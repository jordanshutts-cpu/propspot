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

(async () => {
  const r = await api('/api/inkd/templates');
  const tpls = await r.json();
  const tbody = document.querySelector('#tpl-table tbody');
  if (!tpls.length) {
    tbody.innerHTML = '<tr><td colspan="5" style="padding:20px;text-align:center;color:var(--text-muted)">No templates yet. <a href="/inkd-template-editor.html" style="color:var(--brand)">Create the first one</a>.</td></tr>';
    return;
  }
  for (const t of tpls) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><a href="/inkd-template-editor.html?id=${t.id}">${escapeHtml(t.name)}</a></td>
      <td>${escapeHtml(t.category||'')}</td>
      <td>${t.page_count}</td>
      <td>${new Date(t.updated_at).toLocaleDateString()}</td>
      <td><button class="archive-btn" data-id="${t.id}">Archive</button></td>`;
    tr.querySelector('button').addEventListener('click', async () => {
      if (!confirm('Archive this template?')) return;
      await api(`/api/inkd/templates/${t.id}`, { method: 'DELETE' });
      location.reload();
    });
    tbody.appendChild(tr);
  }
})();

function escapeHtml(s) { return String(s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
