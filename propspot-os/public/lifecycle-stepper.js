// ============================================================
//  Prop Spot — Lifecycle Stepper (new-chrome Phase 2)
//  Renders a horizontal step bar above the property detail
//  card showing the property's current lifecycle stage and
//  what's next. Derives stage from properties.status and
//  properties.acquisition_status (the single source of truth).
//
//  Usage:
//    <div id="lifecycle-stepper"></div>
//    <script>
//      LifecycleStepper.mount('lifecycle-stepper', propertyObject);
//    </script>
//  Or just put the div and call mount() after fetching the property.
// ============================================================

(function () {
  if (!window.__newChromeEnabled || !window.__newChromeEnabled()) return;

  const STAGES = [
    { key: 'prospect',    label: 'Prospect' },
    { key: 'lead',        label: 'Lead' },
    { key: 'opportunity', label: 'Opportunity' },
    { key: 'acquisition', label: 'Acquisition' },
    { key: 'project',     label: 'Project' },
    { key: 'holdings',    label: 'Holdings' },
    { key: 'disposition', label: 'Disposition' },
    { key: 'sold',        label: 'Sold' }
  ];

  // Map property state → current stage key.
  // Prospect/Lead/Opportunity are derived from the presence of sub-rows
  // (property.prospects, .leads, .opportunities) when the property itself
  // hasn't been promoted into a status='purchasing' or later state yet.
  function stageFor(property) {
    if (!property) return null;
    const s = property.status, a = property.acquisition_status;
    if (s === 'dropped')                                                          return 'dead'; // off-track
    if (s === 'sold' || s === 'assigned')                                         return 'sold';
    if (s === 'selling' || s === 'listed_for_sale' || s === 'under_contract_buyer') return 'disposition';
    if (s === 'renting' || s === 'rented' || s === 'listed_for_rent')               return 'holdings';
    if (s === 'renovating')                                                       return 'project';
    if (s === 'purchasing')                                                       return 'acquisition';
    // No property status yet → infer from sub-records.
    if ((property.opportunities || []).some(r => r.status !== 'dead' && r.status !== 'promoted')) return 'opportunity';
    if ((property.leads        || []).some(r => r.status !== 'dead' && r.status !== 'promoted')) return 'lead';
    if ((property.prospects    || []).some(r => r.status !== 'dead' && r.status !== 'promoted')) return 'prospect';
    return 'prospect';
  }

  // Pull a context-aware "next action" line.
  // For Acquisition, drill into purchases.* sub-stage fields so the
  // "Next:" line reflects where in UC → DD → ATC the deal actually sits.
  function nextLine(property) {
    const stage = stageFor(property);
    const a     = property?.acquisition_status;
    const p     = (property?.purchases || [])[0]; // most recent purchase

    if (stage === 'prospect')    return 'Reach out — phone / SMS / mail';
    if (stage === 'lead')        return 'Qualify the lead — set an appointment';
    if (stage === 'opportunity') return 'Present the offer — get a signed contract';

    if (stage === 'acquisition') {
      // Show where in UC → DD → ATC we are, plus title / inspection sub-status.
      const parts = [];
      if (a === 'under_contract')    parts.push('Under Contract');
      if (a === 'due_diligence')     parts.push('Due Diligence');
      if (a === 'approved_to_close') parts.push('Approved to Close');
      if (p?.title_status)            parts.push('Title: ' + p.title_status);
      if (p?.inspection_status)       parts.push('Inspection: ' + p.inspection_status);
      if (p?.expected_close_date)     parts.push('Close ' + formatShort(p.expected_close_date));
      return parts.length ? parts.join(' · ') : 'Open title work, schedule inspection';
    }

    if (stage === 'project')     return 'Renovating — dispatch subs, upload photos, request draws';
    if (stage === 'holdings')    return property.status === 'rented'
      ? 'Rented — Rentvine syncs rent roll, holdings track ongoing costs'
      : 'Listed for rent — awaiting tenant';
    if (stage === 'disposition') return property.status === 'under_contract_buyer'
      ? 'Buyer under contract — clear contingencies through closing'
      : 'Listed on MLS — awaiting offers';
    if (stage === 'sold')        return 'Sold — stop holding costs, archive records';
    if (stage === 'dead')        return 'Dropped — no further action';
    return 'Move this property into the pipeline';
  }

  function formatShort(iso) {
    if (!iso) return '';
    try { return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); }
    catch (e) { return iso; }
  }

  function mount(elementOrId, property) {
    const el = typeof elementOrId === 'string'
      ? document.getElementById(elementOrId)
      : elementOrId;
    if (!el) return;

    const current    = stageFor(property);
    const isDead     = current === 'dead';
    const isSold     = current === 'sold';
    const currentIdx = STAGES.findIndex(s => s.key === current);

    // Progress = (completed + current/2) ÷ total. Sold = 100%, Dead = 0%.
    const pct = isDead ? 0
              : isSold ? 100
              : Math.round(((currentIdx + 0.5) / STAGES.length) * 100);
    const currentStage = STAGES[currentIdx];
    const stageLabel = isDead ? 'Dead'
                     : (currentStage ? currentStage.label : 'Unknown');

    const stepsHtml = STAGES.map((s, i) => {
      const status =
        isDead ? 'future' :
        i  <  currentIdx ? 'past'   :
        i === currentIdx ? 'current':
        'future';
      // Past steps use a clean checkmark SVG (avoids unicode glyph quirks
      // when the premium emoji scanner runs over the stepper).
      const inner = status === 'past'
        ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" width="13" height="13"><polyline points="20 6 9 17 4 12"/></svg>`
        : i + 1;
      return `
        <div class="os-newchrome-step os-newchrome-step--${status}">
          <div class="os-newchrome-step-dot">${inner}</div>
          <div class="os-newchrome-step-label">${s.label}</div>
        </div>`;
    }).join(`<div class="os-newchrome-step-connector"></div>`);

    const deadBanner = isDead
      ? `<div class="os-newchrome-stepper-dropped">
           <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>
           This property is marked <strong>Dead</strong> — won't be acquired.
         </div>`
      : '';

    const next = nextLine(property);
    // Progress bar — colored from 0 to pct% behind the stepper rail.
    const progressBarStyle = `--lc-progress: ${pct}%;`;

    el.innerHTML = `
      <div class="os-newchrome-stepper${isDead ? ' dropped' : ''}" style="${progressBarStyle}">
        ${deadBanner}
        <div class="os-newchrome-stepper-header">
          <div class="os-newchrome-stepper-eyebrow">Property Lifecycle</div>
          <div class="os-newchrome-stepper-progress">
            <span class="os-newchrome-stepper-progress-label">${escHtmlLocal(stageLabel)}</span>
            <span class="os-newchrome-stepper-progress-pct">${pct}<span class="pct-sign">%</span></span>
          </div>
        </div>
        <div class="os-newchrome-stepper-track">
          <div class="os-newchrome-stepper-rail"></div>
          <div class="os-newchrome-stepper-rail-fill"></div>
          <div class="os-newchrome-stepper-steps">${stepsHtml}</div>
        </div>
        ${next ? `
          <div class="os-newchrome-stepper-next">
            <span class="os-newchrome-stepper-next-label">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" width="11" height="11"><polyline points="9 18 15 12 9 6"/></svg>
              Next
            </span>
            <span class="os-newchrome-stepper-next-text">${next}</span>
          </div>` : ''}
      </div>
    `;
  }

  // Tiny local escape — lifecycle-stepper loads on satellites that may not
  // expose the host page's escHtml() helper.
  function escHtmlLocal(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"]/g, c =>
      ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[c]));
  }

  window.LifecycleStepper = { mount, stageFor };
})();
