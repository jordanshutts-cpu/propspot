// Endpoints used by satellite apps (FieldCam, Underwriting, etc.) to resolve
// the calling user's identity and check per-record access.
//
// All endpoints require the OS-issued JWT in Authorization: Bearer <token>.

const express = require('express');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

async function getGrant(userId, appSlug) {
  const { rows } = await query(`
    SELECT ag.role, ag.scope, a.slug, a.name
      FROM app_grants ag
      JOIN apps a ON a.id = ag.app_id
     WHERE ag.user_id = $1 AND a.slug = $2 AND a.enabled = TRUE
  `, [userId, appSlug]);
  return rows[0] || null;
}

// GET /api/os/me  — minimal identity payload for satellite apps
router.get('/me', async (req, res) => {
  try {
    const { rows: u } = await query(
      `SELECT id, email, full_name, is_owner FROM users WHERE id = $1`, [req.userId]
    );
    if (!u[0]) return res.status(404).json({ error: 'User not found' });

    const { rows: g } = await query(`
      SELECT a.slug, a.name, ag.role, ag.scope
        FROM app_grants ag
        JOIN apps a ON a.id = ag.app_id
       WHERE ag.user_id = $1 AND a.enabled = TRUE
    `, [req.userId]);

    res.json({ user: u[0], grants: g });
  } catch (err) {
    res.status(500).json({ error: 'Failed' });
  }
});

// GET /api/os/authz?app=fieldcam&resource=project&id=<uuid>
//   Returns { allow, role, reason }.
//   Owners are allowed everywhere they have any grant.
router.get('/authz', async (req, res) => {
  const { app, resource, id } = req.query;
  if (!app) return res.status(400).json({ error: 'app required' });

  try {
    const grant = await getGrant(req.userId, app);
    if (!grant) return res.json({ allow: false, reason: 'no_grant' });

    if (grant.scope?.all) return res.json({ allow: true, role: grant.role, reason: 'scope_all' });

    if (resource === 'project' && id) {
      const ids = grant.scope?.project_ids || [];
      const allow = ids.includes(id);
      return res.json({ allow, role: grant.role, reason: allow ? 'project_in_scope' : 'project_not_in_scope' });
    }

    // For property-level checks we resolve to the projects belonging to that
    // property and allow if any of them are in scope.
    if (resource === 'property' && id) {
      const { rows } = await query(
        `SELECT id FROM projects WHERE property_id = $1`, [id]
      );
      const propProjectIds = rows.map(r => r.id);
      const granted = (grant.scope?.project_ids || []);
      const allow = propProjectIds.some(pid => granted.includes(pid));
      return res.json({ allow, role: grant.role, reason: allow ? 'property_has_scoped_project' : 'no_overlap' });
    }

    res.json({ allow: false, reason: 'no_match' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Authorization check failed' });
  }
});

// GET /api/os/my-projects?app=fieldcam
//   For list views: returns the project IDs the caller can see in this app.
//   { all: true }  → returns all project ids (with property summary)
//   { project_ids: [...] } → returns only those
router.get('/my-projects', async (req, res) => {
  const { app } = req.query;
  if (!app) return res.status(400).json({ error: 'app required' });

  try {
    const grant = await getGrant(req.userId, app);
    if (!grant) return res.json({ projects: [] });

    let where = '';
    const params = [];
    if (!grant.scope?.all) {
      const ids = grant.scope?.project_ids || [];
      if (!ids.length) return res.json({ projects: [] });
      params.push(ids);
      where = `WHERE pr.id = ANY($1::uuid[])`;
    }

    const { rows } = await query(`
      SELECT pr.id AS project_id, pr.kind, pr.status,
             p.id AS property_id, p.address_line1, p.city, p.state, p.zip
        FROM projects pr
        JOIN properties p ON p.id = pr.property_id
        ${where}
        ORDER BY p.address_line1
    `, params);

    res.json({ projects: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch projects' });
  }
});

// GET /api/os/properties/:id  — property summary for satellite apps
router.get('/properties/:id', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT id, address_line1, unit, city, state, zip, lat, lng
         FROM properties WHERE id = $1`, [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Property not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed' });
  }
});

// GET /grants?app=<slug> — returns { role } for current user on that app.
router.get('/grants', async (req, res) => {
  if (!req.query.app) return res.status(400).json({ error: 'app required' });
  const { rows: [user] } = await query(`SELECT is_owner FROM users WHERE id = $1`, [req.userId]);
  if (user?.is_owner) return res.json({ role: 'admin' });
  const { rows } = await query(`
    SELECT ag.role FROM app_grants ag JOIN apps a ON a.id = ag.app_id
     WHERE ag.user_id = $1 AND a.slug = $2 LIMIT 1
  `, [req.userId, req.query.app]);
  res.json({ role: rows[0]?.role || null });
});

module.exports = router;
