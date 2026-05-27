const { query } = require('../db');

async function logFieldChange({ entryId, changedBy, field, oldValue, newValue, reason = null }) {
  await query(`
    INSERT INTO timesheet_audit_log (entry_id, changed_by, field, old_value, new_value, reason)
    VALUES ($1, $2, $3, $4, $5, $6)
  `, [entryId, changedBy, field,
      oldValue === null || oldValue === undefined ? null : String(oldValue),
      newValue === null || newValue === undefined ? null : String(newValue),
      reason]);
}

// Diffs `before` vs `after` and writes one audit row per changed field.
async function logFieldChanges({ entryId, changedBy, before, after, reason = null }) {
  for (const key of Object.keys(after)) {
    if (String(before?.[key] ?? '') === String(after[key] ?? '')) continue;
    await logFieldChange({
      entryId, changedBy, field: key,
      oldValue: before?.[key], newValue: after[key], reason,
    });
  }
}

module.exports = { logFieldChange, logFieldChanges };
