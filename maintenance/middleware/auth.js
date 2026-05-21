const jwt = require('jsonwebtoken');
const { query } = require('../db');

function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  try {
    const payload = jwt.verify(header.slice(7), process.env.JWT_SECRET);
    req.userId    = payload.userId;
    req.userEmail = payload.email;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

async function requireMaintenanceGrant(req, res, next) {
  try {
    // Pull the user first so we can short-circuit on owner without joining
    // through app_grants (which can return multiple rows when a user has
    // grants on more than one app and confuse the rows[0] pick).
    const { rows: userRows } = await query(
      `SELECT id, email, is_owner FROM users WHERE id = $1`,
      [req.userId]
    );
    const user = userRows[0];
    if (!user) return res.status(401).json({ error: 'User not found' });
    if (user.is_owner) {
      req.maintenanceGrant = { role: 'owner', scope: { all: true } };
      return next();
    }

    const { rows: grantRows } = await query(`
      SELECT ag.role, ag.scope
        FROM app_grants ag
        JOIN apps a ON a.id = ag.app_id
       WHERE ag.user_id = $1 AND a.slug = 'maintenance'
       LIMIT 1
    `, [req.userId]);

    const grant = grantRows[0];
    if (!grant) return res.status(403).json({ error: 'No access to Maintenance' });
    req.maintenanceGrant = { role: grant.role, scope: grant.scope || { all: true } };
    next();
  } catch (err) {
    console.error('requireMaintenanceGrant error:', err);
    // Surface the underlying cause so we can debug from the client side.
    res.status(500).json({
      error: 'Authorization check failed',
      detail: err.message || String(err),
      userId: req.userId || null
    });
  }
}

module.exports = { requireAuth, requireMaintenanceGrant };
