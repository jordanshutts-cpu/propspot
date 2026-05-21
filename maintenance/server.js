require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');

const app = express();

app.use(cors({ origin: process.env.APP_URL || '*', credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// ── API Routes ────────────────────────────────────────────────────
app.use('/api/work-orders', require('./routes/work-orders'));
app.use('/api/updates',     require('./routes/updates'));
app.use('/api/properties',  require('./routes/properties'));
app.use('/api/lawn',        require('./routes/lawn'));
app.use('/api/users',       require('./routes/users'));

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
  res.json({ status: 'ok', service: 'maintenance', timestamp: new Date().toISOString() })
);

app.get('/api/config', (req, res) => {
  res.json({
    osUrl:          process.env.OS_URL          || '',
    holdingsUrl:    process.env.HOLDINGS_URL    || '',
    maintenanceUrl: process.env.MAINTENANCE_URL || '',
    fieldcamUrl:    process.env.FIELDCAM_URL    || ''
  });
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = parseInt(process.env.PORT) || 3000;
app.listen(PORT, () => {
  console.log(`Maintenance running on port ${PORT}`);
  console.log(`  http://localhost:${PORT}`);
});
