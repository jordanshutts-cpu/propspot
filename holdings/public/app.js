// ============================================================
//  Holdings Desk — Shared Frontend Utilities
//  Same SSO pattern as FieldCam: consume ?token= from URL, store
//  in localStorage, then read it on every API call.
// ============================================================

const TOKEN_KEY = 'holdings_token';
const USER_KEY  = 'holdings_user';

// SSO handoff
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
async function getProperties()        { return apiFetch('/api/properties'); }
async function getProperty(id)        { return apiFetch(`/api/properties/${id}`); }

async function getHoldings(params = {}) {
  const qs = new URLSearchParams(params).toString();
  return apiFetch(`/api/holdings${qs ? '?' + qs : ''}`);
}
async function getHolding(id)         { return apiFetch(`/api/holdings/${id}`); }
async function createHolding(body)    { return apiFetch('/api/holdings', { method: 'POST', body: JSON.stringify(body) }); }
async function updateHolding(id, body){ return apiFetch(`/api/holdings/${id}`, { method: 'PATCH', body: JSON.stringify(body) }); }
async function deleteHolding(id)      { return apiFetch(`/api/holdings/${id}`, { method: 'DELETE' }); }

async function recordPayment(body)    { return apiFetch('/api/payments', { method: 'POST', body: JSON.stringify(body) }); }
async function deletePayment(id)      { return apiFetch(`/api/payments/${id}`, { method: 'DELETE' }); }

// ── UI helpers ────────────────────────────────────────────────
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

function propertyAddress(p) {
  if (!p) return '';
  const line1 = [p.address_line1, p.unit].filter(Boolean).join(' ');
  return `${line1}, ${p.city || ''} ${p.state || ''} ${p.zip || ''}`.trim();
}

function propertyDisplay(p) {
  return p?.display_name || p?.address_line1 || 'Property';
}

const HOLDING_KINDS = [
  ['utility',   'Utility',   '⚡'],
  ['insurance', 'Insurance', '🛡️'],
  ['tax',       'Tax',       '🏛️'],
  ['mortgage',  'Mortgage',  '🏦'],
  ['license',   'License',   '📜'],
  ['hoa',       'HOA',       '🏘️']
];
function kindLabel(k){ return (HOLDING_KINDS.find(x => x[0]===k) || [k,k])[1]; }
function kindIcon(k){ return (HOLDING_KINDS.find(x => x[0]===k) || [k,k,'💼'])[2]; }

const CADENCES = [
  ['monthly',    'Monthly'],
  ['quarterly',  'Quarterly'],
  ['semiannual', 'Every 6 months'],
  ['annual',     'Annual'],
  ['one_time',   'One-time']
];
function cadenceLabel(c){ return (CADENCES.find(x => x[0]===c) || [c,c])[1]; }

function dueStatus(d) {
  if (!d) return { label: 'No due date', cls: '' };
  const today = new Date(); today.setHours(0,0,0,0);
  const due = new Date(d);
  const diff = Math.round((due - today) / (1000*60*60*24));
  if (diff < 0)   return { label: `${Math.abs(diff)}d overdue`, cls: 'badge-red' };
  if (diff === 0) return { label: 'Due today',                 cls: 'badge-red' };
  if (diff <= 14) return { label: `In ${diff}d`,                cls: 'badge-amber' };
  return                { label: `In ${diff}d`,                cls: 'badge-green' };
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
