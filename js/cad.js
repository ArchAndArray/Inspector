// cad.js — CAD module screens: drawing list (#/cad) and the editor (#/cad/<id>).
// Geometry is in cadgeo.js, the document + command engine in cadcmd.js; this file is the
// canvas, input handling (Pencil / touch / mouse / keyboard), command line and status bar.
//
// Input model (see the CAD spec, section 5):
//   Pencil or mouse  point, pick and select; a point commits on lift (press, drag to adjust, lift)
//   One finger       pan (or, with the "Finger: draw" setting, an offset pointer)
//   Two fingers      pinch zoom and pan, always available mid-command
//   Long press       context menu (Enter, Cancel, options, Repeat); mouse right click does the same
//   Typing           goes to the command line: coordinates (x,y  @dx,dy  @d<a), direct distance,
//                    option keywords, command names and AutoCAD aliases.

const CAD_ACI = CadStyle.ACI;
// small HTML builders shared by the layers and properties sheets
function cadLtOptions(sel, byLayer) { return (byLayer ? `<option value="" ${!sel ? 'selected' : ''}>ByLayer</option>` : '') + Object.keys(CadStyle.LINETYPES).map((n) => `<option value="${n}" ${sel === n ? 'selected' : ''}>${CadStyle.LT_NOTE[n]}</option>`).join(''); }
function cadLwOptions(sel, byLayer, defLabel) { return (byLayer ? `<option value="" ${sel == null ? 'selected' : ''}>ByLayer</option>` : `<option value="-3" ${sel === -3 || sel == null ? 'selected' : ''}>${defLabel || 'Default'}</option>`) + CadStyle.LW_LIST.map((v) => `<option value="${v}" ${sel === v ? 'selected' : ''}>${(v / 100).toFixed(2)} mm</option>`).join(''); }
const CAD_SNAP_NAMES = { end: 'Endpoint', mid: 'Midpoint', cen: 'Center', gcen: 'Geometric center', node: 'Node', quad: 'Quadrant', int: 'Intersection', per: 'Perpendicular', tan: 'Tangent', nea: 'Nearest', ins: 'Text insertion' };
const CAD_DEFAULT_PREFS = {
  toggles: { osnap: true, grid: true, snap: false, ortho: false, polar: false, dyn: true, lwt: true },
  modes: { end: true, mid: true, cen: true, int: true, node: true, quad: false, per: true, tan: false, nea: false, gcen: false, ins: true },
  polarInc: 45, finger: 'pan'
};
const CAD_TOOLS = [
  { group: 'Draw' },
  { cmd: 'LINE', label: 'Line' }, { cmd: 'PLINE', label: 'Polyline' }, { cmd: 'RECTANG', label: 'Rectangle' },
  { cmd: 'CIRCLE', label: 'Circle' }, { cmd: 'ARC', label: 'Arc' }, { cmd: 'POINT', label: 'Point' }, { cmd: 'HATCH', label: 'Hatch' }, { cmd: 'SYMBOL', label: 'Stencils' },
  { group: 'Modify' },
  { cmd: 'MOVE', label: 'Move' }, { cmd: 'COPY', label: 'Copy' }, { cmd: 'ROTATE', label: 'Rotate' }, { cmd: 'SCALE', label: 'Scale' },
  { cmd: 'MIRROR', label: 'Mirror' }, { cmd: 'OFFSET', label: 'Offset' }, { cmd: 'TRIM', label: 'Trim' }, { cmd: 'EXTEND', label: 'Extend' },
  { cmd: 'FILLET', label: 'Fillet' }, { cmd: 'CHAMFER', label: 'Chamfer' }, { cmd: 'STRETCH', label: 'Stretch' }, { cmd: 'EXPLODE', label: 'Explode' },
  { cmd: 'ERASE', label: 'Erase' },
  { group: 'Annotate' },
  { cmd: 'TEXT', label: 'Text' }, { cmd: 'MTEXT', label: 'Multi text' }, { cmd: 'TEXTEDIT', label: 'Edit text' },
  { cmd: 'DIMLINEAR', label: 'Dim linear' }, { cmd: 'DIMALIGNED', label: 'Dim aligned' }, { cmd: 'DIMCONTINUE', label: 'Dim continue' },
  { group: 'Measure' },
  { cmd: 'DIST', label: 'Distance' }, { cmd: 'AREA', label: 'Area' },
  { group: 'Setup' },
  { cmd: 'LAYER', label: 'Layers' }, { cmd: 'PROPERTIES', label: 'Properties' },
  { group: 'Underlay' },
  { cmd: 'UNDERLAY', label: 'Underlays' }, { cmd: 'CALIBRATE', label: 'Calibrate' }, { cmd: 'UMOVE', label: 'Move underlay' }, { cmd: 'UROTATE', label: 'Rotate underlay' }
];
const CAD_UNITS = { mm: { prec: 2, label: 'mm' }, m: { prec: 4, label: 'm' }, in: { prec: 3, label: 'in' } };

function cadIcon(cmd) {
  const a = 'width="26" height="26" viewBox="0 0 26 26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
  const paths = {
    LINE: '<path d="M5 21 L21 5"/><circle cx="5" cy="21" r="1.6" fill="currentColor"/><circle cx="21" cy="5" r="1.6" fill="currentColor"/>',
    PLINE: '<path d="M4 19 L10 8 L16 17 L22 6"/>',
    RECTANG: '<rect x="4.5" y="7" width="17" height="12" rx="0.5"/>',
    CIRCLE: '<circle cx="13" cy="13" r="8"/>',
    ARC: '<path d="M4 20 A10 10 0 0 1 22 20"/>',
    POINT: '<circle cx="13" cy="13" r="2.2" fill="currentColor"/><path d="M13 5 V8 M13 18 V21 M5 13 H8 M18 13 H21"/>',
    SYMBOL: '<circle cx="9" cy="10" r="5"/><path d="M9 15 V22 M5 22 H13"/><ellipse cx="19" cy="19" rx="4" ry="3"/>',
    HATCH: '<rect x="4.5" y="5.5" width="17" height="15" rx="0.5"/><path d="M8 20 L21 7 M4.5 15 L14 5.5 M13 20.5 L21.5 12"/>',
    ERASE: '<path d="M6 17 L14 6 L21 11 L14 20 H9 Z"/><path d="M10 14 L17 19"/>',
    MOVE: '<path d="M13 3 V23 M3 13 H23 M13 3 L10 6 M13 3 L16 6 M13 23 L10 20 M13 23 L16 20 M3 13 L6 10 M3 13 L6 16 M23 13 L20 10 M23 13 L20 16"/>',
    COPY: '<rect x="4" y="10" width="11" height="11" rx="1"/><path d="M10 6 H21 V17"/>',
    ROTATE: '<path d="M21 13 A8 8 0 1 1 13 5 M13 5 L17 2 M13 5 L17 8"/>',
    SCALE: '<rect x="4" y="13" width="8" height="8"/><path d="M12 14 L22 4 M16 4 H22 V10"/>',
    MIRROR: '<path d="M13 3 V23" stroke-dasharray="3 2.5"/><path d="M10 7 L4 19 H10 Z M16 7 L22 19 H16 Z"/>',
    OFFSET: '<path d="M4 20 C4 10 10 5 21 5"/><path d="M8 23 C8 15 13 10 23 10"/>',
    TRIM: '<path d="M3 13 H9 M17 13 H23"/><path d="M13 4 V22"/><path d="M10 10 L16 16 M16 10 L10 16"/>',
    EXTEND: '<path d="M3 13 H16"/><path d="M22 4 V22"/><path d="M13 9 L17 13 L13 17"/>',
    FILLET: '<path d="M5 4 V15 A6 6 0 0 0 11 21 H22"/>',
    CHAMFER: '<path d="M5 4 V13 L13 21 H22"/>',
    STRETCH: '<rect x="4" y="8" width="10" height="10" stroke-dasharray="3 2.5"/><path d="M14 13 H23 M20 10 L23 13 L20 16"/>',
    EXPLODE: '<path d="M13 3 V8 M13 18 V23 M3 13 H8 M18 13 H23 M6 6 L9.5 9.5 M16.5 16.5 L20 20 M20 6 L16.5 9.5 M9.5 16.5 L6 20"/>',
    FIT: '<path d="M5 10 V5 H10 M16 5 H21 V10 M21 16 V21 H16 M10 21 H5 V16"/>',
    UNDO: '<path d="M8 10 H16 A4.5 4.5 0 0 1 16 19 H10"/><path d="M11 6 L7.5 10 L11 14"/>',
    REDO: '<path d="M18 10 H10 A4.5 4.5 0 0 0 10 19 H16"/><path d="M15 6 L18.5 10 L15 14"/>',
    TEXT: '<path d="M6 7 H20 M13 7 V21 M10 21 H16"/>',
    MTEXT: '<path d="M4 6 H22 M4 11 H22 M4 16 H22 M4 21 H14"/>',
    TEXTEDIT: '<path d="M4 7 H14 M9 7 V19"/><path d="M14 21 L15 17 L22 10 L24 12 L17 19 Z"/>',
    DIMLINEAR: '<path d="M4 8 V20 M22 8 V20 M4 16 H22 M4 16 L8 14 V18 Z M22 16 L18 14 V18 Z" />',
    DIMALIGNED: '<path d="M4 20 L4 12 M18 6 L18 -2 M6 17 L20 3"/><path d="M4 21 L20 5"/><path d="M4 21 L8 20 M4 21 L5 17" />',
    DIMCONTINUE: '<path d="M3 8 V20 M12 8 V20 M23 8 V20 M3 16 H23"/>',
    DIST: '<path d="M4 20 L22 6"/><circle cx="4" cy="20" r="2"/><circle cx="22" cy="6" r="2"/>',
    AREA: '<path d="M5 20 L8 6 L21 9 L19 21 Z" fill="currentColor" fill-opacity=".18"/>',
    LAYER: '<path d="M13 4 L23 9 L13 14 L3 9 Z"/><path d="M3 13 L13 18 L23 13"/><path d="M3 17 L13 22 L23 17"/>',
    PROPERTIES: '<path d="M5 7 H21 M5 13 H21 M5 19 H21"/><circle cx="9" cy="7" r="2" fill="#fff"/><circle cx="17" cy="13" r="2" fill="#fff"/><circle cx="11" cy="19" r="2" fill="#fff"/>',
    UNDERLAY: '<rect x="4" y="6" width="18" height="14" rx="1"/><path d="M4 16 L10 11 L14 15 L17 12 L22 17"/><circle cx="17" cy="10" r="1.5"/>',
    CALIBRATE: '<path d="M3 17 H23 M3 13 V21 M23 13 V21 M8 17 V14 M13 17 V15 M18 17 V14"/>',
    UMOVE: '<rect x="5" y="7" width="12" height="10" rx="1"/><path d="M13 13 L22 22 M22 22 H17 M22 22 V17"/>',
    UROTATE: '<rect x="6" y="9" width="12" height="9" rx="1"/><path d="M20 6 A7 7 0 0 0 11 4 M11 4 L14 3 M11 4 L12 7"/>',
    EXPORT: '<path d="M13 3 V15 M8 8 L13 3 L18 8"/><path d="M5 13 V21 H21 V13"/>',
    GEAR: '<circle cx="13" cy="13" r="3.2"/><path d="M13 3.5 V6 M13 20 V22.5 M3.5 13 H6 M20 13 H22.5 M6.3 6.3 L8 8 M18 18 L19.7 19.7 M19.7 6.3 L18 8 M8 18 L6.3 19.7"/>'
  };
  return `<svg ${a}>${paths[cmd] || ''}</svg>`;
}

function cadLoadPrefs() {
  const base = JSON.parse(JSON.stringify(CAD_DEFAULT_PREFS));
  try {
    const s = JSON.parse(localStorage.getItem('cadPrefs') || 'null');
    if (s) {
      Object.assign(base.toggles, s.toggles || {}); Object.assign(base.modes, s.modes || {});
      if (s.polarInc) base.polarInc = s.polarInc;
      if (s.finger) base.finger = s.finger;
    }
  } catch (e) { /* localStorage unavailable: defaults */ }
  return base;
}
function cadSavePrefs(p) { try { localStorage.setItem('cadPrefs', JSON.stringify(p)); } catch (e) { /* ignore */ } }

let cadMounted = null;
function cadTeardown() { if (cadMounted) { try { cadMounted.destroy(); } catch (e) { console.error(e); } cadMounted = null; } }

async function renderCad(id) {
  cadTeardown();
  if (!id) return renderCadList();
  const data = await DB.get('cadDrawings', id);
  if (!data) { navigate('#/cad'); return; }
  cadMountEditor(data);
}

// ---------------------------------------------------------------------------
// Drawing list
// ---------------------------------------------------------------------------
async function renderCadList() {
  const drawings = await DB.listCadDrawings();
  const rows = drawings.map((d) => `
    <div class="list-item" data-id="${d.id}">
      <div class="meta">
        <h3>${esc(d.name)}</h3>
        <p>${d.entities.length} object${d.entities.length === 1 ? '' : 's'} · ${esc((CAD_UNITS[d.units] || CAD_UNITS.mm).label)} · ${esc(new Date(d.modified).toLocaleString())}</p>
      </div>
      <span class="chevron">›</span>
    </div>`).join('');
  appEl.innerHTML = `
    <div class="topbar">
      <button class="icon-btn" id="btn-cad-back">‹</button>
      <div style="flex:1; min-width:0;"><h1>CAD</h1><span class="sub">2D drawings</span></div>
      <button class="text-btn" id="btn-cad-import">Import DXF</button>
    </div>
    <div class="content">
      ${drawings.length ? rows : `
        <div class="empty-state">
          <div class="glyph">＋</div>
          <h3>No drawings yet</h3>
          <p>Create a drawing to sketch a structure from measurements.</p>
        </div>`}
    </div>
    <button class="fab" id="btn-new-cad">＋</button>`;
  document.getElementById('btn-cad-back').addEventListener('click', () => navigate('#/'));
  document.getElementById('btn-new-cad').addEventListener('click', () => cadOpenNewSheet());
  document.getElementById('btn-cad-import').addEventListener('click', () => cadPickDxfFile());
  appEl.querySelectorAll('.list-item').forEach((row) => row.addEventListener('click', () => navigate('#/cad/' + row.dataset.id)));
  SwipeDelete.attachAll(appEl, '.list-item', (row) => ({
    title: 'Delete drawing?',
    message: `${row.querySelector('h3') ? row.querySelector('h3').textContent : 'This drawing'} and its saved versions will be deleted. This can't be undone.`,
    onDelete: async () => { await DB.deleteCadDrawing(row.dataset.id); renderCadList(); }
  }));
}

function cadOpenNewSheet() {
  const sheet = el(`
    <div class="sheet-backdrop">
      <div class="sheet">
        <div class="sheet-handle"></div>
        <h2>New drawing</h2>
        <div class="field"><label>Name</label><input type="text" id="f-cad-name" placeholder="e.g. Pier 2 elevation"></div>
        <div class="field"><label>Drawing units</label>
          <select id="f-cad-units"><option value="mm" selected>Millimetres</option><option value="m">Metres</option><option value="in">Inches</option></select>
        </div>
        <button class="btn btn-primary btn-block" id="btn-save">Create</button>
        <button class="btn btn-ghost btn-block" id="btn-cancel">Cancel</button>
      </div>
    </div>`);
  presentOverlay(sheet);
  sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.remove(); });
  sheet.querySelector('#btn-cancel').addEventListener('click', () => sheet.remove());
  sheet.querySelector('#btn-save').addEventListener('click', async () => {
    const name = sheet.querySelector('#f-cad-name').value.trim() || 'Untitled drawing';
    const units = sheet.querySelector('#f-cad-units').value;
    const d = await DB.createCadDrawing({ name, units });
    sheet.remove();
    navigate('#/cad/' + d.id);
  });
}

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------
function cadUnderlayCorners(u) {
  const c = Math.cos(u.rot || 0), s = Math.sin(u.rot || 0);
  return [[0, 0], [u.w, 0], [u.w, u.h], [0, u.h]].map(([x, y]) => [u.x + x * c - y * s, u.y + x * s + y * c]);
}
function cadMountEditor(data) {
  const prefs = cadLoadPrefs();
  if (prefs.modes && prefs.modes.ins === undefined) prefs.modes.ins = true;
  const doc = new CadCmd.CadDoc(data);
  const unit = CAD_UNITS[doc.d.units] || CAD_UNITS.mm;
  const fmt = (n) => CadGeo.fmtNum(n, unit.prec);
  const G = CadGeo;
  let view = { cx: data.view ? data.view.cx : 0, cy: data.view ? data.view.cy : 0, scale: data.view ? data.view.scale : 0.5 };
  const prevViews = [];
  let W = 300, H = 300, dpr = 1;
  let rafPending = false;
  let cur = { pt: null, raw: null, snap: null, track: null, screen: null, active: false };
  let saveTimer = null, saveState = 'saved', lastSnapshot = 0, destroyed = false;
  const cmdHistory = []; let cmdHistIdx = -1;
  let windowRect = null;
  let menuEl = null;

  appEl.innerHTML = `
    <div class="cad-root" id="cad-root">
      <div class="cad-top">
        <button class="cad-btn" id="cad-back" title="Back">‹</button>
        <button class="cad-title" id="cad-name"></button>
        <span class="cad-saved" id="cad-saved"></span>
        <span style="flex:1"></span>
        <button class="cad-btn" id="cad-undo" title="Undo">${cadIcon('UNDO')}</button>
        <button class="cad-btn" id="cad-redo" title="Redo">${cadIcon('REDO')}</button>
        <button class="cad-btn" id="cad-fit" title="Zoom to fit">${cadIcon('FIT')}</button>
        <button class="cad-btn" id="cad-export" title="Export / print">${cadIcon('EXPORT')}</button>
        <button class="cad-btn cad-finger" id="cad-finger" title="What one finger does"></button>
        <button class="cad-btn" id="cad-settings" title="Drafting settings">${cadIcon('GEAR')}</button>
      </div>
      <div class="cad-main">
        <div class="cad-palette" id="cad-palette">
          ${CAD_TOOLS.map((t) => (t.group ? `<div class="cad-group">${t.group}</div>` : `<button class="cad-tool" data-cmd="${t.cmd}" title="${t.label}">${cadIcon(t.cmd)}<span>${t.label}</span></button>`)).join('')}
        </div>
        <div class="cad-wrap" id="cad-wrap">
          <canvas id="cad-canvas"></canvas>
        </div>
      </div>
      <div class="cad-bottom">
        <div class="cad-hist" id="cad-hist"></div>
        <div class="cad-chips" id="cad-chips"></div>
        <div class="cad-keypad" id="cad-keypad">
          ${[',', '@', '<', '.', '-'].map((k) => `<button class="cad-key" data-k="${k}">${k}</button>`).join('')}
          <button class="cad-key" data-k="BS">⌫</button>
          <button class="cad-key cad-key-enter" data-k="ENTER">Enter</button>
        </div>
        <div class="cad-cmdrow">
          <span class="cad-prompt" id="cad-prompt">Command:</span>
          <input id="cad-cmd" type="text" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" enterkeyhint="done" placeholder="Type a command or coordinates">
          <button class="cad-btn cad-cancel" id="cad-cancel" title="Cancel (Esc)">✕</button>
          <button class="cad-btn cad-enter" id="cad-enter">Enter</button>
        </div>
        <div class="cad-status">
          <span class="cad-coords" id="cad-coords">X: –  Y: –</span>
          <span class="cad-units">${esc(unit.label)}</span>
          <button class="cad-tog on" id="cad-layer" title="Current layer. Tap for layers"></button>
          <span style="flex:1"></span>
          ${['snap', 'grid', 'ortho', 'polar', 'osnap', 'dyn', 'lwt'].map((k) => `<button class="cad-tog" data-t="${k}">${k.toUpperCase()}</button>`).join('')}
        </div>
      </div>
    </div>`;
  injectCadCss();
  const $ = (id) => document.getElementById(id);
  const root = $('cad-root'), canvas = $('cad-canvas'), wrap = $('cad-wrap'), cmdInput = $('cad-cmd');
  const ctx2 = canvas.getContext('2d');
  $('cad-name').textContent = doc.d.name;

  // ---- engine ----
  const host = {
    zoomExtents: () => zoomExtents(),
    zoomWindow: (a, b) => zoomWindow(a, b),
    zoomPrevious: () => { const v = prevViews.pop(); if (v) { view = v; requestDraw(); } },
    zoomScale: (f) => { pushView(); view.scale = clampScale(view.scale * f); requestDraw(); },
    panBy: (d) => { pushView(); view.cx -= d[0]; view.cy -= d[1]; requestDraw(); },
    redraw: () => requestDraw(),
    toast: (m) => toast(m),
    openLayers: () => openLayers(),
    openProperties: () => openProperties(),
    openUnderlays: () => openUnderlays()
  };
  const engine = new CadCmd.Engine(doc, host);
  engine.onChange = () => { refreshUI(); requestDraw(); };
  doc.onChange = () => { markDirty(); refreshUI(); requestDraw(); };

  // ---- view maths ----
  const clampScale = (s) => Math.max(0.0005, Math.min(5000, s));
  const s2w = (x, y) => [view.cx + (x - W / 2) / view.scale, view.cy - (y - H / 2) / view.scale];
  const w2s = (p) => [(p[0] - view.cx) * view.scale + W / 2, H / 2 - (p[1] - view.cy) * view.scale];
  function pushView() { prevViews.push({ ...view }); if (prevViews.length > 12) prevViews.shift(); }
  function fitBox(b, margin) {
    if (!b || !isFinite(b.minX)) { view = { cx: 0, cy: 0, scale: 0.5 }; return; }
    const bw = Math.max(b.maxX - b.minX, 1e-6), bh = Math.max(b.maxY - b.minY, 1e-6);
    const m = margin == null ? 0.92 : margin;
    let s = Math.min((W * m) / bw, (H * m) / bh);
    if (bw < 1e-3 && bh < 1e-3) s = view.scale;
    view = { cx: (b.minX + b.maxX) / 2, cy: (b.minY + b.maxY) / 2, scale: clampScale(s) };
  }
  function underlayBox() {
    let b = null;
    for (const u of (doc.d.underlays || [])) {
      if (u.on === false) continue;
      for (const q of cadUnderlayCorners(u)) { if (!b) b = { minX: q[0], minY: q[1], maxX: q[0], maxY: q[1] }; else { b.minX = Math.min(b.minX, q[0]); b.minY = Math.min(b.minY, q[1]); b.maxX = Math.max(b.maxX, q[0]); b.maxY = Math.max(b.maxY, q[1]); } }
    }
    return b;
  }
  function allBox() { const e = doc.extents(), u = underlayBox(); if (!e) return u; if (!u) return e; return { minX: Math.min(e.minX, u.minX), minY: Math.min(e.minY, u.minY), maxX: Math.max(e.maxX, u.maxX), maxY: Math.max(e.maxY, u.maxY) }; }
  function zoomExtents() { pushView(); fitBox(allBox()); requestDraw(); }
  function zoomWindow(a, b) { pushView(); fitBox(G.rectOf(a, b), 1); requestDraw(); }
  function zoomAt(sx, sy, factor) {
    const before = s2w(sx, sy);
    view.scale = clampScale(view.scale * factor);
    view.cx = before[0] - (sx - W / 2) / view.scale;
    view.cy = before[1] + (sy - H / 2) / view.scale;
  }

  // ---- persistence ----
  function snapshotData() { return { ...doc.d, entities: doc.entities, view: { ...view } }; }
  function setSaveLabel() { $('cad-saved').textContent = saveState === 'saved' ? '✓ Saved' : saveState === 'saving' ? 'Saving…' : '● Unsaved'; }
  function markDirty() { saveState = 'dirty'; setSaveLabel(); clearTimeout(saveTimer); saveTimer = setTimeout(save, 2000); }
  async function save() {
    clearTimeout(saveTimer);
    if (saveState === 'saved') return;
    saveState = 'saving'; setSaveLabel();
    try {
      const snap = snapshotData();
      await DB.saveCadDrawing(snap);
      const now = Date.now();
      if (now - lastSnapshot > 120000) { lastSnapshot = now; await DB.addCadSnapshot(snap, 20); }
      if (saveState === 'saving') saveState = 'saved';
    } catch (err) { console.error(err); saveState = 'dirty'; toast('Could not save the drawing'); }
    if (!destroyed) setSaveLabel();
  }
  const onHide = () => { if (document.visibilityState === 'hidden' || document.visibilityState === undefined) save(); };
  document.addEventListener('visibilitychange', onHide);
  window.addEventListener('pagehide', save);

  // ---- sizing ----
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 3);
    const r = wrap.getBoundingClientRect();
    const nw = Math.max(50, Math.floor(r.width)), nh = Math.max(50, Math.floor(r.height));
    const first = W === 300 && H === 300 && !canvas.width;
    W = nw; H = nh;
    canvas.width = Math.floor(W * dpr); canvas.height = Math.floor(H * dpr);
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    if (first && (!data.view || !doc.entities.length)) { if (doc.entities.length) fitBox(doc.extents()); }
    requestDraw();
  }
  const ro = new ResizeObserver(resize); ro.observe(wrap);
  const vv = window.visualViewport;
  function fitVisualViewport() {
    if (!vv) return;
    root.style.height = vv.height + 'px';
    root.style.top = vv.offsetTop + 'px';
    root.style.bottom = 'auto';
  }
  if (vv) { vv.addEventListener('resize', fitVisualViewport); vv.addEventListener('scroll', fitVisualViewport); fitVisualViewport(); }

  // ---- cursor, snapping, constraints ----
  const apertureFor = (type) => (type === 'touch' ? 26 : type === 'pen' ? 14 : 11);
  function resolveCursor(sx, sy, ptype) {
    const raw = s2w(sx, sy);
    const t = prefs.toggles;
    const base = engine.base();
    let pt = raw, snap = null, track = null;
    const wants = engine.wantsPoint();
    if (wants && base && (t.ortho || t.polar)) {
      const c = G.constrain(base, raw, t.ortho ? 'ortho' : 'polar', prefs.polarInc, 4);
      pt = c.pt; if (c.ang != null) track = { from: base, ang: c.ang };
    }
    if (wants && t.osnap) {
      const ap = apertureFor(ptype) / view.scale;
      const near = doc.queryVis(raw[0] - ap, raw[1] - ap, raw[0] + ap, raw[1] + ap);
      snap = G.findSnap(near, raw, ap, prefs.modes, base || engine.lastPoint);
      if (snap) { pt = snap.pt; track = null; }
    }
    if (wants && !snap && t.snap && !(base && (t.ortho || t.polar))) {
      const g = doc.d.gridSpacing || 10;
      pt = [Math.round(raw[0] / g) * g, Math.round(raw[1] / g) * g];
    }
    cur = { pt, raw, snap, track, screen: [sx, sy], active: true, ptype };
    engine.setCursor(pt);
    $('cad-coords').textContent = `X: ${fmt(pt[0])}  Y: ${fmt(pt[1])}`;
    requestDraw();
  }

  // ---- drawing ----
  function requestDraw() { if (rafPending || destroyed) return; rafPending = true; requestAnimationFrame(() => { rafPending = false; draw(); }); }
  function layerColor(e) { return CadStyle.colorHex(doc.d, e); }
  function tracePoly(c, e) {
    const segs = G.polySegments(e);
    if (!segs.length) return;
    const p0 = w2s(segs[0].p1);
    c.moveTo(p0[0], p0[1]);
    for (const s of segs) {
      if (s.k === 's') { const q = w2s(s.p2); c.lineTo(q[0], q[1]); }
      else {
        const ce = w2s(s.c), r = s.r * view.scale;
        if (s.bulge > 0) c.arc(ce[0], ce[1], r, -s.a0, -s.a1, true); else c.arc(ce[0], ce[1], r, -s.a1, -s.a0, false);
      }
    }
    if (e.closed) c.closePath();
  }
  function drawText(c, p, rot, h, str, align) {
    const px = h * view.scale, o = w2s(p);
    if (px < 2.5) { c.beginPath(); c.moveTo(o[0], o[1]); c.lineTo(o[0] + Math.cos(rot) * Math.max(str.length * px * 0.58, 4), o[1] - Math.sin(rot) * Math.max(str.length * px * 0.58, 4)); c.stroke(); return; }
    c.save(); c.translate(o[0], o[1]); c.rotate(-rot);
    c.font = `${px}px -apple-system, system-ui, "Helvetica Neue", Arial, sans-serif`; c.textAlign = align || 'left'; c.textBaseline = 'alphabetic';
    c.fillText(str, 0, 0); c.restore();
  }
  function polyPath(c, pts) { c.beginPath(); pts.forEach((q, i) => { const s = w2s(q); if (i) c.lineTo(s[0], s[1]); else c.moveTo(s[0], s[1]); }); c.closePath(); }
  function drawAnno(c, e, mode) {
    if (e.t === 'TEXT' || e.t === 'MTEXT') {
      if (mode === 'sel') { polyPath(c, CadDim.textCorners(e)); c.stroke(); return; }
      if (e.t === 'TEXT') drawText(c, e.p, e.rot || 0, e.h, e.text || '');
      else {
        const cs = Math.cos(e.rot || 0), sn = Math.sin(e.rot || 0);
        CadDim.mtextLines(e).forEach((ln, i) => { const y = -(i * CadDim.LH * e.h) - e.h; drawText(c, [e.p[0] - y * sn, e.p[1] + y * cs], e.rot || 0, e.h, ln); });
      }
      return;
    }
    const g = CadDim.geom(e);
    c.beginPath();
    for (const [a, b] of g.lines) { const A = w2s(a), B = w2s(b); c.moveTo(A[0], A[1]); c.lineTo(B[0], B[1]); }
    c.stroke();
    for (const ar of g.arrows) {
      const n = [-ar.dir[1], ar.dir[0]], base = [ar.tip[0] + ar.dir[0] * ar.size, ar.tip[1] + ar.dir[1] * ar.size], w = ar.size / 3;
      const t = w2s(ar.tip), b1 = w2s([base[0] + n[0] * w, base[1] + n[1] * w]), b2 = w2s([base[0] - n[0] * w, base[1] - n[1] * w]);
      c.beginPath(); c.moveTo(t[0], t[1]); c.lineTo(b1[0], b1[1]); c.lineTo(b2[0], b2[1]); c.closePath(); c.fill();
    }
    if (mode === 'sel') { polyPath(c, CadDim.textBoxOf(e)); c.stroke(); }
    else drawText(c, g.text.p, g.text.rot, g.text.h, g.text.str, 'center');
  }
  function drawSym(c, e, mode) {
    for (const sh of CadSym.shapes(e)) {
      c.beginPath(); sh.pts.forEach((q, i) => { const p = w2s(q); if (i) c.lineTo(p[0], p[1]); else c.moveTo(p[0], p[1]); });
      if (sh.closed) c.closePath();
      if (sh.fill && mode !== 'sel') c.fill(); else c.stroke();
    }
  }
  // Stencil picker: thumbnails of every symbol, tap one to start placing it.
  function openStencils() {
    if (engine.active) engine.cancel();
    const cur = (engine.sym && engine.sym.name) || 'Tree';
    const svg = (name) => {
      const sh = CadSym.preview(name, 7);
      const d = sh.map((q) => (q.fill ? `<path d="M${q.pts.map((p) => p[0].toFixed(3) + ' ' + (-p[1]).toFixed(3)).join(' L')} Z" fill="currentColor"/>` : `<path d="M${q.pts.map((p) => p[0].toFixed(3) + ' ' + (-p[1]).toFixed(3)).join(' L')}${q.closed ? ' Z' : ''}" fill="none" stroke="currentColor" stroke-width="0.035" stroke-linejoin="round" stroke-linecap="round"/>`)).join('');
      return `<svg viewBox="-0.6 -0.6 1.2 1.2" width="64" height="64" style="color:#22252b">${d}</svg>`;
    };
    const sheet = el(`<div class="sheet-backdrop"><div class="sheet" style="max-height:86vh;overflow:auto"><div class="sheet-handle"></div>
      <h2>Stencils</h2><div style="font-size:13px;color:#6b717c;margin-bottom:8px">Tap a symbol, then tap the drawing to place it. Use the Size and Rotate options while placing. Real-world symbols are sized in metres; the north arrow and water level are sized on paper.</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(96px,1fr));gap:8px">${CadSym.NAMES.map((n) => `<button class="btn" data-sym="${n}" style="display:flex;flex-direction:column;align-items:center;gap:2px;padding:8px 4px;${n === cur ? 'outline:2px solid #1565c0' : ''}">${svg(n)}<span style="font-size:12px">${esc(CadSym.SYMBOLS[n].label)}</span></button>`).join('')}</div>
      <div style="display:flex;gap:10px;margin-top:12px"><button class="btn btn-block" id="st-cancel">Cancel</button></div></div></div>`);
    presentOverlay(sheet);
    sheet.querySelector('#st-cancel').addEventListener('click', () => sheet.remove());
    sheet.querySelectorAll('[data-sym]').forEach((b) => b.addEventListener('click', () => {
      engine.sym = engine.sym || { name: 'Tree', rot: 0, size: null };
      if (engine.sym.name !== b.dataset.sym) { engine.sym.name = b.dataset.sym; engine.sym.size = null; }
      sheet.remove(); engine.start('SYMBOL'); refreshUI(); requestDraw();
    }));
  }
  // Hatch: solid or pattern lines in the entity colour. Selected hatches show their boundary instead.
  function hatchPath(c, e) { c.beginPath(); for (const l of e.loops) tracePoly(c, { v: l, closed: true }); }
  function drawHatch(c, e, mode) {
    if (mode === 'sel') { hatchPath(c, e); c.stroke(); return; }
    const pat = CadHatch.PATTERNS[e.pat] || CadHatch.PATTERNS.Lines;
    if (pat.solid) { hatchPath(c, e); c.fill('evenodd'); return; }
    const unit = (e.pk || 1) * (e.sc || 1) * view.scale;                 // screen px per paper mm of pattern
    const minSp = pat.fam ? Math.min(...pat.fam.map((f) => f.sp)) : 1.6;
    if (minSp * unit < 2.2) {                                             // too dense to resolve: show a tint
      c.save(); c.globalAlpha = 0.35; hatchPath(c, e); c.fill('evenodd'); c.restore(); return;
    }
    const tl = s2w(0, 0), br = s2w(W, H), segs = CadHatch.segments(e);
    c.beginPath();
    for (const q of segs) {
      const a = q[0], b = q[1];
      if ((a[0] < tl[0] && b[0] < tl[0]) || (a[0] > br[0] && b[0] > br[0]) || (a[1] > tl[1] && b[1] > tl[1]) || (a[1] < br[1] && b[1] < br[1])) continue;
      const p = w2s(a), r = w2s(b); c.moveTo(p[0], p[1]); c.lineTo(r[0], r[1]);
    }
    c.stroke();
  }
  function drawEntity(c, e, mode) {
    if (e.t === 'TEXT' || e.t === 'MTEXT' || e.t === 'DIM') { drawAnno(c, e, mode); return; }
    if (e.t === 'HATCH') { drawHatch(c, e, mode); return; }
    if (e.t === 'SYM') { drawSym(c, e, mode); return; }
    c.beginPath();
    if (e.t === 'LINE') { const a = w2s(e.p1), b = w2s(e.p2); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); }
    else if (e.t === 'CIRCLE') { const ce = w2s(e.c); c.arc(ce[0], ce[1], e.r * view.scale, 0, Math.PI * 2); }
    else if (e.t === 'ARC') { const ce = w2s(e.c); c.arc(ce[0], ce[1], e.r * view.scale, -e.a0, -e.a1, true); }
    else if (e.t === 'LWPOLYLINE') tracePoly(c, e);
    else if (e.t === 'POINT') {
      const p = w2s(e.p);
      c.moveTo(p[0] - 5, p[1]); c.lineTo(p[0] + 5, p[1]); c.moveTo(p[0], p[1] - 5); c.lineTo(p[0], p[1] + 5);
      c.moveTo(p[0] + 3, p[1]); c.arc(p[0], p[1], 3, 0, Math.PI * 2);
    }
    c.stroke();
  }
  function drawGrid(c) {
    const g0 = doc.d.gridSpacing || 10;
    let step = g0, px = step * view.scale, guard = 0;
    while (px < 12 && guard++ < 12) { step *= 10; px = step * view.scale; }
    const tl = s2w(0, 0), br = s2w(W, H);
    const x0 = Math.floor(tl[0] / step) * step, y0 = Math.floor(br[1] / step) * step;
    const nx = Math.ceil((br[0] - x0) / step), ny = Math.ceil((tl[1] - y0) / step);
    if (nx > 400 || ny > 400) return;
    c.lineWidth = 1;
    for (let i = 0; i <= nx; i++) {
      const x = x0 + i * step, sx = Math.round(w2s([x, 0])[0]) + 0.5;
      c.strokeStyle = Math.abs(Math.round(x / step) % 10) === 0 ? '#d4d6da' : '#eceef1';
      c.beginPath(); c.moveTo(sx, 0); c.lineTo(sx, H); c.stroke();
    }
    for (let j = 0; j <= ny; j++) {
      const y = y0 + j * step, sy = Math.round(w2s([0, y])[1]) + 0.5;
      c.strokeStyle = Math.abs(Math.round(y / step) % 10) === 0 ? '#d4d6da' : '#eceef1';
      c.beginPath(); c.moveTo(0, sy); c.lineTo(W, sy); c.stroke();
    }
  }
  function snapMarker(c, sn, sxy) {
    const x = sxy[0], y = sxy[1], s = 7;
    c.strokeStyle = '#c77700'; c.fillStyle = 'rgba(255,255,255,0.0)'; c.lineWidth = 2.2; c.setLineDash([]);
    c.beginPath();
    switch (sn.type) {
      case 'end': c.rect(x - s, y - s, 2 * s, 2 * s); break;
      case 'mid': c.moveTo(x, y - s); c.lineTo(x + s, y + s); c.lineTo(x - s, y + s); c.closePath(); break;
      case 'cen': c.arc(x, y, s, 0, Math.PI * 2); break;
      case 'gcen': c.arc(x, y, s, 0, Math.PI * 2); c.moveTo(x - 3, y); c.lineTo(x + 3, y); break;
      case 'node': c.arc(x, y, s, 0, Math.PI * 2); c.moveTo(x - s, y - s); c.lineTo(x + s, y + s); c.moveTo(x + s, y - s); c.lineTo(x - s, y + s); break;
      case 'quad': c.moveTo(x, y - s - 1); c.lineTo(x + s + 1, y); c.lineTo(x, y + s + 1); c.lineTo(x - s - 1, y); c.closePath(); break;
      case 'int': c.moveTo(x - s, y - s); c.lineTo(x + s, y + s); c.moveTo(x + s, y - s); c.lineTo(x - s, y + s); break;
      case 'per': c.moveTo(x - s, y - s); c.lineTo(x - s, y + s); c.lineTo(x + s, y + s); c.moveTo(x - s, y); c.lineTo(x, y); c.lineTo(x, y + s); break;
      case 'tan': c.arc(x, y, s - 1, 0, Math.PI * 2); c.moveTo(x - s - 2, y - s - 1); c.lineTo(x + s + 2, y - s - 1); break;
      default: c.moveTo(x - s, y - s); c.lineTo(x + s, y - s); c.lineTo(x - s, y + s); c.lineTo(x + s, y + s); c.closePath();
    }
    c.stroke();
    c.font = '600 11.5px -apple-system, system-ui, sans-serif';
    const label = CAD_SNAP_NAMES[sn.type] || '';
    const tw = c.measureText(label).width;
    c.fillStyle = 'rgba(255,255,255,0.92)'; c.fillRect(x + 12, y + 10, tw + 8, 17);
    c.fillStyle = '#6b4300'; c.fillText(label, x + 16, y + 23);
  }
  function draw() {
    if (destroyed) return;
    const c = ctx2;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.fillStyle = '#ffffff'; c.fillRect(0, 0, W, H);
    if (prefs.toggles.grid) drawGrid(c);
    drawUnderlays(c);
    // origin marker
    const o = w2s([0, 0]);
    c.strokeStyle = '#b9bdc4'; c.lineWidth = 1; c.beginPath(); c.moveTo(o[0] - 10, o[1]); c.lineTo(o[0] + 10, o[1]); c.moveTo(o[0], o[1] - 10); c.lineTo(o[0], o[1] + 10); c.stroke();
    // entities in view
    const tl = s2w(0, 0), br = s2w(W, H);
    const vis = doc.queryVis(tl[0], br[1], br[0], tl[1]);
    c.lineWidth = 1.6; c.lineJoin = 'round'; c.lineCap = 'round';
    const lwt = prefs.toggles.lwt !== false;
    for (const e of vis) {
      if (e.t !== 'HATCH') continue;
      c.strokeStyle = layerColor(e); c.fillStyle = c.strokeStyle;
      c.lineWidth = lwt ? Math.max(1, (e.lw != null || CadStyle.layerOf(doc.d, e.layer) && CadStyle.layerOf(doc.d, e.layer).lw >= 0 ? CadStyle.lwMm(doc.d, e) : 0.13) * 3.78 * 1.3) : 1;
      drawHatch(c, e);
    }
    for (const e of vis) {
      if (e.t === 'HATCH') continue;
      c.strokeStyle = layerColor(e); c.fillStyle = c.strokeStyle;
      c.lineWidth = lwt ? Math.max(1.2, CadStyle.lwMm(doc.d, e) * 3.78 * 1.3) : 1.6;
      const lt = (e.t === 'DIM' || e.t === 'POINT' || e.t === 'SYM') ? 'Continuous' : CadStyle.ltypeName(doc.d, e);
      if (lt !== 'Continuous') { const pat = CadStyle.dashModel(doc.d, lt).map((v) => Math.max(1, v * view.scale)); c.setLineDash(pat); }
      drawEntity(c, e);
      if (lt !== 'Continuous') c.setLineDash([]);
    }
    c.lineWidth = 1.6;
    // selection
    if (engine.selection.size) {
      c.strokeStyle = '#1565c0'; c.lineWidth = 2.6; c.setLineDash([7, 4]);
      for (const id of engine.selection) { const e = doc.byId.get(id); if (e) drawEntity(c, e, 'sel'); }
      c.setLineDash([]); c.lineWidth = 1.6;
    }
    if (engine.overlay && engine.overlay.length) {
      c.strokeStyle = '#e65100'; c.fillStyle = '#e65100'; c.lineWidth = 2.6; c.setLineDash([2, 5]);
      for (const e of engine.overlay) drawEntity(c, e, 'sel');
      c.setLineDash([]); c.lineWidth = 1.6;
    }
    // grips on the idle selection
    if (!engine.active && engine.selection.size && engine.selection.size <= 50) {
      c.lineWidth = 1.2;
      for (const id of engine.selection) {
        const e = doc.byId.get(id); if (!e) continue;
        for (const g of CadEdit.grips(e)) {
          const sp = w2s(g.pt), sz = g.kind === 'mid' ? 6 : 9;
          c.fillStyle = g.kind === 'mid' ? '#7aa7e0' : '#1565c0'; c.strokeStyle = '#ffffff';
          c.fillRect(sp[0] - sz / 2, sp[1] - sz / 2, sz, sz); c.strokeRect(sp[0] - sz / 2, sp[1] - sz / 2, sz, sz);
        }
      }
      c.lineWidth = 1.6;
    }
    // tracking line
    if (cur.active && cur.track) {
      const a = w2s(cur.track.from), far = G.polar(cur.track.from, cur.track.ang, 1e6 / view.scale), b = w2s(far);
      c.strokeStyle = 'rgba(21,101,192,0.55)'; c.lineWidth = 1; c.setLineDash([4, 4]);
      c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); c.stroke(); c.setLineDash([]);
    }
    // rubber band preview
    if (cur.active && cur.pt && engine.prompt) {
      const pv = engine.preview(cur.pt);
      if (pv.length) {
        c.strokeStyle = '#1565c0'; c.fillStyle = '#1565c0'; c.lineWidth = 1.6; c.setLineDash([6, 4]);
        for (const e of pv) drawEntity(c, e, 'pv');
        c.setLineDash([]);
      }
    }
    // base point marker and displacement line for the modify commands, so it is clear where the move is anchored
    if (cur.active && cur.pt && engine.wantsPoint() && ['MOVE', 'COPY', 'ROTATE', 'SCALE', 'STRETCH', 'MIRROR', 'GRIP'].includes(engine.active)) {
      const bp = engine.base();
      if (bp) {
        const a = w2s(bp), b = w2s(cur.pt);
        c.strokeStyle = 'rgba(21,101,192,0.7)'; c.lineWidth = 1; c.setLineDash([2, 4]);
        c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); c.stroke(); c.setLineDash([]);
        c.strokeStyle = '#1565c0'; c.lineWidth = 2; c.beginPath(); c.arc(a[0], a[1], 5, 0, Math.PI * 2); c.moveTo(a[0] - 8, a[1]); c.lineTo(a[0] + 8, a[1]); c.moveTo(a[0], a[1] - 8); c.lineTo(a[0], a[1] + 8); c.stroke(); c.lineWidth = 1.6;
      }
    }
    // selection window
    if (windowRect) {
      const [a, b] = windowRect, crossing = b[0] < a[0];
      c.fillStyle = crossing ? 'rgba(46,158,68,0.12)' : 'rgba(21,101,192,0.12)';
      c.strokeStyle = crossing ? '#2e9e44' : '#1565c0'; c.lineWidth = 1.2; c.setLineDash(crossing ? [6, 4] : []);
      c.fillRect(a[0], a[1], b[0] - a[0], b[1] - a[1]); c.strokeRect(a[0], a[1], b[0] - a[0], b[1] - a[1]); c.setLineDash([]);
    }
    // cursor
    if (cur.active && cur.pt) {
      const sp = w2s(cur.pt);
      c.strokeStyle = 'rgba(30,30,30,0.7)'; c.lineWidth = 1;
      c.beginPath(); c.moveTo(sp[0] - 18, sp[1]); c.lineTo(sp[0] + 18, sp[1]); c.moveTo(sp[0], sp[1] - 18); c.lineTo(sp[0], sp[1] + 18); c.stroke();
      if (cur.snap) snapMarker(c, cur.snap, sp);
      const base = engine.base();
      if (prefs.toggles.dyn && base && engine.wantsPoint() && G.dist(base, cur.pt) > 1e-9) {
        const d = G.dist(base, cur.pt), a = (G.deg(G.angleBetween(base, cur.pt)) + 360) % 360;
        const text = engine.prompt.kind === 'number' ? fmt(d) : `${fmt(d)}  ∠ ${a.toFixed(1)}°`;
        c.font = '600 12.5px -apple-system, system-ui, sans-serif';
        const tw = c.measureText(text).width, tx = Math.min(W - tw - 14, sp[0] + 16), ty = Math.max(24, sp[1] - 16);
        c.fillStyle = 'rgba(25,28,35,0.88)'; c.beginPath(); c.roundRect ? c.roundRect(tx - 6, ty - 15, tw + 12, 21, 5) : c.rect(tx - 6, ty - 15, tw + 12, 21); c.fill();
        c.fillStyle = '#fff'; c.fillText(text, tx, ty);
      }
    }
  }

  // ---- underlays: picture behind the drawing ----
  const ulImages = new Map();                       // assetId -> { img, url } once loaded
  function ulLoad(u) {
    if (ulImages.has(u.assetId)) return ulImages.get(u.assetId);
    const rec = { img: null, url: null, failed: false }; ulImages.set(u.assetId, rec);
    DB.getCadAsset(u.assetId).then((a) => {
      if (!a || !a.blob || destroyed) { rec.failed = true; return; }
      rec.url = URL.createObjectURL(a.blob); const im = new Image();
      im.onload = () => { rec.img = im; requestDraw(); }; im.onerror = () => { rec.failed = true; }; im.src = rec.url;
    }).catch(() => { rec.failed = true; });
    return rec;
  }
  function drawUnderlays(c) {
    for (const u of (doc.d.underlays || [])) {
      if (u.on === false) continue;
      const rec = ulLoad(u); if (!rec.img) continue;
      const o = w2s([u.x, u.y]);
      c.save(); c.globalAlpha = u.opacity == null ? 0.5 : u.opacity; c.translate(o[0], o[1]); c.rotate(-(u.rot || 0)); c.scale(view.scale, view.scale);
      c.drawImage(rec.img, 0, -u.h, u.w, u.h); c.restore();
    }
  }
  async function cadFileToUnderlayImage(file) {
    const MAX = 3200;
    if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
      await loadPdfJs();
      const pdf = await window.pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
      let pageNo = 1;
      if (pdf.numPages > 1) {
        const v = prompt(`This PDF has ${pdf.numPages} pages. Which page should be the underlay?`, '1'); if (v === null) return null;
        pageNo = Math.max(1, Math.min(pdf.numPages, parseInt(v, 10) || 1));
      }
      const page = await pdf.getPage(pageNo), vp1 = page.getViewport({ scale: 1 }), sc = MAX / Math.max(vp1.width, vp1.height), vp = page.getViewport({ scale: sc });
      const cv = document.createElement('canvas'); cv.width = Math.round(vp.width); cv.height = Math.round(vp.height);
      const g2 = cv.getContext('2d'); g2.fillStyle = '#fff'; g2.fillRect(0, 0, cv.width, cv.height);
      await page.render({ canvasContext: g2, viewport: vp }).promise;
      return { blob: await new Promise((r) => cv.toBlob(r, 'image/jpeg', 0.92)), w: cv.width, h: cv.height, name: file.name + (pdf.numPages > 1 ? ' p' + pageNo : '') };
    }
    const bmp = await createImageBitmap(file), k = Math.min(1, MAX / Math.max(bmp.width, bmp.height));
    const cv = document.createElement('canvas'); cv.width = Math.round(bmp.width * k); cv.height = Math.round(bmp.height * k);
    const g2 = cv.getContext('2d'); g2.fillStyle = '#fff'; g2.fillRect(0, 0, cv.width, cv.height); g2.drawImage(bmp, 0, 0, cv.width, cv.height);
    return { blob: await new Promise((r) => cv.toBlob(r, 'image/jpeg', 0.9)), w: cv.width, h: cv.height, name: file.name };
  }
  function pickUnderlayFile(onDone) {
    const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/*,application/pdf,.pdf';
    inp.addEventListener('change', async () => {
      const f = inp.files && inp.files[0]; if (!f) return;
      try {
        toast('Loading underlay…');
        const r = await cadFileToUnderlayImage(f); if (!r) return;
        const a = await DB.addCadAsset(doc.d.id, r.blob, r.name, r.w, r.h);
        const wm = (W / view.scale) * 0.7, hm = wm * r.h / r.w;
        const u = { id: 'u' + Date.now().toString(36), assetId: a.id, name: r.name, x: view.cx - wm / 2, y: view.cy - hm / 2, w: wm, h: hm, rot: 0, opacity: 0.5, on: true, iw: r.w, ih: r.h };
        doc.setUnderlays((doc.d.underlays || []).concat([u]));
        pushView(); fitBox(allBox(), 0.9); requestDraw();
        toast('Underlay added. Use Calibrate to set its real scale.');
        if (onDone) onDone();
      } catch (err) { console.error(err); toast('Could not load that file' + (/PDF/.test(err.message) ? ': connect to the internet once to load the PDF reader.' : '.')); }
    });
    inp.click();
  }
  function openUnderlays() {
    if (engine.active) { toast('Finish or cancel the current command first.'); return; }
    const sheet = el('<div class="sheet-backdrop"><div class="sheet" style="max-height:86vh;overflow:auto"><div class="sheet-handle"></div><h2>Underlays</h2><p class="muted" style="font-size:13px;margin:0 0 8px">A photo or PDF page behind your drawing to trace over. Add it, then Calibrate: pick two points on it and type the real distance.</p><div id="ul-list"></div><button class="btn btn-secondary btn-block" id="ul-add" style="margin:8px 0">+ Add photo or PDF</button><button class="btn btn-primary btn-block" id="ul-done">Done</button></div></div>');
    presentOverlay(sheet);
    const list = sheet.querySelector('#ul-list');
    function render() {
      const us = doc.d.underlays || [];
      list.innerHTML = us.length ? us.map((u) => `<div class="ul-row" data-id="${u.id}">
        <div style="display:flex;align-items:center;gap:6px"><b style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(u.name)}</b>
          <button class="ly-b ${u.on !== false ? 'on' : ''}" data-a="on" title="Show or hide">${u.on !== false ? '👁' : '–'}</button><button class="ly-b" data-a="del" title="Remove">🗑</button></div>
        <div style="display:flex;align-items:center;gap:8px;margin:6px 0"><span style="font-size:13px;color:#6b717c">Fade</span><input type="range" min="10" max="100" value="${Math.round((u.opacity == null ? 0.5 : u.opacity) * 100)}" data-a="op" style="flex:1"></div>
        <div style="display:flex;gap:6px"><button class="btn btn-secondary" data-a="cal" style="flex:1">Calibrate</button><button class="btn btn-secondary" data-a="mv" style="flex:1">Move</button><button class="btn btn-secondary" data-a="rot" style="flex:1">Rotate</button></div>
        <div style="font-size:12px;color:#6b717c;margin-top:4px">${fmt(u.w)} × ${fmt(u.h)} ${esc(unit.label)}</div></div>`).join('') : '<p class="muted">No underlay yet.</p>';
    }
    list.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-a]'); if (!b || b.type === 'range') return; const row = b.closest('.ul-row'), id = row.dataset.id, a = b.dataset.a;
      if (a === 'on') { const u = doc.underlay(id); doc.patchUnderlay(id, { on: u.on === false }); render(); requestDraw(); }
      else if (a === 'del') { if (confirm('Remove this underlay from the drawing?')) { const u = doc.underlay(id); doc.setUnderlays(doc.d.underlays.filter((x) => x.id !== id)); render(); requestDraw(); } }
      else { sheet.remove(); engine.start(a === 'cal' ? 'CALIBRATE' : a === 'mv' ? 'UMOVE' : 'UROTATE', { ul: id }); }
    });
    // fade is a display setting: no undo step, just saved with the drawing
    list.addEventListener('input', (ev) => { const r = ev.target.closest('input[data-a="op"]'); if (r) { const u = doc.underlay(r.closest('.ul-row').dataset.id); if (u) { u.opacity = +r.value / 100; markDirty(); requestDraw(); } } });
    sheet.querySelector('#ul-add').addEventListener('click', () => pickUnderlayFile(() => { render(); }));
    const close = () => { sheet.remove(); refreshUI(); requestDraw(); };
    sheet.addEventListener('click', (e) => { if (e.target === sheet) close(); });
    sheet.querySelector('#ul-done').addEventListener('click', close);
    render();
  }

  // ---- text prompts: single line goes to the command line, multi-line opens a sheet ----
  let lastTextPrompt = null;
  function textPromptUI() {
    const p = engine.prompt;
    if (!engine.active || !p || p.kind !== 'text') { lastTextPrompt = null; return; }
    if (p === lastTextPrompt) return;
    lastTextPrompt = p;
    if (!p.multiline) { cmdInput.value = p.current || ''; setTimeout(() => { cmdInput.focus(); cmdInput.select(); }, 30); return; }
    const sheet = el(`<div class="sheet-backdrop"><div class="sheet"><div class="sheet-handle"></div><h2>${esc(p.msg || 'Text')}</h2>
      <div class="field"><textarea id="cad-mt" rows="6" style="width:100%;font-size:17px;-webkit-user-select:text;user-select:text">${esc(p.current || '')}</textarea></div>
      <div class="row" style="display:flex;gap:10px"><button class="btn btn-block" id="mt-cancel">Cancel</button><button class="btn btn-primary btn-block" id="mt-ok">OK</button></div></div></div>`);
    presentOverlay(sheet);
    const ta = sheet.querySelector('#cad-mt'); setTimeout(() => ta.focus(), 50);
    sheet.querySelector('#mt-cancel').addEventListener('click', () => { sheet.remove(); engine.cancel(); });
    sheet.querySelector('#mt-ok').addEventListener('click', () => { const v = ta.value; sheet.remove(); engine.submitText(v.trim() ? v : ''); refreshUI(); });
  }

  // ---- layers ----
  const ACI_NAMES = { 1: 'Red', 2: 'Yellow', 3: 'Green', 4: 'Cyan', 5: 'Blue', 6: 'Magenta', 7: 'Black', 8: 'Dark grey', 9: 'Light grey' };
  function openLayers() {
    if (engine.active) { toast('Finish or cancel the current command first.'); return; }
    const sheet = el('<div class="sheet-backdrop"><div class="sheet" style="max-height:86vh;overflow:auto"><div class="sheet-handle"></div><h2>Layers</h2><div id="ly-list"></div><button class="btn btn-block" id="ly-add" style="margin:8px 0">+ New layer</button><button class="btn btn-primary btn-block" id="ly-done">Done</button></div></div>');
    presentOverlay(sheet);
    const list = sheet.querySelector('#ly-list');
    const cloneLayers = () => JSON.parse(JSON.stringify(doc.d.layers));
    const change = (name, patch) => { const ls = cloneLayers(); const l = ls.find((x) => x.name === name); Object.assign(l, patch); doc.setLayers(ls, null); engine.selection = new Set(Array.from(engine.selection).filter((id) => { const e = doc.byId.get(id); return e && doc.isSelectable(e); })); render(); };
    let openDetail = null;
    function render() {
      list.innerHTML = doc.d.layers.map((l) => `<div class="ly-row" data-n="${esc(l.name)}">
        <button class="ly-cur ${doc.d.currentLayer === l.name ? 'on' : ''}" data-a="cur" title="Make current">${doc.d.currentLayer === l.name ? '●' : '○'}</button>
        <button class="ly-dotb" data-a="det" title="Colour, line type, line weight"><span class="ly-dot" style="background:${CadStyle.layerHex(l)}"></span></button>
        <input class="ly-name" value="${esc(l.name)}" ${l.name === '0' ? 'readonly' : ''}>
        <button class="ly-b ${openDetail === l.name ? 'on' : ''}" data-a="det" title="Style">⋯</button>
        <button class="ly-b ${l.on !== false ? 'on' : ''}" data-a="on" title="Show or hide">${l.on !== false ? '👁' : '–'}</button>
        <button class="ly-b ${l.frozen ? 'on' : ''}" data-a="fr" title="Freeze">❄</button>
        <button class="ly-b ${l.locked ? 'on' : ''}" data-a="lk" title="Lock">${l.locked ? '🔒' : '🔓'}</button>
        <button class="ly-b" data-a="del" title="Delete layer" ${l.name === '0' ? 'disabled' : ''}>🗑</button></div>
        ${openDetail === l.name ? `<div class="ly-det" data-n="${esc(l.name)}">
          <label>Colour <select class="ly-d-col">${Object.keys(ACI_NAMES).map((k) => `<option value="${k}" ${!l.rgb && +k === l.color ? 'selected' : ''}>${ACI_NAMES[k]}</option>`).join('')}<option value="custom" ${l.rgb ? 'selected' : ''}>Custom…</option></select>
            <input type="color" class="ly-d-rgb" value="${l.rgb || CadStyle.layerHex(l)}" style="${l.rgb ? '' : 'opacity:.55'}"></label>
          <label>Line type <select class="ly-d-lt">${cadLtOptions(l.ltype || 'Continuous', false)}</select></label>
          <label>Line weight <select class="ly-d-lw">${cadLwOptions(l.lw == null ? -3 : l.lw, false, 'Default (' + (doc.d.defaultLw || 0.25).toFixed(2) + ' mm)')}</select></label>
          <label class="ly-d-plot"><input type="checkbox" class="ly-d-pl" ${l.plot !== false ? 'checked' : ''}> Plot this layer</label>
        </div>` : ''}`).join('');
    }
    list.addEventListener('click', (ev) => {
      const b = ev.target.closest('button[data-a]'); if (!b) return;
      const n = b.closest('.ly-row').dataset.n, l = doc.layer(n), a = b.dataset.a;
      if (a === 'cur') { if (!l.frozen && l.on !== false) { doc.setLayers(cloneLayers(), n); render(); refreshUI(); } else toast('A hidden or frozen layer cannot be current.'); }
      else if (a === 'on') change(n, { on: l.on === false });
      else if (a === 'fr') { if (!l.frozen && doc.d.currentLayer === n) { toast('The current layer cannot be frozen.'); return; } change(n, { frozen: !l.frozen }); }
      else if (a === 'lk') change(n, { locked: !l.locked });
      else if (a === 'del') { const err = doc.deleteLayer(n); if (err) toast(err); render(); refreshUI(); }
      else if (a === 'det') { openDetail = openDetail === n ? null : n; render(); }
    });
    list.addEventListener('change', (ev) => {
      const det = ev.target.closest('.ly-det');
      if (det) {
        const n = det.dataset.n, cl = ev.target.classList, v = ev.target.value;
        if (cl.contains('ly-d-col')) { if (v === 'custom') { const l = doc.layer(n); change(n, { rgb: CadStyle.layerHex(l) }); } else change(n, { color: +v, rgb: undefined }); }
        else if (cl.contains('ly-d-rgb')) { const h = CadStyle.normHex(v); if (h) change(n, { rgb: h, color: CadStyle.nearestAci(h) }); }
        else if (cl.contains('ly-d-lt')) change(n, { ltype: v });
        else if (cl.contains('ly-d-lw')) change(n, { lw: parseInt(v, 10) });
        else if (cl.contains('ly-d-pl')) change(n, { plot: ev.target.checked });
        return;
      }
      const row = ev.target.closest('.ly-row'); if (!row) return; const n = row.dataset.n;
      if (false) { }
      else if (ev.target.classList.contains('ly-name')) {
        const nn = ev.target.value.trim();
        if (nn === n) return;
        if (!nn || !doc.renameLayer(n, nn)) { toast(nn ? 'That layer name is taken.' : 'A layer needs a name.'); }
        render(); refreshUI();
      }
    });
    sheet.querySelector('#ly-add').addEventListener('click', () => {
      let i = doc.d.layers.length, nm; do { nm = 'Layer' + i++; } while (doc.layer(nm));
      const cur = doc.layer(doc.d.currentLayer) || {};
      doc.setLayers(cloneLayers().concat([{ name: nm, color: cur.color || 7, ltype: 'Continuous', lw: -3, on: true, frozen: false, locked: false, plot: true }]), nm); render(); refreshUI();
    });
    const close = () => { sheet.remove(); refreshUI(); requestDraw(); };
    sheet.addEventListener('click', (e) => { if (e.target === sheet) close(); });
    sheet.querySelector('#ly-done').addEventListener('click', close);
    render();
  }
  $('cad-layer').addEventListener('click', openLayers);

  // ---- properties of the selection ----
  function openProperties() {
    const ids = Array.from(engine.selection).filter((id) => { const e = doc.byId.get(id); return e && doc.isSelectable(e); });
    if (!ids.length) { toast('Select objects first, then open Properties.'); return; }
    if (engine.active) { toast('Finish or cancel the current command first.'); return; }
    const ents = ids.map((id) => doc.byId.get(id)), one = ents.length === 1 ? ents[0] : null;
    const same = (f) => (ents.every((e) => f(e) === f(ents[0])) ? f(ents[0]) : '*');
    const lay = same((e) => e.layer), col = same((e) => (e.rgb ? 'c:' + e.rgb : e.color == null ? 'by' : String(e.color)));
    const ltS = same((e) => e.lt || ''), lwS = same((e) => (e.lw == null ? '' : String(e.lw)));
    const rgb0 = one && one.rgb ? one.rgb : CadStyle.colorHex(doc.d, ents[0]);
    const isTxt = one && (one.t === 'TEXT' || one.t === 'MTEXT'), isDim = one && one.t === 'DIM', isHat = one && one.t === 'HATCH';
    const sheet = el(`<div class="sheet-backdrop"><div class="sheet" style="max-height:86vh;overflow:auto"><div class="sheet-handle"></div>
      <h2>Properties <span style="font-weight:500;font-size:14px;color:#6b717c">${ents.length} object${ents.length > 1 ? 's' : ''}${one ? ' · ' + one.t : ''}</span></h2>
      <div class="field"><label>Layer</label><select id="pp-layer">${lay === '*' ? '<option value="*">Various</option>' : ''}${doc.d.layers.map((l) => `<option ${l.name === lay ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select></div>
      <div class="field"><label>Colour</label><div style="display:flex;gap:8px"><select id="pp-color" style="flex:1">${col === '*' ? '<option value="*">Various</option>' : ''}<option value="by" ${col === 'by' ? 'selected' : ''}>ByLayer</option>${Object.keys(ACI_NAMES).map((k) => `<option value="${k}" ${col === k ? 'selected' : ''}>${ACI_NAMES[k]}</option>`).join('')}<option value="custom" ${col.startsWith('c:') ? 'selected' : ''}>Custom…</option></select><input type="color" id="pp-rgb" value="${rgb0}" style="width:56px;height:44px"></div></div>
      <div class="field"><label>Line type</label><select id="pp-lt">${ltS === '*' ? '<option value="*">Various</option>' : ''}${cadLtOptions(ltS === '*' ? '' : ltS, true)}</select></div>
      <div class="field"><label>Line weight</label><select id="pp-lw">${lwS === '*' ? '<option value="*">Various</option>' : ''}${cadLwOptions(lwS === '*' || lwS === '' ? null : parseInt(lwS, 10), true)}</select></div>
      ${isTxt ? `<div class="field"><label>Text</label><textarea id="pp-text" rows="${one.t === 'MTEXT' ? 4 : 2}" style="width:100%;font-size:16px;-webkit-user-select:text;user-select:text">${esc(one.text)}</textarea></div>
        <div class="field"><label>Height (${esc(unit.label)})</label><input type="number" id="pp-h" step="any" min="0" value="${+one.h.toFixed(4)}"></div>
        <div class="field"><label>Rotation (degrees)</label><input type="number" id="pp-rot" step="any" value="${+(((one.rot || 0) * 180 / Math.PI)).toFixed(3)}"></div>` : ''}
      ${isHat ? `<div class="field" style="font-size:13px;color:${one.det ? '#b3261e' : '#6b717c'}">${one.det ? 'Detached: the boundary was opened or erased, so the hatch kept its last shape.' : one.src ? 'Linked to its boundary: it follows when you edit the shape.' : 'Not linked to a boundary (it was moved on its own or copied).'}</div>
        <div class="field"><label>Hatch pattern</label><select id="pp-pat">${CadHatch.NAMES.map((n) => `<option value="${n}" ${n === one.pat ? 'selected' : ''}>${esc(CadHatch.PATTERNS[n].label)}</option>`).join('')}</select></div>
        <div class="field"><label>Pattern scale</label><input type="number" id="pp-hsc" step="any" min="0.01" value="${+(one.sc || 1).toFixed(4)}"></div>
        <div class="field"><label>Pattern angle (degrees)</label><input type="number" id="pp-hang" step="any" value="${+(((one.ang || 0) * 180 / Math.PI)).toFixed(3)}"></div>` : ''}
      ${isDim ? `<div class="field"><label>Dimension text (&lt;&gt; = measured value ${esc(CadDim.dimText({ ...one, txt: '' }))})</label><input type="text" id="pp-dim" value="${esc(one.txt || '<>')}"></div>` : ''}
      <div style="display:flex;gap:10px"><button class="btn btn-block" id="pp-cancel">Cancel</button><button class="btn btn-primary btn-block" id="pp-ok">Apply</button></div></div></div>`);
    presentOverlay(sheet);
    sheet.querySelector('#pp-cancel').addEventListener('click', () => sheet.remove());
    sheet.querySelector('#pp-ok').addEventListener('click', () => doc.transact(() => {
      const q = (id) => sheet.querySelector(id);
      const layerV = q('#pp-layer').value, colV = q('#pp-color').value;
      if (layerV !== '*' && layerV !== lay) doc.setProps(ids, { layer: layerV });
      const rgbV = CadStyle.normHex(q('#pp-rgb').value);
      if (colV === 'custom') { if (col !== 'c:' + rgbV) doc.setProps(ids, { rgb: rgbV, color: null }); }
      else if (colV !== '*' && colV !== col) doc.setProps(ids, { color: colV === 'by' ? null : +colV, rgb: null });
      const ltV = q('#pp-lt').value, lwV = q('#pp-lw').value;
      if (ltV !== '*' && ltV !== ltS) doc.setProps(ids, { lt: ltV === '' ? null : ltV });
      if (lwV !== '*' && lwV !== lwS) doc.setProps(ids, { lw: lwV === '' ? null : parseInt(lwV, 10) });
      if (isTxt) {
        const t = q('#pp-text').value.trim(), h = parseFloat(q('#pp-h').value), r = parseFloat(q('#pp-rot').value);
        const patch = {}; if (t && t !== one.text) patch.text = t; if (h > 0 && h !== one.h) patch.h = h; if (isFinite(r) && Math.abs(r * Math.PI / 180 - (one.rot || 0)) > 1e-9) patch.rot = r * Math.PI / 180;
        if (Object.keys(patch).length) doc.setProps([one.id], patch);
      }
      if (isHat) {
        const pat = q('#pp-pat').value, sc = parseFloat(q('#pp-hsc').value), an = parseFloat(q('#pp-hang').value) * Math.PI / 180, patch = {};
        if (pat !== one.pat) patch.pat = pat; if (sc > 0 && sc !== (one.sc || 1)) patch.sc = sc; if (isFinite(an) && Math.abs(an - (one.ang || 0)) > 1e-9) patch.ang = an;
        if (Object.keys(patch).length) doc.setProps([one.id], patch);
      }
      if (isDim) { const t = q('#pp-dim').value.trim(), cur = one.txt || '<>'; if (t && t !== cur) doc.setProps([one.id], { txt: t === '<>' ? null : t }); }
      sheet.remove(); engine.selection = new Set(Array.from(engine.selection).filter((id) => { const e = doc.byId.get(id); return e && doc.isSelectable(e); })); refreshUI(); requestDraw();
    }));
  }

  // ---- UI refresh ----
  function refreshUI() {
    if (destroyed) return;
    $('cad-prompt').textContent = engine.active ? engine.promptText() : 'Command:';
    const lines = engine.history.slice(-3);
    $('cad-hist').innerHTML = lines.map((l) => `<div>${esc(l)}</div>`).join('');
    // chips: option keywords during a command, command suggestions while typing
    const chips = $('cad-chips'); chips.innerHTML = '';
    if (engine.active && engine.prompt && engine.prompt.options && engine.prompt.options.length) {
      for (const o of engine.prompt.options) chips.appendChild(chipEl(o.name, () => { engine.option(o.name); }));
    } else if (!engine.active) {
      if (cmdInput.value.trim()) {
        for (const s of engine.suggest(cmdInput.value)) chips.appendChild(chipEl(s, () => { cmdInput.value = ''; engine.start(s); refreshUI(); }));
      } else if (engine.selection.size) {
        const n = engine.selection.size, count = document.createElement('span');
        count.className = 'cad-selcount'; count.textContent = n + ' selected'; chips.appendChild(count);
        const acts = [['Delete', 'ERASE'], ['Move', 'MOVE'], ['Copy', 'COPY'], ['Rotate', 'ROTATE'], ['Scale', 'SCALE'], ['Mirror', 'MIRROR']];
        if (Array.from(engine.selection).some((id) => { const e = doc.byId.get(id); return e && (e.t === 'LWPOLYLINE' || e.t === 'HATCH' || e.t === 'SYM'); })) acts.push(['Explode', 'EXPLODE']);
        for (const [label, cmd] of acts) chips.appendChild(chipEl(label, () => { engine.start(cmd); }));
        chips.appendChild(chipEl('Properties', () => openProperties()));
        if (Array.from(engine.selection).some((id) => { const e = doc.byId.get(id); return e && (e.t === 'TEXT' || e.t === 'MTEXT' || e.t === 'DIM'); })) chips.appendChild(chipEl('Edit text', () => engine.start('TEXTEDIT')));
        chips.appendChild(chipEl('Clear', () => engine.clearSelection()));
      }
    }
    if (engine.active && engine.wantsSelect()) chips.appendChild(chipEl('Done', () => engine.enter(), true));
    root.classList.toggle('cad-active', !!engine.active);
    const lb = $('cad-layer'); if (lb) lb.textContent = '▤ ' + doc.d.currentLayer;
    textPromptUI();
    document.querySelectorAll('.cad-tool').forEach((b) => b.classList.toggle('on', b.dataset.cmd === engine.active));
    $('cad-undo').disabled = !doc.undoStack.length && !engine.active;
    $('cad-redo').disabled = !doc.redoStack.length || !!engine.active;
    document.querySelectorAll('.cad-tog[data-t]').forEach((b) => b.classList.toggle('on', !!prefs.toggles[b.dataset.t]));
    $('cad-finger').textContent = prefs.finger === 'pan' ? '☝ Pan' : '☝ Draw';
    setSaveLabel();
  }
  function chipEl(label, fn, accent) {
    const b = document.createElement('button');
    b.className = 'cad-chip' + (accent ? ' accent' : ''); b.textContent = label;
    b.addEventListener('pointerdown', (e) => e.preventDefault());
    b.addEventListener('click', () => { fn(); });
    return b;
  }

  // ---- commands from UI ----
  function runCommand(name) { if (engine.active) engine.cancel(); engine.start(name); }
  function doUndo() {
    // Mid-command, Undo steps back one point (LINE / PLINE Undo option) instead of dropping the whole shape.
    if (engine.active) {
      const o = engine.prompt && engine.prompt.options && engine.prompt.options.find((x) => x.name === 'Undo');
      if (o) { engine.option('Undo'); refreshUI(); requestDraw(); return; }
      engine.cancel(); refreshUI(); requestDraw(); return;
    }
    engine.clearSelection(); doc.undo(); refreshUI(); requestDraw();
  }
  function doRedo() { if (engine.active) return; engine.clearSelection(); doc.redo(); refreshUI(); requestDraw(); }
  function toggle(k) {
    prefs.toggles[k] = !prefs.toggles[k];
    if (k === 'ortho' && prefs.toggles.ortho) prefs.toggles.polar = false;
    if (k === 'polar' && prefs.toggles.polar) prefs.toggles.ortho = false;
    cadSavePrefs(prefs); refreshUI(); requestDraw();
  }
  document.querySelectorAll('.cad-tool').forEach((b) => b.addEventListener('click', () => (b.dataset.cmd === 'SYMBOL' ? openStencils() : runCommand(b.dataset.cmd))));
  document.querySelectorAll('.cad-tog[data-t]').forEach((b) => b.addEventListener('click', () => { toggle(b.dataset.t); requestDraw(); }));
  $('cad-undo').addEventListener('click', doUndo);
  $('cad-redo').addEventListener('click', doRedo);
  $('cad-fit').addEventListener('click', zoomExtents);
  $('cad-export').addEventListener('click', () => { if (engine.active) engine.cancel(); cadOpenExportSheet(doc, markDirty); });
  $('cad-cancel').addEventListener('click', () => engine.cancel());
  $('cad-enter').addEventListener('click', () => submitCmd());
  $('cad-back').addEventListener('click', async () => { await save(); navigate('#/cad'); });
  $('cad-finger').addEventListener('click', () => { prefs.finger = prefs.finger === 'pan' ? 'draw' : 'pan'; cadSavePrefs(prefs); refreshUI(); toast(prefs.finger === 'pan' ? 'One finger pans. Pencil or mouse draws.' : 'One finger draws with an offset pointer above your fingertip.'); });
  $('cad-name').addEventListener('click', () => {
    const n = prompt('Drawing name', doc.d.name);
    if (n && n.trim()) { doc.d.name = n.trim(); $('cad-name').textContent = doc.d.name; markDirty(); }
  });
  $('cad-settings').addEventListener('click', openSettings);

  // ---- command line ----
  function submitCmd() {
    const v = cmdInput.value;
    if (v.trim()) { cmdHistory.push(v.trim()); cmdHistIdx = -1; }
    cmdInput.value = '';
    engine.submitText(v);
    refreshUI();
  }
  cmdInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); submitCmd(); }
    else if (e.key === 'Escape') { e.preventDefault(); if (cmdInput.value) { cmdInput.value = ''; refreshUI(); } else engine.cancel(); }
    else if (e.key === 'ArrowUp' && cmdHistory.length) { e.preventDefault(); cmdHistIdx = cmdHistIdx < 0 ? cmdHistory.length - 1 : Math.max(0, cmdHistIdx - 1); cmdInput.value = cmdHistory[cmdHistIdx]; }
    else if (e.key === 'ArrowDown' && cmdHistIdx >= 0) { e.preventDefault(); cmdHistIdx++; cmdInput.value = cmdHistIdx >= cmdHistory.length ? '' : cmdHistory[cmdHistIdx]; if (cmdHistIdx >= cmdHistory.length) cmdHistIdx = -1; }
  });
  cmdInput.addEventListener('input', refreshUI);
  cmdInput.addEventListener('focus', () => root.classList.add('cad-typing'));
  cmdInput.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== cmdInput) root.classList.remove('cad-typing'); }, 150));
  $('cad-keypad').addEventListener('pointerdown', (e) => e.preventDefault());
  $('cad-keypad').addEventListener('click', (e) => {
    const b = e.target.closest('.cad-key'); if (!b) return;
    const k = b.dataset.k;
    if (k === 'ENTER') { submitCmd(); return; }
    if (k === 'BS') { cmdInput.value = cmdInput.value.slice(0, -1); refreshUI(); return; }
    cmdInput.value += k; refreshUI();
  });
  // hardware keyboard: type anywhere to reach the command line; F-keys and Ctrl shortcuts as AutoCAD
  const onKey = (e) => {
    if (destroyed) return;
    const tag = (e.target && e.target.tagName) || '';
    const inOther = (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') && e.target !== cmdInput;
    if (inOther) return;
    const fmap = { F3: 'osnap', F7: 'grid', F8: 'ortho', F9: 'snap', F10: 'polar', F12: 'dyn' };
    if (fmap[e.key]) { e.preventDefault(); toggle(fmap[e.key]); return; }
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); doUndo(); return; }
      if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); doRedo(); return; }
      return;
    }
    if (e.key === 'Escape') { closeMenu(); engine.cancel(); return; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && !engine.active && engine.selection.size && (e.target !== cmdInput || !cmdInput.value)) { e.preventDefault(); engine.start('ERASE'); return; }
    if (e.target !== cmdInput && e.key.length === 1 && !e.altKey) { cmdInput.focus(); }
    else if (e.target !== cmdInput && e.key === 'Enter') { e.preventDefault(); submitCmd(); }
  };
  document.addEventListener('keydown', onKey);

  // ---- context menu (long press / right click) ----
  function closeMenu() { if (menuEl) { menuEl.remove(); menuEl = null; } }
  function openMenu(x, y) {
    closeMenu();
    const items = [];
    if (engine.active) {
      items.push(['Enter', () => engine.enter()]);
      if (engine.prompt && engine.prompt.options) for (const o of engine.prompt.options) items.push([o.name, () => engine.option(o.name)]);
      items.push(['Cancel', () => engine.cancel()]);
    } else {
      if (engine.lastCommand) items.push(['Repeat ' + engine.lastCommand, () => engine.start(engine.lastCommand)]);
      items.push(['Undo', doUndo]); items.push(['Redo', doRedo]); items.push(['Zoom to fit', zoomExtents]);
    }
    menuEl = document.createElement('div');
    menuEl.className = 'cad-menu';
    for (const [label, fn] of items) {
      const b = document.createElement('button'); b.textContent = label;
      b.addEventListener('click', () => { closeMenu(); fn(); refreshUI(); });
      menuEl.appendChild(b);
    }
    wrap.appendChild(menuEl);
    const mw = 170, mh = items.length * 42 + 8;
    menuEl.style.left = Math.max(6, Math.min(W - mw - 6, x)) + 'px';
    menuEl.style.top = Math.max(6, Math.min(H - mh - 6, y)) + 'px';
  }

  // ---- pointer handling ----
  const pointers = new Map();
  let gesture = null, pinch = null, longTimer = null, longFired = false;
  const FINGER_OFFSET = 70;
  function local(e) { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
  function cursorScreen(e, p) { return e.pointerType === 'touch' ? [p[0], p[1] - FINGER_OFFSET] : p; }
  function clearLong() { clearTimeout(longTimer); longTimer = null; }
  function startLong(e, p) {
    clearLong(); longFired = false;
    longTimer = setTimeout(() => { longFired = true; gesture = 'menu'; openMenu(p[0], p[1]); }, 600);
  }
  canvas.addEventListener('pointerdown', (e) => {
    closeMenu();
    if (document.activeElement === cmdInput && e.pointerType !== 'touch') cmdInput.blur();
    canvas.setPointerCapture(e.pointerId);
    const p = local(e);
    pointers.set(e.pointerId, { p, type: e.pointerType, start: p, button: e.button, t0: Date.now(), noTap: false });
    if (pointers.size === 2) {
      clearLong(); gesture = 'pinch'; windowRect = null;
      pointers.forEach((q) => { q.noTap = true; });
      const [a, b] = Array.from(pointers.values()).map((q) => q.p);
      pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], view: { ...view } };
      pinch.world = (() => { const v = view; return [v.cx + (pinch.mid[0] - W / 2) / v.scale, v.cy - (pinch.mid[1] - H / 2) / v.scale]; })();
      pushView();
      return;
    }
    if (pointers.size > 2) return;
    if (e.pointerType === 'mouse' && e.button === 1) { gesture = 'pan'; e.preventDefault(); return; }
    if (e.pointerType === 'mouse' && e.button === 2) { gesture = 'menu'; openMenu(p[0], p[1]); return; }
    if (e.pointerType === 'touch' && prefs.finger === 'pan') { gesture = 'pan'; return; }
    gesture = 'point'; gripStarted = false;
    const rawS = cursorScreen(e, p);
    if (!engine.active && engine.selection.size && e.button <= 0) {
      const gh = gripAt(s2w(rawS[0], rawS[1]), e.pointerType);
      if (gh && engine.startGrip(gh.id, gh.grip)) gripStarted = true;
    }
    resolveCursor(...rawS, e.pointerType); startLong(e, p);
  });
  let gripStarted = false;
  // Nearest grip of the selected objects within the pick aperture.
  function gripAt(raw, ptype) {
    if (engine.selection.size > 50) return null;
    const ap = apertureFor(ptype) / view.scale;
    let best = null, bd = Infinity;
    for (const id of engine.selection) {
      const e = doc.byId.get(id); if (!e) continue;
      for (const g of CadEdit.grips(e)) {
        const d = G.dist(g.pt, raw) + (g.kind === 'mid' ? ap * 0.25 : 0);
        if (d <= ap && d < bd) { bd = d; best = { id, grip: g }; }
      }
    }
    return best;
  }
  // Pick-first selection when no command is running.
  function idlePick(hit, additive) {
    if (hit) {
      if (additive) { if (engine.selection.has(hit.id)) engine.selectRemove([hit.id]); else engine.selectAdd([hit.id]); }
      else { engine.clearSelection(); engine.selectAdd([hit.id]); }
    } else if (!additive) engine.clearSelection();
  }
  function tapAt(p, ptype) {
    const raw = s2w(p[0], p[1]), tol = apertureFor(ptype) / view.scale, hit = doc.pick(raw, tol);
    if (engine.wantsSelect()) { if (hit) engine.selectAdd([hit.id], raw); }
    else if (!engine.active) idlePick(hit, false);
  }
  canvas.addEventListener('pointermove', (e) => {
    const rec = pointers.get(e.pointerId);
    const p = local(e);
    if (!rec) { if (e.pointerType !== 'touch') resolveCursor(p[0], p[1], e.pointerType); return; } // hover
    const prev = rec.p; rec.p = p;
    if (gesture === 'pinch' && pointers.size >= 2) {
      const [a, b] = Array.from(pointers.values()).map((q) => q.p);
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      view.scale = clampScale(pinch.view.scale * d / pinch.d);
      view.cx = pinch.world[0] - (mid[0] - W / 2) / view.scale;
      view.cy = pinch.world[1] + (mid[1] - H / 2) / view.scale;
      requestDraw(); return;
    }
    if (gesture === 'pan') { view.cx -= (p[0] - prev[0]) / view.scale; view.cy += (p[1] - prev[1]) / view.scale; requestDraw(); return; }
    if (gesture === 'point' || gesture === 'window') {
      const moved = Math.hypot(p[0] - rec.start[0], p[1] - rec.start[1]);
      if (moved > 7) clearLong();
      const windowOk = (engine.wantsSelect() && !engine.prompt.single) || !engine.active;
      if (windowOk && (gesture === 'window' || moved > 9)) {
        gesture = 'window'; windowRect = [rec.start, p]; requestDraw(); return;
      }
      resolveCursor(...cursorScreen(e, p), e.pointerType);
    }
  });
  function endPointer(e, cancelled) {
    const rec = pointers.get(e.pointerId); if (!rec) return;
    pointers.delete(e.pointerId);
    clearLong();
    if (gesture === 'pinch') { if (pointers.size < 2) { gesture = pointers.size ? 'pan' : null; pinch = null; } return; }
    const g = gesture;
    if (!pointers.size) gesture = null;
    if (cancelled || longFired) { windowRect = null; longFired = false; requestDraw(); return; }
    if (g === 'window' && windowRect) {
      const [a, b] = windowRect; windowRect = null;
      const w1 = s2w(a[0], a[1]), w2 = s2w(b[0], b[1]), r = G.rectOf(w1, w2);
      const crossing = b[0] < a[0];
      const hits = doc.queryVis(r.minX, r.minY, r.maxX, r.maxY).filter((x) => (crossing ? G.entCrossesRect(x, r) : G.entInWindow(x, r)));
      if (!engine.active) { if (!e.shiftKey) engine.clearSelection(); engine.selectAdd(hits.map((x) => x.id)); }
      else if (e.shiftKey) engine.selectRemove(hits.map((x) => x.id)); else engine.selectAdd(hits.map((x) => x.id));
      requestDraw(); return;
    }
    if (g === 'pan' && e.pointerType === 'touch' && !rec.noTap && Date.now() - rec.t0 < 450 && Math.hypot(rec.p[0] - rec.start[0], rec.p[1] - rec.start[1]) < 8) {
      tapAt(rec.p, 'touch'); requestDraw(); return;
    }
    if (g === 'point') {
      const p = rec.p;
      resolveCursor(...cursorScreen(e, p), e.pointerType);
      if (gripStarted) {
        gripStarted = false;
        // press-lift without dragging leaves the grip hot: the next click places it
        if (Math.hypot(p[0] - rec.start[0], p[1] - rec.start[1]) < 6) { requestDraw(); return; }
      }
      if (engine.wantsSelect()) {
        const tol = apertureFor(e.pointerType) / view.scale;
        const hit = doc.pick(cur.raw, tol);
        if (hit) { if (e.shiftKey) engine.selectRemove([hit.id]); else engine.selectAdd([hit.id], cur.raw); }
      } else if (!engine.active) {
        idlePick(doc.pick(cur.raw, apertureFor(e.pointerType) / view.scale), e.shiftKey);
      } else if (engine.wantsPoint()) {
        engine.pick(cur.pt);
        resolveCursor(...cursorScreen(e, p), e.pointerType);
      }
      if (e.pointerType === 'touch') { cur.active = false; requestDraw(); }
    }
  }
  canvas.addEventListener('pointerup', (e) => endPointer(e, false));
  canvas.addEventListener('pointercancel', (e) => endPointer(e, true));
  canvas.addEventListener('pointerleave', (e) => { if (e.pointerType !== 'touch' && !pointers.size) { cur.active = false; requestDraw(); } });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const p = local(e);
    zoomAt(p[0], p[1], Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)));
    requestDraw();
  }, { passive: false });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  const stopGesture = (e) => e.preventDefault();
  wrap.addEventListener('gesturestart', stopGesture); wrap.addEventListener('gesturechange', stopGesture);

  // ---- drafting settings ----
  function openSettings() {
    const polarOpts = [5, 10, 15, 22.5, 30, 45, 90];
    const sheet = el(`
      <div class="sheet-backdrop"><div class="sheet" style="max-height:86vh; overflow:auto;">
        <div class="sheet-handle"></div>
        <h2>Drafting settings</h2>
        <div class="field"><label>Object snap modes</label>
          <div class="cad-modes">${Object.keys(CAD_SNAP_NAMES).map((k) => `<label class="cad-mode"><input type="checkbox" data-m="${k}" ${prefs.modes[k] ? 'checked' : ''}> ${CAD_SNAP_NAMES[k]}</label>`).join('')}</div>
        </div>
        <div class="field"><label>Polar angle increment</label>
          <select id="cad-s-polar">${polarOpts.map((v) => `<option value="${v}" ${prefs.polarInc === v ? 'selected' : ''}>${v}°</option>`).join('')}</select></div>
        <div class="field"><label>Grid and snap spacing (${esc(unit.label)})</label><input type="number" id="cad-s-grid" min="0" step="any" value="${doc.d.gridSpacing || 10}"></div>
        <div class="field"><label>Plot scale 1 : <span style="font-weight:400">(annotation is sized on paper, then scaled)</span></label><input type="number" id="cad-s-scale" min="1" step="any" value="${doc.d.plotScale || 50}"></div>
        <div class="field"><label>Text height on paper (mm)</label><input type="number" id="cad-s-th" min="0.5" step="any" value="${doc.d.textH || 2.5}"></div>
        <div class="field"><label>Dimension arrow size on paper (mm)</label><input type="number" id="cad-s-ar" min="0.5" step="any" value="${(doc.d.dimStyle && doc.d.dimStyle.arrow) || 2.5}"></div>
        <div class="field"><label>Dimension decimals</label><input type="number" id="cad-s-dec" min="0" max="6" step="1" placeholder="auto" value="${doc.d.dimStyle && doc.d.dimStyle.decimals != null ? doc.d.dimStyle.decimals : ''}"></div>
        <div class="field"><label>Default line weight</label><select id="cad-s-lw">${[18, 25, 30, 35, 50].map((v) => `<option value="${v}" ${Math.round((doc.d.defaultLw || 0.25) * 100) === v ? 'selected' : ''}>${(v / 100).toFixed(2)} mm</option>`).join('')}</select></div>
        <div class="field"><label>Line type scale <span style="font-weight:400">(1 = dash lengths as defined on paper at the plot scale)</span></label><input type="number" id="cad-s-lts" min="0.05" step="any" value="${doc.d.ltScale || 1}"></div>
        <button class="btn btn-secondary btn-block" id="cad-s-pens" style="margin-bottom:10px">Pen settings (print colours and weights)…</button>
        <p style="font-size:12.5px;color:#6b717c;margin:0 0 10px">These apply to text and dimensions you add from now on. Existing ones keep their size.</p>
        <button class="btn btn-primary btn-block" id="btn-save">Done</button>
      </div></div>`);
    presentOverlay(sheet);
    sheet.querySelector('#cad-s-pens').addEventListener('click', () => cadOpenPenSheet(doc, () => { markDirty(); requestDraw(); }));
    const close = () => {
      const num = (id) => parseFloat(sheet.querySelector(id).value);
      const ps = num('#cad-s-scale'), th = num('#cad-s-th'), ar = num('#cad-s-ar'), dc = sheet.querySelector('#cad-s-dec').value.trim();
      const lwv = parseInt(sheet.querySelector('#cad-s-lw').value, 10) / 100, lts = num('#cad-s-lts');
      if (lwv > 0) doc.d.defaultLw = lwv; if (lts > 0) doc.d.ltScale = lts;
      if (ps > 0) doc.d.plotScale = ps; if (th > 0) doc.d.textH = th;
      doc.d.dimStyle = { ...(doc.d.dimStyle || {}), arrow: ar > 0 ? ar : 2.5, decimals: dc === '' ? null : Math.max(0, Math.min(6, parseInt(dc, 10) || 0)) };
      markDirty();
      sheet.querySelectorAll('[data-m]').forEach((c) => { prefs.modes[c.dataset.m] = c.checked; });
      prefs.polarInc = parseFloat(sheet.querySelector('#cad-s-polar').value) || 45;
      const g = parseFloat(sheet.querySelector('#cad-s-grid').value);
      if (g > 0 && g !== doc.d.gridSpacing) { doc.d.gridSpacing = g; markDirty(); }
      cadSavePrefs(prefs); sheet.remove(); refreshUI(); requestDraw();
    };
    sheet.addEventListener('click', (e) => { if (e.target === sheet) close(); });
    sheet.querySelector('#btn-save').addEventListener('click', close);
  }

  // ---- teardown ----
  const state = {
    doc, engine, view: () => view, prefs, setView: (v) => { view = v; requestDraw(); },
    screenOf: (p) => { const s = w2s(p); const r = canvas.getBoundingClientRect(); return [r.left + s[0], r.top + s[1]]; },
    save,
    destroy() {
      for (const r of ulImages.values()) { if (r.url) URL.revokeObjectURL(r.url); }
      destroyed = true;
      clearTimeout(saveTimer); clearLong();
      if (saveState !== 'saved') { try { DB.saveCadDrawing(snapshotData()); } catch (e) { /* ignore */ } }
      document.removeEventListener('keydown', onKey); document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', save);
      if (vv) { vv.removeEventListener('resize', fitVisualViewport); vv.removeEventListener('scroll', fitVisualViewport); }
      ro.disconnect(); closeMenu();
    }
  };
  cadMounted = state; window.cadState = state;
  resize();
  if (doc.entities.length && (!data.view || !data.view.scale)) fitBox(doc.extents());
  refreshUI(); requestDraw();
  setTimeout(() => { if (!destroyed) { resize(); } }, 60);
}

function injectCadCss() {
  if (document.getElementById('cad-css')) return;
  const s = document.createElement('style'); s.id = 'cad-css';
  s.textContent = `
.cad-root{position:fixed;left:0;right:0;top:0;bottom:0;display:flex;flex-direction:column;background:#fff;color:#1b1e24;z-index:5;touch-action:manipulation;-webkit-user-select:none;user-select:none;font-family:-apple-system,system-ui,sans-serif;overscroll-behavior:none}
.cad-top{display:flex;align-items:center;gap:6px;padding:calc(6px + var(--safe-top)) 10px 6px;background:var(--ink,#22252b);color:#fff;flex-shrink:0}
.cad-btn{background:rgba(255,255,255,.13);border:0;color:#fff;min-width:40px;height:40px;border-radius:10px;font-size:18px;display:flex;align-items:center;justify-content:center;padding:0 10px;font-weight:600}
.cad-btn:active{background:rgba(255,255,255,.28)} .cad-btn:disabled{opacity:.35}
.cad-finger{font-size:13px}
.cad-title{background:none;border:0;color:#fff;font-size:16px;font-weight:650;max-width:34vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:6px 6px;text-align:left}
.cad-saved{font-size:12px;color:#b8bcc4;white-space:nowrap}
.cad-main{flex:1;min-height:0;display:flex}
.cad-palette{width:128px;flex-shrink:0;background:#f3f4f6;border-right:1px solid #dfe1e5;display:grid;grid-template-columns:1fr 1fr;align-content:start;overflow-y:auto;padding:2px 0}
.cad-group{grid-column:1/-1;font-size:10px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:#7a808b;padding:7px 10px 2px}
.cad-selcount{font-size:13px;font-weight:700;color:#1565c0;white-space:nowrap;padding:0 4px}
.cad-tool{background:none;border:0;color:#2a2d34;display:flex;flex-direction:column;align-items:center;gap:1px;padding:5px 2px;font-size:10px;font-weight:600;margin:1px 3px;border-radius:9px}
.cad-tool.on{background:#22252b;color:#fff}
.cad-wrap{flex:1;min-width:0;position:relative;overflow:hidden;background:#fff}
#cad-canvas{display:block;touch-action:none}
.cad-bottom{flex-shrink:0;background:#f3f4f6;border-top:1px solid #dfe1e5;padding-bottom:var(--safe-bottom)}
.cad-hist{font:12px ui-monospace,Menlo,monospace;color:#555b66;padding:4px 12px 0;min-height:52px;display:flex;flex-direction:column;justify-content:flex-end;overflow:hidden}
.cad-hist div{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cad-chips{display:flex;gap:6px;padding:4px 10px;overflow-x:auto;min-height:38px;align-items:center}
.cad-chip{border:1px solid #c9ccd2;background:#fff;color:#22252b;border-radius:18px;padding:6px 13px;font-size:14px;font-weight:600;white-space:nowrap}
.cad-chip.accent{background:#22252b;color:#fff;border-color:#22252b}
.cad-keypad{display:none;gap:6px;padding:2px 10px 4px}
.cad-typing .cad-keypad{display:flex}
.cad-key{flex:1;height:38px;border:1px solid #c9ccd2;background:#fff;border-radius:9px;font-size:18px;font-weight:600;color:#22252b}
.cad-key-enter{flex:2;background:#22252b;color:#fff;border-color:#22252b;font-size:15px}
.cad-cmdrow{display:flex;align-items:center;gap:8px;padding:2px 10px 6px}
.cad-prompt{font-size:13px;font-weight:650;color:#22252b;max-width:46%;line-height:1.2}
#cad-cmd{flex:1;min-width:0;height:40px;border:1px solid #c9ccd2;border-radius:9px;padding:0 10px;font-size:17px;background:#fff;color:#111;-webkit-user-select:text;user-select:text}
.cad-cancel,.cad-enter{background:#22252b;height:40px}
.cad-cancel{display:none} .cad-active .cad-cancel{display:flex}
.cad-status{display:flex;align-items:center;gap:6px;padding:2px 10px 6px;overflow-x:auto}
.cad-coords{font:12.5px ui-monospace,Menlo,monospace;color:#2a2d34;white-space:nowrap}
.cad-units{font-size:11px;color:#6b717c;font-weight:700;margin-left:4px}
.cad-tog{border:1px solid #c9ccd2;background:#fff;color:#6b717c;border-radius:8px;height:30px;padding:0 9px;font-size:11.5px;font-weight:700;letter-spacing:.3px}
.cad-tog.on{background:#22252b;color:#fff;border-color:#22252b}
.cad-menu{position:absolute;width:170px;background:#fff;border:1px solid #cfd2d8;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.25);padding:4px;z-index:10;display:flex;flex-direction:column}
.cad-menu button{border:0;background:none;text-align:left;padding:0 12px;height:42px;border-radius:8px;font-size:15px;font-weight:600;color:#22252b}
.cad-menu button:active{background:#eceef1}
.ly-row{display:flex;align-items:center;gap:5px;padding:5px 0;border-bottom:1px solid #eceef1}
.ly-cur{border:0;background:none;font-size:20px;width:32px;color:#1565c0}
.ly-dot{width:14px;height:14px;border-radius:50%;flex-shrink:0;border:1px solid #bbb}
.ly-name{flex:1;min-width:60px;height:38px;border:1px solid #d3d6db;border-radius:8px;padding:0 8px;font-size:16px;-webkit-user-select:text;user-select:text}
.ly-col{height:38px;border:1px solid #d3d6db;border-radius:8px;font-size:13px;max-width:92px}
.ly-dotb{border:0;background:none;padding:0;width:22px;height:22px;flex-shrink:0;display:flex;align-items:center;justify-content:center}
.ly-det{display:flex;flex-wrap:wrap;gap:8px 14px;padding:8px 6px 10px 38px;background:#f6f7f9;border-bottom:1px solid #eceef1;font-size:13px;color:#4a505c}
.ly-det label{display:flex;align-items:center;gap:6px}
.ly-det select{height:36px;border:1px solid #d3d6db;border-radius:8px;font-size:14px}
.ly-det input[type=color]{width:44px;height:36px;border:1px solid #d3d6db;border-radius:8px;padding:2px;background:#fff}
.ly-b{width:38px;height:38px;border:1px solid #d3d6db;background:#fff;border-radius:8px;font-size:16px;opacity:.5}
.ly-b.on{opacity:1;background:#eef3fb} .ly-b:disabled{opacity:.2}
.cad-modes{display:grid;grid-template-columns:1fr 1fr;gap:8px 12px}
.cad-mode{display:flex;align-items:center;gap:8px;font-size:14.5px}
.cad-mode input{width:20px;height:20px}
@media (max-width:560px){.cad-palette{width:54px;grid-template-columns:1fr}.cad-group{padding:6px 2px 1px;text-align:center;font-size:8px}.cad-tool span{display:none}.cad-title{max-width:22vw}}
`;
  document.head.appendChild(s);
}

window.renderCad = renderCad;
window.cadTeardown = cadTeardown;
