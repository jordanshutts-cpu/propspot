const { query } = require('../db');

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
