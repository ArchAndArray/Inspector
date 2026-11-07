// cadgeo.js — pure 2D geometry kernel for the CAD module. No DOM, no globals except `CadGeo`.
// Testable in plain Node (module.exports at the bottom), like calc.js and monitoring.js.
//
// Conventions (same as AutoCAD): Y up, angles in radians internally, 0 = +X (east), positive
// = counter-clockwise. Points are [x, y]. Entities are plain JSON objects:
//   LINE        { t:'LINE', p1, p2 }
//   CIRCLE      { t:'CIRCLE', c, r }
//   ARC         { t:'ARC', c, r, a0, a1 }          counter-clockwise from a0 to a1
//   POINT       { t:'POINT', p }
//   LWPOLYLINE  { t:'LWPOLYLINE', v:[[x,y,bulge],...], closed }
// A polyline "bulge" is tan(included angle / 4); positive = counter-clockwise arc, as in DXF.
// Every entity also carries id, layer (and optional colour/ltype overrides) — not used here.
//
// Geometry is reduced to "primitives": { k:'s', p1, p2 } (segment) or { k:'c', c, r, a0?, a1? }
// (circle, or arc when a0/a1 are present). All intersection, nearest, tangent and snap maths
// works on primitives, so polylines cost nothing extra.

const CadGeo = (() => {
  'use strict';
  const EPS = 1e-9;
  const TAU = Math.PI * 2;

  // ---- vectors ----
  const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
  const mul = (a, s) => [a[0] * s, a[1] * s];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
  const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
  const len = (a) => Math.hypot(a[0], a[1]);
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const polar = (p, ang, d) => [p[0] + Math.cos(ang) * d, p[1] + Math.sin(ang) * d];
  const angleOf = (v) => Math.atan2(v[1], v[0]);
  const angleBetween = (a, b) => Math.atan2(b[1] - a[1], b[0] - a[0]);

  function normAng(a) { a %= TAU; if (a < 0) a += TAU; return a; }
  // Counter-clockwise sweep from a0 to a1, in (0, 2π]. Equal angles mean a full turn.
  function sweepOf(a0, a1) { const s = normAng(a1 - a0); return s < 1e-12 ? TAU : s; }
  function angleInArc(a, a0, a1) {
    const s = sweepOf(a0, a1);
    return normAng(a - a0) <= s + 1e-9;
  }
  const deg = (r) => r * 180 / Math.PI;
  const rad = (d) => d * Math.PI / 180;

  // ---- arcs from bulge / three points ----
  function bulgeArc(p1, p2, b) {
    const d = dist(p1, p2);
    if (d < EPS || Math.abs(b) < 1e-12) return null;
    const h = (d / 2) * (1 - b * b) / (2 * b);          // signed offset of centre along left normal
    const m = mid(p1, p2);
    const n = [-(p2[1] - p1[1]) / d, (p2[0] - p1[0]) / d];
    const c = [m[0] + n[0] * h, m[1] + n[1] * h];
    const th = 4 * Math.atan(b);
    const r = d / (2 * Math.sin(Math.abs(th) / 2));
    const as = angleBetween(c, p1), ae = angleBetween(c, p2);
    return b > 0 ? { c, r, a0: as, a1: ae } : { c, r, a0: ae, a1: as };
  }
  // Bulge of the arc that leaves p1 with tangent direction `tan` and ends at p2.
  function bulgeFromTangent(p1, p2, tangentAngle) {
    const chord = angleBetween(p1, p2);
    let alpha = normAng(chord - tangentAngle);
    if (alpha > Math.PI) alpha -= TAU;
    return Math.tan(alpha / 2);
  }
  function circumcircle(p1, p2, p3) {
    const d = 2 * (p1[0] * (p2[1] - p3[1]) + p2[0] * (p3[1] - p1[1]) + p3[0] * (p1[1] - p2[1]));
    if (Math.abs(d) < 1e-12) return null;
    const s1 = dot(p1, p1), s2 = dot(p2, p2), s3 = dot(p3, p3);
    const c = [
      (s1 * (p2[1] - p3[1]) + s2 * (p3[1] - p1[1]) + s3 * (p1[1] - p2[1])) / d,
      (s1 * (p3[0] - p2[0]) + s2 * (p1[0] - p3[0]) + s3 * (p2[0] - p1[0])) / d
    ];
    return { c, r: dist(c, p1) };
  }
  // Arc from p1 through p2 to p3.
  function arcThrough3(p1, p2, p3) {
    const cc = circumcircle(p1, p2, p3);
    if (!cc) return null;
    const ccw = cross(sub(p2, p1), sub(p3, p2)) > 0;
    const a1 = angleBetween(cc.c, p1), a3 = angleBetween(cc.c, p3);
    return ccw ? { c: cc.c, r: cc.r, a0: a1, a1: a3 } : { c: cc.c, r: cc.r, a0: a3, a1: a1 };
  }
  function arcPoints(arc) { return [polar(arc.c, arc.a0, arc.r), polar(arc.c, arc.a1, arc.r)]; }
  function arcMid(arc) { return polar(arc.c, arc.a0 + sweepOf(arc.a0, arc.a1) / 2, arc.r); }

  // ---- primitives ----
  function polySegments(e) {
    const v = e.v || [], out = [];
    const n = e.closed ? v.length : v.length - 1;
    for (let i = 0; i < n; i++) {
      const a = v[i], b = v[(i + 1) % v.length];
      const bu = a[2] || 0;
      const arc = bu ? bulgeArc([a[0], a[1]], [b[0], b[1]], bu) : null;
      out.push(arc ? { k: 'c', c: arc.c, r: arc.r, a0: arc.a0, a1: arc.a1, bulge: bu, p1: [a[0], a[1]], p2: [b[0], b[1]] }
                   : { k: 's', p1: [a[0], a[1]], p2: [b[0], b[1]] });
    }
    return out;
  }
  function prims(e) {
    switch (e.t) {
      case 'LINE': return [{ k: 's', p1: e.p1, p2: e.p2 }];
      case 'CIRCLE': return [{ k: 'c', c: e.c, r: e.r }];
      case 'ARC': return [{ k: 'c', c: e.c, r: e.r, a0: e.a0, a1: e.a1 }];
      case 'LWPOLYLINE': return polySegments(e);
      default: return [];
    }
  }
  const isArc = (p) => p.k === 'c' && p.a0 !== undefined;
  function primEnds(p) {
    if (p.k === 's') return [p.p1, p.p2];
    if (isArc(p)) return p.bulge < 0 ? [p.p1, p.p2] : arcPoints(p);
    return [];
  }

  function bbox(e) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const grow = (p) => { if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0]; if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1]; };
    if (e.t === 'POINT') grow(e.p);
    for (const p of prims(e)) {
      if (p.k === 's') { grow(p.p1); grow(p.p2); continue; }
      if (!isArc(p)) { grow([p.c[0] - p.r, p.c[1] - p.r]); grow([p.c[0] + p.r, p.c[1] + p.r]); continue; }
      grow(polar(p.c, p.a0, p.r)); grow(polar(p.c, p.a1, p.r));
      for (let q = 0; q < 4; q++) { const a = q * Math.PI / 2; if (angleInArc(a, p.a0, p.a1)) grow(polar(p.c, a, p.r)); }
    }
    return { minX, minY, maxX, maxY };
  }

  // ---- nearest / perpendicular / tangent ----
  function nearestOnPrim(p, pt) {
    if (p.k === 's') {
      const d = sub(p.p2, p.p1), l2 = dot(d, d);
      const t = l2 < EPS ? 0 : Math.max(0, Math.min(1, dot(sub(pt, p.p1), d) / l2));
      const q = [p.p1[0] + d[0] * t, p.p1[1] + d[1] * t];
      return { pt: q, d: dist(q, pt) };
    }
    const v = sub(pt, p.c), l = len(v);
    if (!isArc(p)) {
      if (l < EPS) return { pt: polar(p.c, 0, p.r), d: p.r };
      const q = add(p.c, mul(v, p.r / l));
      return { pt: q, d: dist(q, pt) };
    }
    if (l > EPS && angleInArc(angleOf(v), p.a0, p.a1)) {
      const q = add(p.c, mul(v, p.r / l));
      return { pt: q, d: dist(q, pt) };
    }
    const [e0, e1] = arcPoints(p);
    const d0 = dist(e0, pt), d1 = dist(e1, pt);
    return d0 <= d1 ? { pt: e0, d: d0 } : { pt: e1, d: d1 };
  }
  function perpFeet(p, from) {
    if (p.k === 's') {
      const d = sub(p.p2, p.p1), l2 = dot(d, d);
      if (l2 < EPS) return [];
      const t = dot(sub(from, p.p1), d) / l2;
      if (t < -1e-9 || t > 1 + 1e-9) return [];
      return [[p.p1[0] + d[0] * t, p.p1[1] + d[1] * t]];
    }
    const v = sub(from, p.c), l = len(v);
    if (l < EPS) return [];
    const u = mul(v, 1 / l);
    const out = [add(p.c, mul(u, p.r)), add(p.c, mul(u, -p.r))];
    return isArc(p) ? out.filter((q) => angleInArc(angleBetween(p.c, q), p.a0, p.a1)) : out;
  }
  function tangentPoints(p, from) {
    if (p.k !== 'c') return [];
    const v = sub(from, p.c), l = len(v);
    if (l <= p.r + 1e-9) return [];
    const base = angleOf(v), off = Math.acos(p.r / l);
    const out = [polar(p.c, base + off, p.r), polar(p.c, base - off, p.r)];
    return isArc(p) ? out.filter((q) => angleInArc(angleBetween(p.c, q), p.a0, p.a1)) : out;
  }

  // ---- intersections (finite primitives) ----
  function segSeg(a, b) {
    const r = sub(a.p2, a.p1), s = sub(b.p2, b.p1);
    const den = cross(r, s);
    if (Math.abs(den) < 1e-12) return [];
    const qp = sub(b.p1, a.p1);
    const t = cross(qp, s) / den, u = cross(qp, r) / den;
    const e = 1e-9;
    if (t < -e || t > 1 + e || u < -e || u > 1 + e) return [];
    return [[a.p1[0] + r[0] * t, a.p1[1] + r[1] * t]];
  }
  function segCirc(sg, ci) {
    const d = sub(sg.p2, sg.p1), f = sub(sg.p1, ci.c);
    const A = dot(d, d), B = 2 * dot(f, d), C = dot(f, f) - ci.r * ci.r;
    if (A < EPS) return [];
    let disc = B * B - 4 * A * C;
    if (disc < -1e-9 * Math.max(1, A * ci.r * ci.r)) return [];
    if (disc < 0) disc = 0;
    const sq = Math.sqrt(disc), out = [];
    const ts = sq < 1e-12 ? [-B / (2 * A)] : [(-B - sq) / (2 * A), (-B + sq) / (2 * A)];
    for (const t of ts) {
      if (t < -1e-9 || t > 1 + 1e-9) continue;
      const q = [sg.p1[0] + d[0] * t, sg.p1[1] + d[1] * t];
      if (isArc(ci) && !angleInArc(angleBetween(ci.c, q), ci.a0, ci.a1)) continue;
      out.push(q);
    }
    return out;
  }
  function circCirc(a, b) {
    const d = dist(a.c, b.c);
    if (d < EPS || d > a.r + b.r + 1e-9 || d < Math.abs(a.r - b.r) - 1e-9) return [];
    const x = (d * d + a.r * a.r - b.r * b.r) / (2 * d);
    const h2 = a.r * a.r - x * x, h = h2 > 0 ? Math.sqrt(h2) : 0;
    const ux = (b.c[0] - a.c[0]) / d, uy = (b.c[1] - a.c[1]) / d;
    const m = [a.c[0] + ux * x, a.c[1] + uy * x];
    const pts = h < 1e-9 ? [m] : [[m[0] - uy * h, m[1] + ux * h], [m[0] + uy * h, m[1] - ux * h]];
    return pts.filter((q) => (!isArc(a) || angleInArc(angleBetween(a.c, q), a.a0, a.a1)) &&
                             (!isArc(b) || angleInArc(angleBetween(b.c, q), b.a0, b.a1)));
  }
  function intersectPrims(a, b) {
    if (a.k === 's' && b.k === 's') return segSeg(a, b);
    if (a.k === 's') return segCirc(a, b);
    if (b.k === 's') return segCirc(b, a);
    return circCirc(a, b);
  }
  function intersectEntities(ea, eb) {
    const out = [];
    for (const a of prims(ea)) for (const b of prims(eb)) out.push(...intersectPrims(a, b));
    return out;
  }

  // ---- distance for picking ----
  function entityDist(e, pt) {
    if (e.t === 'POINT') return dist(e.p, pt);
    let best = Infinity;
    for (const p of prims(e)) { const n = nearestOnPrim(p, pt); if (n.d < best) best = n.d; }
    return best;
  }

  // ---- window / crossing selection ----
  const rectOf = (p, q) => ({ minX: Math.min(p[0], q[0]), minY: Math.min(p[1], q[1]), maxX: Math.max(p[0], q[0]), maxY: Math.max(p[1], q[1]) });
  const inRect = (pt, r) => pt[0] >= r.minX && pt[0] <= r.maxX && pt[1] >= r.minY && pt[1] <= r.maxY;
  function entInWindow(e, r) {
    const b = bbox(e);
    return b.minX >= r.minX && b.maxX <= r.maxX && b.minY >= r.minY && b.maxY <= r.maxY;
  }
  function entCrossesRect(e, r) {
    if (e.t === 'POINT') return inRect(e.p, r);
    const b = bbox(e);
    if (b.maxX < r.minX || b.minX > r.maxX || b.maxY < r.minY || b.minY > r.maxY) return false;
    const edges = [
      { k: 's', p1: [r.minX, r.minY], p2: [r.maxX, r.minY] }, { k: 's', p1: [r.maxX, r.minY], p2: [r.maxX, r.maxY] },
      { k: 's', p1: [r.maxX, r.maxY], p2: [r.minX, r.maxY] }, { k: 's', p1: [r.minX, r.maxY], p2: [r.minX, r.minY] }
    ];
    for (const p of prims(e)) {
      const probe = p.k === 's' ? p.p1 : (isArc(p) ? polar(p.c, p.a0, p.r) : polar(p.c, 0, p.r));
      if (inRect(probe, r)) return true;
      for (const ed of edges) if (intersectPrims(p, ed).length) return true;
    }
    return false;
  }

  // ---- ortho / polar constraint relative to a base point ----
  // mode: 'ortho' | 'polar' | null. incDeg: polar increment. tolDeg: how close counts as "on" a polar angle.
  function constrain(base, pt, mode, incDeg, tolDeg) {
    if (!base || !mode) return { pt, ang: null };
    const d = sub(pt, base), l = len(d);
    if (l < EPS) return { pt, ang: null };
    if (mode === 'ortho') {
      return Math.abs(d[0]) >= Math.abs(d[1]) ? { pt: [pt[0], base[1]], ang: d[0] >= 0 ? 0 : Math.PI } : { pt: [base[0], pt[1]], ang: d[1] >= 0 ? Math.PI / 2 : -Math.PI / 2 };
    }
    const inc = rad(incDeg || 45), tol = rad(tolDeg == null ? 4 : tolDeg);
    const a = angleOf(d), k = Math.round(a / inc), snapped = k * inc;
    if (Math.abs(a - snapped) <= tol) return { pt: polar(base, snapped, l), ang: snapped };
    return { pt, ang: null };
  }

  // ---- object snap ----
  // modes: { end, mid, cen, gcen, node, quad, int, per, tan, nea } booleans.
  const SNAP_PRIORITY = ['end', 'int', 'mid', 'cen', 'gcen', 'quad', 'node', 'per', 'tan', 'nea'];
  function polyCentroid(e) {
    const pts = [];
    for (const p of polySegments(e)) {
      pts.push(p.p1);
      if (p.k === 'c') {
        const sw = sweepOf(p.a0, p.a1), sgn = p.bulge < 0 ? -1 : 1;
        const a0 = p.bulge < 0 ? p.a1 : p.a0;
        for (let i = 1; i < 16; i++) pts.push(polar(p.c, a0 + sgn * sw * i / 16, p.r));
      }
    }
    if (pts.length < 3) return null;
    let A = 0, cx = 0, cy = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length], cr = a[0] * b[1] - b[0] * a[1];
      A += cr; cx += (a[0] + b[0]) * cr; cy += (a[1] + b[1]) * cr;
    }
    if (Math.abs(A) < EPS) return null;
    return [cx / (3 * A), cy / (3 * A)];
  }
  // Candidate snap points for one entity (no cursor needed) — type is a mode key.
  function staticSnaps(e, modes) {
    const out = [];
    const push = (pt, type) => out.push({ pt, type });
    if (e.t === 'POINT') { if (modes.node) push(e.p, 'node'); return out; }
    const ps = prims(e);
    for (const p of ps) {
      if (p.k === 's') {
        if (modes.end) { push(p.p1, 'end'); push(p.p2, 'end'); }
        if (modes.mid) push(mid(p.p1, p.p2), 'mid');
      } else if (isArc(p)) {
        if (modes.end) for (const q of primEnds(p)) push(q, 'end');
        if (modes.mid) push(arcMid(p), 'mid');
        if (modes.cen) push(p.c, 'cen');
        if (modes.quad) for (let q = 0; q < 4; q++) { const a = q * Math.PI / 2; if (angleInArc(a, p.a0, p.a1)) push(polar(p.c, a, p.r), 'quad'); }
      } else {
        if (modes.cen) push(p.c, 'cen');
        if (modes.quad) for (let q = 0; q < 4; q++) push(polar(p.c, q * Math.PI / 2, p.r), 'quad');
      }
    }
    if (modes.gcen && e.t === 'LWPOLYLINE' && e.closed) { const g = polyCentroid(e); if (g) push(g, 'gcen'); }
    return out;
  }
  // entities: nearby entities already narrowed by the spatial index.
  function findSnap(entities, cursor, aperture, modes, from) {
    const cands = [];
    for (const e of entities) {
      for (const s of staticSnaps(e, modes)) { const d = dist(s.pt, cursor); if (d <= aperture) cands.push({ ...s, d, id: e.id }); }
      if (from && (modes.per || modes.tan)) {
        for (const p of prims(e)) {
          if (modes.per) for (const q of perpFeet(p, from)) { const d = dist(q, cursor); if (d <= aperture) cands.push({ pt: q, type: 'per', d, id: e.id }); }
          if (modes.tan) for (const q of tangentPoints(p, from)) { const d = dist(q, cursor); if (d <= aperture) cands.push({ pt: q, type: 'tan', d, id: e.id }); }
        }
      }
    }
    if (modes.int) {
      const near = entities.slice(0, 40), lists = near.map((e) => prims(e));
      for (let i = 0; i < near.length; i++) for (let j = i + 1; j < near.length; j++)
        for (const a of lists[i]) for (const b of lists[j]) for (const q of intersectPrims(a, b)) {
          const d = dist(q, cursor); if (d <= aperture) cands.push({ pt: q, type: 'int', d, id: near[i].id });
        }
      // self-intersections inside one polyline
      for (let i = 0; i < near.length; i++) if (near[i].t === 'LWPOLYLINE' && lists[i].length > 2) {
        const L = lists[i];
        for (let a = 0; a < L.length; a++) for (let b = a + 2; b < L.length; b++) {
          if (near[i].closed && a === 0 && b === L.length - 1) continue;
          for (const q of intersectPrims(L[a], L[b])) { const d = dist(q, cursor); if (d <= aperture) cands.push({ pt: q, type: 'int', d, id: near[i].id }); }
        }
      }
    }
    if (cands.length) {
      cands.sort((a, b) => (a.d - b.d) || (SNAP_PRIORITY.indexOf(a.type) - SNAP_PRIORITY.indexOf(b.type)));
      return cands[0];
    }
    if (modes.nea) {
      let best = null;
      for (const e of entities) for (const p of prims(e)) {
        const n = nearestOnPrim(p, cursor);
        if (n.d <= aperture && (!best || n.d < best.d)) best = { pt: n.pt, type: 'nea', d: n.d, id: e.id };
      }
      return best;
    }
    return null;
  }

  // ---- spatial index: static STR-packed tree + small pending list, rebuilt when pending grows ----
  class CadIndex {
    constructor() { this.boxes = new Map(); this.root = null; this.pending = new Set(); this.removed = new Set(); this.builtCount = 0; }
    clear() { this.boxes.clear(); this.root = null; this.pending.clear(); this.removed.clear(); this.builtCount = 0; }
    insert(id, b) {
      this.boxes.set(id, { id, minX: b.minX, minY: b.minY, maxX: b.maxX, maxY: b.maxY });
      this.removed.delete(id);
      this.pending.add(id);
      if (this.pending.size > Math.max(64, this.builtCount * 0.25)) this.rebuild();
    }
    remove(id) {
      if (!this.boxes.has(id)) return;
      this.boxes.delete(id);
      if (this.pending.has(id)) this.pending.delete(id); else this.removed.add(id);
    }
    bulk(list) { this.clear(); for (const [id, b] of list) this.boxes.set(id, { id, minX: b.minX, minY: b.minY, maxX: b.maxX, maxY: b.maxY }); this.rebuild(); }
    rebuild() {
      this.pending.clear(); this.removed.clear();
      const items = Array.from(this.boxes.values());
      this.builtCount = items.length;
      this.root = items.length ? CadIndex._build(items) : null;
    }
    static _node(children, leaf) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const c of children) { if (c.minX < minX) minX = c.minX; if (c.minY < minY) minY = c.minY; if (c.maxX > maxX) maxX = c.maxX; if (c.maxY > maxY) maxY = c.maxY; }
      return { minX, minY, maxX, maxY, children, leaf };
    }
    static _pack(items, M, leaf) {
      const n = items.length, P = Math.ceil(n / M), S = Math.ceil(Math.sqrt(P));
      items.sort((a, b) => (a.minX + a.maxX) - (b.minX + b.maxX));
      const out = [], slice = S * M;
      for (let i = 0; i < n; i += slice) {
        const col = items.slice(i, i + slice).sort((a, b) => (a.minY + a.maxY) - (b.minY + b.maxY));
        for (let j = 0; j < col.length; j += M) out.push(CadIndex._node(col.slice(j, j + M), leaf));
      }
      return out;
    }
    static _build(items) {
      let nodes = CadIndex._pack(items, 16, true);
      while (nodes.length > 1) nodes = CadIndex._pack(nodes, 16, false);
      return nodes[0];
    }
    search(minX, minY, maxX, maxY) {
      const out = [];
      if (this.root) {
        const stack = [this.root];
        while (stack.length) {
          const n = stack.pop();
          if (n.maxX < minX || n.minX > maxX || n.maxY < minY || n.minY > maxY) continue;
          if (n.leaf) {
            for (const c of n.children) {
              if (c.maxX < minX || c.minX > maxX || c.maxY < minY || c.minY > maxY) continue;
              if (!this.removed.has(c.id) && this.boxes.get(c.id) === c) out.push(c.id);
            }
          } else for (const c of n.children) stack.push(c);
        }
      }
      for (const id of this.pending) {
        const c = this.boxes.get(id);
        if (c && !(c.maxX < minX || c.minX > maxX || c.maxY < minY || c.minY > maxY)) out.push(id);
      }
      return out;
    }
  }

  // ---- misc ----
  function unionBox(a, b) {
    if (!a) return b; if (!b) return a;
    return { minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY), maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY) };
  }
  function fmtNum(n, prec) {
    const p = prec == null ? 4 : prec;
    const s = (Math.abs(n) < 5 * Math.pow(10, -p - 1) ? 0 : n).toFixed(p);
    return s.indexOf('.') >= 0 ? s.replace(/\.?0+$/, '') : s;
  }
  function translate(e, d) {
    const c = JSON.parse(JSON.stringify(e));
    for (const k of ['p1', 'p2', 'c', 'p']) if (c[k]) c[k] = [c[k][0] + d[0], c[k][1] + d[1]];
    if (c.v) c.v = c.v.map((q) => [q[0] + d[0], q[1] + d[1], q[2] || 0]);
    return c;
  }

  return {
    EPS, TAU, add, sub, mul, dot, cross, len, dist, mid, polar, angleOf, angleBetween, normAng, sweepOf, angleInArc, deg, rad,
    bulgeArc, bulgeFromTangent, circumcircle, arcThrough3, arcPoints, arcMid,
    prims, polySegments, isArc, primEnds, bbox, nearestOnPrim, perpFeet, tangentPoints,
    intersectPrims, intersectEntities, entityDist, rectOf, inRect, entInWindow, entCrossesRect,
    constrain, staticSnaps, findSnap, SNAP_PRIORITY, polyCentroid, CadIndex, unionBox, fmtNum, translate
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = CadGeo;
