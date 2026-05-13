// ============================================================
//  Maintenance — Shared Frontend Utilities
//  Mirrors FieldCam's patterns: SSO token consume, apiFetch,
//  requireAuth, plus a MaintenanceTracker for GPS geofencing.
// ============================================================

const TOKEN_KEY = 'maintenance_token';
const USER_KEY  = 'maintenance_user';

// SSO handoff: if Prop Spot or the apps switcher deep-linked us with
// ?token=…, stash it before any other code runs. Identical to the
// IIFE in FieldCam's public/app.js so a single Prop Spot token works
// in all satellites.
(function consumeSsoToken() {
  if (typeof window === 'undefined') return;
  const params = new URLSearchParams(location.search);
  const token = params.get('token');
  if (!token) return;
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.removeItem(USER_KEY);
  params.delete('token');
  const qs = params.toString();
  history.replaceState(null, '', location.pathname + (qs ? '?' + qs : '') + location.hash);
})();

// ── Token storage ─────────────────────────────────────────────

function getToken()       { return localStorage.getItem(TOKEN_KEY); }
function clearToken()     { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(USER_KEY); }
function getCachedUser()  { try { return JSON.parse(localStorage.getItem(USER_KEY)); } catch { return null; } }
function setCachedUser(u) { localStorage.setItem(USER_KEY, JSON.stringify(u)); }

// ── Sibling URLs (resolved from the backend at first call) ────

let _config = null;
async function getConfig() {
  if (_config) return _config;
  const r = await fetch(API_BASE + '/api/config');
  _config = await r.json();
  return _config;
}

// ── API fetch wrapper ────────────────────────────────────────

async function apiFetch(path, options = {}) {
  const token = getToken();
  const isFormData = options.body instanceof FormData;
  const headers = {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(!isFormData ? { 'Content-Type': 'application/json' } : {}),
    ...(options.headers || {})
  };
  const res = await fetch((path.startsWith('http') ? '' : API_BASE) + path, { ...options, headers });
  if (res.status === 401) {
    clearToken();
    window.location.href = '/index.html';
    return;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

async function requireAuth() {
  if (!getToken()) {
    window.location.href = '/index.html';
    return null;
  }
  try {
    const user = await apiFetch('/api/me');
    setCachedUser(user);
    return user;
  } catch {
    clearToken();
    window.location.href = '/index.html';
    return null;
  }
}

async function signOut() {
  clearToken();
  window.location.href = '/index.html';
}

// ── Schedules ─────────────────────────────────────────────────

async function listSchedules() { return apiFetch('/api/schedules'); }
async function getSchedule(propertyId) { return apiFetch(`/api/schedules/${propertyId}`); }
async function upsertSchedule(propertyId, body) {
  return apiFetch(`/api/schedules/${propertyId}`, {
    method: 'PUT', body: JSON.stringify(body)
  });
}

// ── Routes & visits ──────────────────────────────────────────

async function getTodayRoute() { return apiFetch('/api/routes/today'); }
async function getRoute(id)    { return apiFetch(`/api/routes/${id}`); }

async function generateRoute({ date, assigned_to, start_lat, start_lng }) {
  return apiFetch('/api/routes/generate', {
    method: 'POST',
    body: JSON.stringify({ date, assigned_to, start_lat, start_lng })
  });
}

async function startRoute(routeId, lat, lng) {
  return apiFetch(`/api/routes/${routeId}/start`, {
    method: 'POST', body: JSON.stringify({ lat, lng })
  });
}
async function endRoute(routeId) {
  return apiFetch(`/api/routes/${routeId}/end`, { method: 'POST' });
}
async function sendPings(routeId, pings) {
  return apiFetch(`/api/routes/${routeId}/pings`, {
    method: 'POST', body: JSON.stringify({ pings })
  });
}

async function getVisit(id) { return apiFetch(`/api/visits/${id}`); }
async function arrive(visitId, lat, lng, method) {
  return apiFetch(`/api/visits/${visitId}/arrive`, {
    method: 'POST', body: JSON.stringify({ lat, lng, method })
  });
}
async function depart(visitId, method) {
  return apiFetch(`/api/visits/${visitId}/depart`, {
    method: 'POST', body: JSON.stringify({ method })
  });
}
async function skipVisit(visitId, reason) {
  return apiFetch(`/api/visits/${visitId}/skip`, {
    method: 'POST', body: JSON.stringify({ reason })
  });
}
async function attachPhotoToVisit(visitId, photoId, kind) {
  return apiFetch(`/api/visits/${visitId}/attach-photo`, {
    method: 'POST', body: JSON.stringify({ photo_id: photoId, kind })
  });
}
async function toggleTask(taskId, done) {
  return apiFetch(`/api/tasks/${taskId}`, {
    method: 'PATCH', body: JSON.stringify({ done })
  });
}

async function getPayroll(weekStart, assigned_to) {
  const q = new URLSearchParams({ weekStart });
  if (assigned_to) q.set('assigned_to', assigned_to);
  return apiFetch('/api/routes/payroll?' + q.toString());
}

// ── Geo ──────────────────────────────────────────────────────

function getCurrentPosition(options = {}) {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('Geolocation not supported'));
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true, timeout: 15000, maximumAge: 0, ...options
    });
  });
}

function distanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Maps deep link ──────────────────────────────────────────

// Always opens in Google Maps if installed on iOS, falls back to Apple Maps.
function mapsDeepLinkUrl(lat, lng, label) {
  const q = encodeURIComponent(`${lat},${lng}`);
  return `https://www.google.com/maps/dir/?api=1&destination=${q}&travelmode=driving`;
}

// ── MaintenanceTracker ──────────────────────────────────────

// Singleton GPS watcher. Owned by worker.html — kept alive while the
// worker is doing his route. Other pages (stop.html) do NOT instantiate
// their own; they read state via window.tracker on the opener if needed.
class MaintenanceTracker {
  constructor({ routeId, visits, onUpdate, onError }) {
    this.routeId  = routeId;
    this.visits   = visits;           // ordered array; status drives next-pending
    this.onUpdate = onUpdate || (() => {});
    this.onError  = onError  || console.error;
    this.watchId  = null;
    this.pingBuffer = [];
    this.lastAcceptedPing = null;
    this.dwellArriveSince = null;
    this.dwellDepartSince = null;
    this.flushTimer  = null;
    this.wakeLock    = null;
  }

  async start() {
    if (this.watchId !== null) return;
    try {
      if ('wakeLock' in navigator) {
        this.wakeLock = await navigator.wakeLock.request('screen').catch(() => null);
      }
    } catch { /* ignore */ }

    this.watchId = navigator.geolocation.watchPosition(
      this._onPos.bind(this),
      err => this.onError(err),
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 }
    );

    this.flushTimer = setInterval(() => this._flush(), PING_FLUSH_MS);
    window.addEventListener('pagehide', this._flushBeacon.bind(this));
  }

  stop() {
    if (this.watchId !== null) navigator.geolocation.clearWatch(this.watchId);
    this.watchId = null;
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = null;
    if (this.wakeLock) { this.wakeLock.release().catch(() => {}); this.wakeLock = null; }
    this._flush();
  }

  setVisits(visits) { this.visits = visits; }

  _nextVisit() {
    return this.visits.find(v => v.status === 'pending' || v.status === 'en_route') ||
           this.visits.find(v => v.status === 'on_site');
  }

  _onPos(pos) {
    const { latitude: lat, longitude: lng, accuracy, speed } = pos.coords;
    if (accuracy != null && accuracy > ACCURACY_FLOOR_M) return;

    // Throttle: skip pings <10s apart to keep the buffer manageable.
    const now = Date.now();
    if (this.lastAcceptedPing && now - this.lastAcceptedPing.t < 10_000) return;
    this.lastAcceptedPing = { lat, lng, accuracy, speed, t: now };

    this.pingBuffer.push({
      lat, lng,
      accuracy_m: accuracy ?? null,
      speed_mps:  speed ?? null,
      recorded_at: new Date(now).toISOString()
    });

    const target = this._nextVisit();
    if (!target || target.lat == null || target.lng == null) return this.onUpdate({ lat, lng });

    const d = distanceMeters(lat, lng, Number(target.lat), Number(target.lng));

    // Arrival debounce.
    if (target.status !== 'on_site') {
      if (d < ARRIVE_RADIUS_M) {
        if (!this.dwellArriveSince) this.dwellArriveSince = now;
        if (now - this.dwellArriveSince >= ARRIVE_DWELL_MS) {
          this.dwellArriveSince = null;
          arrive(target.id, lat, lng, 'geofence')
            .then(() => { target.status = 'on_site'; this.onUpdate({ lat, lng, arrived: target.id }); })
            .catch(this.onError);
        }
      } else {
        this.dwellArriveSince = null;
      }
    }

    // Departure debounce.
    if (target.status === 'on_site') {
      if (d > DEPART_RADIUS_M) {
        if (!this.dwellDepartSince) this.dwellDepartSince = now;
        if (now - this.dwellDepartSince >= DEPART_DWELL_MS) {
          this.dwellDepartSince = null;
          depart(target.id, 'geofence')
            .then(() => { target.status = 'completed'; this.onUpdate({ lat, lng, departed: target.id }); })
            .catch(this.onError);
        }
      } else {
        this.dwellDepartSince = null;
      }
    }

    this.onUpdate({ lat, lng });
  }

  async _flush() {
    if (this.pingBuffer.length === 0) return;
    const batch = this.pingBuffer.splice(0, this.pingBuffer.length);
    try {
      await sendPings(this.routeId, batch);
    } catch (err) {
      // Put pings back so they get retried on next flush.
      this.pingBuffer = batch.concat(this.pingBuffer);
      this.onError(err);
    }
  }

  _flushBeacon() {
    if (this.pingBuffer.length === 0) return;
    const url = API_BASE + `/api/routes/${this.routeId}/pings`;
    const blob = new Blob(
      [JSON.stringify({ pings: this.pingBuffer })],
      { type: 'application/json' }
    );
    try {
      // sendBeacon doesn't let us set Authorization; fall back to fetch keepalive.
      const token = getToken();
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: blob,
        keepalive: true
      }).catch(() => {});
    } catch { /* nothing else to do */ }
  }
}
