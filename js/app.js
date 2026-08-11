// app.js - routing + view rendering for the Site Inspection app

const appEl = document.getElementById('app');
const SEVERITY_LABELS = { 1: 'As New', 2: 'Minor', 3: 'Moderate', 4: 'Severe', 5: 'Failed' };
const EXTENT_LABELS = { A: 'None', B: 'Slight (≤5%)', C: 'Moderate (5–20%)', D: 'Wide (20–50%)', E: 'Extensive (>50%)' };
const PRIORITY_COLORS = { High: '#c81e1e', Medium: '#e0672e', Low: '#4f9d5c', Monitor: '#1e7dc8' };
const CURRENCY_SYMBOLS = { USD: '$', GBP: '£', EUR: '€' };
const INSPECTION_TYPES = ['Routine', 'Detailed', 'Special', 'Follow-up', 'GI Bridges'];
const APP_VERSION = '1.5';

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
document.addEventListener('pointerdown', (e) => {
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
    else if (p[0] === 'inspection' && p[1] && !p[2]) await renderInspection(p[1]);
    else if (p[0] === 'templates') await renderTemplates();
    else await renderHome();
  } catch (err) {
    console.error(err);
    appEl.innerHTML = `<div class="center-note">Something went wrong loading this screen.<br>${esc(err.message)}</div>`;
  }
}

// ---------- Reusable: photo action sheet (used by cover, element photos, finding photos) ----------
function openPhotoActionSheet(photoId, { onAnnotated, onRemoved } = {}) {
  const s = el(`
    <div class="sheet-backdrop">
      <div class="sheet">
        <div class="sheet-handle"></div>
        <h2>Photo</h2>
        <button class="btn btn-primary btn-block" id="btn-annotate">✏️ Edit — draw with Pencil</button>
        <button class="btn btn-danger btn-block" id="btn-remove" style="margin-top:10px;">Remove photo</button>
        <button class="btn btn-ghost btn-block" id="btn-cancel" style="margin-top:10px;">Cancel</button>
      </div>
    </div>
  `);
  presentOverlay(s);
  s.addEventListener('click', (e) => { if (e.target === s) s.remove(); });
  s.querySelector('#btn-cancel').addEventListener('click', () => s.remove());
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

function openPhotoSourceSheet({ onFiles, multiple = false }) {
  const s = el(`
    <div class="sheet-backdrop">
      <div class="sheet">
        <div class="sheet-handle"></div>
        <h2>Add photo</h2>
        <button class="btn btn-primary btn-block" id="btn-camera">📷 Take photo</button>
        <button class="btn btn-secondary btn-block" id="btn-library" style="margin-top:10px;">🖼 Choose from library</button>
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
        <button class="btn btn-ghost btn-block" id="btn-cancel" style="margin-top:16px;">Close</button>
      </div>
    </div>
  `);
  presentOverlay(sheet);
  sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.remove(); });
  sheet.querySelector('#btn-cancel').addEventListener('click', () => sheet.remove());

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
        <button class="btn btn-primary btn-block" id="btn-create-inspection">Create inspection</button>
        <button class="btn btn-ghost btn-block" id="btn-cancel">Cancel</button>
      </div>
    </div>
  `);
  presentOverlay(sheet);
  sheet.querySelector('#f-date').value = new Date().toISOString().slice(0, 10);

  const locationField = wireLocationField(sheet, null);

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
      subtitle: ''
    });
    sheet.remove();
    navigate(`#/inspection/${insp.id}`);
  });
}

// ---------- INSPECTION DETAIL ----------
async function renderInspection(inspectionId) {
  const insp = await DB.get('inspections', inspectionId);
  if (!insp) { navigate('#/'); return; }
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
        <div class="severity-picker" id="cover-style-picker">
          <button class="chip ${(!insp.coverStyle || insp.coverStyle === 'basic') ? 'selected' : ''}" data-style="basic" style="${(!insp.coverStyle || insp.coverStyle === 'basic') ? 'background:var(--ink);' : ''}">Basic</button>
          <button class="chip ${insp.coverStyle === 'archarray' ? 'selected' : ''}" data-style="archarray" style="${insp.coverStyle === 'archarray' ? 'background:var(--ink);' : ''}">Arch&amp;Array</button>
        </div>

        <div class="section-header" style="margin-top:22px;"><h2>Report content</h2></div>
        <button class="btn btn-secondary btn-block" id="btn-intro">📝 Introduction / Summary${insp.introduction ? ' — added' : ''}</button>
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
    await DB.updateInspection(inspectionId, {
      companyName: sheet.querySelector('#f-companyName').value.trim(),
      companyAddress: sheet.querySelector('#f-companyAddress').value.trim(),
      client: sheet.querySelector('#f-client').value.trim(),
      reference: sheet.querySelector('#f-reference').value.trim(),
      date: sheet.querySelector('#f-date').value,
      currency: currencyBtn ? currencyBtn.dataset.currency : 'USD',
      coverStyle: styleBtn ? styleBtn.dataset.style : 'basic'
    });
  }

  sheet.querySelector('#btn-intro').addEventListener('click', async () => {
    await persistFields();
    sheet.remove();
    openIntroSheet(inspectionId);
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

function openIntroSheet(inspectionId) {
  DB.get('inspections', inspectionId).then((insp) => {
    const sheet = el(`
      <div class="sheet-backdrop">
        <div class="sheet">
          <div class="sheet-handle"></div>
          <h2>Introduction / Summary</h2>
          <div class="field"><textarea id="f-intro" style="min-height:220px;" placeholder="Summarize the purpose and scope of this inspection…">${esc(insp.introduction)}</textarea></div>
          <button class="btn btn-primary btn-block" id="btn-save">Save</button>
          <button class="btn btn-ghost btn-block" id="btn-cancel">Cancel</button>
        </div>
      </div>
    `);
    presentOverlay(sheet);
    sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.remove(); });
    sheet.querySelector('#btn-cancel').addEventListener('click', () => sheet.remove());
    sheet.querySelector('#btn-save').addEventListener('click', async () => {
      await DB.updateInspection(inspectionId, { introduction: sheet.querySelector('#f-intro').value.trim() });
      sheet.remove();
      toast('Introduction saved');
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
            <textarea id="f-conclusion" style="min-height:180px;" placeholder="Overall condition assessment and conclusion…">${esc(insp.conclusion)}</textarea>
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
        conclusion: sheet.querySelector('#f-conclusion').value.trim(),
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

async function openAddElementSheet(inspectionId, sectionId) {
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
      order: existing.length,
      ...extra
    });
    sheet.remove();
    if (sectionId) renderSection(inspectionId, sectionId); else renderInspection(inspectionId);
  });

  sheet.querySelectorAll('[data-tpl]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await DB.applyTemplate(inspectionId, btn.dataset.tpl, sectionId || null);
      sheet.remove();
      toast('Template applied');
      if (sectionId) renderSection(inspectionId, sectionId); else renderInspection(inspectionId);
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
          onRemoved: async () => { elementPhotos = await DB.listPhotosForElement(elementId); renderElementPhotoGrid(); }
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
      <button class="text-btn" id="btn-import-pdf">Import PDF</button>
    </div>
    <div class="content" id="drawings-list">
    </div>
  `;
  document.getElementById('btn-back').addEventListener('click', () => navigate(`#/inspection/${inspectionId}`));
  document.getElementById('btn-import-pdf').addEventListener('click', () => openDrawingImportSheet(inspectionId, () => renderDrawings(inspectionId)));

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

async function openDrawingImportSheet(inspectionId, onImported) {
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
      await openPdfPagePickerSheet(inspectionId, pdfDoc, file.name, onImported);
    } catch (err) {
      console.error(err);
      toast('Could not load that PDF — check your internet connection and try again');
    }
  });
  fileInput.click();
}

async function openPdfPagePickerSheet(inspectionId, pdfDoc, filename, onImported) {
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
      await DB.addDrawing(inspectionId, blob, title);
    }
    toast('Import complete');
    onImported();
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
  const elMeta = elementSublineParts(elmt, isGiBridges).join('   ·   ');

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

        <div class="section-header"><h2>Priority</h2></div>
        <div class="severity-picker" id="priority-picker">
          ${['High', 'Medium', 'Low', 'Monitor'].map((p) => `
            <button class="chip ${finding.priority === p ? 'selected' : ''}" data-pri="${p}" style="${finding.priority === p ? `background:${PRIORITY_COLORS[p]};` : ''}">
              ${p}
            </button>
          `).join('')}
        </div>

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

        <div class="section-header"><h2>Notes</h2></div>
        <div class="field"><textarea id="f-notes" placeholder="Describe the finding…">${esc(finding.notes)}</textarea></div>

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
    await DB.updateFinding(findingId, {
      severity: sevBtn ? Number(sevBtn.dataset.sev) : null,
      extent: extBtn ? extBtn.dataset.ext : null,
      priority: priBtn ? priBtn.dataset.pri : null,
      worksRequired,
      worksDescription: worksRequired ? view.querySelector('#f-works-desc').value.trim() : '',
      costEstimate: worksRequired ? view.querySelector('#f-cost').value.trim() : '',
      notes: view.querySelector('#f-notes').value.trim()
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
          onRemoved: async () => { photos = await DB.listPhotosForFinding(findingId); renderPhotoGrid(); }
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
