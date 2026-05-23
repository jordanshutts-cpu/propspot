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
// GET /api/pulse/stream?token=<JWT>&entity_type=<type>&entity_id=<id>
// Long-lived Server-Sent Events stream. One per channel/entity-thread per tab.
router.get('/', authQuery, async (req, res) => {
  const channelId = req.query.channel_id;
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
    subscribeKey = channelId;
    helloPayload = { type: 'hello', channel_id: channelId, user_id: req.userId };
  } else if (entityType && entityId) {
    const { isEntityTypeSupported, canAccessEntity } = require('../lib/authz');
    if (!isEntityTypeSupported(entityType)) return res.status(400).end();
    const access = await canAccessEntity({
      userId: req.userId, entityType, entityId
    });
    if (!access.allowed) return res.status(403).end();
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
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  if (res.socket && res.socket.setNoDelay) res.socket.setNoDelay(true);
  res.write('retry: 5000\n\n');
  res.write(`data: ${JSON.stringify(helloPayload)}\n\n`);

  const unsubscribe = hub.subscribe(subscribeKey, res);

  const heartbeat = setInterval(() => { try { res.write(':\n\n'); } catch {} }, 25000);
  const cleanup = () => { clearInterval(heartbeat); unsubscribe(); };
  req.on('close', cleanup);
  req.on('aborted', cleanup);
});

module.exports = router;
