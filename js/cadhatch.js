// cadhatch.js — hatching: pattern geometry, boundary detection ("tap inside a shape"), solid fills.
// No DOM; testable in Node. Global `CadHatch`.
//
//   HATCH { t:'HATCH', loops:[ [[x,y,bulge],...], ... ] (even-odd: outer loop + islands),
//           pat:'Lines'|..., sc (pattern scale multiplier), ang (rad, added to the pattern angles),
//           pk (model units per paper mm, baked at creation = plot scale x unit factor) }
// Patterns are drawn in paper millimetres at the plot scale and baked with `pk`, the same way text and
// dimensions are, so a pattern keeps its look when the plot scale setting changes later.
// The boundary is baked too (not associative): editing the shape afterwards does not update the hatch.

const CadHatch = (() => {
  'use strict';
  const G = (typeof CadGeo !== 'undefined') ? CadGeo : require('./cadgeo.js');

  // family: ang (deg), sp (perpendicular spacing, paper mm), off (perp offset), dash [on,off,...] (paper mm), phase (paper mm along the line)
  const PATTERNS = {
    Solid: { label: 'Solid fill', solid: true },
    Lines: { label: 'Diagonal lines', fam: [{ ang: 45, sp: 3 }] },
    Steel: { label: 'Steel (paired lines)', fam: [{ ang: 45, sp: 6 }, { ang: 45, sp: 6, off: 1.2 }] },
    Cross: { label: 'Cross-hatch', fam: [{ ang: 45, sp: 3.5 }, { ang: 135, sp: 3.5 }] },
    Grid: { label: 'Grid', fam: [{ ang: 0, sp: 4 }, { ang: 90, sp: 4 }] },
    Brick: { label: 'Brick', fam: [{ ang: 0, sp: 6 }, { ang: 90, sp: 12, dash: [6, 6] }, { ang: 90, sp: 12, off: 6, dash: [6, 6], phase: 6 }] },
    Earth: { label: 'Earth', fam: [{ ang: 0, sp: 5, dash: [3, 2] }, { ang: 0, sp: 5, off: 2.5, dash: [3, 2], phase: 2.5 }] },
    Concrete: { label: 'Concrete', stip: { dots: 0.55, tri: 0.09, tsz: 1.0 } },
    Sand: { label: 'Sand', stip: { dots: 1.4 } },
    Gravel: { label: 'Gravel', stip: { dots: 0.3, tri: 0.14, tsz: 1.9 } }
  };
  const NAMES = Object.keys(PATTERNS);
  const CAP = 80000;

  // ---- geometry helpers ----
  function loopPoly(loop, tol) {
    const out = [];
    for (const s of G.polySegments({ v: loop, closed: true })) {
      out.push(s.p1);
      if (s.k === 'c') {
        const sweep = s.bulge > 0 ? G.sweepOf(s.a0, s.a1) : G.sweepOf(s.a0, s.a1);
        const step = s.r > tol ? 2 * Math.acos(Math.max(0, 1 - tol / s.r)) : Math.PI / 3;
        const n = Math.max(2, Math.min(720, Math.ceil(Math.abs(sweep) / Math.max(step, 0.004))));
        const pts = [];
        for (let i = 1; i < n; i++) { const a = s.a0 + sweep * i / n; pts.push([s.c[0] + s.r * Math.cos(a), s.c[1] + s.r * Math.sin(a)]); }
        out.push(...(s.bulge < 0 ? pts.reverse() : pts));
      }
    }
    return out;
  }
  const polysOf = (e, tol) => e.loops.map((l) => loopPoly(l, tol));
  function inside(polys, p) {                                  // even-odd across all rings
    let c = false;
    for (const poly of polys) {
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const a = poly[i], b = poly[j];
        if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) c = !c;
      }
    }
    return c;
  }
  function boxOfPolys(polys) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const poly of polys) for (const p of poly) { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; }
    return { x0, y0, x1, y1 };
  }
  function mulberry32(a) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

  // ---- pattern segments (model units) ----
  const cache = new WeakMap();
  function segments(e) {
    if (cache.has(e)) return cache.get(e);
    const out = gen(e); cache.set(e, out); return out;
  }
  function gen(e) {
    const pat = PATTERNS[e.pat] || PATTERNS.Lines, out = [];
    if (pat.solid || !e.loops || !e.loops.length) return out;
    const unit = (e.pk || 1) * (e.sc || 1);                     // model units per paper mm, scaled
    const polys = polysOf(e, 0.05 * (e.pk || 1)), bb = boxOfPolys(polys);
    if (!isFinite(bb.x0)) return out;
    const rot = e.ang || 0;
    if (pat.fam) {
      for (const f of pat.fam) {
        const a = (f.ang * Math.PI / 180) + rot, u = [Math.cos(a), Math.sin(a)], n = [-u[1], u[0]];
        const cs = [[bb.x0, bb.y0], [bb.x1, bb.y0], [bb.x1, bb.y1], [bb.x0, bb.y1]].map((p) => p[0] * n[0] + p[1] * n[1]);
        const smin = Math.min(...cs), smax = Math.max(...cs);
        let sp = f.sp * unit; const off = (f.off || 0) * unit;
        const lines = (smax - smin) / sp;
        if (lines > 6000) sp *= lines / 6000;                    // never freeze on a huge area at a tiny scale
        const k0 = Math.ceil((smin - off) / sp), k1 = Math.floor((smax - off) / sp);
        const dm = f.dash ? f.dash.map((v) => v * unit) : null, P = dm ? dm.reduce((x, y) => x + y, 0) : 0, ph = (f.phase || 0) * unit;
        for (let k = k0; k <= k1; k++) {
          const s = off + k * sp, ts = [];
          for (const poly of polys) {
            for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
              const p = poly[i], q = poly[j], sa = p[0] * n[0] + p[1] * n[1] - s, sb = q[0] * n[0] + q[1] * n[1] - s;
              if ((sa >= 0) !== (sb >= 0)) { const t = sa / (sa - sb); ts.push((p[0] + (q[0] - p[0]) * t) * u[0] + (p[1] + (q[1] - p[1]) * t) * u[1]); }
            }
          }
          ts.sort((x, y) => x - y);
          for (let i = 0; i + 1 < ts.length; i += 2) {
            const t0 = ts[i], t1 = ts[i + 1], pt = (t) => [s * n[0] + t * u[0], s * n[1] + t * u[1]];
            if (!dm || P <= 0) { if (t1 - t0 > 1e-9) out.push([pt(t0), pt(t1)]); }
            else {
              for (let c = Math.floor((t0 + ph) / P); c * P - ph < t1; c++) {
                let pos = c * P - ph;
                for (let d = 0; d < dm.length; d++) {
                  if (d % 2 === 0 && dm[d] > 1e-9) { const a0 = Math.max(pos, t0), a1 = Math.min(pos + dm[d], t1); if (a1 - a0 > 1e-9) out.push([pt(a0), pt(a1)]); }
                  pos += dm[d];
                }
              }
            }
            if (out.length > CAP) return out;
          }
        }
      }
      return out;
    }
    // stippled patterns: stable pseudo-random scatter
    const st = pat.stip, rnd = mulberry32(e.seed != null ? e.seed >>> 0 : ((polys[0].length * 7919) ^ Math.round(bb.x0 * 31) ^ Math.round(bb.y1 * 17)) >>> 0);
    const areaPaper = ((bb.x1 - bb.x0) * (bb.y1 - bb.y0)) / (unit * unit);
    const rr = (a, b) => a + (b - a) * rnd();
    const dotLen = 0.22 * unit;
    let nDots = Math.min(30000, Math.round((st.dots || 0) * areaPaper)), nTri = Math.min(12000, Math.round((st.tri || 0) * areaPaper));
    for (let i = 0; i < nDots; i++) {
      const p = [rr(bb.x0, bb.x1), rr(bb.y0, bb.y1)], a = rr(0, Math.PI);
      if (inside(polys, p)) out.push([[p[0] - Math.cos(a) * dotLen / 2, p[1] - Math.sin(a) * dotLen / 2], [p[0] + Math.cos(a) * dotLen / 2, p[1] + Math.sin(a) * dotLen / 2]]);
    }
    for (let i = 0; i < nTri; i++) {
      const c = [rr(bb.x0, bb.x1), rr(bb.y0, bb.y1)], a = rr(0, Math.PI * 2), r = (st.tsz || 1) * unit * rr(0.6, 1.1) / 2;
      const v = [0, 1, 2].map((k) => [c[0] + r * Math.cos(a + k * 2.0944), c[1] + r * Math.sin(a + k * 2.0944)]);
      if (v.every((q) => inside(polys, q))) { out.push([v[0], v[1]], [v[1], v[2]], [v[2], v[0]]); }
    }
    return out;
  }

  // ---- solid fill as trapezoids (exact, even-odd): used for PDF and DXF ----
  function trapezoids(polys) {
    const ys = []; for (const poly of polys) for (const p of poly) ys.push(p[1]);
    ys.sort((a, b) => a - b);
    const uy = ys.filter((y, i) => i === 0 || y - ys[i - 1] > 1e-9), edges = [];
    for (const poly of polys) for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const a = poly[j], b = poly[i]; if (Math.abs(a[1] - b[1]) > 1e-12) edges.push(a[1] < b[1] ? [a, b] : [b, a]); }
    const quads = [];
    for (let s = 0; s + 1 < uy.length; s++) {
      const y0 = uy[s], y1 = uy[s + 1], ym = (y0 + y1) / 2, xs = [];
      for (const [a, b] of edges) if (a[1] <= ym && b[1] > ym) { const x = (yy) => a[0] + (b[0] - a[0]) * (yy - a[1]) / (b[1] - a[1]); xs.push({ xm: x(ym), x0: x(y0), x1: x(y1) }); }
      xs.sort((p, q) => p.xm - q.xm);
      for (let i = 0; i + 1 < xs.length; i += 2) quads.push([[xs[i].x0, y0], [xs[i + 1].x0, y0], [xs[i + 1].x1, y1], [xs[i].x1, y1]]);
    }
    return quads;
  }

  // ---- boundaries ----
  // Closed polylines and circles become loops directly. Returns { loops, skipped }.
  function loopsFromObjects(ents) {
    const loops = []; let skipped = 0;
    for (const e of ents) {
      if (e.t === 'LWPOLYLINE' && e.closed && e.v.length >= 3) loops.push(e.v.map((q) => [q[0], q[1], q[2] || 0]));
      else if (e.t === 'CIRCLE') loops.push([[e.c[0] + e.r, e.c[1], 1], [e.c[0] - e.r, e.c[1], 1]]);
      else skipped++;
    }
    return { loops, skipped };
  }

  // The region enclosed around `pt` by all the given line, arc, circle and polyline entities.
  // Returns { loops } (outer loop first, then islands) or { error }.
  function findBoundary(ents, pt, opts) {
    const o = opts || {}, tol = o.tol || 0.05, eps = Math.max(tol * 0.02, 1e-9);
    // 1. flatten every curve into straight segments
    let segs = [];
    const addPoly = (pts, closed) => { for (let i = 0; i + 1 < pts.length; i++) segs.push([pts[i], pts[i + 1]]); if (closed && pts.length > 2) segs.push([pts[pts.length - 1], pts[0]]); };
    const arcPts = (c, r, a0, sweep) => { const step = r > tol ? 2 * Math.acos(Math.max(0, 1 - tol / r)) : Math.PI / 3, n = Math.max(2, Math.min(720, Math.ceil(Math.abs(sweep) / Math.max(step, 0.004)))); const p = []; for (let i = 0; i <= n; i++) { const a = a0 + sweep * i / n; p.push([c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)]); } return p; };
    for (const e of ents) {
      if (e.t === 'LINE') segs.push([e.p1, e.p2]);
      else if (e.t === 'CIRCLE') addPoly(arcPts(e.c, e.r, 0, Math.PI * 2).slice(0, -1), true);
      else if (e.t === 'ARC') addPoly(arcPts(e.c, e.r, e.a0, G.sweepOf(e.a0, e.a1)), false);
      else if (e.t === 'LWPOLYLINE') {
        for (const s of G.polySegments(e)) {
          if (s.k === 's') segs.push([s.p1, s.p2]);
          else { const pts = arcPts(s.c, s.r, s.a0, G.sweepOf(s.a0, s.a1)); addPoly(s.bulge < 0 ? pts.reverse() : pts, false); }
        }
      }
    }
    segs = segs.filter((s) => Math.hypot(s[1][0] - s[0][0], s[1][1] - s[0][1]) > eps);
    if (segs.length > 12000) return { error: 'Too many objects near the point. Zoom in or use Select objects.' };
    if (segs.length < 3) return { error: 'No closed shape found.' };
    // 2. split at crossings and touches
    const info = segs.map((s) => ({ s, ts: [0, 1], x0: Math.min(s[0][0], s[1][0]), x1: Math.max(s[0][0], s[1][0]), y0: Math.min(s[0][1], s[1][1]), y1: Math.max(s[0][1], s[1][1]) }));
    const order = info.map((_, i) => i).sort((a, b) => info[a].x0 - info[b].x0);
    const paramOf = (s, p) => { const dx = s[1][0] - s[0][0], dy = s[1][1] - s[0][1], l2 = dx * dx + dy * dy; return ((p[0] - s[0][0]) * dx + (p[1] - s[0][1]) * dy) / l2; };
    const dToSeg = (s, p) => { const t = Math.max(0, Math.min(1, paramOf(s, p))); return Math.hypot(s[0][0] + (s[1][0] - s[0][0]) * t - p[0], s[0][1] + (s[1][1] - s[0][1]) * t - p[1]); };
    for (let ii = 0; ii < order.length; ii++) {
      const A = info[order[ii]];
      for (let jj = ii + 1; jj < order.length; jj++) {
        const B = info[order[jj]]; if (B.x0 > A.x1 + eps) break;
        if (B.y0 > A.y1 + eps || B.y1 < A.y0 - eps) continue;
        const [p, p2] = A.s, [q, q2] = B.s, r = [p2[0] - p[0], p2[1] - p[1]], sv = [q2[0] - q[0], q2[1] - q[1]], den = r[0] * sv[1] - r[1] * sv[0];
        if (Math.abs(den) > 1e-12) {
          const t = ((q[0] - p[0]) * sv[1] - (q[1] - p[1]) * sv[0]) / den, u = ((q[0] - p[0]) * r[1] - (q[1] - p[1]) * r[0]) / den;
          if (t > -1e-9 && t < 1 + 1e-9 && u > -1e-9 && u < 1 + 1e-9) { A.ts.push(t); B.ts.push(u); }
        }
        for (const e of [q, q2]) if (dToSeg(A.s, e) < eps) A.ts.push(paramOf(A.s, e));
        for (const e of [p, p2]) if (dToSeg(B.s, e) < eps) B.ts.push(paramOf(B.s, e));
      }
    }
    // 3. nodes and edges
    const nodes = [], key = new Map();
    const nodeId = (p) => { const k = Math.round(p[0] / eps) + ',' + Math.round(p[1] / eps); let id = key.get(k); if (id == null) { id = nodes.length; nodes.push([p[0], p[1]]); key.set(k, id); } return id; };
    const edgeSet = new Set(), edges = [];
    for (const A of info) {
      const ts = A.ts.map((t) => Math.max(0, Math.min(1, t))).sort((a, b) => a - b);
      for (let i = 0; i + 1 < ts.length; i++) {
        if (ts[i + 1] - ts[i] < 1e-12) continue;
        const pa = [A.s[0][0] + (A.s[1][0] - A.s[0][0]) * ts[i], A.s[0][1] + (A.s[1][1] - A.s[0][1]) * ts[i]], pb = [A.s[0][0] + (A.s[1][0] - A.s[0][0]) * ts[i + 1], A.s[0][1] + (A.s[1][1] - A.s[0][1]) * ts[i + 1]];
        const a = nodeId(pa), b = nodeId(pb); if (a === b) continue;
        const k = a < b ? a + '_' + b : b + '_' + a; if (edgeSet.has(k)) continue; edgeSet.add(k); edges.push([a, b]);
      }
    }
    // 4. prune dangling edges
    let adj = nodes.map(() => new Set());
    for (const [a, b] of edges) { adj[a].add(b); adj[b].add(a); }
    const stack = []; adj.forEach((s, i) => { if (s.size === 1) stack.push(i); });
    while (stack.length) { const i = stack.pop(); if (adj[i].size !== 1) { if (adj[i].size === 0) continue; else continue; } const j = Array.from(adj[i])[0]; adj[i].delete(j); adj[j].delete(i); if (adj[j].size === 1) stack.push(j); }
    // 5. faces (half-edge walk, interior on the left)
    const nbr = adj.map((s, i) => Array.from(s).sort((a, b) => Math.atan2(nodes[a][1] - nodes[i][1], nodes[a][0] - nodes[i][0]) - Math.atan2(nodes[b][1] - nodes[i][1], nodes[b][0] - nodes[i][0])));
    const used = new Set(), faces = [];
    const comp = nodes.map((_, i) => i); const find = (x) => { while (comp[x] !== x) { comp[x] = comp[comp[x]]; x = comp[x]; } return x; };
    nbr.forEach((l, i) => l.forEach((j) => { comp[find(i)] = find(j); }));
    for (let u = 0; u < nodes.length; u++) {
      for (const v0 of nbr[u]) {
        if (used.has(u + '>' + v0)) continue;
        const cyc = []; let a = u, b = v0, guard = 0;
        while (!used.has(a + '>' + b) && guard++ < 200000) {
          used.add(a + '>' + b); cyc.push(a);
          const l = nbr[b], idx = l.indexOf(a), c = l[(idx - 1 + l.length) % l.length];
          a = b; b = c;
        }
        if (cyc.length < 3) continue;
        let ar = 0; for (let i = 0; i < cyc.length; i++) { const p = nodes[cyc[i]], q = nodes[cyc[(i + 1) % cyc.length]]; ar += p[0] * q[1] - q[0] * p[1]; }
        faces.push({ cyc, area: ar / 2, comp: find(cyc[0]), poly: cyc.map((i) => nodes[i]) });
      }
    }
    // 6. smallest bounded face around the point, plus islands
    let best = null;
    for (const f of faces) if (f.area > eps * eps && inside([f.poly], pt) && (!best || f.area < best.area)) best = f;
    if (!best) return { error: 'No closed boundary around that point. Close the gap, or use Select objects.' };
    const loops = [best.poly];
    for (const f of faces) if (f.area < 0 && f.comp !== best.comp && inside([best.poly], f.poly[0])) loops.push(f.poly);
    const simp = (poly) => { const r = []; for (let i = 0; i < poly.length; i++) { const a = poly[(i + poly.length - 1) % poly.length], b = poly[i], c = poly[(i + 1) % poly.length]; if (Math.abs((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0])) > eps * Math.max(1, Math.hypot(c[0] - a[0], c[1] - a[1]))) r.push([b[0], b[1], 0]); } return r.length >= 3 ? r : poly.map((p) => [p[0], p[1], 0]); };
    return { loops: loops.map(simp) };
  }


  // ---- association: a hatch remembers its boundary objects and follows them ----
  const isBoundaryEnt = (e) => e.t === 'LINE' || e.t === 'ARC' || e.t === 'CIRCLE' || e.t === 'LWPOLYLINE';
  function centreOf(ents) {
    let b = null;
    for (const e of ents) { const x = G.bbox(e); if (!x || !isFinite(x.minX)) continue; b = b ? { minX: Math.min(b.minX, x.minX), minY: Math.min(b.minY, x.minY), maxX: Math.max(b.maxX, x.maxX), maxY: Math.max(b.maxY, x.maxY) } : { ...x }; }
    return b ? [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2] : [0, 0];
  }
  // Which of the candidate objects form the given loops (an object counts when it passes through a loop corner).
  function sourceIds(cands, loops, tol) {
    const verts = loops.flat(); if (!verts.length) return [];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const v of verts) { x0 = Math.min(x0, v[0]); x1 = Math.max(x1, v[0]); y0 = Math.min(y0, v[1]); y1 = Math.max(y1, v[1]); }
    const out = [];
    for (const e of cands) {
      const b = G.bbox(e); if (b.maxX < x0 - tol || b.minX > x1 + tol || b.maxY < y0 - tol || b.minY > y1 + tol) continue;
      for (const v of verts) if (G.entityDist(e, v) <= tol) { out.push(e.id); break; }
    }
    return out;
  }
  // New hatch fields after the boundary objects changed. byId: id -> entity; cands: boundary candidate entities (visible, not hatches).
  // Returns a replacement entity, or null when nothing needs to change.
  function relink(h, byId, cands, tol) {
    const src = h.src; if (!src) return null;
    const det = (d) => { if (!!h.det === d) return null; const n = { ...h }; if (d) n.det = true; else delete n.det; return n; };
    if (src.mode === 'obj') {
      const ents = src.ids.map((id) => byId.get(id));
      if (ents.some((e) => !e)) return det(true);
      const { loops } = loopsFromObjects(ents);
      if (!loops.length || loops.length < ents.length) return det(true);
      return { ...h, loops, src: { ...src, c: centreOf(ents) }, det: undefined };
    }
    const live = src.ids.map((id) => byId.get(id)).filter(Boolean);
    if (!live.length) return det(true);
    const c = centreOf(live), sh = src.c ? [c[0] - src.c[0], c[1] - src.c[1]] : [0, 0];
    const seeds = [[src.pt[0] + sh[0], src.pt[1] + sh[1]], src.pt];
    for (const sd of seeds) {
      const res = findBoundary(cands, sd, { tol });
      if (res.loops) {
        const n = { ...h, loops: res.loops, src: { mode: 'pt', pt: sd, ids: sourceIds(cands, res.loops, tol * 0.4), c: centreOf(sourceIds(cands, res.loops, tol * 0.4).map((id) => byId.get(id)).filter(Boolean)) } };
        delete n.det; return n;
      }
    }
    return det(true);
  }

  return { isBoundaryEnt, centreOf, sourceIds, relink, PATTERNS, NAMES, segments, trapezoids, loopPoly, polysOf, inside, findBoundary, loopsFromObjects };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = CadHatch;
