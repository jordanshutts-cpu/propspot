// Resolve an inbox app_grants.scope JSONB into the set of shared_inbox_ids
// the caller may see.
//
// Scope shapes:
//   { "all": true }                        — every shared inbox
//   { "inbox_ids": ["uuid", ...] }        — only the listed inboxes

const { query } = require('../db');

async function scopedInboxIds(scope) {
  if (!scope || scope.all) return null; // null = unrestricted
  const ids = Array.isArray(scope.inbox_ids) ? scope.inbox_ids : [];
  if (!ids.length) return [];
  // Optional: validate that the inboxes still exist.
  const { rows } = await query(
    `SELECT id FROM inbox_shared WHERE id = ANY($1::uuid[])`,
    [ids]
  );
  return rows.map(r => r.id);
}

async function scopedPropertyIds(scope) {
  // Inbox scope is per-inbox, not per-property. But we still respect the
  // FieldCam-style project scope (used for save-to-property): if the user's
  // overall grant set restricts them to specific projects, we use that.
  // Owners (scope.all) get unrestricted.
  if (!scope || scope.all) return null;
  // No project scoping on Inbox grants in Phase 1 — return null for now.
  return null;
}

module.exports = { scopedInboxIds, scopedPropertyIds };
