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
    if (rows[0]) {
      req.inboxGrant = { role: rows[0].role, scope: rows[0].scope || {} };
      return next();
    }
    // No explicit grant — fall back to personal-only access if they own
    // any personal inbox. scopedInboxIds(scope, userId) will return just
    // their personals.
    const { rows: own } = await query(
      `SELECT 1 FROM inbox_shared WHERE owner_user_id = $1 LIMIT 1`, [req.userId]
    );
    if (own[0]) {
      req.inboxGrant = { role: 'member', scope: { inbox_ids: [] } };
      return next();
    }
    return res.status(403).json({ error: 'No access to Inbox' });
  } catch (err) { res.status(500).json({ error: 'Authorization check failed' }); }
}

async function requireTimesheetsGrant(req, res, next) {
  try {
    const { rows: userRows } = await query(
      `SELECT id, email, full_name, is_owner FROM users WHERE id = $1`,
      [req.userId]
    );
    const user = userRows[0];
    if (!user) return res.status(401).json({ error: 'User not found' });
    req.user = user;
    if (user.is_owner) {
      req.timesheetsGrant = { role: 'admin', scope: { all: true } };
      return next();
    }
    const { rows } = await query(`
      SELECT ag.role, ag.scope
        FROM app_grants ag
        JOIN apps a ON a.id = ag.app_id
       WHERE ag.user_id = $1 AND a.slug = 'timesheets'
       LIMIT 1
    `, [req.userId]);
    if (!rows[0]) return res.status(403).json({ error: 'No access to Timesheets' });
    req.timesheetsGrant = {
      role: rows[0].role,
      scope: rows[0].scope || { all: true }
    };
    next();
  } catch (err) {
    res.status(500).json({ error: 'Authorization check failed' });
  }
}

function requireTimesheetsApprover(req, res, next) {
  const role = req.timesheetsGrant?.role;
  if (role === 'approver' || role === 'admin') return next();
  return res.status(403).json({ error: 'Approver access required' });
}

function requireTimesheetsAdmin(req, res, next) {
  if (req.timesheetsGrant?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

// requireTeamUser: redirect external_worker users to /my-work.html on any HTML page.
// JWT-protected pages typically read the token from localStorage, not cookies — so
// we apply this guard server-side on the static-HTML routes by checking a
// token cookie OR the Authorization header. If the user is external_worker, send
// 302 to /my-work.html; otherwise fall through.
//
// NOTE: this is a soft guard. The real authorization happens at API level, which
// is already scoped via the assigned_user_id checks in my-work-orders.js. The
// guard here is purely UX — it prevents the external worker from landing on the
// regular dashboard if they manually type /dashboard.html.
function redirectExternalToPortal(allowedPages) {
  const allow = new Set(allowedPages);
  return async (req, res, next) => {
    // Pull token from cookie OR Authorization header.
    let token = req.cookies?.ros_token;
    if (!token) {
      const h = req.headers.authorization;
      if (h?.startsWith('Bearer ')) token = h.slice(7);
    }
    if (!token) return next(); // unauthenticated → let login flow handle
    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      const { rows } = await query(
        `SELECT user_type FROM users WHERE id = $1`, [payload.userId]
      );
      if (rows[0]?.user_type === 'external_worker'
          && !allow.has(req.path)) {
        return res.redirect(302, '/my-work.html');
      }
    } catch (_) { /* invalid token → let request proceed; login pages handle it */ }
    next();
  };
}

module.exports = { requireAuth, requireOwner, requireMaintenanceGrant, requirePulseGrant, requireInboxGrant, requireTimesheetsGrant, requireTimesheetsApprover, requireTimesheetsAdmin, redirectExternalToPortal };
