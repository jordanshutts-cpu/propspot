// ============================================================
//  Pulse — Shared Frontend Utilities
// ============================================================

const TOKEN_KEY = 'pulse_token';
const USER_KEY  = 'pulse_user';

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
    try { renderTopbarAvatar(); } catch {}
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
  const date = new Date(iso);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

// Initial of a name/email for the avatar circle.
function avatarInitial(nameOrEmail) {
  const s = String(nameOrEmail || '?').trim();
  return s ? s[0].toUpperCase() : '?';
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

// ── Unified satellite + OS nav (matches the other apps) ─────────────
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
    a.href = _isCurrentOrigin(base) ? path : _appendToken(base.replace(/\/$/, '') + path);
    a.style.display = '';
  });
  const osBase = cfg.osUrl || '';
  document.querySelectorAll('[data-osnav]').forEach(a => {
    const page = a.dataset.osnav;
    const path = (page === 'dashboard' || page === '') ? '/dashboard.html' : '/' + page + '.html';
    if (!osBase) { a.href = path; return; }
    a.href = _isCurrentOrigin(osBase) ? path : _appendToken(osBase.replace(/\/$/, '') + path);
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
