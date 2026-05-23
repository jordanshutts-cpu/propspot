const express = require('express');
const bcrypt  = require('bcryptjs');
const crypto  = require('crypto');
const multer  = require('multer');
const cloudinary = require('cloudinary').v2;
const { query, pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { signToken, safeUser } = require('../lib/jwt');
const { sendInviteEmail, sendPasswordResetEmail } = require('../lib/email');
const { logActivity } = require('../lib/activity');
const { recomputeScopeForUser } = require('../lib/scope');
const { verifyGoogleIdToken } = require('../lib/google-auth');

const router = express.Router();

// Avatar uploads — image only, 5 MB cap, memory storage so we can stream
// straight to Cloudinary without writing to disk.
const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Only image files are allowed'));
    }
    cb(null, true);
  }
});

function uploadAvatarToCloudinary(buffer, userId) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: 'propspot/avatars',
        public_id: userId,                  // one row per user → overwrite on re-upload
        overwrite: true,
        resource_type: 'image',
        transformation: [
          { width: 400, height: 400, crop: 'fill', gravity: 'face' }
        ]
      },
      (err, result) => err ? reject(err) : resolve(result)
    );
    stream.end(buffer);
  });
}

// ── POST /api/auth/signup ───────────────────────────────────────
// First user becomes the owner with full grants on every app.
// Subsequent users created via signup are NOT auto-granted apps.
router.post('/signup', async (req, res) => {
  const { email, password, fullName } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  if (password.length < 6)  return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: countRows } = await client.query(
      `SELECT COUNT(*)::int AS c FROM users WHERE password_hash IS NOT NULL`
    );
    const isFirstUser = countRows[0].c === 0;
    const bootstrapEmail = (process.env.BOOTSTRAP_OWNER_EMAIL || '').toLowerCase().trim();
    const isBootstrap = bootstrapEmail && email.toLowerCase().trim() === bootstrapEmail;
    const isOwner = isFirstUser || isBootstrap;

    const hash = await bcrypt.hash(password, 10);
    const { rows } = await client.query(
      `INSERT INTO users (email, full_name, password_hash, is_owner)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (email) DO UPDATE
         SET password_hash = EXCLUDED.password_hash,
             full_name     = COALESCE(users.full_name, EXCLUDED.full_name),
             is_owner      = users.is_owner OR EXCLUDED.is_owner
         WHERE users.password_hash IS NULL
       RETURNING *`,
      [email.toLowerCase().trim(), fullName || email.split('@')[0], hash, isOwner]
    );

    if (!rows[0]) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'An account with this email already exists' });
    }
    const user = rows[0];

    // Owner gets {"all": true} grants on every existing app.
    if (user.is_owner) {
      await client.query(`
        INSERT INTO app_grants (user_id, app_id, role, scope, granted_by)
        SELECT $1, a.id, 'owner', '{"all": true}'::jsonb, $1
          FROM apps a
          ON CONFLICT (user_id, app_id) DO UPDATE
            SET role = 'owner', scope = '{"all": true}'::jsonb
      `, [user.id]);
    }

    await client.query('COMMIT');

    await logActivity({
      actorUserId: user.id, entityType: 'user', entityId: user.id,
      action: 'created', payload: { via: 'signup', is_owner: user.is_owner }
    });

    const token = signToken(user.id, user.email);
    res.status(201).json({ token, user: safeUser(user) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Signup error:', err);
    res.status(500).json({ error: 'Signup failed' });
  } finally {
    client.release();
  }
});

// ── POST /api/auth/login ────────────────────────────────────────
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  try {
    const { rows } = await query(
      'SELECT * FROM users WHERE email = $1',
      [email.toLowerCase().trim()]
    );
    const user = rows[0];
    if (!user || !user.password_hash) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid email or password' });

    const token = signToken(user.id, user.email);
    res.json({ token, user: safeUser(user) });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// ── POST /api/auth/google ───────────────────────────────────────
// Sign in with a Google ID token from Google Identity Services.
// Body: { credential: "<google-id-token>" }
//
// Rejects unknown emails — the user must already exist in `users`
// (created via signup, invite, or the bulk-invite script). This keeps
// access control tight and avoids surprise account creation.
router.post('/google', async (req, res) => {
  const { credential } = req.body || {};
  if (!credential) return res.status(400).json({ error: 'Missing credential' });

  let claims;
  try {
    claims = await verifyGoogleIdToken(credential);
  } catch (err) {
    if (err.code === 'DOMAIN_NOT_ALLOWED') {
      return res.status(403).json({
        error: 'Your Google Workspace domain is not allowed to sign in to Prop Spot.'
      });
    }
    console.error('Google token verify failed:', err.message);
    return res.status(401).json({ error: 'Invalid Google sign-in' });
  }

  try {
    const { rows } = await query(
      'SELECT * FROM users WHERE email = $1',
      [claims.email]
    );
    const user = rows[0];
    if (!user) {
      return res.status(403).json({
        error: `No Prop Spot account for ${claims.email}. Ask an admin to add you.`
      });
    }

    // Backfill full_name from Google if the row is missing one.
    if (claims.name && (!user.full_name || user.full_name === user.email.split('@')[0])) {
      await query('UPDATE users SET full_name = $1 WHERE id = $2', [claims.name, user.id]);
      user.full_name = claims.name;
    }

    const token = signToken(user.id, user.email);
    res.json({ token, user: safeUser(user) });
  } catch (err) {
    console.error('Google sign-in error:', err);
    res.status(500).json({ error: 'Sign-in failed' });
  }
});

// ── GET /api/auth/me ────────────────────────────────────────────
// Returns user + all app_grants for app discovery on the OS dashboard.
router.get('/me', requireAuth, async (req, res) => {
  try {
    const { rows: userRows } = await query('SELECT * FROM users WHERE id = $1', [req.userId]);
    if (!userRows[0]) return res.status(404).json({ error: 'User not found' });

    const { rows: grants } = await query(`
      SELECT a.slug, a.name, a.icon, a.base_url, ag.role, ag.scope
        FROM app_grants ag
        JOIN apps a ON a.id = ag.app_id
       WHERE ag.user_id = $1 AND a.enabled = TRUE
       ORDER BY a.name
    `, [req.userId]);

    res.json({ ...safeUser(userRows[0]), grants });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

// ── PATCH /api/auth/me ──────────────────────────────────────────
// Edit your own profile. Allowed fields: full_name. Email changes
// would need a verification flow — not supported here yet.
router.patch('/me', requireAuth, async (req, res) => {
  const fullName = typeof req.body?.full_name === 'string'
    ? req.body.full_name.trim()
    : null;
  if (fullName === null) return res.status(400).json({ error: 'nothing to update' });
  if (fullName.length === 0) return res.status(400).json({ error: 'full_name cannot be empty' });
  if (fullName.length > 200) return res.status(400).json({ error: 'full_name too long' });
  try {
    const { rows } = await query(
      `UPDATE users SET full_name = $1 WHERE id = $2 RETURNING *`,
      [fullName, req.userId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'User not found' });
    res.json(safeUser(rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// ── POST /api/auth/me/avatar ────────────────────────────────────
// Upload a new profile picture. Body: multipart/form-data with
// field name "avatar" (image/*, capped at 5 MB). Server crops to a
// 400x400 face-centered square and stores the URL on the user row.
router.post('/me/avatar', requireAuth, avatarUpload.single('avatar'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No avatar file provided' });
  try {
    const result = await uploadAvatarToCloudinary(req.file.buffer, req.userId);
    const { rows } = await query(
      `UPDATE users
          SET avatar_url = $1, avatar_cloudinary_id = $2
        WHERE id = $3
        RETURNING *`,
      [result.secure_url, result.public_id, req.userId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'User not found' });
    res.json(safeUser(rows[0]));
  } catch (err) {
    console.error('avatar upload failed:', err);
    res.status(500).json({ error: err.message || 'Avatar upload failed' });
  }
});

// ── DELETE /api/auth/me/avatar ──────────────────────────────────
router.delete('/me/avatar', requireAuth, async (req, res) => {
  try {
    const { rows: cur } = await query(
      `SELECT avatar_cloudinary_id FROM users WHERE id = $1`,
      [req.userId]
    );
    if (cur[0]?.avatar_cloudinary_id) {
      await cloudinary.uploader.destroy(cur[0].avatar_cloudinary_id).catch(() => {});
    }
    const { rows } = await query(
      `UPDATE users
          SET avatar_url = NULL, avatar_cloudinary_id = NULL
        WHERE id = $1
        RETURNING *`,
      [req.userId]
    );
    res.json(safeUser(rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to remove avatar' });
  }
});

// ── POST /api/auth/invite ───────────────────────────────────────
// Free-form user invite (no contact attached). Use POST /api/contacts/:id/invite
// when the invitee is already a contact in the system.
router.post('/invite', requireAuth, async (req, res) => {
  const { email, fullName, app_grants: grantSpec } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: inviterRows } = await client.query(
      'SELECT full_name FROM users WHERE id = $1', [req.userId]
    );
    const inviterName = inviterRows[0]?.full_name || 'Your teammate';

    const token   = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 48 * 60 * 60 * 1000);

    const { rows: userRows } = await client.query(
      `INSERT INTO users (email, full_name, invite_token, invite_expires)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (email) DO UPDATE
         SET invite_token   = EXCLUDED.invite_token,
             invite_expires = EXCLUDED.invite_expires,
             full_name      = COALESCE(users.full_name, EXCLUDED.full_name)
       RETURNING *`,
      [email.toLowerCase().trim(), fullName || email.split('@')[0], token, expires]
    );
    const invitedUser = userRows[0];

    // Pre-create requested grants
    const appsForEmail = [];
    if (Array.isArray(grantSpec)) {
      for (const g of grantSpec) {
        if (!g.app_id || !g.role) continue;
        const scope = g.scope || { all: true };
        await client.query(
          `INSERT INTO app_grants (user_id, app_id, role, scope, granted_by)
           VALUES ($1, $2, $3, $4::jsonb, $5)
           ON CONFLICT (user_id, app_id) DO UPDATE
             SET role = EXCLUDED.role, scope = EXCLUDED.scope`,
          [invitedUser.id, g.app_id, g.role, JSON.stringify(scope), req.userId]
        );
        const { rows: a } = await client.query('SELECT name FROM apps WHERE id = $1', [g.app_id]);
        if (a[0]) appsForEmail.push(a[0].name);
      }
    }

    await client.query('COMMIT');

    const appUrl = process.env.APP_URL || 'http://localhost:3000';
    const inviteLink = `${appUrl}/accept-invite.html?token=${token}`;
    const emailSent  = await sendInviteEmail({
      to: email, inviteLink, inviterName, appsList: appsForEmail
    });

    await logActivity({
      actorUserId: req.userId, entityType: 'user', entityId: invitedUser.id,
      action: 'invited', payload: { email, apps: appsForEmail }
    });

    res.json({
      message: emailSent
        ? `Invite email sent to ${email}`
        : `No email configured — share this link manually`,
      inviteLink: emailSent ? undefined : inviteLink
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Invite error:', err);
    res.status(500).json({ error: 'Failed to send invite' });
  } finally {
    client.release();
  }
});

// ── POST /api/auth/accept-invite ───────────────────────────────
router.post('/accept-invite', async (req, res) => {
  const { token, password, fullName } = req.body;
  if (!token || !password) return res.status(400).json({ error: 'Token and password required' });
  if (password.length < 6)  return res.status(400).json({ error: 'Password must be at least 6 characters' });

  try {
    const { rows } = await query(
      'SELECT * FROM users WHERE invite_token = $1 AND invite_expires > NOW()',
      [token]
    );
    if (!rows[0]) return res.status(400).json({ error: 'Invite link is invalid or has expired' });

    const hash = await bcrypt.hash(password, 10);
    const { rows: updated } = await query(
      `UPDATE users
          SET password_hash = $1,
              full_name     = COALESCE($2, full_name),
              invite_token  = NULL,
              invite_expires = NULL
        WHERE id = $3
        RETURNING *`,
      [hash, fullName || null, rows[0].id]
    );
    const user = updated[0];

    // Recompute project scope in case linked-contact projects changed since the
    // invite was sent.
    await recomputeScopeForUser(user.id);

    await logActivity({
      actorUserId: user.id, entityType: 'user', entityId: user.id,
      action: 'accepted', payload: { email: user.email }
    });

    const jwtToken = signToken(user.id, user.email);
    res.json({ token: jwtToken, user: safeUser(user) });
  } catch (err) {
    console.error('Accept invite error:', err);
    res.status(500).json({ error: 'Failed to accept invite' });
  }
});

// ── POST /api/auth/forgot-password ──────────────────────────────
// Generates a 1-hour reset token and emails a link. Always returns 200
// regardless of whether the email exists, to avoid leaking which
// accounts are real.
router.post('/forgot-password', async (req, res) => {
  const email = (req.body.email || '').toLowerCase().trim();
  if (!email) return res.status(400).json({ error: 'Email is required' });

  try {
    const { rows } = await query(
      `SELECT id, email FROM users WHERE email = $1 AND password_hash IS NOT NULL`,
      [email]
    );

    if (rows[0]) {
      const token   = crypto.randomBytes(32).toString('hex');
      const expires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
      await query(
        `UPDATE users SET invite_token = $1, invite_expires = $2 WHERE id = $3`,
        [token, expires, rows[0].id]
      );

      const appUrl    = process.env.APP_URL || 'http://localhost:3000';
      const resetLink = `${appUrl}/reset-password.html?token=${token}`;
      await sendPasswordResetEmail({ to: rows[0].email, resetLink });

      await logActivity({
        actorUserId: rows[0].id, entityType: 'user', entityId: rows[0].id,
        action: 'password_reset_requested', payload: { email: rows[0].email }
      });
    }

    // Always succeed — don't leak whether the email is registered.
    res.json({ message: 'If an account exists for that email, a reset link is on its way.' });
  } catch (err) {
    console.error('Forgot-password error:', err);
    res.status(500).json({ error: 'Could not process request' });
  }
});

// ── POST /api/auth/reset-password ───────────────────────────────
router.post('/reset-password', async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ error: 'Token and password required' });
  if (password.length < 6)  return res.status(400).json({ error: 'Password must be at least 6 characters' });

  try {
    const { rows } = await query(
      `SELECT * FROM users WHERE invite_token = $1 AND invite_expires > NOW()`,
      [token]
    );
    if (!rows[0]) return res.status(400).json({ error: 'Reset link is invalid or has expired' });

    const hash = await bcrypt.hash(password, 10);
    const { rows: updated } = await query(
      `UPDATE users
          SET password_hash  = $1,
              invite_token   = NULL,
              invite_expires = NULL
        WHERE id = $2
        RETURNING *`,
      [hash, rows[0].id]
    );
    const user = updated[0];

    await logActivity({
      actorUserId: user.id, entityType: 'user', entityId: user.id,
      action: 'password_reset', payload: { email: user.email }
    });

    const jwtToken = signToken(user.id, user.email);
    res.json({ token: jwtToken, user: safeUser(user) });
  } catch (err) {
    console.error('Reset-password error:', err);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

// ── POST /api/auth/change-password ──────────────────────────────
// Authenticated user changes their own password. Requires current password.
router.post('/change-password', requireAuth, async (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) {
    return res.status(400).json({ error: 'Current and new password required' });
  }
  if (new_password.length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters' });
  }
  try {
    const { rows } = await query(`SELECT password_hash FROM users WHERE id = $1`, [req.userId]);
    const u = rows[0];
    if (!u || !u.password_hash) return res.status(404).json({ error: 'User not found' });

    const valid = await bcrypt.compare(current_password, u.password_hash);
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });

    const hash = await bcrypt.hash(new_password, 10);
    await query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [hash, req.userId]);

    await logActivity({
      actorUserId: req.userId, entityType: 'user', entityId: req.userId,
      action: 'password_changed', payload: {}
    });
    res.json({ success: true });
  } catch (err) {
    console.error('Change-password error:', err);
    res.status(500).json({ error: 'Failed to change password' });
  }
});

module.exports = router;
