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

async function requirePulseGrant(req, res, next) {
  try {
    const { rows } = await query(`
      SELECT ag.role, ag.scope, u.is_owner
        FROM users u
        LEFT JOIN app_grants ag ON ag.user_id = u.id
        LEFT JOIN apps a       ON a.id = ag.app_id AND a.slug = 'pulse'
       WHERE u.id = $1
    `, [req.userId]);

    const row = rows[0];
    if (!row) return res.status(401).json({ error: 'User not found' });
    if (row.is_owner) {
      req.pulseGrant = { role: 'owner', scope: { all: true } };
      return next();
    }
    if (!row.role) return res.status(403).json({ error: 'No access to Pulse' });
    req.pulseGrant = { role: row.role, scope: row.scope || { all: true } };
    next();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Authorization check failed' });
  }
}

module.exports = { requireAuth, requirePulseGrant };
