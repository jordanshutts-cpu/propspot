// Wrapper around fetch() that adds the PropSpot Authorization header from
// localStorage.ros_token. Without it every /api/inkd/ call returns 401.
function api(url, options = {}) {
  const token = localStorage.getItem('ros_token');
  return fetch(url, {
    ...options,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

// ── App state ─────────────────────────────────────────────────
const state = {
  view: 'documents',      // 'documents' | 'templates' | 'archive'
  statusFilter: 'all',    // 'all' | 'draft' | 'out' | 'action' | 'review' | 'filed'
  search: '',
  envelopes: [],
  templates: [],
  properties: [],         // loaded lazily for the create-document modal
};

function parseView() {
  const v = new URLSearchParams(location.search).get('view') || 'documents';
  return ['documents','templates','archive'].includes(v) ? v : 'documents';
}

// ── Bucketing helpers ─────────────────────────────────────────
// Maps an envelope to one of: 'draft', 'out', 'action', 'review', 'filed'.
function laneFor(e) {
  if (e.status === 'draft')                                 return 'draft';
  if (e.status === 'sent' || e.status === 'partial')        return 'out';
  if (e.status === 'voided' || e.status === 'expired')      return 'action';
  if (e.status === 'completed' && !e.filed_at)              return 'review';
  if (e.filed_at)                                           return 'filed';
  return 'draft';
}

// ── Initial load ──────────────────────────────────────────────
async function init() {
  state.view = parseView();
  highlightSideItem();
  // wireEvents in its own try/catch so a single missing element doesn't
  // silently leave ALL event handlers unattached. Without this, a broken
  // ID lookup partway through means earlier handlers (like the Create
  // dropdown) work but later ones (like ne-cancel) throw and we'd never
  // know — and vice-versa.
  try { wireEvents(); }
  catch (err) { console.error('[inkd] wireEvents failed:', err); }

  const [envRes, tplRes] = await Promise.all([
    api('/api/inkd/envelopes'),
    api('/api/inkd/templates'),
  ]);
  state.envelopes = envRes.ok ? await envRes.json() : [];
  state.templates = tplRes.ok ? await tplRes.json() : [];

  updateCounts();
  render();
}

function updateCounts() {
  const activeEnvs   = state.envelopes.filter(e => laneFor(e) !== 'action');
  const archivedEnvs = state.envelopes.filter(e => laneFor(e) === 'action');
  document.getElementById('cnt-documents').textContent = activeEnvs.length;
  document.getElementById('cnt-templates').textContent = state.templates.length;
  document.getElementById('cnt-archive').textContent   = archivedEnvs.length;
}

function highlightSideItem() {
  for (const el of document.querySelectorAll('.inkd-side-item')) {
    el.classList.toggle('active', el.dataset.view === state.view);
  }
  document.getElementById('filter-chips').style.display = state.view === 'documents' ? 'flex' : 'none';
}

// ── Render the current view ───────────────────────────────────
function render() {
  const titleEl = document.getElementById('view-title');
  const countEl = document.getElementById('view-count');
  const listEl  = document.getElementById('inkd-list');
  const emptyEl = document.getElementById('empty-state');

  let items = [];
  if (state.view === 'documents') {
    titleEl.textContent = 'Documents';
    items = state.envelopes.filter(e => laneFor(e) !== 'action');
    if (state.statusFilter !== 'all') {
      items = items.filter(e => laneFor(e) === state.statusFilter);
    }
  } else if (state.view === 'templates') {
    titleEl.textContent = 'Templates';
    items = state.templates.slice();
  } else if (state.view === 'archive') {
    titleEl.textContent = 'Archive';
    items = state.envelopes.filter(e => laneFor(e) === 'action');
  }

  if (state.search) {
    const q = state.search.toLowerCase();
    items = items.filter(it => {
      const hay = state.view === 'templates'
        ? `${it.name || ''} ${it.category || ''}`
        : `${it.name || ''} ${it.property_address || ''} ${it.template_name || ''}`;
      return hay.toLowerCase().includes(q);
    });
  }

  countEl.textContent = `${items.length} ${items.length === 1 ? 'item' : 'items'}`;

  if (!items.length) {
    listEl.innerHTML = '';
    listEl.style.display = 'none';
    emptyEl.hidden = false;
    updateEmptyState();
    return;
  }
  emptyEl.hidden = true;
  listEl.style.display = '';

  listEl.innerHTML = '';
  for (const item of items) {
    listEl.appendChild(state.view === 'templates' ? templateRow(item) : envelopeRow(item));
  }
}

function updateEmptyState() {
  const title = document.getElementById('empty-title');
  const sub   = document.getElementById('empty-sub');
  const cta   = document.getElementById('empty-cta');
  if (state.view === 'documents') {
    title.textContent = 'Send your documents for signature';
    sub.textContent   = 'Upload a PDF, drop fields, and send. Recipients sign in their browser — no account needed.';
    cta.textContent   = '+ Send a document';
    cta.style.display = '';
  } else if (state.view === 'templates') {
    title.textContent = 'No templates yet';
    sub.textContent   = 'Create reusable templates for documents you send over and over.';
    cta.textContent   = '+ New template';
    cta.style.display = '';
  } else {
    title.textContent = 'Nothing in Archive';
    sub.textContent   = 'Voided or expired envelopes land here automatically.';
    cta.style.display = 'none';
  }
}

function envelopeRow(e) {
  const div = document.createElement('div');
  div.className = 'inkd-row';
  const lane = laneFor(e);
  const badgeText = {
    draft:'Draft', out:'Out for signature',
    action: e.status === 'voided' ? 'Voided' : 'Expired',
    review:'Completed (review)', filed:'Filed',
  }[lane] || e.status;
  const badgeClass = `badge badge-${lane}`;
  const date = new Date(e.created_at).toLocaleDateString();

  div.innerHTML = `
    <div class="col-name">
      <span class="name">${escapeHtml(e.name)}</span>
      ${e.template_name ? `<span class="sub">${escapeHtml(e.template_name)}</span>` : ''}
    </div>
    <div class="col-prop">${escapeHtml(e.property_address || '—')}</div>
    <div class="col-status"><span class="${badgeClass}">${escapeHtml(badgeText)}</span></div>
    <div class="col-date">${date}</div>
    <div class="col-actions"></div>
  `;

  const actions = div.querySelector('.col-actions');
  if (lane === 'draft') {
    const a = document.createElement('a'); a.href = `/inkd-send.html?envelope_id=${e.id}`; a.textContent = 'Open';
    a.addEventListener('click', (ev) => ev.stopPropagation()); actions.appendChild(a);
  } else if (lane === 'out') {
    const a = document.createElement('a'); a.href = `/inkd-envelope.html?id=${e.id}`; a.textContent = 'View';
    a.addEventListener('click', (ev) => ev.stopPropagation()); actions.appendChild(a);
    const v = document.createElement('button'); v.className = 'void'; v.textContent = 'Void';
    v.addEventListener('click', (ev) => { ev.stopPropagation(); voidEnv(e.id); });
    actions.appendChild(v);
  } else if (lane === 'action') {
    const a = document.createElement('a'); a.href = `/inkd-envelope.html?id=${e.id}`; a.textContent = 'View';
    a.addEventListener('click', (ev) => ev.stopPropagation()); actions.appendChild(a);
  } else if (lane === 'review') {
    if (e.final_pdf_url) {
      const a = document.createElement('a'); a.href = e.final_pdf_url; a.target = '_blank'; a.textContent = 'Download';
      a.addEventListener('click', (ev) => ev.stopPropagation()); actions.appendChild(a);
    }
    const f = document.createElement('button'); f.className = 'file'; f.textContent = 'Save to Files';
    f.addEventListener('click', (ev) => { ev.stopPropagation(); saveToFiles(e.id); });
    actions.appendChild(f);
  } else if (lane === 'filed') {
    if (e.final_pdf_url) {
      const a = document.createElement('a'); a.href = e.final_pdf_url; a.target = '_blank'; a.textContent = 'Download';
      a.addEventListener('click', (ev) => ev.stopPropagation()); actions.appendChild(a);
    }
  }

  div.addEventListener('click', () => {
    if (lane === 'draft') location.href = `/inkd-send.html?envelope_id=${e.id}`;
    else location.href = `/inkd-envelope.html?id=${e.id}`;
  });

  return div;
}

function templateRow(t) {
  const div = document.createElement('div');
  div.className = 'inkd-row';
  const date = new Date(t.updated_at || t.created_at).toLocaleDateString();
  div.innerHTML = `
    <div class="col-name">
      <span class="name">${escapeHtml(t.name)}</span>
      ${t.category ? `<span class="sub">${escapeHtml(t.category)}</span>` : ''}
    </div>
    <div class="col-prop">${t.page_count} ${t.page_count === 1 ? 'page' : 'pages'}</div>
    <div class="col-status"></div>
    <div class="col-date">${date}</div>
    <div class="col-actions">
      <a href="/inkd-template-editor.html?id=${t.id}">Edit</a>
      <button class="void" type="button">Archive</button>
    </div>
  `;
  div.querySelector('a').addEventListener('click', (ev) => ev.stopPropagation());
  div.querySelector('.void').addEventListener('click', async (ev) => {
    ev.stopPropagation();
    if (!confirm('Archive this template?')) return;
    await api(`/api/inkd/templates/${t.id}`, { method: 'DELETE' });
    state.templates = state.templates.filter(x => x.id !== t.id);
    updateCounts();
    render();
  });
  div.addEventListener('click', () => location.href = `/inkd-template-editor.html?id=${t.id}`);
  return div;
}

// ── Actions ───────────────────────────────────────────────────
async function voidEnv(id) {
  if (!confirm('Void this envelope?')) return;
  await api(`/api/inkd/envelopes/${id}/void`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  await reload();
}

async function saveToFiles(id) {
  const r = await api(`/api/inkd/envelopes/${id}/save-to-files`, { method: 'POST' });
  if (!r.ok) { const j = await r.json().catch(()=>({})); showToast('Save failed: ' + (j.error || r.statusText), 'error'); return; }
  showToast('Saved to property Files');
  await reload();
}

async function reload() {
  const [envRes, tplRes] = await Promise.all([
    api('/api/inkd/envelopes'),
    api('/api/inkd/templates'),
  ]);
  state.envelopes = envRes.ok ? await envRes.json() : [];
  state.templates = tplRes.ok ? await tplRes.json() : [];
  updateCounts();
  render();
}

// ── Event wiring ──────────────────────────────────────────────
function wireEvents() {
  for (const el of document.querySelectorAll('.inkd-side-item')) {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      state.view = el.dataset.view;
      state.statusFilter = 'all';
      state.search = '';
      document.getElementById('inkd-search').value = '';
      document.querySelectorAll('.inkd-filter-chips .chip').forEach(c => c.classList.toggle('active', c.dataset.status === 'all'));
      history.replaceState({}, '', `?view=${state.view}`);
      highlightSideItem();
      render();
    });
  }

  document.querySelectorAll('.inkd-filter-chips .chip').forEach(chip => {
    chip.addEventListener('click', () => {
      state.statusFilter = chip.dataset.status;
      document.querySelectorAll('.inkd-filter-chips .chip').forEach(c => c.classList.toggle('active', c === chip));
      render();
    });
  });

  document.getElementById('inkd-search').addEventListener('input', (e) => {
    state.search = e.target.value;
    render();
  });

  const createBtn  = document.getElementById('btn-create');
  const createMenu = document.getElementById('create-menu');
  createBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    createMenu.hidden = !createMenu.hidden;
  });
  document.addEventListener('click', (e) => {
    if (!createMenu.contains(e.target) && e.target !== createBtn) createMenu.hidden = true;
  });
  // Event delegation on the menu itself — more robust than two separate
  // querySelector-and-attach calls, and handles clicks on the inner <div>,
  // <strong>, or <span> inside each button (which can happen if the user
  // clicks on the icon or sub-label rather than empty button area).
  createMenu.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-create]');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    createMenu.hidden = true;
    if (btn.dataset.create === 'document') openNewEnvelope();
    else if (btn.dataset.create === 'template') location.href = '/inkd-template-editor.html';
  });

  document.getElementById('empty-cta').addEventListener('click', () => {
    if (state.view === 'documents') openNewEnvelope();
    else if (state.view === 'templates') location.href = '/inkd-template-editor.html';
  });

  document.getElementById('ne-cancel').addEventListener('click', closeNewEnvelope);
  document.getElementById('ne-continue').addEventListener('click', continueToComposer);
  document.getElementById('ne-property-clear').addEventListener('click', clearProperty);
  document.getElementById('ne-property-search').addEventListener('input', (e) => renderPropertyResults(e.target.value));
  document.getElementById('new-env-modal').addEventListener('click', (e) => {
    if (e.target.id === 'new-env-modal') closeNewEnvelope();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const m = document.getElementById('new-env-modal');
      if (m && !m.hidden) closeNewEnvelope();
    }
  });
}

// ── New-envelope modal ────────────────────────────────────────
const modal = { selectedProperty: null };

async function openNewEnvelope(preSelectTemplateId) {
  try {
    // Templates not yet loaded? init()'s parallel fetch may still be in
    // flight on a fast click. Fall through to the modal anyway and let
    // the user see an empty dropdown; alternative is a confirm prompt
    // that's surprising on slow networks.
    const templates = Array.isArray(state.templates) ? state.templates : [];
    if (!templates.length) {
      if (confirm("No templates yet. Open the template editor?")) {
        location.href = '/inkd-template-editor.html';
      }
      return;
    }

    const el = document.getElementById('new-env-modal');
    if (!el) { console.error('[inkd] #new-env-modal missing'); return; }
    el.hidden = false;

    modal.selectedProperty = null;
    const selectedRow = document.getElementById('ne-property-selected');
    if (selectedRow) selectedRow.hidden = true;
    const searchInput  = document.getElementById('ne-property-search');
    if (searchInput) { searchInput.value = ''; searchInput.hidden = false; }
    const resultsBox   = document.getElementById('ne-property-results');
    if (resultsBox) resultsBox.hidden = true;

    const tplSel = document.getElementById('ne-template');
    if (tplSel) {
      tplSel.innerHTML = '<option value="">Pick a template…</option>' +
        templates.map(t =>
          `<option value="${t.id}">${escapeHtml(t.name)}${t.category ? ' — ' + escapeHtml(t.category) : ''}</option>`
        ).join('');
      // When the modal is opened from a template row's "Send for signature"
      // button, lock the dropdown so the user can only edit the property —
      // they already picked a template by clicking that specific row.
      if (preSelectTemplateId) {
        tplSel.value = String(preSelectTemplateId);
        tplSel.disabled = true;
      } else {
        tplSel.disabled = false;
      }
    }

    if (!state.properties.length) {
      try {
        const r = await api('/api/properties');
        if (r.ok) state.properties = await r.json();
      } catch (propErr) {
        console.error('[inkd] property list fetch failed', propErr);
      }
    }
  } catch (err) {
    console.error('[inkd] openNewEnvelope failed:', err);
  }
}

function closeNewEnvelope() {
  const el = document.getElementById('new-env-modal');
  if (el) el.hidden = true;
  // Reset the template select so the next "+ Create → Document" flow isn't
  // stuck on the previous pre-selection.
  const tplSel = document.getElementById('ne-template');
  if (tplSel) tplSel.disabled = false;
}

function renderPropertyResults(query) {
  const results = document.getElementById('ne-property-results');
  const q = query.trim().toLowerCase();
  if (!q) { results.hidden = true; return; }
  const matches = state.properties.filter(p => {
    const addr = `${p.address_line1 || ''} ${p.city || ''} ${p.state || ''} ${p.zip || ''}`.toLowerCase();
    return addr.includes(q);
  }).slice(0, 8);
  if (!matches.length) {
    results.innerHTML = '<div class="empty">No properties match</div>';
    results.hidden = false;
    return;
  }
  results.innerHTML = matches.map(p => `
    <div class="row" data-id="${p.id}">
      ${escapeHtml(p.address_line1 || '(no address)')}
      <span class="sub">${escapeHtml([p.city, p.state, p.zip].filter(Boolean).join(', '))}</span>
    </div>`).join('');
  results.hidden = false;
  for (const row of results.querySelectorAll('.row')) {
    row.addEventListener('click', () => {
      const p = state.properties.find(x => String(x.id) === row.dataset.id);
      selectProperty(p);
    });
  }
}

function selectProperty(p) {
  modal.selectedProperty = p;
  document.getElementById('ne-property-search').hidden = true;
  document.getElementById('ne-property-results').hidden = true;
  const label = [p.address_line1, p.city, p.state, p.zip].filter(Boolean).join(', ');
  document.getElementById('ne-property-selected-label').textContent = label;
  document.getElementById('ne-property-selected').hidden = false;
}

function clearProperty() {
  modal.selectedProperty = null;
  document.getElementById('ne-property-selected').hidden = true;
  const input = document.getElementById('ne-property-search');
  input.hidden = false;
  input.value = '';
  input.focus();
}

function continueToComposer() {
  const tplId = document.getElementById('ne-template').value;
  if (!tplId) { showToast('Pick a template to continue', 'error'); return; }
  const params = new URLSearchParams({ template_id: tplId });
  if (modal.selectedProperty) params.set('property_id', modal.selectedProperty.id);
  location.href = `/inkd-send.html?${params.toString()}`;
}

init();
