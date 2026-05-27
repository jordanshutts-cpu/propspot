// Run: node tests/pulse/recorder-state.test.js
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createRecorderState } = require('../../public/pulse-recorder-state.js');

test('starts in idle', () => {
  const s = createRecorderState();
  assert.equal(s.get(), 'idle');
});

test('idle → requesting-permission on requestPermission', () => {
  const s = createRecorderState();
  s.send('requestPermission');
  assert.equal(s.get(), 'requesting-permission');
});

test('requesting-permission → recording on permissionGranted', () => {
  const s = createRecorderState();
  s.send('requestPermission');
  s.send('permissionGranted');
  assert.equal(s.get(), 'recording');
});

test('requesting-permission → error on permissionDenied', () => {
  const s = createRecorderState();
  s.send('requestPermission');
  s.send('permissionDenied');
  assert.equal(s.get(), 'error');
});

test('recording → previewing on stop', () => {
  const s = createRecorderState();
  s.send('requestPermission');
  s.send('permissionGranted');
  s.send('stop');
  assert.equal(s.get(), 'previewing');
});

test('previewing → uploading on send', () => {
  const s = createRecorderState();
  s.send('requestPermission');
  s.send('permissionGranted');
  s.send('stop');
  s.send('send');
  assert.equal(s.get(), 'uploading');
});

test('uploading → done on uploadSuccess', () => {
  const s = createRecorderState();
  s.send('requestPermission');
  s.send('permissionGranted');
  s.send('stop');
  s.send('send');
  s.send('uploadSuccess');
  assert.equal(s.get(), 'done');
});

test('uploading → previewing on uploadFail (so user can retry)', () => {
  const s = createRecorderState();
  s.send('requestPermission');
  s.send('permissionGranted');
  s.send('stop');
  s.send('send');
  s.send('uploadFail');
  assert.equal(s.get(), 'previewing');
});

test('previewing → idle on discard', () => {
  const s = createRecorderState();
  s.send('requestPermission');
  s.send('permissionGranted');
  s.send('stop');
  s.send('discard');
  assert.equal(s.get(), 'idle');
});

test('subscribers fire on state change', () => {
  const s = createRecorderState();
  let calls = 0;
  s.subscribe(() => { calls++; });
  s.send('requestPermission');
  s.send('permissionGranted');
  assert.equal(calls, 2);
});

test('unknown event from current state is a no-op', () => {
  const s = createRecorderState();
  s.send('uploadSuccess'); // not valid from idle
  assert.equal(s.get(), 'idle');
});
