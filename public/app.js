// ============================================================
//  FieldCam — Shared Frontend Utilities
//  Uses fetch() + JWT auth against our Railway/Express backend.
// ============================================================

const TOKEN_KEY = 'fieldcam_token';
const USER_KEY  = 'fieldcam_user';

// ── Auth Storage ─────────────────────────────────────────────

function getToken()       { return localStorage.getItem(TOKEN_KEY); }
function setToken(t)      { localStorage.setItem(TOKEN_KEY, t); }
function clearToken()     { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(USER_KEY); }
function getCachedUser()  { try { return JSON.parse(localStorage.getItem(USER_KEY)); } catch { return null; } }
function setCachedUser(u) { localStorage.setItem(USER_KEY, JSON.stringify(u)); }

// ── API Fetch Wrapper ─────────────────────────────────────────

async function apiFetch(path, options = {}) {
  const token = getToken();
  const isFormData = options.body instanceof FormData;

  const headers = {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(!isFormData ? { 'Content-Type': 'application/json' } : {}),
    ...(options.headers || {})
  };

  const res = await fetch(API_BASE + path, { ...options, headers });

  if (res.status === 401) {
    clearToken();
    window.location.href = '/index.html';
    return;
  }

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }

  return data;
}

// ── Auth Helpers ─────────────────────────────────────────────

async function requireAuth() {
  if (!getToken()) {
    window.location.href = '/index.html';
    return null;
  }
  try {
    const user = await apiFetch('/api/auth/me');
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

// ── User ──────────────────────────────────────────────────────

async function getCurrentUser() {
  return getCachedUser() || apiFetch('/api/auth/me');
}

// ── Properties ───────────────────────────────────────────────

async function getProperties() {
  return apiFetch('/api/properties');
}

async function getProperty(id) {
  return apiFetch(`/api/properties/${id}`);
}

async function createProperty({ name, address, lat, lng, notes }) {
  return apiFetch('/api/properties', {
    method: 'POST',
    body: JSON.stringify({ name, address, lat, lng, notes })
  });
}

async function updateProperty(id, fields) {
  return apiFetch(`/api/properties/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(fields)
  });
}

async function deleteProperty(id) {
  return apiFetch(`/api/properties/${id}`, { method: 'DELETE' });
}

// ── Photos ───────────────────────────────────────────────────

async function getPhotos(propertyId) {
  return apiFetch(`/api/photos/${propertyId}`);
}

async function uploadPhoto({ file, propertyId, lat, lng, notes }) {
  const formData = new FormData();
  formData.append('photo', file);
  if (lat)   formData.append('lat',   lat);
  if (lng)   formData.append('lng',   lng);
  if (notes) formData.append('notes', notes);

  return apiFetch(`/api/photos/${propertyId}`, {
    method: 'POST',
    body: formData
    // No Content-Type header — browser sets multipart boundary automatically
  });
}

async function deletePhoto(photo) {
  return apiFetch(`/api/photos/${photo.id}`, { method: 'DELETE' });
}

// ── Team ─────────────────────────────────────────────────────

async function getTeamMembers() {
  return apiFetch('/api/team');
}

async function inviteUser(email, fullName) {
  return apiFetch('/api/auth/invite', {
    method: 'POST',
    body: JSON.stringify({ email, fullName })
  });
}

// ── GPS / Geolocation ────────────────────────────────────────

function getCurrentPosition(options = {}) {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('Geolocation not supported by this browser.'));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      timeout: 15000,
      maximumAge: 0,
      ...options
    });
  });
}

function distanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function findNearbyProperties(lat, lng, radiusMeters = NEARBY_RADIUS_METERS) {
  const properties = await getProperties();
  return properties
    .filter(p => p.lat && p.lng)
    .map(p => ({ ...p, distance: distanceMeters(lat, lng, p.lat, p.lng) }))
    .filter(p => p.distance <= radiusMeters)
    .sort((a, b) => a.distance - b.distance);
}

// ── UI Helpers ───────────────────────────────────────────────

function showToast(message, type = 'success') {
  const existing = document.getElementById('fc-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.id = 'fc-toast';
  toast.className = `toast${type === 'error' ? ' toast-error' : ''}`;
  toast.textContent = message;
  document.body.appendChild(toast);

  setTimeout(() => toast.classList.add('toast-visible'), 10);
  setTimeout(() => {
    toast.classList.remove('toast-visible');
    setTimeout(() => toast.remove(), 300);
  }, 3200);
}

function showSpinner(el, text = 'Loading…') {
  el.disabled = true;
  el._originalText = el.innerHTML;
  el.innerHTML = `<span class="spinner"></span> ${text}`;
}

function hideSpinner(el) {
  el.disabled = false;
  el.innerHTML = el._originalText || 'Submit';
}

function formatDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit'
  });
}

function escHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

async function populateHeader() {
  const user = await getCurrentUser();
  const el = document.getElementById('user-name');
  if (el && user) el.textContent = user.full_name || user.email || 'You';
}

// ── Restoration OS link ──────────────────────────────────────
let _osUrlCache = null;
async function getOsUrl() {
  if (_osUrlCache !== null) return _osUrlCache;
  try {
    const cfg = await fetch(API_BASE + '/api/config').then(r => r.json());
    _osUrlCache = cfg.osUrl || '';
  } catch { _osUrlCache = ''; }
  return _osUrlCache;
}

async function injectOsLink() {
  const url = await getOsUrl();
  if (!url) return;
  const headerActions = document.querySelector('.app-header .header-actions');
  if (!headerActions || document.getElementById('os-link')) return;
  const link = document.createElement('a');
  link.id = 'os-link';
  link.className = 'icon-btn';
  link.href = url;
  link.title = 'Restoration OS';
  link.textContent = '🏠';
  headerActions.insertBefore(link, headerActions.firstChild);
}
