const test = require('node:test');
const assert = require('node:assert');
const { query } = require('../../db');
const { autoCloseStale, assignPayPeriods, ensureNextPayPeriod } =
  require('../../workers/timesheets');
const { resetTimesheetTables, ensureTestUser } = require('./helpers');

test('autoCloseStale closes entries older than 14 hours and flags them', async () => {
  await resetTimesheetTables();
  const user = await ensureTestUser();
  const { rows: [e] } = await query(`
    INSERT INTO timesheet_entries (user_id, started_at)
    VALUES ($1, NOW() - INTERVAL '20 hours')
    RETURNING id
  `, [user.id]);

  const closed = await autoCloseStale();
  assert.ok(closed >= 1);

  const { rows } = await query(
    `SELECT ended_at, auto_closed, duration_minutes FROM timesheet_entries WHERE id = $1`,
    [e.id]);
  assert.ok(rows[0].ended_at);
  assert.strictEqual(rows[0].auto_closed, true);
  assert.strictEqual(rows[0].duration_minutes, 14 * 60);
});

test('autoCloseStale skips entries newer than 14 hours', async () => {
  await resetTimesheetTables();
  const user = await ensureTestUser();
  const { rows: [e] } = await query(`
    INSERT INTO timesheet_entries (user_id, started_at)
    VALUES ($1, NOW() - INTERVAL '2 hours')
    RETURNING id
  `, [user.id]);
  await autoCloseStale();
  const { rows } = await query(`SELECT ended_at FROM timesheet_entries WHERE id = $1`, [e.id]);
  assert.strictEqual(rows[0].ended_at, null);
});

test('assignPayPeriods backfills pay_period_id by date range', async () => {
  await resetTimesheetTables();
  const user = await ensureTestUser();
  const { rows: [pp] } = await query(`
    INSERT INTO timesheet_pay_periods (starts_on, ends_on, payday)
    VALUES ('2026-05-18', '2026-05-31', '2026-06-05')
    ON CONFLICT (starts_on, ends_on) DO UPDATE SET payday = EXCLUDED.payday
    RETURNING id
  `);
  const { rows: [e] } = await query(`
    INSERT INTO timesheet_entries (user_id, started_at, ended_at, duration_minutes)
    VALUES ($1, '2026-05-20T10:00:00Z', '2026-05-20T11:00:00Z', 60)
    RETURNING id
  `, [user.id]);

  const updated = await assignPayPeriods();
  assert.ok(updated >= 1);
  const { rows } = await query(`SELECT pay_period_id FROM timesheet_entries WHERE id = $1`, [e.id]);
  assert.strictEqual(rows[0].pay_period_id, pp.id);
});
