// ============================================================
//  Prop Spot — New Chrome Sidebar (Phase 1)
//  Gated by ?newchrome=1 URL param OR localStorage.propspot_newchrome
//  Renders the 260px hybrid sidebar into the existing #apps-rail
//  placeholder so pages don't need HTML changes.
// ============================================================

(function () {
  if (!window.__newChromeEnabled || !window.__newChromeEnabled()) return;

  // ── Status dot colors (mirrors PROPERTY_STATUSES in app.js) ──────
  const STATUS_DOT = {
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

  // ── Section/row builders ────────────────────────────────────────
  function sectionLabel(text) {
    return `<div class="os-newchrome-section-label">${text}</div>`;
  }

  function row({ icon, label, href = '#', osnav, app, appPath, badge, badgeClass = '', soon = false }) {
    const dataAttr = osnav ? `data-osnav="${osnav}"` :
                     app   ? `data-app="${app}" data-app-path="${appPath || '/'}"` : '';
    const badgeHtml = soon
      ? `<span class="os-newchrome-row-soon-pill">soon</span>`
      : (badge !== undefined && badge !== null && badge !== ''
          ? `<span class="os-newchrome-badge ${badgeClass}">${badge}</span>`
          : '');
    const klass = `os-newchrome-row${soon ? ' soon' : ''}`;
    return `
      <a class="${klass}" href="${href}" ${dataAttr}>
        <span class="os-newchrome-row-icon">${icon}</span>
        <span class="os-newchrome-row-label">${label}</span>
        ${badgeHtml}
      </a>`;
  }

  function propertyRow(p, active = false) {
    const dot = STATUS_DOT[p.status] || '#cbd5e1';
    const sub = p.acquisition_status
      ? acquisitionLabel(p.acquisition_status)
      : propertyStatusLabel(p.status);
    return `
      <a class="os-newchrome-property-row${active ? ' active' : ''}" href="/property.html?id=${p.id}">
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

  // ── Hardcoded Phase 1 placeholder counts ────────────────────────
  // Phase 2 will wire these to real API calls.
  const PHASE1_BADGES = {
    inbox: 12,
    mentions: 3,
    myTasks: 5,
    prospects: 7,
    leads: 4,
    opportunities: 2,
    acquisitions: 14,
    holdings: 8,
    dispositions: 3,
    closed: '',
    photosToday: '',
    workOrders: 9,
    pulse: 4,
    underwriting: ''
  };

  // ── Render the sidebar ──────────────────────────────────────────
  async function renderNewSidebar() {
    const railEl = document.getElementById('apps-rail');
    if (!railEl) return;

    // Add body class so CSS swaps layout to 260px sidebar.
    document.body.classList.add('os-newchrome');

    const user = getCachedUser() || {};
    const userInitial = user.full_name ? user.full_name.charAt(0).toUpperCase()
                       : user.email    ? user.email.charAt(0).toUpperCase()
                       : '?';

    // Try to fetch pinned + recent properties for the bottom zone.
    // Phase 1: use any properties that exist (first 3 as "pinned" placeholders, next 3 as "recent").
    let pinned = [], recent = [], totalCount = 0;
    try {
      const props = await apiFetch('/api/properties');
      if (Array.isArray(props)) {
        totalCount = props.length;
        // Prefer properties currently in interesting stages for the Phase 1 placeholders.
        const active = props.filter(p => p.status && p.status !== 'sold' && p.status !== 'dropped');
        pinned = active.slice(0, 3);
        recent = active.slice(3, 8);
      }
    } catch (e) { /* tolerate failure — Phase 1 still renders the chrome */ }

    const active = window.NAV_CURRENT;

    railEl.innerHTML = `
      <aside class="os-newchrome-sidebar">

        <div class="os-newchrome-workspace">
          <div class="os-newchrome-workspace-logo">R</div>
          <div class="os-newchrome-workspace-text">
            <div class="os-newchrome-workspace-name">Restoration Homes</div>
            <div class="os-newchrome-workspace-user">${escHtml(user.full_name || user.email || 'Signed in')}</div>
          </div>
          <span class="os-newchrome-workspace-chev">▾</span>
        </div>

        <div class="os-newchrome-sidebar-scroll">

          ${sectionLabel('For you')}
          ${row({ icon: '📧', label: 'Inbox',     app: 'inbox',    badge: PHASE1_BADGES.inbox })}
          ${row({ icon: '@',  label: 'Mentions',  osnav: 'mentions', href: '#', badge: PHASE1_BADGES.mentions, badgeClass: 'amber' })}
          ${row({ icon: '✓',  label: 'My Tasks',  osnav: 'tasks', href: '#', badge: PHASE1_BADGES.myTasks, badgeClass: 'muted' })}

          ${sectionLabel('Pipeline')}
          ${row({ icon: '🎯', label: 'Prospects',     osnav: 'prospects',     href: '/acquisitions.html', badge: PHASE1_BADGES.prospects, badgeClass: 'muted' })}
          ${row({ icon: '📞', label: 'Leads',         osnav: 'leads',         href: '/acquisitions.html', badge: PHASE1_BADGES.leads,     badgeClass: 'muted' })}
          ${row({ icon: '🤝', label: 'Opportunities', osnav: 'opportunities', href: '/acquisitions.html', badge: PHASE1_BADGES.opportunities, badgeClass: 'muted' })}
          ${row({ icon: '📋', label: 'Acquisitions',  osnav: 'acquisitions',  href: '/acquisitions.html', badge: PHASE1_BADGES.acquisitions, badgeClass: 'muted' })}
          ${row({ icon: '💼', label: 'Holdings',      osnav: 'holdings',      href: '/holdings.html',     badge: PHASE1_BADGES.holdings,     badgeClass: 'muted' })}
          ${row({ icon: '💰', label: 'Dispositions',  osnav: 'dispositions',  href: '/dispositions.html', badge: PHASE1_BADGES.dispositions, badgeClass: 'muted' })}
          ${row({ icon: '📦', label: 'Closed',        osnav: 'closed',        href: '/closed.html' })}

          ${sectionLabel('Tools')}
          ${row({ icon: '📸', label: 'Photos',      app: 'fieldcam' })}
          ${row({ icon: '🛠️', label: 'Work Orders', app: 'maintenance', badge: PHASE1_BADGES.workOrders, badgeClass: 'warn' })}
          ${row({ icon: '💬', label: 'Pulse',       app: 'pulse',       badge: PHASE1_BADGES.pulse })}
          ${row({ icon: '📊', label: 'Underwriting', osnav: 'underwriting', href: '/underwriting.html' })}

          ${sectionLabel('Soon')}
          ${row({ icon: '🌐', label: 'Listings',         soon: true })}
          ${row({ icon: '🏚️', label: 'Offmarket',        soon: true })}
          ${row({ icon: '💵', label: 'Expenses',         soon: true })}
          ${row({ icon: '🧾', label: 'QuickBooks sync',  soon: true })}
          ${row({ icon: '🔄', label: 'Rentvine sync',    soon: true })}

          <div class="os-newchrome-properties">
            <div class="os-newchrome-pinned-header">
              <span>Pinned</span>
              <button class="os-newchrome-pinned-add" title="Pin a property" aria-label="Pin a property">＋</button>
            </div>
            ${pinned.length
              ? pinned.map((p, i) => propertyRow(p, i === 0 && active === 'property-' + p.id)).join('')
              : '<div class="os-newchrome-pinned-empty">Pin properties to keep them here.</div>'}

            ${recent.length ? `
              <div class="os-newchrome-pinned-header" style="margin-top:6px;">
                <span>Recent</span>
              </div>
              ${recent.map(p => propertyRow(p)).join('')}
            ` : ''}

            <a class="os-newchrome-all-link" href="/properties.html">All properties${totalCount ? ` (${totalCount})` : ''} →</a>
          </div>

        </div>
      </aside>
    `;

    // Wire data-app and data-osnav links using existing helper from app.js.
    if (typeof wireUnifiedNav === 'function') {
      wireUnifiedNav();
    }

    // Highlight active row
    if (active) {
      document.querySelectorAll('.os-newchrome-row').forEach(a => {
        const slug = a.dataset.app || a.dataset.osnav;
        if (slug === active) a.classList.add('active');
      });
    }
  }

  // Run now if DOM is ready, else wait for it.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', renderNewSidebar);
  } else {
    renderNewSidebar();
  }

  // Expose for re-render after data changes (Phase 2 will use this).
  window.renderNewSidebar = renderNewSidebar;
})();
