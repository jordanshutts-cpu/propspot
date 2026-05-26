(async () => {
  const r = await fetch('/api/inkd/templates');
  const tpls = await r.json();
  const tbody = document.querySelector('#tpl-table tbody');
  for (const t of tpls) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td style="padding:10px"><a href="/inkd-template-editor.html?id=${t.id}">${escapeHtml(t.name)}</a></td>
      <td style="padding:10px">${escapeHtml(t.category||'')}</td>
      <td style="padding:10px">${t.page_count}</td>
      <td style="padding:10px">${new Date(t.updated_at).toLocaleDateString()}</td>
      <td style="padding:10px"><button data-id="${t.id}">Archive</button></td>`;
    tr.querySelector('button').addEventListener('click', async () => {
      if (!confirm('Archive this template?')) return;
      await fetch(`/api/inkd/templates/${t.id}`, { method: 'DELETE' });
      location.reload();
    });
    tbody.appendChild(tr);
  }
})();

function escapeHtml(s) { return String(s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
