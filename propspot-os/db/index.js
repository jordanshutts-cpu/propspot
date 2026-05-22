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

  // ── Underwriting tables — run as explicit individual queries so they are
  // always applied even if the large schema batch stops early (pg simple-query
  // protocol can silently drop trailing statements after complex DO blocks).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS uw_deals (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      property_id       UUID REFERENCES properties(id) ON DELETE SET NULL,
      address           TEXT NOT NULL,
      city              TEXT,
      state             TEXT,
      zip               TEXT,
      county            TEXT,
      sqft              NUMERIC,
      list_price        NUMERIC,
      prelim_title_json JSONB,
      created_by        UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at        TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS uw_snapshots (
      id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      deal_id    UUID NOT NULL REFERENCES uw_deals(id) ON DELETE CASCADE,
      kind       TEXT NOT NULL CHECK(kind IN ('initial_pro_forma','actual_results')),
      data_json  JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
      UNIQUE(deal_id, kind)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS uw_audit_log (
      id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      deal_id    UUID NOT NULL REFERENCES uw_deals(id) ON DELETE CASCADE,
      kind       TEXT NOT NULL,
      field      TEXT NOT NULL,
      old_value  JSONB,
      new_value  JSONB,
      changed_by UUID REFERENCES users(id) ON DELETE SET NULL,
      changed_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS uw_audit_deal_idx ON uw_audit_log(deal_id, changed_at DESC)`
  );

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
