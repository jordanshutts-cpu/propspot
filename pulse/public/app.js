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
