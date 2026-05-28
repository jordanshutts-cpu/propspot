// ─────────────────────────────────────────────────────────────────
//  property-access helpers
//
//  Single source of truth for "can user X see property Y?"
//
//  Rules:
//    • Owners (is_owner = TRUE)               → see EVERYTHING
//    • External workers (user_type=external_worker)
//        → see ONLY properties they have an explicit property_access row for
//        → uploading / commenting / viewing photos on other properties is blocked
//    • Team members (user_type=team)
//        → see unrestricted properties + any restricted ones they're listed on
//        → "restricted" is determined by the presence of TEAM-USER rows in
//          property_access; rows belonging to external workers do NOT lock
//          the property for the rest of the team
// ─────────────────────────────────────────────────────────────────
const { query } = require('../db');

async function _user(userId) {
  const { rows } = await query(
    `SELECT is_owner, user_type FROM users WHERE id = $1`, [userId]
  );
  return rows[0] || null;
}

/** Returns true if `userId` can see / write to `propertyId`. */
async function userCanAccessProperty(userId, propertyId) {
  const u = await _user(userId);
  if (!u) return false;
  if (u.is_owner) return true;

  if (u.user_type === 'external_worker') {
    const { rows } = await query(
      `SELECT 1 FROM property_access WHERE property_id = $1 AND user_id = $2 LIMIT 1`,
      [propertyId, userId]
    );
    return rows.length > 0;
  }

  // Team member
  const { rows } = await query(`
    SELECT
      (SELECT 1 FROM property_access pa
         JOIN users uu ON uu.id = pa.user_id
        WHERE pa.property_id = $1 AND uu.user_type = 'team'
        LIMIT 1) AS team_locked,
      (SELECT 1 FROM property_access
        WHERE property_id = $1 AND user_id = $2 LIMIT 1) AS listed
  `, [propertyId, userId]);
  const r = rows[0];
  return !r.team_locked || !!r.listed;
}

/**
 * Returns a SQL WHERE-clause fragment (and a single parameter, the user id)
 * to be appended to a property-listing query. Caller appends as:
 *
 *   const f = await propertyFilterSql(req.userId, 'p.id');
 *   if (f) { sql += ' AND ' + f.sql.replace(/\$1/g, '$' + (params.length + 1));
 *            params.push(f.param); }
 *
 * Returns null for owners (no filter needed).
 */
async function propertyFilterSql(userId, propertyIdExpr = 'p.id') {
  const u = await _user(userId);
  if (!u || u.is_owner) return null;

  if (u.user_type === 'external_worker') {
    return {
      sql: `EXISTS (SELECT 1 FROM property_access pa
                     WHERE pa.property_id = ${propertyIdExpr} AND pa.user_id = $1)`,
      param: userId
    };
  }
  // Team
  return {
    sql: `(NOT EXISTS (SELECT 1 FROM property_access pa
                         JOIN users uu ON uu.id = pa.user_id
                        WHERE pa.property_id = ${propertyIdExpr} AND uu.user_type = 'team')
           OR EXISTS (SELECT 1 FROM property_access pa
                       WHERE pa.property_id = ${propertyIdExpr} AND pa.user_id = $1))`,
    param: userId
  };
}

module.exports = { userCanAccessProperty, propertyFilterSql };
