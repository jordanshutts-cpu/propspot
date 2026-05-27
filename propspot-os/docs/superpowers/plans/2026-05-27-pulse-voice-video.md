# Pulse Voice Memos + Video Recording — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three new capture modes to Pulse — voice memos, webcam video, and screen recording (with an optional webcam-bubble overlay) — recorded entirely in the browser, uploaded through the existing Pulse attachment pipeline, and played back inline in message bubbles.

**Architecture:** A new `public/pulse-recorder.js` module exposes a `PulseRecorder` class parameterized by mode (`voice` | `webcam` | `screen`). The class owns a small state machine (extracted into `public/pulse-recorder-state.js` so it can be unit-tested) and a canvas + audio compositor (extracted into `public/pulse-recorder-compositor.js`). The composer in `public/pulse.html` gains three icon buttons that instantiate the recorder; once a recording is finalized, the resulting blob goes through the existing `POST /api/pulse/attachments` endpoint (after widening its mime allowlist and raising its file-size cap), and the returned metadata is attached to the next `POST /api/pulse/messages` call. Attachment rendering in `msgHtml()` routes `audio/*` to a small custom player and `video/*` to `<video controls poster=…>` using a Cloudinary `so_auto` poster.

**Tech Stack:** Node 18 / Express / Postgres / multer / Cloudinary / vanilla JS frontend (no framework, no build step) / browser MediaRecorder, getUserMedia, getDisplayMedia, Web Audio API, Canvas 2D.

**Reference spec:** `docs/superpowers/specs/2026-05-27-pulse-voice-video-design.md`

**Test note:** Propspot-os has no JS test runner. This plan introduces a single `node:assert` script (`tests/pulse/attachments.test.js`) runnable via `node tests/pulse/attachments.test.js`. Everything else is verified by manual smoke against the running app.

**Branch:** Land all tasks on `claude/pulse-video-voice` (already created off `origin/main`). Before each task that runs git commands, the engineer must verify they're on this branch — `git branch --show-current` should print `claude/pulse-video-voice`.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `routes/pulse/attachments.js` | Modify | Widen mime allowlist (add `audio/`, `video/` prefixes); raise `MAX_BYTES` 25 → 200 MB. Export `isAllowedMime` for tests. |
| `tests/pulse/attachments.test.js` | Create | `node:assert` tests for `isAllowedMime`. Runnable standalone. |
| `public/pulse-recorder-state.js` | Create | Pure state machine: `idle → requesting-permission → recording → previewing → uploading → done` (+ `error`). One exported factory `createRecorderState()`. No DOM, no MediaRecorder — testable in Node. |
| `public/pulse-recorder-compositor.js` | Create | `compositeScreenAndWebcam({ screenStream, webcamStream })` → returns `{ stream, stop }`. Encapsulates canvas drawing loop + Web Audio mixing. |
| `public/pulse-recorder.js` | Create | `PulseRecorder` class: builds the recorder panel DOM, talks to the state machine, drives MediaRecorder, uploads the blob, dispatches a `pulse-recorder:done` event with the attachment metadata. |
| `public/pulse.html` | Modify | Add three capture buttons to the composer, add CSS for the recorder panel + audio player, wire the buttons to PulseRecorder, modify `sendMsg()` to accept attachment arrays, modify `msgHtml()` to render audio/video attachments. |
| `docs/superpowers/specs/2026-05-27-pulse-voice-video-design.md` | (Reference only) | The approved design. |

`lib/pulse-cloudinary.js`, `routes/pulse/messages.js`, and `db/schema.sql` stay untouched — Cloudinary's `resource_type: 'auto'` already handles video, the messages route already persists arbitrary attachment rows, and `chat_attachments` already has the needed columns.

---

## Task 1: Widen the attachment mime allowlist and raise the file cap

**Files:**
- Modify: `routes/pulse/attachments.js`
- Create: `tests/pulse/attachments.test.js`

The current attachments route rejects audio and video and caps uploads at 25 MB. This task widens both and adds a small test script.

- [ ] **Step 1: Confirm branch**

Run:
```bash
cd /Users/jordanshutts/propspot && git branch --show-current
```
Expected output: `claude/pulse-video-voice`. If not, run `git checkout claude/pulse-video-voice`.

- [ ] **Step 2: Write the failing test**

Create `propspot-os/tests/pulse/attachments.test.js` with this exact content:

```javascript
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
```

- [ ] **Step 3: Run the test and verify it fails**

Run:
```bash
cd /Users/jordanshutts/propspot/propspot-os && node tests/pulse/attachments.test.js
```
Expected: failure with something like `TypeError: isAllowedMime is not a function` (because `attachments.js` does not currently export it).

- [ ] **Step 4: Update the route to widen the allowlist, raise the cap, and export `isAllowedMime`**

Edit `propspot-os/routes/pulse/attachments.js` and replace the entire file with:

```javascript
const express = require('express');
const multer = require('multer');
const { requireAuth, requirePulseGrant } = require('../../middleware/auth');
const { uploadBuffer } = require('../../lib/pulse-cloudinary');

const router = express.Router();
router.use(requireAuth);
router.use(requirePulseGrant);

// 200 MB cap — 10-min screen recordings at modest bitrate ≈ 120 MB.
const MAX_BYTES = 200 * 1024 * 1024;

// Allowed mime types. `image/*` covers JPEG/PNG/HEIC/WebP/GIF.
// `audio/*` and `video/*` were added for Pulse voice memos + screen recordings.
// Office types covered via prefix matching below.
const ALLOWED_PREFIXES = ['image/', 'audio/', 'video/'];
const ALLOWED_EXACT = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain',
  'text/csv',
  'application/zip'
]);

function isAllowedMime(mime) {
  if (!mime) return false;
  if (ALLOWED_EXACT.has(mime)) return true;
  for (const p of ALLOWED_PREFIXES) if (mime.startsWith(p)) return true;
  return false;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1 }
});

// POST /api/pulse/attachments  (multipart, field "file")
// Returns { url, cloudinary_id, mime_type, size_bytes, filename }
// — the frontend then includes this in the next POST /messages body.
router.post('/', (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'File too large (max 200MB)' });
      }
      return res.status(400).json({ error: err.message || 'Upload failed' });
    }
    next();
  });
}, async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'file required' });
  if (!isAllowedMime(file.mimetype)) {
    return res.status(415).json({ error: 'Unsupported file type' });
  }

  try {
    const result = await uploadBuffer(file.buffer, {
      folder: `propspot/chat/uploads/${req.userId}`,
      mimeType: file.mimetype
    });
    return res.json({
      url: result.url,
      cloudinary_id: result.cloudinary_id,
      mime_type: file.mimetype,
      size_bytes: file.size,
      filename: file.originalname || 'file'
    });
  } catch (err) {
    console.error('Cloudinary upload failed:', err);
    return res.status(502).json({ error: 'Upload provider failed' });
  }
});

module.exports = router;
module.exports.isAllowedMime = isAllowedMime;
```

Two changes from the original: `ALLOWED_PREFIXES` now includes `audio/` and `video/`, `MAX_BYTES` is 200 MB, the 413 message reflects the new cap, and `isAllowedMime` is exported alongside the router via `module.exports.isAllowedMime` (Express still works since the default export is the router).

- [ ] **Step 5: Run the test and verify it passes**

Run:
```bash
cd /Users/jordanshutts/propspot/propspot-os && node tests/pulse/attachments.test.js
```
Expected: all four tests pass — output like `# tests 4`, `# pass 4`, `# fail 0`.

- [ ] **Step 6: Commit**

Run:
```bash
cd /Users/jordanshutts/propspot && git branch --show-current
```
Expected: `claude/pulse-video-voice`.

Then:
```bash
cd /Users/jordanshutts/propspot && \
  git add propspot-os/routes/pulse/attachments.js propspot-os/tests/pulse/attachments.test.js && \
  git commit -m "feat(pulse): allow audio/video uploads + raise cap to 200MB

Widens the Pulse attachment mime allowlist to include audio/* and video/*
prefixes so voice memos and screen recordings can flow through the existing
upload endpoint. Raises the per-file size cap from 25MB to 200MB to fit
10-minute screen recordings.

Adds a small node:assert test script for the mime allowlist."
```

---

## Task 2: Pure state machine for the recorder

**Files:**
- Create: `public/pulse-recorder-state.js`
- Create: `tests/pulse/recorder-state.test.js`

The recorder UI has six states. Extracting them into a pure factory lets us test transitions without a browser.

- [ ] **Step 1: Write the failing test**

Create `propspot-os/tests/pulse/recorder-state.test.js`:

```javascript
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
cd /Users/jordanshutts/propspot/propspot-os && node tests/pulse/recorder-state.test.js
```
Expected: failure — module not found.

- [ ] **Step 3: Implement the state machine**

Create `propspot-os/public/pulse-recorder-state.js`:

```javascript
// Pure state machine for the Pulse recorder. No DOM, no MediaRecorder —
// everything that drives the UI is encoded here so it can be unit-tested
// outside the browser.
//
// States:   idle, requesting-permission, recording, previewing, uploading, done, error
// Events:   requestPermission, permissionGranted, permissionDenied,
//           stop, send, uploadSuccess, uploadFail, discard, reset
//
// Usage:
//   const s = createRecorderState();
//   const off = s.subscribe(state => console.log(state));
//   s.send('requestPermission');
//   s.get(); // 'requesting-permission'

const TRANSITIONS = {
  'idle': {
    requestPermission: 'requesting-permission'
  },
  'requesting-permission': {
    permissionGranted: 'recording',
    permissionDenied: 'error',
    discard: 'idle'
  },
  'recording': {
    stop: 'previewing',
    discard: 'idle'
  },
  'previewing': {
    send: 'uploading',
    discard: 'idle',
    reset: 'requesting-permission'
  },
  'uploading': {
    uploadSuccess: 'done',
    uploadFail: 'previewing'
  },
  'done': {
    reset: 'idle'
  },
  'error': {
    reset: 'idle',
    discard: 'idle'
  }
};

function createRecorderState() {
  let state = 'idle';
  const listeners = new Set();

  return {
    get() { return state; },
    send(event) {
      const next = TRANSITIONS[state]?.[event];
      if (!next || next === state) return; // unknown event: no-op
      state = next;
      listeners.forEach(fn => { try { fn(state); } catch (_) {} });
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    }
  };
}

// Export for both Node (tests) and the browser (loaded via <script>).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { createRecorderState };
} else if (typeof window !== 'undefined') {
  window.PulseRecorderState = { createRecorderState };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
cd /Users/jordanshutts/propspot/propspot-os && node tests/pulse/recorder-state.test.js
```
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/jordanshutts/propspot && git branch --show-current
```
Expected: `claude/pulse-video-voice`.

```bash
cd /Users/jordanshutts/propspot && \
  git add propspot-os/public/pulse-recorder-state.js propspot-os/tests/pulse/recorder-state.test.js && \
  git commit -m "feat(pulse): pure state machine for the recorder

Six-state machine driving the recording panel UI. Exported via UMD-style
shim so it can be required in Node tests and loaded as <script> in the
browser."
```

---

## Task 3: Canvas + audio compositor

**Files:**
- Create: `public/pulse-recorder-compositor.js`

This module owns the canvas drawing loop and the Web Audio mixer used for the "screen recording with webcam bubble" mode. It has no UI and no state machine — it just turns raw media streams into a single composite stream.

Browser media APIs can't be exercised meaningfully in Node, so this module ships without unit tests. It's verified by the manual smoke test in Task 11.

- [ ] **Step 1: Create the compositor module**

Create `propspot-os/public/pulse-recorder-compositor.js`:

```javascript
// Canvas + audio compositor for the Pulse recorder's "screen + webcam bubble"
// mode. Given two MediaStreams (screen, optional webcam), produces a single
// composite MediaStream that MediaRecorder can encode.
//
// Returns { stream, stop } — call stop() to release the canvas loop, the
// AudioContext, and stop all source tracks.

(function () {
  const WEBCAM_W = 240;
  const WEBCAM_H = 180;
  const INSET    = 24;
  const BORDER_W = 2;
  const FPS      = 30;

  // Pair a stream with a hidden <video> playing it (so we can draw video
  // frames onto canvas). Returns the <video> element once metadata loads.
  function streamToVideo(stream) {
    return new Promise((resolve) => {
      const v = document.createElement('video');
      v.autoplay = true;
      v.muted = true;
      v.playsInline = true;
      v.srcObject = stream;
      v.onloadedmetadata = () => { v.play().then(() => resolve(v)); };
    });
  }

  // Mix any non-empty audio tracks from the given streams into a single
  // MediaStream audio track using Web Audio.
  function mixAudio(streams) {
    const audioStreams = streams.filter(s => s && s.getAudioTracks().length);
    if (!audioStreams.length) return { track: null, stop: () => {} };

    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const dest = ctx.createMediaStreamDestination();
    audioStreams.forEach(s => {
      const src = ctx.createMediaStreamSource(s);
      src.connect(dest);
    });
    return {
      track: dest.stream.getAudioTracks()[0],
      stop: () => { ctx.close().catch(() => {}); }
    };
  }

  async function compositeScreenAndWebcam({ screenStream, webcamStream }) {
    const screenVideo = await streamToVideo(screenStream);
    const webcamVideo = webcamStream ? await streamToVideo(webcamStream) : null;

    const canvas = document.createElement('canvas');
    canvas.width = screenVideo.videoWidth || 1280;
    canvas.height = screenVideo.videoHeight || 720;
    const ctx = canvas.getContext('2d');

    let raf = 0;
    let stopped = false;

    function draw() {
      if (stopped) return;
      ctx.drawImage(screenVideo, 0, 0, canvas.width, canvas.height);

      if (webcamVideo) {
        const x = canvas.width  - WEBCAM_W - INSET;
        const y = canvas.height - WEBCAM_H - INSET;
        const cx = x + WEBCAM_W / 2;
        const cy = y + WEBCAM_H / 2;
        const r  = Math.min(WEBCAM_W, WEBCAM_H) / 2;

        // Circular clip → draw → restore
        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.clip();
        ctx.drawImage(webcamVideo, x, y, WEBCAM_W, WEBCAM_H);
        ctx.restore();

        // White ring
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.lineWidth = BORDER_W;
        ctx.strokeStyle = '#ffffff';
        ctx.stroke();
      }

      raf = requestAnimationFrame(draw);
    }
    draw();

    const videoTrack = canvas.captureStream(FPS).getVideoTracks()[0];
    const audio = mixAudio([screenStream, webcamStream]);
    const tracks = [videoTrack];
    if (audio.track) tracks.push(audio.track);
    const composite = new MediaStream(tracks);

    return {
      stream: composite,
      stop() {
        stopped = true;
        cancelAnimationFrame(raf);
        audio.stop();
        videoTrack.stop();
        screenStream.getTracks().forEach(t => t.stop());
        if (webcamStream) webcamStream.getTracks().forEach(t => t.stop());
      }
    };
  }

  window.PulseRecorderCompositor = { compositeScreenAndWebcam };
})();
```

- [ ] **Step 2: Commit**

```bash
cd /Users/jordanshutts/propspot && git branch --show-current
```
Expected: `claude/pulse-video-voice`.

```bash
cd /Users/jordanshutts/propspot && \
  git add propspot-os/public/pulse-recorder-compositor.js && \
  git commit -m "feat(pulse): canvas + audio compositor for screen+webcam recording

Draws a 240x180 circular webcam bubble in the bottom-right of the screen
stream each animation frame, mixes mic + screen-share audio via Web Audio,
and exposes the composite as a single MediaStream for MediaRecorder."
```

---

## Task 4: Recorder class — voice memo mode

**Files:**
- Create: `public/pulse-recorder.js`

The recorder class is built up incrementally across Tasks 4–6: voice memo (Task 4), webcam video (Task 5), screen recording (Task 6). Each task adds a `mode` branch.

- [ ] **Step 1: Create the initial recorder module with voice support only**

Create `propspot-os/public/pulse-recorder.js`:

```javascript
// PulseRecorder — builds the recording panel above the composer, drives
// MediaRecorder, uploads the finalized blob, and dispatches a
// 'pulse-recorder:done' event with attachment metadata.
//
// Usage:
//   const rec = new PulseRecorder({ mode: 'voice', mountInto: el });
//   el.addEventListener('pulse-recorder:done', e => {
//     const attachment = e.detail; // { url, mime_type, ... }
//   });
//   rec.start();

(function () {
  const CAPS_MS = {
    voice:  5 * 60 * 1000,   // 5 minutes
    webcam: 10 * 60 * 1000,  // 10 minutes
    screen: 10 * 60 * 1000
  };

  // Pick a recordable mime type for the given mode, preferring webm.
  function pickMime(mode) {
    const candidates = (mode === 'voice')
      ? ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
      : ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];
    for (const m of candidates) {
      if (window.MediaRecorder?.isTypeSupported?.(m)) return m;
    }
    return ''; // browser default
  }

  function timestamp() {
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  }

  function fmtMs(ms) {
    const total = Math.floor(ms / 1000);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${String(s).padStart(2,'0')}`;
  }

  class PulseRecorder {
    constructor({ mode, mountInto }) {
      this.mode = mode;
      this.mount = mountInto;
      this.state = window.PulseRecorderState.createRecorderState();
      this.mime = pickMime(mode);
      this.cap = CAPS_MS[mode];
      this.chunks = [];
      this.startedAt = 0;
      this.tickHandle = 0;
      this.mediaStream = null;
      this.composite = null; // { stream, stop } for screen mode
      this.recorder = null;
      this.previewUrl = null;
      this.blob = null;

      this._renderRoot();
      this.state.subscribe(() => this._render());
      this._render();
    }

    _renderRoot() {
      this.root = document.createElement('div');
      this.root.className = 'ps-recorder';
      this.mount.appendChild(this.root);
    }

    start() {
      this._beginAcquire();
    }

    _beginAcquire() {
      this.state.send('requestPermission');
      this._acquireStream()
        .then(stream => {
          this.mediaStream = stream;
          this.state.send('permissionGranted');
          this._beginRecording();
        })
        .catch(err => {
          console.warn('PulseRecorder permission/setup failed:', err);
          this._cleanupStreams();
          this.state.send('permissionDenied');
        });
    }

    async _acquireStream() {
      if (this.mode === 'voice') {
        return await navigator.mediaDevices.getUserMedia({ audio: true });
      }
      throw new Error(`Mode ${this.mode} not yet implemented`);
    }

    _beginRecording() {
      const opts = this.mime ? { mimeType: this.mime } : {};
      this.recorder = new MediaRecorder(this.mediaStream, opts);
      this.chunks = [];
      this.recorder.ondataavailable = e => { if (e.data && e.data.size) this.chunks.push(e.data); };
      this.recorder.onstop = () => this._finalizeBlob();
      this.recorder.start();
      this.startedAt = Date.now();
      this.tickHandle = setInterval(() => {
        const elapsed = Date.now() - this.startedAt;
        if (elapsed >= this.cap) { this.stopRecording(); return; }
        this._renderTimer(elapsed);
      }, 250);
    }

    stopRecording() {
      if (this.tickHandle) { clearInterval(this.tickHandle); this.tickHandle = 0; }
      if (this.recorder && this.recorder.state !== 'inactive') {
        this.recorder.stop();
      }
      this._cleanupStreams();
    }

    _cleanupStreams() {
      if (this.composite) { this.composite.stop(); this.composite = null; }
      if (this.mediaStream) {
        this.mediaStream.getTracks().forEach(t => t.stop());
        this.mediaStream = null;
      }
    }

    _finalizeBlob() {
      const type = this.recorder?.mimeType || this.mime || 'application/octet-stream';
      this.blob = new Blob(this.chunks, { type });
      this.previewUrl = URL.createObjectURL(this.blob);
      this.state.send('stop');
    }

    discard() {
      if (this.previewUrl) URL.revokeObjectURL(this.previewUrl);
      this.previewUrl = null;
      this.blob = null;
      this.chunks = [];
      this._cleanupStreams();
      this.state.send('discard');
      this.destroy();
    }

    async send() {
      if (!this.blob) return;
      this.state.send('send');
      try {
        const attachment = await this._upload(this.blob);
        this.state.send('uploadSuccess');
        this.root.dispatchEvent(new CustomEvent('pulse-recorder:done', {
          bubbles: true,
          detail: attachment
        }));
        if (this.previewUrl) URL.revokeObjectURL(this.previewUrl);
        this.destroy();
      } catch (err) {
        console.warn('PulseRecorder upload failed:', err);
        this.state.send('uploadFail');
        this._render();
        this._showToast(err?.message || 'Upload failed — try again.');
      }
    }

    _upload(blob) {
      // XHR (not fetch) so we can read upload progress.
      const ext = (blob.type.includes('mp4')) ? 'mp4' : 'webm';
      const filename = `${this.mode}-${timestamp()}.${ext}`;
      const fd = new FormData();
      fd.append('file', blob, filename);

      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', (window.API_BASE || '') + '/api/pulse/attachments');
        const token = (window.getToken && window.getToken()) || '';
        if (token) xhr.setRequestHeader('Authorization', 'Bearer ' + token);
        xhr.upload.onprogress = (e) => {
          if (!e.lengthComputable) return;
          this._renderUploadProgress(e.loaded / e.total);
        };
        xhr.onload = () => {
          const data = (() => { try { return JSON.parse(xhr.responseText); } catch (_) { return {}; } })();
          if (xhr.status >= 200 && xhr.status < 300) resolve(data);
          else reject(new Error(data.error || `Upload failed (${xhr.status})`));
        };
        xhr.onerror = () => reject(new Error('Network error during upload'));
        xhr.send(fd);
      });
    }

    _showToast(msg) {
      if (typeof window.showToast === 'function') window.showToast(msg, 'error');
    }

    destroy() {
      if (this.tickHandle) clearInterval(this.tickHandle);
      this._cleanupStreams();
      if (this.root && this.root.parentNode) this.root.parentNode.removeChild(this.root);
    }

    // ── Rendering ───────────────────────────────────────────────────
    _render() {
      const s = this.state.get();
      if (s === 'requesting-permission') {
        this.root.innerHTML = `<div class="ps-recorder-body">Requesting permission…</div>`;
        return;
      }
      if (s === 'recording') {
        this.root.innerHTML = `
          <div class="ps-recorder-body">
            <span class="ps-recorder-dot"></span>
            <span class="ps-recorder-mode">${this._modeLabel()}</span>
            <span class="ps-recorder-meter" id="ps-rec-meter"></span>
            <span class="ps-recorder-timer" id="ps-rec-timer">0:00</span>
            <button class="ps-recorder-btn ps-recorder-stop" data-action="stop">Stop</button>
            <button class="ps-recorder-btn ps-recorder-cancel" data-action="discard">Cancel</button>
          </div>`;
        this._wire();
        this._startMeter();
        return;
      }
      if (s === 'previewing') {
        const isVideo = this.mode !== 'voice';
        const player = isVideo
          ? `<video controls src="${this.previewUrl}" class="ps-recorder-preview-vid"></video>`
          : `<audio controls src="${this.previewUrl}" class="ps-recorder-preview-aud"></audio>`;
        this.root.innerHTML = `
          <div class="ps-recorder-body">
            ${player}
            <button class="ps-recorder-btn primary" data-action="send">Send</button>
            <button class="ps-recorder-btn" data-action="reset">Re-record</button>
            <button class="ps-recorder-btn ps-recorder-cancel" data-action="discard">Discard</button>
          </div>`;
        this._wire();
        return;
      }
      if (s === 'uploading') {
        this.root.innerHTML = `
          <div class="ps-recorder-body">
            <span>Uploading…</span>
            <progress id="ps-rec-progress" value="0" max="1" style="flex:1"></progress>
          </div>`;
        return;
      }
      if (s === 'error') {
        this.root.innerHTML = `
          <div class="ps-recorder-body">
            <span style="color:#ef4444">${this._permissionMessage()}</span>
            <button class="ps-recorder-btn" data-action="discard">Close</button>
          </div>`;
        this._wire();
        return;
      }
      // idle / done → no UI
      this.root.innerHTML = '';
    }

    _wire() {
      this.root.querySelectorAll('button[data-action]').forEach(btn => {
        btn.onclick = () => {
          const a = btn.getAttribute('data-action');
          if (a === 'stop') this.stopRecording();
          else if (a === 'discard') this.discard();
          else if (a === 'send') this.send();
          else if (a === 'reset') this._rerecord();
        };
      });
    }

    _rerecord() {
      if (this.previewUrl) URL.revokeObjectURL(this.previewUrl);
      this.previewUrl = null;
      this.blob = null;
      this.chunks = [];
      this._cleanupStreams();
      this._beginAcquire();
    }

    _renderTimer(elapsedMs) {
      const t = this.root.querySelector('#ps-rec-timer');
      if (t) {
        t.textContent = fmtMs(elapsedMs);
        if (this.cap - elapsedMs <= 30 * 1000) t.style.color = '#ef4444';
      }
    }

    _renderUploadProgress(frac) {
      const p = this.root.querySelector('#ps-rec-progress');
      if (p) p.value = frac;
    }

    _modeLabel() {
      return { voice: 'Voice memo', webcam: 'Webcam video', screen: 'Screen recording' }[this.mode] || 'Recording';
    }

    _permissionMessage() {
      return {
        voice:  'Pulse needs permission to use your microphone. Click the icon in your address bar to allow.',
        webcam: 'Pulse needs permission to use your camera. Click the icon in your address bar to allow.',
        screen: 'Screen recording was cancelled.'
      }[this.mode];
    }

    _startMeter() {
      // Audio-only meter (visual feedback that the mic is hot). Skipped for video modes.
      if (this.mode !== 'voice' || !this.mediaStream) return;
      const meter = this.root.querySelector('#ps-rec-meter');
      if (!meter) return;
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const src = ctx.createMediaStreamSource(this.mediaStream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      src.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      let stopped = false;
      const tick = () => {
        if (stopped || this.state.get() !== 'recording') { ctx.close().catch(() => {}); return; }
        analyser.getByteFrequencyData(data);
        let sum = 0; for (const v of data) sum += v;
        const level = Math.min(1, (sum / data.length) / 128);
        meter.style.width = (30 + level * 70) + '%';
        requestAnimationFrame(tick);
      };
      meter.style.display = 'inline-block';
      meter.style.width = '30%';
      meter.style.height = '6px';
      meter.style.background = 'linear-gradient(90deg, #ef4444, #f59e0b)';
      meter.style.borderRadius = '3px';
      meter.style.transition = 'width 80ms linear';
      tick();
      this._stopMeter = () => { stopped = true; };
    }
  }

  window.PulseRecorder = PulseRecorder;
})();
```

- [ ] **Step 2: Commit**

```bash
cd /Users/jordanshutts/propspot && git branch --show-current
```
Expected: `claude/pulse-video-voice`.

```bash
cd /Users/jordanshutts/propspot && \
  git add propspot-os/public/pulse-recorder.js && \
  git commit -m "feat(pulse): PulseRecorder class with voice-memo mode

Builds the recorder panel, drives MediaRecorder for audio capture, uploads
via XHR (for progress events) to /api/pulse/attachments, dispatches a
'pulse-recorder:done' event with the attachment metadata on success.
Webcam and screen modes are stubbed and land in tasks 5 and 6."
```

---

## Task 5: Add webcam video mode to PulseRecorder

**Files:**
- Modify: `public/pulse-recorder.js`

- [ ] **Step 1: Extend `_acquireStream` to handle webcam mode**

In `propspot-os/public/pulse-recorder.js`, find the `_acquireStream` method:

```javascript
    async _acquireStream() {
      if (this.mode === 'voice') {
        return await navigator.mediaDevices.getUserMedia({ audio: true });
      }
      throw new Error(`Mode ${this.mode} not yet implemented`);
    }
```

Replace it with:

```javascript
    async _acquireStream() {
      if (this.mode === 'voice') {
        return await navigator.mediaDevices.getUserMedia({ audio: true });
      }
      if (this.mode === 'webcam') {
        return await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: { width: { ideal: 1280 }, height: { ideal: 720 } }
        });
      }
      throw new Error(`Mode ${this.mode} not yet implemented`);
    }
```

- [ ] **Step 2: Add a live preview thumbnail for video modes**

The recording-state UI currently shows only a timer + stop button. For
webcam and screen modes, the user should see a live preview of what's being
captured. Find the recording branch in `_render`:

```javascript
      if (s === 'recording') {
        this.root.innerHTML = `
          <div class="ps-recorder-body">
            <span class="ps-recorder-dot"></span>
            <span class="ps-recorder-mode">${this._modeLabel()}</span>
            <span class="ps-recorder-meter" id="ps-rec-meter"></span>
            <span class="ps-recorder-timer" id="ps-rec-timer">0:00</span>
            <button class="ps-recorder-btn ps-recorder-stop" data-action="stop">Stop</button>
            <button class="ps-recorder-btn ps-recorder-cancel" data-action="discard">Cancel</button>
          </div>`;
        this._wire();
        this._startMeter();
        return;
      }
```

Replace it with:

```javascript
      if (s === 'recording') {
        const previewTag = (this.mode === 'voice')
          ? `<span class="ps-recorder-meter" id="ps-rec-meter"></span>`
          : `<video id="ps-rec-preview" autoplay muted playsinline class="ps-recorder-live-preview"></video>`;
        this.root.innerHTML = `
          <div class="ps-recorder-body">
            <span class="ps-recorder-dot"></span>
            <span class="ps-recorder-mode">${this._modeLabel()}</span>
            ${previewTag}
            <span class="ps-recorder-timer" id="ps-rec-timer">0:00</span>
            <button class="ps-recorder-btn ps-recorder-stop" data-action="stop">Stop</button>
            <button class="ps-recorder-btn ps-recorder-cancel" data-action="discard">Cancel</button>
          </div>`;
        this._wire();
        if (this.mode === 'voice') {
          this._startMeter();
        } else {
          const v = this.root.querySelector('#ps-rec-preview');
          if (v && this.mediaStream) v.srcObject = this.mediaStream;
        }
        return;
      }
```

- [ ] **Step 3: Add the CSS for the live preview**

The CSS for `.ps-recorder-live-preview` is added in Task 7's CSS block.
For now nothing else needs to change in this file.

- [ ] **Step 4: Commit**

```bash
cd /Users/jordanshutts/propspot && git branch --show-current
```
Expected: `claude/pulse-video-voice`.

```bash
cd /Users/jordanshutts/propspot && \
  git add propspot-os/public/pulse-recorder.js && \
  git commit -m "feat(pulse): webcam video mode + live preview for video recording

getUserMedia({ audio, video }) with a 1280x720 hint. During recording, the
recorder panel now shows a small live <video> preview for webcam and screen
modes (audio modes keep the level meter)."
```

---

## Task 6: Add screen-recording mode (with optional webcam bubble)

**Files:**
- Modify: `public/pulse-recorder.js`

- [ ] **Step 1: Update the recorder to support screen mode and a bubble toggle**

In `propspot-os/public/pulse-recorder.js`, replace the `_acquireStream` method again with:

```javascript
    async _acquireStream() {
      if (this.mode === 'voice') {
        return await navigator.mediaDevices.getUserMedia({ audio: true });
      }
      if (this.mode === 'webcam') {
        return await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: { width: { ideal: 1280 }, height: { ideal: 720 } }
        });
      }
      if (this.mode === 'screen') {
        const screenStream = await navigator.mediaDevices.getDisplayMedia({
          video: true, audio: true
        });
        let webcamStream = null;
        if (this.includeBubble) {
          try {
            webcamStream = await navigator.mediaDevices.getUserMedia({
              audio: false,
              video: { width: { ideal: 480 }, height: { ideal: 360 } }
            });
          } catch (err) {
            console.warn('Webcam bubble denied — proceeding screen-only:', err);
          }
        }
        if (!webcamStream) return screenStream;

        // Composite screen + webcam into one stream.
        this.composite = await window.PulseRecorderCompositor.compositeScreenAndWebcam({
          screenStream,
          webcamStream
        });
        return this.composite.stream;
      }
      throw new Error(`Mode ${this.mode} not yet implemented`);
    }
```

- [ ] **Step 2: Add a bubble-toggle pre-screen in the constructor**

In the constructor (after `this.blob = null;`), add:

```javascript
      this.includeBubble = (mode === 'screen');
```

- [ ] **Step 3: Render the bubble toggle in the idle/pre-record state**

Find the current `start()` method (set up in Task 4):

```javascript
    start() {
      this._beginAcquire();
    }
```

Replace it with:

```javascript
    start() {
      if (this.mode === 'screen') {
        this._renderBubbleToggle();
        return;
      }
      this._beginAcquire();
    }

    _renderBubbleToggle() {
      this.root.innerHTML = `
        <div class="ps-recorder-body">
          <label class="ps-recorder-bubble-toggle">
            <input type="checkbox" id="ps-rec-bubble" checked /> Include webcam bubble
          </label>
          <button class="ps-recorder-btn primary" data-action="go">Start screen recording</button>
          <button class="ps-recorder-btn ps-recorder-cancel" data-action="discard">Cancel</button>
        </div>`;
      this.root.querySelector('[data-action="go"]').onclick = () => {
        this.includeBubble = this.root.querySelector('#ps-rec-bubble').checked;
        this._beginAcquire();
      };
      this.root.querySelector('[data-action="discard"]').onclick = () => this.discard();
    }
```

The `_acquireStream` change in Step 1 already consumes `this.includeBubble`. The compositor (from Task 3) is invoked when bubble is on; otherwise the raw screen stream goes straight to MediaRecorder.

- [ ] **Step 4: Commit**

```bash
cd /Users/jordanshutts/propspot && git branch --show-current
```
Expected: `claude/pulse-video-voice`.

```bash
cd /Users/jordanshutts/propspot && \
  git add propspot-os/public/pulse-recorder.js && \
  git commit -m "feat(pulse): screen-recording mode with optional webcam bubble

getDisplayMedia for the screen, optional getUserMedia for the webcam,
composited via PulseRecorderCompositor. A pre-record panel lets the user
toggle the bubble before approving the screen-share prompt."
```

---

## Task 7: Wire capture buttons into the composer

**Files:**
- Modify: `public/pulse.html`

This task adds three buttons next to the textarea, loads the three new scripts, and bridges `pulse-recorder:done` into the message send flow.

- [ ] **Step 1: Add `<script>` tags for the new modules**

In `propspot-os/public/pulse.html`, find where the existing scripts are loaded (search for `<script src="app.js">` or similar). Below the existing app/auth scripts, before the closing `</body>` tag, add:

```html
<script src="/pulse-recorder-state.js"></script>
<script src="/pulse-recorder-compositor.js"></script>
<script src="/pulse-recorder.js"></script>
```

If the existing inline script wraps everything in `<script>…</script>` inside the body, place the three new lines BEFORE that inline script so the classes are defined first.

- [ ] **Step 2: Add CSS for the recorder panel**

In the `<style>` block of `propspot-os/public/pulse.html`, near the `.ps-composer-wrap` rule (around line 319), add:

```css
.ps-recorder {
  border-top: 1px solid var(--border);
  padding: 8px 12px;
  background: var(--surface);
}
.ps-recorder-body {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  font-size: .85rem;
}
.ps-recorder-dot {
  width: 10px; height: 10px; border-radius: 50%; background: #ef4444;
  animation: ps-rec-pulse 1s infinite;
}
@keyframes ps-rec-pulse { 0%, 100% { opacity: 1 } 50% { opacity: .4 } }
.ps-recorder-mode { font-weight: 600; color: var(--text); }
.ps-recorder-timer { font-variant-numeric: tabular-nums; color: var(--text-muted); }
.ps-recorder-btn {
  padding: 4px 10px; border-radius: 6px; border: 1px solid var(--border);
  background: var(--bg); color: var(--text); cursor: pointer; font-size: .82rem;
}
.ps-recorder-btn:hover { border-color: var(--brand); }
.ps-recorder-btn.primary { background: var(--brand); color: white; border-color: var(--brand); }
.ps-recorder-cancel { color: var(--text-muted); }
.ps-recorder-preview-aud, .ps-recorder-preview-vid {
  flex: 1 1 200px; max-width: 360px;
}
.ps-recorder-live-preview {
  width: 160px; height: 90px; object-fit: cover; border-radius: 6px;
  background: #000;
}
.ps-recorder-bubble-toggle { display: flex; align-items: center; gap: 6px; }

.ps-composer-tools {
  display: flex; gap: 4px; align-items: center;
}
.ps-tool-btn {
  background: transparent; border: 0; cursor: pointer; padding: 6px;
  color: var(--text-muted); border-radius: 6px;
}
.ps-tool-btn:hover { background: var(--brand-light); color: var(--brand); }
.ps-tool-btn:disabled { opacity: .35; cursor: not-allowed; }

/* Inline attachment players in messages */
.ps-msg-attachment { margin-top: 6px; max-width: 360px; }
.ps-msg-attachment video, .ps-msg-attachment audio { max-width: 100%; border-radius: 8px; }
.ps-msg-attachment img { max-width: 100%; border-radius: 8px; }
.ps-msg-attachment.file a {
  display: inline-flex; gap: 6px; align-items: center;
  padding: 6px 10px; border: 1px solid var(--border); border-radius: 8px;
  text-decoration: none; color: var(--text); font-size: .85rem;
}
```

- [ ] **Step 3: Add the three buttons to the composer markup and a host for the recorder panel**

Find the existing composer block in `propspot-os/public/pulse.html` (around line 1158):

```html
        <div class="ps-composer">
          <textarea id="ps-textarea" placeholder="Message ${escHtml(activeScope.name)}… (type @ to mention someone)" rows="1"
            onkeydown="handleKey(event)" oninput="onComposerInput(this)"></textarea>
          <button class="btn btn-primary ps-send" onclick="sendMsg()">Send</button>
        </div>
```

Replace it with:

```html
        <div id="ps-recorder-host"></div>
        <div class="ps-composer">
          <div class="ps-composer-tools">
            <button class="ps-tool-btn" id="ps-tool-voice"  title="Voice memo"      onclick="startPulseRecording('voice')">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
            </button>
            <button class="ps-tool-btn" id="ps-tool-webcam" title="Webcam video"    onclick="startPulseRecording('webcam')">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>
            </button>
            <button class="ps-tool-btn" id="ps-tool-screen" title="Screen recording" onclick="startPulseRecording('screen')">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
            </button>
          </div>
          <textarea id="ps-textarea" placeholder="Message ${escHtml(activeScope.name)}… (type @ to mention someone)" rows="1"
            onkeydown="handleKey(event)" oninput="onComposerInput(this)"></textarea>
          <button class="btn btn-primary ps-send" onclick="sendMsg()">Send</button>
        </div>
```

The recorder panel mounts into `#ps-recorder-host`. The three buttons sit to the left of the textarea.

- [ ] **Step 4: Add the JS bridge functions**

Still in `propspot-os/public/pulse.html`, find the `async function sendMsg()` block (around line 1800). Immediately before it, add:

```javascript
  // ── Pulse Recorder integration ──────────────────────────────────
  let pendingAttachments = [];
  let activeRecorder = null;

  // Feature flag — flip on for one user before broad rollout.
  function isRecorderEnabled() {
    if (new URLSearchParams(location.search).get('pulse_recorder') === '1') return true;
    try { return localStorage.getItem('pulse_recorder') === '1'; } catch (_) { return false; }
  }

  function hideUnsupportedRecorderButtons() {
    if (!isRecorderEnabled()) {
      ['ps-tool-voice','ps-tool-webcam','ps-tool-screen'].forEach(id => {
        const el = document.getElementById(id); if (el) el.style.display = 'none';
      });
      return;
    }
    const noMedia = !navigator.mediaDevices?.getUserMedia;
    const noScreen = !navigator.mediaDevices?.getDisplayMedia;
    if (noMedia) {
      ['ps-tool-voice','ps-tool-webcam'].forEach(id => {
        const el = document.getElementById(id); if (el) el.style.display = 'none';
      });
    }
    if (noScreen) {
      const el = document.getElementById('ps-tool-screen'); if (el) el.style.display = 'none';
    }
  }

  function startPulseRecording(mode) {
    if (activeRecorder) { activeRecorder.destroy(); activeRecorder = null; }
    const host = document.getElementById('ps-recorder-host');
    if (!host) return;
    activeRecorder = new PulseRecorder({ mode, mountInto: host });
    host.addEventListener('pulse-recorder:done', (e) => {
      pendingAttachments.push(e.detail);
      sendMsg();
      activeRecorder = null;
    }, { once: true });
    activeRecorder.start();
  }
```

- [ ] **Step 5: Call `hideUnsupportedRecorderButtons` after the composer renders**

Find where the composer DOM gets injected (look for the line that ends with `</div>\``;` near line 1164, immediately after the composer-wrap template literal). After the template-literal assignment runs (i.e., right after the `try {` block that fetches messages, around line 1166), add a one-liner:

```javascript
    hideUnsupportedRecorderButtons();
```

Place this line immediately before `try {` on line 1166, like:

```javascript
        <div class="ps-composer-hint">Shift+Enter for new line · @ to mention</div>
      </div>`;

    hideUnsupportedRecorderButtons();

    try {
      const qp = scope.channel_id ? `?channel_id=${scope.channel_id}` : `?dm_id=${scope.dm_id}`;
```

- [ ] **Step 6: Commit**

```bash
cd /Users/jordanshutts/propspot && git branch --show-current
```
Expected: `claude/pulse-video-voice`.

```bash
cd /Users/jordanshutts/propspot && \
  git add propspot-os/public/pulse.html && \
  git commit -m "feat(pulse): wire capture buttons + recorder host into the composer

Adds three icon buttons (voice / webcam / screen) next to the textarea, a
host div for the recorder panel above the composer, CSS for the recorder
panel and inline attachment players, and JS glue that bridges the
'pulse-recorder:done' event into sendMsg. Gated behind ?pulse_recorder=1
or localStorage.pulse_recorder=1 so we can dogfood with one user first.
Screen-recording button is hidden on browsers without getDisplayMedia."
```

---

## Task 8: Teach `sendMsg` to send attachments

**Files:**
- Modify: `public/pulse.html`

`sendMsg()` currently sends only body text. It must include `pendingAttachments` and allow an empty body when attachments are present.

- [ ] **Step 1: Replace `sendMsg` body to handle attachments**

In `propspot-os/public/pulse.html`, find `async function sendMsg()` (around line 1800). Replace its body with:

```javascript
  async function sendMsg() {
    if (!activeScope) return;
    const ta = document.getElementById('ps-textarea');
    if (!ta) return;
    let text = ta.value.trim();
    const attachments = pendingAttachments.slice();
    pendingAttachments = [];

    if (!text && !attachments.length) return;
    ta.value = ''; ta.style.height = '';
    closeMentionPicker();

    if (text && pendingMentions.size) {
      pendingMentions.forEach((uid, name) => {
        const safe = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        text = text.replace(
          new RegExp(`@${safe}(?=\\s|$|[^\\w])`, 'g'),
          `<span class="pulse-mention" data-uid="${uid}">@${name}</span>`
        );
      });
      pendingMentions.clear();
    }

    const payload = activeScope.type === 'channel'
      ? { channel_id: activeScope.id, body: text }
      : { dm_id:      activeScope.id, body: text };
    if (attachments.length) payload.attachments = attachments;
    if (replyingTo) { payload.reply_to_id = replyingTo.id; cancelReply(); }
    try {
      await satelliteApiFetch('pulse', '/api/pulse/messages', {
        method: 'POST', body: JSON.stringify(payload)
      });
    } catch (e) {
      showToast(e.message, 'error');
      ta.value = text;
      pendingAttachments = attachments; // restore so a retry can resend
    }
  }
```

Three changes from the original: snapshot + clear `pendingAttachments` before sending, allow an empty body when attachments are present, restore attachments on failure.

- [ ] **Step 2: Commit**

```bash
cd /Users/jordanshutts/propspot && git branch --show-current
```
Expected: `claude/pulse-video-voice`.

```bash
cd /Users/jordanshutts/propspot && \
  git add propspot-os/public/pulse.html && \
  git commit -m "feat(pulse): sendMsg now sends pendingAttachments

Attachments captured from the recorder ride along on the next sendMsg call.
An empty body is allowed when attachments are present; on POST failure the
attachments are restored to pendingAttachments so the user can retry."
```

---

## Task 9: Render audio/video attachments in message bubbles

**Files:**
- Modify: `public/pulse.html`

`msgHtml()` currently renders only the body text. The backend has been returning `attachments: [...]` on every message all along — they just weren't displayed. This task adds rendering for image, audio, and video; everything else falls back to a file link.

- [ ] **Step 1: Add an `attachmentsHtml` helper**

In `propspot-os/public/pulse.html`, immediately above `function msgHtml(m)` (around line 1192), add:

```javascript
  function cloudinaryPoster(url) {
    // .../video/upload/<rest>.<ext>  →  .../video/upload/so_auto/<rest>.jpg
    return url
      .replace('/video/upload/', '/video/upload/so_auto/')
      .replace(/\.(webm|mp4|mov|quicktime)$/i, '.jpg');
  }

  function attachmentsHtml(atts) {
    if (!Array.isArray(atts) || !atts.length) return '';
    return atts.map(a => {
      const mime = a.mime_type || '';
      const url  = a.url;
      const safeFn = escHtml(a.filename || 'file');
      if (mime.startsWith('image/')) {
        return `<div class="ps-msg-attachment"><a href="${url}" target="_blank" rel="noopener"><img src="${url}" alt="${safeFn}" loading="lazy" /></a></div>`;
      }
      if (mime.startsWith('audio/')) {
        return `<div class="ps-msg-attachment"><audio controls preload="metadata" src="${url}"></audio></div>`;
      }
      if (mime.startsWith('video/')) {
        const poster = cloudinaryPoster(url);
        return `<div class="ps-msg-attachment"><video controls preload="metadata" poster="${poster}" src="${url}"></video></div>`;
      }
      return `<div class="ps-msg-attachment file"><a href="${url}" target="_blank" rel="noopener">📎 ${safeFn}</a></div>`;
    }).join('');
  }
```

- [ ] **Step 2: Insert the attachments block into the message body**

Still in `msgHtml()`, find the line:

```javascript
        <div class="ps-msg-text" id="msgt-${mid}">${textOut}${edited}</div>
```

Replace it with:

```javascript
        <div class="ps-msg-text" id="msgt-${mid}">${textOut}${edited}</div>
        ${attachmentsHtml(m.attachments || [])}
```

- [ ] **Step 3: Smoke check that nothing regressed on text-only messages**

Run:
```bash
cd /Users/jordanshutts/propspot/propspot-os && node tests/pulse/attachments.test.js && node tests/pulse/recorder-state.test.js
```
Expected: both test scripts still pass (they don't test rendering, but confirm we haven't broken `attachments.js` or `pulse-recorder-state.js`).

Then load Pulse in a browser (running locally or via preview), open a channel with existing text messages, and confirm they still render. (No automated check for the DOM — visual.)

- [ ] **Step 4: Commit**

```bash
cd /Users/jordanshutts/propspot && git branch --show-current
```
Expected: `claude/pulse-video-voice`.

```bash
cd /Users/jordanshutts/propspot && \
  git add propspot-os/public/pulse.html && \
  git commit -m "feat(pulse): inline attachment rendering for image/audio/video

msgHtml now renders attachments under the message text. Images get an
inline <img>, audio gets browser-native <audio controls>, video gets
<video controls> with a Cloudinary so_auto poster, everything else falls
back to a clickable file link."
```

---

## Task 10: Manual smoke test + flag flip

**Files:**
- (None — manual verification)

- [ ] **Step 1: Deploy / preview the branch**

Push the branch and wait for Railway to deploy, or run the local preview server:
```bash
cd /Users/jordanshutts/propspot/propspot-os && node preview-server.js
```

Open Pulse with the flag on: `https://propspot.io/pulse.html?pulse_recorder=1` (or the local equivalent).

- [ ] **Step 2: Run the manual smoke checklist**

Walk through each row. Mark each ✅ or note the failure:

- [ ] Voice memo in Chrome desktop — record 10s of speech, send, replay in the message bubble.
- [ ] Voice memo in Safari iOS — record, send, replay. (Confirms the `audio/mp4` mime fallback path works server-side.)
- [ ] Webcam video in Chrome mobile — record, send, replay.
- [ ] Screen recording with webcam bubble in Chrome desktop — share a tab, talk, stop, send, replay; confirm the round webcam bubble appears in the bottom-right of the played-back video.
- [ ] Screen recording WITHOUT the bubble (uncheck the toggle) — record, send, replay; confirm no bubble appears.
- [ ] iOS Safari — confirm the screen-recording button is hidden (only voice + webcam buttons show).
- [ ] Deny mic permission on a voice-memo attempt — confirm the red error message in the panel + the panel can be closed.
- [ ] Cancel the screen-share permission prompt — confirm a graceful close, no console errors.
- [ ] Force a recording past 5:00 voice or 10:00 video — confirm auto-stop and that the preview shows.
- [ ] Confirm the Cloudinary poster frame appears for video attachments before the user hits play (the `so_auto` URL should resolve to a JPG; check the Network tab if needed).

- [ ] **Step 3: Persist the flag for the dogfood user**

In the test user's browser console:
```javascript
localStorage.setItem('pulse_recorder', '1');
```

Confirm reloading Pulse without the query string still shows the three buttons.

- [ ] **Step 4: Open the pull request**

```bash
cd /Users/jordanshutts/propspot && git push -u origin claude/pulse-video-voice
```

Then create the PR with `gh pr create` referencing this plan and the spec:

```bash
cd /Users/jordanshutts/propspot && gh pr create --title "Pulse: voice memos + video recording (behind ?pulse_recorder=1 flag)" --body "$(cat <<'EOF'
## Summary
- Adds three new capture modes to Pulse: voice memo, webcam video, and screen recording with optional webcam-bubble overlay.
- Reuses the existing `POST /api/pulse/attachments` pipeline; widens its mime allowlist (`audio/*`, `video/*`) and raises the size cap (25 MB → 200 MB).
- New frontend modules: `pulse-recorder-state.js` (pure state machine), `pulse-recorder-compositor.js` (canvas + Web Audio), `pulse-recorder.js` (UI + MediaRecorder).
- Inline playback in message bubbles via `<audio>`/`<video>` with Cloudinary `so_auto` posters.
- Gated behind `?pulse_recorder=1` / `localStorage.pulse_recorder=1` for dogfooding.

Spec: `docs/superpowers/specs/2026-05-27-pulse-voice-video-design.md`
Plan: `docs/superpowers/plans/2026-05-27-pulse-voice-video.md`

## Test plan
- [x] `node tests/pulse/attachments.test.js` — mime allowlist
- [x] `node tests/pulse/recorder-state.test.js` — state machine transitions
- [ ] Manual smoke (see task 10 in the plan): voice memo, webcam video, screen recording w/ and w/o bubble, mobile button hiding, permission denials, auto-stop, Cloudinary posters

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 5: Once dogfooding passes for a day, remove the flag in a follow-up commit**

After Jordan confirms the flagged version works for the dogfood user, drop the `isRecorderEnabled()` gate:

In `propspot-os/public/pulse.html`, find:

```javascript
  function isRecorderEnabled() {
    if (new URLSearchParams(location.search).get('pulse_recorder') === '1') return true;
    try { return localStorage.getItem('pulse_recorder') === '1'; } catch (_) { return false; }
  }

  function hideUnsupportedRecorderButtons() {
    if (!isRecorderEnabled()) {
      ['ps-tool-voice','ps-tool-webcam','ps-tool-screen'].forEach(id => {
        const el = document.getElementById(id); if (el) el.style.display = 'none';
      });
      return;
    }
```

Replace with:

```javascript
  function hideUnsupportedRecorderButtons() {
```

(Delete the `isRecorderEnabled` function and the early-return guard. The capability-based hiding below stays.)

Commit:

```bash
cd /Users/jordanshutts/propspot && git branch --show-current
```
Expected: `claude/pulse-video-voice`.

```bash
cd /Users/jordanshutts/propspot && \
  git add propspot-os/public/pulse.html && \
  git commit -m "feat(pulse): remove ?pulse_recorder=1 flag — recorder is GA

Dogfood passed; the three capture buttons now show for everyone whose
browser supports the underlying APIs."
```
