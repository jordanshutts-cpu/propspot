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
  // Load autofill sources for the dropdown
  const ar = await fetch('/api/inkd/templates/autofill-sources');
  state.autofillSources = await ar.json();
  populateAutofillDropdown();

  if (templateId) {
    const r = await fetch(`/api/inkd/templates/${templateId}`);
    if (!r.ok) { alert('Template not found'); return; }
    state.template = await r.json();
    document.getElementById('tpl-name').value = state.template.name;
    document.getElementById('tpl-category').value = state.template.category || '';
    state.fields = state.template.fields || [];
    await loadAndRenderPdf(state.template.source_pdf_url);
  } else {
    document.getElementById('pdf-upload').addEventListener('change', onPdfPicked);
  }

  document.querySelectorAll('.field-btn').forEach(b =>
    b.addEventListener('click', () => setTool(b.dataset.type)));
  document.getElementById('btn-save').addEventListener('click', save);
  document.getElementById('btn-delete-field').addEventListener('click', deleteSelectedField);
  ['f-label','f-role','f-autofill','f-required'].forEach(id =>
    document.getElementById(id).addEventListener('change', applySelectedFieldEdits));
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
  await renderPdfFromUrl(url);
}

async function renderPdfFromUrl(url) {
  const stage = document.getElementById('pdf-stage');
  stage.querySelectorAll('.pdf-page').forEach(n => n.remove());
  state.pages = [];

  const pdf = await pdfjsLib.getDocument(url).promise;
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
    div.style.left   = (f.x_pct * page.width) + 'px';
    div.style.top    = (f.y_pct * page.height) + 'px';
    div.style.width  = (f.width_pct * page.width) + 'px';
    div.style.height = (f.height_pct * page.height) + 'px';
    div.textContent  = (f.label || f.field_type) + (f.recipient_role ? ` (${f.recipient_role})` : '');
    div.addEventListener('click', (e) => { e.stopPropagation(); state.selectedFieldIndex = i; renderAllFields(); showSelectedForm(); });
    page.container.appendChild(div);
  });
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
  if (!name) { alert('Template name is required'); return; }

  // Step A: if new template, upload the PDF + create the template
  if (!state.template) {
    if (!state.pdfBytes) { alert('Upload a PDF first'); return; }
    const fd = new FormData();
    fd.append('file', new Blob([state.pdfBytes], { type: 'application/pdf' }), 'template.pdf');
    fd.append('name', name);
    fd.append('category', category);
    const r = await fetch('/api/inkd/templates', { method: 'POST', body: fd });
    if (!r.ok) { alert('Failed to upload PDF'); return; }
    state.template = await r.json();
    history.replaceState({}, '', `?id=${state.template.id}`);
  } else {
    await fetch(`/api/inkd/templates/${state.template.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, category }),
    });
  }

  // Step B: save fields
  const r2 = await fetch(`/api/inkd/templates/${state.template.id}/fields`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fields: state.fields }),
  });
  if (!r2.ok) { alert('Failed to save fields'); return; }
  alert('Template saved');
}

init();
