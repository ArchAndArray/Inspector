// annotate.js - fullscreen photo markup using Canvas + Pointer Events (Apple Pencil Pro support)
//
// Two stacked canvases: a base photo layer (drawn once, only re-drawn on rotate) and a
// transparent overlay layer where all pencil strokes and erasing happen — keeping them
// separate is what lets the eraser remove marks without ever touching the photo. Flattened
// into one image only at save time.
//
// Touch has three mutually exclusive modes via a single `touches` map:
//   - One finger (ruler off, not calibrating): draws, owned by that finger's pointerId only.
//   - Two fingers (ruler off): pinch-to-zoom / pan.
//   - Two fingers (ruler on): positions and rotates the ruler.
// A Pencil always draws, constrained to the ruler when it's active. While calibrating,
// single-finger/pen taps place a point instead of drawing; two fingers still pan/zoom so you
// can navigate to a second point that isn't currently on screen.
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
        <button class="tool-btn" id="btn-calibrate" title="Calibrate" style="width:auto; padding:0 12px; font-size:12px; font-weight:700;">Calibrate</button>
        <div class="spacer"></div>
        <span class="muted" id="ruler-hint" style="display:none; font-size:11.5px; color:#b8bcc4;">Two fingers: move &amp; rotate the ruler</span>
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
          <div id="ruler-visual" style="display:none; position:absolute; opacity:0.5; pointer-events:none;"></div>
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
    photoCtx.drawImage(rotatedPhoto, 0, 0);
    ctx.drawImage(rotatedMark, 0, 0);

    undoStack = [];
    ruler.cx = cw / 2; ruler.cy = ch / 2;
    resetViewTransform();
    fitCanvas();
    updateRulerVisual();
  });

  // ---- Ruler: looks like a real ruler (ticks + numbers), the pen/eraser are constrained
  // to its top edge (not its centerline), shown at 50% opacity, and its numbers reflect
  // real-world units once this photo has been calibrated. ----
  let rulerEnabled = false;
  let rulerSnap = true;
  const ruler = { cx: cw / 2, cy: ch / 2, angle: 0 };
  const RULER_LENGTH_PX = Math.min(cw, ch) * 0.55;
  const RULER_THICKNESS_PX = RULER_LENGTH_PX * 0.11;

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
      const totalUnits = RULER_LENGTH_PX / calibration.pixelsPerUnit;
      const step = niceRulerStep(totalUnits / 8);
      for (let v = 0; v <= totalUnits + 1e-6; v += step) {
        ticks.push({ frac: (v * calibration.pixelsPerUnit) / RULER_LENGTH_PX, label: String(Math.round(v * 100) / 100) });
      }
    } else {
      const step = niceRulerStep(RULER_LENGTH_PX / 8);
      for (let v = 0; v <= RULER_LENGTH_PX + 1e-6; v += step) {
        ticks.push({ frac: v / RULER_LENGTH_PX, label: String(Math.round(v)) });
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
      svg += `<text x="${x}" y="${edgeY + tickLen + 15}" font-size="13" fill="#1c1f26" text-anchor="middle" font-family="-apple-system,sans-serif">${t.label}</text>`;
    });
    if (calibration) {
      svg += `<text x="${W - 6}" y="${H - 6}" font-size="11" fill="#4a4f5a" text-anchor="end" font-family="-apple-system,sans-serif">${calibration.unit}</text>`;
    }
    svg += `</svg>`;
    return svg;
  }

  function updateRulerVisual() {
    rulerVisual.style.display = rulerEnabled ? 'block' : 'none';
    if (!rulerEnabled) return;
    const leftPct = (ruler.cx / cw) * 100;
    const topPct = (ruler.cy / ch) * 100;
    const deg = (ruler.angle * 180) / Math.PI;
    const widthPct = (RULER_LENGTH_PX / cw) * 100;
    const heightPct = (RULER_THICKNESS_PX / ch) * 100;
    rulerVisual.style.left = leftPct + '%';
    rulerVisual.style.top = topPct + '%';
    rulerVisual.style.width = widthPct + '%';
    rulerVisual.style.height = heightPct + '%';
    // Top edge (not center) sits on the ruler's actual position, so the drawing edge and
    // the pivot for rotation both stay on the constraint line at every angle.
    rulerVisual.style.transformOrigin = '50% 0%';
    rulerVisual.style.transform = `translate(-50%, 0%) rotate(${deg}deg)`;
    rulerVisual.innerHTML = buildRulerSVG();
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

  // ---- Pinch-to-zoom / two-finger pan (ruler off, or while calibrating) ----
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

  // ---- Calibration: tap a point, Accept or Reset, then (after panning/zooming freely)
  // tap the second point the same way. Entering a real-world distance finishes it. ----
  let calibrating = false;
  let calStep = 0; // 0 = picking point 1, 1 = picking point 2
  let calPending = null;
  let calPoint1 = null;
  let calPoint2 = null;

  function renderCalMarkers() {
    view.querySelectorAll('.cal-marker').forEach((m) => m.remove());
    function addMarker(pt, color) {
      if (!pt) return;
      const m = document.createElement('div');
      m.className = 'cal-marker';
      m.style.cssText = `position:absolute; width:16px; height:16px; border-radius:50%; background:${color}; border:2px solid #fff; box-shadow:0 0 0 1px rgba(0,0,0,0.35); left:${(pt.x / cw) * 100}%; top:${(pt.y / ch) * 100}%; transform:translate(-50%,-50%); pointer-events:none; z-index:6;`;
      stackEl.appendChild(m);
    }
    addMarker(calPoint1, '#4f9d5c');
    const secondPt = calStep === 0 ? calPending : (calPoint2 || calPending);
    addMarker(secondPt, calPoint2 ? '#4f9d5c' : '#e0a72e');
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
    if (measureMode) { measureMode = false; view.querySelector('#btn-measure').classList.remove('active'); measureStart = null; clearPreview(); }
    view.querySelector('#main-toolbar').style.display = 'none';
    view.querySelector('#ruler-toolbar').style.display = 'none';
    view.querySelector('#cal-toolbar').style.display = '';
    updateCalToolbar();
    renderCalMarkers();
  }
  function exitCalibrationMode() {
    calibrating = false;
    calPending = null; calPoint1 = null; calPoint2 = null;
    view.querySelector('#main-toolbar').style.display = '';
    view.querySelector('#ruler-toolbar').style.display = '';
    view.querySelector('#cal-toolbar').style.display = 'none';
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
                <option value="cm">cm</option>
                <option value="m">m</option>
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

  // ---- Measure: drag to draw a double-ended arrow, labeled with the distance — real-world
  // units if this photo is calibrated, otherwise raw pixels. Baked into the mark layer like
  // any other stroke (so Undo removes it) once the drag finishes; a lightweight separate
  // preview canvas shows it live while dragging without touching the real annotation. ----
  let measureMode = false;
  let measureStart = null;
  let measurePointerId = null;

  function formatDistance(pixelDist) {
    if (calibration && calibration.pixelsPerUnit > 0) {
      const val = pixelDist / calibration.pixelsPerUnit;
      return `${Math.round(val * 100) / 100} ${calibration.unit}`;
    }
    return `${Math.round(pixelDist)} px`;
  }

  function drawArrowheadOn(targetCtx, fromX, fromY, toX, toY, size) {
    const angle = Math.atan2(toY - fromY, toX - fromX);
    targetCtx.beginPath();
    targetCtx.moveTo(toX, toY);
    targetCtx.lineTo(toX - size * Math.cos(angle - Math.PI / 7), toY - size * Math.sin(angle - Math.PI / 7));
    targetCtx.lineTo(toX - size * Math.cos(angle + Math.PI / 7), toY - size * Math.sin(angle + Math.PI / 7));
    targetCtx.closePath();
    targetCtx.fill();
  }

  function drawLabelOn(targetCtx, midX, midY, label) {
    targetCtx.font = '28px -apple-system, sans-serif';
    targetCtx.textAlign = 'center';
    targetCtx.textBaseline = 'middle';
    const textW = targetCtx.measureText(label).width;
    const padX = 10, padY = 6;
    targetCtx.fillStyle = 'rgba(255,255,255,0.85)';
    targetCtx.fillRect(midX - textW / 2 - padX, midY - 16 - padY, textW + padX * 2, 32 + padY * 2);
    targetCtx.fillStyle = '#1c1f26';
    targetCtx.fillText(label, midX, midY);
    targetCtx.textAlign = 'left';
    targetCtx.textBaseline = 'alphabetic';
  }

  function drawMeasureArrowOn(targetCtx, x1, y1, x2, y2) {
    targetCtx.save();
    targetCtx.globalCompositeOperation = 'source-over';
    targetCtx.strokeStyle = currentColor;
    targetCtx.fillStyle = currentColor;
    targetCtx.lineWidth = Math.max(3, currentWidth);
    targetCtx.lineCap = 'round';
    targetCtx.beginPath();
    targetCtx.moveTo(x1, y1);
    targetCtx.lineTo(x2, y2);
    targetCtx.stroke();
    const headSize = Math.max(14, currentWidth * 2.2);
    drawArrowheadOn(targetCtx, x2, y2, x1, y1, headSize); // tip at start
    drawArrowheadOn(targetCtx, x1, y1, x2, y2, headSize); // tip at end
    targetCtx.restore();
    drawLabelOn(targetCtx, (x1 + x2) / 2, (y1 + y2) / 2, formatDistance(Math.hypot(x2 - x1, y2 - y1)));
  }

  function clearPreview() { previewCtx.clearRect(0, 0, cw, ch); }

  function finalizeMeasureArrow(x1, y1, x2, y2) {
    if (Math.hypot(x2 - x1, y2 - y1) < 4) return; // ignore accidental taps
    pushUndo();
    drawMeasureArrowOn(ctx, x1, y1, x2, y2);
  }

  view.querySelector('#btn-measure').addEventListener('click', (e) => {
    measureMode = !measureMode;
    e.currentTarget.classList.toggle('active', measureMode);
    if (measureMode && rulerEnabled) {
      rulerEnabled = false;
      view.querySelector('#btn-ruler').classList.remove('active');
      view.querySelector('#btn-ruler-snap').style.display = 'none';
      view.querySelector('#ruler-hint').style.display = 'none';
      view.querySelector('#zoom-hint').style.display = '';
      updateRulerVisual();
    }
    touches.clear();
    pinchState = null;
    measureStart = null;
    clearPreview();
  });

  // ---- Drawing (pen always; a single finger when the ruler is off and not calibrating) ----
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
