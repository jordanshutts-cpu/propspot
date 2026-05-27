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

const params = new URLSearchParams(location.search);

const state = {
  envelope: null,
  recipients: [],
  fieldValues: [],
  pages: [],
};

async function init() {
  let envId = params.get('envelope_id');
  if (!envId) {
    const body = {
      template_id:   params.get('template_id'),
      property_id:   params.get('property_id'),
      opportunity_id:params.get('opportunity_id'),
      contact_id:    params.get('contact_id'),
    };
    if (!body.template_id) { showToast('Missing template_id', 'error'); return; }
    const r = await api('/api/inkd/envelopes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) { showToast('Failed to create envelope', 'error'); return; }
    const env = await r.json();
    envId = env.id;
    history.replaceState({}, '', `?envelope_id=${envId}`);
  }

  await loadEnvelope(envId);
  await renderPdf();
  renderRecipients();
  renderFields();

  document.getElementById('btn-add-recip').addEventListener('click', addRecipient);
  document.getElementById('btn-draft').addEventListener('click', saveDraft);
  document.getElementById('btn-send').addEventListener('click', send);
  document.getElementById('reminders-toggle').addEventListener('change', toggleReminders);
}

async function loadEnvelope(id) {
  const r = await api(`/api/inkd/envelopes/${id}`);
  if (!r.ok) { showToast('Envelope not found', 'error'); return; }
  const e = await r.json();
  state.envelope = e;
  state.recipients = e.recipients || [];
  state.fieldValues = e.field_values || [];
  document.getElementById('env-name').textContent = e.name;
  document.getElementById('reminders-toggle').checked = !!e.reminders_enabled;
}

async function renderPdf() {
  const stage = document.getElementById('pdf-stage');
  stage.innerHTML = '';
  state.pages = [];
  // /api/ URLs are our own proxy and need the PropSpot auth header; mirrors
  // the pattern inkd-template-editor.js uses for the same Cloudinary ACL
  // workaround.
  const url = state.envelope.source_pdf_url;
  const docOpts = { url };
  const token = localStorage.getItem('ros_token');
  if (token && url.startsWith('/api/')) {
    docOpts.httpHeaders = { Authorization: `Bearer ${token}` };
  }
  const pdf = await pdfjsLib.getDocument(docOpts).promise;
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const viewport = page.getViewport({ scale: 1.5 });
    const container = document.createElement('div');
    container.className = 'pdf-page';
    container.dataset.pageNumber = p;
    container.style.width = viewport.width + 'px'; container.style.height = viewport.height + 'px';
    stage.appendChild(container);
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width; canvas.height = viewport.height;
    container.appendChild(canvas);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    state.pages.push({ pageNum: p, width: viewport.width, height: viewport.height, container });
  }
  drawFieldOverlays();
}

function drawFieldOverlays() {
  for (const fv of state.fieldValues) {
    const page = state.pages.find(p => p.pageNum === fv.page_number);
    if (!page) continue;
    const div = document.createElement('div');
    div.className = 'pdf-field';
    div.style.left   = (fv.x_pct * page.width) + 'px';
    div.style.top    = (fv.y_pct * page.height) + 'px';
    div.style.width  = (fv.width_pct * page.width) + 'px';
    div.style.height = (fv.height_pct * page.height) + 'px';
    div.textContent  = fv.value || (fv.label || fv.field_type);
    if (!fv.value && fv.autofilled === false) div.style.background = 'rgba(245, 158, 11, .2)';
    page.container.appendChild(div);
  }
}

function renderRecipients() {
  const wrap = document.getElementById('recipients');
  wrap.innerHTML = '';
  state.recipients.forEach((r, i) => {
    const div = document.createElement('div'); div.className = 'recip';
    div.innerHTML = `
      <input data-k="full_name" placeholder="Full name" value="${escapeAttr(r.full_name)}">
      <input data-k="email"     placeholder="Email"     value="${escapeAttr(r.email)}">
      <input data-k="phone"     placeholder="Phone (optional)" value="${escapeAttr(r.phone)}">
      <label>Role
        <select data-k="role">
          <option value="buyer"   ${r.role==='buyer' ?'selected':''}>Buyer</option>
          <option value="seller"  ${r.role==='seller'?'selected':''}>Seller</option>
          <option value="agent"   ${r.role==='agent' ?'selected':''}>Agent</option>
          <option value="witness" ${r.role==='witness'?'selected':''}>Witness</option>
        </select>
      </label>
      <label>Order <input type="number" data-k="signing_order" value="${r.signing_order || 1}" min="1" style="width:60px"></label>
      <button data-act="del">Delete</button>`;
    div.querySelectorAll('[data-k]').forEach(inp => {
      inp.addEventListener('change', () => updateRecipient(r.id, inp.dataset.k, inp.value));
    });
    div.querySelector('[data-act=del]').addEventListener('click', () => deleteRecipient(r.id));
    wrap.appendChild(div);
  });
}

function renderFields() {
  const wrap = document.getElementById('fields-list');
  wrap.innerHTML = '';
  state.fieldValues
    .filter(fv => fv.field_type !== 'signature' && fv.field_type !== 'initial')
    .forEach(fv => {
      const row = document.createElement('div');
      row.className = 'field-row' + ((!fv.value) ? ' highlight-yellow' : '');
      const lbl = fv.label || fv.field_type;
      row.innerHTML = `<div class="label">${escapeText(lbl)}</div>`;
      const input = document.createElement('input');
      input.value = fv.value || '';
      input.addEventListener('change', () => updateFieldValue(fv.id, input.value));
      row.appendChild(input);
      wrap.appendChild(row);
    });
}

async function addRecipient() {
  const r = await api(`/api/inkd/envelopes/${state.envelope.id}/recipients`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ role: 'buyer', full_name: '', email: '', signing_order: state.recipients.length + 1 }),
  });
  if (!r.ok) return showToast('Failed', 'error');
  const created = await r.json();
  state.recipients.push(created);
  renderRecipients();
}
async function updateRecipient(id, key, value) {
  await api(`/api/inkd/envelopes/${state.envelope.id}/recipients/${id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ [key]: value }),
  });
  const r = state.recipients.find(x => x.id === id);
  if (r) r[key] = value;
}
async function deleteRecipient(id) {
  await api(`/api/inkd/envelopes/${state.envelope.id}/recipients/${id}`, { method: 'DELETE' });
  state.recipients = state.recipients.filter(r => r.id !== id);
  renderRecipients();
}
async function updateFieldValue(id, value) {
  await api(`/api/inkd/envelopes/${state.envelope.id}/field-values`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ values: [{ id, value }] }),
  });
  const fv = state.fieldValues.find(x => x.id === id);
  if (fv) { fv.value = value; }
  renderFields();
  for (const page of state.pages) page.container.querySelectorAll('.pdf-field').forEach(n => n.remove());
  drawFieldOverlays();
}
async function toggleReminders() {
  const v = document.getElementById('reminders-toggle').checked;
  await api(`/api/inkd/envelopes/${state.envelope.id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reminders_enabled: v }),
  });
}
async function saveDraft() {
  showToast('Draft saved');
}
async function send() {
  if (!state.recipients.length) return showToast('Add at least one recipient before sending', 'error');
  const missing = state.recipients.find(r => !r.email || !r.full_name);
  if (missing) return showToast('Every recipient needs a name + email', 'error');
  const r = await api(`/api/inkd/envelopes/${state.envelope.id}/send`, { method: 'POST' });
  if (!r.ok) { const j = await r.json().catch(()=>({})); return showToast('Send failed: ' + (j.error || r.statusText), 'error'); }
  showToast('Envelope sent');
  location.href = `/inkd.html?lane=out`;
}

function escapeAttr(s) { return String(s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function escapeText(s) { return escapeAttr(s); }

init();
