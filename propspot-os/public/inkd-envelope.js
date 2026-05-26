(async () => {
  const id = new URLSearchParams(location.search).get('id');
  const r = await fetch(`/api/inkd/envelopes/${id}`);
  const e = await r.json();
  document.getElementById('env-title').textContent = e.name;
  document.getElementById('env-status').textContent = e.status + (e.filed_at ? ' (filed)' : '');
  document.getElementById('pdf-iframe').src = e.final_pdf_url || e.source_pdf_url;
  const rec = document.getElementById('recipients');
  for (const r of e.recipients || []) {
    const div = document.createElement('div'); div.className = 'recipient-row';
    div.innerHTML = `<strong>${escapeHtml(r.full_name)}</strong> (${escapeHtml(r.role)}) — <span class="status ${r.status}">${r.status}</span><br><span style="font-size:11px;color:#666">${escapeHtml(r.email)}</span>`;
    rec.appendChild(div);
  }
  const a = await fetch(`/api/inkd/envelopes/${id}/audit`).then(x => x.ok ? x.json() : []);
  const auditEl = document.getElementById('audit');
  for (const ev of a) {
    const d = document.createElement('div');
    d.textContent = `${new Date(ev.event_at).toLocaleString()}  ·  ${ev.event_type}${ev.ip ? ' · ' + ev.ip : ''}`;
    auditEl.appendChild(d);
  }
})();

function escapeHtml(s) { return String(s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
