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

app.use(cors({
  origin: process.env.APP_URL || '*',
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── API Routes ─────────────────────────────────────────────────
// Auth + user management live in Prop Spot. FieldCam only owns the
// photo-capture flow.
app.use('/api/properties', require('./routes/properties'));
app.use('/api/photos',     require('./routes/photos'));

// /api/me — thin pass-through to Prop Spot's /api/os/me so the existing
// frontend (app.js requireAuth() calls /api/auth/me) keeps working.
const OS_URL = process.env.OS_INTERNAL_URL || process.env.OS_URL || '';
app.get(['/api/me', '/api/auth/me'], async (req, res) => {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: 'Authentication required' });
  if (!OS_URL) return res.status(500).json({ error: 'OS_URL not configured' });
  try {
    const r = await fetch(OS_URL + '/api/os/me', { headers: { Authorization: header } });
    res.status(r.status).json(await r.json());
  } catch (err) {
    res.status(502).json({ error: 'Prop Spot unreachable' });
  }
});

// ── Health Check (Railway uses this) ──────────────────────────
app.get('/api/health', (req, res) =>
  res.json({ status: 'ok', service: 'fieldcam', timestamp: new Date().toISOString() })
);

// ── Public config (serves non-secret keys to authenticated frontend) ──
app.get('/api/config', (req, res) => {
  res.json({
    googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY || '',
    osUrl:            process.env.OS_URL || ''
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
