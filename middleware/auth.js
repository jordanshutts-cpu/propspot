const jwt = require('jsonwebtoken');
const { query } = require('../db');

const OS_URL = process.env.OS_INTERNAL_URL || process.env.OS_URL || '';

// Calls Prop Spot's /api/os/me with the same JWT to confirm identity and
// fetch the user's grants. Returns null if OS rejects the token, isn't
// reachable, or the user has no `fieldcam` grant.
async function resolveOsUser(token) {
  if (!OS_URL) return null;
  try {
    const r = await fetch(OS_URL + '/api/os/me', {
      headers: { Authorization: 'Bearer ' + token }
    });
    if (!r.ok) return null;
    const data = await r.json();
    const grant = (data.grants || []).find(g => g.slug === 'fieldcam');
    if (!grant) return null;
    return { user: data.user, grant };
  } catch {
    return null;
  }
}

// Upsert a Prop Spot user into FieldCam's users table so existing FK
// constraints (uploaded_by, created_by) keep working. Email is the merge
// key — if a native FieldCam user already exists with that email, we
// reuse them.
async function syncOsUser(osUser) {
  const email = (osUser.email || '').toLowerCase();
  const { rows: existing } = await query(
    'SELECT id, email FROM users WHERE email = $1', [email]
  );
  if (existing[0]) return existing[0];

  const { rows } = await query(
    `INSERT INTO users (id, email, full_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (email) DO UPDATE
       SET full_name = COALESCE(users.full_name, EXCLUDED.full_name)
     RETURNING id, email`,
    [osUser.id, email, osUser.full_name || null]
  );
  return rows[0];
}

async function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const token = header.slice(7);

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  // Native FieldCam user — fast path.
  try {
    const { rows } = await query(
      'SELECT id, email FROM users WHERE id = $1', [payload.userId]
    );
    if (rows[0]) {
      req.userId    = rows[0].id;
      req.userEmail = rows[0].email;
      return next();
    }
  } catch (err) {
    console.error('Local user lookup failed:', err);
    return res.status(500).json({ error: 'Auth check failed' });
  }

  // Token signature is valid but user isn't local. This usually means the
  // token was issued by Prop Spot. Verify with OS and shadow-sync.
  const os = await resolveOsUser(token);
  if (!os) {
    return res.status(403).json({ error: 'No access to FieldCam — ask an admin to grant the FieldCam app in Prop Spot.' });
  }

  try {
    const local = await syncOsUser(os.user);
    req.userId    = local.id;
    req.userEmail = local.email;
    req.osUserId  = os.user.id;
    req.osGrant   = os.grant;
    next();
  } catch (err) {
    console.error('OS user sync failed:', err);
    return res.status(500).json({ error: 'Failed to sync user from Prop Spot' });
  }
}

module.exports = { requireAuth };
