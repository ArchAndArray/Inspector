// cadedit.js — pure geometry for the CAD modify commands (no DOM, testable in Node). Global `CadEdit`.
// Transforms (move / rotate / scale / mirror), grips, stretch, offset, trim, extend, fillet,
// chamfer and explode. Entities are the plain JSON used by cadcmd.js:
//   LINE {p1,p2}  CIRCLE {c,r}  ARC {c,r,a0,a1 (CCW)}  LWPOLYLINE {v:[[x,y,bulge]],closed}  POINT {p}

const CadEdit = (() => {
  'use strict';
  const G = (typeof CadGeo !== 'undefined') ? CadGeo : require('./cadgeo.js');
  const { sub, add, mul, dot, cross, len, dist, polar, angleBetween, normAng, sweepOf, TAU } = G;
  const D = (typeof CadDim !== 'undefined') ? CadDim : require('./caddim.js');
  const EPS = 1e-9;
  const clone = (e) => JSON.parse(JSON.stringify(e));
  const clamp1 = (x) => Math.max(-1, Math.min(1, x));
  const unit = (v) => { const l = len(v); return l < EPS ? [1, 0] : [v[0] / l, v[1] / l]; };
  const leftNormal = (a, b) => { const d = sub(b, a), l = len(d) || 1; return [-d[1] / l, d[0] / l]; };
  function bulge3(p1, p2, p3) {
    const a = G.arcThrough3(p1, p2, p3); if (!a) return null;
    const ccw = cross(sub(p2, p1), sub(p3, p2)) > 0;
    return Math.tan((ccw ? 1 : -1) * sweepOf(a.a0, a.a1) / 4);
  }

  // ---------- transforms ----------
  function moveXf(d) { return { fn: (p) => [p[0] + d[0], p[1] + d[1]], flip: false, k: 1 }; }
  function rotXf(b, a) {
    const c = Math.cos(a), s = Math.sin(a);
    return { fn: (p) => { const x = p[0] - b[0], y = p[1] - b[1]; return [b[0] + x * c - y * s, b[1] + x * s + y * c]; }, flip: false, k: 1 };
  }
  function scaleXf(b, f) { return { fn: (p) => [b[0] + (p[0] - b[0]) * f, b[1] + (p[1] - b[1]) * f], flip: false, k: f }; }
  function mirrorXf(p1, p2) {
    const u = unit(sub(p2, p1));
    return {
      fn: (p) => { const x = p[0] - p1[0], y = p[1] - p1[1], t = x * u[0] + y * u[1]; return [2 * (p1[0] + u[0] * t) - p[0], 2 * (p1[1] + u[1] * t) - p[1]]; },
      flip: true, k: 1
    };
  }
  function transformEntity(e, xf) {
    const n = clone(e);
    switch (e.t) {
      case 'LINE': n.p1 = xf.fn(e.p1); n.p2 = xf.fn(e.p2); break;
      case 'POINT': n.p = xf.fn(e.p); break;
      case 'CIRCLE': n.c = xf.fn(e.c); n.r = e.r * xf.k; break;
      case 'ARC': {
        const s = xf.fn(polar(e.c, e.a0, e.r)), en = xf.fn(polar(e.c, e.a1, e.r));
        n.c = xf.fn(e.c); n.r = e.r * xf.k;
        const as = angleBetween(n.c, s), ae = angleBetween(n.c, en);
        if (xf.flip) { n.a0 = ae; n.a1 = as; } else { n.a0 = as; n.a1 = ae; }
        break;
      }
      case 'LWPOLYLINE':
        n.v = e.v.map((q) => { const p = xf.fn([q[0], q[1]]); return [p[0], p[1], xf.flip ? -(q[2] || 0) : (q[2] || 0)]; });
        break;
      case 'TEXT': case 'MTEXT': {
        n.p = xf.fn(e.p); n.h = e.h * xf.k; if (e.w) n.w = e.w * xf.k;
        const o = xf.fn([e.p[0] + Math.cos(e.rot || 0), e.p[1] + Math.sin(e.rot || 0)]);
        let r = Math.atan2(o[1] - n.p[1], o[0] - n.p[0]);
        if (xf.flip && Math.cos(r) < -1e-9) r += Math.PI;      // mirrored text stays readable
        n.rot = r; break;
      }
      case 'DIM': {
        n.p1 = xf.fn(e.p1); n.p2 = xf.fn(e.p2); n.off = xf.fn(e.off);
        if (e.k === 'lin') { const o = xf.fn([e.p1[0] + Math.cos(e.ang || 0), e.p1[1] + Math.sin(e.ang || 0)]); n.ang = Math.atan2(o[1] - n.p1[1], o[0] - n.p1[0]); }
        break;
      }
      default: break;
    }
    return n;
  }

  // ---------- grips ----------
  function grips(e) {
    const out = [];
    switch (e.t) {
      case 'LINE': out.push({ pt: e.p1, i: 0, kind: 'end' }, { pt: e.p2, i: 1, kind: 'end' }, { pt: G.mid(e.p1, e.p2), i: 2, kind: 'mid' }); break;
      case 'POINT': out.push({ pt: e.p, i: 0, kind: 'end' }); break;
      case 'CIRCLE':
        out.push({ pt: e.c, i: 0, kind: 'cen' });
        for (let q = 0; q < 4; q++) out.push({ pt: polar(e.c, q * Math.PI / 2, e.r), i: 1 + q, kind: 'quad' });
        break;
      case 'ARC': {
        const [s, en] = G.arcPoints(e);
        out.push({ pt: s, i: 0, kind: 'end' }, { pt: en, i: 1, kind: 'end' }, { pt: G.arcMid(e), i: 2, kind: 'mid' }, { pt: e.c, i: 3, kind: 'cen' });
        break;
      }
      case 'LWPOLYLINE': {
        e.v.forEach((q, i) => out.push({ pt: [q[0], q[1]], i, kind: 'end' }));
        G.polySegments(e).forEach((s, k) => out.push({ pt: s.k === 's' ? G.mid(s.p1, s.p2) : G.arcMid(s), i: e.v.length + k, kind: 'mid', seg: k }));
        break;
      }
      case 'TEXT': case 'MTEXT': out.push({ pt: e.p, i: 0, kind: 'end' }); break;
      case 'DIM': { const f = D.frame(e); out.push({ pt: e.p1, i: 0, kind: 'end' }, { pt: e.p2, i: 1, kind: 'end' }, { pt: G.mid(f.A, f.B), i: 2, kind: 'mid' }); break; }
      default: break;
    }
    return out;
  }
  // New entity with grip g dragged to np, or null when the result is degenerate.
  function gripApply(e, g, np) {
    const n = clone(e), d = sub(np, g.pt);
    switch (e.t) {
      case 'LINE':
        if (g.i === 0) n.p1 = np; else if (g.i === 1) n.p2 = np; else { n.p1 = add(e.p1, d); n.p2 = add(e.p2, d); }
        break;
      case 'POINT': n.p = np; break;
      case 'CIRCLE':
        if (g.i === 0) n.c = add(e.c, d);
        else { const r = dist(e.c, np); if (r < EPS) return null; n.r = r; }
        break;
      case 'ARC': {
        if (g.i === 3) { n.c = add(e.c, d); break; }
        const [s, en] = G.arcPoints(e), m = G.arcMid(e);
        const a = g.i === 0 ? G.arcThrough3(np, m, en) : g.i === 1 ? G.arcThrough3(s, m, np) : G.arcThrough3(s, np, en);
        if (!a) return null;
        n.c = a.c; n.r = a.r; n.a0 = a.a0; n.a1 = a.a1;
        break;
      }
      case 'LWPOLYLINE': {
        const nv = e.v.length;
        if (g.i < nv) n.v[g.i] = [np[0], np[1], e.v[g.i][2] || 0];
        else {
          const k = g.seg, j = (k + 1) % nv, seg = G.polySegments(e)[k];
          if (seg.k === 's') {
            n.v[k] = [e.v[k][0] + d[0], e.v[k][1] + d[1], e.v[k][2] || 0];
            n.v[j] = [e.v[j][0] + d[0], e.v[j][1] + d[1], e.v[j][2] || 0];
          } else { const b = bulge3(seg.p1, np, seg.p2); if (b == null) return null; n.v[k][2] = b; }
        }
        break;
      }
      case 'TEXT': case 'MTEXT': n.p = np; break;
      case 'DIM': if (g.i === 0) n.p1 = np; else if (g.i === 1) n.p2 = np; else n.off = add(e.off, d); break;
      default: return null;
    }
    return n;
  }

  // ---------- stretch ----------
  // Move whatever part of e lies inside rect r by d; null when nothing is inside.
  function stretchEntity(e, r, d) {
    const ins = (p) => G.inRect(p, r), mv = (p) => [p[0] + d[0], p[1] + d[1]];
    switch (e.t) {
      case 'POINT': return ins(e.p) ? { ...clone(e), p: mv(e.p) } : null;
      case 'CIRCLE': return ins(e.c) ? { ...clone(e), c: mv(e.c) } : null;
      case 'LINE': {
        const a = ins(e.p1), b = ins(e.p2); if (!a && !b) return null;
        const n = clone(e); if (a) n.p1 = mv(e.p1); if (b) n.p2 = mv(e.p2); return n;
      }
      case 'ARC': {
        const [s, en] = G.arcPoints(e), a = ins(s), b = ins(en);
        if (!a && !b) return null;
        if (a && b) return { ...clone(e), c: mv(e.c) };
        return gripApply(e, { i: a ? 0 : 1, pt: a ? s : en }, mv(a ? s : en));
      }
      case 'LWPOLYLINE': {
        let any = false; const n = clone(e);
        n.v = e.v.map((q) => { if (ins([q[0], q[1]])) { any = true; return [q[0] + d[0], q[1] + d[1], q[2] || 0]; } return [q[0], q[1], q[2] || 0]; });
        return any ? n : null;
      }
      case 'TEXT': case 'MTEXT': return ins(e.p) ? { ...clone(e), p: mv(e.p) } : null;
      case 'DIM': {
        const a = ins(e.p1), b = ins(e.p2), c = ins(e.off); if (!a && !b && !c) return null;
        const n = clone(e); if (a) n.p1 = mv(e.p1); if (b) n.p2 = mv(e.p2); if (c) n.off = mv(e.off); return n;
      }
      default: return null;
    }
  }

  // ---------- offset ----------
  // Side of the entity a point lies on: +1 = left of travel (inside for circles and arcs), -1 = right.
  function offsetSide(e, pt) {
    switch (e.t) {
      case 'LINE': return cross(sub(e.p2, e.p1), sub(pt, e.p1)) >= 0 ? 1 : -1;
      case 'CIRCLE': case 'ARC': return dist(e.c, pt) < e.r ? 1 : -1;
      case 'LWPOLYLINE': {
        let best = null, bd = Infinity;
        for (const s of G.polySegments(e)) { const d = G.nearestOnPrim(s, pt).d; if (d < bd) { bd = d; best = s; } }
        if (!best) return 1;
        if (best.k === 's') return cross(sub(best.p2, best.p1), sub(pt, best.p1)) >= 0 ? 1 : -1;
        const inside = dist(best.c, pt) < best.r;
        return best.bulge > 0 ? (inside ? 1 : -1) : (inside ? -1 : 1);
      }
      default: return 1;
    }
  }
  // Distance from a point to the entity (used by Offset > Through).
  function offsetDistanceThrough(e, pt) {
    if (e.t === 'LINE') return Math.abs(cross(unit(sub(e.p2, e.p1)), sub(pt, e.p1)));
    if (e.t === 'CIRCLE' || e.t === 'ARC') return Math.abs(dist(e.c, pt) - e.r);
    return G.entityDist(e, pt);
  }
  function lineCircleInf(a, c) {
    const d = sub(a.p2, a.p1), f = sub(a.p1, c.c);
    const A = dot(d, d), B = 2 * dot(f, d), C = dot(f, f) - c.r * c.r;
    const disc = B * B - 4 * A * C; if (disc < 0 || A < EPS) return [];
    const sq = Math.sqrt(disc);
    return [(-B - sq) / (2 * A), (-B + sq) / (2 * A)].map((t) => [a.p1[0] + d[0] * t, a.p1[1] + d[1] * t]);
  }
  function offsetEntity(e, amt) {
    const n = clone(e);
    switch (e.t) {
      case 'LINE': { const nm = leftNormal(e.p1, e.p2); n.p1 = add(e.p1, mul(nm, amt)); n.p2 = add(e.p2, mul(nm, amt)); return n; }
      case 'CIRCLE': case 'ARC': { const r = e.r - amt; if (r <= EPS) return null; n.r = r; return n; }
      case 'LWPOLYLINE': return offsetPoly(e, amt);
      default: return null;
    }
  }
  function offsetPoly(e, amt) {
    const segs = G.polySegments(e), nSeg = segs.length, nv = e.v.length, closed = !!e.closed;
    if (!nSeg) return null;
    const car = [];
    for (const s of segs) {
      if (s.k === 's') { const nm = leftNormal(s.p1, s.p2); car.push({ k: 's', p1: add(s.p1, mul(nm, amt)), p2: add(s.p2, mul(nm, amt)) }); }
      else {
        const ccw = s.bulge > 0, r = ccw ? s.r - amt : s.r + amt;
        if (r <= EPS) return null;
        car.push({ k: 'c', c: s.c, r, dir: ccw ? 1 : -1, a0: s.a0, a1: s.a1 });
      }
    }
    const startPt = (i) => { const c = car[i]; return c.k === 's' ? c.p1 : polar(c.c, c.dir > 0 ? c.a0 : c.a1, c.r); };
    const endPt = (i) => { const c = car[i]; return c.k === 's' ? c.p2 : polar(c.c, c.dir > 0 ? c.a1 : c.a0, c.r); };
    function joinPoint(a, b, ea, sb) {
      if (dist(ea, sb) < 1e-9) return ea;
      const mid = G.mid(ea, sb);
      let cands;
      if (a.k === 's' && b.k === 's') {
        const da = sub(a.p2, a.p1), db = sub(b.p2, b.p1), den = cross(da, db);
        if (Math.abs(den) < 1e-12 * len(da) * len(db)) return mid;
        const t = cross(sub(b.p1, a.p1), db) / den;
        return add(a.p1, mul(da, t));
      }
      if (a.k === 's') cands = lineCircleInf(a, b);
      else if (b.k === 's') cands = lineCircleInf(b, a);
      else cands = G.intersectPrims({ k: 'c', c: a.c, r: a.r }, { k: 'c', c: b.c, r: b.r });
      if (!cands.length) return mid;
      cands.sort((p, q) => dist(p, mid) - dist(q, mid));
      return cands[0];
    }
    const P = [];
    for (let j = 0; j < nv; j++) {
      const prev = j - 1 < 0 ? (closed ? nSeg - 1 : -1) : j - 1;
      const next = j < nSeg ? j : -1;
      if (prev < 0) P.push(startPt(next));
      else if (next < 0) P.push(endPt(prev));
      else P.push(joinPoint(car[prev], car[next], endPt(prev), startPt(next)));
    }
    const out = [];
    for (let k = 0; k < nv; k++) {
      if (k >= nSeg) { out.push([P[k][0], P[k][1], 0]); continue; }
      const p = P[k], q = P[(k + 1) % nv], s = segs[k], c = car[k];
      if (c.k === 's') {
        if (dot(sub(q, p), sub(s.p2, s.p1)) <= 0) return null;       // segment collapsed or reversed
        out.push([p[0], p[1], 0]);
      } else {
        const a1 = angleBetween(c.c, p), a2 = angleBetween(c.c, q);
        const sw = c.dir > 0 ? normAng(a2 - a1) : normAng(a1 - a2);
        if (sw < 1e-9) return null;
        out.push([p[0], p[1], c.dir * Math.tan(sw / 4)]);
      }
    }
    const n = clone(e); n.v = out; return n;
  }

  // ---------- paths (trim / extend) ----------
  // A path is the entity as an ordered chain of segments in travel order; parameter u runs 0..n.
  function pathOf(e) {
    if (e.t === 'LINE') return { segs: [{ k: 's', p1: e.p1, p2: e.p2 }], closed: false, kind: 'LINE' };
    if (e.t === 'ARC') return { segs: [{ k: 'c', c: e.c, r: e.r, a0: e.a0, a1: e.a1, dir: 1, p1: polar(e.c, e.a0, e.r), p2: polar(e.c, e.a1, e.r) }], closed: false, kind: 'ARC' };
    if (e.t === 'CIRCLE') { const p = polar(e.c, 0, e.r); return { segs: [{ k: 'c', c: e.c, r: e.r, full: true, dir: 1, p1: p, p2: p }], closed: true, kind: 'CIRCLE' }; }
    if (e.t === 'LWPOLYLINE') return { segs: G.polySegments(e).map((s) => (s.k === 'c' ? { ...s, dir: s.bulge > 0 ? 1 : -1 } : s)), closed: !!e.closed, kind: 'POLY' };
    return null;
  }
  const segSweep = (s) => (s.full ? TAU : sweepOf(s.a0, s.a1));
  const segStartAng = (s) => (s.full ? 0 : (s.dir > 0 ? s.a0 : s.a1));
  function pointAt(s, f) {
    if (s.k === 's') return [s.p1[0] + (s.p2[0] - s.p1[0]) * f, s.p1[1] + (s.p2[1] - s.p1[1]) * f];
    return polar(s.c, segStartAng(s) + s.dir * segSweep(s) * f, s.r);
  }
  function fracOf(s, q) {
    if (s.k === 's') {
      const d = sub(s.p2, s.p1), l2 = dot(d, d);
      return l2 < EPS ? 0 : Math.max(0, Math.min(1, dot(sub(q, s.p1), d) / l2));
    }
    const ang = angleBetween(s.c, q), ts = segStartAng(s);
    let delta = s.dir > 0 ? normAng(ang - ts) : normAng(ts - ang);
    if (delta > TAU - 1e-7) delta = 0;
    const S = segSweep(s);
    if (delta > S) delta = S;
    return delta / S;
  }
  function sliceSeg(s, f0, f1) {
    const p1 = pointAt(s, f0), p2 = pointAt(s, f1);
    if (s.k === 's') return { p1, p2, bulge: 0 };
    return { p1, p2, bulge: s.dir * Math.tan(segSweep(s) * (f1 - f0) / 4) };
  }
  function subVerts(path, ua, ub) {
    const n = path.segs.length, parts = [];
    const collect = (a, b) => {
      if (b - a < 1e-9) return;
      let k0 = Math.floor(a + 1e-12); const k1 = Math.ceil(b - 1e-12) - 1;
      if (k0 > n - 1) k0 = n - 1;
      for (let k = k0; k <= k1; k++) {
        const f0 = k === k0 ? a - k : 0, f1 = k === k1 ? b - k : 1;
        if (f1 - f0 < 1e-9) continue;
        parts.push(sliceSeg(path.segs[k], f0, f1));
      }
    };
    if (ub >= ua) collect(ua, ub); else { collect(ua, n); collect(0, ub); }
    const v = [];
    for (const s of parts) {
      if (!v.length) v.push([s.p1[0], s.p1[1], 0]);
      v[v.length - 1][2] = s.bulge;
      v.push([s.p2[0], s.p2[1], 0]);
    }
    return v;
  }
  function entityFromVerts(e, kind, v) {
    if (v.length < 2) return null;
    const n = clone(e);
    if (kind === 'LINE') { n.p1 = [v[0][0], v[0][1]]; n.p2 = [v[1][0], v[1][1]]; return n; }
    if (kind === 'ARC' || kind === 'CIRCLE') {
      const a = G.bulgeArc([v[0][0], v[0][1]], [v[1][0], v[1][1]], v[0][2]);
      if (!a) return null;
      n.t = 'ARC'; n.c = a.c; n.r = a.r; n.a0 = a.a0; n.a1 = a.a1; delete n.v; return n;
    }
    n.t = 'LWPOLYLINE'; n.v = v; n.closed = false; return n;
  }
  function cutParams(path, others) {
    const n = path.segs.length; let us = [];
    path.segs.forEach((seg, k) => {
      const sp = seg.full ? { k: 'c', c: seg.c, r: seg.r } : seg;
      for (const o of others) for (const op of G.prims(o)) for (const q of G.intersectPrims(sp, op)) us.push(k + fracOf(seg, q));
    });
    if (path.closed) us = us.map((u) => ((u % n) + n) % n);
    us.sort((a, b) => a - b);
    const out = [];
    for (const u of us) if (!out.length || u - out[out.length - 1] > 1e-7) out.push(u);
    if (path.closed && out.length > 1 && out[out.length - 1] - out[0] > n - 1e-7) out.pop();
    return out;
  }
  function pickParam(path, pt) {
    let bu = 0, bd = Infinity;
    path.segs.forEach((seg, k) => {
      const sp = seg.full ? { k: 'c', c: seg.c, r: seg.r } : seg;
      const nr = G.nearestOnPrim(sp, pt);
      if (nr.d < bd) { bd = nr.d; bu = k + fracOf(seg, nr.pt); }
    });
    return bu;
  }

  // ---------- trim ----------
  // Remove the part of e under pickPt, bounded by where other objects cross it.
  // Returns { pieces: [entity] } (empty = whole object removed) or { error }.
  function trimEntity(e, pickPt, others) {
    const path = pathOf(e); if (!path) return { error: 'This object cannot be trimmed.' };
    const n = path.segs.length, cuts = cutParams(path, others), up = pickParam(path, pickPt);
    if (path.closed) {
      if (cuts.length < 2) return { error: cuts.length ? 'A closed object needs two cutting edges.' : 'Object does not intersect an edge.' };
      let upper = cuts.find((c) => c > up); if (upper === undefined) upper = cuts[0] + n;
      let lower = null; for (let i = cuts.length - 1; i >= 0; i--) if (cuts[i] <= up) { lower = cuts[i]; break; }
      if (lower === null) lower = cuts[cuts.length - 1] - n;
      const m = (x) => ((x % n) + n) % n;
      const ent = entityFromVerts(e, path.kind, subVerts(path, m(upper), m(lower)));
      return { pieces: ent ? [ent] : [] };
    }
    if (!cuts.length) return { error: 'Object does not intersect an edge.' };
    let lower, upper;
    for (const c of cuts) { if (c <= up) lower = c; else if (upper === undefined) upper = c; }
    const pieces = [];
    if (lower !== undefined && lower > 1e-7) { const p = entityFromVerts(e, path.kind, subVerts(path, 0, lower)); if (p) pieces.push(p); }
    if (upper !== undefined && upper < n - 1e-7) { const p = entityFromVerts(e, path.kind, subVerts(path, upper, n)); if (p) pieces.push(p); }
    return { pieces };
  }

  // ---------- extend ----------
  function rayPrim(o, d, p, inf) {
    if (p.k === 's') {
      const s2 = sub(p.p2, p.p1), den = cross(d, s2);
      if (Math.abs(den) < 1e-12 * len(s2)) return [];
      const qp = sub(p.p1, o), t = cross(qp, s2) / den, u = cross(qp, d) / den;
      return !inf && (u < -1e-9 || u > 1 + 1e-9) ? [] : [t];
    }
    const f = sub(o, p.c), B = 2 * dot(f, d), C = dot(f, f) - p.r * p.r, disc = B * B - 4 * C;
    if (disc < 0) return [];
    const sq = Math.sqrt(disc), out = [];
    for (const t of [(-B - sq) / 2, (-B + sq) / 2]) {
      const q = add(o, mul(d, t));
      if (!inf && G.isArc(p) && !G.angleInArc(angleBetween(p.c, q), p.a0, p.a1)) continue;
      out.push(t);
    }
    return out;
  }
  // Extend the end of e nearest pickPt to the nearest boundary among others. Returns { entity } or { error }.
  function extendEntity(e, pickPt, others) {
    const r = extendPass(e, pickPt, others, false);
    if (!r.error) return r;
    const r2 = extendPass(e, pickPt, others, true);     // no real boundary: try where the boundaries would meet if extended
    if (!r2.error) { r2.implied = true; return r2; }
    return r;
  }
  function extendPass(e, pickPt, others, inf) {
    const path = pathOf(e); if (!path || path.closed) return { error: 'This object cannot be extended.' };
    const n = path.segs.length, up = pickParam(path, pickPt), atEnd = up >= n / 2;
    const seg = atEnd ? path.segs[n - 1] : path.segs[0];
    const vi = atEnd ? n : 0;                      // polyline vertex that moves
    const otherPrims = []; for (const o of others) otherPrims.push(...G.prims(o));
    if (seg.k === 's') {
      const o = atEnd ? seg.p2 : seg.p1, d = unit(sub(o, atEnd ? seg.p1 : seg.p2));
      let best = Infinity;
      for (const op of otherPrims) for (const t of rayPrim(o, d, op, inf)) if (t > 1e-7 && t < best) best = t;
      if (!isFinite(best)) return { error: 'Nothing to extend to in that direction. Pick the end you want to extend, nearest its end.' };
      const np = add(o, mul(d, best)), n2 = clone(e);
      if (e.t === 'LINE') { if (atEnd) n2.p2 = np; else n2.p1 = np; }
      else n2.v[vi] = [np[0], np[1], e.v[vi][2] || 0];
      return { entity: n2 };
    }
    const extDir = atEnd ? seg.dir : -seg.dir;
    const angEnd = atEnd ? (seg.dir > 0 ? seg.a1 : seg.a0) : (seg.dir > 0 ? seg.a0 : seg.a1);
    const S = sweepOf(seg.a0, seg.a1);
    let best = Infinity;
    for (const op of otherPrims) {
      let pts;
      if (inf && op.k === 's') pts = lineCircleInf(op, { c: seg.c, r: seg.r });
      else if (inf) pts = G.intersectPrims({ k: 'c', c: seg.c, r: seg.r }, { k: 'c', c: op.c, r: op.r });
      else pts = G.intersectPrims({ k: 'c', c: seg.c, r: seg.r }, op);
      for (const q of pts) {
        const ang = angleBetween(seg.c, q);
        const delta = extDir > 0 ? normAng(ang - angEnd) : normAng(angEnd - ang);
        if (delta > 1e-7 && delta < best && S + delta < TAU - 1e-6) best = delta;
      }
    }
    if (!isFinite(best)) return { error: 'Nothing to extend to in that direction. Pick the end you want to extend, nearest its end.' };
    const newAng = angEnd + extDir * best, n2 = clone(e);
    if (e.t === 'ARC') { if (extDir > 0) n2.a1 = newAng; else n2.a0 = newAng; return { entity: n2 }; }
    const q = polar(seg.c, newAng, seg.r), si = atEnd ? n - 1 : 0;
    n2.v[vi] = [q[0], q[1], e.v[vi][2] || 0];
    n2.v[si][2] = seg.dir * Math.tan((S + best) / 4);
    return { entity: n2 };
  }

  // ---------- fillet / chamfer (two lines) ----------
  function corner(l1, pick1, l2, pick2) {
    const d1 = sub(l1.p2, l1.p1), d2 = sub(l2.p2, l2.p1), den = cross(d1, d2);
    if (len(d1) < EPS || len(d2) < EPS || Math.abs(den) < 1e-9 * len(d1) * len(d2)) return null;
    const t = cross(sub(l2.p1, l1.p1), d2) / den, I = add(l1.p1, mul(d1, t));
    const side = (l, pick) => {
      const dh = unit(sub(l.p2, l.p1)), s = dot(sub(pick, I), dh);
      let u = s >= 0 ? dh : mul(dh, -1);
      if (Math.abs(s) < 1e-9) { const a = dot(sub(l.p1, I), dh), b = dot(sub(l.p2, I), dh); u = Math.abs(a) > Math.abs(b) ? mul(dh, Math.sign(a)) : mul(dh, Math.sign(b)); }
      const far = Math.max(dot(sub(l.p1, I), u), dot(sub(l.p2, I), u));
      return { u, far, F: add(I, mul(u, far)) };
    };
    return { I, a: side(l1, pick1), b: side(l2, pick2) };
  }
  // Returns { l1, l2, arc } (any may be absent) or { error }. trim=false leaves the lines alone.
  function filletLines(l1, pick1, l2, pick2, r, trim) {
    const cd = corner(l1, pick1, l2, pick2); if (!cd) return { error: 'The lines are parallel.' };
    const { I, a, b } = cd, phi = Math.acos(clamp1(dot(a.u, b.u)));
    if (phi < 1e-6 || phi > Math.PI - 1e-6) return { error: 'The lines are parallel.' };
    const t = r > 0 ? r / Math.tan(phi / 2) : 0;
    if (a.far <= t + 1e-9 || b.far <= t + 1e-9) return { error: 'The lines are too short for this radius.' };
    const T1 = add(I, mul(a.u, t)), T2 = add(I, mul(b.u, t)), out = {};
    if (trim) { out.l1 = { ...clone(l1), p1: T1, p2: a.F }; out.l2 = { ...clone(l2), p1: T2, p2: b.F }; }
    if (r > 0) {
      const C = add(I, mul(unit(add(a.u, b.u)), r / Math.sin(phi / 2)));
      const aT1 = angleBetween(C, T1), aT2 = angleBetween(C, T2), ccw = cross(sub(T1, C), sub(T2, C)) > 0;
      out.arc = { t: 'ARC', c: C, r, a0: ccw ? aT1 : aT2, a1: ccw ? aT2 : aT1, layer: l1.layer };
    }
    return out;
  }
  function chamferLines(l1, pick1, l2, pick2, d1, d2, trim) {
    const cd = corner(l1, pick1, l2, pick2); if (!cd) return { error: 'The lines are parallel.' };
    const { I, a, b } = cd;
    if (a.far <= d1 + 1e-9 || b.far <= d2 + 1e-9) return { error: 'The lines are too short for these distances.' };
    const T1 = add(I, mul(a.u, d1)), T2 = add(I, mul(b.u, d2)), out = {};
    if (trim) { out.l1 = { ...clone(l1), p1: T1, p2: a.F }; out.l2 = { ...clone(l2), p1: T2, p2: b.F }; }
    if (d1 > EPS || d2 > EPS) out.line = { t: 'LINE', p1: T1, p2: T2, layer: l1.layer };
    return out;
  }
  // Fillet or chamfer every straight-straight vertex of a polyline. Returns the new entity or null if nothing changed.
  function polyCorners(e, mode, d1, d2, only) {
    const v = e.v.map((q) => [q[0], q[1], q[2] || 0]), nv = v.length, closed = !!e.closed, nSeg = closed ? nv : nv - 1;
    const info = new Array(nv).fill(null);
    for (let i = 0; i < nv; i++) {
      if (!closed && (i === 0 || i === nv - 1)) continue;
      if (only != null && i !== only) continue;
      const kp = (i - 1 + nv) % nv, kn = i;
      if (kp >= nSeg || kn >= nSeg || v[kp][2] || v[kn][2]) continue;
      const P = v[kp], V = v[i], N = v[(i + 1) % nv], a = sub(P, V), b = sub(N, V), la = len(a), lb = len(b);
      if (la < EPS || lb < EPS) continue;
      const u1 = mul(a, 1 / la), u2 = mul(b, 1 / lb), phi = Math.acos(clamp1(dot(u1, u2)));
      if (phi < 1e-6 || phi > Math.PI - 1e-6) continue;
      const t1 = mode === 'fillet' ? d1 / Math.tan(phi / 2) : d1, t2 = mode === 'fillet' ? d1 / Math.tan(phi / 2) : d2;
      if (t1 < EPS && t2 < EPS) continue;
      info[i] = { u1, u2, t1, t2, V, phi, turn: cross(sub(V, P), sub(N, V)) };
    }
    for (let k = 0; k < nSeg; k++) {
      const a = k, b = (k + 1) % nv, ta = info[a] ? info[a].t2 : 0, tb = info[b] ? info[b].t1 : 0;
      if (ta + tb > dist(v[a], v[b]) + 1e-9) { info[a] = null; info[b] = null; }
    }
    const out = []; let changed = false;
    for (let i = 0; i < nv; i++) {
      const f = info[i];
      if (!f) { out.push(v[i]); continue; }
      changed = true;
      const A = add(f.V, mul(f.u1, f.t1)), B = add(f.V, mul(f.u2, f.t2));
      out.push([A[0], A[1], mode === 'fillet' ? Math.sign(f.turn) * Math.tan((Math.PI - f.phi) / 4) : 0]);
      out.push([B[0], B[1], v[i][2]]);
    }
    if (!changed) return null;
    const n = clone(e); n.v = out; return n;
  }

  // ---------- area / perimeter ----------
  // v: [[x,y,bulge]...]. The loop is closed by a straight chord when `closed` is false (area only).
  function areaPerimeter(v, closed) {
    const n = v.length; let sh = 0, per = 0, seg = 0;
    for (let i = 0; i < n; i++) {
      const isClosing = i === n - 1;
      if (isClosing && !closed && n < 3) continue;
      const p = v[i], q = v[(i + 1) % n], b = (isClosing && !closed) ? 0 : (p[2] || 0), chord = dist(p, q);
      sh += p[0] * q[1] - q[0] * p[1];
      let l = chord;
      if (Math.abs(b) > 1e-12 && chord > EPS) {
        const th = 4 * Math.atan(Math.abs(b)), r = chord / (2 * Math.sin(th / 2));
        l = r * th; seg += Math.sign(b) * r * r / 2 * (th - Math.sin(th));
      }
      if (!(isClosing && !closed)) per += l;
    }
    return { area: Math.abs(sh / 2 + seg), perimeter: per };
  }

  // ---------- explode ----------
  function explode(e) {
    if (e.t === 'DIM') {
      const g = D.geom(e), base = clone(e);
      ['k', 'p1', 'p2', 'off', 'ang', 'th', 'ar', 'eo', 'ee', 'gap', 'dec', 'txt', 'id'].forEach((k) => delete base[k]);
      const out = g.lines.map(([p1, p2]) => ({ ...base, t: 'LINE', p1, p2 }));
      for (const a of g.arrows) {
        const nrm = [-a.dir[1], a.dir[0]], b = [a.tip[0] + a.dir[0] * a.size, a.tip[1] + a.dir[1] * a.size], w = a.size / 6;
        out.push({ ...base, t: 'LWPOLYLINE', closed: true, v: [[a.tip[0], a.tip[1], 0], [b[0] + nrm[0] * w, b[1] + nrm[1] * w, 0], [b[0] - nrm[0] * w, b[1] - nrm[1] * w, 0]] });
      }
      const tw = D.CW * g.text.h * g.text.str.length;
      out.push({ ...base, t: 'TEXT', p: [g.text.p[0] - Math.cos(g.text.rot) * tw / 2, g.text.p[1] - Math.sin(g.text.rot) * tw / 2], h: g.text.h, rot: g.text.rot, text: g.text.str });
      return out;
    }
    if (e.t !== 'LWPOLYLINE') return null;
    const base = clone(e); delete base.v; delete base.closed; delete base.id;
    return G.polySegments(e).map((s) => (s.k === 's' ? { ...base, t: 'LINE', p1: s.p1, p2: s.p2 } : { ...base, t: 'ARC', c: s.c, r: s.r, a0: s.a0, a1: s.a1 }));
  }

  return {
    moveXf, rotXf, scaleXf, mirrorXf, transformEntity, grips, gripApply, stretchEntity,
    offsetSide, offsetDistanceThrough, offsetEntity, trimEntity, extendEntity,
    filletLines, chamferLines, polyCorners, explode, pathOf, bulge3, areaPerimeter
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = CadEdit;
