// ============================================================
//  FieldCam Annotator — Canvas-based photo markup tool
//  Usage: openAnnotator(source, onSave, onCancel)
//    source   : URL string, File, or Blob
//    onSave   : function(blob)  — called with annotated JPEG blob
//    onCancel : function()      — called on cancel
// ============================================================

function openAnnotator(source, onSave, onCancel) {
  const existing = document.getElementById('fc-annotator-overlay');
  if (existing) existing.remove();

  // ── Styles ────────────────────────────────────────────────
  if (!document.getElementById('fc-ann-style')) {
    const s = document.createElement('style');
    s.id = 'fc-ann-style';
    s.textContent = `
      #fc-annotator-overlay {
        position: fixed; inset: 0; background: #000; z-index: 9999;
        display: flex; flex-direction: column;
      }
      #ann-bar {
        display: flex; align-items: center; gap: 8px; flex-shrink: 0;
        padding: max(env(safe-area-inset-top, 0px), 14px) 12px 10px;
        background: #1c1c1e;
        overflow-x: auto; -webkit-overflow-scrolling: touch;
        scrollbar-width: none;
      }
      #ann-bar::-webkit-scrollbar { display: none; }
      .ann-btn {
        background: rgba(255,255,255,.15);
        border: 1.5px solid rgba(255,255,255,.2);
        color: rgba(255,255,255,.8);
        border-radius: 8px; padding: 9px 13px;
        font-size: .8rem; font-weight: 600;
        cursor: pointer; white-space: nowrap; flex-shrink: 0;
      }
      .ann-btn.ann-active {
        background: #61B746; border-color: #61B746; color: #fff;
      }
      .ann-btn.ann-save {
        background: #61B746; border-color: #61B746; color: #fff; font-weight: 700;
      }
      .ann-color-dot {
        width: 27px; height: 27px; border-radius: 50%;
        cursor: pointer; flex-shrink: 0;
        border: 2.5px solid transparent;
        transition: border-color .12s;
      }
      .ann-color-dot.ann-color-sel { border-color: #fff !important; }
      #ann-canvas-wrap {
        flex: 1; display: flex; align-items: center; justify-content: center;
        overflow: hidden; position: relative; min-height: 0;
      }
      #ann-canvas { max-width: 100%; max-height: 100%; touch-action: none; display: block; }
      #ann-text-inp {
        position: fixed; display: none;
        background: rgba(0,0,0,.78); border-radius: 7px;
        padding: 7px 12px; font-size: 1.05rem; font-weight: 700;
        outline: none; z-index: 10001; min-width: 160px;
        transform: translateY(-110%);
      }
    `;
    document.head.appendChild(s);
  }

  // ── DOM ───────────────────────────────────────────────────
  const overlay = document.createElement('div');
  overlay.id = 'fc-annotator-overlay';
  overlay.innerHTML = `
    <div id="ann-bar">
      <button class="ann-btn" onclick="_annCancel()">✕</button>
      <button class="ann-btn ann-active" id="ann-t-text"   onclick="_annTool('text')">T&nbsp;Text</button>
      <button class="ann-btn"            id="ann-t-circle" onclick="_annTool('circle')">○&nbsp;Circle</button>
      <button class="ann-btn"            id="ann-t-arrow"  onclick="_annTool('arrow')">↗&nbsp;Arrow</button>
      <button class="ann-btn"            id="ann-t-check"  onclick="_annTool('check')"  style="color:#30D158;border-color:#30D158;">✓&nbsp;Check</button>
      <button class="ann-btn"            id="ann-t-cross"  onclick="_annTool('cross')"  style="color:#FF3B30;border-color:#FF3B30;">✕&nbsp;Mark</button>
      <div style="display:flex;gap:6px;align-items:center;flex-shrink:0;margin:0 2px;">
        <div class="ann-color-dot ann-color-sel" data-c="#FF3B30" style="background:#FF3B30"  onclick="_annColor('#FF3B30')"></div>
        <div class="ann-color-dot"               data-c="#FFD60A" style="background:#FFD60A"  onclick="_annColor('#FFD60A')"></div>
        <div class="ann-color-dot"               data-c="#30D158" style="background:#30D158"  onclick="_annColor('#30D158')"></div>
        <div class="ann-color-dot"               data-c="#fff"    style="background:#fff"     onclick="_annColor('#fff')"></div>
        <div class="ann-color-dot"               data-c="#111"    style="background:#111;border:1px solid #555" onclick="_annColor('#111')"></div>
      </div>
      <button class="ann-btn" onclick="_annUndo()">↩&nbsp;Undo</button>
      <button class="ann-btn ann-save" onclick="_annSave()">✓&nbsp;Done</button>
    </div>
    <div id="ann-canvas-wrap">
      <canvas id="ann-canvas"></canvas>
    </div>
    <input id="ann-text-inp" type="text" placeholder="Type text, press Enter">
  `;
  document.body.appendChild(overlay);

  // ── State ─────────────────────────────────────────────────
  const canvas  = document.getElementById('ann-canvas');
  const ctx     = canvas.getContext('2d');
  const txtInp  = document.getElementById('ann-text-inp');
  let img         = new Image();
  let annotations = [];
  let tool        = 'text';
  let color       = '#FF3B30';
  let drawing     = false;
  let sx = 0, sy = 0, temp = null;
  let pendingTX = 0, pendingTY = 0;
  let blobUrl = null;

  // ── Load image ────────────────────────────────────────────
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    canvas.width  = img.naturalWidth  || 1920;
    canvas.height = img.naturalHeight || 1080;
    redraw();
  };
  if (typeof source === 'string') {
    img.src = source;
  } else {
    blobUrl = URL.createObjectURL(source);
    img.src = blobUrl;
  }

  function cleanup() {
    if (blobUrl) { URL.revokeObjectURL(blobUrl); blobUrl = null; }
  }

  // ── Helpers ───────────────────────────────────────────────
  function lw() { return Math.max(4, canvas.width * 0.005); }
  function fs() { return Math.max(28, canvas.width * 0.04); }

  function redraw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0);
    [...annotations, ...(temp ? [temp] : [])].forEach(draw);
  }

  function draw(a) {
    ctx.save();
    ctx.strokeStyle = a.color;
    ctx.fillStyle   = a.color;
    ctx.lineWidth   = lw();
    ctx.lineCap = ctx.lineJoin = 'round';

    if (a.type === 'circle') {
      const rx = Math.abs(a.x2 - a.x1) / 2;
      const ry = Math.abs(a.y2 - a.y1) / 2;
      if (rx < 2 && ry < 2) { ctx.restore(); return; }
      ctx.beginPath();
      ctx.ellipse((a.x1+a.x2)/2, (a.y1+a.y2)/2, Math.max(rx,2), Math.max(ry,2), 0, 0, Math.PI*2);
      ctx.stroke();

    } else if (a.type === 'arrow') {
      const dx = a.x2 - a.x1, dy = a.y2 - a.y1;
      const len = Math.hypot(dx, dy);
      if (len < 4) { ctx.restore(); return; }
      const angle   = Math.atan2(dy, dx);
      const headLen = Math.max(lw() * 5, len * 0.28);
      ctx.beginPath();
      ctx.moveTo(a.x1, a.y1); ctx.lineTo(a.x2, a.y2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(a.x2, a.y2);
      ctx.lineTo(a.x2 - headLen * Math.cos(angle - Math.PI/6),
                 a.y2 - headLen * Math.sin(angle - Math.PI/6));
      ctx.moveTo(a.x2, a.y2);
      ctx.lineTo(a.x2 - headLen * Math.cos(angle + Math.PI/6),
                 a.y2 - headLen * Math.sin(angle + Math.PI/6));
      ctx.stroke();

    } else if (a.type === 'text') {
      const size = fs();
      ctx.font = `bold ${size}px -apple-system, Arial, sans-serif`;
      // Outline for contrast
      const outline = (a.color === '#fff' || a.color === '#FFD60A') ? '#000' : '#fff';
      ctx.lineWidth   = size * 0.1;
      ctx.strokeStyle = outline;
      ctx.strokeText(a.text, a.x, a.y);
      ctx.fillStyle = a.color;
      ctx.fillText(a.text, a.x, a.y);

    } else if (a.type === 'check') {
      // Bold green checkmark — click-to-place
      const s = fs() * 1.1;
      ctx.strokeStyle = '#30D158';
      ctx.lineWidth   = lw() * 2;
      ctx.lineCap = ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(a.x - s * 0.45, a.y);
      ctx.lineTo(a.x - s * 0.05, a.y + s * 0.38);
      ctx.lineTo(a.x + s * 0.55, a.y - s * 0.45);
      ctx.stroke();

    } else if (a.type === 'cross') {
      // Bold red X — click-to-place
      const s = fs() * 0.55;
      ctx.strokeStyle = '#FF3B30';
      ctx.lineWidth   = lw() * 2;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(a.x - s, a.y - s); ctx.lineTo(a.x + s, a.y + s);
      ctx.moveTo(a.x + s, a.y - s); ctx.lineTo(a.x - s, a.y + s);
      ctx.stroke();
    }
    ctx.restore();
  }

  // ── Canvas XY ─────────────────────────────────────────────
  function xy(e) {
    const r  = canvas.getBoundingClientRect();
    const cl = e.touches ? e.touches[0] : e;
    return {
      x: (cl.clientX - r.left) * (canvas.width  / r.width),
      y: (cl.clientY - r.top)  * (canvas.height / r.height)
    };
  }

  // ── Pointer events ────────────────────────────────────────
  canvas.addEventListener('mousedown',  pDown);
  canvas.addEventListener('mousemove',  pMove);
  canvas.addEventListener('mouseup',    pUp);
  canvas.addEventListener('touchstart', pDown, { passive: false });
  canvas.addEventListener('touchmove',  pMove, { passive: false });
  canvas.addEventListener('touchend',   pUp,   { passive: false });

  function pDown(e) {
    if (tool === 'text')  { showTextInput(xy(e), e); return; }
    if (tool === 'check') { e.preventDefault(); const p = xy(e); annotations.push({ type:'check', x:p.x, y:p.y, color:'#30D158' }); redraw(); return; }
    if (tool === 'cross') { e.preventDefault(); const p = xy(e); annotations.push({ type:'cross', x:p.x, y:p.y, color:'#FF3B30' }); redraw(); return; }
    e.preventDefault();
    const p = xy(e); sx = p.x; sy = p.y; drawing = true;
  }
  function pMove(e) {
    if (!drawing) return;
    e.preventDefault();
    const { x, y } = xy(e);
    temp = { type: tool, x1: sx, y1: sy, x2: x, y2: y, color };
    redraw();
  }
  function pUp(e) {
    if (!drawing) return;
    e.preventDefault();
    if (temp) { annotations.push(temp); temp = null; }
    drawing = false;
    redraw();
  }

  // ── Text input ────────────────────────────────────────────
  function showTextInput({ x, y }, e) {
    if (e) e.preventDefault();
    const r  = canvas.getBoundingClientRect();
    pendingTX = x; pendingTY = y;
    const screenX = r.left + x * (r.width  / canvas.width);
    const screenY = r.top  + y * (r.height / canvas.height);
    txtInp.style.display     = 'block';
    txtInp.style.left        = screenX + 'px';
    txtInp.style.top         = screenY + 'px';
    txtInp.style.color       = color;
    txtInp.style.borderColor = color;
    txtInp.style.border      = `2px solid ${color}`;
    txtInp.value = '';
    txtInp.focus();
  }

  txtInp.addEventListener('keydown', e => {
    if (e.key === 'Enter')  { e.preventDefault(); commitText(); }
    if (e.key === 'Escape') { txtInp.style.display = 'none'; }
  });
  txtInp.addEventListener('blur', commitText);

  function commitText() {
    const t = (txtInp.value || '').trim();
    if (t) {
      annotations.push({ type: 'text', x: pendingTX, y: pendingTY, text: t, color });
      redraw();
    }
    txtInp.style.display = 'none';
    txtInp.value = '';
  }

  // ── Global controls ───────────────────────────────────────
  window._annTool = t => {
    tool = t;
    document.querySelectorAll('#ann-bar .ann-btn[id^="ann-t-"]').forEach(b => b.classList.remove('ann-active'));
    const btn = document.getElementById(`ann-t-${t}`);
    if (btn) {
      btn.classList.add('ann-active');
      // Check/cross keep their signature colors even when active
      if (t === 'check') { btn.style.background = '#30D158'; btn.style.borderColor = '#30D158'; btn.style.color = '#fff'; }
      if (t === 'cross') { btn.style.background = '#FF3B30'; btn.style.borderColor = '#FF3B30'; btn.style.color = '#fff'; }
    }
    canvas.style.cursor = 'crosshair';
  };

  window._annColor = c => {
    color = c;
    document.querySelectorAll('.ann-color-dot').forEach(d =>
      d.classList.toggle('ann-color-sel', d.dataset.c === c)
    );
    txtInp.style.color = txtInp.style.borderColor = c;
  };

  window._annUndo = () => { annotations.pop(); redraw(); };

  window._annCancel = () => {
    overlay.remove(); cleanup();
    onCancel?.();
  };

  window._annSave = () => {
    commitText();
    setTimeout(() => {
      canvas.toBlob(blob => {
        overlay.remove(); cleanup();
        onSave?.(blob);
      }, 'image/jpeg', 0.92);
    }, 80); // small delay so commitText can finish
  };
}
