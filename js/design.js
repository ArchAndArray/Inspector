// design.js — the Design module: structural design calculations, starting with retaining
// walls (mass and cantilever). Other component types (soil nails/rock anchors, concrete
// slab, composite deck, assessment) are deliberately not built yet — per an explicit
// "for now just retaining wall" scope decision — but the item-type list below is written
// to be extended, not reworked, when they arrive.
//
// Structure: Project -> Item -> Case, one level deeper than PM's Project -> Task, because a
// single item (one retaining wall) legitimately needs several named, saved, comparable input
// sets while iterating toward a design that passes — per an explicit decision that a Case is
// its own record, not something overwritten in place every time an input changes.
//
// calc.js and svg.js are pure, DOM-free engines (calc.js mirrors a validated Excel workbook,
// referenced against PD 6694-1's own worked examples; svg.js draws the matching cross-section)
// — this file's job is only to collect inputs, call them, and render/persist/export the
// result. No design engineering logic belongs here; it belongs in calc.js.
//
// A Case stores only its raw inputs (inp/geo/rebar) — never computed results, which are
// always re-derived fresh at view/export time, same principle used throughout this app
// (PM's rollups, BCI/MDCI, etc).

const DESIGN_ITEM_TYPES = {
  retainingWall: { label: 'Retaining Wall', icon: '🧱' }
  // Future: soilNails, concreteSlab, compositeDeck, assessment — added here when built.
};

// Sensible starting values for a brand-new case — not a recommendation, just a reasonable
// point to start adjusting from, same spirit as every other default in this app.
function designDefaultInputs(wallType) {
  const inp = {
    phi: 30, phif: 30, cf: 0, delta: 20, deltaW: 20, beta: 0,
    gamma: 19, gammac: 24, gammaf: 19, q: 10, Htop: 0, Vtop: 0, PPfac: 0.5,
    cover: 50, fck: 32, fyk: 500, applyModelFactor: false
  };
  if (wallType === 'mass') {
    return { inp, geo: { H: 3, b1: 0.6, B: 2.6, Df: 0.6 } };
  }
  return {
    inp,
    geo: { hs: 2.5, ts: 0.4, tb: 0.5, Lt: 0.8, Lh: 1.8, Df: 0.6 },
    rebar: {
      stem: { dia: 20, spacing: 150 },
      heel: { dia: 20, spacing: 150 },
      toe: { dia: 20, spacing: 150 }
    }
  };
}

// ---------------------------------------------------------------------------
// Project list
// ---------------------------------------------------------------------------
async function renderDesign() {
  const projects = await DB.listDesignProjects();
  const rows = projects.map((p) => `
    <div class="list-item" data-id="${p.id}">
      <div class="meta">
        <h3>${esc(p.name)}</h3>
        <p>${esc(p.reference || 'No reference')}${p.client ? ' · ' + esc(p.client) : ''}</p>
      </div>
      <span class="chevron">›</span>
    </div>
  `).join('');

  appEl.innerHTML = `
    <div class="topbar">
      <button class="icon-btn" id="btn-design-back">‹</button>
      <div style="flex:1; min-width:0;">
        <h1>Design</h1>
        <span class="sub">Structural design calculations</span>
      </div>
    </div>
    <div class="content">
      ${projects.length ? rows : `
        <div class="empty-state">
          <div class="glyph">＋</div>
          <h3>No projects yet</h3>
          <p>Create a project to start a retaining wall design.</p>
        </div>
      `}
    </div>
    <button class="fab" id="btn-new-design-project">＋</button>
  `;

  document.getElementById('btn-design-back').addEventListener('click', () => navigate('#/'));
  document.getElementById('btn-new-design-project').addEventListener('click', () => openNewDesignProjectSheet(renderDesign));
  appEl.querySelectorAll('.list-item').forEach((row) => {
    row.addEventListener('click', () => renderDesignProject(row.dataset.id));
  });
}

function openNewDesignProjectSheet(onDone) {
  const sheet = el(`
    <div class="sheet-backdrop">
      <div class="sheet">
        <div class="sheet-handle"></div>
        <h2>New Design Project</h2>
        <div class="field"><label>Name</label><input type="text" id="f-dp-name" placeholder="e.g. A487 Retaining Works"></div>
        <div class="field"><label>Reference</label><input type="text" id="f-dp-reference" placeholder="Project/scheme reference"></div>
        <div class="field"><label>Client</label><input type="text" id="f-dp-client" placeholder="Client / authority"></div>
        <button class="btn btn-primary btn-block" id="btn-save">Create</button>
        <button class="btn btn-ghost btn-block" id="btn-cancel">Cancel</button>
      </div>
    </div>
  `);
  presentOverlay(sheet);
  sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.remove(); });
  sheet.querySelector('#btn-cancel').addEventListener('click', () => sheet.remove());
  sheet.querySelector('#btn-save').addEventListener('click', async () => {
    const name = sheet.querySelector('#f-dp-name').value.trim();
    if (!name) { toast('Enter a project name'); return; }
    await DB.createDesignProject({
      name,
      reference: sheet.querySelector('#f-dp-reference').value.trim(),
      client: sheet.querySelector('#f-dp-client').value.trim()
    });
    sheet.remove();
    onDone();
  });
}

// ---------------------------------------------------------------------------
// Item list (within a project)
// ---------------------------------------------------------------------------
async function renderDesignProject(projectId) {
  const project = await DB.get('designProjects', projectId);
  if (!project) { renderDesign(); return; }
  const items = await DB.listDesignItems(projectId);

  const rows = items.map((item) => {
    const info = DESIGN_ITEM_TYPES[item.type] || { label: item.type, icon: '📄' };
    const subtitle = item.wallType ? `${info.label} · ${item.wallType === 'mass' ? 'Mass' : 'Cantilever'}` : info.label;
    return `
      <div class="list-item" data-id="${item.id}">
        <div class="meta">
          <h3>${info.icon} ${esc(item.name)}</h3>
          <p>${esc(subtitle)}</p>
        </div>
        <span class="chevron">›</span>
      </div>
    `;
  }).join('');

  appEl.innerHTML = `
    <div class="topbar">
      <button class="icon-btn" id="btn-design-project-back">‹</button>
      <div style="flex:1; min-width:0;">
        <h1>${esc(project.name)}</h1>
        <span class="sub">${esc(project.reference || 'Design project')}</span>
      </div>
      <button class="text-btn" id="btn-design-project-edit">Edit</button>
    </div>
    <div class="content">
      ${items.length ? rows : `
        <div class="empty-state">
          <div class="glyph">＋</div>
          <h3>No items yet</h3>
          <p>Add a retaining wall to start a design.</p>
        </div>
      `}
    </div>
    <button class="fab" id="btn-new-design-item">＋</button>
  `;

  document.getElementById('btn-design-project-back').addEventListener('click', renderDesign);
  document.getElementById('btn-design-project-edit').addEventListener('click', () => openEditDesignProjectSheet(project, () => renderDesignProject(projectId)));
  document.getElementById('btn-new-design-item').addEventListener('click', () => openNewDesignItemSheet(projectId, (item) => renderDesignItem(item.id)));
  appEl.querySelectorAll('.list-item').forEach((row) => {
    row.addEventListener('click', () => renderDesignItem(row.dataset.id));
  });
}

function openEditDesignProjectSheet(project, onDone) {
  const sheet = el(`
    <div class="sheet-backdrop">
      <div class="sheet">
        <div class="sheet-handle"></div>
        <h2>Edit Project</h2>
        <div class="field"><label>Name</label><input type="text" id="f-dp-name" value="${esc(project.name)}"></div>
        <div class="field"><label>Reference</label><input type="text" id="f-dp-reference" value="${esc(project.reference)}"></div>
        <div class="field"><label>Client</label><input type="text" id="f-dp-client" value="${esc(project.client)}"></div>
        <button class="btn btn-primary btn-block" id="btn-save">Save</button>
        <button class="btn btn-danger btn-block" id="btn-delete" style="margin-top:10px;">Delete project</button>
        <button class="btn btn-ghost btn-block" id="btn-cancel">Cancel</button>
      </div>
    </div>
  `);
  presentOverlay(sheet);
  sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.remove(); });
  sheet.querySelector('#btn-cancel').addEventListener('click', () => sheet.remove());
  sheet.querySelector('#btn-save').addEventListener('click', async () => {
    const name = sheet.querySelector('#f-dp-name').value.trim();
    if (!name) { toast('Enter a project name'); return; }
    await DB.updateDesignProject(project.id, {
      name,
      reference: sheet.querySelector('#f-dp-reference').value.trim(),
      client: sheet.querySelector('#f-dp-client').value.trim()
    });
    sheet.remove();
    onDone();
  });
  sheet.querySelector('#btn-delete').addEventListener('click', async () => {
    if (!confirm(`Delete "${project.name}" and everything in it? This cannot be undone.`)) return;
    await DB.deleteDesignProjectCascade(project.id);
    sheet.remove();
    renderDesign();
  });
}

// ---------------------------------------------------------------------------
// New item — name, then type (only Retaining Wall populated for now), then
// wall type (Mass/Cantilever) as the first step inside it, per an explicit decision.
// ---------------------------------------------------------------------------
function openNewDesignItemSheet(projectId, onDone) {
  const sheet = el(`
    <div class="sheet-backdrop">
      <div class="sheet">
        <div class="sheet-handle"></div>
        <h2>New Item</h2>
        <div class="field"><label>Name</label><input type="text" id="f-di-name" placeholder="e.g. Wall to Ch.120-180"></div>
        <div class="field">
          <label>Type</label>
          <div class="severity-picker">
            ${Object.entries(DESIGN_ITEM_TYPES).map(([type, info]) => `
              <button class="chip design-type-chip selected" data-type="${type}" style="flex:0 0 auto; min-width:120px;">${info.icon} ${info.label}</button>
            `).join('')}
          </div>
        </div>
        <div class="field" id="wall-type-field">
          <label>Wall Type</label>
          <div class="severity-picker">
            <button class="chip wall-type-chip selected" data-wall="mass">Mass</button>
            <button class="chip wall-type-chip" data-wall="cantilever">Cantilever</button>
          </div>
        </div>
        <button class="btn btn-primary btn-block" id="btn-save">Create</button>
        <button class="btn btn-ghost btn-block" id="btn-cancel">Cancel</button>
      </div>
    </div>
  `);
  presentOverlay(sheet);
  let selectedType = 'retainingWall';
  let selectedWallType = 'mass';
  sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.remove(); });
  sheet.querySelector('#btn-cancel').addEventListener('click', () => sheet.remove());
  sheet.querySelectorAll('.wall-type-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      selectedWallType = btn.dataset.wall;
      sheet.querySelectorAll('.wall-type-chip').forEach((b) => b.classList.toggle('selected', b === btn));
    });
  });
  sheet.querySelector('#btn-save').addEventListener('click', async () => {
    const name = sheet.querySelector('#f-di-name').value.trim();
    if (!name) { toast('Enter an item name'); return; }
    const item = await DB.createDesignItem(projectId, { name, type: selectedType, wallType: selectedWallType });
    // The item's first Case is created immediately with sensible defaults, so "New Item"
    // leads straight into a working design rather than an empty shell needing a second step.
    await DB.createDesignCase(item.id, { name: 'Option A', inputs: designDefaultInputs(selectedWallType) });
    sheet.remove();
    onDone(item);
  });
}

// ---------------------------------------------------------------------------
// Case list (within an item)
// ---------------------------------------------------------------------------
async function renderDesignItem(itemId) {
  const item = await DB.get('designItems', itemId);
  if (!item) { renderDesign(); return; }
  const cases = await DB.listDesignCases(itemId);
  const info = DESIGN_ITEM_TYPES[item.type] || { label: item.type };

  const rows = cases.map((c) => `
    <div class="list-item" data-id="${c.id}">
      <div class="meta">
        <h3>${esc(c.name)}</h3>
        <p>${c.notes ? esc(c.notes) : 'Tap to open'}</p>
      </div>
      <span class="chevron">›</span>
    </div>
  `).join('');

  appEl.innerHTML = `
    <div class="topbar">
      <button class="icon-btn" id="btn-design-item-back">‹</button>
      <div style="flex:1; min-width:0;">
        <h1>${esc(item.name)}</h1>
        <span class="sub">${info.label}${item.wallType ? ' · ' + (item.wallType === 'mass' ? 'Mass' : 'Cantilever') : ''}</span>
      </div>
      <button class="text-btn" id="btn-design-item-edit">Edit</button>
    </div>
    <div class="content">
      <div class="section-header"><h2>Design Cases</h2></div>
      ${cases.length ? rows : `<div class="center-note">No cases yet — tap + to add one.</div>`}
    </div>
    <button class="fab" id="btn-new-design-case">＋</button>
  `;

  document.getElementById('btn-design-item-back').addEventListener('click', () => renderDesignProject(item.projectId));
  document.getElementById('btn-design-item-edit').addEventListener('click', () => openEditDesignItemSheet(item, () => renderDesignItem(itemId)));
  document.getElementById('btn-new-design-case').addEventListener('click', async () => {
    const c = await DB.createDesignCase(itemId, { inputs: designDefaultInputs(item.wallType) });
    renderDesignCase(c.id);
  });
  appEl.querySelectorAll('.list-item').forEach((row) => {
    row.addEventListener('click', () => renderDesignCase(row.dataset.id));
  });
}

function openEditDesignItemSheet(item, onDone) {
  const sheet = el(`
    <div class="sheet-backdrop">
      <div class="sheet">
        <div class="sheet-handle"></div>
        <h2>Edit Item</h2>
        <div class="field"><label>Name</label><input type="text" id="f-di-name" value="${esc(item.name)}"></div>
        <button class="btn btn-primary btn-block" id="btn-save">Save</button>
        <button class="btn btn-danger btn-block" id="btn-delete" style="margin-top:10px;">Delete item</button>
        <button class="btn btn-ghost btn-block" id="btn-cancel">Cancel</button>
      </div>
    </div>
  `);
  presentOverlay(sheet);
  sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.remove(); });
  sheet.querySelector('#btn-cancel').addEventListener('click', () => sheet.remove());
  sheet.querySelector('#btn-save').addEventListener('click', async () => {
    const name = sheet.querySelector('#f-di-name').value.trim();
    if (!name) { toast('Enter an item name'); return; }
    await DB.updateDesignItem(item.id, { name });
    sheet.remove();
    onDone();
  });
  sheet.querySelector('#btn-delete').addEventListener('click', async () => {
    if (!confirm(`Delete "${item.name}" and all its design cases? This cannot be undone.`)) return;
    await DB.deleteDesignItemCascade(item.id);
    sheet.remove();
    renderDesignProject(item.projectId);
  });
}

// ---------------------------------------------------------------------------
// Case editor — the form, live SVG diagram, computed results, and PDF export.
// Autosave (debounced + flush-on-blur) matches the pattern used everywhere else
// in this app (PM's task sheet, the shell's section editors) — no manual Save
// button for the inputs themselves, only for renaming/deleting the case.
// ---------------------------------------------------------------------------

const DESIGN_MATERIAL_FIELDS = [
  { key: 'phi', label: "Soil friction angle φ' (°)", group: 'inp' },
  { key: 'phif', label: "Founding friction angle φ'f (°)", group: 'inp' },
  { key: 'cf', label: "Founding cohesion c'f (kPa)", group: 'inp' },
  { key: 'delta', label: 'Wall friction δ (°)', group: 'inp' },
  { key: 'deltaW', label: 'Wall friction δw (°)', group: 'inp' },
  { key: 'beta', label: 'Backfill slope β (°)', group: 'inp' },
  { key: 'gamma', label: 'Retained soil unit weight γ (kN/m³)', group: 'inp' },
  { key: 'gammac', label: 'Concrete unit weight γc (kN/m³)', group: 'inp' },
  { key: 'gammaf', label: 'Founding soil unit weight γf (kN/m³)', group: 'inp' },
  { key: 'cover', label: 'Cover (mm)', group: 'inp' },
  { key: 'fck', label: 'Concrete fck (MPa)', group: 'inp' },
  { key: 'fyk', label: 'Reinforcement fyk (MPa)', group: 'inp' }
];
const DESIGN_LOAD_FIELDS = [
  { key: 'q', label: 'Surcharge q (kPa)', group: 'inp' },
  { key: 'Htop', label: 'Horizontal load at top (kN/m)', group: 'inp' },
  { key: 'Vtop', label: 'Vertical load at top (kN/m)', group: 'inp' },
  { key: 'PPfac', label: 'Passive pressure mobilisation factor', group: 'inp' }
];
const DESIGN_MASS_GEO_FIELDS = [
  { key: 'H', label: 'Height H (m)', group: 'geo' },
  { key: 'b1', label: 'Top width b1 (m)', group: 'geo' },
  { key: 'B', label: 'Base width B (m)', group: 'geo' },
  { key: 'Df', label: 'Founding depth Df (m)', group: 'geo' }
];
const DESIGN_CANT_GEO_FIELDS = [
  { key: 'hs', label: 'Stem height hs (m)', group: 'geo' },
  { key: 'ts', label: 'Stem thickness ts (m)', group: 'geo' },
  { key: 'tb', label: 'Base thickness tb (m)', group: 'geo' },
  { key: 'Lt', label: 'Toe length Lt (m)', group: 'geo' },
  { key: 'Lh', label: 'Heel length Lh (m)', group: 'geo' },
  { key: 'Df', label: 'Founding depth Df (m)', group: 'geo' }
];
const DESIGN_REBAR_PARTS = ['stem', 'heel', 'toe'];

function designFieldHtml(f, value) {
  return `
    <div class="field" style="margin-bottom:12px;">
      <label>${f.label}</label>
      <input type="number" step="any" class="design-input" data-group="${f.group}" data-key="${f.key}" value="${value != null ? value : ''}">
    </div>
  `;
}

async function renderDesignCase(caseId) {
  const dcase = await DB.get('designCases', caseId);
  if (!dcase) return;
  const item = await DB.get('designItems', dcase.itemId);
  if (!item) return;
  const isMass = item.wallType === 'mass';
  const geoFields = isMass ? DESIGN_MASS_GEO_FIELDS : DESIGN_CANT_GEO_FIELDS;
  const inputs = dcase.inputs || {};
  const inp = inputs.inp || {};
  const geo = inputs.geo || {};
  const rebar = inputs.rebar || {};

  appEl.innerHTML = `
    <div class="topbar">
      <button class="icon-btn" id="btn-design-case-back">‹</button>
      <div style="flex:1; min-width:0;">
        <h1 id="design-case-title">${esc(dcase.name)}</h1>
        <span class="sub">${esc(item.name)}</span>
      </div>
      <button class="text-btn" id="btn-design-case-rename">Rename</button>
      <button class="text-btn" id="btn-design-case-pdf">PDF</button>
      <button class="text-btn" id="btn-design-case-delete" style="color:#ffb3b3;">Delete</button>
    </div>
    <div class="content" style="max-width:1200px;">
      <div style="display:grid; grid-template-columns:minmax(280px,380px) 1fr; gap:20px; align-items:start;">
        <div>
          <div class="section-header"><h2>Materials &amp; Design</h2></div>
          ${DESIGN_MATERIAL_FIELDS.map((f) => designFieldHtml(f, inp[f.key])).join('')}
          <div class="checkbox-row"><input type="checkbox" id="design-model-factor" ${inp.applyModelFactor ? 'checked' : ''}><label style="margin:0;">Apply PD 6694-1 model factor (Sd;K=1.2)</label></div>

          <div class="section-header"><h2>Loads</h2></div>
          ${DESIGN_LOAD_FIELDS.map((f) => designFieldHtml(f, inp[f.key])).join('')}

          <div class="section-header"><h2>Geometry</h2></div>
          ${geoFields.map((f) => designFieldHtml(f, geo[f.key])).join('')}

          ${!isMass ? `
            <div class="section-header"><h2>Reinforcement</h2></div>
            ${DESIGN_REBAR_PARTS.map((part) => `
              <div class="row-2" style="margin-bottom:12px;">
                <div class="field" style="margin-bottom:0;"><label>${part[0].toUpperCase() + part.slice(1)} bar dia (mm)</label>
                  <input type="number" step="any" class="design-rebar-input" data-part="${part}" data-key="dia" value="${(rebar[part] && rebar[part].dia) || ''}"></div>
                <div class="field" style="margin-bottom:0;"><label>${part[0].toUpperCase() + part.slice(1)} spacing (mm)</label>
                  <input type="number" step="any" class="design-rebar-input" data-part="${part}" data-key="spacing" value="${(rebar[part] && rebar[part].spacing) || ''}"></div>
              </div>
            `).join('')}
          ` : ''}
        </div>

        <div>
          <div class="section-header"><h2>Cross-Section</h2></div>
          <div id="design-diagram" class="card" style="padding:8px;"></div>
          <div class="section-header"><h2>Results</h2></div>
          <div id="design-results"></div>
        </div>
      </div>
    </div>
  `;

  document.getElementById('btn-design-case-back').addEventListener('click', () => renderDesignItem(item.id));
  document.getElementById('btn-design-case-delete').addEventListener('click', async () => {
    if (!confirm(`Delete case "${dcase.name}"? This cannot be undone.`)) return;
    await DB.deleteDesignCase(caseId);
    renderDesignItem(item.id);
  });
  document.getElementById('btn-design-case-rename').addEventListener('click', () => {
    const name = prompt('Case name', dcase.name);
    if (!name || !name.trim()) return;
    dcase.name = name.trim();
    document.getElementById('design-case-title').textContent = dcase.name;
    DB.updateDesignCase(caseId, { name: dcase.name });
  });
  document.getElementById('btn-design-case-pdf').addEventListener('click', () => designExportPdf(dcase, item));

  // Live recompute + debounced autosave on every field — no manual Save button for inputs.
  let saveTimer = null;
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => DB.updateDesignCase(caseId, { inputs }), 700);
  }
  function flushSave() { clearTimeout(saveTimer); DB.updateDesignCase(caseId, { inputs }); }

  function recomputeAndRender() {
    designRenderDiagramAndResults(item, inputs);
  }

  appEl.querySelectorAll('.design-input').forEach((el2) => {
    const group = el2.dataset.group, key = el2.dataset.key;
    el2.addEventListener('input', () => {
      if (!inputs[group]) inputs[group] = {};
      inputs[group][key] = el2.value === '' ? 0 : parseFloat(el2.value);
      recomputeAndRender();
      scheduleSave();
    });
    el2.addEventListener('blur', flushSave);
  });
  const modelFactorCb = document.getElementById('design-model-factor');
  modelFactorCb.addEventListener('change', () => {
    if (!inputs.inp) inputs.inp = {};
    inputs.inp.applyModelFactor = modelFactorCb.checked;
    recomputeAndRender();
    flushSave();
  });
  appEl.querySelectorAll('.design-rebar-input').forEach((el2) => {
    el2.addEventListener('input', () => {
      if (!inputs.rebar) inputs.rebar = {};
      if (!inputs.rebar[el2.dataset.part]) inputs.rebar[el2.dataset.part] = {};
      inputs.rebar[el2.dataset.part][el2.dataset.key] = el2.value === '' ? 0 : parseFloat(el2.value);
      recomputeAndRender();
      scheduleSave();
    });
    el2.addEventListener('blur', flushSave);
  });

  recomputeAndRender();
}

function designCheckRow(label, actualText, pass) {
  return `
    <div style="display:flex; align-items:center; justify-content:space-between; padding:8px 0; border-bottom:1px solid var(--line);">
      <div style="font-size:13.5px;">${esc(label)}</div>
      <div style="display:flex; align-items:center; gap:8px;">
        <span style="font-size:12.5px; color:var(--ink-soft); font-family:monospace;">${actualText}</span>
        <span class="badge" style="background:${pass ? 'var(--sev-1)' : 'var(--sev-5)'};">${pass ? 'PASS' : 'FAIL'}</span>
      </div>
    </div>
  `;
}

function designComboResultsHtml(label, r, isMass) {
  let html = `<div style="font-size:13px; font-weight:700; text-transform:uppercase; color:var(--ink-soft); margin:14px 0 4px;">${label}</div>`;
  html += designCheckRow('Eccentricity e ≤ B/6', `e=${r.e.toFixed(3)}m`, r.eB6);
  html += designCheckRow('Bearing N ≤ R', `${r.N.toFixed(0)} ≤ ${r.R.toFixed(0)} kN/m`, r.bearingCheck);
  html += designCheckRow('Sliding Hd ≤ Rslide', `${r.Hd.toFixed(1)} ≤ ${r.Rslide.toFixed(1)} kN/m`, r.slideCheck);
  if (!isMass && r.heelCheck != null) {
    html += designCheckRow('Heel length ≥ min', `Lh vs ${r.heelMin.toFixed(2)}m min`, r.heelCheck);
  }
  return html;
}

function designRcBlockHtml(label, r) {
  if (!r) return '';
  let html = `<div style="font-size:13px; font-weight:700; text-transform:uppercase; color:var(--ink-soft); margin:14px 0 4px;">${label} reinforcement</div>`;
  html += designCheckRow('Moment capacity K ≤ K\'', `K=${r.K.toFixed(3)}`, r.kCheck);
  html += designCheckRow('Area provided ≥ required', `${r.Asprov.toFixed(0)} ≥ ${Math.max(r.Asreq, r.Asmin).toFixed(0)} mm²/m`, r.asCheck);
  html += designCheckRow('Shear VEd ≤ VRdc', `${r.VEd.toFixed(1)} ≤ ${r.VRdc.toFixed(1)} kN/m`, r.vCheck);
  html += designCheckRow('Crack control spacing', `${r.spacing} ≤ ${r.maxSpacing}mm`, r.crackCheck);
  return html;
}

// Renders the SVG diagram and the computed results panel from the current in-memory inputs
// — called on every keystroke (recompute is cheap; these are plain arithmetic functions,
// not anything requiring debouncing itself, only the DB write does).
function designRenderDiagramAndResults(item, inputs) {
  const isMass = item.wallType === 'mass';
  const inp = inputs.inp || {};
  const geo = inputs.geo || {};
  const diagramEl = document.getElementById('design-diagram');
  const resultsEl = document.getElementById('design-results');
  if (!diagramEl || !resultsEl) return;

  try {
    const d = computeDerived(inp);
    if (isMass) {
      diagramEl.innerHTML = svgMassWall(geo);
      const out = computeMassWall(inp, geo, d);
      resultsEl.innerHTML = designComboResultsHtml('Combination 1', out.combos.C1, true) + designComboResultsHtml('Combination 2', out.combos.C2, true);
    } else {
      diagramEl.innerHTML = svgCantileverWall(geo);
      const rebar = inputs.rebar || { stem: {}, heel: {}, toe: {} };
      const out = computeCantileverWall(inp, geo, d, rebar);
      resultsEl.innerHTML =
        designComboResultsHtml('Combination 1', out.combos.C1, false) +
        designComboResultsHtml('Combination 2', out.combos.C2, false) +
        designRcBlockHtml('Stem', out.stem) +
        designRcBlockHtml('Heel', out.heel) +
        designRcBlockHtml('Toe', out.toe);
    }
  } catch (err) {
    // Mid-typing inputs (e.g. a geometry value briefly at 0) can legitimately make the
    // maths blow up (e.g. divide-by-zero in a ratio) — shown as a quiet note rather than
    // a crash, since the next keystroke usually resolves it.
    resultsEl.innerHTML = `<div class="center-note">Enter valid values for all fields to see results.</div>`;
    diagramEl.innerHTML = '';
    console.warn('Design calc did not resolve (likely incomplete inputs):', err);
  }
}

// PDF export — the SVG is rasterized via an offscreen canvas (jsPDF has no native SVG
// support), then embedded as an image; everything else drawn as plain jsPDF text, following
// the same jsPDF usage pattern as pdf.js's report generator.
async function designExportPdf(dcase, item) {
  if (!window.jspdf) {
    toast('PDF library not loaded. Connect to the internet once to cache it, then try again.');
    return;
  }
  toast('Building calculation sheet…');
  try {
    const isMass = item.wallType === 'mass';
    const inputs = dcase.inputs || {};
    const inp = inputs.inp || {};
    const geo = inputs.geo || {};
    const rebar = inputs.rebar || { stem: {}, heel: {}, toe: {} };
    const d = computeDerived(inp);
    const svgString = isMass ? svgMassWall(geo) : svgCantileverWall(geo);
    const pngDataUrl = await designSvgToPngDataUrl(svgString);

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'mm', format: 'a4' });
    const pageW = doc.internal.pageSize.getWidth();
    let y = 18;
    doc.setFontSize(16); doc.setFont(undefined, 'bold');
    doc.text(`${item.name} — ${dcase.name}`, 14, y);
    y += 7;
    doc.setFontSize(10); doc.setFont(undefined, 'normal');
    doc.text(`${isMass ? 'Mass' : 'Cantilever'} retaining wall — retaining wall design calculation`, 14, y);
    y += 10;

    doc.addImage(pngDataUrl, 'PNG', 14, y, 130, 130 * (400 / 640));
    y += 130 * (400 / 640) + 10;

    doc.setFontSize(11); doc.setFont(undefined, 'bold');
    doc.text('Results', 14, y);
    y += 6;
    doc.setFontSize(9); doc.setFont(undefined, 'normal');

    function printLine(text) {
      if (y > 280) { doc.addPage(); y = 18; }
      doc.text(text, 14, y);
      y += 5;
    }
    function printCombo(label, r, includeHeel) {
      printLine(`${label}: e=${r.e.toFixed(3)}m (${r.eB6 ? 'OK' : 'EXCEEDS B/6'})  |  N=${r.N.toFixed(0)} vs R=${r.R.toFixed(0)} kN/m (${r.bearingCheck ? 'PASS' : 'FAIL'})  |  Hd=${r.Hd.toFixed(1)} vs Rslide=${r.Rslide.toFixed(1)} kN/m (${r.slideCheck ? 'PASS' : 'FAIL'})`);
      if (includeHeel && r.heelCheck != null) printLine(`  Heel length check: ${r.heelCheck ? 'PASS' : 'FAIL'} (min ${r.heelMin.toFixed(2)}m)`);
    }
    function printRc(label, r) {
      if (!r) return;
      printLine(`${label}: K=${r.K.toFixed(3)} (${r.kCheck ? 'OK' : 'EXCEEDS Kmax'})  |  As prov=${r.Asprov.toFixed(0)} vs req=${Math.max(r.Asreq, r.Asmin).toFixed(0)} mm2/m (${r.asCheck ? 'PASS' : 'FAIL'})  |  V=${r.VEd.toFixed(1)} vs VRdc=${r.VRdc.toFixed(1)} (${r.vCheck ? 'PASS' : 'FAIL'})  |  crack spacing ${r.crackCheck ? 'PASS' : 'FAIL'}`);
    }

    if (isMass) {
      const out = computeMassWall(inp, geo, d);
      printCombo('Combination 1', out.combos.C1, false);
      printCombo('Combination 2', out.combos.C2, false);
    } else {
      const out = computeCantileverWall(inp, geo, d, rebar);
      printCombo('Combination 1', out.combos.C1, true);
      printCombo('Combination 2', out.combos.C2, true);
      printRc('Stem', out.stem);
      printRc('Heel', out.heel);
      printRc('Toe', out.toe);
    }

    if (dcase.notes) {
      y += 4;
      doc.setFont(undefined, 'bold'); printLine('Notes'); doc.setFont(undefined, 'normal');
      printLine(dcase.notes);
    }

    doc.save(`${item.name.replace(/[^a-z0-9]+/gi, '_')}_${dcase.name.replace(/[^a-z0-9]+/gi, '_')}.pdf`);
  } catch (err) {
    console.error('Design PDF export failed', err);
    toast('PDF export failed — see console for details');
  }
}

function designSvgToPngDataUrl(svgString) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const svgBlob = new Blob([svgString], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(svgBlob);
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = 640; canvas.height = 400;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, 640, 400);
      ctx.drawImage(img, 0, 0, 640, 400);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = (err) => { URL.revokeObjectURL(url); reject(err); };
    img.src = url;
  });
}
