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

const CAD_ACI = { 1: '#d32f2f', 2: '#b8860b', 3: '#2e7d32', 4: '#00838f', 5: '#1565c0', 6: '#8e24aa', 7: '#111111', 8: '#808080', 9: '#a0a0a0' };
const CAD_SNAP_NAMES = { end: 'Endpoint', mid: 'Midpoint', cen: 'Center', gcen: 'Geometric center', node: 'Node', quad: 'Quadrant', int: 'Intersection', per: 'Perpendicular', tan: 'Tangent', nea: 'Nearest' };
const CAD_DEFAULT_PREFS = {
  toggles: { osnap: true, grid: true, snap: false, ortho: false, polar: false, dyn: true },
  modes: { end: true, mid: true, cen: true, int: true, node: true, quad: false, per: true, tan: false, nea: false, gcen: false },
  polarInc: 45, finger: 'pan'
};
const CAD_TOOLS = [
  { cmd: 'LINE', label: 'Line' }, { cmd: 'PLINE', label: 'Polyline' }, { cmd: 'RECTANG', label: 'Rectangle' },
  { cmd: 'CIRCLE', label: 'Circle' }, { cmd: 'ARC', label: 'Arc' }, { cmd: 'POINT', label: 'Point' }, { cmd: 'ERASE', label: 'Erase' }
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
    ERASE: '<path d="M6 17 L14 6 L21 11 L14 20 H9 Z"/><path d="M10 14 L17 19"/>',
    FIT: '<path d="M5 10 V5 H10 M16 5 H21 V10 M21 16 V21 H16 M10 21 H5 V16"/>',
    UNDO: '<path d="M8 10 H16 A4.5 4.5 0 0 1 16 19 H10"/><path d="M11 6 L7.5 10 L11 14"/>',
    REDO: '<path d="M18 10 H10 A4.5 4.5 0 0 0 10 19 H16"/><path d="M15 6 L18.5 10 L15 14"/>',
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
function cadMountEditor(data) {
  const prefs = cadLoadPrefs();
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
        <button class="cad-btn cad-finger" id="cad-finger" title="What one finger does"></button>
        <button class="cad-btn" id="cad-settings" title="Drafting settings">${cadIcon('GEAR')}</button>
      </div>
      <div class="cad-main">
        <div class="cad-palette" id="cad-palette">
          ${CAD_TOOLS.map((t) => `<button class="cad-tool" data-cmd="${t.cmd}" title="${t.label}">${cadIcon(t.cmd)}<span>${t.label}</span></button>`).join('')}
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
          <span style="flex:1"></span>
          ${['snap', 'grid', 'ortho', 'polar', 'osnap', 'dyn'].map((k) => `<button class="cad-tog" data-t="${k}">${k.toUpperCase()}</button>`).join('')}
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
    redraw: () => requestDraw()
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
  function zoomExtents() { pushView(); fitBox(doc.extents()); requestDraw(); }
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
      const near = doc.query(raw[0] - ap, raw[1] - ap, raw[0] + ap, raw[1] + ap);
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
  function layerColor(e) {
    const l = doc.d.layers.find((x) => x.name === e.layer);
    const aci = e.color != null ? e.color : (l ? l.color : 7);
    return CAD_ACI[aci] || CAD_ACI[7];
  }
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
  function drawEntity(c, e) {
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
    // origin marker
    const o = w2s([0, 0]);
    c.strokeStyle = '#b9bdc4'; c.lineWidth = 1; c.beginPath(); c.moveTo(o[0] - 10, o[1]); c.lineTo(o[0] + 10, o[1]); c.moveTo(o[0], o[1] - 10); c.lineTo(o[0], o[1] + 10); c.stroke();
    // entities in view
    const tl = s2w(0, 0), br = s2w(W, H);
    const vis = doc.query(tl[0], br[1], br[0], tl[1]);
    c.lineWidth = 1.6; c.lineJoin = 'round'; c.lineCap = 'round';
    const layers = new Map(doc.d.layers.map((l) => [l.name, l]));
    for (const e of vis) {
      const l = layers.get(e.layer); if (l && (!l.on || l.frozen)) continue;
      c.strokeStyle = layerColor(e); drawEntity(c, e);
    }
    // selection
    if (engine.selection.size) {
      c.strokeStyle = '#1565c0'; c.lineWidth = 2.6; c.setLineDash([7, 4]);
      for (const id of engine.selection) { const e = doc.byId.get(id); if (e) drawEntity(c, e); }
      c.setLineDash([]); c.lineWidth = 1.6;
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
        c.strokeStyle = '#1565c0'; c.lineWidth = 1.6; c.setLineDash([6, 4]);
        for (const e of pv) drawEntity(c, e);
        c.setLineDash([]);
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
      for (const s of engine.suggest(cmdInput.value)) chips.appendChild(chipEl(s, () => { cmdInput.value = ''; engine.start(s); refreshUI(); }));
    }
    if (engine.active && engine.wantsSelect()) chips.appendChild(chipEl('Done', () => engine.enter(), true));
    root.classList.toggle('cad-active', !!engine.active);
    document.querySelectorAll('.cad-tool').forEach((b) => b.classList.toggle('on', b.dataset.cmd === engine.active));
    $('cad-undo').disabled = !doc.undoStack.length && !engine.active;
    $('cad-redo').disabled = !doc.redoStack.length || !!engine.active;
    document.querySelectorAll('.cad-tog').forEach((b) => b.classList.toggle('on', !!prefs.toggles[b.dataset.t]));
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
  function doUndo() { if (engine.active) engine.cancel(); doc.undo(); refreshUI(); requestDraw(); }
  function doRedo() { if (engine.active) return; doc.redo(); refreshUI(); requestDraw(); }
  function toggle(k) {
    prefs.toggles[k] = !prefs.toggles[k];
    if (k === 'ortho' && prefs.toggles.ortho) prefs.toggles.polar = false;
    if (k === 'polar' && prefs.toggles.polar) prefs.toggles.ortho = false;
    cadSavePrefs(prefs); refreshUI(); requestDraw();
  }
  document.querySelectorAll('.cad-tool').forEach((b) => b.addEventListener('click', () => runCommand(b.dataset.cmd)));
  document.querySelectorAll('.cad-tog').forEach((b) => b.addEventListener('click', () => toggle(b.dataset.t)));
  $('cad-undo').addEventListener('click', doUndo);
  $('cad-redo').addEventListener('click', doRedo);
  $('cad-fit').addEventListener('click', zoomExtents);
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
    pointers.set(e.pointerId, { p, type: e.pointerType, start: p, button: e.button });
    if (pointers.size === 2) {
      clearLong(); gesture = 'pinch'; windowRect = null;
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
    gesture = 'point'; resolveCursor(...cursorScreen(e, p), e.pointerType); startLong(e, p);
  });
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
      if (engine.wantsSelect() && (gesture === 'window' || moved > 9)) {
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
      const hits = doc.query(r.minX, r.minY, r.maxX, r.maxY).filter((x) => (crossing ? G.entCrossesRect(x, r) : G.entInWindow(x, r)));
      if (e.shiftKey) engine.selectRemove(hits.map((x) => x.id)); else engine.selectAdd(hits.map((x) => x.id));
      requestDraw(); return;
    }
    if (g === 'point') {
      const p = rec.p;
      resolveCursor(...cursorScreen(e, p), e.pointerType);
      if (engine.wantsSelect()) {
        const tol = apertureFor(e.pointerType) / view.scale;
        const hit = doc.pick(cur.raw, tol);
        if (hit) { if (e.shiftKey) engine.selectRemove([hit.id]); else engine.selectAdd([hit.id]); }
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
        <button class="btn btn-primary btn-block" id="btn-save">Done</button>
      </div></div>`);
    presentOverlay(sheet);
    const close = () => {
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
.cad-palette{width:64px;flex-shrink:0;background:#f3f4f6;border-right:1px solid #dfe1e5;display:flex;flex-direction:column;overflow-y:auto;padding:4px 0}
.cad-tool{background:none;border:0;color:#2a2d34;display:flex;flex-direction:column;align-items:center;gap:1px;padding:7px 2px;font-size:10px;font-weight:600;margin:1px 4px;border-radius:9px}
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
.cad-modes{display:grid;grid-template-columns:1fr 1fr;gap:8px 12px}
.cad-mode{display:flex;align-items:center;gap:8px;font-size:14.5px}
.cad-mode input{width:20px;height:20px}
@media (max-width:560px){.cad-palette{width:54px}.cad-tool span{display:none}.cad-title{max-width:22vw}}
`;
  document.head.appendChild(s);
}

window.renderCad = renderCad;
window.cadTeardown = cadTeardown;
