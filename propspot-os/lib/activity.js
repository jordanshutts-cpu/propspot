const { query } = require('../db');

async function logActivity({ actorUserId, entityType, entityId, action, payload }) {
  try {
    await query(
      `INSERT INTO activity (actor_user_id, entity_type, entity_id, action, payload)
       VALUES ($1, $2, $3, $4, $5)`,
      [actorUserId || null, entityType, entityId || null, action, payload ? JSON.stringify(payload) : null]
    );
  } catch (err) {
    console.error('activity log error:', err.message);
  }
}

module.exports = { logActivity };
