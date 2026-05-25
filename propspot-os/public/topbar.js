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
        <button type="button" class="os-newchrome-hamburger" id="mobile-rail-toggle"
                onclick="toggleMobileRail(event)" aria-label="Open menu" title="Open menu">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" width="20" height="20"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
        </button>
        <form class="os-newchrome-search-wrap" onsubmit="submitTopSearch(event)">
          <div class="os-newchrome-search">
            <span class="os-newchrome-search-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            </span>
            <input type="search" id="top-search" placeholder="Search properties, photos, emails, messages, contacts…" autocomplete="off"
                   oninput="onSearchInput(event)" onfocus="onSearchInput(event)" onkeydown="onSearchKey(event)">
            <span class="os-newchrome-kbd">⌘K</span>
          </div>
          <div class="search-results" id="search-results"></div>
        </form>
        <div class="os-newchrome-actions">
          <!-- Prop Spot AI — the headline feature. Tasteful brand-tinted
               pill with sparkle icon. No aggressive animations. -->
          <button type="button" class="os-newchrome-ai-pill" id="ai-assistant-btn"
                  title="Ask Prop Spot AI — coming soon"
                  onclick="toggleAIAssistant(event)">
            <span class="os-newchrome-ai-pill-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" width="13" height="13"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/><path d="M5 3v4"/><path d="M19 17v4"/><path d="M3 5h4"/><path d="M17 19h4"/></svg>
            </span>
            <span class="os-newchrome-ai-pill-label">Ask Prop Spot AI</span>
          </button>
          <!-- Add new — clean icon button -->
          <button type="button" class="os-newchrome-icon-btn" id="qc-btn"
                  title="Create new" aria-label="Create new"
                  onclick="toggleQuickCreate(event)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" width="15" height="15"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          </button>
          <!-- Notifications — clean icon button with count badge -->
          <button type="button" class="os-newchrome-icon-btn" id="notif-btn"
                  title="Notifications" aria-label="Notifications"
                  onclick="toggleNotifications(event)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="15" height="15"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>
            <span class="os-newchrome-icon-badge" id="notif-badge"
                  style="${PHASE1_NOTIF_COUNT > 0 ? '' : 'display:none;'}">${PHASE1_NOTIF_COUNT}</span>
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

      <!-- AI Assistant panel (placeholder) -->
      <div class="os-newchrome-ai-panel" id="ai-panel">
        <div class="os-newchrome-ai-hero">
          <div class="os-newchrome-ai-icon">
            <svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/><path d="M5 3v4"/><path d="M19 17v4"/><path d="M3 5h4"/><path d="M17 19h4"/></svg>
          </div>
          <div class="os-newchrome-ai-title">Prop Spot AI</div>
          <div class="os-newchrome-ai-tag">Coming Soon</div>
          <p class="os-newchrome-ai-blurb">
            Your AI co-pilot will live here — ask about any property, pull together
            the latest from your inbox &amp; messages, draft replies, flag at-risk
            deals, and act across the whole workspace.
          </p>
          <div class="os-newchrome-ai-features">
            <div class="os-newchrome-ai-feature">
              <span class="os-newchrome-ai-feature-dot"></span>
              <span>Natural-language queries across every tool</span>
            </div>
            <div class="os-newchrome-ai-feature">
              <span class="os-newchrome-ai-feature-dot"></span>
              <span>Auto-summarize inboxes &amp; Pulse threads</span>
            </div>
            <div class="os-newchrome-ai-feature">
              <span class="os-newchrome-ai-feature-dot"></span>
              <span>Underwriting assumptions sanity check</span>
            </div>
            <div class="os-newchrome-ai-feature">
              <span class="os-newchrome-ai-feature-dot"></span>
              <span>Proactive nudges &amp; daily briefings</span>
            </div>
          </div>
          <div class="os-newchrome-ai-cta">
            Currently in development — toggle the theme from your profile menu.
          </div>
        </div>
      </div>
    `;

    // Pre-fill search from ?q=
    const q = new URLSearchParams(location.search).get('q');
    if (q) {
      const input = document.getElementById('top-search');
      if (input) input.value = q;
    }

    // Wire data-app + data-osnav links. Prefer the chrome-local helper
    // (works cross-origin on satellites); fall back to app.js's
    // wireUnifiedNav if present (OS-only legacy path).
    if (typeof window.__wireChromeNav === 'function') {
      window.__wireChromeNav();
    } else if (typeof wireUnifiedNav === 'function') {
      wireUnifiedNav();
    }

    // (Theme toggle moved to user-menu Settings.)

    // Re-apply scope to any quick-create [data-app] items now that they
    // exist in the DOM (sidebar.js may have run before us).
    if (typeof window.__applyScopeToLinks === 'function') {
      window.__applyScopeToLinks();
    }

    // Topbar is painted — let the page-loader drop. Pairs with sidebar.js's
    // matching call; loader only fades once BOTH parts have signaled ready.
    if (window.__markChromeReady) window.__markChromeReady('topbar');
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
    document.getElementById('ai-panel')?.classList.remove('open');
    panel.classList.toggle('open');
  }

  // ── AI Assistant panel (placeholder) ────────────────────────────
  function toggleAIAssistant(e) {
    if (e) e.stopPropagation();
    const panel = document.getElementById('ai-panel');
    if (!panel) return;
    document.getElementById('qc-menu')?.classList.remove('open');
    document.getElementById('notif-panel')?.classList.remove('open');
    document.getElementById('user-menu')?.classList.remove('open');
    panel.classList.toggle('open');
  }
  function closeAIOnOutsideClick(e) {
    const panel = document.getElementById('ai-panel');
    const btn = document.getElementById('ai-assistant-btn');
    if (!panel || !panel.classList.contains('open')) return;
    if (panel.contains(e.target) || (btn && btn.contains(e.target))) return;
    panel.classList.remove('open');
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
  window.toggleAIAssistant = toggleAIAssistant;
  window.markAllNotificationsRead = markAllNotificationsRead;
  window.renderNewTopBar = renderNewTopBar;

  // Outside-click handlers
  document.addEventListener('click', closeQuickCreateOnOutsideClick);
  document.addEventListener('click', closeNotificationsOnOutsideClick);
  document.addEventListener('click', closeAIOnOutsideClick);

  // Cmd+K / Ctrl+K to focus search
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      const input = document.getElementById('top-search');
      if (input) input.focus();
    }
  });

  // ── Mobile rail drawer ─────────────────────────────────────────
  // The sidebar is fixed and CSS slides it off-screen on ≤768px. The
  // hamburger button adds `.open` to reveal it as an overlay drawer.
  // A backdrop dims content + closes on tap. Sidebar row clicks also
  // close the drawer so the user goes straight to the destination.
  function ensureMobileRailBackdrop() {
    if (document.getElementById('mobile-rail-backdrop')) return;
    const bd = document.createElement('div');
    bd.id = 'mobile-rail-backdrop';
    bd.className = 'mobile-rail-backdrop';
    bd.addEventListener('click', closeMobileRail);
    document.body.appendChild(bd);
  }
  function openMobileRail() {
    ensureMobileRailBackdrop();
    document.getElementById('apps-rail')?.classList.add('open');
    document.getElementById('mobile-rail-backdrop')?.classList.add('open');
    document.body.classList.add('mobile-rail-open');
  }
  function closeMobileRail() {
    document.getElementById('apps-rail')?.classList.remove('open');
    document.getElementById('mobile-rail-backdrop')?.classList.remove('open');
    document.body.classList.remove('mobile-rail-open');
  }
  function toggleMobileRail(e) {
    e?.stopPropagation();
    const isOpen = document.getElementById('apps-rail')?.classList.contains('open');
    if (isOpen) closeMobileRail(); else openMobileRail();
  }
  window.toggleMobileRail = toggleMobileRail;
  window.closeMobileRail  = closeMobileRail;

  // When the user taps a sidebar link on mobile, dismiss the drawer.
  // Delegated so it survives sidebar re-renders.
  document.addEventListener('click', (e) => {
    if (!document.body.classList.contains('mobile-rail-open')) return;
    const a = e.target.closest('.os-newchrome-row, .os-newchrome-property-row, .os-newchrome-workspace, .os-newchrome-brand-logo');
    if (a && document.getElementById('apps-rail')?.contains(a)) closeMobileRail();
  });

  // ESC closes the drawer too.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.body.classList.contains('mobile-rail-open')) closeMobileRail();
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', renderNewTopBar);
  } else {
    renderNewTopBar();
  }
})();
