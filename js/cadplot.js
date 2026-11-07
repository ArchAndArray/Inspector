// cadplot.js — lays a drawing out on an A4 / A3 sheet with a title block, as a flat list of plot
// items in sheet millimetres (origin bottom-left, Y up), and draws that list to a canvas (PNG) or a
// jsPDF document (vector PDF). The layout is pure and testable in Node; the two renderers take the
// drawing surface as an argument. Global `CadPlot`.
//
//   item: { k:'poly', pts:[[x,y]..], closed, color, w }    stroked line, w = line weight in mm
//         { k:'fill', pts:[[x,y]..], color }               filled polygon (dimension arrows)
//         { k:'text', p:[x,y], h, rot, str, align, color } h = text height in mm, rot radians CCW
//   Text and dimension sizes in the model are already in model units (paper size x plot scale), so
//   they print at their paper size when the print scale equals the plot scale.

const CadPlot = (() => {
  'use strict';
  const G = (typeof CadGeo !== 'undefined') ? CadGeo : require('./cadgeo.js');
  const DM = (typeof CadDim !== 'undefined') ? CadDim : require('./caddim.js');
  const ACI = { 1: '#d32f2f', 2: '#b8860b', 3: '#2e7d32', 4: '#00838f', 5: '#1565c0', 6: '#8e24aa', 7: '#000000', 8: '#808080', 9: '#a0a0a0' };
  const SIZES = { A4: [210, 297], A3: [297, 420] };
  const UNIT_MM = { mm: 1, m: 1000, in: 25.4 };
  const STD_SCALES = [1, 2, 5, 10, 20, 25, 50, 75, 100, 125, 150, 200, 250, 500, 750, 1000, 1250, 1500, 2000, 2500, 5000, 10000, 20000, 50000, 100000];
  const MARGIN = 10, TB_W = 180, TB_H = 36, TB_GAP = 4;

  function defaultTitleBlock(data) {
    const d = new Date();
    return { project: '', title: data.name || '', drawingNo: '', rev: 'P01', drawnBy: '', checkedBy: '', date: d.toISOString().slice(0, 10) };
  }

  function layout(size, landscape) {
    const s = SIZES[size] || SIZES.A4, w = landscape ? s[1] : s[0], h = landscape ? s[0] : s[1];
    const tbW = Math.min(TB_W, w - 2 * MARGIN);
    const frame = { x0: MARGIN, y0: MARGIN, x1: w - MARGIN, y1: h - MARGIN };
    const tb = { x0: frame.x1 - tbW, y0: frame.y0, x1: frame.x1, y1: frame.y0 + TB_H };
    const area = { x0: frame.x0 + 2, y0: tb.y1 + TB_GAP, x1: frame.x1 - 2, y1: frame.y1 - 2 };
    return { w, h, frame, tb, area };
  }

  function visibleEntities(data) {
    const L = new Map((data.layers || []).map((l) => [l.name, l]));
    return (data.entities || []).filter((e) => { const l = L.get(e.layer); return !l || (l.on !== false && !l.frozen && l.plot !== false); });
  }
  function boxOf(ents) {
    let b = null;
    for (const e of ents) {
      const x = G.bbox(e); if (!x || !isFinite(x.minX)) continue;
      if (!b) b = { minX: x.minX, minY: x.minY, maxX: x.maxX, maxY: x.maxY };
      else { b.minX = Math.min(b.minX, x.minX); b.minY = Math.min(b.minY, x.minY); b.maxX = Math.max(b.maxX, x.maxX); b.maxY = Math.max(b.maxY, x.maxY); }
    }
    return b;
  }

  // Tessellate to points. Chord error on paper stays under 0.04 mm.
  function arcPts(c, r, a0, a1, kmm) {
    const rp = Math.max(r * kmm, 1e-6), sweep = a1 - a0;
    const step = rp > 0.04 ? 2 * Math.acos(Math.max(0, 1 - 0.04 / rp)) : Math.PI / 4;
    const n = Math.max(4, Math.min(720, Math.ceil(Math.abs(sweep) / Math.max(step, 0.005))));
    const out = []; for (let i = 0; i <= n; i++) { const a = a0 + sweep * i / n; out.push([c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)]); }
    return out;
  }

  // Returns { sheet, items, scale, scaleText, fits, suggested, empty }.
  function plan(data, opts) {
    const o = Object.assign({ size: 'A4', landscape: true, scale: 'fit', mono: false, tb: {} }, opts || {});
    const lay = layout(o.size, o.landscape), ents = visibleEntities(data), box = boxOf(ents);
    const um = UNIT_MM[data.units] || 1;
    const items = [];
    let denom = null, fits = true, suggested = null;
    const aw = lay.area.x1 - lay.area.x0, ah = lay.area.y1 - lay.area.y0;
    const fitDenom = (b) => {
      const bw = Math.max(b.maxX - b.minX, 1e-9) * um, bh = Math.max(b.maxY - b.minY, 1e-9) * um;
      const need = Math.max(bw / aw, bh / ah);
      return STD_SCALES.find((s) => s >= need) || Math.ceil(need);
    };
    if (box) {
      suggested = fitDenom(box);
      if (o.scale === 'plot') { denom = data.plotScale || 50; fits = (box.maxX - box.minX) * um / denom <= aw + 1e-6 && (box.maxY - box.minY) * um / denom <= ah + 1e-6; }
      else if (typeof o.scale === 'number' && o.scale > 0) { denom = o.scale; fits = (box.maxX - box.minX) * um / denom <= aw + 1e-6 && (box.maxY - box.minY) * um / denom <= ah + 1e-6; }
      else denom = suggested;
    } else denom = data.plotScale || 50;
    const kmm = um / denom;                                     // sheet mm per model unit
    const cx = box ? (box.minX + box.maxX) / 2 : 0, cy = box ? (box.minY + box.maxY) / 2 : 0;
    const ox = (lay.area.x0 + lay.area.x1) / 2, oy = (lay.area.y0 + lay.area.y1) / 2;
    const M = (p) => [ox + (p[0] - cx) * kmm, oy + (p[1] - cy) * kmm];
    const color = (e) => {
      if (o.mono) return '#000000';
      const l = (data.layers || []).find((x) => x.name === e.layer);
      return ACI[e.color != null ? e.color : (l ? l.color : 7)] || ACI[7];
    };
    const LW = 0.25;
    const poly = (pts, closed, col, w) => items.push({ k: 'poly', pts: pts.map(M), closed: !!closed, color: col, w: w || LW });
    const txt = (p, h, rot, str, align, col) => { if (str && h * kmm >= 0.4) items.push({ k: 'text', p: M(p), h: h * kmm, rot: rot || 0, str, align: align || 'left', color: col }); };

    for (const e of ents) {
      const col = color(e);
      switch (e.t) {
        case 'LINE': poly([e.p1, e.p2], false, col); break;
        case 'CIRCLE': poly(arcPts(e.c, e.r, 0, Math.PI * 2, kmm), true, col); break;
        case 'ARC': poly(arcPts(e.c, e.r, e.a0, e.a1, kmm), false, col); break;
        case 'POINT': { const s = 1 / Math.max(kmm, 1e-9); poly([[e.p[0] - s, e.p[1]], [e.p[0] + s, e.p[1]]], false, col); poly([[e.p[0], e.p[1] - s], [e.p[0], e.p[1] + s]], false, col); break; }
        case 'LWPOLYLINE': {
          const pts = [];
          for (const sg of G.polySegments(e)) {
            if (sg.k === 's') { if (!pts.length) pts.push(sg.p1); pts.push(sg.p2); }
            else { let a = arcPts(sg.c, sg.r, sg.a0, sg.a1, kmm); if (sg.bulge < 0) a = a.reverse(); if (pts.length) a.shift(); pts.push(...a); }
          }
          if (pts.length) poly(pts, e.closed && pts.length > 2, col);
          break;
        }
        case 'TEXT': txt(e.p, e.h, e.rot, e.text, 'left', col); break;
        case 'MTEXT': {
          const c = Math.cos(e.rot || 0), s = Math.sin(e.rot || 0);
          DM.mtextLines(e).forEach((ln, i) => { const y = -(i * DM.LH * e.h) - e.h; txt([e.p[0] - y * s, e.p[1] + y * c], e.h, e.rot, ln, 'left', col); });
          break;
        }
        case 'DIM': {
          const gm = DM.geom(e);
          for (const [a, b] of gm.lines) poly([a, b], false, col);
          for (const ar of gm.arrows) {
            const nn = [-ar.dir[1], ar.dir[0]], base = [ar.tip[0] + ar.dir[0] * ar.size, ar.tip[1] + ar.dir[1] * ar.size], w = ar.size / 3;
            items.push({ k: 'fill', pts: [M(ar.tip), M([base[0] + nn[0] * w, base[1] + nn[1] * w]), M([base[0] - nn[0] * w, base[1] - nn[1] * w])], color: col });
          }
          txt(gm.text.p, gm.text.h, gm.text.rot, gm.text.str, 'center', col);
          break;
        }
        default: break;
      }
    }

    // border and title block (sheet coordinates, not mapped)
    const K = '#000000', raw = (pts, closed, w) => items.push({ k: 'poly', pts, closed, color: K, w });
    const rect = (r, w) => raw([[r.x0, r.y0], [r.x1, r.y0], [r.x1, r.y1], [r.x0, r.y1]], true, w);
    rect(lay.frame, 0.5); rect(lay.tb, 0.35);
    const tb = Object.assign(defaultTitleBlock(data), o.tb || {});
    const bw = lay.tb.x1 - lay.tb.x0, X0 = lay.tb.x0, Y0 = lay.tb.y0;
    const scaleText = '1:' + (Number.isInteger(denom) ? denom : +denom.toFixed(2));
    const cell = (x, y, w, h, label, value, big) => {
      items.push({ k: 'text', p: [X0 + x + 1.2, Y0 + y + h - 2.6], h: 2, rot: 0, str: label, align: 'left', color: '#606060' });
      if (value) items.push({ k: 'text', p: [X0 + x + 1.2, Y0 + y + 2.2], h: big ? 4.2 : 3.4, rot: 0, str: String(value), align: 'left', color: K });
    };
    const hline = (y) => raw([[X0, Y0 + y], [X0 + bw, Y0 + y]], false, 0.25);
    const vline = (x, y0, y1) => raw([[X0 + x, Y0 + y0], [X0 + x, Y0 + y1]], false, 0.25);
    const f = bw / TB_W;                                         // shrink columns if the sheet is narrow
    hline(24); hline(12);
    cell(0, 24, bw, 12, 'PROJECT / STRUCTURE', tb.project, true);
    cell(0, 12, 110 * f, 12, 'DRAWING TITLE', tb.title, true); vline(110 * f, 12, 24);
    cell(110 * f, 12, 40 * f, 12, 'DRAWING NO.', tb.drawingNo); vline(150 * f, 12, 24);
    cell(150 * f, 12, 30 * f, 12, 'REV', tb.rev);
    const row = [['SCALE @ ' + o.size, scaleText, 34], ['DATE', tb.date, 34], ['DRAWN', tb.drawnBy, 40], ['CHECKED', tb.checkedBy, 40], ['UNITS', data.units || 'mm', 32]];
    let x = 0; row.forEach(([l, v, w], i) => { const ww = w * f; cell(x, 0, ww, 12, l, v); x += ww; if (i < row.length - 1) vline(x, 0, 12); });
    items.push({ k: 'text', p: [lay.frame.x0 + 1, lay.frame.y0 - 4], h: 2.2, rot: 0, str: 'Inspector by Arch&Array', align: 'left', color: '#909090' });

    return { sheet: { w: lay.w, h: lay.h }, items, scale: denom, scaleText, fits, suggested, empty: !box, area: lay.area };
  }

  // ---- renderers ----
  function renderCanvas(p, canvas, pxPerMm) {
    canvas.width = Math.round(p.sheet.w * pxPerMm); canvas.height = Math.round(p.sheet.h * pxPerMm);
    const c = canvas.getContext('2d'), H = p.sheet.h;
    c.fillStyle = '#ffffff'; c.fillRect(0, 0, canvas.width, canvas.height);
    c.lineJoin = 'round'; c.lineCap = 'round';
    const X = (v) => v * pxPerMm, Y = (v) => (H - v) * pxPerMm;
    for (const it of p.items) {
      if (it.k === 'poly') {
        c.strokeStyle = it.color; c.lineWidth = Math.max(1, it.w * pxPerMm); c.beginPath();
        it.pts.forEach((q, i) => (i ? c.lineTo(X(q[0]), Y(q[1])) : c.moveTo(X(q[0]), Y(q[1])))); if (it.closed) c.closePath(); c.stroke();
      } else if (it.k === 'fill') {
        c.fillStyle = it.color; c.beginPath(); it.pts.forEach((q, i) => (i ? c.lineTo(X(q[0]), Y(q[1])) : c.moveTo(X(q[0]), Y(q[1])))); c.closePath(); c.fill();
      } else {
        c.save(); c.translate(X(it.p[0]), Y(it.p[1])); c.rotate(-it.rot); c.fillStyle = it.color;
        c.font = `${it.h * pxPerMm}px Helvetica, Arial, sans-serif`; c.textAlign = it.align === 'center' ? 'center' : 'left'; c.textBaseline = 'alphabetic';
        c.fillText(it.str, 0, 0); c.restore();
      }
    }
    return canvas;
  }
  const hex = (s) => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
  function renderPdf(p, JsPDF) {
    const H = p.sheet.h;
    const doc = new JsPDF({ unit: 'mm', format: [p.sheet.w, p.sheet.h], orientation: p.sheet.w > p.sheet.h ? 'landscape' : 'portrait' });
    doc.setLineCap && doc.setLineCap('round'); doc.setLineJoin && doc.setLineJoin('round');
    for (const it of p.items) {
      if (it.k === 'poly') {
        const q = it.pts; if (q.length < 2) continue;
        doc.setDrawColor(...hex(it.color)); doc.setLineWidth(it.w);
        const rel = []; for (let i = 1; i < q.length; i++) rel.push([q[i][0] - q[i - 1][0], -(q[i][1] - q[i - 1][1])]);
        doc.lines(rel, q[0][0], H - q[0][1], [1, 1], 'S', !!it.closed);
      } else if (it.k === 'fill') {
        doc.setFillColor(...hex(it.color)); doc.triangle(it.pts[0][0], H - it.pts[0][1], it.pts[1][0], H - it.pts[1][1], it.pts[2][0], H - it.pts[2][1], 'F');
      } else {
        doc.setTextColor(...hex(it.color)); doc.setFont('helvetica', 'normal'); doc.setFontSize(it.h / 0.352778);
        doc.text(it.str, it.p[0], H - it.p[1], { angle: it.rot * 180 / Math.PI, align: it.align === 'center' ? 'center' : 'left' });
      }
    }
    return doc;
  }

  return { plan, renderCanvas, renderPdf, defaultTitleBlock, layout, SIZES, STD_SCALES };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = CadPlot;
