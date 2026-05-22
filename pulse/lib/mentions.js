// Mention parsing and grant-writing for Pulse messages.
//
// Bodies are stored with explicit `<@uuid>` tokens — the client inserts the
// token when the user picks someone from the @ picker, and renders them as
// chips on display. This regex MUST match the client's token format exactly.

const { query } = require('../db');

const MENTION_RE = /<@([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})>/gi;

// Extract distinct mentioned user uuids from a message body. Lower-cased.
function parseMentions(body) {
  if (!body) return [];
  const ids = new Set();
  let m;
  // Reset lastIndex defensively — MENTION_RE is module-level with /g, so a
  // prior call's state could otherwise affect this scan.
  MENTION_RE.lastIndex = 0;
  while ((m = MENTION_RE.exec(body)) !== null) {
    ids.add(m[1].toLowerCase());
  }
  return [...ids];
}

// Write chat_mentions rows for a message. Idempotent on PK conflict.
// Filters uuids against the users table so deleted-user mentions silently no-op.
// Returns the list of UUIDs that actually got rows (may differ from input).
async function writeMentionRows(messageId, userIds) {
  if (!userIds.length) return [];
  const { rows: existing } = await query(
    `SELECT id FROM users WHERE id = ANY($1::uuid[])`,
    [userIds]
  );
  const validIds = existing.map(r => r.id);
  for (const uid of validIds) {
    await query(
      `INSERT INTO chat_mentions (message_id, mentioned_user_id)
       VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [messageId, uid]
    );
  }
  return validIds;
}

// Write per-(user, entity_thread) grants for each mention. Idempotent.
// Caller must have already filtered userIds to real users (use writeMentionRows
// first, pass its return value here).
async function writeEntityThreadGrants(entityThreadId, mentionedUserIds, grantedBy) {
  if (!mentionedUserIds.length) return;
  for (const uid of mentionedUserIds) {
    await query(
      `INSERT INTO pulse_entity_thread_grants
         (entity_thread_id, user_id, granted_via, granted_by)
       VALUES ($1, $2, 'mention', $3)
       ON CONFLICT DO NOTHING`,
      [entityThreadId, uid, grantedBy]
    );
  }
}

module.exports = { MENTION_RE, parseMentions, writeMentionRows, writeEntityThreadGrants };
