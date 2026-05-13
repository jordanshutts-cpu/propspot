const express = require('express');
const { query, pool } = require('../db');
const { requireAuth, requireWorkerOrAdmin } = require('../middleware/auth');
const { smoothedMiles, nextDueAt, weeklyFolderName } = require('../lib/geo');

const router = express.Router();
router.use(requireAuth);

// GET /api/visits/:id
router.get('/:id', requireWorkerOrAdmin, async (req, res) => {
  try {
    const v = await query(
      `SELECT v.*,
              COALESCE(NULLIF(p.display_name, ''), p.address_line1) AS property_name,
              p.address_line1, p.city, p.state, p.zip, p.lat, p.lng,
              p.lockbox_code, p.gate_code, p.access_notes, p.notes AS property_notes
         FROM maintenance_visits v
         JOIN properties p ON p.id = v.property_id
        WHERE v.id = $1`,
      [req.params.id]
    );
    if (!v.rows[0]) return res.status(404).json({ error: 'Visit not found' });
    if (!req.user.is_owner && v.rows[0].assigned_to !== req.userId) {
      return res.status(403).json({ error: 'Not your visit' });
    }

    const tasks = await query(
      `SELECT * FROM maintenance_tasks WHERE visit_id = $1 ORDER BY sort_order, id`,
      [req.params.id]
    );
    const photos = await query(
      `SELECT vp.kind, p.id, p.url, p.cloudinary_id, p.taken_at, p.notes
         FROM visit_photos vp
         JOIN photos p ON p.id = vp.photo_id
        WHERE vp.visit_id = $1 AND p.deleted_at IS NULL
        ORDER BY p.taken_at`,
      [req.params.id]
    );
    res.json({ ...v.rows[0], tasks: tasks.rows, photos: photos.rows });
  } catch (err) {
    console.error('visit detail:', err);
    res.status(500).json({ error: 'Failed to load visit' });
  }
});

// POST /api/visits/:id/arrive
//   { lat, lng, method: 'geofence'|'manual' }
//
// Sets arrived_at + status=on_site, computes miles_to_here from accepted
// pings since the previous visit's departure (or the route start), and
// lazily ensures a weekly folder exists for that property.
router.post('/:id/arrive', requireWorkerOrAdmin, async (req, res) => {
  const { lat, lng, method } = req.body;
  const arrivalMethod = method === 'manual' ? 'manual' : 'geofence';

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const v = await client.query(
      `SELECT v.*, r.started_at, r.assigned_to AS route_assigned, r.route_date
         FROM maintenance_visits v
         JOIN maintenance_routes r ON r.id = v.route_id
        WHERE v.id = $1 FOR UPDATE`,
      [req.params.id]
    );
    if (!v.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Visit not found' }); }
    const visit = v.rows[0];
    if (visit.assigned_to !== req.userId && !req.user.is_owner) {
      await client.query('ROLLBACK'); return res.status(403).json({ error: 'Not your visit' });
    }
    if (visit.arrived_at) {
      await client.query('ROLLBACK'); return res.status(409).json({ error: 'Already arrived' });
    }

    // Find the previous completed visit on this route to anchor the segment.
    const prev = await client.query(
      `SELECT departed_at FROM maintenance_visits
        WHERE route_id = $1 AND sequence < $2 AND departed_at IS NOT NULL
        ORDER BY sequence DESC LIMIT 1`,
      [visit.route_id, visit.sequence]
    );
    const segmentStart = prev.rows[0]?.departed_at || visit.started_at || visit.route_date;

    const pings = await client.query(
      `SELECT lat, lng, accuracy_m, speed_mps, recorded_at
         FROM route_pings
        WHERE route_id = $1 AND recorded_at >= $2
        ORDER BY recorded_at`,
      [visit.route_id, segmentStart]
    );
    const miles = smoothedMiles(pings.rows);

    // Look up or create the per-property weekly folder.
    const folderName = weeklyFolderName(visit.route_date);
    let folderId;
    const existingFolder = await client.query(
      `SELECT id FROM folders WHERE property_id = $1 AND name = $2`,
      [visit.property_id, folderName]
    );
    if (existingFolder.rows[0]) {
      folderId = existingFolder.rows[0].id;
    } else {
      const folderIns = await client.query(
        `INSERT INTO folders (property_id, name, created_by)
         VALUES ($1, $2, $3) RETURNING id`,
        [visit.property_id, folderName, req.userId]
      );
      folderId = folderIns.rows[0].id;
    }

    const upd = await client.query(
      `UPDATE maintenance_visits
          SET arrived_at       = NOW(),
              status           = 'on_site',
              arrival_method   = $2,
              miles_to_here    = $3,
              weekly_folder_id = $4
        WHERE id = $1
        RETURNING *`,
      [req.params.id, arrivalMethod, miles.toFixed(2), folderId]
    );

    await client.query('COMMIT');
    res.json({ ...upd.rows[0], weekly_folder_name: folderName });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('arrive:', err);
    res.status(500).json({ error: 'Failed to record arrival' });
  } finally {
    client.release();
  }
});

// POST /api/visits/:id/depart
//   { method: 'geofence'|'manual' }
//
// Sets departed_at + duration_minutes + status=completed. Advances the
// schedule's next_due_at off the actual departure time, and updates the
// property's projects.last_mowed_at if a project row exists.
router.post('/:id/depart', requireWorkerOrAdmin, async (req, res) => {
  const departureMethod = req.body.method === 'manual' ? 'manual' : 'geofence';

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const v = await client.query(
      `SELECT * FROM maintenance_visits WHERE id = $1 FOR UPDATE`,
      [req.params.id]
    );
    if (!v.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Visit not found' }); }
    const visit = v.rows[0];
    if (visit.assigned_to !== req.userId && !req.user.is_owner) {
      await client.query('ROLLBACK'); return res.status(403).json({ error: 'Not your visit' });
    }
    if (!visit.arrived_at) {
      await client.query('ROLLBACK'); return res.status(409).json({ error: 'Cannot depart before arrival' });
    }
    if (visit.departed_at) {
      await client.query('ROLLBACK'); return res.status(409).json({ error: 'Already departed' });
    }

    const upd = await client.query(
      `UPDATE maintenance_visits
          SET departed_at      = NOW(),
              status           = 'completed',
              departure_method = $2,
              duration_minutes = GREATEST(1, EXTRACT(EPOCH FROM (NOW() - arrived_at))::int / 60)
        WHERE id = $1
        RETURNING *`,
      [req.params.id, departureMethod]
    );
    const completed = upd.rows[0];

    // Advance the schedule (if one exists) off the departure time.
    const sched = await client.query(
      `SELECT * FROM maintenance_schedules WHERE property_id = $1`,
      [completed.property_id]
    );
    if (sched.rows[0]) {
      const next = nextDueAt(completed.departed_at, sched.rows[0]);
      await client.query(
        `UPDATE maintenance_schedules
            SET next_due_at = $2,
                updated_at  = NOW()
          WHERE property_id = $1`,
        [completed.property_id, next.toISOString()]
      );
    }

    // Mirror to projects.last_mowed_at when a project exists for this property.
    await client.query(
      `UPDATE projects
          SET last_mowed_at = $2,
              updated_at    = NOW()
        WHERE property_id = $1`,
      [completed.property_id, completed.departed_at]
    );

    await client.query('COMMIT');
    res.json(completed);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('depart:', err);
    res.status(500).json({ error: 'Failed to record departure' });
  } finally {
    client.release();
  }
});

// POST /api/visits/:id/skip
router.post('/:id/skip', requireWorkerOrAdmin, async (req, res) => {
  const reason = (req.body.reason || '').trim() || null;
  try {
    const v = await query(
      `SELECT assigned_to FROM maintenance_visits WHERE id = $1`,
      [req.params.id]
    );
    if (!v.rows[0]) return res.status(404).json({ error: 'Visit not found' });
    if (v.rows[0].assigned_to !== req.userId && !req.user.is_owner) {
      return res.status(403).json({ error: 'Not your visit' });
    }
    const { rows } = await query(
      `UPDATE maintenance_visits
          SET status = 'skipped',
              notes  = COALESCE(notes, '') || CASE WHEN $2 IS NULL THEN '' ELSE E'\nSkipped: ' || $2 END
        WHERE id = $1
        RETURNING *`,
      [req.params.id, reason]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error('skip:', err);
    res.status(500).json({ error: 'Failed to skip visit' });
  }
});

// POST /api/visits/:id/attach-photo
//   { photo_id, kind: 'before'|'after'|'exterior' }
router.post('/:id/attach-photo', requireWorkerOrAdmin, async (req, res) => {
  const { photo_id, kind } = req.body;
  if (!photo_id) return res.status(400).json({ error: 'photo_id required' });
  if (kind && !['before', 'after', 'exterior'].includes(kind)) {
    return res.status(400).json({ error: 'invalid kind' });
  }
  try {
    const v = await query(
      `SELECT assigned_to FROM maintenance_visits WHERE id = $1`,
      [req.params.id]
    );
    if (!v.rows[0]) return res.status(404).json({ error: 'Visit not found' });
    if (v.rows[0].assigned_to !== req.userId && !req.user.is_owner) {
      return res.status(403).json({ error: 'Not your visit' });
    }
    await query(
      `INSERT INTO visit_photos (visit_id, photo_id, kind)
       VALUES ($1, $2, $3)
       ON CONFLICT (visit_id, photo_id) DO UPDATE SET kind = EXCLUDED.kind`,
      [req.params.id, photo_id, kind || null]
    );
    res.status(201).json({ ok: true });
  } catch (err) {
    if (err.code === '23503') return res.status(404).json({ error: 'photo_id not found' });
    console.error('attach photo:', err);
    res.status(500).json({ error: 'Failed to attach photo' });
  }
});

module.exports = router;
