#!/usr/bin/env node
// Read-only probe: dump FieldCam property name/address pairs.
// Used to figure out what address format the team actually entered so
// the migration parser can be tuned.
//
// Usage:
//   FIELDCAM_DATABASE_URL='...' node scripts/sample-fieldcam-addresses.js

require('dotenv').config();
const { Pool } = require('pg');

const url = process.env.FIELDCAM_DATABASE_URL;
if (!url) { console.error('FIELDCAM_DATABASE_URL not set'); process.exit(1); }

const p = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });

(async () => {
  const { rows } = await p.query(
    `SELECT name, address FROM properties ORDER BY created_at`
  );
  for (const row of rows) {
    console.log(JSON.stringify({ name: row.name, address: row.address }));
  }
  await p.end();
})();
