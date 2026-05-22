// Authorization helpers for Pulse entity-comments.
//
// A user can access an entity_thread if ANY of the following is true:
//   1) They are a propspot owner (users.is_owner = TRUE).
//   2) Ambient access: the consumer app's pulse_authz_<entity_type> view
//      returns a row for (entity_id, user_id). For inbox_thread that means
//      the user has an Inbox app_grant covering the shared inbox.
//   3) Per-thread mention grant: pulse_entity_thread_grants has a row
//      for (entity_thread_id, user_id).
//
// We DO NOT trust client-supplied entity_type strings for view name
// construction — they're whitelisted here.

const { query } = require('../db');

const SUPPORTED_ENTITY_TYPES = new Set(['inbox_thread']);

function isEntityTypeSupported(entityType) {
  return SUPPORTED_ENTITY_TYPES.has(entityType);
}

// Returns the corresponding view name. NEVER concatenate user input into SQL —
// callers must check isEntityTypeSupported first; this function asserts.
function authzViewName(entityType) {
  if (!isEntityTypeSupported(entityType)) {
    throw new Error(`Unsupported entity_type: ${entityType}`);
  }
  return `pulse_authz_${entityType}`;
}

// Returns { allowed, entityThreadId?, via? } for the (user, entity_type, entity_id) tuple.
// Lazy-creates the pulse_entity_threads row if it doesn't exist AND the user has
// ambient access (so a non-ambient user can't bootstrap a thread by GET'ing it).
async function canAccessEntity({ userId, entityType, entityId }) {
  if (!isEntityTypeSupported(entityType)) return { allowed: false };

  // 1. Owner short-circuit.
  const { rows: ownerRows } = await query(
    `SELECT is_owner FROM users WHERE id = $1`,
    [userId]
  );
  const isOwner = !!ownerRows[0]?.is_owner;

  // 2. Ambient view check. View name is hard-coded after whitelist check — no
  //    injection surface. entityId is bound as $1.
  const viewName = authzViewName(entityType);
  const { rows: ambientRows } = await query(
    `SELECT 1 FROM ${viewName} WHERE entity_id = $1 AND user_id = $2 LIMIT 1`,
    [entityId, userId]
  );
  const hasAmbient = isOwner || ambientRows.length > 0;

  // 3. Find or lazy-create the entity_thread row.
  const { rows: etRows } = await query(
    `SELECT id FROM pulse_entity_threads WHERE entity_type = $1 AND entity_id = $2`,
    [entityType, entityId]
  );
  let entityThreadId = etRows[0]?.id;

  // 4. If no row exists yet AND the user has no ambient access, deny —
  //    a non-ambient user can't bootstrap a thread (no one has mentioned them).
  if (!entityThreadId && !hasAmbient) {
    return { allowed: false };
  }

  // 5. Lazy create the entity_thread row (only reachable when hasAmbient).
  if (!entityThreadId) {
    const ins = await query(
      `INSERT INTO pulse_entity_threads (entity_type, entity_id)
       VALUES ($1, $2)
       ON CONFLICT (entity_type, entity_id) DO UPDATE SET updated_at = NOW()
       RETURNING id`,
      [entityType, entityId]
    );
    entityThreadId = ins.rows[0].id;
  }

  // 6. Allow when ambient. Otherwise check per-thread grant.
  if (hasAmbient) {
    return { allowed: true, entityThreadId, via: isOwner ? 'owner' : 'ambient' };
  }
  const { rows: grantRows } = await query(
    `SELECT 1 FROM pulse_entity_thread_grants
      WHERE entity_thread_id = $1 AND user_id = $2 LIMIT 1`,
    [entityThreadId, userId]
  );
  if (grantRows.length) {
    return { allowed: true, entityThreadId, via: 'grant' };
  }
  return { allowed: false };
}

// Cheap variant for SSE filtering: given a known entity_thread row, check if
// the user has access. Re-resolves entity_type + entity_id and dispatches to
// canAccessEntity.
async function canAccessEntityThread({ userId, entityThreadId }) {
  const { rows: etRows } = await query(
    `SELECT entity_type, entity_id FROM pulse_entity_threads WHERE id = $1`,
    [entityThreadId]
  );
  if (!etRows[0]) return false;
  const result = await canAccessEntity({
    userId,
    entityType: etRows[0].entity_type,
    entityId:   etRows[0].entity_id
  });
  return result.allowed;
}

module.exports = {
  SUPPORTED_ENTITY_TYPES,
  isEntityTypeSupported,
  canAccessEntity,
  canAccessEntityThread
};
