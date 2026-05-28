const test = require('node:test');
const assert = require('node:assert');
const { flagsFor } = require('../../lib/timesheets-anomaly');

function makeEntry(overrides) {
  return {
    id: 'e1',
    user_id: 'u1',
    started_at: '2026-05-26T09:00:00Z',
    ended_at:   '2026-05-26T17:00:00Z',
    duration_minutes: 480,
    project_id: null,
    property_id: null,
    work_order_id: null,
    category: 'Acquisitions',
    notes: null,
    source: 'clock',
    auto_closed: false,
    updated_at: '2026-05-26T17:00:00Z',
    ...overrides,
  };
}

test('long_shift flag fires for entries over 12 hours', () => {
  const entry = makeEntry({
    ended_at: '2026-05-26T22:01:00Z',
    duration_minutes: 13 * 60 + 1,
  });
  const flags = flagsFor(entry, { workerWeekdayHistory: ['Mon','Tue','Wed'] });
  assert.ok(flags.includes('long_shift'));
});

test('long_shift does not fire at exactly 12 hours', () => {
  const entry = makeEntry({
    ended_at: '2026-05-26T21:00:00Z',
    duration_minutes: 12 * 60,
  });
  const flags = flagsFor(entry, { workerWeekdayHistory: ['Mon'] });
  assert.ok(!flags.includes('long_shift'));
});

test('no_tags flag fires when all tag fields are empty', () => {
  const entry = makeEntry({ project_id: null, property_id: null,
                            work_order_id: null, category: null });
  const flags = flagsFor(entry, { workerWeekdayHistory: ['Mon'] });
  assert.ok(flags.includes('no_tags'));
});

test('no_tags does not fire when any tag is set', () => {
  const entry = makeEntry({ project_id: 'p1' });
  const flags = flagsFor(entry, { workerWeekdayHistory: ['Mon'] });
  assert.ok(!flags.includes('no_tags'));
});

test('auto_closed flag mirrors the auto_closed field', () => {
  const e1 = makeEntry({ auto_closed: true });
  const e2 = makeEntry({ auto_closed: false });
  assert.ok(flagsFor(e1, { workerWeekdayHistory: ['Mon'] }).includes('auto_closed'));
  assert.ok(!flagsFor(e2, { workerWeekdayHistory: ['Mon'] }).includes('auto_closed'));
});

test('manual_entry flag mirrors source = manual', () => {
  const entry = makeEntry({ source: 'manual' });
  const flags = flagsFor(entry, { workerWeekdayHistory: ['Mon'] });
  assert.ok(flags.includes('manual_entry'));
});

test('edited_after_close flag fires when updated_at > ended_at', () => {
  const entry = makeEntry({
    ended_at:   '2026-05-26T17:00:00Z',
    updated_at: '2026-05-27T10:00:00Z',
  });
  const flags = flagsFor(entry, { workerWeekdayHistory: ['Mon'] });
  assert.ok(flags.includes('edited_after_close'));
});

test('weekend_off_pattern fires for Sat entry when worker history is weekday-only', () => {
  // 2026-05-30 is a Saturday
  const entry = makeEntry({
    started_at: '2026-05-30T09:00:00Z',
    ended_at:   '2026-05-30T17:00:00Z',
  });
  const history = ['Mon','Tue','Wed','Thu','Fri'];
  const flags = flagsFor(entry, { workerWeekdayHistory: history });
  assert.ok(flags.includes('weekend_off_pattern'));
});

test('weekend_off_pattern does NOT fire when worker history includes weekend', () => {
  const entry = makeEntry({
    started_at: '2026-05-30T09:00:00Z',
    ended_at:   '2026-05-30T17:00:00Z',
  });
  const history = ['Mon','Sat'];
  const flags = flagsFor(entry, { workerWeekdayHistory: history });
  assert.ok(!flags.includes('weekend_off_pattern'));
});
