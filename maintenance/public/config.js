// Maintenance — Frontend config.
// API_BASE = '' means same-origin (works locally and on Railway).
const API_BASE = '';
const APP_NAME = 'Maintenance';

// Geofence thresholds. Tune in the field.
const ARRIVE_RADIUS_M    = 100;   // within this radius → candidate for arrival
const ARRIVE_DWELL_MS    = 30_000;
const DEPART_RADIUS_M    = 150;   // outside this radius → candidate for departure
const DEPART_DWELL_MS    = 60_000;
const ACCURACY_FLOOR_M   = 50;    // drop pings with worse accuracy
const PING_FLUSH_MS      = 30_000;
