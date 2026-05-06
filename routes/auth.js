const express  = require('express');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const crypto   = require('crypto');
const nodemailer = require('nodemailer');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// ── Helpers ────────────────────────────────────────────────────

function signToken(userId, email) {
  return jwt.sign(
    { userId, email },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '30d' }
  );
}

function safeUser(u) {
  const { password_hash, invite_token, invite_expires, ...safe } = u;
  return safe;
}

async function sendInviteEmail(toEmail, inviteLink, inviterName) {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER) {
    console.log('📧 No SMTP configured — invite link:', inviteLink);
    return false; // Caller will return the link in the response
  }

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT) || 587,
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });

  await transporter.sendMail({
    from: process.env.FROM_EMAIL || 'FieldCam <noreply@fieldcam.app>',
    to: toEmail,
    subject: `${inviterName} invited you to FieldCam`,
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;">
        <h2 style="color:#f97316;">📸 You're invited to FieldCam</h2>
        <p>${inviterName} has invited you to collaborate on renovation photos in FieldCam.</p>
        <p>Click below to create your account:</p>
        <a href="${inviteLink}"
           style="display:inline-block;background:#f97316;color:#fff;padding:12px 28px;
                  border-radius:8px;text-decoration:none;font-weight:600;margin:16px 0;">
          Accept Invite
        </a>
        <p style="color:#888;font-size:12px;">Link expires in 48 hours.</p>
      </div>`
  });
  return true;
}

// ── POST /api/auth/signup ───────────────────────────────────────
router.post('/signup', async (req, res) => {
  const { email, password, fullName } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  if (password.length < 6)  return res.status(400).json({ error: 'Password must be at least 6 characters' });

  try {
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await query(
      `INSERT INTO users (email, full_name, password_hash)
       VALUES ($1, $2, $3)
       ON CONFLICT (email) DO NOTHING
       RETURNING *`,
      [email.toLowerCase().trim(), fullName || email.split('@')[0], hash]
    );

    if (rows.length === 0) return res.status(409).json({ error: 'An account with this email already exists' });

    const user  = rows[0];
    const token = signToken(user.id, user.email);
    res.status(201).json({ token, user: safeUser(user) });
  } catch (err) {
    console.error('Signup error:', err);
    res.status(500).json({ error: 'Signup failed' });
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

// ── GET /api/auth/me ────────────────────────────────────────────
router.get('/me', requireAuth, async (req, res) => {
  try {
    const { rows } = await query('SELECT * FROM users WHERE id = $1', [req.userId]);
    if (!rows[0]) return res.status(404).json({ error: 'User not found' });
    res.json(safeUser(rows[0]));
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

// ── POST /api/auth/invite ───────────────────────────────────────
router.post('/invite', requireAuth, async (req, res) => {
  const { email, fullName } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required' });

  try {
    // Get inviter's name
    const { rows: inviterRows } = await query(
      'SELECT full_name FROM users WHERE id = $1', [req.userId]
    );
    const inviterName = inviterRows[0]?.full_name || 'Your teammate';

    // Create or update invited user record
    const token   = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 48 * 60 * 60 * 1000); // 48h

    await query(
      `INSERT INTO users (email, full_name, invite_token, invite_expires)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (email) DO UPDATE
         SET invite_token = $3, invite_expires = $4`,
      [email.toLowerCase().trim(), fullName || email.split('@')[0], token, expires]
    );

    const appUrl     = process.env.APP_URL || 'http://localhost:3000';
    const inviteLink = `${appUrl}/accept-invite.html?token=${token}`;

    const emailSent = await sendInviteEmail(email, inviteLink, inviterName);

    res.json({
      message: emailSent
        ? `Invite email sent to ${email}`
        : `No email configured — share this link manually`,
      inviteLink: emailSent ? undefined : inviteLink
    });
  } catch (err) {
    console.error('Invite error:', err);
    res.status(500).json({ error: 'Failed to send invite' });
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
           full_name = COALESCE($2, full_name),
           invite_token = NULL,
           invite_expires = NULL
       WHERE id = $3
       RETURNING *`,
      [hash, fullName || null, rows[0].id]
    );

    const user  = updated[0];
    const jwtToken = signToken(user.id, user.email);
    res.json({ token: jwtToken, user: safeUser(user) });
  } catch (err) {
    console.error('Accept invite error:', err);
    res.status(500).json({ error: 'Failed to accept invite' });
  }
});

module.exports = router;
