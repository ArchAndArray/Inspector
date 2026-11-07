// cadcmd.js — CAD document model, input parsing and the command engine. No DOM; testable in
// Node. Global `CadCmd`.
//
// A command is a generator. It yields a *prompt* (what to ask for next) and receives the
// user's answer, exactly the way an AutoCAD command line works:
//
//   function* LINE(c) { const r = yield c.point('Specify first point:'); ... }
//
// The engine feeds answers from the canvas (picked points) or from typed text (coordinates,
// distances, option keywords) and keeps a command-line history. Every command's edits are one
// undo group, as AutoCAD's U / UNDO behave.

const CadCmd = (() => {
  'use strict';
  const G = (typeof CadGeo !== 'undefined') ? CadGeo : require('./cadgeo.js');
  const X = (typeof CadEdit !== 'undefined') ? CadEdit : require('./cadedit.js');
  const DM = (typeof CadDim !== 'undefined') ? CadDim : require('./caddim.js');
  const SYM = typeof CadSym !== 'undefined' ? CadSym : require('./cadsym.js');
  const CH = typeof CadHatch !== 'undefined' ? CadHatch : require('./cadhatch.js');

  // ---------- document ----------
  class CadDoc {
    constructor(data) {
      this.d = data;
      this.entities = data.entities;
      this.byId = new Map();
      this.index = new G.CadIndex();
      this.undoStack = []; this.redoStack = [];
      this.group = null;
      this.version = 0;
      this.onChange = null;
      const boxes = [];
      this.assoc = new Set(); this.dirty = new Set();
      for (const e of this.entities) { this.byId.set(e.id, e); boxes.push([e.id, G.bbox(e)]); if (e.t === 'HATCH' && e.src) this.assoc.add(e.id); }
      this.index.bulk(boxes);
    }
    static blank(opts) {
      const o = opts || {};
      const now = new Date().toISOString();
      return {
        id: o.id || null, name: o.name || 'Untitled drawing', units: o.units || 'mm', schema: 1,
        plotScale: 50, gridSpacing: 10,
        layers: [{ name: '0', color: 7, ltype: 'Continuous', lw: -3, on: true, frozen: false, locked: false, plot: true }],
        currentLayer: '0', entities: [], nextId: 1, view: { cx: 0, cy: 0, scale: 0.5 },
        created: now, modified: now
      };
    }
    _id() { return 'e' + (this.d.nextId++); }
    _touch() { this.version++; this.d.modified = new Date().toISOString(); if (this.onChange) this.onChange(); }
    beginGroup() { this.group = []; }
    endGroup() {
      if (this.dirty.size) this._flushAssoc();
      const g = this.group; this.group = null;
      if (g && g.length) { this.undoStack.push(g); this.redoStack.length = 0; }
    }
    _record(op) { if (this.group) this.group.push(op); else { this.undoStack.push([op]); this.redoStack.length = 0; } }
    _doAdd(ent, at) {
      if (at == null || at >= this.entities.length) this.entities.push(ent); else this.entities.splice(at, 0, ent);
      this.byId.set(ent.id, ent); this.index.insert(ent.id, G.bbox(ent));
      if (ent.t === 'HATCH' && ent.src) this.assoc.add(ent.id);
    }
    _doDel(id) {
      const i = this.entities.findIndex((e) => e.id === id);
      if (i < 0) return -1;
      this.entities.splice(i, 1); this.byId.delete(id); this.index.remove(id); this.assoc.delete(id);
      return i;
    }
    add(input) {
      const ent = JSON.parse(JSON.stringify(input));
      if (!ent.id) ent.id = this._id();
      if (!ent.layer) ent.layer = this.d.currentLayer;
      if (ent.t === 'HATCH' && ent.src) { if (ent.src.fresh) delete ent.src.fresh; else delete ent.src; }   // copies and pastes are not linked
      this._doAdd(ent);
      this._record({ k: 'add', ent });
      this._touch();
      return ent;
    }
    // Associative hatches: boundary edits mark the hatch dirty; it is rebuilt when the command's undo group closes.
    _markAssoc(id) {
      if (!this.assoc.size) return;
      for (const hid of this.assoc) { const h = this.byId.get(hid); if (h && h.src && h.src.ids.indexOf(id) >= 0) this.dirty.add(hid); }
    }
    _flushAssoc() {
      const ids = Array.from(this.dirty); this.dirty.clear();
      const cands = this.entities.filter((e) => CH.isBoundaryEnt(e) && this.isVisible(e));
      for (const hid of ids) {
        const h = this.byId.get(hid); if (!h || !h.src) continue;
        const pk = h.pk || 1, n = CH.relink(h, this.byId, cands, 0.05 * pk);
        if (n) this._replace0(hid, n);
      }
    }
    remove(id) {
      const ent = this.byId.get(id); if (!ent) return;
      if (ent.t !== 'HATCH' && this.assoc.size) { this.transact(() => { this._remove0(id); this._markAssoc(id); }); return; }
      this._remove0(id);
    }
    _remove0(id) {
      const ent = this.byId.get(id); if (!ent) return;
      const i = this._doDel(id);
      this._record({ k: 'del', ent, i });
      this._touch();
    }
    replace(id, next) {
      const prev = this.byId.get(id); if (!prev) return null;
      if (prev.t === 'HATCH' && prev.src) {                // moving or reshaping a hatch itself unlinks it from its boundary
        const moved = JSON.stringify(prev.loops) !== JSON.stringify(next.loops);
        if (moved) { next = { ...next }; delete next.src; delete next.det; }
      }
      if (prev.t !== 'HATCH' && this.assoc.size) { let r; this.transact(() => { r = this._replace0(id, next); this._markAssoc(id); }); return r; }
      return this._replace0(id, next);
    }
    _replace0(id, next) {
      const prev = this.byId.get(id); if (!prev) return null;
      const ent = { ...JSON.parse(JSON.stringify(next)), id, layer: next.layer || prev.layer };
      const i = this._doDel(id);
      this._doAdd(ent, i);
      this._record({ k: 'rep', prev, ent, i });
      this._touch();
      return ent;
    }
    _invert(op) {
      if (op.k === 'add') this._doDel(op.ent.id);
      else if (op.k === 'del') this._doAdd(op.ent, op.i);
      else if (op.k === 'meta') this._applyMeta(op.before);
      else { this._doDel(op.ent.id); this._doAdd(op.prev, op.i); }
    }
    _applyMeta(m) { this.d.layers = JSON.parse(JSON.stringify(m.layers)); this.d.currentLayer = m.cur; if (m.ul) this.d.underlays = JSON.parse(JSON.stringify(m.ul)); }
    _reapply(op) {
      if (op.k === 'add') this._doAdd(op.ent);
      else if (op.k === 'del') this._doDel(op.ent.id);
      else if (op.k === 'meta') this._applyMeta(op.after);
      else { this._doDel(op.prev.id); this._doAdd(op.ent, op.i); }
    }
    // Undo the most recent op inside the open command group (LINE's Undo option).
    popOp() {
      if (!this.group || !this.group.length) return false;
      this._invert(this.group.pop()); this._touch(); return true;
    }
    undo() {
      if (this.group) this.endGroup();
      const g = this.undoStack.pop(); if (!g) return false;
      for (let i = g.length - 1; i >= 0; i--) this._invert(g[i]);
      this.redoStack.push(g); this._touch(); return true;
    }
    redo() {
      const g = this.redoStack.pop(); if (!g) return false;
      for (const op of g) this._reapply(op);
      this.undoStack.push(g); this._touch(); return true;
    }
    // ---- layers and properties (each is one undoable step) ----
    layer(name) { return this.d.layers.find((l) => l.name === name) || null; }
    isVisible(e) { const l = this.layer(e.layer); return !l || (l.on !== false && !l.frozen); }
    isSelectable(e) { const l = this.layer(e.layer); return !l || (l.on !== false && !l.frozen && !l.locked); }
    transact(fn) {
      const own = !this.group; if (own) this.beginGroup();
      try { return fn(); } finally { if (own) this.endGroup(); }
    }
    _metaSnap() { return JSON.parse(JSON.stringify({ layers: this.d.layers, cur: this.d.currentLayer, ul: this.d.underlays || [] })); }
    setLayers(layers, currentLayer) {
      const before = this._metaSnap();
      this.d.layers = JSON.parse(JSON.stringify(layers));
      if (currentLayer != null) this.d.currentLayer = currentLayer;
      this._record({ k: 'meta', before, after: this._metaSnap() });
      this._touch();
    }
    // Underlays: [{id, assetId, name, x, y, w, h, rot, opacity, on, iw, ih}], x,y = lower-left corner in model units.
    underlay(id) { return (this.d.underlays || []).find((u) => u.id === id) || null; }
    setUnderlays(list) {
      const before = this._metaSnap();
      this.d.underlays = JSON.parse(JSON.stringify(list));
      this._record({ k: 'meta', before, after: this._metaSnap() });
      this._touch();
    }
    patchUnderlay(id, patch) { this.setUnderlays((this.d.underlays || []).map((u) => (u.id === id ? { ...u, ...patch } : u))); }
    renameLayer(oldName, newName) {
      if (oldName === '0' || !newName || this.layer(newName)) return false;
      this.transact(() => {
        this.setLayers(this.d.layers.map((l) => (l.name === oldName ? { ...l, name: newName } : l)), this.d.currentLayer === oldName ? newName : this.d.currentLayer);
        for (const e of this.entities.filter((x) => x.layer === oldName)) this.replace(e.id, { ...e, layer: newName });
      });
      return true;
    }
    // Returns an error message, or null when deleted.
    deleteLayer(name) {
      if (name === '0') return 'Layer 0 cannot be deleted.';
      if (this.d.currentLayer === name) return 'The current layer cannot be deleted.';
      if (this.entities.some((e) => e.layer === name)) return 'That layer has objects on it. Move or erase them first.';
      this.transact(() => this.setLayers(this.d.layers.filter((l) => l.name !== name), null));
      return null;
    }
    // props: any of layer, color (null = ByLayer), text, h, rot, w, txt.
    setProps(ids, props) {
      this.transact(() => {
        for (const id of ids) {
          const e = this.byId.get(id); if (!e) continue;
          const n = JSON.parse(JSON.stringify(e));
          for (const k of Object.keys(props)) { if (props[k] === null || props[k] === undefined) delete n[k]; else n[k] = props[k]; }
          this.replace(id, n);
        }
      });
    }
    extents() {
      let box = null;
      for (const e of this.entities) box = G.unionBox(box, G.bbox(e));
      return box;
    }
    queryVis(a, b, c2, d) { return this.query(a, b, c2, d).filter((e) => this.isVisible(e)); }
    // Entities whose bounding box overlaps the rectangle (spatial-index query).
    query(minX, minY, maxX, maxY) {
      const out = [];
      for (const id of this.index.search(minX, minY, maxX, maxY)) { const e = this.byId.get(id); if (e) out.push(e); }
      return out;
    }
    // Topmost entity within tol of the point.
    pick(pt, tol) {
      let best = null, bd = tol;
      for (const e of this.query(pt[0] - tol, pt[1] - tol, pt[0] + tol, pt[1] + tol)) {
        if (!this.isVisible(e)) continue;
        let d = G.entityDist(e, pt);
        // Inside a hatch counts as nearly background: lines and text under the finger win, but the hatch is still tappable.
        if (e.t === 'HATCH' && d > 0 && CH.inside(CH.polysOf(e, 0.05 * (e.pk || 1)), pt)) d = tol * 0.98;
        if (e.t === 'SYM' && d > 0 && G.dist(e.p, pt) <= (e.sz || 0) / 2) d = tol * 0.98;
        if (d <= bd) { bd = d; best = e; }
      }
      return best;
    }
  }

  // ---------- typed input ----------
  const NUM = '[-+]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][-+]?\\d+)?';
  const RE_XY = new RegExp('^(@?)\\s*(' + NUM + ')\\s*,\\s*(' + NUM + ')$');
  const RE_POLAR = new RegExp('^(@?)\\s*(' + NUM + ')\\s*<\\s*(' + NUM + ')$');
  const RE_NUM = new RegExp('^(' + NUM + ')$');
  // ctx: { base, last, cursor }. Returns { pt } | { value } (a bare number) | { error }.
  function parseInput(text, ctx) {
    const t = String(text).trim();
    let m;
    if ((m = RE_XY.exec(t))) {
      const x = parseFloat(m[2]), y = parseFloat(m[3]);
      if (m[1]) { const o = ctx.last || ctx.base || [0, 0]; return { pt: [o[0] + x, o[1] + y] }; }
      return { pt: [x, y] };
    }
    if ((m = RE_POLAR.exec(t))) {
      const d = parseFloat(m[2]), a = G.rad(parseFloat(m[3]));
      const o = m[1] ? (ctx.last || ctx.base || [0, 0]) : [0, 0];
      return { pt: G.polar(o, a, d) };
    }
    if ((m = RE_NUM.exec(t))) return { value: parseFloat(m[1]) };
    return { error: 'Invalid input.' };
  }

  // ---------- commands ----------
  const ALIASES = { L: 'LINE', PL: 'PLINE', REC: 'RECTANG', C: 'CIRCLE', A: 'ARC', PO: 'POINT', E: 'ERASE', U: 'UNDO', Z: 'ZOOM', P: 'PAN', RE: 'REGEN', R: 'REDRAW', POLYLINE: 'PLINE', RECTANGLE: 'RECTANG',
    M: 'MOVE', CO: 'COPY', CP: 'COPY', RO: 'ROTATE', SC: 'SCALE', MI: 'MIRROR', O: 'OFFSET', TR: 'TRIM', EX: 'EXTEND',
    F: 'FILLET', CHA: 'CHAMFER', S: 'STRETCH', X: 'EXPLODE', DEL: 'ERASE', DELETE: 'ERASE',
    T: 'MTEXT', MT: 'MTEXT', DT: 'TEXT', ED: 'TEXTEDIT', DDEDIT: 'TEXTEDIT', DLI: 'DIMLINEAR', DIMLIN: 'DIMLINEAR', DAL: 'DIMALIGNED', DIMALI: 'DIMALIGNED',
    DCO: 'DIMCONTINUE', DI: 'DIST', AA: 'AREA', LA: 'LAYER', PR: 'PROPERTIES', UL: 'UNDERLAY', CAL: 'CALIBRATE', UM: 'UMOVE', UR: 'UROTATE', PROPS: 'PROPERTIES', CH: 'PROPERTIES', H: 'HATCH', BH: 'HATCH', HA: 'HATCH', SY: 'SYMBOL', SYM: 'SYMBOL', STENCIL: 'SYMBOL' };
  const opt = (name, short) => ({ name, short: short || name[0] });
  const bulge3 = (p1, p2, p3) => {
    const a = G.arcThrough3(p1, p2, p3); if (!a) return null;
    const ccw = G.cross(G.sub(p2, p1), G.sub(p3, p2)) > 0;
    const th = (ccw ? 1 : -1) * G.sweepOf(a.a0, a.a1);
    return Math.tan(th / 4);
  };
  const same = (a, b) => G.dist(a, b) < 1e-9;
  // Annotation sizes are set in millimetres on paper; model size = paper size x plot scale, converted to drawing units.
  function annoStyle(doc) {
    const d = doc.d, f = ({ mm: 1, m: 0.001, in: 1 / 25.4 })[d.units] || 1, k = (d.plotScale || 50) * f, ds = d.dimStyle || {};
    return { th: (d.textH || 2.5) * k, ar: (ds.arrow || 2.5) * k, eo: (ds.extOff || 1) * k, ee: (ds.extExt || 1.25) * k, gap: (ds.gap || 0.6) * k, dec: ds.decimals == null ? (d.units === 'mm' ? 0 : d.units === 'm' ? 3 : 2) : ds.decimals };
  }
  const fmtLen = (doc, v) => { const u = doc.d.units; return u === 'mm' ? G.fmtNum(v, 2) + ' mm (= ' + G.fmtNum(v / 1000, 3) + ' m)' : u === 'm' ? G.fmtNum(v, 4) + ' m' : G.fmtNum(v, 3) + ' in (= ' + G.fmtNum(v / 12, 3) + ' ft)'; };
  const fmtArea = (doc, a) => { const u = doc.d.units; return u === 'mm' ? G.fmtNum(a / 1e6, 3) + ' m\u00b2 (' + G.fmtNum(a, 1) + ' mm\u00b2)' : u === 'm' ? G.fmtNum(a, 4) + ' m\u00b2' : G.fmtNum(a, 2) + ' in\u00b2 (= ' + G.fmtNum(a / 144, 3) + ' ft\u00b2)'; };
  const rectPoly = (a, b) => ({ t: 'LWPOLYLINE', closed: true, v: [[a[0], a[1], 0], [b[0], a[1], 0], [b[0], b[1], 0], [a[0], b[1], 0]] });
  const withoutId = (e) => { const n = { ...e }; delete n.id; return n; };
  const polySegAt = (e, pt) => { let best = 0, bd = Infinity; G.polySegments(e).forEach((s, k) => { const d = G.nearestOnPrim(s, pt).d; if (d < bd) { bd = d; best = k; } }); return best; };
  // Vertex shared by two picked segments of one polyline (null when they are not neighbours).
  const sharedVertex = (e, k1, k2) => {
    const nSeg = G.polySegments(e).length;
    if (k1 === k2 || nSeg < 2) return null;
    if (k2 === (k1 + 1) % nSeg && (e.closed || k2 === k1 + 1)) return { v: k2, firstIsPrev: true };
    if (k1 === (k2 + 1) % nSeg && (e.closed || k1 === k2 + 1)) return { v: k1, firstIsPrev: false };
    return null;
  };

  // Shared by DIMLINEAR and DIMALIGNED.
  function* dimBody(c, kind) {
    const st = annoStyle(c.doc);
    const p1 = yield c.point('Specify first extension line origin:'); if (p1.kind !== 'point') return;
    const p2 = yield c.point('Specify second extension line origin:', { base: p1.pt, preview: (pt) => [{ t: 'LINE', p1: p1.pt, p2: pt }] }); if (p2.kind !== 'point') return;
    if (same(p1.pt, p2.pt)) { c.warn('The two points are identical.'); return; }
    let forced = null;                                   // null = decide from the cursor, 'H', 'V' or an angle in radians
    const mk = (off) => {
      let ang = 0;
      if (kind === 'lin') {
        if (typeof forced === 'number') ang = forced;
        else if (forced === 'V') ang = Math.PI / 2;
        else if (forced === 'H') ang = 0;
        else {
          const x0 = Math.min(p1.pt[0], p2.pt[0]), x1 = Math.max(p1.pt[0], p2.pt[0]), y0 = Math.min(p1.pt[1], p2.pt[1]), y1 = Math.max(p1.pt[1], p2.pt[1]);
          const vo = Math.max(0, y0 - off[1], off[1] - y1), ho = Math.max(0, x0 - off[0], off[0] - x1);
          ang = vo >= ho ? 0 : Math.PI / 2;
        }
      }
      return { t: 'DIM', k: kind, p1: p1.pt, p2: p2.pt, off, ang, ...st };
    };
    for (;;) {
      const r = yield c.point('Specify dimension line location or', { options: kind === 'lin' ? [opt('Horizontal', 'H'), opt('Vertical', 'V'), opt('Rotated', 'R')] : [], preview: (pt) => [mk(pt)] });
      if (r.kind === 'option') {
        if (r.name === 'Horizontal') forced = 'H'; else if (r.name === 'Vertical') forced = 'V';
        else { const a = yield c.number('Specify angle of dimension line', { default: 0 }); if (a.kind === 'number') forced = G.rad(a.value); }
        continue;
      }
      if (r.kind !== 'point') return;
      const d = mk(r.pt);
      c.add(d);
      const dd = { k: kind, p1: d.p1, p2: d.p2, off: r.pt, ang: d.ang, st };
      const f = DM.frame(d);
      dd.sd = G.dot(G.sub(r.pt, d.p2), f.n);
      c.engine.lastDim = dd;
      c.log('Dimension text = ' + DM.dimText(d));
      return;
    }
  }
  const COMMANDS = {
    *LINE(c) {
      let r = yield c.point('Specify first point:');
      let p0;
      if (r.kind === 'point') p0 = r.pt;
      else if (r.kind === 'enter' && c.engine.lastEnd) p0 = c.engine.lastEnd;
      else return;
      const first = p0, pts = [p0];
      for (;;) {
        const opts = [opt('Undo')];
        if (pts.length > 2) opts.unshift(opt('Close'));
        const from = p0;
        r = yield c.point('Specify next point or', { base: p0, options: opts, preview: (pt) => [{ t: 'LINE', p1: from, p2: pt }] });
        if (r.kind === 'option' && r.name === 'Undo') {
          if (pts.length > 1) { c.undoOp(); pts.pop(); p0 = pts[pts.length - 1]; }
          continue;
        }
        if (r.kind === 'option' && r.name === 'Close') { if (!same(p0, first)) c.add({ t: 'LINE', p1: p0, p2: first }); p0 = first; break; }
        if (r.kind !== 'point') break;
        if (same(p0, r.pt)) continue;
        c.add({ t: 'LINE', p1: p0, p2: r.pt });
        pts.push(r.pt); p0 = r.pt;
      }
      c.engine.lastEnd = p0;
    },

    *PLINE(c) {
      let r = yield c.point('Specify start point:');
      if (r.kind !== 'point') return;
      const verts = [[r.pt[0], r.pt[1], 0]];
      let ent = null, arcMode = false, closed = false;
      const sync = () => {
        if (verts.length < 2) { if (ent) { c.remove(ent.id); ent = null; } return; }
        const v = verts.map((q) => [q[0], q[1], q[2] || 0]);
        if (!ent) ent = c.add({ t: 'LWPOLYLINE', v, closed });
        else ent = c.replace(ent.id, { t: 'LWPOLYLINE', v, closed });
      };
      const lastTangent = () => {
        const segs = G.polySegments({ v: verts, closed: false });
        const s = segs[segs.length - 1];
        if (!s) return null;
        if (s.k === 's') return G.angleBetween(s.p1, s.p2);
        const end = s.p2, ang = G.angleBetween(s.c, end);
        return s.bulge > 0 ? ang + Math.PI / 2 : ang - Math.PI / 2;
      };
      for (;;) {
        const last = verts[verts.length - 1], lastPt = [last[0], last[1]];
        const opts = arcMode ? [opt('Line', 'L')] : [opt('Arc', 'A')];
        if (verts.length > 2) opts.push(opt('Close', 'C'));
        if (verts.length > 1) opts.push(opt('Undo', 'U'));
        if (arcMode && verts.length === 1) {
          // No previous segment to be tangent to: three-point arc.
          r = yield c.point('Specify second point on arc or', { base: lastPt, options: opts, preview: (pt) => [{ t: 'LINE', p1: lastPt, p2: pt }] });
          if (r.kind === 'option') { if (r.name === 'Line') arcMode = false; continue; }
          if (r.kind !== 'point') break;
          const p2 = r.pt;
          const r3 = yield c.point('Specify end point of arc:', { base: p2, preview: (pt) => { const b = bulge3(lastPt, p2, pt); return b == null ? [] : [{ t: 'LWPOLYLINE', closed: false, v: [[lastPt[0], lastPt[1], b], [pt[0], pt[1], 0]] }]; } });
          if (r3.kind !== 'point') break;
          const b = bulge3(lastPt, p2, r3.pt);
          if (b == null) { c.log('Points are collinear.'); continue; }
          verts[0][2] = b; verts.push([r3.pt[0], r3.pt[1], 0]); sync();
          continue;
        }
        const tan = arcMode ? lastTangent() : null;
        const msg = arcMode ? 'Specify endpoint of arc or' : 'Specify next point or';
        const prev = (pt) => {
          if (arcMode && tan != null) return [{ t: 'LWPOLYLINE', closed: false, v: [[lastPt[0], lastPt[1], G.bulgeFromTangent(lastPt, pt, tan)], [pt[0], pt[1], 0]] }];
          return [{ t: 'LINE', p1: lastPt, p2: pt }];
        };
        r = yield c.point(msg, { base: lastPt, options: opts, preview: prev });
        if (r.kind === 'option') {
          if (r.name === 'Arc') arcMode = true;
          else if (r.name === 'Line') arcMode = false;
          else if (r.name === 'Close') { closed = true; sync(); break; }
          else if (r.name === 'Undo') { verts.pop(); verts[verts.length - 1][2] = 0; sync(); }
          continue;
        }
        if (r.kind !== 'point') break;
        if (same(lastPt, r.pt)) continue;
        if (arcMode && tan != null) verts[verts.length - 1][2] = G.bulgeFromTangent(lastPt, r.pt, tan);
        verts.push([r.pt[0], r.pt[1], 0]);
        sync();
      }
      if (verts.length >= 2) { const l = verts[verts.length - 1]; c.engine.lastEnd = closed ? [verts[0][0], verts[0][1]] : [l[0], l[1]]; }
    },

    *RECTANG(c) {
      let r = yield c.point('Specify first corner point:');
      if (r.kind !== 'point') return;
      const p1 = r.pt;
      const poly = (a, b) => ({ t: 'LWPOLYLINE', closed: true, v: [[a[0], a[1], 0], [b[0], a[1], 0], [b[0], b[1], 0], [a[0], b[1], 0]] });
      let dims = null;
      for (;;) {
        const msg = 'Specify other corner point or';
        const corner = (pt) => dims ? [p1[0] + (pt[0] >= p1[0] ? 1 : -1) * dims.l, p1[1] + (pt[1] >= p1[1] ? 1 : -1) * dims.w] : pt;
        r = yield c.point(msg, { base: p1, options: [opt('Dimensions', 'D')], preview: (pt) => [poly(p1, corner(pt))] });
        if (r.kind === 'option' && r.name === 'Dimensions') {
          const dl = c.engine.lastRect || { l: 100, w: 100 };
          const rl = yield c.number('Specify length for rectangles', { default: dl.l });
          if (rl.kind !== 'number') break;
          const rw = yield c.number('Specify width for rectangles', { default: dl.w });
          if (rw.kind !== 'number') break;
          if (!(rl.value > 0) || !(rw.value > 0)) { c.log('Requires a positive, nonzero value.'); continue; }
          dims = { l: rl.value, w: rw.value }; c.engine.lastRect = dims;
          continue;
        }
        if (r.kind !== 'point') break;
        const p2 = corner(r.pt);
        if (Math.abs(p2[0] - p1[0]) < 1e-9 || Math.abs(p2[1] - p1[1]) < 1e-9) { c.log('Rectangle has zero width or height.'); break; }
        c.add(poly(p1, p2));
        break;
      }
    },

    *CIRCLE(c) {
      const circ = (ctr, rr) => [{ t: 'CIRCLE', c: ctr, r: rr }];
      let r = yield c.point('Specify center point for circle or', { options: [opt('3P', '3'), opt('2P', '2')] });
      if (r.kind === 'option' && r.name === '3P') {
        const a = yield c.point('Specify first point on circle:'); if (a.kind !== 'point') return;
        const b = yield c.point('Specify second point on circle:', { base: a.pt, preview: (pt) => [{ t: 'LINE', p1: a.pt, p2: pt }] }); if (b.kind !== 'point') return;
        const p3 = yield c.point('Specify third point on circle:', { preview: (pt) => { const cc = G.circumcircle(a.pt, b.pt, pt); return cc ? circ(cc.c, cc.r) : []; } }); if (p3.kind !== 'point') return;
        const cc = G.circumcircle(a.pt, b.pt, p3.pt);
        if (!cc) { c.log('Points are collinear; no circle.'); return; }
        c.add({ t: 'CIRCLE', c: cc.c, r: cc.r }); c.engine.lastRadius = cc.r; return;
      }
      if (r.kind === 'option' && r.name === '2P') {
        const a = yield c.point('Specify first end point of circle\'s diameter:'); if (a.kind !== 'point') return;
        const b = yield c.point('Specify second end point of circle\'s diameter:', { base: a.pt, preview: (pt) => circ(G.mid(a.pt, pt), G.dist(a.pt, pt) / 2) }); if (b.kind !== 'point') return;
        const rr = G.dist(a.pt, b.pt) / 2;
        if (rr > 0) { c.add({ t: 'CIRCLE', c: G.mid(a.pt, b.pt), r: rr }); c.engine.lastRadius = rr; }
        return;
      }
      if (r.kind !== 'point') return;
      const ctr = r.pt;
      const def = c.engine.lastRadius;
      let rr = yield c.number('Specify radius of circle or', { base: ctr, options: [opt('Diameter', 'D')], default: def, preview: (pt) => circ(ctr, G.dist(ctr, pt)) });
      if (rr.kind === 'option' && rr.name === 'Diameter') {
        const dd = yield c.number('Specify diameter of circle', { base: ctr, default: def ? def * 2 : undefined, preview: (pt) => circ(ctr, G.dist(ctr, pt) / 2) });
        if (dd.kind !== 'number') return;
        rr = { kind: 'number', value: dd.value / 2 };
      }
      if (rr.kind !== 'number') return;
      if (!(rr.value > 0)) { c.log('Requires a positive, nonzero value.'); return; }
      c.add({ t: 'CIRCLE', c: ctr, r: rr.value }); c.engine.lastRadius = rr.value;
    },

    *ARC(c) {
      let r = yield c.point('Specify start point of arc or', { options: [opt('Center', 'C')] });
      if (r.kind === 'option' && r.name === 'Center') {
        const ctr = yield c.point('Specify center point of arc:'); if (ctr.kind !== 'point') return;
        const st = yield c.point('Specify start point of arc:', { base: ctr.pt, preview: (pt) => [{ t: 'CIRCLE', c: ctr.pt, r: G.dist(ctr.pt, pt) }] }); if (st.kind !== 'point') return;
        const rad = G.dist(ctr.pt, st.pt), a0 = G.angleBetween(ctr.pt, st.pt);
        const en = yield c.point('Specify end point of arc:', { base: ctr.pt, preview: (pt) => [{ t: 'ARC', c: ctr.pt, r: rad, a0, a1: G.angleBetween(ctr.pt, pt) }] }); if (en.kind !== 'point') return;
        const a1 = G.angleBetween(ctr.pt, en.pt);
        if (rad > 0 && Math.abs(G.normAng(a1 - a0)) > 1e-9) { c.add({ t: 'ARC', c: ctr.pt, r: rad, a0, a1 }); c.engine.lastEnd = G.polar(ctr.pt, a1, rad); }
        return;
      }
      if (r.kind !== 'point') return;
      const p1 = r.pt;
      const p2 = yield c.point('Specify second point of arc:', { base: p1, preview: (pt) => [{ t: 'LINE', p1, p2: pt }] }); if (p2.kind !== 'point') return;
      const p3 = yield c.point('Specify end point of arc:', { base: p2.pt, preview: (pt) => { const a = G.arcThrough3(p1, p2.pt, pt); return a ? [{ t: 'ARC', ...a }] : []; } }); if (p3.kind !== 'point') return;
      const a = G.arcThrough3(p1, p2.pt, p3.pt);
      if (!a) { c.log('Points are collinear; no arc.'); return; }
      c.add({ t: 'ARC', ...a }); c.engine.lastEnd = p3.pt;
    },

    *POINT(c) {
      for (;;) {
        const r = yield c.point('Specify a point:');
        if (r.kind !== 'point') return;
        c.add({ t: 'POINT', p: r.pt });
      }
    },

    *ERASE(c) {
      const r = yield c.select('Select objects:');
      if (r.kind !== 'select' || !r.ids.length) return;
      for (const id of r.ids) c.remove(id);
      c.log(r.ids.length + ' erased.');
    },

    // ----- modify commands (slice 1b). Each starts with a select prompt that is skipped when objects are already selected. -----
    *MOVE(c) {
      const sel = yield c.select('Select objects:'); if (sel.kind !== 'select' || !sel.ids.length) return;
      const ents = sel.ids.map((id) => c.doc.byId.get(id)).filter(Boolean);
      const b = yield c.point('Specify base point:'); if (b.kind !== 'point') return;
      const s = yield c.point('Specify second point or <use first point as displacement>:', { base: b.pt, preview: (pt) => ents.map((e) => X.transformEntity(e, X.moveXf(G.sub(pt, b.pt)))) });
      let d; if (s.kind === 'point') d = G.sub(s.pt, b.pt); else if (s.kind === 'enter') d = b.pt; else return;
      for (const e of ents) c.replace(e.id, X.transformEntity(e, X.moveXf(d)));
      c.log(ents.length + ' moved.');
    },

    *COPY(c) {
      const sel = yield c.select('Select objects:'); if (sel.kind !== 'select' || !sel.ids.length) return;
      const ents = sel.ids.map((id) => c.doc.byId.get(id)).filter(Boolean);
      const b = yield c.point('Specify base point:'); if (b.kind !== 'point') return;
      let n = 0;
      for (;;) {
        const s = yield c.point(n ? 'Specify second point or' : 'Specify second point or <displacement>', { base: b.pt, options: [opt('Exit', 'E')], preview: (pt) => ents.map((e) => X.transformEntity(e, X.moveXf(G.sub(pt, b.pt)))) });
        let d;
        if (s.kind === 'point') d = G.sub(s.pt, b.pt);
        else if (s.kind === 'enter' && !n) d = b.pt;
        else break;
        for (const e of ents) c.add(withoutId(X.transformEntity(e, X.moveXf(d))));
        n++;
        if (s.kind === 'enter') break;
      }
      if (n) c.log(n + ' cop' + (n === 1 ? 'y' : 'ies') + ' made.');
    },

    *ROTATE(c) {
      const sel = yield c.select('Select objects:'); if (sel.kind !== 'select' || !sel.ids.length) return;
      const ents = sel.ids.map((id) => c.doc.byId.get(id)).filter(Boolean);
      const b = yield c.point('Specify base point:'); if (b.kind !== 'point') return;
      const angOf = (pt) => G.angleBetween(b.pt, pt);
      let copy = false;
      for (;;) {
        const r = yield c.point('Specify rotation angle or', { base: b.pt, allowNumber: true, options: [opt('Copy', 'C'), opt('Reference', 'R')], preview: (pt) => ents.map((e) => X.transformEntity(e, X.rotXf(b.pt, angOf(pt)))) });
        if (r.kind === 'option' && r.name === 'Copy') { copy = true; c.log('Rotating a copy of the selected objects.'); continue; }
        let ang;
        if (r.kind === 'option' && r.name === 'Reference') {
          const ra = yield c.point('Specify the reference angle <0>', { base: b.pt, allowNumber: true });
          let ref = 0;
          if (ra.kind === 'number') ref = G.rad(ra.value); else if (ra.kind === 'point') ref = angOf(ra.pt); else if (ra.kind !== 'enter') return;
          const na = yield c.point('Specify the new angle', { base: b.pt, allowNumber: true, preview: (pt) => ents.map((e) => X.transformEntity(e, X.rotXf(b.pt, angOf(pt) - ref))) });
          if (na.kind === 'number') ang = G.rad(na.value) - ref; else if (na.kind === 'point') ang = angOf(na.pt) - ref; else return;
        } else if (r.kind === 'number') ang = G.rad(r.value);
        else if (r.kind === 'point') ang = angOf(r.pt);
        else return;
        const xf = X.rotXf(b.pt, ang);
        for (const e of ents) { const n = X.transformEntity(e, xf); if (copy) c.add(withoutId(n)); else c.replace(e.id, n); }
        c.log(ents.length + (copy ? ' copied and rotated ' : ' rotated ') + G.fmtNum(G.deg(ang), 4) + ' degrees.');
        return;
      }
    },

    *SCALE(c) {
      const sel = yield c.select('Select objects:'); if (sel.kind !== 'select' || !sel.ids.length) return;
      const ents = sel.ids.map((id) => c.doc.byId.get(id)).filter(Boolean);
      const b = yield c.point('Specify base point:'); if (b.kind !== 'point') return;
      const fOf = (pt) => Math.max(G.dist(b.pt, pt), 1e-9);
      let copy = false;
      for (;;) {
        const r = yield c.point('Specify scale factor or', { base: b.pt, allowNumber: true, options: [opt('Copy', 'C'), opt('Reference', 'R')], preview: (pt) => ents.map((e) => X.transformEntity(e, X.scaleXf(b.pt, fOf(pt)))) });
        if (r.kind === 'option' && r.name === 'Copy') { copy = true; c.log('Scaling a copy of the selected objects.'); continue; }
        let f;
        if (r.kind === 'option' && r.name === 'Reference') {
          const ra = yield c.point('Specify reference length <1>', { base: b.pt, allowNumber: true });
          let ref = 1;
          if (ra.kind === 'number') ref = ra.value; else if (ra.kind === 'point') ref = G.dist(b.pt, ra.pt); else if (ra.kind !== 'enter') return;
          if (!(ref > 0)) { c.log('Reference length must be greater than zero.'); return; }
          const na = yield c.point('Specify new length', { base: b.pt, allowNumber: true, preview: (pt) => ents.map((e) => X.transformEntity(e, X.scaleXf(b.pt, fOf(pt) / ref))) });
          if (na.kind === 'number') f = na.value / ref; else if (na.kind === 'point') f = G.dist(b.pt, na.pt) / ref; else return;
        } else if (r.kind === 'number') f = r.value;
        else if (r.kind === 'point') f = G.dist(b.pt, r.pt);
        else return;
        if (!(f > 0)) { c.log('The scale factor must be greater than zero.'); return; }
        const xf = X.scaleXf(b.pt, f);
        for (const e of ents) { const n = X.transformEntity(e, xf); if (copy) c.add(withoutId(n)); else c.replace(e.id, n); }
        c.log(ents.length + ' scaled by ' + G.fmtNum(f, 6) + '.');
        return;
      }
    },

    *MIRROR(c) {
      const sel = yield c.select('Select objects:'); if (sel.kind !== 'select' || !sel.ids.length) return;
      const ents = sel.ids.map((id) => c.doc.byId.get(id)).filter(Boolean);
      const p1 = yield c.point('Specify first point of mirror line:'); if (p1.kind !== 'point') return;
      const p2 = yield c.point('Specify second point of mirror line:', { base: p1.pt, preview: (pt) => (same(p1.pt, pt) ? [] : [{ t: 'LINE', p1: p1.pt, p2: pt }].concat(ents.map((e) => X.transformEntity(e, X.mirrorXf(p1.pt, pt))))) });
      if (p2.kind !== 'point') return;
      if (same(p1.pt, p2.pt)) { c.log('The two points are identical.'); return; }
      const er = yield c.key('Erase source objects?', [opt('Yes', 'Y'), opt('No', 'N')]);
      if (er.kind === 'point' || er.kind === 'select') return;
      const xf = X.mirrorXf(p1.pt, p2.pt), erase = er.kind === 'option' && er.name === 'Yes';
      for (const e of ents) { c.add(withoutId(X.transformEntity(e, xf))); if (erase) c.remove(e.id); }
      c.log(ents.length + ' mirrored.');
    },

    *OFFSET(c) {
      const eng = c.engine;
      const r = yield c.number('Specify offset distance or', { options: [opt('Through', 'T')], default: eng.lastOffset || undefined });
      let through = false, dst = null;
      if (r.kind === 'option') through = true;
      else if (r.kind === 'number') { if (!(r.value > 0)) { c.log('The offset distance must be greater than zero.'); return; } dst = r.value; eng.lastOffset = dst; }
      else return;
      const make = (e, pt) => X.offsetEntity(e, X.offsetSide(e, pt) * (through ? X.offsetDistanceThrough(e, pt) : dst));
      for (;;) {
        const s = yield c.select('Select object to offset or', { single: true, options: [opt('Exit', 'E')] });
        if (s.kind !== 'select' || !s.ids.length) return;
        const e = c.doc.byId.get(s.ids[0]); if (!e) continue;
        if (!['LINE', 'CIRCLE', 'ARC', 'LWPOLYLINE'].includes(e.t)) { c.warn('This object cannot be offset.'); continue; }
        const q = yield c.point(through ? 'Specify through point or' : 'Specify point on side to offset or', { options: [opt('Exit', 'E')], preview: (pt) => { const o = make(e, pt); return o ? [o] : []; } });
        if (q.kind !== 'point') return;
        const o = make(e, q.pt);
        if (!o) { c.warn('Cannot offset: the result would collapse.'); continue; }
        c.add(withoutId(o));
      }
    },

    *TRIM(c) {
      c.log('Pick the part to trim. All other objects are cutting edges.');
      const counts = [];
      for (;;) {
        const s = yield c.select('Select object to trim or', { single: true, options: [opt('Undo', 'U')] });
        if (s.kind === 'option' && s.name === 'Undo') {
          const k = counts.pop();
          if (k == null) c.log('Nothing to undo.'); else for (let i = 0; i < k; i++) c.undoOp();
          continue;
        }
        if (s.kind !== 'select' || !s.ids.length) return;
        const e = c.doc.byId.get(s.ids[0]); if (!e) continue;
        const bb = G.bbox(e), others = c.doc.queryVis(bb.minX, bb.minY, bb.maxX, bb.maxY).filter((o) => o.id !== e.id);
        const res = X.trimEntity(e, s.pt || G.mid([bb.minX, bb.minY], [bb.maxX, bb.maxY]), others);
        if (res.error) { c.warn(res.error); continue; }
        const before = c.opCount();
        c.remove(e.id);
        for (const p of res.pieces) c.add(withoutId(p));
        counts.push(c.opCount() - before);
      }
    },

    *EXTEND(c) {
      c.log('Pick the end to extend. All other objects are boundary edges.');
      const counts = [];
      for (;;) {
        const s = yield c.select('Select object to extend or', { single: true, options: [opt('Undo', 'U')] });
        if (s.kind === 'option' && s.name === 'Undo') {
          const k = counts.pop();
          if (k == null) c.log('Nothing to undo.'); else for (let i = 0; i < k; i++) c.undoOp();
          continue;
        }
        if (s.kind !== 'select' || !s.ids.length) return;
        const e = c.doc.byId.get(s.ids[0]); if (!e) continue;
        const others = c.doc.entities.filter((o) => o.id !== e.id);
        const res = X.extendEntity(e, s.pt || [0, 0], others);
        if (res.error) { c.warn(res.error); continue; }
        if (res.implied) c.log('Extended to where the boundary would meet it if extended.');
        const before = c.opCount();
        c.replace(e.id, res.entity);
        counts.push(c.opCount() - before);
      }
    },

    *FILLET(c) {
      const eng = c.engine;
      if (eng.filletTrim == null) eng.filletTrim = true;
      if (eng.filletR == null) {
        const r0 = yield c.number('Specify fillet radius', { default: 0 });
        if (r0.kind !== 'number' || r0.value < 0) return;
        eng.filletR = r0.value;
      }
      c.log('Mode = ' + (eng.filletTrim ? 'TRIM' : 'NOTRIM') + ', Radius = ' + G.fmtNum(eng.filletR, 4));
      for (;;) {
        const a = yield c.select('Fillet (radius ' + G.fmtNum(eng.filletR, 4) + '): select first line or', { single: true, options: [opt('Polyline', 'P'), opt('Radius', 'R'), opt('Trim', 'T')] });
        if (a.kind === 'option') {
          if (a.name === 'Radius') { const r = yield c.number('Specify fillet radius', { default: eng.filletR }); if (r.kind === 'number' && r.value >= 0) eng.filletR = r.value; continue; }
          if (a.name === 'Trim') { const t = yield c.key('Trim mode?', [opt('Trim', 'T'), opt('No trim', 'N')]); if (t.kind === 'option') eng.filletTrim = t.name === 'Trim'; continue; }
          if (a.name === 'Polyline') {
            const p = yield c.select('Select 2D polyline', { single: true });
            if (p.kind !== 'select' || !p.ids.length) return;
            const e = c.doc.byId.get(p.ids[0]);
            if (!e || e.t !== 'LWPOLYLINE') { c.warn('That is not a polyline.'); return; }
            const n = X.polyCorners(e, 'fillet', eng.filletR);
            if (!n) { c.warn(eng.filletR > 0 ? 'Nothing to fillet. The radius is too big for the segment lengths, or the corners are arcs.' : 'The radius is 0, so there is nothing to round. Set a radius with R.'); return; }
            c.replace(e.id, n); c.log('Polyline corners filleted.'); return;
          }
          return;
        }
        if (a.kind !== 'select' || !a.ids.length) return;
        const e1 = c.doc.byId.get(a.ids[0]); if (!e1) continue;
        if (e1.t !== 'LINE' && e1.t !== 'LWPOLYLINE') { c.warn('Fillet works on lines and polyline corners.'); continue; }
        const b = yield c.select('Select second line' + (e1.t === 'LWPOLYLINE' ? ' (the neighbouring segment of the same polyline)' : ''), { single: true });
        if (b.kind !== 'select' || !b.ids.length) return;
        const e2 = c.doc.byId.get(b.ids[0]);
        if (!e2) return;
        if (e1.t === 'LWPOLYLINE' || e2.t === 'LWPOLYLINE') {
          if (e1.id !== e2.id) { c.warn('To round a polyline corner, pick the two segments that meet at it.'); return; }
          const sv = sharedVertex(e1, polySegAt(e1, a.pt || [0, 0]), polySegAt(e1, b.pt || [0, 0]));
          if (!sv) { c.warn('Those two segments do not meet at a corner.'); return; }
          const n = X.polyCorners(e1, 'fillet', eng.filletR, 0, sv.v);
          if (!n) { c.warn(eng.filletR > 0 ? 'The radius is too big for these segments, or the corner is an arc.' : 'The radius is 0, so there is nothing to round. Set a radius with R.'); return; }
          c.replace(e1.id, n); return;
        }
        if (e2.t !== 'LINE' || e2.id === e1.id) { c.warn('Pick a second, different line.'); return; }
        const res = X.filletLines(e1, a.pt || e1.p1, e2, b.pt || e2.p1, eng.filletR, eng.filletTrim);
        if (res.error) { c.warn(res.error); return; }
        if (res.l1) c.replace(e1.id, res.l1);
        if (res.l2) c.replace(e2.id, res.l2);
        if (res.arc) c.add(res.arc);
        return;
      }
    },

    *CHAMFER(c) {
      const eng = c.engine;
      if (eng.chamTrim == null) eng.chamTrim = true;
      if (eng.chamD1 == null) {
        const d1 = yield c.number('Specify first chamfer distance', { default: 0 });
        if (d1.kind !== 'number' || d1.value < 0) return;
        const d2 = yield c.number('Specify second chamfer distance', { default: d1.value });
        if (d2.kind !== 'number' || d2.value < 0) return;
        eng.chamD1 = d1.value; eng.chamD2 = d2.value;
      }
      c.log('Mode = ' + (eng.chamTrim ? 'TRIM' : 'NOTRIM') + ', Distances = ' + G.fmtNum(eng.chamD1, 4) + ', ' + G.fmtNum(eng.chamD2, 4));
      for (;;) {
        const a = yield c.select('Chamfer (' + G.fmtNum(eng.chamD1, 4) + ', ' + G.fmtNum(eng.chamD2, 4) + '): select first line or', { single: true, options: [opt('Polyline', 'P'), opt('Distance', 'D'), opt('Trim', 'T')] });
        if (a.kind === 'option') {
          if (a.name === 'Distance') {
            const d1 = yield c.number('Specify first chamfer distance', { default: eng.chamD1 });
            if (d1.kind !== 'number' || d1.value < 0) continue;
            const d2 = yield c.number('Specify second chamfer distance', { default: d1.value });
            if (d2.kind !== 'number' || d2.value < 0) continue;
            eng.chamD1 = d1.value; eng.chamD2 = d2.value; continue;
          }
          if (a.name === 'Trim') { const t = yield c.key('Trim mode?', [opt('Trim', 'T'), opt('No trim', 'N')]); if (t.kind === 'option') eng.chamTrim = t.name === 'Trim'; continue; }
          if (a.name === 'Polyline') {
            const p = yield c.select('Select 2D polyline', { single: true });
            if (p.kind !== 'select' || !p.ids.length) return;
            const e = c.doc.byId.get(p.ids[0]);
            if (!e || e.t !== 'LWPOLYLINE') { c.warn('That is not a polyline.'); return; }
            const n = X.polyCorners(e, 'chamfer', eng.chamD1, eng.chamD2);
            if (!n) { c.warn('Nothing to chamfer. The distances are 0 or too long for the segments.'); return; }
            c.replace(e.id, n); c.log('Polyline corners chamfered.'); return;
          }
          return;
        }
        if (a.kind !== 'select' || !a.ids.length) return;
        const e1 = c.doc.byId.get(a.ids[0]); if (!e1) continue;
        if (e1.t !== 'LINE' && e1.t !== 'LWPOLYLINE') { c.warn('Chamfer works on lines and polyline corners.'); continue; }
        const b = yield c.select('Select second line' + (e1.t === 'LWPOLYLINE' ? ' (the neighbouring segment of the same polyline)' : ''), { single: true });
        if (b.kind !== 'select' || !b.ids.length) return;
        const e2 = c.doc.byId.get(b.ids[0]);
        if (!e2) return;
        if (e1.t === 'LWPOLYLINE' || e2.t === 'LWPOLYLINE') {
          if (e1.id !== e2.id) { c.warn('To chamfer a polyline corner, pick the two segments that meet at it.'); return; }
          const sv = sharedVertex(e1, polySegAt(e1, a.pt || [0, 0]), polySegAt(e1, b.pt || [0, 0]));
          if (!sv) { c.warn('Those two segments do not meet at a corner.'); return; }
          const n = X.polyCorners(e1, 'chamfer', sv.firstIsPrev ? eng.chamD1 : eng.chamD2, sv.firstIsPrev ? eng.chamD2 : eng.chamD1, sv.v);
          if (!n) { c.warn('The distances are 0 or too long for these segments, or the corner is an arc.'); return; }
          c.replace(e1.id, n); return;
        }
        if (e2.t !== 'LINE' || e2.id === e1.id) { c.warn('Pick a second, different line.'); return; }
        const res = X.chamferLines(e1, a.pt || e1.p1, e2, b.pt || e2.p1, eng.chamD1, eng.chamD2, eng.chamTrim);
        if (res.error) { c.warn(res.error); return; }
        if (res.l1) c.replace(e1.id, res.l1);
        if (res.l2) c.replace(e2.id, res.l2);
        if (res.line) c.add(res.line);
        return;
      }
    },

    *STRETCH(c) {
      // The crossing window must ENCLOSE the endpoints / vertices / centres you want to move (as in AutoCAD).
      let R, movers;
      for (;;) {
        const a = yield c.point('Specify first corner of the crossing window (enclose the endpoints to move):'); if (a.kind !== 'point') return;
        const q = yield c.point('Specify opposite corner:', { base: a.pt, preview: (pt) => [rectPoly(a.pt, pt)] }); if (q.kind !== 'point') return;
        R = G.rectOf(a.pt, q.pt);
        const found = c.doc.queryVis(R.minX, R.minY, R.maxX, R.maxY).filter((e) => c.doc.isSelectable(e) && (G.entCrossesRect(e, R) || G.entInWindow(e, R)));
        movers = found.filter((e) => X.stretchEntity(e, R, [0, 0]));
        if (movers.length) break;
        c.warn(found.length ? 'No endpoints or vertices inside the window. Draw the window around the points you want to move.' : 'No objects found in the window.');
      }
      c.engine.selection = new Set(movers.map((e) => e.id));
      c.log(movers.length + ' object' + (movers.length === 1 ? '' : 's') + ' will stretch');
      const b = yield c.point('Specify base point:'); if (b.kind !== 'point') return;
      const s = yield c.point('Specify second point or <use first point as displacement>:', { base: b.pt, preview: (pt) => movers.map((e) => X.stretchEntity(e, R, G.sub(pt, b.pt))).filter(Boolean) });
      let d; if (s.kind === 'point') d = G.sub(s.pt, b.pt); else if (s.kind === 'enter') d = b.pt; else return;
      let n = 0;
      for (const e of movers) { const ne = X.stretchEntity(e, R, d); if (ne) { c.replace(e.id, ne); n++; } }
      c.log(n + ' stretched.');
    },

    *EXPLODE(c) {
      const sel = yield c.select('Select objects:'); if (sel.kind !== 'select' || !sel.ids.length) return;
      let n = 0, skipped = 0;
      for (const id of sel.ids) {
        const e = c.doc.byId.get(id); if (!e) continue;
        const parts = X.explode(e);
        if (!parts) { skipped++; continue; }
        c.remove(e.id); for (const p of parts) c.add(p); n++;
      }
      c.log(n + ' exploded.' + (skipped ? ' ' + skipped + ' cannot be exploded.' : ''));
    },

    // ----- hatching (slice 1e) -----
    // Tap inside a closed shape (lines, arcs, circles, polylines meeting up) to fill it; Object picks closed polylines or circles.
    *HATCH(c) {
      const eng = c.engine; eng.hatch = eng.hatch || { pat: 'Lines', sc: 1, ang: 0 };
      const h = eng.hatch, pk = (c.doc.d.plotScale || 50) * (({ mm: 1, m: 0.001, in: 1 / 25.4 })[c.doc.d.units] || 1);
      const mk = (loops, src) => { const e = { t: 'HATCH', loops, pat: h.pat, sc: h.sc, ang: G.rad(h.ang), pk, seed: (Math.random() * 4294967295) >>> 0 }; if (src) e.src = { ...src, fresh: true }; return e; };
      const boundaryEnts = () => c.doc.entities.filter((e) => e.t !== 'HATCH' && (e.t === 'LINE' || e.t === 'ARC' || e.t === 'CIRCLE' || e.t === 'LWPOLYLINE') && c.doc.isVisible(e));
      c.log('Hatch: ' + CH.PATTERNS[h.pat].label + ', scale ' + G.fmtNum(h.sc, 3) + ', angle ' + G.fmtNum(h.ang, 2) + '.');
      let n = 0;
      for (;;) {
        const r = yield c.point('Pick a point inside a closed shape, or', { options: [opt('Pattern', 'P'), opt('Scale', 'S'), opt('Angle', 'A'), opt('Object', 'O')] });
        if (r.kind === 'option') {
          if (r.name === 'Pattern') {
            const k = yield c.key('Hatch pattern', CH.NAMES.map((nm) => opt(nm, nm === 'Solid' ? 'So' : nm === 'Gravel' ? 'Gv' : nm.slice(0, 2))));
            if (k.kind === 'option') { h.pat = k.name; c.log('Pattern: ' + CH.PATTERNS[h.pat].label); }
          } else if (r.name === 'Scale') {
            const v = yield c.number('Pattern scale', { default: h.sc }); if (v.kind === 'number' && v.value > 0) h.sc = v.value;
          } else if (r.name === 'Angle') {
            const v = yield c.number('Pattern angle in degrees', { default: h.ang }); if (v.kind === 'number') h.ang = v.value;
          } else if (r.name === 'Object') {
            const sel = yield c.select('Select closed polylines or circles:'); if (sel.kind !== 'select' || !sel.ids.length) continue;
            const picked = sel.ids.map((id) => c.doc.byId.get(id)).filter(Boolean), good = picked.filter((q) => (q.t === 'LWPOLYLINE' && q.closed && q.v.length >= 3) || q.t === 'CIRCLE');
            const { loops, skipped } = CH.loopsFromObjects(good);
            if (!loops.length) { c.warn('Select closed polylines or circles.'); continue; }
            c.add(mk(loops, { mode: 'obj', ids: good.map((q) => q.id), c: CH.centreOf(good) })); n++;
            if (skipped) c.log(skipped + ' object(s) skipped: not closed.');
          }
          continue;
        }
        if (r.kind !== 'point') break;
        const res = CH.findBoundary(boundaryEnts(), r.pt, { tol: 0.05 * pk });
        if (res.error) { c.warn(res.error); continue; }
        const cands = boundaryEnts(), ids = CH.sourceIds(cands, res.loops, 0.02 * pk);
        c.add(mk(res.loops, { mode: 'pt', pt: r.pt, ids, c: CH.centreOf(ids.map((id) => c.doc.byId.get(id)).filter(Boolean)) })); n++;
        c.log('Hatch added' + (res.loops.length > 1 ? ' with ' + (res.loops.length - 1) + ' island(s)' : '') + '.');
      }
      if (n) c.log(n + ' hatch' + (n > 1 ? 'es' : '') + ' created.');
    },

    // ----- stencils (slice 1f) -----
    // Place stone, tree and other symbols. Options: Symbol, Size (in the drawing's metres/units), Rotate.
    *SYMBOL(c) {
      const eng = c.engine; eng.sym = eng.sym || { name: 'Tree', rot: 0, size: null };
      const s = eng.sym, d = c.doc.d, U = ({ mm: 1000, m: 1, in: 39.37007874 })[d.units] || 1000;
      const size = () => s.size || SYM.defaultSize(s.name, d);
      const mk = (pt) => ({ t: 'SYM', p: pt, name: s.name, sz: size(), rot: G.rad(s.rot), seed: 1 + Math.floor(Math.random() * 2147483000) });
      let seed = mk([0, 0]).seed, n = 0;
      c.log(SYM.SYMBOLS[s.name].label + ', size ' + G.fmtNum(size() / U, 3) + (SYM.SYMBOLS[s.name].paperMm ? ' m on the ground (' + SYM.SYMBOLS[s.name].paperMm + ' mm on paper)' : ' m') + ', rotation ' + G.fmtNum(s.rot, 1) + '.');
      for (;;) {
        const r = yield c.point('Pick where to place the ' + SYM.SYMBOLS[s.name].label.toLowerCase() + ', or', { options: [opt('Symbol', 'S'), opt('Size', 'Z'), opt('Rotate', 'R')], preview: (pt) => [{ ...mk(pt), seed }] });
        if (r.kind === 'option') {
          if (r.name === 'Symbol') { const k = yield c.key('Symbol', SYM.NAMES.map((nm) => opt(SYM.SYMBOLS[nm].label, nm.slice(0, 2)))); if (k.kind === 'option') { const nm = SYM.NAMES.find((x) => SYM.SYMBOLS[x].label === k.name); if (nm) { s.name = nm; s.size = null; } } }
          else if (r.name === 'Size') { const v = yield c.number('Symbol size in metres', { default: +(size() / U).toFixed(3) }); if (v.kind === 'number' && v.value > 0) s.size = v.value * U; }
          else if (r.name === 'Rotate') { const v = yield c.number('Rotation in degrees', { default: s.rot }); if (v.kind === 'number') s.rot = v.value; }
          continue;
        }
        if (r.kind !== 'point') break;
        c.add({ ...mk(r.pt), seed }); n++; seed = mk([0, 0]).seed;
      }
      if (n) c.log(n + ' symbol' + (n > 1 ? 's' : '') + ' placed.');
    },

    // ----- annotate and measure (slice 1c) -----
    *TEXT(c) {
      const st = annoStyle(c.doc);
      const p = yield c.point('Specify start point of text:'); if (p.kind !== 'point') return;
      const h = yield c.number('Specify text height', { default: c.engine.lastTextH || st.th }); if (h.kind !== 'number' || !(h.value > 0)) return;
      c.engine.lastTextH = h.value;
      const r = yield c.point('Specify rotation angle of text <0>', { base: p.pt, allowNumber: true });
      let rot = 0;
      if (r.kind === 'number') rot = G.rad(r.value); else if (r.kind === 'point') rot = G.angleBetween(p.pt, r.pt); else if (r.kind !== 'enter') return;
      const t = yield c.text('Enter text');
      if (t.kind !== 'text' || !t.value.trim()) return;
      c.add({ t: 'TEXT', p: p.pt, h: h.value, rot, text: t.value.trim() });
    },

    *MTEXT(c) {
      const st = annoStyle(c.doc);
      const a = yield c.point('Specify first corner of the text box:'); if (a.kind !== 'point') return;
      const b = yield c.point('Specify opposite corner:', { base: a.pt, preview: (pt) => [rectPoly(a.pt, pt)] }); if (b.kind !== 'point') return;
      const R = G.rectOf(a.pt, b.pt), w = R.maxX - R.minX;
      const t = yield c.text('Enter text', { multiline: true });
      if (t.kind !== 'text' || !t.value.trim()) return;
      c.add({ t: 'MTEXT', p: [R.minX, R.maxY], h: c.engine.lastTextH || st.th, rot: 0, w: w > st.th ? w : 0, text: t.value.trim() });
    },

    *TEXTEDIT(c) {
      const sel = yield c.select('Select text or a dimension to edit:'); if (sel.kind !== 'select' || !sel.ids.length) return;
      const e = sel.ids.map((id) => c.doc.byId.get(id)).find((x) => x && (x.t === 'TEXT' || x.t === 'MTEXT' || x.t === 'DIM'));
      if (!e) { c.warn('Select text, multiline text or a dimension.'); return; }
      const isDim = e.t === 'DIM';
      const t = yield c.text(isDim ? 'Dimension text (<> = measured value)' : 'Edit text', { multiline: e.t === 'MTEXT', current: isDim ? (e.txt || '<>') : e.text });
      if (t.kind !== 'text' || !t.value.trim()) return;
      const n = JSON.parse(JSON.stringify(e));
      if (isDim) { if (t.value.trim() === '<>') delete n.txt; else n.txt = t.value.trim(); } else n.text = t.value.trim();
      c.replace(e.id, n);
    },

    *DIMLINEAR(c) { yield* dimBody(c, 'lin'); },
    *DIMALIGNED(c) { yield* dimBody(c, 'ali'); },

    *DIMCONTINUE(c) {
      const ld = c.engine.lastDim;
      if (!ld) { c.warn('Place a dimension first (DIMLINEAR or DIMALIGNED), then continue from it.'); return; }
      let from = ld.p2;
      const make = (to) => {
        let off = ld.off;
        if (ld.k === 'ali') { const d = G.sub(to, from), l = G.len(d) || 1, n = [-d[1] / l, d[0] / l]; off = G.add(to, G.mul(n, ld.sd)); }
        return { t: 'DIM', k: ld.k, p1: from, p2: to, off, ang: ld.ang, ...ld.st };
      };
      for (;;) {
        const r = yield c.point('Specify next extension line origin or', { base: from, options: [opt('Exit', 'E')], preview: (pt) => (G.dist(from, pt) > 1e-9 ? [make(pt)] : []) });
        if (r.kind !== 'point' || G.dist(from, r.pt) < 1e-9) return;
        c.add(make(r.pt)); from = r.pt; ld.p2 = from;
      }
    },

    *DIST(c) {
      const a = yield c.point('Specify first point:'); if (a.kind !== 'point') return;
      const b = yield c.point('Specify second point:', { base: a.pt, preview: (pt) => [{ t: 'LINE', p1: a.pt, p2: pt }] }); if (b.kind !== 'point') return;
      const d = G.dist(a.pt, b.pt), dx = b.pt[0] - a.pt[0], dy = b.pt[1] - a.pt[1], ang = (G.deg(G.angleBetween(a.pt, b.pt)) + 360) % 360;
      c.log('Distance = ' + fmtLen(c.doc, d));
      c.log('Angle in XY plane = ' + G.fmtNum(ang, 2) + ' deg, Delta X = ' + G.fmtNum(dx, 3) + ', Delta Y = ' + G.fmtNum(dy, 3));
      c.engine.overlay = [{ t: 'LINE', p1: a.pt, p2: b.pt }];
      c.warn('Distance ' + fmtLen(c.doc, d) + '  ·  ∠ ' + G.fmtNum(ang, 1) + '°  ·  ΔX ' + G.fmtNum(dx, 3) + '  ΔY ' + G.fmtNum(dy, 3));
    },

    *AREA(c) {
      const first = yield c.point('Specify first corner point or', { options: [opt('Object', 'O')] });
      let verts, closed = true, label = '';
      if (first.kind === 'option') {
        const s = yield c.select('Select a polyline or circle:', { single: true }); if (s.kind !== 'select' || !s.ids.length) return;
        const e = c.doc.byId.get(s.ids[0]);
        if (e && e.t === 'CIRCLE') {
          const a = Math.PI * e.r * e.r, l = 2 * Math.PI * e.r;
          c.log('Area = ' + fmtArea(c.doc, a)); c.log('Circumference = ' + fmtLen(c.doc, l));
          c.engine.overlay = [e]; c.warn('Area ' + fmtArea(c.doc, a)); return;
        }
        if (!e || e.t !== 'LWPOLYLINE') { c.warn('Pick a polyline or a circle.'); return; }
        verts = e.v; closed = !!e.closed; label = e.closed ? 'Perimeter' : 'Length';
        c.engine.overlay = [e];
      } else {
        if (first.kind !== 'point') return;
        const pts = [first.pt];
        for (;;) {
          const r = yield c.point('Specify next corner point or press ENTER for total', { base: pts[pts.length - 1], preview: (pt) => [{ t: 'LWPOLYLINE', closed: true, v: pts.concat([pt]).map((q) => [q[0], q[1], 0]) }] });
          if (r.kind === 'point') pts.push(r.pt); else break;
        }
        if (pts.length < 3) { c.warn('An area needs at least three points.'); return; }
        verts = pts.map((q) => [q[0], q[1], 0]); label = 'Perimeter';
        c.engine.overlay = [{ t: 'LWPOLYLINE', closed: true, v: verts }];
      }
      const ap = X.areaPerimeter(verts, closed);
      c.log('Area = ' + fmtArea(c.doc, ap.area)); c.log(label + ' = ' + fmtLen(c.doc, ap.perimeter));
      c.warn('Area ' + fmtArea(c.doc, ap.area) + '  ·  ' + label + ' ' + fmtLen(c.doc, ap.perimeter));
    },

    // ----- underlays (slice 1d) -----
    // Scale the underlay so two points you pick on it are a known real distance apart.
    *CALIBRATE(c) {
      const list = c.doc.d.underlays || [], u = (c.engine.params && c.engine.params.ul && c.doc.underlay(c.engine.params.ul)) || list[list.length - 1];
      if (!u) { c.warn('There is no underlay. Add one first.'); return; }
      const a = yield c.point('Calibrate: specify first point on the underlay:'); if (a.kind !== 'point') return;
      const b = yield c.point('Specify second point:', { base: a.pt, preview: (pt) => [{ t: 'LINE', p1: a.pt, p2: pt }] }); if (b.kind !== 'point') return;
      const m = G.dist(a.pt, b.pt); if (m < 1e-9) { c.warn('The two points are identical.'); return; }
      const r = yield c.number('Enter the real distance between the points', { base: a.pt, default: m }); if (r.kind !== 'number' || !(r.value > 0)) return;
      const k = r.value / m;
      c.doc.patchUnderlay(u.id, { x: a.pt[0] + (u.x - a.pt[0]) * k, y: a.pt[1] + (u.y - a.pt[1]) * k, w: u.w * k, h: u.h * k });
      c.log('Underlay scaled by ' + G.fmtNum(k, 5) + '. The picked points are now ' + fmtLen(c.doc, r.value) + ' apart.');
      c.engine.overlay = [{ t: 'LINE', p1: a.pt, p2: [a.pt[0] + (b.pt[0] - a.pt[0]) * k, a.pt[1] + (b.pt[1] - a.pt[1]) * k] }];
      c.warn('Underlay scaled by ' + G.fmtNum(k, 4));
    },

    *UMOVE(c) {
      const list = c.doc.d.underlays || [], u = (c.engine.params && c.engine.params.ul && c.doc.underlay(c.engine.params.ul)) || list[list.length - 1];
      if (!u) { c.warn('There is no underlay.'); return; }
      const a = yield c.point('Specify base point:'); if (a.kind !== 'point') return;
      const b = yield c.point('Specify second point:', { base: a.pt, preview: (pt) => [{ t: 'LINE', p1: a.pt, p2: pt }] }); if (b.kind !== 'point') return;
      c.doc.patchUnderlay(u.id, { x: u.x + b.pt[0] - a.pt[0], y: u.y + b.pt[1] - a.pt[1] });
    },

    *UROTATE(c) {
      const list = c.doc.d.underlays || [], u = (c.engine.params && c.engine.params.ul && c.doc.underlay(c.engine.params.ul)) || list[list.length - 1];
      if (!u) { c.warn('There is no underlay.'); return; }
      const a = yield c.point('Specify base point:'); if (a.kind !== 'point') return;
      const r = yield c.point('Specify rotation angle (or pick a point)', { base: a.pt, allowNumber: true }); let ang;
      if (r.kind === 'number') ang = G.rad(r.value); else if (r.kind === 'point') ang = G.angleBetween(a.pt, r.pt); else return;
      const cs = Math.cos(ang), sn = Math.sin(ang), dx = u.x - a.pt[0], dy = u.y - a.pt[1];
      c.doc.patchUnderlay(u.id, { x: a.pt[0] + dx * cs - dy * sn, y: a.pt[1] + dx * sn + dy * cs, rot: (u.rot || 0) + ang });
    },

    // Internal: drag a grip of a selected object (started by the canvas, not typed).
    *GRIP(c) {
      const { id, grip } = c.engine.params || {};
      const e = c.doc.byId.get(id); if (!e) return;
      c.engine.keepSel = [id];
      const r = yield c.point('Specify stretch point:', { base: grip.pt, preview: (pt) => { const n = X.gripApply(e, grip, pt); return n ? [n] : []; } });
      if (r.kind !== 'point') return;
      const n = X.gripApply(e, grip, r.pt);
      if (!n) { c.log('That would make the object invalid.'); return; }
      c.replace(id, n);
    },

    *ZOOM(c) {
      const h = c.engine.host;
      const r = yield c.point('Specify corner of window, enter a scale factor (nX), or', { options: [opt('All', 'A'), opt('Extents', 'E'), opt('Previous', 'P'), opt('Scale', 'S'), opt('Window', 'W')], allowNumber: true });
      if (r.kind === 'number') { if (r.value > 0 && h.zoomScale) h.zoomScale(r.value); return; }
      if (r.kind === 'option') {
        if (r.name === 'All' || r.name === 'Extents') { if (h.zoomExtents) h.zoomExtents(); return; }
        if (r.name === 'Previous') { if (h.zoomPrevious) h.zoomPrevious(); return; }
        if (r.name === 'Scale') {
          const s = yield c.number('Enter a scale factor (nX)', { default: 1 });
          if (s.kind === 'number' && s.value > 0 && h.zoomScale) h.zoomScale(s.value);
          return;
        }
        const a = yield c.point('Specify first corner:'); if (a.kind !== 'point') return;
        const b = yield c.point('Specify opposite corner:', { base: a.pt, preview: (pt) => [{ t: 'LWPOLYLINE', closed: true, v: [[a.pt[0], a.pt[1], 0], [pt[0], a.pt[1], 0], [pt[0], pt[1], 0], [a.pt[0], pt[1], 0]] }] });
        if (b.kind === 'point' && h.zoomWindow) h.zoomWindow(a.pt, b.pt);
        return;
      }
      if (r.kind === 'point') {
        const b = yield c.point('Specify opposite corner:', { base: r.pt, preview: (pt) => [{ t: 'LWPOLYLINE', closed: true, v: [[r.pt[0], r.pt[1], 0], [pt[0], r.pt[1], 0], [pt[0], pt[1], 0], [r.pt[0], pt[1], 0]] }] });
        if (b.kind === 'point' && h.zoomWindow) h.zoomWindow(r.pt, b.pt);
        return;
      }
      c.log('Use pinch, two-finger drag or the mouse wheel for real-time zoom and pan.');
    },

    *PAN(c) {
      const a = yield c.point('Specify base point or displacement:'); if (a.kind !== 'point') return;
      const b = yield c.point('Specify second point:', { base: a.pt, preview: (pt) => [{ t: 'LINE', p1: a.pt, p2: pt }] }); if (b.kind !== 'point') return;
      if (c.engine.host.panBy) c.engine.host.panBy([b.pt[0] - a.pt[0], b.pt[1] - a.pt[1]]);
    }
  };
  // Commands that act instantly, with no prompts.
  const INSTANT = {
    UNDO(e) { e.log(e.doc.undo() ? 'Undo.' : 'Nothing to undo.'); },
    REDO(e) { e.log(e.doc.redo() ? 'Redo.' : 'Nothing to redo.'); },
    REGEN(e) { if (e.host.redraw) e.host.redraw(); e.log('Regenerating model.'); },
    REDRAW(e) { if (e.host.redraw) e.host.redraw(); },
    LAYER(e) { if (e.host.openLayers) e.host.openLayers(); else e.log('The layers panel is not available here.'); },
    UNDERLAY(e) { if (e.host.openUnderlays) e.host.openUnderlays(); else e.log('The underlay panel is not available here.'); },
    PROPERTIES(e) { if (e.host.openProperties) e.host.openProperties(); else e.log('The properties panel is not available here.'); }
  };
  const ALL_COMMANDS = Object.keys(COMMANDS).filter((n) => n !== 'GRIP').concat(Object.keys(INSTANT));

  // ---------- engine ----------
  class Engine {
    constructor(doc, host) {
      this.doc = doc; this.host = host || {};
      this.history = []; this.active = null; this.gen = null; this.prompt = null;
      this.lastPoint = null; this.lastEnd = null; this.cursor = null;
      this.lastCommand = null; this.selection = new Set(); this.onChange = null;
      this.lastRadius = null; this.lastRect = null;
      this.preselect = null; this.params = null; this.keepSel = null;
      this.overlay = []; this.lastTextH = null; this.lastDim = null;
      this.lastOffset = null; this.filletR = null; this.filletTrim = null; this.chamD1 = null; this.chamD2 = null; this.chamTrim = null;
    }
    // Like log, but also shown as a message on screen (history lines scroll away under the next prompt).
    warn(msg) { this.log(msg); if (this.host.toast) this.host.toast(msg); }
    log(msg) { this.history.push(msg); if (this.history.length > 200) this.history.shift(); }
    _emit() { if (this.onChange) this.onChange(); }
    resolve(text) {
      const t = String(text).trim().toUpperCase();
      if (!t) return null;
      const name = ALIASES[t] || t;
      return ALL_COMMANDS.includes(name) ? name : null;
    }
    suggest(prefix) {
      const p = String(prefix).trim().toUpperCase();
      if (!p) return [];
      const out = new Set();
      for (const a of Object.keys(ALIASES)) if (a.startsWith(p) && a !== p) out.add(a);
      for (const n of ALL_COMMANDS) if (n.startsWith(p) && n !== p) out.add(n);
      return Array.from(out).sort((a, b) => a.length - b.length || a.localeCompare(b)).slice(0, 8);
    }
    start(text, params) {
      if (this.active) return false;
      const name = this.resolve(text);
      if (!name) { this.log('Unknown command "' + String(text).trim() + '". Press F1 for help.'); this._emit(); return false; }
      this.overlay = [];
      this.log('Command: ' + name);
      this.lastCommand = name;
      if (INSTANT[name]) { INSTANT[name](this); this._emit(); return true; }
      this._begin(name, params);
      return true;
    }
    // Start a grip drag on a selected object (called by the canvas).
    startGrip(id, grip) { if (this.active) return false; this._begin('GRIP', { id, grip }); this.selection = new Set([id]); this._emit(); return true; }
    _begin(name, params) {
      this.params = params || null;
      // Objects selected before the command (noun-verb) answer its first "Select objects" prompt.
      this.preselect = this.selection.size ? new Set(Array.from(this.selection).filter((id) => { const e = this.doc.byId.get(id); return e && this.doc.isSelectable(e); })) : null;
      this.active = name; this.selection = new Set(); this.keepSel = null;
      this.doc.beginGroup();
      const c = this._ctx();
      this.gen = COMMANDS[name](c);
      this._step(undefined);
    }
    _ctx() {
      const e = this, d = this.doc;
      return {
        engine: e, doc: d,
        point: (msg, o) => ({ kind: 'point', msg, ...(o || {}) }),
        number: (msg, o) => ({ kind: 'number', msg, ...(o || {}) }),
        key: (msg, options, o) => ({ kind: 'key', msg, options, ...(o || {}) }),
        select: (msg, o) => ({ kind: 'select', msg, ...(o || {}) }),
        text: (msg, o) => ({ kind: 'text', msg, ...(o || {}) }),
        add: (ent) => d.add(ent), remove: (id) => d.remove(id), replace: (id, ent) => d.replace(id, ent),
        undoOp: () => d.popOp(), opCount: () => (d.group ? d.group.length : 0), log: (m) => e.log(m), warn: (m) => e.warn(m)
      };
    }
    _step(val) {
      let r;
      try { r = this.gen.next(val); } catch (err) { this.log('Error: ' + err.message); this._finish(); return; }
      if (r.done) { this._finish(); return; }
      this.prompt = r.value;
      if (this.prompt.kind === 'select' && !this.prompt.single && this.preselect && this.preselect.size) {
        const ids = Array.from(this.preselect); this.preselect = null;
        for (const id of ids) this.selection.add(id);
        this.log(ids.length + ' found');
        this._step({ kind: 'select', ids });
        return;
      }
      this.log(this.promptText());
      this._emit();
    }
    _finish() {
      this.doc.endGroup();
      this.active = null; this.gen = null; this.prompt = null;
      this.selection = new Set(this.keepSel ? this.keepSel.filter((id) => this.doc.byId.has(id)) : []);
      this.keepSel = null; this.preselect = null; this.params = null;
      this._emit();
    }
    cancel() {
      if (!this.active) { if (this.selection.size || this.overlay.length) { this.selection = new Set(); this.overlay = []; this._emit(); } return; }
      this.log('*Cancel*');
      try { this.gen.return(); } catch (e) { /* ignore */ }
      this._finish();
    }
    promptText() {
      const p = this.prompt; if (!p) return 'Command:';
      let s = p.msg;
      if (p.options && p.options.length) s += ' [' + p.options.map((o) => o.short && o.name.toLowerCase().startsWith(o.short.toLowerCase()) ? o.short.toUpperCase() + o.name.slice(o.short.length) : o.name + '(' + o.short + ')').join('/') + ']';
      if (p.default !== undefined && p.default !== null && typeof p.default === 'number') s += ' <' + G.fmtNum(p.default, 4) + '>';
      return s.endsWith(':') ? s : s + ':';
    }
    setCursor(pt) { this.cursor = pt; }
    preview(pt) {
      if (!this.prompt || !this.prompt.preview || !pt) return [];
      try { return this.prompt.preview(pt) || []; } catch (e) { return []; }
    }
    wantsPoint() { return !!this.prompt && (this.prompt.kind === 'point' || (this.prompt.kind === 'number' && !!this.prompt.base)); }
    wantsSelect() { return !!this.prompt && this.prompt.kind === 'select'; }
    // The base point the rubber band / relative entry works from, if any.
    base() { return this.prompt && this.prompt.base ? this.prompt.base : null; }
    pick(pt) {
      const p = this.prompt; if (!p) return false;
      if (p.kind === 'point') { this.lastPoint = pt; this.log(G.fmtNum(pt[0], 4) + ',' + G.fmtNum(pt[1], 4)); this._step({ kind: 'point', pt }); return true; }
      if (p.kind === 'number' && p.base) { const v = G.dist(p.base, pt); this.lastPoint = pt; this.log(G.fmtNum(v, 4)); this._step({ kind: 'number', value: v }); return true; }
      return false;
    }
    clearSelection() { if (this.selection.size) { this.selection = new Set(); this._emit(); } }
    // pt: where the user picked (Trim, Extend and Fillet need it to know which part or end).
    selectAdd(ids, pt) {
      const total = ids.length;
      ids = ids.filter((id) => { const e = this.doc.byId.get(id); return e && this.doc.isSelectable(e); });
      if (total && !ids.length) { if (this.host.toast) this.host.toast('That object is on a locked or hidden layer.'); return; }
      if (!this.active) { for (const id of ids) this.selection.add(id); this._emit(); return; }   // idle: pick-first selection
      if (!this.wantsSelect()) return;
      if (this.prompt.single) {
        if (!ids.length) return;
        this.log('1 found');
        this._step({ kind: 'select', ids: [ids[0]], pt: pt || null });
        return;
      }
      let n = 0;
      for (const id of ids) if (!this.selection.has(id)) { this.selection.add(id); n++; }
      this.log(n + ' found' + (this.selection.size !== n ? ', ' + this.selection.size + ' total' : ''));
      this._emit();
    }
    selectRemove(ids) { for (const id of ids) this.selection.delete(id); this._emit(); }
    option(name) {
      const p = this.prompt; if (!p || !p.options) return false;
      const o = p.options.find((x) => x.name === name); if (!o) return false;
      this.log(o.name);
      this._step({ kind: 'option', name: o.name }); return true;
    }
    enter() {
      const p = this.prompt;
      if (!this.active) { if (this.lastCommand) return this.start(this.lastCommand); return false; }
      if (!p) return false;
      if (p.kind === 'select') { this._step({ kind: 'select', ids: Array.from(this.selection) }); return true; }
      if (p.kind === 'number' && p.default !== undefined && p.default !== null) { this.log(G.fmtNum(p.default, 4)); this._step({ kind: 'number', value: p.default }); return true; }
      this._step({ kind: 'enter' }); return true;
    }
    _matchOption(text) {
      const p = this.prompt; if (!p || !p.options) return null;
      const t = text.trim().toLowerCase(); if (!t) return null;
      for (const o of p.options) if (o.short && o.short.toLowerCase() === t) return o;
      for (const o of p.options) if (o.name.toLowerCase().startsWith(t) && /^[a-z0-9]/.test(t)) return o;
      return null;
    }
    submitText(text) {
      const t = String(text).trim();
      if (!this.active) { if (!t) return this.enter(); return this.start(t); }
      if (!t) return this.enter();
      const p = this.prompt; if (!p) return false;
      this.log(t);
      if (p.kind === 'text') { this._step({ kind: 'text', value: String(text).replace(/\s+$/, '') }); return true; }
      const o = (/^[A-Za-z]/.test(t) || /^[23][Pp]$/.test(t)) ? this._matchOption(t) : null;
      if (o) { this._step({ kind: 'option', name: o.name }); return true; }
      if (p.kind === 'select') {
        if (t.toUpperCase() === 'ALL' && !p.single) { this.selectAdd(this.doc.entities.map((e) => e.id)); return true; }
        this.log('Invalid selection. Pick objects or press Enter.'); this._emit(); return false;
      }
      if (p.kind === 'key') { this.log('Invalid option keyword.'); this._emit(); return false; }
      const ctx = { base: p.base || null, last: this.lastPoint, cursor: this.cursor };
      const r = parseInput((p.kind === 'number' || p.allowNumber) ? t.replace(/[xX]$/, '') : t, ctx);
      if (r.error) { this.log(p.kind === 'point' ? 'Point or option keyword required.' : 'Requires numeric distance or two points.'); this._emit(); return false; }
      if (p.kind === 'point') {
        if (r.pt) { this.lastPoint = r.pt; this._step({ kind: 'point', pt: r.pt }); return true; }
        if (p.allowNumber && r.value !== undefined) { this._step({ kind: 'number', value: r.value }); return true; }
        // Direct distance: type a length along the current cursor direction from the base point.
        if (p.base && this.cursor) {
          const d = G.sub(this.cursor, p.base), l = G.len(d);
          if (l < 1e-12) { this.log('Move the cursor to set a direction first.'); this._emit(); return false; }
          const pt = [p.base[0] + d[0] / l * r.value, p.base[1] + d[1] / l * r.value];
          this.lastPoint = pt; this._step({ kind: 'point', pt }); return true;
        }
        this.log('Point or option keyword required.'); this._emit(); return false;
      }
      if (p.kind === 'number') {
        if (r.value !== undefined) { this._step({ kind: 'number', value: r.value }); return true; }
        if (r.pt && p.base) { this._step({ kind: 'number', value: G.dist(p.base, r.pt) }); return true; }
        this.log('Requires numeric distance or two points.'); this._emit(); return false;
      }
      return false;
    }
  }

  return { CadDoc, Engine, parseInput, ALIASES, COMMANDS: ALL_COMMANDS, bulge3 };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = CadCmd;
