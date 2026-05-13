const express = require('express');
const { query, pool } = require('../db');
const { requireAuth, requireWorkerOrAdmin } = require('../middleware/auth');
const { orderByNearestNeighbor, endOfWeek } = require('../lib/geo');

const router = express.Router();
router.use(requireAuth);

function isAdmin(req)  { return !!req.user?.is_owner; }
function selfOrAdmin(req, userId) { return isAdmin(req) || userId === req.userId; }

// POST /api/routes/generate
//   { date: 'YYYY-MM-DD', assigned_to?, start_lat?, start_lng? }
// Pulls every active schedule for the worker whose next_due_at is on or before
// the end of the ISO week containing `date`, orders the stops by greedy
// nearest-neighbor from (start_lat,start_lng), and creates a route + visits +
// instantiated tasks. Refuses to regenerate if one already exists.
router.post('/generate', requireWorkerOrAdmin, async (req, res) => {
  const date = req.body.date;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'date (YYYY-MM-DD) required' });
  }
  const assignedTo = req.body.assigned_to || req.userId;
  if (!selfOrAdmin(req, assignedTo)) {
    return res.status(403).json({ error: 'Cannot generate routes for another user' });
  }
  const startLat = req.body.start_lat ?? null;
  const startLng = req.body.start_lng ?? null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const existing = await client.query(
      `SELECT id FROM maintenance_routes
        WHERE assigned_to = $1 AND route_date = $2`,
      [assignedTo, date]
    );
    if (existing.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'A route already exists for this worker on this date',
        route_id: existing.rows[0].id
      });
    }

    const weekEnd = endOfWeek(date).toISOString();
    const due = await client.query(
      `SELECT s.id AS schedule_id, s.default_tasks, s.property_id,
              p.lat, p.lng,
              COALESCE(NULLIF(p.display_name, ''), p.address_line1) AS name
         FROM maintenance_schedules s
         JOIN properties p ON p.id = s.property_id
        WHERE s.active = TRUE
          AND s.assigned_to = $1
          AND (s.next_due_at IS NULL OR s.next_due_at <= $2)
          AND p.lat IS NOT NULL AND p.lng IS NOT NULL`,
      [assignedTo, weekEnd]
    );

    if (due.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(200).json({ route: null, message: 'Nothing due this week' });
    }

    const ordered = (startLat != null && startLng != null)
      ? orderByNearestNeighbor(due.rows, startLat, startLng)
      : due.rows;

    const routeIns = await client.query(
      `INSERT INTO maintenance_routes
         (assigned_to, route_date, status, start_lat, start_lng)
       VALUES ($1, $2, 'planned', $3, $4)
       RETURNING *`,
      [assignedTo, date, startLat, startLng]
    );
    const route = routeIns.rows[0];

    for (let i = 0; i < ordered.length; i++) {
      const stop = ordered[i];
      const visitIns = await client.query(
        `INSERT INTO maintenance_visits
           (route_id, property_id, assigned_to, sequence, status)
         VALUES ($1, $2, $3, $4, 'pending')
         RETURNING id`,
        [route.id, stop.property_id, assignedTo, i]
      );
      const visitId = visitIns.rows[0].id;

      const tasks = Array.isArray(stop.default_tasks) ? stop.default_tasks : [];
      for (let t = 0; t < tasks.length; t++) {
        const task = tasks[t] || {};
        if (!task.label) continue;
        await client.query(
          `INSERT INTO maintenance_tasks (visit_id, label, required, sort_order)
           VALUES ($1, $2, COALESCE($3, FALSE), $4)`,
          [visitId, task.label, task.required, t]
        );
      }
    }

    await client.query('COMMIT');
    const full = await query(
      `SELECT * FROM maintenance_routes WHERE id = $1`, [route.id]
    );
    res.status(201).json({ route: full.rows[0], stops: ordered.length });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('generate route:', err);
    res.status(500).json({ error: 'Failed to generate route' });
  } finally {
    client.release();
  }
});

// GET /api/routes/payroll?weekStart=YYYY-MM-DD&assigned_to=
// Defined BEFORE /:id so Express doesn't match "payroll" as a route id.
router.get('/payroll', requireWorkerOrAdmin, async (req, res) => {
  const weekStart = req.query.weekStart;
  if (!weekStart || !/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
    return res.status(400).json({ error: 'weekStart (YYYY-MM-DD) required' });
  }
  const userId = req.query.assigned_to && isAdmin(req) ? req.query.assigned_to : req.userId;

  try {
    const { rows } = await query(
      `SELECT
         r.route_date,
         r.id              AS route_id,
         r.status          AS route_status,
         r.total_minutes,
         r.total_miles,
         COUNT(v.id) FILTER (WHERE v.status = 'completed') AS properties_serviced,
         COUNT(v.id) FILTER (WHERE v.status = 'skipped')   AS properties_skipped
       FROM maintenance_routes r
       LEFT JOIN maintenance_visits v ON v.route_id = r.id
       WHERE r.assigned_to = $1
         AND r.route_date >= $2::date
         AND r.route_date <  $2::date + INTERVAL '7 days'
       GROUP BY r.id
       ORDER BY r.route_date`,
      [userId, weekStart]
    );

    const totals = rows.reduce((acc, r) => ({
      total_minutes:        acc.total_minutes        + Number(r.total_minutes || 0),
      total_miles:          acc.total_miles          + Number(r.total_miles   || 0),
      properties_serviced:  acc.properties_serviced  + Number(r.properties_serviced || 0),
      properties_skipped:   acc.properties_skipped   + Number(r.properties_skipped  || 0)
    }), { total_minutes: 0, total_miles: 0, properties_serviced: 0, properties_skipped: 0 });

    res.json({ weekStart, assigned_to: userId, days: rows, totals });
  } catch (err) {
    console.error('payroll:', err);
    res.status(500).json({ error: 'Failed to compute payroll' });
  }
});

// GET /api/routes/today
//   Caller's route for today (or ?userId= for admin).
router.get('/today', requireWorkerOrAdmin, async (req, res) => {
  const userId = req.query.userId && isAdmin(req) ? req.query.userId : req.userId;
  try {
    const { rows } = await query(
      `SELECT * FROM maintenance_routes
        WHERE assigned_to = $1 AND route_date = CURRENT_DATE
        LIMIT 1`,
      [userId]
    );
    if (!rows[0]) return res.json({ route: null });
    res.json(await fetchFullRoute(rows[0].id));
  } catch (err) {
    console.error('route today:', err);
    res.status(500).json({ error: 'Failed to load route' });
  }
});

// GET /api/routes/:id — full detail with visits/tasks/photos.
router.get('/:id', requireWorkerOrAdmin, async (req, res) => {
  try {
    const data = await fetchFullRoute(req.params.id);
    if (!data) return res.status(404).json({ error: 'Route not found' });
    if (!selfOrAdmin(req, data.route.assigned_to)) {
      return res.status(403).json({ error: 'Not your route' });
    }
    res.json(data);
  } catch (err) {
    console.error('route detail:', err);
    res.status(500).json({ error: 'Failed to load route' });
  }
});

// POST /api/routes/:id/start
router.post('/:id/start', requireWorkerOrAdmin, async (req, res) => {
  const { lat, lng } = req.body;
  try {
    const { rows } = await query(
      `UPDATE maintenance_routes
          SET status     = 'in_progress',
              started_at = COALESCE(started_at, NOW()),
              start_lat  = COALESCE(start_lat, $2),
              start_lng  = COALESCE(start_lng, $3)
        WHERE id = $1 AND assigned_to = $4
        RETURNING *`,
      [req.params.id, lat ?? null, lng ?? null, req.userId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Route not found or not yours' });
    res.json(rows[0]);
  } catch (err) {
    console.error('start route:', err);
    res.status(500).json({ error: 'Failed to start route' });
  }
});

// POST /api/routes/:id/end — finalize totals.
router.post('/:id/end', requireWorkerOrAdmin, async (req, res) => {
  try {
    const totals = await query(
      `SELECT
         COALESCE(SUM(duration_minutes), 0)::int                 AS total_minutes,
         COALESCE(SUM(miles_to_here), 0)::numeric(8,2)           AS total_miles
       FROM maintenance_visits
       WHERE route_id = $1`,
      [req.params.id]
    );
    const t = totals.rows[0];

    const { rows } = await query(
      `UPDATE maintenance_routes
          SET status        = 'completed',
              ended_at      = NOW(),
              total_minutes = $2,
              total_miles   = $3
        WHERE id = $1 AND assigned_to = $4
        RETURNING *`,
      [req.params.id, t.total_minutes, t.total_miles, req.userId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Route not found or not yours' });
    res.json(rows[0]);
  } catch (err) {
    console.error('end route:', err);
    res.status(500).json({ error: 'Failed to end route' });
  }
});

// POST /api/routes/:id/pings
//   { pings: [{lat,lng,accuracy_m?,speed_mps?,recorded_at}, ...] }
router.post('/:id/pings', requireWorkerOrAdmin, async (req, res) => {
  const pings = Array.isArray(req.body.pings) ? req.body.pings : null;
  if (!pings || pings.length === 0) {
    return res.status(400).json({ error: 'pings array required' });
  }
  if (pings.length > 1000) {
    return res.status(413).json({ error: 'Batch too large (max 1000 pings)' });
  }

  try {
    const owns = await query(
      `SELECT 1 FROM maintenance_routes WHERE id = $1 AND assigned_to = $2`,
      [req.params.id, req.userId]
    );
    if (!owns.rows[0]) return res.status(404).json({ error: 'Route not found or not yours' });

    const vals = [];
    const params = [];
    pings.forEach((p, i) => {
      const base = i * 6;
      vals.push(`($${base+1}, $${base+2}, $${base+3}, $${base+4}, $${base+5}, $${base+6})`);
      params.push(
        req.params.id, p.lat, p.lng,
        p.accuracy_m ?? null, p.speed_mps ?? null, p.recorded_at || new Date().toISOString()
      );
    });

    await query(
      `INSERT INTO route_pings (route_id, lat, lng, accuracy_m, speed_mps, recorded_at)
       VALUES ${vals.join(', ')}`,
      params
    );
    res.json({ inserted: pings.length });
  } catch (err) {
    console.error('insert pings:', err);
    res.status(500).json({ error: 'Failed to record pings' });
  }
});

// ── helpers ─────────────────────────────────────────────────────────

async function fetchFullRoute(routeId) {
  const r = await query(`SELECT * FROM maintenance_routes WHERE id = $1`, [routeId]);
  if (!r.rows[0]) return null;
  const route = r.rows[0];

  const visits = await query(
    `SELECT
       v.*,
       COALESCE(NULLIF(p.display_name, ''), p.address_line1) AS property_name,
       p.address_line1, p.city, p.state, p.zip, p.lat, p.lng,
       p.lockbox_code, p.gate_code, p.access_notes
     FROM maintenance_visits v
     JOIN properties p ON p.id = v.property_id
     WHERE v.route_id = $1
     ORDER BY v.sequence`,
    [routeId]
  );

  if (visits.rows.length === 0) return { route, visits: [] };

  const visitIds = visits.rows.map(v => v.id);
  const tasks = await query(
    `SELECT * FROM maintenance_tasks
      WHERE visit_id = ANY($1::uuid[])
      ORDER BY visit_id, sort_order, id`,
    [visitIds]
  );
  const photos = await query(
    `SELECT vp.visit_id, vp.kind, p.id, p.url, p.cloudinary_id, p.taken_at, p.notes
       FROM visit_photos vp
       JOIN photos p ON p.id = vp.photo_id
      WHERE vp.visit_id = ANY($1::uuid[])
        AND p.deleted_at IS NULL
      ORDER BY p.taken_at`,
    [visitIds]
  );

  const tasksByVisit  = groupBy(tasks.rows,  'visit_id');
  const photosByVisit = groupBy(photos.rows, 'visit_id');

  return {
    route,
    visits: visits.rows.map(v => ({
      ...v,
      tasks:  tasksByVisit[v.id]  || [],
      photos: photosByVisit[v.id] || []
    }))
  };
}

function groupBy(arr, key) {
  const out = {};
  for (const row of arr) {
    (out[row[key]] = out[row[key]] || []).push(row);
  }
  return out;
}

module.exports = router;
