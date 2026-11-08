// caddxf.js — DXF writer and reader. No DOM; testable in Node. Global `CadDxf`.
//
// Writes AutoCAD R12 ASCII DXF (AC1009): the oldest, simplest dialect, read by every CAD package.
//   LINE, CIRCLE, ARC, POINT, TEXT, POLYLINE+VERTEX (with bulge), SOLID (dimension arrows).
//   LWPOLYLINE becomes a POLYLINE; MTEXT becomes one TEXT per line; DIM is exploded into lines,
//   arrow solids and text (the dimension stays editable only inside Inspector).
// Reads R12 to current ASCII DXF: LINE, CIRCLE, ARC, POINT, TEXT, MTEXT, LWPOLYLINE, POLYLINE/VERTEX
//   and INSERT (blocks, including dimension blocks, uniform scale + rotation, nested). Anything else
//   (SPLINE, ELLIPSE, HATCH, IMAGE, ...) is skipped and counted so the user can be told.

const CadDxf = (() => {
  'use strict';
  const DM = (typeof CadDim !== 'undefined') ? CadDim : require('./caddim.js');
  const ST = (typeof CadStyle !== 'undefined') ? CadStyle : require('./cadstyle.js');
  const LT_UP = (name) => String(name || 'Continuous').toUpperCase();
  const ltFromDxf = (nm) => { const u = String(nm || '').trim().toUpperCase(); return Object.keys(ST.LINETYPES).find((k) => k.toUpperCase() === u) || null; };
  const lwNearest = (v) => ST.LW_LIST.reduce((b, x) => (Math.abs(x - v) < Math.abs(b - v) ? x : b), ST.LW_LIST[0]);
  const n = (v) => { const s = (+v).toFixed(6); return s.indexOf('.') >= 0 ? s.replace(/0+$/, '').replace(/\.$/, '') : s; };
  const deg = (r) => r * 180 / Math.PI;
  const rad = (d) => d * Math.PI / 180;
  const cleanName = (s) => String(s || '0').replace(/[<>/\\":;?*|=`,]/g, '_').slice(0, 255) || '0';
  const cleanText = (s) => String(s == null ? '' : s).replace(/[\r\n]+/g, ' ');
  const UNITS_CODE = { in: 1, mm: 4, m: 6 };
  const ACI_LIMIT = (c) => (c >= 1 && c <= 255 ? c : 7);

  // ---------------- writer ----------------
  // A plotted sheet (items in sheet mm) as a flat DXF: everything on layer SHEET, true size on paper. Pictures are left out.
  function writePlan(plan) {
    const ents = [], C = (hex) => (/^#[0-9a-f]{6}$/i.test(hex || '') ? hex : '#000000');
    for (const it of plan.items) {
      if (it.k === 'poly') ents.push({ t: 'LWPOLYLINE', layer: 'SHEET', rgb: C(it.color), v: it.pts.map((p) => [p[0], p[1], 0]), closed: !!it.closed });
      else if (it.k === 'segs') for (const [a, b] of it.segs) ents.push({ t: 'LINE', layer: 'SHEET', rgb: C(it.color), p1: a, p2: b });
      else if (it.k === 'fill') ents.push({ t: 'HATCH', layer: 'SHEET', rgb: C(it.color), pat: 'Solid', pk: 1, loops: [it.pts.map((p) => [p[0], p[1], 0])] });
      else if (it.k === 'fillr') ents.push({ t: 'HATCH', layer: 'SHEET', rgb: C(it.color), pat: 'Solid', pk: 1, loops: it.rings.map((r) => r.map((p) => [p[0], p[1], 0])) });
      else if (it.k === 'text') {
        const w = it.align === 'center' ? DM.CW * it.h * String(it.str).length / 2 : 0;
        ents.push({ t: 'TEXT', layer: 'SHEET', rgb: C(it.color), p: [it.p[0] - Math.cos(it.rot || 0) * w, it.p[1] - Math.sin(it.rot || 0) * w], h: it.h, rot: it.rot || 0, text: it.str });
      }
    }
    return write({ units: 'mm', plotScale: 1, entities: ents, layers: [{ name: 'SHEET', color: 7, ltype: 'Continuous', lw: -3, on: true, frozen: false, locked: false, plot: true }] });
  }
  function write(data) {
    const out = [];
    const g = (code, val) => { out.push(String(code)); out.push(String(val)); };
    const layerOf = (e) => cleanName(e.layer);
    const common = (type, e) => {
      g(0, type); g(8, layerOf(e));
      if (e.lt && e.lt !== 'Continuous' && ST.LINETYPES[e.lt]) g(6, LT_UP(e.lt));
      if (e.rgb) g(62, ST.nearestAci(e.rgb)); else if (e.color != null && e.color >= 1 && e.color <= 255) g(62, e.color);
    };
    const pt = (x, y, i) => { g(10 + (i || 0), n(x)); g(20 + (i || 0), n(y)); g(30 + (i || 0), 0); };
    const text = (e, p, h, rot, str, center) => {
      common('TEXT', e); pt(p[0], p[1]); g(40, n(h)); g(1, cleanText(str)); if (rot) g(50, n(deg(rot)));
      if (center) { g(72, 1); pt(p[0], p[1], 1); }
    };
    const ents = data.entities || [];
    // extents
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const grow = (p) => { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); };
    const G = (typeof CadGeo !== 'undefined') ? CadGeo : require('./cadgeo.js');
    for (const e of ents) { const b = G.bbox(e); if (b && isFinite(b.minX)) { grow([b.minX, b.minY]); grow([b.maxX, b.maxY]); } }
    if (!isFinite(x0)) { x0 = y0 = 0; x1 = y1 = 1; }

    g(0, 'SECTION'); g(2, 'HEADER');
    g(9, '$ACADVER'); g(1, 'AC1009');
    g(9, '$INSUNITS'); g(70, UNITS_CODE[data.units] || 4);
    g(9, '$EXTMIN'); pt(x0, y0); g(9, '$EXTMAX'); pt(x1, y1);
    g(0, 'ENDSEC');
    g(0, 'SECTION'); g(2, 'TABLES');
    const ltNames = Object.keys(ST.LINETYPES);
    g(0, 'TABLE'); g(2, 'LTYPE'); g(70, ltNames.length);
    for (const nm of ltNames) {
      const pat = nm === 'Continuous' ? [] : ST.dashModel(data, nm);
      g(0, 'LTYPE'); g(2, LT_UP(nm)); g(70, 0); g(3, ST.LT_NOTE[nm]); g(72, 65); g(73, pat.length); g(40, n(pat.reduce((a, b) => a + b, 0)));
      pat.forEach((v, i) => g(49, i % 2 === 0 ? (v < 1e-6 ? 0 : n(v)) : n(-v)));
    }
    g(0, 'ENDTAB');
    const layers = (data.layers && data.layers.length ? data.layers : [{ name: '0', color: 7 }]).slice();
    const seen = new Set(layers.map((l) => cleanName(l.name)));
    for (const e of ents) { const nm = layerOf(e); if (!seen.has(nm)) { seen.add(nm); layers.push({ name: nm, color: 7 }); } }
    if (!seen.has('0')) layers.unshift({ name: '0', color: 7 });
    g(0, 'TABLE'); g(2, 'LAYER'); g(70, layers.length);
    for (const l of layers) {
      g(0, 'LAYER'); g(2, cleanName(l.name)); g(70, (l.frozen ? 1 : 0) | (l.locked ? 4 : 0));
      g(62, (l.on === false ? -1 : 1) * (l.rgb ? ST.nearestAci(l.rgb) : ACI_LIMIT(l.color || 7))); g(6, ST.LINETYPES[l.ltype] ? LT_UP(l.ltype) : 'CONTINUOUS');
    }
    g(0, 'ENDTAB');
    g(0, 'TABLE'); g(2, 'STYLE'); g(70, 1);
    g(0, 'STYLE'); g(2, 'STANDARD'); g(70, 0); g(40, 0); g(41, 1); g(50, 0); g(71, 0); g(42, 2.5); g(3, 'txt'); g(4, '');
    g(0, 'ENDTAB');
    g(0, 'ENDSEC');

    g(0, 'SECTION'); g(2, 'ENTITIES');
    for (const e of ents) {
      switch (e.t) {
        case 'LINE': common('LINE', e); pt(e.p1[0], e.p1[1]); pt(e.p2[0], e.p2[1], 1); break;
        case 'CIRCLE': common('CIRCLE', e); pt(e.c[0], e.c[1]); g(40, n(e.r)); break;
        case 'ARC': common('ARC', e); pt(e.c[0], e.c[1]); g(40, n(e.r)); g(50, n(deg(e.a0))); g(51, n(deg(e.a1))); break;
        case 'POINT': common('POINT', e); pt(e.p[0], e.p[1]); break;
        case 'LWPOLYLINE':
          common('POLYLINE', e); g(66, 1); pt(0, 0); g(70, e.closed ? 1 : 0);
          for (const v of e.v) { common('VERTEX', e); pt(v[0], v[1]); if (v[2]) g(42, n(v[2])); }
          g(0, 'SEQEND'); g(8, layerOf(e));
          break;
        case 'SYM': {                                       // symbols are written as plain polylines (fills as SOLID)
          const SY = (typeof CadSym !== 'undefined') ? CadSym : require('./cadsym.js');
          for (const sh of SY.shapes(e)) {
            if (sh.fill) { for (let i = 1; i + 1 < sh.pts.length; i++) { common('SOLID', e); pt(sh.pts[0][0], sh.pts[0][1]); pt(sh.pts[i][0], sh.pts[i][1], 1); pt(sh.pts[i + 1][0], sh.pts[i + 1][1], 2); pt(sh.pts[i + 1][0], sh.pts[i + 1][1], 3); } }
            if (!sh.fill || sh.closed) { common('POLYLINE', e); g(66, 1); pt(0, 0); g(70, sh.closed ? 1 : 0); for (const q of sh.pts) { common('VERTEX', e); pt(q[0], q[1]); } g(0, 'SEQEND'); g(8, layerOf(e)); }
          }
          break;
        }
        case 'HATCH': {                                     // R12 has no HATCH: write the pattern lines or solid quads
          const CH = (typeof CadHatch !== 'undefined') ? CadHatch : require('./cadhatch.js');
          if ((CH.PATTERNS[e.pat] || {}).solid) {
            for (const [a, b, c2, d] of CH.trapezoids(CH.polysOf(e, 0.05 * (e.pk || 1)))) { common('SOLID', e); pt(a[0], a[1]); pt(b[0], b[1], 1); pt(d[0], d[1], 2); pt(c2[0], c2[1], 3); }
          } else for (const [a, b] of CH.segments(e)) { common('LINE', e); pt(a[0], a[1]); pt(b[0], b[1], 1); }
          break;
        }
        case 'TEXT': text(e, e.p, e.h, e.rot || 0, e.text); break;
        case 'MTEXT': {
          const c = Math.cos(e.rot || 0), s = Math.sin(e.rot || 0);
          DM.mtextLines(e).forEach((ln, i) => {
            const y = -(i * DM.LH * e.h) - e.h;
            text(e, [e.p[0] - y * s, e.p[1] + y * c], e.h, e.rot || 0, ln);
          });
          break;
        }
        case 'DIM': {
          const gm = DM.geom(e);
          for (const [a, b] of gm.lines) { common('LINE', e); pt(a[0], a[1]); pt(b[0], b[1], 1); }
          for (const ar of gm.arrows) {
            const nn = [-ar.dir[1], ar.dir[0]], base = [ar.tip[0] + ar.dir[0] * ar.size, ar.tip[1] + ar.dir[1] * ar.size], w = ar.size / 3;
            const p2 = [base[0] + nn[0] * w, base[1] + nn[1] * w], p3 = [base[0] - nn[0] * w, base[1] - nn[1] * w];
            common('SOLID', e); pt(ar.tip[0], ar.tip[1]); pt(p2[0], p2[1], 1); pt(p3[0], p3[1], 2); pt(p3[0], p3[1], 3);
          }
          text(e, gm.text.p, gm.text.h, gm.text.rot, gm.text.str, true);
          break;
        }
        default: break;
      }
    }
    g(0, 'ENDSEC'); g(0, 'EOF');
    return out.join('\r\n') + '\r\n';
  }

  // ---------------- reader ----------------
  function pairs(str) {
    const lines = String(str).replace(/^﻿/, '').split(/\r\n|\n|\r/), out = [];
    for (let i = 0; i + 1 < lines.length; i += 2) { const c = parseInt(lines[i].trim(), 10); if (!isNaN(c)) out.push([c, lines[i + 1]]); else i--; }
    return out;
  }
  // Split a flat pair list into records, each starting at a code-0 pair.
  function records(ps) {
    const recs = []; let cur = null;
    for (const p of ps) { if (p[0] === 0) { cur = { type: p[1].trim().toUpperCase(), g: [] }; recs.push(cur); } else if (cur) cur.g.push(p); }
    return recs;
  }
  const first = (r, code) => { const f = r.g.find((p) => p[0] === code); return f ? f[1] : null; };
  const num = (r, code, d) => { const v = first(r, code); const x = v == null ? NaN : parseFloat(v); return isNaN(x) ? d : x; };
  function unescText(s) {
    return String(s).replace(/%%[dD]/g, '°').replace(/%%[pP]/g, '±').replace(/%%[cC]/g, 'Ø').replace(/\\U\+([0-9A-Fa-f]{4})/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
  }
  function unescMtext(s) {
    let t = String(s).replace(/\\P/gi, '\n').replace(/\\~/g, ' ').replace(/\\\\/g, '\u0001');
    t = t.replace(/\\[fFcCtTqQwWaAhH][^;\\]*;/g, '').replace(/\\[LlOoKk]/g, '').replace(/\\S([^;^/#]*)[/^#]([^;]*);/g, '$1/$2').replace(/[{}]/g, '');
    return unescText(t.replace(/\u0001/g, '\\'));
  }
  const colorOf = (r) => { const c = num(r, 62, null); return c != null && c >= 1 && c <= 9 ? c : undefined; };
  const rgbOf = (r) => { const v = num(r, 420, null); return v != null && v >= 0 && (v & 0xff000000) === 0 ? ST.rgbToHex((v >> 16) & 255, (v >> 8) & 255, v & 255) : undefined; };
  // optional per-object style: line type, line weight (1/100 mm), true colour
  const styleOf = (r) => {
    const o = {}, lt = ltFromDxf(first(r, 6)), lw = num(r, 370, null), rgb = rgbOf(r);
    if (lt && lt !== 'Continuous') o.lt = lt;
    if (lw != null && lw >= 0) o.lw = lwNearest(lw);
    if (rgb) o.rgb = rgb;
    return o;
  };

  function entFromRec(r, lw) {
    const layer = (first(r, 8) || '0').trim() || '0', col = colorOf(r), base = { layer, ...styleOf(r) }; if (col) base.color = col;
    switch (r.type) {
      case 'LINE': return { ...base, t: 'LINE', p1: [num(r, 10, 0), num(r, 20, 0)], p2: [num(r, 11, 0), num(r, 21, 0)] };
      case 'CIRCLE': { const rr = num(r, 40, 0); return rr > 0 ? { ...base, t: 'CIRCLE', c: [num(r, 10, 0), num(r, 20, 0)], r: rr } : null; }
      case 'ARC': {
        const rr = num(r, 40, 0); if (!(rr > 0)) return null;
        let a0 = rad(num(r, 50, 0)), a1 = rad(num(r, 51, 0)); const TAU = Math.PI * 2;
        a0 = ((a0 % TAU) + TAU) % TAU; a1 = ((a1 % TAU) + TAU) % TAU; if (a1 <= a0) a1 += TAU;
        return { ...base, t: 'ARC', c: [num(r, 10, 0), num(r, 20, 0)], r: rr, a0, a1 };
      }
      case 'POINT': return { ...base, t: 'POINT', p: [num(r, 10, 0), num(r, 20, 0)] };
      case 'SOLID': {                                             // filled triangle / quad, drawn as its outline
        const q = [0, 1, 2, 3].map((i) => [num(r, 10 + i, 0), num(r, 20 + i, 0)]);
        const pts = [q[0], q[1], q[3], q[2]].filter((p, i, a) => i === 0 || Math.hypot(p[0] - a[i - 1][0], p[1] - a[i - 1][1]) > 1e-9);
        return pts.length >= 3 ? { ...base, t: 'LWPOLYLINE', v: pts.map((p) => [p[0], p[1], 0]), closed: true } : null;
      }
      case 'TEXT': {
        const h = num(r, 40, 0), str = unescText(first(r, 1) || '');
        if (!(h > 0) || !str.trim()) return null;
        // aligned text keeps its position in group 11; approximate to the left baseline using the estimated width
        const hj = num(r, 72, 0), vj = num(r, 73, 0); let p = [num(r, 10, 0), num(r, 20, 0)];
        const rot = rad(num(r, 50, 0));
        if ((hj || vj) && first(r, 11) != null) {
          p = [num(r, 11, p[0]), num(r, 21, p[1])];
          const w = DM.CW * h * str.length * (hj === 1 ? 0.5 : hj === 2 ? 1 : 0), dy = vj === 3 ? 0 : vj === 2 ? -0.5 * h : vj === 1 ? 0 : 0;
          p = [p[0] - Math.cos(rot) * w - Math.sin(rot) * (-dy), p[1] - Math.sin(rot) * w + Math.cos(rot) * (-dy)];
        }
        return { ...base, t: 'TEXT', p, h, rot, text: str };
      }
      case 'MTEXT': {
        const h = num(r, 40, 0); if (!(h > 0)) return null;
        const chunks = r.g.filter((q) => q[0] === 3).map((q) => q[1]).join('') + (first(r, 1) || '');
        const str = unescMtext(chunks).trim(); if (!str) return null;
        let rot = rad(num(r, 50, 0)); if (first(r, 11) != null) rot = Math.atan2(num(r, 21, 0), num(r, 11, 1));
        return { ...base, t: 'MTEXT', p: [num(r, 10, 0), num(r, 20, 0)], h, rot, w: Math.max(0, num(r, 41, 0)), text: str };
      }
      case 'LWPOLYLINE': {
        const v = []; for (const [c, val] of r.g) { if (c === 10) v.push([parseFloat(val), 0, 0]); else if (c === 20 && v.length) v[v.length - 1][1] = parseFloat(val); else if (c === 42 && v.length) v[v.length - 1][2] = parseFloat(val) || 0; }
        return v.length >= 2 ? { ...base, t: 'LWPOLYLINE', v, closed: !!(num(r, 70, 0) & 1) } : null;
      }
      default: return null;
    }
  }
  // Apply insertion transform (uniform scale, rotation, translation about base) to a parsed entity.
  function xf(e, ins) {
    const c = Math.cos(ins.rot), s = Math.sin(ins.rot), k = ins.sx;
    const P = (p) => { const x = (p[0] - ins.bx) * k, y = (p[1] - ins.by) * k; return [ins.x + x * c - y * s, ins.y + x * s + y * c]; };
    const o = JSON.parse(JSON.stringify(e));
    switch (e.t) {
      case 'LINE': o.p1 = P(e.p1); o.p2 = P(e.p2); break;
      case 'CIRCLE': o.c = P(e.c); o.r = e.r * k; break;
      case 'ARC': o.c = P(e.c); o.r = e.r * k; o.a0 = e.a0 + ins.rot; o.a1 = e.a1 + ins.rot; break;
      case 'POINT': o.p = P(e.p); break;
      case 'TEXT': o.p = P(e.p); o.h = e.h * k; o.rot = (e.rot || 0) + ins.rot; break;
      case 'MTEXT': o.p = P(e.p); o.h = e.h * k; o.w = e.w * k; o.rot = (e.rot || 0) + ins.rot; break;
      case 'LWPOLYLINE': o.v = e.v.map((q) => { const p = P(q); return [p[0], p[1], q[2]]; }); break;
      default: break;
    }
    return o;
  }

  function read(str) {
    const recs = records(pairs(str));
    // split into sections
    const sections = {}; let name = null, cur = null;
    for (const r of recs) {
      if (r.type === 'SECTION') { name = (first(r, 2) || '').trim().toUpperCase(); cur = sections[name] = []; }
      else if (r.type === 'ENDSEC') { cur = null; }
      else if (cur) cur.push(r);
    }
    // header
    let units = 'mm';
    const hdr = pairs(str); for (let i = 0; i < hdr.length - 1; i++) { if (hdr[i][0] === 9 && hdr[i][1].trim() === '$INSUNITS') { const v = parseInt(hdr[i + 1][1], 10); units = v === 1 ? 'in' : v === 6 ? 'm' : 'mm'; break; } }
    // layers
    const layers = [{ name: '0', color: 7, ltype: 'Continuous', lw: -3, on: true, frozen: false, locked: false, plot: true }];
    for (const r of (sections.TABLES || [])) {
      if (r.type !== 'LAYER') continue;
      const nm = (first(r, 2) || '').trim(); if (!nm) continue;
      const col = num(r, 62, 7), flags = num(r, 70, 0), lwv = num(r, 370, -3), rgb = rgbOf(r);
      const L = { name: nm, color: ACI_FIX(Math.abs(col)), ltype: ltFromDxf(first(r, 6)) || 'Continuous', lw: lwv >= 0 ? lwNearest(lwv) : -3, on: col >= 0, frozen: !!(flags & 1), locked: !!(flags & 4), plot: num(r, 290, 1) !== 0 };
      if (rgb) L.rgb = rgb;
      const ex = layers.find((l) => l.name === nm); if (ex) Object.assign(ex, L, { name: nm }); else layers.push(L);
    }
    function ACI_FIX(c) { return c >= 1 && c <= 9 ? c : 7; }
    // entities in a record list (POLYLINE consumes its VERTEX/SEQEND)
    const skipped = {};
    const skip = (t) => { skipped[t] = (skipped[t] || 0) + 1; };
    const blocks = {};
    for (let i = 0; i < (sections.BLOCKS || []).length; i++) {
      const r = sections.BLOCKS[i]; if (r.type !== 'BLOCK') continue;
      const nm = (first(r, 2) || '').trim(), body = [];
      for (i++; i < sections.BLOCKS.length && sections.BLOCKS[i].type !== 'ENDBLK'; i++) body.push(sections.BLOCKS[i]);
      blocks[nm] = { bx: num(r, 10, 0), by: num(r, 20, 0), recs: body };
    }
    function parseList(list, out, depth, ins, layerIn) {
      for (let i = 0; i < list.length; i++) {
        const r = list[i];
        let e = null;
        if (r.type === 'POLYLINE') {
          const fl = num(r, 70, 0), v = [];
          for (i++; i < list.length && list[i].type !== 'SEQEND'; i++) { if (list[i].type === 'VERTEX') v.push([num(list[i], 10, 0), num(list[i], 20, 0), num(list[i], 42, 0)]); }
          if (fl & (16 | 64)) { skip('POLYLINE (3D mesh)'); continue; }
          if (v.length >= 2) e = { t: 'LWPOLYLINE', v, closed: !!(fl & 1), layer: (first(r, 8) || '0').trim() || '0', ...styleOf(r), ...(colorOf(r) ? { color: colorOf(r) } : {}) };
        } else if (r.type === 'INSERT') {
          const bn = (first(r, 2) || '').trim(), B = blocks[bn];
          const sx = num(r, 41, 1), sy = num(r, 42, sx);
          if (!B) { skip('INSERT (missing block)'); continue; }
          if (depth >= 4) { skip('INSERT (nested too deep)'); continue; }
          if (Math.abs(Math.abs(sx) - Math.abs(sy)) > 1e-9 || sx < 0 || sy < 0) { skip('INSERT (mirrored or non-uniform scale)'); continue; }
          if (num(r, 70, 1) > 1 || num(r, 71, 1) > 1) { skip('INSERT (array)'); continue; }
          const sub = [];
          parseList(B.recs, sub, depth + 1, null, (first(r, 8) || '0').trim() || '0');
          const t = { x: num(r, 10, 0), y: num(r, 20, 0), sx, rot: rad(num(r, 50, 0)), bx: B.bx, by: B.by };
          for (const se of sub) { const m = xf(se, t); out.push(m); }
          continue;
        } else if (['LINE', 'CIRCLE', 'ARC', 'POINT', 'SOLID', 'TEXT', 'MTEXT', 'LWPOLYLINE'].includes(r.type)) e = entFromRec(r);
        else if (['VERTEX', 'SEQEND', 'ATTRIB', 'ATTDEF', 'ENDBLK', 'BLOCK'].includes(r.type)) continue;
        else { skip(r.type); continue; }
        if (e) { if (e.layer === '0' && layerIn && depth > 0) e.layer = layerIn; out.push(e); }
      }
    }
    const raw = []; parseList(sections.ENTITIES || [], raw, 0);
    // ids and layers
    const entities = []; let nextId = 1;
    for (const e of raw) {
      if (!layers.some((l) => l.name === e.layer)) layers.push({ name: e.layer, color: 7, ltype: 'Continuous', lw: -3, on: true, frozen: false, locked: false, plot: true });
      e.id = 'e' + (nextId++); entities.push(e);
    }
    return { entities, layers, units, nextId, skipped };
  }

  return { write, writePlan, read };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = CadDxf;
