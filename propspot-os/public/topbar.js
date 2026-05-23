// ============================================================
//  Prop Spot — New Chrome Top Bar (Phase 1)
//  Gated by ?newchrome=1 URL param OR localStorage.propspot_newchrome
//  Renders the 56px top bar into the existing #top-header
//  placeholder. Reuses search/user-menu helpers from app.js.
// ============================================================

(function () {
  if (!window.__newChromeEnabled || !window.__newChromeEnabled()) return;

  // Phase 1: notifications count is hardcoded. Phase 4 wires real data.
  const PHASE1_NOTIF_COUNT = 7;

  function renderNewTopBar() {
    const headerEl = document.getElementById('top-header');
    if (!headerEl) return;

    const user = getCachedUser() || {};

    headerEl.innerHTML = `
      <div class="os-newchrome-topbar">
        <form class="os-newchrome-search-wrap" onsubmit="submitTopSearch(event)">
          <div class="os-newchrome-search">
            <span class="os-newchrome-search-icon">🔍</span>
            <input type="search" id="top-search" placeholder="Search properties, photos, emails, messages, contacts…" autocomplete="off"
                   oninput="onSearchInput(event)" onfocus="onSearchInput(event)" onkeydown="onSearchKey(event)">
            <span class="os-newchrome-kbd">⌘K</span>
          </div>
          <div class="search-results" id="search-results"></div>
        </form>
        <div class="os-newchrome-actions">
          <button type="button" class="os-newchrome-quick-create" id="qc-btn" title="Create new" onclick="toggleQuickCreate(event)">＋</button>
          <button type="button" class="os-newchrome-bell" id="notif-btn" title="Notifications" onclick="toggleNotifications(event)">
            🔔
            <span class="os-newchrome-bell-badge" id="notif-badge">${PHASE1_NOTIF_COUNT}</span>
          </button>
          <button type="button" class="os-newchrome-avatar" id="user-avatar" title="Account" onclick="toggleUserMenu(event)">
            ${avatarContent(user)}
          </button>
        </div>
      </div>

      <!-- Quick-create dropdown -->
      <div class="os-newchrome-qc-menu" id="qc-menu" role="menu">
        <div class="os-newchrome-qc-section-label">Acquire</div>
        <a class="os-newchrome-qc-item" href="/add-property.html">
          <span style="width:18px;">🏠</span> New Property
        </a>
        <a class="os-newchrome-qc-item" href="/acquisitions.html?new=prospect">
          <span style="width:18px;">🎯</span> New Prospect
        </a>
        <a class="os-newchrome-qc-item" href="/acquisitions.html?new=lead">
          <span style="width:18px;">📞</span> New Lead
        </a>
        <a class="os-newchrome-qc-item" href="/acquisitions.html?new=opportunity">
          <span style="width:18px;">🤝</span> New Opportunity
        </a>

        <div class="os-newchrome-qc-section-label">Work</div>
        <a class="os-newchrome-qc-item" data-app="fieldcam" data-app-path="/" href="#">
          <span style="width:18px;">📸</span> Upload Photos
        </a>
        <a class="os-newchrome-qc-item" data-app="maintenance" data-app-path="/" href="#">
          <span style="width:18px;">🛠️</span> New Work Order
        </a>
        <a class="os-newchrome-qc-item" data-app="pulse" data-app-path="/" href="#">
          <span style="width:18px;">💬</span> New Pulse Message
        </a>
        <a class="os-newchrome-qc-item" data-app="inbox" data-app-path="/" href="#">
          <span style="width:18px;">✉️</span> Compose Email
        </a>

        <div class="os-newchrome-qc-section-label">Admin</div>
        <a class="os-newchrome-qc-item" href="/team.html?invite=1">
          <span style="width:18px;">👤</span> Invite Teammate
        </a>
        <a class="os-newchrome-qc-item" href="/contacts.html?new=1">
          <span style="width:18px;">📇</span> New Contact
        </a>
      </div>

      <!-- Notifications panel -->
      <div class="os-newchrome-notif-panel" id="notif-panel">
        <div class="os-newchrome-notif-header">
          <h3>Notifications</h3>
          <button class="os-newchrome-notif-mark-all" onclick="markAllNotificationsRead()">Mark all read</button>
        </div>
        <div class="os-newchrome-notif-body" id="notif-body">
          <div class="os-newchrome-notif-empty">Phase 4 will populate this feed with mentions, work-order updates, holdings due-soon alerts, and pipeline promotions.</div>
        </div>
      </div>
    `;

    // Pre-fill search from ?q=
    const q = new URLSearchParams(location.search).get('q');
    if (q) {
      const input = document.getElementById('top-search');
      if (input) input.value = q;
    }

    if (typeof wireUnifiedNav === 'function') {
      wireUnifiedNav();
    }
  }

  // ── Quick-create menu ───────────────────────────────────────────
  function toggleQuickCreate(e) {
    if (e) e.stopPropagation();
    const menu = document.getElementById('qc-menu');
    if (!menu) return;
    // Close other panels
    document.getElementById('notif-panel')?.classList.remove('open');
    document.getElementById('user-menu')?.classList.remove('open');
    menu.classList.toggle('open');
  }
  function closeQuickCreateOnOutsideClick(e) {
    const menu = document.getElementById('qc-menu');
    const btn = document.getElementById('qc-btn');
    if (!menu || !menu.classList.contains('open')) return;
    if (menu.contains(e.target) || (btn && btn.contains(e.target))) return;
    menu.classList.remove('open');
  }

  // ── Notifications panel ─────────────────────────────────────────
  function toggleNotifications(e) {
    if (e) e.stopPropagation();
    const panel = document.getElementById('notif-panel');
    if (!panel) return;
    document.getElementById('qc-menu')?.classList.remove('open');
    document.getElementById('user-menu')?.classList.remove('open');
    panel.classList.toggle('open');
  }
  function closeNotificationsOnOutsideClick(e) {
    const panel = document.getElementById('notif-panel');
    const btn = document.getElementById('notif-btn');
    if (!panel || !panel.classList.contains('open')) return;
    if (panel.contains(e.target) || (btn && btn.contains(e.target))) return;
    panel.classList.remove('open');
  }
  function markAllNotificationsRead() {
    const badge = document.getElementById('notif-badge');
    if (badge) badge.style.display = 'none';
    // Phase 4: POST to /api/notifications/mark-all-read
  }

  // Expose for inline onclick handlers
  window.toggleQuickCreate = toggleQuickCreate;
  window.toggleNotifications = toggleNotifications;
  window.markAllNotificationsRead = markAllNotificationsRead;
  window.renderNewTopBar = renderNewTopBar;

  // Outside-click handlers
  document.addEventListener('click', closeQuickCreateOnOutsideClick);
  document.addEventListener('click', closeNotificationsOnOutsideClick);

  // Cmd+K / Ctrl+K to focus search
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      const input = document.getElementById('top-search');
      if (input) input.focus();
    }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', renderNewTopBar);
  } else {
    renderNewTopBar();
  }
})();
