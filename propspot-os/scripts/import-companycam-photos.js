#!/usr/bin/env node
/**
 * Phase B of the CompanyCam migration. Pulls every photo from each
 * property that has a `companycam_project_id` set (Phase A populated
 * these), re-hosts it on Cloudinary, and inserts a row into the
 * `photos` table so it shows up in FieldCam and on the property page.
 *
 * Idempotent: photos already migrated (matched by companycam_photo_id)
 * are skipped on re-run. Safe to interrupt and re-run.
 *
 * Concurrency: uploads N photos in flight at a time (default 5).
 *
 * Required env:
 *   DATABASE_URL              Prop Spot Postgres
 *   COMPANYCAM_API_KEY        Read-only CC API token
 *   CLOUDINARY_CLOUD_NAME
 *   CLOUDINARY_API_KEY
 *   CLOUDINARY_API_SECRET
 *
 * Usage:
 *   node scripts/import-companycam-photos.js               # dry run (enumerate only)
 *   node scripts/import-companycam-photos.js --migrate     # live (download + upload + insert)
 *   node scripts/import-companycam-photos.js --migrate --concurrency 10
 *   node scripts/import-companycam-photos.js --migrate --limit-projects 1   # one project, smoke test
 */

require('dotenv').config();
const { Pool }     = require('pg');
const cloudinary   = require('cloudinary').v2;

const args = process.argv.slice(2);
const DO_WRITE = args.includes('--migrate');
function argVal(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const CONCURRENCY     = parseInt(argVal('--concurrency', '5'), 10);
const LIMIT_PROJECTS  = parseInt(argVal('--limit-projects', '0'), 10) || null;

const CC_KEY = process.env.COMPANYCAM_API_KEY;
const DB_URL = process.env.DATABASE_URL;
if (!CC_KEY) { console.error('COMPANYCAM_API_KEY not set'); process.exit(1); }
if (!DB_URL) { console.error('DATABASE_URL not set'); process.exit(1); }
if (DO_WRITE) {
  if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
    console.error('Cloudinary credentials missing — CLOUDINARY_CLOUD_NAME / _API_KEY / _API_SECRET required for --migrate');
    process.exit(1);
  }
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key:    process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
}

const db = new Pool({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });

// ── CC API helpers ──────────────────────────────────────────────────────
async function ccGet(path) {
  const url = `https://api.companycam.com${path}`;
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${CC_KEY}` } });
    if (res.ok) return res.json();
    if (res.status === 429) {
      const wait = Math.min(60_000, 2_000 * Math.pow(2, attempt));
      console.error(`  CC 429 rate-limited, sleeping ${wait}ms…`);
      await new Promise(r => setTimeout(r, wait));
      continue;
    }
    if (res.status >= 500 && attempt < 3) {
      await new Promise(r => setTimeout(r, 2_000 * (attempt + 1)));
      continue;
    }
    throw new Error(`CC ${res.status}: ${await res.text().catch(() => '')}`);
  }
  throw new Error('CC retries exhausted');
}

async function fetchAllPhotosForProject(ccProjectId) {
  const all = [];
  let page = 1;
  // CC pages; per_page max varies but 100 is broadly safe.
  while (true) {
    const batch = await ccGet(`/v2/projects/${ccProjectId}/photos?per_page=100&page=${page}`);
    if (!Array.isArray(batch) || batch.length === 0) break;
    all.push(...batch);
    if (batch.length < 100) break;
    page++;
  }
  return all;
}

function pickOriginalUri(uris) {
  // Prefer non-annotated original so we're storing the raw image.
  const orig = uris.find(u => u.type === 'original');
  return orig?.uri || orig?.url || null;
}

// ── User mapping (CC creator_name → PropSpot user_id) ──────────────────
async function buildUserMap() {
  const ccUsers = await ccGet('/v2/users?per_page=200');
  const ccById  = new Map();
  for (const u of ccUsers) {
    const name = ((u.first_name || '') + ' ' + (u.last_name || '')).replace(/\s+/g, ' ').trim();
    ccById.set(String(u.id), { name, email: u.email_address });
  }

  const { rows: psUsers } = await db.query(
    'SELECT id, full_name, email, google_email FROM users'
  );
  const psByName  = new Map();
  const psByLocal = new Map();
  for (const u of psUsers) {
    if (u.full_name) psByName.set(u.full_name.toLowerCase().trim().replace(/\s+/g, ' '), u.id);
    for (const e of [u.email, u.google_email]) {
      if (!e) continue;
      const local = e.toLowerCase().split('@')[0];
      if (local) psByLocal.set(local, u.id);
    }
  }

  const ccIdToPsId = new Map();
  const unmatched  = [];
  for (const [ccId, info] of ccById) {
    const nameKey  = info.name.toLowerCase();
    const localKey = (info.email || '').toLowerCase().split('@')[0];
    const psId = psByName.get(nameKey) || (localKey && psByLocal.get(localKey)) || null;
    if (psId) ccIdToPsId.set(ccId, psId);
    else      unmatched.push(info.name || `(cc-id=${ccId})`);
  }
  return { ccIdToPsId, unmatched };
}

// ── Cloudinary upload (streaming buffer) ───────────────────────────────
function uploadBufferToCloudinary(buffer, folder, publicId) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder, public_id: publicId, resource_type: 'image', overwrite: false },
      (err, result) => err ? reject(err) : resolve(result)
    );
    stream.end(buffer);
  });
}

// ── Bounded-concurrency runner ─────────────────────────────────────────
async function runConcurrent(items, n, worker) {
  const results = [];
  let cursor = 0;
  async function pull() {
    while (cursor < items.length) {
      const i = cursor++;
      try { results[i] = await worker(items[i], i); }
      catch (err) { results[i] = { error: err }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, pull));
  return results;
}

// ── Schema self-migration ──────────────────────────────────────────────
async function selfMigrate() {
  await db.query(`
    ALTER TABLE photos ADD COLUMN IF NOT EXISTS companycam_photo_id TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS photos_companycam_uniq
      ON photos (companycam_photo_id) WHERE companycam_photo_id IS NOT NULL;
  `);
}

// ── Main ────────────────────────────────────────────────────────────────
(async () => {
  console.log(DO_WRITE
    ? `=== LIVE MIGRATION — concurrency=${CONCURRENCY} ${LIMIT_PROJECTS ? `(limit ${LIMIT_PROJECTS} projects)` : ''} ===`
    : '=== DRY RUN — enumerate photos only, no downloads ===');

  await selfMigrate();

  const { ccIdToPsId, unmatched } = await buildUserMap();
  console.log(`CC user mapping: ${ccIdToPsId.size} matched, ${unmatched.length} unmatched (photos by them get uploaded_by=NULL).`);
  if (unmatched.length) console.log(`  Unmatched: ${unmatched.join(', ')}`);

  const projQuery = `
    SELECT id AS property_id, companycam_project_id, address_line1, city, state
      FROM properties
     WHERE companycam_project_id IS NOT NULL
     ORDER BY created_at ASC
     ${LIMIT_PROJECTS ? `LIMIT ${LIMIT_PROJECTS}` : ''}
  `;
  const { rows: properties } = await db.query(projQuery);
  console.log(`Properties with CC links: ${properties.length}\n`);

  const report = {
    projects_processed: 0,
    photos_seen:        0,
    photos_skipped:     0,
    photos_migrated:    0,
    photo_errors:       0,
    project_errors:     0,
  };

  for (const p of properties) {
    const label = `${p.companycam_project_id.padStart(11)}  ${p.address_line1}, ${p.city}, ${p.state}`;
    let ccPhotos;
    try {
      ccPhotos = await fetchAllPhotosForProject(p.companycam_project_id);
    } catch (err) {
      console.log(`❌ PROJECT FAILED  ${label}  → ${err.message}`);
      report.project_errors++;
      continue;
    }
    report.photos_seen += ccPhotos.length;

    // Filter out photos we've already migrated.
    const ccIds = ccPhotos.map(p => String(p.id));
    let existingIds = new Set();
    if (ccIds.length) {
      const { rows } = await db.query(
        `SELECT companycam_photo_id FROM photos WHERE companycam_photo_id = ANY($1::text[])`,
        [ccIds]
      );
      existingIds = new Set(rows.map(r => r.companycam_photo_id));
    }
    const todo = ccPhotos.filter(ph => !existingIds.has(String(ph.id)));
    report.photos_skipped += ccPhotos.length - todo.length;

    console.log(`📁 ${label}  (${ccPhotos.length} photos, ${todo.length} to migrate)`);

    if (!DO_WRITE || todo.length === 0) {
      report.projects_processed++;
      continue;
    }

    const results = await runConcurrent(todo, CONCURRENCY, async (ph) => {
      const originalUri = pickOriginalUri(ph.uris || []);
      if (!originalUri) throw new Error('no original uri');

      const resp = await fetch(originalUri);
      if (!resp.ok) throw new Error(`CDN ${resp.status}`);
      const buf = Buffer.from(await resp.arrayBuffer());

      const folder   = `propspot/companycam/${p.companycam_project_id}`;
      const publicId = String(ph.id);
      const up = await uploadBufferToCloudinary(buf, folder, publicId);

      const uploadedBy = ccIdToPsId.get(String(ph.creator_id)) || null;
      const lat = ph.coordinates?.lat ?? null;
      const lng = ph.coordinates?.lon ?? null;
      const takenAt = ph.captured_at ? new Date(ph.captured_at * 1000) : null;

      await db.query(
        `INSERT INTO photos
           (property_id, uploaded_by, url, cloudinary_id, lat, lng,
            taken_at, notes, companycam_photo_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (companycam_photo_id) WHERE companycam_photo_id IS NOT NULL DO NOTHING`,
        [
          p.property_id, uploadedBy, up.secure_url, up.public_id,
          lat, lng, takenAt,
          `Imported from CompanyCam photo ${ph.id}` + (ph.creator_name ? ` (uploader: ${ph.creator_name})` : ''),
          String(ph.id),
        ]
      );
      return { ok: true };
    });

    const ok  = results.filter(r => r && r.ok).length;
    const err = results.filter(r => r && r.error).length;
    report.photos_migrated += ok;
    report.photo_errors    += err;
    if (err) {
      console.log(`   ⚠ ${err} photo error(s) in this project`);
      for (let i = 0; i < results.length; i++) {
        if (results[i]?.error) console.log(`     - cc-id=${todo[i].id}: ${results[i].error.message}`);
      }
    }
    report.projects_processed++;
  }

  console.log('\n=== Summary ===');
  console.log(`Projects processed:        ${report.projects_processed}`);
  console.log(`Project errors:            ${report.project_errors}`);
  console.log(`Photos seen (CC):          ${report.photos_seen}`);
  console.log(`Photos already migrated:   ${report.photos_skipped}`);
  console.log(`Photos newly migrated:     ${report.photos_migrated}`);
  console.log(`Photo errors:              ${report.photo_errors}`);

  await db.end();
})();
