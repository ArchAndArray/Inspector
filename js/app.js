// app.js - routing + view rendering for the Site Inspection app

const appEl = document.getElementById('app');
const SEVERITY_LABELS = { 1: 'As New', 2: 'Minor', 3: 'Moderate', 4: 'Severe', 5: 'Failed' };
const EXTENT_LABELS = { A: 'None', B: 'Slight (≤5%)', C: 'Moderate (5–20%)', D: 'Wide (20–50%)', E: 'Extensive (>50%)' };
const PRIORITY_COLORS = { High: '#c81e1e', Medium: '#e0672e', Low: '#4f9d5c', Monitor: '#1e7dc8' };
const APP_VERSION = '0.4';

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
  document.body.appendChild(s);
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
  document.body.appendChild(s);
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
            <option value="Routine">Routine</option>
            <option value="Detailed">Detailed</option>
            <option value="Special">Special</option>
            <option value="Follow-up">Follow-up</option>
          </select>
        </div>
        <div class="field"><label>Date</label><input type="date" id="f-date"></div>
        <div class="field"><label>Inspector</label><input type="text" id="f-inspector" placeholder="Name"></div>
        <div class="field"><label>Weather</label><input type="text" id="f-weather" placeholder="e.g. Overcast, 14°C"></div>
        <div class="field">
          <label>Location</label>
          <div class="link-row">
            <input type="text" id="f-location" placeholder="Tap to capture GPS or enter manually" style="flex:1; margin-right:8px;">
            <button class="small-btn" id="btn-gps">📍 GPS</button>
          </div>
        </div>
        <button class="btn btn-primary btn-block" id="btn-create-inspection">Create inspection</button>
        <button class="btn btn-ghost btn-block" id="btn-cancel">Cancel</button>
      </div>
    </div>
  `);
  document.body.appendChild(sheet);
  sheet.querySelector('#f-date').value = new Date().toISOString().slice(0, 10);

  let gpsCoords = null;
  sheet.querySelector('#btn-gps').addEventListener('click', () => {
    if (!navigator.geolocation) { toast('GPS not available'); return; }
    toast('Locating…');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        gpsCoords = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        sheet.querySelector('#f-location').value = `${gpsCoords.lat.toFixed(6)}, ${gpsCoords.lng.toFixed(6)}`;
        toast('Location captured');
      },
      () => toast('Could not get location'),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  });

  sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.remove(); });
  sheet.querySelector('#btn-cancel').addEventListener('click', () => sheet.remove());
  sheet.querySelector('#btn-create-inspection').addEventListener('click', async () => {
    const structureName = sheet.querySelector('#f-structureName').value.trim();
    if (!structureName) { toast('Enter a structure name'); return; }
    const insp = await DB.createInspection({
      structureName,
      structureId: sheet.querySelector('#f-structureId').value.trim(),
      inspectionType: sheet.querySelector('#f-inspectionType').value,
      date: sheet.querySelector('#f-date').value,
      inspector: sheet.querySelector('#f-inspector').value.trim(),
      weather: sheet.querySelector('#f-weather').value.trim(),
      location: { ...(gpsCoords || {}), manual: sheet.querySelector('#f-location').value.trim() },
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

  async function elementRowHtml(elmt) {
    const s = await DB.getElementConditionSummary(elmt.id);
    const badge = s.worstSeverity
      ? `<span class="badge badge-sev-${s.worstSeverity}">S${s.worstSeverity}</span> <span class="badge badge-extent">${s.worstExtent || '—'}</span>`
      : `<span class="badge badge-none">No findings</span>`;
    const subline = [elmt.materialType, elmt.location].filter(Boolean).join(' · ') || `${s.findingCount} finding${s.findingCount === 1 ? '' : 's'}`;
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
      <button class="text-btn" id="btn-export">Export</button>
    </div>
    <div class="content">
      <div class="card">
        <div class="link-row" style="margin-bottom:8px;"><strong style="font-size:15px;">Inspection details</strong><button class="small-btn" id="btn-edit-header">Edit</button></div>
        <p class="muted" style="margin:4px 0; font-size:14px;">Structure ID: ${esc(insp.structureId || '—')}</p>
        <p class="muted" style="margin:4px 0; font-size:14px;">Inspector: ${esc(insp.inspector || '—')}</p>
        <p class="muted" style="margin:4px 0; font-size:14px;">Weather: ${esc(insp.weather || '—')}</p>
        <p class="muted" style="margin:4px 0; font-size:14px;">Location: ${esc(insp.location && insp.location.manual || '—')}</p>
      </div>

      <div class="card">
        <div class="link-row" style="margin-bottom:10px;"><strong style="font-size:15px;">Cover photo</strong>${!coverPhoto ? '<button class="small-btn" id="btn-add-cover">＋ Add</button>' : ''}</div>
        ${coverPhoto
          ? `<div class="photo-thumb" id="cover-thumb" style="width:120px; height:120px;"><img src="${blobUrl(coverPhoto.originalBlob)}">${coverPhoto.annotatedBlob ? '<div class="annotated-dot"></div>' : ''}</div>`
          : `<p class="muted" style="font-size:13px; margin:0;">Used on the report cover page.</p>`}
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
  document.getElementById('btn-export').addEventListener('click', () => exportInspectionPDF(inspectionId));
  document.getElementById('btn-report-info').addEventListener('click', () => openReportInfoSheet(inspectionId));
  document.getElementById('btn-edit-header').addEventListener('click', () => openEditHeaderSheet(insp));
  document.getElementById('btn-add-section').addEventListener('click', () => openAddSectionSheet(inspectionId));
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
          <select id="f-inspectionType">${['Routine', 'Detailed', 'Special', 'Follow-up'].map((t) => `<option value="${t}" ${insp.inspectionType === t ? 'selected' : ''}>${t}</option>`).join('')}</select>
        </div>
        <div class="field"><label>Date</label><input type="date" id="f-date" value="${(insp.date || '').slice(0, 10)}"></div>
        <div class="field"><label>Inspector</label><input type="text" id="f-inspector" value="${esc(insp.inspector)}"></div>
        <div class="field"><label>Weather</label><input type="text" id="f-weather" value="${esc(insp.weather)}"></div>
        <div class="field"><label>Location</label><input type="text" id="f-location" value="${esc(insp.location && insp.location.manual)}"></div>
        <div class="field"><label>Report title</label><input type="text" id="f-title" value="${esc(insp.title)}"></div>
        <div class="field"><label>Report subtitle</label><input type="text" id="f-subtitle" value="${esc(insp.subtitle)}"></div>
        <div class="field"><label>General notes</label><textarea id="f-notes">${esc(insp.notes)}</textarea></div>
        <button class="btn btn-primary btn-block" id="btn-save">Save</button>
        <button class="btn btn-danger btn-block" id="btn-delete" style="margin-top:8px;">Delete inspection</button>
        <button class="btn btn-ghost btn-block" id="btn-cancel">Cancel</button>
      </div>
    </div>
  `);
  document.body.appendChild(sheet);
  sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.remove(); });
  sheet.querySelector('#btn-cancel').addEventListener('click', () => sheet.remove());
  sheet.querySelector('#btn-save').addEventListener('click', async () => {
    await DB.updateInspection(insp.id, {
      structureName: sheet.querySelector('#f-structureName').value.trim(),
      structureId: sheet.querySelector('#f-structureId').value.trim(),
      inspectionType: sheet.querySelector('#f-inspectionType').value,
      date: sheet.querySelector('#f-date').value,
      inspector: sheet.querySelector('#f-inspector').value.trim(),
      weather: sheet.querySelector('#f-weather').value.trim(),
      location: { ...(insp.location || {}), manual: sheet.querySelector('#f-location').value.trim() },
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
  let logos = await DB.listLogos(inspectionId);

  const sheet = el(`
    <div class="sheet-backdrop">
      <div class="sheet">
        <div class="sheet-handle"></div>
        <h2>Report info</h2>
        <p class="muted" style="font-size:13px; margin-top:-8px;">Appears on the report cover page.</p>
        <div class="field"><label>Client</label><input type="text" id="f-client" value="${esc(insp.client)}" placeholder="Client or organization name"></div>
        <div class="field"><label>Reference / project no.</label><input type="text" id="f-reference" value="${esc(insp.reference)}" placeholder="e.g. PRJ-2026-014"></div>
        <div class="field"><label>Report date</label><input type="date" id="f-date" value="${(insp.date || '').slice(0, 10)}"></div>
        <div class="field">
          <label>Logos</label>
          <div class="photo-grid" id="logo-grid"></div>
          <input type="file" id="logo-file-input" accept="image/*" multiple style="display:none;">
          <p class="hint">Add one or more logos (e.g. client + your company). They'll appear at the top of the cover page.</p>
        </div>

        <div class="section-header" style="margin-top:24px;"><h2>Report content</h2></div>
        <button class="btn btn-secondary btn-block" id="btn-intro">📝 Introduction / Summary${insp.introduction ? ' — added' : ''}</button>
        <button class="btn btn-secondary btn-block" id="btn-conclusion" style="margin-top:10px;">📋 Conclusion &amp; Recommendations${(insp.conclusion || (insp.recommendations && insp.recommendations.length)) ? ' — added' : ''}</button>

        <button class="btn btn-primary btn-block" id="btn-save" style="margin-top:22px;">Save</button>
        <button class="btn btn-ghost btn-block" id="btn-cancel">Cancel</button>
      </div>
    </div>
  `);
  document.body.appendChild(sheet);

  sheet.querySelector('#btn-intro').addEventListener('click', () => openIntroSheet(inspectionId));
  sheet.querySelector('#btn-conclusion').addEventListener('click', () => openConclusionSheet(inspectionId));

  function renderLogoGrid() {
    const grid = sheet.querySelector('#logo-grid');
    grid.innerHTML = logos.map((p) => `
      <div class="photo-thumb" data-lid="${p.id}" style="position:relative;">
        <img src="${blobUrl(p.originalBlob)}">
        <button class="icon-btn" data-remove-logo="${p.id}" style="position:absolute; top:4px; right:4px; width:24px; height:24px; background:rgba(28,31,38,0.75); font-size:13px;">✕</button>
      </div>
    `).join('') + `<div class="photo-add" id="btn-add-logo">＋</div>`;
    grid.querySelector('#btn-add-logo').addEventListener('click', () => sheet.querySelector('#logo-file-input').click());
    grid.querySelectorAll('[data-remove-logo]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await DB.delete('photos', btn.dataset.removeLogo);
        logos = logos.filter((l) => l.id !== btn.dataset.removeLogo);
        renderLogoGrid();
      });
    });
  }
  renderLogoGrid();

  sheet.querySelector('#logo-file-input').addEventListener('change', async (e) => {
    const files = Array.from(e.target.files);
    for (const file of files) {
      const normalized = await normalizeImageFile(file, 1200);
      const p = await DB.addLogo(inspectionId, normalized);
      logos.push(p);
    }
    renderLogoGrid();
  });

  sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.remove(); });
  sheet.querySelector('#btn-cancel').addEventListener('click', () => sheet.remove());
  sheet.querySelector('#btn-save').addEventListener('click', async () => {
    await DB.updateInspection(inspectionId, {
      client: sheet.querySelector('#f-client').value.trim(),
      reference: sheet.querySelector('#f-reference').value.trim(),
      date: sheet.querySelector('#f-date').value
    });
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
    document.body.appendChild(sheet);
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
    document.body.appendChild(sheet);

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
  document.body.appendChild(sheet);
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

  const rows = [];
  for (const elmt of elements) {
    const s = await DB.getElementConditionSummary(elmt.id);
    const badge = s.worstSeverity
      ? `<span class="badge badge-sev-${s.worstSeverity}">S${s.worstSeverity}</span> <span class="badge badge-extent">${s.worstExtent || '—'}</span>`
      : `<span class="badge badge-none">No findings</span>`;
    const subline = [elmt.materialType, elmt.location].filter(Boolean).join(' · ') || `${s.findingCount} finding${s.findingCount === 1 ? '' : 's'}`;
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
  document.body.appendChild(sheet);
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
async function openAddElementSheet(inspectionId, sectionId) {
  const templates = await DB.listTemplates();
  const sheet = el(`
    <div class="sheet-backdrop">
      <div class="sheet">
        <div class="sheet-handle"></div>
        <h2>Add element</h2>
        <div class="field"><label>Element name</label><input type="text" id="f-name" placeholder="e.g. Pier 2, Bearing SE"></div>
        <div class="row-2">
          <div class="field"><label>Material type</label><input type="text" id="f-material" placeholder="e.g. Reinforced concrete"></div>
          <div class="field"><label>Location</label><input type="text" id="f-location" placeholder="e.g. Chainage 12+400"></div>
        </div>
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
  document.body.appendChild(sheet);
  sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.remove(); });
  sheet.querySelector('#btn-cancel').addEventListener('click', () => sheet.remove());

  sheet.querySelector('#btn-add-single').addEventListener('click', async () => {
    const name = sheet.querySelector('#f-name').value.trim();
    if (!name) { toast('Enter an element name'); return; }
    const existing = await DB.listElements(inspectionId);
    const elmt = await DB.createElement(inspectionId, {
      name,
      sectionId: sectionId || null,
      materialType: sheet.querySelector('#f-material').value.trim(),
      location: sheet.querySelector('#f-location').value.trim(),
      order: existing.length
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

  const subline = [elmt.materialType, elmt.location].filter(Boolean).join(' · ');

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

function openEditElementSheet(inspectionId, elmt, backHash) {
  const sheet = el(`
    <div class="sheet-backdrop">
      <div class="sheet">
        <div class="sheet-handle"></div>
        <h2>Edit element</h2>
        <div class="field"><label>Name</label><input type="text" id="f-name" value="${esc(elmt.name)}"></div>
        <div class="row-2">
          <div class="field"><label>Material type</label><input type="text" id="f-material" value="${esc(elmt.materialType)}"></div>
          <div class="field"><label>Location</label><input type="text" id="f-location" value="${esc(elmt.location)}"></div>
        </div>
        <button class="btn btn-primary btn-block" id="btn-save">Save</button>
        <button class="btn btn-danger btn-block" id="btn-delete" style="margin-top:8px;">Delete element</button>
        <button class="btn btn-ghost btn-block" id="btn-cancel">Cancel</button>
      </div>
    </div>
  `);
  document.body.appendChild(sheet);
  sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.remove(); });
  sheet.querySelector('#btn-cancel').addEventListener('click', () => sheet.remove());
  sheet.querySelector('#btn-save').addEventListener('click', async () => {
    const name = sheet.querySelector('#f-name').value.trim();
    if (!name) { toast('Enter a name'); return; }
    await DB.updateElement(elmt.id, {
      name,
      materialType: sheet.querySelector('#f-material').value.trim(),
      location: sheet.querySelector('#f-location').value.trim()
    });
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

// ---------- FINDING EDITOR ----------
async function openFindingEditor(inspectionId, elementId, findingId) {
  const elmt = await DB.get('elements', elementId);
  let finding = findingId ? await DB.get('findings', findingId) : null;
  if (!finding) {
    finding = await DB.createFinding(elementId, {});
    findingId = finding.id;
  }
  let photos = await DB.listPhotosForFinding(findingId);
  const elMeta = [elmt.materialType, elmt.location].filter(Boolean).join('   ·   ');

  const view = el(`
    <div class="fullscreen">
      <div class="topbar">
        <button class="icon-btn" id="btn-close">✕</button>
        <h1 style="font-size:17px;">Finding</h1>
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
          <div class="field"><label>Cost estimate</label><input type="text" id="f-cost" value="${esc(finding.costEstimate)}" placeholder="e.g. $12,500"></div>
        </div>

        <div class="section-header"><h2>Notes</h2></div>
        <div class="field"><textarea id="f-notes" placeholder="Describe the finding…">${esc(finding.notes)}</textarea></div>

        <div class="section-header"><h2>Photos</h2></div>
        <div class="photo-grid" id="photo-grid"></div>
      </div>
    </div>
  `);
  document.body.appendChild(view);

  view.querySelector('#f-works-required').addEventListener('change', (e) => {
    view.querySelector('#works-detail').classList.toggle('hidden', !e.target.checked);
  });

  view.querySelectorAll('#priority-picker .chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const wasSelected = chip.classList.contains('selected');
      view.querySelectorAll('#priority-picker .chip').forEach((c) => { c.classList.remove('selected'); c.style.background = ''; });
      if (!wasSelected) { chip.classList.add('selected'); chip.style.background = PRIORITY_COLORS[chip.dataset.pri]; }
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

  async function saveAndClose() {
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
    view.remove();
    renderElement(inspectionId, elementId);
  }

  view.querySelectorAll('#severity-picker .chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const wasSelected = chip.classList.contains('selected');
      view.querySelectorAll('#severity-picker .chip').forEach((c) => { c.classList.remove('selected'); c.style.background = ''; });
      if (!wasSelected) { chip.classList.add('selected'); chip.style.background = `var(--sev-${chip.dataset.sev})`; }
    });
  });
  view.querySelectorAll('#extent-picker .chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const wasSelected = chip.classList.contains('selected');
      view.querySelectorAll('#extent-picker .chip').forEach((c) => { c.classList.remove('selected'); c.style.background = ''; });
      if (!wasSelected) { chip.classList.add('selected'); chip.style.background = 'var(--ink)'; }
    });
  });

  view.querySelector('#btn-close').addEventListener('click', saveAndClose);
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
  document.body.appendChild(sheet);
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
