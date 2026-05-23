require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');

const app = express();

// IMPORTANT: do NOT add `compression` middleware to this app. SSE relies on
// flushing per-event; gzip would buffer events and break real-time delivery.
// If you ever need compression for non-SSE routes, gate it with a path filter
// that excludes /api/pulse/stream.

const SATELLITE_ENVS = [
  'OS_URL', 'APP_URL', 'INBOX_URL', 'HOLDINGS_URL',
  'MAINTENANCE_URL', 'FIELDCAM_URL', 'UNDERWRITING_URL'
];
const ALLOWED_ORIGINS = SATELLITE_ENVS
  .map(k => process.env[k])
  .filter(Boolean);

app.use(cors({
  origin(origin, cb) {
    // Same-origin (no Origin header) — allow.
    if (!origin) return cb(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    // In dev with no satellite envs set, accept anything to keep localhost testing easy.
    if (ALLOWED_ORIGINS.length === 0) return cb(null, true);
    cb(new Error(`Origin ${origin} not allowed by CORS`));
  },
  credentials: true
}));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// ── API Routes ────────────────────────────────────────────────────
app.use('/api/pulse/messages',       require('./routes/messages'));
app.use('/api/pulse/channels',       require('./routes/channels'));
app.use('/api/pulse/dms',            require('./routes/dms'));
app.use('/api/pulse/attachments',    require('./routes/attachments'));
app.use('/api/pulse/unread',         require('./routes/unread'));
app.use('/api/pulse/sections',       require('./routes/sections'));
app.use('/api/pulse/users',          require('./routes/users'));
app.use('/api/pulse/stream',         require('./routes/stream'));
app.use('/api/pulse/entity-threads', require('./routes/entity-threads'));

// /api/me — pass-through to Prop Spot OS (mirrors maintenance/server.js)
const OS_URL = process.env.OS_INTERNAL_URL || process.env.OS_URL || '';
app.get(['/api/me', '/api/auth/me'], async (req, res) => {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: 'Authentication required' });
  if (!OS_URL) return res.status(500).json({ error: 'OS_URL not configured' });
  try {
    const r = await fetch(OS_URL + '/api/os/me', { headers: { Authorization: header } });
    res.status(r.status).json(await r.json());
  } catch {
    res.status(502).json({ error: 'Prop Spot unreachable' });
  }
});

// ── Health Check ──────────────────────────────────────────────────
app.get('/api/health', (req, res) =>
  res.json({ status: 'ok', service: 'pulse', timestamp: new Date().toISOString() })
);

// ── Public config (non-secret, served to frontend) ────────────────
app.get('/api/config', (req, res) => {
  res.json({
    osUrl:          process.env.OS_URL          || '',
    holdingsUrl:    process.env.HOLDINGS_URL    || '',
    maintenanceUrl: process.env.MAINTENANCE_URL || '',
    fieldcamUrl:    process.env.FIELDCAM_URL    || '',
    pulseUrl:       process.env.APP_URL         || '',
    inboxUrl:       process.env.INBOX_URL       || '',
    underwritingUrl: process.env.UNDERWRITING_URL || ''
  });
});

// ── Static Frontend ───────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start ─────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT) || 3000;
app.listen(PORT, () => {
  console.log(`Pulse running on port ${PORT}`);
  console.log(`  http://localhost:${PORT}`);
});
