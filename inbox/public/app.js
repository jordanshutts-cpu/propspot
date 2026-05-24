// ============================================================
//  Inbox — Shared Frontend Utilities
// ============================================================

const TOKEN_KEY = 'inbox_token';
const USER_KEY  = 'inbox_user';

// ── New-chrome feature flag (Phase 3 — same workspace chrome as OS) ─
// Enabled by ?newchrome=1 in URL OR localStorage.propspot_newchrome === '1'.
// When on, Inbox loads sidebar.js + topbar.js + lifecycle-stepper.js +
// chrome.css cross-origin from os.propspot.io so navigation looks the
// same as on os.propspot.io itself.
window.__newChromeEnabled = function () {
  try {
    if (new URLSearchParams(location.search).get('newchrome') === '1') return true;
    if (localStorage.getItem('propspot_newchrome') === '1') return true;
  } catch (e) {}
  return false;
};
if (window.__newChromeEnabled()) {
  try { localStorage.setItem('propspot_newchrome', '1'); } catch (e) {}
  const OS = window.__PROPSPOT_OS_URL || 'https://os.propspot.io';
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = OS + '/chrome.css';
  link.dataset.propspotChrome = '1';
  document.head.appendChild(link);
  ['/sidebar.js', '/topbar.js', '/lifecycle-stepper.js'].forEach(src => {
    const s = document.createElement('script');
    s.src = OS + src;
    s.async = false;
    document.head.appendChild(s);
  });
}

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
    ...((options.body && !(options.body instanceof FormData)) ? { 'Content-Type': 'application/json' } : {}),
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

async function requireAuthOrRedirect() {
  if (!getToken()) { window.location.href = '/index.html'; return null; }
  try {
    const me = await apiFetch('/api/auth/me');
    setCachedUser(me);
    try { renderTopbarAvatar(); } catch {}
    return me;
  } catch {
    clearToken();
    window.location.href = '/index.html';
    return null;
  }
}

async function signOut() { clearToken(); window.location.href = '/index.html'; }

// ── Domain API ───────────────────────────────────────────────
async function listMailboxes()             { return apiFetch('/api/mailboxes'); }
async function connectMailbox()            { return apiFetch('/api/mailboxes/connect', { method: 'POST', body: '{}' }); }
async function resyncMailbox(id)           { return apiFetch(`/api/mailboxes/${id}/resync`, { method: 'POST', body: '{}' }); }
async function disconnectMailbox(id)       { return apiFetch(`/api/mailboxes/${id}`, { method: 'DELETE' }); }

async function listSharedInboxes()         { return apiFetch('/api/shared-inboxes'); }
async function createSharedInbox(body)     { return apiFetch('/api/shared-inboxes', { method: 'POST', body: JSON.stringify(body) }); }
async function patchSharedInbox(id, body)  { return apiFetch(`/api/shared-inboxes/${id}`, { method: 'PATCH', body: JSON.stringify(body) }); }
async function deleteSharedInbox(id)       { return apiFetch(`/api/shared-inboxes/${id}`, { method: 'DELETE' }); }
async function listInboxMembers(id)        { return apiFetch(`/api/shared-inboxes/${id}/members`); }
async function patchInboxMember(id, body)  { return apiFetch(`/api/shared-inboxes/${id}/members`, { method: 'PATCH', body: JSON.stringify(body) }); }

async function listAliasRoutes()           { return apiFetch('/api/alias-routes'); }
async function saveAliasRoute(body)        { return apiFetch('/api/alias-routes', { method: 'POST', body: JSON.stringify(body) }); }
async function deleteAliasRoute(id)        { return apiFetch(`/api/alias-routes/${id}`, { method: 'DELETE' }); }

async function listThreads(params = {})    {
  const qs = new URLSearchParams(params).toString();
  return apiFetch(`/api/threads${qs ? '?' + qs : ''}`);
}
async function getThread(id)               { return apiFetch(`/api/threads/${id}`); }
async function patchThread(id, body)       { return apiFetch(`/api/threads/${id}`, { method: 'PATCH', body: JSON.stringify(body) }); }
async function sendReply(threadId, body)   { return apiFetch(`/api/messages/threads/${threadId}/reply`, { method: 'POST', body: JSON.stringify(body) }); }
async function composeMessage(body)        { return apiFetch('/api/messages/compose', { method: 'POST', body: JSON.stringify(body) }); }

async function saveAttachmentToProperty(attId, body) {
  return apiFetch(`/api/attachments/${attId}/save-to-property`, { method: 'POST', body: JSON.stringify(body) });
}
function attachmentUrl(attId) { return `/api/attachments/${attId}`; }

async function searchProperties(q) {
  return apiFetch(`/api/properties?q=${encodeURIComponent(q || '')}`);
}

// ── UI helpers ────────────────────────────────────────────────
function showToast(message, type = 'success') {
  const existing = document.getElementById('ib-toast');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.id = 'ib-toast';
  toast.className = `toast${type === 'error' ? ' toast-error' : ''}`;
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.classList.add('toast-show'), 10);
  setTimeout(() => { toast.classList.remove('toast-show'); setTimeout(() => toast.remove(), 250); }, 3200);
}

function escapeHtml(s) {
  return (s == null ? '' : String(s)).replace(/[<>&"']/g, ch => ({
    '<':'&lt;', '>':'&gt;', '&':'&amp;', '"':'&quot;', "'":'&#39;'
  }[ch]));
}

function relativeTime(iso) {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const diff = (Date.now() - t) / 1000;
  if (diff < 60)        return 'just now';
  if (diff < 3600)      return Math.floor(diff / 60) + 'm';
  if (diff < 86400)     return Math.floor(diff / 3600) + 'h';
  if (diff < 86400 * 7) return Math.floor(diff / 86400) + 'd';
  return new Date(iso).toLocaleDateString();
}

function propertyLabel(p) {
  if (!p) return '';
  const addr = [p.address_line1, p.unit].filter(Boolean).join(' ');
  const where = [p.city, p.state].filter(Boolean).join(', ');
  return [addr, where].filter(Boolean).join(' — ');
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

// ── Unified satellite + OS nav ───────────────────────────────────────
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
