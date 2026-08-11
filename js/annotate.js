// annotate.js - fullscreen photo markup using Canvas + Pointer Events (Apple Pencil Pro support)
//
// Two stacked canvases: a base photo layer (drawn once, only re-drawn on rotate) and a
// transparent overlay layer where all pencil strokes and erasing happen — keeping them
// separate is what lets the eraser remove marks without ever touching the photo. Flattened
// into one image only at save time.
//
// Four mutually-exclusive interaction modes (Ruler, Measure, Text, Calibrate) share the
// same touch bookkeeping: one finger (or a Pencil) acts on whichever mode is active, two
// fingers always pinch-zoom/pan except when the Ruler is on (then two fingers move+rotate
// it instead). `deactivateOtherModes()` keeps only one of the four active at a time.
//
// Calibration stores {pixelsPerUnit, unit} on the photo record. Distances are computed in
// canvas-pixel space, which stays valid across rotation (a rigid transform preserves
// distances) and across save/reload (the working canvas size is stable).

const ANNOTATE_COLORS = ['#c81e1e', '#f2b705', '#1c1f26', '#ffffff', '#1e7dc8'];
const ANNOTATE_WIDTHS = { thin: 3, medium: 7, thick: 14 };
const MAX_CANVAS_DIM = 2400;
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

// "Nice" round step for tick spacing (1/2/5 × a power of ten), given a raw target step.
function niceRulerStep(raw) {
  if (!(raw > 0)) return 1;
  const pow10 = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / pow10;
  let niceNorm;
  if (norm < 1.5) niceNorm = 1;
  else if (norm < 3.5) niceNorm = 2;
  else if (norm < 7.5) niceNorm = 5;
  else niceNorm = 10;
  return niceNorm * pow10;
}

// Thousands separator for any readout number (ruler ticks, measure distances).
function formatWithCommas(value) {
  const parts = String(value).split('.');
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return parts.join('.');
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

  let calibration = photo.calibration || null; // {pixelsPerUnit, unit}

  const view = el(`
    <div class="fullscreen" id="annotate-view">
      <div class="annotate-toolbar" id="main-toolbar">
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
        <button class="tool-btn" id="btn-measure" title="Measure">
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <line x1="3" y1="12" x2="21" y2="12" stroke="currentColor" stroke-width="2"/>
            <path d="M3 12 L8 8 M3 12 L8 16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M21 12 L16 8 M21 12 L16 16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
        <button class="tool-btn" id="btn-text-tool" title="Text">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect x="2" y="4" width="20" height="16" rx="2" stroke="currentColor" stroke-width="1.6" fill="none"/>
            <path d="M7 9h10M7 13h6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
          </svg>
        </button>
        <button class="tool-btn" id="btn-calibrate" title="Calibrate" style="width:auto; padding:0 12px; font-size:12px; font-weight:700;">Calibrate</button>
        <div class="spacer"></div>
        <span class="muted" id="ruler-angle-readout" style="display:none; font-size:13px; font-weight:700; color:#fff;">0°</span>
        <span class="muted" id="ruler-hint" style="display:none; font-size:11.5px; color:#b8bcc4;">Two fingers: move &amp; rotate · pull the dot to resize</span>
        <span class="muted" id="zoom-hint" style="font-size:11.5px; color:#b8bcc4;">Pinch to zoom</span>
      </div>
      <div class="annotate-toolbar" id="cal-toolbar" style="display:none; padding-top:0; padding-bottom:8px;">
        <span id="cal-instruction" style="color:#fff; font-size:13px; font-weight:600; flex:1;"></span>
        <button class="tool-btn" id="btn-cal-reset" title="Reset">↺</button>
        <button class="tool-btn" id="btn-cal-accept" title="Accept" style="display:none; background:var(--sev-1);">✓</button>
        <button class="tool-btn" id="btn-cal-cancel" title="Cancel calibration">✕</button>
      </div>
      <div class="annotate-canvas-wrap" id="canvas-wrap">
        <div id="canvas-stack" style="position:relative;">
          <canvas id="photo-canvas" width="${cw}" height="${ch}" style="display:block; width:100%; height:100%;"></canvas>
          <canvas id="mark-canvas" width="${cw}" height="${ch}" style="display:block; width:100%; height:100%; position:absolute; top:0; left:0;"></canvas>
          <canvas id="preview-canvas" width="${cw}" height="${ch}" style="display:block; width:100%; height:100%; position:absolute; top:0; left:0; pointer-events:none;"></canvas>
          <svg id="cal-line-svg" width="100%" height="100%" viewBox="0 0 ${cw} ${ch}" style="display:none; position:absolute; top:0; left:0; pointer-events:none; z-index:5;" preserveAspectRatio="none">
            <line id="cal-line" x1="0" y1="0" x2="0" y2="0" stroke="#e0a72e" stroke-width="3" stroke-dasharray="10,7"/>
          </svg>
          <div id="ruler-visual" style="display:none; position:absolute; opacity:0.5; pointer-events:none;"></div>
          <div id="ruler-handle" style="display:none; position:absolute; width:26px; height:26px; margin:-13px; border-radius:50%; background:#c81e1e; border:2.5px solid #fff; box-shadow:0 0 0 1px rgba(0,0,0,0.35); touch-action:none; z-index:7;"></div>
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

  const photoCanvas = view.querySelector('#photo-canvas');
  const markCanvas = view.querySelector('#mark-canvas');
  const previewCanvas = view.querySelector('#preview-canvas');
  const previewCtx = previewCanvas.getContext('2d');
  const rulerVisual = view.querySelector('#ruler-visual');
  const rulerHandle = view.querySelector('#ruler-handle');
  const stackEl = view.querySelector('#canvas-stack');
  markCanvas.style.touchAction = 'none';
  const photoCtx = photoCanvas.getContext('2d');
  const ctx = markCanvas.getContext('2d');

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
    previewCanvas.width = cw; previewCanvas.height = ch;
    view.querySelector('#cal-line-svg').setAttribute('viewBox', `0 0 ${cw} ${ch}`);
    photoCtx.drawImage(rotatedPhoto, 0, 0);
    ctx.drawImage(rotatedMark, 0, 0);

    undoStack = [];
    ruler.cx = cw / 2; ruler.cy = ch / 2;
    resetViewTransform();
    fitCanvas();
    updateRulerVisual();
    updateRulerHandle();
  });

  // ---- Ruler: looks like a real ruler (ticks + numbers), the pen/eraser are constrained
  // to its top edge (not its centerline), shown at 50% opacity, its numbers reflect
  // real-world units once calibrated, its length can be pulled longer/shorter via the end
  // handle, and its angle is normalized so it never renders upside-down regardless of which
  // finger the OS reports first in a two-finger gesture. ----
  let rulerEnabled = false;
  let rulerSnap = true;
  const ruler = { cx: cw / 2, cy: ch / 2, angle: 0 };
  let rulerLength = Math.min(cw, ch) * 0.55;
  const RULER_MIN_LENGTH = 60;
  const RULER_MAX_LENGTH = Math.max(cw, ch) * 1.6;

  function normalizeRulerAngle(angle) {
    // Keep within (-90°, 90°] so the ruler renders the same way regardless of which finger
    // the OS happened to report as "first" — a line has no inherent direction, but the
    // ruler's visual (ticks/numbers on one side) does, so without this it can flip 180°
    // and appear upside-down when you re-place your fingers.
    let deg = (angle * 180) / Math.PI;
    while (deg <= -90) deg += 180;
    while (deg > 90) deg -= 180;
    return (deg * Math.PI) / 180;
  }

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

  function rulerTicks() {
    const ticks = [];
    if (calibration && calibration.pixelsPerUnit > 0) {
      const totalUnits = rulerLength / calibration.pixelsPerUnit;
      const step = niceRulerStep(totalUnits / 8);
      for (let v = 0; v <= totalUnits + 1e-6; v += step) {
        ticks.push({ frac: (v * calibration.pixelsPerUnit) / rulerLength, label: formatWithCommas(Math.round(v * 100) / 100) });
      }
    } else {
      const step = niceRulerStep(rulerLength / 8);
      for (let v = 0; v <= rulerLength + 1e-6; v += step) {
        ticks.push({ frac: v / rulerLength, label: formatWithCommas(Math.round(v)) });
      }
    }
    return ticks;
  }

  function buildRulerSVG() {
    const W = 600, H = 70, edgeY = 6, tickLen = 18;
    const ticks = rulerTicks();
    let svg = `<svg width="100%" height="100%" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="display:block; overflow:visible;">`;
    svg += `<rect x="0" y="0" width="${W}" height="${H}" fill="#ffffff" stroke="#1c1f26" stroke-width="1"/>`;
    svg += `<line x1="0" y1="${edgeY}" x2="${W}" y2="${edgeY}" stroke="#c81e1e" stroke-width="2.5"/>`;
    ticks.forEach((t) => {
      const x = Math.max(1, Math.min(W - 1, t.frac * W));
      svg += `<line x1="${x}" y1="${edgeY}" x2="${x}" y2="${edgeY + tickLen}" stroke="#1c1f26" stroke-width="1.5"/>`;
      svg += `<text x="${x}" y="${edgeY + tickLen + 15}" font-size="12" fill="#1c1f26" text-anchor="middle" font-family="-apple-system,sans-serif">${t.label}</text>`;
    });
    if (calibration) {
      svg += `<text x="${W - 6}" y="${H - 6}" font-size="11" fill="#4a4f5a" text-anchor="end" font-family="-apple-system,sans-serif">${calibration.unit}</text>`;
    }
    svg += `</svg>`;
    return svg;
  }

  function updateRulerVisual() {
    rulerVisual.style.display = rulerEnabled ? 'block' : 'none';
    view.querySelector('#ruler-angle-readout').style.display = rulerEnabled ? '' : 'none';
    if (!rulerEnabled) return;
    const leftPct = (ruler.cx / cw) * 100;
    const topPct = (ruler.cy / ch) * 100;
    const deg = (ruler.angle * 180) / Math.PI;
    const widthPct = (rulerLength / cw) * 100;
    const heightPct = ((rulerLength * 0.11) / ch) * 100;
    rulerVisual.style.left = leftPct + '%';
    rulerVisual.style.top = topPct + '%';
    rulerVisual.style.width = widthPct + '%';
    rulerVisual.style.height = heightPct + '%';
    rulerVisual.style.transformOrigin = '50% 0%';
    rulerVisual.style.transform = `translate(-50%, 0%) rotate(${deg}deg)`;
    rulerVisual.innerHTML = buildRulerSVG();
    view.querySelector('#ruler-angle-readout').textContent = Math.round(deg) + '°';
  }

  function rulerEndPoint() {
    return { x: ruler.cx + (rulerLength / 2) * Math.cos(ruler.angle), y: ruler.cy + (rulerLength / 2) * Math.sin(ruler.angle) };
  }
  function updateRulerHandle() {
    if (!rulerEnabled) { rulerHandle.style.display = 'none'; return; }
    rulerHandle.style.display = 'block';
    const end = rulerEndPoint();
    rulerHandle.style.left = (end.x / cw) * 100 + '%';
    rulerHandle.style.top = (end.y / ch) * 100 + '%';
  }

  let handleDragPointerId = null;
  rulerHandle.addEventListener('pointerdown', (e) => {
    handleDragPointerId = e.pointerId;
    try { rulerHandle.setPointerCapture(e.pointerId); } catch (err) {}
    e.preventDefault();
    e.stopPropagation();
  });
  rulerHandle.addEventListener('pointermove', (e) => {
    if (e.pointerId !== handleDragPointerId) return;
    const p = canvasPoint(e);
    const dist = Math.hypot(p.x - ruler.cx, p.y - ruler.cy);
    rulerLength = Math.min(RULER_MAX_LENGTH, Math.max(RULER_MIN_LENGTH, dist * 2));
    updateRulerVisual();
    updateRulerHandle();
    e.preventDefault();
    e.stopPropagation();
  });
  function endHandleDrag(e) {
    if (e.pointerId !== handleDragPointerId) return;
    handleDragPointerId = null;
    try { rulerHandle.releasePointerCapture(e.pointerId); } catch (err) {}
  }
  rulerHandle.addEventListener('pointerup', endHandleDrag);
  rulerHandle.addEventListener('pointercancel', endHandleDrag);

  function projectOntoRuler(pt) {
    if (!rulerEnabled) return pt;
    const dx = Math.cos(ruler.angle), dy = Math.sin(ruler.angle);
    const relX = pt.x - ruler.cx, relY = pt.y - ruler.cy;
    const t = relX * dx + relY * dy;
    return { x: ruler.cx + t * dx, y: ruler.cy + t * dy };
  }

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
    ruler.angle = normalizeRulerAngle(snapAngleIfNeeded(Math.atan2(b.y - a.y, b.x - a.x)));
    updateRulerVisual();
    updateRulerHandle();
  }

  // ---- Pinch-to-zoom / two-finger pan ----
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

  // ---- Shared: switch between Ruler / Measure / Text / Calibrate, only one active at a time ----
  function deactivateOtherModes(except) {
    if (except !== 'ruler' && rulerEnabled) {
      rulerEnabled = false;
      view.querySelector('#btn-ruler').classList.remove('active');
      view.querySelector('#btn-ruler-snap').style.display = 'none';
      updateRulerVisual();
      updateRulerHandle();
    }
    if (except !== 'measure' && measureMode) {
      measureMode = false;
      view.querySelector('#btn-measure').classList.remove('active');
      measureStart = null;
    }
    if (except !== 'text' && textMode) {
      textMode = false;
      view.querySelector('#btn-text-tool').classList.remove('active');
      textPressPoint = null;
    }
    view.querySelector('#ruler-hint').style.display = except === 'ruler' ? '' : 'none';
    view.querySelector('#zoom-hint').style.display = except === 'ruler' ? 'none' : '';
    touches.clear();
    pinchState = null;
    clearPreview();
  }

  view.querySelector('#btn-ruler').addEventListener('click', (e) => {
    rulerEnabled = !rulerEnabled;
    if (rulerEnabled) {
      deactivateOtherModes('ruler');
      e.currentTarget.classList.add('active');
      view.querySelector('#btn-ruler-snap').style.display = '';
    } else {
      e.currentTarget.classList.remove('active');
      view.querySelector('#btn-ruler-snap').style.display = 'none';
      view.querySelector('#ruler-hint').style.display = 'none';
      view.querySelector('#zoom-hint').style.display = '';
    }
    touches.clear();
    pinchState = null;
    updateRulerVisual();
    updateRulerHandle();
  });
  view.querySelector('#btn-ruler-snap').addEventListener('click', (e) => {
    rulerSnap = !rulerSnap;
    e.currentTarget.textContent = rulerSnap ? 'Snap' : 'Free';
    e.currentTarget.classList.toggle('active', rulerSnap);
  });

  // ---- Calibration ----
  let calibrating = false;
  let calStep = 0;
  let calPending = null;
  let calPoint1 = null;
  let calPoint2 = null;

  function targetMarkerSVG(color, size) {
    const c = size / 2;
    return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
      <circle cx="${c}" cy="${c}" r="${size * 0.32}" fill="none" stroke="${color}" stroke-width="2.5"/>
      <line x1="${c}" y1="2" x2="${c}" y2="${size * 0.28}" stroke="${color}" stroke-width="2"/>
      <line x1="${c}" y1="${size - 2}" x2="${c}" y2="${size * 0.72}" stroke="${color}" stroke-width="2"/>
      <line x1="2" y1="${c}" x2="${size * 0.28}" y2="${c}" stroke="${color}" stroke-width="2"/>
      <line x1="${size - 2}" y1="${c}" x2="${size * 0.72}" y2="${c}" stroke="${color}" stroke-width="2"/>
    </svg>`;
  }

  function renderCalMarkers() {
    view.querySelectorAll('.cal-marker').forEach((m) => m.remove());
    const size = 34;
    function addTarget(pt, color) {
      if (!pt) return;
      const m = document.createElement('div');
      m.className = 'cal-marker';
      m.style.cssText = `position:absolute; left:${(pt.x / cw) * 100}%; top:${(pt.y / ch) * 100}%; transform:translate(-50%,-50%); pointer-events:none; z-index:6;`;
      m.innerHTML = targetMarkerSVG(color, size);
      stackEl.appendChild(m);
    }
    const p2 = calPoint2 || (calStep === 1 ? calPending : null);

    const lineSvg = view.querySelector('#cal-line-svg');
    const lineEl = view.querySelector('#cal-line');
    if (calPoint1 && p2) {
      lineSvg.style.display = 'block';
      lineEl.setAttribute('x1', calPoint1.x); lineEl.setAttribute('y1', calPoint1.y);
      lineEl.setAttribute('x2', p2.x); lineEl.setAttribute('y2', p2.y);
    } else {
      lineSvg.style.display = 'none';
    }

    addTarget(calPoint1, '#4f9d5c');
    addTarget(p2, calPoint2 ? '#4f9d5c' : '#e0a72e');
  }

  function updateCalToolbar() {
    const instr = view.querySelector('#cal-instruction');
    const acceptBtn = view.querySelector('#btn-cal-accept');
    if (calStep === 0) instr.textContent = calPending ? 'Tap to fine-tune, then Accept' : 'Tap the first point';
    else instr.textContent = calPending ? 'Tap to fine-tune, then Accept' : 'Pinch/pan to find it, then tap the second point';
    acceptBtn.style.display = calPending ? '' : 'none';
  }

  function enterCalibrationMode() {
    calibrating = true;
    calStep = 0; calPending = null; calPoint1 = null; calPoint2 = null;
    deactivateOtherModes(null);
    view.querySelector('#main-toolbar').style.display = 'none';
    view.querySelector('#ruler-toolbar').style.display = 'none';
    const calToolbar = view.querySelector('#cal-toolbar');
    calToolbar.style.display = '';
    // This row normally sits below the main toolbar (which already reserves safe-area
    // space) so it skips its own top padding — but calibration hides that row, making this
    // one the topmost, so it needs that clearance itself or its buttons land under the
    // iPad's status bar.
    calToolbar.style.paddingTop = 'calc(10px + var(--safe-top))';
    updateCalToolbar();
    renderCalMarkers();
  }
  function exitCalibrationMode() {
    calibrating = false;
    calPending = null; calPoint1 = null; calPoint2 = null;
    view.querySelector('#main-toolbar').style.display = '';
    view.querySelector('#ruler-toolbar').style.display = '';
    view.querySelector('#cal-toolbar').style.display = 'none';
    view.querySelector('#cal-toolbar').style.paddingTop = '0';
    renderCalMarkers();
  }
  view.querySelector('#btn-calibrate').addEventListener('click', () => {
    if (calibrating) exitCalibrationMode(); else enterCalibrationMode();
  });
  view.querySelector('#btn-cal-reset').addEventListener('click', () => {
    calPending = null;
    renderCalMarkers();
    updateCalToolbar();
  });
  view.querySelector('#btn-cal-cancel').addEventListener('click', exitCalibrationMode);
  view.querySelector('#btn-cal-accept').addEventListener('click', () => {
    if (!calPending) return;
    if (calStep === 0) {
      calPoint1 = calPending; calPending = null; calStep = 1;
      renderCalMarkers();
      updateCalToolbar();
    } else {
      calPoint2 = calPending; calPending = null;
      openCalibrationDistancePrompt();
    }
  });

  function openCalibrationDistancePrompt() {
    const pixelDist = Math.hypot(calPoint2.x - calPoint1.x, calPoint2.y - calPoint1.y);
    const sheet = el(`
      <div class="sheet-backdrop">
        <div class="sheet">
          <div class="sheet-handle"></div>
          <h2>Set real-world distance</h2>
          <p class="muted" style="font-size:13px; margin-top:-8px;">Distance between the two points you picked.</p>
          <div class="row-2">
            <div class="field"><label>Distance</label><input type="text" id="f-dist" inputmode="decimal" placeholder="e.g. 500"></div>
            <div class="field">
              <label>Unit</label>
              <select id="f-unit">
                <option value="mm">mm</option>
                <option value="m">m</option>
                <option value="cm">cm</option>
                <option value="in">in</option>
                <option value="ft">ft</option>
              </select>
            </div>
          </div>
          <button class="btn btn-primary btn-block" id="btn-save-cal">Save calibration</button>
          <button class="btn btn-ghost btn-block" id="btn-cancel-cal">Cancel</button>
        </div>
      </div>
    `);
    presentOverlay(sheet);
    sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.remove(); });
    sheet.querySelector('#btn-cancel-cal').addEventListener('click', () => { sheet.remove(); exitCalibrationMode(); });
    sheet.querySelector('#btn-save-cal').addEventListener('click', async () => {
      const val = parseFloat(sheet.querySelector('#f-dist').value);
      if (!val || val <= 0) { toast('Enter a valid distance'); return; }
      const unit = sheet.querySelector('#f-unit').value;
      calibration = { pixelsPerUnit: pixelDist / val, unit };
      await DB.updatePhoto(photoId, { calibration });
      sheet.remove();
      exitCalibrationMode();
      updateRulerVisual();
      toast('Calibration saved');
    });
  }

  // ---- Shared arrow drawing helper (used by Measure and the Text tool's leader) ----
  function drawArrowheadOn(targetCtx, fromX, fromY, toX, toY, size) {
    const angle = Math.atan2(toY - fromY, toX - fromX);
    targetCtx.beginPath();
    targetCtx.moveTo(toX, toY);
    targetCtx.lineTo(toX - size * Math.cos(angle - Math.PI / 7), toY - size * Math.sin(angle - Math.PI / 7));
    targetCtx.lineTo(toX - size * Math.cos(angle + Math.PI / 7), toY - size * Math.sin(angle + Math.PI / 7));
    targetCtx.closePath();
    targetCtx.fill();
  }

  function clearPreview() { previewCtx.clearRect(0, 0, cw, ch); }

  function measureArrowSizing() {
    // Scale relative to the image's own resolution so arrowheads stay clearly visible
    // regardless of how large the source photo is, instead of a fixed small pixel count.
    const ref = Math.min(cw, ch);
    return { headSize: Math.max(20, ref * 0.028), lineWidth: Math.max(3, ref * 0.005, currentWidth) };
  }

  // ---- Measure: drag to draw a double-ended arrow, labeled with the distance ----
  let measureMode = false;
  let measureStart = null;
  let measurePointerId = null;

  function formatDistance(pixelDist) {
    if (calibration && calibration.pixelsPerUnit > 0) {
      const val = pixelDist / calibration.pixelsPerUnit;
      return `${formatWithCommas(Math.round(val * 100) / 100)} ${calibration.unit}`;
    }
    return `${formatWithCommas(Math.round(pixelDist))} px`;
  }

  function drawLabelOn(targetCtx, midX, midY, label, fontSize) {
    fontSize = fontSize || 28;
    targetCtx.font = `${fontSize}px -apple-system, sans-serif`;
    targetCtx.textAlign = 'center';
    targetCtx.textBaseline = 'middle';
    const textW = targetCtx.measureText(label).width;
    const padX = 10, padY = 6;
    targetCtx.fillStyle = 'rgba(255,255,255,0.85)';
    targetCtx.fillRect(midX - textW / 2 - padX, midY - fontSize / 2 - padY, textW + padX * 2, fontSize + padY * 2);
    targetCtx.fillStyle = '#1c1f26';
    targetCtx.fillText(label, midX, midY);
    targetCtx.textAlign = 'left';
    targetCtx.textBaseline = 'alphabetic';
  }

  function drawMeasureArrowOn(targetCtx, x1, y1, x2, y2) {
    const { headSize, lineWidth } = measureArrowSizing();
    targetCtx.save();
    targetCtx.globalCompositeOperation = 'source-over';
    targetCtx.strokeStyle = currentColor;
    targetCtx.fillStyle = currentColor;
    targetCtx.lineWidth = lineWidth;
    targetCtx.lineCap = 'round';
    targetCtx.beginPath();
    targetCtx.moveTo(x1, y1);
    targetCtx.lineTo(x2, y2);
    targetCtx.stroke();
    drawArrowheadOn(targetCtx, x2, y2, x1, y1, headSize); // tip at start
    drawArrowheadOn(targetCtx, x1, y1, x2, y2, headSize); // tip at end
    targetCtx.restore();
    drawLabelOn(targetCtx, (x1 + x2) / 2, (y1 + y2) / 2, formatDistance(Math.hypot(x2 - x1, y2 - y1)));
  }

  function finalizeMeasureArrow(x1, y1, x2, y2) {
    if (Math.hypot(x2 - x1, y2 - y1) < 4) return;
    pushUndo();
    drawMeasureArrowOn(ctx, x1, y1, x2, y2);
  }

  view.querySelector('#btn-measure').addEventListener('click', (e) => {
    measureMode = !measureMode;
    if (measureMode) {
      deactivateOtherModes('measure');
      e.currentTarget.classList.add('active');
    } else {
      e.currentTarget.classList.remove('active');
    }
    touches.clear();
    pinchState = null;
    measureStart = null;
    clearPreview();
  });

  // ---- Text tool: tap to drop a white multi-line text box (bold/underline/size
  // adjustable); dragging instead of tapping places an optional single-headed leader arrow
  // pointing back at the drag's start point. ----
  let textMode = false;
  let textPressPoint = null;
  let textPointerId = null;
  let textBold = false, textUnderline = false, textFontSize = 26;

  function rectEdgeIntersection(centerX, centerY, boxW, boxH, targetX, targetY) {
    const dx = targetX - centerX, dy = targetY - centerY;
    if (dx === 0 && dy === 0) return { x: centerX, y: centerY };
    const halfW = boxW / 2, halfH = boxH / 2;
    let tMin = Infinity;
    if (dx !== 0) tMin = Math.min(tMin, halfW / Math.abs(dx));
    if (dy !== 0) tMin = Math.min(tMin, halfH / Math.abs(dy));
    const len = Math.hypot(dx, dy);
    const ux = dx / len, uy = dy / len;
    return { x: centerX + ux * tMin, y: centerY + uy * tMin };
  }

  function drawTextBoxOn(targetCtx, x, y, text, opts) {
    const { bold, underline, fontSize } = opts;
    const lines = text.split('\n');
    const fontWeight = bold ? '800' : '400';
    targetCtx.font = `${fontWeight} ${fontSize}px -apple-system, sans-serif`;
    const lineHeight = fontSize * 1.35;
    const padding = 12;
    let maxLineW = 0;
    lines.forEach((l) => { maxLineW = Math.max(maxLineW, targetCtx.measureText(l).width); });
    const boxW = maxLineW + padding * 2;
    const boxH = lines.length * lineHeight + padding * 2;

    targetCtx.fillStyle = 'rgba(255,255,255,0.94)';
    targetCtx.strokeStyle = '#1c1f26';
    targetCtx.lineWidth = 1.5;
    targetCtx.fillRect(x, y, boxW, boxH);
    targetCtx.strokeRect(x, y, boxW, boxH);

    targetCtx.fillStyle = '#1c1f26';
    targetCtx.textBaseline = 'top';
    lines.forEach((l, i) => {
      const ly = y + padding + i * lineHeight;
      targetCtx.fillText(l, x + padding, ly);
      if (underline) {
        const w = targetCtx.measureText(l).width;
        targetCtx.beginPath();
        targetCtx.moveTo(x + padding, ly + fontSize + 3);
        targetCtx.lineTo(x + padding + w, ly + fontSize + 3);
        targetCtx.strokeStyle = '#1c1f26';
        targetCtx.lineWidth = Math.max(1.5, fontSize * 0.04);
        targetCtx.stroke();
      }
    });
    targetCtx.textBaseline = 'alphabetic';
    return { x, y, w: boxW, h: boxH, centerX: x + boxW / 2, centerY: y + boxH / 2 };
  }

  function openTextEntrySheet(onConfirm) {
    let bold = textBold, underline = textUnderline, fontSize = textFontSize;
    const sheet = el(`
      <div class="sheet-backdrop">
        <div class="sheet">
          <div class="sheet-handle"></div>
          <h2>Add text</h2>
          <div class="field"><textarea id="f-text" placeholder="Type a label…" style="min-height:90px;"></textarea></div>
          <div style="display:flex; gap:8px; margin-bottom:16px; flex-wrap:wrap; align-items:center;">
            <button class="tool-btn" id="btn-bold" title="Bold" style="width:auto; padding:0 16px; font-weight:800; ${bold ? 'background:var(--ink);' : ''}">B</button>
            <button class="tool-btn" id="btn-underline" title="Underline" style="width:auto; padding:0 16px; text-decoration:underline; ${underline ? 'background:var(--ink);' : ''}">U</button>
            <button class="tool-btn" id="btn-size-down" title="Smaller" style="width:auto; padding:0 14px;">A−</button>
            <span id="size-readout" class="muted" style="font-size:13px; min-width:26px; text-align:center;">${fontSize}</span>
            <button class="tool-btn" id="btn-size-up" title="Bigger" style="width:auto; padding:0 14px;">A+</button>
          </div>
          <button class="btn btn-primary btn-block" id="btn-place">Place text</button>
          <button class="btn btn-ghost btn-block" id="btn-cancel">Cancel</button>
        </div>
      </div>
    `);
    presentOverlay(sheet);
    sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.remove(); });
    sheet.querySelector('#btn-cancel').addEventListener('click', () => sheet.remove());
    sheet.querySelector('#btn-bold').addEventListener('click', (e) => { bold = !bold; e.currentTarget.style.background = bold ? 'var(--ink)' : ''; });
    sheet.querySelector('#btn-underline').addEventListener('click', (e) => { underline = !underline; e.currentTarget.style.background = underline ? 'var(--ink)' : ''; });
    sheet.querySelector('#btn-size-down').addEventListener('click', () => { fontSize = Math.max(14, fontSize - 4); sheet.querySelector('#size-readout').textContent = fontSize; });
    sheet.querySelector('#btn-size-up').addEventListener('click', () => { fontSize = Math.min(72, fontSize + 4); sheet.querySelector('#size-readout').textContent = fontSize; });
    sheet.querySelector('#btn-place').addEventListener('click', () => {
      const text = sheet.querySelector('#f-text').value.trim();
      if (!text) { toast('Enter some text'); return; }
      textBold = bold; textUnderline = underline; textFontSize = fontSize;
      sheet.remove();
      onConfirm({ text, bold, underline, fontSize });
    });
  }

  function finalizeTextPlacement(pressPt, releasePt) {
    const dragged = Math.hypot(releasePt.x - pressPt.x, releasePt.y - pressPt.y) > 12;
    const arrowTarget = dragged ? pressPt : null;
    const boxAnchor = dragged ? releasePt : pressPt;
    openTextEntrySheet((result) => {
      pushUndo();
      const box = drawTextBoxOn(ctx, boxAnchor.x, boxAnchor.y, result.text, result);
      if (arrowTarget) {
        const start = rectEdgeIntersection(box.centerX, box.centerY, box.w, box.h, arrowTarget.x, arrowTarget.y);
        const { headSize, lineWidth } = measureArrowSizing();
        ctx.save();
        ctx.strokeStyle = '#1c1f26';
        ctx.fillStyle = '#1c1f26';
        ctx.lineWidth = lineWidth;
        ctx.beginPath();
        ctx.moveTo(start.x, start.y);
        ctx.lineTo(arrowTarget.x, arrowTarget.y);
        ctx.stroke();
        drawArrowheadOn(ctx, start.x, start.y, arrowTarget.x, arrowTarget.y, headSize);
        ctx.restore();
      }
    });
  }

  view.querySelector('#btn-text-tool').addEventListener('click', (e) => {
    textMode = !textMode;
    if (textMode) {
      deactivateOtherModes('text');
      e.currentTarget.classList.add('active');
    } else {
      e.currentTarget.classList.remove('active');
    }
    touches.clear();
    pinchState = null;
    textPressPoint = null;
    clearPreview();
  });

  // ---- Drawing (pen always; a single finger when no special mode is active) ----
  let drawing = false;
  let drawingPointerId = null;
  let lastX = 0, lastY = 0;

  function isDrawingPointer(e) {
    if (e.pointerType === 'pen') return true;
    if (e.pointerType === 'touch') return false;
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

  const touches = new Map(); // pointerId -> {cx, cy, x, y}

  markCanvas.addEventListener('pointerdown', (e) => {
    if (calibrating) {
      if (e.pointerType === 'touch') {
        const p = canvasPoint(e);
        touches.set(e.pointerId, { cx: e.clientX, cy: e.clientY, x: p.x, y: p.y });
        if (touches.size >= 2) { updatePinch(); e.preventDefault(); return; }
      }
      calPending = canvasPoint(e);
      renderCalMarkers();
      updateCalToolbar();
      e.preventDefault();
      return;
    }

    if (measureMode) {
      if (e.pointerType === 'touch') {
        const p = canvasPoint(e);
        touches.set(e.pointerId, { cx: e.clientX, cy: e.clientY, x: p.x, y: p.y });
        if (touches.size >= 2) { measureStart = null; clearPreview(); updatePinch(); e.preventDefault(); return; }
      }
      measureStart = canvasPoint(e);
      measurePointerId = e.pointerId;
      e.preventDefault();
      return;
    }

    if (textMode) {
      if (e.pointerType === 'touch') {
        const p = canvasPoint(e);
        touches.set(e.pointerId, { cx: e.clientX, cy: e.clientY, x: p.x, y: p.y });
        if (touches.size >= 2) { textPressPoint = null; clearPreview(); updatePinch(); e.preventDefault(); return; }
      }
      textPressPoint = canvasPoint(e);
      textPointerId = e.pointerId;
      e.preventDefault();
      return;
    }

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
      if (rulerEnabled) { e.preventDefault(); return; }
      startStroke(e);
      e.preventDefault();
      return;
    }
    if (!isDrawingPointer(e)) return;
    startStroke(e);
  });

  markCanvas.addEventListener('pointermove', (e) => {
    if (calibrating) {
      if (e.pointerType === 'touch' && touches.has(e.pointerId)) {
        const p = canvasPoint(e);
        touches.set(e.pointerId, { cx: e.clientX, cy: e.clientY, x: p.x, y: p.y });
        if (touches.size >= 2) { updatePinch(); e.preventDefault(); return; }
      }
      if (e.pointerType === 'pen' || e.pointerType === 'mouse' || (e.pointerType === 'touch' && touches.size === 1)) {
        calPending = canvasPoint(e);
        renderCalMarkers();
      }
      e.preventDefault();
      return;
    }

    if (measureMode) {
      if (e.pointerType === 'touch' && touches.has(e.pointerId)) {
        const p = canvasPoint(e);
        touches.set(e.pointerId, { cx: e.clientX, cy: e.clientY, x: p.x, y: p.y });
        if (touches.size >= 2) { updatePinch(); e.preventDefault(); return; }
      }
      if (measureStart && e.pointerId === measurePointerId) {
        const p = canvasPoint(e);
        clearPreview();
        drawMeasureArrowOn(previewCtx, measureStart.x, measureStart.y, p.x, p.y);
      }
      e.preventDefault();
      return;
    }

    if (textMode) {
      if (e.pointerType === 'touch' && touches.has(e.pointerId)) {
        const p = canvasPoint(e);
        touches.set(e.pointerId, { cx: e.clientX, cy: e.clientY, x: p.x, y: p.y });
        if (touches.size >= 2) { updatePinch(); e.preventDefault(); return; }
      }
      if (textPressPoint && e.pointerId === textPointerId) {
        const p = canvasPoint(e);
        clearPreview();
        if (Math.hypot(p.x - textPressPoint.x, p.y - textPressPoint.y) > 12) {
          previewCtx.save();
          previewCtx.strokeStyle = currentColor;
          previewCtx.lineWidth = 2.5;
          previewCtx.setLineDash([8, 6]);
          previewCtx.beginPath();
          previewCtx.moveTo(textPressPoint.x, textPressPoint.y);
          previewCtx.lineTo(p.x, p.y);
          previewCtx.stroke();
          previewCtx.restore();
        }
      }
      e.preventDefault();
      return;
    }

    if (e.pointerType === 'touch' && touches.has(e.pointerId)) {
      const p = canvasPoint(e);
      touches.set(e.pointerId, { cx: e.clientX, cy: e.clientY, x: p.x, y: p.y });
      if (touches.size >= 2) {
        if (rulerEnabled) updateRulerFromTouches();
        else updatePinch();
        e.preventDefault();
        return;
      }
      if (drawing && e.pointerId === drawingPointerId) continueStroke(e);
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
    if (measureMode && measureStart && e.pointerId === measurePointerId) {
      const p = canvasPoint(e);
      clearPreview();
      finalizeMeasureArrow(measureStart.x, measureStart.y, p.x, p.y);
      measureStart = null;
      measurePointerId = null;
    }
    if (textMode && textPressPoint && e.pointerId === textPointerId) {
      const p = canvasPoint(e);
      clearPreview();
      finalizeTextPlacement(textPressPoint, p);
      textPressPoint = null;
      textPointerId = null;
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
