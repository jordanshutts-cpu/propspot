// ============================================================
//  Prop Spot — Premium Theme Manager
//  Toggles html.theme-premium class, loads premium.css and
//  Inter font, and replaces emoji icons with clean SVGs.
//
//  Classic mode (default): exact original UI, nothing changed.
//  Premium mode:           visual upgrades + SVG icon replacement.
//
//  Toggle: window.toggleTheme()
//  Persisted to localStorage.propspot_theme = 'classic' | 'premium'
// ============================================================

(function () {

  // ── Inline SVG icon library ────────────────────────────────
  // Lucide-style icons (24×24 viewBox, stroke-based).
  function S(d) {
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + d + '</svg>';
  }

  var ICONS = {
    'inbox':          S('<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>'),
    'mail':           S('<rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>'),
    'target':         S('<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>'),
    'users':          S('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>'),
    'clipboard-list': S('<rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M12 11h4"/><path d="M12 16h4"/><path d="M8 11h.01"/><path d="M8 16h.01"/>'),
    'wrench':         S('<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>'),
    'tag':            S('<path d="M12 2H2v10l9.29 9.29c.94.94 2.48.94 3.42 0l6.58-6.58c.94-.94.94-2.48 0-3.42L12 2Z"/><path d="M7 7h.01"/>'),
    'dollar-sign':    S('<line x1="12" x2="12" y1="2" y2="22"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>'),
    'calendar':       S('<rect width="18" height="18" x="3" y="4" rx="2" ry="2"/><line x1="16" x2="16" y1="2" y2="6"/><line x1="8" x2="8" y1="2" y2="6"/><line x1="3" x2="21" y1="10" y2="10"/>'),
    'triangle-alert': S('<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>'),
    'folder-open':    S('<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>'),
    'search':         S('<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>'),
    'bell':           S('<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>'),
    'house':          S('<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>'),
    'phone':          S('<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.72 13a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 3.77 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>'),
    'camera':         S('<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>'),
    'message-square': S('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>'),
    'user':           S('<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>'),
    'book-open':      S('<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>'),
    'puzzle':         S('<path d="M19.439 7.85c-.049.322.059.648.289.878l1.568 1.568c.47.47.706 1.087.706 1.704s-.235 1.233-.706 1.704l-1.611 1.611a.98.98 0 0 1-.837.276c-.47-.07-.802-.48-.968-.925a2.501 2.501 0 1 0-3.214 3.214c.446.166.856.497.925.968a.979.979 0 0 1-.276.837l-1.61 1.61a2.404 2.404 0 0 1-1.705.707 2.402 2.402 0 0 1-1.704-.706l-1.568-1.568a1.026 1.026 0 0 0-.877-.29c-.493.074-.84.504-1.02.968a2.5 2.5 0 1 1-3.237-3.237c.464-.18.894-.527.967-1.02a1.026 1.026 0 0 0-.289-.877l-1.568-1.568A2.402 2.402 0 0 1 1.998 12c0-.617.236-1.234.706-1.704L4.23 8.77c.24-.24.581-.353.917-.303.515.077.877.528 1.073 1.01a2.5 2.5 0 1 0 3.259-3.259c-.482-.196-.933-.558-1.01-1.073-.05-.336.062-.676.303-.917l1.525-1.525A2.402 2.402 0 0 1 12 1.998c.617 0 1.234.236 1.704.706l1.568 1.568c.23.23.556.338.877.29.493-.074.84-.504 1.02-.968a2.5 2.5 0 1 1 3.237 3.237c-.464.18-.894.527-.967 1.02z"/>'),
    'hammer':         S('<path d="m15 12-8.5 8.5c-.83.83-2.17.83-3 0 0 0 0 0 0 0a2.12 2.12 0 0 1 0-3L12 9"/><path d="M17.64 15 22 10.64"/><path d="m20.91 11.7-1.25-1.25c-.6-.6-.93-1.4-.93-2.25v-.86L16.01 4.6a5.56 5.56 0 0 0-3.94-1.64H9l.92.82A6.18 6.18 0 0 1 12 8.4v1.56l2 2h2.47l2.26 1.91"/>'),
    'briefcase':      S('<rect width="20" height="14" x="2" y="7" rx="2" ry="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>'),
    'banknote':       S('<rect width="20" height="12" x="2" y="6" rx="2"/><circle cx="12" cy="12" r="2"/><path d="M6 12h.01M18 12h.01"/>'),
    'package':        S('<path d="m7.5 4.27 9 5.15"/><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>'),
    'skull':          S('<path d="m12.5 17-.5-1-.5 1h1z"/><path d="M15 22a1 1 0 0 0 1-1v-1a2 2 0 0 0 1.56-3.25 8 8 0 1 0-11.12 0A2 2 0 0 0 8 20v1a1 1 0 0 0 1 1z"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="12" r="1"/>'),
    'bar-chart-2':    S('<line x1="18" x2="18" y1="20" y2="10"/><line x1="12" x2="12" y1="20" y2="4"/><line x1="6" x2="6" y1="20" y2="14"/>'),
    'globe':          S('<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>'),
    'receipt':        S('<path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z"/><path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8"/><path d="M12 17.5v-11"/>'),
    'refresh-cw':     S('<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>'),
    'at-sign':        S('<circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-3.92 7.94"/>'),
    'check-circle':   S('<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>'),
    'sparkles':       S('<path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/><path d="M5 3v4"/><path d="M19 17v4"/><path d="M3 5h4"/><path d="M17 19h4"/>'),
    'sun-moon':       S('<path d="M12 8a2.83 2.83 0 0 0 4 4 4 4 0 1 1-4-4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.9 4.9 1.4 1.4"/><path d="m17.7 17.7 1.4 1.4"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.3 17.7-1.4 1.4"/><path d="m19.1 4.9-1.4 1.4"/>'),
  };

  // ── Emoji → icon name map ──────────────────────────────────
  var EMOJI_MAP = {
    // Dashboard pipeline
    '\uD83D\uDCE5': 'inbox',          // 📥
    '\uD83C\uDFAF': 'target',         // 🎯
    '\uD83E\uDD1D': 'users',          // 🤝
    '\uD83D\uDCDD': 'clipboard-list', // 📝
    '\uD83D\uDD27': 'wrench',         // 🔧
    '\uD83C\uDFF7\uFE0F': 'tag',      // 🏷️
    // Dashboard holdings
    '\uD83D\uDCB5': 'dollar-sign',    // 💵
    '\uD83D\uDCC5': 'calendar',       // 📅
    '\u26A0\uFE0F': 'triangle-alert', // ⚠️
    '\uD83D\uDCC2': 'folder-open',    // 📂
    // Sidebar - For you
    '\uD83D\uDCE7': 'mail',           // 📧
    '@':            'at-sign',
    '\u2713':       'check-circle',   // ✓
    '\u2714':       'check-circle',   // ✔
    // Sidebar - Pipeline
    '\uD83D\uDCDE': 'phone',          // 📞
    '\uD83D\uDCCB': 'clipboard-list', // 📋
    '\uD83D\uDD28': 'hammer',         // 🔨
    '\uD83D\uDCBC': 'briefcase',      // 💼
    '\uD83D\uDCB0': 'banknote',       // 💰
    '\uD83D\uDCE6': 'package',        // 📦
    '\uD83D\uDC80': 'skull',          // 💀
    // Sidebar - Tools
    '\uD83D\uDCF8': 'camera',         // 📸
    '\uD83D\uDEE0\uFE0F': 'wrench',   // 🛠️
    '\uD83D\uDCAC': 'message-square', // 💬
    '\uD83D\uDCCA': 'bar-chart-2',    // 📊
    // Sidebar - Soon
    '\uD83C\uDF10': 'globe',          // 🌐
    '\uD83C\uDFDA\uFE0F': 'house',    // 🏚️
    '\uD83E\uDDE7': 'receipt',        // 🧾 (memo)
    '\uD83D\uDD04': 'refresh-cw',     // 🔄
    // Topbar
    '\uD83D\uDD0D': 'search',         // 🔍
    '\uD83D\uDD14': 'bell',           // 🔔
    // QC menu / general
    '\uD83C\uDFE0': 'house',          // 🏠
    '\uD83C\uDFE1': 'house',          // 🏡
    '\uD83E\uDDF9': 'puzzle',         // 🧩
    '\uD83D\uDC64': 'user',           // 👤
    '\uD83D\uDCC7': 'book-open',      // 📇
    '\uD83C\uDFDB\uFE0F': 'book-open',// 🏛️
  };

  // ── State helpers ──────────────────────────────────────────
  function isPremium() {
    try { return localStorage.getItem('propspot_theme') === 'premium'; }
    catch (e) { return false; }
  }

  // ── CSS injection ──────────────────────────────────────────
  function ensurePremiumCSS() {
    if (document.getElementById('premium-css-link')) return;
    var link = document.createElement('link');
    link.id   = 'premium-css-link';
    link.rel  = 'stylesheet';
    link.href = '/premium.css';
    document.head.appendChild(link);
  }

  function ensureInterFont() {
    if (document.getElementById('inter-font-link')) return;
    var link = document.createElement('link');
    link.id   = 'inter-font-link';
    link.rel  = 'stylesheet';
    link.href = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap';
    document.head.appendChild(link);
  }

  // ── Apply / remove theme ───────────────────────────────────
  function applyTheme() {
    if (isPremium()) {
      ensurePremiumCSS();
      ensureInterFont();
      document.documentElement.classList.add('theme-premium');
    } else {
      document.documentElement.classList.remove('theme-premium');
    }
    updateToggleButton();
  }

  // ── Emoji → SVG replacement ────────────────────────────────
  // Replaces emoji text in specific containers with inline SVGs.
  // Stores the original emoji in data-premium-emoji for restoration.

  function iconForEmoji(text) {
    var trimmed = (text || '').trim();
    var name = EMOJI_MAP[trimmed];
    return (name && ICONS[name]) ? ICONS[name] : null;
  }

  function replaceIconEl(el) {
    // Already replaced — skip.
    if (el.dataset.premiumEmoji !== undefined) return;
    var icon = iconForEmoji(el.textContent);
    if (!icon) return;
    el.dataset.premiumEmoji = el.textContent.trim();
    el.innerHTML = icon;
  }

  function replaceEmojisIn(root) {
    if (!isPremium()) return;
    root = root || document;

    // 1. Simple single-emoji containers
    var simpleSelectors = [
      '.stage-icon',
      '.app-icon',
      '.os-newchrome-row-icon',
      '.os-newchrome-search-icon',
      '.nav-icon'
    ];
    simpleSelectors.forEach(function (sel) {
      root.querySelectorAll(sel).forEach(replaceIconEl);
    });

    // 2. Quick-create menu item icon spans
    root.querySelectorAll('.os-newchrome-qc-item > span').forEach(replaceIconEl);

    // 3. Bell button — has a text node + badge child; handle separately
    var bellBtn = root.querySelector ? root.querySelector('.os-newchrome-bell') : null;
    if (bellBtn) {
      // Avoid re-processing
      if (!bellBtn.dataset.premiumBell) {
        var replaced = false;
        bellBtn.childNodes.forEach(function (node) {
          if (replaced) return;
          if (node.nodeType === Node.TEXT_NODE) {
            var icon = iconForEmoji(node.textContent);
            if (icon) {
              var span = document.createElement('span');
              span.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;';
              span.innerHTML = icon;
              bellBtn.insertBefore(span, node);
              node.textContent = '';
              bellBtn.dataset.premiumBell = '1';
              replaced = true;
            }
          }
        });
      }
    }
  }

  // ── Restore emojis (classic → premium round-trip) ──────────
  // Simply re-renders sidebar + topbar (they rebuild HTML from scratch).
  // Static dashboard stage icons need manual restore via data-premium-emoji.
  function restoreEmojis() {
    // Restore static stage/app icons
    document.querySelectorAll('[data-premium-emoji]').forEach(function (el) {
      el.textContent = el.dataset.premiumEmoji;
      delete el.dataset.premiumEmoji;
    });
    // Restore bell
    var bellBtn = document.querySelector('.os-newchrome-bell');
    if (bellBtn && bellBtn.dataset.premiumBell) {
      delete bellBtn.dataset.premiumBell;
      // Re-render topbar to get fresh HTML
      if (typeof window.renderNewTopBar === 'function') window.renderNewTopBar();
    }
    // Re-render sidebar (re-creates all nav rows with emoji text)
    if (typeof window.renderNewSidebar === 'function') window.renderNewSidebar();
  }

  // ── Toggle button state ────────────────────────────────────
  function updateToggleButton() {
    var btn = document.getElementById('theme-toggle-btn');
    if (!btn) return;
    if (isPremium()) {
      btn.title = 'Switch to classic theme';
      btn.style.opacity = '1';
    } else {
      btn.title = 'Switch to premium theme';
      btn.style.opacity = '0.6';
    }
  }

  // ── Public toggle ──────────────────────────────────────────
  function toggleTheme() {
    var next = isPremium() ? 'classic' : 'premium';
    try { localStorage.setItem('propspot_theme', next); } catch (e) {}

    if (next === 'premium') {
      applyTheme();
      // Small delay so premium.css is parsed before we inject SVGs
      setTimeout(function () { replaceEmojisIn(document); }, 60);
    } else {
      applyTheme();
      restoreEmojis();
    }
  }

  // ── Observe sidebar / topbar re-renders ───────────────────
  // sidebar.js and topbar.js inject new HTML into these containers.
  // After each injection, re-apply icon replacement if premium is on.
  function observeChrome() {
    var targets = ['apps-rail', 'top-header'].map(function (id) {
      return document.getElementById(id);
    }).filter(Boolean);

    if (!targets.length) return;

    var debounce = null;
    var obs = new MutationObserver(function () {
      if (!isPremium()) return;
      clearTimeout(debounce);
      debounce = setTimeout(function () { replaceEmojisIn(document); }, 80);
    });
    targets.forEach(function (t) {
      obs.observe(t, { childList: true, subtree: true });
    });
  }

  // ── Expose public API ──────────────────────────────────────
  window.toggleTheme       = toggleTheme;
  window.__isPremiumTheme  = isPremium;
  window.__replaceEmojisIn = replaceEmojisIn;

  // ── Init ───────────────────────────────────────────────────
  // Apply class immediately (before paint) to avoid flash.
  applyTheme();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      observeChrome();
      if (isPremium()) replaceEmojisIn(document);
    });
  } else {
    observeChrome();
    if (isPremium()) replaceEmojisIn(document);
  }

})();
