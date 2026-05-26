const test = require('node:test');
const assert = require('node:assert');
const { mintToken, hashToken, verifyToken } = require('../../lib/inkd-tokens');

test('mintToken returns 64-char hex string', () => {
  const t = mintToken();
  assert.strictEqual(t.length, 64);
  assert.match(t, /^[0-9a-f]{64}$/);
});

test('mintToken returns a different value each call', () => {
  const a = mintToken();
  const b = mintToken();
  assert.notStrictEqual(a, b);
});

test('hashToken produces a bcrypt hash of the token', async () => {
  const t = mintToken();
  const h = await hashToken(t);
  assert.ok(h.startsWith('$2'));
  assert.ok(h.length >= 50);
});

test('verifyToken returns true for matching token + hash', async () => {
  const t = mintToken();
  const h = await hashToken(t);
  assert.strictEqual(await verifyToken(t, h), true);
});

test('verifyToken returns false for mismatched token', async () => {
  const t = mintToken();
  const h = await hashToken(t);
  const t2 = mintToken();
  assert.strictEqual(await verifyToken(t2, h), false);
});
