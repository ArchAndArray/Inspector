// annotate.js - fullscreen photo markup using Canvas + Pointer Events (Apple Pencil Pro support)
//
// Uses two stacked canvases: a base layer holding the photo (drawn once, never touched
// again except on rotate) and a transparent overlay layer where all pencil strokes and
// erasing happen. The eraser uses 'destination-out' compositing on the overlay only, so it
// can never punch through to the photo underneath. The two layers are flattened into one
// image only at save time.
//
// Touch handling has three mutually-exclusive modes, tracked via a single `touches` map:
//   - One finger (ruler off): draws, owned by that finger's pointerId specifically — a
//     second finger touching down never contributes to that stroke (this was the bug: the
//     old code only checked "is a stroke in progress", not "is this the same finger").
//   - Two fingers (ruler off): pinch-to-zoom / two-finger pan, not drawing.
//   - Two fingers (ruler on): positions and rotates the ruler, as before.
// An Apple Pencil always draws, constrained to the ruler when it's active.
//
// Rotate bakes the rotation directly into both canvas layers' pixels (not stored as
// separate metadata), so saving afterwards persists the rotated result permanently — the
// same flatten-on-save mechanism that already merges the photo and annotation layers.

const ANNOTATE_COLORS = ['#c81e1e', '#f2b705', '#1c1f26', '#ffffff', '#1e7dc8'];
const ANNOTATE_WIDTHS = { thin: 3, medium: 7, thick: 14 };
const MAX_CANVAS_DIM = 2400; // cap resolution to keep memory/perf sane on large photos
const RULER_SNAP_DEGREES = [0, 45, 90, 135, 180, 225, 270, 315, 360];
const RULER_SNAP_THRESHOLD_DEG = 7;
const MAX_ZOOM = 4;

async function loadBitmapCorrected(blob) {
  try {
    return await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch (err) {
    const url = URL.createObjectURL(blob);
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = url;
    });
    URL.revokeObjectURL(url);
    return img;
  }
}

async function openAnnotator(photoId, onDone) {
  const photo = await DB.get('photos', photoId);
  if (!photo) return;
  const sourceBlob = photo.annotatedBlob || photo.originalBlob;
  const img = await loadBitmapCorrected(sourceBlob);
  const naturalW = img.width || img.naturalWidth;
  const naturalH = img.height || img.naturalHeight;

  let cw = naturalW, ch = naturalH;
  const longEdge0 = Math.max(cw, ch);
  if (longEdge0 > MAX_CANVAS_DIM) {
    const scale = MAX_CANVAS_DIM / longEdge0;
    cw = Math.round(cw * scale);
    ch = Math.round(ch * scale);
  }

  const view = el(`
    <div class="fullscreen" id="annotate-view">
      <div class="annotate-toolbar">
        <button class="tool-btn" id="btn-undo" title="Undo">↺</button>
        <button class="tool-btn" id="btn-rotate" title="Rotate">
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M4 12a8 8 0 1 1 2.6 5.9" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/>
            <path d="M4 17v-5h5" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
        <div class="spacer"></div>
        ${ANNOTATE_COLORS.map((c, i) => `<div class="color-dot ${i === 0 ? 'active' : ''}" data-color="${c}" style="background:${c};"></div>`).join('')}
        <div class="spacer"></div>
        <button class="tool-btn" id="w-thin" title="Thin">•</button>
        <button class="tool-btn active" id="w-medium" title="Medium">●</button>
        <button class="tool-btn" id="w-thick" title="Thick">⬤</button>
        <button class="tool-btn" id="btn-erase" title="Eraser">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect x="3" y="12" width="14" height="8" rx="1.2" transform="rotate(-32 3 12)" fill="currentColor"/>
            <path d="M9.5 5.5 L19 15 L15 19 L5.5 9.5 Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
          </svg>
        </button>
      </div>
      <div class="annotate-toolbar" id="ruler-toolbar" style="padding-top:0; padding-bottom:8px;">
        <button class="tool-btn" id="btn-ruler" title="Ruler">📏</button>
        <button class="tool-btn" id="btn-ruler-snap" title="Snap / Free rotation" style="display:none; width:auto; padding:0 12px; font-size:12px; font-weight:700;">Snap</button>
        <div class="spacer"></div>
        <span class="muted" id="ruler-hint" style="display:none; font-size:11.5px; color:#b8bcc4;">Two fingers: move &amp; rotate the ruler</span>
        <span class="muted" id="zoom-hint" style="font-size:11.5px; color:#b8bcc4;">Pinch to zoom</span>
      </div>
      <div class="annotate-canvas-wrap" id="canvas-wrap">
        <div id="canvas-stack" style="position:relative;">
          <canvas id="photo-canvas" width="${cw}" height="${ch}" style="display:block; width:100%; height:100%;"></canvas>
          <canvas id="mark-canvas" width="${cw}" height="${ch}" style="display:block; width:100%; height:100%; position:absolute; top:0; left:0;"></canvas>
          <div id="ruler-visual" style="display:none; position:absolute; width:72%; max-width:560px; height:5px; background:rgba(200,30,30,0.6); border-radius:3px; box-shadow:0 0 0 1.5px rgba(255,255,255,0.85); pointer-events:none;"></div>
        </div>
      </div>
      <div class="annotate-toolbar">
        <button class="btn btn-ghost" id="btn-cancel">Cancel</button>
        <div class="spacer"></div>
        <button class="btn btn-primary" id="btn-save">Save markup</button>
      </div>
    </div>
  `);
  presentOverlay(view);

  let photoCanvas = view.querySelector('#photo-canvas');
  let markCanvas = view.querySelector('#mark-canvas');
  const rulerVisual = view.querySelector('#ruler-visual');
  const stackEl = view.querySelector('#canvas-stack');
  markCanvas.style.touchAction = 'none';
  let photoCtx = photoCanvas.getContext('2d');
  let ctx = markCanvas.getContext('2d'); // all drawing/erasing happens here only

  photoCtx.drawImage(img, 0, 0, cw, ch);
  if (img.close) img.close();

  // ---- View transform (pinch-zoom / pan) ----
  let viewScale = 1, viewTx = 0, viewTy = 0;
  function applyViewTransform() {
    stackEl.style.transformOrigin = '0 0';
    stackEl.style.transform = `translate(${viewTx}px, ${viewTy}px) scale(${viewScale})`;
  }
  function resetViewTransform() {
    viewScale = 1; viewTx = 0; viewTy = 0;
    applyViewTransform();
  }

  // Fit the canvas stack to available space via CSS while preserving pixel resolution
  function fitCanvas() {
    const wrap = view.querySelector('#canvas-wrap');
    const availW = wrap.clientWidth - 16;
    const availH = wrap.clientHeight - 16;
    const scale = Math.min(availW / cw, availH / ch, 1) || 1;
    stackEl.style.width = Math.round(cw * scale) + 'px';
    stackEl.style.height = Math.round(ch * scale) + 'px';
  }
  fitCanvas();
  window.addEventListener('resize', fitCanvas);

  // Undo stack: snapshot of the annotation layer only, before each stroke. Cleared on
  // rotate since a rotation changes the canvas dimensions and old snapshots no longer fit.
  let undoStack = [];
  function pushUndo() {
    undoStack.push(ctx.getImageData(0, 0, cw, ch));
    if (undoStack.length > 20) undoStack.shift();
  }

  let currentColor = ANNOTATE_COLORS[0];
  let currentWidth = ANNOTATE_WIDTHS.medium;
  let eraseMode = false;

  view.querySelectorAll('.color-dot').forEach((dot) => {
    dot.addEventListener('click', () => {
      currentColor = dot.dataset.color;
      eraseMode = false;
      view.querySelectorAll('.color-dot').forEach((d) => d.classList.remove('active'));
      dot.classList.add('active');
      view.querySelector('#btn-erase').classList.remove('active');
    });
  });

  function setWidth(key, btnId) {
    currentWidth = ANNOTATE_WIDTHS[key];
    view.querySelectorAll('#w-thin,#w-medium,#w-thick').forEach((b) => b.classList.remove('active'));
    view.querySelector(btnId).classList.add('active');
  }
  view.querySelector('#w-thin').addEventListener('click', () => setWidth('thin', '#w-thin'));
  view.querySelector('#w-medium').addEventListener('click', () => setWidth('medium', '#w-medium'));
  view.querySelector('#w-thick').addEventListener('click', () => setWidth('thick', '#w-thick'));

  view.querySelector('#btn-erase').addEventListener('click', (e) => {
    eraseMode = !eraseMode;
    e.currentTarget.classList.toggle('active', eraseMode);
  });

  view.querySelector('#btn-undo').addEventListener('click', () => {
    if (!undoStack.length) return;
    ctx.putImageData(undoStack.pop(), 0, 0);
  });

  // ---- Rotate (bakes 90° rotation into both layers' actual pixels) ----
  view.querySelector('#btn-rotate').addEventListener('click', () => {
    const newCw = ch, newCh = cw;

    const rotatedPhoto = document.createElement('canvas');
    rotatedPhoto.width = newCw; rotatedPhoto.height = newCh;
    const rpCtx = rotatedPhoto.getContext('2d');
    rpCtx.translate(newCw / 2, newCh / 2);
    rpCtx.rotate(Math.PI / 2);
    rpCtx.drawImage(photoCanvas, -cw / 2, -ch / 2);

    const rotatedMark = document.createElement('canvas');
    rotatedMark.width = newCw; rotatedMark.height = newCh;
    const rmCtx = rotatedMark.getContext('2d');
    rmCtx.translate(newCw / 2, newCh / 2);
    rmCtx.rotate(Math.PI / 2);
    rmCtx.drawImage(markCanvas, -cw / 2, -ch / 2);

    cw = newCw; ch = newCh;
    photoCanvas.width = cw; photoCanvas.height = ch;
    markCanvas.width = cw; markCanvas.height = ch;
    photoCtx.drawImage(rotatedPhoto, 0, 0);
    ctx.drawImage(rotatedMark, 0, 0);

    undoStack = [];
    ruler.cx = cw / 2; ruler.cy = ch / 2;
    resetViewTransform();
    fitCanvas();
    updateRulerVisual();
  });

  // ---- Ruler ----
  let rulerEnabled = false;
  let rulerSnap = true;
  const ruler = { cx: cw / 2, cy: ch / 2, angle: 0 };

  function snapAngleIfNeeded(angle) {
    if (!rulerSnap) return angle;
    const deg = ((angle * 180) / Math.PI + 360) % 360;
    let closest = null, minDiff = Infinity;
    for (const s of RULER_SNAP_DEGREES) {
      const diff = Math.abs(deg - s);
      if (diff < minDiff) { minDiff = diff; closest = s % 360; }
    }
    return minDiff <= RULER_SNAP_THRESHOLD_DEG ? (closest * Math.PI) / 180 : angle;
  }

  function updateRulerVisual() {
    rulerVisual.style.display = rulerEnabled ? 'block' : 'none';
    if (!rulerEnabled) return;
    const leftPct = (ruler.cx / cw) * 100;
    const topPct = (ruler.cy / ch) * 100;
    const deg = (ruler.angle * 180) / Math.PI;
    rulerVisual.style.left = leftPct + '%';
    rulerVisual.style.top = topPct + '%';
    rulerVisual.style.transform = `translate(-50%, -50%) rotate(${deg}deg)`;
  }

  function projectOntoRuler(pt) {
    if (!rulerEnabled) return pt;
    const dx = Math.cos(ruler.angle), dy = Math.sin(ruler.angle);
    const relX = pt.x - ruler.cx, relY = pt.y - ruler.cy;
    const t = relX * dx + relY * dy;
    return { x: ruler.cx + t * dx, y: ruler.cy + t * dy };
  }

  view.querySelector('#btn-ruler').addEventListener('click', (e) => {
    rulerEnabled = !rulerEnabled;
    e.currentTarget.classList.toggle('active', rulerEnabled);
    view.querySelector('#btn-ruler-snap').style.display = rulerEnabled ? '' : 'none';
    view.querySelector('#ruler-hint').style.display = rulerEnabled ? '' : 'none';
    view.querySelector('#zoom-hint').style.display = rulerEnabled ? 'none' : '';
    touches.clear();
    pinchState = null;
    updateRulerVisual();
  });
  view.querySelector('#btn-ruler-snap').addEventListener('click', (e) => {
    rulerSnap = !rulerSnap;
    e.currentTarget.textContent = rulerSnap ? 'Snap' : 'Free';
    e.currentTarget.classList.toggle('active', rulerSnap);
  });

  function canvasPoint(e) {
    const rect = markCanvas.getBoundingClientRect();
    const scaleX = cw / rect.width;
    const scaleY = ch / rect.height;
    return { x: (e.clientX - rect.left) * scaleX, y: (e.clientY - rect.top) * scaleY };
  }

  function updateRulerFromTouches() {
    const pts = Array.from(touches.values());
    if (pts.length < 2) return;
    const [a, b] = pts;
    ruler.cx = (a.x + b.x) / 2;
    ruler.cy = (a.y + b.y) / 2;
    ruler.angle = snapAngleIfNeeded(Math.atan2(b.y - a.y, b.x - a.x));
    updateRulerVisual();
  }

  // ---- Pinch-to-zoom / two-finger pan (only when the ruler is off) ----
  let pinchState = null;
  function updatePinch() {
    const pts = Array.from(touches.values());
    if (pts.length < 2) { pinchState = null; return; }
    const [a, b] = pts;
    const dist = Math.hypot(b.cx - a.cx, b.cy - a.cy);
    const mid = { x: (a.cx + b.cx) / 2, y: (a.cy + b.cy) / 2 };
    if (!pinchState) {
      pinchState = { startDist: dist, startScale: viewScale, startMid: mid, startTx: viewTx, startTy: viewTy };
      return;
    }
    const scaleFactor = pinchState.startDist > 0 ? dist / pinchState.startDist : 1;
    viewScale = Math.min(MAX_ZOOM, Math.max(1, pinchState.startScale * scaleFactor));
    viewTx = pinchState.startTx + (mid.x - pinchState.startMid.x);
    viewTy = pinchState.startTy + (mid.y - pinchState.startMid.y);
    applyViewTransform();
  }

  // ---- Drawing (pen always; a single finger when the ruler is off) ----
  // `drawingPointerId` fixes the original bug: strokes were continued by ANY active touch's
  // movement, not just the finger that started them, so a second finger drew a line across
  // to wherever it landed. Now only the owning pointerId can extend the current stroke.
  let drawing = false;
  let drawingPointerId = null;
  let lastX = 0, lastY = 0;

  function isDrawingPointer(e) {
    if (e.pointerType === 'pen') return true;
    if (e.pointerType === 'touch') return false; // touch handled explicitly by touch count below
    return true; // mouse, for desktop testing
  }

  function startStroke(e) {
    try { markCanvas.setPointerCapture(e.pointerId); } catch (err) {}
    pushUndo();
    drawing = true;
    drawingPointerId = e.pointerId;
    const p = projectOntoRuler(canvasPoint(e));
    lastX = p.x; lastY = p.y;
    const pressure = e.pressure && e.pressure > 0 ? e.pressure : 0.5;
    const w = eraseMode ? currentWidth * 3 : currentWidth * (0.5 + pressure);
    ctx.globalCompositeOperation = eraseMode ? 'destination-out' : 'source-over';
    ctx.fillStyle = currentColor;
    ctx.beginPath();
    ctx.arc(p.x, p.y, w / 2, 0, Math.PI * 2);
    ctx.fill();
  }

  function continueStroke(e) {
    const events = (typeof e.getCoalescedEvents === 'function' && e.getCoalescedEvents().length) ? e.getCoalescedEvents() : [e];
    for (const ev of events) {
      const p = projectOntoRuler(canvasPoint(ev));
      const pressure = ev.pressure && ev.pressure > 0 ? ev.pressure : 0.5;
      const w = eraseMode ? currentWidth * 3 : currentWidth * (0.5 + pressure);
      ctx.globalCompositeOperation = eraseMode ? 'destination-out' : 'source-over';
      ctx.strokeStyle = currentColor;
      ctx.lineWidth = w;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(lastX, lastY);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      lastX = p.x; lastY = p.y;
    }
  }

  // pointerId -> {cx, cy, x, y} — cx/cy are raw client coords (for pinch math, unaffected
  // by our own zoom transform), x/y are canvas-pixel coords (for ruler/drawing math).
  const touches = new Map();

  markCanvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch') {
      const p = canvasPoint(e);
      touches.set(e.pointerId, { cx: e.clientX, cy: e.clientY, x: p.x, y: p.y });

      if (touches.size >= 2) {
        if (rulerEnabled) {
          updateRulerFromTouches();
        } else {
          if (drawing) { drawing = false; drawingPointerId = null; }
          updatePinch();
        }
        e.preventDefault();
        return;
      }
      // Exactly one touch so far.
      if (rulerEnabled) { e.preventDefault(); return; } // waiting for a second finger
      startStroke(e);
      e.preventDefault();
      return;
    }
    if (!isDrawingPointer(e)) return;
    startStroke(e);
  });

  markCanvas.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch' && touches.has(e.pointerId)) {
      const p = canvasPoint(e);
      touches.set(e.pointerId, { cx: e.clientX, cy: e.clientY, x: p.x, y: p.y });
      if (touches.size >= 2) {
        if (rulerEnabled) updateRulerFromTouches();
        else updatePinch();
        e.preventDefault();
        return;
      }
      // Single touch: only continue if this exact finger owns the current stroke.
      if (drawing && e.pointerId === drawingPointerId) {
        continueStroke(e);
      }
      e.preventDefault();
      return;
    }
    if (!drawing || e.pointerId !== drawingPointerId) return;
    continueStroke(e);
    e.preventDefault();
  });

  function endStroke(e) {
    if (e.pointerType === 'touch') {
      touches.delete(e.pointerId);
      if (touches.size < 2) pinchState = null;
    }
    if (e.pointerId !== drawingPointerId) return;
    drawing = false;
    drawingPointerId = null;
    try { markCanvas.releasePointerCapture(e.pointerId); } catch (err) {}
  }
  markCanvas.addEventListener('pointerup', endStroke);
  markCanvas.addEventListener('pointercancel', endStroke);
  markCanvas.addEventListener('pointerleave', endStroke);

  view.querySelector('#btn-cancel').addEventListener('click', () => {
    window.removeEventListener('resize', fitCanvas);
    view.remove();
  });

  view.querySelector('#btn-save').addEventListener('click', () => {
    // Flatten photo + annotation layers into a single image for storage/export. Any
    // rotation applied during this session is already baked into both layers' pixels, so
    // it's persisted automatically as part of this same save — no separate metadata needed.
    const mergeCanvas = document.createElement('canvas');
    mergeCanvas.width = cw;
    mergeCanvas.height = ch;
    const mergeCtx = mergeCanvas.getContext('2d');
    mergeCtx.drawImage(photoCanvas, 0, 0);
    mergeCtx.drawImage(markCanvas, 0, 0);
    mergeCanvas.toBlob(async (blob) => {
      await DB.setAnnotatedBlob(photoId, blob);
      window.removeEventListener('resize', fitCanvas);
      view.remove();
      if (onDone) onDone();
    }, 'image/jpeg', 0.92);
  });
}
