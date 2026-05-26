// ============================================================
//  Prop Spot — Shared Frontend Utilities
//  Pattern-matched to FieldCam's app.js so any FieldCam page can
//  read OS tokens directly (we use a shared key).
// ============================================================

// ── Page transition loader ──────────────────────────────────────
// Each page's <head> sets html.page-loading inline so CSS covers the
// page from first paint. We keep the curtain up until the JS-rendered
// chrome (sidebar + topbar in newchrome, or renderTopHeader+rail in
// legacy) signals that it has painted — that way the user never sees
// the chrome "pop in" after the overlay fades. A hard fallback hides
// the loader after 1.2s no matter what, so a broken chrome script
// can't strand the page behind a permanent spinner.
(function setupPageLoader() {
  const useNewChrome = !!(window.__newChromeEnabled && window.__newChromeEnabled());
  // 'content' is signalled when in-flight fetches settle (or after a
  // fallback timer). Pairs with chrome readiness so the loader only
  // drops when both the chrome AND the page body are rendered.
  const requiredParts = useNewChrome ? ['sidebar', 'topbar', 'content'] : ['legacy', 'content'];
  const ready = new Set();
  let hidden = false;

  function ensureOverlay() {
    if (document.getElementById('os-page-loader')) return;
    const div = document.createElement('div');
    div.id = 'os-page-loader';
    div.className = 'os-page-loader';
    div.innerHTML =
      '<div class="os-page-loader-stack">' +
        '<div class="os-page-loader-wordmark">PropSpot<span class="os-suffix">.OS</span></div>' +
        '<div class="os-page-loader-dots" aria-hidden="true">' +
          '<span></span><span></span><span></span>' +
        '</div>' +
      '</div>';
    (document.body || document.documentElement).appendChild(div);
  }
  function show() {
    hidden = false;
    ensureOverlay();
    document.documentElement.classList.add('page-loading');
    const el = document.getElementById('os-page-loader');
    if (el) el.classList.add('show');
  }
  function hide() {
    if (hidden) return;
    hidden = true;
    document.documentElement.classList.remove('page-loading');
    const el = document.getElementById('os-page-loader');
    if (el) el.classList.remove('show');
  }
  function maybeHide() {
    if (requiredParts.every(p => ready.has(p))) {
      // Tiny tick so the just-painted chrome is composited before we fade.
      requestAnimationFrame(() => requestAnimationFrame(hide));
    }
  }

  // Public ready signal — sidebar.js / topbar.js call this after their
  // initial paint. Safe to call multiple times.
  window.__markChromeReady = function (part) {
    ready.add(part);
    maybeHide();
  };

  if (document.body) ensureOverlay();
  else document.addEventListener('DOMContentLoaded', ensureOverlay, { once: true });

  // Legacy chrome renders synchronously inside app.js's DOMContentLoaded
  // handler, so we can mark 'legacy' ready right after that fires.
  if (!useNewChrome) {
    if (document.readyState !== 'loading') {
      setTimeout(() => window.__markChromeReady('legacy'), 0);
    } else {
      document.addEventListener('DOMContentLoaded',
        () => setTimeout(() => window.__markChromeReady('legacy'), 0),
        { once: true });
    }
  }

  // ── Content-ready signal via fetch tracking ─────────────────
  // Wrap fetch to count pending requests. When the count drops to 0
  // (with a tiny settle window), mark 'content' ready. Static-page
  // fallback fires earlier so pages that issue no fetches don't pay
  // an extra wait.
  let pendingFetches = 0;
  let settleTimer = null;
  function scheduleSettle() {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      if (pendingFetches === 0) window.__markChromeReady('content');
    }, 40);
  }
  if (typeof window.fetch === 'function') {
    const origFetch = window.fetch.bind(window);
    window.fetch = function (...args) {
      pendingFetches++;
      clearTimeout(settleTimer);
      const onDone = () => {
        pendingFetches = Math.max(0, pendingFetches - 1);
        if (pendingFetches === 0) scheduleSettle();
      };
      let p;
      try { p = origFetch(...args); }
      catch (e) { onDone(); throw e; }
      p.then(onDone, onDone);
      return p;
    };
  }
  // Static-page fallback: if no fetches were issued, settle quickly.
  setTimeout(() => { if (pendingFetches === 0) scheduleSettle(); }, 150);

  // Hard fallback: never strand the page behind the loader, even if
  // a fetch hangs forever (SSE, long-poll, broken endpoint).
  setTimeout(() => { ready.add('content'); ready.add('sidebar'); ready.add('topbar'); ready.add('legacy'); maybeHide(); }, 800);

  // Same-origin link clicks → mask the OUTGOING navigation
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href]');
    if (!a) return;
    const href = a.getAttribute('href') || '';
    if (!href || href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:') || href.startsWith('tel:')) return;
    if (a.target && a.target !== '_self') return;
    if (a.hasAttribute('download')) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (e.defaultPrevented) return;
    let url;
    try { url = new URL(a.href, location.origin); } catch { return; }
    if (url.origin !== location.origin) return;
    if (url.pathname === location.pathname && url.search === location.search) return;
    show();
  });

  // Programmatic navigation (location.href = …, history.pushState, etc.)
  const origAssign = location.assign.bind(location);
  const origReplace = location.replace.bind(location);
  try {
    location.assign  = function (url) { show(); return origAssign(url); };
    location.replace = function (url) { show(); return origReplace(url); };
  } catch { /* Safari may freeze location — ignore */ }

  // bfcache restore → page is already painted, drop the curtain immediately
  window.addEventListener('pageshow', (e) => { if (e.persisted) hide(); });
})();

const TOKEN_KEY = 'ros_token';
const USER_KEY  = 'ros_user';

// ── New-chrome feature flag ─────────────────────────────────────
// The new chrome (260px sidebar + flex topbar) is now the DEFAULT.
// Opt-out paths (for emergencies / legacy debugging only):
//   - ?newchrome=0 in the URL  → force legacy chrome for this load
//   - localStorage.propspot_newchrome === '0' → force legacy chrome
// Anything else → new chrome.
window.__newChromeEnabled = function () {
  try {
    const param = new URLSearchParams(location.search).get('newchrome');
    if (param === '0') return false;
    if (param === '1') return true;
    if (localStorage.getItem('propspot_newchrome') === '0') return false;
  } catch (e) {}
  return true;
};
// Skip chrome loading on unauthenticated pages (login, reset-password,
// accept-invite) — sidebar.js/topbar.js call ensurePlaceholders() which
// would manufacture chrome elements onto those pages and dump the cached
// sidebar HTML on top of the login form. Auth gates use !getToken() as
// the signal because token presence is the universal authenticated marker.
if (window.__newChromeEnabled() && localStorage.getItem(TOKEN_KEY)) {
  // Persist the flag so navigating within the workspace keeps it on.
  try { localStorage.setItem('propspot_newchrome', '1'); } catch (e) {}
  // Apply os-newchrome to body immediately (synchronously, before sidebar.js
  // finishes async data fetches) so there is no layout flash between page loads.
  try { document.body.classList.add('os-newchrome'); } catch (e) {}
  // Dynamically load the new chrome scripts.
  ['/sidebar.js', '/topbar.js', '/lifecycle-stepper.js'].forEach(src => {
    const s = document.createElement('script');
    s.src = src;
    s.async = false;
    document.head.appendChild(s);
  });
}

// ── Apply theme class immediately to prevent FOUC ────────────────
// Reads localStorage synchronously before any paint so premium.css
// takes effect on the first frame instead of flashing in.
(function () {
  try {
    if (localStorage.getItem('propspot_theme') === 'premium') {
      document.documentElement.classList.add('theme-premium');
      // Inject premium.css early so it's ready before theme.js loads
      const link = document.createElement('link');
      link.rel  = 'stylesheet';
      link.id   = 'premium-css-link';
      link.href = '/premium.css';
      document.head.appendChild(link);
    }
  } catch (e) {}
})();

// ── Theme manager (premium / classic toggle) ─────────────────────
(function () {
  const s = document.createElement('script');
  s.src = '/theme.js';
  s.async = false;
  document.head.appendChild(s);
})();

// ── Page-load progress bar ───────────────────────────────────────
// Shows a thin green bar at the top when navigating between pages.
(function () {
  const BAR_KEY = 'propspot_nav_loading';
  const BRAND   = '#61B746';

  function injectBar() {
    if (document.getElementById('ps-nav-bar')) return;
    const bar = document.createElement('div');
    bar.id = 'ps-nav-bar';
    bar.style.cssText = [
      'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:99999',
      'height:2px', `background:${BRAND}`,
      'transform:scaleX(0)', 'transform-origin:left center',
      'transition:transform 0.25s ease', 'pointer-events:none',
    ].join(';');
    document.body.appendChild(bar);
    return bar;
  }

  function completeBar() {
    const bar = document.getElementById('ps-nav-bar');
    if (!bar) return;
    bar.style.transition = 'transform 0.2s ease, opacity 0.3s ease 0.15s';
    bar.style.transform  = 'scaleX(1)';
    bar.style.opacity    = '0';
    setTimeout(() => { try { bar.remove(); } catch (e) {} }, 500);
    try { sessionStorage.removeItem(BAR_KEY); } catch (e) {}
  }

  // On page load: if a navigation was in progress, complete the bar.
  document.addEventListener('DOMContentLoaded', function () {
    try {
      if (sessionStorage.getItem(BAR_KEY)) {
        const bar = injectBar();
        if (bar) {
          // Jump to 80% instantly, then complete
          bar.style.transition = 'none';
          bar.style.transform  = 'scaleX(0.8)';
          requestAnimationFrame(() => { completeBar(); });
        }
      }
    } catch (e) {}

    // Wire navigation links to show the bar on click.
    document.addEventListener('click', function (e) {
      const anchor = e.target.closest('a[href]');
      if (!anchor) return;
      const href = anchor.getAttribute('href');
      if (!href || href.startsWith('#') || href.startsWith('javascript') ||
          anchor.target === '_blank' || e.ctrlKey || e.metaKey || e.shiftKey) return;
      // Only trigger for same-origin or relative navigation
      try {
        const url = new URL(href, location.origin);
        if (url.origin !== location.origin) return;
      } catch (e) { return; }

      try { sessionStorage.setItem(BAR_KEY, '1'); } catch (e) {}
      const bar = injectBar();
      if (bar) {
        requestAnimationFrame(() => {
          bar.style.transform = 'scaleX(0.65)';
          bar.style.transition = 'transform 1.8s cubic-bezier(0.1, 0.05, 0, 1)';
        });
      }
    });
  });
})();

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

async function signOut() {
  clearToken();
  // Drop the cached sidebar HTML so a different user signing in next
  // doesn't briefly see the previous user's pinned/recent properties.
  try { sessionStorage.removeItem('propspot_sidebar_cache'); } catch (e) {}
  window.location.href = '/index.html';
}

function toggleSidebar() {
  const collapsed = document.documentElement.classList.toggle('sidebar-collapsed');
  try { localStorage.setItem('sidebar_collapsed', collapsed ? '1' : '0'); } catch(e) {}
  // Legacy chrome button (chevron via textContent)
  const legacyBtn = document.getElementById('nav-collapse-btn');
  if (legacyBtn) {
    legacyBtn.title = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
    legacyBtn.textContent = collapsed ? '›' : '‹';
  }
  // New chrome button — SVG flips via CSS rotate, just update the tooltip.
  const newBtn = document.getElementById('os-newchrome-collapse-btn');
  if (newBtn) {
    newBtn.title = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
    newBtn.setAttribute('aria-label', collapsed ? 'Expand sidebar' : 'Collapse sidebar');
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

// ── Activity humanizer ─────────────────────────────────────────
// Turns the raw {action, entity_type, payload} stored on each activity
// row into a readable sentence like "set purchase price to $250,000".
// Shared between the dashboard's Recent Activity widget and the full
// Activity Monitor page so descriptions stay consistent.
const ACTIVITY_ENTITY_NOUN = {
  property: 'property', prospect: 'prospect', lead: 'lead',
  opportunity: 'opportunity', purchase: 'purchase', project: 'project',
  holding: 'holding', contact: 'contact', photo: 'photo',
  file: 'file', email: 'email', note: 'note', task: 'task'
};
const ACTIVITY_FIELD_LABELS = {
  status: 'status', acquisition_status: 'acquisition stage',
  display_name: 'name', address_line1: 'address', unit: 'unit',
  city: 'city', state: 'state', zip: 'ZIP', county: 'county',
  tms: 'TMS', parcel_id: 'parcel ID', lockbox_code: 'lockbox code',
  owner: 'owner', owner_name: 'owner', notes: 'notes',
  purchase_price: 'purchase price', purchase_date: 'purchase date',
  anticipated_close_date: 'anticipated close date',
  sold_price: 'sold price', sold_date: 'sold date',
  lender_contact_id: 'lender', seller_contact_id: 'seller',
  lender_name: 'lender', seller_name: 'seller',
  source: 'source', raw_name: 'name', raw_phone: 'phone',
  motivation_notes: 'motivation notes', our_offer: 'offer',
  appointment_at: 'appointment', contract_date: 'contract date',
  kind: 'kind', amount: 'amount', frequency: 'frequency',
  next_due_date: 'next due', vendor: 'vendor', category: 'category',
  name: 'name', full_name: 'name', role: 'role',
  phone: 'phone', email: 'email'
};
const ACTIVITY_SKIP_KEYS = new Set([
  'property_id', 'id', 'created_at', 'updated_at',
  'created_by', 'updated_by'
]);

function fmtActivityValue(key, value) {
  if (value == null || value === '') return '—';
  if (key === 'status' && typeof propertyStatusLabel === 'function')
    return propertyStatusLabel(value) || value;
  if (key === 'acquisition_status' && typeof acquisitionStatusLabel === 'function')
    return acquisitionStatusLabel(value) || value;
  if (typeof value === 'number' && /price|amount|offer/i.test(key))
    return formatMoney(value);
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) && /date|_at$/i.test(key))
    return formatDate(value);
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  let s = String(value);
  if (s.length > 48) s = s.slice(0, 48) + '…';
  return s;
}

// Task status labels
const TASK_STATUS_LABELS = {
  open: 'Open', in_progress: 'In Progress', done: 'Done', cancelled: 'Cancelled'
};
const TASK_PRIORITY_LABELS = {
  low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent'
};

function describeActivity(r) {
  const action  = r.action || 'changed';
  const ent     = ACTIVITY_ENTITY_NOUN[r.entity_type] || r.entity_type || 'item';
  const payload = (r.payload && typeof r.payload === 'object') ? r.payload : {};

  // ── Task compound actions ──────────────────────────────────────
  if (action === 'task_created') {
    const title = payload.title ? ` "<strong>${escHtml(payload.title)}</strong>"` : '';
    return `<span class="act-verb act-create">created</span> task${title}`;
  }
  if (action === 'task_deleted') {
    const title = payload.title ? ` "<strong>${escHtml(payload.title)}</strong>"` : '';
    return `<span class="act-verb act-delete">deleted</span> task${title}`;
  }
  if (action === 'task_updated') {
    const parts = [];
    if (payload.status   != null) parts.push(`status → <strong class="act-value">${escHtml(TASK_STATUS_LABELS[payload.status]   || payload.status)}</strong>`);
    if (payload.priority != null) parts.push(`priority → <strong class="act-value">${escHtml(TASK_PRIORITY_LABELS[payload.priority] || payload.priority)}</strong>`);
    if (!parts.length) return `<span class="act-verb">updated</span> a task`;
    return `<span class="act-verb">updated</span> task · ${parts.join(', ')}`;
  }

  if (action === 'created')          return `<span class="act-verb act-create">created</span> a ${ent}`;
  if (action === 'deleted')          return `<span class="act-verb act-delete">deleted</span> a ${ent}`;
  if (action === 'photos_recovered') return `<span class="act-verb">recovered</span> ${payload.inserted || ''} photo${payload.inserted === 1 ? '' : 's'}`.replace(/\s+/g, ' ');

  if (action === 'status_changed' || (action === 'updated' && payload.status)) {
    const newStatus = fmtActivityValue('status', payload.status);
    const extra = payload.acquisition_status
      ? ` · ${fmtActivityValue('acquisition_status', payload.acquisition_status)}`
      : '';
    return `<span class="act-verb">moved</span> ${ent} to <strong class="act-value">${escHtml(newStatus + extra)}</strong>`;
  }

  if (action === 'updated' || action === 'changed') {
    const keys = Object.keys(payload).filter(k => !ACTIVITY_SKIP_KEYS.has(k));
    if (!keys.length) return `<span class="act-verb">updated</span> ${ent}`;
    if (keys.length === 1) {
      const k = keys[0];
      const label = ACTIVITY_FIELD_LABELS[k] || k.replace(/_/g, ' ');
      const val = fmtActivityValue(k, payload[k]);
      const isClear = payload[k] == null || payload[k] === '';
      if (isClear) return `<span class="act-verb">cleared</span> <strong class="act-field">${escHtml(label)}</strong> on ${ent}`;
      return `<span class="act-verb">set</span> <strong class="act-field">${escHtml(label)}</strong> to <strong class="act-value">${escHtml(val)}</strong>`;
    }
    const PRIORITY = ['purchase_price', 'sold_price', 'purchase_date', 'sold_date',
                      'display_name', 'address_line1', 'owner_name', 'notes'];
    const sorted = keys.slice().sort((a, b) => {
      const ia = PRIORITY.indexOf(a), ib = PRIORITY.indexOf(b);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });
    const shown = sorted.slice(0, 3).map(k => ACTIVITY_FIELD_LABELS[k] || k.replace(/_/g, ' '));
    const more  = sorted.length > 3 ? ` <span class="text-muted">+${sorted.length - 3} more</span>` : '';
    return `<span class="act-verb">updated</span> <strong class="act-field">${escHtml(shown.join(', '))}</strong>${more} on ${ent}`;
  }

  return `<span class="act-verb">${escHtml(action)}</span> ${ent}`;
}
window.describeActivity = describeActivity;

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

// ── Satellite API helper ────────────────────────────────────────────
// All satellite APIs now live in this same OS server — routes are mounted
// under /api/<slug>/... so we translate paths and call apiFetch directly.
//
// Slug → route prefix mapping:
//   fieldcam    /api/properties      → /api/fieldcam/properties
//   maintenance /api/work-orders     → /api/maintenance/work-orders
//   pulse       /api/pulse/*         → /api/pulse/*  (already namespaced)
//   inbox       /api/shared-inboxes  → /api/inbox/shared-inboxes
//   holdings    /api/holdings/*      → /api/holdings/*  (already at OS)
async function satelliteApiFetch(slug, path, opts = {}) {
  // Slugs that need a namespace prefix injected
  const PREFIXED = { fieldcam: 'fieldcam', maintenance: 'maintenance', inbox: 'inbox' };
  let localPath = path;
  if (PREFIXED[slug]) {
    // /api/foo/bar → /api/<slug>/foo/bar
    localPath = path.replace(/^\/api\//, `/api/${PREFIXED[slug]}/`);
    // Handle paths that don't start with /api/ (shouldn't happen, but guard)
    if (!localPath.startsWith('/api/')) localPath = `/api/${PREFIXED[slug]}${path}`;
  }
  // pulse and holdings paths are already correct (/api/pulse/*, /api/holdings/*)
  return apiFetch(localPath, opts);
}

// Get the full URL for a satellite page (with SSO token).
// Use for links that open a satellite detail page that doesn't yet have an OS equivalent.
async function satellitePageUrl(slug, path = '/') {
  const cfg = await _loadNavConfig();
  const urlMap = {
    holdings:    cfg.holdingsUrl,
    maintenance: cfg.maintenanceUrl,
    fieldcam:    cfg.fieldcamUrl,
    pulse:       cfg.pulseUrl,
    inbox:       cfg.inboxUrl,
  };
  const base = urlMap[slug];
  if (!base) return '#';
  const token = getToken();
  const url = base.replace(/\/$/, '') + path;
  if (!token) return url;
  const sep = url.includes('?') ? '&' : '?';
  return url + sep + 'token=' + encodeURIComponent(token);
}

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
    holdings:     cfg.holdingsUrl     || '',
    maintenance:  cfg.maintenanceUrl  || '',
    fieldcam:     cfg.fieldcamUrl     || '',
    pulse:        cfg.pulseUrl        || '',
    inbox:        cfg.inboxUrl        || '',
    underwriting: cfg.underwritingUrl || ''
  };

  // Apps with OS-native pages — always route here, never to satellite URL.
  const OS_NATIVE_PAGES = {
    holdings:    '/holdings-desk.html',
    maintenance: '/maintenance.html',
    fieldcam:    '/fieldcam.html',
    pulse:       '/pulse.html',
    inbox:       '/inbox.html',
  };

  // data-app="<slug>" — route to OS-native page if one exists, otherwise app-frame
  document.querySelectorAll('[data-app]').forEach(a => {
    const slug = a.dataset.app;

    // OS-native page takes priority — always stays within the OS
    if (OS_NATIVE_PAGES[slug]) {
      const oPath = a.dataset.appPath || '/';
      const qs = oPath.includes('?') ? '?' + oPath.split('?').slice(1).join('?') : '';
      a.href = OS_NATIVE_PAGES[slug] + qs;
      a.style.display = '';
      return;
    }

    const base = APP_URLS[slug];
    if (!base) { a.style.display = 'none'; return; }
    const path = a.dataset.appPath || '/';
    a.href = _isCurrentOrigin(base) ? path : _appendToken(base.replace(/\/$/, '') + path);
    a.style.display = '';
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
    <a class="nav-link" data-app="holdings" href="#" style="display:none;">
      <span class="nav-icon">💼</span><span class="nav-label">Holdings</span>
    </a>
    <a class="nav-link" data-app="maintenance" href="#" style="display:none;">
      <span class="nav-icon">🛠️</span><span class="nav-label">Maintenance</span>
    </a>
    <a class="nav-link" data-app="fieldcam" href="#" style="display:none;">
      <span class="nav-icon">📸</span><span class="nav-label">FieldCam</span>
    </a>
    <a class="nav-link" data-app="pulse" href="#" style="display:none;">
      <span class="nav-icon">💬</span><span class="nav-label">Pulse</span>
    </a>
    <a class="nav-link" data-app="inbox" href="#" style="display:none;">
      <span class="nav-icon">📧</span><span class="nav-label">Inbox</span>
    </a>
    <a class="nav-link" data-osnav="underwriting" href="/underwriting.html">
      <span class="nav-icon">📊</span><span class="nav-label">Underwriting</span>
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
      if (window.__newChromeEnabled && window.__newChromeEnabled()) return;
      renderUnifiedNav();
      wireUnifiedNav();   // also wire any pre-existing nav (back-compat)
    });
  } else {
    if (!(window.__newChromeEnabled && window.__newChromeEnabled())) {
      renderUnifiedNav();
      wireUnifiedNav();
    }
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
              onclick="toggleUserMenu(event)" title="Account">${avatarContent(getCachedUser())}</button>
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
    <a class="apps-rail-brand" href="/dashboard.html" title="Prop Spot home">
      <img src="/logo.png" alt="Prop Spot">
    </a>
    <a class="apps-rail-link" data-osnav="dashboard"     data-label="Home"         href="/dashboard.html">🏠</a>
    <a class="apps-rail-link" data-osnav="holdings-desk" data-label="Holdings Desk" href="/holdings-desk.html">💼</a>
    <a class="apps-rail-link" data-osnav="maintenance"   data-label="Maintenance"  href="/maintenance.html">🛠️</a>
    <a class="apps-rail-link" data-osnav="fieldcam"      data-label="FieldCam"     href="/fieldcam.html">📸</a>
    <a class="apps-rail-link" data-osnav="pulse"         data-label="Pulse"        href="/pulse.html">💬</a>
    <a class="apps-rail-link" data-osnav="inbox"         data-label="Inbox"        href="/inbox.html">📧</a>
    <a class="apps-rail-link" data-osnav="underwriting"  data-label="Underwriting" href="/underwriting.html">📊</a>
    <div class="apps-rail-spacer"></div>
  `;
  // Wire data-osnav links (sets active highlight).
  wireUnifiedNav();
}

// Render the avatar circle's inner content — either an <img> (when the
// user has uploaded a picture) or a single-letter initial fallback.
function avatarContent(u, sizeClass = '') {
  if (u?.avatar_url) {
    return `<img class="avatar-img ${sizeClass}" src="${escHtml(u.avatar_url)}" alt="">`;
  }
  if (u?.full_name) return escHtml(u.full_name.charAt(0).toUpperCase());
  if (u?.email)     return escHtml(u.email.charAt(0).toUpperCase());
  return '👤';
}

function renderUserMenu() {
  const el = document.getElementById('user-menu');
  if (!el) return;
  const u = getCachedUser() || {};
  el.innerHTML = `
    <div class="user-info" style="display:flex;gap:10px;align-items:center;">
      <div class="user-avatar-big">${avatarContent(u, 'avatar-img--big')}</div>
      <div style="min-width:0;">
        <div class="user-name">${escHtml(u.full_name || u.email || 'You')}</div>
        <div class="user-email">${escHtml(u.email || '')}</div>
      </div>
    </div>
    <button type="button" onclick="openEditProfile()"><span class="user-menu-icon" data-icon="user">👤</span> Edit Profile</button>
    <button type="button" onclick="openChangePassword()"><span class="user-menu-icon" data-icon="key">🔑</span> Change Password</button>
    <button type="button" onclick="window.location.href='/team.html'"><span class="user-menu-icon" data-icon="users">👥</span> Team Members</button>
    <button type="button" onclick="openSettings()"><span class="user-menu-icon" data-icon="settings">⚙️</span> Settings</button>
    <div class="menu-divider"></div>
    <button type="button" class="danger" onclick="signOut()"><span class="user-menu-icon" data-icon="logout">🚪</span> Sign Out</button>
  `;
}

// ── Settings modal (theme + future prefs) ─────────────────────────
function openSettings() {
  // Close the user menu dropdown first
  document.getElementById('user-menu')?.classList.remove('open');
  // Tear down any prior instance
  document.getElementById('settings-modal')?.remove();

  const currentTheme = (window.__getTheme && window.__getTheme()) || 'classic';
  const wrap = document.createElement('div');
  wrap.id = 'settings-modal';
  wrap.className = 'settings-backdrop open';
  wrap.innerHTML = `
    <div class="settings-card" onclick="event.stopPropagation()">
      <div class="settings-head">
        <h2>Settings</h2>
        <button class="settings-close" onclick="closeSettings()" title="Close">✕</button>
      </div>
      <div class="settings-body">
        <div class="settings-section">
          <div class="settings-section-label">Appearance</div>
          <div class="settings-row">
            <div class="settings-row-text">
              <div class="settings-row-title">Theme</div>
              <div class="settings-row-sub">Refined Light theme or a Palantir-style Dark mode.</div>
            </div>
            <div class="settings-segmented" role="group">
              <button type="button" class="settings-seg-btn ${currentTheme==='premium' ? 'active' : ''}" data-theme="premium" onclick="pickTheme('premium')">Light</button>
              <button type="button" class="settings-seg-btn ${currentTheme==='dark'    ? 'active' : ''}" data-theme="dark"    onclick="pickTheme('dark')">Dark</button>
            </div>
          </div>
        </div>
        <div class="settings-section">
          <div class="settings-section-label">Account</div>
          <div class="settings-row settings-row-link" onclick="closeSettings(); openEditProfile();">
            <div class="settings-row-text">
              <div class="settings-row-title">Edit profile</div>
              <div class="settings-row-sub">Change your name, email, and avatar.</div>
            </div>
            <span class="settings-row-chev">›</span>
          </div>
          <div class="settings-row settings-row-link" onclick="closeSettings(); openChangePassword();">
            <div class="settings-row-text">
              <div class="settings-row-title">Change password</div>
              <div class="settings-row-sub">Update the password used to sign in.</div>
            </div>
            <span class="settings-row-chev">›</span>
          </div>
        </div>
      </div>
    </div>
  `;
  wrap.addEventListener('click', (e) => { if (e.target === wrap) closeSettings(); });
  document.body.appendChild(wrap);
}
function closeSettings() {
  document.getElementById('settings-modal')?.remove();
}
// pickTheme is the settings-modal entry point. theme.js owns the
// actual class-toggling / CSS-loading via window.setTheme; this just
// forwards and keeps the segmented control's active state in sync.
function pickTheme(which) {
  if (typeof window.setTheme === 'function') {
    window.setTheme(which);
  } else if (typeof window.toggleTheme === 'function' && which !== 'classic') {
    // Fallback for older theme.js — best-effort
    window.toggleTheme();
  }
  document.querySelectorAll('#settings-modal .settings-seg-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.theme === which);
  });
}
// Close on Escape
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.getElementById('settings-modal')) closeSettings();
});

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

// ── Static navigation page list for universal search ─────────
// Shown as a "Go to" section at the top of results when the query
// matches a page label, description, or keywords.
const NAV_PAGES = [
  { label: 'Dashboard',    description: 'Home · Overview',              href: '/dashboard.html',              keywords: 'home overview summary' },
  { label: 'Database',     description: 'Workspace · All properties',   href: '/database.html',               keywords: 'properties list all kanban' },
  { label: 'Activity',     description: 'Workspace · Recent activity',  href: '/activity.html',               keywords: 'log history feed recent' },
  { label: 'FieldCam',     description: 'Tools · Site photography',     href: '/fieldcam.html',               keywords: 'camera photos field photos upload pictures' },
  { label: 'Inbox',        description: 'Tools · Email',                app: 'inbox',                         keywords: 'email messages mail compose' },
  { label: 'Pulse',        description: 'Tools · Team messaging',       app: 'pulse',                         keywords: 'chat messages team slack messaging' },
  { label: 'Work Orders',  description: 'Tools · Maintenance',          app: 'maintenance',                   keywords: 'maintenance repair tasks work orders' },
  { label: 'Underwriting', description: 'Tools · Deal analysis',        href: '/underwriting.html',           keywords: 'analysis deals numbers finance underwrite model' },
  { label: 'Acquisitions', description: 'Pipeline · Active deals',      href: '/acquisitions.html',           keywords: 'pipeline buying purchase deals acquire' },
  { label: 'Prospects',    description: 'Pipeline · Potential deals',   href: '/acquisitions.html',           keywords: 'prospect potential lead opportunity' },
  { label: 'Holdings',     description: 'Pipeline · Owned properties',  href: '/holdings.html',               keywords: 'hold own rent renting lease' },
  { label: 'Dispositions', description: 'Pipeline · Selling',           href: '/dispositions.html',           keywords: 'sell selling sale listing under contract' },
  { label: 'Sold',         description: 'Pipeline · Closed deals',      href: '/closed.html',                 keywords: 'sold closed done complete' },
  { label: 'Contacts',     description: 'People · Address book',        href: '/contacts.html',               keywords: 'contacts people address book agents vendors' },
  { label: 'Team',         description: 'People · Teammates',           href: '/team.html',                   keywords: 'team people users staff members invite' },
];

const NAV_PAGE_ICONS = {
  dashboard:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>',
  database:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>',
  activity:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>',
  fieldcam:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>',
  inbox:        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>',
  pulse:        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
  workorders:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>',
  underwriting: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>',
  acquisitions: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/></svg>',
  default:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>',
};

function _navPageIcon(page) {
  const key = page.label.toLowerCase().replace(/\s+/g, '');
  return NAV_PAGE_ICONS[key] || NAV_PAGE_ICONS.default;
}

// ── Inline SVG icon chips for search result rows ──────────────────
// Replaces emoji glyphs so icons are theme-consistent and never glitch
// between OS emoji renders and UI icons.
function _srIcon(svg, bg, color) {
  return `<span class="search-result-nav-icon" style="background:${bg};color:${color};">${svg}</span>`;
}
const _SVG_HOME     = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>';
const _SVG_USER     = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>';
const _SVG_CONTACTS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>';
const _SVG_SEARCH   = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>';
const SR_ICON_PROP     = _srIcon(_SVG_HOME,     'rgba(97,183,70,0.10)',   'var(--brand-dark,#15803d)');
const SR_ICON_USER     = _srIcon(_SVG_USER,     'rgba(99,102,241,0.10)',  '#4f46e5');
const SR_ICON_CONTACT  = _srIcon(_SVG_CONTACTS, 'rgba(147,51,234,0.10)', '#9333ea');
const SR_ICON_SEARCH   = _srIcon(_SVG_SEARCH,   'rgba(15,23,42,0.06)',   'var(--text-muted)');

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

  // ── Pages / navigation matches (shown first, above data results) ──
  const matchedPages = NAV_PAGES.filter(pg => {
    const hay = `${pg.label} ${pg.description} ${pg.keywords || ''}`.toLowerCase();
    return hay.includes(q2);
  }).slice(0, 4);

  let html = '';
  if (matchedPages.length) {
    html += '<div class="search-section"><div class="search-section-header">Go to</div>';
    html += matchedPages.map(pg => {
      const icon = _navPageIcon(pg);
      const attrs = pg.app
        ? `data-app="${escHtml(pg.app)}" data-app-path="/" href="#"`
        : `href="${escHtml(pg.href)}"`;
      return `<a class="search-result" ${attrs}>
        <span class="search-result-nav-icon">${icon}</span>
        <div class="search-result-body">
          <div class="search-result-title">${escHtml(pg.label)}</div>
          <div class="search-result-subtitle">${escHtml(pg.description)}</div>
        </div>
        <span class="search-result-nav-arrow">→</span>
      </a>`;
    }).join('');
    html += '</div>';
  }

  if (props.length) {
    html += '<div class="search-section"><div class="search-section-header">Properties</div>';
    html += props.map(p => `
      <a class="search-result" href="/property.html?id=${p.id}">
        ${SR_ICON_PROP}
        <div class="search-result-body">
          <div class="search-result-title">${escHtml(p.display_name || p.address_line1)}${p.unit ? ' #' + escHtml(p.unit) : ''}</div>
          <div class="search-result-subtitle">${escHtml([p.city, p.state, p.zip].filter(Boolean).join(', '))}</div>
        </div>
        <span class="search-result-nav-arrow">→</span>
      </a>
    `).join('');
    html += '</div>';
  }
  if (users.length) {
    html += '<div class="search-section"><div class="search-section-header">Team</div>';
    html += users.map(u => `
      <a class="search-result" href="/team.html">
        ${SR_ICON_USER}
        <div class="search-result-body">
          <div class="search-result-title">${escHtml(u.full_name || u.email)}${u.is_owner ? ' · Owner' : ''}</div>
          <div class="search-result-subtitle">${escHtml(u.email || '')}</div>
        </div>
        <span class="search-result-nav-arrow">→</span>
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
          ${SR_ICON_CONTACT}
          <div class="search-result-body">
            <div class="search-result-title">${escHtml(c.full_name)}</div>
            <div class="search-result-subtitle">${escHtml(sub)}</div>
          </div>
          <span class="search-result-nav-arrow">→</span>
        </a>
      `;
    }).join('');
    html += '</div>';
  }
  if (!matchedPages.length && !props.length && !users.length && !contacts.length) {
    html = '<div class="search-empty">No matches.</div>';
  } else if (props.length || users.length || contacts.length) {
    html += '<div class="search-section" style="border-top:1px solid var(--border);">' +
      `<a class="search-result" href="/properties.html?q=${encodeURIComponent(q2)}">` +
        SR_ICON_SEARCH +
        '<div class="search-result-body">' +
          `<div class="search-result-title">See all results for "${escHtml(q2)}"</div>` +
        '</div>' +
        '<span class="search-result-nav-arrow">→</span>' +
      '</a></div>';
  }
  resultsEl.innerHTML = html;
  resultsEl.classList.add('open');
  // Wire satellite data-app links that landed in search results
  if (typeof wireUnifiedNav === 'function') setTimeout(wireUnifiedNav, 0);
  else if (typeof window.__wireChromeNav === 'function') setTimeout(window.__wireChromeNav, 0);
}

function onSearchKey(e) {
  if (e.key === 'Escape') {
    document.getElementById('search-results')?.classList.remove('open');
    e.target.blur();
    return;
  }
  // Belt-and-suspenders Enter handler. The form's onsubmit handles Enter
  // in normal browsers, but if something prevents the form submit (an
  // outer form swallows it, etc.) we still navigate here.
  if (e.key === 'Enter') {
    e.preventDefault();
    const q = e.target.value.trim();
    window.location.href = '/properties.html' + (q ? '?q=' + encodeURIComponent(q) : '');
  }
}

function closeSearchOnOutsideClick(e) {
  const results = document.getElementById('search-results');
  const search  = document.getElementById('top-search');
  if (!results || !results.classList.contains('open')) return;
  if (results.contains(e.target) || (search && search.contains(e.target))) return;
  results.classList.remove('open');
}

// ── Edit Profile modal ─────────────────────────────────────────
async function openEditProfile() {
  document.getElementById('user-menu')?.classList.remove('open');
  const u = getCachedUser() || {};
  let modal = document.getElementById('edit-profile-modal');
  if (modal) modal.remove();
  modal = document.createElement('div');
  modal.id = 'edit-profile-modal';
  modal.className = 'modal-backdrop';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:1000;display:flex;align-items:center;justify-content:center;padding:20px;';
  modal.innerHTML = `
    <div style="background:#fff;border-radius:14px;max-width:420px;width:100%;padding:20px;">
      <div class="section-header"><span class="section-title">Edit Profile</span>
        <button class="icon-btn" style="background:#eee;color:#000;" onclick="document.getElementById('edit-profile-modal').remove()">×</button>
      </div>
      <div style="display:flex;flex-direction:column;align-items:center;gap:10px;margin:6px 0 16px;">
        <div class="user-avatar-big" id="ep-preview" style="width:88px;height:88px;font-size:2rem;">${avatarContent(u, 'avatar-img--xl')}</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:center;">
          <label class="btn btn-secondary" style="cursor:pointer;padding:8px 14px;font-size:.85rem;">
            📷 Upload Photo
            <input type="file" id="ep-avatar-input" accept="image/*" style="display:none;" onchange="uploadAvatarFile(event)">
          </label>
          ${u.avatar_url ? `<button type="button" class="btn btn-secondary" style="padding:8px 14px;font-size:.85rem;" onclick="removeAvatar()">Remove</button>` : ''}
        </div>
        <p id="ep-avatar-err" class="text-sm" style="color:var(--danger);display:none;"></p>
      </div>
      <form id="ep-form">
        <div class="form-group">
          <label class="form-label">Full name</label>
          <input class="form-input" type="text" id="ep-name" required maxlength="200" value="${escHtml(u.full_name || '')}">
        </div>
        <div class="form-group">
          <label class="form-label">Email</label>
          <input class="form-input" type="email" id="ep-email" value="${escHtml(u.email || '')}" disabled style="background:#f5f5f5;">
          <p class="text-xs text-muted" style="margin-top:4px;">Email changes aren't supported yet — contact an owner if needed.</p>
        </div>
        <div class="form-group">
          <label class="form-label">Sign-in methods</label>
          <div id="ep-google-row" style="padding:10px 12px;border:1px solid #e5e7eb;border-radius:8px;">
            ${renderGoogleLinkRow(u)}
          </div>
          <p id="ep-google-err" class="text-xs" style="color:var(--danger);display:none;margin-top:4px;"></p>
        </div>
        <p id="ep-err" class="text-sm mb-8" style="color:var(--danger);display:none;"></p>
        <button class="btn btn-primary btn-full" type="submit" id="ep-btn">Save</button>
      </form>
    </div>`;
  document.body.appendChild(modal);
  document.getElementById('ep-form').addEventListener('submit', submitEditProfile);
  initEditProfileGoogleLink();
}

// ── Google account linking (inside Edit Profile) ───────────────
function renderGoogleLinkRow(u) {
  if (u.google_email) {
    return `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;">
        <div>
          <div style="font-size:.9rem;">🔗 Linked as <strong>${escHtml(u.google_email)}</strong></div>
          <div class="text-xs text-muted">You can sign in with this Google account.</div>
        </div>
        <button type="button" class="btn btn-secondary" style="padding:6px 12px;font-size:.8rem;" onclick="unlinkGoogle()">Unlink</button>
      </div>`;
  }
  return `
    <div>
      <div style="font-size:.85rem;margin-bottom:8px;">Sign in with your Google Workspace account in addition to your password.</div>
      <div id="ep-google-btn"></div>
    </div>`;
}

function refreshGoogleLinkRow() {
  const row = document.getElementById('ep-google-row');
  if (!row) return;
  row.innerHTML = renderGoogleLinkRow(getCachedUser() || {});
  initEditProfileGoogleLink();
}

async function initEditProfileGoogleLink() {
  const placeholder = document.getElementById('ep-google-btn');
  if (!placeholder) return; // already linked → nothing to render
  try {
    const cfg = window.__epGoogleCfg || (window.__epGoogleCfg = await fetch('/api/config').then(r => r.json()));
    if (!cfg.googleClientId) {
      placeholder.innerHTML = '<p class="text-xs text-muted">Google sign-in isn\'t configured yet.</p>';
      return;
    }
    await ensureGoogleIdentityLoaded();
    google.accounts.id.initialize({
      client_id: cfg.googleClientId,
      callback: handleGoogleLinkCredential,
      auto_select: false,
      ux_mode: 'popup'
    });
    google.accounts.id.renderButton(placeholder, {
      theme: 'outline', size: 'large', text: 'continue_with',
      shape: 'rectangular', logo_alignment: 'left', width: 280
    });
  } catch (e) {
    console.error('Google link init failed:', e);
  }
}

function ensureGoogleIdentityLoaded() {
  return new Promise((resolve, reject) => {
    if (typeof google !== 'undefined' && google.accounts) return resolve();
    let script = document.getElementById('gsi-script');
    if (!script) {
      script = document.createElement('script');
      script.id = 'gsi-script';
      script.src = 'https://accounts.google.com/gsi/client';
      script.async = true; script.defer = true;
      document.head.appendChild(script);
    }
    let attempts = 0;
    const handle = setInterval(() => {
      if (typeof google !== 'undefined' && google.accounts) {
        clearInterval(handle); resolve();
      } else if (++attempts > 25) {
        clearInterval(handle); reject(new Error('Failed to load Google Identity Services'));
      }
    }, 200);
  });
}

async function handleGoogleLinkCredential(response) {
  const err = document.getElementById('ep-google-err');
  err.style.display = 'none';
  try {
    // Use raw fetch (not apiFetch) so a 401 from the verify step doesn't
    // log the user out — they're already authenticated for the link call.
    const res = await fetch('/api/auth/google/link', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${getToken()}`
      },
      body: JSON.stringify({ credential: response.credential })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    setCachedUser(data.user);
    refreshGoogleLinkRow();
    renderTopHeader(); renderUserMenu();
    showToast('Google account linked');
  } catch (e) {
    err.textContent = e.message; err.style.display = 'block';
  }
}

async function unlinkGoogle() {
  if (!confirm('Unlink your Google account? You\'ll only be able to sign in with your password after this.')) return;
  const err = document.getElementById('ep-google-err');
  err.style.display = 'none';
  try {
    const { user } = await apiFetch('/api/auth/google/link', { method: 'DELETE' });
    setCachedUser(user);
    refreshGoogleLinkRow();
    renderTopHeader(); renderUserMenu();
    showToast('Google account unlinked');
  } catch (e) {
    err.textContent = e.message; err.style.display = 'block';
  }
}

async function submitEditProfile(e) {
  e.preventDefault();
  const btn = document.getElementById('ep-btn');
  const err = document.getElementById('ep-err');
  err.style.display = 'none';
  const fullName = document.getElementById('ep-name').value.trim();
  if (!fullName) { err.textContent = 'Name is required'; err.style.display = 'block'; return; }
  showSpinner(btn, 'Saving…');
  try {
    const updated = await apiFetch('/api/auth/me', {
      method: 'PATCH',
      body: JSON.stringify({ full_name: fullName })
    });
    setCachedUser(updated);
    document.getElementById('edit-profile-modal')?.remove();
    renderTopHeader(); renderUserMenu();
    showToast('Profile saved');
  } catch (e2) {
    err.textContent = e2.message; err.style.display = 'block';
    hideSpinner(btn);
  }
}

async function uploadAvatarFile(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  const err = document.getElementById('ep-avatar-err');
  err.style.display = 'none';
  // Optimistic local preview while we upload.
  const preview = document.getElementById('ep-preview');
  const tmpUrl = URL.createObjectURL(file);
  preview.innerHTML = `<img class="avatar-img avatar-img--xl" src="${tmpUrl}" alt="">`;
  try {
    const fd = new FormData();
    fd.append('avatar', file);
    const updated = await apiFetch('/api/auth/me/avatar', { method: 'POST', body: fd });
    setCachedUser(updated);
    preview.innerHTML = avatarContent(updated, 'avatar-img--xl');
    renderTopHeader(); renderUserMenu();
    showToast('Photo updated');
    // Re-open to show the "Remove" button now that avatar exists.
    openEditProfile();
  } catch (e2) {
    err.textContent = e2.message; err.style.display = 'block';
    // Revert preview
    const u = getCachedUser() || {};
    preview.innerHTML = avatarContent(u, 'avatar-img--xl');
  } finally {
    URL.revokeObjectURL(tmpUrl);
    e.target.value = '';
  }
}

async function removeAvatar() {
  if (!confirm('Remove your profile photo?')) return;
  try {
    const updated = await apiFetch('/api/auth/me/avatar', { method: 'DELETE' });
    setCachedUser(updated);
    document.getElementById('edit-profile-modal')?.remove();
    renderTopHeader(); renderUserMenu();
    showToast('Photo removed');
  } catch (e) { showToast(e.message, 'error'); }
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
      if (window.__newChromeEnabled && window.__newChromeEnabled()) {
        // New chrome handles user-menu rendering via topbar.js; only render the menu body here.
        renderUserMenu();
        return;
      }
      renderTopHeader(); renderAppsRail(); renderUserMenu();
    });
  } else {
    if (window.__newChromeEnabled && window.__newChromeEnabled()) {
      renderUserMenu();
    } else {
      renderTopHeader(); renderAppsRail(); renderUserMenu();
    }
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
  ['prospect',             'Prospect',           '#475569', '#e2e8f0'],   // slate  → Potential future purchases
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

// ── View-mode toggle (Kanban | Table) ──────────────────────────────────
// Drop into the section header on any lifecycle page. Persists the user's
// choice per-page in localStorage so it stays consistent across reloads.
function getViewMode(storageKey, fallback = 'kanban') {
  try {
    const v = localStorage.getItem(storageKey);
    return v === 'table' || v === 'kanban' ? v : fallback;
  } catch { return fallback; }
}

function renderViewToggle(container, { storageKey, onChange }) {
  const current = getViewMode(storageKey);
  container.innerHTML = `
    <div class="view-toggle" role="tablist" aria-label="View mode">
      <button type="button" data-mode="kanban" class="${current === 'kanban' ? 'active' : ''}" role="tab">Kanban</button>
      <button type="button" data-mode="table"  class="${current === 'table'  ? 'active' : ''}" role="tab">Table</button>
    </div>
  `;
  container.querySelectorAll('.view-toggle button').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      try { localStorage.setItem(storageKey, mode); } catch {}
      container.querySelectorAll('.view-toggle button').forEach(b => b.classList.toggle('active', b === btn));
      if (typeof onChange === 'function') onChange(mode);
    });
  });
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
