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

    function rebuildUserMap() {
      USERS_BY_ID = new Map(MENTIONABLE.map(u => [u.id.toLowerCase(), u]));
    }

    async function loadInitial() {
      try {
        const [data, users] = await Promise.all([
          api(`/api/pulse/entity-threads?type=${encodeURIComponent(entityType)}&id=${encodeURIComponent(entityId)}`),
          api(`/api/pulse/entity-threads/mentionable-users?type=${encodeURIComponent(entityType)}&id=${encodeURIComponent(entityId)}`)
        ]);
        MENTIONABLE = users || [];
        rebuildUserMap();
        renderMessages(data.messages || []);
        api(`/api/pulse/entity-threads/mark-read?type=${encodeURIComponent(entityType)}&id=${encodeURIComponent(entityId)}`, { method: 'POST' }).catch(() => {});
        openStream();
      } catch (err) {
        msgEl.innerHTML = `<div class="pulse-embed-error">${escapeHtml(err.message)}</div>`;
      }
    }

    function renderMessages(messages) {
      if (!messages.length) {
        msgEl.innerHTML = '<div class="pulse-embed-empty">No comments yet — leave the first one.</div>';
        return;
      }
      msgEl.innerHTML = messages.map(m => `
        <div class="pulse-embed-msg" data-id="${escapeHtml(m.id)}">
          <div class="pulse-embed-msg-head">
            <span class="pulse-embed-msg-author">${escapeHtml(m.sender_name || 'Unknown')}</span>
            <span>${fmtTime(m.created_at)}</span>
            ${m.edited_at ? '<span title="Edited">(edited)</span>' : ''}
          </div>
          <div class="pulse-embed-msg-body">${renderBody(m.body, USERS_BY_ID)}</div>
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
      div.innerHTML = `
        <div class="pulse-embed-msg-head">
          <span class="pulse-embed-msg-author">${escapeHtml(m.sender_name || 'Unknown')}</span>
          <span>${fmtTime(m.created_at)}</span>
        </div>
        <div class="pulse-embed-msg-body">${renderBody(m.body, USERS_BY_ID)}</div>
      `;
      msgEl.appendChild(div);
      msgEl.scrollTop = msgEl.scrollHeight;
    }

    function uuid() {
      return ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>
        (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)
      );
    }

    async function postMessage() {
      const body = taEl.value.trim();
      if (!body) return;
      sendEl.disabled = true;
      try {
        const m = await api(
          `/api/pulse/entity-threads/messages?type=${encodeURIComponent(entityType)}&id=${encodeURIComponent(entityId)}`,
          { method: 'POST', body: JSON.stringify({ body, client_message_id: uuid() }) }
        );
        appendMessage(m);
        taEl.value = '';
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
      const before = taEl.value.slice(0, pickerAnchor);
      const after  = taEl.value.slice(pickerAnchor + 1 + pickerToken.length);
      taEl.value = `${before}<@${u.id}> ${after}`;
      taEl.focus();
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
          const el = msgEl.querySelector(`[data-id="${payload.message.id}"] .pulse-embed-msg-body`);
          if (el) el.innerHTML = renderBody(payload.message.body, USERS_BY_ID);
        }
      });
    }

    loadInitial();
  }

  function init() {
    const slots = document.querySelectorAll('[id="pulse-slot"], [data-pulse-slot]');
    slots.forEach(mountSlot);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
