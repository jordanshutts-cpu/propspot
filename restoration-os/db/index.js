const { Pool } = require('pg');
const fs   = require('fs');
const path = require('path');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function initDb() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(schema);

  const seed = fs.readFileSync(path.join(__dirname, 'seed.sql'), 'utf8');
  await pool.query(seed);

  // Bootstrap the first owner row (idempotent — uses ON CONFLICT DO NOTHING).
  // They show up in /api/team as "Invited" until they sign up at /index.html.
  if (process.env.BOOTSTRAP_OWNER_EMAIL) {
    await pool.query(
      `INSERT INTO users (email, full_name)
       VALUES ($1, 'Owner')
       ON CONFLICT (email) DO NOTHING`,
      [process.env.BOOTSTRAP_OWNER_EMAIL.toLowerCase().trim()]
    );
  }

  console.log('Database schema + seed ready');
}

async function query(text, params) {
  const start = Date.now();
  const res = await pool.query(text, params);
  const ms = Date.now() - start;
  if (process.env.NODE_ENV !== 'production') {
    console.log(`  DB [${ms}ms] ${text.slice(0, 80).replace(/\s+/g, ' ')}`);
  }
  return res;
}

module.exports = { query, initDb, pool };
