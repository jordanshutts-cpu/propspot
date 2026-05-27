// ────────────────────────────────────────────────────────────────
//  Notifications — REST + SSE
// ────────────────────────────────────────────────────────────────
const express = require('express');
const jwt = require('jsonwebtoken');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');
const hub = require('../lib/hub');

const router = express.Router();

// ── SSE auth via ?token= (EventSource can't set headers) ─────────
function authQuery(req, res, next) {
  const token = req.query.token ||
    (req.headers.authorization || '').replace(/^Bearer\s+/, '');
  if (!token) return res.status(401).end();
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = payload.userId;
    next();
  } catch { return res.status(401).end(); }
}

// GET /api/notifications/stream
// Long-lived SSE stream. Subscribes to user:<userId> so any hub.publish
// call from tasks.js / pulse/messages.js reaches this connection.
router.get('/stream', authQuery, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  if (res.socket?.setNoDelay) res.socket.setNoDelay(true);
  res.write('retry: 5000\n\n');
  res.write(`data: ${JSON.stringify({ type: 'hello', user_id: req.userId })}\n\n`);

  const unsub = hub.subscribe('user:' + req.userId, res);
  const hb = setInterval(() => { try { res.write(':\n\n'); } catch {} }, 25000);
  const cleanup = () => { clearInterval(hb); unsub(); };
  req.on('close', cleanup);
  req.on('aborted', cleanup);
});

router.use(requireAuth);

// GET /api/notifications?limit=50&offset=0
router.get('/', async (req, res) => {
  const limit  = Math.min(parseInt(req.query.limit)  || 50, 100);
  const offset = Math.max(parseInt(req.query.offset) || 0,  0);
  try {
    const [{ rows: notifications }, { rows: [{ count }] }] = await Promise.all([
      query(
        `SELECT * FROM notifications
          WHERE user_id = $1
          ORDER BY created_at DESC
          LIMIT $2 OFFSET $3`,
        [req.userId, limit, offset]
      ),
      query(
        `SELECT COUNT(*)::int AS count
           FROM notifications
          WHERE user_id = $1 AND read_at IS NULL`,
        [req.userId]
      )
    ]);
    res.json({ notifications, unread_count: count });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch notifications' });
  }
});

// POST /api/notifications/read-all
router.post('/read-all', async (req, res) => {
  try {
    await query(
      `UPDATE notifications SET read_at = NOW()
        WHERE user_id = $1 AND read_at IS NULL`,
      [req.userId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to mark notifications read' });
  }
});

// POST /api/notifications/:id/read
router.post('/:id/read', async (req, res) => {
  try {
    await query(
      `UPDATE notifications SET read_at = NOW()
        WHERE id = $1 AND user_id = $2 AND read_at IS NULL`,
      [req.params.id, req.userId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to mark notification read' });
  }
});

module.exports = router;
