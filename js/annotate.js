// annotate.js - fullscreen photo markup using Canvas + Pointer Events (Apple Pencil Pro support)
//
// Uses two stacked canvases: a base layer holding the photo (drawn once, never touched
// again) and a transparent overlay layer where all pencil strokes and erasing happen.
// The eraser uses 'destination-out' compositing, which previously ran on a single flattened
// canvas and punched through to the photo underneath — keeping annotations on their own
// layer means the eraser can only ever remove marks, never the photo. The two layers are
// flattened into one image only at save time.

const ANNOTATE_COLORS = ['#c81e1e', '#f2b705', '#1c1f26', '#ffffff', '#1e7dc8'];
const ANNOTATE_WIDTHS = { thin: 3, medium: 7, thick: 14 };
const MAX_CANVAS_DIM = 2400; // cap resolution to keep memory/perf sane on large photos

async function loadBitmapCorrected(blob) {
  try {
    return await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch (err) {
    // Fallback path for browsers without the imageOrientation option
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

  // Determine canvas pixel size (cap long edge)
  let cw = naturalW, ch = naturalH;
  const longEdge = Math.max(cw, ch);
  if (longEdge > MAX_CANVAS_DIM) {
    const scale = MAX_CANVAS_DIM / longEdge;
    cw = Math.round(cw * scale);
    ch = Math.round(ch * scale);
  }

  const view = el(`
    <div class="fullscreen" id="annotate-view">
      <div class="annotate-toolbar">
        <button class="tool-btn" id="btn-undo" title="Undo">↺</button>
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
      <div class="annotate-canvas-wrap" id="canvas-wrap">
        <div id="canvas-stack" style="position:relative;">
          <canvas id="photo-canvas" width="${cw}" height="${ch}" style="display:block; width:100%; height:100%;"></canvas>
          <canvas id="mark-canvas" width="${cw}" height="${ch}" style="display:block; width:100%; height:100%; position:absolute; top:0; left:0;"></canvas>
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
  markCanvas.style.touchAction = 'none';
  const photoCtx = photoCanvas.getContext('2d');
  const ctx = markCanvas.getContext('2d'); // all drawing/erasing happens here only

  photoCtx.drawImage(img, 0, 0, cw, ch);
  if (img.close) img.close();

  // Fit the canvas stack to available space via CSS while preserving pixel resolution
  function fitCanvas() {
    const wrap = view.querySelector('#canvas-wrap');
    const stack = view.querySelector('#canvas-stack');
    const availW = wrap.clientWidth - 16;
    const availH = wrap.clientHeight - 16;
    const scale = Math.min(availW / cw, availH / ch, 1) || 1;
    stack.style.width = Math.round(cw * scale) + 'px';
    stack.style.height = Math.round(ch * scale) + 'px';
  }
  fitCanvas();
  window.addEventListener('resize', fitCanvas);

  // Undo stack: snapshot of the annotation layer only, before each stroke
  const undoStack = [];
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
    const snap = undoStack.pop();
    ctx.putImageData(snap, 0, 0);
  });

  // Drawing with Pointer Events (supports Apple Pencil pressure via e.pressure) — all on
  // the annotation layer; the photo layer is never redrawn during the session.
  let drawing = false;
  let lastX = 0, lastY = 0;

  function canvasPoint(e) {
    const rect = markCanvas.getBoundingClientRect();
    const scaleX = cw / rect.width;
    const scaleY = ch / rect.height;
    return { x: (e.clientX - rect.left) * scaleX, y: (e.clientY - rect.top) * scaleY };
  }

  markCanvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch' && e.isPrimary === false) return;
    markCanvas.setPointerCapture(e.pointerId);
    pushUndo();
    drawing = true;
    const p = canvasPoint(e);
    lastX = p.x; lastY = p.y;
    const pressure = e.pressure && e.pressure > 0 ? e.pressure : 0.5;
    const w = eraseMode ? currentWidth * 3 : currentWidth * (0.5 + pressure);
    ctx.globalCompositeOperation = eraseMode ? 'destination-out' : 'source-over';
    ctx.fillStyle = currentColor;
    ctx.beginPath();
    ctx.arc(p.x, p.y, w / 2, 0, Math.PI * 2);
    ctx.fill();
    e.preventDefault();
  });

  markCanvas.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    // Apple Pencil samples at a much higher rate than the browser's paint loop; using
    // coalesced events picks up every intermediate point instead of only the last one
    // per frame, which is what made fast strokes feel laggy or skip segments.
    const events = (typeof e.getCoalescedEvents === 'function' && e.getCoalescedEvents().length) ? e.getCoalescedEvents() : [e];
    for (const ev of events) {
      const p = canvasPoint(ev);
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
    e.preventDefault();
  });

  function endStroke(e) {
    if (!drawing) return;
    drawing = false;
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
    // Flatten photo + annotation layers into a single image for storage/export.
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
