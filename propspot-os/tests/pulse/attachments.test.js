// Standalone test — runnable via: node tests/pulse/attachments.test.js
// No test framework: just node:assert + node:test.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { isAllowedMime } = require('../../routes/pulse/attachments');

test('isAllowedMime accepts existing image/document types', () => {
  assert.equal(isAllowedMime('image/jpeg'), true);
  assert.equal(isAllowedMime('image/png'), true);
  assert.equal(isAllowedMime('image/heic'), true);
  assert.equal(isAllowedMime('application/pdf'), true);
  assert.equal(
    isAllowedMime('application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
    true
  );
  assert.equal(isAllowedMime('text/csv'), true);
});

test('isAllowedMime accepts audio types', () => {
  assert.equal(isAllowedMime('audio/webm'), true);
  assert.equal(isAllowedMime('audio/mp4'), true);
  assert.equal(isAllowedMime('audio/mpeg'), true);
  assert.equal(isAllowedMime('audio/ogg'), true);
});

test('isAllowedMime accepts video types', () => {
  assert.equal(isAllowedMime('video/webm'), true);
  assert.equal(isAllowedMime('video/mp4'), true);
  assert.equal(isAllowedMime('video/quicktime'), true);
});

test('isAllowedMime rejects unrelated binaries', () => {
  assert.equal(isAllowedMime('application/x-msdownload'), false);
  assert.equal(isAllowedMime('application/octet-stream'), false);
  assert.equal(isAllowedMime(''), false);
  assert.equal(isAllowedMime(null), false);
  assert.equal(isAllowedMime(undefined), false);
});
