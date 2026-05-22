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

async function requireInboxGrant(req, res, next) {
  try {
    const { rows: userRows } = await query(
      `SELECT id, email, full_name, is_owner FROM users WHERE id = $1`,
      [req.userId]
    );
    const user = userRows[0];
    if (!user) return res.status(401).json({ error: 'User not found' });
    req.user = user;

    if (user.is_owner) {
      req.inboxGrant = { role: 'owner', scope: { all: true } };
      return next();
    }

    const { rows: grantRows } = await query(`
      SELECT ag.role, ag.scope
        FROM app_grants ag
        JOIN apps a ON a.id = ag.app_id
       WHERE ag.user_id = $1 AND a.slug = 'inbox'
       LIMIT 1
    `, [req.userId]);

    const grant = grantRows[0];
    if (!grant) return res.status(403).json({ error: 'No access to Inbox' });
    req.inboxGrant = { role: grant.role, scope: grant.scope || {} };
    next();
  } catch (err) {
    console.error('requireInboxGrant error:', err);
    res.status(500).json({ error: 'Authorization check failed' });
  }
}

function requireOwner(req, res, next) {
  if (req.inboxGrant?.role === 'owner') return next();
  return res.status(403).json({ error: 'Owner access required' });
}

module.exports = { requireAuth, requireInboxGrant, requireOwner };
