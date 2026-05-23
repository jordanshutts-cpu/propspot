const express = require('express');
const jwt = require('jsonwebtoken');
const { query } = require('../db');
const hub = require('../lib/hub');

const router = express.Router();

// EventSource cannot set custom headers, so the JWT comes via ?token=
function authQuery(req, res, next) {
  const token = req.query.token
    || (req.headers.authorization || '').replace(/^Bearer\s+/, '');
  if (!token) return res.status(401).end();
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.userId    = payload.userId;
    req.userEmail = payload.email;
    next();
  } catch {
    return res.status(401).end();
  }
}

// GET /api/pulse/stream?token=<JWT>&channel_id=<UUID>
// GET /api/pulse/stream?token=<JWT>&dm_id=<UUID>
// GET /api/pulse/stream?token=<JWT>&entity_type=<type>&entity_id=<id>
//
// Long-lived Server-Sent Events stream. One per scope per tab.
// Every connection ALSO subscribes to `user:<userId>` so cross-scope events
// (unread_update, mention) reach the user regardless of which scope they're
// currently viewing.
router.get('/', authQuery, async (req, res) => {
  const channelId  = req.query.channel_id;
  const dmId       = req.query.dm_id;
  const entityType = req.query.entity_type;
  const entityId   = req.query.entity_id;

  let subscribeKey;
  let helloPayload;

  if (channelId) {
    const { rows } = await query(`
      SELECT 1
        FROM users u
        LEFT JOIN chat_channel_members m
          ON m.user_id = u.id AND m.channel_id = $1
       WHERE u.id = $2
         AND (u.is_owner = TRUE OR m.user_id IS NOT NULL)
       LIMIT 1
    `, [channelId, req.userId]);
    if (!rows.length) return res.status(403).end();
    subscribeKey = 'channel:' + channelId;
    helloPayload = { type: 'hello', channel_id: channelId, user_id: req.userId };
  } else if (dmId) {
    const { rows } = await query(
      `SELECT 1 FROM chat_dm_members WHERE dm_id = $1 AND user_id = $2 LIMIT 1`,
      [dmId, req.userId]
    );
    if (!rows.length) return res.status(403).end();
    subscribeKey = 'dm:' + dmId;
    helloPayload = { type: 'hello', dm_id: dmId, user_id: req.userId };
  } else if (entityType && entityId) {
    const { isEntityTypeSupported, canAccessEntity } = require('../lib/authz');
    if (!isEntityTypeSupported(entityType)) return res.status(400).end();
    const access = await canAccessEntity({
      userId: req.userId, entityType, entityId
    });
    if (!access.allowed || !access.entityThreadId) return res.status(403).end();
    subscribeKey = `et:${access.entityThreadId}`;
    helloPayload = {
      type: 'hello',
      entity_type: entityType,
      entity_id: entityId,
      entity_thread_id: access.entityThreadId,
      user_id: req.userId
    };
  } else {
    return res.status(400).end();
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable proxy buffering
  res.flushHeaders();
  if (res.socket && res.socket.setNoDelay) res.socket.setNoDelay(true);
  res.write('retry: 5000\n\n'); // tell client to retry every 5s if dropped
  res.write(`data: ${JSON.stringify(helloPayload)}\n\n`);

  // Subscribe to BOTH the scope key (channel/dm/entity-thread) AND the
  // per-user key. The per-user key catches unread_update + mention events
  // that originate in a different scope than the one this tab is viewing.
  const unsubscribe = hub.subscribe([subscribeKey, 'user:' + req.userId], res);

  const heartbeat = setInterval(() => { try { res.write(':\n\n'); } catch {} }, 25000);
  const cleanup = () => { clearInterval(heartbeat); unsubscribe(); };
  req.on('close', cleanup);
  req.on('aborted', cleanup);
});

module.exports = router;
