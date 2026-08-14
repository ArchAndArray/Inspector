// app.js - routing + view rendering for the Site Inspection app

const appEl = document.getElementById('app');
const SEVERITY_LABELS = { 1: 'As New', 2: 'Minor', 3: 'Moderate', 4: 'Severe', 5: 'Failed' };
const EXTENT_LABELS = { A: 'None', B: 'Slight (≤5%)', C: 'Moderate (5–20%)', D: 'Wide (20–50%)', E: 'Extensive (>50%)' };
const PRIORITY_COLORS = { High: '#c81e1e', Medium: '#e0672e', Low: '#4f9d5c', Monitor: '#1e7dc8' };
const CURRENCY_SYMBOLS = { USD: '$', GBP: '£', EUR: '€' };
const INSPECTION_TYPES = ['Safety Inspection', 'Detailed', 'Special', 'Follow-up', 'GI Bridges'];

// Computes the letter for an appendix by its live position (A, B, C…, falling back to a
// number past Z) — never stored, always derived fresh so it stays correct if appendices
// are added, removed, or reordered.
function appendixLetter(index) {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  return letters[index] || String(index + 1);
}
const APP_VERSION = '3.5';

let activeObjectUrls = [];
function blobUrl(blob) {
  const url = URL.createObjectURL(blob);
  activeObjectUrls.push(url);
  return url;
}
function clearObjectUrls() {
  activeObjectUrls.forEach((u) => URL.revokeObjectURL(u));
  activeObjectUrls = [];
}

function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2200);
}

// Surfaces any otherwise-silent JS error as a visible toast. Without this, a throw
// happening outside a try/catch (e.g. before an async function's first await) fails
// with zero visible feedback — exactly the "button does nothing" symptom.
window.addEventListener('error', (e) => {
  console.error('Uncaught error:', e.error || e.message);
  toast('Error: ' + (e.message || 'something went wrong') + ' (line ' + (e.lineno || '?') + ')');
});
window.addEventListener('unhandledrejection', (e) => {
  const msg = (e.reason && e.reason.message) ? e.reason.message : String(e.reason);
  console.error('Unhandled promise rejection:', e.reason);
  toast('Error: ' + msg);
});

// Overlays (sheets and fullscreen views) can nest in either direction depending on the
// flow — a sheet can open a fullscreen view (e.g. New Inspection -> Map picker), and a
// fullscreen view can open a sheet (e.g. Finding editor -> photo action sheet). A fixed
// CSS z-index per type can't handle both directions correctly, so instead each overlay
// gets an increasing z-index at the moment it's shown, guaranteeing whatever opened most
// recently always renders on top.
let overlayZCounter = 100;
function presentOverlay(elToShow) {
  overlayZCounter += 1;
  elToShow.style.zIndex = String(overlayZCounter);
  document.body.appendChild(elToShow);
  return elToShow;
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function esc(str) {
  if (str == null) return '';
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

// ---------- Shared location field (GPS / grid reference / map) ----------
// Returns { html, wire(sheet, getCoords) } — html is inserted into the sheet's markup,
// wire() attaches behavior. getCoords() returns the last known {lat, lng} or null.
function locationFieldHTML(initial) {
  return `
    <div class="field">
      <label>Location</label>
      <input type="text" id="f-location" placeholder="Enter manually, or use a button below" value="${esc(initial)}">
      <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:8px;">
        <button type="button" class="btn btn-secondary" id="btn-use-current-location" style="flex:1; min-width:140px; font-size:13px; padding:10px;">📍 Use Current Location</button>
        <button type="button" class="btn btn-secondary" id="btn-grid-ref" style="flex:1; min-width:140px; font-size:13px; padding:10px;">🧭 Grid Reference</button>
        <button type="button" class="btn btn-secondary" id="btn-pick-map" style="flex:1; min-width:140px; font-size:13px; padding:10px;">🗺️ Map</button>
      </div>
      <p class="hint">Map picker needs an internet connection to load map tiles.</p>
    </div>
  `;
}

function wireLocationField(sheet, initialCoords) {
  let coords = initialCoords && initialCoords.lat != null ? { lat: initialCoords.lat, lng: initialCoords.lng } : null;
  const input = sheet.querySelector('#f-location');

  sheet.querySelector('#btn-use-current-location').addEventListener('click', () => {
    if (!navigator.geolocation) { toast('Location services not available'); return; }
    toast('Locating…');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        coords = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        input.value = `${coords.lat.toFixed(6)}, ${coords.lng.toFixed(6)}`;
        toast('Location captured');
      },
      () => toast('Could not get location'),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  });

  sheet.querySelector('#btn-grid-ref').addEventListener('click', () => {
    openGridReferenceSheet((result) => {
      coords = { lat: result.lat, lng: result.lon };
      input.value = `${result.refText} (${result.gridLabel})`;
      toast('Grid reference converted');
    });
  });

  sheet.querySelector('#btn-pick-map').addEventListener('click', () => {
    openMapPickerSheet(coords, (result) => {
      coords = { lat: result.lat, lng: result.lng };
      input.value = `${result.lat.toFixed(6)}, ${result.lng.toFixed(6)}`;
      toast('Location set from map');
    });
  });

  return { getCoords: () => coords, getManualText: () => input.value.trim() };
}

function openGridReferenceSheet(onConfirm) {
  const sheet = el(`
    <div class="sheet-backdrop">
      <div class="sheet">
        <div class="sheet-handle"></div>
        <h2>Grid reference</h2>
        <div class="field">
          <label>Grid type</label>
          <div class="severity-picker" id="grid-type-picker">
            <button class="chip selected" data-grid="osgb" style="background:var(--ink);">OS National Grid (GB)</button>
            <button class="chip" data-grid="irish">Irish National Grid</button>
          </div>
        </div>
        <div class="field">
          <label>Grid reference</label>
          <input type="text" id="f-gridref" placeholder="e.g. SU 587 149">
          <p class="hint" id="grid-hint">Two letters followed by an even number of digits (e.g. SU 587 149).</p>
        </div>
        <button class="btn btn-primary btn-block" id="btn-convert">Convert &amp; use</button>
        <button class="btn btn-ghost btn-block" id="btn-cancel">Cancel</button>
      </div>
    </div>
  `);
  presentOverlay(sheet);

  let gridType = 'osgb';
  sheet.querySelectorAll('#grid-type-picker .chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      sheet.querySelectorAll('#grid-type-picker .chip').forEach((c) => { c.classList.remove('selected'); c.style.background = ''; });
      chip.classList.add('selected');
      chip.style.background = 'var(--ink)';
      gridType = chip.dataset.grid;
      sheet.querySelector('#grid-hint').textContent = gridType === 'irish'
        ? 'One letter followed by an even number of digits (e.g. O 15 24).'
        : 'Two letters followed by an even number of digits (e.g. SU 587 149).';
    });
  });

  sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.remove(); });
  sheet.querySelector('#btn-cancel').addEventListener('click', () => sheet.remove());
  sheet.querySelector('#btn-convert').addEventListener('click', () => {
    const refText = sheet.querySelector('#f-gridref').value.trim();
    if (!refText) { toast('Enter a grid reference'); return; }
    const result = window.GeoGrid ? window.GeoGrid.convert(refText, gridType) : null;
    if (!result) { toast('Could not parse that grid reference'); return; }
    sheet.remove();
    onConfirm({
      lat: result.lat,
      lon: result.lon,
      refText,
      gridLabel: gridType === 'irish' ? 'Irish National Grid' : 'OS National Grid'
    });
  });
}

let leafletLoadPromise = null;
function loadLeaflet() {
  if (window.L) return Promise.resolve();
  if (leafletLoadPromise) return leafletLoadPromise;
  leafletLoadPromise = new Promise((resolve, reject) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css';
    document.head.appendChild(link);
    const script = document.createElement('script');
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js';
    script.onload = resolve;
    script.onerror = () => reject(new Error('Failed to load map library'));
    document.head.appendChild(script);
  });
  return leafletLoadPromise;
}

// PDF.js (Mozilla's PDF renderer) — distinct from jsPDF, which we use to generate PDFs.
// Loaded on demand, like Leaflet, since it needs an internet connection the first time.
let pdfJsLoadPromise = null;
function loadPdfJs() {
  if (window.pdfjsLib) return Promise.resolve();
  if (pdfJsLoadPromise) return pdfJsLoadPromise;
  pdfJsLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
    script.onload = () => {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
      resolve();
    };
    script.onerror = () => reject(new Error('Failed to load PDF library'));
    document.head.appendChild(script);
  });
  return pdfJsLoadPromise;
}

async function openMapPickerSheet(initialCoords, onConfirm) {
  toast('Loading map…');
  try {
    await loadLeaflet();
  } catch (err) {
    toast('Could not load map — check your internet connection');
    return;
  }

  const view = el(`
    <div class="fullscreen">
      <div class="topbar">
        <button class="icon-btn" id="btn-close">✕</button>
        <div style="flex:1; min-width:0;">
          <h1 style="font-size:17px;">Pick location</h1>
          <span class="sub">Needs internet connection · tap the map to place a pin</span>
        </div>
      </div>
      <div id="map-container" style="flex:1;"></div>
      <div style="padding:16px; border-top:1px solid var(--line); background:var(--paper);">
        <button class="btn btn-primary btn-block" id="btn-confirm-location" disabled>Confirm location</button>
      </div>
    </div>
  `);
  presentOverlay(view);

  const startLat = (initialCoords && initialCoords.lat) || 51.5074;
  const startLng = (initialCoords && initialCoords.lng) || -0.1278;
  const map = L.map(view.querySelector('#map-container')).setView([startLat, startLng], initialCoords ? 15 : 6);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 19
  }).addTo(map);

  let marker = null;
  if (initialCoords) {
    marker = L.marker([startLat, startLng]).addTo(map);
    view.querySelector('#btn-confirm-location').disabled = false;
  }

  map.on('click', (e) => {
    if (marker) map.removeLayer(marker);
    marker = L.marker(e.latlng).addTo(map);
    view.querySelector('#btn-confirm-location').disabled = false;
  });

  setTimeout(() => map.invalidateSize(), 100);

  view.querySelector('#btn-close').addEventListener('click', () => view.remove());
  view.querySelector('#btn-confirm-location').addEventListener('click', () => {
    if (!marker) return;
    const pos = marker.getLatLng();
    view.remove();
    onConfirm({ lat: pos.lat, lng: pos.lng });
  });
}

// iOS Safari quirk: tapping a button while a text field still has focus sometimes only
// dismisses the keyboard on the first tap, requiring a second tap to register the click.
// Blurring the active field as soon as a touch/pointer lands elsewhere fixes this everywhere.
// Excludes Apple Pencil taps specifically — the reported keyboard/Scribble stickiness is
// pencil-specific, so this narrows the blur trigger away from that device while leaving the
// original finger-tap fix fully intact.
document.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'pen') return;
  const active = document.activeElement;
  if (!active) return;
  const isField = active.tagName === 'INPUT' || active.tagName === 'TEXTAREA';
  if (isField && active !== e.target && !(e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) {
    active.blur();
  }
}, true);

// Re-encodes a captured/selected photo to correct pixel orientation (fixes iOS EXIF
// rotation so portrait photos don't appear sideways in canvas-based annotation/PDF export),
// and caps resolution to keep storage reasonable.
async function normalizeImageFile(file, maxDim = 3000) {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    let w = bitmap.width, h = bitmap.height;
    const longEdge = Math.max(w, h);
    if (longEdge > maxDim) {
      const scale = maxDim / longEdge;
      w = Math.round(w * scale);
      h = Math.round(h * scale);
    }
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
    if (bitmap.close) bitmap.close();
    return await new Promise((resolve) => canvas.toBlob((blob) => resolve(blob || file), 'image/jpeg', 0.9));
  } catch (err) {
    console.warn('normalizeImageFile failed, using original file', err);
    return file;
  }
}

// ---------- Routing ----------
function navigate(hash) { window.location.hash = hash; }
window.addEventListener('hashchange', route);
window.addEventListener('DOMContentLoaded', route);

function parseHash() {
  return window.location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
}

async function route() {
  clearObjectUrls();
  const p = parseHash();
  try {
    if (p.length === 0) await renderHome();
    else if (p[0] === 'inspection' && p[1] && p[2] === 'section' && p[3]) await renderSection(p[1], p[3]);
    else if (p[0] === 'inspection' && p[1] && p[2] === 'element' && p[3]) await renderElement(p[1], p[3]);
    else if (p[0] === 'inspection' && p[1] && p[2] === 'risk-assessment') await renderRiskAssessment(p[1]);
    else if (p[0] === 'inspection' && p[1] && p[2] === 'drawings') await renderDrawings(p[1]);
    else if (p[0] === 'inspection' && p[1] && p[2] === 'appendix' && p[3]) await renderAppendix(p[1], p[3]);
    else if (p[0] === 'inspection' && p[1] && p[2] === 'rsection' && p[3] && p[4] === 'drawings') await renderReportSectionDrawings(p[1], p[3]);
    else if (p[0] === 'inspection' && p[1] && p[2] === 'rsection' && p[3] && p[4] === 'text') await renderTextReportSection(p[1], p[3]);
    else if (p[0] === 'inspection' && p[1] && p[2] === 'rsection' && p[3] && p[4] === 'locationMap') await renderLocationMapReportSection(p[1], p[3]);
    else if (p[0] === 'inspection' && p[1] && p[2] === 'rsection' && p[3] && p[4] === 'inspectionDetails') await renderBasicInfoReportSection(p[1], p[3]);
    else if (p[0] === 'inspection' && p[1] && p[2] === 'rsection' && p[3] && p[4] === 'elementSummary') await renderElementSummaryReportSection(p[1], p[3]);
    else if (p[0] === 'inspection' && p[1] && p[2] === 'rsection' && p[3] && p[4] === 'inspection') await renderInspectionFindingsReportSection(p[1], p[3]);
    else if (p[0] === 'inspection' && p[1] && p[2] === 'rsection' && p[3] && p[4] === 'appendices' && p[5]) await renderReportSectionAppendix(p[1], p[3], p[5]);
    else if (p[0] === 'inspection' && p[1] && p[2] === 'rsection' && p[3] && p[4] === 'appendices') await renderReportSectionAppendicesList(p[1], p[3]);
    else if (p[0] === 'inspection' && p[1] && !p[2]) await renderInspection(p[1]);
    else if (p[0] === 'templates') await renderTemplates();
    else if (p[0] === 'scale-annotate') await renderScaleAnnotate();
    else await renderHome();
  } catch (err) {
    console.error(err);
    appEl.innerHTML = `<div class="center-note">Something went wrong loading this screen.<br>${esc(err.message)}</div>`;
  }
}

// ---------- Reusable: photo action sheet (used by cover, element photos, finding photos) ----------
async function openPhotoActionSheet(photoId, { onAnnotated, onRemoved, onCaptioned } = {}) {
  const photo = await DB.get('photos', photoId);
  const s = el(`
    <div class="sheet-backdrop">
      <div class="sheet">
        <div class="sheet-handle"></div>
        <h2>Photo</h2>
        <div class="field">
          <label>Description</label>
          <input type="text" id="f-caption" value="${esc(photo && photo.caption)}" placeholder="Shown under the photo in the report">
        </div>
        <button class="btn btn-secondary btn-block" id="btn-save-caption">Save description</button>
        <button class="btn btn-primary btn-block" id="btn-annotate" style="margin-top:10px;">✏️ Edit — draw with Pencil</button>
        <button class="btn btn-danger btn-block" id="btn-remove" style="margin-top:10px;">Remove photo</button>
        <button class="btn btn-ghost btn-block" id="btn-cancel" style="margin-top:10px;">Cancel</button>
      </div>
    </div>
  `);
  presentOverlay(s);
  s.addEventListener('click', (e) => { if (e.target === s) s.remove(); });
  s.querySelector('#btn-cancel').addEventListener('click', () => s.remove());
  s.querySelector('#btn-save-caption').addEventListener('click', async () => {
    await DB.updatePhoto(photoId, { caption: s.querySelector('#f-caption').value.trim() });
    s.remove();
    if (onCaptioned) onCaptioned();
  });
  s.querySelector('#btn-annotate').addEventListener('click', async () => {
    s.remove();
    await openAnnotator(photoId, onAnnotated);
  });
  s.querySelector('#btn-remove').addEventListener('click', async () => {
    await DB.delete('photos', photoId);
    s.remove();
    if (onRemoved) onRemoved();
  });
}

function openPhotoSourceSheet({ onFiles, multiple = false, onSketch = null }) {
  const s = el(`
    <div class="sheet-backdrop">
      <div class="sheet">
        <div class="sheet-handle"></div>
        <h2>Add photo</h2>
        <button class="btn btn-primary btn-block" id="btn-camera">📷 Take photo</button>
        <button class="btn btn-secondary btn-block" id="btn-library" style="margin-top:10px;">🖼 Choose from library</button>
        ${onSketch ? '<button class="btn btn-secondary btn-block" id="btn-sketch" style="margin-top:10px;">✏️ Draw a sketch</button>' : ''}
        <button class="btn btn-ghost btn-block" id="btn-cancel" style="margin-top:10px;">Cancel</button>
        <input type="file" id="src-camera" accept="image/*" capture="environment" style="display:none;">
        <input type="file" id="src-library" accept="image/*" ${multiple ? 'multiple' : ''} style="display:none;">
      </div>
    </div>
  `);
  presentOverlay(s);
  s.addEventListener('click', (e) => { if (e.target === s) s.remove(); });
  s.querySelector('#btn-cancel').addEventListener('click', () => s.remove());
  s.querySelector('#btn-camera').addEventListener('click', () => s.querySelector('#src-camera').click());
  s.querySelector('#btn-library').addEventListener('click', () => s.querySelector('#src-library').click());
  s.querySelector('#src-camera').addEventListener('change', (e) => { const f = e.target.files; s.remove(); if (f.length) onFiles(f); });
  s.querySelector('#src-library').addEventListener('change', (e) => { const f = e.target.files; s.remove(); if (f.length) onFiles(f); });
  if (onSketch) {
    s.querySelector('#btn-sketch').addEventListener('click', () => { s.remove(); onSketch(); });
  }
}

// A blank white canvas, used as the starting point for a freehand sketch (rather than an
// annotated photo) — same resolution ballpark as a normalized camera photo, so it behaves
// identically once it reaches the annotator.
function createBlankCanvasBlob(w = 1600, h = 1200) {
  return new Promise((resolve) => {
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    canvas.toBlob((blob) => resolve(blob), 'image/jpeg', 0.95);
  });
}

// A4 portrait proportions (1:1.414, ~200dpi) rather than the generic 4:3 sketch canvas
// above — for Drawing section sketches specifically, so they fill a report page properly
// instead of looking squeezed or letterboxed.
function createA4CanvasBlob() {
  return createBlankCanvasBlob(1654, 2339);
}

// Prompts for a sketch's title before it's created, so it's genuinely print-ready in one
// step rather than sitting as "Untitled" until edited later.
function openSketchTitlePrompt(onConfirm) {
  const sheet = el(`
    <div class="sheet-backdrop">
      <div class="sheet">
        <div class="sheet-handle"></div>
        <h2>Name this sketch</h2>
        <div class="field"><label>Title</label><input type="text" id="f-sketch-title" placeholder="Untitled Sketch"></div>
        <button class="btn btn-primary btn-block" id="btn-start-sketch">Start sketch</button>
        <button class="btn btn-ghost btn-block" id="btn-cancel-sketch">Cancel</button>
      </div>
    </div>
  `);
  presentOverlay(sheet);
  sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.remove(); });
  sheet.querySelector('#btn-cancel-sketch').addEventListener('click', () => sheet.remove());
  sheet.querySelector('#btn-start-sketch').addEventListener('click', () => {
    const title = sheet.querySelector('#f-sketch-title').value.trim() || 'Untitled Sketch';
    sheet.remove();
    onConfirm(title);
  });
}

// ---------- Force update / resync from GitHub ----------
async function forceUpdate() {
  toast('Checking for updates…');
  try {
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
    setTimeout(() => window.location.reload(), 500);
  } catch (err) {
    console.error('Update check failed', err);
    toast('Update check failed — try again while online');
  }
}

// Manually forces a real focus→blur cycle on a throwaway hidden input, distinct from what
// the global blur-on-tap listener already does (which only ever blurs, never focuses
// anything) — offered as a fallback if the on-screen keyboard still gets stuck in its
// compact Scribble layout after using Apple Pencil, without leaving the app to toggle
// Scribble off in Settings. Not guaranteed to work — there's no documented API into this
// iPadOS behavior — but a genuine, distinct attempt worth having on hand.
function resetKeyboardState() {
  const dummy = document.createElement('input');
  dummy.type = 'text';
  dummy.style.cssText = 'position:fixed; top:-100px; left:-100px; width:1px; height:1px; opacity:0;';
  document.body.appendChild(dummy);
  dummy.focus();
  setTimeout(() => {
    dummy.blur();
    dummy.remove();
  }, 50);
}

// ---------- BACKUP & RESTORE (raw data export/import) ----------
function openBackupRestoreSheet() {
  const sheet = el(`
    <div class="sheet-backdrop">
      <div class="sheet">
        <div class="sheet-handle"></div>
        <h2>Backup &amp; restore</h2>
        <p class="muted" style="font-size:13px; margin-top:-8px;">Export everything on this device — inspections, elements, findings, photos, and risk assessments — to a single file, or restore from a previous backup. Useful before reinstalling the app or moving to a new device.</p>
        <button class="btn btn-primary btn-block" id="btn-do-export">⬆️ Export all data</button>
        <button class="btn btn-secondary btn-block" id="btn-do-import" style="margin-top:10px;">⬇️ Import data</button>
        <input type="file" id="backup-file-input" accept="application/json" style="display:none;">

        <div class="section-header" style="margin-top:22px;"><h2>Device utilities</h2></div>
        <p class="muted" style="font-size:13px; margin-top:-4px;">If the on-screen keyboard gets stuck in its small Scribble layout after using Apple Pencil, try this before resorting to Settings → Scribble.</p>
        <button class="btn btn-secondary btn-block" id="btn-reset-keyboard">⌨️ Reset keyboard</button>

        <button class="btn btn-ghost btn-block" id="btn-cancel" style="margin-top:16px;">Close</button>
      </div>
    </div>
  `);
  presentOverlay(sheet);
  sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.remove(); });
  sheet.querySelector('#btn-cancel').addEventListener('click', () => sheet.remove());

  sheet.querySelector('#btn-reset-keyboard').addEventListener('click', () => {
    resetKeyboardState();
    toast('Keyboard reset');
  });

  sheet.querySelector('#btn-do-export').addEventListener('click', async () => {
    toast('Preparing export…');
    try {
      const count = await exportRawDataBackup();
      toast(`Export ready — ${count} records — check your downloads`);
    } catch (err) {
      console.error(err);
      toast('Export failed: ' + err.message);
    }
  });

  sheet.querySelector('#btn-do-import').addEventListener('click', () => {
    sheet.querySelector('#backup-file-input').click();
  });
  sheet.querySelector('#backup-file-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (!confirm('Import this backup? Records with matching IDs will be overwritten; everything else will be added alongside your current data.')) {
      e.target.value = '';
      return;
    }
    toast('Importing…');
    try {
      const count = await importRawDataBackup(file);
      sheet.remove();
      toast(`Imported ${count} records`);
      route();
    } catch (err) {
      console.error(err);
      toast('Import failed: ' + err.message);
    }
    e.target.value = '';
  });
}

// ---------- HOME ----------
async function renderHome() {
  const inspections = await DB.listInspections();
  const rows = inspections.map((insp) => `
    <div class="list-item" data-id="${insp.id}">
      <div class="meta">
        <h3>${esc(insp.structureName || 'Untitled structure')}</h3>
        <p>${esc(insp.inspectionType || 'Inspection')} · ${fmtDate(insp.date)}${insp.inspector ? ' · ' + esc(insp.inspector) : ''}</p>
      </div>
      <span class="chevron">›</span>
    </div>
  `).join('');

  appEl.innerHTML = `
    <div class="topbar">
      <div style="flex:1; min-width:0;">
        <h1>Inspector</h1>
        <span class="sub">by Arch&amp;Array · v${APP_VERSION}</span>
      </div>
      <button class="icon-btn" id="btn-update" title="Check for updates">⟳</button>
      <button class="icon-btn" id="btn-backup" title="Backup & restore">💾</button>
      <button class="icon-btn" id="btn-scale-annotate" title="Scale / Annotate">📐</button>
      <button class="icon-btn" id="btn-new-sketch" title="New sketch">✏️</button>
      <button class="icon-btn" id="btn-templates" title="Element templates">☰</button>
    </div>
    <div class="content">
      ${inspections.length ? rows : `
        <div class="empty-state">
          <div class="glyph">＋</div>
          <h3>No inspections yet</h3>
          <p>Start a new inspection to begin logging findings.</p>
        </div>
      `}
    </div>
    <button class="fab" id="btn-new-inspection">＋</button>
  `;

  appEl.querySelectorAll('.list-item').forEach((row) => row.addEventListener('click', () => navigate(`#/inspection/${row.dataset.id}`)));
  document.getElementById('btn-new-inspection').addEventListener('click', openNewInspectionSheet);
  document.getElementById('btn-templates').addEventListener('click', () => navigate('#/templates'));
  document.getElementById('btn-update').addEventListener('click', forceUpdate);
  document.getElementById('btn-backup').addEventListener('click', openBackupRestoreSheet);
  document.getElementById('btn-scale-annotate').addEventListener('click', () => navigate('#/scale-annotate'));
  document.getElementById('btn-new-sketch').addEventListener('click', async () => {
    const blank = await createBlankCanvasBlob();
    const rec = await DB.addStandaloneAnnotation(blank, 'Sketch', 'image');
    navigate('#/scale-annotate');
    await openAnnotator(rec.id, () => renderScaleAnnotate());
  });
}

function openNewInspectionSheet() {
  const sheet = el(`
    <div class="sheet-backdrop">
      <div class="sheet">
        <div class="sheet-handle"></div>
        <h2>New inspection</h2>
        <div class="field"><label>Structure name / project</label><input type="text" id="f-structureName" placeholder="e.g. Riverside Footbridge"></div>
        <div class="field"><label>Structure ID</label><input type="text" id="f-structureId" placeholder="e.g. BR-0042"></div>
        <div class="field">
          <label>Inspection type</label>
          <select id="f-inspectionType">
            ${INSPECTION_TYPES.map((t) => `<option value="${t}">${t}</option>`).join('')}
          </select>
        </div>
        <div class="field"><label>Date</label><input type="date" id="f-date"></div>
        <div class="field"><label>Inspector</label><input type="text" id="f-inspector" placeholder="Name"></div>
        <div class="field"><label>Weather</label><input type="text" id="f-weather" placeholder="e.g. Overcast, 14°C"></div>
        ${locationFieldHTML('')}

        <div class="section-header" style="margin-top:22px;"><h2>Report Style</h2></div>
        <div class="severity-picker" id="report-style-picker">
          <button class="chip selected" data-style="old" style="background:var(--ink);">Old Style<span class="chip-label">Current system</span></button>
          <button class="chip" data-style="new">New Style<span class="chip-label">Flexible sections</span></button>
        </div>
        <p class="hint" id="style-hint">The proven, current report system — Introduction, Summary, Conclusion, Drawings, and Appendices exactly as they work today.</p>
        <div class="field hidden" id="template-field">
          <label>Starting template</label>
          <select id="f-template"></select>
          <p class="hint">Defines the starting set of sections — fully editable afterward.</p>
        </div>

        <button class="btn btn-primary btn-block" id="btn-create-inspection" style="margin-top:14px;">Create inspection</button>
        <button class="btn btn-ghost btn-block" id="btn-cancel">Cancel</button>
      </div>
    </div>
  `);
  presentOverlay(sheet);
  sheet.querySelector('#f-date').value = new Date().toISOString().slice(0, 10);

  const locationField = wireLocationField(sheet, null);

  let reportStyle = 'old';
  DB.seedDefaultReportTemplate().then(() => DB.listReportTemplates()).then((templates) => {
    const select = sheet.querySelector('#f-template');
    select.innerHTML = templates.map((t) => `<option value="${t.id}" ${t.id === 'default-template' ? 'selected' : ''}>${esc(t.name)}</option>`).join('');
  });

  sheet.querySelectorAll('#report-style-picker .chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      sheet.querySelectorAll('#report-style-picker .chip').forEach((c) => { c.classList.remove('selected'); c.style.background = ''; });
      chip.classList.add('selected');
      chip.style.background = 'var(--ink)';
      reportStyle = chip.dataset.style;
      sheet.querySelector('#template-field').classList.toggle('hidden', reportStyle !== 'new');
      sheet.querySelector('#style-hint').textContent = reportStyle === 'new'
        ? 'Build the report from an ordered list of sections you choose and arrange yourself — still being tested, so Old Style is recommended for reports you need to finish reliably right now.'
        : 'The proven, current report system — Introduction, Summary, Conclusion, Drawings, and Appendices exactly as they work today.';
    });
  });

  sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.remove(); });
  sheet.querySelector('#btn-cancel').addEventListener('click', () => sheet.remove());
  sheet.querySelector('#btn-create-inspection').addEventListener('click', async () => {
    const structureName = sheet.querySelector('#f-structureName').value.trim();
    if (!structureName) { toast('Enter a structure name'); return; }
    const coords = locationField.getCoords();
    const insp = await DB.createInspection({
      structureName,
      structureId: sheet.querySelector('#f-structureId').value.trim(),
      inspectionType: sheet.querySelector('#f-inspectionType').value,
      date: sheet.querySelector('#f-date').value,
      inspector: sheet.querySelector('#f-inspector').value.trim(),
      weather: sheet.querySelector('#f-weather').value.trim(),
      location: { ...(coords || {}), manual: locationField.getManualText() },
      title: 'Structural Inspection Report',
      subtitle: '',
      reportStyle
    });
    if (reportStyle === 'new') {
      const templateId = sheet.querySelector('#f-template').value;
      if (templateId) await DB.applyReportTemplate(insp.id, templateId);
    }
    sheet.remove();
    navigate(`#/inspection/${insp.id}`);
  });
}

// ---------- NEW STYLE REPORTS (flexible, user-ordered sections) ----------
const REPORT_SECTION_TYPES = {
  text: { label: 'Text', icon: '📝' },
  drawing: { label: 'Drawing', icon: '📐' },
  inspection: { label: 'Inspection Findings', icon: '🏗️' },
  locationMap: { label: 'Location Map', icon: '🗺️' },
  inspectionDetails: { label: 'Basic Inspection Information', icon: 'ℹ️' },
  elementSummary: { label: 'Element Summary', icon: '📊' },
  appendices: { label: 'Appendices', icon: '📎' }
};

async function renderInspectionNewStyle(inspectionId, insp) {
  let reportSections = await DB.listReportSections(inspectionId);

  appEl.innerHTML = `
    <div class="topbar">
      <button class="icon-btn" id="btn-back">‹</button>
      <div style="flex:1; min-width:0;">
        <h1 style="font-size:17px;">${esc(insp.structureName)}</h1>
        <span class="sub">${esc(insp.inspectionType)} · New Style</span>
      </div>
      <button class="icon-btn" id="btn-risk-assessment" title="Risk Assessment">⚠️</button>
      <button class="text-btn" id="btn-report-info">Info</button>
      <button class="text-btn" id="btn-print">Print</button>
    </div>
    <div class="content" id="rs-list"></div>
    <button class="fab" id="btn-add-section">＋</button>
  `;
  document.getElementById('btn-back').addEventListener('click', () => navigate('#/'));
  document.getElementById('btn-risk-assessment').addEventListener('click', () => navigate(`#/inspection/${inspectionId}/risk-assessment`));
  document.getElementById('btn-report-info').addEventListener('click', () => openReportInfoSheet(inspectionId));
  document.getElementById('btn-print').addEventListener('click', () => {
    try { exportInspectionPDFNewStyle(inspectionId); } catch (err) { console.error(err); toast('Error: ' + err.message); }
  });
  document.getElementById('btn-add-section').addEventListener('click', () => openAddReportSectionSheet(inspectionId, async () => { reportSections = await DB.listReportSections(inspectionId); renderList(); }));

  function renderList() {
    const list = document.getElementById('rs-list');
    if (!reportSections.length) {
      list.innerHTML = `
        <div class="empty-state">
          <div class="glyph">📄</div>
          <h3>No sections yet</h3>
          <p>Tap ＋ to add your first report section — text, drawings, an inspection group, the location map, details, element summary, or appendices.</p>
        </div>`;
      return;
    }
    list.innerHTML = reportSections.map((s) => {
      const typeInfo = REPORT_SECTION_TYPES[s.type] || { label: s.type, icon: '📄' };
      return `
        <div class="list-item" data-rs="${s.id}">
          <input type="number" class="rs-order-input" data-rs-order="${s.id}" value="${s.order}" min="1" max="${reportSections.length}">
          <div class="meta">
            <h3>${typeInfo.icon} ${esc(s.title) || typeInfo.label}</h3>
            <p>${typeInfo.label}</p>
          </div>
          <span class="chevron">›</span>
        </div>
      `;
    }).join('') + `<button class="small-btn" id="btn-save-template" style="margin-top:6px;">💾 Save this section set as a template</button>`;

    const saveTemplateBtn = list.querySelector('#btn-save-template');
    if (saveTemplateBtn) saveTemplateBtn.addEventListener('click', () => openSaveReportTemplateSheet(reportSections));

    list.querySelectorAll('[data-rs]').forEach((row) => {
      row.addEventListener('click', (e) => {
        if (e.target.classList.contains('rs-order-input')) return;
        const s = reportSections.find((x) => x.id === row.dataset.rs);
        openReportSectionEditor(inspectionId, s);
      });
    });
    list.querySelectorAll('.rs-order-input').forEach((input) => {
      input.addEventListener('click', (e) => e.stopPropagation());
      input.addEventListener('change', async (e) => {
        e.stopPropagation();
        const newOrder = Number(e.target.value);
        if (!newOrder || newOrder < 1) { renderList(); return; }
        await DB.reorderReportSection(inspectionId, input.dataset.rsOrder, newOrder);
        reportSections = await DB.listReportSections(inspectionId);
        renderList();
      });
    });
  }
  renderList();
}

function openSaveReportTemplateSheet(reportSections) {
  const sheet = el(`
    <div class="sheet-backdrop">
      <div class="sheet">
        <div class="sheet-handle"></div>
        <h2>Save as template</h2>
        <p class="muted" style="font-size:13px; margin-top:-8px;">Saves the current set of section types, titles, and order — not their content — as a reusable starting point for future New Style inspections.</p>
        <div class="field"><label>Template name</label><input type="text" id="f-tpl-name" placeholder="e.g. Detailed Bridge Report"></div>
        <button class="btn btn-primary btn-block" id="btn-save-tpl">Save template</button>
        <button class="btn btn-ghost btn-block" id="btn-cancel">Cancel</button>
      </div>
    </div>
  `);
  presentOverlay(sheet);
  sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.remove(); });
  sheet.querySelector('#btn-cancel').addEventListener('click', () => sheet.remove());
  sheet.querySelector('#btn-save-tpl').addEventListener('click', async () => {
    const name = sheet.querySelector('#f-tpl-name').value.trim();
    if (!name) { toast('Enter a template name'); return; }
    const shells = reportSections
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((s) => ({ type: s.type, title: s.title }));
    await DB.saveReportTemplate(name, shells);
    sheet.remove();
    toast('Template saved');
  });
}

function openAddReportSectionSheet(inspectionId, onAdded) {
  const sheet = el(`
    <div class="sheet-backdrop">
      <div class="sheet">
        <div class="sheet-handle"></div>
        <h2>Add section</h2>
        ${Object.entries(REPORT_SECTION_TYPES).map(([type, info]) => `
          <button class="btn btn-secondary btn-block" data-type="${type}" style="margin-top:8px; text-align:left;">${info.icon}&nbsp;&nbsp;${info.label}</button>
        `).join('')}
        <button class="btn btn-ghost btn-block" id="btn-cancel" style="margin-top:16px;">Cancel</button>
      </div>
    </div>
  `);
  presentOverlay(sheet);
  sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.remove(); });
  sheet.querySelector('#btn-cancel').addEventListener('click', () => sheet.remove());
  sheet.querySelectorAll('[data-type]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const type = btn.dataset.type;
      const info = REPORT_SECTION_TYPES[type];
      sheet.remove();
      const section = await DB.addReportSection(inspectionId, type, info.label);
      openReportSectionEditor(inspectionId, section);
    });
  });
}

function openReportSectionEditor(inspectionId, section) {
  if (section.type === 'drawing') { navigate(`#/inspection/${inspectionId}/rsection/${section.id}/drawings`); return; }
  if (section.type === 'appendices') { navigate(`#/inspection/${inspectionId}/rsection/${section.id}/appendices`); return; }
  navigate(`#/inspection/${inspectionId}/rsection/${section.id}/${section.type}`);
}

function reportSectionPageHeader(section, inspectionId, insp) {
  return `
    <div class="topbar">
      <button class="icon-btn" id="btn-back">‹</button>
      <div style="flex:1; min-width:0;">
        <h1 style="font-size:17px;">${REPORT_SECTION_TYPES[section.type].icon} ${esc(section.title) || REPORT_SECTION_TYPES[section.type].label}</h1>
        <span class="sub">${esc(insp.structureName)} · ${REPORT_SECTION_TYPES[section.type].label}</span>
      </div>
      <button class="text-btn" id="btn-delete-section" style="color:#ff9d9d;">Delete</button>
    </div>
  `;
}
function wireReportSectionPageHeader(inspectionId, section) {
  document.getElementById('btn-back').addEventListener('click', () => navigate(`#/inspection/${inspectionId}`));
  document.getElementById('btn-delete-section').addEventListener('click', async () => {
    if (!confirm('Delete this section?')) return;
    await DB.deleteReportSectionCascade(section.id);
    navigate(`#/inspection/${inspectionId}`);
  });
}

async function renderTextReportSection(inspectionId, reportSectionId) {
  const insp = await DB.get('inspections', inspectionId);
  const section = await DB.get('reportSections', reportSectionId);
  if (!insp || !section) { navigate(`#/inspection/${inspectionId}`); return; }
  appEl.innerHTML = `
    ${reportSectionPageHeader(section, inspectionId, insp)}
    <div class="content">
      <div class="field"><label>Title</label><input type="text" id="f-title" value="${esc(section.title)}"></div>
      ${richTextToolbarHTML('rst')}
      <div class="rt-editor" id="rst-editor" contenteditable="true"></div>
      <button class="btn btn-primary btn-block" id="btn-save" style="margin-top:14px;">Save</button>
    </div>
  `;
  wireReportSectionPageHeader(inspectionId, section);
  const editorApi = wireRichTextEditor(appEl, 'rst', section.textHtml);
  document.getElementById('btn-save').addEventListener('click', async () => {
    await DB.updateReportSection(section.id, { title: document.getElementById('f-title').value.trim(), textHtml: editorApi.getHTML() });
    toast('Saved');
    renderTextReportSection(inspectionId, reportSectionId);
  });
}

async function renderLocationMapReportSection(inspectionId, reportSectionId) {
  const insp = await DB.get('inspections', inspectionId);
  const section = await DB.get('reportSections', reportSectionId);
  if (!insp || !section) { navigate(`#/inspection/${inspectionId}`); return; }
  let customMapImage = await DB.getCustomLocationMap(inspectionId);

  appEl.innerHTML = `
    ${reportSectionPageHeader(section, inspectionId, insp)}
    <div class="content">
      <div class="field"><label>Title</label><input type="text" id="f-title" value="${esc(section.title)}"></div>

      <div class="section-header" style="margin-top:14px;"><h2>Map mode</h2></div>
      <div class="severity-picker" id="map-mode-picker">
        <button class="chip ${(!insp.locationMapMode || insp.locationMapMode === 'auto') ? 'selected' : ''}" data-mapmode="auto" style="${(!insp.locationMapMode || insp.locationMapMode === 'auto') ? 'background:var(--ink);' : ''}">Auto map</button>
        <button class="chip ${insp.locationMapMode === 'custom' ? 'selected' : ''}" data-mapmode="custom" style="${insp.locationMapMode === 'custom' ? 'background:var(--ink);' : ''}">Upload image</button>
        <button class="chip ${insp.locationMapMode === 'off' ? 'selected' : ''}" data-mapmode="off" style="${insp.locationMapMode === 'off' ? 'background:var(--ink);' : ''}">Off</button>
      </div>
      <div class="field" style="margin-top:10px;">
        <label>Map scale</label>
        <select id="f-map-scale">
          ${[500, 1250, 2500, 5000, 10000, 25000].map((s) => `<option value="${s}" ${(insp.locationMapScale || 2500) === s ? 'selected' : ''}>1:${formatWithCommas(s)}</option>`).join('')}
        </select>
      </div>
      <div id="custom-map-area" class="${insp.locationMapMode === 'custom' ? '' : 'hidden'}" style="margin-top:10px;">
        <div class="photo-grid" id="custom-map-grid"></div>
      </div>
      <input type="file" id="map-file-input" accept="image/*" style="display:none;">

      <div class="section-header"><h2>Structure location</h2></div>
      ${locationFieldHTML(insp.location && insp.location.manual || '')}

      <button class="btn btn-primary btn-block" id="btn-save" style="margin-top:14px;">Save</button>
    </div>
  `;
  wireReportSectionPageHeader(inspectionId, section);
  const locationField = wireLocationField(appEl, insp.location);

  appEl.querySelectorAll('#map-mode-picker .chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      appEl.querySelectorAll('#map-mode-picker .chip').forEach((c) => { c.classList.remove('selected'); c.style.background = ''; });
      chip.classList.add('selected');
      chip.style.background = 'var(--ink)';
      appEl.querySelector('#custom-map-area').classList.toggle('hidden', chip.dataset.mapmode !== 'custom');
    });
  });

  function renderCustomMapGrid() {
    const grid = appEl.querySelector('#custom-map-grid');
    grid.innerHTML = customMapImage
      ? `<div class="photo-thumb" style="position:relative; width:96px; height:96px;">
           <img src="${blobUrl(customMapImage.originalBlob)}">
           <button class="icon-btn" id="btn-remove-custom-map" style="position:absolute; top:4px; right:4px; width:24px; height:24px; background:rgba(28,31,38,0.75); font-size:13px;">✕</button>
         </div>`
      : `<div class="photo-add" id="btn-add-custom-map" style="width:96px; height:96px;">＋</div>`;
    const addTile = grid.querySelector('#btn-add-custom-map');
    if (addTile) addTile.addEventListener('click', () => appEl.querySelector('#map-file-input').click());
    const removeBtn = grid.querySelector('#btn-remove-custom-map');
    if (removeBtn) removeBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await DB.removeCustomLocationMap(inspectionId);
      customMapImage = null;
      renderCustomMapGrid();
    });
  }
  renderCustomMapGrid();
  appEl.querySelector('#map-file-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const normalized = await normalizeImageFile(file, 1600);
    customMapImage = await DB.setCustomLocationMap(inspectionId, normalized);
    renderCustomMapGrid();
    e.target.value = '';
  });

  document.getElementById('btn-save').addEventListener('click', async () => {
    const mapModeBtn = appEl.querySelector('#map-mode-picker .chip.selected');
    const coords = locationField.getCoords();
    await DB.updateInspection(inspectionId, {
      locationMapMode: mapModeBtn ? mapModeBtn.dataset.mapmode : 'auto',
      locationMapScale: Number(appEl.querySelector('#f-map-scale').value) || 2500,
      location: { ...(coords || {}), manual: locationField.getManualText() }
    });
    await DB.updateReportSection(section.id, { title: appEl.querySelector('#f-title').value.trim() });
    toast('Saved');
    renderLocationMapReportSection(inspectionId, reportSectionId);
  });
}

async function renderBasicInfoReportSection(inspectionId, reportSectionId) {
  const insp = await DB.get('inspections', inspectionId);
  const section = await DB.get('reportSections', reportSectionId);
  if (!insp || !section) { navigate(`#/inspection/${inspectionId}`); return; }
  const coverPhoto = await DB.getCoverPhoto(inspectionId);

  appEl.innerHTML = `
    ${reportSectionPageHeader(section, inspectionId, insp)}
    <div class="content">
      <div class="field"><label>Section title</label><input type="text" id="f-title" value="${esc(section.title)}"></div>
      <div class="field"><label>Structure name / project</label><input type="text" id="f-structureName" value="${esc(insp.structureName)}"></div>
      <div class="field"><label>Structure ID</label><input type="text" id="f-structureId" value="${esc(insp.structureId)}"></div>
      <div class="field"><label>Date</label><input type="date" id="f-date" value="${(insp.date || '').slice(0, 10)}"></div>
      <div class="field"><label>Inspector</label><input type="text" id="f-inspector" value="${esc(insp.inspector)}"></div>
      <div class="field"><label>Weather</label><input type="text" id="f-weather" value="${esc(insp.weather)}"></div>
      ${locationFieldHTML(insp.location && insp.location.manual || '')}
      <div class="field"><label>Report title</label><input type="text" id="f-reportTitle" value="${esc(insp.title)}"></div>
      <div class="field"><label>Report subtitle</label><input type="text" id="f-subtitle" value="${esc(insp.subtitle)}"></div>
      <div class="field"><label>General notes</label><textarea id="f-notes">${esc(insp.notes)}</textarea></div>

      <div class="card">
        <div class="link-row" style="margin-bottom:10px;"><strong style="font-size:15px;">Cover photo</strong>${!coverPhoto ? '<button class="small-btn" id="btn-add-cover">＋ Add</button>' : ''}</div>
        ${coverPhoto
          ? `<div class="photo-thumb" id="cover-thumb" style="width:120px; height:120px;"><img src="${blobUrl(coverPhoto.originalBlob)}">${coverPhoto.annotatedBlob ? '<div class="annotated-dot"></div>' : ''}</div>`
          : `<p class="muted" style="font-size:13px; margin:0;">Used on the report cover page.</p>`}
      </div>

      <button class="btn btn-primary btn-block" id="btn-save" style="margin-top:14px;">Save</button>
    </div>
  `;
  wireReportSectionPageHeader(inspectionId, section);
  const locationField = wireLocationField(appEl, insp.location);

  const addCoverBtn = document.getElementById('btn-add-cover');
  if (addCoverBtn) addCoverBtn.addEventListener('click', () => {
    openPhotoSourceSheet({
      onFiles: async (files) => {
        const normalized = await normalizeImageFile(files[0]);
        await DB.setCoverPhoto(inspectionId, normalized);
        toast('Cover photo saved');
        renderBasicInfoReportSection(inspectionId, reportSectionId);
      }
    });
  });
  const coverThumb = document.getElementById('cover-thumb');
  if (coverThumb) coverThumb.addEventListener('click', () => {
    openPhotoActionSheet(coverPhoto.id, {
      onAnnotated: () => renderBasicInfoReportSection(inspectionId, reportSectionId),
      onRemoved: () => renderBasicInfoReportSection(inspectionId, reportSectionId)
    });
  });

  document.getElementById('btn-save').addEventListener('click', async () => {
    const coords = locationField.getCoords();
    await DB.updateInspection(inspectionId, {
      structureName: appEl.querySelector('#f-structureName').value.trim(),
      structureId: appEl.querySelector('#f-structureId').value.trim(),
      date: appEl.querySelector('#f-date').value,
      inspector: appEl.querySelector('#f-inspector').value.trim(),
      weather: appEl.querySelector('#f-weather').value.trim(),
      location: { ...(coords || {}), manual: locationField.getManualText() },
      title: appEl.querySelector('#f-reportTitle').value.trim(),
      subtitle: appEl.querySelector('#f-subtitle').value.trim(),
      notes: appEl.querySelector('#f-notes').value.trim()
    });
    await DB.updateReportSection(section.id, { title: appEl.querySelector('#f-title').value.trim() });
    toast('Saved');
    renderBasicInfoReportSection(inspectionId, reportSectionId);
  });
}

async function renderElementSummaryReportSection(inspectionId, reportSectionId) {
  const insp = await DB.get('inspections', inspectionId);
  const section = await DB.get('reportSections', reportSectionId);
  if (!insp || !section) { navigate(`#/inspection/${inspectionId}`); return; }
  const summary = await DB.getInspectionSummary(inspectionId);

  appEl.innerHTML = `
    ${reportSectionPageHeader(section, inspectionId, insp)}
    <div class="content">
      <div class="field"><label>Title</label><input type="text" id="f-title" value="${esc(section.title)}"></div>
      <button class="btn btn-primary btn-block" id="btn-save">Save title</button>
      <div class="section-header" style="margin-top:22px;"><h2>Live preview</h2></div>
      <p class="muted" style="font-size:13px; margin-top:-8px;">Computed automatically from every element and finding in the inspection — nothing else to fill in here.</p>
      ${summary.length ? summary.map((s) => `
        <div class="list-item">
          <div class="meta">
            <h3>${esc(s.element.name)}</h3>
            <p>${s.element.materialType ? esc(s.element.materialType) + ' · ' : ''}${s.findingCount} finding${s.findingCount === 1 ? '' : 's'}${s.worstSeverity ? ` · Worst: S${s.worstSeverity} ${s.worstExtent || ''}` : ''}</p>
          </div>
        </div>
      `).join('') : `<p class="muted" style="font-size:13px;">No elements yet.</p>`}
    </div>
  `;
  wireReportSectionPageHeader(inspectionId, section);
  document.getElementById('btn-save').addEventListener('click', async () => {
    await DB.updateReportSection(section.id, { title: appEl.querySelector('#f-title').value.trim() });
    toast('Saved');
    renderElementSummaryReportSection(inspectionId, reportSectionId);
  });
}

async function renderInspectionFindingsReportSection(inspectionId, reportSectionId) {
  const insp = await DB.get('inspections', inspectionId);
  const section = await DB.get('reportSections', reportSectionId);
  if (!insp || !section) { navigate(`#/inspection/${inspectionId}`); return; }
  const structureSections = await DB.listStructureSections(inspectionId, reportSectionId);
  const directElements = await DB.listDirectElements(inspectionId, reportSectionId);

  appEl.innerHTML = `
    ${reportSectionPageHeader(section, inspectionId, insp)}
    <div class="content">
      <div class="field"><label>Section title</label><input type="text" id="f-title" value="${esc(section.title)}"></div>
      <button class="btn btn-primary btn-block" id="btn-save-title">Save title</button>

      <p class="hint" style="margin-top:14px;">Use Structure Sections to split a structure into parts with their own elements — e.g. Span 1 / Span 2 on a twin-span bridge. For a simple single structure, just add elements directly below.</p>

      <div class="section-header" style="margin-top:14px;"><h2>Structure Sections</h2><button class="small-btn" id="btn-add-structure-section">＋ Add</button></div>
      ${structureSections.length ? structureSections.map((s) => `
        <div class="list-item" data-ss="${s.id}">
          <div class="meta"><h3>${esc(s.name)}</h3></div>
          <span class="chevron">›</span>
        </div>
      `).join('') : `<p class="muted" style="font-size:13px; padding:0 2px;">None yet.</p>`}

      <div class="section-header"><h2>Elements</h2><button class="small-btn" id="btn-add-element">＋ Add</button></div>
      ${directElements.length ? directElements.map((e) => `
        <div class="list-item" data-el="${e.id}">
          <div class="meta"><h3>${esc(e.name)}</h3><p>${esc(e.materialType) || ''}</p></div>
          <span class="chevron">›</span>
        </div>
      `).join('') : `<p class="muted" style="font-size:13px; padding:0 2px;">Elements not in a Structure Section appear here.</p>`}
    </div>
  `;
  wireReportSectionPageHeader(inspectionId, section);
  document.getElementById('btn-save-title').addEventListener('click', async () => {
    await DB.updateReportSection(section.id, { title: appEl.querySelector('#f-title').value.trim() });
    toast('Saved');
    renderInspectionFindingsReportSection(inspectionId, reportSectionId);
  });
  appEl.querySelectorAll('[data-ss]').forEach((row) => {
    row.addEventListener('click', () => navigate(`#/inspection/${inspectionId}/section/${row.dataset.ss}`));
  });
  appEl.querySelectorAll('[data-el]').forEach((row) => {
    row.addEventListener('click', () => navigate(`#/inspection/${inspectionId}/element/${row.dataset.el}`));
  });
  document.getElementById('btn-add-structure-section').addEventListener('click', () => {
    const nameSheet = el(`
      <div class="sheet-backdrop">
        <div class="sheet">
          <div class="sheet-handle"></div>
          <h2>New Structure Section</h2>
          <div class="field"><label>Name</label><input type="text" id="f-ss-name" placeholder="e.g. Span 1"></div>
          <button class="btn btn-primary btn-block" id="btn-save-ss">Add</button>
          <button class="btn btn-ghost btn-block" id="btn-cancel-ss">Cancel</button>
        </div>
      </div>
    `);
    presentOverlay(nameSheet);
    nameSheet.addEventListener('click', (e) => { if (e.target === nameSheet) nameSheet.remove(); });
    nameSheet.querySelector('#btn-cancel-ss').addEventListener('click', () => nameSheet.remove());
    nameSheet.querySelector('#btn-save-ss').addEventListener('click', async () => {
      const name = nameSheet.querySelector('#f-ss-name').value.trim();
      if (!name) { toast('Enter a name'); return; }
      const existing = await DB.listSections(inspectionId);
      await DB.createStructureSection(inspectionId, reportSectionId, { name, order: existing.length });
      nameSheet.remove();
      renderInspectionFindingsReportSection(inspectionId, reportSectionId);
    });
  });
  document.getElementById('btn-add-element').addEventListener('click', () => {
    openAddElementSheet(inspectionId, null, {
      reportSectionId,
      onDone: () => renderInspectionFindingsReportSection(inspectionId, reportSectionId)
    });
  });
}

async function renderReportSectionDrawings(inspectionId, reportSectionId) {
  const insp = await DB.get('inspections', inspectionId);
  const section = await DB.get('reportSections', reportSectionId);
  if (!insp || !section) { navigate(`#/inspection/${inspectionId}`); return; }
  let drawings = await DB.listSectionDrawings(reportSectionId);

  appEl.innerHTML = `
    <div class="topbar">
      <button class="icon-btn" id="btn-back">‹</button>
      <div style="flex:1; min-width:0;">
        <h1 style="font-size:17px;">${esc(section.title) || 'Drawing section'}</h1>
        <span class="sub">${esc(insp.structureName)}</span>
      </div>
    </div>
    <div class="content" id="drawings-list"></div>
    <button class="fab" id="btn-add-drawing">＋</button>
  `;
  document.getElementById('btn-back').addEventListener('click', () => navigate(`#/inspection/${inspectionId}`));
  document.getElementById('btn-add-drawing').addEventListener('click', () => openAddSectionDrawingSheet(inspectionId, reportSectionId, () => renderReportSectionDrawings(inspectionId, reportSectionId)));

  function renderList() {
    const list = document.getElementById('drawings-list');
    if (!drawings.length) {
      list.innerHTML = `
        <div class="empty-state">
          <div class="glyph">📐</div>
          <h3>No drawings yet</h3>
          <p>Add photos or import a PDF (page by page) into this section.</p>
        </div>`;
      return;
    }
    list.innerHTML = drawings.map((d) => `
      <div class="list-item" data-drawing="${d.id}">
        <div class="photo-thumb" style="width:56px; height:56px; flex-shrink:0; margin-right:12px;">
          <img src="${blobUrl(d.annotatedBlob || d.originalBlob)}">
          ${d.annotatedBlob ? '<div class="annotated-dot"></div>' : ''}
        </div>
        <div class="meta"><h3>${esc(d.title) || 'Untitled'}</h3></div>
        <span class="chevron">›</span>
      </div>
    `).join('');
    list.querySelectorAll('[data-drawing]').forEach((row) => {
      row.addEventListener('click', () => {
        const d = drawings.find((x) => x.id === row.dataset.drawing);
        openDrawingDetailSheet(d, {
          onChanged: async () => { drawings = await DB.listSectionDrawings(reportSectionId); renderList(); }
        });
      });
    });
  }
  renderList();
}

function openAddSectionDrawingSheet(inspectionId, reportSectionId, onAdded) {
  const sheet = el(`
    <div class="sheet-backdrop">
      <div class="sheet">
        <div class="sheet-handle"></div>
        <h2>Add drawing</h2>
        <button class="btn btn-primary btn-block" id="btn-camera">📷 Take photo</button>
        <button class="btn btn-secondary btn-block" id="btn-library" style="margin-top:10px;">🖼 Choose from library</button>
        <button class="btn btn-secondary btn-block" id="btn-pdf" style="margin-top:10px;">📄 Import PDF</button>
        <button class="btn btn-secondary btn-block" id="btn-sketch" style="margin-top:10px;">✏️ Draw sketch</button>
        <button class="btn btn-ghost btn-block" id="btn-cancel" style="margin-top:16px;">Cancel</button>
        <input type="file" id="asd-camera-input" accept="image/*" capture="environment" style="display:none;">
        <input type="file" id="asd-library-input" accept="image/*" multiple style="display:none;">
      </div>
    </div>
  `);
  presentOverlay(sheet);
  sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.remove(); });
  sheet.querySelector('#btn-cancel').addEventListener('click', () => sheet.remove());

  async function handleImageFiles(fileList) {
    sheet.remove();
    for (const file of Array.from(fileList)) {
      const normalized = await normalizeImageFile(file);
      await DB.addSectionDrawing(reportSectionId, inspectionId, normalized, file.name.replace(/\.[a-z0-9]+$/i, ''));
    }
    onAdded();
  }
  sheet.querySelector('#btn-camera').addEventListener('click', () => sheet.querySelector('#asd-camera-input').click());
  sheet.querySelector('#btn-library').addEventListener('click', () => sheet.querySelector('#asd-library-input').click());
  sheet.querySelector('#asd-camera-input').addEventListener('change', (e) => { if (e.target.files.length) handleImageFiles(e.target.files); });
  sheet.querySelector('#asd-library-input').addEventListener('change', (e) => { if (e.target.files.length) handleImageFiles(e.target.files); });

  sheet.querySelector('#btn-pdf').addEventListener('click', () => {
    sheet.remove();
    openPdfImportFlow(
      (blob, title) => DB.addSectionDrawing(reportSectionId, inspectionId, blob, title),
      () => { toast('Import complete'); onAdded(); }
    );
  });
  sheet.querySelector('#btn-sketch').addEventListener('click', () => {
    sheet.remove();
    openSketchTitlePrompt(async (title) => {
      const blank = await createA4CanvasBlob();
      const drawing = await DB.addSectionDrawing(reportSectionId, inspectionId, blank, title);
      await openAnnotator(drawing.id, onAdded);
    });
  });
}

// ---------- APPENDICES scoped to a report section (New Style) ----------
async function renderReportSectionAppendix(inspectionId, reportSectionId, appendixId) {
  const insp = await DB.get('inspections', inspectionId);
  const section = await DB.get('reportSections', reportSectionId);
  if (!insp || !section) { navigate(`#/inspection/${inspectionId}`); return; }
  const appendices = await DB.listSectionAppendices(reportSectionId);
  const appendixIndex = appendices.findIndex((a) => a.id === appendixId);
  const appendix = appendices[appendixIndex];
  if (!appendix) { navigate(`#/inspection/${inspectionId}/rsection/${reportSectionId}/appendices`); return; }
  const fullTitle = `Appendix ${appendixLetter(appendixIndex)} - ${appendix.name}`;
  let items = await DB.listAppendixItems(appendixId);

  appEl.innerHTML = `
    <div class="topbar">
      <button class="icon-btn" id="btn-back">‹</button>
      <div style="flex:1; min-width:0;">
        <h1 style="font-size:17px;">${esc(fullTitle)}</h1>
        <span class="sub">${esc(insp.structureName)}</span>
      </div>
      <button class="text-btn" id="btn-rename">Edit</button>
    </div>
    <div class="content" id="ai-list"></div>
    <button class="fab" id="btn-add-item">＋</button>
  `;
  document.getElementById('btn-back').addEventListener('click', () => navigate(`#/inspection/${inspectionId}/rsection/${reportSectionId}/appendices`));
  document.getElementById('btn-rename').addEventListener('click', () => {
    const nameSheet = el(`
      <div class="sheet-backdrop">
        <div class="sheet">
          <div class="sheet-handle"></div>
          <h2>Edit appendix</h2>
          <div class="field">
            <label>Name</label>
            <div class="link-row">
              <span style="font-weight:700; color:var(--ink-soft); margin-right:6px; white-space:nowrap;">Appendix ${appendixLetter(appendixIndex)} -</span>
              <input type="text" id="f-name" value="${esc(appendix.name)}" style="flex:1;">
            </div>
          </div>
          <button class="btn btn-primary btn-block" id="btn-save">Save</button>
          <button class="btn btn-danger btn-block" id="btn-delete" style="margin-top:8px;">Delete appendix</button>
          <button class="btn btn-ghost btn-block" id="btn-cancel">Cancel</button>
        </div>
      </div>
    `);
    presentOverlay(nameSheet);
    nameSheet.addEventListener('click', (e) => { if (e.target === nameSheet) nameSheet.remove(); });
    nameSheet.querySelector('#btn-cancel').addEventListener('click', () => nameSheet.remove());
    nameSheet.querySelector('#btn-save').addEventListener('click', async () => {
      const name = nameSheet.querySelector('#f-name').value.trim();
      if (!name) { toast('Enter a name'); return; }
      await DB.updateSectionAppendix(reportSectionId, appendixId, { name });
      nameSheet.remove();
      renderReportSectionAppendix(inspectionId, reportSectionId, appendixId);
    });
    nameSheet.querySelector('#btn-delete').addEventListener('click', async () => {
      if (!confirm('Delete this appendix and everything in it?')) return;
      await DB.deleteSectionAppendixCascade(reportSectionId, appendixId);
      nameSheet.remove();
      navigate(`#/inspection/${inspectionId}/rsection/${reportSectionId}/appendices`);
    });
  });
  document.getElementById('btn-add-item').addEventListener('click', () => openAddAppendixItemSheet(inspectionId, appendixId, () => renderReportSectionAppendix(inspectionId, reportSectionId, appendixId)));

  function renderList() {
    const list = document.getElementById('ai-list');
    if (!items.length) {
      list.innerHTML = `<div class="empty-state"><div class="glyph">📎</div><h3>No items yet</h3><p>Add photos or import a PDF into this appendix.</p></div>`;
      return;
    }
    list.innerHTML = items.map((it) => `
      <div class="list-item" data-item="${it.id}">
        <div class="photo-thumb" style="width:56px; height:56px; flex-shrink:0; margin-right:12px;">
          <img src="${blobUrl(it.annotatedBlob || it.originalBlob)}">
          ${it.annotatedBlob ? '<div class="annotated-dot"></div>' : ''}
        </div>
        <div class="meta"><h3>${esc(it.title) || 'Untitled'}</h3></div>
        <span class="chevron">›</span>
      </div>
    `).join('');
    list.querySelectorAll('[data-item]').forEach((row) => {
      row.addEventListener('click', () => {
        const it = items.find((x) => x.id === row.dataset.item);
        openAppendixItemDetailSheet(it, {
          onChanged: async () => { items = await DB.listAppendixItems(appendixId); renderList(); }
        });
      });
    });
  }
  renderList();
}

async function renderReportSectionAppendicesList(inspectionId, reportSectionId) {
  const insp = await DB.get('inspections', inspectionId);
  const section = await DB.get('reportSections', reportSectionId);
  if (!insp || !section) { navigate(`#/inspection/${inspectionId}`); return; }
  let appendices = await DB.listSectionAppendices(reportSectionId);

  appEl.innerHTML = `
    <div class="topbar">
      <button class="icon-btn" id="btn-back">‹</button>
      <div style="flex:1; min-width:0;">
        <h1 style="font-size:17px;">${esc(section.title) || 'Appendices'}</h1>
        <span class="sub">${esc(insp.structureName)}</span>
      </div>
      <button class="text-btn" id="btn-section-title">Edit</button>
    </div>
    <div class="content">
      <div id="appendix-list"></div>
      <div class="checkbox-row" style="margin-top:14px;">
        <input type="checkbox" id="f-include-ra" ${section.includeRiskAssessment ? 'checked' : ''}>
        <label for="f-include-ra">Include Risk Assessment as an appendix (always last)</label>
      </div>
    </div>
    <button class="fab" id="btn-add-appendix">＋</button>
  `;
  document.getElementById('btn-back').addEventListener('click', () => navigate(`#/inspection/${inspectionId}`));
  document.getElementById('f-include-ra').addEventListener('change', async (e) => {
    await DB.updateReportSection(reportSectionId, { includeRiskAssessment: e.target.checked });
  });
  document.getElementById('btn-section-title').addEventListener('click', () => {
    const nameSheet = el(`
      <div class="sheet-backdrop">
        <div class="sheet">
          <div class="sheet-handle"></div>
          <h2>Section title</h2>
          <div class="field"><label>Title</label><input type="text" id="f-title" value="${esc(section.title)}"></div>
          <button class="btn btn-primary btn-block" id="btn-save">Save</button>
          <button class="btn btn-danger btn-block" id="btn-delete" style="margin-top:8px;">Delete section</button>
          <button class="btn btn-ghost btn-block" id="btn-cancel">Cancel</button>
        </div>
      </div>
    `);
    presentOverlay(nameSheet);
    nameSheet.addEventListener('click', (e) => { if (e.target === nameSheet) nameSheet.remove(); });
    nameSheet.querySelector('#btn-cancel').addEventListener('click', () => nameSheet.remove());
    nameSheet.querySelector('#btn-save').addEventListener('click', async () => {
      await DB.updateReportSection(reportSectionId, { title: nameSheet.querySelector('#f-title').value.trim() });
      nameSheet.remove();
      renderReportSectionAppendicesList(inspectionId, reportSectionId);
    });
    nameSheet.querySelector('#btn-delete').addEventListener('click', async () => {
      if (!confirm('Delete this section and every appendix in it?')) return;
      await DB.deleteReportSectionCascade(reportSectionId);
      nameSheet.remove();
      navigate(`#/inspection/${inspectionId}`);
    });
  });

  function renderList() {
    const list = document.getElementById('appendix-list');
    if (!appendices.length) {
      list.innerHTML = `<p class="muted" style="font-size:13px; padding:0 2px;">No appendices yet.</p>`;
      return;
    }
    list.innerHTML = appendices.map((a, i) => `
      <div class="tpl-row" data-appendix="${a.id}" style="cursor:pointer;">
        <span>Appendix ${appendixLetter(i)} - ${esc(a.name)}</span>
        <span class="chevron">›</span>
      </div>
    `).join('');
    list.querySelectorAll('[data-appendix]').forEach((row) => {
      row.addEventListener('click', () => navigate(`#/inspection/${inspectionId}/rsection/${reportSectionId}/appendices/${row.dataset.appendix}`));
    });
  }
  renderList();

  document.getElementById('btn-add-appendix').addEventListener('click', () => {
    const letter = appendixLetter(appendices.length);
    const nameSheet = el(`
      <div class="sheet-backdrop">
        <div class="sheet">
          <div class="sheet-handle"></div>
          <h2>New appendix</h2>
          <div class="field">
            <label>Name</label>
            <div class="link-row">
              <span style="font-weight:700; color:var(--ink-soft); margin-right:6px; white-space:nowrap;">Appendix ${letter} -</span>
              <input type="text" id="f-appendix-name" placeholder="e.g. Site Photos" style="flex:1;">
            </div>
          </div>
          <button class="btn btn-primary btn-block" id="btn-save-appendix">Add</button>
          <button class="btn btn-ghost btn-block" id="btn-cancel-appendix">Cancel</button>
        </div>
      </div>
    `);
    presentOverlay(nameSheet);
    nameSheet.addEventListener('click', (e) => { if (e.target === nameSheet) nameSheet.remove(); });
    nameSheet.querySelector('#btn-cancel-appendix').addEventListener('click', () => nameSheet.remove());
    nameSheet.querySelector('#btn-save-appendix').addEventListener('click', async () => {
      const name = nameSheet.querySelector('#f-appendix-name').value.trim();
      if (!name) { toast('Enter a name'); return; }
      await DB.addSectionAppendix(reportSectionId, name);
      nameSheet.remove();
      appendices = await DB.listSectionAppendices(reportSectionId);
      renderList();
    });
  });
}

// ---------- INSPECTION DETAIL ----------
async function renderInspection(inspectionId) {
  const insp = await DB.get('inspections', inspectionId);
  if (!insp) { navigate('#/'); return; }
  if (insp.reportStyle === 'new') { await renderInspectionNewStyle(inspectionId, insp); return; }
  const sections = await DB.listSections(inspectionId);
  const ungroupedElements = await DB.listElementsBySection(inspectionId, null);
  const coverPhoto = await DB.getCoverPhoto(inspectionId);
  const riskAssessment = await DB.getRiskAssessment(inspectionId);
  const drawingCount = (await DB.listDrawings(inspectionId)).length;
  const isGiBridges = insp.inspectionType === 'GI Bridges';
  const bciSummary = isGiBridges ? await computeBciSummary(inspectionId) : null;

  async function elementRowHtml(elmt) {
    const s = await DB.getElementConditionSummary(elmt.id);
    const badge = s.worstSeverity
      ? `<span class="badge badge-sev-${s.worstSeverity}">S${s.worstSeverity}</span> <span class="badge badge-extent">${s.worstExtent || '—'}</span>`
      : s.findingCount
        ? `<span class="badge badge-none">${s.findingCount} finding${s.findingCount === 1 ? '' : 's'}</span>`
        : `<span class="badge badge-none">No findings</span>`;
    const subline = elementSublineParts(elmt, isGiBridges).join(' · ') || `${s.findingCount} finding${s.findingCount === 1 ? '' : 's'}`;
    return `
      <div class="list-item" data-el="${elmt.id}">
        <div class="meta"><h3>${esc(elmt.name)}</h3><p>${esc(subline)}</p></div>
        ${badge}<span class="chevron">›</span>
      </div>`;
  }

  const sectionRows = [];
  for (const sec of sections) {
    const secElements = await DB.listElementsBySection(inspectionId, sec.id);
    sectionRows.push(`
      <div class="list-item" data-sec="${sec.id}">
        <div class="meta"><h3>${esc(sec.name)}</h3><p>${secElements.length} element${secElements.length === 1 ? '' : 's'}${sec.comments ? ' · ' + esc(sec.comments) : ''}</p></div>
        <span class="chevron">›</span>
      </div>`);
  }

  const ungroupedRows = [];
  for (const e of ungroupedElements) ungroupedRows.push(await elementRowHtml(e));

  appEl.innerHTML = `
    <div class="topbar">
      <button class="icon-btn" id="btn-back">‹</button>
      <div style="flex:1; min-width:0;">
        <h1 style="font-size:17px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${esc(insp.structureName)}</h1>
        <span class="sub">${esc(insp.inspectionType || 'Inspection')} · ${fmtDate(insp.date)}</span>
      </div>
      <button class="text-btn muted" id="btn-report-info">Report info</button>
      <button class="text-btn" id="btn-print">Print</button>
    </div>
    <div class="content">
      <div class="card">
        <div class="link-row" style="margin-bottom:8px;"><strong style="font-size:15px;">Inspection details</strong><button class="small-btn" id="btn-edit-header">Edit</button></div>
        <p class="muted" style="margin:4px 0; font-size:14px;">Structure ID: ${esc(insp.structureId || '—')}</p>
        <p class="muted" style="margin:4px 0; font-size:14px;">Inspector: ${esc(insp.inspector || '—')}</p>
        <p class="muted" style="margin:4px 0; font-size:14px;">Weather: ${esc(insp.weather || '—')}</p>
        <p class="muted" style="margin:4px 0; font-size:14px;">Location: ${esc(insp.location && insp.location.manual || '—')}</p>
      </div>

      ${isGiBridges ? `
      <div class="card" style="border: 1.5px solid var(--ink);">
        <strong style="font-size:15px; display:block; margin-bottom:12px;">BCI / MDCI Condition Scores</strong>
        <div style="display:flex; justify-content:space-between; align-items:baseline;">
          <span style="font-size:13px; font-weight:600; color:var(--ink-soft);">Official BCI</span>
          <span style="font-size:14px;">Ave: <b>${bciSummary.vanilla.bciAv != null ? Math.round(bciSummary.vanilla.bciAv) : '—'}</b>&nbsp;&nbsp;Crit: <b>${bciSummary.vanilla.bciCrit != null ? Math.round(bciSummary.vanilla.bciCrit) : '—'}</b></span>
        </div>
        <p class="muted" style="font-size:11px; margin:2px 0 10px; text-align:right;">BCS Ave: ${bciSummary.vanilla.bcsAv != null ? bciSummary.vanilla.bcsAv.toFixed(2) : '—'} · BCS Crit: ${bciSummary.vanilla.bcsCrit != null ? bciSummary.vanilla.bcsCrit.toFixed(2) : '—'}</p>
        <div style="display:flex; justify-content:space-between; align-items:baseline;">
          <span style="font-size:13px; font-weight:600; color:var(--ink-soft);">House MDCI</span>
          <span style="font-size:14px;">Ave: <b>${bciSummary.mdci.bciAv != null ? Math.round(bciSummary.mdci.bciAv) : '—'}</b>&nbsp;&nbsp;Crit: <b>${bciSummary.mdci.bciCrit != null ? Math.round(bciSummary.mdci.bciCrit) : '—'}</b></span>
        </div>
        <p class="muted" style="font-size:11px; margin:2px 0 10px; text-align:right;">BCS Ave: ${bciSummary.mdci.bcsAv != null ? bciSummary.mdci.bcsAv.toFixed(2) : '—'} · BCS Crit: ${bciSummary.mdci.bcsCrit != null ? bciSummary.mdci.bcsCrit.toFixed(2) : '—'}</p>
        <p class="muted" style="font-size:11.5px; margin:10px 0 0; line-height:1.4;">MDCI is a house-developed condition index that blends multiple defects per element more granularly than the official method. It is not directly comparable to another authority's BCI figures.</p>
        <p class="muted" style="font-size:11px; margin:6px 0 0; line-height:1.4;">Official BCI's multi-defect interaction rule is an algorithmic approximation — engineer judgement should override where defects genuinely compound in severity. ${bciSummary.excludedCount ? `${bciSummary.excludedCount} element${bciSummary.excludedCount === 1 ? '' : 's'} excluded (no Element Type set, or marked Not Inspected).` : ''}</p>
      </div>
      ` : ''}

      <div class="card">
        <div class="link-row" style="margin-bottom:10px;"><strong style="font-size:15px;">Cover photo</strong>${!coverPhoto ? '<button class="small-btn" id="btn-add-cover">＋ Add</button>' : ''}</div>
        ${coverPhoto
          ? `<div class="photo-thumb" id="cover-thumb" style="width:120px; height:120px;"><img src="${blobUrl(coverPhoto.originalBlob)}">${coverPhoto.annotatedBlob ? '<div class="annotated-dot"></div>' : ''}</div>`
          : `<p class="muted" style="font-size:13px; margin:0;">Used on the report cover page.</p>`}
      </div>

      <div class="list-item" id="btn-open-risk-assessment">
        <div class="meta">
          <h3>Risk Assessment</h3>
          <p>${riskAssessment ? `${(riskAssessment.risks || []).length} risk${(riskAssessment.risks || []).length === 1 ? '' : 's'} logged` : 'Not started'}</p>
        </div>
        <span class="chevron">›</span>
      </div>

      <div class="list-item" id="btn-open-drawings">
        <div class="meta">
          <h3>Drawings</h3>
          <p>${drawingCount ? `${drawingCount} imported` : 'No drawings imported'}</p>
        </div>
        <span class="chevron">›</span>
      </div>

      <div class="section-header"><h2>Sections</h2><button class="small-btn" id="btn-add-section">＋ Add section</button></div>
      ${sections.length ? sectionRows.join('') : `<p class="muted" style="font-size:13px; padding:0 2px;">Optional — use sections to group elements by span, zone, or area.</p>`}

      <div class="section-header"><h2>Elements</h2><button class="small-btn" id="btn-add-element">＋ Add</button></div>
      ${ungroupedElements.length ? ungroupedRows.join('') : (sections.length ? `<p class="muted" style="font-size:13px; padding:0 2px;">Elements not assigned to a section appear here.</p>` : `
        <div class="empty-state">
          <div class="glyph">▦</div>
          <h3>No elements yet</h3>
          <p>Add structural elements to begin logging findings.</p>
        </div>
      `)}
    </div>
    <button class="fab" id="btn-add-element-fab">＋</button>
  `;

  document.getElementById('btn-back').addEventListener('click', () => navigate('#/'));
  document.getElementById('btn-print').addEventListener('click', () => {
    try { exportInspectionPDF(inspectionId); } catch (err) { console.error(err); toast('Error: ' + err.message); }
  });
  document.getElementById('btn-report-info').addEventListener('click', () => openReportInfoSheet(inspectionId));
  document.getElementById('btn-edit-header').addEventListener('click', () => openEditHeaderSheet(insp));
  document.getElementById('btn-add-section').addEventListener('click', () => openAddSectionSheet(inspectionId));
  document.getElementById('btn-open-risk-assessment').addEventListener('click', () => navigate(`#/inspection/${inspectionId}/risk-assessment`));
  document.getElementById('btn-open-drawings').addEventListener('click', () => navigate(`#/inspection/${inspectionId}/drawings`));
  document.getElementById('btn-add-element').addEventListener('click', () => openAddElementSheet(inspectionId, null));
  document.getElementById('btn-add-element-fab').addEventListener('click', () => openAddElementSheet(inspectionId, null));

  const addCoverBtn = document.getElementById('btn-add-cover');
  if (addCoverBtn) addCoverBtn.addEventListener('click', () => {
    openPhotoSourceSheet({
      onFiles: async (files) => {
        const normalized = await normalizeImageFile(files[0]);
        await DB.setCoverPhoto(inspectionId, normalized);
        toast('Cover photo saved');
        renderInspection(inspectionId);
      }
    });
  });
  const coverThumb = document.getElementById('cover-thumb');
  if (coverThumb) coverThumb.addEventListener('click', () => {
    openPhotoActionSheet(coverPhoto.id, {
      onAnnotated: () => renderInspection(inspectionId),
      onRemoved: () => renderInspection(inspectionId)
    });
  });

  appEl.querySelectorAll('.list-item[data-sec]').forEach((row) => row.addEventListener('click', () => navigate(`#/inspection/${inspectionId}/section/${row.dataset.sec}`)));
  appEl.querySelectorAll('.list-item[data-el]').forEach((row) => row.addEventListener('click', () => navigate(`#/inspection/${inspectionId}/element/${row.dataset.el}`)));
}

function openEditHeaderSheet(insp) {
  const sheet = el(`
    <div class="sheet-backdrop">
      <div class="sheet">
        <div class="sheet-handle"></div>
        <h2>Edit inspection details</h2>
        <div class="field"><label>Structure name / project</label><input type="text" id="f-structureName" value="${esc(insp.structureName)}"></div>
        <div class="field"><label>Structure ID</label><input type="text" id="f-structureId" value="${esc(insp.structureId)}"></div>
        <div class="field">
          <label>Inspection type</label>
          <select id="f-inspectionType">${INSPECTION_TYPES.map((t) => `<option value="${t}" ${insp.inspectionType === t ? 'selected' : ''}>${t}</option>`).join('')}</select>
        </div>
        <div class="field"><label>Date</label><input type="date" id="f-date" value="${(insp.date || '').slice(0, 10)}"></div>
        <div class="field"><label>Inspector</label><input type="text" id="f-inspector" value="${esc(insp.inspector)}"></div>
        <div class="field"><label>Weather</label><input type="text" id="f-weather" value="${esc(insp.weather)}"></div>
        ${locationFieldHTML(insp.location && insp.location.manual || '')}
        <div class="field"><label>Report title</label><input type="text" id="f-title" value="${esc(insp.title)}"></div>
        <div class="field"><label>Report subtitle</label><input type="text" id="f-subtitle" value="${esc(insp.subtitle)}"></div>
        <div class="field"><label>General notes</label><textarea id="f-notes">${esc(insp.notes)}</textarea></div>
        <button class="btn btn-primary btn-block" id="btn-save">Save</button>
        <button class="btn btn-danger btn-block" id="btn-delete" style="margin-top:8px;">Delete inspection</button>
        <button class="btn btn-ghost btn-block" id="btn-cancel">Cancel</button>
      </div>
    </div>
  `);
  presentOverlay(sheet);
  const locationField = wireLocationField(sheet, insp.location);
  sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.remove(); });
  sheet.querySelector('#btn-cancel').addEventListener('click', () => sheet.remove());
  sheet.querySelector('#btn-save').addEventListener('click', async () => {
    const coords = locationField.getCoords();
    await DB.updateInspection(insp.id, {
      structureName: sheet.querySelector('#f-structureName').value.trim(),
      structureId: sheet.querySelector('#f-structureId').value.trim(),
      inspectionType: sheet.querySelector('#f-inspectionType').value,
      date: sheet.querySelector('#f-date').value,
      inspector: sheet.querySelector('#f-inspector').value.trim(),
      weather: sheet.querySelector('#f-weather').value.trim(),
      location: { ...(coords || {}), manual: locationField.getManualText() },
      title: sheet.querySelector('#f-title').value.trim() || 'Structural Inspection Report',
      subtitle: sheet.querySelector('#f-subtitle').value.trim(),
      notes: sheet.querySelector('#f-notes').value.trim()
    });
    sheet.remove();
    renderInspection(insp.id);
  });
  sheet.querySelector('#btn-delete').addEventListener('click', async () => {
    if (!confirm('Delete this inspection and all its sections, elements, findings, and photos? This cannot be undone.')) return;
    await DB.deleteInspectionCascade(insp.id);
    sheet.remove();
    navigate('#/');
  });
}

// ---------- REPORT INFO (client / reference / logos) ----------
async function openReportInfoSheet(inspectionId) {
  const insp = await DB.get('inspections', inspectionId);
  let companyLogo = await DB.getLogoByRole(inspectionId, 'company');
  let clientLogo = await DB.getLogoByRole(inspectionId, 'client');
  let customMapImage = await DB.getCustomLocationMap(inspectionId);
  let appendices = await DB.listAppendices(inspectionId);

  const sheet = el(`
    <div class="sheet-backdrop">
      <div class="sheet">
        <div class="sheet-handle"></div>
        <h2>Report info</h2>
        <p class="muted" style="font-size:13px; margin-top:-8px;">Appears on the report cover page.</p>
        <div class="field"><label>Company name</label><input type="text" id="f-companyName" value="${esc(insp.companyName)}" placeholder="Your company name"></div>
        <div class="field"><label>Company address</label><input type="text" id="f-companyAddress" value="${esc(insp.companyAddress)}" placeholder="Your company address"></div>
        <div class="field"><label>Client</label><input type="text" id="f-client" value="${esc(insp.client)}" placeholder="Client or organization name"></div>
        <div class="field"><label>Reference / project no.</label><input type="text" id="f-reference" value="${esc(insp.reference)}" placeholder="e.g. PRJ-2026-014"></div>
        <div class="field"><label>Report date</label><input type="date" id="f-date" value="${(insp.date || '').slice(0, 10)}"></div>

        <div class="section-header" style="margin-top:22px;"><h2>Inspection Type</h2></div>
        <div class="field">
          <select id="f-inspectionType">
            ${INSPECTION_TYPES.map((t) => `<option value="${t}" ${insp.inspectionType === t ? 'selected' : ''}>${t}</option>`).join('')}
          </select>
        </div>

        <div class="section-header" style="margin-top:22px;"><h2>Currency</h2></div>
        <div class="severity-picker" id="currency-picker">
          <button class="chip ${(!insp.currency || insp.currency === 'USD') ? 'selected' : ''}" data-currency="USD" style="${(!insp.currency || insp.currency === 'USD') ? 'background:var(--ink);' : ''}">$ USD</button>
          <button class="chip ${insp.currency === 'GBP' ? 'selected' : ''}" data-currency="GBP" style="${insp.currency === 'GBP' ? 'background:var(--ink);' : ''}">£ GBP</button>
          <button class="chip ${insp.currency === 'EUR' ? 'selected' : ''}" data-currency="EUR" style="${insp.currency === 'EUR' ? 'background:var(--ink);' : ''}">€ EUR</button>
        </div>
        <p class="hint">Used for cost estimates on findings with works required.</p>

        <div class="section-header" style="margin-top:22px;"><h2>Logos</h2></div>
        <div class="field">
          <label>Company logo</label>
          <div class="photo-grid" id="company-logo-grid"></div>
        </div>
        <div class="field">
          <label>Client logo</label>
          <div class="photo-grid" id="client-logo-grid"></div>
        </div>
        <input type="file" id="logo-file-input" accept="image/*" style="display:none;">

        <div class="section-header" style="margin-top:22px;"><h2>Cover style</h2></div>
        <div class="checkbox-row">
          <input type="checkbox" id="f-include-cover" ${insp.includeCoverPage !== false ? 'checked' : ''}>
          <label for="f-include-cover">Include cover page</label>
        </div>
        <p class="hint" style="margin-top:-4px;">Off: the report starts from the Table of Contents instead.</p>
        <div class="severity-picker" id="cover-style-picker">
          <button class="chip ${(!insp.coverStyle || insp.coverStyle === 'basic') ? 'selected' : ''}" data-style="basic" style="${(!insp.coverStyle || insp.coverStyle === 'basic') ? 'background:var(--ink);' : ''}">Basic</button>
          <button class="chip ${insp.coverStyle === 'archarray' ? 'selected' : ''}" data-style="archarray" style="${insp.coverStyle === 'archarray' ? 'background:var(--ink);' : ''}">Arch&amp;Array</button>
        </div>

        <div class="section-header" style="margin-top:22px;"><h2>Location Map</h2></div>
        <div class="severity-picker" id="map-mode-picker">
          <button class="chip ${(!insp.locationMapMode || insp.locationMapMode === 'auto') ? 'selected' : ''}" data-mapmode="auto" style="${(!insp.locationMapMode || insp.locationMapMode === 'auto') ? 'background:var(--ink);' : ''}">Auto map</button>
          <button class="chip ${insp.locationMapMode === 'custom' ? 'selected' : ''}" data-mapmode="custom" style="${insp.locationMapMode === 'custom' ? 'background:var(--ink);' : ''}">Upload image</button>
          <button class="chip ${insp.locationMapMode === 'off' ? 'selected' : ''}" data-mapmode="off" style="${insp.locationMapMode === 'off' ? 'background:var(--ink);' : ''}">Off</button>
        </div>
        <div class="field" style="margin-top:12px;">
          <label>Map scale</label>
          <select id="f-map-scale">
            ${[500, 1250, 2500, 5000, 10000, 25000].map((s) => `<option value="${s}" ${(insp.locationMapScale || 2500) === s ? 'selected' : ''}>1:${formatWithCommas(s)}</option>`).join('')}
          </select>
        </div>
        <div id="custom-map-area" class="${insp.locationMapMode === 'custom' ? '' : 'hidden'}" style="margin-top:10px;">
          <div class="photo-grid" id="custom-map-grid"></div>
        </div>
        <input type="file" id="map-file-input" accept="image/*" style="display:none;">
        <p class="hint">Placed after the Introduction. Auto mode needs internet at export time; if the structure has no coordinates set, the map section is skipped with a warning.</p>

        <div class="section-header" style="margin-top:22px;"><h2>Appendices</h2><button class="small-btn" id="btn-add-appendix">＋ Add</button></div>
        <div id="appendix-list"></div>
        <div class="checkbox-row" style="margin-top:6px;">
          <input type="checkbox" id="f-include-ra-appendix" ${insp.includeRiskAssessmentAppendix ? 'checked' : ''}>
          <label for="f-include-ra-appendix">Include Risk Assessment as an appendix (always last)</label>
        </div>

        <div class="section-header" style="margin-top:22px;"><h2>Report content</h2></div>
        <button class="btn btn-secondary btn-block" id="btn-intro">📝 Introduction${insp.introduction ? ' — added' : ''}</button>
        <button class="btn btn-secondary btn-block" id="btn-summary" style="margin-top:10px;">📝 Summary${insp.summary ? ' — added' : ''}</button>
        <button class="btn btn-secondary btn-block" id="btn-conclusion" style="margin-top:10px;">📋 Conclusion &amp; Recommendations${(insp.conclusion || (insp.recommendations && insp.recommendations.length)) ? ' — added' : ''}</button>

        <button class="btn btn-primary btn-block" id="btn-save" style="margin-top:22px;">Save</button>
        <button class="btn btn-ghost btn-block" id="btn-cancel">Cancel</button>
      </div>
    </div>
  `);
  presentOverlay(sheet);

  // Reads the current state of every field in this sheet and persists it — used both by
  // the Save button and before navigating to the Introduction/Conclusion sub-sheets, so
  // in-progress edits are never silently discarded.
  async function persistFields() {
    const styleBtn = sheet.querySelector('#cover-style-picker .chip.selected');
    const currencyBtn = sheet.querySelector('#currency-picker .chip.selected');
    const mapModeBtn = sheet.querySelector('#map-mode-picker .chip.selected');
    await DB.updateInspection(inspectionId, {
      companyName: sheet.querySelector('#f-companyName').value.trim(),
      companyAddress: sheet.querySelector('#f-companyAddress').value.trim(),
      client: sheet.querySelector('#f-client').value.trim(),
      reference: sheet.querySelector('#f-reference').value.trim(),
      date: sheet.querySelector('#f-date').value,
      inspectionType: sheet.querySelector('#f-inspectionType').value,
      currency: currencyBtn ? currencyBtn.dataset.currency : 'USD',
      coverStyle: styleBtn ? styleBtn.dataset.style : 'basic',
      includeCoverPage: sheet.querySelector('#f-include-cover').checked,
      locationMapMode: mapModeBtn ? mapModeBtn.dataset.mapmode : 'auto',
      locationMapScale: Number(sheet.querySelector('#f-map-scale').value) || 2500,
      includeRiskAssessmentAppendix: sheet.querySelector('#f-include-ra-appendix').checked
    });
  }

  sheet.querySelector('#btn-intro').addEventListener('click', async () => {
    await persistFields();
    sheet.remove();
    openRichTextFieldSheet(inspectionId, 'introduction', 'Introduction');
  });
  sheet.querySelector('#btn-summary').addEventListener('click', async () => {
    await persistFields();
    sheet.remove();
    openRichTextFieldSheet(inspectionId, 'summary', 'Summary');
  });
  sheet.querySelector('#btn-conclusion').addEventListener('click', async () => {
    await persistFields();
    sheet.remove();
    openConclusionSheet(inspectionId);
  });

  sheet.querySelectorAll('#cover-style-picker .chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      sheet.querySelectorAll('#cover-style-picker .chip').forEach((c) => { c.classList.remove('selected'); c.style.background = ''; });
      chip.classList.add('selected');
      chip.style.background = 'var(--ink)';
    });
  });

  sheet.querySelectorAll('#currency-picker .chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      sheet.querySelectorAll('#currency-picker .chip').forEach((c) => { c.classList.remove('selected'); c.style.background = ''; });
      chip.classList.add('selected');
      chip.style.background = 'var(--ink)';
    });
  });

  sheet.querySelectorAll('#map-mode-picker .chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      sheet.querySelectorAll('#map-mode-picker .chip').forEach((c) => { c.classList.remove('selected'); c.style.background = ''; });
      chip.classList.add('selected');
      chip.style.background = 'var(--ink)';
      sheet.querySelector('#custom-map-area').classList.toggle('hidden', chip.dataset.mapmode !== 'custom');
    });
  });

  function renderCustomMapGrid() {
    const grid = sheet.querySelector('#custom-map-grid');
    grid.innerHTML = customMapImage
      ? `<div class="photo-thumb" style="position:relative; width:96px; height:96px;">
           <img src="${blobUrl(customMapImage.originalBlob)}">
           <button class="icon-btn" id="btn-remove-custom-map" style="position:absolute; top:4px; right:4px; width:24px; height:24px; background:rgba(28,31,38,0.75); font-size:13px;">✕</button>
         </div>`
      : `<div class="photo-add" id="btn-add-custom-map" style="width:96px; height:96px;">＋</div>`;
    const addTile = grid.querySelector('#btn-add-custom-map');
    if (addTile) addTile.addEventListener('click', () => sheet.querySelector('#map-file-input').click());
    const removeBtn = grid.querySelector('#btn-remove-custom-map');
    if (removeBtn) removeBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await DB.removeCustomLocationMap(inspectionId);
      customMapImage = null;
      renderCustomMapGrid();
    });
  }
  renderCustomMapGrid();
  sheet.querySelector('#map-file-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const normalized = await normalizeImageFile(file, 1600);
    customMapImage = await DB.setCustomLocationMap(inspectionId, normalized);
    renderCustomMapGrid();
    e.target.value = '';
  });

  function renderAppendixList() {
    const list = sheet.querySelector('#appendix-list');
    if (!appendices.length) {
      list.innerHTML = `<p class="muted" style="font-size:13px; padding:0 2px;">No appendices yet.</p>`;
      return;
    }
    list.innerHTML = appendices.map((a, i) => `
      <div class="tpl-row" data-appendix="${a.id}" style="cursor:pointer;">
        <span>Appendix ${appendixLetter(i)} - ${esc(a.name)}</span>
        <span class="chevron">›</span>
      </div>
    `).join('');
    list.querySelectorAll('[data-appendix]').forEach((row) => {
      row.addEventListener('click', async () => {
        await persistFields();
        sheet.remove();
        navigate(`#/inspection/${inspectionId}/appendix/${row.dataset.appendix}`);
      });
    });
  }
  renderAppendixList();
  sheet.querySelector('#btn-add-appendix').addEventListener('click', () => {
    const letter = appendixLetter(appendices.length);
    const nameSheet = el(`
      <div class="sheet-backdrop">
        <div class="sheet">
          <div class="sheet-handle"></div>
          <h2>New appendix</h2>
          <div class="field">
            <label>Name</label>
            <div class="link-row">
              <span style="font-weight:700; color:var(--ink-soft); margin-right:6px; white-space:nowrap;">Appendix ${letter} -</span>
              <input type="text" id="f-appendix-name" placeholder="e.g. Site Photos" style="flex:1;">
            </div>
          </div>
          <p class="hint">The letter updates automatically if appendices are added, removed, or reordered later.</p>
          <button class="btn btn-primary btn-block" id="btn-save-appendix">Add</button>
          <button class="btn btn-ghost btn-block" id="btn-cancel-appendix">Cancel</button>
        </div>
      </div>
    `);
    presentOverlay(nameSheet);
    nameSheet.addEventListener('click', (e) => { if (e.target === nameSheet) nameSheet.remove(); });
    nameSheet.querySelector('#btn-cancel-appendix').addEventListener('click', () => nameSheet.remove());
    nameSheet.querySelector('#btn-save-appendix').addEventListener('click', async () => {
      const name = nameSheet.querySelector('#f-appendix-name').value.trim();
      if (!name) { toast('Enter a name'); return; }
      const appendix = await DB.addAppendix(inspectionId, name);
      appendices.push(appendix);
      nameSheet.remove();
      renderAppendixList();
    });
  });

  function renderLogoSlot(role) {
    const grid = sheet.querySelector(role === 'company' ? '#company-logo-grid' : '#client-logo-grid');
    const logo = role === 'company' ? companyLogo : clientLogo;
    grid.innerHTML = logo
      ? `<div class="photo-thumb" data-role="${role}" style="position:relative; width:96px; height:96px;">
           <img src="${blobUrl(logo.originalBlob)}">
           <button class="icon-btn" data-remove-role="${role}" style="position:absolute; top:4px; right:4px; width:24px; height:24px; background:rgba(28,31,38,0.75); font-size:13px;">✕</button>
         </div>`
      : `<div class="photo-add" data-add-role="${role}" style="width:96px; height:96px;">＋</div>`;

    const addTile = grid.querySelector('[data-add-role]');
    if (addTile) addTile.addEventListener('click', () => {
      sheet.querySelector('#logo-file-input').dataset.targetRole = role;
      sheet.querySelector('#logo-file-input').click();
    });
    const removeBtn = grid.querySelector('[data-remove-role]');
    if (removeBtn) removeBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await DB.removeLogoByRole(inspectionId, role);
      if (role === 'company') companyLogo = null; else clientLogo = null;
      renderLogoSlot(role);
    });
  }
  renderLogoSlot('company');
  renderLogoSlot('client');

  sheet.querySelector('#logo-file-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    const role = e.target.dataset.targetRole;
    if (!file || !role) return;
    const normalized = await normalizeImageFile(file, 1200);
    const saved = await DB.setLogoByRole(inspectionId, role, normalized);
    if (role === 'company') companyLogo = saved; else clientLogo = saved;
    renderLogoSlot(role);
    e.target.value = '';
  });

  sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.remove(); });
  sheet.querySelector('#btn-cancel').addEventListener('click', () => sheet.remove());
  sheet.querySelector('#btn-save').addEventListener('click', async () => {
    await persistFields();
    sheet.remove();
    toast('Report info saved');
    renderInspection(inspectionId);
  });
}

// ---------- Rich text editor (Introduction / Summary / Conclusion only) ----------
// A lightweight contenteditable-based editor using document.execCommand — deliberately not
// a full library, since the scope here is bounded (bold/italic/underline, text/highlight
// color, lists/indent — no alignment, no tables). Stores each field's value as an HTML
// string; existing plain-text values from before this feature are auto-converted on load.

function looksLikeHtml(value) {
  return /<\/?[a-z][\s\S]*>/i.test(value || '');
}
function plainTextToHtml(text) {
  if (!text) return '';
  return text.split('\n').map((line) => `<div>${esc(line) || '<br>'}</div>`).join('');
}

function richTextToolbarHTML(idPrefix) {
  return `
    <div class="rt-toolbar">
      <button type="button" class="rt-btn" id="${idPrefix}-bold" title="Bold" style="font-weight:800;">B</button>
      <button type="button" class="rt-btn" id="${idPrefix}-italic" title="Italic" style="font-style:italic;">I</button>
      <button type="button" class="rt-btn" id="${idPrefix}-underline" title="Underline" style="text-decoration:underline;">U</button>
      <button type="button" class="rt-btn" id="${idPrefix}-color" title="Text color">A</button>
      <input type="color" id="${idPrefix}-color-input" style="display:none;" value="#c81e1e">
      <button type="button" class="rt-btn" id="${idPrefix}-highlight" title="Highlight">🖍</button>
      <input type="color" id="${idPrefix}-highlight-input" style="display:none;" value="#fff3a3">
      <button type="button" class="rt-btn" id="${idPrefix}-ul" title="Bulleted list">•≡</button>
      <button type="button" class="rt-btn" id="${idPrefix}-ol" title="Numbered list">1≡</button>
      <button type="button" class="rt-btn" id="${idPrefix}-outdent" title="Outdent">⇤</button>
      <button type="button" class="rt-btn" id="${idPrefix}-indent" title="Indent">⇥</button>
    </div>
  `;
}

// Wires up a rich text toolbar + its contenteditable editor. `container` must already
// contain the toolbar HTML (from richTextToolbarHTML) and an element with id `${idPrefix}-editor`.
function wireRichTextEditor(container, idPrefix, initialValue) {
  const editor = container.querySelector(`#${idPrefix}-editor`);
  editor.innerHTML = looksLikeHtml(initialValue) ? initialValue : plainTextToHtml(initialValue);

  function cmd(command, value) {
    editor.focus();
    document.execCommand(command, false, value);
    syncToolbarState();
  }
  const boldBtn = container.querySelector(`#${idPrefix}-bold`);
  const italicBtn = container.querySelector(`#${idPrefix}-italic`);
  const underlineBtn = container.querySelector(`#${idPrefix}-underline`);
  const ulBtn = container.querySelector(`#${idPrefix}-ul`);
  const olBtn = container.querySelector(`#${idPrefix}-ol`);
  boldBtn.addEventListener('click', () => cmd('bold'));
  italicBtn.addEventListener('click', () => cmd('italic'));
  underlineBtn.addEventListener('click', () => cmd('underline'));
  ulBtn.addEventListener('click', () => cmd('insertUnorderedList'));
  olBtn.addEventListener('click', () => cmd('insertOrderedList'));
  container.querySelector(`#${idPrefix}-indent`).addEventListener('click', () => cmd('indent'));
  container.querySelector(`#${idPrefix}-outdent`).addEventListener('click', () => cmd('outdent'));

  const colorBtn = container.querySelector(`#${idPrefix}-color`);
  const colorInput = container.querySelector(`#${idPrefix}-color-input`);
  colorBtn.addEventListener('click', () => colorInput.click());
  colorInput.addEventListener('input', (e) => cmd('foreColor', e.target.value));

  const highlightBtn = container.querySelector(`#${idPrefix}-highlight`);
  const highlightInput = container.querySelector(`#${idPrefix}-highlight-input`);
  highlightBtn.addEventListener('click', () => highlightInput.click());
  highlightInput.addEventListener('input', (e) => {
    editor.focus();
    // Safari has historically preferred backColor over hiliteColor for contenteditable
    // highlighting; fall back if hiliteColor isn't reported as supported.
    const supported = document.queryCommandSupported && document.queryCommandSupported('hiliteColor');
    document.execCommand(supported ? 'hiliteColor' : 'backColor', false, e.target.value);
    syncToolbarState();
  });

  // Reflects whatever formatting is active at the current cursor/selection back onto the
  // toolbar buttons — previously the buttons worked but never indicated selected state,
  // which was confusing since there was no way to tell bold/italic/etc were "on" without
  // clicking and checking the text.
  function syncToolbarState() {
    if (!document.queryCommandState) return;
    try {
      boldBtn.classList.toggle('active', document.queryCommandState('bold'));
      italicBtn.classList.toggle('active', document.queryCommandState('italic'));
      underlineBtn.classList.toggle('active', document.queryCommandState('underline'));
      ulBtn.classList.toggle('active', document.queryCommandState('insertUnorderedList'));
      olBtn.classList.toggle('active', document.queryCommandState('insertOrderedList'));
    } catch (err) { /* queryCommandState can throw for unsupported commands on some browsers */ }
  }
  editor.addEventListener('keyup', syncToolbarState);
  editor.addEventListener('mouseup', syncToolbarState);
  editor.addEventListener('focus', syncToolbarState);
  document.addEventListener('selectionchange', () => {
    if (document.activeElement === editor) syncToolbarState();
  });

  return { getHTML: () => editor.innerHTML };
}

function openRichTextFieldSheet(inspectionId, fieldKey, label) {
  DB.get('inspections', inspectionId).then((insp) => {
    const sheet = el(`
      <div class="sheet-backdrop">
        <div class="sheet">
          <div class="sheet-handle"></div>
          <h2>${esc(label)}</h2>
          ${richTextToolbarHTML('rtf')}
          <div class="rt-editor" id="rtf-editor" contenteditable="true"></div>
          <button class="btn btn-primary btn-block" id="btn-save" style="margin-top:14px;">Save</button>
          <button class="btn btn-ghost btn-block" id="btn-cancel">Cancel</button>
        </div>
      </div>
    `);
    presentOverlay(sheet);
    const editorApi = wireRichTextEditor(sheet, 'rtf', insp[fieldKey]);
    sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.remove(); });
    sheet.querySelector('#btn-cancel').addEventListener('click', () => sheet.remove());
    sheet.querySelector('#btn-save').addEventListener('click', async () => {
      await DB.updateInspection(inspectionId, { [fieldKey]: editorApi.getHTML() });
      sheet.remove();
      toast(`${label} saved`);
      openReportInfoSheet(inspectionId);
    });
  });
}

function openConclusionSheet(inspectionId) {
  DB.get('inspections', inspectionId).then((insp) => {
    let recommendations = (insp.recommendations && insp.recommendations.length) ? [...insp.recommendations] : [''];

    const sheet = el(`
      <div class="sheet-backdrop">
        <div class="sheet">
          <div class="sheet-handle"></div>
          <h2>Conclusion &amp; Recommendations</h2>
          <div class="field">
            <label>Conclusion</label>
            ${richTextToolbarHTML('rtc')}
            <div class="rt-editor" id="rtc-editor" contenteditable="true"></div>
          </div>
          <div class="field">
            <label>Recommendations</label>
            <div id="reco-list"></div>
            <button class="small-btn" id="btn-add-reco">＋ Add recommendation</button>
          </div>
          <button class="btn btn-primary btn-block" id="btn-save" style="margin-top:8px;">Save</button>
          <button class="btn btn-ghost btn-block" id="btn-cancel">Cancel</button>
        </div>
      </div>
    `);
    presentOverlay(sheet);
    const editorApi = wireRichTextEditor(sheet, 'rtc', insp.conclusion);

    function renderRecoList() {
      const list = sheet.querySelector('#reco-list');
      list.innerHTML = recommendations.map((text, i) => `
        <div class="reco-row">
          <span class="reco-num">${i + 1}.</span>
          <input type="text" class="reco-input" data-i="${i}" value="${esc(text)}" placeholder="Recommendation text">
          <button class="reco-remove" data-remove="${i}">✕</button>
        </div>
      `).join('');
      list.querySelectorAll('.reco-input').forEach((input) => {
        input.addEventListener('input', (e) => { recommendations[Number(e.target.dataset.i)] = e.target.value; });
      });
      list.querySelectorAll('[data-remove]').forEach((btn) => {
        btn.addEventListener('click', () => {
          recommendations.splice(Number(btn.dataset.remove), 1);
          if (!recommendations.length) recommendations = [''];
          renderRecoList();
        });
      });
    }
    renderRecoList();

    sheet.querySelector('#btn-add-reco').addEventListener('click', () => {
      recommendations.push('');
      renderRecoList();
    });

    sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.remove(); });
    sheet.querySelector('#btn-cancel').addEventListener('click', () => sheet.remove());
    sheet.querySelector('#btn-save').addEventListener('click', async () => {
      const cleaned = recommendations.map((r) => r.trim()).filter(Boolean);
      await DB.updateInspection(inspectionId, {
        conclusion: editorApi.getHTML(),
        recommendations: cleaned
      });
      sheet.remove();
      toast('Conclusion saved');
      openReportInfoSheet(inspectionId);
    });
  });
}

// ---------- ADD SECTION ----------
function openAddSectionSheet(inspectionId) {
  const sheet = el(`
    <div class="sheet-backdrop">
      <div class="sheet">
        <div class="sheet-handle"></div>
        <h2>New section</h2>
        <div class="field"><label>Name / descriptor</label><input type="text" id="f-name" placeholder="e.g. Span 2, North Approach"></div>
        <div class="field"><label>Comments</label><textarea id="f-comments" placeholder="Optional notes about this section"></textarea></div>
        <button class="btn btn-primary btn-block" id="btn-save">Add section</button>
        <button class="btn btn-ghost btn-block" id="btn-cancel">Cancel</button>
      </div>
    </div>
  `);
  presentOverlay(sheet);
  sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.remove(); });
  sheet.querySelector('#btn-cancel').addEventListener('click', () => sheet.remove());
  sheet.querySelector('#btn-save').addEventListener('click', async () => {
    const name = sheet.querySelector('#f-name').value.trim();
    if (!name) { toast('Enter a name'); return; }
    const existing = await DB.listSections(inspectionId);
    const sec = await DB.createSection(inspectionId, { name, comments: sheet.querySelector('#f-comments').value.trim(), order: existing.length });
    sheet.remove();
    navigate(`#/inspection/${inspectionId}/section/${sec.id}`);
  });
}

// ---------- SECTION DETAIL ----------
async function renderSection(inspectionId, sectionId) {
  const insp = await DB.get('inspections', inspectionId);
  const section = await DB.get('sections', sectionId);
  if (!insp || !section) { navigate(`#/inspection/${inspectionId}`); return; }
  const elements = await DB.listElementsBySection(inspectionId, sectionId);
  const isGiBridges = insp.inspectionType === 'GI Bridges';

  const rows = [];
  for (const elmt of elements) {
    const s = await DB.getElementConditionSummary(elmt.id);
    const badge = s.worstSeverity
      ? `<span class="badge badge-sev-${s.worstSeverity}">S${s.worstSeverity}</span> <span class="badge badge-extent">${s.worstExtent || '—'}</span>`
      : s.findingCount
        ? `<span class="badge badge-none">${s.findingCount} finding${s.findingCount === 1 ? '' : 's'}</span>`
        : `<span class="badge badge-none">No findings</span>`;
    const subline = elementSublineParts(elmt, isGiBridges).join(' · ') || `${s.findingCount} finding${s.findingCount === 1 ? '' : 's'}`;
    rows.push(`
      <div class="list-item" data-el="${elmt.id}">
        <div class="meta"><h3>${esc(elmt.name)}</h3><p>${esc(subline)}</p></div>
        ${badge}<span class="chevron">›</span>
      </div>`);
  }

  appEl.innerHTML = `
    <div class="topbar">
      <button class="icon-btn" id="btn-back">‹</button>
      <div style="flex:1; min-width:0;">
        <h1 style="font-size:17px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${esc(section.name)}</h1>
        <span class="sub">${esc(insp.structureName)}</span>
      </div>
      <button class="text-btn" id="btn-edit-section">Edit</button>
    </div>
    <div class="content">
      ${section.comments ? `<div class="card"><p style="margin:0; font-size:14px;">${esc(section.comments)}</p></div>` : ''}
      <div class="section-header" style="margin-top:0;"><h2>Elements</h2><button class="small-btn" id="btn-add-element">＋ Add</button></div>
      ${elements.length ? rows.join('') : `
        <div class="empty-state">
          <div class="glyph">▦</div>
          <h3>No elements yet</h3>
          <p>Add elements within this section.</p>
        </div>
      `}
    </div>
    <button class="fab" id="btn-add-element-fab">＋</button>
  `;

  document.getElementById('btn-back').addEventListener('click', () => navigate(`#/inspection/${inspectionId}`));
  document.getElementById('btn-edit-section').addEventListener('click', () => openEditSectionSheet(inspectionId, section));
  document.getElementById('btn-add-element').addEventListener('click', () => openAddElementSheet(inspectionId, sectionId));
  document.getElementById('btn-add-element-fab').addEventListener('click', () => openAddElementSheet(inspectionId, sectionId));
  appEl.querySelectorAll('.list-item[data-el]').forEach((row) => row.addEventListener('click', () => navigate(`#/inspection/${inspectionId}/element/${row.dataset.el}`)));
}

function openEditSectionSheet(inspectionId, section) {
  const sheet = el(`
    <div class="sheet-backdrop">
      <div class="sheet">
        <div class="sheet-handle"></div>
        <h2>Edit section</h2>
        <div class="field"><label>Name / descriptor</label><input type="text" id="f-name" value="${esc(section.name)}"></div>
        <div class="field"><label>Comments</label><textarea id="f-comments">${esc(section.comments)}</textarea></div>
        <button class="btn btn-primary btn-block" id="btn-save">Save</button>
        <button class="btn btn-danger btn-block" id="btn-delete" style="margin-top:8px;">Delete section</button>
        <button class="btn btn-ghost btn-block" id="btn-cancel">Cancel</button>
      </div>
    </div>
  `);
  presentOverlay(sheet);
  sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.remove(); });
  sheet.querySelector('#btn-cancel').addEventListener('click', () => sheet.remove());
  sheet.querySelector('#btn-save').addEventListener('click', async () => {
    const name = sheet.querySelector('#f-name').value.trim();
    if (!name) { toast('Enter a name'); return; }
    await DB.updateSection(section.id, { name, comments: sheet.querySelector('#f-comments').value.trim() });
    sheet.remove();
    renderSection(inspectionId, section.id);
  });
  sheet.querySelector('#btn-delete').addEventListener('click', async () => {
    if (!confirm('Delete this section and all elements, findings, and photos within it?')) return;
    await DB.deleteSectionCascade(section.id);
    sheet.remove();
    navigate(`#/inspection/${inspectionId}`);
  });
}

// ---------- ADD ELEMENT ----------

// Shared HTML for the GI Bridges Element Type / Importance / Not Inspected fields, used by
// both the add and edit element sheets. Only shown when the inspection type is 'GI Bridges'.
function bciElementFieldsHTML(elmt) {
  const currentType = (elmt && elmt.elementType) || '';
  const currentImportance = (elmt && elmt.importance) || '';
  const notInspected = !!(elmt && elmt.notInspected);
  return `
    <div class="field">
      <label>Element type</label>
      <select id="f-elementType">
        <option value="">Select…</option>
        ${BCI_ELEMENT_TYPES.map((t) => `<option value="${t.key}" ${currentType === t.key ? 'selected' : ''}>${esc(t.label)}</option>`).join('')}
      </select>
    </div>
    <div class="field">
      <label>Importance</label>
      <div class="severity-picker" id="bci-importance-picker">
        ${BCI_IMPORTANCE_LEVELS.map((lvl) => `<button class="chip ${currentImportance === lvl ? 'selected' : ''}" data-imp="${lvl}" style="${currentImportance === lvl ? 'background:var(--ink);' : ''}">${lvl}</button>`).join('')}
      </div>
      <p class="hint" id="bci-importance-hint">Defaults from Element Type, but can be overridden here.</p>
    </div>
    <div class="checkbox-row">
      <input type="checkbox" id="f-notInspected" ${notInspected ? 'checked' : ''}>
      <label for="f-notInspected">Not inspected (excluded from BCI/MDCI scoring)</label>
    </div>
  `;
}

function wireBciElementFields(sheet) {
  const typeSelect = sheet.querySelector('#f-elementType');

  // Importance is fixed by the standard for the 17 defined element types — only "Other"
  // (or no type selected yet) allows manual selection.
  function applyLockState() {
    const info = bciElementTypeInfo(typeSelect.value);
    const locked = !!(info && info.importance);
    sheet.querySelectorAll('#bci-importance-picker .chip').forEach((c) => {
      c.disabled = locked;
      c.style.opacity = locked ? '0.55' : '';
      c.style.pointerEvents = locked ? 'none' : '';
    });
    const hint = sheet.querySelector('#bci-importance-hint');
    if (hint) hint.textContent = locked ? 'Set automatically by the standard for this element type.' : 'Select "Other" as the element type to set this manually.';
  }

  typeSelect.addEventListener('change', () => {
    const info = bciElementTypeInfo(typeSelect.value);
    if (info && info.importance) {
      sheet.querySelectorAll('#bci-importance-picker .chip').forEach((c) => {
        const match = c.dataset.imp === info.importance;
        c.classList.toggle('selected', match);
        c.style.background = match ? 'var(--ink)' : '';
      });
    }
    applyLockState();
  });
  sheet.querySelectorAll('#bci-importance-picker .chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      if (chip.disabled) return;
      sheet.querySelectorAll('#bci-importance-picker .chip').forEach((c) => { c.classList.remove('selected'); c.style.background = ''; });
      chip.classList.add('selected');
      chip.style.background = 'var(--ink)';
    });
  });
  applyLockState();
  return {
    getValues: () => {
      const impBtn = sheet.querySelector('#bci-importance-picker .chip.selected');
      return {
        elementType: typeSelect.value,
        importance: impBtn ? impBtn.dataset.imp : '',
        notInspected: sheet.querySelector('#f-notInspected').checked
      };
    }
  };
}

async function openAddElementSheet(inspectionId, sectionId, opts = {}) {
  const { reportSectionId = null, onDone = null } = opts;
  const templates = await DB.listTemplates();
  const insp = await DB.get('inspections', inspectionId);
  const isGiBridges = insp && insp.inspectionType === 'GI Bridges';
  const sheet = el(`
    <div class="sheet-backdrop">
      <div class="sheet">
        <div class="sheet-handle"></div>
        <h2>Add element</h2>
        <div class="field"><label>Element name</label><input type="text" id="f-name" placeholder="e.g. Pier 2, Bearing SE"></div>
        ${isGiBridges ? bciElementFieldsHTML(null) : `
        <div class="row-2">
          <div class="field"><label>Material type</label><input type="text" id="f-material" placeholder="e.g. Reinforced concrete"></div>
          <div class="field"><label>Location</label><input type="text" id="f-location" placeholder="e.g. Chainage 12+400"></div>
        </div>`}
        <button class="btn btn-primary btn-block" id="btn-add-single">Add element</button>
        ${templates.length ? `
          <div class="section-header" style="margin-top:22px;"><h2>Apply a template</h2></div>
          <div id="tpl-list">
            ${templates.map((t) => `
              <div class="tpl-row">
                <span>${esc(t.name)} <span class="muted">(${t.elements.length} elements)</span></span>
                <button class="small-btn" data-tpl="${t.id}">Apply</button>
              </div>
            `).join('')}
          </div>
        ` : `<p class="muted" style="font-size:13px; margin-top:16px;">No saved templates yet. Create one from the ☰ menu on the home screen.</p>`}
        <button class="btn btn-ghost btn-block" id="btn-cancel" style="margin-top:16px;">Close</button>
      </div>
    </div>
  `);
  presentOverlay(sheet);
  sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.remove(); });
  sheet.querySelector('#btn-cancel').addEventListener('click', () => sheet.remove());
  const bciFields = isGiBridges ? wireBciElementFields(sheet) : null;

  function goBack() {
    if (onDone) { onDone(); return; }
    if (sectionId) renderSection(inspectionId, sectionId); else renderInspection(inspectionId);
  }

  sheet.querySelector('#btn-add-single').addEventListener('click', async () => {
    const name = sheet.querySelector('#f-name').value.trim();
    if (!name) { toast('Enter an element name'); return; }
    const existing = await DB.listElements(inspectionId);
    const extra = isGiBridges
      ? bciFields.getValues()
      : { materialType: sheet.querySelector('#f-material').value.trim(), location: sheet.querySelector('#f-location').value.trim() };
    const elmt = await DB.createElement(inspectionId, {
      name,
      sectionId: sectionId || null,
      reportSectionId,
      order: existing.length,
      ...extra
    });
    sheet.remove();
    goBack();
  });

  sheet.querySelectorAll('[data-tpl]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await DB.applyTemplate(inspectionId, btn.dataset.tpl, sectionId || null);
      sheet.remove();
      toast('Template applied');
      goBack();
    });
  });
}

// ---------- ELEMENT DETAIL ----------
async function renderElement(inspectionId, elementId) {
  const elmt = await DB.get('elements', elementId);
  if (!elmt) { navigate(`#/inspection/${inspectionId}`); return; }
  const insp = await DB.get('inspections', inspectionId);
  const isGiBridges = insp && insp.inspectionType === 'GI Bridges';
  const backHash = elmt.sectionId ? `#/inspection/${inspectionId}/section/${elmt.sectionId}` : `#/inspection/${inspectionId}`;
  const findings = await DB.listFindings(elementId);
  let elementPhotos = await DB.listPhotosForElement(elementId);

  const findingCards = [];
  for (const f of findings) {
    const photos = await DB.listPhotosForFinding(f.id);
    const photoThumbs = photos.slice(0, 4).map((p) => `<div class="photo-thumb" style="width:52px;height:52px;"><img src="${blobUrl(p.annotatedBlob || p.originalBlob)}"></div>`).join('');
    findingCards.push(`
      <div class="list-item" data-id="${f.id}" style="align-items:flex-start;">
        <div class="meta">
          <div style="display:flex; gap:6px; margin-bottom:6px; flex-wrap:wrap;">
            ${f.severity ? `<span class="badge badge-sev-${f.severity}">S${f.severity} · ${SEVERITY_LABELS[f.severity]}</span>` : `<span class="badge badge-none">No severity</span>`}
            ${f.extent ? `<span class="badge badge-extent">${f.extent} · ${EXTENT_LABELS[f.extent]}</span>` : ''}
            ${f.priority ? `<span class="badge badge-priority-${f.priority.toLowerCase()}">${esc(f.priority)}</span>` : ''}
            ${f.worksRequired ? `<span class="badge badge-none" style="background:var(--ink); color:#fff;">Works required</span>` : ''}
          </div>
          <p style="margin:0 0 8px; font-size:14px;">${esc(f.notes) || '<span class="muted">No notes</span>'}</p>
          ${photos.length ? `<div style="display:flex; gap:6px;">${photoThumbs}${photos.length > 4 ? `<div class="muted" style="align-self:center; font-size:12px;">+${photos.length - 4}</div>` : ''}</div>` : ''}
        </div>
        <span class="chevron">›</span>
      </div>
    `);
  }

  const subline = elementSublineParts(elmt, isGiBridges).join(' · ');

  appEl.innerHTML = `
    <div class="topbar">
      <button class="icon-btn" id="btn-back">‹</button>
      <div style="flex:1; min-width:0;">
        <h1 style="font-size:17px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${esc(elmt.name)}</h1>
        <span class="sub">${esc(subline) || 'Element'}</span>
      </div>
      <button class="text-btn" id="btn-edit-element">Edit</button>
    </div>
    <div class="content">
      <div class="section-header" style="margin-top:0;"><h2>Element photos</h2></div>
      <div class="photo-grid" id="element-photo-grid"></div>

      <div class="section-header"><h2>Findings</h2></div>
      ${findings.length ? findingCards.join('') : `
        <div class="empty-state">
          <div class="glyph">＋</div>
          <h3>No findings yet</h3>
          <p>Add a finding to log severity, extent, notes, and photos.</p>
        </div>
      `}
    </div>
    <button class="fab" id="btn-add-finding">＋</button>
  `;

  function renderElementPhotoGrid() {
    const grid = document.getElementById('element-photo-grid');
    grid.innerHTML = elementPhotos.map((p) => `
      <div class="photo-thumb" data-pid="${p.id}">
        <img src="${blobUrl(p.annotatedBlob || p.originalBlob)}">
        ${p.annotatedBlob ? '<div class="annotated-dot"></div>' : ''}
      </div>
    `).join('') + `<div class="photo-add" id="btn-add-element-photo">📷</div>`;
    grid.querySelectorAll('.photo-thumb').forEach((thumb) => {
      thumb.addEventListener('click', () => {
        openPhotoActionSheet(thumb.dataset.pid, {
          onAnnotated: async () => { elementPhotos = await DB.listPhotosForElement(elementId); renderElementPhotoGrid(); },
          onRemoved: async () => { elementPhotos = await DB.listPhotosForElement(elementId); renderElementPhotoGrid(); },
          onCaptioned: async () => { elementPhotos = await DB.listPhotosForElement(elementId); renderElementPhotoGrid(); }
        });
      });
    });
    grid.querySelector('#btn-add-element-photo').addEventListener('click', () => {
      openPhotoSourceSheet({
        multiple: true,
        onFiles: async (files) => {
          for (const file of Array.from(files)) {
            const normalized = await normalizeImageFile(file);
            await DB.addElementPhoto(elementId, normalized);
          }
          elementPhotos = await DB.listPhotosForElement(elementId);
          renderElementPhotoGrid();
        }
      });
    });
  }
  renderElementPhotoGrid();

  document.getElementById('btn-back').addEventListener('click', () => navigate(backHash));
  document.getElementById('btn-add-finding').addEventListener('click', () => openFindingEditor(inspectionId, elementId, null));
  document.getElementById('btn-edit-element').addEventListener('click', () => openEditElementSheet(inspectionId, elmt, backHash));

  appEl.querySelectorAll('.list-item[data-id]').forEach((row) => row.addEventListener('click', () => openFindingEditor(inspectionId, elementId, row.dataset.id)));
}

async function openEditElementSheet(inspectionId, elmt, backHash) {
  const insp = await DB.get('inspections', inspectionId);
  const isGiBridges = insp && insp.inspectionType === 'GI Bridges';
  const sheet = el(`
    <div class="sheet-backdrop">
      <div class="sheet">
        <div class="sheet-handle"></div>
        <h2>Edit element</h2>
        <div class="field"><label>Name</label><input type="text" id="f-name" value="${esc(elmt.name)}"></div>
        ${isGiBridges ? bciElementFieldsHTML(elmt) : `
        <div class="row-2">
          <div class="field"><label>Material type</label><input type="text" id="f-material" value="${esc(elmt.materialType)}"></div>
          <div class="field"><label>Location</label><input type="text" id="f-location" value="${esc(elmt.location)}"></div>
        </div>`}
        <button class="btn btn-primary btn-block" id="btn-save">Save</button>
        <button class="btn btn-danger btn-block" id="btn-delete" style="margin-top:8px;">Delete element</button>
        <button class="btn btn-ghost btn-block" id="btn-cancel">Cancel</button>
      </div>
    </div>
  `);
  presentOverlay(sheet);
  sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.remove(); });
  sheet.querySelector('#btn-cancel').addEventListener('click', () => sheet.remove());
  const bciFields = isGiBridges ? wireBciElementFields(sheet) : null;

  sheet.querySelector('#btn-save').addEventListener('click', async () => {
    const name = sheet.querySelector('#f-name').value.trim();
    if (!name) { toast('Enter a name'); return; }
    const extra = isGiBridges
      ? bciFields.getValues()
      : { materialType: sheet.querySelector('#f-material').value.trim(), location: sheet.querySelector('#f-location').value.trim() };
    await DB.updateElement(elmt.id, { name, ...extra });
    sheet.remove();
    renderElement(inspectionId, elmt.id);
  });
  sheet.querySelector('#btn-delete').addEventListener('click', async () => {
    if (!confirm('Delete this element and all its findings and photos?')) return;
    await DB.deleteElementCascade(elmt.id);
    sheet.remove();
    navigate(backHash);
  });
}

// ---------- RISK ASSESSMENT ----------
function riskBand(l, s) {
  const r = (l || 0) * (s || 0);
  let label = '—', colorVar = '--sev-1';
  if (r > 0) {
    if (r <= 3) { label = 'Low'; colorVar = '--sev-1'; }
    else if (r <= 6) { label = 'Medium'; colorVar = '--sev-3'; }
    else { label = 'High'; colorVar = '--sev-5'; }
  }
  return { r, label, colorVar };
}

async function renderRiskAssessment(inspectionId) {
  const insp = await DB.get('inspections', inspectionId);
  if (!insp) { navigate('#/'); return; }
  const ra = await DB.getOrCreateRiskAssessment(inspectionId);

  const inspectorSig = await DB.getSignature(ra.id, 'inspector');
  const staffList = ra.additionalStaff || [];
  const staffSigs = {};
  for (const s of staffList) staffSigs[s.id] = await DB.getSignature(ra.id, `staff:${s.id}`);

  const riskCards = (ra.risks || []).map((r) => {
    const band = riskBand(r.likelihood, r.severity);
    return `
      <div class="hazard-card" data-risk="${r.id}" style="background:var(--paper); border-radius:12px; border:1px solid var(--line); padding:14px; margin-bottom:10px;">
        <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:8px;">
          <div style="flex:1; min-width:0;">
            <div style="font-size:14.5px; font-weight:650;">${esc(r.hazardType || 'Untitled risk')}</div>
            ${r.description ? `<div style="font-size:12.5px; color:var(--ink-soft); margin-top:2px;">${esc(r.description)}</div>` : ''}
          </div>
          <span class="badge" style="background:var(${band.colorVar}); flex-shrink:0;">R ${band.r || '—'} · ${band.label}</span>
        </div>
        ${r.controlRequired ? `<div style="font-size:12.5px; color:var(--ink-soft); margin-top:8px;"><b style="color:var(--ink); font-weight:600;">Control required:</b> ${esc(r.controlRequired)}</div>` : ''}
        <div style="display:flex; gap:10px; margin-top:8px; font-size:11.5px; color:var(--ink-soft); flex-wrap:wrap;">
          ${r.actionBy ? `<span>Action: ${esc(r.actionBy)}</span>` : ''}
          ${r.targetDate ? `<span>Target: ${fmtDate(r.targetDate)}</span>` : ''}
          ${r.signedOffByName ? `<span>Signed off: ${esc(r.signedOffByName)}</span>` : ''}
        </div>
      </div>`;
  }).join('');

  const staffRows = staffList.map((s) => `
    <div class="list-item" data-staff="${s.id}" style="padding:10px 12px;">
      <div class="meta"><h3 style="font-size:14px;">${esc(s.initials) || 'Staff'}</h3><p>${staffSigs[s.id] ? 'Signed' : 'Not yet signed'}</p></div>
      <span class="chevron">›</span>
    </div>`).join('');

  appEl.innerHTML = `
    <div class="topbar">
      <button class="icon-btn" id="btn-back">‹</button>
      <div style="flex:1; min-width:0;">
        <h1 style="font-size:17px;">Risk Assessment</h1>
        <span class="sub">${esc(insp.structureName)}</span>
      </div>
      <button class="text-btn" id="btn-print-ra">Print</button>
    </div>
    <div class="content">
      <div class="card" style="margin-top:0;">
        <div class="link-row" style="margin-bottom:8px;"><strong style="font-size:15px;">Assessment Details</strong><button class="small-btn" id="btn-edit-ra-details">Edit</button></div>
        <p class="muted" style="margin:4px 0; font-size:14px;">Company: ${esc(ra.companyName) || '—'}</p>
        <p class="muted" style="margin:4px 0; font-size:14px;">Address: ${esc(ra.companyAddress) || '—'}</p>
        <p class="muted" style="margin:4px 0; font-size:14px;">Title: ${esc(ra.assessmentTitle) || '—'}</p>
        <p class="muted" style="margin:4px 0; font-size:14px;">Reference: ${esc(ra.assessmentReference) || '—'}</p>
        <p class="muted" style="margin:4px 0; font-size:14px;">Assessor: ${esc(ra.assessorName) || '—'}</p>
        <p class="muted" style="margin:4px 0; font-size:14px;">Date: ${ra.assessmentDate ? fmtDate(ra.assessmentDate) : '—'}</p>
        <p class="muted" style="margin:4px 0; font-size:14px;">Location: ${esc(ra.locationSiteAddress) || '—'}</p>
      </div>

      <div class="card">
        <div class="link-row" style="margin-bottom:8px;"><strong style="font-size:15px;">Description of Task / Activity</strong><button class="small-btn" id="btn-edit-ra-task">Edit</button></div>
        <p style="margin:0; font-size:14px;">${esc(ra.taskDescription) || '<span class="muted">Not yet described</span>'}</p>
      </div>

      <div class="section-header" style="margin-top:0;"><h2>Risks</h2><button class="small-btn" id="btn-add-risk">＋ Add</button></div>
      ${riskCards || `<p class="muted" style="font-size:13px; padding:0 2px;">No risks logged yet. Each risk combines a hazard with its control action.</p>`}

      <div class="section-header"><h2>Sign-off</h2></div>
      <div class="card">
        <div class="link-row" style="margin-bottom:8px;"><strong style="font-size:15px;">Responsible Person(s)</strong><button class="small-btn" id="btn-edit-responsible">Edit</button></div>
        <p style="margin:0 0 16px; font-size:14px;">${esc(ra.responsiblePersons) || '<span class="muted">Not yet specified</span>'}</p>

        <div class="field-label" style="font-size:13px; font-weight:600; color:var(--ink-soft); text-transform:uppercase; letter-spacing:0.3px; margin-bottom:8px;">Residual Risk Acceptable?</div>
        <p class="muted" style="font-size:12px; margin:-4px 0 8px;">Confirms the risk remaining across all the risks above, after their control actions, is acceptable.</p>
        <div style="display:flex; gap:10px; margin-bottom:20px;" id="residual-toggle">
          <button class="chip ${ra.residualRiskAcceptable === 'yes' ? 'selected' : ''}" data-val="yes" style="${ra.residualRiskAcceptable === 'yes' ? 'background:var(--sev-1);' : ''}">Yes</button>
          <button class="chip ${ra.residualRiskAcceptable === 'no' ? 'selected' : ''}" data-val="no" style="${ra.residualRiskAcceptable === 'no' ? 'background:var(--red);' : ''}">No</button>
        </div>

        <div style="border-top:1px solid var(--line); padding-top:14px; margin-bottom:14px;">
          <div class="link-row" style="margin-bottom:8px;"><strong style="font-size:14px;">Inspector / Engineer</strong><button class="small-btn" id="btn-edit-inspector">Edit</button></div>
          <p class="muted" style="margin:0 0 8px; font-size:13px;">${esc(ra.inspectorName) || 'Not yet signed'}${ra.inspectorDate ? ` · ${fmtDate(ra.inspectorDate)}` : ''}</p>
          ${inspectorSig
            ? `<div class="photo-thumb" id="inspector-sig-thumb" style="width:100px; height:44px;"><img src="${blobUrl(inspectorSig.originalBlob)}" style="object-fit:contain; background:#fff;"></div>`
            : `<button class="btn btn-secondary" id="btn-sign-inspector" style="font-size:13px; padding:8px 14px;">✍️ Sign</button>`}
        </div>

        <div style="border-top:1px solid var(--line); padding-top:14px;">
          <div class="link-row" style="margin-bottom:8px;"><strong style="font-size:14px;">Additional Inspection Staff</strong><button class="small-btn" id="btn-add-staff">＋ Add</button></div>
          ${staffRows || `<p class="muted" style="font-size:13px;">None added.</p>`}
        </div>
      </div>
    </div>
  `;

  document.getElementById('btn-back').addEventListener('click', () => navigate(`#/inspection/${inspectionId}`));
  document.getElementById('btn-print-ra').addEventListener('click', () => {
    try { exportRiskAssessmentPDF(inspectionId); } catch (err) { console.error(err); toast('Error: ' + err.message); }
  });
  document.getElementById('btn-edit-ra-details').addEventListener('click', () => openEditRADetailsSheet(inspectionId, ra));
  document.getElementById('btn-edit-ra-task').addEventListener('click', () => openEditRATaskSheet(inspectionId, ra));
  document.getElementById('btn-add-risk').addEventListener('click', () => openRiskEditorSheet(inspectionId, ra, null));
  document.getElementById('btn-edit-responsible').addEventListener('click', () => openEditResponsibleSheet(inspectionId, ra));
  document.getElementById('btn-edit-inspector').addEventListener('click', () => openEditInspectorSignOffSheet(inspectionId, ra));
  document.getElementById('btn-add-staff').addEventListener('click', () => openStaffEditorSheet(inspectionId, ra, null));

  appEl.querySelectorAll('[data-risk]').forEach((card) => {
    card.addEventListener('click', () => {
      const r = (ra.risks || []).find((x) => x.id === card.dataset.risk);
      openRiskEditorSheet(inspectionId, ra, r);
    });
  });
  appEl.querySelectorAll('[data-staff]').forEach((row) => {
    row.addEventListener('click', () => {
      const s = staffList.find((x) => x.id === row.dataset.staff);
      openStaffEditorSheet(inspectionId, ra, s);
    });
  });

  appEl.querySelectorAll('#residual-toggle .chip').forEach((chip) => {
    chip.addEventListener('click', async () => {
      const wasSelected = chip.classList.contains('selected');
      await DB.updateRiskAssessment(ra.id, { residualRiskAcceptable: wasSelected ? null : chip.dataset.val });
      renderRiskAssessment(inspectionId);
    });
  });

  const signInspectorBtn = document.getElementById('btn-sign-inspector');
  if (signInspectorBtn) signInspectorBtn.addEventListener('click', () => {
    openSignaturePad(null, async (blob) => {
      await DB.setSignature(ra.id, 'inspector', blob);
      const now = new Date();
      await DB.updateRiskAssessment(ra.id, {
        inspectorDate: ra.inspectorDate || now.toISOString().slice(0, 10),
        inspectorTime: ra.inspectorTime || now.toTimeString().slice(0, 5)
      });
      renderRiskAssessment(inspectionId);
    });
  });
  const inspThumb = document.getElementById('inspector-sig-thumb');
  if (inspThumb) inspThumb.addEventListener('click', () => {
    openSignaturePad(inspectorSig.originalBlob, async (blob) => {
      await DB.setSignature(ra.id, 'inspector', blob);
      renderRiskAssessment(inspectionId);
    });
  });
}

function openEditRADetailsSheet(inspectionId, ra) {
  const sheet = el(`
    <div class="sheet-backdrop">
      <div class="sheet">
        <div class="sheet-handle"></div>
        <h2>Assessment details</h2>
        <div class="field"><label>Company name</label><input type="text" id="f-companyName" value="${esc(ra.companyName)}"></div>
        <div class="field"><label>Company address</label><input type="text" id="f-companyAddress" value="${esc(ra.companyAddress)}"></div>
        <div class="field"><label>Assessment title</label><input type="text" id="f-title" value="${esc(ra.assessmentTitle)}" placeholder="e.g. Bridge Deck Inspection RA"></div>
        <div class="field"><label>Assessment reference</label><input type="text" id="f-reference" value="${esc(ra.assessmentReference)}"></div>
        <div class="field"><label>Assessor name</label><input type="text" id="f-assessor" value="${esc(ra.assessorName)}"></div>
        <div class="field"><label>Assessment date</label><input type="date" id="f-assessDate" value="${(ra.assessmentDate || '').slice(0, 10)}"></div>
        <div class="field"><label>Location / site address</label><input type="text" id="f-location" value="${esc(ra.locationSiteAddress)}"></div>
        <button class="btn btn-primary btn-block" id="btn-save">Save</button>
        <button class="btn btn-ghost btn-block" id="btn-cancel">Cancel</button>
      </div>
    </div>
  `);
  presentOverlay(sheet);
  sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.remove(); });
  sheet.querySelector('#btn-cancel').addEventListener('click', () => sheet.remove());
  sheet.querySelector('#btn-save').addEventListener('click', async () => {
    await DB.updateRiskAssessment(ra.id, {
      companyName: sheet.querySelector('#f-companyName').value.trim(),
      companyAddress: sheet.querySelector('#f-companyAddress').value.trim(),
      assessmentTitle: sheet.querySelector('#f-title').value.trim(),
      assessmentReference: sheet.querySelector('#f-reference').value.trim(),
      assessorName: sheet.querySelector('#f-assessor').value.trim(),
      assessmentDate: sheet.querySelector('#f-assessDate').value,
      locationSiteAddress: sheet.querySelector('#f-location').value.trim()
    });
    sheet.remove();
    renderRiskAssessment(inspectionId);
  });
}

function openEditRATaskSheet(inspectionId, ra) {
  const sheet = el(`
    <div class="sheet-backdrop">
      <div class="sheet">
        <div class="sheet-handle"></div>
        <h2>Description of task / activity</h2>
        <div class="field"><textarea id="f-task" style="min-height:140px;">${esc(ra.taskDescription)}</textarea></div>
        <button class="btn btn-primary btn-block" id="btn-save">Save</button>
        <button class="btn btn-ghost btn-block" id="btn-cancel">Cancel</button>
      </div>
    </div>
  `);
  presentOverlay(sheet);
  sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.remove(); });
  sheet.querySelector('#btn-cancel').addEventListener('click', () => sheet.remove());
  sheet.querySelector('#btn-save').addEventListener('click', async () => {
    await DB.updateRiskAssessment(ra.id, { taskDescription: sheet.querySelector('#f-task').value.trim() });
    sheet.remove();
    renderRiskAssessment(inspectionId);
  });
}

function openEditResponsibleSheet(inspectionId, ra) {
  const sheet = el(`
    <div class="sheet-backdrop">
      <div class="sheet">
        <div class="sheet-handle"></div>
        <h2>Responsible person(s)</h2>
        <div class="field"><textarea id="f-resp" placeholder="Name / role">${esc(ra.responsiblePersons)}</textarea></div>
        <button class="btn btn-primary btn-block" id="btn-save">Save</button>
        <button class="btn btn-ghost btn-block" id="btn-cancel">Cancel</button>
      </div>
    </div>
  `);
  presentOverlay(sheet);
  sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.remove(); });
  sheet.querySelector('#btn-cancel').addEventListener('click', () => sheet.remove());
  sheet.querySelector('#btn-save').addEventListener('click', async () => {
    await DB.updateRiskAssessment(ra.id, { responsiblePersons: sheet.querySelector('#f-resp').value.trim() });
    sheet.remove();
    renderRiskAssessment(inspectionId);
  });
}

function openEditInspectorSignOffSheet(inspectionId, ra) {
  const sheet = el(`
    <div class="sheet-backdrop">
      <div class="sheet">
        <div class="sheet-handle"></div>
        <h2>Inspector / Engineer</h2>
        <div class="field"><label>Name</label><input type="text" id="f-name" value="${esc(ra.inspectorName)}"></div>
        <div class="row-2">
          <div class="field"><label>Date</label><input type="date" id="f-date" value="${(ra.inspectorDate || '').slice(0, 10)}"></div>
          <div class="field"><label>Time</label><input type="time" id="f-time" value="${esc(ra.inspectorTime)}"></div>
        </div>
        <button class="btn btn-primary btn-block" id="btn-save">Save</button>
        <button class="btn btn-danger btn-block" id="btn-clear-sig" style="margin-top:8px;">Clear signature</button>
        <button class="btn btn-ghost btn-block" id="btn-cancel">Cancel</button>
      </div>
    </div>
  `);
  presentOverlay(sheet);
  sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.remove(); });
  sheet.querySelector('#btn-cancel').addEventListener('click', () => sheet.remove());
  sheet.querySelector('#btn-save').addEventListener('click', async () => {
    await DB.updateRiskAssessment(ra.id, {
      inspectorName: sheet.querySelector('#f-name').value.trim(),
      inspectorDate: sheet.querySelector('#f-date').value,
      inspectorTime: sheet.querySelector('#f-time').value
    });
    sheet.remove();
    renderRiskAssessment(inspectionId);
  });
  sheet.querySelector('#btn-clear-sig').addEventListener('click', async () => {
    await DB.removeSignature(ra.id, 'inspector');
    sheet.remove();
    renderRiskAssessment(inspectionId);
  });
}

// One combined form per Risk: hazard fields + its control action fields together.
async function openRiskEditorSheet(inspectionId, ra, risk) {
  const isNew = !risk;
  const r = risk || { id: DB.uid(), hazardType: '', description: '', whoMightBeHarmed: '', existingControls: '', likelihood: null, severity: null, controlRequired: '', actionBy: '', targetDate: '', completionDate: '', signedOffByName: '' };
  const suggestions = await DB.listHazardTypeSuggestions();
  const sigRole = `risk:${r.id}`;
  let sig = await DB.getSignature(ra.id, sigRole);

  const sheet = el(`
    <div class="sheet-backdrop">
      <div class="sheet">
        <div class="sheet-handle"></div>
        <h2>${isNew ? 'Add risk' : 'Edit risk'}</h2>

        <div class="section-header" style="margin-top:0;"><h2>Hazard</h2></div>
        <div class="field">
          <label>Hazard type</label>
          <input type="text" id="f-hazType" list="hazard-suggestions" value="${esc(r.hazardType)}" placeholder="e.g. Working at Height">
          <datalist id="hazard-suggestions">${suggestions.map((s) => `<option value="${esc(s)}">`).join('')}</datalist>
        </div>
        <div class="field"><label>Location / description of hazard</label><textarea id="f-hazDesc">${esc(r.description)}</textarea></div>
        <div class="field"><label>Who might be harmed</label><input type="text" id="f-hazWho" value="${esc(r.whoMightBeHarmed)}"></div>
        <div class="field"><label>Existing controls</label><textarea id="f-hazControls">${esc(r.existingControls)}</textarea></div>
        <div class="field">
          <label>Likelihood</label>
          <div class="severity-picker" id="likelihood-picker">
            ${[1, 2, 3].map((n) => `<button class="chip ${r.likelihood === n ? 'selected' : ''}" data-l="${n}" style="${r.likelihood === n ? 'background:var(--ink);' : ''}">${n}</button>`).join('')}
          </div>
        </div>
        <div class="field">
          <label>Severity</label>
          <div class="severity-picker" id="severity-picker-haz">
            ${[1, 2, 3].map((n) => `<button class="chip ${r.severity === n ? 'selected' : ''}" data-s="${n}" style="${r.severity === n ? 'background:var(--ink);' : ''}">${n}</button>`).join('')}
          </div>
        </div>
        <div class="card" id="r-preview" style="text-align:center; font-weight:700;"></div>

        <div class="section-header"><h2>Control Action</h2></div>
        <div class="field"><label>Additional controls required</label><textarea id="f-controlReq">${esc(r.controlRequired)}</textarea></div>
        <div class="field"><label>Action by</label><input type="text" id="f-actionBy" value="${esc(r.actionBy)}"></div>
        <div class="row-2">
          <div class="field"><label>Target date</label><input type="date" id="f-targetDate" value="${(r.targetDate || '').slice(0, 10)}"></div>
          <div class="field"><label>Completion date</label><input type="date" id="f-completionDate" value="${(r.completionDate || '').slice(0, 10)}"></div>
        </div>
        <div class="field"><label>Signed off by (name)</label><input type="text" id="f-signedOff" value="${esc(r.signedOffByName)}"></div>
        <div class="field">
          <label>Signature</label>
          <div id="sig-area"></div>
        </div>

        <button class="btn btn-primary btn-block" id="btn-save">Save risk</button>
        ${!isNew ? '<button class="btn btn-danger btn-block" id="btn-delete" style="margin-top:8px;">Delete risk</button>' : ''}
        <button class="btn btn-ghost btn-block" id="btn-cancel">Cancel</button>
      </div>
    </div>
  `);
  presentOverlay(sheet);

  let currentL = r.likelihood, currentS = r.severity;
  function updateRPreview() {
    const band = riskBand(currentL, currentS);
    const box = sheet.querySelector('#r-preview');
    box.style.background = currentL && currentS ? `var(${band.colorVar})` : 'var(--bg)';
    box.style.color = currentL && currentS ? '#fff' : 'var(--ink-soft)';
    box.textContent = currentL && currentS ? `Risk Rating: ${band.r} · ${band.label}` : 'Select likelihood and severity';
  }
  updateRPreview();

  sheet.querySelectorAll('#likelihood-picker .chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const was = chip.classList.contains('selected');
      sheet.querySelectorAll('#likelihood-picker .chip').forEach((c) => { c.classList.remove('selected'); c.style.background = ''; });
      currentL = was ? null : Number(chip.dataset.l);
      if (!was) { chip.classList.add('selected'); chip.style.background = 'var(--ink)'; }
      updateRPreview();
    });
  });
  sheet.querySelectorAll('#severity-picker-haz .chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const was = chip.classList.contains('selected');
      sheet.querySelectorAll('#severity-picker-haz .chip').forEach((c) => { c.classList.remove('selected'); c.style.background = ''; });
      currentS = was ? null : Number(chip.dataset.s);
      if (!was) { chip.classList.add('selected'); chip.style.background = 'var(--ink)'; }
      updateRPreview();
    });
  });

  function renderSigArea() {
    const area = sheet.querySelector('#sig-area');
    area.innerHTML = sig
      ? `<div class="photo-thumb" id="risk-sig-thumb" style="width:100px; height:44px;"><img src="${blobUrl(sig.originalBlob)}" style="object-fit:contain; background:#fff;"></div>`
      : `<button class="btn btn-secondary" id="btn-sign-risk" style="font-size:13px; padding:8px 14px;" type="button">✍️ Sign</button>`;
    const signBtn = area.querySelector('#btn-sign-risk');
    if (signBtn) signBtn.addEventListener('click', () => {
      openSignaturePad(null, async (blob) => { sig = await DB.setSignature(ra.id, sigRole, blob); renderSigArea(); });
    });
    const thumb = area.querySelector('#risk-sig-thumb');
    if (thumb) thumb.addEventListener('click', () => {
      openSignaturePad(sig.originalBlob, async (blob) => { sig = await DB.setSignature(ra.id, sigRole, blob); renderSigArea(); });
    });
  }
  renderSigArea();

  sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.remove(); });
  sheet.querySelector('#btn-cancel').addEventListener('click', () => sheet.remove());
  sheet.querySelector('#btn-save').addEventListener('click', async () => {
    const updated = {
      id: r.id,
      hazardType: sheet.querySelector('#f-hazType').value.trim(),
      description: sheet.querySelector('#f-hazDesc').value.trim(),
      whoMightBeHarmed: sheet.querySelector('#f-hazWho').value.trim(),
      existingControls: sheet.querySelector('#f-hazControls').value.trim(),
      likelihood: currentL,
      severity: currentS,
      controlRequired: sheet.querySelector('#f-controlReq').value.trim(),
      actionBy: sheet.querySelector('#f-actionBy').value.trim(),
      targetDate: sheet.querySelector('#f-targetDate').value,
      completionDate: sheet.querySelector('#f-completionDate').value,
      signedOffByName: sheet.querySelector('#f-signedOff').value.trim()
    };
    const risks = [...(ra.risks || [])];
    const idx = risks.findIndex((x) => x.id === r.id);
    if (idx >= 0) risks[idx] = updated; else risks.push(updated);
    await DB.updateRiskAssessment(ra.id, { risks });
    sheet.remove();
    renderRiskAssessment(inspectionId);
  });
  const deleteBtn = sheet.querySelector('#btn-delete');
  if (deleteBtn) deleteBtn.addEventListener('click', async () => {
    if (!confirm('Delete this risk?')) return;
    await DB.removeSignature(ra.id, sigRole);
    const risks = (ra.risks || []).filter((x) => x.id !== r.id);
    await DB.updateRiskAssessment(ra.id, { risks });
    sheet.remove();
    renderRiskAssessment(inspectionId);
  });
}

async function openStaffEditorSheet(inspectionId, ra, staff) {
  const isNew = !staff;
  const s = staff || { id: DB.uid(), initials: '' };
  const sigRole = `staff:${s.id}`;
  let sig = await DB.getSignature(ra.id, sigRole);

  const sheet = el(`
    <div class="sheet-backdrop">
      <div class="sheet">
        <div class="sheet-handle"></div>
        <h2>${isNew ? 'Add inspection staff' : 'Edit staff'}</h2>
        <div class="field"><label>Initials</label><input type="text" id="f-initials" value="${esc(s.initials)}" placeholder="e.g. JW" maxlength="6"></div>
        <div class="field">
          <label>Signature</label>
          <div id="sig-area"></div>
        </div>
        <button class="btn btn-primary btn-block" id="btn-save">Save</button>
        ${!isNew ? '<button class="btn btn-danger btn-block" id="btn-delete" style="margin-top:8px;">Remove</button>' : ''}
        <button class="btn btn-ghost btn-block" id="btn-cancel">Cancel</button>
      </div>
    </div>
  `);
  presentOverlay(sheet);

  function renderSigArea() {
    const area = sheet.querySelector('#sig-area');
    area.innerHTML = sig
      ? `<div class="photo-thumb" id="staff-sig-thumb" style="width:100px; height:44px;"><img src="${blobUrl(sig.originalBlob)}" style="object-fit:contain; background:#fff;"></div>`
      : `<button class="btn btn-secondary" id="btn-sign-staff" style="font-size:13px; padding:8px 14px;" type="button">✍️ Sign</button>`;
    const signBtn = area.querySelector('#btn-sign-staff');
    if (signBtn) signBtn.addEventListener('click', () => {
      openSignaturePad(null, async (blob) => { sig = await DB.setSignature(ra.id, sigRole, blob); renderSigArea(); });
    });
    const thumb = area.querySelector('#staff-sig-thumb');
    if (thumb) thumb.addEventListener('click', () => {
      openSignaturePad(sig.originalBlob, async (blob) => { sig = await DB.setSignature(ra.id, sigRole, blob); renderSigArea(); });
    });
  }
  renderSigArea();

  sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.remove(); });
  sheet.querySelector('#btn-cancel').addEventListener('click', () => sheet.remove());
  sheet.querySelector('#btn-save').addEventListener('click', async () => {
    const initials = sheet.querySelector('#f-initials').value.trim();
    if (!initials) { toast('Enter initials'); return; }
    const additionalStaff = [...(ra.additionalStaff || [])];
    const idx = additionalStaff.findIndex((x) => x.id === s.id);
    const updated = { id: s.id, initials };
    if (idx >= 0) additionalStaff[idx] = updated; else additionalStaff.push(updated);
    await DB.updateRiskAssessment(ra.id, { additionalStaff });
    sheet.remove();
    renderRiskAssessment(inspectionId);
  });
  const deleteBtn = sheet.querySelector('#btn-delete');
  if (deleteBtn) deleteBtn.addEventListener('click', async () => {
    if (!confirm('Remove this staff member?')) return;
    await DB.removeSignature(ra.id, sigRole);
    const additionalStaff = (ra.additionalStaff || []).filter((x) => x.id !== s.id);
    await DB.updateRiskAssessment(ra.id, { additionalStaff });
    sheet.remove();
    renderRiskAssessment(inspectionId);
  });
}

// ---------- DRAWINGS (imported PDF pages, annotatable) ----------
async function renderDrawings(inspectionId) {
  const insp = await DB.get('inspections', inspectionId);
  if (!insp) { navigate('#/'); return; }
  let drawings = await DB.listDrawings(inspectionId);

  appEl.innerHTML = `
    <div class="topbar">
      <button class="icon-btn" id="btn-back">‹</button>
      <div style="flex:1; min-width:0;">
        <h1 style="font-size:17px;">Drawings</h1>
        <span class="sub">${esc(insp.structureName)}</span>
      </div>
    </div>
    <div class="content" id="drawings-list">
    </div>
    <button class="fab" id="btn-add-drawing">＋</button>
  `;
  document.getElementById('btn-back').addEventListener('click', () => navigate(`#/inspection/${inspectionId}`));
  document.getElementById('btn-add-drawing').addEventListener('click', () => openAddDrawingSheet(inspectionId, () => renderDrawings(inspectionId)));

  function renderList() {
    const list = document.getElementById('drawings-list');
    if (!drawings.length) {
      list.innerHTML = `
        <div class="empty-state">
          <div class="glyph">📄</div>
          <h3>No drawings yet</h3>
          <p>Import a PDF (e.g. a drawing set) and annotate individual sheets, same as a photo.</p>
        </div>`;
      return;
    }
    list.innerHTML = drawings.map((d) => `
      <div class="list-item" data-drawing="${d.id}">
        <div class="photo-thumb" style="width:56px; height:56px; flex-shrink:0; margin-right:12px;">
          <img src="${blobUrl(d.annotatedBlob || d.originalBlob)}">
          ${d.annotatedBlob ? '<div class="annotated-dot"></div>' : ''}
        </div>
        <div class="meta">
          <h3>${esc(d.title) || 'Untitled sheet'}</h3>
          <p>${d.includeInReport ? 'Included in report' : 'Not included in report'}</p>
        </div>
        <span class="chevron">›</span>
      </div>
    `).join('');
    list.querySelectorAll('[data-drawing]').forEach((row) => {
      row.addEventListener('click', () => {
        const d = drawings.find((x) => x.id === row.dataset.drawing);
        openDrawingDetailSheet(d, {
          onChanged: async () => { drawings = await DB.listDrawings(inspectionId); renderList(); }
        });
      });
    });
  }
  renderList();
}

function openDrawingDetailSheet(drawing, { onChanged }) {
  const sheet = el(`
    <div class="sheet-backdrop">
      <div class="sheet">
        <div class="sheet-handle"></div>
        <h2>${esc(drawing.title) || 'Drawing'}</h2>
        <div class="photo-thumb" id="drawing-thumb" style="width:100%; height:220px; margin-bottom:16px;">
          <img src="${blobUrl(drawing.annotatedBlob || drawing.originalBlob)}" style="object-fit:contain; background:#fafafa;">
        </div>
        <div class="field"><label>Title</label><input type="text" id="f-title" value="${esc(drawing.title)}" placeholder="e.g. Sheet 3 - General Arrangement"></div>
        <div class="checkbox-row">
          <input type="checkbox" id="f-include" ${drawing.includeInReport ? 'checked' : ''}>
          <label for="f-include">Include in main report export</label>
        </div>
        <button class="btn btn-primary btn-block" id="btn-annotate">✏️ Edit — draw with Pencil</button>
        <button class="btn btn-secondary btn-block" id="btn-save" style="margin-top:10px;">Save</button>
        <button class="btn btn-danger btn-block" id="btn-delete" style="margin-top:10px;">Delete drawing</button>
        <button class="btn btn-ghost btn-block" id="btn-cancel">Close</button>
      </div>
    </div>
  `);
  presentOverlay(sheet);
  sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.remove(); });
  sheet.querySelector('#btn-cancel').addEventListener('click', () => sheet.remove());

  sheet.querySelector('#btn-annotate').addEventListener('click', async () => {
    sheet.remove();
    await openAnnotator(drawing.id, () => onChanged());
  });
  sheet.querySelector('#btn-save').addEventListener('click', async () => {
    await DB.updateDrawing(drawing.id, {
      title: sheet.querySelector('#f-title').value.trim(),
      includeInReport: sheet.querySelector('#f-include').checked
    });
    sheet.remove();
    onChanged();
  });
  sheet.querySelector('#btn-delete').addEventListener('click', async () => {
    if (!confirm('Delete this drawing?')) return;
    await DB.delete('photos', drawing.id);
    sheet.remove();
    onChanged();
  });
}

// Generic PDF import: picks a file, loads it, and hands each selected page's rendered blob
// to `onImportPage(blob, title)` — used by both Drawings and standalone Scale/Annotate.
async function openPdfImportFlow(onImportPage, onAllImported) {
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'application/pdf';
  fileInput.style.display = 'none';
  document.body.appendChild(fileInput);

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    fileInput.remove();
    if (!file) return;
    toast('Loading PDF…');
    try {
      await loadPdfJs();
      const arrayBuffer = await file.arrayBuffer();
      const pdfDoc = await window.pdfjsLib.getDocument({ data: arrayBuffer }).promise;
      await openPdfPagePickerSheet(pdfDoc, file.name, onImportPage, onAllImported);
    } catch (err) {
      console.error(err);
      toast('Could not load that PDF — check your internet connection and try again');
    }
  });
  fileInput.click();
}

function openAddDrawingSheet(inspectionId, onAdded) {
  const sheet = el(`
    <div class="sheet-backdrop">
      <div class="sheet">
        <div class="sheet-handle"></div>
        <h2>Add drawing</h2>
        <button class="btn btn-primary btn-block" id="btn-camera">📷 Take photo</button>
        <button class="btn btn-secondary btn-block" id="btn-library" style="margin-top:10px;">🖼 Choose from library</button>
        <button class="btn btn-secondary btn-block" id="btn-pdf" style="margin-top:10px;">📄 Import PDF</button>
        <button class="btn btn-secondary btn-block" id="btn-sketch" style="margin-top:10px;">✏️ Draw sketch</button>
        <button class="btn btn-ghost btn-block" id="btn-cancel" style="margin-top:16px;">Cancel</button>
        <input type="file" id="ad-camera-input" accept="image/*" capture="environment" style="display:none;">
        <input type="file" id="ad-library-input" accept="image/*" multiple style="display:none;">
      </div>
    </div>
  `);
  presentOverlay(sheet);
  sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.remove(); });
  sheet.querySelector('#btn-cancel').addEventListener('click', () => sheet.remove());

  async function handleImageFiles(fileList) {
    sheet.remove();
    for (const file of Array.from(fileList)) {
      const normalized = await normalizeImageFile(file);
      await DB.addDrawing(inspectionId, normalized, file.name.replace(/\.[a-z0-9]+$/i, ''));
    }
    onAdded();
  }
  sheet.querySelector('#btn-camera').addEventListener('click', () => sheet.querySelector('#ad-camera-input').click());
  sheet.querySelector('#btn-library').addEventListener('click', () => sheet.querySelector('#ad-library-input').click());
  sheet.querySelector('#ad-camera-input').addEventListener('change', (e) => { if (e.target.files.length) handleImageFiles(e.target.files); });
  sheet.querySelector('#ad-library-input').addEventListener('change', (e) => { if (e.target.files.length) handleImageFiles(e.target.files); });

  sheet.querySelector('#btn-pdf').addEventListener('click', () => {
    sheet.remove();
    openDrawingImportSheet(inspectionId, onAdded);
  });
  sheet.querySelector('#btn-sketch').addEventListener('click', () => {
    sheet.remove();
    openSketchTitlePrompt(async (title) => {
      const blank = await createA4CanvasBlob();
      const drawing = await DB.addDrawing(inspectionId, blank, title);
      await openAnnotator(drawing.id, onAdded);
    });
  });
}

async function openDrawingImportSheet(inspectionId, onImported) {
  await openPdfImportFlow(
    (blob, title) => DB.addDrawing(inspectionId, blob, title),
    onImported
  );
}

async function openPdfPagePickerSheet(pdfDoc, filename, onImportPage, onAllImported) {
  const numPages = pdfDoc.numPages;
  const sheet = el(`
    <div class="sheet-backdrop">
      <div class="sheet">
        <div class="sheet-handle"></div>
        <h2>Select pages to import</h2>
        <p class="muted" style="font-size:13px; margin-top:-8px;">${numPages} page${numPages === 1 ? '' : 's'} found.</p>
        <div class="photo-grid" id="page-grid"></div>
        <button class="btn btn-primary btn-block" id="btn-import" style="margin-top:16px;" disabled>Import selected (0)</button>
        <button class="btn btn-ghost btn-block" id="btn-cancel">Cancel</button>
      </div>
    </div>
  `);
  presentOverlay(sheet);
  sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.remove(); });
  sheet.querySelector('#btn-cancel').addEventListener('click', () => sheet.remove());

  const grid = sheet.querySelector('#page-grid');
  const selected = new Set();
  const importBtn = sheet.querySelector('#btn-import');

  function updateImportBtn() {
    importBtn.textContent = `Import selected (${selected.size})`;
    importBtn.disabled = selected.size === 0;
  }

  for (let pageNum = 1; pageNum <= numPages; pageNum++) {
    const tile = el(`<div class="photo-thumb" data-page="${pageNum}" style="position:relative; cursor:pointer;"><div class="muted" style="display:flex; align-items:center; justify-content:center; height:100%; font-size:11px;">Loading…</div></div>`);
    grid.appendChild(tile);

    tile.addEventListener('click', () => {
      if (selected.has(pageNum)) { selected.delete(pageNum); tile.style.outline = ''; }
      else { selected.add(pageNum); tile.style.outline = '3px solid var(--red)'; }
      updateImportBtn();
    });

    // Render a low-res thumbnail for the picker
    pdfDoc.getPage(pageNum).then((page) => {
      const viewport = page.getViewport({ scale: 0.35 });
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise.then(() => {
        tile.innerHTML = '';
        const img = document.createElement('img');
        img.src = canvas.toDataURL('image/jpeg', 0.7);
        tile.appendChild(img);
        const label = document.createElement('div');
        label.textContent = `Page ${pageNum}`;
        label.style.cssText = 'position:absolute; bottom:2px; left:4px; font-size:9px; color:#fff; background:rgba(28,31,38,0.7); padding:1px 5px; border-radius:3px;';
        tile.appendChild(label);
      });
    });
  }

  importBtn.addEventListener('click', async () => {
    const pages = Array.from(selected).sort((a, b) => a - b);
    sheet.remove();
    toast(`Importing ${pages.length} page${pages.length === 1 ? '' : 's'}…`);
    const baseName = filename.replace(/\.pdf$/i, '');
    for (const pageNum of pages) {
      const page = await pdfDoc.getPage(pageNum);
      const viewport = page.getViewport({ scale: 2.2 }); // higher res for legible annotation
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
      const title = numPages > 1 ? `${baseName} — Page ${pageNum}` : baseName;
      await onImportPage(blob, title);
    }
    toast('Import complete');
    onAllImported();
  });
}

async function renderAppendix(inspectionId, appendixId) {
  const insp = await DB.get('inspections', inspectionId);
  if (!insp) { navigate('#/'); return; }
  const appendices = await DB.listAppendices(inspectionId);
  const appendixIndex = appendices.findIndex((a) => a.id === appendixId);
  const appendix = appendices[appendixIndex];
  if (!appendix) { navigate(`#/inspection/${inspectionId}`); return; }
  const fullTitle = `Appendix ${appendixLetter(appendixIndex)} - ${appendix.name}`;
  let items = await DB.listAppendixItems(appendixId);

  appEl.innerHTML = `
    <div class="topbar">
      <button class="icon-btn" id="btn-back">‹</button>
      <div style="flex:1; min-width:0;">
        <h1 style="font-size:17px;">${esc(fullTitle)}</h1>
        <span class="sub">${esc(insp.structureName)}</span>
      </div>
      <button class="text-btn" id="btn-rename-appendix">Edit</button>
    </div>
    <div class="content" id="appendix-item-list"></div>
    <button class="fab" id="btn-add-item">＋</button>
  `;
  document.getElementById('btn-back').addEventListener('click', () => navigate(`#/inspection/${inspectionId}`));
  document.getElementById('btn-rename-appendix').addEventListener('click', () => openEditAppendixSheet(inspectionId, appendix, appendixIndex));
  document.getElementById('btn-add-item').addEventListener('click', () => openAddAppendixItemSheet(inspectionId, appendixId, () => renderAppendix(inspectionId, appendixId)));

  function renderList() {
    const list = document.getElementById('appendix-item-list');
    if (!items.length) {
      list.innerHTML = `
        <div class="empty-state">
          <div class="glyph">📎</div>
          <h3>No items yet</h3>
          <p>Add photos or import a PDF (page by page) into this appendix.</p>
        </div>`;
      return;
    }
    list.innerHTML = items.map((it) => `
      <div class="list-item" data-item="${it.id}">
        <div class="photo-thumb" style="width:56px; height:56px; flex-shrink:0; margin-right:12px;">
          <img src="${blobUrl(it.annotatedBlob || it.originalBlob)}">
          ${it.annotatedBlob ? '<div class="annotated-dot"></div>' : ''}
        </div>
        <div class="meta"><h3>${esc(it.title) || 'Untitled'}</h3></div>
        <span class="chevron">›</span>
      </div>
    `).join('');
    list.querySelectorAll('[data-item]').forEach((row) => {
      row.addEventListener('click', () => {
        const it = items.find((x) => x.id === row.dataset.item);
        openAppendixItemDetailSheet(it, {
          onChanged: async () => { items = await DB.listAppendixItems(appendixId); renderList(); }
        });
      });
    });
  }
  renderList();
}

function openEditAppendixSheet(inspectionId, appendix, appendixIndex) {
  const letter = appendixLetter(appendixIndex);
  const sheet = el(`
    <div class="sheet-backdrop">
      <div class="sheet">
        <div class="sheet-handle"></div>
        <h2>Edit appendix</h2>
        <div class="field">
          <label>Name</label>
          <div class="link-row">
            <span style="font-weight:700; color:var(--ink-soft); margin-right:6px; white-space:nowrap;">Appendix ${letter} -</span>
            <input type="text" id="f-name" value="${esc(appendix.name)}" style="flex:1;">
          </div>
        </div>
        <button class="btn btn-primary btn-block" id="btn-save">Save</button>
        <button class="btn btn-danger btn-block" id="btn-delete" style="margin-top:8px;">Delete appendix</button>
        <button class="btn btn-ghost btn-block" id="btn-cancel">Cancel</button>
      </div>
    </div>
  `);
  presentOverlay(sheet);
  sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.remove(); });
  sheet.querySelector('#btn-cancel').addEventListener('click', () => sheet.remove());
  sheet.querySelector('#btn-save').addEventListener('click', async () => {
    const name = sheet.querySelector('#f-name').value.trim();
    if (!name) { toast('Enter a name'); return; }
    await DB.updateAppendix(inspectionId, appendix.id, { name });
    sheet.remove();
    renderAppendix(inspectionId, appendix.id);
  });
  sheet.querySelector('#btn-delete').addEventListener('click', async () => {
    if (!confirm('Delete this appendix and everything in it?')) return;
    await DB.deleteAppendixCascade(inspectionId, appendix.id);
    sheet.remove();
    navigate(`#/inspection/${inspectionId}`);
  });
}

function openAddAppendixItemSheet(inspectionId, appendixId, onAdded) {
  const sheet = el(`
    <div class="sheet-backdrop">
      <div class="sheet">
        <div class="sheet-handle"></div>
        <h2>Add to appendix</h2>
        <button class="btn btn-primary btn-block" id="btn-camera">📷 Take photo</button>
        <button class="btn btn-secondary btn-block" id="btn-library" style="margin-top:10px;">🖼 Choose from library</button>
        <button class="btn btn-secondary btn-block" id="btn-pdf" style="margin-top:10px;">📄 Import PDF</button>
        <button class="btn btn-ghost btn-block" id="btn-cancel" style="margin-top:16px;">Cancel</button>
        <input type="file" id="ai-camera-input" accept="image/*" capture="environment" style="display:none;">
        <input type="file" id="ai-library-input" accept="image/*" multiple style="display:none;">
      </div>
    </div>
  `);
  presentOverlay(sheet);
  sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.remove(); });
  sheet.querySelector('#btn-cancel').addEventListener('click', () => sheet.remove());

  async function handleImageFiles(fileList) {
    sheet.remove();
    for (const file of Array.from(fileList)) {
      const normalized = await normalizeImageFile(file);
      await DB.addAppendixItem(appendixId, normalized, file.name.replace(/\.[a-z0-9]+$/i, ''));
    }
    onAdded();
  }
  sheet.querySelector('#btn-camera').addEventListener('click', () => sheet.querySelector('#ai-camera-input').click());
  sheet.querySelector('#btn-library').addEventListener('click', () => sheet.querySelector('#ai-library-input').click());
  sheet.querySelector('#ai-camera-input').addEventListener('change', (e) => { if (e.target.files.length) handleImageFiles(e.target.files); });
  sheet.querySelector('#ai-library-input').addEventListener('change', (e) => { if (e.target.files.length) handleImageFiles(e.target.files); });

  sheet.querySelector('#btn-pdf').addEventListener('click', () => {
    sheet.remove();
    openPdfImportFlow(
      (blob, title) => DB.addAppendixItem(appendixId, blob, title),
      () => { toast('Import complete'); onAdded(); }
    );
  });
}

function openAppendixItemDetailSheet(item, { onChanged }) {
  const sheet = el(`
    <div class="sheet-backdrop">
      <div class="sheet">
        <div class="sheet-handle"></div>
        <h2>${esc(item.title) || 'Item'}</h2>
        <div class="photo-thumb" style="width:100%; height:220px; margin-bottom:16px;">
          <img src="${blobUrl(item.annotatedBlob || item.originalBlob)}" style="object-fit:contain; background:#fafafa;">
        </div>
        <div class="field"><label>Title</label><input type="text" id="f-title" value="${esc(item.title)}"></div>
        <button class="btn btn-primary btn-block" id="btn-annotate">✏️ Edit — draw with Pencil</button>
        <button class="btn btn-secondary btn-block" id="btn-save" style="margin-top:10px;">Save</button>
        <button class="btn btn-danger btn-block" id="btn-delete" style="margin-top:10px;">Delete item</button>
        <button class="btn btn-ghost btn-block" id="btn-cancel">Close</button>
      </div>
    </div>
  `);
  presentOverlay(sheet);
  sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.remove(); });
  sheet.querySelector('#btn-cancel').addEventListener('click', () => sheet.remove());
  sheet.querySelector('#btn-annotate').addEventListener('click', async () => {
    sheet.remove();
    await openAnnotator(item.id, () => onChanged());
  });
  sheet.querySelector('#btn-save').addEventListener('click', async () => {
    await DB.updatePhoto(item.id, { title: sheet.querySelector('#f-title').value.trim() });
    sheet.remove();
    onChanged();
  });
  sheet.querySelector('#btn-delete').addEventListener('click', async () => {
    if (!confirm('Delete this item?')) return;
    await DB.delete('photos', item.id);
    sheet.remove();
    onChanged();
  });
}

// ---------- SCALE / ANNOTATE (standalone tool, not tied to any inspection) ----------

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

async function blobToFormat(blob, mime) {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext('2d').drawImage(bitmap, 0, 0);
  if (bitmap.close) bitmap.close();
  return new Promise((resolve) => canvas.toBlob(resolve, mime, mime === 'image/jpeg' ? 0.92 : undefined));
}

async function saveImageAsPDF(blob, baseName) {
  if (!window.jspdf) { toast('PDF library not loaded — connect to the internet once, then try again'); return; }
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext('2d').drawImage(bitmap, 0, 0);
  const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
  if (bitmap.close) bitmap.close();
  const { jsPDF } = window.jspdf;
  const wPt = bitmap.width * 0.75; // approx px->pt at 96dpi source -> 72pt page
  const hPt = bitmap.height * 0.75;
  const doc = new jsPDF({ unit: 'pt', format: [wPt, hPt] });
  doc.addImage(dataUrl, 'JPEG', 0, 0, wPt, hPt, undefined, 'FAST');
  doc.save(`${baseName}.pdf`);
}

function openSaveFormatSheet(formats, onPick) {
  const labels = { png: 'PNG (lossless)', jpeg: 'JPEG (smaller file)', pdf: 'PDF' };
  const sheet = el(`
    <div class="sheet-backdrop">
      <div class="sheet">
        <div class="sheet-handle"></div>
        <h2>Save to file</h2>
        ${formats.map((f) => `<button class="btn btn-secondary btn-block" data-format="${f}" style="margin-bottom:10px;">${labels[f]}</button>`).join('')}
        <button class="btn btn-ghost btn-block" id="btn-cancel">Cancel</button>
      </div>
    </div>
  `);
  presentOverlay(sheet);
  sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.remove(); });
  sheet.querySelector('#btn-cancel').addEventListener('click', () => sheet.remove());
  sheet.querySelectorAll('[data-format]').forEach((btn) => {
    btn.addEventListener('click', () => {
      sheet.remove();
      onPick(btn.dataset.format);
    });
  });
}

async function renderScaleAnnotate() {
  let items = await DB.listStandaloneAnnotations();

  appEl.innerHTML = `
    <div class="topbar">
      <button class="icon-btn" id="btn-back">‹</button>
      <div style="flex:1; min-width:0;">
        <h1 style="font-size:17px;">Scale / Annotate</h1>
        <span class="sub">Draw, measure, and export — not saved to any inspection</span>
      </div>
    </div>
    <div class="content" id="sa-list"></div>
    <button class="fab" id="btn-sa-new">＋</button>
  `;
  document.getElementById('btn-back').addEventListener('click', () => navigate('#/'));
  document.getElementById('btn-sa-new').addEventListener('click', openNewScaleAnnotateSheet);

  function renderList() {
    const list = document.getElementById('sa-list');
    if (!items.length) {
      list.innerHTML = `
        <div class="empty-state">
          <div class="glyph">📐</div>
          <h3>Nothing here yet</h3>
          <p>Take a photo, choose one from your library, or import a PDF to draw, measure, and export.</p>
        </div>`;
      return;
    }
    list.innerHTML = items.map((it) => `
      <div class="list-item" data-item="${it.id}">
        <div class="photo-thumb" style="width:56px; height:56px; flex-shrink:0; margin-right:12px;">
          <img src="${blobUrl(it.annotatedBlob || it.originalBlob)}">
          ${it.annotatedBlob ? '<div class="annotated-dot"></div>' : ''}
        </div>
        <div class="meta">
          <h3>${esc(it.title) || 'Untitled'}</h3>
          <p>${it.calibration ? `Calibrated · ${esc(it.calibration.unit)}` : 'Not calibrated'}${it.sourceType === 'pdf' ? ' · from PDF' : ''}</p>
        </div>
        <span class="chevron">›</span>
      </div>
    `).join('');
    list.querySelectorAll('[data-item]').forEach((row) => {
      row.addEventListener('click', () => {
        const it = items.find((x) => x.id === row.dataset.item);
        openScaleAnnotateDetailSheet(it, {
          onChanged: async () => { items = await DB.listStandaloneAnnotations(); renderList(); }
        });
      });
    });
  }
  renderList();
}

function openNewScaleAnnotateSheet() {
  const sheet = el(`
    <div class="sheet-backdrop">
      <div class="sheet">
        <div class="sheet-handle"></div>
        <h2>New Scale / Annotate</h2>
        <button class="btn btn-primary btn-block" id="btn-camera">📷 Take photo</button>
        <button class="btn btn-secondary btn-block" id="btn-library" style="margin-top:10px;">🖼 Choose from library</button>
        <button class="btn btn-secondary btn-block" id="btn-pdf" style="margin-top:10px;">📄 Import PDF</button>
        <button class="btn btn-ghost btn-block" id="btn-cancel" style="margin-top:16px;">Cancel</button>
        <input type="file" id="sa-camera-input" accept="image/*" capture="environment" style="display:none;">
        <input type="file" id="sa-library-input" accept="image/*" style="display:none;">
      </div>
    </div>
  `);
  presentOverlay(sheet);
  sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.remove(); });
  sheet.querySelector('#btn-cancel').addEventListener('click', () => sheet.remove());

  async function handleImageFile(file) {
    sheet.remove();
    const normalized = await normalizeImageFile(file);
    const rec = await DB.addStandaloneAnnotation(normalized, file.name.replace(/\.[a-z0-9]+$/i, ''), 'image');
    navigate('#/scale-annotate');
    await openAnnotator(rec.id, () => renderScaleAnnotate());
  }

  sheet.querySelector('#btn-camera').addEventListener('click', () => sheet.querySelector('#sa-camera-input').click());
  sheet.querySelector('#btn-library').addEventListener('click', () => sheet.querySelector('#sa-library-input').click());
  sheet.querySelector('#sa-camera-input').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) handleImageFile(f); });
  sheet.querySelector('#sa-library-input').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) handleImageFile(f); });

  sheet.querySelector('#btn-pdf').addEventListener('click', () => {
    sheet.remove();
    openPdfImportFlow(
      (blob, title) => DB.addStandaloneAnnotation(blob, title, 'pdf'),
      () => { toast('Import complete'); renderScaleAnnotate(); }
    );
  });
}

function openScaleAnnotateDetailSheet(item, { onChanged }) {
  const sheet = el(`
    <div class="sheet-backdrop">
      <div class="sheet">
        <div class="sheet-handle"></div>
        <h2>${esc(item.title) || 'Untitled'}</h2>
        <div class="photo-thumb" style="width:100%; height:220px; margin-bottom:16px;">
          <img src="${blobUrl(item.annotatedBlob || item.originalBlob)}" style="object-fit:contain; background:#fafafa;">
        </div>
        <div class="field"><label>Title</label><input type="text" id="f-title" value="${esc(item.title)}"></div>
        <p class="muted" style="font-size:13px; margin-top:-8px;">${item.calibration ? `Calibrated: 1 unit = ${(1 / item.calibration.pixelsPerUnit).toFixed(3)} px⁻¹ (${esc(item.calibration.unit)})` : 'Not yet calibrated — open Edit and use Calibrate.'}</p>
        <button class="btn btn-primary btn-block" id="btn-annotate">✏️ Edit — draw, ruler, measure</button>
        <button class="btn btn-secondary btn-block" id="btn-save-title" style="margin-top:10px;">Save title</button>
        <button class="btn btn-secondary btn-block" id="btn-save-file" style="margin-top:10px;">⬇️ Save to file</button>
        <button class="btn btn-danger btn-block" id="btn-delete" style="margin-top:10px;">Delete</button>
        <button class="btn btn-ghost btn-block" id="btn-cancel">Close</button>
      </div>
    </div>
  `);
  presentOverlay(sheet);
  sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.remove(); });
  sheet.querySelector('#btn-cancel').addEventListener('click', () => sheet.remove());

  sheet.querySelector('#btn-annotate').addEventListener('click', async () => {
    sheet.remove();
    await openAnnotator(item.id, () => onChanged());
  });
  sheet.querySelector('#btn-save-title').addEventListener('click', async () => {
    await DB.updatePhoto(item.id, { title: sheet.querySelector('#f-title').value.trim() });
    sheet.remove();
    onChanged();
  });
  sheet.querySelector('#btn-save-file').addEventListener('click', () => {
    const formats = item.sourceType === 'pdf' ? ['pdf', 'png', 'jpeg'] : ['png', 'jpeg'];
    openSaveFormatSheet(formats, async (format) => {
      const blob = item.annotatedBlob || item.originalBlob;
      const baseName = (item.title || 'scale-annotate').replace(/[^a-z0-9]+/gi, '_');
      toast('Preparing file…');
      try {
        if (format === 'pdf') {
          await saveImageAsPDF(blob, baseName);
        } else {
          const mime = format === 'png' ? 'image/png' : 'image/jpeg';
          const converted = await blobToFormat(blob, mime);
          downloadBlob(converted, `${baseName}.${format === 'jpeg' ? 'jpg' : format}`);
        }
        toast('Saved — check your downloads');
      } catch (err) {
        console.error(err);
        toast('Save failed: ' + err.message);
      }
    });
  });
  sheet.querySelector('#btn-delete').addEventListener('click', async () => {
    if (!confirm('Delete this item?')) return;
    await DB.delete('photos', item.id);
    sheet.remove();
    onChanged();
  });
}

// ---------- FINDING EDITOR ----------
async function openFindingEditor(inspectionId, elementId, findingId) {
  const elmt = await DB.get('elements', elementId);
  const insp = await DB.get('inspections', inspectionId);
  const currencySymbol = CURRENCY_SYMBOLS[insp && insp.currency] || '$';
  let finding = findingId ? await DB.get('findings', findingId) : null;
  if (!finding) {
    finding = await DB.createFinding(elementId, {});
    findingId = finding.id;
  }
  let photos = await DB.listPhotosForFinding(findingId);
  const isGiBridges = insp && insp.inspectionType === 'GI Bridges';
  const isSafetyInspection = insp && insp.inspectionType === 'Safety Inspection';
  const elMeta = elementSublineParts(elmt, isGiBridges).join('   ·   ');
  // Safety Inspection: severity/extent and works-required are each hidden by default per
  // finding, behind their OWN independent toggle — either can be shown without the other.
  const showDetailFields = !isSafetyInspection || finding.showDetail;
  const showWorksSection = !isSafetyInspection || finding.showWorks;

  const view = el(`
    <div class="fullscreen">
      <div class="topbar">
        <button class="icon-btn" id="btn-close">✕</button>
        <div style="flex:1; min-width:0;">
          <h1 style="font-size:17px;">Finding</h1>
          <span class="sub" id="save-status">&nbsp;</span>
        </div>
        <button class="text-btn" id="btn-save-finding">Save</button>
        <button class="text-btn" id="btn-delete-finding" style="color:#ff9d9d;">Delete</button>
      </div>
      <div class="content" style="overflow-y:auto;">
        <div class="card" style="margin-top:0;">
          <strong style="font-size:16px;">${esc(elmt.name)}</strong>
          ${elMeta ? `<p class="muted" style="margin:4px 0 0; font-size:13px;">${esc(elMeta)}</p>` : ''}
        </div>

        <div class="section-header" style="margin-top:0;"><h2>Notes</h2></div>
        <div class="field"><textarea id="f-notes" placeholder="Describe the finding…" style="min-height:270px;">${esc(finding.notes)}</textarea></div>

        ${isSafetyInspection ? `
        <div class="checkbox-row">
          <input type="checkbox" id="f-show-detail" ${finding.showDetail ? 'checked' : ''}>
          <label for="f-show-detail">Add severity &amp; extent</label>
        </div>
        ` : ''}

        <div id="detail-fields" class="${showDetailFields ? '' : 'hidden'}">
          <div class="section-header" style="margin-top:0;"><h2>Severity</h2></div>
          <div class="severity-picker" id="severity-picker">
            ${[1, 2, 3, 4, 5].map((s) => `
              <button class="chip ${finding.severity === s ? 'selected' : ''}" data-sev="${s}" style="${finding.severity === s ? `background:var(--sev-${s});` : ''}">
                ${s}<span class="chip-label">${SEVERITY_LABELS[s]}</span>
              </button>
            `).join('')}
          </div>

          <div class="section-header"><h2>Extent</h2></div>
          <div class="extent-picker" id="extent-picker">
            ${['A', 'B', 'C', 'D', 'E'].map((x) => `
              <button class="chip ${finding.extent === x ? 'selected' : ''}" data-ext="${x}" style="${finding.extent === x ? 'background:var(--ink);' : ''}">
                ${x}<span class="chip-label">${EXTENT_LABELS[x]}</span>
              </button>
            `).join('')}
          </div>
        </div>

        <div class="section-header"><h2>Priority</h2></div>
        <div class="severity-picker" id="priority-picker">
          ${['High', 'Medium', 'Low', 'Monitor'].map((p) => `
            <button class="chip ${finding.priority === p ? 'selected' : ''}" data-pri="${p}" style="${finding.priority === p ? `background:${PRIORITY_COLORS[p]};` : ''}">
              ${p}
            </button>
          `).join('')}
        </div>

        ${isSafetyInspection ? `
        <div class="checkbox-row">
          <input type="checkbox" id="f-show-works" ${finding.showWorks ? 'checked' : ''}>
          <label for="f-show-works">Add works required</label>
        </div>
        ` : ''}

        <div id="works-section" class="${showWorksSection ? '' : 'hidden'}">
          <div class="section-header"><h2>Works</h2></div>
          <div class="checkbox-row">
            <input type="checkbox" id="f-works-required" ${finding.worksRequired ? 'checked' : ''}>
            <label for="f-works-required">Works required</label>
          </div>
          <div id="works-detail" class="${finding.worksRequired ? '' : 'hidden'}">
            <div class="field"><label>Works needed</label><textarea id="f-works-desc" placeholder="Describe the works required…">${esc(finding.worksDescription)}</textarea></div>
            <div class="field">
              <label>Cost estimate</label>
              <div class="link-row">
                <span style="font-size:18px; font-weight:700; color:var(--ink-soft); margin-right:8px;">${currencySymbol}</span>
                <input type="text" id="f-cost" inputmode="decimal" value="${esc(String(finding.costEstimate || '').replace(/^[\$£€\s]+/, ''))}" placeholder="e.g. 12,500" style="flex:1;">
              </div>
            </div>
          </div>
        </div>

        <div class="section-header"><h2>Photos</h2></div>
        <div class="photo-grid" id="photo-grid"></div>
      </div>
    </div>
  `);
  presentOverlay(view);

  const saveStatusEl = view.querySelector('#save-status');
  function flashSaveStatus(text) {
    saveStatusEl.textContent = text;
    clearTimeout(flashSaveStatus._t);
    flashSaveStatus._t = setTimeout(() => { saveStatusEl.textContent = '\u00A0'; }, 1500);
  }

  // Persists current field values without closing the editor. Called on every
  // meaningful change (chip taps, checkbox toggle, debounced on typing, and on blur)
  // so nothing is lost regardless of what interrupts the session — a squeeze gesture,
  // an accidental navigation, adding a photo, anything.
  async function persistFields(showStatus) {
    const sevBtn = view.querySelector('.chip.selected[data-sev]');
    const extBtn = view.querySelector('.chip.selected[data-ext]');
    const priBtn = view.querySelector('.chip.selected[data-pri]');
    const worksRequired = view.querySelector('#f-works-required').checked;
    const showDetailCheckbox = view.querySelector('#f-show-detail');
    const showWorksCheckbox = view.querySelector('#f-show-works');
    const showDetail = showDetailCheckbox ? showDetailCheckbox.checked : true;
    const showWorks = showWorksCheckbox ? showWorksCheckbox.checked : true;
    const detailVisible = !isSafetyInspection || showDetail;
    const worksVisible = !isSafetyInspection || showWorks;
    await DB.updateFinding(findingId, {
      severity: detailVisible && sevBtn ? Number(sevBtn.dataset.sev) : null,
      extent: detailVisible && extBtn ? extBtn.dataset.ext : null,
      priority: priBtn ? priBtn.dataset.pri : null,
      worksRequired: worksVisible ? worksRequired : false,
      worksDescription: worksVisible && worksRequired ? view.querySelector('#f-works-desc').value.trim() : '',
      costEstimate: worksVisible && worksRequired ? view.querySelector('#f-cost').value.trim() : '',
      notes: view.querySelector('#f-notes').value.trim(),
      showDetail: isSafetyInspection ? showDetail : finding.showDetail,
      showWorks: isSafetyInspection ? showWorks : finding.showWorks
    });
    if (showStatus) flashSaveStatus('Saved');
  }

  function debounce(fn, wait) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), wait); };
  }
  const debouncedAutosave = debounce(() => persistFields(false), 600);

  // Autosave on every text field: as-you-type (debounced) and immediately on blur.
  ['#f-works-desc', '#f-cost', '#f-notes'].forEach((sel) => {
    const field = view.querySelector(sel);
    field.addEventListener('input', debouncedAutosave);
    field.addEventListener('blur', () => persistFields(false));
  });

  const showDetailCheckbox = view.querySelector('#f-show-detail');
  if (showDetailCheckbox) {
    showDetailCheckbox.addEventListener('change', (e) => {
      view.querySelector('#detail-fields').classList.toggle('hidden', !e.target.checked);
      persistFields(false);
    });
  }
  const showWorksCheckbox = view.querySelector('#f-show-works');
  if (showWorksCheckbox) {
    showWorksCheckbox.addEventListener('change', (e) => {
      view.querySelector('#works-section').classList.toggle('hidden', !e.target.checked);
      persistFields(false);
    });
  }

  view.querySelector('#f-works-required').addEventListener('change', (e) => {
    view.querySelector('#works-detail').classList.toggle('hidden', !e.target.checked);
    persistFields(false);
  });

  view.querySelectorAll('#priority-picker .chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const wasSelected = chip.classList.contains('selected');
      view.querySelectorAll('#priority-picker .chip').forEach((c) => { c.classList.remove('selected'); c.style.background = ''; });
      if (!wasSelected) { chip.classList.add('selected'); chip.style.background = PRIORITY_COLORS[chip.dataset.pri]; }
      persistFields(false);
    });
  });

  function renderPhotoGrid() {
    const grid = view.querySelector('#photo-grid');
    grid.innerHTML = photos.map((p) => `
      <div class="photo-thumb" data-pid="${p.id}">
        <img src="${blobUrl(p.annotatedBlob || p.originalBlob)}">
        ${p.annotatedBlob ? '<div class="annotated-dot"></div>' : ''}
      </div>
    `).join('') + `<div class="photo-add" id="btn-add-photo">📷</div>`;

    grid.querySelectorAll('.photo-thumb').forEach((thumb) => {
      thumb.addEventListener('click', () => {
        openPhotoActionSheet(thumb.dataset.pid, {
          onAnnotated: async () => { photos = await DB.listPhotosForFinding(findingId); renderPhotoGrid(); },
          onRemoved: async () => { photos = await DB.listPhotosForFinding(findingId); renderPhotoGrid(); },
          onCaptioned: async () => { photos = await DB.listPhotosForFinding(findingId); renderPhotoGrid(); }
        });
      });
    });
    grid.querySelector('#btn-add-photo').addEventListener('click', () => {
      // Persist any in-progress text before navigating to the camera/library, so nothing
      // is at risk while the photo picker or annotator is open.
      persistFields(false);
      openPhotoSourceSheet({
        multiple: true,
        onFiles: async (files) => {
          for (const file of Array.from(files)) {
            const normalized = await normalizeImageFile(file);
            await DB.addPhoto({ kind: 'finding', findingId, originalBlob: normalized, order: photos.length });
          }
          photos = await DB.listPhotosForFinding(findingId);
          renderPhotoGrid();
        },
        onSketch: async () => {
          const blank = await createBlankCanvasBlob();
          const photo = await DB.addPhoto({ kind: 'finding', findingId, originalBlob: blank, order: photos.length });
          await openAnnotator(photo.id, async () => { photos = await DB.listPhotosForFinding(findingId); renderPhotoGrid(); });
        }
      });
    });
  }
  renderPhotoGrid();

  view.querySelectorAll('#severity-picker .chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const wasSelected = chip.classList.contains('selected');
      view.querySelectorAll('#severity-picker .chip').forEach((c) => { c.classList.remove('selected'); c.style.background = ''; });
      if (!wasSelected) {
        chip.classList.add('selected'); chip.style.background = `var(--sev-${chip.dataset.sev})`;
        const newSev = Number(chip.dataset.sev);
        const extBtn = view.querySelector('#extent-picker .chip.selected');
        if (extBtn && !bciIsValidSeverityExtent(newSev, extBtn.dataset.ext)) {
          extBtn.classList.remove('selected'); extBtn.style.background = '';
          toast('Extent A only applies with Severity 1 — extent cleared');
        }
      }
      persistFields(false);
    });
  });
  view.querySelectorAll('#extent-picker .chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const wasSelected = chip.classList.contains('selected');
      const sevBtn = view.querySelector('#severity-picker .chip.selected');
      const currentSev = sevBtn ? Number(sevBtn.dataset.sev) : null;
      if (!wasSelected && !bciIsValidSeverityExtent(currentSev, chip.dataset.ext)) {
        toast('Extent A only applies with Severity 1');
        return;
      }
      view.querySelectorAll('#extent-picker .chip').forEach((c) => { c.classList.remove('selected'); c.style.background = ''; });
      if (!wasSelected) { chip.classList.add('selected'); chip.style.background = 'var(--ink)'; }
      persistFields(false);
    });
  });

  view.querySelector('#btn-save-finding').addEventListener('click', () => persistFields(true));
  view.querySelector('#btn-close').addEventListener('click', async () => {
    await persistFields(false);
    view.remove();
    renderElement(inspectionId, elementId);
  });
  view.querySelector('#btn-delete-finding').addEventListener('click', async () => {
    if (!confirm('Delete this finding and its photos?')) return;
    await DB.deleteFindingCascade(findingId);
    view.remove();
    renderElement(inspectionId, elementId);
  });
}

// ---------- TEMPLATES MANAGER ----------
async function renderTemplates() {
  const templates = await DB.listTemplates();
  appEl.innerHTML = `
    <div class="topbar">
      <button class="icon-btn" id="btn-back">‹</button>
      <h1>Element templates</h1>
    </div>
    <div class="content">
      <p class="muted" style="font-size:13px; margin-top:0;">Templates let you quickly populate a standard set of elements (e.g. "Standard Bridge") when starting a new inspection or section.</p>
      ${templates.length ? templates.map((t) => `
        <div class="list-item" data-id="${t.id}">
          <div class="meta"><h3>${esc(t.name)}</h3><p>${t.elements.map((e) => esc(e.name)).join(', ')}</p></div>
          <button class="small-btn" data-del="${t.id}">Delete</button>
        </div>
      `).join('') : `
        <div class="empty-state">
          <div class="glyph">▦</div>
          <h3>No templates yet</h3>
          <p>Create a reusable element set for structures you inspect often.</p>
        </div>
      `}
    </div>
    <button class="fab" id="btn-new-template">＋</button>
  `;
  document.getElementById('btn-back').addEventListener('click', () => navigate('#/'));
  document.getElementById('btn-new-template').addEventListener('click', openNewTemplateSheet);
  appEl.querySelectorAll('[data-del]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm('Delete this template?')) return;
      await DB.deleteTemplate(btn.dataset.del);
      renderTemplates();
    });
  });
}

function openNewTemplateSheet() {
  const sheet = el(`
    <div class="sheet-backdrop">
      <div class="sheet">
        <div class="sheet-handle"></div>
        <h2>New template</h2>
        <div class="field"><label>Template name</label><input type="text" id="f-name" placeholder="e.g. Standard Bridge"></div>
        <div class="field">
          <label>Elements (one per line)</label>
          <textarea id="f-elements" placeholder="North Abutment&#10;Pier 1&#10;Pier 2&#10;Deck Span 1&#10;Bearings&#10;Parapets" style="min-height:140px;"></textarea>
        </div>
        <button class="btn btn-primary btn-block" id="btn-save">Save template</button>
        <button class="btn btn-ghost btn-block" id="btn-cancel">Cancel</button>
      </div>
    </div>
  `);
  presentOverlay(sheet);
  sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.remove(); });
  sheet.querySelector('#btn-cancel').addEventListener('click', () => sheet.remove());
  sheet.querySelector('#btn-save').addEventListener('click', async () => {
    const name = sheet.querySelector('#f-name').value.trim();
    const lines = sheet.querySelector('#f-elements').value.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!name) { toast('Enter a template name'); return; }
    if (!lines.length) { toast('Add at least one element'); return; }
    await DB.saveTemplate(name, lines);
    sheet.remove();
    renderTemplates();
  });
}
