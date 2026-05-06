require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const { initDb } = require('./db');

const app = express();

app.use(cors({ origin: process.env.APP_URL || '*', credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// ── API Routes ─────────────────────────────────────────────────
app.use('/api/auth',              require('./routes/auth'));
app.use('/api/users',             require('./routes/users'));
app.use('/api/apps',              require('./routes/apps'));
app.use('/api/properties',        require('./routes/properties'));
app.use('/api/prospects',         require('./routes/prospects'));
app.use('/api/leads',             require('./routes/leads'));
app.use('/api/opportunities',     require('./routes/opportunities'));
app.use('/api/purchases',         require('./routes/purchases'));
app.use('/api/projects',          require('./routes/projects'));
app.use('/api/contacts',          require('./routes/contacts'));
app.use('/api/property-contacts', require('./routes/property-contacts'));
app.use('/api/activity',          require('./routes/activity'));
app.use('/api/os',                require('./routes/authz'));

// ── Health Check ───────────────────────────────────────────────
app.get('/api/health', (req, res) =>
  res.json({ status: 'ok', service: 'restoration-os', timestamp: new Date().toISOString() })
);

// ── Static Frontend ────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start ──────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT) || 3000;

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Prop Spot running on port ${PORT}`);
      console.log(`  http://localhost:${PORT}`);
    });
  })
  .catch(err => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
