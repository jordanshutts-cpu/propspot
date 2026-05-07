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

async function getPhotos(propertyId, folderId) {
  const q = folderId ? `?folder_id=${encodeURIComponent(folderId)}` : '';
  return apiFetch(`/api/photos/${propertyId}${q}`);
}

async function uploadPhoto({ file, propertyId, lat, lng, notes, folderId }) {
  const formData = new FormData();
  formData.append('photo', file);
  if (lat)      formData.append('lat',       lat);
  if (lng)      formData.append('lng',       lng);
  if (notes)    formData.append('notes',     notes);
  if (folderId) formData.append('folder_id', folderId);

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

// ── Folders ───────────────────────────────────────────────────

async function getFolders(propertyId) {
  return apiFetch(`/api/folders/${propertyId}`);
}
async function createFolders(propertyId, names) {
  return apiFetch(`/api/folders/${propertyId}`, {
    method: 'POST',
    body: JSON.stringify({ names: Array.isArray(names) ? names : [names] })
  });
}
async function deleteFolder(folderId) {
  return apiFetch(`/api/folders/${folderId}`, { method: 'DELETE' });
}
async function movePhotoToFolder(photoId, folderId) {
  return apiFetch(`/api/photos/${photoId}/folder`, {
    method: 'PATCH',
    body: JSON.stringify({ folder_id: folderId || null })
  });
}

// ── Share links ───────────────────────────────────────────────

async function createShareLink(propertyId, folderId, label) {
  return apiFetch('/api/share', {
    method: 'POST',
    body: JSON.stringify({ propertyId, folderId: folderId || null, label: label || null })
  });
}
async function getShareLinks(propertyId) {
  return apiFetch(`/api/share?propertyId=${propertyId}`);
}
async function revokeShareLink(token) {
  return apiFetch(`/api/share/${token}`, { method: 'DELETE' });
}

// ── Access control ────────────────────────────────────────────

async function getPropertyAccess(propertyId) {
  return apiFetch(`/api/access/${propertyId}`);
}
async function grantPropertyAccess(propertyId, userId, accessLevel) {
  return apiFetch(`/api/access/${propertyId}`, {
    method: 'POST',
    body: JSON.stringify({ userId, accessLevel })
  });
}
async function revokePropertyAccess(propertyId, userId) {
  return apiFetch(`/api/access/${propertyId}/${userId}`, { method: 'DELETE' });
}
async function setUserRole(userId, role) {
  return apiFetch(`/api/access/users/${userId}/role`, {
    method: 'PATCH',
    body: JSON.stringify({ role })
  });
}

// ── Sidebar Collapse ─────────────────────────────────────────

function toggleSidebar() {
  const collapsed = document.documentElement.classList.toggle('sidebar-collapsed');
  try { localStorage.setItem('sidebar_collapsed', collapsed ? '1' : '0'); } catch(e) {}
  const btn = document.getElementById('nav-collapse-btn');
  if (btn) btn.title = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
  btn && (btn.textContent = collapsed ? '›' : '‹');
}

// ── Sidebar Notification Bell ─────────────────────────────────

function handleNavNotif() {
  // If the notification panel exists on this page, toggle it
  if (typeof toggleNotifPanel === 'function') {
    toggleNotifPanel();
  } else {
    // Navigate to dashboard which has the full notifications UI
    window.location.href = '/dashboard.html';
  }
}

async function loadNavBadge() {
  try {
    const mentions  = await getMentions();
    const seen      = parseInt(localStorage.getItem('fieldcam_mentions_seen') || '0', 10);
    const unread    = mentions.filter(m => new Date(m.created_at).getTime() > seen).length;
    const badge     = document.getElementById('nav-notif-badge');
    const headerBadge = document.getElementById('notif-badge');  // dashboard header (if present)
    [badge, headerBadge].forEach(el => {
      if (!el) return;
      if (unread > 0) { el.textContent = unread; el.classList.remove('hidden'); }
      else            { el.classList.add('hidden'); }
    });
  } catch { /* silent on pages where auth is not loaded yet */ }
}

// ── Trash ─────────────────────────────────────────────────────

async function getTrash(propertyId) {
  return apiFetch(`/api/trash/${propertyId}`);
}

async function restoreFromTrash(photoId) {
  return apiFetch(`/api/trash/${photoId}/restore`, { method: 'POST' });
}

async function permanentlyDeletePhoto(photoId) {
  return apiFetch(`/api/trash/${photoId}`, { method: 'DELETE' });
}

async function emptyTrash(propertyId) {
  return apiFetch(`/api/trash/empty/${propertyId}`, { method: 'DELETE' });
}

// ── Comments ──────────────────────────────────────────────────

async function getComments(photoId) {
  return apiFetch(`/api/comments?photo_id=${encodeURIComponent(photoId)}`);
}

async function postComment(photoId, body) {
  return apiFetch('/api/comments', {
    method: 'POST',
    body: JSON.stringify({ photo_id: photoId, body })
  });
}

async function deleteComment(commentId) {
  return apiFetch(`/api/comments/${commentId}`, { method: 'DELETE' });
}

async function getMentions() {
  return apiFetch('/api/comments/mentions');
}

// ── Sidebar init (runs on every page) ────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // Set correct collapse icon (class already applied by head script)
  const btn = document.getElementById('nav-collapse-btn');
  if (btn) {
    const collapsed = document.documentElement.classList.contains('sidebar-collapsed');
    btn.textContent = collapsed ? '›' : '‹';
    btn.title = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
  }
  // Load nav notification badge (desktop sidebar bell)
  if (getToken()) loadNavBadge();
});
