const params = new URLSearchParams(location.search);
const token = params.get('token');
let state = { envelope: null, me: null, fields: [], pages: [], pendingSigField: null };
let sigPad = null;

async function init() {
  if (!token) { document.body.innerHTML = '<p style="padding:40px">Missing signing token.</p>'; return; }
  const r = await fetch(`/api/inkd/signing/${token}`);
  if (!r.ok) { document.body.innerHTML = '<p style="padding:40px">This signing link is invalid or expired.</p>'; return; }
  const data = await r.json();
  state.envelope = data.envelope;
  state.me = data.me;
  state.fields = data.fields;
  document.getElementById('env-title').textContent = `${state.envelope.name} — signing as ${state.me.full_name} (${state.me.role})`;
  await renderPdf();
  drawFields();
  updateFinishButton();
  document.getElementById('btn-finish').addEventListener('click', submit);
  document.getElementById('btn-decline').addEventListener('click', decline);
  wireSigModal();
}

async function renderPdf() {
  const stage = document.getElementById('pdf-stage');
  const pdf = await pdfjsLib.getDocument(state.envelope.source_pdf_url).promise;
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const viewport = page.getViewport({ scale: 1.5 });
    const container = document.createElement('div');
    container.className = 'pdf-page'; container.dataset.pageNumber = p;
    container.style.width = viewport.width + 'px'; container.style.height = viewport.height + 'px';
    stage.appendChild(container);
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width; canvas.height = viewport.height;
    container.appendChild(canvas);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    state.pages.push({ pageNum: p, width: viewport.width, height: viewport.height, container });
  }
}

function drawFields() {
  for (const page of state.pages) page.container.querySelectorAll('.field').forEach(n => n.remove());
  for (const fv of state.fields) {
    const page = state.pages.find(p => p.pageNum === fv.page_number);
    if (!page) continue;
    const div = document.createElement('div');
    div.className = 'field';
    div.style.left = (fv.x_pct * page.width) + 'px';
    div.style.top  = (fv.y_pct * page.height) + 'px';
    div.style.width  = (fv.width_pct * page.width) + 'px';
    div.style.height = (fv.height_pct * page.height) + 'px';

    const isMine    = fv.recipient_id === state.me.id;
    const isTheirs  = fv.recipient_id && fv.recipient_id !== state.me.id;

    if (isMine) {
      div.classList.add('mine');
      if (fv.value) div.classList.add('filled');
      mountMineEditor(div, fv);
    } else if (isTheirs) {
      div.classList.add('theirs');
      div.textContent = fv.value ? '(filled)' : (fv.label || fv.field_type);
    } else {
      div.classList.add('preview-only');
      div.textContent = fv.value || fv.label || '';
    }
    page.container.appendChild(div);
  }
}

function mountMineEditor(div, fv) {
  if (fv.field_type === 'text') {
    const inp = document.createElement('input'); inp.type = 'text'; inp.value = fv.value || '';
    inp.addEventListener('input', () => { fv.value = inp.value; updateFinishButton(); div.classList.toggle('filled', !!inp.value); });
    div.appendChild(inp);
  } else if (fv.field_type === 'date') {
    const inp = document.createElement('input'); inp.type = 'date'; inp.value = fv.value || '';
    inp.addEventListener('change', () => { fv.value = inp.value; updateFinishButton(); div.classList.toggle('filled', !!inp.value); });
    div.appendChild(inp);
  } else if (fv.field_type === 'checkbox') {
    const inp = document.createElement('input'); inp.type = 'checkbox'; inp.checked = fv.value === 'true';
    inp.addEventListener('change', () => { fv.value = inp.checked ? 'true' : 'false'; updateFinishButton(); });
    div.appendChild(inp);
  } else if (fv.field_type === 'signature' || fv.field_type === 'initial') {
    if (fv.value) {
      const img = document.createElement('img'); img.src = fv.value; img.className = 'sig-img';
      div.appendChild(img);
    } else {
      div.textContent = fv.field_type === 'signature' ? 'Click to sign' : 'Click to initial';
    }
    div.addEventListener('click', () => openSigModal(fv, div));
  }
}

function updateFinishButton() {
  const mine = state.fields.filter(f => f.recipient_id === state.me.id);
  const allFilled = mine.every(f => f.value && f.value !== '');
  document.getElementById('btn-finish').disabled = !allFilled;
}

function wireSigModal() {
  const canvas = document.getElementById('sig-canvas');
  sigPad = new SignaturePad(canvas, { backgroundColor: '#fafafa' });
  document.getElementById('sig-clear').addEventListener('click', () => sigPad.clear());
  document.getElementById('sig-cancel').addEventListener('click', closeSigModal);
  document.getElementById('sig-save').addEventListener('click', applySignature);
}

function openSigModal(fv, divEl) {
  state.pendingSigField = { fv, divEl };
  document.getElementById('sig-kind').textContent = fv.field_type === 'initial' ? 'initials' : 'signature';
  document.getElementById('sig-modal').hidden = false;
  sigPad.clear();
}
function closeSigModal() { document.getElementById('sig-modal').hidden = true; state.pendingSigField = null; }

async function applySignature() {
  if (sigPad.isEmpty()) { alert('Please draw your signature first'); return; }
  const dataUrl = sigPad.toDataURL('image/png');
  const r = await fetch(`/api/inkd/signing/${token}/upload-signature`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dataUrl }),
  });
  if (!r.ok) { alert('Failed to upload signature'); return; }
  const { url } = await r.json();
  const { fv, divEl } = state.pendingSigField;
  fv.value = url;
  divEl.classList.add('filled');
  divEl.innerHTML = '';
  const img = document.createElement('img'); img.src = url; img.className = 'sig-img';
  divEl.appendChild(img);
  closeSigModal();
  updateFinishButton();
}

async function submit() {
  const mine = state.fields.filter(f => f.recipient_id === state.me.id);
  const values = mine.map(f => ({ id: f.id, value: f.value }));
  const r = await fetch(`/api/inkd/signing/${token}/submit`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ values }),
  });
  if (!r.ok) { alert('Submit failed'); return; }
  document.body.innerHTML = '<div style="padding:80px;text-align:center"><h1>Thank you!</h1><p>Your signature has been recorded. You may close this window.</p></div>';
}

async function decline() {
  const reason = prompt('Why are you declining? (optional)');
  const r = await fetch(`/api/inkd/signing/${token}/decline`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reason }),
  });
  if (!r.ok) { alert('Decline failed'); return; }
  document.body.innerHTML = '<div style="padding:80px;text-align:center"><h1>Declined</h1><p>The sender has been notified.</p></div>';
}

init();
