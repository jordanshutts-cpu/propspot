const jwt = require('jsonwebtoken');

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

// requireOwner: checks users.is_owner. Use for global admin actions
// (registering an app, granting any user any role, etc.)
async function requireOwner(req, res, next) {
  const { query } = require('../db');
  try {
    const { rows } = await query('SELECT is_owner FROM users WHERE id = $1', [req.userId]);
    if (!rows[0]?.is_owner) {
      return res.status(403).json({ error: 'Owner access required' });
    }
    next();
  } catch (err) {
    res.status(500).json({ error: 'Authorization check failed' });
  }
}

module.exports = { requireAuth, requireOwner };
