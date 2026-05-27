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
const templateId = params.get('id'); // null = new template

const state = {
  template: null,           // template row from server (set on load or after save)
  fields: [],               // [{ id?, page_number, x_pct, y_pct, width_pct, height_pct, field_type, label, recipient_role, required, autofill_source }]
  selectedFieldIndex: null,
  toolMode: null,           // 'text' | 'signature' | 'initial' | 'date' | 'checkbox' | null
  pages: [],                // [{ pageNum, width, height, container }]
  autofillSources: [],      // groups from server
  pdfBytes: null,           // ArrayBuffer if a new PDF was just uploaded but not saved yet
};

async function init() {
  // Wire DOM event listeners SYNCHRONOUSLY first — before any await.
  // Otherwise a user who clicks Choose File during the autofill-sources
  // fetch will fire a 'change' event with no listener attached, and the
  // PDF upload silently does nothing.
  if (!templateId) {
    document.getElementById('pdf-upload').addEventListener('change', onPdfPicked);
  }
  document.querySelectorAll('.field-btn').forEach(b =>
    b.addEventListener('click', () => setTool(b.dataset.type)));
  document.getElementById('btn-save').addEventListener('click', save);
  document.getElementById('btn-delete-field').addEventListener('click', deleteSelectedField);
  ['f-label','f-role','f-autofill','f-required'].forEach(id =>
    document.getElementById(id).addEventListener('change', applySelectedFieldEdits));

  // Document-level drag handlers so drags continue even if the cursor
  // leaves the field while resizing/moving.
  document.addEventListener('mousemove', onDragMove);
  document.addEventListener('mouseup',   onDragEnd);

  // Now do the async work — load autofill sources for the dropdown.
  try {
    const ar = await api('/api/inkd/templates/autofill-sources');
    state.autofillSources = await ar.json();
    populateAutofillDropdown();
  } catch (err) {
    console.error('Failed to load autofill sources', err);
  }

  if (templateId) {
    const r = await api(`/api/inkd/templates/${templateId}`);
    if (!r.ok) { showToast('Template not found', 'error'); return; }
    state.template = await r.json();
    document.getElementById('tpl-name').value = state.template.name;
    document.getElementById('tpl-category').value = state.template.category || '';
    state.fields = state.template.fields || [];

    if (!state.template.source_pdf_url) {
      showPdfError("This template doesn't have a PDF attached. Archive it and create a new one.", null);
    } else {
      await loadAndRenderPdf(state.template.source_pdf_url);
    }
  }
}

// Render a friendly error in the PDF stage instead of leaving it blank
// when getDocument() throws (404, CORS, bad URL, malformed file, etc.).
function showPdfError(message, err) {
  const stage = document.getElementById('pdf-stage');
  stage.querySelectorAll('.pdf-page').forEach(n => n.remove());
  document.querySelector('#upload-prompt')?.remove();
  document.querySelector('#pdf-error')?.remove();

  const wrap = document.createElement('div');
  wrap.id = 'pdf-error';
  wrap.style.cssText = 'max-width:520px;margin:80px auto;text-align:center;padding:24px;background:var(--surface);border:1.5px solid var(--border);border-radius:12px;color:var(--text);';
  const url = state.template?.source_pdf_url || '';
  wrap.innerHTML = `
    <div style="font-size:2rem;margin-bottom:8px;">📄</div>
    <h2 style="margin:8px 0;font-size:1.05rem;">Couldn't load the template PDF</h2>
    <p style="color:var(--text-muted);font-size:.88rem;margin:0 0 12px;">${escapeHtml(message)}</p>
    ${err ? `<p style="color:var(--text-muted);font-size:.78rem;font-family:monospace;background:var(--bg);padding:8px 12px;border-radius:6px;margin:0 0 12px;text-align:left;white-space:pre-wrap;word-break:break-word;">${escapeHtml(String(err.message || err))}</p>` : ''}
    ${url ? `<p style="font-size:.78rem;margin:0;"><a href="${escapeHtml(url)}" target="_blank" style="color:var(--brand);">Open PDF URL directly</a> to verify the file itself is reachable.</p>` : ''}
  `;
  stage.appendChild(wrap);
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

function populateAutofillDropdown() {
  const sel = document.getElementById('f-autofill');
  sel.innerHTML = '<option value="">(no autofill)</option>';
  for (const grp of state.autofillSources) {
    const og = document.createElement('optgroup');
    og.label = grp.group;
    for (const p of grp.paths) {
      const o = document.createElement('option');
      o.value = p.value; o.textContent = p.label;
      og.appendChild(o);
    }
    sel.appendChild(og);
  }
}

async function onPdfPicked(e) {
  const file = e.target.files[0];
  if (!file) return;
  state.pdfBytes = await file.arrayBuffer();
  document.getElementById('upload-prompt').remove();
  const dataUrl = URL.createObjectURL(file);
  await renderPdfFromUrl(dataUrl);
}

async function loadAndRenderPdf(url) {
  document.querySelector('#upload-prompt')?.remove();
  document.querySelector('#pdf-error')?.remove();
  try {
    await renderPdfFromUrl(url);
  } catch (err) {
    console.error('PDF render failed', err);
    showPdfError('The stored PDF URL is unreachable or not a valid PDF.', err);
  }
}

async function renderPdfFromUrl(url) {
  const stage = document.getElementById('pdf-stage');
  stage.querySelectorAll('.pdf-page').forEach(n => n.remove());
  state.pages = [];

  // When url points at our own /api/ proxy, attach the PropSpot
  // Authorization header so requireAuth lets the request through.
  // Same-origin Blob/data URLs (used for fresh uploads pre-save) and
  // external URLs are passed without the header.
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
    container.style.width  = viewport.width + 'px';
    container.style.height = viewport.height + 'px';
    stage.appendChild(container);

    const canvas = document.createElement('canvas');
    canvas.width  = viewport.width;
    canvas.height = viewport.height;
    container.appendChild(canvas);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;

    state.pages.push({ pageNum: p, width: viewport.width, height: viewport.height, container });
    wireFieldPlacement(container, p);
  }
  renderAllFields();
}

function setTool(type) {
  document.querySelectorAll('.field-btn').forEach(b => b.classList.toggle('active', b.dataset.type === type));
  state.toolMode = type;
}

function wireFieldPlacement(pageEl, pageNumber) {
  let dragStart = null;
  let dragRect = null;
  pageEl.addEventListener('mousedown', (e) => {
    if (!state.toolMode) return;
    if (e.target !== pageEl && e.target.tagName !== 'CANVAS') return;
    const rect = pageEl.getBoundingClientRect();
    dragStart = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    dragRect = document.createElement('div');
    dragRect.className = 'pdf-field';
    dragRect.style.left = dragStart.x + 'px';
    dragRect.style.top  = dragStart.y + 'px';
    pageEl.appendChild(dragRect);
    e.preventDefault();
  });
  pageEl.addEventListener('mousemove', (e) => {
    if (!dragStart) return;
    const rect = pageEl.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    dragRect.style.left   = Math.min(x, dragStart.x) + 'px';
    dragRect.style.top    = Math.min(y, dragStart.y) + 'px';
    dragRect.style.width  = Math.abs(x - dragStart.x) + 'px';
    dragRect.style.height = Math.abs(y - dragStart.y) + 'px';
  });
  window.addEventListener('mouseup', () => {
    if (!dragStart || !dragRect) { dragStart = null; return; }
    const pageInfo = state.pages.find(p => p.pageNum === pageNumber);
    const x = parseFloat(dragRect.style.left), y = parseFloat(dragRect.style.top);
    const w = parseFloat(dragRect.style.width) || 80, h = parseFloat(dragRect.style.height) || 24;
    const field = {
      page_number: pageNumber,
      x_pct: x / pageInfo.width,
      y_pct: y / pageInfo.height,
      width_pct: w / pageInfo.width,
      height_pct: h / pageInfo.height,
      field_type: state.toolMode,
      label: defaultLabelForType(state.toolMode),
      recipient_role: null,
      required: true,
      autofill_source: null,
    };
    dragRect.remove();
    state.fields.push(field);
    state.selectedFieldIndex = state.fields.length - 1;
    setTool(null);
    renderAllFields();
    showSelectedForm();
    dragStart = null; dragRect = null;
  });
}

function defaultLabelForType(t) {
  return { text: 'Text', signature: 'Signature', initial: 'Initial', date: 'Date', checkbox: 'Checkbox' }[t] || t;
}

function renderAllFields() {
  for (const page of state.pages) {
    page.container.querySelectorAll('.pdf-field').forEach(n => n.remove());
  }
  state.fields.forEach((f, i) => {
    const page = state.pages.find(p => p.pageNum === f.page_number);
    if (!page) return;
    const div = document.createElement('div');
    div.className = 'pdf-field' + (i === state.selectedFieldIndex ? ' selected' : '');
    div.dataset.fieldIndex = String(i);
    div.style.left   = (f.x_pct * page.width) + 'px';
    div.style.top    = (f.y_pct * page.height) + 'px';
    div.style.width  = (f.width_pct * page.width) + 'px';
    div.style.height = (f.height_pct * page.height) + 'px';

    const label = document.createElement('span');
    label.className = 'pdf-field-label';
    label.textContent = (f.label || f.field_type) + (f.recipient_role ? ` (${f.recipient_role})` : '');
    div.appendChild(label);

    // Resize handle in the bottom-right corner.
    const handle = document.createElement('div');
    handle.className = 'resize-handle';
    handle.title = 'Drag to resize';
    div.appendChild(handle);

    // Click to select (suppressed after a real drag — see mouseup handler).
    div.addEventListener('click', (e) => {
      if (state._suppressNextClick) { state._suppressNextClick = false; return; }
      if (e.target === handle) return;
      e.stopPropagation();
      state.selectedFieldIndex = i;
      renderAllFields();
      showSelectedForm();
    });

    // Start resize on handle mousedown.
    handle.addEventListener('mousedown', (e) => beginDrag(e, 'resize', i, page));

    // Start move on field-body mousedown (but not on the handle).
    div.addEventListener('mousedown', (e) => {
      if (e.target === handle) return;
      beginDrag(e, 'move', i, page);
    });

    page.container.appendChild(div);
  });
}

function beginDrag(e, kind, fieldIndex, page) {
  e.stopPropagation();
  e.preventDefault();
  const f = state.fields[fieldIndex];
  state.dragOp = {
    kind,
    startX: e.clientX,
    startY: e.clientY,
    fieldIndex,
    page,
    original: { x_pct: f.x_pct, y_pct: f.y_pct, width_pct: f.width_pct, height_pct: f.height_pct },
    moved: false,
  };
  state.selectedFieldIndex = fieldIndex;
}

function onDragMove(e) {
  const op = state.dragOp;
  if (!op) return;
  const dx = e.clientX - op.startX;
  const dy = e.clientY - op.startY;
  if (!op.moved && (Math.abs(dx) > 2 || Math.abs(dy) > 2)) op.moved = true;

  const f = state.fields[op.fieldIndex];
  const page = op.page;
  const minW = 20, minH = 12;

  if (op.kind === 'resize') {
    let newW = op.original.width_pct * page.width + dx;
    let newH = op.original.height_pct * page.height + dy;
    newW = Math.max(minW, Math.min(newW, page.width  - f.x_pct * page.width));
    newH = Math.max(minH, Math.min(newH, page.height - f.y_pct * page.height));
    f.width_pct  = newW / page.width;
    f.height_pct = newH / page.height;
  } else {
    let newX = op.original.x_pct * page.width  + dx;
    let newY = op.original.y_pct * page.height + dy;
    newX = Math.max(0, Math.min(newX, page.width  - f.width_pct  * page.width));
    newY = Math.max(0, Math.min(newY, page.height - f.height_pct * page.height));
    f.x_pct = newX / page.width;
    f.y_pct = newY / page.height;
  }

  // Update just the affected element so the rest of the editor doesn't flicker.
  const div = page.container.querySelector(`.pdf-field[data-field-index="${op.fieldIndex}"]`);
  if (div) {
    div.style.left   = (f.x_pct * page.width)  + 'px';
    div.style.top    = (f.y_pct * page.height) + 'px';
    div.style.width  = (f.width_pct  * page.width)  + 'px';
    div.style.height = (f.height_pct * page.height) + 'px';
  }
}

function onDragEnd() {
  const op = state.dragOp;
  if (!op) return;
  state._suppressNextClick = op.moved;
  state.dragOp = null;
  if (op.moved) {
    // Re-render to refresh the selected-field form (in case coords are shown there)
    // and ensure z-order is consistent.
    renderAllFields();
    showSelectedForm();
  }
}

function showSelectedForm() {
  const i = state.selectedFieldIndex;
  const isOpen = i != null && state.fields[i];
  document.getElementById('selected-empty').hidden = isOpen;
  document.getElementById('selected-form').hidden = !isOpen;
  if (!isOpen) return;
  const f = state.fields[i];
  document.getElementById('f-label').value = f.label || '';
  document.getElementById('f-role').value = f.recipient_role || '';
  document.getElementById('f-autofill').value = f.autofill_source || '';
  document.getElementById('f-required').checked = f.required !== false;
}

function applySelectedFieldEdits() {
  const i = state.selectedFieldIndex; if (i == null) return;
  const f = state.fields[i];
  f.label = document.getElementById('f-label').value || null;
  f.recipient_role = document.getElementById('f-role').value || null;
  f.autofill_source = document.getElementById('f-autofill').value || null;
  f.required = document.getElementById('f-required').checked;
  renderAllFields();
}

function deleteSelectedField() {
  const i = state.selectedFieldIndex; if (i == null) return;
  state.fields.splice(i, 1);
  state.selectedFieldIndex = null;
  renderAllFields();
  showSelectedForm();
}

async function save() {
  const name = document.getElementById('tpl-name').value.trim();
  const category = document.getElementById('tpl-category').value;
  if (!name) { showToast('Template name is required', 'error'); return; }

  // Step A: if new template, upload the PDF + create the template
  if (!state.template) {
    if (!state.pdfBytes) { showToast('Upload a PDF first', 'error'); return; }
    const fd = new FormData();
    fd.append('file', new Blob([state.pdfBytes], { type: 'application/pdf' }), 'template.pdf');
    fd.append('name', name);
    fd.append('category', category);
    const r = await api('/api/inkd/templates', { method: 'POST', body: fd });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      const where = j.stage ? ` (${j.stage})` : '';
      showToast('Upload failed' + where + ': ' + (j.detail || j.error || r.statusText), 'error');
      return;
    }
    state.template = await r.json();
    history.replaceState({}, '', `?id=${state.template.id}`);
  } else {
    await api(`/api/inkd/templates/${state.template.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, category }),
    });
  }

  // Step B: save fields
  const r2 = await api(`/api/inkd/templates/${state.template.id}/fields`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fields: state.fields }),
  });
  if (!r2.ok) {
    const j = await r2.json().catch(() => ({}));
    showToast('Failed to save fields: ' + (j.detail || j.error || r2.statusText), 'error');
    return;
  }
  showToast('Template saved');
}

init();
