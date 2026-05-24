#!/usr/bin/env node
/**
 * One-off: bulk-create Prop Spot accounts for Google Workspace members.
 *
 * Designed for the SSO flow — no invite tokens, no invite emails. Each
 * user we create has no password_hash; they sign in by clicking
 * "Sign in with Google" at os.propspot.io. Their row's primary `email`
 * IS their Workspace address, so the SSO route matches them directly
 * and backfills google_sub on first sign-in.
 *
 * Two modes:
 *   (default)  Dry run. Reports per-user status, no writes.
 *   --create   Real run. Upserts users into the `users` table.
 *
 * Idempotent: users that already exist (any active method — password
 * OR google linked) are skipped. Rows with only a stale legacy invite
 * token are refreshed by stripping the token (the user can just
 * Google-sign-in now).
 *
 * Usage:
 *   DATABASE_URL='postgres://...' node scripts/bulk-invite-users.js
 *   DATABASE_URL='postgres://...' node scripts/bulk-invite-users.js --create
 */

require('dotenv').config();
const { Pool } = require('pg');
const { logActivity } = require('../lib/activity');

// ── Roster to create ────────────────────────────────────────────────────
// Already-active Workspace users (Adam, Alex, Carson, Erika, Jen Slipakoff,
// Sofia) are NOT in this list — they already have rows that the SSO
// route will match by email on first Google sign-in.
//
// Jordan handles his own merge (jordan@sellrh.com → linked to Google)
// via Edit Profile, not via this script.
//
// Jen Ott's existing jenngunnels@gmail.com row is left alone; this
// script creates her work account jott@rentdwella.com so she can
// switch to Google sign-in. Jordan can sort out the duplicate later.
const USERS = [
  { name: 'Jennifer Ott',  email: 'jott@rentdwella.com',                  type: 'Employee' },
  { name: 'Aira',          email: 'aira@restorationhomes.com',            type: 'VA' },
  { name: 'Billy',         email: 'billy@restorationhomes.com',           type: 'VA' },
  { name: 'Camille',       email: 'camille@restorationhomes.com',         type: 'VA' },
  { name: 'Daniel',        email: 'daniel@restorationhomes.com',          type: 'VA' },
  { name: 'Frederick',     email: 'frederick@restorationhomes.com',       type: 'VA' },
  { name: 'Manpreet',      email: 'manpreet@restorationhomes.com',        type: 'VA' },
  { name: 'Giewel Amparo', email: 'giewel.amparo@rentdwella.com',         type: 'VA' },
  { name: 'Megan Price',   email: 'megan.price@restorationhomes.com',     type: 'Contractor' },
  { name: 'Sheri Merriam', email: 'sheri.merriam@restorationhomes.com',   type: 'Employee' },
];

const args     = process.argv.slice(2);
const DO_WRITE = args.includes('--create') || args.includes('--invite'); // --invite kept for muscle memory

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL not set'); process.exit(1); }
const db = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });

function fmtRow(status, u, extra = '') {
  return `${status}  ${u.email.padEnd(42)} ${u.name.padEnd(16)} ${u.type.padEnd(11)}${extra ? '  ' + extra : ''}`;
}

(async () => {
  const banner = DO_WRITE ? '=== LIVE RUN — writing to DB ===' : '=== DRY RUN — no writes ===';
  console.log(banner);
  console.log(`Roster size: ${USERS.length}\n`);

  const report = {
    active_skipped: 0,
    created:        0,
    refreshed:      0,
    errors:         0,
  };

  // Owner attribution for activity log.
  let actorUserId = null;
  try {
    const { rows } = await db.query(
      `SELECT id FROM users WHERE email = $1 OR google_email = $1 LIMIT 1`,
      ['jordan@sellrh.com']
    );
    actorUserId = rows[0]?.id || null;
  } catch (_) {}

  for (const u of USERS) {
    const email    = u.email.toLowerCase().trim();
    const fullName = u.name;

    try {
      const { rows } = await db.query(
        `SELECT id, password_hash, google_sub, invite_token
           FROM users WHERE email = $1 LIMIT 1`,
        [email]
      );
      const existing = rows[0];

      // Already active — skip. "Active" here means either method works:
      // they've set a password, OR they've already linked Google.
      if (existing && (existing.password_hash || existing.google_sub)) {
        console.log(fmtRow('✓ ACTIVE   ', u, `(id=${existing.id.slice(0,8)})`));
        report.active_skipped++;
        continue;
      }

      if (!DO_WRITE) {
        const label = existing ? '🔁 REFRESH ' : '➕ NEW     ';
        const detail = existing ? '(has stale legacy invite — would clear)' : '(would create)';
        console.log(fmtRow(label, u, detail));
        continue;
      }

      // Upsert: create new, or strip stale legacy invite token from an
      // existing row that was never accepted (so it doesn't litter the
      // dashboard with a "Pending" badge — the user just signs in with
      // Google now).
      const { rows: upserted } = await db.query(
        `INSERT INTO users (email, full_name, is_owner)
         VALUES ($1, $2, FALSE)
         ON CONFLICT (email) DO UPDATE
           SET full_name      = COALESCE(users.full_name, EXCLUDED.full_name),
               invite_token   = NULL,
               invite_expires = NULL
         RETURNING id, (xmax = 0) AS inserted`,
        [email, fullName]
      );
      const row = upserted[0];

      await logActivity({
        actorUserId, entityType: 'user', entityId: row.id,
        action: row.inserted ? 'created' : 'invite_cleared',
        payload: { email, bulk_sso: true, type: u.type }
      });

      if (row.inserted) {
        report.created++;
        console.log(fmtRow('✅ CREATED ', u, `(id=${row.id.slice(0,8)})`));
      } else {
        report.refreshed++;
        console.log(fmtRow('🔁 REFRESHED', u, `(cleared stale invite, id=${row.id.slice(0,8)})`));
      }
    } catch (err) {
      console.error(fmtRow('❌ ERROR   ', u, err.message));
      report.errors++;
    }
  }

  console.log('\n=== Summary ===');
  console.log(`Active (skipped):  ${report.active_skipped}`);
  if (DO_WRITE) {
    console.log(`Newly created:     ${report.created}`);
    console.log(`Refreshed:         ${report.refreshed}`);
  }
  console.log(`Errors:            ${report.errors}`);

  if (DO_WRITE && (report.created + report.refreshed) > 0) {
    console.log('\nNext: tell these folks to visit https://os.propspot.io and click "Sign in with Google".');
  }

  await db.end();
})();
