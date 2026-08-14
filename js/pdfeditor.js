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
    const viewport = page.getViewport({ scale: 0.35 });
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
    <div class="annotate-toolbar" style="background:var(--paper); color:var(--ink); border-bottom:1px solid var(--line); flex-wrap:wrap; flex-shrink:0;" id="pdfed-toolbar">
      <button class="small-btn" id="btn-pdfed-rotate-l" title="Rotate left">↺</button>
      <button class="small-btn" id="btn-pdfed-rotate-r" title="Rotate right">↻</button>
      <button class="small-btn" id="btn-pdfed-duplicate">Duplicate</button>
      <button class="small-btn" id="btn-pdfed-delete" style="color:#c81e1e;">Delete</button>
      <button class="small-btn" id="btn-pdfed-extract">Extract</button>
      <div class="spacer"></div>
      <button class="small-btn" id="btn-pdfed-insert">Insert PDF</button>
      <button class="small-btn" id="btn-pdfed-append">Append PDF</button>
      <button class="small-btn" id="btn-pdfed-split">Split</button>
      <button class="small-btn" id="btn-pdfed-rename">Rename</button>
    </div>
    <div style="display:flex; flex:1; min-height:0;">
      <div id="pdfed-sidebar" style="width:150px; flex-shrink:0; overflow-y:auto; background:#f0f0f2; border-right:1px solid var(--line); padding:10px;"></div>
      <div id="pdfed-preview-wrap" style="flex:1; min-width:0; overflow:auto; display:flex; align-items:flex-start; justify-content:center; background:#e4e4e7; padding:20px;">
        <div class="empty-state"><p class="muted">Select a page to preview</p></div>
      </div>
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
  pdfEdWireToolbar();
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
      pdfEdRenderPreview();
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

function pdfEdRenderPreview() {
  const wrap = document.getElementById('pdfed-preview-wrap');
  const page = pdfEdPages.find((p) => p.id === pdfEdPreviewId);
  if (!page) { wrap.innerHTML = `<div class="empty-state"><p class="muted">Select a page to preview</p></div>`; return; }
  wrap.innerHTML = `<img src="${page.thumbUrl}" style="max-width:100%; box-shadow:0 4px 20px rgba(0,0,0,0.25); background:#fff;">`;
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
