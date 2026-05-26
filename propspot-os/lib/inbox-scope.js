// Resolve an inbox app_grants.scope JSONB into the set of shared_inbox_ids
// the caller may see.
//
// Scope shapes:
//   { "all": true }                        — every shared inbox
//   { "inbox_ids": ["uuid", ...] }        — only the listed inboxes

const { query } = require('../db');

async function scopedInboxIds(scope, ownerUserId = null) {
  // Personal inboxes (owner_user_id set) are only visible to their owner.
  // The "shared" scope (app_grants.scope) controls access to team inboxes;
  // personal access is owner-only and bypasses grants entirely.
  let ownedIds = [];
  if (ownerUserId) {
    const { rows } = await query(
      `SELECT id FROM inbox_shared WHERE owner_user_id = $1`,
      [ownerUserId]
    );
    ownedIds = rows.map(r => r.id);
  }

  // Unrestricted shared access — return every non-personal inbox plus the
  // caller's own personals. Owners' "all" grant still excludes others'
  // personal inboxes.
  if (!scope || scope.all) {
    if (!ownerUserId) return null; // legacy callers — preserve old semantics
    const { rows } = await query(
      `SELECT id FROM inbox_shared
        WHERE owner_user_id IS NULL OR owner_user_id = $1`,
      [ownerUserId]
    );
    return rows.map(r => r.id);
  }

  // Explicit list from scope + owned personals.
  const explicit = Array.isArray(scope.inbox_ids) ? scope.inbox_ids : [];
  const merged = [...new Set([...explicit, ...ownedIds])];
  if (!merged.length) return [];
  const { rows } = await query(
    `SELECT id FROM inbox_shared WHERE id = ANY($1::uuid[])`,
    [merged]
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
