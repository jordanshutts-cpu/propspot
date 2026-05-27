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

  // Audio-only composite — no canvas, no bubble. Combines the screen video
  // track with a mixed audio track of (mic + screen-share audio). Used when
  // the user records the screen without enabling the webcam bubble.
  function composeScreenWithMic({ screenStream, micStream }) {
    const audio = mixAudio([screenStream, micStream]);
    const screenVideoTrack = screenStream.getVideoTracks()[0];
    const tracks = [screenVideoTrack];
    if (audio.track) tracks.push(audio.track);
    const composite = new MediaStream(tracks);
    return {
      stream: composite,
      stop() {
        audio.stop();
        screenStream.getTracks().forEach(t => t.stop());
        if (micStream) micStream.getTracks().forEach(t => t.stop());
      }
    };
  }

  async function compositeScreenAndWebcam({ screenStream, webcamStream, micStream }) {
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

        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.clip();
        ctx.drawImage(webcamVideo, x, y, WEBCAM_W, WEBCAM_H);
        ctx.restore();

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
    const audio = mixAudio([screenStream, webcamStream, micStream]);
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
        if (micStream)    micStream.getTracks().forEach(t => t.stop());
      }
    };
  }

  window.PulseRecorderCompositor = { compositeScreenAndWebcam, composeScreenWithMic };
})();
