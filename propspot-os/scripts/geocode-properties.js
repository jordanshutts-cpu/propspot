#!/usr/bin/env node
/**
 * Backfill lat/lng on every property that doesn't have them yet, using
 * the Google Maps Geocoding API. Idempotent — properties with both
 * lat AND lng already set are skipped.
 *
 * Usage:
 *   DATABASE_URL='postgres://...' \
 *   GOOGLE_MAPS_API_KEY='AIza...' \
 *     node scripts/geocode-properties.js [--dry-run] [--all]
 *
 * Flags:
 *   --dry-run   Print the proposed updates, write nothing.
 *   --all       Re-geocode every property (even ones with lat/lng).
 *               Useful for canonicalising coordinates from Google's
 *               results.
 *
 * Requires the Geocoding API enabled on your GCP project for the key.
 */

require('dotenv').config();
const { Pool } = require('pg');

const DRY_RUN = process.argv.includes('--dry-run');
const ALL     = process.argv.includes('--all');

const apiKey = process.env.GOOGLE_MAPS_API_KEY;
const dbUrl  = process.env.DATABASE_URL;
if (!apiKey) { console.error('GOOGLE_MAPS_API_KEY not set'); process.exit(1); }
if (!dbUrl)  { console.error('DATABASE_URL not set');        process.exit(1); }

const db = new Pool({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });

async function geocode(address) {
  const url = 'https://maps.googleapis.com/maps/api/geocode/json'
            + '?address=' + encodeURIComponent(address)
            + '&key=' + apiKey;
  const r = await fetch(url);
  const data = await r.json();
  if (data.status === 'OK' && data.results?.[0]) {
    const g = data.results[0];
    return { ok: true, lat: g.geometry.location.lat, lng: g.geometry.location.lng,
             formatted: g.formatted_address };
  }
  return { ok: false, status: data.status || 'unknown',
           error: data.error_message || '(no message)' };
}

(async () => {
  const where = ALL ? '' : 'WHERE lat IS NULL OR lng IS NULL';
  const { rows } = await db.query(`
    SELECT id, address_line1, city, state, zip, lat, lng
      FROM properties
      ${where}
     ORDER BY created_at
  `);

  console.log(`\n=== Geocode ${DRY_RUN ? '(DRY RUN) ' : ''}${rows.length} properties ===\n`);

  const report = { ok: 0, skipped_unknown: 0, fail: [], requestDenied: false };

  for (const p of rows) {
    if (p.city === 'UNKNOWN' && p.state === 'XX') {
      console.log(`SKIP    ${p.id}  placeholder address — fix manually first`);
      report.skipped_unknown++;
      continue;
    }
    const addr = [p.address_line1, p.city, p.state, p.zip].filter(Boolean).join(', ');
    const r = await geocode(addr);
    if (!r.ok) {
      console.log(`FAIL    ${p.id}  ${addr}  →  ${r.status}: ${r.error}`);
      report.fail.push({ id: p.id, address: addr, status: r.status });
      if (r.status === 'REQUEST_DENIED') {
        report.requestDenied = true;
        break; // no point continuing — API key issue
      }
      continue;
    }
    console.log(`OK      ${p.id}  ${addr}  →  (${r.lat.toFixed(5)}, ${r.lng.toFixed(5)})`);
    if (!DRY_RUN) {
      await db.query(
        `UPDATE properties SET lat = $1, lng = $2, updated_at = NOW() WHERE id = $3`,
        [r.lat, r.lng, p.id]
      );
    }
    report.ok++;
    // Be polite to the Geocoding API.
    await new Promise(res => setTimeout(res, 100));
  }

  console.log('\n=== Summary ===');
  console.log(JSON.stringify({
    geocoded:   report.ok,
    skipped:    report.skipped_unknown,
    failed:     report.fail.length,
    failures:   report.fail.slice(0, 5)
  }, null, 2));

  if (report.requestDenied) {
    console.error('\nREQUEST_DENIED usually means the Geocoding API is not enabled');
    console.error('on your GCP project for this key. Enable it at:');
    console.error('  https://console.cloud.google.com/apis/library/geocoding-backend.googleapis.com');
  }

  await db.end();
})();
