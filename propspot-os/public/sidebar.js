// ============================================================
//  Prop Spot — New Chrome Sidebar (Phase 2)
//  Gated by ?newchrome=1 URL param OR localStorage.propspot_newchrome.
//  Renders the 260px hybrid sidebar into the existing #apps-rail
//  placeholder. Phase 2 adds:
//    • Live badge counts via /api/sidebar-counts
//    • Persistent pinning via /api/pinned (+ pin-a-property dialog)
//    • Real recent list via /api/recent
//    • Scope mode — clicking a pinned/recent property filters
//      Photos/Work Orders/Pulse/Inbox to that property
// ============================================================

(function () {
  if (!window.__newChromeEnabled || !window.__newChromeEnabled()) return;

  // ── OS URL — used for cross-origin satellite loads (FieldCam etc.)
  // On propspot-os itself, OS_URL is just location.origin (same-origin).
  // On a satellite, OS_URL points at os.propspot.io so chrome-only
  // endpoints (sidebar-counts, pinned, recent) hit OS directly.
  // Override via window.__PROPSPOT_OS_URL for local dev.
  const OS_URL = window.__PROPSPOT_OS_URL ||
    (location.hostname.startsWith('os.') || location.hostname === 'localhost'
      ? location.origin
      : 'https://os.propspot.io');
  const IS_SATELLITE = OS_URL !== location.origin;

  // ── Cross-origin OS fetch — sends the local app's auth token
  // as Bearer (every satellite stores the same OS JWT, just under a
  // different localStorage key like fieldcam_token / inbox_token).
  async function osFetch(path) {
    const token = (typeof getToken === 'function') ? getToken() : null;
    const headers = {};
    if (token) headers.Authorization = 'Bearer ' + token;
    const res = await fetch(OS_URL + path, { headers, credentials: 'omit' });
    if (!res.ok) throw new Error('OS fetch ' + path + ' → ' + res.status);
    return res.json();
  }

  // ── Inject chrome.css if missing (satellites won't have it loaded)
  function ensureChromeStylesheet() {
    if (document.querySelector('link[data-propspot-chrome]')) return;
    const link = document.createElement('link');
    link.rel  = 'stylesheet';
    link.href = OS_URL + '/chrome.css';
    link.dataset.propspotChrome = '1';
    document.head.appendChild(link);
  }

  // ── Inject theme.js on satellite apps so premium theme works cross-origin
  function ensureThemeScript() {
    if (document.getElementById('propspot-theme-js')) return;
    // Apply theme class immediately to prevent FOUC on satellites
    try {
      if (localStorage.getItem('propspot_theme') === 'premium') {
        document.documentElement.classList.add('theme-premium');
        if (!document.getElementById('premium-css-link')) {
          const link = document.createElement('link');
          link.id   = 'premium-css-link';
          link.rel  = 'stylesheet';
          link.href = OS_URL + '/premium.css';
          document.head.appendChild(link);
        }
      }
    } catch (e) {}
    const s = document.createElement('script');
    s.id  = 'propspot-theme-js';
    s.src = OS_URL + '/theme.js';
    s.async = false;
    document.head.appendChild(s);
  }

  // ── Wire data-app + data-osnav links to real URLs ───────────────
  // On OS this is wireUnifiedNav() from app.js. On satellites, app.js
  // doesn't define that helper, so the chrome carries its own copy and
  // fetches the URL map from OS via osFetch so navigation lines up
  // regardless of which satellite the user is on.
  let _navCfgCache = null;
  async function _loadNavConfigChrome() {
    if (_navCfgCache) return _navCfgCache;
    try { _navCfgCache = await (IS_SATELLITE ? osFetch('/api/config') : apiFetch('/api/config')); }
    catch (e) { _navCfgCache = {}; }
    return _navCfgCache;
  }
  function _appendToken(url) {
    const token = (typeof getToken === 'function') ? getToken() : null;
    if (!token) return url;
    const sep = url.includes('?') ? '&' : '?';
    return url + sep + 'token=' + encodeURIComponent(token);
  }
  function _isCurrentOrigin(url) {
    try { return new URL(url).origin === location.origin; }
    catch (e) { return false; }
  }
  async function wireChromeNav() {
    const cfg = await _loadNavConfigChrome();
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

    document.querySelectorAll('[data-app]').forEach(a => {
      const slug = a.dataset.app;
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
    const osBase = cfg.osUrl || OS_URL;
    document.querySelectorAll('[data-osnav]').forEach(a => {
      const page = a.dataset.osnav;
      const path = (page === 'dashboard' || page === '') ? '/dashboard.html' : '/' + page + '.html';
      // Honor explicit href when set (some Pipeline items point to specific pages)
      const explicit = a.getAttribute('href');
      const target   = (explicit && explicit !== '#') ? explicit : path;
      if (!osBase || _isCurrentOrigin(osBase)) {
        a.href = target;
      } else {
        a.href = _appendToken(osBase.replace(/\/$/, '') + target);
      }
    });
  }

  // ── Inject required DOM placeholders if a host page doesn't have them
  function ensurePlaceholders() {
    if (!document.getElementById('apps-rail')) {
      const aside = document.createElement('aside');
      aside.className = 'apps-rail';
      aside.id = 'apps-rail';
      document.body.insertBefore(aside, document.body.firstChild);
    }
    if (!document.getElementById('top-header')) {
      const header = document.createElement('header');
      header.className = 'top-header';
      header.id = 'top-header';
      document.body.insertBefore(header, document.body.firstChild);
    }
    if (!document.getElementById('user-menu')) {
      const div = document.createElement('div');
      div.id = 'user-menu';
      div.className = 'user-menu';
      document.body.appendChild(div);
    }
  }

  // ── Status dot colors (mirrors PROPERTY_STATUSES in app.js) ──────
  const STATUS_DOT = {
    prospect:             '#94a3b8',
    purchasing:           '#f59e0b',
    renovating:           '#2563eb',
    renting:              '#0284c7',
    rented:               '#16a34a',
    listed_for_rent:      '#0284c7',
    selling:              '#a855f7',
    listed_for_sale:      '#9333ea',
    under_contract_buyer: '#db2777',
    sold:                 '#475569',
    assigned:             '#334155',
    dropped:              '#9ca3af'
  };

  // Apps that understand a ?property_id= filter — those get hrefs
  // rewritten by setScope(). Pipeline pages stay unscoped.
  const SCOPABLE_APPS = ['fieldcam', 'maintenance', 'pulse', 'inbox'];

  // ── Section/row builders ────────────────────────────────────────
  function sectionLabel(text, opts = {}) {
    var slug = text.toLowerCase().replace(/\s+/g, '-');
    const editBtn = opts.editable
      ? `<button type="button" class="os-newchrome-section-edit" title="Customize ${escHtml(text)}" aria-label="Customize ${escHtml(text)}"
              onclick="window.__openForYouCustomize && window.__openForYouCustomize()">
           <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="13" height="13"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4Z"/></svg>
         </button>`
      : '';
    return `<div class="os-newchrome-section-label" data-section="${slug}"><span class="os-newchrome-section-label-text">${text}</span>${editBtn}</div>`;
  }

  // ── "For you" customization ─────────────────────────────────────
  // Catalog of items the user can show/hide in the For You section.
  // Order in this array is the rendered order. Visibility persists via
  // localStorage under 'propspot_foryou_visible'.
  // Note: ICONS is referenced lazily through a getter so it's available
  // even though declared further down in this file.
  function _icon(key) { return ICONS[key]; }
  const FOR_YOU_CATALOG = [
    { id: 'inbox',     iconKey: 'inbox',     label: 'Inbox',       app: 'inbox',       default: true,  badgeKey: 'inbox' },
    { id: 'mentions',  iconKey: 'at',        label: 'Mentions',    osnav: 'mentions',  href: '/mentions.html', default: true, badgeKey: 'mentions' },
    { id: 'tasks',     iconKey: 'check',     label: 'My Tasks',    osnav: 'tasks',     href: '/tasks.html', default: true, badgeKey: 'myTasks' },
    { id: 'pulse',     iconKey: 'pulse',     label: 'Pulse',       app: 'pulse',       default: false, badgeKey: 'pulse' },
    { id: 'fieldcam',  iconKey: 'camera',    label: 'FieldCam',    app: 'fieldcam',    default: false, badgeKey: 'photosToday', badgeClass: 'muted' },
    { id: 'workorders',iconKey: 'wrench',    label: 'Maintenance', app: 'maintenance', default: false, badgeKey: 'workOrders',  badgeClass: 'warn' },
    { id: 'activity',  iconKey: 'activity',  label: 'Activity',    osnav: 'activity',  href: '/activity.html', default: false },
  ];

  function getForYouVisible() {
    try {
      const raw = localStorage.getItem('propspot_foryou_visible');
      if (raw) return JSON.parse(raw);
    } catch (e) {}
    return FOR_YOU_CATALOG.filter(it => it.default).map(it => it.id);
  }

  function setForYouVisible(ids) {
    try { localStorage.setItem('propspot_foryou_visible', JSON.stringify(ids)); } catch (e) {}
  }

  // Build the For You rows from catalog + saved visibility.
  function renderForYouRows(counts) {
    const visible = new Set(getForYouVisible());
    return FOR_YOU_CATALOG
      .filter(it => visible.has(it.id))
      .map(it => row({
        icon: ICONS[it.iconKey] || '',
        label: it.label,
        app: it.app,
        osnav: it.osnav,
        href: it.href,
        soon: it.soon,
        badge: it.badgeKey ? counts[it.badgeKey] : undefined,
        badgeClass: it.badgeClass || '',
        section: 'for-you'
      }))
      .join('');
  }

  // Open the customize modal — checkbox list of catalog items.
  window.__openForYouCustomize = function () {
    const visible = new Set(getForYouVisible());
    const existing = document.getElementById('foryou-customize-modal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'foryou-customize-modal';
    modal.className = 'foryou-modal-backdrop';
    modal.innerHTML = `
      <div class="foryou-modal">
        <div class="foryou-modal-header">
          <div class="foryou-modal-title">Customize “For you”</div>
          <button class="foryou-modal-close" aria-label="Close">×</button>
        </div>
        <div class="foryou-modal-body">
          <div class="foryou-modal-hint">Pick what shows in your For You section.</div>
          ${FOR_YOU_CATALOG.map(it => `
            <label class="foryou-modal-row">
              <input type="checkbox" data-id="${it.id}" ${visible.has(it.id) ? 'checked' : ''}/>
              <span class="foryou-modal-icon">${ICONS[it.iconKey] || ''}</span>
              <span class="foryou-modal-label">${escHtml(it.label)}</span>
              ${it.soon ? '<span class="foryou-modal-soon">soon</span>' : ''}
            </label>
          `).join('')}
        </div>
        <div class="foryou-modal-footer">
          <button class="foryou-modal-cancel">Cancel</button>
          <button class="foryou-modal-save">Save</button>
        </div>
      </div>`;
    document.body.appendChild(modal);

    const close = () => modal.remove();
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
    modal.querySelector('.foryou-modal-close').addEventListener('click', close);
    modal.querySelector('.foryou-modal-cancel').addEventListener('click', close);
    modal.querySelector('.foryou-modal-save').addEventListener('click', () => {
      const checked = Array.from(modal.querySelectorAll('input[type=checkbox]'))
        .filter(cb => cb.checked).map(cb => cb.dataset.id);
      // Preserve catalog order
      const ordered = FOR_YOU_CATALOG.map(it => it.id).filter(id => checked.includes(id));
      setForYouVisible(ordered);
      close();
      // Re-render the sidebar
      if (typeof window.__rerenderSidebar === 'function') window.__rerenderSidebar();
      else location.reload();
    });
  };

  // ── Coordinated SVG icon library — all use currentColor so they inherit
  // their section's accent. Lucide-style line icons, viewBox 24x24.
  const _svg = (path, opts = '') =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"${opts ? ' ' + opts : ''}>${path}</svg>`;
  const ICONS = {
    // For you
    inbox:        _svg('<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>'),
    at:           _svg('<circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-3.92 7.94"/>'),
    check:        _svg('<polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>'),
    pulse:        _svg('<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>'),
    camera:       _svg('<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>'),
    wrench:       _svg('<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>'),
    folder:       _svg('<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>'),
    activity:     _svg('<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>'),
    // Pipeline
    target:       _svg('<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>'),
    phone:        _svg('<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>'),
    users:        _svg('<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>'),
    clipboard:    _svg('<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/>'),
    hammer:       _svg('<path d="M15 12 L9 18 L3 21 L4 18 L9 12 L15 12 z"/><path d="M14 11 L11 14"/><path d="M15 12 L21 6 L18 3 L12 9"/>'),
    briefcase:    _svg('<rect x="2" y="7" width="20" height="14" rx="2" ry="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>'),
    trendingUp:   _svg('<polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/>'),
    package:      _svg('<line x1="16.5" y1="9.4" x2="7.5" y2="4.21"/><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>'),
    xCircle:      _svg('<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>'),
    bookmark:     _svg('<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>'),
    // Workspace
    database:     _svg('<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>'),
    // Tools
    barChart:     _svg('<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>'),
    // Soon
    globe:        _svg('<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>'),
    home:         _svg('<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>'),
    dollar:       _svg('<line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>'),
    receipt:      _svg('<path d="M4 2v20l3-2 3 2 3-2 3 2 3-2 1 2V2"/><path d="M8 7h8"/><path d="M8 11h8"/><path d="M8 15h5"/>'),
    refresh:      _svg('<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>'),
  };

  function row({ icon, label, href = '#', osnav, app, appPath, badge, badgeClass = '', soon = false, section = '' }) {
    const dataAttr = osnav ? `data-osnav="${osnav}"` :
                     app   ? `data-app="${app}" data-app-path="${appPath || '/'}"` : '';
    const badgeHtml = soon
      ? `<span class="os-newchrome-row-soon-pill">soon</span>`
      : (badge !== undefined && badge !== null && badge !== '' && badge > 0
          ? `<span class="os-newchrome-badge ${badgeClass}">${badge}</span>`
          : '');
    const klass = `os-newchrome-row${soon ? ' soon' : ''}`;
    const sectionAttr = section ? ` data-section="${section}"` : '';
    // title attr surfaces the label as a tooltip — useful when the sidebar
    // is collapsed and only the icon is visible.
    return `
      <a class="${klass}" href="${href}" ${dataAttr} title="${escHtml(label)}"${sectionAttr}>
        <span class="os-newchrome-row-icon">${icon}</span>
        <span class="os-newchrome-row-label">${label}</span>
        ${badgeHtml}
      </a>`;
  }

  function propertyRow(p, kind /* 'pinned' | 'recent' */) {
    const dot = STATUS_DOT[p.status] || '#cbd5e1';
    const sub = p.acquisition_status
      ? acquisitionLabel(p.acquisition_status)
      : (typeof propertyStatusLabel === 'function' ? propertyStatusLabel(p.status) : p.status);
    const scoped = getScopedPropertyId();
    const active = scoped === p.id;
    return `
      <a class="os-newchrome-property-row${active ? ' active' : ''}"
         href="/property.html?id=${p.id}"
         data-property-id="${p.id}"
         data-property-name="${escHtml(p.display_name || p.address_line1)}"
         data-property-sub="${escHtml(sub || '')}"
         data-property-row="${kind}">
        <span class="os-newchrome-status-dot" style="background:${dot}"></span>
        <div class="os-newchrome-property-name">
          <div class="os-newchrome-property-name-line">${escHtml(p.display_name || p.address_line1)}</div>
          <div class="os-newchrome-property-sub">${escHtml(sub || '')}</div>
        </div>
      </a>`;
  }

  function acquisitionLabel(s) {
    const map = {
      under_contract: 'Under Contract',
      due_diligence: 'Due Diligence',
      assigning: 'Assigning',
      approved_to_close: 'Approved to Close'
    };
    return map[s] || s;
  }

  // ── Scope mode (sessionStorage-backed) ──────────────────────────
  function getScopedPropertyId() {
    try { return sessionStorage.getItem('propspot_scoped_property') || null; }
    catch (e) { return null; }
  }
  function getScopedPropertyMeta() {
    try {
      const raw = sessionStorage.getItem('propspot_scoped_property_meta');
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }
  function setScope(id, name, sub) {
    try {
      sessionStorage.setItem('propspot_scoped_property', id);
      sessionStorage.setItem('propspot_scoped_property_meta',
        JSON.stringify({ id, name, sub }));
    } catch (e) {}
    applyScopeToLinks();
    renderScopeChip();
    refreshActiveProperty();
  }
  function clearScope() {
    try {
      sessionStorage.removeItem('propspot_scoped_property');
      sessionStorage.removeItem('propspot_scoped_property_meta');
    } catch (e) {}
    applyScopeToLinks();
    renderScopeChip();
    refreshActiveProperty();
  }

  // Rewrite hrefs on every scopable [data-app] link so cross-app navigation
  // pre-filters to the scoped property. Pipeline links (data-osnav) stay
  // untouched — Pipeline is intentionally global.
  function applyScopeToLinks() {
    const scoped = getScopedPropertyId();
    document.querySelectorAll('[data-app]').forEach(a => {
      const app = a.dataset.app;
      if (!SCOPABLE_APPS.includes(app)) return;
      const baseHref = a.dataset.scopeBase || a.getAttribute('href') || '';
      // Save original href once so we can restore it if scope clears.
      if (!a.dataset.scopeBase) a.dataset.scopeBase = baseHref;
      if (!scoped) {
        if (baseHref) a.href = baseHref;
        return;
      }
      // Append/replace property_id query param.
      try {
        const u = new URL(baseHref, location.origin);
        u.searchParams.set('property_id', scoped);
        // Preserve the original token if present
        const orig = new URL(a.dataset.scopeBase, location.origin);
        const token = orig.searchParams.get('token');
        if (token) u.searchParams.set('token', token);
        a.href = u.toString();
      } catch (e) { /* leave href alone */ }
    });
  }

  function refreshActiveProperty() {
    const scoped = getScopedPropertyId();
    document.querySelectorAll('.os-newchrome-property-row').forEach(r => {
      r.classList.toggle('active', r.dataset.propertyId === scoped);
    });
  }

  // Floating chip pinned just below the top-header. We render it
  // straight into <body> (not into <main>) and rely on position: fixed
  // CSS — this avoids getting trapped inside page-specific flex
  // layouts (inbox / pulse three-column views) that swallowed the
  // chip as a side column.
  function renderScopeChip() {
    let chipHost = document.getElementById('os-newchrome-scope-chip-host');
    if (!chipHost) {
      chipHost = document.createElement('div');
      chipHost.id = 'os-newchrome-scope-chip-host';
      document.body.appendChild(chipHost);
    }
    const meta = getScopedPropertyMeta();
    if (!meta) {
      chipHost.innerHTML = '';
      document.body.classList.remove('has-scope-chip');
      return;
    }
    document.body.classList.add('has-scope-chip');
    chipHost.innerHTML = `
      <div class="os-newchrome-scope-chip" role="status">
        <span class="os-newchrome-scope-chip-dot"></span>
        <span class="os-newchrome-scope-chip-label">
          Now viewing: <strong>${escHtml(meta.name)}</strong>${meta.sub ? ' · ' + escHtml(meta.sub) : ''}
        </span>
        <a class="os-newchrome-scope-chip-link" href="/property.html?id=${meta.id}">Open property →</a>
        <button type="button" class="os-newchrome-scope-chip-close" aria-label="Clear scope"
                onclick="window.__clearScope && window.__clearScope()">×</button>
      </div>
    `;
  }

  // ── Data fetches (each is fault-tolerant) ───────────────────────
  // On satellites these go cross-origin to OS via osFetch().
  // On OS itself we use the local apiFetch — same result, no preflight.
  async function fetchCounts() {
    try { return IS_SATELLITE ? await osFetch('/api/sidebar-counts') : await apiFetch('/api/sidebar-counts'); }
    catch (e) { return {}; }
  }
  async function fetchPinned() {
    try { return IS_SATELLITE ? await osFetch('/api/pinned') : await apiFetch('/api/pinned'); }
    catch (e) { return []; }
  }
  async function fetchRecent() {
    try { return IS_SATELLITE ? await osFetch('/api/recent') : await apiFetch('/api/recent'); }
    catch (e) { return []; }
  }
  async function fetchTotal() {
    try {
      const all = IS_SATELLITE ? await osFetch('/api/properties') : await apiFetch('/api/properties');
      return Array.isArray(all) ? all.length : 0;
    } catch (e) { return 0; }
  }

  // ── Pin-a-property dialog ───────────────────────────────────────
  let _allPropertiesCache = null;
  async function loadAllPropertiesOnce() {
    if (_allPropertiesCache) return _allPropertiesCache;
    try { _allPropertiesCache = await apiFetch('/api/properties'); }
    catch (e) { _allPropertiesCache = []; }
    return _allPropertiesCache;
  }

  function openPinPicker() {
    let modal = document.getElementById('os-newchrome-pin-modal');
    if (modal) modal.remove();
    modal = document.createElement('div');
    modal.id = 'os-newchrome-pin-modal';
    modal.className = 'os-newchrome-pin-modal-backdrop';
    modal.innerHTML = `
      <div class="os-newchrome-pin-modal">
        <div class="os-newchrome-pin-modal-header">
          <h3>Pin a property</h3>
          <button type="button" class="os-newchrome-pin-modal-close"
                  onclick="document.getElementById('os-newchrome-pin-modal').remove()">×</button>
        </div>
        <input id="os-newchrome-pin-search" type="search"
               class="os-newchrome-pin-search" placeholder="Search by address, city, or name…"
               autocomplete="off">
        <div class="os-newchrome-pin-list" id="os-newchrome-pin-list">
          <div class="os-newchrome-pin-loading">Loading…</div>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.remove();
    });

    Promise.all([loadAllPropertiesOnce(), fetchPinned()]).then(([all, pinned]) => {
      const pinnedIds = new Set(pinned.map(p => p.id));
      const listEl = document.getElementById('os-newchrome-pin-list');
      const searchEl = document.getElementById('os-newchrome-pin-search');
      const render = (q = '') => {
        const filtered = (all || []).filter(p => {
          if (!q) return true;
          const haystack = `${p.display_name || ''} ${p.address_line1 || ''} ${p.city || ''} ${p.state || ''} ${p.zip || ''}`.toLowerCase();
          return haystack.includes(q.toLowerCase());
        }).slice(0, 100);
        if (!filtered.length) {
          listEl.innerHTML = `<div class="os-newchrome-pin-empty">No properties match "${escHtml(q)}".</div>`;
          return;
        }
        listEl.innerHTML = filtered.map(p => {
          const isPinned = pinnedIds.has(p.id);
          const dot = STATUS_DOT[p.status] || '#cbd5e1';
          return `
            <div class="os-newchrome-pin-row" data-property-id="${p.id}">
              <span class="os-newchrome-status-dot" style="background:${dot}"></span>
              <div class="os-newchrome-pin-row-text">
                <div class="os-newchrome-pin-row-title">${escHtml(p.display_name || p.address_line1)}</div>
                <div class="os-newchrome-pin-row-sub">${escHtml([p.city, p.state, p.zip].filter(Boolean).join(', '))}</div>
              </div>
              <button type="button" class="os-newchrome-pin-toggle ${isPinned ? 'pinned' : ''}"
                      onclick="window.__togglePin && window.__togglePin('${p.id}', this)">
                ${isPinned ? '★ Unpin' : '☆ Pin'}
              </button>
            </div>
          `;
        }).join('');
      };
      render();
      searchEl.addEventListener('input', (e) => render(e.target.value.trim()));
      searchEl.focus();
    });
  }

  async function togglePin(propertyId, buttonEl) {
    const isPinned = buttonEl.classList.contains('pinned');
    try {
      if (isPinned) {
        await apiFetch(`/api/pinned/${propertyId}`, { method: 'DELETE' });
        buttonEl.classList.remove('pinned');
        buttonEl.textContent = '☆ Pin';
      } else {
        await apiFetch('/api/pinned', { method: 'POST', body: JSON.stringify({ property_id: propertyId }) });
        buttonEl.classList.add('pinned');
        buttonEl.textContent = '★ Unpin';
      }
      // Re-render the sidebar so the bottom Pinned list updates.
      renderNewSidebar();
    } catch (e) {
      if (typeof showToast === 'function') showToast(e.message || 'Pin failed', 'error');
    }
  }

  // ── Click handler for property rows: activate scope ─────────────
  function onPropertyRowClick(e) {
    const row = e.target.closest('.os-newchrome-property-row');
    if (!row) return;
    // Cmd/Ctrl-click: open property page without scoping.
    if (e.metaKey || e.ctrlKey || e.shiftKey) return;
    // Plain click: scope the workspace; let the default navigation
    // proceed too so the user lands on the property page.
    setScope(row.dataset.propertyId, row.dataset.propertyName, row.dataset.propertySub);
    // Do NOT prevent default — navigation continues.
  }

  // ── Right-click context menu for pinned property rows ───────────
  // Right-click any pinned row → small floating menu with an
  // 'Unpin' action. Recent rows aren't pinnable so they don't get
  // a menu (browser default contextmenu fires through normally).
  let _ctxMenuEl = null;
  function ensureCtxMenu() {
    if (_ctxMenuEl) return _ctxMenuEl;
    _ctxMenuEl = document.createElement('div');
    _ctxMenuEl.className = 'os-newchrome-ctx-menu';
    document.body.appendChild(_ctxMenuEl);
    document.addEventListener('click',       hideCtxMenu);
    document.addEventListener('scroll',      hideCtxMenu, true);
    document.addEventListener('contextmenu', (ev) => {
      // Hide if right-click happened OUTSIDE a property row.
      if (!ev.target.closest('.os-newchrome-property-row')) hideCtxMenu();
    });
    document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') hideCtxMenu(); });
    return _ctxMenuEl;
  }
  function hideCtxMenu() { if (_ctxMenuEl) _ctxMenuEl.classList.remove('open'); }

  function onPropertyRowContextMenu(e) {
    const row = e.target.closest('.os-newchrome-property-row');
    if (!row) return;
    // Only pinned rows get the unpin menu.
    if (row.dataset.propertyRow !== 'pinned') return;
    e.preventDefault();

    const id   = row.dataset.propertyId;
    const name = row.dataset.propertyName || 'this property';
    const menu = ensureCtxMenu();
    menu.innerHTML = `
      <div class="os-newchrome-ctx-item os-newchrome-ctx-danger" data-action="unpin">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="12" x2="12" y1="17" y2="22"/>
          <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"/>
        </svg>
        <span>Remove from pinned</span>
      </div>
      <div class="os-newchrome-ctx-sub">${escHtml(name)}</div>
    `;
    // Position at cursor, keep within viewport
    const W = 220, H = 76;
    const x = Math.min(e.clientX, window.innerWidth  - W - 6);
    const y = Math.min(e.clientY, window.innerHeight - H - 6);
    menu.style.left = x + 'px';
    menu.style.top  = y + 'px';
    menu.classList.add('open');

    menu.querySelector('[data-action="unpin"]').onclick = async (ev) => {
      ev.stopPropagation();
      hideCtxMenu();
      try {
        if (IS_SATELLITE) {
          await osFetch('/api/pinned/' + id, { method: 'DELETE' });
        } else {
          await apiFetch('/api/pinned/' + id, { method: 'DELETE' });
        }
        // Fade the row out, then re-render the whole sidebar for a clean refresh
        row.style.transition = 'opacity 0.15s ease, transform 0.15s ease';
        row.style.opacity = '0';
        row.style.transform = 'translateX(-6px)';
        setTimeout(() => {
          if (typeof window.renderNewSidebar === 'function') window.renderNewSidebar();
        }, 160);
        if (typeof showToast === 'function') showToast('Removed from pinned');
      } catch (err) {
        if (typeof showToast === 'function') showToast(err.message || 'Failed to unpin', 'error');
      }
    };
  }

  // ── Sidebar HTML cache (sessionStorage) ────────────────────────
  // Stores the last rendered sidebar HTML so it can be shown instantly
  // on the next page load instead of waiting for async data fetches.
  // Bumped to v3 — workspace tile is now the Home button (anchor +
  // chevron removed + Home row removed). Old v2 cache would briefly
  // re-show the old structure before fresh render replaces it.
  const SIDEBAR_CACHE_KEY = 'propspot_sidebar_cache_v7';

  function saveSidebarCache(html) {
    try { sessionStorage.setItem(SIDEBAR_CACHE_KEY, html); } catch (e) {}
  }

  function restoreSidebarCache(railEl) {
    try {
      const cached = sessionStorage.getItem(SIDEBAR_CACHE_KEY);
      if (!cached) return false;
      railEl.innerHTML = cached;
      return true;
    } catch (e) { return false; }
  }

  // ── Render the sidebar ──────────────────────────────────────────
  // Expose so the customize modal can trigger a re-render without a full reload.
  window.__rerenderSidebar = function () {
    try { renderNewSidebar(); } catch (e) { location.reload(); }
  };
  async function renderNewSidebar() {
    // On satellites these set up the chrome the host page doesn't ship with.
    ensureChromeStylesheet();
    ensureThemeScript();
    ensurePlaceholders();
    const railEl = document.getElementById('apps-rail');
    if (!railEl) return;

    document.body.classList.add('os-newchrome');

    // Show cached sidebar immediately so there's no blank flash between pages.
    const hadCache = restoreSidebarCache(railEl);
    if (hadCache) {
      // Wire events and active state on the cached HTML right away.
      railEl.removeEventListener('click', onPropertyRowClick);
      railEl.addEventListener('click', onPropertyRowClick);
      railEl.removeEventListener('contextmenu', onPropertyRowContextMenu);
      railEl.addEventListener('contextmenu', onPropertyRowContextMenu);
      wireChromeNav();
      if (window.NAV_CURRENT) {
        railEl.querySelectorAll('.os-newchrome-row').forEach(a => {
          const slug = a.dataset.app || a.dataset.osnav;
          a.classList.toggle('active', slug === window.NAV_CURRENT);
        });
      }
      applyScopeToLinks();
      renderScopeChip();
      refreshActiveProperty();
      if (typeof window.__replaceEmojisIn === 'function') window.__replaceEmojisIn(railEl);
      // Cached chrome is on screen — let the page-loader drop NOW. Fresh
      // data refresh below just updates badge counts and pinned/recent
      // lists, which is a near-invisible diff against the cached HTML.
      if (window.__markChromeReady) window.__markChromeReady('sidebar');
    }

    const user = getCachedUser() || {};

    // Kick off all data fetches in parallel.
    const [counts, pinned, recent, total] = await Promise.all([
      fetchCounts(), fetchPinned(), fetchRecent(), fetchTotal()
    ]);

    // Play notification sound when new mentions or inbox items arrive
    if (typeof window.__playNotifSound === 'function' && window.__prevSidebarCounts) {
      const prev = window.__prevSidebarCounts;
      if (counts.mentions > (prev.mentions || 0)) window.__playNotifSound('mention');
      else if (counts.inbox > (prev.inbox || 0)) window.__playNotifSound('message');
    }
    window.__prevSidebarCounts = { ...counts };

    const active = window.NAV_CURRENT;

    const sidebarHTML = `
      <aside class="os-newchrome-sidebar">

        <div class="os-newchrome-brand-bar">
          <a class="os-newchrome-brand-logo" href="/dashboard.html" title="PropSpot.OS · Home">
            <img src="/logo.png" alt="PropSpot.OS">
            <span class="os-newchrome-brand-text">PropSpot<span class="os-newchrome-brand-suffix">.OS</span></span>
          </a>
          <button type="button" class="os-newchrome-collapse-btn" id="os-newchrome-collapse-btn"
                  onclick="toggleSidebar()" title="Collapse sidebar" aria-label="Collapse sidebar">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
          </button>
        </div>

        <a class="os-newchrome-workspace ${window.NAV_CURRENT === 'dashboard' ? 'active' : ''}"
           href="/dashboard.html"
           data-osnav="dashboard"
           title="Restoration Homes · Home">
          <div class="os-newchrome-workspace-logo">R</div>
          <div class="os-newchrome-workspace-text">
            <div class="os-newchrome-workspace-name">Restoration Homes</div>
            <div class="os-newchrome-workspace-user">${escHtml(user.full_name || user.email || 'Signed in')}</div>
          </div>
        </a>

        <div class="os-newchrome-sidebar-scroll">

          ${sectionLabel('For you', { editable: true })}
          ${renderForYouRows(counts)}

          ${sectionLabel('Pipeline')}
          ${row({ section: 'pipeline', icon: ICONS.target,     label: 'Prospects',     osnav: 'prospects',     href: '/acquisitions.html',                    badge: counts.prospects,     badgeClass: 'muted' })}
          ${row({ section: 'pipeline', icon: ICONS.phone,      label: 'Leads',         osnav: 'leads',         href: '/acquisitions.html',                    badge: counts.leads,         badgeClass: 'muted' })}
          ${row({ section: 'pipeline', icon: ICONS.users,      label: 'Opportunities', osnav: 'opportunities', href: '/acquisitions.html',                    badge: counts.opportunities, badgeClass: 'muted' })}
          ${row({ section: 'pipeline', icon: ICONS.clipboard,  label: 'Acquisitions',  osnav: 'acquisitions',  href: '/acquisitions.html',                    badge: counts.acquisitions,  badgeClass: 'muted' })}
          ${row({ section: 'pipeline', icon: ICONS.hammer,     label: 'Projects',      osnav: 'projects',      href: '/properties.html?status=renovating',    badge: counts.projects,      badgeClass: 'muted' })}
          ${row({ section: 'pipeline', icon: ICONS.briefcase,  label: 'Holdings',      osnav: 'holdings',      href: '/holdings.html',                        badge: counts.holdings,      badgeClass: 'muted' })}
          ${row({ section: 'pipeline', icon: ICONS.trendingUp, label: 'Dispositions',  osnav: 'dispositions',  href: '/dispositions.html',                    badge: counts.dispositions,  badgeClass: 'muted' })}
          ${row({ section: 'pipeline', icon: ICONS.package,    label: 'Sold',          osnav: 'sold',          href: '/closed.html',                          badge: counts.sold,          badgeClass: 'muted' })}
          ${row({ section: 'pipeline', icon: ICONS.xCircle,    label: 'Dead',          osnav: 'dead',          href: '/properties.html?status=dropped' })}

          ${sectionLabel('Workspace')}
          ${row({ section: 'workspace', icon: ICONS.database, label: 'Database', osnav: 'database', href: '/database.html', badge: total, badgeClass: 'muted' })}
          ${row({ section: 'workspace', icon: ICONS.activity, label: 'Activity', osnav: 'activity', href: '/activity.html' })}

          ${sectionLabel('Tools')}
          ${row({ section: 'tools', icon: ICONS.camera,   label: 'FieldCam',     app: 'fieldcam',                                       badge: counts.photosToday, badgeClass: 'muted' })}
          ${row({ section: 'tools', icon: ICONS.wrench,   label: 'Maintenance',  app: 'maintenance',                                    badge: counts.workOrders,  badgeClass: 'warn' })}
          ${row({ section: 'tools', icon: ICONS.pulse,    label: 'Pulse',        app: 'pulse',                                          badge: counts.pulse })}
          ${row({ section: 'tools', icon: ICONS.folder,   label: 'Files',        osnav: 'files',        href: '/files.html' })}
          ${row({ section: 'tools', icon: ICONS.barChart, label: 'Underwriting', osnav: 'underwriting', href: '/underwriting.html' })}

          ${sectionLabel('Soon')}
          ${row({ section: 'soon', icon: ICONS.globe,   label: 'Listings',         soon: true })}
          ${row({ section: 'soon', icon: ICONS.home,    label: 'Offmarket',        soon: true })}
          ${row({ section: 'soon', icon: ICONS.dollar,  label: 'Expenses',         soon: true })}
          ${row({ section: 'soon', icon: ICONS.receipt, label: 'QuickBooks sync',  soon: true })}
          ${row({ section: 'soon', icon: ICONS.refresh, label: 'Rentvine sync',    soon: true })}

          <div class="os-newchrome-properties">
            <div class="os-newchrome-pinned-header" data-section="pinned">
              <span>Pinned</span>
              <button class="os-newchrome-pinned-add" title="Pin a property" aria-label="Pin a property"
                      onclick="window.__openPinPicker && window.__openPinPicker()">＋</button>
            </div>
            ${pinned.length
              ? pinned.map(p => propertyRow(p, 'pinned')).join('')
              : '<div class="os-newchrome-pinned-empty">Click ＋ to pin a property.</div>'}

            ${recent.length ? `
              <div class="os-newchrome-pinned-header" data-section="recent" style="margin-top:6px;">
                <span>Recent</span>
              </div>
              ${recent.map(p => propertyRow(p, 'recent')).join('')}
            ` : ''}

            <a class="os-newchrome-all-link" href="/properties.html">All properties${total ? ` (${total})` : ''} →</a>
          </div>

        </div>
      </aside>
    `;

    railEl.innerHTML = sidebarHTML;
    saveSidebarCache(sidebarHTML);

    wireChromeNav();

    // Wire click handler for property rows (event delegation on the sidebar).
    railEl.removeEventListener('click', onPropertyRowClick);
    railEl.addEventListener('click', onPropertyRowClick);

    // Highlight active row
    if (active) {
      document.querySelectorAll('.os-newchrome-row').forEach(a => {
        const slug = a.dataset.app || a.dataset.osnav;
        if (slug === active) a.classList.add('active');
      });
    }

    // Apply scope state (chip + link rewriting + active-row highlight)
    applyScopeToLinks();
    renderScopeChip();
    refreshActiveProperty();

    // Re-apply premium icons on fresh render
    if (typeof window.__replaceEmojisIn === 'function') window.__replaceEmojisIn(railEl);

    // First-load (no cache): fresh chrome is now on screen. Tell the
    // page-loader it can drop. Cached path already called this above —
    // markChromeReady is idempotent.
    if (window.__markChromeReady) window.__markChromeReady('sidebar');
  }

  // Expose for inline onclick + topbar integration.
  window.renderNewSidebar = renderNewSidebar;
  window.__openPinPicker  = openPinPicker;
  window.__togglePin      = togglePin;
  window.__setScope       = setScope;
  window.__clearScope     = clearScope;
  window.__getScopedPropertyId = getScopedPropertyId;
  window.__applyScopeToLinks  = applyScopeToLinks;
  window.__wireChromeNav      = wireChromeNav;   // topbar.js uses this too

  // Run now if DOM is ready, else wait for it.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', renderNewSidebar);
  } else {
    renderNewSidebar();
  }

  // ── Auto-poll sidebar counts for real-time notifications ────────
  // Every 15s, re-fetch counts and update badges in place. Plays
  // notification sounds when new mentions or inbox items appear.
  const POLL_INTERVAL = 15000;
  async function pollCounts() {
    try {
      const counts = IS_SATELLITE ? await osFetch('/api/sidebar-counts') : await apiFetch('/api/sidebar-counts');
      if (typeof window.__playNotifSound === 'function' && window.__prevSidebarCounts) {
        const prev = window.__prevSidebarCounts;
        if ((counts.mentions || 0) > (prev.mentions || 0)) window.__playNotifSound('mention');
        else if ((counts.inbox || 0) > (prev.inbox || 0)) window.__playNotifSound('message');
        else if ((counts.myTasks || 0) > (prev.myTasks || 0)) window.__playNotifSound('message');
      }
      window.__prevSidebarCounts = { ...counts };

      // Update badge numbers in place without full re-render
      const badgeMap = [
        { selector: '[data-app="inbox"]',       key: 'inbox' },
        { selector: '[data-osnav="mentions"]',  key: 'mentions' },
        { selector: '[data-osnav="tasks"]',     key: 'myTasks' },
        { selector: '[data-app="pulse"]',       key: 'pulse' },
        { selector: '[data-app="fieldcam"]',    key: 'photosToday' },
        { selector: '[data-app="maintenance"]', key: 'workOrders' },
      ];
      badgeMap.forEach(({ selector, key }) => {
        const row = document.querySelector('.os-newchrome-row' + selector);
        if (!row) return;
        let badge = row.querySelector('.os-newchrome-badge');
        const val = counts[key] || 0;
        if (val > 0) {
          if (!badge) {
            badge = document.createElement('span');
            badge.className = 'os-newchrome-badge';
            row.appendChild(badge);
          }
          badge.textContent = val;
          badge.style.display = '';
        } else if (badge) {
          badge.style.display = 'none';
        }
      });
    } catch (e) {}
  }
  setInterval(pollCounts, POLL_INTERVAL);
})();
