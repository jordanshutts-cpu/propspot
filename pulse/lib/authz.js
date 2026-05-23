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

// Private: find-or-create the pulse_entity_threads row for (entity_type, entity_id).
// Caller MUST have already verified entityType is supported AND that the user
// is authorized to lazy-create (owner or ambient). No authz check here.
async function ensureEntityThread(entityType, entityId) {
  const { rows: etRows } = await query(
    `SELECT id FROM pulse_entity_threads WHERE entity_type = $1 AND entity_id = $2`,
    [entityType, entityId]
  );
  if (etRows[0]) return etRows[0].id;
  const ins = await query(
    `INSERT INTO pulse_entity_threads (entity_type, entity_id)
     VALUES ($1, $2)
     ON CONFLICT (entity_type, entity_id) DO UPDATE SET updated_at = NOW()
     RETURNING id`,
    [entityType, entityId]
  );
  return ins.rows[0].id;
}

// Returns { allowed, entityThreadId?, via? } for the (user, entity_type, entity_id) tuple.
// Lazy-creates the pulse_entity_threads row if it doesn't exist AND the user has
// ambient access (so a non-ambient user can't bootstrap a thread by GET'ing it).
async function canAccessEntity({ userId, entityType, entityId }) {
  if (!isEntityTypeSupported(entityType)) return { allowed: false };

  // 1. Owner short-circuit. Owners always have access; skip the ambient query.
  const { rows: ownerRows } = await query(
    `SELECT is_owner FROM users WHERE id = $1`,
    [userId]
  );
  if (ownerRows[0]?.is_owner) {
    const entityThreadId = await ensureEntityThread(entityType, entityId);
    return { allowed: true, entityThreadId, via: 'owner' };
  }

  // 2. Ambient view check. View name is hard-coded after whitelist check — no
  //    injection surface. entityId/userId are bound as $1/$2.
  const viewName = authzViewName(entityType);
  const { rows: ambientRows } = await query(
    `SELECT 1 FROM ${viewName} WHERE entity_id = $1 AND user_id = $2 LIMIT 1`,
    [entityId, userId]
  );
  const hasAmbient = ambientRows.length > 0;

  // 3. If user has no ambient, see if a thread row + per-thread grant exist.
  if (!hasAmbient) {
    const { rows: etRows } = await query(
      `SELECT id FROM pulse_entity_threads WHERE entity_type = $1 AND entity_id = $2`,
      [entityType, entityId]
    );
    if (!etRows[0]) return { allowed: false };
    const entityThreadId = etRows[0].id;
    const { rows: grantRows } = await query(
      `SELECT 1 FROM pulse_entity_thread_grants
        WHERE entity_thread_id = $1 AND user_id = $2 LIMIT 1`,
      [entityThreadId, userId]
    );
    if (grantRows.length) return { allowed: true, entityThreadId, via: 'grant' };
    return { allowed: false };
  }

  // 4. User has ambient — find or lazy-create the thread row, allow.
  const entityThreadId = await ensureEntityThread(entityType, entityId);
  return { allowed: true, entityThreadId, via: 'ambient' };
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
