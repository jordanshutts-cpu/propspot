// ============================================================
//  Prop Spot — Shared Kanban Renderer
//  Used by acquisitions / holdings / dispositions / closed.
//  Stateless: caller manages the properties array and re-renders
//  on changes. Library handles DOM, drag-and-drop, and the move
//  callback only.
// ============================================================

// Render a kanban board into `el`.
//   el        — container element
//   props     — array of property objects
//   opts.lanes      — [[value, label, color], ...]    (left → right order is fixed)
//   opts.field      — 'status' or 'acquisition_status' (which field drives the lane)
//   opts.laneFor    — optional (p) => string | null  (map a property to a lane key;
//                     return null to hide; defaults to p[field])
//   opts.onCardMove — async (propertyId, newLaneValue) => void  (called on drop;
//                     library does NOT call this if drop lane equals current lane)
function renderKanban(el, props, opts) {
  const { lanes, field } = opts;
  const groupBy = opts.laneFor || ((p) => p[field]);

  // Set --kanban-cols so the responsive grid adapts to the lane count.
  el.style.setProperty('--kanban-cols', lanes.length);

  const byLane = Object.fromEntries(lanes.map(([k]) => [k, []]));
  for (const p of props) {
    const lane = groupBy(p);
    if (lane == null) continue;
    if (byLane[lane] != null) byLane[lane].push(p);
  }

  el.innerHTML = `
    <div class="kanban">
      ${lanes.map(([key, label, color]) => `
        <section class="kanban-col" data-lane="${escHtml(key)}">
          <header class="kanban-col-head">
            <span class="kanban-swatch" style="background:${color};"></span>
            <span class="kanban-title">${escHtml(label)}</span>
            <span class="kanban-count">${byLane[key].length}</span>
          </header>
          <div class="kanban-col-body" data-dropzone>
            ${byLane[key].length
              ? byLane[key].map(kanbanCardHtml).join('')
              : '<div class="empty-lane">Drag a property here</div>'}
          </div>
        </section>
      `).join('')}
    </div>
  `;

  wireKanbanDnD(el, props, groupBy, opts.onCardMove);
}

function kanbanCardHtml(p) {
  const ownerLine = p.owner_name || p.owner || '';
  const cityLine  = [p.city, p.state].filter(Boolean).join(', ');
  // Date line preference: anticipated_close_date (acquisitions) > purchase_date (closed/post-close)
  let dateLine = '';
  if (p.anticipated_close_date) {
    dateLine = `Anticipated purchase ${fmtKbDate(p.anticipated_close_date)}`;
  } else if (p.purchase_date) {
    dateLine = `Purchased ${fmtKbDate(p.purchase_date)}`;
  }
  const addrText = (p.address_line1 || '') + (p.unit ? ' #' + p.unit : '');
  return `
    <div class="kanban-card" draggable="true" data-id="${escHtml(p.id)}">
      <a class="kanban-addr-link" href="/property.html?id=${encodeURIComponent(p.id)}" draggable="false" title="${escHtml(addrText)}">${escHtml(addrText)}</a>
      <div class="kanban-meta">
        ${cityLine ? `<span>${escHtml(cityLine)}</span>` : ''}
        ${cityLine && (ownerLine || dateLine) ? '<span class="dot">·</span>' : ''}
        ${ownerLine ? `<span>${escHtml(ownerLine)}</span>` : ''}
        ${ownerLine && dateLine ? '<span class="dot">·</span>' : ''}
        ${dateLine ? `<span>${escHtml(dateLine)}</span>` : ''}
      </div>
    </div>
  `;
}

function fmtKbDate(d) {
  if (!d) return '';
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function wireKanbanDnD(el, props, groupBy, onCardMove) {
  const cards = el.querySelectorAll('.kanban-card');
  const cols  = el.querySelectorAll('.kanban-col');

  cards.forEach(card => {
    card.addEventListener('dragstart', e => {
      card.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', card.dataset.id);
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      el.querySelectorAll('.kanban-col.drag-over').forEach(c => c.classList.remove('drag-over'));
    });
  });

  cols.forEach(col => {
    col.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      col.classList.add('drag-over');
    });
    col.addEventListener('dragleave', e => {
      if (!col.contains(e.relatedTarget)) col.classList.remove('drag-over');
    });
    col.addEventListener('drop', async e => {
      e.preventDefault();
      col.classList.remove('drag-over');
      const id = e.dataTransfer.getData('text/plain');
      const newLane = col.dataset.lane;
      if (!id || !newLane) return;

      const prop = props.find(p => p.id === id);
      if (!prop) return;
      if (groupBy(prop) === newLane) return;   // no-op

      if (typeof onCardMove === 'function') {
        await onCardMove(id, newLane);
      }
    });
  });
}

// Shared toast for kanban moves (and any other transient feedback).
// Adds an element if missing; show/hide is non-blocking.
let _kbToastTimer;
function showKbToast(msg, isError = false) {
  let el = document.getElementById('kb-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'kb-toast';
    el.className = 'kb-toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.toggle('error', !!isError);
  el.classList.add('show');
  clearTimeout(_kbToastTimer);
  _kbToastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}
