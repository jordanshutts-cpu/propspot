// Keeps app_grants.scope.project_ids in sync with property_contacts.
//
// Whenever a contact is linked to or unlinked from a property with role
// 'contractor' (or any role we want to gate by), we recompute the set of
// project_ids that contact's user can see across all apps where their grant
// has scope = {"project_ids":[...]}.
//
// Grants with scope = {"all": true} are NEVER touched by this code.

const { query } = require('../db');

// Returns the array of project IDs reachable through this contact's
// property_contacts links.
async function projectIdsForContact(contactId) {
  const { rows } = await query(`
    SELECT DISTINCT pr.id
    FROM property_contacts pc
    JOIN projects pr ON pr.property_id = pc.property_id
    WHERE pc.contact_id = $1
  `, [contactId]);
  return rows.map(r => r.id);
}

// Recompute scope.project_ids for every project-scoped grant belonging to the
// user linked to this contact. Idempotent.
async function recomputeScopeForContact(contactId) {
  const { rows: contactRows } = await query(
    'SELECT user_id FROM contacts WHERE id = $1', [contactId]
  );
  const userId = contactRows[0]?.user_id;
  if (!userId) return; // contact has no associated user — nothing to do

  const ids = await projectIdsForContact(contactId);

  await query(`
    UPDATE app_grants
       SET scope = jsonb_set(scope, '{project_ids}', $2::jsonb, true)
     WHERE user_id = $1
       AND scope ? 'project_ids'
  `, [userId, JSON.stringify(ids)]);
}

// Same recompute, but for every contact a user has (used when grants are
// edited or when a user accepts an invite).
async function recomputeScopeForUser(userId) {
  const { rows: contacts } = await query(
    'SELECT id FROM contacts WHERE user_id = $1', [userId]
  );
  if (!contacts.length) return;

  const allIds = new Set();
  for (const c of contacts) {
    (await projectIdsForContact(c.id)).forEach(id => allIds.add(id));
  }
  await query(`
    UPDATE app_grants
       SET scope = jsonb_set(scope, '{project_ids}', $2::jsonb, true)
     WHERE user_id = $1
       AND scope ? 'project_ids'
  `, [userId, JSON.stringify([...allIds])]);
}

module.exports = { projectIdsForContact, recomputeScopeForContact, recomputeScopeForUser };
