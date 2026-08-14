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
  // If an editable mark layer was saved previously (via "Save, keep editable" rather than
  // "Flatten & commit"), load the pristine original photo plus that separate mark layer,
  // so marks are still individually undo-able/erasable — not the flattened result, which
  // would make previously-drawn marks indistinguishable from the photo itself.
  const hasEditableMark = !!photo.editableMarkBlob;
  const sourceBlob = hasEditableMark ? photo.originalBlob : (photo.annotatedBlob || photo.originalBlob);
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
        <div class="atb-row">
          <div class="atb-left">
            <button class="tool-btn tool-btn-text" id="btn-undo" title="Undo">Undo</button>
            <button class="tool-btn tool-btn-text" id="btn-rotate" title="Rotate">Rotate</button>
            <button class="tool-btn tool-btn-text" id="btn-crop" title="Crop">Crop</button>
            <button class="tool-btn tool-btn-text" id="btn-calibrate" title="Calibrate">Calibrate</button>
            <button class="tool-btn tool-btn-text" id="btn-grid" title="Grid">Grid</button>
          </div>
          <div class="atb-mid" id="color-row-fixed">
            ${ANNOTATE_COLORS.map((c, i) => `<div class="color-dot ${i === 0 ? 'active' : ''}" data-color="${c}" style="background:${c};"></div>`).join('')}
          </div>
          <div class="atb-right">
            <button class="tool-btn" id="btn-line-style" title="Line style — tap to choose" style="display:none;">
              <svg width="20" height="16" viewBox="0 0 24 16" xmlns="http://www.w3.org/2000/svg">
                <line x1="2" y1="8" x2="22" y2="8" stroke="currentColor" stroke-width="2.4" stroke-dasharray="5,3.5" stroke-linecap="round"/>
              </svg>
            </button>
            <button class="tool-btn" id="w-thin" title="Thin">•</button>
            <button class="tool-btn active" id="w-medium" title="Medium">●</button>
            <button class="tool-btn" id="w-thick" title="Thick">⬤</button>
            <button class="tool-btn" id="w-custom" title="Custom width — tap to use, hold to change">
              <svg width="18" height="18" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                <rect x="3" y="5" width="18" height="1.5" fill="currentColor"/>
                <rect x="3" y="11" width="18" height="3.5" fill="currentColor"/>
                <rect x="3" y="17.5" width="18" height="5.5" fill="currentColor"/>
              </svg>
            </button>
            <button class="tool-btn" id="btn-erase" title="Eraser">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <rect x="3" y="12" width="14" height="8" rx="1.2" transform="rotate(-32 3 12)" fill="currentColor"/>
                <path d="M9.5 5.5 L19 15 L15 19 L5.5 9.5 Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
              </svg>
            </button>
          </div>
        </div>
      </div>
      <div class="annotate-toolbar" id="ruler-toolbar" style="padding-top:0; padding-bottom:8px;">
        <div class="atb-row">
          <div class="atb-left">
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
            <button class="tool-btn" id="btn-arc" title="Curved line">
              <svg width="19" height="19" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M4 18 Q12 4 20 18" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/>
              </svg>
            </button>
            <button class="tool-btn" id="btn-straight-line" title="Straight line">
              <svg width="19" height="19" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <line x1="4" y1="20" x2="20" y2="4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
              </svg>
            </button>
            <button class="tool-btn pen-type-btn active" data-pentype="pen" title="Pen">✏️</button>
            <button class="tool-btn pen-type-btn" data-pentype="airbrush" title="Airbrush">💨</button>
            <button class="tool-btn pen-type-btn" data-pentype="fountain" title="Fountain pen">🖋️</button>
            <button class="tool-btn pen-type-btn" data-pentype="smoothing" title="Smoothing pen">〰️</button>
          </div>
          <div class="atb-mid" id="color-row-custom">
            ${[0, 1, 2, 3, 4].map((i) => `<div class="color-dot color-dot-custom" data-custom-index="${i}" style="background:#e8e9ec; border:1.5px dashed #b8bcc4;"></div>`).join('')}
          </div>
          <div class="atb-right">
            <span class="muted" id="ruler-angle-readout" style="display:none; font-size:13px; font-weight:700; color:#fff;">0°</span>
            <span class="muted" id="ruler-hint" style="display:none; font-size:11.5px; color:#b8bcc4;">Two fingers: move &amp; rotate · pull the dot to resize</span>
            <span class="muted" id="zoom-hint" style="font-size:11.5px; color:#b8bcc4;">Pinch to zoom</span>
          </div>
        </div>
      </div>
      <div class="annotate-toolbar" id="cal-toolbar" style="display:none; padding-top:0; padding-bottom:8px;">
        <span id="cal-instruction" style="color:#fff; font-size:13px; font-weight:600; flex:1;"></span>
        <button class="tool-btn" id="btn-cal-reset" title="Reset">↺</button>
        <button class="tool-btn" id="btn-cal-accept" title="Accept" style="display:none; background:var(--sev-1);">✓</button>
        <button class="tool-btn" id="btn-cal-cancel" title="Cancel calibration">✕</button>
      </div>
      <div class="annotate-toolbar" id="crop-toolbar" style="display:none; padding-top:0; padding-bottom:8px;">
        <span style="color:#fff; font-size:13px; font-weight:600; flex:1;">Drag corners to resize, drag inside to move</span>
        <button class="tool-btn" id="btn-crop-apply" title="Apply crop" style="background:var(--sev-1);">✓</button>
        <button class="tool-btn" id="btn-crop-cancel" title="Cancel crop">✕</button>
      </div>
      <div class="annotate-toolbar" id="adjust-toolbar" style="display:none; padding-top:0; padding-bottom:8px;">
        <span style="color:#fff; font-size:13px; font-weight:600; flex:1;">Drag to reposition, then confirm</span>
        <button class="tool-btn" id="btn-adjust-done" title="Confirm" style="background:var(--sev-1);">✓</button>
        <button class="tool-btn" id="btn-adjust-cancel" title="Discard">✕</button>
      </div>
      <div class="annotate-canvas-wrap" id="canvas-wrap">
        <div id="canvas-stack" style="position:relative;">
          <canvas id="photo-canvas" width="${cw}" height="${ch}" style="display:block; width:100%; height:100%;"></canvas>
          <canvas id="mark-canvas" width="${cw}" height="${ch}" style="display:block; width:100%; height:100%; position:absolute; top:0; left:0;"></canvas>
          <canvas id="preview-canvas" width="${cw}" height="${ch}" style="display:block; width:100%; height:100%; position:absolute; top:0; left:0; pointer-events:none;"></canvas>
          <div id="grid-visual" style="display:none; position:absolute; top:0; left:0; width:100%; height:100%; pointer-events:none; z-index:2;"></div>
          <svg id="cal-line-svg" width="100%" height="100%" viewBox="0 0 ${cw} ${ch}" style="display:none; position:absolute; top:0; left:0; pointer-events:none; z-index:5;" preserveAspectRatio="none">
            <line id="cal-line" x1="0" y1="0" x2="0" y2="0" stroke="#e0a72e" stroke-width="3" stroke-dasharray="10,7"/>
          </svg>
          <div id="ruler-visual" style="display:none; position:absolute; opacity:0.5; pointer-events:none;"></div>
          <div id="ruler-handle" style="display:none; position:absolute; width:26px; height:26px; margin:-13px; border-radius:50%; background:#c81e1e; border:2.5px solid #fff; box-shadow:0 0 0 1px rgba(0,0,0,0.35); touch-action:none; z-index:7;"></div>
          <div id="crop-visual" style="display:none; position:absolute; top:0; left:0; width:100%; height:100%; z-index:9;">
            <div id="crop-dim-top" style="position:absolute; background:rgba(0,0,0,0.55); pointer-events:none;"></div>
            <div id="crop-dim-bottom" style="position:absolute; background:rgba(0,0,0,0.55); pointer-events:none;"></div>
            <div id="crop-dim-left" style="position:absolute; background:rgba(0,0,0,0.55); pointer-events:none;"></div>
            <div id="crop-dim-right" style="position:absolute; background:rgba(0,0,0,0.55); pointer-events:none;"></div>
            <div id="crop-border" style="position:absolute; border:2px solid #fff; box-shadow:0 0 0 1px rgba(0,0,0,0.5); touch-action:none;"></div>
            <div class="crop-handle" data-corner="tl" style="position:absolute; width:24px; height:24px; margin:-12px; border-radius:50%; background:#c81e1e; border:2.5px solid #fff; box-shadow:0 0 0 1px rgba(0,0,0,0.35); touch-action:none;"></div>
            <div class="crop-handle" data-corner="tr" style="position:absolute; width:24px; height:24px; margin:-12px; border-radius:50%; background:#c81e1e; border:2.5px solid #fff; box-shadow:0 0 0 1px rgba(0,0,0,0.35); touch-action:none;"></div>
            <div class="crop-handle" data-corner="bl" style="position:absolute; width:24px; height:24px; margin:-12px; border-radius:50%; background:#c81e1e; border:2.5px solid #fff; box-shadow:0 0 0 1px rgba(0,0,0,0.35); touch-action:none;"></div>
            <div class="crop-handle" data-corner="br" style="position:absolute; width:24px; height:24px; margin:-12px; border-radius:50%; background:#c81e1e; border:2.5px solid #fff; box-shadow:0 0 0 1px rgba(0,0,0,0.35); touch-action:none;"></div>
          </div>
          <div id="adjust-box-area" style="display:none; position:absolute; border:2px dashed #fff; box-shadow:0 0 0 1px rgba(0,0,0,0.5); touch-action:none; z-index:11;"></div>
          <div id="adjust-handle-1" class="adjust-handle" style="display:none; position:absolute; width:26px; height:26px; margin:-13px; border-radius:50%; background:#c81e1e; border:2.5px solid #fff; box-shadow:0 0 0 1px rgba(0,0,0,0.35); touch-action:none; z-index:12;"></div>
          <div id="adjust-handle-2" class="adjust-handle" style="display:none; position:absolute; width:26px; height:26px; margin:-13px; border-radius:50%; background:#1e7dc8; border:2.5px solid #fff; box-shadow:0 0 0 1px rgba(0,0,0,0.35); touch-action:none; z-index:12;"></div>
          <div id="adjust-handle-3" class="adjust-handle" style="display:none; position:absolute; width:24px; height:24px; margin:-12px; border-radius:50%; background:#e0a72e; border:2.5px solid #fff; box-shadow:0 0 0 1px rgba(0,0,0,0.35); touch-action:none; z-index:12;"></div>
        </div>
      </div>
      <div class="annotate-toolbar">
        <button class="btn btn-ghost" id="btn-cancel">Cancel</button>
        <div class="spacer"></div>
        <button class="btn btn-secondary" id="btn-save-editable" title="Saves your progress but keeps every mark individually editable if you come back to it">Save (editable)</button>
        <button class="btn btn-primary" id="btn-save" style="margin-left:8px;" title="Permanently merges the marks into the image">Flatten &amp; save</button>
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
  const gridVisual = view.querySelector('#grid-visual');
  const stackEl = view.querySelector('#canvas-stack');
  markCanvas.style.touchAction = 'none';
  const photoCtx = photoCanvas.getContext('2d');
  const ctx = markCanvas.getContext('2d');

  photoCtx.drawImage(img, 0, 0, cw, ch);
  if (img.close) img.close();
  if (hasEditableMark) {
    try {
      const markImg = await loadBitmapCorrected(photo.editableMarkBlob);
      ctx.drawImage(markImg, 0, 0, cw, ch);
      if (markImg.close) markImg.close();
    } catch (err) {
      // If the previously-saved mark layer can't be loaded for any reason, fail visibly
      // rather than silently leaving initialization half-done — a swallowed error here
      // would otherwise present as "editing doesn't work" with no indication why.
      console.error('Failed to reload editable mark layer', err);
      toast('Could not reload your previous marks — starting from the flattened image instead');
    }
  }

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
  let currentPenType = 'pen'; // 'pen' | 'airbrush' | 'fountain' | 'smoothing'

  // ---- Line style (dash pattern) — restricted to the Arc and Straight Line tools only.
  // Freehand drawing (any pen type) builds a stroke from many short segments (one per
  // pointer event), and even with the dash phase correctly tracked across segments, a
  // dashed pattern on a wobbly hand-drawn line doesn't render as cleanly as on a single
  // smooth path — Arc and Straight Line both draw in one continuous stroke, where dashes
  // render correctly and cleanly, so line style only applies to those two.
  //
  // Dash sizes are computed relative to the canvas's own resolution and the current pen
  // width (same technique as measureArrowSizing) rather than fixed pixel counts — a photo
  // canvas can be as large as 2400px but displayed at a fraction of that on screen, so a
  // fixed small dash/gap (e.g. 2px) becomes sub-pixel at display size and reads as a solid
  // line. LINE_STYLE_PREVIEW below is separate and intentionally fixed-size — it's only for
  // the small picker sheet's icon swatches, not the actual canvas.
  const LINE_STYLE_PREVIEW = {
    solid: [],
    dots: [2, 5],
    smallDashes: [6, 5],
    dashDot: [10, 5, 2, 5],
    largeDashes: [16, 7]
  };
  let currentLineStyle = 'solid';
  function getLineDashArray() {
    if (currentLineStyle === 'solid') return [];
    if (!arcMode && !straightLineMode) return [];
    const ref = Math.min(cw, ch);
    const unit = Math.max(8, ref * 0.012, currentWidth * 1.8);
    const patterns = {
      dots: [unit * 0.5, unit * 1.1],
      smallDashes: [unit * 1.3, unit * 1.0],
      dashDot: [unit * 2.1, unit * 1.0, unit * 0.5, unit * 1.0],
      largeDashes: [unit * 3.3, unit * 1.5]
    };
    return patterns[currentLineStyle] || [];
  }
  function applyLineStyle() {
    ctx.setLineDash(getLineDashArray());
  }
  function resetLineStyle() {
    ctx.setLineDash([]);
  }
  // Line style only means anything for Arc/Straight Line — hide the button entirely rather
  // than leave it selectable-but-inert for every other tool, which would just be confusing
  // (pick a style, draw with the Pen, see no effect, wonder why).
  function updateLineStyleButtonVisibility() {
    const btn = view.querySelector('#btn-line-style');
    btn.style.display = (arcMode || straightLineMode) ? '' : 'none';
  }

  view.querySelector('#btn-line-style').addEventListener('click', () => {
    const options = [
      ['solid', 'Solid'], ['dots', 'Dots'], ['smallDashes', 'Small dashes'],
      ['dashDot', 'Dots and dashes'], ['largeDashes', 'Large dashes']
    ];
    const sheet = el(`
      <div class="sheet-backdrop">
        <div class="sheet">
          <div class="sheet-handle"></div>
          <h2>Line style</h2>
          ${options.map(([key, label]) => `
            <button class="btn btn-secondary btn-block line-style-option" data-style="${key}" style="margin-top:8px; display:flex; align-items:center; gap:12px; ${key === currentLineStyle ? 'border-color:var(--ink); background:#f0f0f2;' : ''}">
              <svg width="60" height="14" viewBox="0 0 60 14"><line x1="2" y1="7" x2="58" y2="7" stroke="#1c1f26" stroke-width="2.4" stroke-dasharray="${LINE_STYLE_PREVIEW[key].join(',')}"/></svg>
              <span>${label}</span>
            </button>
          `).join('')}
          <button class="btn btn-ghost btn-block" id="btn-cancel-linestyle" style="margin-top:16px;">Close</button>
        </div>
      </div>
    `);
    presentOverlay(sheet);
    sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.remove(); });
    sheet.querySelector('#btn-cancel-linestyle').addEventListener('click', () => sheet.remove());
    sheet.querySelectorAll('.line-style-option').forEach((btn) => {
      btn.addEventListener('click', () => {
        currentLineStyle = btn.dataset.style;
        sheet.remove();
      });
    });
  });

  // ---- Persistent custom colors (5 user-saveable slots, survive across sessions) ----
  const CUSTOM_COLORS_KEY = 'inspector_custom_colors';
  function loadCustomColors() {
    try {
      const raw = localStorage.getItem(CUSTOM_COLORS_KEY);
      const arr = raw ? JSON.parse(raw) : null;
      if (Array.isArray(arr) && arr.length === 5) return arr;
    } catch (err) { /* ignore malformed/unavailable storage */ }
    return [null, null, null, null, null];
  }
  function saveCustomColors(arr) {
    try { localStorage.setItem(CUSTOM_COLORS_KEY, JSON.stringify(arr)); } catch (err) { /* ignore quota/unavailable storage */ }
  }
  let customColors = loadCustomColors();

  function renderCustomColorRow() {
    view.querySelectorAll('.color-dot-custom').forEach((dot) => {
      const i = Number(dot.dataset.customIndex);
      const c = customColors[i];
      dot.style.background = c || '#e8e9ec';
      dot.style.border = c ? 'none' : '1.5px dashed #b8bcc4';
    });
  }
  renderCustomColorRow();

  function selectColor(dot, colorValue) {
    if (!colorValue) return; // an unset custom slot has nothing to select yet
    currentColor = colorValue;
    eraseMode = false;
    view.querySelectorAll('.color-dot').forEach((d) => d.classList.remove('active'));
    dot.classList.add('active');
    view.querySelector('#btn-erase').classList.remove('active');
  }

  // Shared tap-vs-hold detection: a short press selects, a ~500ms hold opens the editor —
  // used identically for the custom color slots and the custom width button.
  // Shared tap-vs-hold detection: a short press selects, a ~500ms hold opens the editor —
  // used identically for the custom color slots and the custom width button. Captures the
  // pointer on press so natural finger drift during a tap on these small targets can't send
  // the pointerup event to a neighboring element instead, which was silently breaking both
  // the tap and the hold intermittently.
  function wireTapAndHold(el2, onTap, onHold) {
    let holdTimer = null;
    let holdFired = false;
    el2.addEventListener('pointerdown', (e) => {
      holdFired = false;
      try { el2.setPointerCapture(e.pointerId); } catch (err) { /* not critical if unsupported */ }
      holdTimer = setTimeout(() => { holdFired = true; onHold(e); }, 500);
    });
    function clearHold() { if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; } }
    el2.addEventListener('pointerup', (e) => {
      clearHold();
      if (!holdFired) onTap(e);
      try { el2.releasePointerCapture(e.pointerId); } catch (err) { /* already released */ }
    });
    el2.addEventListener('pointerleave', clearHold);
    el2.addEventListener('pointercancel', clearHold);
  }

  view.querySelectorAll('#color-row-fixed .color-dot').forEach((dot) => {
    dot.addEventListener('click', () => selectColor(dot, dot.dataset.color));
  });
  view.querySelectorAll('.color-dot-custom').forEach((dot) => {
    const i = Number(dot.dataset.customIndex);
    wireTapAndHold(dot,
      () => selectColor(dot, customColors[i]),
      () => openColorEditSheet(customColors[i] || '#c81e1e', (newColor) => {
        customColors[i] = newColor;
        saveCustomColors(customColors);
        renderCustomColorRow();
        selectColor(dot, newColor);
      })
    );
  });

  function openColorEditSheet(initialColor, onSave) {
    const sheet = el(`
      <div class="sheet-backdrop">
        <div class="sheet">
          <div class="sheet-handle"></div>
          <h2>Custom color</h2>
          <input type="color" id="f-custom-color" value="${initialColor}" style="width:100%; height:60px; border:none; border-radius:10px;">
          <button class="btn btn-primary btn-block" id="btn-save-color" style="margin-top:14px;">Save</button>
          <button class="btn btn-ghost btn-block" id="btn-cancel-color">Cancel</button>
        </div>
      </div>
    `);
    presentOverlay(sheet);
    sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.remove(); });
    sheet.querySelector('#btn-cancel-color').addEventListener('click', () => sheet.remove());
    sheet.querySelector('#btn-save-color').addEventListener('click', () => {
      onSave(sheet.querySelector('#f-custom-color').value);
      sheet.remove();
    });
  }

  // ---- Pen type (Pen / Airbrush / Fountain / Smoothing) ----
  view.querySelectorAll('.pen-type-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      currentPenType = btn.dataset.pentype;
      view.querySelectorAll('.pen-type-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  // ---- Width: 3 fixed presets plus a Custom slot (session-only, tap to use / hold to change) ----
  let customWidthValue = 10;
  let fountainAvgWidth = 8;
  let fountainMaxWidth = 22;

  function setWidth(key, btnEl) {
    currentWidth = ANNOTATE_WIDTHS[key];
    view.querySelectorAll('#w-thin,#w-medium,#w-thick,#w-custom').forEach((b) => b.classList.remove('active'));
    btnEl.classList.add('active');
  }
  view.querySelector('#w-thin').addEventListener('click', (e) => setWidth('thin', e.currentTarget));
  view.querySelector('#w-medium').addEventListener('click', (e) => setWidth('medium', e.currentTarget));
  view.querySelector('#w-thick').addEventListener('click', (e) => setWidth('thick', e.currentTarget));

  function selectCustomWidth() {
    currentWidth = currentPenType === 'fountain' ? fountainAvgWidth : customWidthValue;
    view.querySelectorAll('#w-thin,#w-medium,#w-thick,#w-custom').forEach((b) => b.classList.remove('active'));
    view.querySelector('#w-custom').classList.add('active');
  }
  wireTapAndHold(view.querySelector('#w-custom'),
    selectCustomWidth,
    () => {
      if (currentPenType === 'fountain') {
        openFountainWidthEditSheet(fountainAvgWidth, fountainMaxWidth, (avg, max) => {
          fountainAvgWidth = avg; fountainMaxWidth = max;
          selectCustomWidth();
        });
      } else {
        openWidthEditSheet(customWidthValue, (val) => {
          customWidthValue = val;
          selectCustomWidth();
        });
      }
    }
  );

  function openWidthEditSheet(initialValue, onSave) {
    const sheet = el(`
      <div class="sheet-backdrop">
        <div class="sheet">
          <div class="sheet-handle"></div>
          <h2>Custom width</h2>
          <div class="field">
            <input type="range" id="f-width" min="1" max="60" step="1" value="${initialValue}" style="width:100%;">
            <p class="hint" id="width-readout" style="text-align:center;">${initialValue}px</p>
          </div>
          <button class="btn btn-primary btn-block" id="btn-save-width">Save</button>
          <button class="btn btn-ghost btn-block" id="btn-cancel-width">Cancel</button>
        </div>
      </div>
    `);
    presentOverlay(sheet);
    sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.remove(); });
    sheet.querySelector('#f-width').addEventListener('input', (e) => {
      sheet.querySelector('#width-readout').textContent = `${e.target.value}px`;
    });
    sheet.querySelector('#btn-cancel-width').addEventListener('click', () => sheet.remove());
    sheet.querySelector('#btn-save-width').addEventListener('click', () => {
      onSave(Number(sheet.querySelector('#f-width').value));
      sheet.remove();
    });
  }

  function openFountainWidthEditSheet(initialAvg, initialMax, onSave) {
    const sheet = el(`
      <div class="sheet-backdrop">
        <div class="sheet">
          <div class="sheet-handle"></div>
          <h2>Fountain pen width</h2>
          <p class="muted" style="font-size:13px; margin-top:-8px;">Fountain pen width varies with stroke direction, between these two values.</p>
          <div class="field">
            <label>Average / normal width</label>
            <input type="range" id="f-avg" min="1" max="40" step="1" value="${initialAvg}" style="width:100%;">
            <p class="hint" id="avg-readout" style="text-align:center;">${initialAvg}px</p>
          </div>
          <div class="field">
            <label>Maximum width</label>
            <input type="range" id="f-max" min="1" max="60" step="1" value="${initialMax}" style="width:100%;">
            <p class="hint" id="max-readout" style="text-align:center;">${initialMax}px</p>
          </div>
          <button class="btn btn-primary btn-block" id="btn-save-fountain">Save</button>
          <button class="btn btn-ghost btn-block" id="btn-cancel-fountain">Cancel</button>
        </div>
      </div>
    `);
    presentOverlay(sheet);
    sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.remove(); });
    sheet.querySelector('#f-avg').addEventListener('input', (e) => { sheet.querySelector('#avg-readout').textContent = `${e.target.value}px`; });
    sheet.querySelector('#f-max').addEventListener('input', (e) => { sheet.querySelector('#max-readout').textContent = `${e.target.value}px`; });
    sheet.querySelector('#btn-cancel-fountain').addEventListener('click', () => sheet.remove());
    sheet.querySelector('#btn-save-fountain').addEventListener('click', () => {
      const avg = Number(sheet.querySelector('#f-avg').value);
      const max = Number(sheet.querySelector('#f-max').value);
      onSave(Math.min(avg, max), Math.max(avg, max));
      sheet.remove();
    });
  }

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
    if (gridState) updateGridVisual();
    if (cropMode) { cropRect = { x: cw * 0.1, y: ch * 0.1, w: cw * 0.8, h: ch * 0.8 }; updateCropVisual(); }
  });

  // ---- Grid: a pure visual alignment aid, drawn on its own overlay layer that's never
  // part of the mark canvas — so it's never baked into the saved image or the exported
  // report, same principle as the ruler. ----
  // Cycles through Off -> Normal -> Dense (half the spacing) -> Off, rather than a separate
  // button, keeping the already-busy toolbar from growing further.
  let gridState = 0; // 0 = off, 1 = normal, 2 = dense
  const GRID_SPACING = { 1: 100, 2: 50 };
  function updateGridVisual() {
    if (!gridState) return;
    const spacing = GRID_SPACING[gridState];
    // Stroke width scaled up slightly rather than a fixed 1 unit — under this SVG's
    // viewBox scale-down (native canvas resolution mapped onto a much smaller on-screen
    // size), a 1-unit line can render at a sub-pixel width, which some renderers handle
    // inconsistently depending on exact pixel alignment.
    const strokeW = Math.max(1.5, cw / 1400);
    let svg = `<svg width="100%" height="100%" viewBox="0 0 ${cw} ${ch}" preserveAspectRatio="none" style="display:block;">`;
    for (let x = spacing; x < cw; x += spacing) {
      svg += `<line x1="${x}" y1="0" x2="${x}" y2="${ch}" stroke="#000000" stroke-width="${strokeW}" opacity="0.18"/>`;
    }
    for (let y = spacing; y < ch; y += spacing) {
      svg += `<line x1="0" y1="${y}" x2="${cw}" y2="${y}" stroke="#000000" stroke-width="${strokeW}" opacity="0.18"/>`;
    }
    svg += `</svg>`;
    gridVisual.innerHTML = svg;
  }
  view.querySelector('#btn-grid').addEventListener('click', (e) => {
    gridState = (gridState + 1) % 3;
    e.currentTarget.textContent = gridState === 2 ? 'Grid ••' : gridState === 1 ? 'Grid •' : 'Grid';
    e.currentTarget.classList.toggle('active', gridState > 0);
    gridVisual.style.display = gridState > 0 ? 'block' : 'none';
    if (gridState > 0) updateGridVisual();
  });

  // ---- Crop: drag the corner handles to resize the crop rectangle, drag inside it to
  // reposition. Applying it resizes both canvas layers the same way Rotate already does —
  // recreate at the new dimensions, redraw the cropped region into them. Like Rotate, this
  // becomes the new permanent version once saved (no separate "revert to original"), and
  // calibration survives it correctly since pixels-per-unit doesn't change from selecting a
  // subregion at 1:1 — only the canvas's own extent shrinks. ----
  let cropMode = false;
  let cropRect = null;
  let cropDragCorner = null, cropDragPointerId = null, cropAnchor = null;
  let cropMovePointerId = null, cropMoveStart = null, cropRectStart = null;
  const CROP_MIN_SIZE = 40;

  function updateCropVisual() {
    if (!cropRect) return;
    const leftPct = (cropRect.x / cw) * 100, topPct = (cropRect.y / ch) * 100;
    const rightPct = ((cropRect.x + cropRect.w) / cw) * 100, bottomPct = ((cropRect.y + cropRect.h) / ch) * 100;
    const widthPct = (cropRect.w / cw) * 100, heightPct = (cropRect.h / ch) * 100;

    view.querySelector('#crop-dim-top').style.cssText += `left:0%; top:0%; width:100%; height:${topPct}%;`;
    view.querySelector('#crop-dim-bottom').style.cssText += `left:0%; top:${bottomPct}%; width:100%; height:${100 - bottomPct}%;`;
    view.querySelector('#crop-dim-left').style.cssText += `left:0%; top:${topPct}%; width:${leftPct}%; height:${heightPct}%;`;
    view.querySelector('#crop-dim-right').style.cssText += `left:${rightPct}%; top:${topPct}%; width:${100 - rightPct}%; height:${heightPct}%;`;

    const border = view.querySelector('#crop-border');
    border.style.left = leftPct + '%'; border.style.top = topPct + '%';
    border.style.width = widthPct + '%'; border.style.height = heightPct + '%';

    const corners = {
      tl: { x: cropRect.x, y: cropRect.y },
      tr: { x: cropRect.x + cropRect.w, y: cropRect.y },
      bl: { x: cropRect.x, y: cropRect.y + cropRect.h },
      br: { x: cropRect.x + cropRect.w, y: cropRect.y + cropRect.h }
    };
    view.querySelectorAll('.crop-handle').forEach((h) => {
      const p = corners[h.dataset.corner];
      h.style.left = (p.x / cw) * 100 + '%';
      h.style.top = (p.y / ch) * 100 + '%';
    });
  }

  function enterCropMode() {
    deactivateOtherModes(null);
    cropMode = true;
    cropRect = { x: cw * 0.1, y: ch * 0.1, w: cw * 0.8, h: ch * 0.8 };
    view.querySelector('#main-toolbar').style.display = 'none';
    view.querySelector('#ruler-toolbar').style.display = 'none';
    const cropToolbar = view.querySelector('#crop-toolbar');
    cropToolbar.style.display = '';
    // Same fix as the calibration toolbar: this row normally sits below the main toolbar
    // (which already reserves safe-area space) so it skips its own top padding — but
    // hiding that row here makes this one the topmost, so it needs the clearance itself.
    cropToolbar.style.paddingTop = 'calc(10px + var(--safe-top))';
    view.querySelector('#crop-visual').style.display = 'block';
    updateCropVisual();
  }
  function exitCropMode() {
    cropMode = false;
    view.querySelector('#main-toolbar').style.display = '';
    view.querySelector('#ruler-toolbar').style.display = '';
    view.querySelector('#crop-toolbar').style.display = 'none';
    view.querySelector('#crop-toolbar').style.paddingTop = '0';
    view.querySelector('#crop-visual').style.display = 'none';
  }
  view.querySelector('#btn-crop').addEventListener('click', () => {
    if (cropMode) exitCropMode(); else enterCropMode();
  });
  view.querySelector('#btn-crop-cancel').addEventListener('click', exitCropMode);

  const anchorCornerFor = { tl: 'br', tr: 'bl', bl: 'tr', br: 'tl' };
  function cornerPoint(corner) {
    if (corner === 'tl') return { x: cropRect.x, y: cropRect.y };
    if (corner === 'tr') return { x: cropRect.x + cropRect.w, y: cropRect.y };
    if (corner === 'bl') return { x: cropRect.x, y: cropRect.y + cropRect.h };
    return { x: cropRect.x + cropRect.w, y: cropRect.y + cropRect.h };
  }
  view.querySelectorAll('.crop-handle').forEach((h) => {
    h.addEventListener('pointerdown', (e) => {
      cropDragCorner = h.dataset.corner;
      cropDragPointerId = e.pointerId;
      cropAnchor = cornerPoint(anchorCornerFor[cropDragCorner]);
      try { h.setPointerCapture(e.pointerId); } catch (err) {}
      e.preventDefault(); e.stopPropagation();
    });
    h.addEventListener('pointermove', (e) => {
      if (e.pointerId !== cropDragPointerId) return;
      const p = canvasPoint(e);
      let px = Math.max(0, Math.min(cw, p.x));
      let py = Math.max(0, Math.min(ch, p.y));
      if (cropDragCorner === 'tl' || cropDragCorner === 'bl') px = Math.min(px, cropAnchor.x - CROP_MIN_SIZE);
      else px = Math.max(px, cropAnchor.x + CROP_MIN_SIZE);
      if (cropDragCorner === 'tl' || cropDragCorner === 'tr') py = Math.min(py, cropAnchor.y - CROP_MIN_SIZE);
      else py = Math.max(py, cropAnchor.y + CROP_MIN_SIZE);
      cropRect.x = Math.min(px, cropAnchor.x);
      cropRect.y = Math.min(py, cropAnchor.y);
      cropRect.w = Math.abs(px - cropAnchor.x);
      cropRect.h = Math.abs(py - cropAnchor.y);
      updateCropVisual();
      e.preventDefault(); e.stopPropagation();
    });
    function endHandleDrag(e) { if (e.pointerId === cropDragPointerId) { cropDragCorner = null; cropDragPointerId = null; } }
    h.addEventListener('pointerup', endHandleDrag);
    h.addEventListener('pointercancel', endHandleDrag);
  });

  const cropBorderEl = view.querySelector('#crop-border');
  cropBorderEl.addEventListener('pointerdown', (e) => {
    cropMovePointerId = e.pointerId;
    cropMoveStart = canvasPoint(e);
    cropRectStart = { ...cropRect };
    try { cropBorderEl.setPointerCapture(e.pointerId); } catch (err) {}
    e.preventDefault(); e.stopPropagation();
  });
  cropBorderEl.addEventListener('pointermove', (e) => {
    if (e.pointerId !== cropMovePointerId) return;
    const p = canvasPoint(e);
    const dx = p.x - cropMoveStart.x, dy = p.y - cropMoveStart.y;
    cropRect.x = Math.max(0, Math.min(cw - cropRectStart.w, cropRectStart.x + dx));
    cropRect.y = Math.max(0, Math.min(ch - cropRectStart.h, cropRectStart.y + dy));
    updateCropVisual();
    e.preventDefault(); e.stopPropagation();
  });
  function endBorderDrag(e) { if (e.pointerId === cropMovePointerId) cropMovePointerId = null; }
  cropBorderEl.addEventListener('pointerup', endBorderDrag);
  cropBorderEl.addEventListener('pointercancel', endBorderDrag);

  view.querySelector('#btn-crop-apply').addEventListener('click', () => {
    const { x, y, w, h } = cropRect;
    // Math.max(1, Math.round(w)) does not actually guard against w being NaN — Math.max
    // with NaN always returns NaN regardless of the other argument — so a stray NaN
    // reaching here would silently produce a 0-dimension canvas, which is a plausible
    // route to corrupt data reaching the save step later.
    const newCw = Math.max(1, Math.round(w) || 1);
    const newCh = Math.max(1, Math.round(h) || 1);

    const croppedPhoto = document.createElement('canvas');
    croppedPhoto.width = newCw; croppedPhoto.height = newCh;
    croppedPhoto.getContext('2d').drawImage(photoCanvas, x, y, w, h, 0, 0, newCw, newCh);

    const croppedMark = document.createElement('canvas');
    croppedMark.width = newCw; croppedMark.height = newCh;
    croppedMark.getContext('2d').drawImage(markCanvas, x, y, w, h, 0, 0, newCw, newCh);

    cw = newCw; ch = newCh;
    photoCanvas.width = cw; photoCanvas.height = ch;
    markCanvas.width = cw; markCanvas.height = ch;
    previewCanvas.width = cw; previewCanvas.height = ch;
    view.querySelector('#cal-line-svg').setAttribute('viewBox', `0 0 ${cw} ${ch}`);
    photoCtx.drawImage(croppedPhoto, 0, 0);
    ctx.drawImage(croppedMark, 0, 0);

    undoStack = [];
    ruler.cx = cw / 2; ruler.cy = ch / 2;
    resetViewTransform();
    fitCanvas();
    updateRulerVisual();
    updateRulerHandle();
    if (gridState) updateGridVisual();
    exitCropMode();
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
    const W = 600, H = 70, edgeY = 6, tickLen = 18, minorTickLen = 10, midTickLen = 14;
    const ticks = rulerTicks();
    let svg = `<svg width="100%" height="100%" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="display:block; overflow:visible;">`;
    svg += `<rect x="0" y="0" width="${W}" height="${H}" fill="#ffffff" stroke="#1c1f26" stroke-width="1"/>`;
    svg += `<line x1="0" y1="${edgeY}" x2="${W}" y2="${edgeY}" stroke="#c81e1e" stroke-width="2.5"/>`;

    // Intermediate (unlabeled) tick marks between each pair of major ticks — quarter marks,
    // with the halfway mark drawn a little longer, so the ruler reads like a real one for
    // fine measurement/alignment rather than only showing the widely-spaced major values.
    if (ticks.length > 1) {
      const stepFrac = ticks[1].frac - ticks[0].frac;
      for (let i = 0; i < ticks.length - 1; i++) {
        for (let s = 1; s <= 3; s++) {
          const frac = ticks[i].frac + (stepFrac * s) / 4;
          const x = frac * W;
          if (x < 1 || x > W - 1) continue;
          const len = s === 2 ? midTickLen : minorTickLen;
          svg += `<line x1="${x}" y1="${edgeY}" x2="${x}" y2="${edgeY + len}" stroke="#1c1f26" stroke-width="1" opacity="0.55"/>`;
        }
      }
    }

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
    // Displayed with the sign flipped from the raw screen-coordinate angle: on screen, Y
    // increases downward, so tilting the ruler's right side up is naturally a negative
    // angle — but the intuitive reading (up = positive) is the opposite of that.
    view.querySelector('#ruler-angle-readout').textContent = Math.round(-deg) + '°';
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
      pinchState = { startDist: dist, startScale: viewScale };
      return;
    }
    const scaleFactor = pinchState.startDist > 0 ? dist / pinchState.startDist : 1;
    const newScale = Math.min(MAX_ZOOM, Math.max(1, pinchState.startScale * scaleFactor));

    // Zoom anchored on the current pinch midpoint, not the transform's fixed top-left
    // origin — stackEl is flex-centered within its container, so its base layout position
    // isn't known directly, but it can always be derived from the currently-observed
    // rendered rect and the currently-applied translate (rect.left = baseLeft + viewTx
    // always holds, since translate is a simple additive offset), which stays correct
    // regardless of how the centering itself is achieved.
    const rect = stackEl.getBoundingClientRect();
    const baseLeft = rect.left - viewTx;
    const baseTop = rect.top - viewTy;
    const nativeW = rect.width / viewScale;
    const nativeH = rect.height / viewScale;
    const fracX = (mid.x - rect.left) / rect.width;
    const fracY = (mid.y - rect.top) / rect.height;

    viewTx = mid.x - fracX * nativeW * newScale - baseLeft;
    viewTy = mid.y - fracY * nativeH * newScale - baseTop;
    viewScale = newScale;
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
    if (except !== 'arc' && arcMode) {
      arcMode = false;
      view.querySelector('#btn-arc').classList.remove('active');
      arcStart = null;
    }
    if (except !== 'straightLine' && straightLineMode) {
      straightLineMode = false;
      view.querySelector('#btn-straight-line').classList.remove('active');
      straightLineStart = null;
    }
    if (except !== 'text' && textMode) {
      textMode = false;
      view.querySelector('#btn-text-tool').classList.remove('active');
      textPressPoint = null;
    }
    if (except !== 'crop' && cropMode) {
      exitCropMode();
    }
    view.querySelector('#ruler-hint').style.display = except === 'ruler' ? '' : 'none';
    view.querySelector('#zoom-hint').style.display = except === 'ruler' ? 'none' : '';
    touches.clear();
    pinchState = null;
    clearPreview();
    updateLineStyleButtonVisibility();
  }

  // ---- Adjust mode: after placing a Measure arrow or a Text box, it stays live and
  // draggable (rather than committing to pixels immediately) until explicitly confirmed —
  // giving one more chance to nudge it into place. No auto-timeout, matching how every
  // other confirmation in this app works (deliberate, not implicit). ----
  let adjustMode = null; // null | 'measure' | 'text' | 'arc'
  let adjustP1 = null, adjustP2 = null; // measure mode's two endpoints, also arc mode's two endpoints
  let adjustTextAnchor = null, adjustTextArrow = null, adjustTextResult = null; // text mode
  let adjustArcMid = null; // arc mode's bulge point — where the curve is dragged to pass through
  let adjustDragTarget = null; // 'p1' | 'p2' | 'p3' | 'arrow' | 'box'
  let adjustDragPointerId = null;
  let adjustDragBoxOffset = null;

  let adjustTextBoxRect = null;
  function redrawAdjustPreview() {
    clearPreview();
    const boxArea = view.querySelector('#adjust-box-area');
    if (adjustMode === 'measure') {
      boxArea.style.display = 'none';
      drawMeasureArrowOn(previewCtx, adjustP1.x, adjustP1.y, adjustP2.x, adjustP2.y);
      positionAdjustHandle('#adjust-handle-1', adjustP1);
      positionAdjustHandle('#adjust-handle-2', adjustP2);
      positionAdjustHandle('#adjust-handle-3', null);
    } else if (adjustMode === 'arc') {
      boxArea.style.display = 'none';
      drawArcOn(previewCtx, adjustP1, adjustP2, adjustArcMid);
      positionAdjustHandle('#adjust-handle-1', adjustP1);
      positionAdjustHandle('#adjust-handle-2', adjustP2);
      positionAdjustHandle('#adjust-handle-3', adjustArcMid);
    } else if (adjustMode === 'text') {
      const box = drawTextBoxOn(previewCtx, adjustTextAnchor.x, adjustTextAnchor.y, adjustTextResult.text, adjustTextResult);
      adjustTextBoxRect = box; // remembered so the leader handle knows its starting position
      boxArea.style.display = 'block';
      boxArea.style.left = (box.x / cw) * 100 + '%';
      boxArea.style.top = (box.y / ch) * 100 + '%';
      boxArea.style.width = (box.w / cw) * 100 + '%';
      boxArea.style.height = (box.h / ch) * 100 + '%';
      positionAdjustHandle('#adjust-handle-1', null);
      if (adjustTextArrow) {
        const start = rectEdgeIntersection(box.centerX, box.centerY, box.w, box.h, adjustTextArrow.x, adjustTextArrow.y);
        const { headSize, lineWidth } = measureArrowSizing();
        const lineEnd = pullBackForArrowhead(start.x, start.y, adjustTextArrow.x, adjustTextArrow.y, headSize);
        previewCtx.save();
        previewCtx.strokeStyle = currentColor;
        previewCtx.fillStyle = currentColor;
        previewCtx.lineWidth = lineWidth;
        previewCtx.beginPath();
        previewCtx.moveTo(start.x, start.y);
        previewCtx.lineTo(lineEnd.x, lineEnd.y);
        previewCtx.stroke();
        drawArrowheadOn(previewCtx, start.x, start.y, adjustTextArrow.x, adjustTextArrow.y, headSize);
        previewCtx.restore();
        positionAdjustHandle('#adjust-handle-2', adjustTextArrow);
      } else {
        // No leader yet — a small handle sits at the box's corner as the affordance to
        // create one by dragging it outward. Leaving it untouched and tapping Done gives
        // "just a text box" with no leader at all.
        positionAdjustHandle('#adjust-handle-2', { x: box.x + box.w, y: box.y + box.h });
      }
      positionAdjustHandle('#adjust-handle-3', null);
    }
  }

  function positionAdjustHandle(selector, pt) {
    const handle = view.querySelector(selector);
    if (!pt) { handle.style.display = 'none'; return; }
    handle.style.display = 'block';
    handle.style.left = (pt.x / cw) * 100 + '%';
    handle.style.top = (pt.y / ch) * 100 + '%';
  }

  // For a quadratic bezier, the curve's own midpoint is NOT the control point — it's
  // (start + 2*control + end) / 4. Solving that for control means the point the user drags
  // is exactly where the curve visually passes through, rather than an abstract "control
  // point" that doesn't match what's being dragged on screen.
  function computeQuadraticControl(p1, p2, bulgePt) {
    return {
      x: 2 * bulgePt.x - (p1.x + p2.x) / 2,
      y: 2 * bulgePt.y - (p1.y + p2.y) / 2
    };
  }

  function drawArcOn(targetCtx, p1, p2, bulgePt) {
    const control = computeQuadraticControl(p1, p2, bulgePt);
    targetCtx.save();
    targetCtx.strokeStyle = currentColor;
    targetCtx.lineWidth = currentWidth;
    targetCtx.lineCap = 'round';
    targetCtx.setLineDash(getLineDashArray());
    targetCtx.beginPath();
    targetCtx.moveTo(p1.x, p1.y);
    targetCtx.quadraticCurveTo(control.x, control.y, p2.x, p2.y);
    targetCtx.stroke();
    targetCtx.restore();
  }

  function exitAdjustMode() {
    adjustMode = null;
    adjustP1 = null; adjustP2 = null;
    adjustTextAnchor = null; adjustTextArrow = null; adjustTextResult = null;
    adjustArcMid = null;
    adjustDragTarget = null; adjustDragPointerId = null;
    clearPreview();
    hideMagnifier();
    view.querySelector('#main-toolbar').style.display = '';
    view.querySelector('#ruler-toolbar').style.display = '';
    const adjustToolbar = view.querySelector('#adjust-toolbar');
    adjustToolbar.style.display = 'none';
    adjustToolbar.style.paddingTop = '0';
    view.querySelector('#adjust-handle-1').style.display = 'none';
    view.querySelector('#adjust-handle-2').style.display = 'none';
    view.querySelector('#adjust-handle-3').style.display = 'none';
    view.querySelector('#adjust-box-area').style.display = 'none';
  }

  function enterAdjustModeCommon() {
    deactivateOtherModes(null);
    view.querySelector('#main-toolbar').style.display = 'none';
    view.querySelector('#ruler-toolbar').style.display = 'none';
    const adjustToolbar = view.querySelector('#adjust-toolbar');
    adjustToolbar.style.display = '';
    // Same fix as the calibration/crop toolbars: this row skips its own top padding
    // normally (it sits below the main toolbar, which already reserves that space), but
    // hiding that row here makes this one the topmost, so it needs the clearance itself.
    adjustToolbar.style.paddingTop = 'calc(10px + var(--safe-top))';
  }

  function enterMeasureAdjustMode(p1, p2) {
    enterAdjustModeCommon();
    adjustMode = 'measure';
    adjustP1 = { x: p1.x, y: p1.y };
    adjustP2 = { x: p2.x, y: p2.y };
    redrawAdjustPreview();
  }

  function enterTextAdjustMode(boxAnchor, arrowTarget, result) {
    enterAdjustModeCommon();
    adjustMode = 'text';
    adjustTextAnchor = { x: boxAnchor.x, y: boxAnchor.y };
    adjustTextArrow = arrowTarget ? { x: arrowTarget.x, y: arrowTarget.y } : null;
    adjustTextResult = result;
    redrawAdjustPreview();
  }

  function enterArcAdjustMode(p1, p2) {
    enterAdjustModeCommon();
    adjustMode = 'arc';
    adjustP1 = { x: p1.x, y: p1.y };
    adjustP2 = { x: p2.x, y: p2.y };
    adjustArcMid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 }; // starts as a straight line — zero bulge
    redrawAdjustPreview();
  }

  // Commits whatever's currently pending in adjust mode to the real canvas — shared by the
  // Done button and by the annotator's own outer Save button, so tapping Save while an item
  // is still mid-adjustment (only ever drawn on the preview layer, not the real one) can
  // never silently lose it.
  function confirmPendingAdjust() {
    if (adjustMode === 'measure') {
      finalizeMeasureArrow(adjustP1.x, adjustP1.y, adjustP2.x, adjustP2.y);
    } else if (adjustMode === 'arc') {
      pushUndo();
      drawArcOn(ctx, adjustP1, adjustP2, adjustArcMid);
    } else if (adjustMode === 'text') {
      pushUndo();
      const box = drawTextBoxOn(ctx, adjustTextAnchor.x, adjustTextAnchor.y, adjustTextResult.text, adjustTextResult);
      if (adjustTextArrow) {
        const start = rectEdgeIntersection(box.centerX, box.centerY, box.w, box.h, adjustTextArrow.x, adjustTextArrow.y);
        const { headSize, lineWidth } = measureArrowSizing();
        const lineEnd = pullBackForArrowhead(start.x, start.y, adjustTextArrow.x, adjustTextArrow.y, headSize);
        ctx.save();
        ctx.strokeStyle = currentColor;
        ctx.fillStyle = currentColor;
        ctx.lineWidth = lineWidth;
        ctx.beginPath();
        ctx.moveTo(start.x, start.y);
        ctx.lineTo(lineEnd.x, lineEnd.y);
        ctx.stroke();
        drawArrowheadOn(ctx, start.x, start.y, adjustTextArrow.x, adjustTextArrow.y, headSize);
        ctx.restore();
      }
    }
    exitAdjustMode();
  }

  view.querySelector('#btn-adjust-cancel').addEventListener('click', exitAdjustMode);
  view.querySelector('#btn-adjust-done').addEventListener('click', confirmPendingAdjust);

  function wireAdjustHandle(selector, measureTarget) {
    const handle = view.querySelector(selector);
    handle.addEventListener('pointerdown', (e) => {
      adjustDragTarget = measureTarget;
      adjustDragPointerId = e.pointerId;
      try { handle.setPointerCapture(e.pointerId); } catch (err) {}
      const p = canvasPoint(e);
      showMagnifier(p, e.clientX, e.clientY);
      e.preventDefault(); e.stopPropagation();
    });
    handle.addEventListener('pointermove', (e) => {
      if (adjustDragTarget !== measureTarget || e.pointerId !== adjustDragPointerId) return;
      const p = canvasPoint(e);
      if (adjustMode === 'measure') {
        if (measureTarget === 'p1') adjustP1 = p; else adjustP2 = p;
      } else if (adjustMode === 'arc') {
        if (measureTarget === 'p1') adjustP1 = p;
        else if (measureTarget === 'p2') adjustP2 = p;
        else if (measureTarget === 'p3') adjustArcMid = p;
      } else if (adjustMode === 'text') {
        adjustTextArrow = p;
      }
      showMagnifier(p, e.clientX, e.clientY);
      redrawAdjustPreview();
      e.preventDefault(); e.stopPropagation();
    });
    function endDrag(e) {
      if (adjustDragTarget !== measureTarget || e.pointerId !== adjustDragPointerId) return;
      adjustDragTarget = null; adjustDragPointerId = null;
      hideMagnifier();
    }
    handle.addEventListener('pointerup', endDrag);
    handle.addEventListener('pointercancel', endDrag);
  }
  wireAdjustHandle('#adjust-handle-1', 'p1');
  wireAdjustHandle('#adjust-handle-2', 'p2');
  wireAdjustHandle('#adjust-handle-3', 'p3');

  const adjustBoxArea = view.querySelector('#adjust-box-area');
  adjustBoxArea.addEventListener('pointerdown', (e) => {
    adjustDragTarget = 'box';
    adjustDragPointerId = e.pointerId;
    try { adjustBoxArea.setPointerCapture(e.pointerId); } catch (err) {}
    const p = canvasPoint(e);
    adjustDragBoxOffset = { x: p.x - adjustTextAnchor.x, y: p.y - adjustTextAnchor.y };
    showMagnifier(p, e.clientX, e.clientY);
    e.preventDefault(); e.stopPropagation();
  });
  adjustBoxArea.addEventListener('pointermove', (e) => {
    if (adjustDragTarget !== 'box' || e.pointerId !== adjustDragPointerId) return;
    const p = canvasPoint(e);
    adjustTextAnchor = { x: p.x - adjustDragBoxOffset.x, y: p.y - adjustDragBoxOffset.y };
    showMagnifier(p, e.clientX, e.clientY);
    redrawAdjustPreview();
    e.preventDefault(); e.stopPropagation();
  });
  function endBoxDrag(e) {
    if (adjustDragTarget !== 'box' || e.pointerId !== adjustDragPointerId) return;
    adjustDragTarget = null; adjustDragPointerId = null;
    hideMagnifier();
  }
  adjustBoxArea.addEventListener('pointerup', endBoxDrag);
  adjustBoxArea.addEventListener('pointercancel', endBoxDrag);

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
    // Point 1's pending position (before Accept) was previously never shown here — only
    // point 2's was, so the first crosshair stayed invisible until you tapped ✓.
    const p1 = calPoint1 || (calStep === 0 ? calPending : null);
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

    addTarget(p1, calPoint1 ? '#4f9d5c' : '#e0a72e');
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

  // A line drawn at constant width all the way to an arrowhead's exact tip pokes out past
  // the tapering triangle near the point, since the arrowhead narrows to zero width right
  // where the line stays full width — this pulls the line's endpoint back to sit at the
  // arrowhead's base instead, where the triangle is already wide enough to cover it.
  function pullBackForArrowhead(fromX, fromY, toX, toY, headSize) {
    const dx = toX - fromX, dy = toY - fromY;
    const dist = Math.hypot(dx, dy);
    if (dist <= headSize) return { x: fromX, y: fromY };
    const pullback = headSize * 0.85;
    const t = (dist - pullback) / dist;
    return { x: fromX + dx * t, y: fromY + dy * t };
  }

  function clearPreview() { previewCtx.clearRect(0, 0, cw, ch); }

  // ---- Magnifier loupe: shown while a finger is actively placing a point (calibration,
  // Measure, or Text tool) so the exact spot isn't hidden under the fingertip. Reads
  // straight from the canvases' raw pixel buffers, so it's unaffected by any pinch-zoom
  // CSS transform currently applied to the view — always a true fixed zoom of the image
  // itself. Positioned in fixed screen coordinates, offset above or below the touch point
  // (whichever keeps it clear of the hand), never as a child of the transformed stack. ----
  let magnifierEl = null, magnifierCanvas = null, magnifierCtx = null;
  const MAGNIFIER_SIZE = 150; // CSS px diameter on screen
  const MAGNIFIER_ZOOM = 4;

  function ensureMagnifier() {
    if (magnifierEl) return;
    magnifierEl = document.createElement('div');
    magnifierEl.style.cssText = `position:fixed; width:${MAGNIFIER_SIZE}px; height:${MAGNIFIER_SIZE}px; border-radius:50%; border:3px solid #fff; box-shadow:0 4px 16px rgba(0,0,0,0.4); overflow:hidden; pointer-events:none; z-index:99999; display:none;`;
    magnifierCanvas = document.createElement('canvas');
    magnifierCanvas.width = MAGNIFIER_SIZE * 2;
    magnifierCanvas.height = MAGNIFIER_SIZE * 2;
    magnifierCanvas.style.cssText = 'width:100%; height:100%;';
    magnifierEl.appendChild(magnifierCanvas);
    magnifierCtx = magnifierCanvas.getContext('2d');
    document.body.appendChild(magnifierEl);
  }

  function showMagnifier(canvasPt, clientX, clientY) {
    ensureMagnifier();
    magnifierEl.style.display = 'block';

    const offset = 90;
    const showAbove = clientY > window.innerHeight * 0.5;
    const top = showAbove ? clientY - offset - MAGNIFIER_SIZE : clientY + offset;
    const left = clientX - MAGNIFIER_SIZE / 2;
    magnifierEl.style.top = Math.max(8, top) + 'px';
    magnifierEl.style.left = Math.max(8, Math.min(window.innerWidth - MAGNIFIER_SIZE - 8, left)) + 'px';

    const outSize = magnifierCanvas.width;
    const srcSize = outSize / MAGNIFIER_ZOOM;
    const sx = canvasPt.x - srcSize / 2;
    const sy = canvasPt.y - srcSize / 2;

    magnifierCtx.fillStyle = '#f2f3f5';
    magnifierCtx.fillRect(0, 0, outSize, outSize);
    magnifierCtx.drawImage(photoCanvas, sx, sy, srcSize, srcSize, 0, 0, outSize, outSize);
    magnifierCtx.drawImage(markCanvas, sx, sy, srcSize, srcSize, 0, 0, outSize, outSize);

    const c = outSize / 2;
    magnifierCtx.strokeStyle = '#c81e1e';
    magnifierCtx.lineWidth = 2;
    magnifierCtx.beginPath();
    magnifierCtx.moveTo(c - 18, c); magnifierCtx.lineTo(c + 18, c);
    magnifierCtx.moveTo(c, c - 18); magnifierCtx.lineTo(c, c + 18);
    magnifierCtx.stroke();
    magnifierCtx.beginPath();
    magnifierCtx.arc(c, c, 9, 0, Math.PI * 2);
    magnifierCtx.strokeStyle = '#ffffff';
    magnifierCtx.lineWidth = 3;
    magnifierCtx.stroke();
    magnifierCtx.beginPath();
    magnifierCtx.arc(c, c, 9, 0, Math.PI * 2);
    magnifierCtx.strokeStyle = '#c81e1e';
    magnifierCtx.lineWidth = 1.5;
    magnifierCtx.stroke();
  }

  function hideMagnifier() {
    if (magnifierEl) magnifierEl.style.display = 'none';
  }

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
    const totalDist = Math.hypot(x2 - x1, y2 - y1);
    const pullbackEach = headSize * 0.85;
    targetCtx.save();
    targetCtx.globalCompositeOperation = 'source-over';
    targetCtx.strokeStyle = currentColor;
    targetCtx.fillStyle = currentColor;
    targetCtx.lineWidth = lineWidth;
    targetCtx.lineCap = 'round';
    targetCtx.setLineDash(getLineDashArray()); // restore() below cleans this up automatically
    // On a very short arrow, pulling back both ends could make them cross — in that case
    // the two arrowheads alone (drawn below regardless) are enough at this scale, so the
    // connecting line is skipped rather than drawing a glitchy backwards segment.
    if (totalDist > pullbackEach * 2) {
      const lineStart = pullBackForArrowhead(x2, y2, x1, y1, headSize);
      const lineEnd = pullBackForArrowhead(x1, y1, x2, y2, headSize);
      targetCtx.beginPath();
      targetCtx.moveTo(lineStart.x, lineStart.y);
      targetCtx.lineTo(lineEnd.x, lineEnd.y);
      targetCtx.stroke();
    }
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

  // ---- Arc tool: press-drag-release places a plain curved line between two points (no
  // arrowhead, no label), then enters adjust mode with a third handle controlling how far
  // the curve bulges from the straight line between the two endpoints. ----
  let arcMode = false;
  let arcStart = null;
  let arcPointerId = null;
  view.querySelector('#btn-arc').addEventListener('click', (e) => {
    arcMode = !arcMode;
    if (arcMode) {
      deactivateOtherModes('arc');
      e.currentTarget.classList.add('active');
    } else {
      e.currentTarget.classList.remove('active');
    }
    touches.clear();
    pinchState = null;
    arcStart = null;
    clearPreview();
    updateLineStyleButtonVisibility();
  });

  // ---- Straight Line tool: press-drag-release draws a plain straight line directly —
  // unlike Measure/Arc/Text, it commits immediately on release with no adjust step and no
  // confirmation, by design (it's meant to be quick and doesn't need repositioning after
  // the fact the way a labeled arrow or placed text box does). ----
  let straightLineMode = false;
  let straightLineStart = null;
  let straightLinePointerId = null;
  function drawStraightLineOn(targetCtx, x1, y1, x2, y2) {
    targetCtx.save();
    targetCtx.strokeStyle = currentColor;
    targetCtx.lineWidth = currentWidth;
    targetCtx.lineCap = 'round';
    targetCtx.setLineDash(getLineDashArray());
    targetCtx.beginPath();
    targetCtx.moveTo(x1, y1);
    targetCtx.lineTo(x2, y2);
    targetCtx.stroke();
    targetCtx.restore();
  }
  view.querySelector('#btn-straight-line').addEventListener('click', (e) => {
    straightLineMode = !straightLineMode;
    if (straightLineMode) {
      deactivateOtherModes('straightLine');
      e.currentTarget.classList.add('active');
    } else {
      e.currentTarget.classList.remove('active');
    }
    touches.clear();
    pinchState = null;
    straightLineStart = null;
    clearPreview();
    updateLineStyleButtonVisibility();
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
    // tMin scales the RAW (dx,dy) vector to reach the box edge — scaling the NORMALIZED
    // direction by the same factor (as before) landed almost exactly back at the center,
    // which is why the leader line was disappearing behind the text instead of stopping
    // at the box boundary.
    return { x: centerX + dx * tMin, y: centerY + dy * tMin };
  }

  // Word-wraps typed text within maxWidth — splits on explicit line breaks first (paragraph
  // boundaries), then wraps each paragraph's words so no line exceeds maxWidth. Used so a
  // long line can't grow the text box out past the image, which it previously could.
  function wrapTextLines(targetCtx, text, maxWidth) {
    const paragraphs = text.split('\n');
    const wrapped = [];
    paragraphs.forEach((para) => {
      if (para === '') { wrapped.push(''); return; }
      const words = para.split(' ');
      let line = '';
      words.forEach((word) => {
        const test = line ? line + ' ' + word : word;
        if (targetCtx.measureText(test).width > maxWidth && line) {
          wrapped.push(line);
          line = word;
        } else {
          line = test;
        }
      });
      if (line) wrapped.push(line);
    });
    return wrapped;
  }

  function drawTextBoxOn(targetCtx, x, y, text, opts) {
    const { bold, underline, fontSize } = opts;
    const fontWeight = bold ? '800' : '400';
    targetCtx.font = `${fontWeight} ${fontSize}px -apple-system, sans-serif`;
    const maxTextWidth = cw * 0.65; // cap so the box can't grow past the image, regardless of line length
    const lines = wrapTextLines(targetCtx, text, maxTextWidth);
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
          <div class="field"><textarea id="f-text" placeholder="Type a label…" style="min-height:140px;"></textarea></div>
          <div class="field">
            <label>Formatting</label>
            <div class="severity-picker">
              <button class="chip" id="btn-bold" style="font-weight:800; flex:0 0 auto; min-width:52px;">B</button>
              <button class="chip" id="btn-underline" style="text-decoration:underline; flex:0 0 auto; min-width:52px;">U</button>
              <button class="chip" id="btn-size-down" style="flex:0 0 auto; min-width:52px;">A−</button>
              <button class="chip" id="btn-size-up" style="flex:0 0 auto; min-width:52px;">A+</button>
            </div>
            <p class="hint" id="size-readout">Size: ${fontSize}px</p>
          </div>
          <button class="btn btn-primary btn-block" id="btn-place">Place text</button>
          <button class="btn btn-ghost btn-block" id="btn-cancel">Cancel</button>
        </div>
      </div>
    `);
    presentOverlay(sheet);
    const boldBtn = sheet.querySelector('#btn-bold');
    const underlineBtn = sheet.querySelector('#btn-underline');
    function syncToggle(btn, active) {
      btn.classList.toggle('selected', active);
      btn.style.background = active ? 'var(--ink)' : '';
    }
    syncToggle(boldBtn, bold);
    syncToggle(underlineBtn, underline);

    sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.remove(); });
    sheet.querySelector('#btn-cancel').addEventListener('click', () => sheet.remove());
    boldBtn.addEventListener('click', () => { bold = !bold; syncToggle(boldBtn, bold); });
    underlineBtn.addEventListener('click', () => { underline = !underline; syncToggle(underlineBtn, underline); });
    sheet.querySelector('#btn-size-down').addEventListener('click', () => { fontSize = Math.max(14, fontSize - 4); sheet.querySelector('#size-readout').textContent = `Size: ${fontSize}px`; });
    sheet.querySelector('#btn-size-up').addEventListener('click', () => { fontSize = Math.min(72, fontSize + 4); sheet.querySelector('#size-readout').textContent = `Size: ${fontSize}px`; });
    sheet.querySelector('#btn-place').addEventListener('click', () => {
      const text = sheet.querySelector('#f-text').value.trim();
      if (!text) { toast('Enter some text'); return; }
      textBold = bold; textUnderline = underline; textFontSize = fontSize;
      sheet.remove();
      onConfirm({ text, bold, underline, fontSize });
    });
  }

  // Text placement is now a simple tap: box position is the release point, and a leader
  // (if wanted at all) is added afterward from within adjust mode — see the leader handle
  // wired into redrawAdjustPreview / wireAdjustHandle below.
  function finalizeTextPlacement(releasePt) {
    openTextEntrySheet((result) => {
      enterTextAdjustMode(releasePt, null, result);
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

  // ---- Pen type rendering ----
  function hexToRgb(hex) {
    const m = /^#([0-9a-f]{6})$/i.exec(hex);
    if (!m) return [28, 31, 38];
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function drawAirbrushSegment(fromX, fromY, toX, toY, width) {
    const dist = Math.hypot(toX - fromX, toY - fromY);
    const steps = Math.max(1, Math.round(dist / 3));
    const rgb = hexToRgb(currentColor);
    const radius = Math.max(4, width);
    for (let i = 0; i <= steps; i++) {
      const t = steps === 0 ? 0 : i / steps;
      const cx = fromX + (toX - fromX) * t + (Math.random() - 0.5) * radius * 0.6;
      const cy = fromY + (toY - fromY) * t + (Math.random() - 0.5) * radius * 0.6;
      const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
      grad.addColorStop(0, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.22)`);
      grad.addColorStop(1, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0)`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function fountainWidthsForCurrent() {
    const customActive = view.querySelector('#w-custom').classList.contains('active');
    if (customActive) return { avg: fountainAvgWidth, max: fountainMaxWidth };
    return { avg: currentWidth, max: currentWidth * 2.5 };
  }

  function drawFountainSegment(fromX, fromY, toX, toY) {
    const { avg, max } = fountainWidthsForCurrent();
    const nibAngle = Math.PI / 4; // fixed 45° nib, classic calligraphy variation
    const angle = Math.atan2(toY - fromY, toX - fromX);
    const w = avg + (max - avg) * Math.abs(Math.sin(angle - nibAngle));
    ctx.strokeStyle = currentColor;
    ctx.lineWidth = w;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    applyLineStyle();
    ctx.lineDashOffset = -strokeDashDistance;
    ctx.beginPath();
    ctx.moveTo(fromX, fromY);
    ctx.lineTo(toX, toY);
    ctx.stroke();
    strokeDashDistance += Math.hypot(toX - fromX, toY - fromY);
    resetLineStyle();
  }

  let smoothPoints = [];
  function drawSmoothingSegment(p, width) {
    smoothPoints.push(p);
    if (smoothPoints.length > 3) smoothPoints.shift();
    if (smoothPoints.length < 3) return;
    const [p0, p1, p2] = smoothPoints;
    const midA = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
    const midB = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
    // Previously relied on whatever strokeStyle/lineWidth the canvas context happened to
    // still be set to from an unrelated prior operation, rather than the currently
    // selected color/width — set explicitly here instead.
    ctx.strokeStyle = currentColor;
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    applyLineStyle();
    ctx.lineDashOffset = -strokeDashDistance;
    ctx.beginPath();
    ctx.moveTo(midA.x, midA.y);
    ctx.quadraticCurveTo(p1.x, p1.y, midB.x, midB.y);
    ctx.stroke();
    strokeDashDistance += Math.hypot(midB.x - midA.x, midB.y - midA.y);
    resetLineStyle();
  }

  // ---- Hold-to-straighten: holding the pen still for ~1s while drawing redraws the whole
  // stroke as a single straight line from where it started to the held point. ----
  let strokeStartPoint = null;
  let preStrokeSnapshot = null;
  let holdStraightenTimer = null;
  const HOLD_STRAIGHTEN_MS = 1000;

  // A freehand stroke is built from many short segments (one per coalesced pointer event,
  // often just a few pixels each) rather than one continuous path — without this, a dash
  // pattern set fresh on each tiny segment always restarts at its "on" phase and never
  // reaches the "gap" before the segment ends, so the whole stroke renders solid regardless
  // of the selected style. Tracking cumulative distance and offsetting the dash phase by it
  // makes the pattern continue seamlessly across segments instead.
  let strokeDashDistance = 0;

  function clearHoldStraightenTimer() {
    if (holdStraightenTimer) { clearTimeout(holdStraightenTimer); holdStraightenTimer = null; }
  }
  function resetHoldStraightenTimer() {
    clearHoldStraightenTimer();
    if (eraseMode || !strokeStartPoint) return;
    holdStraightenTimer = setTimeout(() => {
      if (!drawing || !strokeStartPoint || !preStrokeSnapshot) return;
      ctx.putImageData(preStrokeSnapshot, 0, 0);
      drawStrokeSegment(strokeStartPoint.x, strokeStartPoint.y, lastX, lastY, 0.6);
      smoothPoints = [strokeStartPoint, { x: lastX, y: lastY }];
    }, HOLD_STRAIGHTEN_MS);
  }

  // Draws one segment using whichever pen type is currently active — shared by normal
  // drawing and by the hold-to-straighten redraw above.
  function drawStrokeSegment(fromX, fromY, toX, toY, pressure) {
    const w = currentWidth * (0.5 + pressure);
    if (currentPenType === 'airbrush') { drawAirbrushSegment(fromX, fromY, toX, toY, w); return; }
    if (currentPenType === 'fountain') { drawFountainSegment(fromX, fromY, toX, toY); return; }
    if (currentPenType === 'smoothing') { drawSmoothingSegment({ x: toX, y: toY }, w); return; }
    ctx.strokeStyle = currentColor;
    ctx.lineWidth = w;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    applyLineStyle();
    ctx.lineDashOffset = -strokeDashDistance;
    ctx.beginPath();
    ctx.moveTo(fromX, fromY);
    ctx.lineTo(toX, toY);
    ctx.stroke();
    strokeDashDistance += Math.hypot(toX - fromX, toY - fromY);
    resetLineStyle();
  }

  function startStroke(e) {
    try { markCanvas.setPointerCapture(e.pointerId); } catch (err) {}
    preStrokeSnapshot = ctx.getImageData(0, 0, cw, ch);
    pushUndo();
    drawing = true;
    drawingPointerId = e.pointerId;
    const p = projectOntoRuler(canvasPoint(e));
    lastX = p.x; lastY = p.y;
    strokeStartPoint = { x: p.x, y: p.y };
    strokeDashDistance = 0;
    smoothPoints = [p];
    const pressure = e.pressure && e.pressure > 0 ? e.pressure : 0.5;
    const w = eraseMode ? currentWidth * 3 : currentWidth * (0.5 + pressure);
    ctx.globalCompositeOperation = eraseMode ? 'destination-out' : 'source-over';
    ctx.fillStyle = currentColor;
    ctx.beginPath();
    ctx.arc(p.x, p.y, w / 2, 0, Math.PI * 2);
    ctx.fill();
    resetHoldStraightenTimer();
  }

  function continueStroke(e) {
    const events = (typeof e.getCoalescedEvents === 'function' && e.getCoalescedEvents().length) ? e.getCoalescedEvents() : [e];
    for (const ev of events) {
      const p = projectOntoRuler(canvasPoint(ev));
      const pressure = ev.pressure && ev.pressure > 0 ? ev.pressure : 0.5;
      ctx.globalCompositeOperation = eraseMode ? 'destination-out' : 'source-over';
      if (eraseMode) {
        const w = currentWidth * 3;
        ctx.strokeStyle = currentColor;
        ctx.lineWidth = w;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.setLineDash([]); // erasing should always be a complete stroke, never dashed, regardless of the selected line style
        ctx.beginPath();
        ctx.moveTo(lastX, lastY);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
      } else {
        drawStrokeSegment(lastX, lastY, p.x, p.y, pressure);
      }
      lastX = p.x; lastY = p.y;
    }
    resetHoldStraightenTimer();
  }

  const touches = new Map(); // pointerId -> {cx, cy, x, y}

  markCanvas.addEventListener('pointerdown', (e) => {
    if (cropMode) { e.preventDefault(); return; } // crop handles/border have their own listeners with stopPropagation
    if (adjustMode) { e.preventDefault(); return; } // adjust handles/box-area have their own listeners with stopPropagation
    if (calibrating) {
      if (e.pointerType === 'touch') {
        const p = canvasPoint(e);
        touches.set(e.pointerId, { cx: e.clientX, cy: e.clientY, x: p.x, y: p.y });
        if (touches.size >= 2) { updatePinch(); e.preventDefault(); return; }
      }
      calPending = canvasPoint(e);
      showMagnifier(calPending, e.clientX, e.clientY);
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
      showMagnifier(measureStart, e.clientX, e.clientY);
      e.preventDefault();
      return;
    }

    if (arcMode) {
      if (e.pointerType === 'touch') {
        const p = canvasPoint(e);
        touches.set(e.pointerId, { cx: e.clientX, cy: e.clientY, x: p.x, y: p.y });
        if (touches.size >= 2) { arcStart = null; clearPreview(); updatePinch(); e.preventDefault(); return; }
      }
      arcStart = canvasPoint(e);
      arcPointerId = e.pointerId;
      showMagnifier(arcStart, e.clientX, e.clientY);
      e.preventDefault();
      return;
    }

    if (straightLineMode) {
      if (e.pointerType === 'touch') {
        const p = canvasPoint(e);
        touches.set(e.pointerId, { cx: e.clientX, cy: e.clientY, x: p.x, y: p.y });
        if (touches.size >= 2) { straightLineStart = null; clearPreview(); updatePinch(); e.preventDefault(); return; }
      }
      straightLineStart = canvasPoint(e);
      straightLinePointerId = e.pointerId;
      showMagnifier(straightLineStart, e.clientX, e.clientY);
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
      showMagnifier(textPressPoint, e.clientX, e.clientY);
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
    if (cropMode) { e.preventDefault(); return; }
    if (adjustMode) { e.preventDefault(); return; }
    if (calibrating) {
      if (e.pointerType === 'touch' && touches.has(e.pointerId)) {
        const p = canvasPoint(e);
        touches.set(e.pointerId, { cx: e.clientX, cy: e.clientY, x: p.x, y: p.y });
        if (touches.size >= 2) { updatePinch(); e.preventDefault(); return; }
      }
      if (e.pointerType === 'pen' || e.pointerType === 'mouse' || (e.pointerType === 'touch' && touches.size === 1)) {
        calPending = canvasPoint(e);
        showMagnifier(calPending, e.clientX, e.clientY);
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
        showMagnifier(p, e.clientX, e.clientY);
      }
      e.preventDefault();
      return;
    }

    if (arcMode) {
      if (e.pointerType === 'touch' && touches.has(e.pointerId)) {
        const p = canvasPoint(e);
        touches.set(e.pointerId, { cx: e.clientX, cy: e.clientY, x: p.x, y: p.y });
        if (touches.size >= 2) { updatePinch(); e.preventDefault(); return; }
      }
      if (arcStart && e.pointerId === arcPointerId) {
        const p = canvasPoint(e);
        clearPreview();
        previewCtx.save();
        previewCtx.strokeStyle = currentColor;
        previewCtx.lineWidth = currentWidth;
        previewCtx.lineCap = 'round';
        previewCtx.setLineDash([8, 6]);
        previewCtx.beginPath();
        previewCtx.moveTo(arcStart.x, arcStart.y);
        previewCtx.lineTo(p.x, p.y);
        previewCtx.stroke();
        previewCtx.restore();
        showMagnifier(p, e.clientX, e.clientY);
      }
      e.preventDefault();
      return;
    }

    if (straightLineMode) {
      if (e.pointerType === 'touch' && touches.has(e.pointerId)) {
        const p = canvasPoint(e);
        touches.set(e.pointerId, { cx: e.clientX, cy: e.clientY, x: p.x, y: p.y });
        if (touches.size >= 2) { updatePinch(); e.preventDefault(); return; }
      }
      if (straightLineStart && e.pointerId === straightLinePointerId) {
        const p = canvasPoint(e);
        clearPreview();
        // Shows the actual line style live while dragging, since this tool commits
        // directly on release with no adjust step — reusing the same draw function the
        // final bake uses guarantees the preview always matches the real result exactly.
        drawStraightLineOn(previewCtx, straightLineStart.x, straightLineStart.y, p.x, p.y);
        showMagnifier(p, e.clientX, e.clientY);
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
        showMagnifier(p, e.clientX, e.clientY);
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
    hideMagnifier();
    if (e.pointerType === 'touch') {
      touches.delete(e.pointerId);
      if (touches.size < 2) pinchState = null;
    }
    if (measureMode && measureStart && e.pointerId === measurePointerId) {
      const p = canvasPoint(e);
      clearPreview();
      if (Math.hypot(p.x - measureStart.x, p.y - measureStart.y) >= 4) {
        enterMeasureAdjustMode(measureStart, p);
      }
      measureStart = null;
      measurePointerId = null;
    }
    if (arcMode && arcStart && e.pointerId === arcPointerId) {
      const p = canvasPoint(e);
      clearPreview();
      if (Math.hypot(p.x - arcStart.x, p.y - arcStart.y) >= 4) {
        enterArcAdjustMode(arcStart, p);
      }
      arcStart = null;
      arcPointerId = null;
    }
    if (straightLineMode && straightLineStart && e.pointerId === straightLinePointerId) {
      const p = canvasPoint(e);
      clearPreview();
      hideMagnifier();
      if (Math.hypot(p.x - straightLineStart.x, p.y - straightLineStart.y) >= 4) {
        pushUndo();
        drawStraightLineOn(ctx, straightLineStart.x, straightLineStart.y, p.x, p.y);
      }
      straightLineStart = null;
      straightLinePointerId = null;
    }
    if (textMode && textPressPoint && e.pointerId === textPointerId) {
      const p = canvasPoint(e);
      clearPreview();
      finalizeTextPlacement(p);
      textPressPoint = null;
      textPointerId = null;
    }
    if (e.pointerId !== drawingPointerId) return;
    drawing = false;
    drawingPointerId = null;
    clearHoldStraightenTimer();
    strokeStartPoint = null;
    preStrokeSnapshot = null;
    try { markCanvas.releasePointerCapture(e.pointerId); } catch (err) {}
  }
  markCanvas.addEventListener('pointerup', endStroke);
  markCanvas.addEventListener('pointercancel', endStroke);
  markCanvas.addEventListener('pointerleave', endStroke);

  function removeMagnifierEl() {
    if (magnifierEl) { magnifierEl.remove(); magnifierEl = null; magnifierCanvas = null; magnifierCtx = null; }
  }

  view.querySelector('#btn-cancel').addEventListener('click', () => {
    window.removeEventListener('resize', fitCanvas);
    removeMagnifierEl();
    view.remove();
  });

  function buildMergedBlob() {
    return new Promise((resolve) => {
      const mergeCanvas = document.createElement('canvas');
      mergeCanvas.width = cw;
      mergeCanvas.height = ch;
      const mergeCtx = mergeCanvas.getContext('2d');
      mergeCtx.drawImage(photoCanvas, 0, 0);
      mergeCtx.drawImage(markCanvas, 0, 0);
      mergeCanvas.toBlob((blob) => resolve(blob), 'image/jpeg', 0.92);
    });
  }

  view.querySelector('#btn-save-editable').addEventListener('click', async () => {
    if (adjustMode) confirmPendingAdjust();
    const mergedBlob = await buildMergedBlob();
    if (!mergedBlob) { toast('Could not prepare the image to save — nothing was lost, please try again'); return; }
    // PNG specifically, not JPEG — this layer needs to keep its transparency (including
    // areas removed with the eraser) intact for when it's reloaded and edited further.
    markCanvas.toBlob(async (markBlob) => {
      if (!markBlob) { toast('Could not prepare the image to save — nothing was lost, please try again'); return; }
      try {
        await DB.saveEditableAnnotation(photoId, mergedBlob, markBlob);
      } catch (err) {
        console.error('Save failed', err);
        toast('Save failed — your edits are still here, please try again');
        return;
      }
      window.removeEventListener('resize', fitCanvas);
      removeMagnifierEl();
      view.remove();
      if (onDone) onDone();
    }, 'image/png');
  });

  view.querySelector('#btn-save').addEventListener('click', async () => {
    if (adjustMode) confirmPendingAdjust(); // never leave a pending measure/text item unsaved
    const blob = await buildMergedBlob();
    if (!blob) {
      toast('Could not prepare the image to save — nothing was lost, please try again');
      return;
    }
    try {
      await DB.setAnnotatedBlob(photoId, blob);
    } catch (err) {
      console.error('Save failed', err);
      toast('Save failed — your edits are still here, please try again');
      return; // keep the annotator open rather than losing the user's work
    }
    window.removeEventListener('resize', fitCanvas);
    removeMagnifierEl();
    view.remove();
    if (onDone) onDone();
  });
}
