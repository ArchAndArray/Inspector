// app.js - routing + view rendering for the Site Inspection app

const appEl = document.getElementById('app');
const SEVERITY_LABELS = {
  1: 'As New',
  2: 'Minor',
  3: 'Moderate',
  4: 'Severe',
  5: 'Failed'
};
const EXTENT_LABELS = {
  A: 'None',
  B: 'Slight (≤5%)',
  C: 'Moderate (5–20%)',
  D: 'Wide (20–50%)',
  E: 'Extensive (>50%)'
};

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
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2200);
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

// ---------- Routing ----------
function navigate(hash) {
  window.location.hash = hash;
}

window.addEventListener('hashchange', route);
window.addEventListener('DOMContentLoaded', route);

function parseHash() {
  const h = window.location.hash.replace(/^#\/?/, '');
  return h.split('/').filter(Boolean);
}

async function route() {
  clearObjectUrls();
  const parts = parseHash();
  try {
    if (parts.length === 0) {
      await renderHome();
    } else if (parts[0] === 'inspection' && parts[1] && !parts[2]) {
      await renderInspection(parts[1]);
    } else if (parts[0] === 'inspection' && parts[1] && parts[2] === 'element' && parts[3]) {
      await renderElement(parts[1], parts[3]);
    } else if (parts[0] === 'templates') {
      await renderTemplates();
    } else {
      await renderHome();
    }
  } catch (err) {
    console.error(err);
    appEl.innerHTML = `<div class="center-note">Something went wrong loading this screen.<br>${esc(err.message)}</div>`;
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
      <h1>Inspections</h1>
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

  appEl.querySelectorAll('.list-item').forEach((row) => {
    row.addEventListener('click', () => navigate(`#/inspection/${row.dataset.id}`));
  });
  document.getElementById('btn-new-inspection').addEventListener('click', openNewInspectionSheet);
  document.getElementById('btn-templates').addEventListener('click', () => navigate('#/templates'));
}

function openNewInspectionSheet() {
  const sheet = el(`
    <div class="sheet-backdrop">
      <div class="sheet">
        <div class="sheet-handle"></div>
        <h2>New inspection</h2>
        <div class="field">
          <label>Structure name / project</label>
          <input type="text" id="f-structureName" placeholder="e.g. Riverside Footbridge">
        </div>
        <div class="field">
          <label>Structure ID</label>
          <input type="text" id="f-structureId" placeholder="e.g. BR-0042">
        </div>
        <div class="field">
          <label>Inspection type</label>
          <select id="f-inspectionType">
            <option value="Routine">Routine</option>
            <option value="Detailed">Detailed</option>
            <option value="Special">Special</option>
            <option value="Follow-up">Follow-up</option>
          </select>
        </div>
        <div class="row-2">
          <div class="field">
            <label>Date</label>
            <input type="date" id="f-date">
          </div>
          <div class="field">
            <label>Inspector</label>
            <input type="text" id="f-inspector" placeholder="Name">
          </div>
        </div>
        <div class="field">
          <label>Weather</label>
          <input type="text" id="f-weather" placeholder="e.g. Overcast, 14°C">
        </div>
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

  sheet.addEventListener('click', (e) => {
    if (e.target === sheet) sheet.remove();
  });
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
  const elements = await DB.listElements(inspectionId);
  const summary = await DB.getInspectionSummary(inspectionId);
  const coverPhoto = await DB.getCoverPhoto(inspectionId);

  const summaryMap = {};
  summary.forEach((s) => { summaryMap[s.element.id] = s; });

  const elementRows = elements.map((elmt) => {
    const s = summaryMap[elmt.id];
    const badge = s.worstSeverity
      ? `<span class="badge badge-sev-${s.worstSeverity}">S${s.worstSeverity}</span> <span class="badge badge-extent">${s.worstExtent || '—'}</span>`
      : `<span class="badge badge-none">No findings</span>`;
    return `
      <div class="list-item" data-id="${elmt.id}">
        <div class="meta">
          <h3>${esc(elmt.name)}</h3>
          <p>${s.findingCount} finding${s.findingCount === 1 ? '' : 's'}</p>
        </div>
        ${badge}
        <span class="chevron">›</span>
      </div>
    `;
  }).join('');

  appEl.innerHTML = `
    <div class="topbar">
      <button class="icon-btn" id="btn-back">‹</button>
      <div style="flex:1; min-width:0;">
        <h1 style="font-size:17px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${esc(insp.structureName)}</h1>
        <span class="sub">${esc(insp.inspectionType || 'Inspection')} · ${fmtDate(insp.date)}</span>
      </div>
      <button class="text-btn" id="btn-export">Export</button>
    </div>
    <div class="content">
      <div class="card" id="header-card">
        <div class="link-row" style="margin-bottom:8px;">
          <strong style="font-size:15px;">Inspection details</strong>
          <button class="small-btn" id="btn-edit-header">Edit</button>
        </div>
        <p class="muted" style="margin:4px 0; font-size:14px;">Structure ID: ${esc(insp.structureId || '—')}</p>
        <p class="muted" style="margin:4px 0; font-size:14px;">Inspector: ${esc(insp.inspector || '—')}</p>
        <p class="muted" style="margin:4px 0; font-size:14px;">Weather: ${esc(insp.weather || '—')}</p>
        <p class="muted" style="margin:4px 0; font-size:14px;">Location: ${esc(insp.location && insp.location.manual || '—')}</p>
      </div>

      <div class="card" id="cover-card">
        <div class="link-row" style="margin-bottom:10px;">
          <strong style="font-size:15px;">Cover photo</strong>
          <button class="small-btn" id="btn-cover-photo">${coverPhoto ? 'Replace' : 'Add photo'}</button>
        </div>
        ${coverPhoto ? `<div class="photo-thumb" style="width:120px; height:120px;"><img src="${blobUrl(coverPhoto.originalBlob)}"></div>` : `<p class="muted" style="font-size:13px; margin:0;">Used on the report cover page.</p>`}
        <input type="file" id="cover-file-input" accept="image/*" capture="environment" style="display:none;">
      </div>

      <div class="section-header">
        <h2>Elements</h2>
        <button class="small-btn" id="btn-add-element">＋ Add</button>
      </div>
      ${elements.length ? elementRows : `
        <div class="empty-state">
          <div class="glyph">▦</div>
          <h3>No elements yet</h3>
          <p>Add structural elements to begin logging findings.</p>
        </div>
      `}
    </div>
    <button class="fab" id="btn-add-element-fab">＋</button>
  `;

  document.getElementById('btn-back').addEventListener('click', () => navigate('#/'));
  document.getElementById('btn-export').addEventListener('click', () => exportInspectionPDF(inspectionId));
  document.getElementById('btn-edit-header').addEventListener('click', () => openEditHeaderSheet(insp));
  document.getElementById('btn-add-element').addEventListener('click', () => openAddElementSheet(inspectionId));
  document.getElementById('btn-add-element-fab').addEventListener('click', () => openAddElementSheet(inspectionId));

  document.getElementById('btn-cover-photo').addEventListener('click', () => {
    document.getElementById('cover-file-input').click();
  });
  document.getElementById('cover-file-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    await DB.setCoverPhoto(inspectionId, file);
    toast('Cover photo saved');
    renderInspection(inspectionId);
  });

  appEl.querySelectorAll('.list-item[data-id]').forEach((row) => {
    row.addEventListener('click', () => navigate(`#/inspection/${inspectionId}/element/${row.dataset.id}`));
  });
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
          <select id="f-inspectionType">
            ${['Routine', 'Detailed', 'Special', 'Follow-up'].map((t) => `<option value="${t}" ${insp.inspectionType === t ? 'selected' : ''}>${t}</option>`).join('')}
          </select>
        </div>
        <div class="row-2">
          <div class="field"><label>Date</label><input type="date" id="f-date" value="${(insp.date || '').slice(0, 10)}"></div>
          <div class="field"><label>Inspector</label><input type="text" id="f-inspector" value="${esc(insp.inspector)}"></div>
        </div>
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
    if (!confirm('Delete this inspection and all its elements, findings, and photos? This cannot be undone.')) return;
    await DB.deleteInspectionCascade(insp.id);
    sheet.remove();
    navigate('#/');
  });
}

async function openAddElementSheet(inspectionId) {
  const templates = await DB.listTemplates();
  const sheet = el(`
    <div class="sheet-backdrop">
      <div class="sheet">
        <div class="sheet-handle"></div>
        <h2>Add element</h2>
        <div class="field">
          <label>Element name</label>
          <div class="link-row">
            <input type="text" id="f-elname" placeholder="e.g. Pier 2, Deck Span 3" style="flex:1; margin-right:8px;">
            <button class="btn btn-primary" id="btn-add-single">Add</button>
          </div>
        </div>
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
    const name = sheet.querySelector('#f-elname').value.trim();
    if (!name) { toast('Enter an element name'); return; }
    const existing = await DB.listElements(inspectionId);
    await DB.createElement(inspectionId, { name, order: existing.length });
    sheet.remove();
    renderInspection(inspectionId);
  });

  sheet.querySelectorAll('[data-tpl]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await DB.applyTemplate(inspectionId, btn.dataset.tpl);
      sheet.remove();
      toast('Template applied');
      renderInspection(inspectionId);
    });
  });
}

// ---------- ELEMENT DETAIL (findings) ----------
async function renderElement(inspectionId, elementId) {
  const elmt = await DB.get('elements', elementId);
  if (!elmt) { navigate(`#/inspection/${inspectionId}`); return; }
  const findings = await DB.listFindings(elementId);

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
          </div>
          <p style="margin:0 0 8px; font-size:14px;">${esc(f.notes) || '<span class="muted">No notes</span>'}</p>
          ${photos.length ? `<div style="display:flex; gap:6px;">${photoThumbs}${photos.length > 4 ? `<div class="muted" style="align-self:center; font-size:12px;">+${photos.length - 4}</div>` : ''}</div>` : ''}
        </div>
        <span class="chevron">›</span>
      </div>
    `);
  }

  appEl.innerHTML = `
    <div class="topbar">
      <button class="icon-btn" id="btn-back">‹</button>
      <div style="flex:1; min-width:0;">
        <h1 style="font-size:17px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${esc(elmt.name)}</h1>
        <span class="sub">${findings.length} finding${findings.length === 1 ? '' : 's'}</span>
      </div>
      <button class="text-btn" id="btn-rename">Rename</button>
    </div>
    <div class="content">
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

  document.getElementById('btn-back').addEventListener('click', () => navigate(`#/inspection/${inspectionId}`));
  document.getElementById('btn-add-finding').addEventListener('click', () => openFindingEditor(inspectionId, elementId, null));
  document.getElementById('btn-rename').addEventListener('click', () => openRenameElementSheet(inspectionId, elmt));

  appEl.querySelectorAll('.list-item[data-id]').forEach((row) => {
    row.addEventListener('click', () => openFindingEditor(inspectionId, elementId, row.dataset.id));
  });
}

function openRenameElementSheet(inspectionId, elmt) {
  const sheet = el(`
    <div class="sheet-backdrop">
      <div class="sheet">
        <div class="sheet-handle"></div>
        <h2>Edit element</h2>
        <div class="field"><label>Name</label><input type="text" id="f-name" value="${esc(elmt.name)}"></div>
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
    await DB.put('elements', { ...elmt, name });
    sheet.remove();
    renderElement(inspectionId, elmt.id);
  });
  sheet.querySelector('#btn-delete').addEventListener('click', async () => {
    if (!confirm('Delete this element and all its findings and photos?')) return;
    await DB.deleteElementCascade(elmt.id);
    sheet.remove();
    navigate(`#/inspection/${inspectionId}`);
  });
}

// ---------- FINDING EDITOR ----------
async function openFindingEditor(inspectionId, elementId, findingId) {
  let finding = findingId ? await DB.get('findings', findingId) : null;
  if (!finding) {
    finding = await DB.createFinding(elementId, {});
    findingId = finding.id;
  }
  let photos = await DB.listPhotosForFinding(findingId);

  const view = el(`
    <div class="fullscreen">
      <div class="topbar">
        <button class="icon-btn" id="btn-close">✕</button>
        <h1 style="font-size:17px;">Finding</h1>
        <button class="text-btn" id="btn-delete-finding" style="color:#ff9d9d;">Delete</button>
      </div>
      <div class="content" style="overflow-y:auto;">
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

        <div class="section-header"><h2>Notes</h2></div>
        <div class="field">
          <textarea id="f-notes" placeholder="Describe the finding…">${esc(finding.notes)}</textarea>
        </div>

        <div class="section-header"><h2>Photos</h2></div>
        <div class="photo-grid" id="photo-grid"></div>
        <input type="file" id="finding-file-input" accept="image/*" capture="environment" style="display:none;">
        <input type="file" id="finding-file-input-lib" accept="image/*" multiple style="display:none;">
      </div>
    </div>
  `);
  document.body.appendChild(view);

  function renderPhotoGrid() {
    const grid = view.querySelector('#photo-grid');
    grid.innerHTML = photos.map((p) => `
      <div class="photo-thumb" data-pid="${p.id}">
        <img src="${blobUrl(p.annotatedBlob || p.originalBlob)}">
        ${p.annotatedBlob ? '<div class="annotated-dot"></div>' : ''}
      </div>
    `).join('') + `<div class="photo-add" id="btn-add-photo">📷</div>`;

    grid.querySelectorAll('.photo-thumb').forEach((thumb) => {
      thumb.addEventListener('click', () => openPhotoActionSheet(thumb.dataset.pid));
    });
    grid.querySelector('#btn-add-photo').addEventListener('click', openPhotoSourceSheet);
  }
  renderPhotoGrid();

  function openPhotoSourceSheet() {
    const s = el(`
      <div class="sheet-backdrop">
        <div class="sheet">
          <div class="sheet-handle"></div>
          <h2>Add photo</h2>
          <button class="btn btn-primary btn-block" id="btn-camera">📷 Take photo</button>
          <button class="btn btn-secondary btn-block" id="btn-library" style="margin-top:10px;">🖼 Choose from library</button>
          <button class="btn btn-ghost btn-block" id="btn-cancel" style="margin-top:10px;">Cancel</button>
        </div>
      </div>
    `);
    document.body.appendChild(s);
    s.addEventListener('click', (e) => { if (e.target === s) s.remove(); });
    s.querySelector('#btn-cancel').addEventListener('click', () => s.remove());
    s.querySelector('#btn-camera').addEventListener('click', () => { s.remove(); view.querySelector('#finding-file-input').click(); });
    s.querySelector('#btn-library').addEventListener('click', () => { s.remove(); view.querySelector('#finding-file-input-lib').click(); });
  }

  async function handleFiles(fileList) {
    const files = Array.from(fileList);
    for (const file of files) {
      const p = await DB.addPhoto({ findingId, originalBlob: file, order: photos.length });
      photos.push(p);
    }
    renderPhotoGrid();
  }
  view.querySelector('#finding-file-input').addEventListener('change', (e) => handleFiles(e.target.files));
  view.querySelector('#finding-file-input-lib').addEventListener('change', (e) => handleFiles(e.target.files));

  function openPhotoActionSheet(photoId) {
    const s = el(`
      <div class="sheet-backdrop">
        <div class="sheet">
          <div class="sheet-handle"></div>
          <h2>Photo</h2>
          <button class="btn btn-primary btn-block" id="btn-annotate">✏️ Annotate with Pencil</button>
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
      await openAnnotator(photoId, () => {
        DB.listPhotosForFinding(findingId).then((p) => { photos = p; renderPhotoGrid(); });
      });
    });
    s.querySelector('#btn-remove').addEventListener('click', async () => {
      await DB.delete('photos', photoId);
      photos = photos.filter((p) => p.id !== photoId);
      s.remove();
      renderPhotoGrid();
    });
  }

  async function saveAndClose() {
    const sevBtn = view.querySelector('.chip.selected[data-sev]');
    const extBtn = view.querySelector('.chip.selected[data-ext]');
    await DB.updateFinding(findingId, {
      severity: sevBtn ? Number(sevBtn.dataset.sev) : null,
      extent: extBtn ? extBtn.dataset.ext : null,
      notes: view.querySelector('#f-notes').value.trim()
    });
    view.remove();
    renderElement(inspectionId, elementId);
  }

  view.querySelectorAll('#severity-picker .chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const wasSelected = chip.classList.contains('selected');
      view.querySelectorAll('#severity-picker .chip').forEach((c) => { c.classList.remove('selected'); c.style.background = ''; });
      if (!wasSelected) {
        chip.classList.add('selected');
        chip.style.background = `var(--sev-${chip.dataset.sev})`;
      }
    });
  });
  view.querySelectorAll('#extent-picker .chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const wasSelected = chip.classList.contains('selected');
      view.querySelectorAll('#extent-picker .chip').forEach((c) => { c.classList.remove('selected'); c.style.background = ''; });
      if (!wasSelected) {
        chip.classList.add('selected');
        chip.style.background = 'var(--ink)';
      }
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
      <p class="muted" style="font-size:13px; margin-top:0;">Templates let you quickly populate a standard set of elements (e.g. "Standard Bridge") when starting a new inspection.</p>
      ${templates.length ? templates.map((t) => `
        <div class="list-item" data-id="${t.id}">
          <div class="meta">
            <h3>${esc(t.name)}</h3>
            <p>${t.elements.map((e) => esc(e.name)).join(', ')}</p>
          </div>
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
