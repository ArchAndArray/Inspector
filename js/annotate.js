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

  const IC = (() => {
    const mk = (d, extra) => `<svg class="ic2" viewBox="0 0 24 24" aria-hidden="true"${extra || ''}>${d}</svg>`;
    return {
      back: mk('<path d="M15 5l-7 7 7 7"/>'), down: mk('<path d="M6 9l6 6 6-6"/>'),
      undo: mk('<path d="M9 14L4 9l5-5 M4 9h10a6 6 0 0 1 0 12h-3"/>'), redo: mk('<path d="M15 14l5-5-5-5 M20 9H10a6 6 0 0 0 0 12h3"/>'),
      pen: mk('<path d="M4 20l1-4L16 5l3 3L8 19z M14 7l3 3"/>'), eraser: mk('<path d="M5 15l8-9 6 6-6 7H9z M9 21h11"/>'),
      line: mk('<path d="M5 19L19 5"/>'), arc: mk('<path d="M4 18C6 8 18 8 20 18"/>'), text: mk('<path d="M5 6V4h14v2 M12 4v16 M9 20h6"/>'),
      measure: mk('<path d="M3 8v8 M21 8v8 M3 12h18 M6 10l-3 2 3 2 M18 10l3 2-3 2"/>'), ruler: mk('<path d="M3 15L15 3l6 6L9 21z M7 13l2 2 M10 10l2 2 M13 7l2 2"/>'),
      crop: mk('<path d="M6 2v16h16 M2 6h16v16"/>'), rotate: mk('<path d="M20 11a8 8 0 1 0-2 6 M20 4v7h-7"/>'),
      more: mk('<path d="M5 12h.01 M12 12h.01 M19 12h.01" stroke-width="3.2"/>'), photo: mk('<path d="M4 7h11v11H4z M4 15l3-3 3 3 M19 3v6 M16 6h6"/>'),
      grid: mk('<path d="M4 4h16v16H4z M4 9.3h16 M4 14.7h16 M9.3 4v16 M14.7 4v16"/>'), sliders: mk('<path d="M4 7h10 M18 7h2 M4 17h2 M10 17h10 M14 5v4 M6 15v4"/>'),
      grip: mk('<path d="M8 7h.01 M16 7h.01 M8 12h.01 M16 12h.01 M8 17h.01 M16 17h.01" stroke-width="3"/>'),
      arrow: mk('<path d="M5 19L18 6 M9 6h9v9"/>'), ellipse: mk('<ellipse cx="12" cy="12" rx="8.5" ry="6"/>'), rect: mk('<rect x="4" y="6" width="16" height="12" rx="1"/>'),
      num: mk('<circle cx="12" cy="12" r="8.5"/><path d="M10.5 9.5L12.6 8v8"/>'), eye: mk('<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'), eyeoff: mk('<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><path d="M4 4l16 16"/>'), lock: mk('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>'), unlock: mk('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 7-2.6"/>'), up: mk('<path d="M6 15l6-6 6 6"/>'), trash: mk('<path d="M5 7h14 M9 7V4h6v3 M7 7l1 13h8l1-13"/>'), plus: mk('<path d="M12 5v14M5 12h14"/>'), pencil: mk('<path d="M4 20l1-4L16 5l3 3L8 19z"/>'), layers: mk('<path d="M12 3l9 5-9 5-9-5z M3 13l9 5 9-5"/>'), bucket: mk('<path d="M6 11l6-6 7 7-6 6a2 2 0 0 1-3 0z M5 12h14"/><path d="M20 15c1 1.6 1.6 2.6 1.6 3.4a1.6 1.6 0 0 1-3.2 0c0-.8.6-1.8 1.6-3.4z"/>'), select: mk('<path d="M6 3l12 8-5.5 1.5L9.5 18z"/>'), shapes: mk('<rect x="3.5" y="3.5" width="9" height="9" rx="1.5"/><circle cx="15.5" cy="15.5" r="5"/>'),
      widths: mk('<path d="M4 6h16 M4 12h16 M4 18h16" stroke-width="1.5"/><path d="M4 12h16" stroke-width="3.5"/><path d="M4 18h16" stroke-width="5.5"/>')
    };
  })();

  const view = el(`
    <div class="fullscreen" id="annotate-view">
      <div class="annotate-toolbar atb2-top" id="main-toolbar">
        <button class="atb2-btn" id="btn-cancel" title="Back" aria-label="Back">${IC.back}</button>
        <button class="atb2-btn" id="btn-undo" title="Undo (or tap with two fingers)" aria-label="Undo">${IC.undo}</button>
        <button class="atb2-btn" id="btn-redo" title="Redo" aria-label="Redo">${IC.redo}</button>
        <div class="atb2-status">
          <span id="ruler-angle-readout" style="display:none; font-weight:700; color:#fff; margin-right:8px;">0°</span>
          <span id="ruler-hint" style="display:none;">Two fingers: move &amp; rotate · pull the dot to resize</span>
          <span id="zoom-hint">Two fingers to zoom · two-finger tap to undo</span>
        </div>
        <button class="atb2-chip" id="btn-layers" title="Layers and tracing paper" aria-label="Layers">${IC.layers}<span>Layers</span></button>
        <button class="atb2-chip" id="btn-layer-toggle" style="display:none;" title="Choose what you are editing: pen marks, or text and measurements">Pen layer</button>
        <button class="atb2-chip atb2-primary" id="btn-done" title="Save or discard">Done ${IC.down}</button>
      </div>
      <div id="ruler-toolbar" class="atb2-float">
        <div class="tool-island" id="tool-island">
          <button class="isl-grip" id="isl-grip" title="Drag to move the tools · tap to collapse" aria-label="Move or collapse the tools">${IC.grip}</button>
          <div class="isl-items" id="isl-items">
            <button class="tool-btn isl-btn" id="btn-pen-tool" title="Pen" aria-label="Pen">${IC.pen}</button>
            <button class="tool-btn isl-btn" id="btn-erase" title="Eraser" aria-label="Eraser">${IC.eraser}</button>
            <button class="tool-btn isl-btn" id="btn-bucket" title="Fill: tap inside a closed outline to colour it in" aria-label="Fill area">${IC.bucket}</button>
            <button class="tool-btn isl-btn" id="btn-select" title="Select: tap a drawing to move, resize, turn, copy or delete it. Drag on empty space to select several." aria-label="Select">${IC.select}</button>
            <div class="isl-div"></div>
            <button class="tool-btn isl-btn" id="btn-shapes" title="Lines and shapes: line, curve, arrow, circle, box" aria-label="Lines and shapes">${IC.shapes}</button>
            <button class="tool-btn isl-btn" id="btn-num" title="Numbered marker: tap to drop 1, 2, 3 ..." aria-label="Numbered marker">${IC.num}</button>
            <button class="tool-btn isl-btn" id="btn-text-tool" title="Text — tap for a text box, drag for a text box with an arrow (callout)" aria-label="Text or callout">${IC.text}</button>
            <div class="isl-div"></div>
            <button class="tool-btn isl-btn" id="btn-measure" title="Measure" aria-label="Measure">${IC.measure}</button>
            <button class="tool-btn isl-btn" id="btn-ruler" title="Ruler" aria-label="Ruler">${IC.ruler}</button>
            <button class="tool-btn isl-btn isl-snap" id="btn-ruler-snap" title="Snap / Free rotation" style="display:none;">Snap</button>
            <div class="isl-div"></div>
            <button class="tool-btn isl-btn" id="btn-crop" title="Crop" aria-label="Crop">${IC.crop}</button>
            <button class="tool-btn isl-btn" id="btn-rotate" title="Rotate" aria-label="Rotate">${IC.rotate}</button>
            <button class="tool-btn isl-btn" id="btn-more" title="More: photo, grid, calibrate, pen settings" aria-label="More">${IC.more}</button>
          </div>
        </div>
        <div class="more-pop" id="shapes-pop" style="display:none;">
          <button class="more-item" id="btn-straight-line">${IC.line}<span>Straight line</span></button>
          <button class="more-item" id="btn-arc">${IC.arc}<span>Curved line</span></button>
          <button class="more-item" id="btn-shape-arrow">${IC.arrow}<span>Arrow</span></button>
          <button class="more-item" id="btn-shape-ellipse">${IC.ellipse}<span>Circle / oval</span></button>
          <button class="more-item" id="btn-shape-rect">${IC.rect}<span>Box</span></button>
        </div>
        <div class="more-pop" id="more-pop" style="display:none;">
          <button class="more-item" id="btn-insert-photo">${IC.photo}<span>Insert photo</span></button>
          <button class="more-item" id="btn-snap">${IC.grid}<span>Snap: off</span></button>
          <button class="more-item" id="btn-grid">${IC.grid}<span>Grid</span></button>
          <button class="more-item" id="btn-calibrate">${IC.measure}<span>Calibrate scale</span></button>
          <button class="more-item" id="btn-pen-settings">${IC.sliders}<span>Pen settings</span></button>
        </div>
        <div class="pen-strip" id="pen-strip">
          <div class="strip-row" id="color-row-fixed">
            ${ANNOTATE_COLORS.map((c, i) => `<div class="color-dot ${i === 0 ? 'active' : ''}" data-color="${c}" style="background:${c};"></div>`).join('')}
          </div>
          <div class="strip-row" id="color-row-custom" title="Tap a + circle to save your own colour; hold a saved one to change it">
            ${[0, 1, 2, 3, 4].map((i) => `<div class="color-dot color-dot-custom" data-custom-index="${i}" style="background:#e8e9ec; border:1.5px dashed #b8bcc4;"></div>`).join('')}
          </div>
          <div class="strip-row">
            <button class="tool-btn" id="w-thin" title="Thin">•</button>
            <button class="tool-btn active" id="w-medium" title="Medium">●</button>
            <button class="tool-btn" id="w-thick" title="Thick">⬤</button>
            <button class="tool-btn" id="w-custom" title="Custom width — tap to use, hold to change">${IC.widths}</button>
            <button class="tool-btn" id="btn-line-style" title="Line style — tap to choose" style="display:none;">
              <svg width="20" height="16" viewBox="0 0 24 16" xmlns="http://www.w3.org/2000/svg"><line x1="2" y1="8" x2="22" y2="8" stroke="currentColor" stroke-width="2.4" stroke-dasharray="5,3.5" stroke-linecap="round"/></svg>
            </button>
          </div>
          <div class="strip-row" id="marker-row" style="display:none;">
            <span class="strip-lab">Marker number</span>
            <button class="tool-btn" id="mk-minus" aria-label="Previous number">−</button>
            <span class="strip-num" id="mk-label">1</span>
            <button class="tool-btn" id="mk-plus" aria-label="Next number">+</button>
          </div>
          <div class="strip-row strip-types">
            <button class="tool-btn pen-type-btn active" data-pentype="pen" title="Pencil">Pencil</button>
            <button class="tool-btn pen-type-btn" data-pentype="airbrush" title="Airbrush">Air</button>
            <button class="tool-btn pen-type-btn" data-pentype="fountain" title="Fountain pen">Ink</button>
            <button class="tool-btn pen-type-btn" data-pentype="smoothing" title="Smoothing pen">Smooth</button>
            <button class="tool-btn pen-type-btn" data-pentype="highlighter" title="Highlighter (see-through)">Highlight</button>
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
          <canvas id="annotation-under-canvas" width="${cw}" height="${ch}" style="display:block; width:100%; height:100%; position:absolute; top:0; left:0; pointer-events:none;"></canvas>
          <canvas id="mark-canvas" width="${cw}" height="${ch}" style="display:block; width:100%; height:100%; position:absolute; top:0; left:0;"></canvas>
          <canvas id="annotation-canvas" width="${cw}" height="${ch}" style="display:block; width:100%; height:100%; position:absolute; top:0; left:0;"></canvas>
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
      <div id="save-actions" style="display:none;">
        <button id="btn-save-editable" type="button">Save (editable)</button>
        <button id="btn-save" type="button">Flatten &amp; save</button>
      </div>
    </div>
  `);
  presentOverlay(view);

  const photoCanvas = view.querySelector('#photo-canvas');
  const markCanvas = view.querySelector('#mark-canvas');
  const annotationCanvas = view.querySelector('#annotation-canvas');
  const underCanvas = view.querySelector('#annotation-under-canvas'); // text / measurements / photos set to sit BEHIND the pen marks
  const underCtx = underCanvas.getContext('2d');
  const previewCanvas = view.querySelector('#preview-canvas');
  const previewCtx = previewCanvas.getContext('2d');
  const rulerVisual = view.querySelector('#ruler-visual');
  const rulerHandle = view.querySelector('#ruler-handle');
  const gridVisual = view.querySelector('#grid-visual');
  const stackEl = view.querySelector('#canvas-stack');
  markCanvas.style.touchAction = 'none';
  annotationCanvas.style.touchAction = 'none';
  const photoCtx = photoCanvas.getContext('2d');
  const ctx = markCanvas.getContext('2d');
  // The mark layer is now: a base picture (marks saved by older versions, and nothing else) plus a list of editable strokes
  // drawn on top of it. markCanvas always shows the two together, so everything that reads it (magnifier, save) still works.
  const baseCanvas = document.createElement('canvas');
  baseCanvas.width = cw; baseCanvas.height = ch;
  const baseCtx = baseCanvas.getContext('2d');
  const hist = Ink.makeHistory(Ink.unpack(photo.editableStrokes));
  let editedSinceOpen = false, marksRenderedOnce = false;
  let shapeMode = null, shapeStart = null, shapePointerId = null, markerOverride = null; // arrow | ellipse | rect | num
  // Layers: every drawing belongs to one layer (stroke.ly). The photo / paper sits underneath and can be faded (tracing paper).
  const meta0 = photo.editableMeta || {};
  let layers = (Array.isArray(meta0.layers) && meta0.layers.length ? meta0.layers : [{ id: 'l1', name: 'Layer 1' }]).map((l) => ({ id: l.id, name: l.name || 'Layer', vis: l.vis !== false, lock: !!l.lock, op: l.op == null ? 1 : l.op }));
  let activeLayerId = layers.some((l) => l.id === meta0.active) ? meta0.active : layers[layers.length - 1].id;
  const bg = { vis: !(meta0.bg && meta0.bg.vis === false), op: meta0.bg && meta0.bg.op != null ? meta0.bg.op : 1 };
  const layerOf = (s) => layers.find((l) => l.id === s.ly) || layers[0];
  const activeLayer = () => layers.find((l) => l.id === activeLayerId) || layers[0];
  const simpleLayers = () => layers.length === 1 && layers[0].vis && layers[0].op === 1;
  let layerTmp = null;
  let bucketMode = false, bucketStart = null, bucketPid = null, selIds = [], selBox = null;
  let selectMode = false, selId = null, selDrag = null, selPointerId = null, selRaf = 0, snapOn = false; // Select tool + snapping
  function renderMarks() {
    if (marksRenderedOnce) editedSinceOpen = true; marksRenderedOnce = true;
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, cw, ch);
    if (simpleLayers()) { ctx.drawImage(baseCanvas, 0, 0); ctx.restore(); Ink.renderAll(ctx, hist.strokes); }
    else {
      // each layer is drawn on its own, so the eraser only rubs out its own layer, then they are stacked bottom to top
      if (!layerTmp || layerTmp.width !== cw || layerTmp.height !== ch) { layerTmp = document.createElement('canvas'); layerTmp.width = cw; layerTmp.height = ch; }
      const tc = layerTmp.getContext('2d');
      layers.forEach((l, i) => {
        if (!l.vis) return;
        tc.setTransform(1, 0, 0, 1, 0, 0); tc.globalAlpha = 1; tc.globalCompositeOperation = 'source-over'; tc.clearRect(0, 0, cw, ch);
        if (i === 0) tc.drawImage(baseCanvas, 0, 0);
        Ink.renderAll(tc, hist.strokes.filter((st) => layerOf(st) === l));
        ctx.globalAlpha = l.op; ctx.drawImage(layerTmp, 0, 0);
      });
      ctx.globalAlpha = 1; ctx.restore();
    }
    updateUndoButtons();
    if (selectMode) refreshSelection();
  }
  function updateUndoButtons() {
    const u = view.querySelector('#btn-undo'), r = view.querySelector('#btn-redo');
    if (u) u.style.opacity = hist.strokes.length ? '1' : '0.45';
    if (r) r.style.opacity = hist.redoCount ? '1' : '0.45';
    updateMarkerLabel();
  }
  function addStroke(s) {
    if (!s.ly) s.ly = activeLayerId;
    hist.add(s); updateUndoButtons();
    // with several layers, what was just drawn live on top is re-stacked in its proper layer
    if (!simpleLayers()) requestAnimationFrame(renderMarks);
    return s;
  }
  // ---- pen preferences (remembered on this iPad) ----
  const INK_PREFS_KEY = 'annotate.inkPrefs';
  const inkPrefs = Object.assign({ streamline: 0.3, curve: 'normal', finger: 'auto', twoTapUndo: true, holdStraighten: true }, (() => { try { return JSON.parse(localStorage.getItem(INK_PREFS_KEY) || '{}'); } catch (err) { return {}; } })());
  const saveInkPrefs = () => { try { localStorage.setItem(INK_PREFS_KEY, JSON.stringify(inkPrefs)); } catch (err) { /* ignore */ } };
  const annotationCtx = annotationCanvas.getContext('2d');

  // ============================================================================
  // Annotation layer: Text and Measure objects live here as persistent, editable
  // data (position, content, endpoints) rather than baked pixels — unlike every
  // other tool, which still commits straight to the Drawing layer (mark-canvas)
  // exactly as before. Always renders on top of the Drawing layer. Reuses the
  // exact same drawTextBoxOn/drawMeasureArrowOn functions used for fresh
  // placement, so a re-rendered object looks pixel-identical to how it always
  // has — this isn't a new rendering system, just a new place these two
  // specific tools' output lives and gets redrawn from.
  // ============================================================================
  let annotationObjects = (photo.annotationObjects || []).map((o) => ({ ...o }));
  let annotationLayerActive = false;
  let adjustEditingObjectId = null; // set when adjust-mode is editing an existing object rather than placing a new one

  async function renderAnnotationLayer() {
    annotationCtx.clearRect(0, 0, cw, ch); underCtx.clearRect(0, 0, cw, ch);
    for (const obj of annotationObjects) {
      const tgt = obj.behind ? underCtx : annotationCtx;
      if (adjustEditingObjectId === obj.id) continue; // being actively edited — drawn on the preview layer instead, not here
      if (obj.kind === 'text') {
        drawTextBoxOn(tgt, obj.x, obj.y, obj.text, { bold: obj.bold, underline: obj.underline, fontSize: obj.fontSize });
        if (obj.leaderX != null) {
          const box = { centerX: obj.x + obj._w / 2, centerY: obj.y + obj._h / 2, w: obj._w, h: obj._h };
          drawLeaderOn(tgt, box, obj.leaderX, obj.leaderY, obj.color);
        }
      } else if (obj.kind === 'measure') {
        const prevColor = currentColor;
        currentColor = obj.color;
        drawMeasureArrowOn(tgt, obj.x1, obj.y1, obj.x2, obj.y2);
        currentColor = prevColor;
      } else if (obj.kind === 'image') {
        // Bitmap cached in-memory on the object itself after first load, so repositioning
        // or resizing later doesn't re-fetch/re-decode from IndexedDB on every redraw —
        // only ever needed once per photo session (or once per reopen).
        if (!obj._bitmapCache) {
          const rec = await DB.get('photos', obj.photoBlobId);
          if (!rec) continue; // referenced photo no longer exists — skip rather than error
          try { obj._bitmapCache = await loadBitmapCorrected(rec.originalBlob); } catch (err) { continue; }
        }
        tgt.drawImage(obj._bitmapCache, obj.x, obj.y, obj.w, obj.h);
      }
    }
  }

  // Shared by both the fresh-placement leader draw (confirmPendingAdjust) and re-rendering
  // a stored text object with a leader — factored out so both paths draw it identically.
  function drawLeaderOn(targetCtx, box, targetX, targetY, color) {
    const start = rectEdgeIntersection(box.centerX, box.centerY, box.w, box.h, targetX, targetY);
    const { headSize, lineWidth } = measureArrowSizing();
    const lineEnd = pullBackForArrowhead(start.x, start.y, targetX, targetY, headSize);
    targetCtx.save();
    targetCtx.strokeStyle = color;
    targetCtx.fillStyle = color;
    targetCtx.lineWidth = lineWidth;
    targetCtx.beginPath();
    targetCtx.moveTo(start.x, start.y);
    targetCtx.lineTo(lineEnd.x, lineEnd.y);
    targetCtx.stroke();
    drawArrowheadOn(targetCtx, start.x, start.y, targetX, targetY, headSize);
    targetCtx.restore();
  }

  // Hit-tests a canvas point against every annotation object, topmost (last-drawn) first.
  // Measure uses a tolerance band around the line since it's thin; Text uses its actual box.
  function hitTestAnnotationObjects(p) {
    for (let i = annotationObjects.length - 1; i >= 0; i--) {
      const obj = annotationObjects[i];
      if (obj.kind === 'text') {
        if (p.x >= obj.x && p.x <= obj.x + (obj._w || 0) && p.y >= obj.y && p.y <= obj.y + (obj._h || 0)) return obj;
      } else if (obj.kind === 'measure') {
        const tolerance = Math.max(14, measureArrowSizing().lineWidth * 3);
        const dist = distanceToSegment(p, { x: obj.x1, y: obj.y1 }, { x: obj.x2, y: obj.y2 });
        if (dist <= tolerance) return obj;
      } else if (obj.kind === 'image') {
        if (p.x >= obj.x && p.x <= obj.x + obj.w && p.y >= obj.y && p.y <= obj.y + obj.h) return obj;
      }
    }
    return null;
  }

  function distanceToSegment(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;
    let t = lenSq ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq : 0;
    t = Math.max(0, Math.min(1, t));
    const cx = a.x + t * dx, cy = a.y + t * dy;
    return Math.hypot(p.x - cx, p.y - cy);
  }

  function setAnnotationLayerActive(active) {
    annotationLayerActive = active;
    annotationCanvas.style.pointerEvents = active ? 'auto' : 'none';
    view.querySelector('#btn-layer-toggle').textContent = active ? 'Text layer' : 'Pen layer';
    view.querySelector('#btn-layer-toggle').classList.toggle('active', active);
  }
  setAnnotationLayerActive(false); // drawing layer is the default, matching every prior behavior

  view.querySelector('#btn-layer-toggle').addEventListener('click', () => setAnnotationLayerActive(!annotationLayerActive));

  // Inserting a photo — e.g. a defect close-up positioned against this overview photo —
  // creates its own photos-store record (kind:'annotationImage', matching how every other
  // image in this app is stored, rather than embedding blob data inline in the annotation
  // object) and immediately enters image adjust-mode for the user to position/size it.
  view.querySelector('#btn-insert-photo').addEventListener('click', () => {
    openPhotoSourceSheet({
      onFiles: async (files) => {
        const normalized = await normalizeImageFile(files[0]);
        const rec = await DB.addPhoto({ kind: 'annotationImage', inspectionId: photo.inspectionId, originalBlob: normalized });
        const bitmap = await loadBitmapCorrected(normalized);
        // Default size: a modest fraction of the canvas, centered, preserving the
        // inserted photo's own aspect ratio rather than distorting it to a fixed box.
        const naturalW = bitmap.width || bitmap.naturalWidth;
        const naturalH = bitmap.height || bitmap.naturalHeight;
        const targetW = cw * 0.3;
        const targetH = targetW * (naturalH / naturalW);
        enterImageAdjustMode({ x: (cw - targetW) / 2, y: (ch - targetH) / 2, w: targetW, h: targetH }, bitmap, rec.id, true);
      }
    });
  });

  // Tapping an existing object on the annotation layer opens it for editing — the one
  // piece of this whole feature that's genuinely new territory: re-entering adjust-mode
  // from stored data at any time afterward, not just in the few seconds right after
  // placement, which is what every other use of adjust-mode still assumes.
  annotationCanvas.addEventListener('pointerdown', (e) => {
    if (!annotationLayerActive || measureMode || textMode) return; // placing something new takes priority over editing
    const p = canvasPoint(e);
    const hit = hitTestAnnotationObjects(p);
    if (!hit) return;
    e.preventDefault();
    openAnnotationObjectEditor(hit);
  });

  let adjustEditingObjectColor = null; // preserves an existing object's own color while it's being repositioned, rather than silently switching it to whatever color is currently selected

  function openAnnotationObjectEditor(obj) {
    const label = obj.kind === 'text' ? 'Text' : obj.kind === 'measure' ? 'Measure' : 'Photo';
    const sheet = el(`
      <div class="sheet-backdrop">
        <div class="sheet">
          <div class="sheet-handle"></div>
          <h2>${label}</h2>
          <button class="btn btn-primary btn-block" id="btn-ao-edit">Edit</button>
          <div style="display:flex; gap:10px; margin-top:10px;">
            <button class="btn btn-secondary" id="btn-ao-front" style="flex:1;" title="Draw this on top of the other text, measurements and photos">Bring to front</button>
            <button class="btn btn-secondary" id="btn-ao-back" style="flex:1;" title="Draw this underneath the other text, measurements and photos">Send to back</button>
          </div>
          <button class="btn btn-secondary btn-block" id="btn-ao-behind" style="margin-top:10px;" title="Normally text sits above every pen mark. Turn this on to put it underneath them instead.">${obj.behind ? 'Put above the pen marks' : 'Put behind the pen marks'}</button>
          <button class="btn btn-danger btn-block" id="btn-ao-delete" style="margin-top:10px;">Delete</button>
          <button class="btn btn-ghost btn-block" id="btn-ao-cancel" style="margin-top:10px;">Cancel</button>
        </div>
      </div>
    `);
    presentOverlay(sheet);
    sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.remove(); });
    sheet.querySelector('#btn-ao-cancel').addEventListener('click', () => sheet.remove());
    sheet.querySelector('#btn-ao-delete').addEventListener('click', () => {
      sheet.remove();
      annotationObjects = annotationObjects.filter((o) => o.id !== obj.id);
      if (obj.kind === 'image' && obj.photoBlobId) DB.delete('photos', obj.photoBlobId).catch(() => {});
      renderAnnotationLayer();
    });
    const reorder = (toFront) => {
      sheet.remove();
      annotationObjects = annotationObjects.filter((o) => o.id !== obj.id);
      if (toFront) annotationObjects.push(obj); else annotationObjects.unshift(obj);
      editedSinceOpen = true; renderAnnotationLayer();
    };
    sheet.querySelector('#btn-ao-behind').addEventListener('click', () => { sheet.remove(); obj.behind = !obj.behind; editedSinceOpen = true; renderAnnotationLayer(); });
    sheet.querySelector('#btn-ao-front').addEventListener('click', () => reorder(true));
    sheet.querySelector('#btn-ao-back').addEventListener('click', () => reorder(false));
    sheet.querySelector('#btn-ao-edit').addEventListener('click', () => {
      sheet.remove();
      startEditingAnnotationObject(obj);
    });
  }

  function startEditingAnnotationObject(obj) {
    if (obj.kind === 'measure') {
      adjustEditingObjectId = obj.id;
      adjustEditingObjectColor = obj.color;
      renderAnnotationLayer();
      enterMeasureAdjustMode({ x: obj.x1, y: obj.y1 }, { x: obj.x2, y: obj.y2 });
    } else if (obj.kind === 'text') {
      openTextEntrySheet((result) => {
        adjustEditingObjectId = obj.id;
        adjustEditingObjectColor = obj.color;
        renderAnnotationLayer();
        enterTextAdjustMode({ x: obj.x, y: obj.y }, obj.leaderX != null ? { x: obj.leaderX, y: obj.leaderY } : null, result);
      }, { text: obj.text, bold: obj.bold, underline: obj.underline, fontSize: obj.fontSize });
    } else if (obj.kind === 'image') {
      adjustEditingObjectId = obj.id;
      renderAnnotationLayer();
      enterImageAdjustMode({ x: obj.x, y: obj.y, w: obj.w, h: obj.h }, obj._bitmapCache, obj.photoBlobId, false);
    }
  }

  photoCtx.drawImage(img, 0, 0, cw, ch);
  if (img.close) img.close();
  if (hasEditableMark) {
    try {
      const markImg = await loadBitmapCorrected(photo.editableMarkBlob);
      baseCtx.drawImage(markImg, 0, 0, cw, ch);
      if (markImg.close) markImg.close();
    } catch (err) {
      // If the previously-saved mark layer can't be loaded for any reason, fail visibly
      // rather than silently leaving initialization half-done — a swallowed error here
      // would otherwise present as "editing doesn't work" with no indication why.
      console.error('Failed to reload editable mark layer', err);
      toast('Could not reload your previous marks — starting from the flattened image instead');
    }
  }
  renderMarks();
  renderAnnotationLayer(); // paints any previously-saved Text/Measure objects immediately on open — without this, the data loads correctly but nothing appears until the next edit

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
    if (!arcMode && !straightLineMode && !(shapeMode && shapeMode !== 'num')) return [];
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
    btn.style.display = (arcMode || straightLineMode || (shapeMode && shapeMode !== 'num')) ? '' : 'none';
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

  view.querySelector('#btn-pen-settings').addEventListener('click', () => {
    const seg = (name, opts) => `<div class="pen-seg" data-k="${name}" style="display:flex; gap:6px; margin:6px 0 14px;">${opts.map(([v, l]) => `<button class="btn btn-secondary" data-v="${v}" style="flex:1;${String(inkPrefs[name]) === String(v) ? 'border-color:var(--ink); background:#f0f0f2; font-weight:600;' : ''}">${l}</button>`).join('')}</div>`;
    const sheet = el(`
      <div class="sheet-backdrop">
        <div class="sheet">
          <div class="sheet-handle"></div>
          <h2>Pen settings</h2>
          <div>Smoothing (stabiliser)</div>${seg('streamline', [[0, 'Off'], [0.3, 'Light'], [0.6, 'Medium'], [0.85, 'Strong']])}
          <div>Pencil pressure</div>${seg('curve', [['soft', 'Soft'], ['normal', 'Normal'], ['firm', 'Firm']])}
          <div>Finger drawing</div>${seg('finger', [['auto', 'Auto (off once Pencil seen)'], ['on', 'Always on'], ['off', 'Off']])}
          <div>Two-finger tap = undo</div>${seg('twoTapUndo', [[true, 'On'], [false, 'Off']])}
          <div>Hold still to straighten a line</div>${seg('holdStraighten', [[true, 'On'], [false, 'Off']])}
          <button class="btn btn-primary btn-block" id="btn-pen-done">Done</button>
        </div>
      </div>`);
    presentOverlay(sheet);
    sheet.querySelectorAll('.pen-seg').forEach((g) => g.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
      const raw = b.dataset.v; const k = g.dataset.k;
      inkPrefs[k] = (raw === 'true') ? true : (raw === 'false') ? false : (k === 'streamline' ? parseFloat(raw) : raw);
      saveInkPrefs();
      g.querySelectorAll('button').forEach((x) => { const on = x === b; x.style.borderColor = on ? 'var(--ink)' : ''; x.style.background = on ? '#f0f0f2' : ''; x.style.fontWeight = on ? '600' : ''; });
    })));
    sheet.querySelector('#btn-pen-done').addEventListener('click', () => sheet.remove());
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
      dot.textContent = c ? '' : '+'; dot.title = c ? 'Tap to use · hold to change' : 'Tap to add your own colour';
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
      () => {
        if (customColors[i]) { selectColor(dot, customColors[i]); return; }
        // an empty slot: tap to add a colour (no hidden long-press needed)
        openColorEditSheet('#c81e1e', (newColor) => { customColors[i] = newColor; saveCustomColors(customColors); renderCustomColorRow(); selectColor(dot, newColor); });
      },
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

  function undoStroke() { if (drawing) return; if (hist.undo()) renderMarks(); }
  function redoStroke() { if (drawing) return; if (hist.redo()) renderMarks(); }
  view.querySelector('#btn-undo').addEventListener('click', undoStroke);
  view.querySelector('#btn-redo').addEventListener('click', redoStroke);

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
    rmCtx.drawImage(baseCanvas, -cw / 2, -ch / 2);
    const oldCh = ch;
    hist.mapAll((st) => Ink.rotate90cw([st], oldCh)[0]);

    cw = newCw; ch = newCh;
    baseCanvas.width = cw; baseCanvas.height = ch;
    photoCanvas.width = cw; photoCanvas.height = ch;
    markCanvas.width = cw; markCanvas.height = ch;
    previewCanvas.width = cw; previewCanvas.height = ch;
    view.querySelector('#cal-line-svg').setAttribute('viewBox', `0 0 ${cw} ${ch}`);
    photoCtx.drawImage(rotatedPhoto, 0, 0);
    baseCtx.drawImage(rotatedMark, 0, 0);
    renderMarks();
    ruler.cx = cw / 2; ruler.cy = ch / 2;
    resetViewTransform();
    fitCanvas();
    updateRulerVisual();
    updateRulerHandle();
    if (gridState) updateGridVisual();
    if (selectMode) refreshSelection();
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
    croppedMark.getContext('2d').drawImage(baseCanvas, x, y, w, h, 0, 0, newCw, newCh);
    const cropK = newCw / w;
    hist.mapAll((st) => Ink.cropStrokes([st], x, y, cropK)[0]);

    cw = newCw; ch = newCh;
    baseCanvas.width = cw; baseCanvas.height = ch;
    photoCanvas.width = cw; photoCanvas.height = ch;
    markCanvas.width = cw; markCanvas.height = ch;
    previewCanvas.width = cw; previewCanvas.height = ch;
    view.querySelector('#cal-line-svg').setAttribute('viewBox', `0 0 ${cw} ${ch}`);
    photoCtx.drawImage(croppedPhoto, 0, 0);
    baseCtx.drawImage(croppedMark, 0, 0);
    renderMarks();
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
    if (shapeMode && except !== 'shape:' + shapeMode) {
      shapeMode = null; shapeStart = null;
      syncShapeButtons(); updateLineStyleButtonVisibility();
    }
    if (except !== 'select' && selectMode) exitSelect();
    if (except !== 'bucket' && bucketMode) exitBucket();
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
  let adjustMode = null; // null | 'measure' | 'text' | 'arc' | 'image'
  let adjustP1 = null, adjustP2 = null; // measure mode's two endpoints, also arc mode's two endpoints
  let adjustTextAnchor = null, adjustTextArrow = null, adjustTextResult = null; // text mode
  let adjustArcMid = null; // arc mode's bulge point — where the curve is dragged to pass through
  let adjustDragTarget = null; // 'p1' | 'p2' | 'p3' | 'arrow' | 'box'
  let adjustDragPointerId = null;
  let adjustDragBoxOffset = null;

  let adjustTextBoxRect = null;
  let adjustImageRect = null; // { x, y, w, h } — image mode's current position/size while editing
  let adjustImageBitmap = null; // cached decoded bitmap for the live preview only, not persisted
  let adjustImagePhotoId = null; // the photos-store id backing whichever image is being placed/edited
  let adjustImageIsNew = false; // true only for a fresh "Insert Photo" placement, not editing an existing one — used to clean up an orphaned photos-store record if the placement is cancelled
  function redrawAdjustPreview() {
    clearPreview();
    const boxArea = view.querySelector('#adjust-box-area');
    if (adjustMode === 'measure') {
      boxArea.style.display = 'none';
      const prevColor = currentColor;
      if (adjustEditingObjectColor) currentColor = adjustEditingObjectColor;
      drawMeasureArrowOn(previewCtx, adjustP1.x, adjustP1.y, adjustP2.x, adjustP2.y);
      currentColor = prevColor;
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
        previewCtx.strokeStyle = adjustEditingObjectColor || currentColor;
        previewCtx.fillStyle = adjustEditingObjectColor || currentColor;
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
    } else if (adjustMode === 'image') {
      if (adjustImageBitmap) previewCtx.drawImage(adjustImageBitmap, adjustImageRect.x, adjustImageRect.y, adjustImageRect.w, adjustImageRect.h);
      boxArea.style.display = 'block';
      boxArea.style.left = (adjustImageRect.x / cw) * 100 + '%';
      boxArea.style.top = (adjustImageRect.y / ch) * 100 + '%';
      boxArea.style.width = (adjustImageRect.w / cw) * 100 + '%';
      boxArea.style.height = (adjustImageRect.h / ch) * 100 + '%';
      positionAdjustHandle('#adjust-handle-1', null);
      positionAdjustHandle('#adjust-handle-2', { x: adjustImageRect.x + adjustImageRect.w, y: adjustImageRect.y + adjustImageRect.h });
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
    // Cancel (not just Done/commitAnnotationObject) also needs to clear this — otherwise
    // a cancelled edit would leave that object permanently hidden from
    // renderAnnotationLayer, which skips whatever adjustEditingObjectId currently points to.
    if (adjustEditingObjectId) { adjustEditingObjectId = null; adjustEditingObjectColor = null; renderAnnotationLayer(); }
    // A cancelled fresh "Insert Photo" placement (not editing an existing one) would
    // otherwise leave an orphaned photos-store record behind — checked against the final
    // annotationObjects state rather than relying on call-order, since this runs both
    // right after a successful commit and on a plain Cancel.
    if (adjustMode === 'image' && adjustImageIsNew) {
      const wasCommitted = annotationObjects.some((o) => o.kind === 'image' && o.photoBlobId === adjustImagePhotoId);
      if (!wasCommitted && adjustImagePhotoId) DB.delete('photos', adjustImagePhotoId).catch(() => {});
    }
    adjustImageRect = null; adjustImageBitmap = null; adjustImagePhotoId = null; adjustImageIsNew = false;
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

  function enterImageAdjustMode(rect, bitmap, photoBlobId, isNew) {
    enterAdjustModeCommon();
    adjustMode = 'image';
    adjustImageRect = { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
    adjustImageBitmap = bitmap;
    adjustImagePhotoId = photoBlobId;
    adjustImageIsNew = !!isNew;
    redrawAdjustPreview();
  }

  // Commits whatever's currently pending in adjust mode to the real canvas — shared by the
  // Done button and by the annotator's own outer Save button, so tapping Save while an item
  // is still mid-adjustment (only ever drawn on the preview layer, not the real one) can
  // never silently lose it.
  function confirmPendingAdjust() {
    if (adjustMode === 'measure') {
      if (Math.hypot(adjustP2.x - adjustP1.x, adjustP2.y - adjustP1.y) >= 4) {
        commitAnnotationObject({
          kind: 'measure', id: adjustEditingObjectId || uid(),
          x1: adjustP1.x, y1: adjustP1.y, x2: adjustP2.x, y2: adjustP2.y, color: adjustEditingObjectColor || currentColor
        });
      }
    } else if (adjustMode === 'arc') {
      const ctl = computeQuadraticControl(adjustP1, adjustP2, adjustArcMid);
      const arcStroke = addStroke(Ink.newStroke('arc', { c: currentColor, w: currentWidth, dash: getLineDashArray(), pts: [[adjustP1.x, adjustP1.y], [adjustP2.x, adjustP2.y]], ctl: [ctl.x, ctl.y] }));
      Ink.renderStroke(ctx, arcStroke);
    } else if (adjustMode === 'text') {
      // Measured once on a scratch context purely to get the box's final w/h for storage
      // (needed for hit-testing later) — the real render happens via renderAnnotationLayer.
      const measureCtx = document.createElement('canvas').getContext('2d');
      const box = drawTextBoxOn(measureCtx, adjustTextAnchor.x, adjustTextAnchor.y, adjustTextResult.text, adjustTextResult);
      commitAnnotationObject({
        kind: 'text', id: adjustEditingObjectId || uid(),
        x: adjustTextAnchor.x, y: adjustTextAnchor.y, text: adjustTextResult.text,
        bold: adjustTextResult.bold, underline: adjustTextResult.underline, fontSize: adjustTextResult.fontSize,
        color: adjustEditingObjectColor || currentColor, leaderX: adjustTextArrow ? adjustTextArrow.x : null, leaderY: adjustTextArrow ? adjustTextArrow.y : null,
        _w: box.w, _h: box.h
      });
    } else if (adjustMode === 'image') {
      commitAnnotationObject({
        kind: 'image', id: adjustEditingObjectId || uid(),
        x: adjustImageRect.x, y: adjustImageRect.y, w: adjustImageRect.w, h: adjustImageRect.h,
        photoBlobId: adjustImagePhotoId,
        _bitmapCache: adjustImageBitmap // reuse the already-decoded bitmap immediately, no need to re-fetch/re-decode on the very next render
      });
    }
    exitAdjustMode();
  }

  // Adds a new annotation object or updates an existing one (if adjustEditingObjectId is
  // set), then re-renders the annotation layer from the updated list — the single place
  // both the "place new" and "edit existing" paths converge, so they can't drift apart.
  function commitAnnotationObject(obj) {
    const idx = annotationObjects.findIndex((o) => o.id === obj.id);
    if (idx >= 0) { if (obj.behind === undefined && annotationObjects[idx].behind) obj.behind = true; annotationObjects[idx] = obj; } // editing keeps its stacking choice
    else annotationObjects.push(obj);
    adjustEditingObjectId = null;
    adjustEditingObjectColor = null;
    renderAnnotationLayer();
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
      } else if (adjustMode === 'image' && measureTarget === 'p2') {
        adjustImageRect.w = Math.max(20, p.x - adjustImageRect.x);
        adjustImageRect.h = Math.max(20, p.y - adjustImageRect.y);
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
    const anchor = adjustMode === 'image' ? adjustImageRect : adjustTextAnchor;
    adjustDragBoxOffset = { x: p.x - anchor.x, y: p.y - anchor.y };
    showMagnifier(p, e.clientX, e.clientY);
    e.preventDefault(); e.stopPropagation();
  });
  adjustBoxArea.addEventListener('pointermove', (e) => {
    if (adjustDragTarget !== 'box' || e.pointerId !== adjustDragPointerId) return;
    const p = canvasPoint(e);
    if (adjustMode === 'image') {
      adjustImageRect.x = p.x - adjustDragBoxOffset.x;
      adjustImageRect.y = p.y - adjustDragBoxOffset.y;
    } else {
      adjustTextAnchor = { x: p.x - adjustDragBoxOffset.x, y: p.y - adjustDragBoxOffset.y };
    }
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
    drawMeasureArrowOn(baseCtx, x1, y1, x2, y2);
    renderMarks();
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

  // ---- Shape tools: arrow, circle/oval and box (drag), numbered marker (tap or drag to place) ----
  function syncShapeButtons() {
    const ids = { arrow: '#btn-shape-arrow', ellipse: '#btn-shape-ellipse', rect: '#btn-shape-rect', num: '#btn-num' };
    for (const k in ids) view.querySelector(ids[k]).classList.toggle('active', shapeMode === k);
    view.querySelector('#marker-row').style.display = shapeMode === 'num' ? '' : 'none';
    updateMarkerLabel();
  }
  function nextMarkerNumber() {
    if (markerOverride != null) return markerOverride;
    let m = 0; for (const st of hist.strokes) if (st.k === 'num' && st.n > m) m = st.n;
    return m + 1;
  }
  function updateMarkerLabel() { const l = view.querySelector('#mk-label'); if (l) l.textContent = String(nextMarkerNumber()); }
  function setShapeMode(kind) {
    const on = shapeMode !== kind;
    if (on) deactivateOtherModes('shape:' + kind);
    shapeMode = on ? kind : null;
    if (on) {
      if (eraseMode) { eraseMode = false; view.querySelector('#btn-erase').classList.remove('active'); }
      if (annotationLayerActive) setAnnotationLayerActive(false);
    }
    touches.clear(); pinchState = null; shapeStart = null; clearPreview();
    syncShapeButtons(); updateLineStyleButtonVisibility();
  }
  view.querySelector('#btn-shape-arrow').addEventListener('click', () => setShapeMode('arrow'));
  view.querySelector('#btn-shape-ellipse').addEventListener('click', () => setShapeMode('ellipse'));
  view.querySelector('#btn-shape-rect').addEventListener('click', () => setShapeMode('rect'));
  view.querySelector('#btn-num').addEventListener('click', () => setShapeMode('num'));
  view.querySelector('#mk-minus').addEventListener('click', () => { markerOverride = Math.max(1, nextMarkerNumber() - 1); updateMarkerLabel(); });
  view.querySelector('#mk-plus').addEventListener('click', () => { markerOverride = nextMarkerNumber() + 1; updateMarkerLabel(); });
  function makeShapeStroke(a, b) {
    if (shapeMode === 'num') {
      return Ink.newStroke('num', { c: currentColor, w: Math.max(currentWidth, Math.min(cw, ch) * 0.016), pts: [[b.x, b.y]], n: nextMarkerNumber() });
    }
    const st = Ink.newStroke(shapeMode, { c: currentColor, w: currentWidth, dash: getLineDashArray(), pts: [[a.x, a.y], [b.x, b.y]] });
    if (shapeMode === 'arrow') st.hd = Math.max(currentWidth * 4 + 10, Math.min(cw, ch) * 0.035);
    return st;
  }


  // ---- Snapping: with the grid showing, points land on grid crossings; with no grid, lines click to every 15 degrees ----
  const SNAP_KEY = 'annotate.snap';
  try { snapOn = localStorage.getItem(SNAP_KEY) === '1'; } catch (err) { /* ignore */ }
  function snapPt(p, from) {
    if (!snapOn) return p;
    if (gridState) { const sp = GRID_SPACING[gridState]; return { x: Math.round(p.x / sp) * sp, y: Math.round(p.y / sp) * sp }; }
    if (from) {
      const dx = p.x - from.x, dy = p.y - from.y, len = Math.hypot(dx, dy);
      if (len < 1) return p;
      const ang = Math.atan2(dy, dx), st = Math.PI / 12, r = Math.round(ang / st) * st;
      if (Math.abs(r - ang) <= 4 * Math.PI / 180) return { x: from.x + len * Math.cos(r), y: from.y + len * Math.sin(r) };
    }
    return p;
  }
  function syncSnapButton() {
    const b = view.querySelector('#btn-snap'); if (!b) return;
    b.querySelector('span').textContent = snapOn ? 'Snap: on' : 'Snap: off';
    b.classList.toggle('active', snapOn);
  }
  view.querySelector('#btn-snap').addEventListener('click', () => {
    snapOn = !snapOn; try { localStorage.setItem(SNAP_KEY, snapOn ? '1' : '0'); } catch (err) { /* ignore */ }
    syncSnapButton();
    const hint = view.querySelector('#zoom-hint'); if (hint) { hint.textContent = snapOn ? (gridState ? 'Snapping to the grid' : 'Snapping lines to 15°') : 'Snap off'; }
  });
  syncSnapButton();

  // ---- Select tool: tap a drawing to pick it, drag to move it, drag a handle to resize / turn it. Every change can be undone. ----
  const pxScale = () => cw / (markCanvas.getBoundingClientRect().width || cw);
  const selStroke = () => (selId ? hist.strokes.find((q) => q.id === selId) || null : null);
  const selStrokes = () => selIds.map((id) => hist.strokes.find((q) => q.id === id)).filter(Boolean);
  function setSel(ids) { selIds = ids.slice(); selId = selIds.length === 1 ? selIds[0] : null; }
  const selBar = document.createElement('div');
  selBar.className = 'sel-bar'; selBar.style.display = 'none';
  selBar.innerHTML = `
    <button class="atb2-chip" data-sel="colour" title="Give it the pen colour"><span class="sel-dot"></span>Colour</button>
    <span class="sel-count" style="display:none;"></span>
    <button class="atb2-chip" data-sel="fill" title="Fill a box or circle with the pen colour">Fill</button>
    <button class="atb2-chip" data-sel="copy" title="Make a copy">Copy</button>
    <button class="atb2-chip" data-sel="tolayer" title="Move it onto the layer you are drawing on">To layer</button>
    <button class="atb2-chip" data-sel="delete" title="Delete">Delete</button>
    <button class="atb2-chip atb2-primary" data-sel="done" title="Finish">${IC.down.replace('M6 9l6 6 6-6', 'M5 12l5 5 9-10')}</button>`;
  view.appendChild(selBar);
  function updateSelBar() {
    const list = selStrokes();
    selBar.style.display = selectMode && list.length ? 'flex' : 'none';
    if (!list.length) return;
    const s = list[0];
    const top = view.querySelector('#main-toolbar'); selBar.style.top = ((top ? top.offsetHeight : 56) + 10) + 'px';
    const f = selBar.querySelector('[data-sel="fill"]'); f.style.display = (list.length === 1 && (s.k === 'rect' || s.k === 'ellipse')) ? '' : 'none'; f.classList.toggle('active', list.length === 1 && !!s.fill);
    selBar.querySelector('[data-sel="tolayer"]').style.display = layers.length > 1 && list.some((q) => layerOf(q).id !== activeLayer().id) ? '' : 'none';
    const c = selBar.querySelector('.sel-count'); c.style.display = list.length > 1 ? '' : 'none'; c.textContent = list.length + ' selected';
    selBar.querySelector('.sel-dot').style.background = currentColor;
  }
  function drawSelection() {
    clearPreview();
    if (!selectMode) return;
    const k = pxScale(), list = selStrokes();
    if (selBox) {
      previewCtx.save(); previewCtx.fillStyle = 'rgba(76,154,255,.12)'; previewCtx.strokeStyle = '#4c9aff'; previewCtx.lineWidth = 1.6 * k; previewCtx.setLineDash([6 * k, 5 * k]);
      const x = Math.min(selBox.x0, selBox.x1), y = Math.min(selBox.y0, selBox.y1), w = Math.abs(selBox.x1 - selBox.x0), h = Math.abs(selBox.y1 - selBox.y0);
      previewCtx.fillRect(x, y, w, h); previewCtx.strokeRect(x, y, w, h); previewCtx.restore();
    }
    if (list.length > 1) {
      previewCtx.save(); previewCtx.lineWidth = 1.4 * k; previewCtx.strokeStyle = '#4c9aff';
      let u = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
      previewCtx.setLineDash([3 * k, 4 * k]);
      for (const q of list) { const b = Ink.bbox(q); previewCtx.strokeRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0); u = { x0: Math.min(u.x0, b.x0), y0: Math.min(u.y0, b.y0), x1: Math.max(u.x1, b.x1), y1: Math.max(u.y1, b.y1) }; }
      previewCtx.setLineDash([7 * k, 5 * k]); previewCtx.lineWidth = 2 * k; previewCtx.strokeRect(u.x0 - 4 * k, u.y0 - 4 * k, u.x1 - u.x0 + 8 * k, u.y1 - u.y0 + 8 * k);
      previewCtx.restore(); return;
    }
    const s = list[0]; if (!s) return;
    previewCtx.save(); previewCtx.setLineDash([6 * k, 5 * k]); previewCtx.lineWidth = 1.6 * k; previewCtx.strokeStyle = '#4c9aff';
    if (s.k === 'rect' || s.k === 'ellipse') { const c = Ink.boxCorners(s); previewCtx.beginPath(); previewCtx.moveTo(c[0][0], c[0][1]); for (let i = 1; i < 4; i++) previewCtx.lineTo(c[i][0], c[i][1]); previewCtx.closePath(); previewCtx.stroke(); }
    else if (s.k !== 'line' && s.k !== 'arrow' && s.k !== 'arc') { const b = Ink.bbox(s); previewCtx.strokeRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0); }
    previewCtx.setLineDash([]);
    for (const h of Ink.handles(s, 38 * k)) {
      previewCtx.beginPath(); previewCtx.arc(h.x, h.y, (h.id === 'rot' ? 9 : 8) * k, 0, Math.PI * 2);
      previewCtx.fillStyle = h.id === 'rot' ? '#4c9aff' : '#ffffff'; previewCtx.fill(); previewCtx.lineWidth = 2.2 * k; previewCtx.strokeStyle = '#4c9aff'; previewCtx.stroke();
    }
    previewCtx.restore();
  }
  function refreshSelection() {
    const keep = selIds.filter((id) => { const q = hist.strokes.find((x) => x.id === id); return q && layerOf(q).vis && !layerOf(q).lock; });
    if (keep.length !== selIds.length) setSel(keep);
    updateSelBar(); drawSelection();
  }
  function hitHandle(p) {
    const s = selStroke(); if (!s) return null; const k = pxScale();
    let best = null, bd = 24 * k;
    for (const h of Ink.handles(s, 38 * k)) { const d = Math.hypot(h.x - p.x, h.y - p.y); if (d <= bd) { bd = d; best = h.id; } }
    return best;
  }
  // Is any of this stroke still showing inside the region once later eraser strokes on its layer are applied?
  function strokeVisibleIn(st, rx0, ry0, rx1, ry1) {
    const layer = layerOf(st); let i0 = hist.strokes.indexOf(st);
    if (i0 < 0) i0 = hist.strokes.findIndex((q) => q.id === st.id);
    const erasers = [];
    for (let i = i0 + 1; i < hist.strokes.length; i++) { const q = hist.strokes[i]; if (q.k === 'erase' && layerOf(q) === layer) erasers.push(q); }
    if (!erasers.length) return true;
    const b = Ink.bbox(st), x0 = Math.max(rx0, b.x0), y0 = Math.max(ry0, b.y0), x1 = Math.min(rx1, b.x1), y1 = Math.min(ry1, b.y1);
    if (x1 <= x0 || y1 <= y0) return false;
    const w = x1 - x0, h = y1 - y0, sc = Math.min(1, 220 / Math.max(w, h)), sw = Math.max(1, Math.ceil(w * sc)), sh = Math.max(1, Math.ceil(h * sc));
    const c = document.createElement('canvas'); c.width = sw; c.height = sh; const cx = c.getContext('2d');
    cx.setTransform(sc, 0, 0, sc, -x0 * sc, -y0 * sc);
    Ink.renderStroke(cx, st); for (const e of erasers) Ink.renderStroke(cx, e);
    const d = cx.getImageData(0, 0, sw, sh).data;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 12) return true;
    return false;
  }
  function hitStroke(p) {
    const r = 12 * pxScale();
    for (let i = hist.strokes.length - 1; i >= 0; i--) { const st = hist.strokes[i]; if (st.k !== 'erase' && layerOf(st).vis && !layerOf(st).lock && Ink.hit(st, p.x, p.y, r) && strokeVisibleIn(st, p.x - r - st.w, p.y - r - st.w, p.x + r + st.w, p.y + r + st.w)) return st; }
    return null;
  }
  function syncSelectButton() { view.querySelector('#btn-select').classList.toggle('active', selectMode); }
  function setSelectMode(on) {
    if (on === selectMode) return;
    if (on) {
      deactivateOtherModes('select');
      if (eraseMode) { eraseMode = false; view.querySelector('#btn-erase').classList.remove('active'); }
      if (annotationLayerActive) setAnnotationLayerActive(false);
      selectMode = true;
    } else { exitSelect(); }
    touches.clear(); pinchState = null; syncSelectButton(); refreshSelection(); refreshPenActive();
  }
  function exitSelect() {
    if (selDrag) cancelSelDrag();
    selectMode = false; setSel([]); selBox = null; selDrag = null; selBar.style.display = 'none'; clearPreview(); syncSelectButton();
  }
  view.querySelector('#btn-select').addEventListener('click', () => setSelectMode(!selectMode));
  function selTemp(s) { const i = hist.strokes.findIndex((q) => q.id === s.id); if (i >= 0) hist.strokes[i] = s; }
  function cancelSelDrag() { if (selDrag && selDrag.s0) selTemp(selDrag.s0); selDrag = null; renderMarks(); }
  function selPointerDown(p) {
    const hid = selId && hitHandle(p);
    const aoHit = !hid && hitTestAnnotationObjects(p);
    if (aoHit) { setSel([]); selDrag = null; updateSelBar(); drawSelection(); openAnnotationObjectEditor(aoHit); return; }
    if (hid) selDrag = { kind: 'h', id: hid, s0: selStroke(), sx: p.x, sy: p.y, moved: false };
    else {
      const st = hitStroke(p);
      if (st) { if (!selIds.includes(st.id)) setSel([st.id]); selDrag = { kind: 'm', list: selStrokes(), sx: p.x, sy: p.y, moved: false }; }
      else selDrag = { kind: 'box', sx: p.x, sy: p.y, moved: false };
    }
    updateSelBar(); drawSelection();
  }
  function selPointerMove(p) {
    const d = selDrag; if (!d) return;
    if (!d.moved && Math.hypot(p.x - d.sx, p.y - d.sy) < 4 * pxScale()) return;
    d.moved = true;
    if (d.kind === 'box') { selBox = { x0: d.sx, y0: d.sy, x1: p.x, y1: p.y }; drawSelection(); return; }
    if (d.kind === 'm') {
      let dx = p.x - d.sx, dy = p.y - d.sy;
      if (snapOn && gridState) { const a = d.list[0].pts[0], q = snapPt({ x: a[0] + dx, y: a[1] + dy }); dx = q.x - a[0]; dy = q.y - a[1]; }
      for (const s0 of d.list) selTemp(Ink.moveStroke(s0, dx, dy));
    } else {
      let q = p;
      if (d.id === 'p0' || d.id === 'p1') q = snapPt(p, { x: d.s0.pts[d.id === 'p0' ? 1 : 0][0], y: d.s0.pts[d.id === 'p0' ? 1 : 0][1] });
      else if (d.id !== 'rot') q = snapPt(p);
      selTemp(Ink.dragHandle(d.s0, d.id, q.x, q.y, d.sx, d.sy, snapOn ? 15 : 0));
    }
    if (!selRaf) selRaf = requestAnimationFrame(() => { selRaf = 0; renderMarks(); });
  }
  function selPointerUp() {
    const d = selDrag; selDrag = null; selPointerId = null;
    if (selRaf) { cancelAnimationFrame(selRaf); selRaf = 0; }
    if (!d) return;
    if (d.kind === 'box') {
      if (d.moved && selBox) {
        const x0 = Math.min(selBox.x0, selBox.x1), x1 = Math.max(selBox.x0, selBox.x1), y0 = Math.min(selBox.y0, selBox.y1), y1 = Math.max(selBox.y0, selBox.y1);
        setSel(hist.strokes.filter((q) => { if (q.k === 'erase' || !layerOf(q).vis || layerOf(q).lock) return false; const b = Ink.bbox(q); return b.x1 >= x0 && b.x0 <= x1 && b.y1 >= y0 && b.y0 <= y1 && strokeVisibleIn(q, x0, y0, x1, y1); }).map((q) => q.id));
      } else setSel([]);
      selBox = null; updateSelBar(); drawSelection(); return;
    }
    if (d.moved) {
      const olds = d.kind === 'm' ? d.list : [d.s0];
      const edits = olds.map((a) => ({ t: 'set', a, b: hist.strokes.find((q) => q.id === a.id) })).filter((e) => e.b);
      for (const a of olds) selTemp(a);
      if (edits.length === 1) hist.set(edits[0].a, edits[0].b); else if (edits.length) hist.batch(edits);
    }
    renderMarks(); updateUndoButtons();
  }
  selBar.addEventListener('click', (e) => {
    const b = e.target.closest('[data-sel]'); if (!b) return;
    const list = selStrokes(); if (!list.length) return;
    const act = b.dataset.sel, s = list[0];
    if (act === 'done') setSel([]);
    else if (act === 'delete') { hist.batch(list.map((q) => ({ t: 'del', id: q.id }))); setSel([]); }
    else if (act === 'colour') hist.batch(list.map((q) => ({ t: 'set', a: q, b: Object.assign({}, q, { c: currentColor, fill: q.fill ? currentColor : q.fill }) })));
    else if (act === 'fill' && list.length === 1) hist.set(s, Object.assign({}, s, { fill: s.fill ? undefined : currentColor }));
    else if (act === 'tolayer') hist.batch(list.map((q) => ({ t: 'set', a: q, b: Object.assign({}, q, { ly: activeLayer().id }) })));
    else if (act === 'copy') {
      const k = 28 * pxScale(); let n = nextMarkerNumber();
      const copies = list.map((q) => { const c = Object.assign(Ink.moveStroke(q, k, k), { id: Ink.uid() }); if (c.k === 'num') c.n = n++; return c; });
      hist.batch(copies.map((c) => ({ t: 'add', s: c }))); setSel(copies.map((c) => c.id));
    }
    renderMarks();
  });
  const onSelectKey = (e) => {
    if (!view.isConnected) { document.removeEventListener('keydown', onSelectKey); return; }
    if (!selectMode || !selIds.length) return;
    if ((e.key === 'Backspace' || e.key === 'Delete') && !/^(INPUT|TEXTAREA)$/.test((e.target || {}).tagName || '')) { hist.batch(selStrokes().map((q) => ({ t: 'del', id: q.id }))); setSel([]); renderMarks(); e.preventDefault(); }
  };
  document.addEventListener('keydown', onSelectKey);


  // ---- Fill (bucket): tap inside a closed outline and the whole area is coloured in ----
  function syncBucketButton() { view.querySelector('#btn-bucket').classList.toggle('active', bucketMode); }
  function exitBucket() { bucketMode = false; bucketStart = null; syncBucketButton(); }
  view.querySelector('#btn-bucket').addEventListener('click', () => {
    if (bucketMode) { exitBucket(); refreshPenActive(); return; }
    deactivateOtherModes('bucket');
    if (eraseMode) { eraseMode = false; view.querySelector('#btn-erase').classList.remove('active'); }
    if (annotationLayerActive) setAnnotationLayerActive(false);
    bucketMode = true; touches.clear(); pinchState = null; syncBucketButton(); refreshPenActive();
    const hint = view.querySelector('#zoom-hint'); if (hint) hint.textContent = 'Tap inside a closed outline to fill it';
  });
  function doBucket(p) {
    const scale = Math.min(1, 1400 / Math.max(cw, ch)), w = Math.max(1, Math.round(cw * scale)), h = Math.max(1, Math.round(ch * scale));
    const t = document.createElement('canvas'); t.width = w; t.height = h; const tx = t.getContext('2d'); tx.drawImage(markCanvas, 0, 0, w, h);
    const d = tx.getImageData(0, 0, w, h).data, line = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) line[i] = d[i * 4 + 3] > 24 ? 1 : 0;
    const R = 2, mask = Ink.dilate(line, w, h, R);
    let sx = Math.round(p.x * scale), sy = Math.round(p.y * scale);
    if (sx >= 0 && sy >= 0 && sx < w && sy < h && mask[sy * w + sx]) {
      // tapped on (or next to) a line: use the nearest free pixel
      let found = null;
      for (let r = 1; r <= 6 && !found; r++) for (let dy = -r; dy <= r && !found; dy++) for (let dx = -r; dx <= r; dx++) { const x = sx + dx, y = sy + dy; if (x >= 0 && y >= 0 && x < w && y < h && !mask[y * w + x]) { found = [x, y]; break; } }
      if (!found) { toast('Tap inside the shape, away from the line'); return; }
      sx = found[0]; sy = found[1];
    }
    const res = Ink.floodRects(mask, w, h, sx, sy, 1 / scale, R);
    if (!res) { toast('Tap inside a closed outline'); return; }
    if (res.edge && res.area > w * h * 0.5) { toast('That area is open — close the gap in the outline, then tap inside the shape'); return; }
    const st = Ink.newStroke('flood', { c: currentColor, w: 1, pts: [[p.x, p.y]], rects: res.rects });
    addStroke(st); renderMarks();
  }

  // ---- Layers panel + tracing paper ----
  function layerMeta() { return { layers: layers.map((l) => ({ id: l.id, name: l.name, vis: l.vis, lock: l.lock, op: l.op })), active: activeLayerId, bg: { vis: bg.vis, op: bg.op } }; }
  function applyBg() {
    photoCanvas.style.opacity = bg.vis ? String(bg.op) : '0';
    stackEl.style.background = (bg.op < 1 || !bg.vis) ? '#ffffff' : '';
  }
  applyBg();
  const layersPanel = document.createElement('div');
  layersPanel.className = 'layers-panel'; layersPanel.style.display = 'none';
  view.appendChild(layersPanel);
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function layerChanged() { editedSinceOpen = true; renderMarks(); buildLayersPanel(); updateUndoButtons(); }
  function buildLayersPanel() {
    const n = (l) => hist.strokes.filter((st) => layerOf(st) === l).length;
    let h = `<div class="lp-head"><b>Layers</b><button class="atb2-chip" data-lp="add">${IC.plus}<span>Add layer</span></button><button class="atb2-chip lp-x" data-lp="close" aria-label="Close">${IC.down}</button></div><div class="lp-list">`;
    for (let i = layers.length - 1; i >= 0; i--) {
      const l = layers[i];
      h += `<div class="lp-row ${l.id === activeLayerId ? 'active' : ''}" data-id="${l.id}">
        <button class="lp-ic" data-lp="vis" title="Show / hide">${l.vis ? IC.eye : IC.eyeoff}</button>
        <button class="lp-ic" data-lp="lock" title="Lock / unlock">${l.lock ? IC.lock : IC.unlock}</button>
        <button class="lp-name" data-lp="pick" title="Draw on this layer">${esc(l.name)}<small>${n(l)} drawing${n(l) === 1 ? '' : 's'}</small></button>
        <input class="lp-op" type="range" min="10" max="100" value="${Math.round(l.op * 100)}" data-lp="op" title="Layer opacity" aria-label="Layer opacity">
        <button class="lp-ic" data-lp="up" title="Move up" ${i === layers.length - 1 ? 'disabled' : ''}>${IC.up}</button>
        <button class="lp-ic" data-lp="down" title="Move down" ${i === 0 ? 'disabled' : ''}>${IC.down}</button>
        <button class="lp-ic" data-lp="rename" title="Rename">${IC.pencil}</button>
        <button class="lp-ic" data-lp="del" title="Delete layer" ${layers.length === 1 ? 'disabled' : ''}>${IC.trash}</button>
      </div>`;
    }
    h += `</div><div class="lp-row lp-bg">
        <button class="lp-ic" data-lp="bgvis" title="Show / hide the photo">${bg.vis ? IC.eye : IC.eyeoff}</button>
        <span class="lp-ic lp-spacer"></span>
        <span class="lp-name">Photo / paper<small>${bg.op < 1 && bg.vis ? 'tracing paper: faded to ' + Math.round(bg.op * 100) + '%' : 'full strength'}</small></span>
        <input class="lp-op" type="range" min="5" max="100" value="${Math.round(bg.op * 100)}" data-lp="bgop" title="Photo opacity" aria-label="Photo opacity">
        <button class="atb2-chip ${bg.op < 1 ? 'active' : ''}" data-lp="trace" title="Fade the photo so your lines stand out, like tracing paper">Trace</button>
      </div>`;
    layersPanel.innerHTML = h;
    const ct = view.querySelector('#btn-layers span'); if (ct) ct.textContent = layers.length > 1 ? 'Layers · ' + layers.length : 'Layers';
    view.querySelector('#btn-layers').classList.toggle('active', layersPanel.style.display !== 'none');
  }
  function openLayersPanel(on) {
    if (on) { const top = view.querySelector('#main-toolbar'); layersPanel.style.top = ((top ? top.offsetHeight : 56) + 10) + 'px'; }
    layersPanel.style.display = on ? 'flex' : 'none'; buildLayersPanel();
  }
  view.querySelector('#btn-layers').addEventListener('click', () => openLayersPanel(layersPanel.style.display === 'none'));
  layersPanel.addEventListener('input', (e) => {
    const t = e.target, act = t.dataset && t.dataset.lp; if (!act) return;
    if (act === 'op') { const l = layers.find((q) => q.id === t.closest('.lp-row').dataset.id); l.op = t.value / 100; editedSinceOpen = true; renderMarks(); }
    else if (act === 'bgop') { bg.op = t.value / 100; editedSinceOpen = true; applyBg(); const sm = layersPanel.querySelector('.lp-bg small'); if (sm) sm.textContent = bg.op < 1 ? 'tracing paper: faded to ' + Math.round(bg.op * 100) + '%' : 'full strength'; layersPanel.querySelector('[data-lp=trace]').classList.toggle('active', bg.op < 1); }
  });
  layersPanel.addEventListener('click', (e) => {
    const b = e.target.closest('[data-lp]'); if (!b || b.tagName === 'INPUT') return;
    const act = b.dataset.lp, row = b.closest('.lp-row'), i = row && row.dataset.id ? layers.findIndex((q) => q.id === row.dataset.id) : -1, l = layers[i];
    if (act === 'close') return openLayersPanel(false);
    if (act === 'add') {
      let k = layers.length + 1; while (layers.some((q) => q.name === 'Layer ' + k)) k++;
      const nl = { id: 'l' + Date.now().toString(36) + layers.length, name: 'Layer ' + k, vis: true, lock: false, op: 1 };
      layers.splice(layers.findIndex((q) => q.id === activeLayerId) + 1, 0, nl); activeLayerId = nl.id; return layerChanged();
    }
    if (act === 'trace') { bg.op = bg.op < 1 ? 1 : 0.3; bg.vis = true; applyBg(); editedSinceOpen = true; return buildLayersPanel(); }
    if (act === 'bgvis') { bg.vis = !bg.vis; applyBg(); editedSinceOpen = true; return buildLayersPanel(); }
    if (!l) return;
    if (act === 'pick') { activeLayerId = l.id; return buildLayersPanel(); }
    if (act === 'vis') { l.vis = !l.vis; return layerChanged(); }
    if (act === 'lock') { l.lock = !l.lock; return layerChanged(); }
    if (act === 'up' && i < layers.length - 1) { [layers[i], layers[i + 1]] = [layers[i + 1], layers[i]]; return layerChanged(); }
    if (act === 'down' && i > 0) { [layers[i], layers[i - 1]] = [layers[i - 1], layers[i]]; return layerChanged(); }
    if (act === 'rename') { const nm = window.prompt('Layer name', l.name); if (nm && nm.trim()) { l.name = nm.trim().slice(0, 30); buildLayersPanel(); editedSinceOpen = true; } return; }
    if (act === 'del' && layers.length > 1) {
      const mine = hist.strokes.filter((st) => layerOf(st) === l);
      if (mine.length && !window.confirm('Delete "' + l.name + '" and its ' + mine.length + ' drawing' + (mine.length === 1 ? '' : 's') + '? Undo brings the drawings back onto the bottom layer.')) return;
      if (mine.length) hist.batch(mine.map((st) => ({ t: 'del', id: st.id })));
      layers.splice(i, 1); if (activeLayerId === l.id) activeLayerId = layers[Math.min(i, layers.length - 1)].id;
      return layerChanged();
    }
  });
  buildLayersPanel();

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

  function openTextEntrySheet(onConfirm, initial) {
    let bold = initial ? initial.bold : textBold;
    let underline = initial ? initial.underline : textUnderline;
    let fontSize = initial ? initial.fontSize : textFontSize;
    const sheet = el(`
      <div class="sheet-backdrop">
        <div class="sheet">
          <div class="sheet-handle"></div>
          <h2>${initial ? 'Edit text' : 'Add text'}</h2>
          <div class="field"><textarea id="f-text" placeholder="Type a label…" style="min-height:140px;">${initial ? esc(initial.text) : ''}</textarea></div>
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
          <button class="btn btn-primary btn-block" id="btn-place">${initial ? 'Update text' : 'Place text'}</button>
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

  // ---- Pen drawing: strokes go through the Ink engine (stabiliser, pressure curve, deterministic redraw) ----
  function fountainWidthsForCurrent() {
    const customActive = view.querySelector('#w-custom').classList.contains('active');
    if (customActive) return { avg: fountainAvgWidth, max: fountainMaxWidth };
    return { avg: currentWidth, max: currentWidth * 2.5 };
  }

  let strokeStartPoint = null;
  let holdStraightenTimer = null;
  const HOLD_STRAIGHTEN_MS = 700;
  let liveStroke = null, liveState = null, drawFilter = null, heldLine = false, holdBackdrop = null, lastRawPt = null;

  function clearHoldStraightenTimer() {
    if (holdStraightenTimer) { clearTimeout(holdStraightenTimer); holdStraightenTimer = null; }
  }
  // Hold the pen still and the stroke becomes a straight line (snapping to 0/45/90 degrees when close); keep moving to swing the end.
  function resetHoldStraightenTimer() {
    clearHoldStraightenTimer();
    if (eraseMode || !liveStroke || !inkPrefs.holdStraighten || heldLine || liveStroke.pts.length < 3) return;
    holdStraightenTimer = setTimeout(() => {
      if (!drawing || !liveStroke || liveStroke.pts.length < 3) return;
      Object.assign(liveStroke, Ink.straighten(liveStroke, 3));
      renderMarks();
      if (!holdBackdrop) holdBackdrop = document.createElement('canvas');
      holdBackdrop.width = cw; holdBackdrop.height = ch; holdBackdrop.getContext('2d').drawImage(markCanvas, 0, 0);
      Ink.renderStroke(ctx, liveStroke);
      heldLine = true;
      if (navigator.vibrate) { try { navigator.vibrate(8); } catch (err) { /* ignore */ } }
    }, HOLD_STRAIGHTEN_MS);
  }
  function snapshotBackdrop() {
    if (!holdBackdrop) holdBackdrop = document.createElement('canvas');
    holdBackdrop.width = cw; holdBackdrop.height = ch; holdBackdrop.getContext('2d').drawImage(markCanvas, 0, 0);
  }
  function restoreBackdrop() {
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalCompositeOperation = 'source-over'; ctx.clearRect(0, 0, cw, ch); ctx.drawImage(holdBackdrop, 0, 0); ctx.restore();
  }
  function currentStrokeKind() {
    if (eraseMode) return 'erase';
    return currentPenType === 'airbrush' ? 'air' : currentPenType === 'fountain' ? 'nib' : currentPenType === 'smoothing' ? 'smooth' : currentPenType === 'highlighter' ? 'hl' : 'pen';
  }

  function startStroke(e) {
    try { markCanvas.setPointerCapture(e.pointerId); } catch (err) {}
    drawing = true;
    drawingPointerId = e.pointerId;
    drawingPointerType = e.pointerType;
    heldLine = false;
    const p = projectOntoRuler(canvasPoint(e));
    const kind = currentStrokeKind();
    drawFilter = Ink.makeFilter({ streamline: kind === 'smooth' ? Math.max(inkPrefs.streamline, 0.6) : (kind === 'erase' ? 0.1 : inkPrefs.streamline), curve: inkPrefs.curve, hasPressure: e.pointerType === 'pen' });
    liveStroke = Ink.newStroke(kind, { c: currentColor, w: currentWidth, nib: kind === 'nib' ? fountainWidthsForCurrent() : undefined });
    liveStroke.pts = drawFilter.begin(p.x, p.y, e.pressure, e.timeStamp).slice();
    lastRawPt = p;
    liveState = Ink.liveStart(liveStroke);
    if (kind === 'hl') { snapshotBackdrop(); Ink.renderStroke(ctx, liveStroke); }
    else Ink.liveDot(ctx, liveState);
    strokeStartPoint = { x: p.x, y: p.y };
    resetHoldStraightenTimer();
  }

  function continueStroke(e) {
    if (!liveStroke) return;
    const events = (typeof e.getCoalescedEvents === 'function' && e.getCoalescedEvents().length) ? e.getCoalescedEvents() : [e];
    for (const ev of events) {
      const p = projectOntoRuler(canvasPoint(ev));
      lastRawPt = p;
      if (heldLine) continue;
      for (const q of drawFilter.add(p.x, p.y, ev.pressure, ev.timeStamp)) liveStroke.pts.push(q);
    }
    if (heldLine) {
      // swing the held line's end point with the pen
      const a = liveStroke.pts[0], b = Ink.straighten({ ...liveStroke, pts: [a, [lastRawPt.x, lastRawPt.y]] }, 3).pts[1];
      liveStroke.pts = [[a[0], a[1]], b];
      ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalCompositeOperation = 'source-over'; ctx.clearRect(0, 0, cw, ch); ctx.drawImage(holdBackdrop, 0, 0); ctx.restore();
      Ink.renderStroke(ctx, liveStroke);
      return;
    }
    if (liveStroke.k === 'hl') { restoreBackdrop(); Ink.renderStroke(ctx, liveStroke); }
    else Ink.liveAdvance(ctx, liveState);
    resetHoldStraightenTimer();
  }
  // Pen lifted: catch the stabiliser up, draw the last piece and keep the stroke in the history.
  function finishStroke(e) {
    clearHoldStraightenTimer();
    if (liveStroke) {
      if (!heldLine) {
        const p = projectOntoRuler(canvasPoint(e));
        for (const q of drawFilter.end(p.x, p.y)) liveStroke.pts.push(q);
        if (liveStroke.k === 'hl') { restoreBackdrop(); Ink.renderStroke(ctx, liveStroke); }
        else Ink.liveFinish(ctx, liveState);
      }
      addStroke(liveStroke);
    }
    liveStroke = null; liveState = null; drawFilter = null; heldLine = false; holdBackdrop = null; strokeStartPoint = null;
  }

  const touches = new Map(); // pointerId -> {cx, cy, x, y}

  // ---- Palm rejection ----
  // Without this a resting palm (a touch) landing during a Pencil stroke took over the stroke or the
  // tool's start point, so the pen drew only part of a line or nothing. Rules:
  //  1. While the Pencil is down, and for a moment after it lifts, touches are ignored.
  //  2. Once a Pencil has been seen (remembered on this iPad), a single finger no longer draws or places
  //     tools; two fingers still pinch and pan. With no Pencil the finger behaves as before.
  //  3. A touch stroke that started just before the Pencil arrived is undone.
  const PALM_GRACE_MS = 350;
  const penDownIds = new Set(), ignoredTouches = new Set();
  let lastPenTime = 0, drawingPointerType = '';
  let penSeen = false;
  try { penSeen = localStorage.getItem('annotate.penSeen') === '1'; } catch (err) { /* ignore */ }
  function notePen() {
    lastPenTime = performance.now();
    if (!penSeen) { penSeen = true; try { localStorage.setItem('annotate.penSeen', '1'); } catch (err) { /* ignore */ } }
  }
  function cancelTouchInteractions() {
    if (drawing && drawingPointerType === 'touch') {
      // a finger stroke that began just before the Pencil arrived: throw it away
      clearHoldStraightenTimer();
      liveStroke = null; liveState = null; drawFilter = null; heldLine = false; holdBackdrop = null;
      drawing = false; drawingPointerId = null; strokeStartPoint = null;
      renderMarks();
    }
    touches.clear(); tapStart.clear(); pinchState = null;
  }
  const tapStart = new Map();
  // Finger drawing: 'auto' = off once a Pencil has been seen on this iPad; 'on' / 'off' set it by hand (Pen… sheet)
  const fingerBlocked = () => inkPrefs.finger === 'off' || (inkPrefs.finger === 'auto' && penSeen);
  const palmBlocked = () => penDownIds.size > 0 || performance.now() - lastPenTime < PALM_GRACE_MS;

  markCanvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'pen') { penDownIds.add(e.pointerId); notePen(); cancelTouchInteractions(); }
    else if (e.pointerType === 'touch') {
      if (palmBlocked()) { ignoredTouches.add(e.pointerId); e.preventDefault(); return; }
      tapStart.set(e.pointerId, { cx: e.clientX, cy: e.clientY, t: performance.now() });
      if (fingerBlocked() && !cropMode && !adjustMode) {
        // Pencil user: one finger does nothing, two fingers pinch and pan
        const p0 = canvasPoint(e);
        touches.set(e.pointerId, { cx: e.clientX, cy: e.clientY, x: p0.x, y: p0.y });
        if (touches.size >= 2) { measureStart = arcStart = straightLineStart = textPressPoint = null; clearPreview(); hideMagnifier(); if (rulerEnabled) updateRulerFromTouches(); else updatePinch(); }
        e.preventDefault(); return;
      }
    }
    try { markCanvas.setPointerCapture(e.pointerId); } catch (err) { /* not critical */ }
    if (cropMode) { e.preventDefault(); return; } // crop handles/border have their own listeners with stopPropagation
    if (adjustMode) { e.preventDefault(); return; } // adjust handles/box-area have their own listeners with stopPropagation
    if (!selectMode && !textMode && !measureMode && !calibrating && !annotationLayerActive && (activeLayer().lock || !activeLayer().vis)) {
      toast(activeLayer().lock ? 'This layer is locked — unlock it in Layers, or pick another layer' : 'This layer is hidden — show it in Layers, or pick another layer');
      e.preventDefault(); return;
    }
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

    if (bucketMode) {
      if (e.pointerType === 'touch') {
        const p = canvasPoint(e);
        touches.set(e.pointerId, { cx: e.clientX, cy: e.clientY, x: p.x, y: p.y });
        if (touches.size >= 2) { bucketStart = null; updatePinch(); e.preventDefault(); return; }
      }
      bucketStart = canvasPoint(e); bucketPid = e.pointerId;
      e.preventDefault();
      return;
    }
    if (selectMode) {
      if (e.pointerType === 'touch') {
        const p = canvasPoint(e);
        touches.set(e.pointerId, { cx: e.clientX, cy: e.clientY, x: p.x, y: p.y });
        if (touches.size >= 2) { if (selDrag) cancelSelDrag(); selPointerId = null; updatePinch(); e.preventDefault(); return; }
      }
      selPointerId = e.pointerId;
      selPointerDown(canvasPoint(e));
      e.preventDefault();
      return;
    }

    if (shapeMode) {
      if (e.pointerType === 'touch') {
        const p = canvasPoint(e);
        touches.set(e.pointerId, { cx: e.clientX, cy: e.clientY, x: p.x, y: p.y });
        if (touches.size >= 2) { shapeStart = null; clearPreview(); updatePinch(); e.preventDefault(); return; }
      }
      shapeStart = snapPt(canvasPoint(e));
      shapePointerId = e.pointerId;
      clearPreview(); Ink.renderStroke(previewCtx, makeShapeStroke(shapeStart, shapeStart));
      showMagnifier(shapeStart, e.clientX, e.clientY);
      e.preventDefault();
      return;
    }

    if (straightLineMode) {
      if (e.pointerType === 'touch') {
        const p = canvasPoint(e);
        touches.set(e.pointerId, { cx: e.clientX, cy: e.clientY, x: p.x, y: p.y });
        if (touches.size >= 2) { straightLineStart = null; clearPreview(); updatePinch(); e.preventDefault(); return; }
      }
      straightLineStart = snapPt(canvasPoint(e));
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
      const aoHit = hitTestAnnotationObjects(canvasPoint(e));
      if (aoHit && aoHit.kind === 'text') { textPressPoint = null; openAnnotationObjectEditor(aoHit); e.preventDefault(); return; }
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
          if (drawing) { clearHoldStraightenTimer(); liveStroke = null; liveState = null; drawFilter = null; heldLine = false; drawing = false; drawingPointerId = null; renderMarks(); }
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
    if (e.pointerType === 'pen') notePen();
    if (e.pointerType === 'touch' && !cropMode && !adjustMode) {
      if (ignoredTouches.has(e.pointerId) || palmBlocked()) { e.preventDefault(); return; }
      if (fingerBlocked()) {
        if (touches.has(e.pointerId)) {
          const p0 = canvasPoint(e);
          touches.set(e.pointerId, { cx: e.clientX, cy: e.clientY, x: p0.x, y: p0.y });
          if (touches.size >= 2) { if (rulerEnabled) updateRulerFromTouches(); else updatePinch(); }
        }
        e.preventDefault(); return;
      }
    }
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

    if (bucketMode) {
      if (e.pointerType === 'touch' && touches.has(e.pointerId)) {
        const p = canvasPoint(e);
        touches.set(e.pointerId, { cx: e.clientX, cy: e.clientY, x: p.x, y: p.y });
        if (touches.size >= 2) { updatePinch(); e.preventDefault(); return; }
      }
      e.preventDefault();
      return;
    }
    if (selectMode) {
      if (e.pointerType === 'touch' && touches.has(e.pointerId)) {
        const p = canvasPoint(e);
        touches.set(e.pointerId, { cx: e.clientX, cy: e.clientY, x: p.x, y: p.y });
        if (touches.size >= 2) { updatePinch(); e.preventDefault(); return; }
      }
      if (selDrag && e.pointerId === selPointerId) selPointerMove(canvasPoint(e));
      e.preventDefault();
      return;
    }

    if (shapeMode) {
      if (e.pointerType === 'touch' && touches.has(e.pointerId)) {
        const p = canvasPoint(e);
        touches.set(e.pointerId, { cx: e.clientX, cy: e.clientY, x: p.x, y: p.y });
        if (touches.size >= 2) { updatePinch(); e.preventDefault(); return; }
      }
      if (shapeStart && e.pointerId === shapePointerId) {
        const p = snapPt(canvasPoint(e), shapeStart);
        clearPreview(); Ink.renderStroke(previewCtx, makeShapeStroke(shapeStart, p));
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
        const p = snapPt(canvasPoint(e), straightLineStart);
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
    if (e.pointerType === 'pen') { penDownIds.delete(e.pointerId); lastPenTime = performance.now(); }
    if (e.pointerType === 'touch' && ignoredTouches.has(e.pointerId)) { if (e.type === 'pointerleave' || e.type === 'pointercancel') ignoredTouches.delete(e.pointerId); return; }
    if (e.type === 'pointerleave' && e.pointerType !== 'mouse' && markCanvas.hasPointerCapture && markCanvas.hasPointerCapture(e.pointerId)) return; // captured: the matching pointerup finishes it
    hideMagnifier();
    if (e.pointerType === 'touch') {
      if (e.type === 'pointerup' && inkPrefs.twoTapUndo && tapStart.size === 2 && tapStart.has(e.pointerId) && !cropMode && !adjustMode && !calibrating) {
        const now = performance.now(), arr = [...tapStart.values()];
        const quick = arr.every((t) => now - t.t < 350);
        const still = [...touches.entries()].every(([id, t]) => { const s0 = tapStart.get(id); return !s0 || Math.hypot(t.cx - s0.cx, t.cy - s0.cy) < 14; });
        if (quick && still) { if (drawing) { clearHoldStraightenTimer(); liveStroke = null; liveState = null; drawFilter = null; drawing = false; drawingPointerId = null; renderMarks(); } undoStroke(); }
      }
      tapStart.delete(e.pointerId);
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
    if (bucketMode && bucketStart && e.pointerId === bucketPid) {
      const p = canvasPoint(e), st0 = bucketStart; bucketStart = null; bucketPid = null;
      if (e.type !== 'pointercancel' && Math.hypot(p.x - st0.x, p.y - st0.y) < 10 * pxScale()) doBucket(st0);
    }
    if (selectMode && e.pointerId === selPointerId) {
      if (e.type === 'pointercancel') cancelSelDrag(); else selPointerUp();
      selPointerId = null;
    }
    if (shapeMode && shapeStart && e.pointerId === shapePointerId) {
      const p = snapPt(canvasPoint(e), shapeStart);
      clearPreview(); hideMagnifier();
      if (shapeMode === 'num' || Math.hypot(p.x - shapeStart.x, p.y - shapeStart.y) >= 4) {
        const st = addStroke(makeShapeStroke(shapeStart, p));
        Ink.renderStroke(ctx, st);
        if (shapeMode === 'num') { markerOverride = null; updateMarkerLabel(); }
      }
      shapeStart = null; shapePointerId = null;
    }
    if (straightLineMode && straightLineStart && e.pointerId === straightLinePointerId) {
      const p = snapPt(canvasPoint(e), straightLineStart);
      clearPreview();
      hideMagnifier();
      if (Math.hypot(p.x - straightLineStart.x, p.y - straightLineStart.y) >= 4) {
        const lineStroke = addStroke(Ink.newStroke('line', { c: currentColor, w: currentWidth, dash: getLineDashArray(), pts: [[straightLineStart.x, straightLineStart.y], [p.x, p.y]] }));
        Ink.renderStroke(ctx, lineStroke);
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
    if (e.type === 'pointercancel') { clearHoldStraightenTimer(); liveStroke = null; liveState = null; drawFilter = null; heldLine = false; renderMarks(); }
    else finishStroke(e);
    drawing = false;
    drawingPointerId = null;
    try { markCanvas.releasePointerCapture(e.pointerId); } catch (err) {}
  }
  markCanvas.addEventListener('pointerup', endStroke);
  markCanvas.addEventListener('pointercancel', endStroke);
  markCanvas.addEventListener('pointerleave', endStroke);

  function removeMagnifierEl() {
    if (magnifierEl) { magnifierEl.remove(); magnifierEl = null; magnifierCanvas = null; magnifierCtx = null; }
  }

  function discardAndClose() {
    window.removeEventListener('resize', fitCanvas);
    window.removeEventListener('resize', onIslandResize);
    removeMagnifierEl();
    view.remove();
  }

  // ---- Layout v2: Back / Done menu, floating tool island, More menu ----
  const initialStrokeCount = hist.strokes.length, initialObjCount = annotationObjects.length;
  const hasEdits = () => editedSinceOpen || hist.redoCount > 0 || hist.strokes.length !== initialStrokeCount || annotationObjects.length !== initialObjCount;
  function openDoneSheet() {
    const sheet = el(`
      <div class="sheet-backdrop">
        <div class="sheet">
          <div class="sheet-handle"></div>
          <h2>Finish sketch</h2>
          <button class="btn btn-primary btn-block" data-act="editable">Save and keep editable</button>
          <div class="muted" style="margin:6px 0 14px; font-size:13px;">Your marks stay separate, so you can come back and change or undo them.</div>
          <button class="btn btn-secondary btn-block" data-act="flatten">Flatten into the photo</button>
          <div class="muted" style="margin:6px 0 14px; font-size:13px;">The marks become part of the picture permanently.</div>
          <button class="btn btn-ghost btn-block" data-act="discard" style="color:var(--red);">Discard changes and close</button>
          <button class="btn btn-ghost btn-block" data-act="keep">Keep editing</button>
        </div>
      </div>`);
    presentOverlay(sheet);
    sheet.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]') && e.target.closest('[data-act]').dataset.act;
      if (e.target === sheet) { sheet.remove(); return; }
      if (!act) return;
      sheet.remove();
      if (act === 'editable') view.querySelector('#btn-save-editable').click();
      else if (act === 'flatten') view.querySelector('#btn-save').click();
      else if (act === 'discard') discardAndClose();
    });
  }
  view.querySelector('#btn-done').addEventListener('click', openDoneSheet);
  view.querySelector('#btn-cancel').addEventListener('click', () => { if (hasEdits()) openDoneSheet(); else discardAndClose(); });

  const islandEl = view.querySelector('#tool-island'), gripEl = view.querySelector('#isl-grip');
  const stripEl = view.querySelector('#pen-strip'), morePop = view.querySelector('#more-pop'), shapesPop = view.querySelector('#shapes-pop');
  const pops = [morePop, shapesPop];
  const closePops = () => pops.forEach((q) => { q.style.display = 'none'; });
  const ISL_KEY = 'annotate.island';
  const isl = Object.assign({ edge: 'left', pos: 0.35, collapsed: false }, (() => { try { return JSON.parse(localStorage.getItem(ISL_KEY) || '{}'); } catch (err) { return {}; } })());
  if (!['left', 'right', 'top', 'bottom'].includes(isl.edge)) isl.edge = 'left';
  const saveIsl = () => { try { localStorage.setItem(ISL_KEY, JSON.stringify(isl)); } catch (err) { /* ignore */ } };
  const safeBottomPx = () => { const pr = document.createElement('div'); pr.style.cssText = 'position:absolute;left:0;bottom:0;width:1px;height:env(safe-area-inset-bottom,0px);visibility:hidden;'; view.appendChild(pr); const h = pr.offsetHeight; pr.remove(); return h; };
  const topLimit = () => view.querySelector('#main-toolbar').offsetHeight + 8;
  function layoutIsland() {
    if (!view.isConnected) return;
    const W = view.clientWidth, H = view.clientHeight;
    const vertical = isl.edge === 'left' || isl.edge === 'right';
    const top0 = topLimit(), bottomPad = 14 + safeBottomPx();
    islandEl.classList.toggle('h', !vertical);
    islandEl.classList.toggle('collapsed', !!isl.collapsed);
    islandEl.style.left = islandEl.style.right = islandEl.style.top = islandEl.style.bottom = '';
    islandEl.style.maxHeight = vertical ? Math.max(120, H - top0 - bottomPad) + 'px' : '';
    islandEl.style.maxWidth = vertical ? '' : Math.max(120, W - 24) + 'px';
    if (vertical) {
      const h = islandEl.offsetHeight;
      islandEl.style.top = Math.round(top0 + Math.max(0, H - top0 - bottomPad - h) * isl.pos) + 'px';
      islandEl.style[isl.edge] = '12px';
    } else {
      const w = islandEl.offsetWidth;
      islandEl.style.left = Math.round(12 + Math.max(0, W - 24 - w) * isl.pos) + 'px';
      if (isl.edge === 'top') islandEl.style.top = top0 + 'px'; else islandEl.style.bottom = bottomPad + 'px';
    }
    stripEl.style.bottom = (isl.edge === 'bottom' ? bottomPad + islandEl.offsetHeight + 12 : bottomPad) + 'px';
    pops.forEach((q) => { if (q.style.display !== 'none') layoutPop(q); });
  }
  function layoutPop(pop) {
    const W = view.clientWidth, H = view.clientHeight, top0 = topLimit();
    const r = islandEl.getBoundingClientRect(), pw = pop.offsetWidth, ph = pop.offsetHeight;
    let l, t;
    if (isl.edge === 'left') { l = r.right + 8; t = r.bottom - ph; }
    else if (isl.edge === 'right') { l = r.left - pw - 8; t = r.bottom - ph; }
    else if (isl.edge === 'top') { l = r.right - pw; t = r.bottom + 8; }
    else { l = r.right - pw; t = r.top - ph - 8; }
    pop.style.left = Math.max(8, Math.min(W - pw - 8, l)) + 'px';
    pop.style.top = Math.max(top0, Math.min(H - ph - 8, t)) + 'px';
  }
  function onIslandResize() { if (!view.isConnected) { window.removeEventListener('resize', onIslandResize); return; } layoutIsland(); }
  window.addEventListener('resize', onIslandResize);
  layoutIsland();
  requestAnimationFrame(layoutIsland);

  let islDrag = null;
  gripEl.addEventListener('pointerdown', (e) => {
    const r = islandEl.getBoundingClientRect();
    islDrag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, ox: e.clientX - r.left, oy: e.clientY - r.top, moved: false };
    try { gripEl.setPointerCapture(e.pointerId); } catch (err) { /* not critical */ }
    e.preventDefault(); e.stopPropagation();
  });
  gripEl.addEventListener('pointermove', (e) => {
    if (!islDrag || e.pointerId !== islDrag.id) return;
    if (!islDrag.moved && Math.hypot(e.clientX - islDrag.x0, e.clientY - islDrag.y0) > 8) { islDrag.moved = true; closePops(); }
    if (!islDrag.moved) return;
    islandEl.style.right = islandEl.style.bottom = '';
    islandEl.style.left = (e.clientX - islDrag.ox) + 'px';
    islandEl.style.top = (e.clientY - islDrag.oy) + 'px';
    e.preventDefault();
  });
  function endIslDrag(e) {
    if (!islDrag || e.pointerId !== islDrag.id) return;
    const d = islDrag; islDrag = null;
    try { gripEl.releasePointerCapture(e.pointerId); } catch (err) { /* already released */ }
    if (e.type === 'pointercancel') { layoutIsland(); return; }
    if (!d.moved) { isl.collapsed = !isl.collapsed; saveIsl(); layoutIsland(); return; }
    const W = view.clientWidth, H = view.clientHeight, top0 = topLimit(), bottomPad = 14 + safeBottomPx();
    const r = islandEl.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const dist = { left: cx, right: W - cx, top: cy - top0, bottom: H - cy };
    isl.edge = Object.keys(dist).sort((a, b) => dist[a] - dist[b])[0];
    const vertical = isl.edge === 'left' || isl.edge === 'right';
    islandEl.classList.toggle('h', !vertical);
    islandEl.style.maxHeight = ''; islandEl.style.maxWidth = '';
    const nw = islandEl.offsetWidth, nh = islandEl.offsetHeight;
    isl.pos = vertical
      ? Math.max(0, Math.min(1, (cy - nh / 2 - top0) / Math.max(1, H - top0 - bottomPad - nh)))
      : Math.max(0, Math.min(1, (cx - nw / 2 - 12) / Math.max(1, W - 24 - nw)));
    saveIsl(); layoutIsland();
  }
  gripEl.addEventListener('pointerup', endIslDrag);
  gripEl.addEventListener('pointercancel', endIslDrag);

  function togglePop(pop) {
    const open = pop.style.display !== 'none';
    closePops();
    if (!open) { pop.style.display = 'flex'; layoutPop(pop); }
  }
  view.querySelector('#btn-more').addEventListener('click', () => togglePop(morePop));
  view.querySelector('#btn-shapes').addEventListener('click', () => togglePop(shapesPop));
  pops.forEach((q) => q.addEventListener('click', () => closePops()));
  view.addEventListener('pointerdown', (e) => {
    if (pops.every((q) => q.style.display === 'none')) return;
    if (pops.some((q) => q.contains(e.target)) || e.target.closest('#btn-more') || e.target.closest('#btn-shapes')) return;
    closePops();
  }, true);

  // Pen button: leave any other tool and go back to freehand drawing
  const penToolBtn = view.querySelector('#btn-pen-tool'), shapesBtn = view.querySelector('#btn-shapes');
  penToolBtn.addEventListener('click', () => {
    deactivateOtherModes(null);
    if (eraseMode) { eraseMode = false; view.querySelector('#btn-erase').classList.remove('active'); }
    if (annotationLayerActive) setAnnotationLayerActive(false);
    refreshPenActive();
  });
  function refreshPenActive() {
    const on = !(eraseMode || measureMode || arcMode || straightLineMode || textMode || shapeMode || selectMode || bucketMode);
    if (penToolBtn.classList.contains('active') !== on) penToolBtn.classList.toggle('active', on);
    const sh = !!(arcMode || straightLineMode || (shapeMode && shapeMode !== 'num'));
    if (shapesBtn.classList.contains('active') !== sh) shapesBtn.classList.toggle('active', sh);
  }
  new MutationObserver(refreshPenActive).observe(view.querySelector('#ruler-toolbar'), { subtree: true, attributes: true, attributeFilter: ['class'] });
  refreshPenActive();

  async function buildMergedBlob() {
    // Explicitly waits for a fresh render rather than trusting the annotation canvas is
    // already up to date — commitAnnotationObject's own render call isn't awaited by its
    // callers, so without this, saving immediately after committing an object (especially
    // an image, which loads asynchronously) could composite a stale annotation layer.
    await renderAnnotationLayer();
    return new Promise((resolve) => {
      const mergeCanvas = document.createElement('canvas');
      mergeCanvas.width = cw;
      mergeCanvas.height = ch;
      const mergeCtx = mergeCanvas.getContext('2d');
      if (bg.op < 1 || !bg.vis) { mergeCtx.fillStyle = '#ffffff'; mergeCtx.fillRect(0, 0, cw, ch); }
      if (bg.vis) { mergeCtx.globalAlpha = bg.op; mergeCtx.drawImage(photoCanvas, 0, 0); mergeCtx.globalAlpha = 1; }
      mergeCtx.drawImage(underCanvas, 0, 0); // anything set to sit behind the pen marks
      mergeCtx.drawImage(markCanvas, 0, 0);
      mergeCtx.drawImage(annotationCanvas, 0, 0); // annotation layer always composites on top, per its "always on top" requirement
      mergeCanvas.toBlob((blob) => resolve(blob), 'image/jpeg', 0.92);
    });
  }

  view.querySelector('#btn-save-editable').addEventListener('click', async () => {
    if (adjustMode) confirmPendingAdjust();
    const mergedBlob = await buildMergedBlob();
    if (!mergedBlob) { toast('Could not prepare the image to save — nothing was lost, please try again'); return; }
    // PNG specifically, not JPEG — this layer needs to keep its transparency (including
    // areas removed with the eraser) intact for when it's reloaded and edited further.
    baseCanvas.toBlob(async (markBlob) => {
      if (!markBlob) { toast('Could not prepare the image to save — nothing was lost, please try again'); return; }
      try {
        await DB.saveEditableAnnotation(photoId, mergedBlob, markBlob, annotationObjects, Ink.pack(hist.strokes), layerMeta());
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
      await DB.setAnnotatedBlob(photoId, blob, annotationObjects);
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
