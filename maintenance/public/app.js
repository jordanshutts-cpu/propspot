// ============================================================
//  Maintenance — Shared Frontend Utilities
// ============================================================

const TOKEN_KEY = 'maintenance_token';
const USER_KEY  = 'maintenance_user';

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

function getToken()       { return localStorage.getItem(TOKEN_KEY); }
function setToken(t)      { localStorage.setItem(TOKEN_KEY, t); }
function clearToken()     { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(USER_KEY); }
function getCachedUser()  { try { return JSON.parse(localStorage.getItem(USER_KEY)); } catch { return null; } }
function setCachedUser(u) { localStorage.setItem(USER_KEY, JSON.stringify(u)); }

async function apiFetch(path, options = {}) {
  const token = getToken();
  const headers = {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    'Content-Type': 'application/json',
    ...(options.headers || {})
  };
  const res = await fetch(API_BASE + path, { ...options, headers });
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
  if (!getToken()) { window.location.href = '/index.html'; return null; }
  try {
    const me = await apiFetch('/api/auth/me');
    setCachedUser(me);
    return me;
  } catch {
    clearToken();
    window.location.href = '/index.html';
    return null;
  }
}

async function signOut() { clearToken(); window.location.href = '/index.html'; }

async function getOsUrl() {
  try { const cfg = await (await fetch('/api/config')).json(); return cfg.osUrl || ''; }
  catch { return ''; }
}

// ── Domain API ───────────────────────────────────────────────
async function getProperties()       { return apiFetch('/api/properties'); }
async function getProperty(id)       { return apiFetch(`/api/properties/${id}`); }

async function getWorkOrders(params = {}) {
  const qs = new URLSearchParams(params).toString();
  return apiFetch(`/api/work-orders${qs ? '?' + qs : ''}`);
}
async function getWorkOrder(id)            { return apiFetch(`/api/work-orders/${id}`); }
async function createWorkOrder(body)       { return apiFetch('/api/work-orders', { method: 'POST', body: JSON.stringify(body) }); }
async function updateWorkOrder(id, body)   { return apiFetch(`/api/work-orders/${id}`, { method: 'PATCH', body: JSON.stringify(body) }); }
async function deleteWorkOrder(id)         { return apiFetch(`/api/work-orders/${id}`, { method: 'DELETE' }); }

async function postUpdate(work_order_id, body) {
  return apiFetch('/api/updates', { method: 'POST', body: JSON.stringify({ work_order_id, body }) });
}
async function deleteUpdate(id) { return apiFetch(`/api/updates/${id}`, { method: 'DELETE' }); }

// ── Lawn maintenance ─────────────────────────────────────────
async function getLawn()                      { return apiFetch('/api/lawn'); }
async function markMowed(propertyId, body)    { return apiFetch(`/api/lawn/${propertyId}/mowed`, { method: 'POST', body: JSON.stringify(body || {}) }); }
async function checkIn(propertyId, coords)    { return apiFetch(`/api/lawn/${propertyId}/checkin`, { method: 'POST', body: JSON.stringify(coords || {}) }); }
async function patchLawn(propertyId, body)    { return apiFetch(`/api/lawn/${propertyId}`, { method: 'PATCH', body: JSON.stringify(body) }); }
async function saveLawnRoute(orderArray)      { return apiFetch('/api/lawn/route', { method: 'POST', body: JSON.stringify({ order: orderArray }) }); }
async function getMowEvents(propertyId)       { return apiFetch(`/api/lawn/${propertyId}/mow-events`); }
async function patchMowEvent(eventId, body)   { return apiFetch(`/api/lawn/mow-events/${eventId}`, { method: 'PATCH', body: JSON.stringify(body) }); }
async function deleteMowEvent(eventId)        { return apiFetch(`/api/lawn/mow-events/${eventId}`, { method: 'DELETE' }); }
async function getUsers()                     { return apiFetch('/api/users'); }

// ── UI helpers ────────────────────────────────────────────────
function showToast(message, type = 'success') {
  const existing = document.getElementById('mn-toast');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.id = 'mn-toast';
  toast.className = `toast${type === 'error' ? ' toast-error' : ''}`;
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.classList.add('toast-visible'), 10);
  setTimeout(() => {
    toast.classList.remove('toast-visible');
    setTimeout(() => toast.remove(), 300);
  }, 3200);
}

function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return '—';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return '—';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function relativeTime(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return formatDate(iso);
}

function formatMoney(cents) {
  if (cents == null || cents === '') return '—';
  return '$' + (parseInt(cents, 10) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function dollarsToCents(v) {
  if (v === '' || v == null) return null;
  return Math.round(parseFloat(v) * 100);
}
function centsToDollars(c) {
  if (c == null) return '';
  return (parseInt(c, 10) / 100).toFixed(2);
}

function propertyDisplay(p) { return p?.display_name || p?.address_line1 || 'Property'; }

const CATEGORIES = [
  ['plumbing',    'Plumbing',    '🚿'],
  ['electrical',  'Electrical',  '💡'],
  ['hvac',        'HVAC',        '❄️'],
  ['roofing',     'Roofing',     '🏠'],
  ['landscaping', 'Landscaping', '🌳'],
  ['cleaning',    'Cleaning',    '🧹'],
  ['appliance',   'Appliance',   '🔌'],
  ['pest',        'Pest control','🐜'],
  ['general',     'General',     '🛠️'],
  ['other',       'Other',       '📋']
];
function categoryLabel(c){ return (CATEGORIES.find(x => x[0]===c) || [c, c||'—'])[1]; }
function categoryIcon(c){  return (CATEGORIES.find(x => x[0]===c) || [c, c, '🛠️'])[2]; }

const PRIORITIES = [
  ['urgent', 'Urgent', 'badge-red'],
  ['high',   'High',   'badge-amber'],
  ['normal', 'Normal', 'badge-green'],
  ['low',    'Low',    'badge-grey']
];
function priorityLabel(p){ return (PRIORITIES.find(x => x[0]===p) || [p,p])[1]; }
function priorityBadgeClass(p){ return (PRIORITIES.find(x => x[0]===p) || [p,p,'badge-grey'])[2]; }

const STATUSES = [
  ['open',        'Open',        'badge-red'],
  ['scheduled',   'Scheduled',   'badge-amber'],
  ['in_progress', 'In progress', 'badge-blue'],
  ['completed',   'Completed',   'badge-green'],
  ['cancelled',   'Cancelled',   'badge-grey']
];
function statusLabel(s){ return (STATUSES.find(x => x[0]===s) || [s, s||'—'])[1]; }
function statusBadgeClass(s){ return (STATUSES.find(x => x[0]===s) || [s,s,'badge-grey'])[2]; }

function toggleSidebar() {
  const collapsed = document.documentElement.classList.toggle('sidebar-collapsed');
  try { localStorage.setItem('sidebar_collapsed', collapsed ? '1' : '0'); } catch(e) {}
  const btn = document.getElementById('nav-collapse-btn');
  if (btn) {
    btn.title = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
    btn.textContent = collapsed ? '›' : '‹';
  }
}

// ── Unified satellite + OS nav (shared across propspot-os, holdings,
//    maintenance, fieldcam, pulse). Each anchor with data-app="holdings|
//    maintenance|fieldcam|pulse" is wired to that satellite's URL with the
//    SSO token; data-osnav="dashboard|properties|contacts|team|apps"
//    is wired to the OS URL. Set window.NAV_CURRENT to highlight the
//    active item. ─────────────────────────────────────────────────────
let _navCfgCache = null;
async function _loadNavConfig() {
  if (_navCfgCache) return _navCfgCache;
  try {
    const r = await fetch(API_BASE + '/api/config');
    _navCfgCache = await r.json() || {};
  } catch { _navCfgCache = {}; }
  return _navCfgCache;
}
function _isCurrentOrigin(url) {
  if (!url) return false;
  try { return new URL(url).origin === location.origin; }
  catch { return false; }
}
function _appendToken(url) {
  const token = getToken();
  if (!token) return url;
  const sep = url.includes('?') ? '&' : '?';
  return url + sep + 'token=' + encodeURIComponent(token);
}
async function wireUnifiedNav() {
  if (!getToken()) return;
  const cfg = await _loadNavConfig();
  const APP_URLS = {
    holdings:     cfg.holdingsUrl     || '',
    maintenance:  cfg.maintenanceUrl  || '',
    fieldcam:     cfg.fieldcamUrl     || '',
    pulse:        cfg.pulseUrl        || '',
    underwriting: cfg.underwritingUrl || ''
  };
  document.querySelectorAll('[data-app]').forEach(a => {
    const slug = a.dataset.app;
    const base = APP_URLS[slug];
    if (!base) { a.style.display = 'none'; return; }
    const path = a.dataset.appPath || '/';
    a.href = _isCurrentOrigin(base)
      ? path
      : _appendToken(base.replace(/\/$/, '') + path);
    a.style.display = '';
  });
  const osBase = cfg.osUrl || '';
  document.querySelectorAll('[data-osnav]').forEach(a => {
    const page = a.dataset.osnav;
    const path = (page === 'dashboard' || page === '') ? '/dashboard.html' : '/' + page + '.html';
    if (!osBase) { a.href = path; return; }
    a.href = _isCurrentOrigin(osBase)
      ? path
      : _appendToken(osBase.replace(/\/$/, '') + path);
  });
  const active = window.NAV_CURRENT;
  if (active) {
    document.querySelectorAll('.nav-link').forEach(a => {
      const slug = a.dataset.app || a.dataset.osnav;
      if (slug === active) a.classList.add('active');
    });
  }
}
function renderUnifiedNav() {
  const navEl = document.getElementById('nav');
  if (!navEl) return;
  navEl.innerHTML = `
    <a class="nav-brand" data-osnav="dashboard" href="#">
      <span class="nav-icon">🏘️</span><span class="nav-label">Prop Spot</span>
    </a>
    <button class="nav-collapse-btn" id="nav-collapse-btn" onclick="toggleSidebar()" title="Collapse sidebar">‹</button>
    <a class="nav-link" data-osnav="dashboard" href="#"><span class="nav-icon">🏠</span><span class="nav-label">Home</span></a>
    <a class="nav-link" data-app="holdings" href="#" style="display:none;"><span class="nav-icon">💼</span><span class="nav-label">Holdings</span></a>
    <a class="nav-link" data-app="maintenance" href="#" style="display:none;"><span class="nav-icon">🛠️</span><span class="nav-label">Maintenance</span></a>
    <a class="nav-link" data-app="fieldcam" href="#" style="display:none;"><span class="nav-icon">📸</span><span class="nav-label">FieldCam</span></a>
    <a class="nav-link" data-app="pulse" href="#" style="display:none;"><span class="nav-icon">💬</span><span class="nav-label">Pulse</span></a>
    <a class="nav-link" data-app="underwriting" href="#" style="display:none;"><span class="nav-icon">📊</span><span class="nav-label">Underwriting</span></a>
    <div class="nav-spacer"></div>
    <button class="nav-signout" onclick="signOut()" title="Sign Out">
      <span class="nav-icon">🚪</span><span class="nav-label">Sign Out</span>
    </button>
  `;
  const btn = document.getElementById('nav-collapse-btn');
  if (btn) {
    const collapsed = document.documentElement.classList.contains('sidebar-collapsed');
    btn.textContent = collapsed ? '›' : '‹';
    btn.title = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
  }
  wireUnifiedNav();
}
if (typeof window !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { renderUnifiedNav(); });
  } else {
    renderUnifiedNav();
  }
}
