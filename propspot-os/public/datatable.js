// ============================================================
//  Prop Spot — DataTable
//  Sortable, resizable, reorderable columns with localStorage
//  persistence per page (keyed by storageKey in opts).
//  Usage:
//    renderDataTable('#table-mount', rows, {
//      storageKey: 'acquisitions-v1',
//      columns: [
//        { key: 'address_line1', label: 'Address', width: 220, sortable: true,
//          render: (row) => row.address_line1 },
//        ...
//      ],
//      onRowClick: (row) => location.href = '/property.html?id=' + row.id
//    });
// ============================================================

function _dtKey(storageKey, suffix) { return `dt:${storageKey}:${suffix}`; }
function _dtReadJSON(k, fallback) {
  try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; }
  catch { return fallback; }
}
function _dtWriteJSON(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }

function _dtCompare(a, b, dir) {
  if (a == null && b == null) return 0;
  if (a == null) return 1;       // nulls sort last regardless of direction
  if (b == null) return -1;
  // Try numeric first
  const an = parseFloat(a), bn = parseFloat(b);
  if (!isNaN(an) && !isNaN(bn) && String(an) === String(a).trim() && String(bn) === String(b).trim()) {
    return (an - bn) * (dir === 'desc' ? -1 : 1);
  }
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' })
    * (dir === 'desc' ? -1 : 1);
}

function renderDataTable(mount, rows, opts) {
  const root = (typeof mount === 'string') ? document.querySelector(mount) : mount;
  if (!root) return;
  const storageKey = opts.storageKey || 'default';
  const baseCols = opts.columns;

  // Restore preferences (column order, widths, hidden, sort)
  const prefs = _dtReadJSON(_dtKey(storageKey, 'prefs'), {});
  const order = (prefs.order && prefs.order.length === baseCols.length) ? prefs.order : baseCols.map(c => c.key);
  const widths = prefs.widths || {};
  const sort = prefs.sort || (opts.defaultSort || null);

  // Resolve columns in user-saved order
  const colsByKey = Object.fromEntries(baseCols.map(c => [c.key, c]));
  const cols = order.map(k => colsByKey[k]).filter(Boolean);

  // Apply sort
  let data = rows.slice();
  if (sort && sort.key) {
    const col = colsByKey[sort.key];
    if (col) {
      const accessor = col.sortValue || col.render || (r => r[col.key]);
      data.sort((a, b) => _dtCompare(accessor(a), accessor(b), sort.dir));
    }
  }

  // Build HTML
  const colgroup = cols.map(c =>
    `<col data-key="${c.key}" style="width:${widths[c.key] || c.width || 160}px;">`
  ).join('');

  const ths = cols.map((c) => {
    const arrow = (sort && sort.key === c.key) ? (sort.dir === 'desc' ? ' ▼' : ' ▲') : '';
    const sortClass = c.sortable !== false ? 'dt-sortable' : '';
    return `<th class="${sortClass}" data-key="${c.key}" draggable="true">
      <span class="dt-th-label">${c.label}${arrow}</span>
      <span class="dt-resize" data-key="${c.key}"></span>
    </th>`;
  }).join('');

  const tbody = data.map((row) => {
    const tds = cols.map(c => {
      const v = c.render ? c.render(row) : (row[c.key] != null ? String(row[c.key]) : '');
      return `<td data-key="${c.key}">${v}</td>`;
    }).join('');
    return `<tr data-row-id="${row.id || ''}">${tds}</tr>`;
  }).join('');

  root.innerHTML = `
    <div class="dt-wrap">
      <table class="dt-table">
        <colgroup>${colgroup}</colgroup>
        <thead><tr>${ths}</tr></thead>
        <tbody>${tbody || `<tr><td colspan="${cols.length}" class="dt-empty">No matches.</td></tr>`}</tbody>
      </table>
    </div>
  `;

  // ── Wire interactions ─────────────────────────────────────
  const tableEl = root.querySelector('.dt-table');

  // Click sort
  tableEl.querySelectorAll('th.dt-sortable .dt-th-label').forEach(span => {
    span.addEventListener('click', (e) => {
      const th = e.target.closest('th');
      const key = th.dataset.key;
      let nextDir = 'asc';
      if (sort && sort.key === key && sort.dir === 'asc') nextDir = 'desc';
      else if (sort && sort.key === key && sort.dir === 'desc') {
        // third click → clear sort
        const newPrefs = { ...prefs, sort: null };
        _dtWriteJSON(_dtKey(storageKey, 'prefs'), newPrefs);
        renderDataTable(root, rows, opts);
        return;
      }
      const newPrefs = { ...prefs, sort: { key, dir: nextDir } };
      _dtWriteJSON(_dtKey(storageKey, 'prefs'), newPrefs);
      renderDataTable(root, rows, opts);
    });
  });

  // Row click
  if (opts.onRowClick) {
    tableEl.querySelectorAll('tbody tr').forEach((tr, i) => {
      tr.addEventListener('click', () => opts.onRowClick(data[i]));
    });
  }

  // Column resize (drag the right edge)
  tableEl.querySelectorAll('.dt-resize').forEach(handle => {
    handle.addEventListener('mousedown', (downEvt) => {
      downEvt.preventDefault();
      downEvt.stopPropagation();
      const key = handle.dataset.key;
      const colEl = tableEl.querySelector(`colgroup col[data-key="${key}"]`);
      if (!colEl) return;
      const startX = downEvt.clientX;
      const startW = colEl.offsetWidth;
      const onMove = (moveEvt) => {
        const newW = Math.max(60, Math.min(800, startW + (moveEvt.clientX - startX)));
        colEl.style.width = newW + 'px';
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        const newWidths = { ...widths, [key]: parseInt(colEl.style.width, 10) };
        _dtWriteJSON(_dtKey(storageKey, 'prefs'), { ...prefs, widths: newWidths });
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  });

  // Column drag-and-drop reorder (HTML5 drag on <th>)
  let draggingKey = null;
  tableEl.querySelectorAll('thead th').forEach(th => {
    th.addEventListener('dragstart', (e) => {
      draggingKey = th.dataset.key;
      th.classList.add('dt-dragging');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', draggingKey); } catch {}
    });
    th.addEventListener('dragend', () => {
      th.classList.remove('dt-dragging');
      tableEl.querySelectorAll('th').forEach(x => x.classList.remove('dt-drop-target'));
      draggingKey = null;
    });
    th.addEventListener('dragover', (e) => {
      if (!draggingKey || draggingKey === th.dataset.key) return;
      e.preventDefault();
      th.classList.add('dt-drop-target');
    });
    th.addEventListener('dragleave', () => th.classList.remove('dt-drop-target'));
    th.addEventListener('drop', (e) => {
      e.preventDefault();
      th.classList.remove('dt-drop-target');
      if (!draggingKey || draggingKey === th.dataset.key) return;
      const newOrder = order.slice();
      const fromIdx = newOrder.indexOf(draggingKey);
      const toIdx   = newOrder.indexOf(th.dataset.key);
      if (fromIdx < 0 || toIdx < 0) return;
      newOrder.splice(fromIdx, 1);
      newOrder.splice(toIdx, 0, draggingKey);
      _dtWriteJSON(_dtKey(storageKey, 'prefs'), { ...prefs, order: newOrder });
      renderDataTable(root, rows, opts);
    });
  });
}

// Convenience: clear the saved layout for a storageKey (debug / reset).
function resetDataTablePrefs(storageKey) {
  localStorage.removeItem(_dtKey(storageKey, 'prefs'));
}
