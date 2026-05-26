const express = require('express');
const crypto  = require('crypto');
const { query, pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { logActivity } = require('../lib/activity');
const { sendInviteEmail } = require('../lib/email');
const { recomputeScopeForUser } = require('../lib/scope');

const router = express.Router();
router.use(requireAuth);

const VALID_TYPES = [
  'seller','buyer','lender','contractor','inspector','property_manager',
  'utility_company','buyer_agent','listing_agent','closing_attorney',
  'accountant','other'
];

// GET /api/contacts?type=contractor
router.get('/', async (req, res) => {
  const { type, q } = req.query;
  const params = [];
  const filters = [];
  if (type) { params.push(type); filters.push(`type = $${params.length}`); }
  if (q)    {
    params.push(`%${q.toLowerCase()}%`);
    filters.push(`(LOWER(full_name) LIKE $${params.length} OR LOWER(email) LIKE $${params.length} OR LOWER(company) LIKE $${params.length})`);
  }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  try {
    const { rows } = await query(`
      SELECT c.*,
             (c.user_id IS NOT NULL) AS has_account,
             (SELECT COUNT(*) FROM property_contacts WHERE contact_id = c.id)::int AS property_count
        FROM contacts c
        ${where}
       ORDER BY c.full_name
    `, params);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch contacts' });
  }
});

// GET /api/contacts/:id  (with linked properties)
router.get('/:id', async (req, res) => {
  try {
    const { rows: cRows } = await query('SELECT * FROM contacts WHERE id = $1', [req.params.id]);
    if (!cRows[0]) return res.status(404).json({ error: 'Contact not found' });

    const { rows: links } = await query(`
      SELECT pc.role, pc.is_primary, p.id, p.address_line1, p.city, p.state, p.zip
        FROM property_contacts pc
        JOIN properties p ON p.id = pc.property_id
       WHERE pc.contact_id = $1
       ORDER BY p.address_line1
    `, [req.params.id]);

    let userInfo = null;
    if (cRows[0].user_id) {
      const { rows: u } = await query(
        `SELECT id, email, full_name,
                (password_hash IS NOT NULL OR google_sub IS NOT NULL) AS is_active
           FROM users WHERE id = $1`, [cRows[0].user_id]
      );
      userInfo = u[0] || null;
    }

    res.json({ ...cRows[0], properties: links, user: userInfo });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch contact' });
  }
});

// POST /api/contacts
router.post('/', async (req, res) => {
  const { type, full_name, email, phone, company, notes } = req.body;
  if (!full_name?.trim()) return res.status(400).json({ error: 'full_name required' });
  if (type && !VALID_TYPES.includes(type)) {
    return res.status(400).json({ error: `type must be one of: ${VALID_TYPES.join(', ')}` });
  }
  try {
    const { rows } = await query(`
      INSERT INTO contacts (type, full_name, email, phone, company, notes, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `, [
      type || 'other',
      full_name.trim(),
      email?.trim().toLowerCase() || null,
      phone?.trim() || null,
      company?.trim() || null,
      notes?.trim() || null,
      req.userId
    ]);
    await logActivity({
      actorUserId: req.userId, entityType: 'contact', entityId: rows[0].id,
      action: 'created', payload: { type: rows[0].type, full_name: rows[0].full_name }
    });
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create contact' });
  }
});

// PATCH /api/contacts/:id
router.patch('/:id', async (req, res) => {
  const allowed = ['type','full_name','email','phone','company','notes'];
  const sets = []; const vals = []; let i = 1;
  for (const k of allowed) {
    if (req.body[k] !== undefined) {
      if (k === 'type' && !VALID_TYPES.includes(req.body[k])) {
        return res.status(400).json({ error: `Invalid type` });
      }
      sets.push(`${k} = $${i++}`); vals.push(req.body[k]);
    }
  }
  if (!sets.length) return res.status(400).json({ error: 'no fields to update' });
  vals.push(req.params.id);
  try {
    const { rows } = await query(
      `UPDATE contacts SET ${sets.join(', ')}, updated_at = NOW()
        WHERE id = $${i} RETURNING *`, vals
    );
    if (!rows[0]) return res.status(404).json({ error: 'Contact not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update contact' });
  }
});

// DELETE /api/contacts/:id
router.delete('/:id', async (req, res) => {
  try {
    await query('DELETE FROM contacts WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete contact' });
  }
});

// POST /api/contacts/:id/invite
//   body: { app_grants: [{ app_id, role, scope_kind: 'all'|'linked_projects' }, ...] }
//
// Promotes a contact into a user, fires off an invite email, and creates the
// requested app grants. If scope_kind = 'linked_projects', the grant scope is
// auto-populated with the projects this contact is currently linked to as a
// contractor (or any role).
router.post('/:id/invite', async (req, res) => {
  const { app_grants: grantSpec } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: cRows } = await client.query(
      'SELECT * FROM contacts WHERE id = $1', [req.params.id]
    );
    const contact = cRows[0];
    if (!contact)        { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Contact not found' }); }
    if (!contact.email)  { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Contact has no email — add one before inviting' }); }

    const { rows: inviterRows } = await client.query(
      'SELECT full_name FROM users WHERE id = $1', [req.userId]
    );
    const inviterName = inviterRows[0]?.full_name || 'Your teammate';

    // Insert OR update the user row, attaching invite token.
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
      [contact.email.toLowerCase(), contact.full_name, token, expires]
    );
    const user = userRows[0];

    // Link the contact to the user record
    await client.query(
      `UPDATE contacts SET user_id = $1, updated_at = NOW() WHERE id = $2`,
      [user.id, contact.id]
    );

    // Compute initial project_ids scope (linked projects through this contact)
    const { rows: linkedProjects } = await client.query(`
      SELECT DISTINCT pr.id
        FROM property_contacts pc
        JOIN projects pr ON pr.property_id = pc.property_id
       WHERE pc.contact_id = $1
    `, [contact.id]);
    const linkedProjectIds = linkedProjects.map(r => r.id);

    // Pre-create app grants
    const appsForEmail = [];
    if (Array.isArray(grantSpec) && grantSpec.length) {
      for (const g of grantSpec) {
        if (!g.app_id || !g.role) continue;
        const scope = g.scope_kind === 'linked_projects'
          ? { project_ids: linkedProjectIds }
          : (g.scope || { all: true });

        await client.query(
          `INSERT INTO app_grants (user_id, app_id, role, scope, granted_by)
           VALUES ($1, $2, $3, $4::jsonb, $5)
           ON CONFLICT (user_id, app_id) DO UPDATE
             SET role = EXCLUDED.role, scope = EXCLUDED.scope`,
          [user.id, g.app_id, g.role, JSON.stringify(scope), req.userId]
        );
        const { rows: a } = await client.query('SELECT name FROM apps WHERE id = $1', [g.app_id]);
        if (a[0]) appsForEmail.push(a[0].name);
      }
    }

    await client.query('COMMIT');

    const appUrl = process.env.APP_URL || 'http://localhost:3000';
    const inviteLink = `${appUrl}/accept-invite.html?token=${token}`;
    const emailSent = await sendInviteEmail({
      to: contact.email, inviteLink, inviterName, appsList: appsForEmail
    });

    await logActivity({
      actorUserId: req.userId, entityType: 'contact', entityId: contact.id,
      action: 'invited', payload: { email: contact.email, apps: appsForEmail }
    });

    res.json({
      message: emailSent
        ? `Invite email sent to ${contact.email}`
        : 'No email configured — share this link manually',
      inviteLink: emailSent ? undefined : inviteLink,
      contact_id: contact.id,
      user_id:    user.id
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Contact invite error:', err);
    res.status(500).json({ error: 'Failed to send invite' });
  } finally {
    client.release();
  }
});

module.exports = router;
