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
    const currentIdx = STAGES.findIndex(s => s.key === current);

    const stepsHtml = STAGES.map((s, i) => {
      const status =
        isDead ? 'future' :
        i  <  currentIdx ? 'past'   :
        i === currentIdx ? 'current':
        'future';
      return `
        <div class="os-newchrome-step os-newchrome-step--${status}">
          <div class="os-newchrome-step-dot">${status === 'past' ? '✓' : i + 1}</div>
          <div class="os-newchrome-step-label">${s.label}</div>
        </div>`;
    }).join(`<div class="os-newchrome-step-connector"></div>`);

    const deadBanner = isDead
      ? `<div class="os-newchrome-stepper-dropped">💀 This property is marked Dead — won't be acquired.</div>`
      : '';

    const next = nextLine(property);

    el.innerHTML = `
      <div class="os-newchrome-stepper${isDead ? ' dropped' : ''}">
        ${deadBanner}
        <div class="os-newchrome-stepper-steps">${stepsHtml}</div>
        ${next ? `<div class="os-newchrome-stepper-next"><span class="os-newchrome-stepper-next-label">Next:</span> ${next}</div>` : ''}
      </div>
    `;
  }

  window.LifecycleStepper = { mount, stageFor };
})();
