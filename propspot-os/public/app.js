// ============================================================
//  Prop Spot — Shared Frontend Utilities
//  Pattern-matched to FieldCam's app.js so any FieldCam page can
//  read OS tokens directly (we use a shared key).
// ============================================================

const TOKEN_KEY = 'ros_token';
const USER_KEY  = 'ros_user';

// ── Auth Storage ────────────────────────────────────────────────────────
function getToken()       { return localStorage.getItem(TOKEN_KEY); }
function setToken(t)      { localStorage.setItem(TOKEN_KEY, t); }
function clearToken()     { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(USER_KEY); }
function getCachedUser()  { try { return JSON.parse(localStorage.getItem(USER_KEY)); } catch { return null; } }
function setCachedUser(u) { localStorage.setItem(USER_KEY, JSON.stringify(u)); }

// ── API Fetch Wrapper ──────────────────────────────────────────────────
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
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

async function requireAuth() {
  if (!getToken()) { window.location.href = '/index.html'; return null; }
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

async function signOut() { clearToken(); window.location.href = '/index.html'; }

function toggleSidebar() {
  const collapsed = document.documentElement.classList.toggle('sidebar-collapsed');
  try { localStorage.setItem('sidebar_collapsed', collapsed ? '1' : '0'); } catch(e) {}
  const btn = document.getElementById('nav-collapse-btn');
  if (btn) {
    btn.title = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
    btn.textContent = collapsed ? '›' : '‹';
  }
}

async function getCurrentUser() {
  return getCachedUser() || apiFetch('/api/auth/me');
}

async function getProperties()         { return apiFetch('/api/properties'); }
async function getProperty(id)         { return apiFetch(`/api/properties/${id}`); }
async function createProperty(p)       { return apiFetch('/api/properties', { method: 'POST', body: JSON.stringify(p) }); }
async function updateProperty(id, p)   { return apiFetch(`/api/properties/${id}`, { method: 'PATCH', body: JSON.stringify(p) }); }
async function deleteProperty(id)      { return apiFetch(`/api/properties/${id}`, { method: 'DELETE' }); }

async function getContacts(params = {}) {
  const qs = new URLSearchParams(params).toString();
  return apiFetch(`/api/contacts${qs ? '?' + qs : ''}`);
}
async function getContact(id)        { return apiFetch(`/api/contacts/${id}`); }
async function createContact(c)      { return apiFetch('/api/contacts', { method: 'POST', body: JSON.stringify(c) }); }
async function updateContact(id, c)  { return apiFetch(`/api/contacts/${id}`, { method: 'PATCH', body: JSON.stringify(c) }); }
async function inviteContact(id, body){ return apiFetch(`/api/contacts/${id}/invite`, { method: 'POST', body: JSON.stringify(body) }); }
async function linkContactToProperty(body)   { return apiFetch('/api/property-contacts', { method: 'POST', body: JSON.stringify(body) }); }
async function unlinkContactFromProperty(body){ return apiFetch('/api/property-contacts', { method: 'DELETE', body: JSON.stringify(body) }); }

async function getApps()                       { return apiFetch('/api/apps'); }
async function getAppGrants(appId)             { return apiFetch(`/api/apps/${appId}/grants`); }
async function grantAppAccess(appId, userId, body) {
  return apiFetch(`/api/apps/${appId}/grants/${userId}`, { method: 'PUT', body: JSON.stringify(body) });
}
async function revokeAppAccess(appId, userId)  {
  return apiFetch(`/api/apps/${appId}/grants/${userId}`, { method: 'DELETE' });
}

async function getUsers() { return apiFetch('/api/users'); }
async function inviteUser(email, fullName, app_grants) {
  return apiFetch('/api/auth/invite', {
    method: 'POST',
    body: JSON.stringify({ email, fullName, app_grants })
  });
}

async function listPipeline(stage, propertyId) {
  const qs = propertyId ? `?property_id=${propertyId}` : '';
  return apiFetch(`/api/${stage}${qs}`);
}
async function createPipelineRecord(stage, body) {
  return apiFetch(`/api/${stage}`, { method: 'POST', body: JSON.stringify(body) });
}
async function promotePipelineRecord(stage, id, body = {}) {
  return apiFetch(`/api/${stage}/${id}/promote`, { method: 'POST', body: JSON.stringify(body) });
}

async function getActivity(params = {}) {
  const qs = new URLSearchParams(params).toString();
  return apiFetch(`/api/activity${qs ? '?' + qs : ''}`);
}

// ── Property files ─────────────────────────────────────────────
async function getPropertyFiles(propertyId) {
  return apiFetch(`/api/property-files/${propertyId}`);
}
async function uploadPropertyFile(propertyId, file) {
  const fd = new FormData();
  fd.append('file', file);
  return apiFetch(`/api/property-files/${propertyId}`, { method: 'POST', body: fd });
}
async function deletePropertyFile(fileId) {
  return apiFetch(`/api/property-files/file/${fileId}`, { method: 'DELETE' });
}

// ── Holdings Desk ──────────────────────────────────────────────────────
// All write operations and the full management UI live in the satellite
// at holdings.propspot.io. Prop Spot keeps a read-only summary endpoint
// for the dashboard tile and reads the embedded property-page section
// directly from the property's GET /:id response (holdings_items field).
async function getHoldingsSummary()      { return apiFetch('/api/holdings/summary'); }

// ── Unified satellite + OS nav wiring ──────────────────────────────
// Each anchor with data-app="holdings|maintenance|fieldcam" gets wired
// to that satellite's URL with the current SSO token appended. Each
// data-osnav="dashboard|properties|contacts|team|apps" gets wired to
// the OS URL. Set window.NAV_CURRENT to highlight the active item.
let _navCfgCache = null;
async function _loadNavConfig() {
  if (_navCfgCache) return _navCfgCache;
  try {
    const cfg = await apiFetch('/api/config');
    _navCfgCache = cfg || {};
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

// Back-compat: old code called holdingsLink(path) directly.
async function holdingsLink(path = '/') {
  const cfg = await _loadNavConfig();
  const base = cfg.holdingsUrl;
  if (!base) return '#';
  if (_isCurrentOrigin(base)) return path;
  return _appendToken(base.replace(/\/$/, '') + path);
}

async function wireUnifiedNav() {
  if (!getToken()) return;
  const cfg = await _loadNavConfig();

  const APP_URLS = {
    holdings:    cfg.holdingsUrl    || '',
    maintenance: cfg.maintenanceUrl || '',
    fieldcam:    cfg.fieldcamUrl    || ''
  };

  // data-app="<slug>" — link to a satellite app
  document.querySelectorAll('[data-app]').forEach(a => {
    const slug = a.dataset.app;
    const base = APP_URLS[slug];
    if (!base) {
      a.style.display = 'none';   // satellite URL not configured — keep hidden
      return;
    }
    const path = a.dataset.appPath || '/';
    a.href = _isCurrentOrigin(base)
      ? path
      : _appendToken(base.replace(/\/$/, '') + path);
    a.style.display = '';   // reveal once URL confirmed
  });

  // data-osnav="<page>" — link to an OS page (dashboard/properties/contacts/team/apps)
  const osBase = cfg.osUrl || '';
  document.querySelectorAll('[data-osnav]').forEach(a => {
    const page = a.dataset.osnav;
    const path = (page === 'dashboard' || page === '') ? '/dashboard.html' : '/' + page + '.html';
    if (!osBase) {
      // No OS_URL configured — assume we're on OS itself, use relative path.
      a.href = path;
      return;
    }
    a.href = _isCurrentOrigin(osBase)
      ? path
      : _appendToken(osBase.replace(/\/$/, '') + path);
  });

  // Highlight the active nav-link
  const active = window.NAV_CURRENT;
  if (active) {
    document.querySelectorAll('.nav-link').forEach(a => {
      const slug = a.dataset.app || a.dataset.osnav;
      if (slug === active) a.classList.add('active');
    });
  }
}

// Inject the canonical nav HTML into <nav id="nav"></nav> on the page,
// then wire all links. Each page should set window.NAV_CURRENT = '<key>'
// before calling, where key matches the data-app or data-osnav of the
// item to highlight (dashboard | properties | holdings | maintenance |
// fieldcam | contacts | team).
function renderUnifiedNav() {
  const navEl = document.getElementById('nav');
  if (!navEl) return;
  navEl.innerHTML = `
    <a class="nav-brand" data-osnav="dashboard" href="#">
      <span class="nav-icon">🏘️</span><span class="nav-label">Prop Spot</span>
    </a>
    <button class="nav-collapse-btn" id="nav-collapse-btn" onclick="toggleSidebar()" title="Collapse sidebar">‹</button>
    <a class="nav-link" data-osnav="dashboard" href="#">
      <span class="nav-icon">🏠</span><span class="nav-label">Home</span>
    </a>
    <a class="nav-link" data-osnav="properties" href="#">
      <span class="nav-icon">🏘️</span><span class="nav-label">Properties</span>
    </a>
    <a class="nav-link" data-app="holdings" href="#" style="display:none;">
      <span class="nav-icon">💼</span><span class="nav-label">Holdings</span>
    </a>
    <a class="nav-link" data-app="maintenance" href="#" style="display:none;">
      <span class="nav-icon">🛠️</span><span class="nav-label">Maintenance</span>
    </a>
    <a class="nav-link" data-app="fieldcam" href="#" style="display:none;">
      <span class="nav-icon">📸</span><span class="nav-label">FieldCam</span>
    </a>
    <a class="nav-link" data-osnav="contacts" href="#">
      <span class="nav-icon">📇</span><span class="nav-label">Contacts</span>
    </a>
    <a class="nav-link" data-osnav="team" href="#">
      <span class="nav-icon">👥</span><span class="nav-label">Team</span>
    </a>
    <div class="nav-spacer"></div>
    <button class="nav-signout" onclick="signOut()" title="Sign Out">
      <span class="nav-icon">🚪</span><span class="nav-label">Sign Out</span>
    </button>
  `;
  // Restore collapse-button icon to match the current state.
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
    document.addEventListener('DOMContentLoaded', () => {
      renderUnifiedNav();
      wireUnifiedNav();   // also wire any pre-existing nav (back-compat)
    });
  } else {
    renderUnifiedNav();
    wireUnifiedNav();
  }
}

// ── New OS layout: top header + slim apps rail ───────────────
// Each opt-in page sets <body class="os-newlayout"> + <header id="top-header">
// + <aside id="apps-rail"> + <div id="user-menu" class="user-menu"> placeholders.
// window.NAV_CURRENT (one of: purchases | holdings | dispositions | team |
// contacts | dashboard) highlights the active top-nav item.

function renderTopHeader() {
  const el = document.getElementById('top-header');
  if (!el) return;
  el.innerHTML = `
    <nav class="top-nav-links">
      <a class="top-nav-link" href="/acquisitions.html"  data-osnav="acquisitions">Acquisitions</a>
      <a class="top-nav-link" href="/holdings.html"      data-osnav="holdings">Holdings</a>
      <a class="top-nav-link" href="/dispositions.html"  data-osnav="dispositions">Dispositions</a>
      <a class="top-nav-link" href="/closed.html"        data-osnav="closed">Closed</a>
    </nav>
    <form class="top-nav-search" onsubmit="submitTopSearch(event)">
      <span class="search-icon">🔍</span>
      <input type="search" id="top-search" placeholder="Search properties, team, contacts…" autocomplete="off"
             oninput="onSearchInput(event)" onfocus="onSearchInput(event)" onkeydown="onSearchKey(event)">
      <div class="search-results" id="search-results"></div>
    </form>
    <div class="top-nav-icons">
      <a class="top-nav-icon-btn" href="/contacts.html" data-osnav="contacts" title="Contacts">📇</a>
      <a class="top-nav-icon-btn" href="/team.html"     data-osnav="team"     title="Team">👥</a>
      <button type="button" class="top-nav-avatar" id="user-avatar"
              onclick="toggleUserMenu(event)" title="Account">${
                getCachedUser()?.full_name
                  ? escHtml(getCachedUser().full_name.charAt(0).toUpperCase())
                  : '👤'
              }</button>
    </div>
  `;
  // Highlight active section
  const active = window.NAV_CURRENT;
  if (active) {
    el.querySelectorAll('[data-osnav]').forEach(a => {
      if (a.dataset.osnav === active) a.classList.add('active');
    });
  }
  // Pre-fill search box from ?q=
  const q = new URLSearchParams(location.search).get('q');
  if (q) document.getElementById('top-search').value = q;
}

function renderAppsRail() {
  const el = document.getElementById('apps-rail');
  if (!el) return;
  el.innerHTML = `
    <a class="apps-rail-brand" href="/dashboard.html" data-osnav="dashboard" title="Prop Spot home">
      <img src="/logo.png" alt="Prop Spot">
    </a>
    <a class="apps-rail-link" data-app="fieldcam"     data-label="FieldCam"     style="display:none;" href="#">📸</a>
    <a class="apps-rail-link" data-app="maintenance"  data-label="Maintenance"  style="display:none;" href="#">🛠️</a>
    <a class="apps-rail-link" data-app="underwriting" data-label="Underwriting" style="display:none;" href="#">💰</a>
    <div class="apps-rail-spacer"></div>
  `;
  // Wire data-app links via existing helper (it'll fetch /api/config)
  wireUnifiedNav();
}

function renderUserMenu() {
  const el = document.getElementById('user-menu');
  if (!el) return;
  const u = getCachedUser() || {};
  el.innerHTML = `
    <div class="user-info">
      <div class="user-name">${escHtml(u.full_name || u.email || 'You')}</div>
      <div class="user-email">${escHtml(u.email || '')}</div>
    </div>
    <button type="button" onclick="openChangePassword()">🔑 Change Password</button>
    <div class="menu-divider"></div>
    <button type="button" class="danger" onclick="signOut()">🚪 Sign Out</button>
  `;
}

function toggleUserMenu(e) {
  if (e) e.stopPropagation();
  const el = document.getElementById('user-menu');
  if (!el) return;
  el.classList.toggle('open');
}

function closeUserMenuOnOutsideClick(e) {
  const menu = document.getElementById('user-menu');
  const avatar = document.getElementById('user-avatar');
  if (!menu || !menu.classList.contains('open')) return;
  if (menu.contains(e.target) || (avatar && avatar.contains(e.target))) return;
  menu.classList.remove('open');
}

function submitTopSearch(e) {
  e.preventDefault();
  const q = document.getElementById('top-search').value.trim();
  // Pressing Enter goes to the full filtered properties list.
  // For instant jump-to-result, the dropdown handles individual clicks.
  window.location.href = '/properties.html' + (q ? '?q=' + encodeURIComponent(q) : '');
}

// ── Live search across properties / users / contacts ─────────
let _searchCache = null;
let _searchInflight = null;

async function _loadSearchData() {
  if (_searchCache) return _searchCache;
  if (_searchInflight) return _searchInflight;
  _searchInflight = (async () => {
    const [properties, users, contacts] = await Promise.all([
      apiFetch('/api/properties').catch(() => []),
      apiFetch('/api/users').catch(() => []),
      apiFetch('/api/contacts').catch(() => [])
    ]);
    _searchCache = { properties, users, contacts };
    _searchInflight = null;
    return _searchCache;
  })();
  return _searchInflight;
}

async function onSearchInput(e) {
  const q = e.target.value.trim().toLowerCase();
  const resultsEl = document.getElementById('search-results');
  if (!resultsEl) return;
  if (!q) { resultsEl.classList.remove('open'); return; }

  // Show "loading" until we have data the first time.
  if (!_searchCache) {
    resultsEl.innerHTML = '<div class="search-loading">Loading…</div>';
    resultsEl.classList.add('open');
  }
  const data = await _loadSearchData();

  // Re-read the latest query in case the user kept typing
  const q2 = document.getElementById('top-search').value.trim().toLowerCase();
  if (!q2) { resultsEl.classList.remove('open'); return; }

  const props = (data.properties || []).filter(p => {
    const addr = `${p.address_line1 || ''} ${p.unit || ''} ${p.city || ''} ${p.state || ''} ${p.zip || ''}`.toLowerCase();
    const dn = (p.display_name || '').toLowerCase();
    return addr.includes(q2) || dn.includes(q2);
  }).slice(0, 6);

  const users = (data.users || []).filter(u =>
    (u.full_name || '').toLowerCase().includes(q2) ||
    (u.email     || '').toLowerCase().includes(q2)
  ).slice(0, 6);

  const contacts = (data.contacts || []).filter(c =>
    (c.full_name || '').toLowerCase().includes(q2) ||
    (c.email     || '').toLowerCase().includes(q2) ||
    (c.company   || '').toLowerCase().includes(q2) ||
    (c.phone     || '').toLowerCase().includes(q2)
  ).slice(0, 6);

  let html = '';
  if (props.length) {
    html += '<div class="search-section"><div class="search-section-header">Properties</div>';
    html += props.map(p => `
      <a class="search-result" href="/property.html?id=${p.id}">
        <span class="search-result-icon">🏠</span>
        <div class="search-result-body">
          <div class="search-result-title">${escHtml(p.display_name || p.address_line1)}${p.unit ? ' #' + escHtml(p.unit) : ''}</div>
          <div class="search-result-subtitle">${escHtml([p.city, p.state, p.zip].filter(Boolean).join(', '))}</div>
        </div>
      </a>
    `).join('');
    html += '</div>';
  }
  if (users.length) {
    html += '<div class="search-section"><div class="search-section-header">Team</div>';
    html += users.map(u => `
      <a class="search-result" href="/team.html">
        <span class="search-result-icon">👤</span>
        <div class="search-result-body">
          <div class="search-result-title">${escHtml(u.full_name || u.email)}${u.is_owner ? ' · owner' : ''}</div>
          <div class="search-result-subtitle">${escHtml(u.email || '')}</div>
        </div>
      </a>
    `).join('');
    html += '</div>';
  }
  if (contacts.length) {
    html += '<div class="search-section"><div class="search-section-header">Contacts</div>';
    html += contacts.map(c => {
      const sub = [c.company, c.email, c.phone, contactTypeLabel ? contactTypeLabel(c.type) : c.type]
        .filter(Boolean).join(' · ');
      return `
        <a class="search-result" href="/contact.html?id=${c.id}">
          <span class="search-result-icon">📇</span>
          <div class="search-result-body">
            <div class="search-result-title">${escHtml(c.full_name)}</div>
            <div class="search-result-subtitle">${escHtml(sub)}</div>
          </div>
        </a>
      `;
    }).join('');
    html += '</div>';
  }
  if (!props.length && !users.length && !contacts.length) {
    html = '<div class="search-empty">No matches.</div>';
  } else {
    html += '<div class="search-section" style="border-top:1px solid var(--border);">' +
      `<a class="search-result" href="/properties.html?q=${encodeURIComponent(q2)}">` +
        '<span class="search-result-icon">↩</span>' +
        '<div class="search-result-body">' +
          `<div class="search-result-title">See all properties matching "${escHtml(q2)}"</div>` +
        '</div>' +
      '</a></div>';
  }
  resultsEl.innerHTML = html;
  resultsEl.classList.add('open');
}

function onSearchKey(e) {
  if (e.key === 'Escape') {
    document.getElementById('search-results')?.classList.remove('open');
    e.target.blur();
  }
}

function closeSearchOnOutsideClick(e) {
  const results = document.getElementById('search-results');
  const search  = document.getElementById('top-search');
  if (!results || !results.classList.contains('open')) return;
  if (results.contains(e.target) || (search && search.contains(e.target))) return;
  results.classList.remove('open');
}

async function openChangePassword() {
  document.getElementById('user-menu')?.classList.remove('open');
  let modal = document.getElementById('change-password-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'change-password-modal';
    modal.className = 'modal-backdrop';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:1000;display:flex;align-items:center;justify-content:center;padding:20px;';
    modal.innerHTML = `
      <div style="background:#fff;border-radius:14px;max-width:380px;width:100%;padding:20px;">
        <div class="section-header"><span class="section-title">Change Password</span>
          <button class="icon-btn" style="background:#eee;color:#000;" onclick="document.getElementById('change-password-modal').remove()">×</button>
        </div>
        <form id="cp-form">
          <div class="form-group">
            <label class="form-label">Current Password</label>
            <input class="form-input" type="password" id="cp-current" required autocomplete="current-password">
          </div>
          <div class="form-group">
            <label class="form-label">New Password (min 6)</label>
            <input class="form-input" type="password" id="cp-new" required minlength="6" autocomplete="new-password">
          </div>
          <p id="cp-err" class="text-sm mb-8" style="color:var(--danger);display:none;"></p>
          <button class="btn btn-primary btn-full" type="submit" id="cp-btn">Save</button>
        </form>
      </div>`;
    document.body.appendChild(modal);
    document.getElementById('cp-form').addEventListener('submit', submitChangePassword);
  } else {
    modal.style.display = 'flex';
  }
}

async function submitChangePassword(e) {
  e.preventDefault();
  const btn = document.getElementById('cp-btn');
  const err = document.getElementById('cp-err');
  err.style.display = 'none';
  showSpinner(btn, 'Saving…');
  try {
    await apiFetch('/api/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({
        current_password: document.getElementById('cp-current').value,
        new_password:     document.getElementById('cp-new').value
      })
    });
    document.getElementById('change-password-modal').remove();
    showToast('Password changed');
  } catch (e2) {
    err.textContent = e2.message; err.style.display = 'block';
    hideSpinner(btn);
  }
}

if (typeof window !== 'undefined') {
  document.addEventListener('click', closeUserMenuOnOutsideClick);
  document.addEventListener('click', closeSearchOnOutsideClick);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      renderTopHeader(); renderAppsRail(); renderUserMenu();
    });
  } else {
    renderTopHeader(); renderAppsRail(); renderUserMenu();
  }
}

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

// Returns { cls, label } for a next_due_date badge.
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

function showToast(message, type = 'success') {
  const existing = document.getElementById('ros-toast');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.id = 'ros-toast';
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

// Property-level status across the overall lifecycle.
// Tuple shape: [value, label, text-color, background-color]
const PROPERTY_STATUSES = [
  ['purchasing',           'Purchasing',         '#92400e', '#fef3c7'],   // amber  → Acquisitions
  ['renovating',           'Renovating',         '#1e40af', '#dbeafe'],   // blue   → Holdings
  ['renting',              'Renting',            '#075985', '#e0f2fe'],   // sky    → Holdings
  ['rented',               'Rented',             '#15803d', '#dcfce7'],   // green  → Holdings
  ['listed_for_rent',      'Listed for Rent',    '#0c4a6e', '#bae6fd'],   // sky-2  → Holdings (treat as renting-ish)
  ['selling',              'Selling',            '#6b21a8', '#ede9fe'],   // violet → Dispositions
  ['listed_for_sale',      'Listed on MLS',      '#581c87', '#e9d5ff'],   // purple → Dispositions
  ['under_contract_buyer', 'UC with Buyer',      '#9d174d', '#fce7f3'],   // pink   → Dispositions
  ['sold',                 'Sold',               '#1e293b', '#e2e8f0'],   // slate  → Closed
  ['assigned',             'Assigned',           '#0f172a', '#cbd5e1'],   // slate-2 → Closed
  ['dropped',              'Dropped',            '#6b7280', '#f3f4f6']    // gray   → Closed
];
function propertyStatusLabel(s) {
  const f = PROPERTY_STATUSES.find(([k]) => k === s);
  return f ? f[1] : (s || '—');
}
function propertyStatusBadge(s) {
  const f = PROPERTY_STATUSES.find(([k]) => k === s);
  if (!f) return `<span class="status-badge">—</span>`;
  return `<span class="status-badge" style="color:${f[2]};background:${f[3]};">${f[1]}</span>`;
}

// Acquisition sub-status (only meaningful when status = 'purchasing').
// Tuple shape: [value, label, text-color, background-color]
// Fixed order — do not reorder without Jordan's explicit ask.
const ACQUISITION_STATUSES = [
  ['under_contract',    'Under Contract',    '#92400e', '#fef3c7'],   // amber
  ['due_diligence',     'Due Diligence',     '#1e40af', '#dbeafe'],   // blue
  ['assigning',         'Assigning',         '#6b21a8', '#ede9fe'],   // violet
  ['approved_to_close', 'Approved to Close', '#15803d', '#dcfce7']    // green
];
function acquisitionStatusLabel(s) {
  const f = ACQUISITION_STATUSES.find(([k]) => k === s);
  return f ? f[1] : (s || '—');
}
function acquisitionStatusBadge(s) {
  const f = ACQUISITION_STATUSES.find(([k]) => k === s);
  if (!f) return `<span class="status-badge">—</span>`;
  return `<span class="status-badge" style="color:${f[2]};background:${f[3]};">${f[1]}</span>`;
}

const CONTACT_TYPES = [
  ['seller','Seller'],
  ['buyer','Buyer'],
  ['lender','Lender'],
  ['contractor','Contractor'],
  ['inspector','Inspector'],
  ['property_manager','Property Manager'],
  ['utility_company','Utility Company'],
  ['buyer_agent','Buyer Agent'],
  ['listing_agent','Listing Agent'],
  ['closing_attorney','Closing Attorney'],
  ['accountant','Accountant'],
  ['other','Other']
];

function contactTypeLabel(type) {
  const found = CONTACT_TYPES.find(([k]) => k === type);
  return found ? found[1] : type;
}
