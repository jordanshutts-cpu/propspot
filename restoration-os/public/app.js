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

// ── Holdings Desk ──────────────────────────────────────────────────────
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
  ['purchasing', 'Purchasing', '#92400e', '#fef3c7'],   // amber
  ['renovating', 'Renovating', '#1e40af', '#dbeafe'],   // blue
  ['selling',    'Selling',    '#6b21a8', '#ede9fe'],   // violet
  ['renting',    'Renting',    '#075985', '#e0f2fe'],   // sky
  ['rented',     'Rented',     '#15803d', '#dcfce7'],   // green
  ['dropped',    'Dropped',    '#6b7280', '#f3f4f6']    // gray
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
