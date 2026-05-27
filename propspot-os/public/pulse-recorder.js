// PulseRecorder — builds the recording panel above the composer, drives
// MediaRecorder, uploads the finalized blob, and dispatches a
// 'pulse-recorder:done' event with attachment metadata.
//
// Usage:
//   const rec = new PulseRecorder({ mode: 'voice', mountInto: el });
//   el.addEventListener('pulse-recorder:done', e => {
//     const attachment = e.detail;
//   });
//   rec.start();

(function () {
  const CAPS_MS = {
    voice:  5 * 60 * 1000,
    webcam: 10 * 60 * 1000,
    screen: 10 * 60 * 1000
  };

  function pickMime(mode) {
    const candidates = (mode === 'voice')
      ? ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
      : ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];
    for (const m of candidates) {
      if (window.MediaRecorder?.isTypeSupported?.(m)) return m;
    }
    return '';
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
      this.composite = null;
      this.recorder = null;
      this.previewUrl = null;
      this.blob = null;
      this.includeBubble = (mode === 'screen');

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

        this.composite = await window.PulseRecorderCompositor.compositeScreenAndWebcam({
          screenStream,
          webcamStream
        });
        return this.composite.stream;
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

    _render() {
      const s = this.state.get();
      if (s === 'requesting-permission') {
        this.root.innerHTML = `<div class="ps-recorder-body">Requesting permission…</div>`;
        return;
      }
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
