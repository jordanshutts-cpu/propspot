// Helpers for applying the user's app_grant scope to queries.
// Scope shapes:
//   {"all": true}                     — full access
//   {"project_ids": ["uuid", ...]}    — only properties that own those projects

const { query } = require('../db');

// Resolve a scope into a set of property_ids the user can see.
// Returns null when the user has full access (scope.all === true).
async function scopedPropertyIds(scope) {
  if (!scope || scope.all) return null;
  const ids = scope.project_ids || [];
  if (!ids.length) return [];
  const { rows } = await query(
    `SELECT DISTINCT property_id FROM projects WHERE id = ANY($1::uuid[])`,
    [ids]
  );
  return rows.map(r => r.property_id);
}

module.exports = { scopedPropertyIds };
