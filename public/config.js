// ============================================================
//  FieldCam — Frontend Config
//  After deploying to Railway, replace the API_BASE with your
//  Railway public URL (e.g. https://fieldcam-production.up.railway.app)
//
//  During local development with `node server.js`, leave as-is.
// ============================================================

const API_BASE = '';   // Empty = same origin (works on Railway and locally)
                       // Set to 'https://your-app.railway.app' if hosting
                       // the frontend separately.

// How close (meters) to auto-suggest a property
const NEARBY_RADIUS_METERS = 300;

const APP_NAME = 'FieldCam';
