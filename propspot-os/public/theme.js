// ============================================================
//  Prop Spot — Theme Manager
//  Toggles html.theme-dark class and replaces emoji icons
//  with clean inline SVGs across the entire app.
//
//  Emoji → SVG replacement runs unconditionally for all users
//  (including dynamically-rendered content via MutationObserver).
//
//  Toggle: window.toggleTheme()
//  Persisted to localStorage.propspot_theme = 'premium' | 'dark'
// ============================================================

(function () {

  // ── Inline SVG icon library ────────────────────────────────
  // Lucide-style icons (24×24 viewBox, stroke-based, 2px stroke).
  function S(d) {
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + d + '</svg>';
  }

  var ICONS = {
    'inbox':          S('<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>'),
    'paperclip':      S('<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 17.93 8.8l-8.58 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>'),
    'trash':          S('<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>'),
    'archive':        S('<rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>'),
    'ban':            S('<circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>'),
    'moon':           S('<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>'),
    'reply':          S('<polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/>'),
    'forward':        S('<polyline points="15 17 20 12 15 7"/><path d="M4 18v-2a4 4 0 0 1 4-4h12"/>'),
    'pencil':         S('<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>'),
    'pen-line':       S('<path d="M12 20h9"/><path d="M16.376 3.622a1 1 0 0 1 3.002 3.002L7.368 18.635a2 2 0 0 1-.855.506l-2.872.838a.5.5 0 0 1-.62-.62l.838-2.872a2 2 0 0 1 .506-.854z"/>'),
    'link':           S('<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>'),
    'rotate-ccw':     S('<polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>'),
    'expand':         S('<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/>'),
    'x':              S('<line x1="18" x2="6" y1="6" y2="18"/><line x1="6" x2="18" y1="6" y2="18"/>'),
    'x-circle':       S('<circle cx="12" cy="12" r="10"/><line x1="15" x2="9" y1="9" y2="15"/><line x1="9" x2="15" y1="9" y2="15"/>'),
    'alarm-clock':    S('<circle cx="12" cy="13" r="8"/><path d="M5 3 2 6"/><path d="m22 6-3-3"/><path d="M6.38 18.7 4 21"/><path d="M17.64 18.67 20 21"/><path d="m9 13 2 2 4-4"/>'),
    'settings':       S('<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>'),
    'chevron-down':   S('<polyline points="6 9 12 15 18 9"/>'),
    'chevron-right':  S('<polyline points="9 18 15 12 9 6"/>'),
    'chevron-up':     S('<polyline points="18 15 12 9 6 15"/>'),
    'plus':           S('<line x1="12" x2="12" y1="5" y2="19"/><line x1="5" x2="19" y1="12" y2="12"/>'),
    'arrow-down':     S('<line x1="12" x2="12" y1="5" y2="19"/><polyline points="19 12 12 19 5 12"/>'),
    'arrow-right':    S('<line x1="5" x2="19" y1="12" y2="12"/><polyline points="12 5 19 12 12 19"/>'),
    'image':          S('<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>'),
    'pin':            S('<line x1="12" x2="12" y1="17" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"/>'),
    'eye':            S('<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/>'),
    'send':           S('<path d="M22 2 11 13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>'),
    'file-text':      S('<path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5z"/><polyline points="14 2 14 8 20 8"/><line x1="16" x2="8" y1="13" y2="13"/><line x1="16" x2="8" y1="17" y2="17"/><polyline points="10 9 9 9 8 9"/>'),
    'list':           S('<line x1="8" x2="21" y1="6" y2="6"/><line x1="8" x2="21" y1="12" y2="12"/><line x1="8" x2="21" y1="18" y2="18"/><line x1="3" x2="3.01" y1="6" y2="6"/><line x1="3" x2="3.01" y1="12" y2="12"/><line x1="3" x2="3.01" y1="18" y2="18"/>'),
    'sprout':         S('<path d="M7 20h10"/><path d="M10 20c5.5-2.5.8-6.4 3-10"/><path d="M9.5 9.4c1.1.8 1.8 2.2 2.3 3.7-2 .4-3.5.4-4.8-.3-1.2-.6-2.3-1.9-3-4.2 2.8-.5 4.4 0 5.5.8z"/><path d="M14.1 6a7 7 0 0 0-1.1 4c1.9-.1 3.3-.6 4.3-1.4 1-1 1.6-2.3 1.7-4.6-2.7.1-4 1-4.9 2z"/>'),
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
    // ── Additional icons ───────────────────────────────────────
    'hard-hat':       S('<path d="M2 18a1 1 0 0 0 1 1h18a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1H3a1 1 0 0 0-1 1v2z"/><path d="M10 10V5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v5"/><path d="M4 15v-3a8 8 0 0 1 16 0v3"/>'),
    'trees':          S('<path d="M10 10v.2A3 3 0 0 1 8.9 16H5a3 3 0 0 1-1-5.8V10a3 3 0 0 1 6 0Z"/><path d="M7 16v5"/><path d="M13 19v3"/><path d="M12 19h8.3a1 1 0 0 0 .7-1.7L18 14h.3a1 1 0 0 0 .7-1.7L16 9h.2a1 1 0 0 0 .8-1.7L13 3l-1.4 1.5"/>'),
    'droplets':       S('<path d="M7 16.3c2.2 0 4-1.83 4-4.05 0-1.16-.57-2.26-1.71-3.19S7.29 6.75 7 5.3c-.29 1.45-1.14 2.84-2.29 3.76S3 11.1 3 12.25c0 2.22 1.8 4.05 4 4.05z"/><path d="M12.56 6.6A10.97 10.97 0 0 0 14 3.02c.5 2.5 2 4.9 4 6.5s3 3.5 3 5.5a6.98 6.98 0 0 1-11.91 4.97"/>'),
    'zap':            S('<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>'),
    'lightbulb':      S('<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/>'),
    'snowflake':      S('<line x1="2" x2="22" y1="12" y2="12"/><line x1="12" x2="12" y1="2" y2="22"/><path d="m20 16-4-4 4-4"/><path d="m4 8 4 4-4 4"/><path d="m16 4-4 4-4-4"/><path d="m8 20 4-4 4 4"/>'),
    'brush':          S('<path d="m9.06 11.9 8.07-8.06a2.85 2.85 0 1 1 4.03 4.03l-8.06 8.08"/><path d="M7.07 14.94c-1.66 0-3 1.35-3 3.02 0 1.33-2.5 1.52-2 2.02 1 1 2.49 2.02 4 2.02 2.2 0 4-1.8 4-4.04a3.01 3.01 0 0 0-3-3.02z"/>'),
    'plug':           S('<path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/>'),
    'bug':            S('<rect width="8" height="14" x="8" y="6" rx="4"/><path d="m19 7-3 2"/><path d="m5 7 3 2"/><path d="m19 19-3-2"/><path d="m5 19 3-2"/><path d="M20 13h-4"/><path d="M4 13h4"/><path d="m10 4 1 2"/><path d="m14 4-1 2"/>'),
    'map-pin':        S('<path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"/><circle cx="12" cy="10" r="3"/>'),
    'map':            S('<path d="M14.106 5.553a2 2 0 0 0 1.788 0l3.659-1.83A1 1 0 0 1 21 4.619v12.764a1 1 0 0 1-.553.894l-4.553 2.277a2 2 0 0 1-1.788 0l-4.212-2.106a2 2 0 0 0-1.788 0l-3.659 1.83A1 1 0 0 1 3 19.381V6.618a1 1 0 0 1 .553-.894l4.553-2.277a2 2 0 0 1 1.788 0z"/><path d="M15 5.764v15"/><path d="M9 3.236v15"/>'),
    'printer':        S('<path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><path d="M6 9V3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v6"/><rect width="12" height="8" x="6" y="14" rx="1"/>'),
    'video':          S('<path d="m22 8-6 4 6 4V8z"/><rect width="14" height="12" x="2" y="6" rx="2" ry="2"/>'),
    'shield':         S('<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>'),
    'landmark':       S('<line x1="3" x2="21" y1="22" y2="22"/><line x1="6" x2="6" y1="18" y2="11"/><line x1="10" x2="10" y1="18" y2="11"/><line x1="14" x2="14" y1="18" y2="11"/><line x1="18" x2="18" y1="18" y2="11"/><polygon points="12 2 20 7 4 7"/>'),
    'lock':           S('<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>'),
    'alert-octagon':  S('<path d="M12 16h.01"/><path d="M12 8v4"/><path d="M15.312 2a2 2 0 0 1 1.414.586l4.688 4.688A2 2 0 0 1 22 8.688v6.624a2 2 0 0 1-.586 1.414l-4.688 4.688a2 2 0 0 1-1.414.586H8.688a2 2 0 0 1-1.414-.586l-4.688-4.688A2 2 0 0 1 2 15.312V8.688a2 2 0 0 1 .586-1.414l4.688-4.688A2 2 0 0 1 8.688 2z"/>'),
    'star':           S('<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>'),
    'award':          S('<circle cx="12" cy="8" r="6"/><path d="M15.477 12.89 17 22l-5-3-5 3 1.523-9.11"/>'),
    'navigation':     S('<polygon points="3 11 22 2 13 21 11 13 3 11"/>'),
    'download':       S('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>'),
    'upload':         S('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/>'),
    'building':       S('<rect width="16" height="20" x="4" y="2" rx="2" ry="2"/><path d="M9 22v-4h6v4"/><path d="M8 6h.01"/><path d="M16 6h.01"/><path d="M12 6h.01"/><path d="M12 10h.01"/><path d="M12 14h.01"/><path d="M16 10h.01"/><path d="M16 14h.01"/><path d="M8 10h.01"/><path d="M8 14h.01"/>'),
    'flame':          S('<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>'),
    'party-popper':   S('<path d="M5.8 11.3 2 22l10.7-3.79"/><path d="M4 3h.01"/><path d="M22 8h.01"/><path d="M15 2h.01"/><path d="M22 20h.01"/><path d="m22 2-2.24.75a2.9 2.9 0 0 0-1.96 3.12c.1.86-.57 1.63-1.45 1.63h-.38c-.86 0-1.6.6-1.76 1.44L14 10"/><path d="m22 13-.82-.33c-.86-.34-1.82.2-1.98 1.11c-.11.7-.72 1.22-1.43 1.22H17"/><path d="m11 2 .33.82c.34.86-.2 1.82-1.11 1.98C9.52 4.9 9 5.52 9 6.23V7"/><path d="M11 13c1.93 1.93 2.83 4.17 2 5-.83.83-3.07-.07-5-2-1.93-1.93-2.83-4.17-2-5 .83-.83 3.07.07 5 2z"/>'),
    'check':          S('<polyline points="20 6 9 17 4 12"/>'),
  };

  // ── Emoji → icon name map ──────────────────────────────────
  var EMOJI_MAP = {
    // Navigation & pipeline
    '📥': 'inbox',          // 📥 Prospects
    '🎯': 'target',         // 🎯 Leads
    '🤝': 'users',          // 🤝 Opportunities
    '📝': 'clipboard-list', // 📝 Under Contract
    '🔧': 'wrench',         // 🔧 Renovating
    '🏷️': 'tag',      // 🏷️ Listed/Rented
    '🏷':       'tag',      // 🏷 (no VS16)
    // Holdings categories
    '💵': 'dollar-sign',    // 💵 Income
    '📅': 'calendar',       // 📅 Dates
    '⚠️': 'triangle-alert', // ⚠️
    '⚠':       'triangle-alert', // ⚠ (no VS16)
    '📂': 'folder-open',    // 📂 Folders
    '💰': 'banknote',       // 💰 Money
    '💴': 'banknote',       // 💴
    '💶': 'banknote',       // 💶
    '🏦': 'landmark',       // 🏦 Bank
    '👻': 'skull',          // 👻 → skull
    '💀': 'skull',          // 💀
    // Contact methods
    '📧': 'mail',           // 📧 Email
    '@':            'at-sign',
    '✓':       'check-circle',   // ✓
    '✔':       'check-circle',   // ✔
    '✅':       'check-circle',   // ✅
    '❌':       'x-circle',       // ❌
    '📞': 'phone',          // 📞 Phone
    '📋': 'clipboard-list', // 📋 Clipboard
    '🔨': 'hammer',         // 🔨
    '💼': 'briefcase',      // 💼
    '📦': 'package',        // 📦
    // Tools navigation
    '📸': 'camera',         // 📸 FieldCam
    '🛠️': 'wrench',   // 🛠️ Maintenance
    '🛠':       'wrench',   // 🛠 (no VS16)
    '💬': 'message-square', // 💬 Pulse
    '📊': 'bar-chart-2',    // 📊 Underwriting
    '🌐': 'globe',          // 🌐 Website
    '🏚️': 'house',    // 🏚️
    '🏚':       'house',    // 🏚 (no VS16)
    '🧧': 'receipt',        // 🧾
    '🔄': 'refresh-cw',     // 🔄 Refresh/Optimize Route
    // Topbar
    '🔍': 'search',         // 🔍 Search
    '🔔': 'bell',           // 🔔 Notifications
    // Real estate / properties
    '🏠': 'house',          // 🏠
    '🏡': 'house',          // 🏡
    '🏘️': 'building', // 🏘️ Houses
    '🏘':       'building', // 🏘 (no VS16)
    '🏗️': 'hard-hat', // 🏗️ Construction
    '🏗':       'hard-hat', // 🏗 (no VS16)
    // People
    '🧹': 'puzzle',         // 🧩
    '👤': 'user',           // 👤
    '👥': 'users',          // 👥
    '📇': 'book-open',      // 📇 Contacts
    '🏛️': 'landmark', // 🏛️
    '🏛':       'landmark', // 🏛 (no VS16)
    // Inbox / messaging
    '📬': 'inbox',          // 📬
    '📫': 'inbox',          // 📫
    '📭': 'inbox',          // 📭 Empty mailbox
    '📨': 'mail',           // 📨 Incoming mail
    '📁': 'folder-open',    // 📁
    '📎': 'paperclip',      // 📎
    '🗑️': 'trash',    // 🗑️
    '🗑':       'trash',    // 🗑 (no VS16)
    '🚫': 'ban',            // 🚫
    '😴': 'moon',           // 😴
    '⏰':       'alarm-clock',    // ⏰
    '📩': 'arrow-down',     // 📩 Envelope with arrow
    '↩️': 'reply',          // ↩️
    '↩':       'reply',          // ↩ (no VS16)
    '↪️': 'forward',        // ↪️
    '↪':       'forward',        // ↪ (no VS16)
    '✏️': 'pencil',         // ✏️
    '✏':       'pencil',         // ✏ (no VS16)
    '🖋️': 'pen-line',       // 🖋️ Fountain pen (Ink'd app)
    '🖋':       'pen-line',       // 🖋 (no VS16)
    '🖊️': 'pen-line',       // 🖊️ Ballpoint pen
    '🖊':       'pen-line',       // 🖊 (no VS16)
    '✒️':       'pen-line',       // ✒️ Black nib
    '✒':       'pen-line',       // ✒ (no VS16)
    '🔗': 'link',           // 🔗
    '↻':       'rotate-ccw',     // ↻
    '⤢':       'expand',         // ⤢
    '✕':       'x',              // ✕
    '✖':       'x',              // ✖
    '✖️': 'x',              // ✖️
    '⚙️': 'settings',       // ⚙️
    '⚙':       'settings',       // ⚙ (no VS16)
    '▾':       'chevron-down',   // ▾
    '▸':       'chevron-right',  // ▸
    '▴':       'chevron-up',     // ▴
    '↓':       'arrow-down',     // ↓
    '→':       'arrow-right',    // →
    '👋': 'user',           // 👋 Wave → user
    // Files
    '📜': 'list',           // 📜 Scroll
    '📄': 'file-text',      // 📄 Document
    '🖼️': 'image',    // 🖼️
    '🖼':       'image',    // 🖼 (no VS16)
    '📌': 'pin',            // 📌
    '👁️': 'eye',      // 👁️
    '👁':       'eye',      // 👁 (no VS16)
    '📤': 'upload',         // 📤 Outbox
    '🌱': 'sprout',         // 🌱 Seedling
    // Maintenance categories
    '🌳': 'trees',          // 🌳 Tree/Landscaping
    '🌲': 'trees',          // 🌲 Tree
    '🚿': 'droplets',       // 🚿 Shower/Plumbing
    '💧': 'droplets',       // 💧 Water
    '💡': 'lightbulb',      // 💡 Electrical
    '⚡️': 'zap',            // ⚡️
    '⚡':       'zap',            // ⚡ (no VS16)
    '❄️': 'snowflake',      // ❄️ HVAC
    '❄':       'snowflake',      // ❄ (no VS16)
    '🧹': 'brush',          // 🧹 Cleaning (NOTE: reuses key - cleaned in map order)
    '🧹': 'brush',          // 🧹
    '🔌': 'plug',           // 🔌 Appliance
    '🐜': 'bug',            // 🐜 Pest
    '🐛': 'bug',            // 🐛 Bug
    '😨': 'alert-octagon',  // 😨 → alert
    '🚨': 'alert-octagon',  // 🚨 Urgent
    // Location
    '📍': 'map-pin',        // 📍 Location pin
    '🗺️': 'map',      // 🗺️ Map
    '🗺':       'map',      // 🗺 (no VS16)
    // Celebration / empty states
    '🎉': 'sparkles',       // 🎉 Party popper
    '🔥': 'zap',            // 🔥 Fire (non-reaction context)
    // Other UI chrome
    '🖨️': 'printer',  // 🖨️
    '🖨':       'printer',  // 🖨 (no VS16)
    '📹': 'video',          // 📹 Video
    '🎥': 'video',          // 🎥 Camera
    '🛡️': 'shield',   // 🛡️ Shield/Insurance
    '🛡':       'shield',   // 🛡 (no VS16)
    '🔒': 'lock',           // 🔒 Lock
    '🏆': 'award',          // 🏆 Trophy
    '⭐':       'star',           // ⭐ Star
    '🌟': 'star',           // 🌟 Star
    '✨':       'sparkles',       // ✨ Sparkles
    '🚀': 'navigation',     // 🚀 Rocket → navigation
    '📣': 'bell',           // 📣 Megaphone → bell
    '📢': 'bell',           // 📢 Loudspeaker → bell
    '🌞': 'sun-moon',       // 🌞 Sun
    '🗄️': 'archive',  // 🗄️ File cabinet/archive
    '🗄':       'archive',  // 🗄 (no VS16)
    '💸': 'banknote',       // 💸 Flying money
    '💳': 'banknote',       // 💳 Credit card
    '👍': 'check-circle',   // 👍 Thumbs up (in UI context)
  };

  // ── State helpers ──────────────────────────────────────────
  function getTheme() {
    try {
      var t = localStorage.getItem('propspot_theme');
      if (t === 'classic' || !t) {
        t = 'premium';
        try { localStorage.setItem('propspot_theme', t); } catch (e) {}
      }
      return t;
    } catch (e) { return 'premium'; }
  }
  function isPremium() { var t = getTheme(); return t === 'premium' || t === 'dark'; }
  function isDark()    { return getTheme() === 'dark'; }

  // ── CSS injection ──────────────────────────────────────────
  function ensurePremiumCSS() {
    if (document.getElementById('premium-css-link')) return;
    var link = document.createElement('link');
    link.id   = 'premium-css-link';
    link.rel  = 'stylesheet';
    link.href = '/premium.css';
    document.head.appendChild(link);
  }
  function ensureDarkCSS() {
    if (document.getElementById('dark-css-link')) return;
    var link = document.createElement('link');
    link.id   = 'dark-css-link';
    link.rel  = 'stylesheet';
    link.href = '/dark.css';
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
    // Premium CSS + Inter always load (premium is the only theme).
    ensurePremiumCSS();
    ensureInterFont();
    document.documentElement.classList.add('theme-premium');
    if (isDark()) {
      ensureDarkCSS();
      document.documentElement.classList.add('theme-dark');
    } else {
      document.documentElement.classList.remove('theme-dark');
    }
    updateToggleButton();
  }

  // ── Emoji → SVG replacement ────────────────────────────────
  // Runs unconditionally — emojis are always replaced with SVGs.

  function iconForEmoji(text) {
    var trimmed = (text || '').trim();
    var name = EMOJI_MAP[trimmed];
    return (name && ICONS[name]) ? ICONS[name] : null;
  }

  function replaceIconEl(el) {
    if (el.dataset.premiumEmoji !== undefined) return;
    var icon = iconForEmoji(el.textContent);
    if (!icon) return;
    el.dataset.premiumEmoji = el.textContent.trim();
    el.innerHTML = icon;
  }

  // Classes the scanner must NOT touch (these are styled separately
  // or contain intentional emoji content like reaction buttons).
  var SCAN_SKIP_CLASSES = [
    'ib-inbox-icon', 'ib-filter-icon', 'user-menu-icon',
    'os-newchrome-step-dot', 'pipe-row-del', 'premium-icon-skip',
    'pulse-reaction-btn', 'pulse-reaction-emoji', 'emoji-picker-btn',
    'pulse-quick-react', 'reaction-emoji', 'emoji-react',
  ];

  // ── Emoji-prefix scanner ───────────────────────────────────
  // Handles "🔨 Projects" style text nodes — splits the emoji off into
  // a sibling <span class="premium-emoji-prefix"> with an inline SVG.
  function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  var _emojiPrefixRegex = null;
  function emojiPrefixRegex() {
    if (_emojiPrefixRegex) return _emojiPrefixRegex;
    var keys = Object.keys(EMOJI_MAP).sort(function (a, b) { return b.length - a.length; });
    _emojiPrefixRegex = new RegExp('^(' + keys.map(escapeRegExp).join('|') + ')(\\s+|$)');
    return _emojiPrefixRegex;
  }

  function scanForEmojiPrefixes(root) {
    if (!root || !root.querySelectorAll) return;
    var SKIP_TAGS = { SCRIPT:1, STYLE:1, NOSCRIPT:1, IFRAME:1, INPUT:1, TEXTAREA:1, SELECT:1, OPTION:1 };
    var regex = emojiPrefixRegex();
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        var p = n.parentNode;
        if (!p || SKIP_TAGS[p.tagName]) return NodeFilter.FILTER_REJECT;
        if (p.dataset && p.dataset.premiumEmoji !== undefined) return NodeFilter.FILTER_REJECT;
        for (var c = 0; c < SCAN_SKIP_CLASSES.length; c++) {
          if (p.classList && p.classList.contains(SCAN_SKIP_CLASSES[c])) return NodeFilter.FILTER_REJECT;
        }
        // Also skip if any ancestor has a skip class (for nested reaction components)
        var anc = p.parentNode;
        while (anc && anc !== root) {
          for (var d = 0; d < SCAN_SKIP_CLASSES.length; d++) {
            if (anc.classList && anc.classList.contains(SCAN_SKIP_CLASSES[d])) return NodeFilter.FILTER_REJECT;
          }
          anc = anc.parentNode;
        }
        if (!n.nodeValue || n.nodeValue.length < 2) return NodeFilter.FILTER_SKIP;
        if (!regex.test(n.nodeValue)) return NodeFilter.FILTER_SKIP;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    var nodes = [];
    var n;
    while ((n = walker.nextNode())) nodes.push(n);
    nodes.forEach(function (textNode) {
      var m = regex.exec(textNode.nodeValue);
      if (!m) return;
      var emoji = m[1];
      var iconName = EMOJI_MAP[emoji];
      if (!iconName || !ICONS[iconName]) return;
      textNode.nodeValue = textNode.nodeValue.slice(m[0].length);
      var span = document.createElement('span');
      span.className = 'premium-emoji-prefix';
      span.dataset.premiumEmoji = emoji;
      span.dataset.premiumPrefix = '1';
      span.innerHTML = ICONS[iconName];
      textNode.parentNode.insertBefore(span, textNode);
    });
  }

  function scanForEmojiLeaves(root) {
    if (!root || !root.querySelectorAll) return;
    var SKIP_TAGS = { SCRIPT:1, STYLE:1, NOSCRIPT:1, IFRAME:1, INPUT:1, TEXTAREA:1, SELECT:1, OPTION:1 };
    var els = root.querySelectorAll('span, button, a, div, h1, h2, h3, h4, h5, li, td, th, i');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (el.children.length > 0) continue;
      if (SKIP_TAGS[el.tagName]) continue;
      if (el.dataset && el.dataset.premiumEmoji !== undefined) continue;
      var skipByClass = false;
      for (var c = 0; c < SCAN_SKIP_CLASSES.length; c++) {
        if (el.classList && el.classList.contains(SCAN_SKIP_CLASSES[c])) { skipByClass = true; break; }
      }
      if (skipByClass) continue;
      var t = (el.textContent || '').trim();
      if (!t || t.length > 4) continue;
      if (iconForEmoji(t)) replaceIconEl(el);
    }
  }

  function replaceEmojisIn(root) {
    root = root || document;

    // 1. Simple single-emoji containers (fast path)
    var simpleSelectors = [
      '.stage-icon', '.app-icon', '.os-newchrome-row-icon',
      '.os-newchrome-search-icon', '.nav-icon'
    ];
    simpleSelectors.forEach(function (sel) {
      root.querySelectorAll(sel).forEach(replaceIconEl);
    });

    // 2. Quick-create menu item icon spans
    root.querySelectorAll('.os-newchrome-qc-item > span').forEach(replaceIconEl);

    // 3. Catch-all leaf scan
    scanForEmojiLeaves(root === document ? document.body : root);

    // 4. Inline prefix scan ("💼 Holdings" → SVG + "Holdings")
    scanForEmojiPrefixes(root === document ? document.body : root);

    // 5. Bell button (mixed text node + badge child)
    var bellBtn = root.querySelector ? root.querySelector('.os-newchrome-bell') : null;
    if (bellBtn && !bellBtn.dataset.premiumBell) {
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

  // ── Restore emojis (for dev/toggle use) ───────────────────
  function restoreEmojis() {
    document.querySelectorAll('.premium-emoji-prefix[data-premium-prefix="1"]').forEach(function (el) {
      var emoji = el.dataset.premiumEmoji;
      var sibling = el.nextSibling;
      if (sibling && sibling.nodeType === Node.TEXT_NODE) {
        sibling.nodeValue = emoji + ' ' + sibling.nodeValue;
      } else {
        el.parentNode.insertBefore(document.createTextNode(emoji + ' '), el);
      }
      el.remove();
    });
    document.querySelectorAll('[data-premium-emoji]').forEach(function (el) {
      el.textContent = el.dataset.premiumEmoji;
      delete el.dataset.premiumEmoji;
    });
    var bellBtn = document.querySelector('.os-newchrome-bell');
    if (bellBtn && bellBtn.dataset.premiumBell) {
      delete bellBtn.dataset.premiumBell;
      if (typeof window.renderNewTopBar === 'function') window.renderNewTopBar();
    }
    if (typeof window.renderNewSidebar === 'function') window.renderNewSidebar();
  }

  // ── Toggle button state ────────────────────────────────────
  function updateToggleButton() {
    var btn = document.getElementById('theme-toggle-btn');
    if (!btn) return;
    btn.title = isDark() ? 'Switch to light theme' : 'Switch to dark theme';
    btn.style.opacity = '1';
  }

  // ── Public toggle / setter ─────────────────────────────────
  function toggleTheme() {
    setTheme(isDark() ? 'premium' : 'dark');
  }
  function setTheme(next) {
    if (next === 'classic') next = 'premium';
    if (!['premium','dark'].includes(next)) return;
    try { localStorage.setItem('propspot_theme', next); } catch (e) {}
    applyTheme();
    setTimeout(function () { replaceEmojisIn(document); }, 60);
  }

  // ── MutationObserver: watch the ENTIRE body ────────────────
  // Catches dynamic content injected by any component, not just
  // sidebar/topbar. Debounced to avoid thrashing on large renders.
  function observeChrome() {
    var body = document.body;
    if (!body) return;

    var debounce = null;
    var obs = new MutationObserver(function (mutations) {
      clearTimeout(debounce);
      debounce = setTimeout(function () {
        // Only scan the nodes that were actually added, not the whole document.
        mutations.forEach(function (m) {
          m.addedNodes.forEach(function (node) {
            if (node.nodeType !== Node.ELEMENT_NODE) return;
            // Skip nodes that are inside skip-class ancestors
            replaceEmojisIn(node);
          });
        });
        // Also re-scan known chrome areas that do full re-renders
        var rail = document.getElementById('apps-rail');
        var topbar = document.getElementById('top-header');
        if (rail)   replaceEmojisIn(rail);
        if (topbar) replaceEmojisIn(topbar);
      }, 80);
    });
    obs.observe(body, { childList: true, subtree: true });
  }

  // ── Expose public API ──────────────────────────────────────
  window.toggleTheme       = toggleTheme;
  window.setTheme          = setTheme;
  window.__getTheme        = getTheme;
  window.__isPremiumTheme  = isPremium;
  window.__isDarkTheme     = isDark;
  window.__replaceEmojisIn = replaceEmojisIn;

  // ── Init ───────────────────────────────────────────────────
  applyTheme();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      replaceEmojisIn(document);
      observeChrome();
    });
  } else {
    replaceEmojisIn(document);
    observeChrome();
  }

})();
