// Resolves an autofill_source string against a context object.
//
// Recognized roots:
//   property.<col>
//   opportunity.<col>
//   contact.<col>          (the contact_id on the envelope, if any)
//   user.<col>             (the sender / current user)
//   recipient.<role>.<col> (looks up ctx.recipients[role][col])
//   today                  ISO date string YYYY-MM-DD
//   today_long             "May 26, 2026"
//   envelope.id            UUID

function resolvePath(path, ctx) {
  if (!path || typeof path !== 'string') return null;
  const parts = path.split('.');
  const root = parts[0];

  if (root === 'today')      return ctx.today ?? null;
  if (root === 'today_long') return ctx.today_long ?? null;

  if (root === 'envelope' && parts[1] === 'id') return ctx.envelope?.id ?? null;

  if (root === 'recipient') {
    const role = parts[1];
    const col  = parts[2];
    if (!role || !col) return null;
    const r = ctx.recipients?.[role];
    if (!r || r[col] == null) return null;
    return String(r[col]);
  }

  if (['property','opportunity','contact','user'].includes(root)) {
    const obj = ctx[root];
    const col = parts[1];
    if (!obj || !col || obj[col] == null) return null;
    return String(obj[col]);
  }

  return null;
}

function resolveAllFields(templateFields, ctx) {
  const out = {};
  for (const f of templateFields) {
    out[f.id] = f.autofill_source ? resolvePath(f.autofill_source, ctx) : null;
  }
  return out;
}

module.exports = { resolvePath, resolveAllFields };
