const test = require('node:test');
const assert = require('node:assert');
const { query } = require('../../db');
const { logFieldChange, logFieldChanges } = require('../../lib/timesheets-audit');
const { resetTimesheetTables, ensureTestUser, ensureTestPayPeriod } =
  require('./helpers');

test('logFieldChange writes one audit row', async () => {
  await resetTimesheetTables();
  const user = await ensureTestUser();
  const pp = await ensureTestPayPeriod();
  const { rows: [entry] } = await query(`
    INSERT INTO timesheet_entries (user_id, pay_period_id, started_at)
    VALUES ($1, $2, NOW())
    RETURNING id
  `, [user.id, pp.id]);

  await logFieldChange({
    entryId: entry.id,
    changedBy: user.id,
    field: 'category',
    oldValue: null,
    newValue: 'Underwriting',
  });

  const { rows } = await query(
    `SELECT field, new_value FROM timesheet_audit_log WHERE entry_id = $1`,
    [entry.id]
  );
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].field, 'category');
  assert.strictEqual(rows[0].new_value, 'Underwriting');
});

test('logFieldChanges writes one row per changed field, skips unchanged', async () => {
  await resetTimesheetTables();
  const user = await ensureTestUser();
  const pp = await ensureTestPayPeriod();
  const { rows: [entry] } = await query(`
    INSERT INTO timesheet_entries (user_id, pay_period_id, started_at)
    VALUES ($1, $2, NOW())
    RETURNING id
  `, [user.id, pp.id]);

  await logFieldChanges({
    entryId: entry.id,
    changedBy: user.id,
    before: { category: 'A', notes: 'old' },
    after:  { category: 'B', notes: 'old' }, // notes unchanged
  });

  const { rows } = await query(
    `SELECT field FROM timesheet_audit_log WHERE entry_id = $1 ORDER BY field`,
    [entry.id]
  );
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].field, 'category');
});
