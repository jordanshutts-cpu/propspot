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
      if (!next || next === state) return;
      state = next;
      listeners.forEach(fn => { try { fn(state); } catch (_) {} });
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    }
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { createRecorderState };
} else if (typeof window !== 'undefined') {
  window.PulseRecorderState = { createRecorderState };
}
