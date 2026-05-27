// Worker-facing JS for the Timesheets app. Admin/approver code is appended in
// later tasks (kept in one file to match patterns in pulse.js / inbox.js).

(async function() {
  const $ = (id) => document.getElementById(id);
  const fmt = (mins) => (mins / 60).toFixed(1) + ' hrs';
  const pad = (n) => String(n).padStart(2, '0');

  let currentOpen = null;       // open entry, or null
  let timerInterval = null;

  function authFetch(path, opts = {}) {
    const token = localStorage.getItem('token');
    return fetch(path, {
      ...opts,
      headers: { ...(opts.headers || {}),
                 'Authorization': 'Bearer ' + token,
                 'Content-Type': 'application/json' },
    }).then(r => r.ok ? r.json() : r.json().then(b => Promise.reject(b)));
  }

  function renderTimer() {
    if (!currentOpen) { $('ts-timer').hidden = true; return; }
    const start = new Date(currentOpen.started_at).getTime();
    const tick = () => {
      const secs = Math.floor((Date.now() - start) / 1000);
      $('ts-timer').textContent = `${Math.floor(secs/3600)}:${pad(Math.floor((secs%3600)/60))}:${pad(secs%60)}`;
    };
    tick();
    clearInterval(timerInterval);
    timerInterval = setInterval(tick, 1000);
    $('ts-timer').hidden = false;
  }

  function setClockState(open) {
    currentOpen = open;
    const btn = $('ts-clock-btn');
    if (open) {
      btn.textContent = 'Clock Out';
      btn.classList.remove('idle'); btn.classList.add('active');
      $('ts-switch-btn').hidden = false;
    } else {
      btn.textContent = 'Clock In';
      btn.classList.remove('active'); btn.classList.add('idle');
      $('ts-switch-btn').hidden = true;
      clearInterval(timerInterval); $('ts-timer').hidden = true;
    }
    renderTimer();
  }

  function tagsFromForm() {
    return {
      project_id:    $('ts-project').value   || null,
      property_id:   $('ts-property').value  || null,
      work_order_id: $('ts-workorder').value || null,
      category:      $('ts-category').value  || null,
    };
  }

  async function onClockClick() {
    if (currentOpen) {
      const entry = await authFetch('/api/timesheets/clock-out', { method: 'POST' });
      setClockState(null);
      await refreshEntries();
    } else {
      const entry = await authFetch('/api/timesheets/clock-in', {
        method: 'POST', body: JSON.stringify(tagsFromForm()),
      });
      setClockState(entry);
      await refreshEntries();
    }
  }

  async function onSwitchClick() {
    const entry = await authFetch('/api/timesheets/switch', {
      method: 'POST', body: JSON.stringify(tagsFromForm()),
    });
    setClockState(entry);
    await refreshEntries();
  }

  function renderEntries(entries) {
    const today = new Date().toISOString().slice(0, 10);
    const todays = entries.filter(e => e.started_at.slice(0, 10) === today);
    const list = $('ts-today-list');
    list.innerHTML = todays.map(e => `
      <li class="ts-entry">
        <span class="ts-when">
          ${new Date(e.started_at).toLocaleTimeString([], {hour:'numeric', minute:'2-digit'})}
          – ${e.ended_at ? new Date(e.ended_at).toLocaleTimeString([], {hour:'numeric', minute:'2-digit'}) : 'now'}
        </span>
        <span class="ts-dur">${e.duration_minutes ? fmt(e.duration_minutes) : '…'}</span>
        <span class="ts-tag-text">${e.category || ''}</span>
      </li>
    `).join('') || '<li class="ts-empty">No entries today yet.</li>';

    const totalMin = entries.reduce((s, e) => s + (e.duration_minutes || 0), 0);
    $('ts-period-hours').textContent = fmt(totalMin);
  }

  async function refreshEntries() {
    const entries = await authFetch('/api/timesheets/me/entries');
    renderEntries(entries);
  }

  async function populateTagDropdowns() {
    // Projects
    try {
      const projects = await authFetch('/api/projects');
      $('ts-project').innerHTML = '<option value="">Project…</option>' +
        projects.map(p => `<option value="${p.id}">${p.name || p.address || p.id}</option>`).join('');
    } catch {}
    // Properties
    try {
      const props = await authFetch('/api/properties?limit=100');
      $('ts-property').innerHTML = '<option value="">Property…</option>' +
        (props.items || props).map(p => `<option value="${p.id}">${p.address_line1}, ${p.city}</option>`).join('');
    } catch {}
    // Work orders (assigned to me)
    try {
      const wos = await authFetch('/api/my-work-orders');
      $('ts-workorder').innerHTML = '<option value="">Work order…</option>' +
        (wos.items || wos).map(w => `<option value="${w.id}">${w.title || w.id}</option>`).join('');
    } catch {}
    // Categories from settings (may not exist yet)
    try {
      const settings = await authFetch('/api/timesheets/settings');
      $('ts-category').innerHTML = '<option value="">Category…</option>' +
        (settings.category_options || []).map(c => `<option value="${c}">${c}</option>`).join('');
    } catch {}
  }

  async function openManualModal() {
    const modal = $('ts-manual-modal');
    const settings = await authFetch('/api/timesheets/settings').catch(() => ({}));
    $('ts-manual-category').innerHTML = '<option value="">Category…</option>' +
      (settings.category_options || []).map(c => `<option value="${c}">${c}</option>`).join('');
    modal.showModal();
  }

  document.addEventListener('submit', async (e) => {
    if (e.target.id !== 'ts-manual-form') return;
    const submitter = e.submitter && e.submitter.value;
    if (submitter !== 'save') return;
    const fd = new FormData(e.target);
    const date = fd.get('date'), start = fd.get('start'), end = fd.get('end');
    const startedAt = new Date(`${date}T${start}:00`).toISOString();
    const endedAt   = new Date(`${date}T${end}:00`).toISOString();
    await authFetch('/api/timesheets/entries', {
      method: 'POST',
      body: JSON.stringify({
        started_at: startedAt, ended_at: endedAt,
        category: fd.get('category') || null,
        notes: fd.get('notes') || null,
      }),
    });
    $('ts-manual-modal').close();
    await refreshEntries();
  });

  async function init() {
    $('ts-clock-btn').addEventListener('click', onClockClick);
    $('ts-switch-btn').addEventListener('click', onSwitchClick);
    $('ts-add-manual').addEventListener('click', openManualModal);
    await populateTagDropdowns();
    const open = await authFetch('/api/timesheets/me/current');
    setClockState(open);
    await refreshEntries();
  }

  init().catch(err => console.error('[timesheets]', err));
})();
