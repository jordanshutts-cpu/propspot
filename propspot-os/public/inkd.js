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

load();
