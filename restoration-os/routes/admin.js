// Owner-only admin endpoints. Mounted at /api/admin.

const express = require('express');
const { Pool } = require('pg');
const { query } = require('../db');
const { requireAuth, requireOwner } = require('../middleware/auth');
const { logActivity } = require('../lib/activity');

const router = express.Router();
router.use(requireAuth);
router.use(requireOwner);

// POST /api/admin/migrate-fieldcam
//
// Pulls all users with password_hash from FieldCam's Postgres (via
// FIELDCAM_DATABASE_URL env var on this service), copies them into
// Prop Spot's users table preserving bcrypt hashes, grants the
// `fieldcam` app to each, and remaps FieldCam's photos.uploaded_by
// and properties.created_by FK references when a Prop Spot user
// already exists with the same email.
//
// Idempotent: re-running is a no-op once users have been migrated
// (their FieldCam password_hash is set to NULL on success).
router.post('/migrate-fieldcam', async (req, res) => {
  const fcUrl = process.env.FIELDCAM_DATABASE_URL;
  if (!fcUrl) {
    return res.status(400).json({
      error: 'FIELDCAM_DATABASE_URL not set on this service'
    });
  }

  const fc = new Pool({
    connectionString: fcUrl,
    ssl: { rejectUnauthorized: false }
  });

  const report = { migrated: [], errors: [], skipped: 0 };

  try {
    const { rows: fcUsers } = await fc.query(`
      SELECT id, email, full_name, password_hash, created_at
        FROM users
       WHERE password_hash IS NOT NULL
       ORDER BY created_at
    `);

    if (!fcUsers.length) {
      await fc.end();
      return res.json({ ...report, message: 'No FieldCam-native users to migrate.' });
    }

    const { rows: appRows } = await query(
      `SELECT id FROM apps WHERE slug = 'fieldcam'`
    );
    if (!appRows[0]) {
      await fc.end();
      return res.status(500).json({ error: 'No fieldcam app row in Prop Spot' });
    }
    const fieldcamAppId = appRows[0].id;

    for (const u of fcUsers) {
      const email = (u.email || '').toLowerCase().trim();
      const entry = { email, actions: [] };

      try {
        // Step 1: find or create in Prop Spot
        const { rows: existing } = await query(
          `SELECT id, password_hash FROM users WHERE email = $1`, [email]
        );

        let osId;
        if (existing[0]) {
          osId = existing[0].id;
          entry.actions.push(`already in Prop Spot as ${osId}`);
          if (!existing[0].password_hash) {
            await query(
              `UPDATE users SET password_hash = $1 WHERE id = $2`,
              [u.password_hash, osId]
            );
            entry.actions.push('copied bcrypt hash');
          }
        } else {
          // Create in Prop Spot using FieldCam's id so existing FieldCam
          // FKs stay valid without remap.
          const { rows: ins } = await query(
            `INSERT INTO users (id, email, full_name, password_hash, created_at)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id`,
            [u.id, email, u.full_name, u.password_hash, u.created_at]
          );
          osId = ins[0].id;
          entry.actions.push(`created in Prop Spot as ${osId} (kept FieldCam id)`);
        }

        // Step 2: grant fieldcam app access (idempotent)
        await query(
          `INSERT INTO app_grants (user_id, app_id, role, scope, granted_by)
           VALUES ($1, $2, 'member', '{"all": true}'::jsonb, $1)
           ON CONFLICT (user_id, app_id) DO NOTHING`,
          [osId, fieldcamAppId]
        );
        entry.actions.push('granted fieldcam access');

        // Step 3: if Prop Spot id differs from FieldCam id, remap FKs
        if (osId !== u.id) {
          const client = await fc.connect();
          try {
            await client.query('BEGIN');

            // Insert temporary shadow row with the OS id under a temp email
            // to satisfy UNIQUE on email.
            await client.query(
              `INSERT INTO users (id, email, full_name, created_at)
               VALUES ($1, $2, $3, NOW())
               ON CONFLICT (id) DO NOTHING`,
              [osId, email + '.tmp-' + Date.now(), u.full_name]
            );

            const { rowCount: photoCount } = await client.query(
              `UPDATE photos SET uploaded_by = $1 WHERE uploaded_by = $2`,
              [osId, u.id]
            );
            const { rowCount: propCount } = await client.query(
              `UPDATE properties SET created_by = $1 WHERE created_by = $2`,
              [osId, u.id]
            );

            await client.query(`DELETE FROM users WHERE id = $1`, [u.id]);
            await client.query(
              `UPDATE users SET email = $1 WHERE id = $2`,
              [email, osId]
            );

            await client.query('COMMIT');
            entry.actions.push(
              `remapped ${photoCount} photo(s), ${propCount} property/ies`
            );
          } catch (err) {
            await client.query('ROLLBACK');
            throw err;
          } finally {
            client.release();
          }
        } else {
          // Same id — just clear FieldCam's credential columns.
          await fc.query(
            `UPDATE users SET password_hash = NULL,
                              invite_token = NULL,
                              invite_expires = NULL
              WHERE id = $1`, [u.id]
          );
          entry.actions.push('cleared FieldCam password (shadow row preserved)');
        }

        await logActivity({
          actorUserId: req.userId, entityType: 'user', entityId: osId,
          action: 'migrated_from_fieldcam', payload: { email }
        });

        report.migrated.push(entry);
      } catch (err) {
        console.error(`Migration failed for ${email}:`, err);
        report.errors.push({ email, error: err.message });
      }
    }
  } catch (err) {
    console.error('migrate-fieldcam failed:', err);
    return res.status(500).json({ error: err.message });
  } finally {
    await fc.end().catch(() => {});
  }

  res.json({
    message: `Migrated ${report.migrated.length} user(s).`,
    ...report
  });
});

module.exports = router;
