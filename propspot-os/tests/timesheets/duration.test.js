const test = require('node:test');
const assert = require('node:assert');
const { durationMinutes, splitOvertime, weeksInPeriod } =
  require('../../lib/timesheets-duration');

test('durationMinutes returns minutes between two timestamps', () => {
  const start = new Date('2026-05-26T09:00:00Z');
  const end   = new Date('2026-05-26T11:30:00Z');
  assert.strictEqual(durationMinutes(start, end), 150);
});

test('durationMinutes returns null when ended_at is null', () => {
  assert.strictEqual(durationMinutes(new Date(), null), null);
});

test('durationMinutes floors fractional minutes', () => {
  const start = new Date('2026-05-26T09:00:00Z');
  const end   = new Date('2026-05-26T09:00:45Z'); // 45 seconds = 0.75 min
  assert.strictEqual(durationMinutes(start, end), 0);
});

test('splitOvertime: under 40 hours all regular', () => {
  // One entry of 30 hours in a single week
  const entries = [{
    started_at: '2026-05-18T08:00:00Z',
    ended_at:   '2026-05-19T14:00:00Z', // 30 hours
    duration_minutes: 30 * 60,
  }];
  const result = splitOvertime(entries, 40 * 60);
  assert.strictEqual(result.regularMinutes, 30 * 60);
  assert.strictEqual(result.overtimeMinutes, 0);
});

test('splitOvertime: 50 hours in one week = 40 regular + 10 OT', () => {
  const entries = [{
    started_at: '2026-05-18T00:00:00Z',  // Monday
    ended_at:   '2026-05-20T02:00:00Z',  // 50 hours
    duration_minutes: 50 * 60,
  }];
  const result = splitOvertime(entries, 40 * 60);
  assert.strictEqual(result.regularMinutes, 40 * 60);
  assert.strictEqual(result.overtimeMinutes, 10 * 60);
});

test('splitOvertime: 50 hours in week 1 + 30 in week 2 = 70 regular + 10 OT', () => {
  const entries = [
    { started_at: '2026-05-18T00:00:00Z', ended_at: '2026-05-20T02:00:00Z',
      duration_minutes: 50 * 60 }, // week of May 18 (Mon)
    { started_at: '2026-05-25T00:00:00Z', ended_at: '2026-05-26T06:00:00Z',
      duration_minutes: 30 * 60 }, // week of May 25 (Mon)
  ];
  const result = splitOvertime(entries, 40 * 60);
  assert.strictEqual(result.regularMinutes, (40 + 30) * 60);
  assert.strictEqual(result.overtimeMinutes, 10 * 60);
});

test('weeksInPeriod returns Monday-anchored week keys', () => {
  // May 18 2026 is a Monday. May 25 2026 is also a Monday.
  const keys = weeksInPeriod('2026-05-18', '2026-05-31');
  assert.deepStrictEqual(keys, ['2026-05-18', '2026-05-25']);
});
