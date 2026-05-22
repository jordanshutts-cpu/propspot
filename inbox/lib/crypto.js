// AES-256-GCM encryption for OAuth refresh tokens at rest.
// Key from INBOX_TOKEN_KEY env var (base64-encoded 32 bytes).
// Generate with: openssl rand -base64 32

const crypto = require('crypto');

const ALGO     = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY      = process.env.INBOX_TOKEN_KEY
  ? Buffer.from(process.env.INBOX_TOKEN_KEY, 'base64')
  : null;

function ensureKey() {
  if (!KEY || KEY.length !== 32) {
    throw new Error('INBOX_TOKEN_KEY must be a base64-encoded 32-byte value (try: openssl rand -base64 32)');
  }
}

function encrypt(plaintext) {
  ensureKey();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: base64(iv).base64(tag).base64(ciphertext)
  return [iv, tag, ciphertext].map(b => b.toString('base64')).join('.');
}

function decrypt(packed) {
  ensureKey();
  const [ivB64, tagB64, ctB64] = packed.split('.');
  if (!ivB64 || !tagB64 || !ctB64) throw new Error('Malformed encrypted value');
  const decipher = crypto.createDecipheriv(ALGO, KEY, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ctB64, 'base64')),
    decipher.final()
  ]);
  return plaintext.toString('utf8');
}

module.exports = { encrypt, decrypt };
