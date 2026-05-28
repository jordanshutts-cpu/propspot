// Shared test setup for timesheets tests that hit the DB.
// Requires DATABASE_URL pointing at a test database.

const { query } = require('../../db');

async function resetTimesheetTables() {
  await query('DELETE FROM timesheet_audit_log');
  await query('DELETE FROM timesheet_entries');
  await query('DELETE FROM gusto_employee_links WHERE gusto_employee_uuid LIKE \'test-%\'');
  await query('DELETE FROM timesheet_pay_periods WHERE gusto_pay_schedule_uuid LIKE \'test-%\' OR gusto_pay_schedule_uuid IS NULL');
}

async function ensureTestUser(email = 'tstuser@example.com', fullName = 'Test User') {
  const { rows } = await query(`
    INSERT INTO users (email, full_name)
    VALUES ($1, $2)
    ON CONFLICT (email) DO UPDATE SET full_name = EXCLUDED.full_name
    RETURNING id, email, full_name
  `, [email, fullName]);
  return rows[0];
}

async function ensureTestPayPeriod(starts = '2026-05-18', ends = '2026-05-31', payday = '2026-06-05') {
  const { rows } = await query(`
    INSERT INTO timesheet_pay_periods (starts_on, ends_on, payday)
    VALUES ($1, $2, $3)
    ON CONFLICT (starts_on, ends_on) DO UPDATE SET payday = EXCLUDED.payday
    RETURNING *
  `, [starts, ends, payday]);
  return rows[0];
}

module.exports = { resetTimesheetTables, ensureTestUser, ensureTestPayPeriod };
