// ============================================================
//  Holdings Desk — Frontend Utilities
//  SSO with Prop Spot via the shared 'ros_token' localStorage key.
//  Auth check proxies to Prop Spot's /api/os/me through our /api/me.
// ============================================================

// Shared SSO storage key — byte-identical to Prop Spot's so a token
// minted in one app works in the other if both are open on the same
// device. (Each domain still has its own localStorage in practice;
// the deep-link ?token= flow is the actual handoff mechanism.)
const TOKEN_KEY = 'ros_token';
const USER_KEY  = 'ros_user';

// SSO handoff: if Prop Spot deep-linked with ?token=… consume it
// before anything else and scrub it from the URL bar.
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

// ── Auth Storage ─────────────────────────────────────────────
function getToken()       { return localStorage.getItem(TOKEN_KEY); }
function setToken(t)      { localStorage.setItem(TOKEN_KEY, t); }
function clearToken()     { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(USER_KEY); }
function getCachedUser()  { try { return JSON.parse(localStorage.getItem(USER_KEY)); } catch { return null; } }
function setCachedUser(u) { localStorage.setItem(USER_KEY, JSON.stringify(u)); }

let cachedConfig = null;
async function getConfig() {
  if (cachedConfig) return cachedConfig;
  try {
    const r = await fetch(API_BASE + '/api/config');
    cachedConfig = await r.json();
  } catch {
    cachedConfig = {};
  }
  return cachedConfig;
}

async function bounceToOs() {
  const cfg = await getConfig();
  const osUrl = cfg.osUrl || 'https://os.propspot.io';
  window.location.href = osUrl;
}

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
    await bounceToOs();
    return;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

async function requireAuth() {
  if (!getToken()) { await bounceToOs(); return null; }
  try {
    const user = await apiFetch('/api/auth/me');
    setCachedUser(user);
    try { renderTopbarAvatar(); } catch {}
    return user;
  } catch {
    clearToken();
    await bounceToOs();
    return null;
  }
}

async function signOut() {
  clearToken();
  await bounceToOs();
}

// ── Lookups (read-only against shared DB) ────────────────────
async function getProperties() { return apiFetch('/api/lookups/properties'); }
async function getProperty(id) { return apiFetch('/api/lookups/properties/' + id); }
async function getContacts()   { return apiFetch('/api/lookups/contacts'); }

// ── Holdings ─────────────────────────────────────────────────
async function getHoldings(params = {}) {
  const qs = new URLSearchParams(params).toString();
  return apiFetch(`/api/holdings/items${qs ? '?' + qs : ''}`);
}
async function getHolding(id)            { return apiFetch(`/api/holdings/items/${id}`); }
async function createHolding(p)          { return apiFetch('/api/holdings/items', { method: 'POST', body: JSON.stringify(p) }); }
async function updateHolding(id, p)      { return apiFetch(`/api/holdings/items/${id}`, { method: 'PATCH', body: JSON.stringify(p) }); }
async function deleteHolding(id)         { return apiFetch(`/api/holdings/items/${id}`, { method: 'DELETE' }); }
async function markHoldingPaid(id, body = {}) {
  return apiFetch(`/api/holdings/items/${id}/mark-paid`, { method: 'POST', body: JSON.stringify(body) });
}
async function getHoldingsSummary()      { return apiFetch('/api/holdings/summary'); }
async function getUpcomingHoldings(days = 14) {
  return apiFetch(`/api/holdings/upcoming-due?days=${encodeURIComponent(days)}`);
}
async function createHoldingPayment(p)   { return apiFetch('/api/holdings/payments', { method: 'POST', body: JSON.stringify(p) }); }
async function updateHoldingPayment(id, p){ return apiFetch(`/api/holdings/payments/${id}`, { method: 'PATCH', body: JSON.stringify(p) }); }
async function deleteHoldingPayment(id)  { return apiFetch(`/api/holdings/payments/${id}`, { method: 'DELETE' }); }
async function uploadHoldingDocument(itemId, file, fields = {}) {
  const fd = new FormData();
  fd.append('file', file);
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined && v !== null && v !== '') fd.append(k, v);
  }
  return apiFetch(`/api/holdings/items/${itemId}/documents`, { method: 'POST', body: fd });
}
async function deleteHoldingDocument(id) { return apiFetch(`/api/holdings/documents/${id}`, { method: 'DELETE' }); }

// ── Categories / Frequencies ─────────────────────────────────
const HOLDING_CATEGORIES = [
  ['utility',           'Utility',           '💡'],
  ['insurance',         'Insurance',         '🛡️'],
  ['property_tax',      'Property Tax',      '🏛️'],
  ['mortgage',          'Mortgage',          '🏦'],
  ['business_license',  'Business License',  '📜'],
  ['hoa',               'HOA',               '🏘️']
];
const HOLDING_FREQUENCIES = [
  ['monthly',    'Monthly'],
  ['quarterly',  'Quarterly'],
  ['semiannual', 'Semiannual'],
  ['annual',     'Annual'],
  ['one_time',   'One-time'],
  ['variable',   'Variable']
];

function holdingCategoryLabel(cat) { const r = HOLDING_CATEGORIES.find(([k]) => k === cat); return r ? r[1] : cat; }
function holdingCategoryIcon(cat)  { const r = HOLDING_CATEGORIES.find(([k]) => k === cat); return r ? r[2] : '📋'; }
function holdingFrequencyLabel(f)  { const r = HOLDING_FREQUENCIES.find(([k]) => k === f); return r ? r[1] : f; }

function holdingDueBadge(nextDueDate, daysBefore = 7) {
  if (!nextDueDate) return { cls: 'badge-muted', label: 'No due date' };
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const due = new Date(nextDueDate); due.setHours(0, 0, 0, 0);
  const diff = Math.round((due - today) / 86400000);
  if (diff < 0)  return { cls: 'badge-danger',  label: `Overdue ${Math.abs(diff)}d` };
  if (diff === 0) return { cls: 'badge-danger', label: 'Due today' };
  if (diff <= daysBefore) return { cls: 'badge-warn', label: `Due in ${diff}d` };
  return { cls: 'badge-ok', label: `Due ${formatDate(nextDueDate)}` };
}

// ── Display helpers ──────────────────────────────────────────
function showToast(message, type = 'success') {
  const existing = document.getElementById('hd-toast');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.id = 'hd-toast';
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
    month: 'short', day: 'numeric', year: 'numeric'
  });
}

function formatMoney(n) {
  if (n === null || n === undefined || n === '') return '';
  return '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

// ── Link back to Prop Spot for property / contact pages ──────
async function osLink(path) {
  const cfg = await getConfig();
  const base = cfg.osUrl || '';
  const token = getToken();
  if (!base) return path;
  const sep = path.includes('?') ? '&' : '?';
  return base + path + sep + 'token=' + encodeURIComponent(token);
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
    inbox:        cfg.inboxUrl        || '',
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
    <a class="nav-link" data-app="inbox" href="#" style="display:none;"><span class="nav-icon">📧</span><span class="nav-label">Inbox</span></a>
    <a class="nav-link" data-app="underwriting" href="#" style="display:none;"><span class="nav-icon">📊</span><span class="nav-label">Underwriting</span></a>
    <div class="nav-spacer"></div>
  `;
  const btn = document.getElementById('nav-collapse-btn');
  if (btn) {
    const collapsed = document.documentElement.classList.contains('sidebar-collapsed');
    btn.textContent = collapsed ? '›' : '‹';
    btn.title = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
  }
  wireUnifiedNav();
}

// ── Topbar avatar + dropdown menu (consistent across all apps) ──
function avatarContent(u) {
  if (u?.avatar_url) return `<img class="avatar-img" src="${escHtml(u.avatar_url)}" alt="">`;
  if (u?.full_name)  return escHtml(u.full_name.charAt(0).toUpperCase());
  if (u?.email)      return escHtml(u.email.charAt(0).toUpperCase());
  return '👤';
}
function renderTopbarAvatar() {
  const u = getCachedUser() || {};
  const target = document.querySelector('.header-actions') || document.querySelector('.pulse-topbar-right');
  if (!target) return;
  let btn = target.querySelector('.topbar-avatar');
  if (!btn) {
    target.querySelector('.header-signout, .pulse-signout')?.remove();
    btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'topbar-avatar';
    btn.id = 'topbar-user-avatar';
    btn.title = 'Account';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      document.getElementById('topbar-user-menu')?.classList.toggle('open');
    });
    target.appendChild(btn);
  }
  btn.innerHTML = avatarContent(u);
  let menu = document.getElementById('topbar-user-menu');
  if (!menu) {
    menu = document.createElement('div');
    menu.id = 'topbar-user-menu';
    menu.className = 'topbar-user-menu';
    document.body.appendChild(menu);
    document.addEventListener('click', (e) => {
      if (!menu.classList.contains('open')) return;
      if (menu.contains(e.target) || btn.contains(e.target)) return;
      menu.classList.remove('open');
    });
  }
  menu.innerHTML = `
    <div class="user-info">
      <div class="user-avatar-big">${avatarContent(u)}</div>
      <div style="min-width:0;">
        <div class="user-name">${escHtml(u.full_name || u.email || 'You')}</div>
        <div class="user-email">${escHtml(u.email || '')}</div>
      </div>
    </div>
    <a class="topbar-menu-item" href="#" onclick="goEditProfile(event)">👤 Edit Profile</a>
    <div class="menu-divider"></div>
    <button type="button" class="topbar-menu-item danger" onclick="signOut()">🚪 Sign Out</button>
  `;
}
async function goEditProfile(e) {
  e.preventDefault();
  const cfg = await _loadNavConfig();
  if (!cfg.osUrl) return;
  const url = cfg.osUrl.replace(/\/$/, '') + '/dashboard.html?action=edit_profile';
  window.location.href = _appendToken(url);
}

if (typeof window !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { renderUnifiedNav(); renderTopbarAvatar(); });
  } else {
    renderUnifiedNav(); renderTopbarAvatar();
  }
}

function toggleSidebar() {
  const collapsed = document.documentElement.classList.toggle('sidebar-collapsed');
  try { localStorage.setItem('sidebar_collapsed', collapsed ? '1' : '0'); } catch(e) {}
  const btn = document.getElementById('nav-collapse-btn');
  if (btn) {
    btn.title = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
    btn.textContent = collapsed ? '›' : '‹';
  }
}
