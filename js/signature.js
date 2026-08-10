// signature.js - simple full-screen signature pad (black ink, blank canvas), used for
// Risk Assessment sign-off. Shares the same coalesced-pointer-event approach as annotate.js
// for smooth, responsive Apple Pencil strokes.

function openSignaturePad(existingBlob, onSave) {
  const cw = 900, ch = 360; // fixed logical resolution, scaled to fit via CSS

  const view = el(`
    <div class="fullscreen" id="sig-view">
      <div class="annotate-toolbar">
        <button class="tool-btn" id="sig-undo" title="Undo">↺</button>
        <div class="spacer"></div>
        <span style="color:#fff; font-size:14px; font-weight:600;">Sign here</span>
        <div class="spacer"></div>
        <button class="tool-btn" id="sig-clear" title="Clear">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect x="3" y="12" width="14" height="8" rx="1.2" transform="rotate(-32 3 12)" fill="currentColor"/>
            <path d="M9.5 5.5 L19 15 L15 19 L5.5 9.5 Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
          </svg>
        </button>
      </div>
      <div class="annotate-canvas-wrap" id="sig-canvas-wrap" style="background:#fff;">
        <canvas id="sig-canvas" width="${cw}" height="${ch}" style="border:1px solid #ddd;"></canvas>
      </div>
      <div class="annotate-toolbar">
        <button class="btn btn-ghost" id="sig-cancel">Cancel</button>
        <div class="spacer"></div>
        <button class="btn btn-primary" id="sig-save">Save signature</button>
      </div>
    </div>
  `);
  presentOverlay(view);

  const canvas = view.querySelector('#sig-canvas');
  canvas.style.touchAction = 'none';
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, cw, ch);

  function fitCanvas() {
    const wrap = view.querySelector('#sig-canvas-wrap');
    const availW = wrap.clientWidth - 32;
    const availH = wrap.clientHeight - 32;
    const scale = Math.min(availW / cw, availH / ch, 1) || 1;
    canvas.style.width = Math.round(cw * scale) + 'px';
    canvas.style.height = Math.round(ch * scale) + 'px';
  }
  fitCanvas();
  window.addEventListener('resize', fitCanvas);

  if (existingBlob) {
    loadBitmapCorrected(existingBlob).then((img) => {
      ctx.drawImage(img, 0, 0, cw, ch);
      if (img.close) img.close();
    });
  }

  const undoStack = [];
  function pushUndo() {
    undoStack.push(ctx.getImageData(0, 0, cw, ch));
    if (undoStack.length > 20) undoStack.shift();
  }

  let drawing = false;
  let lastX = 0, lastY = 0;

  function canvasPoint(e) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = cw / rect.width;
    const scaleY = ch / rect.height;
    return { x: (e.clientX - rect.left) * scaleX, y: (e.clientY - rect.top) * scaleY };
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch' && e.isPrimary === false) return;
    canvas.setPointerCapture(e.pointerId);
    pushUndo();
    drawing = true;
    const p = canvasPoint(e);
    lastX = p.x; lastY = p.y;
    const pressure = e.pressure && e.pressure > 0 ? e.pressure : 0.5;
    ctx.fillStyle = '#1c1f26';
    ctx.beginPath();
    ctx.arc(p.x, p.y, (2 + pressure * 2) / 2, 0, Math.PI * 2);
    ctx.fill();
    e.preventDefault();
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    const events = (typeof e.getCoalescedEvents === 'function' && e.getCoalescedEvents().length) ? e.getCoalescedEvents() : [e];
    for (const ev of events) {
      const p = canvasPoint(ev);
      const pressure = ev.pressure && ev.pressure > 0 ? ev.pressure : 0.5;
      ctx.strokeStyle = '#1c1f26';
      ctx.lineWidth = 2 + pressure * 2;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(lastX, lastY);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      lastX = p.x; lastY = p.y;
    }
    e.preventDefault();
  });

  function endStroke(e) {
    if (!drawing) return;
    drawing = false;
    try { canvas.releasePointerCapture(e.pointerId); } catch (err) {}
  }
  canvas.addEventListener('pointerup', endStroke);
  canvas.addEventListener('pointercancel', endStroke);
  canvas.addEventListener('pointerleave', endStroke);

  view.querySelector('#sig-undo').addEventListener('click', () => {
    if (!undoStack.length) return;
    ctx.putImageData(undoStack.pop(), 0, 0);
  });
  view.querySelector('#sig-clear').addEventListener('click', () => {
    pushUndo();
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, cw, ch);
  });
  view.querySelector('#sig-cancel').addEventListener('click', () => {
    window.removeEventListener('resize', fitCanvas);
    view.remove();
  });
  view.querySelector('#sig-save').addEventListener('click', () => {
    canvas.toBlob(async (blob) => {
      window.removeEventListener('resize', fitCanvas);
      view.remove();
      if (onSave) onSave(blob);
    }, 'image/png');
  });
}
