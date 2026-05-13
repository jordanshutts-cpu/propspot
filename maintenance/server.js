require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const { requireAuth, loadUserFlags } = require('./middleware/auth');

const app = express();

// CORS allow-list. APP_URL may be a comma-separated list of origins, or '*'.
const allowed = (process.env.APP_URL || '*')
  .split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: allowed.length === 1 && allowed[0] === '*' ? true : allowed,
  credentials: true
}));

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Current user (resolved against the shared users table) ─────────
app.get('/api/me', requireAuth, async (req, res) => {
  const u = await loadUserFlags(req.userId);
  if (!u) return res.status(404).json({ error: 'User not found' });
  res.json(u);
});

// ── API routes ──────────────────────────────────────────────────────
app.use('/api/schedules', require('./routes/schedules'));
app.use('/api/routes',    require('./routes/routes'));
app.use('/api/visits',    require('./routes/visits'));
app.use('/api/tasks',     require('./routes/tasks'));

// ── Health check (Railway uses this) ────────────────────────────────
app.get('/api/health', (req, res) =>
  res.json({ status: 'ok', service: 'maintenance', timestamp: new Date().toISOString() })
);

// ── Non-secret config served to the authenticated frontend ──────────
app.get('/api/config', (req, res) => {
  res.json({
    googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY || '',
    propspotUrl:      process.env.PROPSPOT_URL       || '',
    fieldcamUrl:      process.env.FIELDCAM_URL       || ''
  });
});

// ── Static frontend ─────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
);

const PORT = parseInt(process.env.PORT) || 3000;
app.listen(PORT, () => {
  console.log(`Maintenance running on port ${PORT}`);
  console.log(`  http://localhost:${PORT}`);
});
