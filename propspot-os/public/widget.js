// Pulse entity-comments embed widget.
//
// Usage on a host page:
//   <link rel="stylesheet" href="<PULSE_URL>/widget.css">
//   <div id="pulse-slot" data-entity-type="inbox_thread" data-entity-id="<uuid>"></div>
//   <script>window.PULSE_AUTH = { token: getToken() };</script>
//   <script src="<PULSE_URL>/widget.js" defer></script>
//
// The widget reads its Pulse base URL from the <script src> attribute it was
// loaded by — no extra config required.

(function () {
  if (window.__pulseWidgetLoaded) return;
  window.__pulseWidgetLoaded = true;

  const scriptEl = document.currentScript
    || [...document.scripts].find(s => s.src && s.src.includes('/widget.js'));
  const PULSE_URL = scriptEl ? new URL(scriptEl.src).origin : '';

  if (!PULSE_URL) { console.warn('[Pulse widget] could not determine PULSE_URL'); return; }
  // Ensure widget.css is loaded — if the host didn't include it, inject it.
  if (![...document.styleSheets].some(s => (s.href || '').includes('/widget.css'))) {
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = PULSE_URL + '/widget.css';
    document.head.appendChild(l);
  }

  function getToken() {
    return (window.PULSE_AUTH && window.PULSE_AUTH.token) || null;
  }

  async function api(path, opts = {}) {
    const token = getToken();
    if (!token) throw new Error('No auth token available (window.PULSE_AUTH.token)');
    const r = await fetch(`${PULSE_URL}${path}`, {
      ...opts,
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + token,
        ...(opts.headers || {})
      }
    });
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      throw new Error(e.error || `HTTP ${r.status}`);
    }
    return r.json();
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[c]));
  }

  // Render <@uuid> tokens as colored chips with a display name.
  function renderBody(body, usersById) {
    if (!body) return '';
    return escapeHtml(body).replace(/&lt;@([0-9a-f-]{36})&gt;/gi, (_, uid) => {
      const u = usersById.get(uid.toLowerCase());
      const label = u ? (u.full_name || u.email) : uid.slice(0, 8);
      return `<span class="pulse-embed-mention">@${escapeHtml(label)}</span>`;
    });
  }

  function fmtTime(iso) {
    const d = new Date(iso);
    return d.toLocaleString(undefined, { hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric' });
  }

  async function mountSlot(slot) {
    const entityType = slot.dataset.entityType;
    let entityId = slot.dataset.entityId;

    // Wait up to 5s for entityId to be populated by the host page's loader.
    if (!entityId) {
      const start = Date.now();
      await new Promise(resolve => {
        const iv = setInterval(() => {
          entityId = slot.dataset.entityId;
          if (entityId || Date.now() - start > 5000) {
            clearInterval(iv); resolve();
          }
        }, 250);
      });
    }
    if (!entityType || !entityId) {
      slot.innerHTML = '<div class="pulse-embed pulse-embed-error">Pulse widget: missing entity_type/entity_id</div>';
      return;
    }

    slot.innerHTML = `
      <div class="pulse-embed" role="region" aria-label="Internal comments">
        <div class="pulse-embed-header">
          💬 <span>Internal comments</span>
          <span class="pulse-embed-status" title="Disconnected"></span>
        </div>
        <div class="pulse-embed-messages" data-role="messages">
          <div class="pulse-embed-empty">Loading…</div>
        </div>
        <div class="pulse-embed-composer">
          <textarea class="pulse-embed-textarea" data-role="textarea" placeholder="Type a comment… (@ to mention)"></textarea>
          <div class="pulse-embed-mention-picker" data-role="picker"></div>
          <div class="pulse-embed-actions">
            <span class="pulse-embed-hint">Only people on this thread see these comments.</span>
            <button class="pulse-embed-send" data-role="send">Post</button>
          </div>
        </div>
      </div>
    `;

    const msgEl    = slot.querySelector('[data-role="messages"]');
    const taEl     = slot.querySelector('[data-role="textarea"]');
    const sendEl   = slot.querySelector('[data-role="send"]');
    const pickerEl = slot.querySelector('[data-role="picker"]');
    const statusEl = slot.querySelector('.pulse-embed-status');

    let MENTIONABLE = [];   // { id, full_name, email, has_ambient }
    let USERS_BY_ID = new Map();
    let CALLER_ID = null;   // populated by loadInitial; drives edit/delete visibility
    // displayName → uuid for mentions picked from the picker. Used by
    // postMessage to convert "@Jordan Shutts" back to "<@uuid>" on the
    // way to the server. The textarea stores plain text — there's no
    // way to display a styled chip inline in a <textarea>, so we keep
    // a side-table of picked names and re-attach uuids at send time.
    const PICKED_MENTIONS = new Map();

    function rebuildUserMap() {
      USERS_BY_ID = new Map(MENTIONABLE.map(u => [u.id.toLowerCase(), u]));
    }

    function displayNameFor(u) {
      return u.full_name || u.email || u.id.slice(0, 8);
    }

    // Replace each "@<displayName>" the user picked with its "<@uuid>" token
    // before sending. Iterate longest-first so "@Jordan Shutts" wins over
    // "@Jordan" if both happen to be mentionable.
    function serializeMentions(text) {
      const names = [...PICKED_MENTIONS.keys()].sort((a, b) => b.length - a.length);
      let out = text;
      for (const name of names) {
        const uid = PICKED_MENTIONS.get(name);
        // Escape regex special chars in the display name.
        const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        out = out.replace(new RegExp(`@${esc}`, 'g'), `<@${uid}>`);
      }
      return out;
    }

    async function loadInitial() {
      try {
        const [data, users] = await Promise.all([
          api(`/api/pulse/entity-threads?type=${encodeURIComponent(entityType)}&id=${encodeURIComponent(entityId)}`),
          api(`/api/pulse/entity-threads/mentionable-users?type=${encodeURIComponent(entityType)}&id=${encodeURIComponent(entityId)}`)
        ]);
        MENTIONABLE = users || [];
        rebuildUserMap();
        CALLER_ID = data.caller_user_id || null;
        renderMessages(data.messages || []);
        api(`/api/pulse/entity-threads/mark-read?type=${encodeURIComponent(entityType)}&id=${encodeURIComponent(entityId)}`, { method: 'POST' }).catch(() => {});
        openStream();
      } catch (err) {
        msgEl.innerHTML = `<div class="pulse-embed-error">${escapeHtml(err.message)}</div>`;
      }
    }

    // Quick-pick palette for the + reaction button. Keep it tiny so the
    // popover stays one row on mobile.
    const QUICK_REACTIONS = ['👍', '❤️', '😂', '🎉', '✅', '👀'];

    function reactionsHtml(reactions) {
      if (!reactions || !reactions.length) return '';
      return reactions.map(r => {
        const byMe = CALLER_ID && r.users?.some(u => u.user_id === CALLER_ID);
        const names = (r.users || []).map(u => u.name).join(', ');
        return `<button type="button" class="pulse-embed-rx${byMe ? ' by-me' : ''}"
                 data-action="toggle-reaction" data-emoji="${escapeHtml(r.emoji)}"
                 title="${escapeHtml(names)}">
          <span class="pulse-embed-rx-emoji">${escapeHtml(r.emoji)}</span>
          <span class="pulse-embed-rx-count">${r.count}</span>
        </button>`;
      }).join('');
    }

    // Build the inner head + body markup for a message row. Own messages
    // get edit/delete buttons; everyone else's are read-only.
    function messageInnerHtml(m) {
      const isMine = CALLER_ID && m.sender_id && m.sender_id.toLowerCase() === CALLER_ID.toLowerCase();
      const reactBtn = `<button type="button" data-action="open-react" title="Add reaction">😊</button>`;
      const ownBtns = isMine ? `
          <button type="button" data-action="edit" title="Edit">✏️</button>
          <button type="button" class="danger" data-action="delete" title="Delete">🗑</button>` : '';
      const actions = `
        <div class="pulse-embed-msg-actions">
          ${reactBtn}${ownBtns}
        </div>`;
      return `
        <div class="pulse-embed-msg-head">
          <span class="pulse-embed-msg-author">${escapeHtml(m.sender_name || 'Unknown')}</span>
          <span>${fmtTime(m.created_at)}</span>
          ${m.edited_at ? '<span title="Edited">(edited)</span>' : ''}
          ${actions}
        </div>
        <div class="pulse-embed-msg-body">${renderBody(m.body, USERS_BY_ID)}</div>
        <div class="pulse-embed-reactions" data-role="reactions">${reactionsHtml(m.reactions)}</div>
        <div class="pulse-embed-react-picker" data-role="react-picker" hidden>
          ${QUICK_REACTIONS.map(e => `<button type="button" data-action="pick-reaction" data-emoji="${escapeHtml(e)}">${escapeHtml(e)}</button>`).join('')}
        </div>
        <div class="pulse-embed-msg-edit">
          <textarea data-role="edit-textarea"></textarea>
          <div class="pulse-embed-msg-edit-actions">
            <button type="button" class="cancel" data-action="cancel-edit">Cancel</button>
            <button type="button" class="save" data-action="save-edit">Save</button>
          </div>
        </div>
      `;
    }

    function renderMessages(messages) {
      if (!messages.length) {
        msgEl.innerHTML = '<div class="pulse-embed-empty">No comments yet — leave the first one.</div>';
        return;
      }
      msgEl.innerHTML = messages.map(m => `
        <div class="pulse-embed-msg" data-id="${escapeHtml(m.id)}" data-raw-body="${escapeHtml(m.body || '')}">
          ${messageInnerHtml(m)}
        </div>
      `).join('');
      msgEl.scrollTop = msgEl.scrollHeight;
    }

    function appendMessage(m) {
      const empty = msgEl.querySelector('.pulse-embed-empty');
      if (empty) empty.remove();
      if (msgEl.querySelector(`.pulse-embed-msg[data-id="${m.id}"]`)) return;  // dedup
      const div = document.createElement('div');
      div.className = 'pulse-embed-msg';
      div.dataset.id = m.id;
      div.dataset.rawBody = m.body || '';
      div.innerHTML = messageInnerHtml(m);
      msgEl.appendChild(div);
      msgEl.scrollTop = msgEl.scrollHeight;
    }

    // Click delegation for per-message actions (edit / delete / save / cancel).
    msgEl.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const card = btn.closest('.pulse-embed-msg');
      if (!card) return;
      const action = btn.dataset.action;
      const msgId = card.dataset.id;

      if (action === 'edit') {
        const ta = card.querySelector('[data-role="edit-textarea"]');
        ta.value = card.dataset.rawBody || '';
        card.classList.add('editing');
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
      } else if (action === 'cancel-edit') {
        card.classList.remove('editing');
      } else if (action === 'save-edit') {
        const ta = card.querySelector('[data-role="edit-textarea"]');
        const newBody = ta.value.trim();
        if (!newBody) return;
        btn.disabled = true;
        try {
          const updated = await api(`/api/pulse/entity-threads/messages/${encodeURIComponent(msgId)}`,
            { method: 'PATCH', body: JSON.stringify({ body: newBody }) });
          // Replace card contents with the freshly-edited render. The SSE
          // event will arrive shortly with the same payload; messageInnerHtml
          // is idempotent so a double-render is harmless.
          card.dataset.rawBody = updated.body || '';
          card.innerHTML = messageInnerHtml(updated);
          card.classList.remove('editing');
        } catch (err) {
          alert('Could not save: ' + err.message);
        } finally {
          btn.disabled = false;
        }
      } else if (action === 'delete') {
        if (!confirm('Delete this comment? Other people on the thread will no longer see it.')) return;
        try {
          await api(`/api/pulse/entity-threads/messages/${encodeURIComponent(msgId)}`, { method: 'DELETE' });
          card.remove();
          if (!msgEl.querySelector('.pulse-embed-msg')) {
            msgEl.innerHTML = '<div class="pulse-embed-empty">No comments yet — leave the first one.</div>';
          }
        } catch (err) {
          alert('Could not delete: ' + err.message);
        }
      } else if (action === 'open-react') {
        // Toggle the quick-pick popover. Close any other open ones first.
        msgEl.querySelectorAll('[data-role="react-picker"]:not([hidden])').forEach(el => {
          if (!card.contains(el)) el.hidden = true;
        });
        const picker = card.querySelector('[data-role="react-picker"]');
        if (picker) picker.hidden = !picker.hidden;
      } else if (action === 'pick-reaction' || action === 'toggle-reaction') {
        const emoji = btn.dataset.emoji;
        if (!emoji) return;
        // Close picker immediately so the UI feels snappy.
        const picker = card.querySelector('[data-role="react-picker"]');
        if (picker) picker.hidden = true;
        try {
          const { reactions } = await api(
            `/api/pulse/entity-threads/messages/${encodeURIComponent(msgId)}/react`,
            { method: 'POST', body: JSON.stringify({ emoji }) }
          );
          const rxEl = card.querySelector('[data-role="reactions"]');
          if (rxEl) rxEl.innerHTML = reactionsHtml(reactions);
        } catch (err) {
          alert('Could not react: ' + err.message);
        }
      }
    });
    // Click outside any open react picker → close it.
    document.addEventListener('click', e => {
      if (e.target.closest('[data-role="react-picker"]') || e.target.closest('[data-action="open-react"]')) return;
      msgEl.querySelectorAll('[data-role="react-picker"]:not([hidden])').forEach(el => el.hidden = true);
    });

    function uuid() {
      return ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>
        (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)
      );
    }

    async function postMessage() {
      const raw = taEl.value.trim();
      if (!raw) return;
      const body = serializeMentions(raw);
      sendEl.disabled = true;
      try {
        const m = await api(
          `/api/pulse/entity-threads/messages?type=${encodeURIComponent(entityType)}&id=${encodeURIComponent(entityId)}`,
          { method: 'POST', body: JSON.stringify({ body, client_message_id: uuid() }) }
        );
        appendMessage(m);
        taEl.value = '';
        PICKED_MENTIONS.clear();
      } catch (err) {
        msgEl.insertAdjacentHTML('beforeend', `<div class="pulse-embed-error">${escapeHtml(err.message)}</div>`);
      } finally {
        sendEl.disabled = false;
      }
    }

    sendEl.addEventListener('click', postMessage);
    taEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); postMessage(); }
    });

    // ── Mention picker ─────────────────────────────────────────────
    let pickerOpen = false;
    let pickerCursor = 0;   // index into filtered results
    let pickerToken = '';   // characters typed after the @
    let pickerAnchor = -1;  // index in taEl.value where the '@' was typed

    function closePicker() { pickerOpen = false; pickerEl.classList.remove('open'); pickerEl.innerHTML = ''; }

    function openPicker(anchor) {
      pickerOpen = true; pickerAnchor = anchor; pickerToken = ''; pickerCursor = 0;
      renderPicker();
      pickerEl.classList.add('open');
    }

    function filteredUsers() {
      const q = pickerToken.toLowerCase();
      const filtered = MENTIONABLE.filter(u =>
        (u.full_name || '').toLowerCase().includes(q)
        || (u.email || '').toLowerCase().includes(q)
      );
      return filtered.slice(0, 8);
    }

    function renderPicker() {
      const list = filteredUsers();
      if (!list.length) { closePicker(); return; }
      if (pickerCursor >= list.length) pickerCursor = list.length - 1;
      pickerEl.innerHTML = list.map((u, i) => `
        <div class="pulse-embed-mention-item ${i === pickerCursor ? 'active' : ''}" data-uid="${escapeHtml(u.id)}">
          <span>${escapeHtml(u.full_name || u.email)}</span>
          <span class="pulse-embed-mention-badge">${u.has_ambient ? '' : 'guest'}</span>
        </div>
      `).join('');
      pickerEl.querySelectorAll('.pulse-embed-mention-item').forEach((el, i) => {
        el.addEventListener('mousedown', (e) => { e.preventDefault(); pickerCursor = i; pickUser(); });
      });
    }

    function pickUser() {
      const list = filteredUsers();
      const u = list[pickerCursor];
      if (!u) return;
      const name = displayNameFor(u);
      PICKED_MENTIONS.set(name, u.id);
      const insert = `@${name} `;
      const before = taEl.value.slice(0, pickerAnchor);
      const after  = taEl.value.slice(pickerAnchor + 1 + pickerToken.length);
      taEl.value = `${before}${insert}${after}`;
      const caret = before.length + insert.length;
      taEl.focus();
      taEl.setSelectionRange(caret, caret);
      closePicker();
    }

    taEl.addEventListener('input', () => {
      const v = taEl.value;
      const caret = taEl.selectionStart;
      const before = v.slice(0, caret);
      const match = before.match(/(^|\s)@([\w.-]*)$/);
      if (match) {
        const tokenStart = caret - match[2].length - 1;
        if (!pickerOpen || pickerAnchor !== tokenStart) openPicker(tokenStart);
        pickerToken = match[2];
        renderPicker();
      } else if (pickerOpen) {
        closePicker();
      }
    });

    taEl.addEventListener('keydown', (e) => {
      if (!pickerOpen) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); pickerCursor = (pickerCursor + 1) % filteredUsers().length; renderPicker(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); const n = filteredUsers().length; pickerCursor = (pickerCursor - 1 + n) % n; renderPicker(); }
      else if (e.key === 'Enter' || e.key === 'Tab') {
        const list = filteredUsers();
        if (list.length) { e.preventDefault(); pickUser(); }
      } else if (e.key === 'Escape') { closePicker(); }
    });

    // ── SSE ────────────────────────────────────────────────────────
    let es = null;
    function openStream() {
      if (es) try { es.close(); } catch {}
      const token = getToken();
      const url = `${PULSE_URL}/api/pulse/stream?token=${encodeURIComponent(token)}&entity_type=${encodeURIComponent(entityType)}&entity_id=${encodeURIComponent(entityId)}`;
      es = new EventSource(url);
      es.addEventListener('open', () => statusEl.classList.add('connected'));
      es.addEventListener('error', () => statusEl.classList.remove('connected'));
      es.addEventListener('message', (e) => {
        let payload;
        try { payload = JSON.parse(e.data); } catch { return; }
        if (payload.type === 'entity_thread.message_created' && payload.message) {
          appendMessage(payload.message);
        } else if (payload.type === 'entity_thread.message_deleted') {
          const el = msgEl.querySelector(`[data-id="${payload.message_id}"]`);
          if (el) el.remove();
        } else if (payload.type === 'entity_thread.message_updated' && payload.message) {
          // Full card re-render keeps data-raw-body (used by the edit
          // textarea pre-fill) and the "(edited)" badge in sync.
          const card = msgEl.querySelector(`.pulse-embed-msg[data-id="${payload.message.id}"]`);
          if (card) {
            card.dataset.rawBody = payload.message.body || '';
            card.classList.remove('editing');
            card.innerHTML = messageInnerHtml(payload.message);
          }
        } else if (payload.type === 'entity_thread.reaction_update' && payload.message_id) {
          const card = msgEl.querySelector(`.pulse-embed-msg[data-id="${payload.message_id}"]`);
          const rxEl = card?.querySelector('[data-role="reactions"]');
          if (rxEl) rxEl.innerHTML = reactionsHtml(payload.reactions || []);
        }
      });
    }

    loadInitial();
  }

  function init() {
    const slots = document.querySelectorAll('[id="pulse-slot"], [data-pulse-slot]');
    slots.forEach(mountSlot);
  }

  // Public API: hosts that re-render their DOM (e.g. inbox.html's right pane
  // when the user clicks a different thread) call window.Pulse.mountSlots()
  // after innerHTML replacement to mount the widget into the fresh slot.
  // Slots already populated (containing a .pulse-embed) are skipped.
  window.Pulse = window.Pulse || {};
  window.Pulse.mountSlots = function () {
    document.querySelectorAll('[id="pulse-slot"], [data-pulse-slot]').forEach(slot => {
      if (slot.querySelector('.pulse-embed')) return;  // already mounted
      mountSlot(slot);
    });
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
