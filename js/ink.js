// ink.js — pen engine for the Sketch / Annotator tool. Strokes are kept as small editable objects (not pixels) so they
// can be undone and redone one at a time, replayed after a rotate or crop, saved and reloaded. No DOM; the drawing
// functions only need a Canvas 2D context, so the geometry is testable in Node. Global `Ink`.
//
//   Stroke { id, k, c (colour), w (nominal width, canvas px), pts:[[x,y,p],...] (p = pressure 0..1),
//            k: 'pen' | 'smooth' (pen with extra stabiliser) | 'air' (airbrush) | 'nib' (fountain) | 'erase' | 'line' | 'arc',
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
  const isFree = (s) => s.k !== 'line' && s.k !== 'arc';

  // Whole stroke in one go (replay).
  function renderStroke(ctx, s) {
    if (!s.pts.length) return;
    ctx.save(); setup(ctx, s);
    if (s.k === 'line' || s.k === 'arc') {
      ctx.lineWidth = s.w; ctx.setLineDash(s.dash || []); ctx.beginPath(); ctx.moveTo(s.pts[0][0], s.pts[0][1]);
      if (s.k === 'arc') ctx.quadraticCurveTo(s.ctl[0], s.ctl[1], s.pts[1][0], s.pts[1][1]); else ctx.lineTo(s.pts[1][0], s.pts[1][1]);
      ctx.stroke();
    } else if (s.pts.length === 1) drawDot(ctx, s);
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
  function bbox(s) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const pts = s.k === 'arc' ? s.pts.concat([s.ctl]) : s.pts;
    for (const p of pts) { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; }
    const r = s.k === 'erase' ? s.w * 1.5 : s.w;
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
    if (s.k === 'arc') {
      let prev = s.pts[0];
      for (let i = 1; i <= 24; i++) {
        const t = i / 24, u = 1 - t, q = [u * u * s.pts[0][0] + 2 * u * t * s.ctl[0] + t * t * s.pts[1][0], u * u * s.pts[0][1] + 2 * u * t * s.ctl[1] + t * t * s.pts[1][1]];
        if (distToSeg(x, y, prev, q) <= r + s.w / 2) return true; prev = q;
      }
      return false;
    }
    if (s.pts.length === 1) return Math.hypot(x - s.pts[0][0], y - s.pts[0][1]) <= r + s.w / 2;
    for (let i = 1; i < s.pts.length; i++) if (distToSeg(x, y, s.pts[i - 1], s.pts[i]) <= r + s.w / 2) return true;
    return false;
  }
  // New stroke with every point moved by f([x,y]) -> [x,y]; widths and dashes scaled by k.
  function mapStroke(s, f, k) {
    const kk = k || 1, m = (p) => { const q = f(p); return p.length > 2 ? [q[0], q[1], p[2]] : q; };
    return Object.assign({}, s, { pts: s.pts.map(m), w: s.w * kk, dash: (s.dash || []).map((d) => d * kk), ctl: s.ctl ? f(s.ctl) : s.ctl, nib: s.nib ? { avg: s.nib.avg * kk, max: s.nib.max * kk } : s.nib });
  }
  const rotate90cw = (strokes, ch) => strokes.map((s) => mapStroke(s, (p) => [ch - p[1], p[0]], 1));
  const cropStrokes = (strokes, x, y, k) => strokes.map((s) => mapStroke(s, (p) => [(p[0] - x) * k, (p[1] - y) * k], k));
  // Hold-to-straighten: the stroke becomes a straight line from where it started to where it ended, snapping to 0/45/90 within a few degrees.
  function straighten(s, snapDeg) {
    const a = s.pts[0], b = s.pts[s.pts.length - 1];
    let bx = b[0], by = b[1];
    const ang = Math.atan2(by - a[1], bx - a[0]) * 180 / Math.PI, len = Math.hypot(bx - a[0], by - a[1]), tol = snapDeg == null ? 3 : snapDeg;
    for (let t = -180; t <= 180; t += 45) if (Math.abs(ang - t) <= tol) { bx = a[0] + len * Math.cos(t * Math.PI / 180); by = a[1] + len * Math.sin(t * Math.PI / 180); break; }
    return Object.assign({}, s, { k: s.k === 'erase' ? 'erase' : 'line', pts: [[a[0], a[1]], [bx, by]], dash: [] });
  }

  // ---- history: strokes in drawing order, with redo ----
  function makeHistory(initial) {
    const h = { strokes: initial ? initial.slice() : [], redo: [] };
    return {
      get strokes() { return h.strokes; },
      get redoCount() { return h.redo.length; },
      add(s) { h.strokes.push(s); h.redo.length = 0; return s; },
      undo() { const s = h.strokes.pop(); if (s) h.redo.push(s); return s || null; },
      redo() { const s = h.redo.pop(); if (s) h.strokes.push(s); return s || null; },
      replaceAll(list) { h.strokes = list.slice(); h.redo.length = 0; },
      mapAll(f) { h.strokes = h.strokes.map(f); h.redo = h.redo.map(f); },
      dropLast() { return h.strokes.pop() || null; }
    };
  }

  // ---- saving: compact JSON ----
  const r1 = (v) => Math.round(v * 10) / 10, r2 = (v) => Math.round(v * 100) / 100;
  function pack(strokes) {
    return strokes.map((s) => ({ id: s.id, k: s.k, c: s.c, w: r2(s.w), seed: s.seed, dash: (s.dash || []).map(r1), nib: s.nib, ctl: s.ctl ? [r1(s.ctl[0]), r1(s.ctl[1])] : undefined, pts: s.pts.map((p) => (p.length > 2 ? [r1(p[0]), r1(p[1]), r2(p[2])] : [r1(p[0]), r1(p[1])])) }));
  }
  function unpack(list) {
    return (Array.isArray(list) ? list : []).filter((s) => s && Array.isArray(s.pts) && s.pts.length).map((s) => newStroke(s.k || 'pen', { id: s.id || uid(), c: s.c || '#000000', w: s.w || 4, seed: s.seed || 1, dash: s.dash || [], nib: s.nib, ctl: s.ctl, pts: s.pts.map((p) => (p.length > 2 ? [p[0], p[1], p[2]] : [p[0], p[1]])) }));
  }

  return { CURVES, pressureCurve, makeFilter, newStroke, widthFor, renderStroke, renderAll, liveStart, liveAdvance, liveFinish, liveDot, bbox, hit, mapStroke, rotate90cw, cropStrokes, straighten, makeHistory, pack, unpack, uid };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Ink;
