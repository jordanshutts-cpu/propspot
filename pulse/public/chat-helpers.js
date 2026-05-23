/* eslint-disable no-undef */
/* ──────────────────────────────────────────────────────────────────
   chat-helpers.js — Pulse v2 chat utilities.

   Loaded by chat.html AFTER app.js (which provides escHtml, apiFetch,
   showToast, formatTime, avatarInitial, getToken, getCachedUser).

   Provides:
   - sanitizeHtml(html)            — DOMPurify wrapper with allowlist
   - formatDateDivider(iso)        — Today / Yesterday / weekday / date
   - sameDay(isoA, isoB)           — true if both timestamps are same day
   - requestNotificationPermission() — one-time prompt, cached
   - notify(title, body)           — fire browser notification if granted
   - bytesHuman(n)                 — "1.2 MB"
   - extractMentionUids(html)      — pull data-uid values out of HTML
   - getMentionBlot(Quill)         — Quill blot for the mention pill
   - setupAttachmentTray(opts)     — pre-send attachment chip tray
   - setupMentionPopover(opts)     — @-typing popover for Quill
   ────────────────────────────────────────────────────────────────── */

// ── HTML sanitization ─────────────────────────────────────────────
// Only allow inline-formatting tags + the mention span. Everything else
// gets stripped. DOMPurify must already be loaded from the CDN.
const ALLOWED_TAGS = ['p','br','b','i','u','s','em','strong','code','pre',
                      'blockquote','ol','ul','li','a','span'];
const ALLOWED_ATTR = ['href','target','rel','class','data-uid'];

function sanitizeHtml(html) {
  if (!html) return '';
  if (typeof DOMPurify === 'undefined') return String(html);
  const clean = DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOW_DATA_ATTR: true
  });
  // Force external links to safe targets
  return clean.replace(/<a\s/g, '<a target="_blank" rel="noopener noreferrer" ');
}

// ── Date helpers ──────────────────────────────────────────────────
function sameDay(a, b) {
  const da = new Date(a), db = new Date(b);
  return da.getFullYear() === db.getFullYear()
      && da.getMonth()    === db.getMonth()
      && da.getDate()     === db.getDate();
}

function formatDateDivider(iso) {
  const d = new Date(iso);
  const now = new Date();
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  if (sameDay(d, now))        return 'Today';
  if (sameDay(d, yesterday))  return 'Yesterday';
  // Within last 6 days → weekday name
  const sixDaysAgo = new Date(now); sixDaysAgo.setDate(now.getDate() - 6);
  if (d >= sixDaysAgo) return d.toLocaleDateString(undefined, { weekday: 'long' });
  // Same year → "Mon, May 19"
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  }
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

// ── Browser notifications ─────────────────────────────────────────
let _notifPermAsked = false;
async function requestNotificationPermission() {
  if (!('Notification' in window)) return 'denied';
  if (Notification.permission === 'granted') return 'granted';
  if (Notification.permission === 'denied')  return 'denied';
  if (_notifPermAsked) return Notification.permission;
  _notifPermAsked = true;
  try { return await Notification.requestPermission(); } catch { return 'denied'; }
}

function notify(title, body) {
  if (!('Notification' in window))       return;
  if (Notification.permission !== 'granted') return;
  if (document.visibilityState === 'visible') return; // tab is focused; skip
  try { new Notification(title, { body, icon: '/logo.png' }); } catch {}
}

// ── Misc helpers ─────────────────────────────────────────────────
function bytesHuman(n) {
  if (n == null) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

function extractMentionUids(html) {
  if (!html) return [];
  const re = /data-uid="([0-9a-fA-F-]{36})"/g;
  const out = new Set();
  let m;
  while ((m = re.exec(html)) !== null) out.add(m[1]);
  return Array.from(out);
}

// ── Quill: register the mention blot ──────────────────────────────
// Registered ONCE on first call. The mention pill renders as
//   <span class="pulse-mention" data-uid="UUID">@Name</span>
function registerMentionBlot(Quill) {
  if (registerMentionBlot._done) return;
  const Embed = Quill.import('blots/embed');
  class MentionBlot extends Embed {
    static create(data) {
      const node = super.create();
      node.setAttribute('class', 'pulse-mention');
      node.setAttribute('data-uid', data.uid);
      node.setAttribute('contenteditable', 'false');
      node.textContent = '@' + (data.name || '');
      return node;
    }
    static value(node) {
      return { uid: node.getAttribute('data-uid'), name: (node.textContent || '').replace(/^@/, '') };
    }
  }
  MentionBlot.blotName = 'mention';
  MentionBlot.tagName = 'span';
  Quill.register(MentionBlot);
  registerMentionBlot._done = true;
}

// ── Attachment tray ───────────────────────────────────────────────
// Manages the chip strip between the toolbar and the editor. Returns
// { addFiles, clear, getAttachments, count } so the composer can wire
// the file input + drag-drop into it.
function setupAttachmentTray({ trayEl, dropEl, onError }) {
  const items = []; // [{ id, name, status, mime, size, url, cloudinary_id }]

  function render() {
    trayEl.innerHTML = '';
    for (const it of items) {
      const chip = document.createElement('div');
      chip.className = 'pulse-attach-chip' + (it.status === 'uploading' ? ' uploading' : '');
      const isImage = it.mime && it.mime.startsWith('image/');
      const inner = isImage && it.url
        ? `<img class="thumb" src="${it.url}" alt="">`
        : `<div class="icon">${fileIcon(it.mime)}</div>`;
      chip.innerHTML = `
        ${inner}
        <div class="name" title="${escHtml(it.name)}">${escHtml(it.name)}</div>
        <button type="button" class="remove" data-id="${it.id}" title="Remove">×</button>
      `;
      trayEl.appendChild(chip);
    }
    trayEl.querySelectorAll('.remove').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.id;
        const idx = items.findIndex(x => x.id === id);
        if (idx >= 0) items.splice(idx, 1);
        render();
      });
    });
  }

  async function addFiles(fileList) {
    const files = Array.from(fileList || []);
    for (const f of files) {
      if (items.length >= 10) {
        onError && onError('Up to 10 attachments per message');
        break;
      }
      const id = Math.random().toString(36).slice(2);
      const placeholder = {
        id, name: f.name, mime: f.type, size: f.size,
        status: 'uploading', url: null, cloudinary_id: null
      };
      items.push(placeholder);
      render();
      try {
        const fd = new FormData();
        fd.append('file', f);
        const res = await apiFetch('/api/pulse/attachments', { method: 'POST', body: fd });
        Object.assign(placeholder, {
          status: 'done',
          url: res.url,
          cloudinary_id: res.cloudinary_id,
          mime: res.mime_type,
          size: res.size_bytes,
          name: res.filename || placeholder.name
        });
      } catch (err) {
        const idx = items.findIndex(x => x.id === id);
        if (idx >= 0) items.splice(idx, 1);
        onError && onError(err.message || 'Upload failed');
      }
      render();
    }
  }

  function clear() { items.length = 0; render(); }
  function getAttachments() {
    return items
      .filter(x => x.status === 'done')
      .map(x => ({
        url: x.url,
        cloudinary_id: x.cloudinary_id,
        mime_type: x.mime,
        size_bytes: x.size,
        filename: x.name
      }));
  }
  function count() { return items.length; }
  function isReady() { return items.every(x => x.status === 'done'); }

  // Drag-drop wiring
  if (dropEl) {
    const onDragOver = (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      dropEl.classList.add('drag-active');
    };
    const onDragLeave = () => dropEl.classList.remove('drag-active');
    const onDrop = (e) => {
      e.preventDefault();
      dropEl.classList.remove('drag-active');
      if (e.dataTransfer.files && e.dataTransfer.files.length) {
        addFiles(e.dataTransfer.files);
      }
    };
    dropEl.addEventListener('dragover',  onDragOver);
    dropEl.addEventListener('dragleave', onDragLeave);
    dropEl.addEventListener('drop',      onDrop);
  }

  return { addFiles, clear, getAttachments, count, isReady };
}

function fileIcon(mime) {
  if (!mime) return '📄';
  if (mime.startsWith('image/')) return '🖼';
  if (mime === 'application/pdf') return '📕';
  if (mime.includes('word')) return '📘';
  if (mime.includes('sheet') || mime.includes('excel')) return '📗';
  if (mime.includes('presentation') || mime.includes('powerpoint')) return '📙';
  if (mime.includes('zip')) return '🗜';
  if (mime.startsWith('text/')) return '📄';
  return '📎';
}

// ── Mention popover ───────────────────────────────────────────────
// Watches a Quill instance for `@` followed by typing; opens a popup of
// candidates (filtered by the search string). Picking inserts the mention
// blot and closes.
function setupMentionPopover({ quill, popupEl, getCandidates, onError }) {
  let active = false;
  let triggerIndex = -1; // position of the `@`
  let highlighted = 0;
  let candidates = [];   // current filtered list

  function open() {
    active = true;
    popupEl.classList.remove('hidden');
  }
  function close() {
    active = false;
    highlighted = 0;
    candidates = [];
    popupEl.classList.add('hidden');
    popupEl.innerHTML = '';
  }

  function renderList() {
    popupEl.innerHTML = candidates.map((c, i) => `
      <div class="pulse-mention-item ${i === highlighted ? 'active' : ''}" data-i="${i}">
        <div class="ava">${c.avatar_url
          ? `<img src="${escHtml(c.avatar_url)}" alt="">`
          : escHtml(avatarInitial(c.full_name || c.email))}</div>
        <div>${escHtml(c.full_name || c.email || 'Unknown')}</div>
      </div>
    `).join('');
    popupEl.querySelectorAll('.pulse-mention-item').forEach(el => {
      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        pick(parseInt(el.dataset.i, 10));
      });
    });
  }

  function positionAtCursor() {
    const sel = quill.getSelection();
    if (!sel) return;
    const bounds = quill.getBounds(sel.index);
    const hostRect = quill.container.getBoundingClientRect();
    popupEl.style.left = (hostRect.left + bounds.left) + 'px';
    popupEl.style.top  = (hostRect.top  + bounds.top - popupEl.offsetHeight - 4) + 'px';
  }

  function pick(i) {
    if (!candidates[i]) return close();
    const c = candidates[i];
    const sel = quill.getSelection();
    if (!sel) return close();
    // Replace from the `@` to current cursor
    const length = sel.index - triggerIndex;
    quill.deleteText(triggerIndex, length, 'user');
    quill.insertEmbed(triggerIndex, 'mention', {
      uid: c.id, name: c.full_name || c.email || 'Unknown'
    }, 'user');
    quill.insertText(triggerIndex + 1, ' ', 'user');
    quill.setSelection(triggerIndex + 2, 0, 'user');
    close();
  }

  async function refresh(query) {
    let list = [];
    try { list = await getCandidates(); } catch (err) { onError && onError(err.message); }
    const q = (query || '').toLowerCase();
    candidates = (list || [])
      .filter(c => {
        if (!q) return true;
        const name = (c.full_name || '').toLowerCase();
        const email = (c.email || '').toLowerCase();
        return name.includes(q) || email.includes(q);
      })
      .slice(0, 8);
    highlighted = 0;
    renderList();
    if (candidates.length) {
      open();
      // Position after render so popupEl.offsetHeight is non-zero
      requestAnimationFrame(positionAtCursor);
    } else {
      close();
    }
  }

  quill.on('text-change', () => {
    const sel = quill.getSelection();
    if (!sel) return close();
    const text = quill.getText(0, sel.index);
    // Find the most recent `@` not preceded by an alphanumeric char
    const m = text.match(/(^|\s)@([\w.-]*)$/);
    if (!m) return close();
    triggerIndex = sel.index - m[2].length - 1;
    refresh(m[2]);
  });

  quill.root.addEventListener('keydown', (e) => {
    if (!active) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      highlighted = (highlighted + 1) % Math.max(1, candidates.length);
      renderList();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      highlighted = (highlighted - 1 + candidates.length) % Math.max(1, candidates.length);
      renderList();
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      if (candidates.length) {
        e.preventDefault();
        pick(highlighted);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  });

  return { close };
}

// ── Render mention pills in incoming messages ─────────────────────
// Walk the sanitized HTML and tag the current user's mentions with the
// `self` class so they highlight differently.
function highlightSelfMentions(html, selfUid) {
  if (!selfUid) return html;
  return html.replace(
    /<span class="pulse-mention" data-uid="([^"]+)">/g,
    (m, uid) => uid === selfUid
      ? '<span class="pulse-mention self" data-uid="' + uid + '">'
      : m
  );
}

// Expose helpers globally — chat.html consumes them directly.
window.PulseChat = {
  sanitizeHtml,
  formatDateDivider,
  sameDay,
  requestNotificationPermission,
  notify,
  bytesHuman,
  extractMentionUids,
  fileIcon,
  registerMentionBlot,
  setupAttachmentTray,
  setupMentionPopover,
  highlightSelfMentions
};
