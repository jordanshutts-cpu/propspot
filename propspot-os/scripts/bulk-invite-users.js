#!/usr/bin/env node
/**
 * One-off: bulk-invite Google Workspace members into Prop Spot.
 *
 * Two modes:
 *   (default)  Dry run. Connects to DB, reports per-user status, sends nothing.
 *   --invite   Real run. Upserts users, mints 48-hour invite tokens, emails
 *              the invite link via lib/email.js (or prints links if SMTP
 *              isn't configured), logs to the activity table.
 *
 * Idempotent: already-active users (with a password_hash) are skipped.
 * Users with a still-valid pending invite are skipped unless --force.
 *
 * Usage:
 *   DATABASE_URL='postgres://...' node scripts/bulk-invite-users.js
 *   DATABASE_URL='postgres://...' node scripts/bulk-invite-users.js --invite
 *   DATABASE_URL='postgres://...' node scripts/bulk-invite-users.js --invite --force
 */

require('dotenv').config();
const crypto = require('crypto');
const { Pool } = require('pg');
const { sendInviteEmail } = require('../lib/email');
const { logActivity } = require('../lib/activity');

// ── User roster (Google Workspace → Prop Spot) ──────────────────────────
// type=Owner   → is_owner=TRUE  (auto-grants all enabled apps via seed logic)
// type=other   → is_owner=FALSE (no grants; promote later in admin UI)
const USERS = [
  { name: 'Aira',            email: 'aira@restorationhomes.com',            type: 'VA' },
  { name: 'Billy',           email: 'billy@restorationhomes.com',           type: 'VA' },
  { name: 'Camille',         email: 'camille@restorationhomes.com',         type: 'VA' },
  { name: 'Daniel',          email: 'daniel@restorationhomes.com',          type: 'VA' },
  { name: 'Frederick',       email: 'frederick@restorationhomes.com',       type: 'VA' },
  { name: 'Manpreet',        email: 'manpreet@restorationhomes.com',        type: 'VA' },
  { name: 'Sofia',           email: 'sofia@restorationhomes.com',           type: 'VA' },
  { name: 'Adam Slipakoff',  email: 'adam.slipakoff@restorationhomes.com',  type: 'Owner' },
  { name: 'Alex Fisher',     email: 'alex.fisher@restorationhomes.com',     type: 'Owner' },
  { name: 'Carson Gantz',    email: 'carson.gantz@restorationhomes.com',    type: 'Employee' },
  { name: 'Erika Templin',   email: 'erika.templin@restorationhomes.com',   type: 'Contractor' },
  { name: 'Giewel Amparo',   email: 'giewel.amparo@rentdwella.com',         type: 'VA' },
  { name: 'Jennifer Ott',    email: 'jott@rentdwella.com',                  type: 'Employee' },
  { name: 'Jen Slipakoff',   email: 'jen.slipakoff@restorationhomes.com',   type: 'Employee' },
  { name: 'Jordan Shutts',   email: 'jordan.shutts@restorationhomes.com',   type: 'Owner' },
  { name: 'Megan Price',     email: 'megan.price@restorationhomes.com',     type: 'Contractor' },
  { name: 'Sheri Merriam',   email: 'sheri.merriam@restorationhomes.com',   type: 'Employee' },
];

const args     = process.argv.slice(2);
const DO_WRITE = args.includes('--invite');
const FORCE    = args.includes('--force');

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL not set'); process.exit(1); }
const db = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });

function fmtRow(status, u, extra = '') {
  const owner = u.type === 'Owner' ? ' [OWNER]' : '';
  return `${status}  ${u.email.padEnd(42)} ${u.name.padEnd(18)} ${u.type.padEnd(11)}${owner ? owner : ''}${extra ? '  ' + extra : ''}`;
}

(async () => {
  const banner = DO_WRITE
    ? (FORCE ? '=== LIVE RUN (--invite --force) ===' : '=== LIVE RUN (--invite) ===')
    : '=== DRY RUN — no writes, no emails ===';
  console.log(banner);
  console.log(`Roster size: ${USERS.length}\n`);

  const report = {
    active_skipped:  0,
    pending_skipped: 0,
    invited:         0,
    reinvited:       0,
    errors:          0,
    unsent_links:    [],
  };

  // Resolve actor — prefer Jordan's row in the DB so activity log attributes correctly.
  let actorUserId = null;
  try {
    const { rows } = await db.query(
      `SELECT id FROM users WHERE email = $1 LIMIT 1`,
      ['jordan.shutts@restorationhomes.com']
    );
    actorUserId = rows[0]?.id || null;
  } catch (_) { /* leave null */ }

  for (const u of USERS) {
    const email    = u.email.toLowerCase().trim();
    const fullName = u.name;
    const isOwner  = u.type === 'Owner';

    try {
      const { rows } = await db.query(
        `SELECT id, password_hash, invite_token, invite_expires, is_owner
           FROM users WHERE email = $1 LIMIT 1`,
        [email]
      );
      const existing = rows[0];

      // 1. Already active — never re-invite.
      if (existing && existing.password_hash) {
        console.log(fmtRow('✓ ACTIVE     ', u, `(id=${existing.id.slice(0,8)})`));
        report.active_skipped++;
        continue;
      }

      // 2. Has a pending invite that is still valid — skip unless --force.
      const stillValid = existing
        && existing.invite_token
        && existing.invite_expires
        && new Date(existing.invite_expires) > new Date();
      if (stillValid && !FORCE) {
        const expiresIn = Math.round(
          (new Date(existing.invite_expires) - new Date()) / 3600000
        );
        console.log(fmtRow('⏳ PENDING   ', u, `(expires in ${expiresIn}h, use --force to re-invite)`));
        report.pending_skipped++;
        continue;
      }

      // 3. Either brand new, expired invite, or --force on a pending.
      if (!DO_WRITE) {
        const label = !existing
          ? '➕ NEW       '
          : (stillValid ? '🔁 REINVITE  ' : '⌛ EXPIRED   ');
        console.log(fmtRow(label, u, '(would invite)'));
        continue;
      }

      const token   = crypto.randomBytes(32).toString('hex');
      const expires = new Date(Date.now() + 48 * 60 * 60 * 1000);

      const { rows: upserted } = await db.query(
        `INSERT INTO users (email, full_name, invite_token, invite_expires, is_owner)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (email) DO UPDATE
           SET invite_token   = EXCLUDED.invite_token,
               invite_expires = EXCLUDED.invite_expires,
               full_name      = COALESCE(users.full_name, EXCLUDED.full_name),
               is_owner       = users.is_owner OR EXCLUDED.is_owner
         RETURNING id, is_owner`,
        [email, fullName, token, expires, isOwner]
      );
      const invitedUser = upserted[0];

      // Owners get full app grants — mirrors the signup/seed behavior.
      if (invitedUser.is_owner) {
        await db.query(`
          INSERT INTO app_grants (user_id, app_id, role, scope, granted_by)
          SELECT $1, a.id, 'owner', '{"all": true}'::jsonb, $1
            FROM apps a
            WHERE a.enabled = TRUE
            ON CONFLICT (user_id, app_id) DO UPDATE
              SET role = 'owner', scope = '{"all": true}'::jsonb
        `, [invitedUser.id]);
      }

      const appUrl     = process.env.APP_URL || 'https://os.propspot.io';
      const inviteLink = `${appUrl}/accept-invite.html?token=${token}`;
      const inviterName = 'Jordan Shutts';
      const emailSent  = await sendInviteEmail({
        to: email, inviteLink, inviterName,
        appsList: invitedUser.is_owner ? ['Prop Spot (full access)'] : ['Prop Spot'],
      });

      await logActivity({
        actorUserId, entityType: 'user', entityId: invitedUser.id,
        action: 'invited', payload: { email, bulk: true, type: u.type }
      });

      const wasReinvite = !!existing;
      if (wasReinvite) report.reinvited++; else report.invited++;

      const status = wasReinvite ? '🔁 REINVITED ' : '✅ INVITED   ';
      console.log(fmtRow(status, u, emailSent ? '(email sent)' : '(NO SMTP — link below)'));
      if (!emailSent) report.unsent_links.push({ email, inviteLink });
    } catch (err) {
      console.error(fmtRow('❌ ERROR     ', u, err.message));
      report.errors++;
    }
  }

  console.log('\n=== Summary ===');
  console.log(`Active (skipped):        ${report.active_skipped}`);
  console.log(`Pending (skipped):       ${report.pending_skipped}`);
  if (DO_WRITE) {
    console.log(`Newly invited:           ${report.invited}`);
    console.log(`Re-invited (expired):    ${report.reinvited}`);
  }
  console.log(`Errors:                  ${report.errors}`);

  if (report.unsent_links.length) {
    console.log('\n=== Invite links to share manually (SMTP not configured) ===');
    for (const { email, inviteLink } of report.unsent_links) {
      console.log(`${email}\n  ${inviteLink}`);
    }
  }

  await db.end();
})();
