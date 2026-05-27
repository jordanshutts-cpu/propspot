require('dotenv').config();
const express      = require('express');
const cors         = require('cors');
const path         = require('path');
const cookieParser = require('cookie-parser');
const cloudinary   = require('cloudinary').v2;
const { initDb }   = require('./db');
const { redirectExternalToPortal } = require('./middleware/auth');

// ── Cloudinary config (used by /api/photos) ─────────────────────────
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const app = express();

// All APIs now live in this single service — open CORS to any origin.
// Auth is enforced via Bearer token on every protected route.
app.use(cors({ origin: true, credentials: true }));

// Default body size. Inbox reply/compose needs 35 MB for base64 attachments.
// We mount the larger limit only on inbox routes below.
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ── API Routes ────────────────────────────────────────────────────

// ── Core OS routes ────────────────────────────────────────────────
app.use('/api/auth',              require('./routes/auth'));
app.use('/api/users',             require('./routes/users'));
app.use('/api/apps',              require('./routes/apps'));
app.use('/api/properties',        require('./routes/properties'));
app.use('/api/photos',            require('./routes/photos'));
app.use('/api/prospects',         require('./routes/prospects'));
app.use('/api/leads',             require('./routes/leads'));
app.use('/api/opportunities',     require('./routes/opportunities'));
app.use('/api/purchases',         require('./routes/purchases'));
app.use('/api/projects',          require('./routes/projects'));
app.use('/api/contacts',          require('./routes/contacts'));
app.use('/api/property-contacts', require('./routes/property-contacts'));
app.use('/api/property-files',    require('./routes/property-files'));
app.use('/api/admin/import',      require('./routes/admin-import'));
app.use('/api/admin/recover-photos', require('./routes/admin-photo-recovery'));
app.use('/api/admin/merge-452',   require('./routes/admin-merge-452')); // ONE-TIME — remove after merge
app.use('/api/activity',          require('./routes/activity'));
app.use('/api/os',                require('./routes/authz'));
app.use('/api/underwriting',      require('./routes/underwriting'));
app.use('/api/pinned',            require('./routes/pinned'));
app.use('/api/recent',            require('./routes/recent'));
app.use('/api/sidebar-counts',    require('./routes/sidebar-counts'));
app.use('/api/tasks',             require('./routes/tasks'));
app.use('/api/task-projects',    require('./routes/task-projects'));
app.use('/api/drive',             require('./routes/drive'));
app.use('/api/mentions',          require('./routes/mentions'));
app.use('/api/org',               require('./routes/org'));
app.use('/api/calendar',          require('./routes/calendar'));
app.use('/api/my-work-orders',    require('./routes/my-work-orders'));

// ── Holdings (full CRUD — replaces stub) ──────────────────────────
app.use('/api/holdings', require('./routes/holdings'));
app.use('/api/lookups',  require('./routes/holdings-lookups'));

// ── FieldCam ──────────────────────────────────────────────────────
app.use('/api/fieldcam/properties', require('./routes/fieldcam/properties'));
app.use('/api/fieldcam/photos',     require('./routes/fieldcam/photos'));
app.use('/api/fieldcam/folders',    require('./routes/fieldcam/folders'));
app.use('/api/fieldcam/access',     require('./routes/fieldcam/access'));
app.use('/api/fieldcam/comments',   require('./routes/fieldcam/comments'));
app.use('/api/fieldcam/share',      require('./routes/fieldcam/share'));
app.use('/api/fieldcam/trash',      require('./routes/fieldcam/trash'));

// ── Maintenance ───────────────────────────────────────────────────
app.use('/api/maintenance/work-orders', require('./routes/maintenance/work-orders'));
app.use('/api/maintenance/work-orders', require('./routes/maintenance/invite-external-worker'));
app.use('/api/maintenance/lawn',        require('./routes/maintenance/lawn'));
app.use('/api/maintenance/updates',     require('./routes/maintenance/updates'));
app.use('/api/maintenance/properties',  require('./routes/maintenance/properties'));
app.use('/api/maintenance/users',       require('./routes/maintenance/users'));
app.use('/api/maintenance/assignable-users', require('./routes/maintenance/assignable-users'));

// ── Pulse (SSE stream must not be compressed) ─────────────────────
app.use('/api/pulse/stream',         require('./routes/pulse/stream'));
app.use('/api/pulse/messages',       require('./routes/pulse/messages'));
app.use('/api/pulse/channels',       require('./routes/pulse/channels'));
app.use('/api/pulse/dms',            require('./routes/pulse/dms'));
app.use('/api/pulse/unread',         require('./routes/pulse/unread'));
app.use('/api/pulse/users',          require('./routes/pulse/users'));
app.use('/api/pulse/sections',       require('./routes/pulse/sections'));
app.use('/api/pulse/entity-threads', require('./routes/pulse/entity-threads'));
app.use('/api/pulse/attachments',    require('./routes/pulse/attachments'));

// ── Ink'd (e-signature) ───────────────────────────────────────────
app.use('/api/inkd/templates',       require('./routes/inkd/templates'));
app.use('/api/inkd/envelopes',       require('./routes/inkd/envelopes'));
app.use('/api/inkd/envelopes/:envelopeId/recipients', require('./routes/inkd/recipients'));
app.use('/api/inkd/signing',         require('./routes/inkd/signing'));
app.use('/api/inkd/envelopes',       require('./routes/inkd/files-promotion'));

// ── Inbox (35 MB body limit for base64 attachments) ───────────────
app.use('/api/inbox', express.json({ limit: '35mb' }), express.urlencoded({ extended: true, limit: '35mb' }));
app.use('/api/inbox/shared-inboxes', require('./routes/inbox/shared-inboxes'));
app.use('/api/inbox/threads',        require('./routes/inbox/threads'));
app.use('/api/inbox/messages',       require('./routes/inbox/messages'));
app.use('/api/inbox/mailboxes',      require('./routes/inbox/mailboxes'));
app.use('/api/inbox/alias-routes',   require('./routes/inbox/alias-routes'));
app.use('/api/inbox/attachments',    require('./routes/inbox/attachments'));
app.use('/api/inbox/contacts',       require('./routes/inbox/contacts'));
app.use('/api/inbox/properties',     require('./routes/inbox/properties'));

// ── Health Check ──────────────────────────────────────────────────
app.get('/api/health', (req, res) =>
  res.json({ status: 'ok', service: 'propspot-os', timestamp: new Date().toISOString() })
);

// ── Public config (non-secret keys for authenticated frontend) ────
app.get('/api/config', (req, res) => {
  // All satellite APIs are now served by this OS — no external URLs needed.
  // Satellite URL fields are kept for backward compat but return empty string
  // so satelliteApiFetch falls through to same-origin calls.
  res.json({
    googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY || '',
    googleClientId:   process.env.GOOGLE_CLIENT_ID    || '',
    osUrl:            process.env.APP_URL || '',
    holdingsUrl:      '',
    maintenanceUrl:   '',
    fieldcamUrl:      '',
    pulseUrl:         '',
    inboxUrl:         '',
    underwritingUrl:  process.env.UNDERWRITING_URL || ''
  });
});

// ── FieldCam custom-domain routing ─────────────────────────────────
// MUST be before express.static — static middleware serves index.html
// for '/' before the catch-all ever fires, so the hostname check has
// to intercept at the middleware level instead.
//
//   fieldcam.propspot.io/           → fieldcam.html  (dashboard)
//   fieldcam.propspot.io/camera*    → fieldcam-camera.html
//   fieldcam.propspot.io/property*  → fieldcam-property.html
//   fieldcam.propspot.io/api/*      → pass through to API routes
//   fieldcam.propspot.io/*.js|css…  → pass through to express.static
const FIELDCAM_HOSTNAME = process.env.FIELDCAM_HOSTNAME || 'fieldcam.propspot.io';

app.use((req, res, next) => {
  // Support both direct hostname and X-Forwarded-Host (Railway reverse proxy)
  const host = (req.get('x-forwarded-host') || req.hostname || '').split(':')[0].toLowerCase();
  if (host !== FIELDCAM_HOSTNAME) return next();
  if (req.path.startsWith('/api/')) return next();                       // API — normal routing
  if (/\.(js|css|png|jpg|jpeg|ico|svg|woff2?|map|webp)$/i.test(req.path)) return next(); // static assets
  const p = req.path;
  if (p.startsWith('/camera'))   return res.sendFile(path.join(__dirname, 'public', 'fieldcam-camera.html'));
  if (p.startsWith('/property')) return res.sendFile(path.join(__dirname, 'public', 'fieldcam-property.html'));
  return res.sendFile(path.join(__dirname, 'public', 'fieldcam.html'));
});

// ── External-worker routing guard ─────────────────────────────────
// Soft UX guard: if an external_worker user navigates to any HTML page
// other than the allowed list, redirect them to /my-work.html. API
// authorization is handled separately on each route. Must run BEFORE
// express.static so it can intercept HTML requests before they're served.
app.use((req, res, next) => {
  // Only gate HTML navigations. Assets (.js, .css), API (/api/*), and
  // websocket upgrades fall straight through.
  if (!req.path.endsWith('.html') && req.path !== '/') return next();
  return redirectExternalToPortal([
    '/my-work.html', '/accept-invite.html', '/forgot-password.html',
    '/reset-password.html', '/login.html', '/index.html', '/'
  ])(req, res, next);
});

// ── Static Frontend ────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start ───────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT) || 3000;

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Prop Spot running on port ${PORT}`);
      console.log(`  http://localhost:${PORT}`);
      require('./routes/inkd/workers').startWorker();
    });
    // Background Gmail sync for every connected mailbox (shared + personal).
    // Skip with INBOX_SYNC_ENABLED=0 in environments where you don't want
    // the API hammered (e.g. local dev with stale tokens).
    if (process.env.INBOX_SYNC_ENABLED !== '0') {
      try {
        require('./workers/inbox-sync').start();
      } catch (e) {
        console.error('[inbox-sync] failed to start:', e.message);
      }
    }
  })
  .catch(err => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
