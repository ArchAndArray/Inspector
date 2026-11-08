// cadvp.js — layouts and viewports: geometry, clipping and linked titles. No DOM; testable in Node. Global `CadVp`.
//
//   VPORT { t:'VPORT', loops:[[[x,y,bulge]...]] (paper mm, even-odd), cx, cy (model point shown at the window centre),
//           sc (scale 1:sc), um (paper... model unit in mm), lock, bd (border drawn), fz:[layer names frozen here] }
//   Layout { id, name, size, landscape, tb:{...}, entities:[...], view }  (paper is millimetres, origin lower left, Y up)
// A viewport maps model point m to paper point  C + (m - [cx,cy]) * um/sc  where C is the centre of the window's bounding box.

const CadVp = (() => {
  'use strict';
  const G = (typeof CadGeo !== 'undefined') ? CadGeo : require('./cadgeo.js');
  const CH = (typeof CadHatch !== 'undefined') ? CadHatch : require('./cadhatch.js');
  const UNIT_MM = { mm: 1, m: 1000, in: 25.4 };
  const SCALES = [1, 2, 5, 10, 20, 25, 50, 75, 100, 125, 150, 200, 250, 500, 750, 1000, 1250, 1500, 2000, 2500, 5000];
  const SHEETS = { A4: [210, 297], A3: [297, 420], A2: [420, 594], A1: [594, 841], A0: [841, 1189] };

  const polys = (e, tol) => CH.polysOf(e, tol || 0.05);
  function box(e) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const poly of polys(e)) for (const p of poly) { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; }
    return { minX: x0, minY: y0, maxX: x1, maxY: y1 };
  }
  const centre = (e) => { const b = box(e); return [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2]; };
  const factor = (e) => (e.um || 1) / (e.sc || 50);                         // paper mm per model unit
  const inside = (e, pt) => CH.inside(polys(e), pt);
  const modelToPaper = (e, m) => { const C = centre(e), s = factor(e); return [C[0] + (m[0] - e.cx) * s, C[1] + (m[1] - e.cy) * s]; };
  const paperToModel = (e, p) => { const C = centre(e), s = factor(e); return [e.cx + (p[0] - C[0]) / s, e.cy + (p[1] - C[1]) / s]; };
  // The view (centre of screen in model units, px per model unit) that draws this viewport's model through a paper view.
  function viewFor(e, pview) {
    const C = centre(e), s = factor(e);
    return { cx: e.cx - (C[0] - pview.cx) / s, cy: e.cy - (C[1] - pview.cy) / s, scale: pview.scale * s };
  }
  const shownIn = (e, layer) => !(e.fz && e.fz.indexOf(layer) >= 0);

  // Window as a rectangle (axis aligned, 4 plain vertices)?
  function rectOf(e) {
    const l = e.loops && e.loops.length === 1 ? e.loops[0] : null;
    if (!l || l.length !== 4 || l.some((q) => q[2])) return null;
    const x0 = l[0][0], y0 = l[0][1], x1 = l[2][0], y1 = l[2][1];
    const ok = Math.abs(l[1][0] - x1) < 1e-6 && Math.abs(l[1][1] - y0) < 1e-6 && Math.abs(l[3][0] - x0) < 1e-6 && Math.abs(l[3][1] - y1) < 1e-6;
    return ok ? { x0, y0, x1, y1 } : null;
  }
  const rectLoop = (a, b) => [[Math.min(a[0], b[0]), Math.min(a[1], b[1]), 0], [Math.max(a[0], b[0]), Math.min(a[1], b[1]), 0], [Math.max(a[0], b[0]), Math.max(a[1], b[1]), 0], [Math.min(a[0], b[0]), Math.max(a[1], b[1]), 0]];
  const circleLoop = (c, r) => [[c[0] + r, c[1], 1], [c[0] - r, c[1], 1]];
  // Corner grip of a rectangular window keeps it rectangular. Returns the new loop.
  function rectGrip(e, i, np) {
    const r = rectOf(e); if (!r) return null;
    const cs = [[r.x0, r.y0], [r.x1, r.y0], [r.x1, r.y1], [r.x0, r.y1]], opp = cs[(i + 2) % 4];
    return rectLoop(np, opp);
  }
  // After the window changes shape by stretching, keep the model where it was on paper.
  function holdContent(prev, next) {
    const a = centre(prev), b = centre(next), s = factor(prev);
    return { ...next, cx: next.cx + (b[0] - a[0]) / s, cy: next.cy + (b[1] - a[1]) / s };
  }
  // Scale and window that fits a model box into the window.
  function fit(e, mb, margin) {
    const b = box(e), m = margin || 0.95, um = e.um || 1;
    const w = Math.max(mb.maxX - mb.minX, 1e-9) * um, h = Math.max(mb.maxY - mb.minY, 1e-9) * um;
    const need = Math.max(w / ((b.maxX - b.minX) * m), h / ((b.maxY - b.minY) * m));
    const sc = SCALES.find((s) => s >= need) || Math.ceil(need);
    return { ...e, sc, cx: (mb.minX + mb.maxX) / 2, cy: (mb.minY + mb.maxY) / 2 };
  }
  const scaleText = (e) => '1:' + (Number.isInteger(e.sc) ? e.sc : +e.sc.toFixed(2));
  const fillTpl = (tpl, vp) => String(tpl || '').replace(/\{scale\}/gi, vp ? scaleText(vp) : '1:?');

  // ---- clipping (used by the plotter) ----
  // Pieces of segment a-b inside the even-odd region.
  function clipSeg(a, b, rings) {
    const ts = [0, 1], dx = b[0] - a[0], dy = b[1] - a[1];
    for (const r of rings) {
      for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
        const p = r[j], q = r[i], ex = q[0] - p[0], ey = q[1] - p[1], den = dx * ey - dy * ex;
        if (Math.abs(den) < 1e-12) continue;
        const t = ((p[0] - a[0]) * ey - (p[1] - a[1]) * ex) / den, u = ((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / den;
        if (t > 0 && t < 1 && u >= 0 && u <= 1) ts.push(t);
      }
    }
    ts.sort((x, y) => x - y);
    const out = [];
    for (let i = 0; i + 1 < ts.length; i++) {
      if (ts[i + 1] - ts[i] < 1e-9) continue;
      const tm = (ts[i] + ts[i + 1]) / 2;
      if (CH.inside(rings, [a[0] + dx * tm, a[1] + dy * tm])) {
        const p0 = [a[0] + dx * ts[i], a[1] + dy * ts[i]], p1 = [a[0] + dx * ts[i + 1], a[1] + dy * ts[i + 1]];
        const last = out[out.length - 1];
        if (last && Math.hypot(last[1][0] - p0[0], last[1][1] - p0[1]) < 1e-9) last[1] = p1; else out.push([p0, p1]);
      }
    }
    return out;
  }
  // Polyline pieces inside the region: returns arrays of points.
  function clipPoly(pts, closed, rings) {
    const out = []; let cur = null;
    const n = closed ? pts.length : pts.length - 1;
    for (let i = 0; i < n; i++) {
      for (const [p0, p1] of clipSeg(pts[i], pts[(i + 1) % pts.length], rings)) {
        if (cur && Math.hypot(cur[cur.length - 1][0] - p0[0], cur[cur.length - 1][1] - p0[1]) < 1e-9) cur.push(p1);
        else { cur = [p0, p1]; out.push(cur); }
      }
    }
    return out;
  }
  const isConvex = (poly) => {
    let s = 0;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length], c = poly[(i + 2) % poly.length], cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
      if (Math.abs(cr) < 1e-12) continue; if (!s) s = Math.sign(cr); else if (Math.sign(cr) !== s) return false;
    }
    return true;
  };
  // Sutherland-Hodgman: subject polygon clipped to a convex window.
  function clipRingConvex(subject, win) {
    const area = win.reduce((a, p, i) => { const q = win[(i + 1) % win.length]; return a + p[0] * q[1] - q[0] * p[1]; }, 0), sg = area >= 0 ? 1 : -1;
    let out = subject;
    for (let i = 0; i < win.length && out.length; i++) {
      const a = win[i], b = win[(i + 1) % win.length], inn = (p) => sg * ((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])) >= 0;
      const isect = (p, q) => { const x1 = p[0], y1 = p[1], x2 = q[0], y2 = q[1], x3 = a[0], y3 = a[1], x4 = b[0], y4 = b[1], den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4); const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / den; return [x1 + t * (x2 - x1), y1 + t * (y2 - y1)]; };
      const input = out; out = [];
      for (let k = 0; k < input.length; k++) {
        const cur = input[k], prev = input[(k + input.length - 1) % input.length];
        if (inn(cur)) { if (!inn(prev)) out.push(isect(prev, cur)); out.push(cur); } else if (inn(prev)) out.push(isect(prev, cur));
      }
    }
    return out;
  }

  return { UNIT_MM, SCALES, SHEETS, polys, box, centre, factor, inside, modelToPaper, paperToModel, viewFor, shownIn, rectOf, rectLoop, circleLoop, rectGrip, holdContent, fit, scaleText, fillTpl, clipSeg, clipPoly, isConvex, clipRingConvex };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = CadVp;
