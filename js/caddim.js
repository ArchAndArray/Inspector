// caddim.js — pure geometry for annotation entities: text boxes and linear / aligned dimensions.
// No DOM; testable in Node. Global `CadDim`.
//
//   TEXT   { t:'TEXT',  p:[x,y] baseline-left, h, rot (rad), text }
//   MTEXT  { t:'MTEXT', p:[x,y] top-left, h, rot, w (wrap width, 0 = none), text (\n separated) }
//   DIM    { t:'DIM', k:'lin'|'ali', p1, p2, off:[x,y] (a point on the dimension line), ang (rad, lin only),
//            th (text height), ar (arrow size), eo (extension offset), ee (extension past the dim line),
//            gap (text gap above the line), dec (decimals), txt (override, '<>' = measured value) }
// Style numbers are baked into each dimension in model units when it is created, so the geometry
// here needs no document. Text width is estimated (0.58 x height per character); the canvas draws
// the real glyphs, so selection boxes can differ from the glyphs by a few percent.

const CadDim = (() => {
  'use strict';
  const CW = 0.58, LH = 1.3;
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
  const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
  const mul = (a, k) => [a[0] * k, a[1] * k];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
  const len = (a) => Math.hypot(a[0], a[1]);
  const st = (e) => ({ th: e.th || 2.5, ar: e.ar || 2.5, eo: e.eo == null ? 1 : e.eo, ee: e.ee == null ? 1.25 : e.ee, gap: e.gap == null ? 0.6 : e.gap, dec: e.dec == null ? 0 : e.dec });

  // ---- text ----
  function mtextLines(e) {
    const out = [], maxChars = e.w > 0 ? Math.max(1, Math.floor(e.w / (CW * e.h))) : Infinity;
    for (const raw of String(e.text || '').split('\n')) {
      if (raw.length <= maxChars) { out.push(raw); continue; }
      let line = '';
      for (const word of raw.split(' ')) {
        if (line && (line + ' ' + word).length > maxChars) { out.push(line); line = word; } else line = line ? line + ' ' + word : word;
      }
      out.push(line);
    }
    return out;
  }
  // Corners of the (rotated) box around a text entity, counter-clockwise.
  function textCorners(e) {
    let x0, x1, y0, y1;
    if (e.t === 'TEXT') { x0 = 0; x1 = Math.max(CW * e.h * String(e.text || '').length, e.h * 0.4); y0 = -0.25 * e.h; y1 = e.h; }
    else {
      const lines = mtextLines(e), wMax = e.w > 0 ? e.w : Math.max(...lines.map((l) => l.length), 1) * CW * e.h;
      x0 = 0; x1 = Math.max(wMax, e.h * 0.4); y1 = 0; y0 = -(lines.length * LH * e.h);
    }
    const c = Math.cos(e.rot || 0), s = Math.sin(e.rot || 0);
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(([x, y]) => [e.p[0] + x * c - y * s, e.p[1] + x * s + y * c]);
  }

  // ---- dimensions ----
  function frame(e) {
    let u;
    if (e.k === 'ali') { const d = sub(e.p2, e.p1), l = len(d); u = l < 1e-12 ? [1, 0] : [d[0] / l, d[1] / l]; }
    else u = [Math.cos(e.ang || 0), Math.sin(e.ang || 0)];
    const n = [-u[1], u[0]];
    const s1 = dot(sub(e.off, e.p1), n), s2 = dot(sub(e.off, e.p2), n);
    const A = add(e.p1, mul(n, s1)), B = add(e.p2, mul(n, s2));
    return { u, n, s1, s2, A, B };
  }
  const measure = (e) => Math.abs(dot(sub(e.p2, e.p1), frame(e).u));
  function dimText(e) {
    const s = st(e), val = measure(e).toFixed(s.dec);
    if (e.txt && String(e.txt).trim()) return String(e.txt).indexOf('<>') >= 0 ? String(e.txt).replace('<>', val) : String(e.txt);
    return val;
  }
  function geom(e) {
    const s = st(e), f = frame(e), lines = [], arrows = [];
    const L = len(sub(f.B, f.A));
    const dir = L < 1e-12 ? f.u : mul(sub(f.B, f.A), 1 / L);
    const ext = (p, A, sd) => {
      if (Math.abs(sd) <= s.eo + 1e-9) return;
      const sg = sd >= 0 ? 1 : -1;
      lines.push([add(p, mul(f.n, sg * s.eo)), add(A, mul(f.n, sg * s.ee))]);
    };
    ext(e.p1, f.A, f.s1); ext(e.p2, f.B, f.s2);
    const outside = L < 2.5 * s.ar;
    if (!outside) {
      lines.push([f.A, f.B]);
      arrows.push({ tip: f.A, dir, size: s.ar }, { tip: f.B, dir: mul(dir, -1), size: s.ar });
    } else {
      lines.push([add(f.A, mul(dir, -1.8 * s.ar)), add(f.B, mul(dir, 1.8 * s.ar))]);
      arrows.push({ tip: f.A, dir: mul(dir, -1), size: s.ar }, { tip: f.B, dir, size: s.ar });
    }
    let rot = Math.atan2(f.u[1], f.u[0]);
    if (rot > Math.PI / 2 + 1e-9) rot -= Math.PI; else if (rot <= -Math.PI / 2 + 1e-9) rot += Math.PI;
    const up = [-Math.sin(rot), Math.cos(rot)], m = mul(add(f.A, f.B), 0.5);
    return { lines, arrows, text: { p: add(m, mul(up, s.gap)), rot, h: s.th, str: dimText(e) } };
  }
  // Box around the dimension text (centre-bottom anchored at text.p), counter-clockwise corners.
  function textBoxOf(e) {
    const g = geom(e).text, w = Math.max(CW * g.h * g.str.length, g.h * 0.4), c = Math.cos(g.rot), s = Math.sin(g.rot);
    return [[-w / 2, -0.15 * g.h], [w / 2, -0.15 * g.h], [w / 2, 1.1 * g.h], [-w / 2, 1.1 * g.h]].map(([x, y]) => [g.p[0] + x * c - y * s, g.p[1] + x * s + y * c]);
  }
  return { CW, LH, mtextLines, textCorners, frame, measure, dimText, geom, textBoxOf };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = CadDim;
