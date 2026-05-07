// ============================================================
//  One-shot migration: FieldCam-native users → Prop Spot
//
//  For each FieldCam user with a password_hash (i.e. someone who
//  actually signed up rather than a stale invite row):
//    1. Find or create a matching user in Prop Spot, copying the
//       bcrypt hash so they can sign in at os.propspot.io with
//       their existing FieldCam password.
//    2. Grant them the `fieldcam` app in Prop Spot.
//    3. Re-point FieldCam's photos.uploaded_by and properties.created_by
//       to the canonical Prop Spot user id (so photo attribution
//       survives the cutover). Leave a shadow row in FieldCam's
//       users table with the same id as Prop Spot's.
//
//  Idempotent: re-running this script is a no-op once a user has
//  been migrated (the password_hash column is set NULL on FieldCam
//  for migrated users so they're not picked up a second time).
//
//  Usage:
//    DATABASE_URL=postgres://...@.../railway        # FieldCam Postgres
//    PROP_SPOT_DATABASE_URL=postgres://...@.../...  # Prop Spot Postgres
//    node scripts/migrate-users-to-prop-spot.js
//
//  Get both URLs from Railway → service → Variables tab.
//  Run from your laptop, not from Railway (you need access to BOTH DBs).
// ============================================================

require('dotenv').config();
const { Pool } = require('pg');

const FC_URL = process.env.DATABASE_URL;
const PS_URL = process.env.PROP_SPOT_DATABASE_URL;

if (!FC_URL || !PS_URL) {
  console.error('Set DATABASE_URL (FieldCam) and PROP_SPOT_DATABASE_URL (Prop Spot)');
  process.exit(1);
}

const fc = new Pool({ connectionString: FC_URL, ssl: { rejectUnauthorized: false } });
const ps = new Pool({ connectionString: PS_URL, ssl: { rejectUnauthorized: false } });

async function main() {
  const { rows: fcUsers } = await fc.query(`
    SELECT id, email, full_name, password_hash, created_at
      FROM users
     WHERE password_hash IS NOT NULL
     ORDER BY created_at
  `);

  if (!fcUsers.length) {
    console.log('No FieldCam-native users to migrate. Done.');
    return;
  }

  const { rows: appRows } = await ps.query(
    `SELECT id FROM apps WHERE slug = 'fieldcam'`
  );
  if (!appRows[0]) {
    console.error('Prop Spot has no app row with slug=fieldcam. Run the OS once first so the seed inserts it.');
    process.exit(1);
  }
  const fieldcamAppId = appRows[0].id;

  console.log(`Found ${fcUsers.length} FieldCam user(s) to migrate.\n`);

  for (const u of fcUsers) {
    const email = u.email.toLowerCase().trim();
    console.log(`→ ${email}`);

    // Step 1: find or create in Prop Spot
    const { rows: existing } = await ps.query(
      `SELECT id, password_hash FROM users WHERE email = $1`, [email]
    );

    let osId;
    if (existing[0]) {
      osId = existing[0].id;
      console.log(`    already in Prop Spot as ${osId}`);
      // If Prop Spot user has no password yet (e.g. owner placeholder),
      // copy over the FieldCam hash so they can sign in.
      if (!existing[0].password_hash) {
        await ps.query(
          `UPDATE users SET password_hash = $1 WHERE id = $2`,
          [u.password_hash, osId]
        );
        console.log(`    copied bcrypt hash into Prop Spot user`);
      }
    } else {
      // Create using FieldCam's id so existing FieldCam FKs stay valid
      // without remap. (OS users.id has no other constraints.)
      const { rows: ins } = await ps.query(
        `INSERT INTO users (id, email, full_name, password_hash, created_at)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [u.id, email, u.full_name, u.password_hash, u.created_at]
      );
      osId = ins[0].id;
      console.log(`    created in Prop Spot as ${osId} (kept FieldCam id)`);
    }

    // Step 2: grant fieldcam access (idempotent)
    await ps.query(
      `INSERT INTO app_grants (user_id, app_id, role, scope, granted_by)
       VALUES ($1, $2, 'member', '{"all": true}'::jsonb, $1)
       ON CONFLICT (user_id, app_id) DO NOTHING`,
      [osId, fieldcamAppId]
    );
    console.log(`    granted fieldcam app access`);

    // Step 3: if Prop Spot user id differs from FieldCam id, remap FKs
    if (osId !== u.id) {
      const client = await fc.connect();
      try {
        await client.query('BEGIN');

        // Insert shadow row with the OS id BEFORE we remap (so
        // photos/properties always point to a valid users.id)
        await client.query(
          `INSERT INTO users (id, email, full_name, created_at)
           VALUES ($1, $2, $3, NOW())
           ON CONFLICT (id) DO NOTHING`,
          [osId, email + '.tmp-' + Date.now(), u.full_name]
        );

        // Remap FK refs from old FieldCam id to new OS id
        const { rowCount: photoCount } = await client.query(
          `UPDATE photos SET uploaded_by = $1 WHERE uploaded_by = $2`,
          [osId, u.id]
        );
        const { rowCount: propCount } = await client.query(
          `UPDATE properties SET created_by = $1 WHERE created_by = $2`,
          [osId, u.id]
        );

        // Now safely delete the old FieldCam user row
        await client.query(`DELETE FROM users WHERE id = $1`, [u.id]);

        // Update the shadow row's email to the real email (now that the
        // old row is gone, no UNIQUE conflict)
        await client.query(
          `UPDATE users SET email = $1 WHERE id = $2`,
          [email, osId]
        );

        await client.query('COMMIT');
        console.log(`    remapped ${photoCount} photo(s), ${propCount} property/ies, deleted old user row`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } else {
      // OS id == FieldCam id — just clear the password hash on FieldCam
      // so this row is no longer treated as a native user. The shadow
      // sync from now on writes to this same row.
      await fc.query(
        `UPDATE users SET password_hash = NULL,
                          invite_token = NULL,
                          invite_expires = NULL
          WHERE id = $1`, [u.id]
      );
      console.log(`    cleared FieldCam password (shadow row preserved)`);
    }
  }

  console.log(`\nMigration complete. ${fcUsers.length} user(s) migrated.`);
  console.log('Verify in Prop Spot: SELECT email, password_hash IS NOT NULL AS has_pw FROM users;');
  console.log('Then sign in at os.propspot.io with your old FieldCam credentials.');
}

main()
  .catch(err => { console.error('Migration failed:', err); process.exit(1); })
  .finally(() => Promise.all([fc.end(), ps.end()]));
