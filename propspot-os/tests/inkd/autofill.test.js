const test = require('node:test');
const assert = require('node:assert');
const { resolvePath } = require('../../lib/inkd-autofill');

const ctx = {
  property:    { address: '123 Main St', city: 'Tampa', state: 'FL', zip: '33602' },
  opportunity: { purchase_price: 250000, closing_date: '2026-07-01' },
  user:        { full_name: 'Jordan Shutts', email: 'jordan@example.com' },
  recipients:  { buyer: { full_name: 'Alice Buyer', email: 'a@b.com' },
                 seller: { full_name: 'Bob Seller' } },
  today:       '2026-05-26',
  today_long:  'May 26, 2026',
  envelope:    { id: 'env-1' },
};

test('resolves a simple property path', () => {
  assert.strictEqual(resolvePath('property.address', ctx), '123 Main St');
});

test('resolves an opportunity numeric value as string', () => {
  assert.strictEqual(resolvePath('opportunity.purchase_price', ctx), '250000');
});

test('resolves a nested recipient-by-role path', () => {
  assert.strictEqual(resolvePath('recipient.buyer.full_name', ctx), 'Alice Buyer');
});

test('resolves user path', () => {
  assert.strictEqual(resolvePath('user.full_name', ctx), 'Jordan Shutts');
});

test('resolves computed today path', () => {
  assert.strictEqual(resolvePath('today', ctx), '2026-05-26');
});

test('returns null for unknown root', () => {
  assert.strictEqual(resolvePath('unknown.foo', ctx), null);
});

test('returns null for missing leaf', () => {
  assert.strictEqual(resolvePath('property.parcel_id', ctx), null);
});

test('returns null for recipient role not present', () => {
  assert.strictEqual(resolvePath('recipient.witness.full_name', ctx), null);
});

test('returns null for null / empty path', () => {
  assert.strictEqual(resolvePath('', ctx), null);
  assert.strictEqual(resolvePath(null, ctx), null);
});

test('returns null for prototype-chain properties (no leakage)', () => {
  // Without the hasOwnProperty guard, these would resolve to inherited
  // Object.prototype methods and stamp garbage onto signed PDFs.
  assert.strictEqual(resolvePath('property.constructor', ctx), null);
  assert.strictEqual(resolvePath('property.toString', ctx), null);
  assert.strictEqual(resolvePath('property.hasOwnProperty', ctx), null);
  assert.strictEqual(resolvePath('recipient.buyer.constructor', ctx), null);
});

test('resolves envelope.id', () => {
  assert.strictEqual(resolvePath('envelope.id', ctx), 'env-1');
});

test('resolves today_long', () => {
  assert.strictEqual(resolvePath('today_long', ctx), 'May 26, 2026');
});
