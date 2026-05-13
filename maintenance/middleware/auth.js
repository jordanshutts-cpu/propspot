const jwt = require('jsonwebtoken');
const { query } = require('../db');

// Same JWT_SECRET as Prop Spot → same token works in every satellite.
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

// Cached lookup of the authenticated user's role flags. Reused by
// requireWorkerOrAdmin and admin-only routes.
async function loadUserFlags(userId) {
  const { rows } = await query(
    `SELECT id, email, full_name, is_owner, is_maintenance_worker
       FROM users WHERE id = $1`,
    [userId]
  );
  return rows[0] || null;
}

async function requireWorkerOrAdmin(req, res, next) {
  const u = await loadUserFlags(req.userId);
  if (!u) return res.status(401).json({ error: 'User not found' });
  if (!u.is_owner && !u.is_maintenance_worker) {
    return res.status(403).json({ error: 'Maintenance access required' });
  }
  req.user = u;
  next();
}

async function requireAdmin(req, res, next) {
  const u = await loadUserFlags(req.userId);
  if (!u) return res.status(401).json({ error: 'User not found' });
  if (!u.is_owner) return res.status(403).json({ error: 'Admin only' });
  req.user = u;
  next();
}

module.exports = { requireAuth, requireWorkerOrAdmin, requireAdmin, loadUserFlags };
