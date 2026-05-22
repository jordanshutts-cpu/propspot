require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const path       = require('path');
const cloudinary = require('cloudinary').v2;

// ── Cloudinary config (used by document uploads) ───────────────
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const app = express();

app.use(cors({
  origin: process.env.APP_URL || '*',
  credentials: true
}));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// ── API Routes ─────────────────────────────────────────────────
// Auth + users + properties + contacts live in Prop Spot. Holdings Desk
// owns the holdings_items / holdings_payments / holdings_documents tables,
// plus thin read-only lookups for the property/contact pickers.
app.use('/api/holdings', require('./routes/holdings'));
app.use('/api/lookups',  require('./routes/lookups'));

// /api/me — pass-through to Prop Spot. Lets the frontend keep calling
// /api/auth/me on load without knowing it's not local.
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

// ── Health Check (Railway uses this) ──────────────────────────
app.get('/api/health', (req, res) =>
  res.json({ status: 'ok', service: 'holdings', timestamp: new Date().toISOString() })
);

// ── Public config (non-secret values for the frontend) ────────
app.get('/api/config', (req, res) => {
  res.json({
    osUrl:          process.env.OS_URL          || '',
    holdingsUrl:    process.env.HOLDINGS_URL    || '',
    maintenanceUrl: process.env.MAINTENANCE_URL || '',
    fieldcamUrl:    process.env.FIELDCAM_URL    || '',
    pulseUrl:       process.env.PULSE_URL       || '',
    inboxUrl:       process.env.INBOX_URL       || '',
    underwritingUrl: process.env.UNDERWRITING_URL || ''
  });
});

// ── Serve Frontend (public/) ───────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// Catch-all: send index.html for any unknown GET (SPA-style)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start ──────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT) || 3000;
app.listen(PORT, () => {
  console.log(`Holdings Desk running on port ${PORT}`);
  console.log(`   http://localhost:${PORT}`);
});
