require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const path       = require('path');
const cloudinary = require('cloudinary').v2;

// ── Cloudinary config ──────────────────────────────────────────
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const app = express();

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── API Routes ─────────────────────────────────────────────────
// Auth + user management live in Prop Spot. FieldCam only owns the
// photo / folder / comment / share / trash flows.
// Share must mount before any auth-checking routes so public GETs work.
app.use('/api/share',      require('./routes/share'));
app.use('/api/properties', require('./routes/properties'));
app.use('/api/photos',     require('./routes/photos'));
app.use('/api/trash',      require('./routes/trash'));
app.use('/api/folders',    require('./routes/folders'));
app.use('/api/access',     require('./routes/access'));
app.use('/api/comments',   require('./routes/comments'));

// /api/me — pass-through to Prop Spot. Lets the existing frontend
// (which calls /api/auth/me on load) keep working unchanged.
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
  res.json({ status: 'ok', service: 'fieldcam', timestamp: new Date().toISOString() })
);

// ── Public config (non-secret keys for authenticated frontend) ─
app.get('/api/config', (req, res) => {
  res.json({
    googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY || '',
    osUrl:            process.env.OS_URL          || '',
    holdingsUrl:      process.env.HOLDINGS_URL    || '',
    maintenanceUrl:   process.env.MAINTENANCE_URL || '',
    fieldcamUrl:      process.env.FIELDCAM_URL    || '',
    pulseUrl:         process.env.PULSE_URL       || '',
    inboxUrl:         process.env.INBOX_URL       || '',
    underwritingUrl:  process.env.UNDERWRITING_URL || ''
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
  console.log(`FieldCam running on port ${PORT}`);
  console.log(`   http://localhost:${PORT}`);
});
