// ink.js — pen engine for the Sketch / Annotator tool. Strokes are kept as small editable objects (not pixels) so they
// can be undone and redone one at a time, replayed after a rotate or crop, saved and reloaded. No DOM; the drawing
// functions only need a Canvas 2D context, so the geometry is testable in Node. Global `Ink`.
//
//   Stroke { id, k, c (colour), w (nominal width, canvas px), pts:[[x,y,p],...] (p = pressure 0..1),
//            k: 'pen' | 'smooth' (pen with extra stabiliser) | 'air' (airbrush) | 'nib' (fountain) | 'erase' | 'hl' (highlighter)
//               | 'line' | 'arc' | 'arrow' | 'ellipse' | 'rect' (two points = opposite corners) | 'num' (numbered marker, n = the number),
//            dash:[px...], nib:{avg,max}, seed, ctl:[x,y] (arc control point) }
//
// Drawing is deterministic: the pieces drawn while the pen is moving are exactly the pieces drawn when the whole stroke is
// replayed, so undo, redo, rotate and reload never change how a stroke looks.

const Ink = (() => {
  'use strict';
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  function mulberry32(a) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  const hexRgb = (hex) => { const m = /^#([0-9a-f]{6})$/i.exec(hex || ''); if (!m) return [28, 31, 38]; const n = parseInt(m[1], 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  let uidN = 0;
  const uid = () => 's' + Date.now().toString(36) + (uidN++).toString(36);

  // ---- pressure ----
  const CURVES = { soft: 0.7, normal: 1, firm: 1.6 };
  const pressureCurve = (p, curve) => Math.pow(clamp(p, 0, 1), CURVES[curve] || 1);

  // ---- input filter: stabiliser (streamline), minimum spacing, pressure smoothing, speed-based pressure for finger and mouse ----
  // streamline 0..1 (0 = follow the pen exactly). Returns the accepted points for each raw sample.
  function makeFilter(o) {
    const opt = Object.assign({ streamline: 0.3, minDist: 0.7, curve: 'normal', hasPressure: true, pressureSmooth: 0.5 }, o || {});
    let last = null, sp = 0.5, lastRaw = null, lastT = 0, speedP = 0.55;
    const follow = () => 1 - clamp(opt.streamline, 0, 0.95) * 0.88;
    function pressureOf(p, x, y, t) {
      if (opt.hasPressure && p > 0) return pressureCurve(p, opt.curve);
      // no pressure on this pointer: slower = a little thicker, faster = a little thinner
      let sp2 = 0.55;
      if (lastRaw && t > lastT) { const v = Math.hypot(x - lastRaw[0], y - lastRaw[1]) / (t - lastT); sp2 = clamp(0.7 - v * 0.12, 0.38, 0.7); }
      speedP += (sp2 - speedP) * 0.2; return speedP;
    }
    return {
      begin(x, y, p, t) {
        lastRaw = [x, y]; lastT = t || 0; sp = pressureOf(p, x, y, t || 0); last = [x, y, sp]; return [last];
      },
      add(x, y, p, t) {
        const tt = t || (lastT + 8), pr = pressureOf(p, x, y, tt);
        lastRaw = [x, y]; lastT = tt;
        sp += (pr - sp) * (1 - clamp(opt.pressureSmooth, 0, 0.95) * 0.8);
        const f = follow(), nx = last[0] + (x - last[0]) * f, ny = last[1] + (y - last[1]) * f;
        if (Math.hypot(nx - last[0], ny - last[1]) < opt.minDist) return [];
        last = [nx, ny, sp]; return [last];
      },
      // catch the stabiliser up to where the pen actually lifted
      end(x, y) {
        const out = [];
        if (!last) return out;
        let guard = 0;
        while (Math.hypot(x - last[0], y - last[1]) > opt.minDist && guard++ < 24) {
          const f = Math.max(follow(), 0.5);
          last = [last[0] + (x - last[0]) * f, last[1] + (y - last[1]) * f, sp]; out.push(last);
        }
        if (Math.hypot(x - last[0], y - last[1]) > 0.01) { last = [x, y, sp]; out.push(last); }
        return out;
      }
    };
  }

  // ---- stroke construction ----
  function newStroke(kind, o) {
    return Object.assign({ id: uid(), k: kind, c: '#000000', w: 4, pts: [], dash: [], seed: (Math.random() * 1e9) | 0 }, o || {});
  }

  // ---- drawing ----
  function widthFor(s, p, ang) {
    if (s.k === 'erase') return s.w * 3;
    if (s.k === 'nib') { const n = s.nib || { avg: s.w, max: s.w * 2.5 }; return (n.avg + (n.max - n.avg) * Math.abs(Math.sin(ang - Math.PI / 4))) * (0.75 + 0.5 * p); }
    if (s.k === 'air') return s.w * (0.5 + p);
    return s.w * (0.4 + 1.2 * p);
  }
  function setup(ctx, s) {
    ctx.globalCompositeOperation = s.k === 'erase' ? 'destination-out' : 'source-over';
    ctx.strokeStyle = s.c; ctx.fillStyle = s.c; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.setLineDash([]); ctx.lineDashOffset = 0;
  }
  function airDabs(ctx, s, a, b, i, w) {
    const rgb = hexRgb(s.c), dist = Math.hypot(b[0] - a[0], b[1] - a[1]), steps = Math.max(1, Math.round(dist / 3)), radius = Math.max(4, w), rnd = mulberry32((s.seed + i * 7919) | 0);
    for (let k = 0; k <= steps; k++) {
      const t = k / steps, cx = a[0] + (b[0] - a[0]) * t + (rnd() - 0.5) * radius * 0.6, cy = a[1] + (b[1] - a[1]) * t + (rnd() - 0.5) * radius * 0.6;
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
      g.addColorStop(0, 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',0.22)'); g.addColorStop(1, 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, radius, 0, Math.PI * 2); ctx.fill();
    }
  }
  // Piece i of a freehand stroke (0 <= i <= n-2 are the curved pieces, i = n-1 is the closing piece).
  function drawPiece(ctx, s, i) {
    const P = s.pts, n = P.length;
    let a, b, c = null;
    if (i === 0) { a = P[0]; b = n > 1 ? mid(P[0], P[1]) : P[0]; }
    else if (i < n - 1) { a = mid(P[i - 1], P[i]); b = mid(P[i], P[i + 1]); c = P[i]; }
    else { a = n > 1 ? mid(P[n - 2], P[n - 1]) : P[0]; b = P[n - 1]; }
    const p = i === 0 ? P[0][2] : (P[Math.min(i, n - 1)][2] + P[Math.max(0, i - 1)][2]) / 2, ang = Math.atan2(b[1] - a[1], b[0] - a[0]), w = widthFor(s, p == null ? 0.5 : p, ang);
    if (s.k === 'air') { airDabs(ctx, s, a, b, i, w); return; }
    ctx.lineWidth = w; ctx.beginPath(); ctx.moveTo(a[0], a[1]);
    if (c) ctx.quadraticCurveTo(c[0], c[1], b[0], b[1]); else ctx.lineTo(b[0], b[1]);
    ctx.stroke();
  }
  function drawDot(ctx, s) {
    const p = s.pts[0], w = widthFor(s, p[2] == null ? 0.5 : p[2], 0);
    if (s.k === 'air') { airDabs(ctx, s, p, p, 0, w); return; }
    ctx.beginPath(); ctx.arc(p[0], p[1], w / 2, 0, Math.PI * 2); ctx.fill();
  }
  const SHAPES = { line: 1, arc: 1, arrow: 1, ellipse: 1, rect: 1, num: 1, flood: 1 };
  const isFree = (s) => !SHAPES[s.k] && s.k !== 'hl';
  const HL_ALPHA = 0.35, HL_SCALE = 3.5;
  const markerRadius = (s) => Math.max(s.w * 2.4, 13);
  const isLight = (hex) => { const c = hexRgb(hex); return (c[0] * 299 + c[1] * 587 + c[2] * 114) / 1000 > 170; };
  const FILL_ALPHA = 0.4, FLOOD_ALPHA = 0.5;
  // Rectangle and ellipse: two stored points are opposite corners in the shape's own (unrotated) frame; rot turns it about its centre.
  function boxFrame(s) {
    const a = s.pts[0], b = s.pts[1] || s.pts[0];
    return { cx: (a[0] + b[0]) / 2, cy: (a[1] + b[1]) / 2, hw: Math.abs(b[0] - a[0]) / 2, hh: Math.abs(b[1] - a[1]) / 2, rot: s.rot || 0 };
  }
  function drawShape(ctx, s) {
    const a = s.pts[0], b = s.pts[1] || s.pts[0];
    ctx.lineWidth = s.w; ctx.setLineDash(s.dash || []);
    if (s.k === 'line' || s.k === 'arc') {
      ctx.beginPath(); ctx.moveTo(a[0], a[1]);
      if (s.k === 'arc') ctx.quadraticCurveTo(s.ctl[0], s.ctl[1], b[0], b[1]); else ctx.lineTo(b[0], b[1]);
      ctx.stroke();
    } else if (s.k === 'arrow') {
      const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1, ux = dx / len, uy = dy / len;
      const head = Math.min(len * 0.9, s.hd || (s.w * 4 + 10)), half = head * 0.42;
      const bx = b[0] - ux * head * 0.8, by = b[1] - uy * head * 0.8;
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(bx, by); ctx.stroke();
      ctx.setLineDash([]); ctx.beginPath(); ctx.moveTo(b[0], b[1]);
      ctx.lineTo(b[0] - ux * head - uy * half, b[1] - uy * head + ux * half); ctx.lineTo(b[0] - ux * head + uy * half, b[1] - uy * head - ux * half);
      ctx.closePath(); ctx.fill(); ctx.lineWidth = Math.max(1, s.w * 0.5); ctx.stroke();
    } else if (s.k === 'ellipse' || s.k === 'rect') {
      const f = boxFrame(s);
      ctx.save(); ctx.translate(f.cx, f.cy); ctx.rotate(f.rot);
      ctx.beginPath();
      if (s.k === 'ellipse') ctx.ellipse(0, 0, Math.max(1, f.hw), Math.max(1, f.hh), 0, 0, Math.PI * 2); else { ctx.lineJoin = 'miter'; ctx.rect(-f.hw, -f.hh, f.hw * 2, f.hh * 2); }
      if (s.fill) { const ga = ctx.globalAlpha; ctx.globalAlpha = ga * FILL_ALPHA; ctx.fillStyle = s.fill; ctx.fill(); ctx.globalAlpha = ga; }
      ctx.stroke(); ctx.restore();
    } else if (s.k === 'flood') {
      // bucket fill: the filled area is kept as a list of small rectangles [x, y, w, h] (so it moves, rotates and crops like any stroke)
      const ga = ctx.globalAlpha; ctx.globalAlpha = ga * FLOOD_ALPHA; ctx.setLineDash([]);
      ctx.beginPath(); for (const q of s.rects || []) ctx.rect(q[0], q[1], q[2], q[3]); ctx.fill(); ctx.globalAlpha = ga;
    } else if (s.k === 'num') {
      const r = markerRadius(s);
      ctx.setLineDash([]); ctx.beginPath(); ctx.arc(a[0], a[1], r, 0, Math.PI * 2); ctx.fill();
      ctx.lineWidth = Math.max(2, r * 0.14); ctx.strokeStyle = isLight(s.c) ? '#1c1f26' : '#ffffff'; ctx.stroke();
      const t = String(s.n == null ? 1 : s.n);
      ctx.fillStyle = isLight(s.c) ? '#1c1f26' : '#ffffff'; ctx.font = '700 ' + Math.round(r * (t.length > 2 ? 0.85 : t.length > 1 ? 1.05 : 1.25)) + 'px sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(t, a[0], a[1] + r * 0.06);
    }
  }
  // Highlighter: the whole stroke is one translucent path, so overlaps inside a single stroke do not darken.
  function drawHighlighter(ctx, s) {
    const P = s.pts, n = P.length;
    ctx.globalAlpha = HL_ALPHA; ctx.lineWidth = s.w * HL_SCALE; ctx.lineCap = 'butt'; ctx.lineJoin = 'round';
    if (n === 1) { ctx.beginPath(); ctx.arc(P[0][0], P[0][1], s.w * HL_SCALE / 2, 0, Math.PI * 2); ctx.fill(); return; }
    ctx.beginPath(); ctx.moveTo(P[0][0], P[0][1]);
    if (n === 2) ctx.lineTo(P[1][0], P[1][1]);
    else { const m0 = mid(P[0], P[1]); ctx.lineTo(m0[0], m0[1]); for (let i = 1; i < n - 1; i++) { const m = mid(P[i], P[i + 1]); ctx.quadraticCurveTo(P[i][0], P[i][1], m[0], m[1]); } ctx.lineTo(P[n - 1][0], P[n - 1][1]); }
    ctx.stroke();
  }

  // Whole stroke in one go (replay).
  function renderStroke(ctx, s) {
    if (!s.pts.length) return;
    ctx.save(); setup(ctx, s);
    if (SHAPES[s.k]) drawShape(ctx, s);
    else if (s.k === 'hl') drawHighlighter(ctx, s);
    else if (s.pts.length === 1) drawDot(ctx, s);
    else for (let i = 0; i < s.pts.length; i++) drawPiece(ctx, s, i);
    ctx.restore();
  }
  function renderAll(ctx, strokes) { for (const s of strokes) renderStroke(ctx, s); }

  // Live drawing while the pen moves: liveAdvance draws every piece that now has enough points, liveFinish draws the last.
  const liveStart = (s) => ({ s, next: 0 });
  function liveAdvance(ctx, L) {
    const s = L.s, n = s.pts.length;
    if (!isFree(s) || n < 2) return;
    ctx.save(); setup(ctx, s);
    while (L.next <= n - 2) { drawPiece(ctx, s, L.next); L.next++; }
    ctx.restore();
  }
  function liveFinish(ctx, L) {
    const s = L.s, n = s.pts.length;
    if (!isFree(s) || !n) return;
    ctx.save(); setup(ctx, s);
    if (n === 1) drawDot(ctx, s);
    else { while (L.next <= n - 2) { drawPiece(ctx, s, L.next); L.next++; } drawPiece(ctx, s, n - 1); }
    ctx.restore();
  }
  // A dot under the pen as soon as it touches down, so the first touch gives instant feedback.
  function liveDot(ctx, L) { const s = L.s; if (!s.pts.length) return; ctx.save(); setup(ctx, s); drawDot(ctx, s); ctx.restore(); }

  // ---- geometry helpers ----
  function boxCorners(s) {
    const f = boxFrame(s), c = Math.cos(f.rot), n = Math.sin(f.rot);
    return [[-f.hw, -f.hh], [f.hw, -f.hh], [f.hw, f.hh], [-f.hw, f.hh]].map((q) => [f.cx + q[0] * c - q[1] * n, f.cy + q[0] * n + q[1] * c]);
  }
  function bbox(s) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    if (s.k === 'flood' && s.rects && s.rects.length) { for (const q of s.rects) { if (q[0] < x0) x0 = q[0]; if (q[1] < y0) y0 = q[1]; if (q[0] + q[2] > x1) x1 = q[0] + q[2]; if (q[1] + q[3] > y1) y1 = q[1] + q[3]; } return { x0, y0, x1, y1 }; }
    const pts = (s.k === 'rect' || s.k === 'ellipse') && s.rot ? boxCorners(s) : s.k === 'arc' ? s.pts.concat([s.ctl]) : s.pts;
    for (const p of pts) { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; }
    const r = s.k === 'erase' ? s.w * 1.5 : s.k === 'hl' ? s.w * HL_SCALE / 2 : s.k === 'num' ? markerRadius(s) : s.k === 'arrow' ? (s.hd || (s.w * 4 + 10)) : s.w;
    return { x0: x0 - r, y0: y0 - r, x1: x1 + r, y1: y1 + r };
  }
  function distToSeg(px, py, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
    const t = l2 ? clamp(((px - a[0]) * dx + (py - a[1]) * dy) / l2, 0, 1) : 0;
    return Math.hypot(px - (a[0] + dx * t), py - (a[1] + dy * t));
  }
  // Is a point within r of the stroke's centre line?
  function hit(s, x, y, r) {
    const b = bbox(s); if (x < b.x0 - r || x > b.x1 + r || y < b.y0 - r || y > b.y1 + r) return false;
    if (s.k === 'flood') { for (const q of s.rects || []) if (x >= q[0] - r && x <= q[0] + q[2] + r && y >= q[1] - r && y <= q[1] + q[3] + r) return true; return false; }
    if (s.k === 'rect' || s.k === 'ellipse') {
      const f = boxFrame(s), c = Math.cos(-f.rot), n = Math.sin(-f.rot), dx = x - f.cx, dy = y - f.cy, u = dx * c - dy * n, v = dx * n + dy * c, t = r + s.w / 2;
      if (s.k === 'rect') {
        if (s.fill && Math.abs(u) <= f.hw && Math.abs(v) <= f.hh) return true;
        const ox = Math.abs(u) - f.hw, oy = Math.abs(v) - f.hh;
        return Math.max(ox, oy) <= t && (ox >= -t || oy >= -t);
      }
      const rx = Math.max(1, f.hw), ry = Math.max(1, f.hh), q = Math.hypot(u / rx, v / ry);
      if (s.fill && q <= 1) return true;
      // distance to the ellipse outline, estimated along the radial direction
      const len = Math.hypot(u, v) || 1e-6, outline = q > 0 ? len / q : Math.min(rx, ry);
      return Math.abs(len - outline) <= t;
    }
    if (s.k === 'arc') {
      let prev = s.pts[0];
      for (let i = 1; i <= 24; i++) {
        const t = i / 24, u = 1 - t, q = [u * u * s.pts[0][0] + 2 * u * t * s.ctl[0] + t * t * s.pts[1][0], u * u * s.pts[0][1] + 2 * u * t * s.ctl[1] + t * t * s.pts[1][1]];
        if (distToSeg(x, y, prev, q) <= r + s.w / 2) return true; prev = q;
      }
      return false;
    }
    const hw = s.k === 'hl' ? s.w * HL_SCALE / 2 : s.w / 2;
    if (s.k === 'num') return Math.hypot(x - s.pts[0][0], y - s.pts[0][1]) <= markerRadius(s) + r;
    if (s.pts.length === 1) return Math.hypot(x - s.pts[0][0], y - s.pts[0][1]) <= r + hw;
    for (let i = 1; i < s.pts.length; i++) if (distToSeg(x, y, s.pts[i - 1], s.pts[i]) <= r + hw) return true;
    return false;
  }
  // New stroke with every point moved by f([x,y]) -> [x,y]; widths and dashes scaled by k.
  function mapStroke(s, f, k) {
    const kk = k || 1, m = (p) => { const q = f(p); return p.length > 2 ? [q[0], q[1], p[2]] : q; };
    const rects = s.rects ? s.rects.map((q) => { const a = f([q[0], q[1]]), b = f([q[0] + q[2], q[1] + q[3]]); return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])]; }) : s.rects;
    return Object.assign({}, s, { rects, pts: s.pts.map(m), w: s.w * kk, dash: (s.dash || []).map((d) => d * kk), hd: s.hd ? s.hd * kk : s.hd, ctl: s.ctl ? f(s.ctl) : s.ctl, nib: s.nib ? { avg: s.nib.avg * kk, max: s.nib.max * kk } : s.nib });
  }
  const rotate90cw = (strokes, ch) => strokes.map((s) => {
    const m = mapStroke(s, (p) => [ch - p[1], p[0]], 1);
    if ((s.k === 'rect' || s.k === 'ellipse') && s.rot) {
      // keep the shape's own frame: new centre, swapped half-sizes, turned a further quarter
      const f = boxFrame(s), c = [ch - f.cy, f.cx];
      m.pts = [[c[0] - f.hh, c[1] - f.hw], [c[0] + f.hh, c[1] + f.hw]]; m.rot = f.rot + Math.PI / 2;
    }
    return m;
  });
  const cropStrokes = (strokes, x, y, k) => strokes.map((s) => mapStroke(s, (p) => [(p[0] - x) * k, (p[1] - y) * k], k));
  // Hold-to-straighten: the stroke becomes a straight line from where it started to where it ended, snapping to 0/45/90 within a few degrees.
  function straighten(s, snapDeg) {
    const a = s.pts[0], b = s.pts[s.pts.length - 1];
    let bx = b[0], by = b[1];
    const ang = Math.atan2(by - a[1], bx - a[0]) * 180 / Math.PI, len = Math.hypot(bx - a[0], by - a[1]), tol = snapDeg == null ? 3 : snapDeg;
    for (let t = -180; t <= 180; t += 45) if (Math.abs(ang - t) <= tol) { bx = a[0] + len * Math.cos(t * Math.PI / 180); by = a[1] + len * Math.sin(t * Math.PI / 180); break; }
    return Object.assign({}, s, { k: s.k === 'erase' ? 'erase' : s.k === 'hl' ? 'hl' : 'line', pts: [[a[0], a[1]], [bx, by]], dash: [] });
  }


  // ---- editing: move, handles ----
  const moveStroke = (s, dx, dy) => mapStroke(s, (p) => [p[0] + dx, p[1] + dy], 1);
  function pointsBox(s) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of (s.k === 'arc' ? s.pts.concat([s.ctl]) : s.pts)) { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; }
    return { x0, y0, x1, y1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
  }
  const isBox = (s) => s.k === 'rect' || s.k === 'ellipse';
  const isEnds = (s) => s.k === 'line' || s.k === 'arrow' || s.k === 'arc';
  // Grab points for a stroke, canvas coordinates. `off` = how far the turn handle sits beyond the top edge.
  function handles(s, off) {
    off = off || 40;
    if (s.k === 'num' || s.k === 'flood') return [];
    if (isEnds(s)) { const h = [{ id: 'p0', x: s.pts[0][0], y: s.pts[0][1] }, { id: 'p1', x: s.pts[1][0], y: s.pts[1][1] }]; if (s.k === 'arc') h.push({ id: 'ctl', x: s.ctl[0], y: s.ctl[1] }); return h; }
    let corners, topMid, c;
    if (isBox(s)) {
      corners = boxCorners(s); topMid = [(corners[0][0] + corners[1][0]) / 2, (corners[0][1] + corners[1][1]) / 2]; const f = boxFrame(s); c = [f.cx, f.cy];
      const dx = topMid[0] - c[0], dy = topMid[1] - c[1], l = Math.hypot(dx, dy) || 1;
      return corners.map((q, i) => ({ id: 'c' + i, x: q[0], y: q[1] })).concat([{ id: 'rot', x: topMid[0] + dx / l * off, y: topMid[1] + dy / l * off }]);
    }
    const b = pointsBox(s);
    return [{ id: 'c0', x: b.x0, y: b.y0 }, { id: 'c1', x: b.x1, y: b.y0 }, { id: 'c2', x: b.x1, y: b.y1 }, { id: 'c3', x: b.x0, y: b.y1 }, { id: 'rot', x: b.cx, y: b.y0 - off }];
  }
  // New stroke after dragging handle `id` to (x,y). Always computed from the stroke as it was when the drag began (s0), grabbed at (sx,sy).
  function dragHandle(s0, id, x, y, sx, sy, snapDeg) {
    const snapA = (a) => { if (!snapDeg) return a; const st = snapDeg * Math.PI / 180, r = Math.round(a / st) * st; return Math.abs(r - a) <= 3 * Math.PI / 180 ? r : a; };
    if (id === 'p0' || id === 'p1') { const i = id === 'p0' ? 0 : 1; return Object.assign({}, s0, { pts: s0.pts.map((p, j) => (j === i ? [x, y] : p.slice())) }); }
    if (id === 'ctl') return Object.assign({}, s0, { ctl: [x, y], pts: s0.pts.map((p) => p.slice()) });
    if (id === 'rot') {
      const c = isBox(s0) ? [boxFrame(s0).cx, boxFrame(s0).cy] : (() => { const b = pointsBox(s0); return [b.cx, b.cy]; })();
      let da = Math.atan2(y - c[1], x - c[0]) - Math.atan2(sy - c[1], sx - c[0]);
      if (isBox(s0)) { const r = snapA((s0.rot || 0) + da); return Object.assign({}, s0, { rot: r, pts: s0.pts.map((p) => p.slice()) }); }
      const co = Math.cos(da), si = Math.sin(da);
      return mapStroke(s0, (p) => [c[0] + (p[0] - c[0]) * co - (p[1] - c[1]) * si, c[1] + (p[0] - c[0]) * si + (p[1] - c[1]) * co], 1);
    }
    const i = +id.slice(1);
    if (isBox(s0)) {
      const cs = boxCorners(s0), opp = cs[(i + 2) % 4], f = boxFrame(s0), co = Math.cos(-f.rot), si = Math.sin(-f.rot);
      const dx = x - opp[0], dy = y - opp[1], u = dx * co - dy * si, v = dx * si + dy * co, cx = (x + opp[0]) / 2, cy = (y + opp[1]) / 2, hw = Math.abs(u) / 2, hh = Math.abs(v) / 2;
      return Object.assign({}, s0, { pts: [[cx - hw, cy - hh], [cx + hw, cy + hh]] });
    }
    const b = pointsBox(s0), corners = [[b.x0, b.y0], [b.x1, b.y0], [b.x1, b.y1], [b.x0, b.y1]], cr = corners[i], op = corners[(i + 2) % 4];
    const vx = cr[0] - op[0], vy = cr[1] - op[1], l2 = vx * vx + vy * vy || 1;
    const k = Math.max(0.05, ((x - op[0]) * vx + (y - op[1]) * vy) / l2);
    return mapStroke(s0, (p) => [op[0] + (p[0] - op[0]) * k, op[1] + (p[1] - op[1]) * k], 1);
  }

  // Thicken a line mask by r pixels each way, so small gaps in a hand-drawn outline do not let the fill leak out.
  function dilate(mask, w, h, r) {
    const a = new Uint8Array(w * h), b = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) { let last = -1e9; for (let x = 0; x < w; x++) { if (mask[y * w + x]) last = x; if (x - last <= r) a[y * w + x] = 1; } last = 1e9; for (let x = w - 1; x >= 0; x--) { if (mask[y * w + x]) last = x; if (last - x <= r) a[y * w + x] = 1; } }
    for (let x = 0; x < w; x++) { let last = -1e9; for (let y = 0; y < h; y++) { if (a[y * w + x]) last = y; if (y - last <= r) b[y * w + x] = 1; } last = 1e9; for (let y = h - 1; y >= 0; y--) { if (a[y * w + x]) last = y; if (last - y <= r) b[y * w + x] = 1; } }
    return b;
  }

  // ---- bucket fill: flood a mask (1 = line / barrier) from (sx, sy); returns the area as merged rectangles in canvas units ----
  // mask is w*h at reduced size; f = canvas px per mask px; grow = extra mask px added around the area so the fill tucks under the outline.
  function floodRects(mask, w, h, sx, sy, f, grow) {
    if (sx < 0 || sy < 0 || sx >= w || sy >= h || mask[sy * w + sx]) return null;
    const seen = new Uint8Array(w * h), stack = [sx, sy], runs = [];
    let area = 0, edge = false;
    while (stack.length) {
      const y = stack.pop(), x = stack.pop(), row = y * w;
      if (seen[row + x] || mask[row + x]) continue;
      let x0 = x, x1 = x;
      while (x0 > 0 && !mask[row + x0 - 1] && !seen[row + x0 - 1]) x0--;
      while (x1 < w - 1 && !mask[row + x1 + 1] && !seen[row + x1 + 1]) x1++;
      for (let i = x0; i <= x1; i++) seen[row + i] = 1;
      runs.push([y, x0, x1]); area += x1 - x0 + 1;
      if (x0 === 0 || x1 === w - 1 || y === 0 || y === h - 1) edge = true;
      for (const yy of [y - 1, y + 1]) {
        if (yy < 0 || yy >= h) continue;
        let inRun = false;
        for (let i = x0; i <= x1; i++) {
          const free = !mask[yy * w + i] && !seen[yy * w + i];
          if (free && !inRun) { stack.push(i, yy); inRun = true; } else if (!free) inRun = false;
        }
      }
    }
    runs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const open = new Map(), done = [];
    let lastY = -2;
    for (const [y, x0, x1] of runs) {
      if (y !== lastY) { for (const [k, r] of open) if (r.y + r.h < y) { done.push(r); open.delete(k); } lastY = y; }
      const key = x0 + ',' + x1, r = open.get(key);
      if (r && r.y + r.h === y) r.h++; else { if (r) done.push(r); open.set(key, { x0, x1, y, h: 1 }); }
    }
    for (const r of open.values()) done.push(r);
    const g = grow || 0;
    return { area, edge, rects: done.map((r) => [(r.x0 - g) * f, (r.y - g) * f, (r.x1 - r.x0 + 1 + 2 * g) * f, (r.h + 2 * g) * f]) };
  }

  // ---- history: strokes in drawing order, with redo ----
  // Operations, not just strokes: adding, deleting and editing (move, resize, recolour...) can all be undone and redone.
  function makeHistory(initial) {
    // strokes loaded from a saved sketch are history too, so they can still be undone one by one
    const h = { strokes: initial ? initial.slice() : [], ops: (initial || []).map((s) => ({ t: 'add', s })), redo: [] };
    const idx = (id) => h.strokes.findIndex((x) => x.id === id);
    const apply = (o) => {
      if (o.t === 'add') h.strokes.push(o.s);
      else if (o.t === 'del') { const i = idx(o.s.id); if (i >= 0) h.strokes.splice(i, 1); }
      else if (o.t === 'set') { const i = idx(o.a.id); if (i >= 0) h.strokes[i] = o.b; }
      else if (o.t === 'multi') o.list.forEach(apply);
    };
    const revert = (o) => {
      if (o.t === 'add') { const i = idx(o.s.id); if (i >= 0) h.strokes.splice(i, 1); }
      else if (o.t === 'del') h.strokes.splice(Math.min(o.i, h.strokes.length), 0, o.s);
      else if (o.t === 'set') { const i = idx(o.b.id); if (i >= 0) h.strokes[i] = o.a; }
      else if (o.t === 'multi') o.list.slice().reverse().forEach(revert);
    };
    const subject = (o) => (o.t === 'add' ? o.s : o.t === 'del' ? o.s : o.t === 'set' ? o.b : null);
    const mapOp = (o, f) => (o.t === 'add' || o.t === 'del' ? Object.assign({}, o, { s: f(o.s) }) : o.t === 'set' ? Object.assign({}, o, { a: f(o.a), b: f(o.b) }) : Object.assign({}, o, { list: o.list.map((q) => mapOp(q, f)) }));
    return {
      get strokes() { return h.strokes; },
      get redoCount() { return h.redo.length; },
      get opCount() { return h.ops.length; },
      add(s) { h.strokes.push(s); h.ops.push({ t: 'add', s }); h.redo.length = 0; return s; },
      // replace stroke `a` by `b` (same id) as one undoable step
      set(a, b) { const i = idx(a.id); if (i < 0) return null; h.strokes[i] = b; h.ops.push({ t: 'set', a, b }); h.redo.length = 0; return b; },
      del(id) { const i = idx(id); if (i < 0) return null; const s = h.strokes.splice(i, 1)[0]; h.ops.push({ t: 'del', s, i }); h.redo.length = 0; return s; },
      // several changes that undo together; list of {t:'add',s}|{t:'del',id}|{t:'set',a,b}
      batch(list) {
        const done = [];
        for (const q of list) {
          if (q.t === 'add') { h.strokes.push(q.s); done.push({ t: 'add', s: q.s }); }
          else if (q.t === 'del') { const i = idx(q.id); if (i >= 0) { done.push({ t: 'del', s: h.strokes.splice(i, 1)[0], i }); } }
          else if (q.t === 'set') { const i = idx(q.a.id); if (i >= 0) { h.strokes[i] = q.b; done.push({ t: 'set', a: q.a, b: q.b }); } }
        }
        if (done.length) { h.ops.push({ t: 'multi', list: done }); h.redo.length = 0; }
        return done.length;
      },
      undo() { const o = h.ops.pop(); if (!o) return null; revert(o); h.redo.push(o); return subject(o) || true; },
      redo() { const o = h.redo.pop(); if (!o) return null; apply(o); h.ops.push(o); return subject(o) || true; },
      replaceAll(list) { h.strokes = list.slice(); h.ops = []; h.redo.length = 0; },
      mapAll(f) { h.strokes = h.strokes.map(f); h.ops = h.ops.map((o) => mapOp(o, f)); h.redo = h.redo.map((o) => mapOp(o, f)); },
      dropLast() { const o = h.ops[h.ops.length - 1]; if (!o) return null; h.ops.pop(); revert(o); return subject(o) || true; }
    };
  }

  // ---- saving: compact JSON ----
  const r1 = (v) => Math.round(v * 10) / 10, r2 = (v) => Math.round(v * 100) / 100;
  function pack(strokes) {
    return strokes.map((s) => ({ id: s.id, k: s.k, c: s.c, w: r2(s.w), seed: s.seed, n: s.n, hd: s.hd, rot: s.rot, fill: s.fill, ly: s.ly, rects: s.rects ? s.rects.map((q) => q.map(r1)) : undefined, dash: (s.dash || []).map(r1), nib: s.nib, ctl: s.ctl ? [r1(s.ctl[0]), r1(s.ctl[1])] : undefined, pts: s.pts.map((p) => (p.length > 2 ? [r1(p[0]), r1(p[1]), r2(p[2])] : [r1(p[0]), r1(p[1])])) }));
  }
  function unpack(list) {
    return (Array.isArray(list) ? list : []).filter((s) => s && Array.isArray(s.pts) && s.pts.length).map((s) => newStroke(s.k || 'pen', { id: s.id || uid(), c: s.c || '#000000', w: s.w || 4, seed: s.seed || 1, dash: s.dash || [], nib: s.nib, ctl: s.ctl, n: s.n, hd: s.hd, rot: s.rot, fill: s.fill, ly: s.ly, rects: s.rects, pts: s.pts.map((p) => (p.length > 2 ? [p[0], p[1], p[2]] : [p[0], p[1]])) }));
  }

  return { SHAPES, markerRadius, CURVES, pressureCurve, makeFilter, newStroke, widthFor, renderStroke, renderAll, liveStart, liveAdvance, liveFinish, liveDot, bbox, hit, moveStroke, handles, dragHandle, boxFrame, boxCorners, FILL_ALPHA, FLOOD_ALPHA, floodRects, dilate, mapStroke, rotate90cw, cropStrokes, straighten, makeHistory, pack, unpack, uid };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Ink;
