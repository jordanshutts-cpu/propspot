// Anomaly flag detection. Pure functions — no DB access.
//
// `flagsFor(entry, context)` returns an array of flag string IDs.
// Context provides cross-entry info the caller has already aggregated
// (e.g., a list of weekday names the worker has historically worked).

const WEEKDAY_NAMES = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const LONG_SHIFT_THRESHOLD_MIN = 12 * 60;

function flagsFor(entry, context = {}) {
  const flags = [];

  if (entry.duration_minutes && entry.duration_minutes > LONG_SHIFT_THRESHOLD_MIN) {
    flags.push('long_shift');
  }

  const hasTag = entry.project_id || entry.property_id ||
                 entry.work_order_id || (entry.category && entry.category.trim());
  if (!hasTag) flags.push('no_tags');

  if (entry.auto_closed) flags.push('auto_closed');
  if (entry.source === 'manual') flags.push('manual_entry');

  if (entry.ended_at && entry.updated_at &&
      new Date(entry.updated_at) > new Date(entry.ended_at)) {
    flags.push('edited_after_close');
  }

  // Weekend-off-pattern: this entry is on Sat/Sun AND the worker's recent
  // history (last 30 days) contains zero weekend days.
  if (entry.started_at) {
    const dayName = WEEKDAY_NAMES[new Date(entry.started_at).getUTCDay()];
    const onWeekend = (dayName === 'Sat' || dayName === 'Sun');
    const historyHasWeekend = (context.workerWeekdayHistory || [])
      .some(d => d === 'Sat' || d === 'Sun');
    if (onWeekend && !historyHasWeekend) flags.push('weekend_off_pattern');
  }

  return flags;
}

module.exports = { flagsFor, LONG_SHIFT_THRESHOLD_MIN, WEEKDAY_NAMES };
