'use strict';
require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
async function run() {
  await pool.query("ALTER TABLE properties ADD COLUMN IF NOT EXISTS investment_type TEXT CHECK (investment_type IN ('rental','flip'))");
  await pool.query('CREATE INDEX IF NOT EXISTS properties_investment_type_idx ON properties(investment_type)');
  console.log('Migration applied: investment_type column ready');
  await pool.end();
}
run().catch(e => { console.error(e.message); process.exit(1); });
