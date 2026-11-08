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
  const ST = (typeof CadStyle !== 'undefined') ? CadStyle : require('./cadstyle.js');
  const SY = (typeof CadSym !== 'undefined') ? CadSym : require('./cadsym.js');
  const VP = (typeof CadVp !== 'undefined') ? CadVp : require('./cadvp.js');
  const CH = (typeof CadHatch !== 'undefined') ? CadHatch : require('./cadhatch.js');
  const SIZES = { A4: [210, 297], A3: [297, 420], A2: [420, 594], A1: [594, 841], A0: [841, 1189] };
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
  // Sheet border, title block and credit line as items in sheet millimetres.
  function sheetFrame(items, lay, data, tbIn, scaleText, sizeName) {
    const K = '#000000', raw = (pts, closed, w) => items.push({ k: 'poly', pts, closed, color: K, w });
    const rect = (r, w) => raw([[r.x0, r.y0], [r.x1, r.y0], [r.x1, r.y1], [r.x0, r.y1]], true, w);
    rect(lay.frame, 0.5); rect(lay.tb, 0.35);
    const tb = Object.assign(defaultTitleBlock(data), tbIn || {});
    const bw = lay.tb.x1 - lay.tb.x0, X0 = lay.tb.x0, Y0 = lay.tb.y0;
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
    const row = [['SCALE @ ' + sizeName, scaleText, 34], ['DATE', tb.date, 34], ['DRAWN', tb.drawnBy, 40], ['CHECKED', tb.checkedBy, 40], ['UNITS', data.units || 'mm', 32]];
    let x = 0; row.forEach(([l, v, w], i) => { const ww = w * f; cell(x, 0, ww, 12, l, v); x += ww; if (i < row.length - 1) vline(x, 0, 12); });
    items.push({ k: 'text', p: [lay.frame.x0 + 1, lay.frame.y0 - 4], h: 2.2, rot: 0, str: 'Inspector by Arch&Array', align: 'left', color: '#909090' });

  }
  // Frame and title block of a layout (paper space), for the screen and the plotter.
  function sheetItems(lyt, data) {
    const lay = layout(lyt.size, lyt.landscape !== false), items = [];
    sheetFrame(items, lay, data, lyt.tb, (lyt.tb && lyt.tb.scaleText) || 'AS SHOWN', lyt.size);
    return { lay, items };
  }
  // Turn model (or paper) entities into plot items. M maps entity coordinates to sheet mm, kmm = sheet mm per entity unit.
  function genItems(data, ents, M, kmm, o, items) {
    const pens = data.pens || {};
    const color = (e) => {
      if (o.mono) return '#000000';
      const hex = ST.colorHex(data, e), pn = pens[hex];
      return pn && pn.color ? pn.color : ST.printable(hex);
    };
    let curW = 0.25, curDash = null;
    const LW = 0.25;
    const poly = (pts, closed, col, w) => items.push({ k: 'poly', pts: pts.map(M), closed: !!closed, color: col, w: w || curW || LW, dash: curDash && curDash.length ? curDash : null });
    const txt = (p, h, rot, str, align, col) => { if (str && h * kmm >= 0.4) items.push({ k: 'text', p: M(p), h: h * kmm, rot: rot || 0, str, align: align || 'left', color: col }); };

    const ordered = ents.filter((e) => e.t === 'HATCH').concat(ents.filter((e) => e.t !== 'HATCH'));
    for (const e of ordered) {
      const col = color(e), hex0 = ST.colorHex(data, e), pn0 = pens[hex0];
      curW = pn0 && pn0.lw != null ? pn0.lw : ST.lwMm(data, e);
      curDash = (e.t === 'DIM' || e.t === 'POINT' || e.t === 'SYM') ? null : ST.dashModel(data, ST.ltypeName(data, e)).map((v) => v * kmm);
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
        case 'HATCH': {
          const pat = CH.PATTERNS[e.pat] || CH.PATTERNS.Lines, lay0 = ST.layerOf(data, e.layer);
          const hw = pn0 && pn0.lw != null ? pn0.lw : (e.lw != null || (lay0 && lay0.lw >= 0)) ? ST.lwMm(data, e) : 0.13;
          if (pat.solid) { items.push({ k: 'fillr', rings: CH.polysOf(e, 0.05 * (e.pk || 1)).map((r) => r.map(M)), color: col }); break; }
          const segs = CH.segments(e).map(([a, b]) => [M(a), M(b)]);
          if (segs.length) items.push({ k: 'segs', segs, color: col, w: hw });
          break;
        }
        case 'SYM':
          for (const sh of SY.shapes(e)) {
            if (sh.fill) items.push({ k: 'fillr', rings: [sh.pts.map(M)], color: col });
            else poly(sh.pts, sh.closed && sh.pts.length > 2, col);
          }
          break;
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

  }

  // ---- layouts (paper space) ----
  const itemBox = (pts) => { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const p of pts) { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; } return [x0, y0, x1, y1]; };
  // Items from one viewport, cut to its window (even-odd region of paper-mm rings).
  function clipItems(items, rings) {
    const out = [], inside = (p) => CH.inside(rings, p), convex = rings.length === 1 && VP.isConvex(rings[0]);
    const full = (pts, closed) => {
      if (!pts.every(inside)) return false;
      const n = closed ? pts.length : pts.length - 1;
      for (let i = 0; i < n; i++) { const a = pts[i], b = pts[(i + 1) % pts.length], pcs = VP.clipSeg(a, b, rings); if (pcs.length !== 1 || Math.hypot(pcs[0][0][0] - a[0], pcs[0][0][1] - a[1]) > 1e-6 || Math.hypot(pcs[0][1][0] - b[0], pcs[0][1][1] - b[1]) > 1e-6) return false; }
      return true;
    };
    for (const it of items) {
      if (it.k === 'poly') {
        if (full(it.pts, it.closed)) { out.push(it); continue; }
        for (const pc of VP.clipPoly(it.pts, it.closed, rings)) out.push({ ...it, pts: pc, closed: false });
      } else if (it.k === 'segs') {
        const segs = []; for (const [a, b] of it.segs) for (const q of VP.clipSeg(a, b, rings)) segs.push(q);
        if (segs.length) out.push({ ...it, segs });
      } else if (it.k === 'fill') {
        if (it.pts.every(inside)) out.push(it); else if (convex) { const q = VP.clipRingConvex(it.pts, rings[0]); if (q.length >= 3) out.push({ ...it, pts: q }); }
      } else if (it.k === 'fillr') {
        const rs = [];
        for (const rg of it.rings) { if (rg.every(inside) && rings.length === 1) rs.push(rg); else if (convex) { const q = VP.clipRingConvex(rg, rings[0]); if (q.length >= 3) rs.push(q); } else { const bb = itemBox(rg); if (inside([(bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2])) rs.push(rg); } }
        if (rs.length) out.push({ ...it, rings: rs });
      } else if (it.k === 'text') { if (inside(it.p)) out.push(it); }
      else if (it.k === 'img') out.push({ ...it, clip: rings });
      else out.push(it);
    }
    return out;
  }
  // A layout as a plot: paper entities in sheet mm, each viewport's model drawn through its window, then the sheet frame.
  function planLayout(data, lyt, opts) {
    const o = Object.assign({ mono: false }, opts || {});
    const lay = layout(lyt.size, lyt.landscape !== false), items = [];
    const L = new Map((data.layers || []).map((l) => [l.name, l]));
    const plottable = (e) => { const l = L.get(e.layer); return !l || (l.on !== false && !l.frozen && l.plot !== false); };
    const model = (data.entities || []).filter(plottable), paper = (lyt.entities || []).filter(plottable);
    const um = UNIT_MM[data.units] || 1, ident = (p) => [p[0], p[1]];
    const uls = o.underlays === false ? [] : (data.underlays || []).filter((u) => u.on !== false && (!o.underlayIds || o.underlayIds.indexOf(u.id) >= 0));
    const ulCorners = (u) => { const c = Math.cos(u.rot || 0), s = Math.sin(u.rot || 0); return [[0, 0], [u.w, 0], [u.w, u.h], [0, u.h]].map(([x, y]) => [u.x + x * c - y * s, u.y + x * s + y * c]); };
    let nvp = 0;
    for (const vp of paper) {
      if (vp.t !== 'VPORT') continue;
      nvp++;
      const rings = VP.polys(vp, 0.05), k = VP.factor(vp), C = VP.centre(vp), M = (p) => [C[0] + (p[0] - vp.cx) * k, C[1] + (p[1] - vp.cy) * k];
      const vitems = [];
      for (const u of uls) vitems.push({ k: 'img', id: u.assetId, pts: ulCorners(u).map(M), opacity: u.opacity == null ? 0.5 : u.opacity, iw: u.iw, ih: u.ih });
      genItems(data, model.filter((e) => VP.shownIn(vp, e.layer)), M, k, o, vitems);
      for (const it of clipItems(vitems, rings)) items.push(it);
    }
    // paper objects are in millimetres at 1:1 (dashes, text and hatches are already paper-sized)
    const pdata = { ...data, units: 'mm', plotScale: 1 };
    const pitems = [];
    genItems(pdata, paper.filter((e) => e.t !== 'VPORT'), ident, 1, o, pitems);
    for (const e of paper) {
      if (e.t !== 'VPORT' || e.bd === false) continue;
      const pens = data.pens || {}, hex = ST.colorHex(data, e), pn = pens[hex];
      for (const ring of VP.polys(e, 0.05)) pitems.push({ k: 'poly', pts: ring, closed: true, color: o.mono ? '#000000' : (pn && pn.color ? pn.color : ST.printable(hex)), w: pn && pn.lw != null ? pn.lw : ST.lwMm(data, e), dash: null });
    }
    for (const it of pitems) items.push(it);
    const tbs = Object.assign({}, lyt.tb || {});
    sheetFrame(items, lay, data, tbs, tbs.scaleText || 'AS SHOWN', lyt.size);
    return { sheet: { w: lay.w, h: lay.h }, items, scale: null, scaleText: tbs.scaleText || 'AS SHOWN', fits: true, suggested: null, empty: !nvp && !paper.length, area: lay.area };
  }
  function plan(data, opts) {
    const o = Object.assign({ size: 'A4', landscape: true, scale: 'fit', mono: false, tb: {} }, opts || {});
    const lay = layout(o.size, o.landscape), ents = visibleEntities(data);
    let box = boxOf(ents);
    const uls = o.underlays === false ? [] : (data.underlays || []).filter((u) => u.on !== false && (!o.underlayIds || o.underlayIds.indexOf(u.id) >= 0));
    const ulCorners = (u) => { const c = Math.cos(u.rot || 0), s = Math.sin(u.rot || 0); return [[0, 0], [u.w, 0], [u.w, u.h], [0, u.h]].map(([x, y]) => [u.x + x * c - y * s, u.y + x * s + y * c]); };
    if (o.fitPictures !== false) for (const u of uls) for (const q of ulCorners(u)) { if (!box) box = { minX: q[0], minY: q[1], maxX: q[0], maxY: q[1] }; else { box.minX = Math.min(box.minX, q[0]); box.minY = Math.min(box.minY, q[1]); box.maxX = Math.max(box.maxX, q[0]); box.maxY = Math.max(box.maxY, q[1]); } }
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
    for (const u of uls) items.push({ k: 'img', id: u.assetId, pts: ulCorners(u).map(M), opacity: u.opacity == null ? 0.5 : u.opacity, iw: u.iw, ih: u.ih });
    genItems(data, ents, M, kmm, o, items);

    const scaleText = '1:' + (Number.isInteger(denom) ? denom : +denom.toFixed(2));
    sheetFrame(items, lay, data, o.tb, scaleText, o.size);

    return { sheet: { w: lay.w, h: lay.h }, items, scale: denom, scaleText, fits, suggested, empty: !box, area: lay.area };
  }

  // ---- renderers ----
  function renderCanvas(p, canvas, pxPerMm, images) {
    canvas.width = Math.round(p.sheet.w * pxPerMm); canvas.height = Math.round(p.sheet.h * pxPerMm);
    const c = canvas.getContext('2d'), H = p.sheet.h;
    c.fillStyle = '#ffffff'; c.fillRect(0, 0, canvas.width, canvas.height);
    c.lineJoin = 'round'; c.lineCap = 'round';
    const X = (v) => v * pxPerMm, Y = (v) => (H - v) * pxPerMm;
    for (const it of p.items) {
      if (it.k === 'img') {
        const im = images && images[it.id]; if (!im) continue;
        const iw = im.naturalWidth || im.width, ih = im.naturalHeight || im.height, [p0, p1, , p3] = it.pts;
        const ux = p1[0] - p0[0], uy = p1[1] - p0[1], vx = p3[0] - p0[0], vy = p3[1] - p0[1];
        c.save(); c.beginPath(); c.rect(X(p.area.x0), Y(p.area.y1), (p.area.x1 - p.area.x0) * pxPerMm, (p.area.y1 - p.area.y0) * pxPerMm); c.clip();
        if (it.clip) { c.beginPath(); for (const rg of it.clip) { rg.forEach((q, i) => (i ? c.lineTo(X(q[0]), Y(q[1])) : c.moveTo(X(q[0]), Y(q[1])))); c.closePath(); } c.clip('evenodd'); }
        c.globalAlpha = it.opacity;
        c.setTransform(ux / iw * pxPerMm, -uy / iw * pxPerMm, -vx / ih * pxPerMm, vy / ih * pxPerMm, X(p0[0] + vx), Y(p0[1] + vy));
        c.drawImage(im, 0, 0); c.restore();
      } else if (it.k === 'poly') {
        c.strokeStyle = it.color; c.lineWidth = Math.max(1, it.w * pxPerMm); c.beginPath(); c.setLineDash(it.dash ? it.dash.map((v) => Math.max(0.6, v * pxPerMm)) : []);
        it.pts.forEach((q, i) => (i ? c.lineTo(X(q[0]), Y(q[1])) : c.moveTo(X(q[0]), Y(q[1])))); if (it.closed) c.closePath(); c.stroke(); c.setLineDash([]);
      } else if (it.k === 'segs') {
        c.strokeStyle = it.color; c.lineWidth = Math.max(1, it.w * pxPerMm); c.setLineDash([]); c.beginPath();
        for (const [a, b] of it.segs) { c.moveTo(X(a[0]), Y(a[1])); c.lineTo(X(b[0]), Y(b[1])); } c.stroke();
      } else if (it.k === 'fillr') {
        c.fillStyle = it.color; c.beginPath();
        for (const r of it.rings) { r.forEach((q, i) => (i ? c.lineTo(X(q[0]), Y(q[1])) : c.moveTo(X(q[0]), Y(q[1])))); c.closePath(); }
        c.fill('evenodd');
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
  // Rotated, faded picture flattened into an axis-aligned PNG covering (picture box ∩ plot area), for PDF.
  function bakeImage(p, it, im, ppm) {
    const xs = it.pts.map((q) => q[0]), ys = it.pts.map((q) => q[1]);
    const x0 = Math.max(Math.min(...xs), p.area.x0), x1 = Math.min(Math.max(...xs), p.area.x1), y0 = Math.max(Math.min(...ys), p.area.y0), y1 = Math.min(Math.max(...ys), p.area.y1);
    if (x1 - x0 < 0.1 || y1 - y0 < 0.1) return null;
    const cv = document.createElement('canvas'); cv.width = Math.max(1, Math.round((x1 - x0) * ppm)); cv.height = Math.max(1, Math.round((y1 - y0) * ppm));
    const c = cv.getContext('2d'), iw = im.naturalWidth || im.width, ih = im.naturalHeight || im.height, [p0, p1, , p3] = it.pts;
    const ux = p1[0] - p0[0], uy = p1[1] - p0[1], vx = p3[0] - p0[0], vy = p3[1] - p0[1];
    if (it.clip) { c.beginPath(); for (const rg of it.clip) { rg.forEach((q, i) => (i ? c.lineTo((q[0] - x0) * ppm, (y1 - q[1]) * ppm) : c.moveTo((q[0] - x0) * ppm, (y1 - q[1]) * ppm))); c.closePath(); } c.clip('evenodd'); }
    c.globalAlpha = it.opacity;
    c.setTransform(ux / iw * ppm, -uy / iw * ppm, -vx / ih * ppm, vy / ih * ppm, (p0[0] + vx - x0) * ppm, (y1 - (p0[1] + vy)) * ppm);
    c.drawImage(im, 0, 0);
    return { url: cv.toDataURL('image/png'), x: x0, y: y1, w: x1 - x0, h: y1 - y0 };
  }
  // One plan = one page; an array of plans = one page each.
  function renderPdf(plans, JsPDF, images) {
    const list = Array.isArray(plans) ? plans : [plans], p0 = list[0];
    const doc = new JsPDF({ unit: 'mm', format: [p0.sheet.w, p0.sheet.h], orientation: p0.sheet.w > p0.sheet.h ? 'landscape' : 'portrait' });
    list.forEach((p, i) => { if (i) doc.addPage([p.sheet.w, p.sheet.h], p.sheet.w > p.sheet.h ? 'landscape' : 'portrait'); drawPdfPage(doc, p, images); });
    return doc;
  }
  function drawPdfPage(doc, p, images) {
    const H = p.sheet.h;
    doc.setLineCap && doc.setLineCap('round'); doc.setLineJoin && doc.setLineJoin('round');
    for (const it of p.items) {
      if (it.k === 'img') {
        const im = images && images[it.id]; if (!im || typeof document === 'undefined') continue;
        const b = bakeImage(p, it, im, 200 / 25.4); if (b) doc.addImage(b.url, 'PNG', b.x, H - b.y, b.w, b.h, undefined, 'FAST');
        continue;
      }
      if (it.k === 'poly') {
        const q = it.pts; if (q.length < 2) continue;
        doc.setDrawColor(...hex(it.color)); doc.setLineWidth(it.w);
        if (doc.setLineDashPattern) doc.setLineDashPattern(it.dash ? it.dash.map((v) => Math.max(0.05, v)) : [], 0);
        const rel = []; for (let i = 1; i < q.length; i++) rel.push([q[i][0] - q[i - 1][0], -(q[i][1] - q[i - 1][1])]);
        doc.lines(rel, q[0][0], H - q[0][1], [1, 1], 'S', !!it.closed);
      } else if (it.k === 'segs') {
        doc.setDrawColor(...hex(it.color)); doc.setLineWidth(it.w);
        if (doc.setLineDashPattern) doc.setLineDashPattern([], 0);
        for (const [a, b] of it.segs) doc.line(a[0], H - a[1], b[0], H - b[1]);
      } else if (it.k === 'fillr') {
        doc.setFillColor(...hex(it.color)); doc.setDrawColor(...hex(it.color)); doc.setLineWidth(0.05);
        if (doc.setLineDashPattern) doc.setLineDashPattern([], 0);
        for (const q of CH.trapezoids(it.rings)) { const [a, b, c2, d] = q; doc.lines([[b[0] - a[0], -(b[1] - a[1])], [c2[0] - b[0], -(c2[1] - b[1])], [d[0] - c2[0], -(d[1] - c2[1])]], a[0], H - a[1], [1, 1], 'FD', true); }
      } else if (it.k === 'fill') {
        doc.setFillColor(...hex(it.color));
        if (it.pts.length === 3) doc.triangle(it.pts[0][0], H - it.pts[0][1], it.pts[1][0], H - it.pts[1][1], it.pts[2][0], H - it.pts[2][1], 'F');
        else { const q = it.pts, rel = []; for (let i = 1; i < q.length; i++) rel.push([q[i][0] - q[i - 1][0], -(q[i][1] - q[i - 1][1])]); doc.lines(rel, q[0][0], H - q[0][1], [1, 1], 'F', true); }
      } else {
        doc.setTextColor(...hex(it.color)); doc.setFont('helvetica', 'normal'); doc.setFontSize(it.h / 0.352778);
        doc.text(it.str, it.p[0], H - it.p[1], { angle: it.rot * 180 / Math.PI, align: it.align === 'center' ? 'center' : 'left' });
      }
    }
    return doc;
  }

  return { sheetItems, planLayout, clipItems, plan, renderCanvas, renderPdf, defaultTitleBlock, layout, SIZES, STD_SCALES };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = CadPlot;
