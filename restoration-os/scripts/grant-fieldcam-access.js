#!/usr/bin/env node
/**
 * One-off: grant `fieldcam` access to a named user who already exists
 * in Prop Spot.
 *
 * Idempotent: re-running on a user who already has the grant is a no-op.
 *
 * Usage:
 *   DATABASE_URL='postgres://...' node scripts/grant-fieldcam-access.js
 *   DATABASE_URL='postgres://...' node scripts/grant-fieldcam-access.js "Jane Doe"
 *   DATABASE_URL='postgres://...' node scripts/grant-fieldcam-access.js jane@example.com
 */

require('dotenv').config();
const { Pool } = require('pg');

const QUERY = process.argv[2] || 'Jonathan Baghdady';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL not set'); process.exit(1); }
const db = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });

(async () => {
  const report = { query: QUERY };

  try {
    const isEmail = QUERY.includes('@');
    const { rows: candidates } = isEmail
      ? await db.query(
          `SELECT id, email, full_name FROM users WHERE email ILIKE $1`,
          [QUERY]
        )
      : await db.query(
          `SELECT id, email, full_name FROM users
            WHERE full_name ILIKE $1
            ORDER BY created_at`,
          [`%${QUERY}%`]
        );

    if (!candidates.length) {
      report.status = `no user matching "${QUERY}" — create the user first`;
      console.log(JSON.stringify(report, null, 2));
      process.exit(1);
    }
    if (candidates.length > 1) {
      report.status = `multiple users match "${QUERY}": ${candidates.map(c => `${c.full_name} <${c.email}>`).join(', ')} — re-run with the email to disambiguate`;
      console.log(JSON.stringify(report, null, 2));
      process.exit(1);
    }

    const u = candidates[0];
    report.user_id   = u.id;
    report.email     = u.email;
    report.full_name = u.full_name;

    const { rows: app } = await db.query(`SELECT id FROM apps WHERE slug = 'fieldcam'`);
    if (!app[0]) {
      report.status = 'no `fieldcam` app row found in apps table';
      console.log(JSON.stringify(report, null, 2));
      process.exit(1);
    }

    const result = await db.query(`
      INSERT INTO app_grants (user_id, app_id, role, scope, granted_by)
      VALUES ($1, $2, 'member', '{"all": true}'::jsonb, $1)
      ON CONFLICT (user_id, app_id) DO NOTHING
      RETURNING user_id
    `, [u.id, app[0].id]);

    report.status = result.rowCount
      ? `granted fieldcam access to ${u.full_name} <${u.email}>`
      : `${u.full_name} <${u.email}> already had fieldcam access — no change`;
  } catch (err) {
    report.status = `error: ${err.message}`;
    console.log(JSON.stringify(report, null, 2));
    process.exit(1);
  }

  console.log(JSON.stringify(report, null, 2));
  await db.end();
})();
