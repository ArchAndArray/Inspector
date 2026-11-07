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
      for (const e of this.entities) { this.byId.set(e.id, e); boxes.push([e.id, G.bbox(e)]); }
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
      const g = this.group; this.group = null;
      if (g && g.length) { this.undoStack.push(g); this.redoStack.length = 0; }
    }
    _record(op) { if (this.group) this.group.push(op); else { this.undoStack.push([op]); this.redoStack.length = 0; } }
    _doAdd(ent, at) {
      if (at == null || at >= this.entities.length) this.entities.push(ent); else this.entities.splice(at, 0, ent);
      this.byId.set(ent.id, ent); this.index.insert(ent.id, G.bbox(ent));
    }
    _doDel(id) {
      const i = this.entities.findIndex((e) => e.id === id);
      if (i < 0) return -1;
      this.entities.splice(i, 1); this.byId.delete(id); this.index.remove(id);
      return i;
    }
    add(input) {
      const ent = JSON.parse(JSON.stringify(input));
      if (!ent.id) ent.id = this._id();
      if (!ent.layer) ent.layer = this.d.currentLayer;
      this._doAdd(ent);
      this._record({ k: 'add', ent });
      this._touch();
      return ent;
    }
    remove(id) {
      const ent = this.byId.get(id); if (!ent) return;
      const i = this._doDel(id);
      this._record({ k: 'del', ent, i });
      this._touch();
    }
    replace(id, next) {
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
      else { this._doDel(op.ent.id); this._doAdd(op.prev, op.i); }
    }
    _reapply(op) {
      if (op.k === 'add') this._doAdd(op.ent);
      else if (op.k === 'del') this._doDel(op.ent.id);
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
    extents() {
      let box = null;
      for (const e of this.entities) box = G.unionBox(box, G.bbox(e));
      return box;
    }
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
        const d = G.entityDist(e, pt);
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
  const ALIASES = { L: 'LINE', PL: 'PLINE', REC: 'RECTANG', C: 'CIRCLE', A: 'ARC', PO: 'POINT', E: 'ERASE', U: 'UNDO', Z: 'ZOOM', P: 'PAN', RE: 'REGEN', R: 'REDRAW', POLYLINE: 'PLINE', RECTANGLE: 'RECTANG' };
  const opt = (name, short) => ({ name, short: short || name[0] });
  const bulge3 = (p1, p2, p3) => {
    const a = G.arcThrough3(p1, p2, p3); if (!a) return null;
    const ccw = G.cross(G.sub(p2, p1), G.sub(p3, p2)) > 0;
    const th = (ccw ? 1 : -1) * G.sweepOf(a.a0, a.a1);
    return Math.tan(th / 4);
  };
  const same = (a, b) => G.dist(a, b) < 1e-9;

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
    REDRAW(e) { if (e.host.redraw) e.host.redraw(); }
  };
  const ALL_COMMANDS = Object.keys(COMMANDS).concat(Object.keys(INSTANT));

  // ---------- engine ----------
  class Engine {
    constructor(doc, host) {
      this.doc = doc; this.host = host || {};
      this.history = []; this.active = null; this.gen = null; this.prompt = null;
      this.lastPoint = null; this.lastEnd = null; this.cursor = null;
      this.lastCommand = null; this.selection = new Set(); this.onChange = null;
      this.lastRadius = null; this.lastRect = null;
    }
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
    start(text) {
      if (this.active) return false;
      const name = this.resolve(text);
      if (!name) { this.log('Unknown command "' + String(text).trim() + '". Press F1 for help.'); this._emit(); return false; }
      this.log('Command: ' + name);
      this.lastCommand = name;
      if (INSTANT[name]) { INSTANT[name](this); this._emit(); return true; }
      this.active = name; this.selection = new Set();
      this.doc.beginGroup();
      const c = this._ctx();
      this.gen = COMMANDS[name](c);
      this._step(undefined);
      return true;
    }
    _ctx() {
      const e = this, d = this.doc;
      return {
        engine: e, doc: d,
        point: (msg, o) => ({ kind: 'point', msg, ...(o || {}) }),
        number: (msg, o) => ({ kind: 'number', msg, ...(o || {}) }),
        key: (msg, options, o) => ({ kind: 'key', msg, options, ...(o || {}) }),
        select: (msg, o) => ({ kind: 'select', msg, ...(o || {}) }),
        add: (ent) => d.add(ent), remove: (id) => d.remove(id), replace: (id, ent) => d.replace(id, ent),
        undoOp: () => d.popOp(), log: (m) => e.log(m)
      };
    }
    _step(val) {
      let r;
      try { r = this.gen.next(val); } catch (err) { this.log('Error: ' + err.message); this._finish(); return; }
      if (r.done) { this._finish(); return; }
      this.prompt = r.value;
      this.log(this.promptText());
      this._emit();
    }
    _finish() {
      this.doc.endGroup();
      this.active = null; this.gen = null; this.prompt = null; this.selection = new Set();
      this._emit();
    }
    cancel() {
      if (!this.active) return;
      this.log('*Cancel*');
      try { this.gen.return(); } catch (e) { /* ignore */ }
      this._finish();
    }
    promptText() {
      const p = this.prompt; if (!p) return 'Command:';
      let s = p.msg;
      if (p.options && p.options.length) s += ' [' + p.options.map((o) => o.short && o.name.toLowerCase().startsWith(o.short.toLowerCase()) ? o.short.toUpperCase() + o.name.slice(o.short.length) : o.name + '(' + o.short + ')').join('/') + ']';
      if (p.default !== undefined && p.default !== null) s += ' <' + G.fmtNum(p.default, 4) + '>';
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
    selectAdd(ids) {
      if (!this.wantsSelect()) return;
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
      const o = (/^[A-Za-z]/.test(t) || /^[23][Pp]$/.test(t)) ? this._matchOption(t) : null;
      if (o) { this._step({ kind: 'option', name: o.name }); return true; }
      if (p.kind === 'select') {
        if (t.toUpperCase() === 'ALL') { this.selectAdd(this.doc.entities.map((e) => e.id)); return true; }
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
