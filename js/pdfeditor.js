// ---------- PDF EDITOR ----------
// A standalone tool (not tied to any inspection) for structurally editing PDFs: rotate,
// delete, duplicate, reorder, extract, split, combine/insert/append pages from other PDFs.
// Session-only by design — nothing persists once you leave; Save/Export both just act on
// the current in-memory working document. Uses pdf-lib for the actual page manipulation
// (rotation is applied directly and immediately to the real document — the thumbnail's
// on-screen rotation is just a cheap CSS mirror of that, not a separate deferred state)
// and pdf.js for rendering thumbnails/the main preview.

let pdfEdWorkingDoc = null;   // pdf-lib PDFDocument — the current working state, single source of truth
let pdfEdFilename = 'document';
let pdfEdPages = [];          // ordered descriptors: { id, thumbUrl } — rotation is baked directly into the thumbnail's own pixels, not a separate display transform
let pdfEdSelected = new Set();
let pdfEdPreviewId = null;
let pdfEdCommentMode = false;
let pdfEdDragId = null;

function pdfEdFindIndex(id) {
  return pdfEdPages.findIndex((p) => p.id === id);
}

// Rotates a thumbnail image's actual pixels rather than using a CSS transform — a CSS
// rotate() on an <img> spins the content but leaves the element's own box dimensions
// unchanged, so a 90°/270° rotation visually overflows/clips within what's still a
// portrait-shaped (or landscape-shaped) box. Baking the rotation into real pixel data on a
// correctly-swapped-dimension canvas avoids that entirely.
function pdfEdRotateImageDataUrl(dataUrl, degrees) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const sideways = degrees === 90 || degrees === 270;
      const w = sideways ? img.height : img.width;
      const h = sideways ? img.width : img.height;
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const c = canvas.getContext('2d');
      c.translate(w / 2, h / 2);
      c.rotate((degrees * Math.PI) / 180);
      c.drawImage(img, -img.width / 2, -img.height / 2);
      resolve(canvas.toDataURL('image/jpeg', 0.72));
    };
    img.src = dataUrl;
  });
}

async function renderPdfEditor() {
  appEl.innerHTML = `
    <div class="fullscreen" id="pdfed-view">
      <div class="topbar">
        <button class="icon-btn" id="btn-back">‹</button>
        <div style="flex:1; min-width:0;">
          <h1 style="font-size:17px;" id="pdfed-title">📄 PDF Editor</h1>
          <span class="sub" id="pdfed-subtitle">No document open</span>
        </div>
        <button class="text-btn" id="btn-pdfed-open">Open</button>
      </div>
      <div id="pdfed-body" style="display:flex; flex-direction:column; flex:1; min-height:0;">
        <div class="empty-state">
          <div class="glyph">📄</div>
          <h3>No PDF open</h3>
          <p>Tap Open to load a PDF, or Combine to merge several into one.</p>
          <button class="btn btn-primary" id="btn-pdfed-open-2" style="margin-top:14px;">Open a PDF</button>
          <button class="btn btn-secondary" id="btn-pdfed-combine-2" style="margin-top:10px;">Combine multiple PDFs</button>
        </div>
      </div>
    </div>
    <input type="file" id="pdfed-file-input" accept="application/pdf" style="display:none;">
    <input type="file" id="pdfed-file-input-multi" accept="application/pdf" multiple style="display:none;">
    <input type="file" id="pdfed-file-input-second" accept="application/pdf" style="display:none;">
  `;
  document.getElementById('btn-back').addEventListener('click', () => navigate('#/'));

  const fileInput = document.getElementById('pdfed-file-input');
  const fileInputMulti = document.getElementById('pdfed-file-input-multi');

  async function pickSingleFile() {
    return new Promise((resolve) => {
      fileInput.value = '';
      fileInput.onchange = () => resolve(fileInput.files[0] || null);
      fileInput.click();
    });
  }
  async function pickMultipleFiles() {
    return new Promise((resolve) => {
      fileInputMulti.value = '';
      fileInputMulti.onchange = () => resolve(Array.from(fileInputMulti.files || []));
      fileInputMulti.click();
    });
  }

  async function openSingle() {
    const file = await pickSingleFile();
    if (!file) return;
    toast('Loading PDF…');
    try {
      await loadPdfLib();
      await loadPdfJs();
      const buf = await file.arrayBuffer();
      pdfEdWorkingDoc = await PDFLib.PDFDocument.load(buf);
      pdfEdFilename = file.name.replace(/\.pdf$/i, '');
      pdfEdSelected = new Set();
      pdfEdPreviewId = null;
      await pdfEdRebuildThumbnails();
      renderPdfEdBody();
    } catch (err) {
      console.error('Failed to open PDF', err);
      toast('Could not open that PDF — it may be corrupted or password protected');
    }
  }

  async function combineMultiple() {
    const files = await pickMultipleFiles();
    if (!files.length) return;
    toast('Combining PDFs…');
    try {
      await loadPdfLib();
      await loadPdfJs();
      const combined = await PDFLib.PDFDocument.create();
      for (const file of files) {
        const buf = await file.arrayBuffer();
        const src = await PDFLib.PDFDocument.load(buf);
        const copied = await combined.copyPages(src, src.getPageIndices());
        copied.forEach((p) => combined.addPage(p));
      }
      pdfEdWorkingDoc = combined;
      pdfEdFilename = 'Combined';
      pdfEdSelected = new Set();
      pdfEdPreviewId = null;
      await pdfEdRebuildThumbnails();
      renderPdfEdBody();
    } catch (err) {
      console.error('Failed to combine PDFs', err);
      toast('Could not combine those PDFs');
    }
  }

  document.getElementById('btn-pdfed-open').addEventListener('click', openSingle);
  document.getElementById('btn-pdfed-open-2').addEventListener('click', openSingle);
  document.getElementById('btn-pdfed-combine-2').addEventListener('click', combineMultiple);
}

async function pdfEdRebuildThumbnails() {
  const bytes = await pdfEdWorkingDoc.save();
  const pdfJsDoc = await window.pdfjsLib.getDocument({ data: bytes }).promise;
  const newPages = [];
  for (let i = 1; i <= pdfJsDoc.numPages; i++) {
    const page = await pdfJsDoc.getPage(i);
    // Bumped from the original 0.35 — that was reasonable for the small sidebar thumbnails
    // alone, but is now also used for the enlarged main preview (and its zoom), where it
    // would look visibly soft. Higher resolution costs more memory for very long documents,
    // a tradeoff worth knowing about for very large PDFs specifically.
    const viewport = page.getViewport({ scale: 1.0 });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    const existing = pdfEdPages[i - 1];
    newPages.push({
      id: existing ? existing.id : uid(),
      thumbUrl: canvas.toDataURL('image/jpeg', 0.72)
    });
  }
  pdfEdPages = newPages;
}

function renderPdfEdBody() {
  document.getElementById('pdfed-title').textContent = `📄 ${pdfEdFilename}.pdf`;
  document.getElementById('pdfed-subtitle').textContent = `${pdfEdPages.length} page${pdfEdPages.length === 1 ? '' : 's'}${pdfEdSelected.size ? ` · ${pdfEdSelected.size} selected` : ''}`;

  const body = document.getElementById('pdfed-body');
  body.innerHTML = `
    <div class="annotate-toolbar" style="background:var(--paper); border-bottom:1px solid var(--line); flex-wrap:wrap; flex-shrink:0; gap:8px; padding-top:12px;" id="pdfed-toolbar">
      <button class="pdfed-btn" id="btn-pdfed-rotate-l" title="Rotate left">↺</button>
      <button class="pdfed-btn" id="btn-pdfed-rotate-r" title="Rotate right">↻</button>
      <button class="pdfed-btn" id="btn-pdfed-duplicate">Duplicate</button>
      <button class="pdfed-btn pdfed-btn-danger" id="btn-pdfed-delete">Delete</button>
      <button class="pdfed-btn" id="btn-pdfed-extract">Extract</button>
      <button class="pdfed-btn" id="btn-pdfed-comment">Comment</button>
      <button class="pdfed-btn" id="btn-pdfed-annotate">Sketch</button>
      <button class="pdfed-btn" id="btn-pdfed-compress">Compress</button>
      <div class="spacer"></div>
      <button class="pdfed-btn" id="btn-pdfed-insert">Insert PDF</button>
      <button class="pdfed-btn" id="btn-pdfed-append">Append PDF</button>
      <button class="pdfed-btn" id="btn-pdfed-split">Split</button>
      <button class="pdfed-btn" id="btn-pdfed-rename">Rename</button>
    </div>
    <div style="display:flex; flex:1; min-height:0;">
      <div id="pdfed-sidebar" style="width:150px; flex-shrink:0; overflow-y:auto; background:#f0f0f2; border-right:1px solid var(--line); padding:10px;"></div>
      <div id="pdfed-preview-wrap" style="flex:1; min-width:0; overflow:auto; background:#c8c8cd; touch-action:pan-y;">
        <div id="pdfed-preview-stack" style="padding:20px; display:flex; flex-direction:column; align-items:center; gap:20px;"></div>
      </div>
      <div id="pdfed-comment-panel" style="display:none; flex-shrink:0; border-left:1px solid var(--line); background:#fff;"></div>
    </div>
    <div class="annotate-toolbar" style="background:var(--paper); color:var(--ink); border-top:1px solid var(--line); flex-shrink:0;">
      <button class="btn btn-ghost" id="btn-pdfed-close">Close document</button>
      <div class="spacer"></div>
      <button class="btn btn-secondary" id="btn-pdfed-save">Save</button>
      <button class="btn btn-primary" id="btn-pdfed-export" style="margin-left:8px;">Export</button>
    </div>
  `;
  pdfEdRenderSidebar();
  pdfEdRenderPreview();
  pdfEdWirePreviewZoom();
  pdfEdWireToolbar();
  pdfEdRenderCommentPanel();
}

function pdfEdRenderSidebar() {
  const sidebar = document.getElementById('pdfed-sidebar');
  sidebar.innerHTML = pdfEdPages.map((p, i) => `
    <div class="pdfed-thumb-wrap" data-id="${p.id}" style="margin-bottom:14px; position:relative;">
      <div class="pdfed-thumb ${pdfEdPreviewId === p.id ? 'pdfed-thumb-active' : ''}" data-id="${p.id}" style="border:2px solid ${pdfEdPreviewId === p.id ? 'var(--ink)' : 'var(--line)'}; border-radius:8px; overflow:hidden; background:#fff; cursor:pointer;">
        <img src="${p.thumbUrl}" style="width:100%; display:block;">
      </div>
      <div class="pdfed-check" data-id="${p.id}" style="position:absolute; top:4px; left:4px; width:22px; height:22px; border-radius:50%; background:${pdfEdSelected.has(p.id) ? 'var(--ink)' : 'rgba(255,255,255,0.85)'}; border:1.5px solid var(--line); display:flex; align-items:center; justify-content:center; font-size:12px; color:#fff; cursor:pointer;">${pdfEdSelected.has(p.id) ? '✓' : ''}</div>
      <p class="muted" style="font-size:11px; text-align:center; margin:4px 0 0;">Page ${i + 1}</p>
    </div>
  `).join('');

  sidebar.querySelectorAll('.pdfed-check').forEach((el2) => {
    el2.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = el2.dataset.id;
      if (pdfEdSelected.has(id)) pdfEdSelected.delete(id); else pdfEdSelected.add(id);
      renderPdfEdBody();
    });
  });
  sidebar.querySelectorAll('.pdfed-thumb').forEach((el2) => {
    el2.addEventListener('click', () => {
      pdfEdPreviewId = el2.dataset.id;
      pdfEdRenderSidebarActiveOnly();
      const target = document.getElementById(`pdfed-page-${pdfEdPreviewId}`);
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });

  // Drag-and-drop reordering of the thumbnails.
  sidebar.querySelectorAll('.pdfed-thumb-wrap').forEach((wrap) => {
    wrap.setAttribute('draggable', 'true');
    wrap.addEventListener('dragstart', (e) => {
      pdfEdDragId = wrap.dataset.id;
      e.dataTransfer.effectAllowed = 'move';
    });
    wrap.addEventListener('dragover', (e) => { e.preventDefault(); wrap.style.opacity = '0.5'; });
    wrap.addEventListener('dragleave', () => { wrap.style.opacity = '1'; });
    wrap.addEventListener('drop', async (e) => {
      e.preventDefault();
      wrap.style.opacity = '1';
      const targetId = wrap.dataset.id;
      if (!pdfEdDragId || pdfEdDragId === targetId) return;
      await pdfEdReorder(pdfEdDragId, targetId);
      pdfEdDragId = null;
    });
    // Touch devices: HTML5 drag-and-drop is unreliable on iPadOS Safari, so also support a
    // manual long-press-and-drag using pointer events as a fallback.
    let touchDragTimer = null;
    wrap.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch') return;
      touchDragTimer = setTimeout(() => {
        pdfEdDragId = wrap.dataset.id;
        wrap.style.opacity = '0.5';
      }, 400);
    });
    wrap.addEventListener('pointerup', async (e) => {
      if (touchDragTimer) { clearTimeout(touchDragTimer); touchDragTimer = null; }
      if (!pdfEdDragId) return;
      const el2 = document.elementFromPoint(e.clientX, e.clientY);
      const targetWrap = el2 && el2.closest('.pdfed-thumb-wrap');
      wrap.style.opacity = '1';
      if (targetWrap && targetWrap.dataset.id !== pdfEdDragId) {
        await pdfEdReorder(pdfEdDragId, targetWrap.dataset.id);
      }
      pdfEdDragId = null;
    });
    wrap.addEventListener('pointermove', () => {
      if (touchDragTimer) { clearTimeout(touchDragTimer); touchDragTimer = null; }
    });
  });
}

// Lighter-weight than a full renderPdfEdBody() when only the "which page is previewed"
// selection changes — avoids re-rendering every thumbnail image just to update a border.
function pdfEdRenderSidebarActiveOnly() {
  document.querySelectorAll('.pdfed-thumb').forEach((el2) => {
    const active = el2.dataset.id === pdfEdPreviewId;
    el2.style.border = `2px solid ${active ? 'var(--ink)' : 'var(--line)'}`;
  });
}

// Renders every page as one continuous scrollable list, rather than showing only a single
// selected page — clicking a sidebar thumbnail scrolls this list to that page (see the
// click handler above) instead of swapping out an exclusive single-page view.
function pdfEdRenderPreview() {
  const stack = document.getElementById('pdfed-preview-stack');
  stack.innerHTML = pdfEdPages.map((p, i) => `
    <div id="pdfed-page-${p.id}" class="pdfed-preview-page" data-id="${p.id}" data-pageindex="${i}" style="position:relative; box-shadow:0 4px 20px rgba(0,0,0,0.25); background:#fff;">
      <img src="${p.thumbUrl}" style="display:block; width:100%; pointer-events:none;">
      <div class="pdfed-textlayer" data-pageindex="${i}" style="position:absolute; inset:0; display:none;"></div>
    </div>
  `).join('');
  stack.querySelectorAll('.pdfed-preview-page').forEach((el2) => {
    el2.addEventListener('click', () => {
      if (pdfEdCommentMode) return; // clicks in comment mode are for text selection, not page-switching
      pdfEdPreviewId = el2.dataset.id;
      pdfEdRenderSidebarActiveOnly();
    });
  });
}

// Pinch-to-zoom for the preview pane. Deliberately uses a real CSS width change on each
// page (triggering actual browser reflow) rather than a transform:scale() — a transform
// doesn't reliably expand a scroll container's scrollable bounds the same way across
// browsers, which a CSS-transform-only first attempt at this ran into. A real width change
// means wrap.scrollWidth/scrollHeight always correctly reflect the new content size
// afterward, which is what the pinch-point anchoring below relies on — verified against a
// worked example before shipping. Single-finger scrolling stays entirely native
// (touch-action:pan-y on the wrapper); only an actual two-finger gesture is intercepted.
function pdfEdWirePreviewZoom() {
  const wrap = document.getElementById('pdfed-preview-wrap');
  let scale = 1;
  // Fills most of the available preview width by default (this was the "too small" part
  // of the complaint) rather than a fixed size, capped so it doesn't become unreasonably
  // large on a very wide display.
  const baseWidthPx = Math.min(950, Math.max(320, wrap.clientWidth - 40));

  function applyScale() {
    document.querySelectorAll('.pdfed-preview-page').forEach((el2) => {
      el2.style.width = (baseWidthPx * scale) + 'px';
    });
  }
  applyScale();

  const touchPts = new Map();
  let pinchState = null;

  wrap.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return;
    touchPts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touchPts.size >= 2) pinchState = null; // reset so the next move re-establishes a clean baseline
  });
  wrap.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'touch' || !touchPts.has(e.pointerId)) return;
    touchPts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touchPts.size < 2) return;
    e.preventDefault(); // only suppress native behavior for the actual two-finger gesture
    const pts = Array.from(touchPts.values());
    const dist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
    const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
    if (!pinchState) { pinchState = { startDist: dist, startScale: scale }; return; }

    // Capture the pinch point's position as a fraction of the total (pre-resize) scrollable
    // content, then after resizing, restore scroll so that same fraction lands back under
    // the same screen point — standard technique for anchored zoom on a real (reflowing) resize.
    const wrapRect = wrap.getBoundingClientRect();
    const beforeScrollW = wrap.scrollWidth, beforeScrollH = wrap.scrollHeight;
    const fracX = (wrap.scrollLeft + (mid.x - wrapRect.left)) / beforeScrollW;
    const fracY = (wrap.scrollTop + (mid.y - wrapRect.top)) / beforeScrollH;

    scale = Math.min(4, Math.max(1, pinchState.startScale * (dist / pinchState.startDist)));
    applyScale();

    requestAnimationFrame(() => {
      wrap.scrollLeft = fracX * wrap.scrollWidth - (mid.x - wrapRect.left);
      wrap.scrollTop = fracY * wrap.scrollHeight - (mid.y - wrapRect.top);
    });
  });
  function clearTouch(e) {
    if (e.pointerType !== 'touch') return;
    touchPts.delete(e.pointerId);
    if (touchPts.size < 2) pinchState = null;
  }
  wrap.addEventListener('pointerup', clearTouch);
  wrap.addEventListener('pointercancel', clearTouch);
}

// Reorders the actual pdf-lib document to match a new thumbnail order — rebuilt via
// copyPages into a fresh document rather than relying on any lower-level page-array
// mutation, since copyPages/addPage are the well-documented, reliable core pdf-lib API.
async function pdfEdReorder(draggedId, targetId) {
  const fromIdx = pdfEdFindIndex(draggedId);
  const toIdx = pdfEdFindIndex(targetId);
  if (fromIdx < 0 || toIdx < 0) return;
  const newOrder = pdfEdPages.slice();
  const [moved] = newOrder.splice(fromIdx, 1);
  newOrder.splice(toIdx, 0, moved);
  const newIndices = newOrder.map((p) => pdfEdFindIndex(p.id));

  const rebuilt = await PDFLib.PDFDocument.create();
  const copied = await rebuilt.copyPages(pdfEdWorkingDoc, newIndices);
  copied.forEach((p) => rebuilt.addPage(p));
  pdfEdWorkingDoc = rebuilt;
  pdfEdPages = newOrder;
  renderPdfEdBody();
}

function pdfEdWireToolbar() {
  document.getElementById('btn-pdfed-close').addEventListener('click', () => {
    if (!confirm('Close this document? Any unsaved changes will be lost.')) return;
    pdfEdWorkingDoc = null;
    pdfEdPages = [];
    pdfEdSelected = new Set();
    pdfEdPreviewId = null;
    renderPdfEditor();
  });

  document.getElementById('btn-pdfed-rotate-l').addEventListener('click', () => pdfEdRotateSelection(-90));
  document.getElementById('btn-pdfed-rotate-r').addEventListener('click', () => pdfEdRotateSelection(90));
  document.getElementById('btn-pdfed-delete').addEventListener('click', pdfEdDeleteSelection);
  document.getElementById('btn-pdfed-duplicate').addEventListener('click', pdfEdDuplicateSelection);
  document.getElementById('btn-pdfed-extract').addEventListener('click', () => pdfEdExportPages(pdfEdSelectedIndices(), `${pdfEdFilename}_extracted`));
  document.getElementById('btn-pdfed-rename').addEventListener('click', pdfEdRenamePrompt);
  document.getElementById('btn-pdfed-split').addEventListener('click', pdfEdSplitPrompt);
  document.getElementById('btn-pdfed-insert').addEventListener('click', () => pdfEdMergeSecondFile('insert'));
  document.getElementById('btn-pdfed-append').addEventListener('click', () => pdfEdMergeSecondFile('append'));
  document.getElementById('btn-pdfed-comment').addEventListener('click', pdfEdToggleCommentMode);
  document.getElementById('btn-pdfed-annotate').addEventListener('click', pdfEdAnnotatePageButton);
  document.getElementById('btn-pdfed-compress').addEventListener('click', pdfEdCompressDocument);

  document.getElementById('btn-pdfed-save').addEventListener('click', () => pdfEdExportPages(pdfEdWorkingDoc.getPageIndices(), pdfEdFilename));
  document.getElementById('btn-pdfed-export').addEventListener('click', () => {
    const indices = pdfEdSelected.size ? pdfEdSelectedIndices() : pdfEdWorkingDoc.getPageIndices();
    pdfEdExportPages(indices, pdfEdSelected.size ? `${pdfEdFilename}_selected` : pdfEdFilename);
  });
}

function pdfEdSelectedIndices() {
  return pdfEdPages
    .map((p, i) => (pdfEdSelected.has(p.id) ? i : -1))
    .filter((i) => i >= 0);
}

function pdfEdActiveTargets() {
  // Operates on the selection if there is one, otherwise falls back to whichever page is
  // currently open in the preview pane — so single-page actions don't require selecting
  // first.
  if (pdfEdSelected.size) return Array.from(pdfEdSelected);
  return pdfEdPreviewId ? [pdfEdPreviewId] : [];
}

// ============================================================================
// Sketch tools on PDF pages — rasterizes the target page to a bitmap, opens it
// in the exact same annotator used everywhere else in the app (Findings,
// Drawings, Scale/Annotate), then replaces that page's content with the
// flattened result. This is a real trade-off, not a limitation to hide: the
// annotated page becomes a raster image — marks baked in, but that page's
// live text/vectors are gone. Every other page is untouched. Reuses
// resizeAndCompressImage (pdf.js) so a marked-up page doesn't reintroduce the
// oversized-file problem that motivated building that utility in the first
// place — an unmarked, unresized flattened page would be exactly as bloated.
// ============================================================================

async function pdfEdAnnotatePageButton() {
  const targets = pdfEdActiveTargets();
  if (!targets.length) { toast('Select a page first'); return; }
  if (targets.length > 1) { toast('Select just one page to annotate'); return; }
  const pageIndex = pdfEdFindIndex(targets[0]);
  if (pageIndex < 0) return;
  await pdfEdAnnotatePage(pageIndex);
}

async function pdfEdAnnotatePage(pageIndex) {
  toast('Preparing page…');
  const bytes = await pdfEdWorkingDoc.save();
  const pdfJsDoc = await window.pdfjsLib.getDocument({ data: bytes }).promise;
  const page = await pdfJsDoc.getPage(pageIndex + 1);
  // Rendered notably higher than the preview's own scale:1.0 — this bitmap is
  // what gets marked up and re-embedded, so it needs real working resolution,
  // not just enough to look fine as a small on-screen preview.
  const viewport = page.getViewport({ scale: 2.5 });
  const canvas = document.createElement('canvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
  if (!blob) { toast('Could not prepare this page for annotation'); return; }

  // A temporary photo record so the existing annotator (which always operates
  // on a real photos-store record) can be reused completely unchanged — the
  // same pattern the standalone Scale/Annotate tool already uses for sessions
  // that aren't tied to any inspection. Cleaned up once the result is pulled
  // back out, regardless of whether the user saved or cancelled.
  const photo = await DB.addPhoto({ kind: 'pdfPage', originalBlob: blob });

  openAnnotator(photo.id, async () => {
    try {
      const updated = await DB.get('photos', photo.id);
      const resultBlob = updated && updated.annotatedBlob;
      if (resultBlob) {
        await pdfEdReplacePageWithImage(pageIndex, resultBlob);
        toast('Page updated');
      }
    } catch (err) {
      console.error('Failed to apply page annotation', err);
      toast('Could not save the annotated page — please try again');
    } finally {
      try { await DB.delete('photos', photo.id); } catch (err) { /* best-effort cleanup */ }
    }
  });
}

async function pdfEdReplacePageWithImage(pageIndex, blob) {
  const pdfDoc = pdfEdWorkingDoc;
  const oldPage = pdfDoc.getPage(pageIndex);
  const w = oldPage.getWidth(), h = oldPage.getHeight();
  const rotation = oldPage.getRotation().angle;

  const compressedBlob = await resizeAndCompressImage(blob, 2000, 0.8);
  const imgBytes = new Uint8Array(await compressedBlob.arrayBuffer());
  const jpgImage = await pdfDoc.embedJpg(imgBytes);

  pdfDoc.removePage(pageIndex);
  const newPage = pdfDoc.insertPage(pageIndex, [w, h]);
  newPage.drawImage(jpgImage, { x: 0, y: 0, width: w, height: h });
  if (rotation) newPage.setRotation(PDFLib.degrees(rotation));

  await pdfEdRebuildThumbnails();
}

// ============================================================================
// Compress: recompresses images already embedded in an arbitrary opened PDF —
// a different, harder problem than the sketch/report cases above, since those
// control the source image; this has to find and decode whatever's already in
// the file. Deliberately scoped to the common case: images encoded with a
// plain /DCTDecode (JPEG) filter, which covers most scanned/photographed
// documents — those bytes ARE valid JPEG bytes directly. Anything else
// (chained filters, non-JPEG encodings) is left untouched rather than risking
// a wrong guess at how to decode it. Several of the low-level accessors here
// (resolving XObject dict entries, reading stream bytes/filter) couldn't be
// execute-verified — each image is processed in its own try/catch so one
// wrong guess skips that image rather than breaking the whole document.
// ============================================================================

function pdfEdResolve(context, refOrObj) {
  if (!refOrObj) return refOrObj;
  if (refOrObj instanceof PDFLib.PDFRef) return context.lookup(refOrObj);
  return refOrObj;
}

async function pdfEdCompressDocument() {
  if (!pdfEdWorkingDoc) return;
  if (!confirm('Compress images in this document? Large photos will be resized and recompressed to reduce file size. This cannot be undone (but nothing is saved to your device until you tap Save or Export).')) return;
  toast('Compressing…');

  const pdfDoc = pdfEdWorkingDoc;
  const context = pdfDoc.context;
  let processed = 0, skipped = 0;

  for (const page of pdfDoc.getPages()) {
    let resources;
    try { resources = page.node.Resources(); } catch (err) { continue; }
    if (!resources) continue;
    const xObjectDict = pdfEdResolve(context, resources.get(PDFLib.PDFName.of('XObject')));
    if (!xObjectDict || typeof xObjectDict.keys !== 'function') continue;

    for (const key of xObjectDict.keys()) {
      try {
        const ref = xObjectDict.get(key);
        const stream = pdfEdResolve(context, ref);
        if (!stream) { skipped++; continue; }
        const dict = stream.dict || stream;
        const subtype = dict.get(PDFLib.PDFName.of('Subtype'));
        if (!subtype || subtype.toString() !== '/Image') continue;

        const filter = dict.get(PDFLib.PDFName.of('Filter'));
        if (!filter || filter.toString() !== '/DCTDecode') { skipped++; continue; } // chained/non-JPEG filters skipped, not guessed at

        const rawBytes = stream.contents || stream.getContents?.();
        if (!rawBytes || !rawBytes.length) { skipped++; continue; }

        const originalBlob = new Blob([rawBytes], { type: 'image/jpeg' });
        const compressedBlob = await resizeAndCompressImage(originalBlob, 1800, 0.75);
        if (compressedBlob.size >= originalBlob.size) { skipped++; continue; } // only replace if it's actually smaller

        const compressedBytes = new Uint8Array(await compressedBlob.arrayBuffer());
        const newImage = await pdfDoc.embedJpg(compressedBytes);
        xObjectDict.set(key, newImage.ref);
        processed++;
      } catch (err) {
        console.error('Skipped one image during compression', err);
        skipped++;
      }
    }
  }

  await pdfEdRebuildThumbnails();
  toast(`Compressed ${processed} image${processed === 1 ? '' : 's'}${skipped ? `, skipped ${skipped}` : ''}`);
}

// ============================================================================
// PDF Comments (Highlight + Popup + threaded replies via native PDF annotation
// objects) — NOT rasterized drawing. These are constructed directly against
// pdf-lib's low-level object API (context.obj/register), producing real,
// standards-compliant Highlight/Popup/Text annotation dictionaries readable by
// other PDF software (Acrobat, Preview, etc.), not baked into the page content.
//
// The exact dictionary shape here (QuadPoints ordering, Popup linking via
// /Parent + /Popup, reply threading via /IRT + /RT) was validated end-to-end
// in a standalone spike: built with a low-level PDF object constructor,
// independently re-read and verified with a completely separate PDF library,
// including a genuine two-level reply thread walked back correctly via /IRT.
// That confirms the PDF STRUCTURE itself is correct.
//
// What that spike could NOT verify is this exact translation into pdf-lib's
// JavaScript API specifically — npm access isn't available in this sandbox to
// execute pdf-lib directly, so this part is built from careful reading of
// pdf-lib's own source and a confirmed real-world usage example (both show
// context.obj() accepting plain JS objects/arrays exactly as used below), not
// from direct execution. Real device testing is what finally confirms this
// specific part.
// ============================================================================

function pdfEdDateString(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `D:${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

// Reads a page's existing /Annots array, creating one if it doesn't exist yet.
function pdfEdGetOrCreateAnnots(page) {
  const context = page.doc.context;
  let arr = page.node.Annots ? page.node.Annots() : undefined;
  if (!arr) {
    arr = context.obj([]);
    page.node.set(PDFLib.PDFName.of('Annots'), context.register(arr));
  }
  return arr;
}

// Creates a Highlight annotation (the underlined/marked text) plus its linked
// Popup (the comment box), and appends both to the page. QuadPoints order is
// top-left, top-right, bottom-left, bottom-right per rectangle — this is the
// order real-world viewers expect in practice, per the widely-known ambiguity
// in how the PDF spec's own text on this point is written.
function pdfEdCreateComment(pdfDoc, page, { quadPointsPerRect, rect, contents, author, colorRgb }) {
  const context = pdfDoc.context;
  const highlightDict = context.obj({
    Type: 'Annot',
    Subtype: 'Highlight',
    Rect: rect,
    QuadPoints: quadPointsPerRect,
    C: colorRgb,
    CA: 0.55,
    Contents: contents,
    T: author,
    M: pdfEdDateString(new Date())
  });
  const highlightRef = context.register(highlightDict);

  const popupDict = context.obj({
    Type: 'Annot',
    Subtype: 'Popup',
    Rect: [rect[2] + 20, rect[3], rect[2] + 220, rect[3] + 70],
    Parent: highlightRef,
    Open: false
  });
  const popupRef = context.register(popupDict);
  highlightDict.set(PDFLib.PDFName.of('Popup'), popupRef);

  const annots = pdfEdGetOrCreateAnnots(page);
  annots.push(highlightRef);
  annots.push(popupRef);

  return highlightRef;
}

// Creates a reply annotation threaded to a parent comment (either the original
// Highlight, or another reply) via /IRT — verified in the spike to correctly
// support genuine multi-level threading, not just a single reply.
function pdfEdCreateReply(pdfDoc, page, parentRef, { contents, author }) {
  const context = pdfDoc.context;
  const replyDict = context.obj({
    Type: 'Annot',
    Subtype: 'Text',
    Rect: [0, 0, 20, 20], // replies don't need their own visible marker on the page
    Contents: contents,
    T: author,
    M: pdfEdDateString(new Date()),
    IRT: parentRef,
    RT: 'Reply'
  });
  const replyRef = context.register(replyDict);
  pdfEdGetOrCreateAnnots(page).push(replyRef);
  return replyRef;
}

// Reads every comment (Highlight annotations only — Popups and replies are
// linked to them, not listed as their own top-level comments) on a page,
// with each one's reply thread resolved.
function pdfEdListComments(pdfDoc, page) {
  const annots = page.node.Annots ? page.node.Annots() : undefined;
  if (!annots) return [];
  const all = [];
  for (let i = 0; i < annots.size(); i++) {
    const ref = annots.get(i);
    const dict = pdfDoc.context.lookup(ref);
    if (dict) all.push({ ref, dict });
  }
  const highlights = all.filter((a) => a.dict.get(PDFLib.PDFName.of('Subtype'))?.toString() === '/Highlight');
  return highlights.map((h) => ({
    ref: h.ref,
    dict: h.dict,
    replies: pdfEdCollectReplies(all, h.ref)
  }));
}

// Walks /IRT references to find every reply (direct or nested) to a given
// annotation, in thread order.
function pdfEdCollectReplies(all, parentRef) {
  const direct = all.filter((a) => {
    const irt = a.dict.get(PDFLib.PDFName.of('IRT'));
    return irt && irt.toString() === parentRef.toString();
  });
  let result = [];
  direct.forEach((r) => {
    result.push(r);
    result = result.concat(pdfEdCollectReplies(all, r.ref));
  });
  return result;
}

// Deletes a comment (or reply) and, per an explicit design decision, cascades
// to delete every reply in its thread too — leaving a reply pointing at a
// vanished parent via /IRT was found in testing to be structurally valid but
// confusing to present in a UI, so cascade is the chosen behavior throughout.
function pdfEdDeleteCommentCascade(pdfDoc, page, targetRef) {
  const annots = page.node.Annots ? page.node.Annots() : undefined;
  if (!annots) return;
  const all = [];
  for (let i = 0; i < annots.size(); i++) {
    const ref = annots.get(i);
    const dict = pdfDoc.context.lookup(ref);
    if (dict) all.push({ ref, dict });
  }
  const toDelete = new Set([targetRef.toString()]);
  // Also delete the target's linked Popup, if it has one.
  const targetDict = pdfDoc.context.lookup(targetRef);
  const popupRef = targetDict && targetDict.get(PDFLib.PDFName.of('Popup'));
  if (popupRef) toDelete.add(popupRef.toString());
  // Cascade through every level of replies.
  pdfEdCollectReplies(all, targetRef).forEach((r) => toDelete.add(r.ref.toString()));

  const kept = [];
  for (let i = 0; i < annots.size(); i++) {
    const ref = annots.get(i);
    if (!toDelete.has(ref.toString())) kept.push(ref);
  }
  const newArr = pdfDoc.context.obj(kept);
  page.node.set(PDFLib.PDFName.of('Annots'), pdfDoc.context.register(newArr));
}

// ---- Comment mode: toggles the invisible text-selection layer on every page,
// so native browser text selection can be used to pick what to highlight. ----
async function pdfEdToggleCommentMode() {
  pdfEdCommentMode = !pdfEdCommentMode;
  document.getElementById('btn-pdfed-comment').classList.toggle('pdfed-btn-active', pdfEdCommentMode);
  document.querySelectorAll('.pdfed-textlayer').forEach((el2) => {
    el2.style.display = pdfEdCommentMode ? 'block' : 'none';
  });
  if (pdfEdCommentMode) {
    toast('Select text to add a comment. Tap an existing highlight to view or reply.');
    for (let i = 0; i < pdfEdPages.length; i++) {
      await pdfEdBuildTextLayer(i);
      pdfEdRenderCommentMarkers(i);
    }
    document.addEventListener('selectionchange', pdfEdOnSelectionChange);
  } else {
    document.removeEventListener('selectionchange', pdfEdOnSelectionChange);
    window.getSelection().removeAllRanges();
  }
}

// Builds an invisible, selectable text layer for one page by positioning a
// <span> per pdf.js text item at its correct location. Deliberately computed
// in CSS pixels relative to the container's CURRENT rendered size (a
// snapshot) rather than percentages — font-size can't be expressed as "% of
// container height" in standard CSS, so this rebuilds on zoom-end instead of
// trying to stay continuously responsive during an active pinch gesture.
async function pdfEdBuildTextLayer(pageIndex) {
  const container = document.querySelector(`.pdfed-textlayer[data-pageindex="${pageIndex}"]`);
  if (!container) return;
  const containerRect = container.getBoundingClientRect();
  if (containerRect.width < 10) return;

  const bytes = await pdfEdWorkingDoc.save();
  const pdfJsDoc = await window.pdfjsLib.getDocument({ data: bytes }).promise;
  const page = await pdfJsDoc.getPage(pageIndex + 1);
  const baseViewport = page.getViewport({ scale: 1 });
  const pdfW = baseViewport.width, pdfH = baseViewport.height;
  const scaleX = containerRect.width / pdfW;
  const scaleY = containerRect.height / pdfH;
  const textContent = await page.getTextContent();

  container.innerHTML = '';
  container.dataset.pdfW = pdfW;
  container.dataset.pdfH = pdfH;
  container.dataset.built = '1';

  const markersDiv = document.createElement('div');
  markersDiv.className = 'pdfed-markers';
  markersDiv.style.cssText = 'position:absolute; inset:0; pointer-events:none;';
  container.appendChild(markersDiv);

  textContent.items.forEach((item) => {
    if (!item.str || !item.str.trim()) return;
    const tx = window.pdfjsLib.Util.transform(baseViewport.transform, item.transform);
    const fontHeightPdf = Math.hypot(tx[2], tx[3]);
    const angle = Math.atan2(tx[1], tx[0]);
    const span = document.createElement('span');
    span.textContent = item.str;
    span.style.position = 'absolute';
    span.style.left = (tx[4] * scaleX) + 'px';
    span.style.top = ((tx[5] - fontHeightPdf) * scaleY) + 'px';
    span.style.fontSize = Math.max(1, fontHeightPdf * scaleY) + 'px';
    span.style.fontFamily = 'sans-serif';
    span.style.color = 'transparent';
    span.style.whiteSpace = 'pre';
    span.style.transformOrigin = '0% 0%';
    span.style.cursor = 'text';
    if (Math.abs(angle) > 0.01) span.style.transform = `rotate(${angle}rad)`;
    container.appendChild(span);
  });
}

// Converts the current browser text selection (if it's within this page's
// text layer) into PDF-space QuadPoints + a bounding Rect, using the same
// scaleX/scaleY relationship established when the text layer was built.
function pdfEdSelectionToQuad(container) {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!container.contains(range.commonAncestorContainer)) return null;
  const rects = Array.from(range.getClientRects()).filter((r) => r.width > 1 && r.height > 1);
  if (!rects.length) return null;

  const containerRect = container.getBoundingClientRect();
  const pdfW = parseFloat(container.dataset.pdfW);
  const pdfH = parseFloat(container.dataset.pdfH);
  const scaleX = pdfW / containerRect.width;
  const scaleY = pdfH / containerRect.height;

  let quad = [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  rects.forEach((r) => {
    const x1 = (r.left - containerRect.left) * scaleX;
    const x2 = (r.right - containerRect.left) * scaleX;
    const yTopPdf = pdfH - (r.top - containerRect.top) * scaleY;
    const yBotPdf = pdfH - (r.bottom - containerRect.top) * scaleY;
    quad.push(x1, yTopPdf, x2, yTopPdf, x1, yBotPdf, x2, yBotPdf);
    minX = Math.min(minX, x1); maxX = Math.max(maxX, x2);
    minY = Math.min(minY, yBotPdf); maxY = Math.max(maxY, yTopPdf);
  });
  return { quad, rect: [minX, minY, maxX, maxY], text: range.toString() };
}

let pdfEdSelectionDebounce = null;
function pdfEdOnSelectionChange() {
  clearTimeout(pdfEdSelectionDebounce);
  pdfEdSelectionDebounce = setTimeout(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    const container = Array.from(document.querySelectorAll('.pdfed-textlayer')).find((c) => c.contains(sel.anchorNode));
    if (!container) return;
    const result = pdfEdSelectionToQuad(container);
    if (!result) return;
    const pageIndex = parseInt(container.dataset.pageindex, 10);
    pdfEdShowNewCommentSheet(pageIndex, result);
  }, 400);
}

function pdfEdShowNewCommentSheet(pageIndex, selectionResult) {
  const sheet = el(`
    <div class="sheet-backdrop">
      <div class="sheet">
        <div class="sheet-handle"></div>
        <h2>Add comment</h2>
        <p class="muted" style="margin-top:4px;">On: "${escapeHtml(selectionResult.text.slice(0, 80))}${selectionResult.text.length > 80 ? '…' : ''}"</p>
        <textarea id="pdfed-comment-text" rows="4" style="width:100%; margin-top:12px; padding:10px; border:1.5px solid var(--line); border-radius:8px; font-size:16px;" placeholder="Your comment"></textarea>
        <button class="btn btn-primary btn-block" id="btn-save-comment" style="margin-top:14px;">Add Comment</button>
        <button class="btn btn-ghost btn-block" id="btn-cancel-comment" style="margin-top:8px;">Cancel</button>
      </div>
    </div>
  `);
  document.body.appendChild(sheet);
  sheet.querySelector('#btn-cancel-comment').addEventListener('click', () => {
    window.getSelection().removeAllRanges();
    sheet.remove();
  });
  sheet.querySelector('#btn-save-comment').addEventListener('click', () => {
    const text = sheet.querySelector('#pdfed-comment-text').value.trim();
    if (!text) { toast('Enter a comment first'); return; }
    const page = pdfEdWorkingDoc.getPage(pageIndex);
    pdfEdCreateComment(pdfEdWorkingDoc, page, {
      quadPointsPerRect: selectionResult.quad,
      rect: selectionResult.rect,
      contents: text,
      author: 'Inspector',
      colorRgb: [1, 0.85, 0.2]
    });
    window.getSelection().removeAllRanges();
    sheet.remove();
    pdfEdRenderCommentMarkers(pageIndex);
    pdfEdRenderCommentPanel();
  });
}

// Draws existing comments as tappable semi-transparent overlays, converting
// each Highlight's stored QuadPoints back into CSS pixels using the same
// scale relationship as the text layer itself.
// Reads a numeric value out of whatever pdf-lib actually returns for a
// PDFNumber — tried defensively across a few plausible accessor shapes since
// this specific detail couldn't be execute-verified against the real library.
function pdfEdNum(x) {
  if (typeof x === 'number') return x;
  if (x && typeof x.asNumber === 'function') return x.asNumber();
  if (x && typeof x.value === 'number') return x.value;
  if (window.PDFLib && typeof window.PDFLib.asNumber === 'function') return window.PDFLib.asNumber(x);
  return NaN;
}

function pdfEdRenderCommentMarkers(pageIndex) {
  const container = document.querySelector(`.pdfed-textlayer[data-pageindex="${pageIndex}"]`);
  if (!container || !container.dataset.built) return;
  const markersDiv = container.querySelector('.pdfed-markers');
  if (!markersDiv) return;
  markersDiv.innerHTML = '';

  const containerRect = container.getBoundingClientRect();
  const pdfW = parseFloat(container.dataset.pdfW);
  const pdfH = parseFloat(container.dataset.pdfH);
  const scaleX = containerRect.width / pdfW;
  const scaleY = containerRect.height / pdfH;

  const page = pdfEdWorkingDoc.getPage(pageIndex);
  const comments = pdfEdListComments(pdfEdWorkingDoc, page);
  comments.forEach((c) => {
    const rectArr = c.dict.get(PDFLib.PDFName.of('Rect'));
    if (!rectArr) return;
    const [x1, y1, x2, y2] = [0, 1, 2, 3].map((i) => pdfEdNum(rectArr.get(i)));
    const marker = document.createElement('div');
    marker.style.cssText = `position:absolute; left:${x1 * scaleX}px; top:${(pdfH - y2) * scaleY}px; width:${(x2 - x1) * scaleX}px; height:${(y2 - y1) * scaleY}px; background:rgba(255,217,51,0.4); border-bottom:2px solid rgba(200,150,0,0.8); pointer-events:auto; cursor:pointer;`;
    marker.addEventListener('click', (e) => {
      e.stopPropagation();
      pdfEdShowThreadSheet(pageIndex, c.ref);
    });
    markersDiv.appendChild(marker);

    // Small comment icon, an additional/alternative click target beyond the highlight
    // itself — positioned just above the highlight's top-right corner.
    const icon = document.createElement('div');
    const iconSize = Math.max(16, Math.min(24, (y2 - y1) * scaleY * 0.8));
    icon.style.cssText = `position:absolute; left:${x2 * scaleX - iconSize / 2}px; top:${(pdfH - y2) * scaleY - iconSize / 2}px; width:${iconSize}px; height:${iconSize}px; border-radius:50%; background:#c81e1e; color:#fff; display:flex; align-items:center; justify-content:center; font-size:${iconSize * 0.6}px; pointer-events:auto; cursor:pointer; box-shadow:0 1px 3px rgba(0,0,0,0.3); z-index:1;`;
    icon.textContent = '💬';
    icon.title = 'View comment';
    icon.addEventListener('click', (e) => {
      e.stopPropagation();
      pdfEdShowThreadSheet(pageIndex, c.ref);
    });
    markersDiv.appendChild(icon);
  });
}

function pdfEdShowThreadSheet(pageIndex, highlightRef) {
  const page = pdfEdWorkingDoc.getPage(pageIndex);
  const comments = pdfEdListComments(pdfEdWorkingDoc, page);
  const thread = comments.find((c) => c.ref.toString() === highlightRef.toString());
  if (!thread) return;

  const renderEntry = (dict, isReply) => {
    const author = dict.get(PDFLib.PDFName.of('T'));
    const contents = dict.get(PDFLib.PDFName.of('Contents'));
    return `
      <div style="padding:10px 0; border-bottom:1px solid var(--line); ${isReply ? 'margin-left:20px;' : ''}">
        <div style="font-weight:600; font-size:13px;">${escapeHtml(author ? author.decodeText() : 'Unknown')}</div>
        <div style="margin-top:2px;">${escapeHtml(contents ? contents.decodeText() : '')}</div>
      </div>
    `;
  };

  const sheet = el(`
    <div class="sheet-backdrop">
      <div class="sheet">
        <div class="sheet-handle"></div>
        <h2>Comment thread</h2>
        <div id="pdfed-thread-list" style="max-height:40vh; overflow-y:auto; margin-top:8px;">
          ${renderEntry(thread.dict, false)}
          ${thread.replies.map((r) => renderEntry(r.dict, true)).join('')}
        </div>
        <textarea id="pdfed-reply-text" rows="2" style="width:100%; margin-top:12px; padding:10px; border:1.5px solid var(--line); border-radius:8px; font-size:16px;" placeholder="Reply"></textarea>
        <button class="btn btn-secondary btn-block" id="btn-reply-comment" style="margin-top:10px;">Reply</button>
        <button class="btn btn-ghost btn-block" id="btn-delete-comment" style="margin-top:8px; color:#c81e1e;">Delete comment${thread.replies.length ? ' and all replies' : ''}</button>
        <button class="btn btn-ghost btn-block" id="btn-close-thread" style="margin-top:8px;">Close</button>
      </div>
    </div>
  `);
  document.body.appendChild(sheet);
  sheet.querySelector('#btn-close-thread').addEventListener('click', () => sheet.remove());
  sheet.querySelector('#btn-reply-comment').addEventListener('click', () => {
    const text = sheet.querySelector('#pdfed-reply-text').value.trim();
    if (!text) { toast('Enter a reply first'); return; }
    const lastRef = thread.replies.length ? thread.replies[thread.replies.length - 1].ref : thread.ref;
    pdfEdCreateReply(pdfEdWorkingDoc, page, lastRef, { contents: text, author: 'Inspector' });
    sheet.remove();
    pdfEdRenderCommentMarkers(pageIndex);
    pdfEdRenderCommentPanel();
  });
  sheet.querySelector('#btn-delete-comment').addEventListener('click', () => {
    if (!confirm('Delete this comment' + (thread.replies.length ? ' and all its replies' : '') + '?')) return;
    pdfEdDeleteCommentCascade(pdfEdWorkingDoc, page, thread.ref);
    sheet.remove();
    pdfEdRenderCommentMarkers(pageIndex);
    pdfEdRenderCommentPanel();
  });
}

async function pdfEdRotateSelection(delta) {

  const targets = pdfEdActiveTargets();
  if (!targets.length) { toast('Select a page first'); return; }
  for (const id of targets) {
    const idx = pdfEdFindIndex(id);
    if (idx < 0) continue;
    const page = pdfEdWorkingDoc.getPage(idx);
    const current = page.getRotation().angle;
    const next = ((current + delta) % 360 + 360) % 360;
    page.setRotation(PDFLib.degrees(next));
    // Rotate the thumbnail's actual pixels rather than a CSS transform — see
    // pdfEdRotateImageDataUrl for why. A 90°-multiple pixel rotation is lossless, so
    // rotating the current thumbnail in place (rather than re-deriving from some
    // separately-tracked original) is both correct and simpler.
    pdfEdPages[idx].thumbUrl = await pdfEdRotateImageDataUrl(pdfEdPages[idx].thumbUrl, ((delta % 360) + 360) % 360);
  }
  renderPdfEdBody();
}

async function pdfEdDeleteSelection() {
  const targets = pdfEdActiveTargets();
  if (!targets.length) { toast('Select a page first'); return; }
  if (targets.length >= pdfEdPages.length) { toast("Can't delete every page"); return; }
  if (!confirm(`Delete ${targets.length} page${targets.length === 1 ? '' : 's'}?`)) return;
  const targetSet = new Set(targets);
  const keepIndices = pdfEdPages.map((p, i) => i).filter((i) => !targetSet.has(pdfEdPages[i].id));
  const rebuilt = await PDFLib.PDFDocument.create();
  const copied = await rebuilt.copyPages(pdfEdWorkingDoc, keepIndices);
  copied.forEach((p) => rebuilt.addPage(p));
  pdfEdWorkingDoc = rebuilt;
  pdfEdSelected = new Set();
  pdfEdPreviewId = null;
  await pdfEdRebuildThumbnails();
  renderPdfEdBody();
}

async function pdfEdDuplicateSelection() {
  const targets = pdfEdActiveTargets();
  if (!targets.length) { toast('Select a page first'); return; }
  const targetIndices = targets.map((id) => pdfEdFindIndex(id)).filter((i) => i >= 0).sort((a, b) => a - b);
  // Build a new page order with each target immediately duplicated after itself.
  const newOrder = [];
  pdfEdPages.forEach((p, i) => {
    newOrder.push(i);
    if (targetIndices.includes(i)) newOrder.push(i);
  });
  const rebuilt = await PDFLib.PDFDocument.create();
  const copied = await rebuilt.copyPages(pdfEdWorkingDoc, newOrder);
  copied.forEach((p) => rebuilt.addPage(p));
  pdfEdWorkingDoc = rebuilt;
  pdfEdSelected = new Set();
  await pdfEdRebuildThumbnails();
  renderPdfEdBody();
}

async function pdfEdExportPages(indices, suggestedName) {
  if (!indices || !indices.length) { toast('Nothing to export'); return; }
  toast('Preparing PDF…');
  try {
    const outDoc = await PDFLib.PDFDocument.create();
    const copied = await outDoc.copyPages(pdfEdWorkingDoc, indices);
    copied.forEach((p) => outDoc.addPage(p));
    const bytes = await outDoc.save();
    const blob = new Blob([bytes], { type: 'application/pdf' });
    downloadBlob(blob, `${suggestedName}.pdf`);
  } catch (err) {
    console.error('Export failed', err);
    toast('Export failed — please try again');
  }
}

function pdfEdRenamePrompt() {
  const sheet = el(`
    <div class="sheet-backdrop">
      <div class="sheet">
        <div class="sheet-handle"></div>
        <h2>Rename document</h2>
        <div class="field"><label>Name</label><input type="text" id="f-pdfed-name" value="${esc(pdfEdFilename)}"></div>
        <button class="btn btn-primary btn-block" id="btn-save-pdfed-name">Save</button>
        <button class="btn btn-ghost btn-block" id="btn-cancel-pdfed-name">Cancel</button>
      </div>
    </div>
  `);
  presentOverlay(sheet);
  sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.remove(); });
  sheet.querySelector('#btn-cancel-pdfed-name').addEventListener('click', () => sheet.remove());
  sheet.querySelector('#btn-save-pdfed-name').addEventListener('click', () => {
    const name = sheet.querySelector('#f-pdfed-name').value.trim();
    if (!name) { toast('Enter a name'); return; }
    pdfEdFilename = name;
    sheet.remove();
    renderPdfEdBody();
  });
}

function pdfEdSplitPrompt() {
  const sheet = el(`
    <div class="sheet-backdrop">
      <div class="sheet">
        <div class="sheet-handle"></div>
        <h2>Split PDF</h2>
        <p class="muted" style="font-size:13px; margin-top:-8px;">Enter page numbers to split after, separated by commas — e.g. "5, 12" splits a 20-page document into pages 1–5, 6–12, and 13–20.</p>
        <div class="field"><label>Split after page(s)</label><input type="text" id="f-pdfed-split" placeholder="e.g. 5, 12"></div>
        <button class="btn btn-primary btn-block" id="btn-do-split">Split &amp; download</button>
        <button class="btn btn-ghost btn-block" id="btn-cancel-split">Cancel</button>
      </div>
    </div>
  `);
  presentOverlay(sheet);
  sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.remove(); });
  sheet.querySelector('#btn-cancel-split').addEventListener('click', () => sheet.remove());
  sheet.querySelector('#btn-do-split').addEventListener('click', async () => {
    const raw = sheet.querySelector('#f-pdfed-split').value.trim();
    const total = pdfEdPages.length;
    const points = raw.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isFinite(n) && n > 0 && n < total);
    const uniqueSorted = Array.from(new Set(points)).sort((a, b) => a - b);
    if (!uniqueSorted.length) { toast('Enter at least one valid split point'); return; }
    sheet.remove();
    const boundaries = [0, ...uniqueSorted, total];
    for (let i = 0; i < boundaries.length - 1; i++) {
      const start = boundaries[i], end = boundaries[i + 1];
      const indices = [];
      for (let j = start; j < end; j++) indices.push(j);
      await pdfEdExportPages(indices, `${pdfEdFilename}_part${i + 1}`);
    }
    toast(`Split into ${boundaries.length - 1} files`);
  });
}

function pdfEdMergeSecondFile(mode) {
  const input = document.getElementById('pdfed-file-input-second');
  input.value = '';
  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;
    toast(mode === 'append' ? 'Appending…' : 'Inserting…');
    try {
      const buf = await file.arrayBuffer();
      const src = await PDFLib.PDFDocument.load(buf);
      const copied = await pdfEdWorkingDoc.copyPages(src, src.getPageIndices());
      if (mode === 'append') {
        copied.forEach((p) => pdfEdWorkingDoc.addPage(p));
      } else {
        const insertAt = pdfEdPreviewId ? pdfEdFindIndex(pdfEdPreviewId) + 1 : pdfEdPages.length;
        copied.forEach((p, i) => pdfEdWorkingDoc.insertPage(insertAt + i, p));
      }
      await pdfEdRebuildThumbnails();
      renderPdfEdBody();
    } catch (err) {
      console.error('Merge failed', err);
      toast('Could not read that PDF');
    }
  };
  input.click();
}

// ============================================================================
// Comment preview panel — a collapsible right-side list of every comment in
// the document, only shown when comments actually exist. Selecting one
// scrolls the main preview to it. Collapses into a vertical-text ribbon.
// ============================================================================

let pdfEdCommentPanelCollapsed = false;

function pdfEdListAllComments() {
  if (!pdfEdWorkingDoc) return [];
  const pages = pdfEdWorkingDoc.getPages();
  let all = [];
  pages.forEach((page, i) => {
    const comments = pdfEdListComments(pdfEdWorkingDoc, page);
    comments.forEach((c) => all.push({ ...c, pageIndex: i }));
  });
  return all;
}

function pdfEdRenderCommentPanel() {
  const panel = document.getElementById('pdfed-comment-panel');
  if (!panel) return;
  const allComments = pdfEdListAllComments();
  if (!allComments.length) {
    panel.style.display = 'none';
    return;
  }
  panel.style.display = 'block';

  if (pdfEdCommentPanelCollapsed) {
    panel.style.width = '36px';
    panel.innerHTML = `
      <div id="pdfed-comment-ribbon" style="height:100%; display:flex; align-items:center; justify-content:center; cursor:pointer; padding:10px 0;">
        <div style="writing-mode:vertical-rl; transform:rotate(180deg); font-size:12px; font-weight:650; color:var(--ink); letter-spacing:0.5px; white-space:nowrap;">◀ Comment Preview Window</div>
      </div>
    `;
    document.getElementById('pdfed-comment-ribbon').addEventListener('click', () => {
      pdfEdCommentPanelCollapsed = false;
      pdfEdRenderCommentPanel();
    });
    return;
  }

  panel.style.width = '240px';
  panel.innerHTML = `
    <div style="padding:10px 12px; border-bottom:1px solid var(--line); display:flex; align-items:center; justify-content:space-between;">
      <div style="font-size:13px; font-weight:650;">Comments</div>
      <button id="pdfed-comment-collapse" style="background:none; border:none; font-size:16px; color:var(--muted); padding:2px 4px;" title="Collapse">▶</button>
    </div>
    <div id="pdfed-comment-list" style="overflow-y:auto; padding:8px; height:calc(100% - 41px);"></div>
  `;
  document.getElementById('pdfed-comment-collapse').addEventListener('click', () => {
    pdfEdCommentPanelCollapsed = true;
    pdfEdRenderCommentPanel();
  });

  const list = document.getElementById('pdfed-comment-list');
  list.innerHTML = allComments.map((c) => {
    const contents = c.dict.get(PDFLib.PDFName.of('Contents'));
    const text = contents ? contents.decodeText() : '';
    return `
      <div class="pdfed-comment-item" data-page="${c.pageIndex}" data-ref="${c.ref.toString()}" style="background:#f7f7f8; border-radius:8px; padding:9px 10px; margin-bottom:6px; cursor:pointer;">
        <div style="font-size:11px; color:var(--muted); font-weight:600; margin-bottom:3px;">Page ${c.pageIndex + 1}${c.replies.length ? ` · ${c.replies.length} repl${c.replies.length === 1 ? 'y' : 'ies'}` : ''}</div>
        <div style="font-size:13px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(text)}</div>
      </div>
    `;
  }).join('');
  list.querySelectorAll('.pdfed-comment-item').forEach((item) => {
    item.addEventListener('click', () => pdfEdScrollToComment(Number(item.dataset.page), item.dataset.ref, allComments));
  });
}

// Scrolls the page into view first, then nudges the scroll position toward the comment's
// actual vertical location within that page — a best-effort refinement on top of the core
// "scrolls to it" behavior, not pixel-perfect, since it estimates once the smooth
// scrollIntoView above has likely settled rather than precisely detecting scroll-end.
function pdfEdScrollToComment(pageIndex, refStr, allComments) {
  const comment = allComments.find((c) => c.pageIndex === pageIndex && c.ref.toString() === refStr);
  const pageDesc = pdfEdPages[pageIndex];
  if (!pageDesc) return;
  const pageEl = document.getElementById(`pdfed-page-${pageDesc.id}`);
  if (!pageEl) return;
  pageEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (!comment) return;

  const rectArr = comment.dict.get(PDFLib.PDFName.of('Rect'));
  if (!rectArr) return;
  const y2 = pdfEdNum(rectArr.get(3));
  const pdfPage = pdfEdWorkingDoc.getPage(pageIndex);
  const pdfH = pdfPage.getHeight();
  const fracFromTop = 1 - (y2 / pdfH);

  setTimeout(() => {
    const wrap = document.getElementById('pdfed-preview-wrap');
    const pageRect = pageEl.getBoundingClientRect();
    const wrapRect = wrap.getBoundingClientRect();
    const offsetWithinPage = fracFromTop * pageRect.height;
    wrap.scrollTop += (pageRect.top - wrapRect.top) + offsetWithinPage - 80;
  }, 350);
}
