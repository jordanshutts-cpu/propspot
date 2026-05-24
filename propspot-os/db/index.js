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

  // ── Underwriting tables migration ────────────────────────────────────────
  // The legacy Python underwriter service created uw_audit_log with a
  // different schema (property_id instead of deal_id). If those old tables
  // are present, drop them first so we can recreate with the correct schema.
  await pool.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'uw_audit_log'
      ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name   = 'uw_audit_log'
           AND column_name  = 'deal_id'
      ) THEN
        DROP TABLE IF EXISTS uw_audit_log CASCADE;
        DROP TABLE IF EXISTS uw_snapshots  CASCADE;
        DROP TABLE IF EXISTS uw_deals      CASCADE;
      END IF;
    END $$;
  `);

  // Run as explicit individual queries so they are always applied even if the
  // large schema batch stops early (pg simple-query protocol can silently drop
  // trailing statements after complex DO blocks).
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

  // Bootstrap the first owner row (idempotent). Now also sets is_owner=TRUE
  // and role='admin' on the existing or newly-inserted row so re-running the
  // bootstrap promotes an already-signed-up account to owner.
  if (process.env.BOOTSTRAP_OWNER_EMAIL) {
    const email = process.env.BOOTSTRAP_OWNER_EMAIL.toLowerCase().trim();
    await pool.query(
      `INSERT INTO users (email, full_name, is_owner, role)
       VALUES ($1, 'Owner', TRUE, 'admin')
       ON CONFLICT (email) DO UPDATE
         SET is_owner = TRUE, role = 'admin'`,
      [email]
    );
  }

  // Hardcoded owner promotions (idempotent). Guarantees the founding
  // accounts always have owner+admin even when BOOTSTRAP_OWNER_EMAIL is unset
  // in Railway. The UPDATE is a no-op once both columns already match.
  await pool.query(
    `UPDATE users
        SET is_owner = TRUE, role = 'admin'
      WHERE LOWER(email) = ANY($1::text[])
        AND (is_owner = FALSE OR role IS DISTINCT FROM 'admin')`,
    [['ejslipakoff@gmail.com', 'jordan@sellrh.com']]
  );

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
