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
// Long-lived Server-Sent Events stream. One per channel per tab.
router.get('/', authQuery, async (req, res) => {
  const channelId = req.query.channel_id;
  if (!channelId) return res.status(400).end();

  // Membership check — owners always allowed, otherwise must be in chat_channel_members.
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

  // SSE headers — every line matters here.
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable proxy buffering
  res.flushHeaders();
  if (res.socket && res.socket.setNoDelay) res.socket.setNoDelay(true);
  res.write('retry: 5000\n\n'); // tell client to retry every 5s if dropped

  // Send a hello so the client can flip its "connected" dot immediately.
  res.write(`data: ${JSON.stringify({ type: 'hello', channel_id: channelId, user_id: req.userId })}\n\n`);

  const unsubscribe = hub.subscribe(channelId, res);

  // Heartbeat to keep proxies (Railway, Cloudflare) from killing idle conns.
  const heartbeat = setInterval(() => {
    try { res.write(':\n\n'); } catch {}
  }, 25000);

  const cleanup = () => {
    clearInterval(heartbeat);
    unsubscribe();
  };
  req.on('close', cleanup);
  req.on('aborted', cleanup);
});

module.exports = router;
