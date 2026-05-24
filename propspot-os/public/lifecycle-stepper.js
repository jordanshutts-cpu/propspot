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
    { key: 'lead',       label: 'Lead' },
    { key: 'uc',         label: 'Under Contract' },
    { key: 'dd',         label: 'Due Diligence' },
    { key: 'atc',        label: 'Approved to Close' },
    { key: 'renovating', label: 'Renovating' },
    { key: 'stabilized', label: 'Stabilized' },
    { key: 'selling',    label: 'Selling' },
    { key: 'sold',       label: 'Closed' }
  ];

  // Map property state → current stage key.
  function stageFor(property) {
    if (!property) return null;
    const s = property.status, a = property.acquisition_status;
    if (s === 'sold' || s === 'assigned')                         return 'sold';
    if (s === 'selling' || s === 'listed_for_sale' || s === 'under_contract_buyer') return 'selling';
    if (s === 'renting' || s === 'rented' || s === 'listed_for_rent')               return 'stabilized';
    if (s === 'renovating')                                       return 'renovating';
    if (s === 'purchasing' && a === 'approved_to_close')          return 'atc';
    if (s === 'purchasing' && a === 'due_diligence')              return 'dd';
    if (s === 'purchasing' && a === 'under_contract')             return 'uc';
    if (s === 'dropped')                                          return null; // shown as side-track
    return 'lead';
  }

  // Pull a context-aware "next action" line from sub-stage fields on purchases.
  function nextLine(property) {
    const stage = stageFor(property);
    const p = (property?.purchases || [])[0]; // most recent purchase
    if (stage === 'uc') {
      const parts = [];
      if (p) {
        if (p.title_status === 'pending')     parts.push('Open title work');
        if (p.inspection_status === 'pending') parts.push('Schedule inspection');
      }
      if (!parts.length) parts.push('Start due diligence');
      return parts.join(' · ');
    }
    if (stage === 'dd') {
      const parts = [];
      if (p?.title_status)       parts.push('Title: ' + p.title_status);
      if (p?.inspection_status)  parts.push('Inspection: ' + p.inspection_status);
      if (p?.due_diligence_status) parts.push('DD: ' + p.due_diligence_status);
      if (p?.expected_close_date) parts.push('Close ' + formatShort(p.expected_close_date));
      return parts.length ? parts.join(' · ') : 'Complete due diligence';
    }
    if (stage === 'atc')        return 'Wire scheduled — review closing docs';
    if (stage === 'renovating') return 'Work orders in progress — track via Maintenance';
    if (stage === 'stabilized') return property.status === 'rented' ? 'Property rented — Rentvine syncs rent roll' : 'Listed for rent — awaiting tenant';
    if (stage === 'selling')    return property.status === 'under_contract_buyer' ? 'Buyer under contract — clear contingencies' : 'Listed on MLS — awaiting offers';
    if (stage === 'sold')       return 'Closed — stop holding costs, archive records';
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

    const current = stageFor(property);
    const dropped = property?.status === 'dropped';
    const currentIdx = STAGES.findIndex(s => s.key === current);

    const stepsHtml = STAGES.map((s, i) => {
      const status =
        dropped ? 'future' :
        i  <  currentIdx ? 'past'   :
        i === currentIdx ? 'current':
        'future';
      return `
        <div class="os-newchrome-step os-newchrome-step--${status}">
          <div class="os-newchrome-step-dot">${status === 'past' ? '✓' : i + 1}</div>
          <div class="os-newchrome-step-label">${s.label}</div>
        </div>`;
    }).join(`<div class="os-newchrome-step-connector"></div>`);

    const droppedBanner = dropped
      ? `<div class="os-newchrome-stepper-dropped">This property is marked Dropped — lifecycle does not apply.</div>`
      : '';

    const next = dropped ? '' : nextLine(property);

    el.innerHTML = `
      <div class="os-newchrome-stepper${dropped ? ' dropped' : ''}">
        ${droppedBanner}
        <div class="os-newchrome-stepper-steps">${stepsHtml}</div>
        ${next ? `<div class="os-newchrome-stepper-next"><span class="os-newchrome-stepper-next-label">Next:</span> ${next}</div>` : ''}
      </div>
    `;
  }

  window.LifecycleStepper = { mount, stageFor };
})();
