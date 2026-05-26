// Static list of autofill source paths available in the template editor.
// Add new entries here when extending the data model.

const SOURCES = [
  { group: 'Property', paths: [
    { value: 'property.address',  label: 'Property — Street address' },
    { value: 'property.city',     label: 'Property — City' },
    { value: 'property.state',    label: 'Property — State' },
    { value: 'property.zip',      label: 'Property — ZIP' },
    { value: 'property.parcel_id',label: 'Property — Parcel ID' },
    { value: 'property.year_built', label: 'Property — Year built' },
    { value: 'property.square_feet', label: 'Property — Square feet' },
    { value: 'property.beds',     label: 'Property — Bedrooms' },
    { value: 'property.baths',    label: 'Property — Bathrooms' },
  ]},
  { group: 'Opportunity', paths: [
    { value: 'opportunity.purchase_price',         label: 'Opportunity — Purchase price' },
    { value: 'opportunity.earnest_money',          label: 'Opportunity — Earnest money' },
    { value: 'opportunity.closing_date',           label: 'Opportunity — Closing date' },
    { value: 'opportunity.contingency_period_days',label: 'Opportunity — Contingency period (days)' },
  ]},
  { group: 'Contact (per-role)', paths: [
    { value: 'recipient.buyer.full_name',  label: 'Buyer — Full name' },
    { value: 'recipient.buyer.email',      label: 'Buyer — Email' },
    { value: 'recipient.buyer.phone',      label: 'Buyer — Phone' },
    { value: 'recipient.seller.full_name', label: 'Seller — Full name' },
    { value: 'recipient.seller.email',     label: 'Seller — Email' },
    { value: 'recipient.seller.phone',     label: 'Seller — Phone' },
    { value: 'recipient.agent.full_name',  label: 'Agent — Full name' },
    { value: 'recipient.agent.email',      label: 'Agent — Email' },
    { value: 'recipient.witness.full_name',label: 'Witness — Full name' },
  ]},
  { group: 'Current user / sender', paths: [
    { value: 'user.full_name', label: 'Sender — Full name' },
    { value: 'user.email',     label: 'Sender — Email' },
  ]},
  { group: 'Computed', paths: [
    { value: 'today',      label: "Today's date (ISO)" },
    { value: 'today_long', label: "Today's date (May 26, 2026)" },
    { value: 'envelope.id',label: 'Envelope ID' },
  ]},
];

module.exports = { SOURCES };
