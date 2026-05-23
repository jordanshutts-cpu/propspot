// Verifies Google ID tokens issued by Google Identity Services
// ("Sign in with Google" button on /index.html).
//
// Reads:
//   GOOGLE_CLIENT_ID         (required) — the Web OAuth Client ID
//   GOOGLE_ALLOWED_DOMAINS   (optional) — comma-separated email domains
//                                          allowed to sign in (e.g.
//                                          "restorationhomes.com,rentdwella.com").
//                                          Empty = any domain accepted.
const { OAuth2Client } = require('google-auth-library');

let client = null;
function getClient() {
  if (!client) {
    if (!process.env.GOOGLE_CLIENT_ID) {
      throw new Error('GOOGLE_CLIENT_ID not configured');
    }
    client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
  }
  return client;
}

function allowedDomains() {
  return (process.env.GOOGLE_ALLOWED_DOMAINS || '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
}

// Verifies the ID token. Returns { email, name, sub, email_verified, hd }
// on success. Throws on invalid signature, wrong audience, expired token,
// or unverified email.
async function verifyGoogleIdToken(idToken) {
  if (!idToken) throw new Error('Missing ID token');
  const ticket = await getClient().verifyIdToken({
    idToken,
    audience: process.env.GOOGLE_CLIENT_ID,
  });
  const payload = ticket.getPayload();
  if (!payload) throw new Error('Empty token payload');
  if (!payload.email_verified) throw new Error('Email not verified by Google');

  const email = (payload.email || '').toLowerCase().trim();
  if (!email) throw new Error('Token has no email');

  const domains = allowedDomains();
  if (domains.length > 0) {
    const emailDomain = email.split('@')[1] || '';
    if (!domains.includes(emailDomain)) {
      const err = new Error(`Email domain not allowed: ${emailDomain}`);
      err.code = 'DOMAIN_NOT_ALLOWED';
      throw err;
    }
  }

  return {
    email,
    name: payload.name || '',
    sub: payload.sub,
    hd: payload.hd || null,
  };
}

module.exports = { verifyGoogleIdToken };
