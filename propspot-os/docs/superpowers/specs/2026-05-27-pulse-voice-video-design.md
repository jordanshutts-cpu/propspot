# Pulse — Voice Memos & Video Recording

**Date:** 2026-05-27
**Status:** Approved
**Owner:** Jordan Shutts

## Problem

Pulse currently supports text messages with image and document attachments,
but operators can't quickly send a voice note or a screen-recording walkthrough
without leaving the app. Slack offers both (voice clips and "Clips" screen
recordings), and it has become the expected baseline for an internal messaging
tool. Today, operators have to record externally (QuickTime, phone voice memo,
Loom) and re-upload — slow, fragmented, and the resulting files often exceed
the current 25 MB attachment cap.

## Goals

1. Record and send **voice memos** (microphone only) from any device.
2. Record and send **webcam videos** (face + voice) from any device.
3. Record and send **screen recordings with audio**, with an optional webcam
   bubble overlay in the corner (Loom-style), on desktop.
4. Reuse the existing Pulse attachment pipeline (`POST /api/pulse/attachments`
   → Cloudinary → row in `chat_attachments` → referenced from the message).
5. Inline playback in the message bubble — audio plays in place; video plays
   in place; tap to fullscreen.

## Non-goals

- Trimming or editing recordings before send.
- Captions, transcription, or speech-to-text.
- Real-time video calls or live streaming.
- Push notifications (separate effort).
- Native mobile camera-roll integration (handled in the future Capacitor wrap).
- View receipts ("12 people watched this clip").
- Chunked / resumable uploads.

## Solution

### 1. Capture buttons in the composer

Add three icon buttons to the message composer in `public/pulse.html`, sitting
next to the existing paperclip:

- 🎤 **Voice memo** — visible on all devices.
- 📹 **Webcam video** — visible on all devices.
- 🖥️ **Screen recording** — visible only when `navigator.mediaDevices.getDisplayMedia`
  is present (effectively: desktop browsers).

Buttons are hidden (not greyed out) when their underlying API is unsupported,
so the UI doesn't advertise broken functionality.

### 2. Recording panel

When the user clicks a capture button, a small recording panel slides up
above the composer:

- **Idle / pre-recording:** big record button, "Cancel" link.
- **Recording:** audio level meter (a pulsing bar driven by an `AnalyserNode`
  reading the mic input — not a full waveform) for audio modes, or a live
  preview thumbnail for video modes, plus an elapsed timer (`MM:SS`), red dot,
  and stop button. The last 30 seconds before the cap triggers a color change
  on the timer.
- **Stopped, previewing:** inline `<audio>` or `<video>` player with the local
  blob, "Send" button, "Discard" button, "Re-record" button.
- **Uploading:** progress bar (driven by `XMLHttpRequest`'s `upload.onprogress`
  event since `fetch` doesn't expose progress).
- On send: the recording uploads, the resulting attachment metadata is added
  to the message body, the message posts, the panel closes.

The panel is a single component (`PulseRecorder`) parameterized by mode
(`voice` | `webcam` | `screen`). State machine: `idle → requesting-permission →
recording → previewing → uploading → done` (or `error` at any step).

### 3. Browser capture APIs

| Mode | Stream sources | Container | Codec |
| --- | --- | --- | --- |
| Voice memo | `getUserMedia({ audio: true })` | `audio/webm` (Chrome/Edge/Firefox); `audio/mp4` (Safari fallback) | Opus / AAC |
| Webcam video | `getUserMedia({ video: true, audio: true })` | `video/webm` / `video/mp4` | VP9+Opus / H.264+AAC |
| Screen recording | `getDisplayMedia({ video: true, audio: true })` + optional `getUserMedia({ video: true, audio: true })` for the bubble | `video/webm` | VP9+Opus |

Container/codec selection uses `MediaRecorder.isTypeSupported()` at runtime;
Safari falls back to MP4 variants, everywhere else uses WebM.

### 4. Screen + webcam-bubble compositing (desktop only)

When the screen-record button is clicked, the user is prompted (in the panel)
to toggle "Include webcam bubble." If on:

1. Acquire two streams: screen (`getDisplayMedia`) and webcam (`getUserMedia`).
2. Create a hidden `<canvas>` matching the screen stream's resolution.
3. Each animation frame (`requestAnimationFrame`):
   - Draw the screen `<video>` element to the canvas as the base layer.
   - Draw the webcam `<video>` element at 240×180 px in the bottom-right
     corner, inset 24 px from the edges, with a 2 px white border and circular
     clipping (`ctx.save()` → `ctx.beginPath()` → `ctx.arc()` → `ctx.clip()`
     → draw → `ctx.restore()`).
4. Mix audio: a Web Audio API `AudioContext` with a `MediaStreamAudioSourceNode`
   for each input (mic + screen-share audio if present) feeding a
   `ChannelMergerNode` → `MediaStreamDestinationNode`. The merged audio track
   plus `canvas.captureStream(30).getVideoTracks()[0]` form the composite
   `MediaStream`.
5. `MediaRecorder` records the composite stream into one `.webm` blob.

If the user declines the webcam permission prompt mid-flow, the bubble toggle
auto-switches off and the recording proceeds screen-only. If the screen-share
itself is denied, the panel closes and shows the permission toast.

### 5. Length caps & sizing

- **Voice memo:** 5-minute cap (auto-stops at 5:00).
- **Video (webcam or screen):** 10-minute cap (auto-stops at 10:00).
- **File size cap:** 200 MB. (10 min of 720p screen recording at 1.5 Mbps video
  + 128 kbps audio ≈ 120 MB; the cap gives headroom for higher-resolution
  screens.)
- The client doesn't try to enforce the file-size cap pre-upload — it relies
  on the server's 413 response (see §7) and surfaces a retry-with-shorter-clip
  message.

### 6. Upload & storage (reusing existing pipeline)

The blob is sent through the existing `POST /api/pulse/attachments` endpoint
unchanged on the wire. The frontend builds a `FormData` with `file` set to
the blob plus a generated filename (`voice-2026-05-27-1442.webm`,
`screen-2026-05-27-1442.webm`, `webcam-2026-05-27-1442.webm`).

After upload, the response shape is identical to today's image flow:
`{ url, cloudinary_id, mime_type, size_bytes, filename }`. The frontend
includes the attachment in the next `POST /api/pulse/messages` body, exactly
as it does for images.

`chat_attachments` requires **no schema change** — `mime_type` already
distinguishes audio/video from images at render time.

### 7. Backend changes — `routes/pulse/attachments.js`

Two changes only:

1. **Widen the mime-type allowlist:**
   - Add to `ALLOWED_PREFIXES`: `audio/`, `video/`.
   - (Existing `image/` prefix and Office-doc exact matches remain.)
2. **Raise `MAX_BYTES`:**
   - `25 * 1024 * 1024` → `200 * 1024 * 1024`.

`lib/pulse-cloudinary.js` requires no changes — it already calls Cloudinary
with `resource_type: 'auto'`, which auto-detects video uploads and stores
them with video-resource semantics (transcoded variants, poster frames, etc.
available via Cloudinary URL transforms).

### 8. Playback in message bubbles

The attachment renderer in `public/pulse.html` becomes a small switch:

- `mime_type` starts with `image/` → existing inline thumbnail (unchanged).
- `mime_type` starts with `audio/` → custom audio player: a play/pause button
  + thin scrub bar + elapsed/total time, wrapping a hidden `<audio>` element.
  The custom UI makes a voice memo look like a voice memo, not a generic file
  attachment.
- `mime_type` starts with `video/` → `<video controls preload="metadata"
  poster="<cloudinary-poster-url>">` at the same max-width as image
  attachments. The poster URL is built from the `url` returned by Cloudinary
  by inserting `/so_auto/` after `/upload/` (Cloudinary's "auto-pick a frame"
  transformation) and swapping the file extension for `.jpg`. Example:
  `…/video/upload/v123/abc.webm` → `…/video/upload/so_auto/v123/abc.jpg`.
- Anything else → existing file-link rendering (unchanged).

Video plays inline; the user can fullscreen via native browser controls.

### 9. Error handling

| Scenario | Behavior |
| --- | --- |
| Mic/camera permission denied | Toast: "Pulse needs permission to use your microphone. Click the icon in your address bar to allow." Panel closes. |
| Screen-share permission denied | Toast: "Screen recording was cancelled." Panel closes. |
| `MediaRecorder` unsupported | The button never mounts (feature-detected on load). |
| Recording too large (413 from server) | Toast: "Recording too large — try a shorter clip." Blob kept in memory; "Re-record" stays available, "Send" disabled. |
| Network drop mid-upload | Toast: "Upload failed — tap to retry." Retry button posts the same blob to the same endpoint. No chunked uploads. |
| Tab closed mid-recording | Recording is discarded (no draft persistence). |
| User clicks Discard | Blob released (`URL.revokeObjectURL`), panel closes, no upload. |

### 10. Testing

Propspot-os has no JS test runner today (no `npm test` script, no Jest/Vitest
in `package.json`); existing Pulse changes are verified by manual smoke and
small one-off Node assert scripts. This work follows the same pattern.

**Automated checks — small `node:assert` script** at
`tests/pulse/attachments.test.js`, runnable via `node tests/pulse/attachments.test.js`:

- `isAllowedMime()` accepts audio/webm, audio/mp4, audio/mpeg, video/webm,
  video/mp4, plus the existing image/PDF/etc. happy paths.
- `isAllowedMime()` rejects unrelated binaries (e.g., `application/x-msdownload`).

This script can be wired into a future `npm test` without changing its shape.

**Manual smoke (pre-merge checklist):**

- Record a voice memo in Chrome desktop, post, replay.
- Record a voice memo in Safari iOS, post, replay.
- Record a webcam video in Chrome mobile, post, replay.
- Record a screen recording with webcam bubble in Chrome desktop, post, replay.
- Record a screen recording without the bubble in Chrome desktop, post, replay.
- Try to record screen on iOS Safari — confirm the button is hidden.
- Deny mic permission on a voice-memo attempt, confirm the toast in §9 appears.
- Deny screen-share permission, confirm the cancelled toast appears.
- Force a recording past 5:00 (voice) and 10:00 (video) — confirm auto-stop.
- Confirm video posters render (Cloudinary `so_auto` frame appears before play).

### 11. Mobile behavior summary

| Device | Voice memo | Webcam video | Screen recording |
| --- | --- | --- | --- |
| Desktop Chrome/Edge/Firefox | ✅ | ✅ | ✅ |
| Desktop Safari | ✅ (mp4) | ✅ (mp4) | ✅ (limited — Safari's `getDisplayMedia` lacks system audio in many cases; we capture mic only) |
| iOS Safari / Android Chrome | ✅ | ✅ | ❌ (button hidden) |

## Open questions / risks

- **Safari MediaRecorder quirks:** Safari historically lagged on
  `MediaRecorder`; canvas-stream recording specifically has been fragile.
  Mitigation: if `MediaRecorder.isTypeSupported('video/webm')` is false AND
  the user picks "screen + bubble" on Safari, fall back to screen-only
  (no compositing), with a tooltip explaining the limitation.
- **Cloudinary free-tier video quotas:** Cloudinary's free tier caps total
  storage and bandwidth. Video uploads consume both faster than images.
  Out of scope to address here, but worth a dashboard check post-launch.

## Rollout

1. Land the backend mime-type + size-cap changes first (tiny, low-risk).
2. Land the frontend recorder behind a `?pulse_recorder=1` query-string flag
   so we can dogfood with one user before turning it on for everyone.
3. Smoke-test all three modes manually, including the failure paths in §9.
4. Remove the flag and merge to main.
