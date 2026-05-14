#!/usr/bin/env node
/**
 * One-time migration: FieldCam DB → Prop Spot DB.
 *
 * Reads FIELDCAM_DATABASE_URL, writes to DATABASE_URL.
 * Idempotent: rerunning is safe. Existing Prop Spot rows are left alone.
 *
 * Usage:
 *   FIELDCAM_DATABASE_URL=postgres://... DATABASE_URL=postgres://... \
 *     node scripts/migrate-from-fieldcam.js [--dry-run]
 *
 * Order: users → properties → photos. FK remaps flow through in-memory maps
 * built as each table migrates. Bad rows are logged and skipped, never
 * abort the whole run.
 */

require('dotenv').config();
const { Pool } = require('pg');
const { normalizeAddress, parseFreetextAddress } = require('../lib/address');

const DRY_RUN = process.argv.includes('--dry-run');

const fcUrl = process.env.FIELDCAM_DATABASE_URL;
const osUrl = process.env.DATABASE_URL;

if (!fcUrl) { console.error('FIELDCAM_DATABASE_URL not set'); process.exit(1); }
if (!osUrl) { console.error('DATABASE_URL not set'); process.exit(1); }

const fc = new Pool({ connectionString: fcUrl, ssl: { rejectUnauthorized: false } });
const os = new Pool({ connectionString: osUrl, ssl: { rejectUnauthorized: false } });

const report = {
  users:      { migrated: 0, linked: 0, granted: 0, skipped: 0, errors: [] },
  properties: { migrated: 0, linked: 0, parse_failed: 0, errors: [] },
  photos:     { migrated: 0, skipped: 0, orphaned: 0, errors: [] }
};

const userMap = new Map();      // fcUserId → osUserId
const propertyMap = new Map();  // fcPropertyId → osPropertyId
let orphanBucketId = null;      // synthetic property for photos with no parent

function log(...args) { console.log('  ', ...args); }

async function fieldcamAppId() {
  const { rows } = await os.query(`SELECT id FROM apps WHERE slug = 'fieldcam'`);
  if (!rows[0]) throw new Error("Prop Spot has no 'fieldcam' row in apps table — seed first");
  return rows[0].id;
}

async function migrateUsers() {
  const appId = await fieldcamAppId();
  const { rows: fcUsers } = await fc.query(`
    SELECT id, email, full_name, password_hash, created_at
      FROM users
     ORDER BY created_at
  `);

  for (const u of fcUsers) {
    const email = (u.email || '').toLowerCase().trim();
    if (!email) { report.users.skipped++; continue; }

    try {
      const { rows: existing } = await os.query(
        `SELECT id, password_hash FROM users WHERE email = $1`, [email]
      );

      let osId;
      if (existing[0]) {
        osId = existing[0].id;
        report.users.linked++;
        if (u.password_hash && !existing[0].password_hash && !DRY_RUN) {
          await os.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [u.password_hash, osId]);
        }
      } else if (!DRY_RUN) {
        const { rows: ins } = await os.query(
          `INSERT INTO users (id, email, full_name, password_hash, created_at)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id`,
          [u.id, email, u.full_name, u.password_hash, u.created_at]
        );
        osId = ins[0].id;
        report.users.migrated++;
      } else {
        osId = u.id;
        report.users.migrated++;
      }

      userMap.set(u.id, osId);

      if (!DRY_RUN) {
        await os.query(
          `INSERT INTO app_grants (user_id, app_id, role, scope, granted_by)
           VALUES ($1, $2, 'member', '{"all": true}'::jsonb, $1)
           ON CONFLICT (user_id, app_id) DO NOTHING`,
          [osId, appId]
        );
      }
      report.users.granted++;
    } catch (err) {
      report.users.errors.push({ email, error: err.message });
    }
  }
  log(`users: migrated=${report.users.migrated} linked=${report.users.linked} granted=${report.users.granted} skipped=${report.users.skipped} errors=${report.users.errors.length}`);
}

async function migrateProperties() {
  // Some FieldCam DBs predate the os_property_id column. Probe and adapt.
  const { rows: cols } = await fc.query(`
    SELECT column_name FROM information_schema.columns
     WHERE table_name = 'properties'
  `);
  const colSet = new Set(cols.map(c => c.column_name));
  const hasOsPropertyId = colSet.has('os_property_id');

  const selectCols = ['id', 'name', 'address', 'notes', 'lat', 'lng', 'cover_url', 'created_by', 'created_at'];
  if (hasOsPropertyId) selectCols.push('os_property_id');

  const { rows: fcProps } = await fc.query(`
    SELECT ${selectCols.join(', ')}
      FROM properties
     ORDER BY created_at
  `);

  for (const p of fcProps) {
    try {
      // Already linked to a Prop Spot property?
      if (hasOsPropertyId && p.os_property_id) {
        const { rows: hit } = await os.query(
          `SELECT id FROM properties WHERE id = $1`, [p.os_property_id]
        );
        if (hit[0]) {
          propertyMap.set(p.id, hit[0].id);
          report.properties.linked++;
          continue;
        }
      }

      const parsed = parseFreetextAddress(p.address);
      if (!parsed.ok) report.properties.parse_failed++;

      const normalized = normalizeAddress(parsed);

      // Dedup by normalized_address.
      const { rows: existing } = await os.query(
        `SELECT id FROM properties WHERE normalized_address = $1`, [normalized]
      );
      if (existing[0]) {
        propertyMap.set(p.id, existing[0].id);
        report.properties.linked++;
        continue;
      }

      const notesPrefix = parsed.ok ? '' : `[migrated] Original address: ${p.address}\n\n`;
      const notes = (notesPrefix + (p.notes || '')).trim() || null;
      const createdBy = userMap.get(p.created_by) || null;

      if (DRY_RUN) {
        propertyMap.set(p.id, p.id);
        report.properties.migrated++;
        continue;
      }

      const { rows: ins } = await os.query(`
        INSERT INTO properties
          (id, address_line1, city, state, zip, normalized_address, lat, lng, cover_url, notes, display_name, created_by, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        RETURNING id
      `, [
        p.id,
        parsed.address_line1, parsed.city, parsed.state, parsed.zip, normalized,
        p.lat, p.lng, p.cover_url, notes, p.name || null,
        createdBy, p.created_at
      ]);

      propertyMap.set(p.id, ins[0].id);
      report.properties.migrated++;
    } catch (err) {
      report.properties.errors.push({ fc_id: p.id, address: p.address, error: err.message });
    }
  }
  log(`properties: migrated=${report.properties.migrated} linked=${report.properties.linked} parse_failed=${report.properties.parse_failed} errors=${report.properties.errors.length}`);
}

async function getOrCreateOrphanBucket() {
  if (orphanBucketId) return orphanBucketId;
  const sentinel = { address_line1: 'Migrated photos — needs review', city: 'UNKNOWN', state: 'XX', zip: '00000' };
  const normalized = normalizeAddress(sentinel);
  const { rows: hit } = await os.query(`SELECT id FROM properties WHERE normalized_address = $1`, [normalized]);
  if (hit[0]) { orphanBucketId = hit[0].id; return orphanBucketId; }
  if (DRY_RUN) { orphanBucketId = '00000000-0000-0000-0000-000000000000'; return orphanBucketId; }
  const { rows: ins } = await os.query(`
    INSERT INTO properties (address_line1, city, state, zip, normalized_address, notes)
    VALUES ($1, $2, $3, $4, $5, '[migrated] Auto-created bucket for FieldCam photos with no resolvable parent property.')
    RETURNING id
  `, [sentinel.address_line1, sentinel.city, sentinel.state, sentinel.zip, normalized]);
  orphanBucketId = ins[0].id;
  return orphanBucketId;
}

async function migratePhotos() {
  const { rows: fcPhotos } = await fc.query(`
    SELECT id, property_id, uploaded_by, url, cloudinary_id, lat, lng, notes, taken_at, created_at
      FROM photos
     ORDER BY taken_at
  `);

  for (const ph of fcPhotos) {
    try {
      let propId = propertyMap.get(ph.property_id);
      if (!propId) {
        propId = await getOrCreateOrphanBucket();
        report.photos.orphaned++;
      }

      // Idempotency: skip if (cloudinary_id, property_id) already present.
      if (ph.cloudinary_id) {
        const { rows: dup } = await os.query(
          `SELECT id FROM photos WHERE cloudinary_id = $1 AND property_id = $2`,
          [ph.cloudinary_id, propId]
        );
        if (dup[0]) { report.photos.skipped++; continue; }
      }

      const uploadedBy = userMap.get(ph.uploaded_by) || null;

      if (DRY_RUN) { report.photos.migrated++; continue; }

      await os.query(`
        INSERT INTO photos
          (id, property_id, uploaded_by, url, cloudinary_id, lat, lng, notes, taken_at, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      `, [
        ph.id, propId, uploadedBy, ph.url, ph.cloudinary_id,
        ph.lat, ph.lng, ph.notes, ph.taken_at, ph.created_at
      ]);
      report.photos.migrated++;
    } catch (err) {
      report.photos.errors.push({ fc_id: ph.id, error: err.message });
    }
  }
  log(`photos: migrated=${report.photos.migrated} skipped=${report.photos.skipped} orphaned=${report.photos.orphaned} errors=${report.photos.errors.length}`);
}

(async () => {
  console.log(`\n=== FieldCam → Prop Spot migration ${DRY_RUN ? '(DRY RUN)' : ''} ===\n`);
  try {
    log('1. Users');
    await migrateUsers();

    log('2. Properties');
    await migrateProperties();

    log('3. Photos');
    await migratePhotos();

    console.log('\n=== Summary ===');
    console.error(JSON.stringify(report, null, 2));

    if (DRY_RUN) {
      console.log('\nDry run only. No writes were made to Prop Spot.');
    } else {
      console.log('\nMigration complete.');
    }
  } catch (err) {
    console.error('Fatal:', err);
    process.exitCode = 1;
  } finally {
    await fc.end();
    await os.end();
  }
})();
