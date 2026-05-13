// Geo helpers: Haversine distance, ping smoothing, greedy nearest-neighbor
// route ordering, and cadence-based next_due_at math.

const EARTH_RADIUS_M = 6_371_000;
const METERS_PER_MILE = 1_609.344;

function toRad(deg) { return (deg * Math.PI) / 180; }

function distanceMeters(lat1, lng1, lat2, lng2) {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

// Smooth a chronological list of GPS pings and return total miles driven.
// Drops low-accuracy pings, parked jitter, and physically impossible speeds.
function smoothedMiles(pings) {
  if (!pings || pings.length < 2) return 0;
  let prev = null;
  let meters = 0;
  for (const p of pings) {
    if (p.accuracy_m != null && p.accuracy_m > 50) continue;
    if (!prev) { prev = p; continue; }
    const d = distanceMeters(prev.lat, prev.lng, p.lat, p.lng);
    const dt = (new Date(p.recorded_at) - new Date(prev.recorded_at)) / 1000;
    const speed = dt > 0 ? d / dt : 0;
    if (speed > 50) continue;                             // >180 km/h: outlier
    if ((p.speed_mps != null ? p.speed_mps : speed) < 0.5 && d < 15) continue; // parked jitter
    meters += d;
    prev = p;
  }
  return meters / METERS_PER_MILE;
}

// Greedy nearest-neighbor over an array of {id, lat, lng} stops, starting
// from a seed (lat,lng). Returns the stops reordered. O(n^2) — fine for the
// scale we expect (≤ ~30 stops/day).
function orderByNearestNeighbor(stops, startLat, startLng) {
  const remaining = stops.slice();
  const ordered = [];
  let curLat = startLat, curLng = startLng;
  while (remaining.length) {
    let bestIdx = 0;
    let bestD = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const s = remaining[i];
      if (s.lat == null || s.lng == null) continue;
      const d = distanceMeters(curLat, curLng, s.lat, s.lng);
      if (d < bestD) { bestD = d; bestIdx = i; }
    }
    const next = remaining.splice(bestIdx, 1)[0];
    ordered.push(next);
    curLat = next.lat; curLng = next.lng;
  }
  return ordered;
}

// Advance next_due_at off the given anchor (typically the visit's departed_at)
// using the schedule's cadence settings. Snaps forward to preferred_dow if set.
function nextDueAt(anchor, schedule) {
  const base = new Date(anchor);
  const due = new Date(base);
  switch (schedule.cadence) {
    case 'weekly':   due.setUTCDate(due.getUTCDate() + 7);  break;
    case 'biweekly': due.setUTCDate(due.getUTCDate() + 14); break;
    case 'monthly':  due.setUTCMonth(due.getUTCMonth() + 1); break;
    case 'custom':
      due.setUTCDate(due.getUTCDate() + (schedule.custom_days || 7));
      break;
    default:
      due.setUTCDate(due.getUTCDate() + 7);
  }
  if (schedule.preferred_dow != null) {
    const target = ((schedule.preferred_dow % 7) + 7) % 7;
    while (due.getUTCDay() !== target) {
      due.setUTCDate(due.getUTCDate() + 1);
    }
  }
  return due;
}

// Monday of the ISO week containing `d` (UTC). Used to name the weekly folder
// "Week of YYYY-MM-DD".
function isoMonday(d) {
  const dt = new Date(d);
  const day = dt.getUTCDay() || 7;       // Sun=0 → 7
  if (day !== 1) dt.setUTCDate(dt.getUTCDate() - (day - 1));
  dt.setUTCHours(0, 0, 0, 0);
  return dt;
}

function weeklyFolderName(d) {
  const monday = isoMonday(d);
  return `Week of ${monday.toISOString().slice(0, 10)}`;
}

function endOfWeek(d) {
  const monday = isoMonday(d);
  const sunday = new Date(monday);
  sunday.setUTCDate(sunday.getUTCDate() + 6);
  sunday.setUTCHours(23, 59, 59, 999);
  return sunday;
}

module.exports = {
  distanceMeters,
  smoothedMiles,
  orderByNearestNeighbor,
  nextDueAt,
  isoMonday,
  weeklyFolderName,
  endOfWeek
};
