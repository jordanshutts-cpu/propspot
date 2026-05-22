const { Pool } = require('pg');

// FieldCam talks to Prop Spot's Postgres (DATABASE_URL points at the OS).
// No schema is run from here — Prop Spot owns the canonical DDL.

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function query(text, params) {
  const start = Date.now();
  const res = await pool.query(text, params);
  const ms = Date.now() - start;
  if (process.env.NODE_ENV !== 'production') {
    console.log(`  DB [${ms}ms] ${text.slice(0, 60).replace(/\s+/g, ' ')}`);
  }
  return res;
}

module.exports = { query, pool };
