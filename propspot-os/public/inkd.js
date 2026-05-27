// Wrapper around fetch() that adds the PropSpot Authorization header from
// localStorage.ros_token (set during login). Without it every /api/inkd/ call
// returns 401 'Authentication required' from middleware/auth.js.
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

async function load() {
  const r = await api('/api/inkd/envelopes');
  const list = await r.json();
  const buckets = { draft: [], out: [], action: [], review: [], filed: [] };
  for (const e of list) {
    if (e.status === 'draft')                                   buckets.draft.push(e);
    else if (e.status === 'sent' || e.status === 'partial')     buckets.out.push(e);
    else if (e.status === 'voided' || e.status === 'expired')   buckets.action.push(e);
    else if (e.status === 'completed' && !e.filed_at)           buckets.review.push(e);
    else if (e.filed_at)                                        buckets.filed.push(e);
  }
  for (const lane of Object.keys(buckets)) {
    const section = document.querySelector(`[data-lane="${lane}"] .cards`);
    section.innerHTML = '';
    for (const e of buckets[lane]) section.appendChild(card(e, lane));
  }
}

function card(e, lane) {
  const div = document.createElement('div'); div.className = 'card';
  const title = document.createElement('h3'); title.textContent = e.name; div.appendChild(title);
  if (e.property_address) { const p = document.createElement('p'); p.textContent = e.property_address; div.appendChild(p); }
  if (e.template_name)    { const p = document.createElement('p'); p.textContent = e.template_name;    div.appendChild(p); }
  const meta = document.createElement('p'); meta.textContent = new Date(e.created_at).toLocaleDateString(); div.appendChild(meta);

  const actions = document.createElement('div'); actions.className = 'actions';
  if (lane === 'draft') {
    actions.innerHTML = `<a href="/inkd-send.html?envelope_id=${e.id}">Open</a>`;
  } else if (lane === 'out') {
    actions.innerHTML = `<a href="/inkd-envelope.html?id=${e.id}">View</a> <button class="void" data-id="${e.id}">Void</button>`;
  } else if (lane === 'action') {
    actions.innerHTML = `<a href="/inkd-envelope.html?id=${e.id}">View</a>`;
  } else if (lane === 'review') {
    actions.innerHTML = `<a href="${e.final_pdf_url}" target="_blank">Download</a> <button class="file" data-id="${e.id}" data-act="file">Save to Files</button>`;
  } else if (lane === 'filed') {
    actions.innerHTML = `<a href="${e.final_pdf_url}" target="_blank">Download</a>`;
  }
  div.appendChild(actions);
  actions.querySelector('.void')?.addEventListener('click', () => voidEnv(e.id));
  actions.querySelector('[data-act=file]')?.addEventListener('click', () => saveToFiles(e.id));
  return div;
}

async function voidEnv(id) {
  if (!confirm('Void this envelope?')) return;
  await api(`/api/inkd/envelopes/${id}/void`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  load();
}

async function saveToFiles(id) {
  const r = await api(`/api/inkd/envelopes/${id}/save-to-files`, { method: 'POST' });
  if (!r.ok) { const j = await r.json().catch(()=>({})); alert('Save failed: ' + (j.error || r.statusText)); return; }
  alert('Saved to property Files');
  load();
}

// ── New-envelope modal ───────────────────────────────────────
const modal = {
  el: null,
  templates: [],
  properties: [],
  selectedProperty: null,
};

async function openNewEnvelope() {
  modal.el = document.getElementById('new-env-modal');
  modal.el.hidden = false;

  // Reset state
  modal.selectedProperty = null;
  document.getElementById('ne-property-selected').hidden = true;
  document.getElementById('ne-property-search').value = '';
  document.getElementById('ne-property-search').hidden = false;
  document.getElementById('ne-property-results').hidden = true;

  // Load templates (parallel with properties)
  const [tplRes, propRes] = await Promise.all([
    api('/api/inkd/templates'),
    api('/api/properties'),
  ]);
  modal.templates  = tplRes.ok  ? await tplRes.json()  : [];
  modal.properties = propRes.ok ? await propRes.json() : [];

  const tplSel = document.getElementById('ne-template');
  if (!modal.templates.length) {
    tplSel.innerHTML = '<option value="">No templates yet — create one first</option>';
  } else {
    tplSel.innerHTML = '<option value="">Pick a template…</option>' +
      modal.templates.map(t =>
        `<option value="${t.id}">${escapeHtml(t.name)}${t.category ? ' — ' + escapeHtml(t.category) : ''}</option>`
      ).join('');
  }
}

function closeNewEnvelope() {
  if (modal.el) modal.el.hidden = true;
}

function renderPropertyResults(query) {
  const results = document.getElementById('ne-property-results');
  const q = query.trim().toLowerCase();
  if (!q) { results.hidden = true; return; }
  const matches = modal.properties.filter(p => {
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
      const p = modal.properties.find(x => String(x.id) === row.dataset.id);
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
  if (!tplId) {
    showToast('Pick a template to continue', 'error');
    return;
  }
  const params = new URLSearchParams({ template_id: tplId });
  if (modal.selectedProperty) params.set('property_id', modal.selectedProperty.id);
  location.href = `/inkd-send.html?${params.toString()}`;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

// Wire modal events on page load
document.getElementById('btn-new-envelope').addEventListener('click', openNewEnvelope);
document.getElementById('ne-cancel').addEventListener('click', closeNewEnvelope);
document.getElementById('ne-continue').addEventListener('click', continueToComposer);
document.getElementById('ne-property-clear').addEventListener('click', clearProperty);
document.getElementById('ne-property-search').addEventListener('input', (e) => renderPropertyResults(e.target.value));
// Close on backdrop click (but not when clicking inside the modal box)
document.getElementById('new-env-modal').addEventListener('click', (e) => {
  if (e.target.id === 'new-env-modal') closeNewEnvelope();
});
// Esc closes the modal
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && modal.el && !modal.el.hidden) closeNewEnvelope();
});

load();
