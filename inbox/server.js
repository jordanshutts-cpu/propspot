require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');

const app = express();

app.use(cors({ origin: true, credentials: true }));
// Compose/reply send attachments inline as base64 (so we don't need
// multer + multipart upload). Gmail's per-message limit is 25MB; with
// base64 inflation we cap the JSON body at 35MB to stay under that
// ceiling once the data is decoded.
app.use(express.json({ limit: '35mb' }));
app.use(express.urlencoded({ extended: true, limit: '35mb' }));

// ── API Routes ────────────────────────────────────────────────────
app.use('/api/mailboxes',       require('./routes/mailboxes'));
app.use('/api/shared-inboxes',  require('./routes/shared-inboxes'));
app.use('/api/alias-routes',    require('./routes/alias-routes'));
app.use('/api/threads',         require('./routes/threads'));
app.use('/api/messages',        require('./routes/messages'));
app.use('/api/attachments',     require('./routes/attachments'));
app.use('/api/properties',      require('./routes/properties'));
app.use('/api/contacts',        require('./routes/contacts'));

// /api/me — pass-through to Prop Spot
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
  res.json({ status: 'ok', service: 'inbox', timestamp: new Date().toISOString() })
);

app.get('/api/config', (req, res) => {
  res.json({
    osUrl:           process.env.OS_URL           || '',
    holdingsUrl:     process.env.HOLDINGS_URL     || '',
    maintenanceUrl:  process.env.MAINTENANCE_URL  || '',
    fieldcamUrl:     process.env.FIELDCAM_URL     || '',
    pulseUrl:        process.env.PULSE_URL        || '',
    inboxUrl:        process.env.APP_URL          || '',
    underwritingUrl: process.env.UNDERWRITING_URL || ''
  });
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = parseInt(process.env.PORT) || 3000;
app.listen(PORT, () => {
  console.log(`Inbox running on port ${PORT}`);
  console.log(`  http://localhost:${PORT}`);

  // Start the background sync worker (pulls Gmail history per mailbox).
  if (process.env.INBOX_SYNC_DISABLED !== '1') {
    require('./workers/sync').start();
  }
});
