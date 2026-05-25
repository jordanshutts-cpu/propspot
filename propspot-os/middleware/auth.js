const jwt   = require('jsonwebtoken');
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
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// requireOwner: checks users.is_owner.
async function requireOwner(req, res, next) {
  try {
    const { rows } = await query('SELECT is_owner FROM users WHERE id = $1', [req.userId]);
    if (!rows[0]?.is_owner) return res.status(403).json({ error: 'Owner access required' });
    next();
  } catch (err) {
    res.status(500).json({ error: 'Authorization check failed' });
  }
}

// ── App-grant guards ─────────────────────────────────────────────────────────

async function requireMaintenanceGrant(req, res, next) {
  try {
    const { rows: userRows } = await query(
      `SELECT id, email, is_owner FROM users WHERE id = $1`, [req.userId]
    );
    const user = userRows[0];
    if (!user) return res.status(401).json({ error: 'User not found' });
    if (user.is_owner) { req.maintenanceGrant = { role: 'owner', scope: { all: true } }; return next(); }
    const { rows } = await query(`
      SELECT ag.role, ag.scope FROM app_grants ag JOIN apps a ON a.id = ag.app_id
       WHERE ag.user_id = $1 AND a.slug = 'maintenance' LIMIT 1`, [req.userId]);
    if (!rows[0]) return res.status(403).json({ error: 'No access to Maintenance' });
    req.maintenanceGrant = { role: rows[0].role, scope: rows[0].scope || { all: true } };
    next();
  } catch (err) { res.status(500).json({ error: 'Authorization check failed' }); }
}

async function requirePulseGrant(req, res, next) {
  // Pulse is open to every authenticated org member — no explicit grant needed.
  // Owners get elevated role so they can manage channels; everyone else is 'member'.
  try {
    const { rows } = await query(`SELECT is_owner FROM users WHERE id = $1`, [req.userId]);
    if (!rows[0]) return res.status(401).json({ error: 'User not found' });
    req.pulseGrant = { role: rows[0].is_owner ? 'owner' : 'member', scope: { all: true } };
    next();
  } catch (err) { res.status(500).json({ error: 'Authorization check failed' }); }
}

async function requireInboxGrant(req, res, next) {
  try {
    const { rows: userRows } = await query(
      `SELECT id, email, full_name, is_owner FROM users WHERE id = $1`, [req.userId]
    );
    const user = userRows[0];
    if (!user) return res.status(401).json({ error: 'User not found' });
    req.user = user;
    if (user.is_owner) { req.inboxGrant = { role: 'owner', scope: { all: true } }; return next(); }
    const { rows } = await query(`
      SELECT ag.role, ag.scope FROM app_grants ag JOIN apps a ON a.id = ag.app_id
       WHERE ag.user_id = $1 AND a.slug = 'inbox' LIMIT 1`, [req.userId]);
    if (!rows[0]) return res.status(403).json({ error: 'No access to Inbox' });
    req.inboxGrant = { role: rows[0].role, scope: rows[0].scope || {} };
    next();
  } catch (err) { res.status(500).json({ error: 'Authorization check failed' }); }
}

module.exports = { requireAuth, requireOwner, requireMaintenanceGrant, requirePulseGrant, requireInboxGrant };
