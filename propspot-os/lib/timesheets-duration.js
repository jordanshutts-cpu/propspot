// Duration + weekly overtime helpers. Pure functions — no DB access.

function durationMinutes(startedAt, endedAt) {
  if (!endedAt) return null;
  const start = new Date(startedAt).getTime();
  const end   = new Date(endedAt).getTime();
  return Math.floor((end - start) / 60000);
}

// Returns Monday (UTC) of the week containing `date`, as YYYY-MM-DD.
function mondayOfWeek(date) {
  const d = new Date(date);
  const day = d.getUTCDay(); // 0 = Sunday, 1 = Monday, ... 6 = Saturday
  const diff = (day === 0 ? -6 : 1 - day);
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

// All Monday-anchored weeks that overlap the period [startsOn, endsOn].
function weeksInPeriod(startsOn, endsOn) {
  const out = [];
  let cursor = mondayOfWeek(startsOn);
  const last = mondayOfWeek(endsOn);
  while (cursor <= last) {
    out.push(cursor);
    const d = new Date(cursor + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + 7);
    cursor = d.toISOString().slice(0, 10);
  }
  return out;
}

// Split a worker's entries into regular vs overtime minutes per Gusto's
// weekly OT rule: anything over `thresholdMin` per calendar week (Mon-Sun)
// is overtime.
function splitOvertime(entries, thresholdMin) {
  const byWeek = new Map(); // weekMondayUTC → total minutes
  for (const e of entries) {
    if (!e.ended_at || !e.duration_minutes) continue;
    const wk = mondayOfWeek(e.started_at);
    byWeek.set(wk, (byWeek.get(wk) || 0) + e.duration_minutes);
  }
  let regular = 0, overtime = 0;
  for (const total of byWeek.values()) {
    if (total <= thresholdMin) regular += total;
    else { regular += thresholdMin; overtime += total - thresholdMin; }
  }
  return { regularMinutes: regular, overtimeMinutes: overtime };
}

module.exports = { durationMinutes, splitOvertime, weeksInPeriod, mondayOfWeek };
