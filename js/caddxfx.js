// caddxfx.js — DXF writer for AutoCAD 2000 (AC1015) and AutoCAD 2018 (AC1032). No DOM; testable in Node. Global `CadDxfX`.
//
// Unlike the R12 writer (caddxf.js) this one writes real AutoCAD objects:
//   LWPOLYLINE, MTEXT, HATCH (solid and line patterns, with the same scale and angle), symbols as BLOCK + INSERT,
//   layers with lineweights, layouts (paper space tabs) with VIEWPORTs at their scales, window shapes,
//   frozen layers per viewport, the sheet frame and title block.
// Dimensions are still written as lines, arrow solids and text (they stay editable in Inspector only).
// Pictures (underlays) are not written.
// Files are ASCII: any character above 127 is written as \U+XXXX, which AutoCAD reads in TEXT and MTEXT.

const CadDxfX = (() => {
  'use strict';
  const DM = (typeof CadDim !== 'undefined') ? CadDim : require('./caddim.js');
  const ST = (typeof CadStyle !== 'undefined') ? CadStyle : require('./cadstyle.js');
  const G = (typeof CadGeo !== 'undefined') ? CadGeo : require('./cadgeo.js');
  const CH = (typeof CadHatch !== 'undefined') ? CadHatch : require('./cadhatch.js');
  const SY = (typeof CadSym !== 'undefined') ? CadSym : require('./cadsym.js');
  const VP = (typeof CadVp !== 'undefined') ? CadVp : require('./cadvp.js');
  const PL = (typeof CadPlot !== 'undefined') ? CadPlot : require('./cadplot.js');
  const n = (v) => { const s = (+v).toFixed(8); return s.indexOf('.') >= 0 ? s.replace(/0+$/, '').replace(/\.$/, '') : s; };
  const deg = (r) => r * 180 / Math.PI;
  const LT_UP = (name) => String(name || 'Continuous').toUpperCase();
  const cleanName = (s) => String(s || '0').replace(/[<>/\\":;?*|=`,]/g, '_').slice(0, 255) || '0';
  const UNITS_CODE = { in: 1, mm: 4, m: 6 };
  const UNIT_MM = { mm: 1, m: 1000, in: 25.4 };
  const esc = (s) => String(s == null ? '' : s).replace(/[^\x20-\x7e]/g, (c) => (c === '\n' || c === '\r' ? ' ' : '\\U+' + c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')));
  const mesc = (s) => String(s).split(/\r\n|\n|\r/).map((ln) => esc(ln.replace(/\\/g, '\\\\').replace(/[{}]/g, (c) => '\\' + c))).join('\\P');
  const rgbInt = (hex) => { const m = /^#?([0-9a-f]{6})$/i.exec(hex || ''); return m ? parseInt(m[1], 16) : null; };
  const lwOk = (v) => (v != null && v >= 0 ? ST.LW_LIST.reduce((b, x) => (Math.abs(x - v) < Math.abs(b - v) ? x : b), ST.LW_LIST[0]) : -3);
  const app = (dst, src) => { for (let i = 0; i < src.length; i++) dst.push(src[i]); };
  const buf = () => { const a = []; const f = (c, v) => { a.push(String(c), String(v)); }; f.a = a; return f; };

  function write(data, opts) {
    const o = Object.assign({ version: 'R2000', layouts: true }, opts || {});
    const ver = o.version === 'R2018' ? 'AC1032' : 'AC1015', modern = ver === 'AC1032';
    let hn = 1; const H = () => (hn++).toString(16).toUpperCase();
    const units = data.units || 'mm', um = UNIT_MM[units] || 1;
    const model = data.entities || [];

    // ---- layers, linetypes ----
    const layers = (data.layers && data.layers.length ? data.layers : [{ name: '0', color: 7 }]).map((l) => ({ ...l, name: cleanName(l.name) }));
    const lnames = new Set(layers.map((l) => l.name));
    const addLayer = (l) => { if (!lnames.has(l.name)) { lnames.add(l.name); layers.push(l); } };
    if (!lnames.has('0')) layers.unshift({ name: '0', color: 7 });
    const lay = (data.layouts || []).filter(() => o.layouts);
    const allEnts = model.concat(...lay.map((l) => l.entities || []));
    for (const e of allEnts) addLayer({ name: cleanName(e.layer), color: 7 });
    addLayer({ name: 'SHEET', color: 7, lw: 25 });
    addLayer({ name: 'VPORT_NOPLOT', color: 8, plot: false });
    const layerH = new Map(layers.map((l) => [l.name, H()]));
    const ltNames = Object.keys(ST.LINETYPES);

    // ---- infrastructure handles ----
    const hModelBR = H(), hPaperBR0 = H(), hRootDict = H(), hGroupDict = H(), hLayoutDict = H(), hPsDict = H(), hPlaceholder = H(), hModelLayout = H();
    const paper = (lay.length ? lay : [{ id: '_auto', name: 'Layout1', size: 'A3', landscape: true, entities: [], tb: {} }]).map((l, i) => ({
      l, name: cleanName(l.name || 'Layout' + (i + 1)), brName: i === 0 ? '*Paper_Space' : '*Paper_Space' + (i - 1), br: i === 0 ? hPaperBR0 : H(), bh: H(), eh: H(), lh: H(), ents: buf()
    }));
    const usedNames = new Set(['Model']);
    for (const p of paper) { let nm = p.name, k = 2; while (usedNames.has(nm)) nm = p.name + '_' + k++; p.name = nm; usedNames.add(nm); }

    const blocks = [];      // symbol blocks: {name, br, bh, eh, ents:buf}
    let symN = 0;

    // ---- entity emitters ----
    function head(f, type, e, owner, inPaper, sub, forceLayer) {
      const h = H();
      f(0, type); f(5, h); f(330, owner); f(100, 'AcDbEntity');
      if (inPaper) f(67, 1);
      f(8, forceLayer || cleanName(e && e.layer));
      if (e && e.lt && e.lt !== 'Continuous' && ST.LINETYPES[e.lt]) f(6, LT_UP(e.lt));
      if (e && e.rgb && rgbInt(e.rgb) != null) { f(62, ST.nearestAci(e.rgb)); f(420, rgbInt(e.rgb)); }
      else if (e && e.color != null && e.color >= 0 && e.color <= 255) f(62, e.color);
      if (e && e.lw != null && e.lw >= 0) f(370, lwOk(e.lw));
      if (sub) f(100, sub);
      return h;
    }
    const pt3 = (f, i, x, y) => { f(10 + i, n(x)); f(20 + i, n(y)); f(30 + i, 0); };
    function lwpoly(f, e, owner, inPaper, v, closed, layerOverride) {
      head(f, 'LWPOLYLINE', e, owner, inPaper, 'AcDbPolyline', layerOverride);
      f(90, v.length); f(70, closed ? 1 : 0);
      for (const q of v) { f(10, n(q[0])); f(20, n(q[1])); if (q[2]) f(42, n(q[2])); }
    }
    function text(f, e, owner, inPaper, p, h, rot, str, center) {
      head(f, 'TEXT', e, owner, inPaper, 'AcDbText');
      pt3(f, 0, p[0], p[1]); f(40, n(h)); f(1, esc(str)); if (rot) f(50, n(deg(rot)));
      f(7, 'Standard');
      if (center) { f(72, 1); pt3(f, 1, p[0], p[1]); }
      f(100, 'AcDbText'); if (center) f(73, 0);
    }
    // Real HATCH. loops: rings of [x,y,bulge]; pattern: null for solid or {fam:[...], unit, ang, name}.
    function hatch(f, e, owner, inPaper, loops, pattern, layerOverride) {
      head(f, 'HATCH', e, owner, inPaper, 'AcDbHatch', layerOverride);
      f(10, 0); f(20, 0); f(30, 0); f(210, 0); f(220, 0); f(230, 1);
      f(2, pattern ? pattern.name : 'SOLID'); f(70, pattern ? 0 : 1); f(71, 0);
      f(91, loops.length);
      loops.forEach((lp, i) => {
        const hb = lp.some((q) => q[2]);
        f(92, i === 0 ? 3 : 2); f(72, hb ? 1 : 0); f(73, 1); f(93, lp.length);
        for (const q of lp) { f(10, n(q[0])); f(20, n(q[1])); if (hb) f(42, n(q[2] || 0)); }
        f(97, 0);
      });
      f(75, 0); f(76, 1);
      if (pattern) {
        f(52, n(deg(pattern.ang))); f(41, n(pattern.unit)); f(77, 0); f(78, pattern.lines.length);
        for (const L of pattern.lines) {
          f(53, n(L.ang)); f(43, n(L.bx)); f(44, n(L.by)); f(45, n(L.ox)); f(46, n(L.oy)); f(79, L.dash.length);
          for (const d of L.dash) f(49, n(d));
        }
      }
      f(47, 1); f(98, 0);
    }
    // Pattern definition lines (paper mm; AutoCAD applies the scale and angle), same families as Inspector's own hatching.
    function patternOf(e) {
      const pat = CH.PATTERNS[e.pat]; if (!pat || !pat.fam) return null;
      const lines = pat.fam.map((fm) => {
        const a = fm.ang * Math.PI / 180, ux = Math.cos(a), uy = Math.sin(a), nx = -uy, ny = ux, off = fm.off || 0, ph = fm.phase || 0;
        return { ang: fm.ang, bx: nx * off - ux * ph, by: ny * off - uy * ph, ox: nx * fm.sp, oy: ny * fm.sp, dash: fm.dash ? fm.dash.map((v, i) => (i % 2 ? -v : v)) : [] };
      });
      return { name: 'INSP_' + String(e.pat).toUpperCase(), lines, unit: (e.pk || 1) * (e.sc || 1), ang: e.ang || 0 };
    }

    function emit(f, e, owner, inPaper, c) {
      const L = (type, sub) => head(f, type, e, owner, inPaper, sub);
      switch (e.t) {
        case 'LINE': L('LINE', 'AcDbLine'); pt3(f, 0, e.p1[0], e.p1[1]); pt3(f, 1, e.p2[0], e.p2[1]); break;
        case 'CIRCLE': L('CIRCLE', 'AcDbCircle'); pt3(f, 0, e.c[0], e.c[1]); f(40, n(e.r)); break;
        case 'ARC': L('ARC', 'AcDbCircle'); pt3(f, 0, e.c[0], e.c[1]); f(40, n(e.r)); f(100, 'AcDbArc'); f(50, n(deg(e.a0))); f(51, n(deg(e.a1))); break;
        case 'POINT': L('POINT', 'AcDbPoint'); pt3(f, 0, e.p[0], e.p[1]); break;
        case 'LWPOLYLINE': lwpoly(f, e, owner, inPaper, e.v, e.closed); break;
        case 'TEXT': text(f, e, owner, inPaper, e.p, e.h, e.rot || 0, e.text); break;
        case 'MTEXT': {
          L('MTEXT', 'AcDbMText'); pt3(f, 0, e.p[0], e.p[1]); f(40, n(e.h)); if (e.w > 0) f(41, n(e.w)); f(71, 1); f(72, 1);
          const s = mesc(e.text); for (let i = 0; i < s.length; i += 250) { const part = s.slice(i, i + 250); f(i + 250 >= s.length ? 1 : 3, part); }
          if (!s.length) f(1, '');
          f(7, 'Standard'); if (e.rot) f(50, n(deg(e.rot))); f(73, 1); f(44, n(DM.LH / (5 / 3)));
          break;
        }
        case 'HATCH': {
          const pt = CH.PATTERNS[e.pat] || CH.PATTERNS.Lines;
          if (!e.loops || !e.loops.length) break;
          if (pt.solid) hatch(f, e, owner, inPaper, e.loops, null);
          else if (pt.fam) hatch(f, e, owner, inPaper, e.loops, patternOf(e));
          else {                                                  // stipple patterns (concrete, sand, gravel): the marks become one block
            const name = 'INSP_HATCH_' + (++symN), blk = { name, br: H(), bh: H(), eh: H(), ents: buf() };
            for (const [a, b] of CH.segments(e)) { head(blk.ents, 'LINE', { layer: '0', color: 0 }, blk.br, false, 'AcDbLine', '0'); pt3(blk.ents, 0, a[0], a[1]); pt3(blk.ents, 1, b[0], b[1]); }
            blocks.push(blk); head(f, 'INSERT', e, owner, inPaper, 'AcDbBlockReference'); f(2, name); pt3(f, 0, 0, 0);
          }
          break;
        }
        case 'SYM': {
          const name = 'INSP_SYM_' + (++symN), blk = { name, br: H(), bh: H(), eh: H(), ents: buf() };
          for (const sh of SY.shapes(e)) {
            const v = sh.pts.map((q) => [q[0] - e.p[0], q[1] - e.p[1], 0]);
            if (sh.fill) hatch(blk.ents, { layer: '0', color: 0 }, blk.br, false, [v], null, '0');
            if (!sh.fill || sh.closed) lwpoly(blk.ents, { layer: '0', color: 0 }, blk.br, false, v, sh.closed, '0');
          }
          blocks.push(blk);
          head(f, 'INSERT', e, owner, inPaper, 'AcDbBlockReference'); f(2, name); pt3(f, 0, e.p[0], e.p[1]);
          break;
        }
        case 'DIM': {
          const gm = DM.geom(e);
          for (const [a, b] of gm.lines) { L('LINE', 'AcDbLine'); pt3(f, 0, a[0], a[1]); pt3(f, 1, b[0], b[1]); }
          for (const ar of gm.arrows) {
            const nn = [-ar.dir[1], ar.dir[0]], base = [ar.tip[0] + ar.dir[0] * ar.size, ar.tip[1] + ar.dir[1] * ar.size], w = ar.size / 3;
            const p2 = [base[0] + nn[0] * w, base[1] + nn[1] * w], p3 = [base[0] - nn[0] * w, base[1] - nn[1] * w];
            L('SOLID', 'AcDbTrace'); pt3(f, 0, ar.tip[0], ar.tip[1]); pt3(f, 1, p2[0], p2[1]); pt3(f, 2, p3[0], p3[1]); pt3(f, 3, p3[0], p3[1]);
          }
          text(f, e, owner, inPaper, gm.text.p, gm.text.h, gm.text.rot, gm.text.str, true);
          break;
        }
        default: break;
      }
    }

    // ---- model space ----
    const modelF = buf();
    for (const e of model) emit(modelF, e, hModelBR, false);

    // ---- paper space ----
    let vpId = 1;
    const sheets = paper.map((p, idx) => {
      const lyt = p.l, ly = PL.layout(lyt.size || 'A3', lyt.landscape !== false), f = p.ents;
      const W = ly.w, Hh = ly.h;
      const vpEnt = (cx, cy, w, h, st, id, view, flags, layerName, frozen, clipH) => {
        const hh = H();
        f(0, 'VIEWPORT'); f(5, hh); f(330, p.br); f(100, 'AcDbEntity'); f(67, 1); f(8, layerName); f(100, 'AcDbViewport');
        f(10, n(cx)); f(20, n(cy)); f(30, 0); f(40, n(w)); f(41, n(h)); f(68, st); f(69, id);
        f(12, n(view.cx)); f(22, n(view.cy)); f(13, 0); f(23, 0); f(14, 0.5); f(24, 0.5); f(15, 0.5); f(25, 0.5);
        f(16, 0); f(26, 0); f(36, 1); f(17, 0); f(27, 0); f(37, 0);
        f(42, 50); f(43, 0); f(44, 0); f(45, n(view.h)); f(50, 0); f(51, 0); f(72, 1000); f(90, flags);
        if (clipH) f(340, clipH);
        for (const fz of frozen || []) { const lh = layerH.get(cleanName(fz)); if (lh) f(331, lh); }
        f(281, 0); f(71, 1); f(74, 0);
        return hh;
      };
      // the sheet itself (paper viewport 1) comes first, then the user viewports
      vpEnt(W / 2, Hh / 2, W, Hh, 2, 1, { cx: W / 2, cy: Hh / 2, h: Hh }, 32864, '0', null, null);
      let order = 0;
      for (const e of lyt.entities || []) {
        if (e.t !== 'VPORT') { emit(f, e, p.br, true); continue; }
        const b = VP.box(e), w = b.maxX - b.minX, h = b.maxY - b.minY, rect = VP.rectOf(e) != null, lname = e.bd === false ? 'VPORT_NOPLOT' : '0';
        let clipH = null;
        if (!rect) {                                                // the window outline is the clip boundary (drawn on the viewport layer)
          const ring = (e.loops && e.loops[0]) || [];
          const hc = H(); const tmp = buf();
          // write the boundary polyline with a known handle
          tmp(0, 'LWPOLYLINE'); tmp(5, hc); tmp(330, p.br); tmp(100, 'AcDbEntity'); tmp(67, 1); tmp(8, lname); tmp(100, 'AcDbPolyline');
          tmp(90, ring.length); tmp(70, 1); for (const q of ring) { tmp(10, n(q[0])); tmp(20, n(q[1])); if (q[2]) tmp(42, n(q[2])); }
          app(f.a, tmp.a); clipH = hc;
        }
        const cxm = e.cx, cym = e.cy, viewH = h * (e.sc || 50) / (e.um || um);
        vpEnt((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, w, h, ++order, ++vpId, { cx: cxm, cy: cym, h: viewH }, 32864 | (e.lock ? 16384 : 0) | (rect ? 0 : 65536), lname, e.fz, clipH);
      }
      // frame, title block
      const si = PL.sheetItems(lyt, data), items = si.items;
      const own = { layer: 'SHEET' };
      for (const it of items) {
        if (it.k === 'poly') lwpoly(f, { layer: 'SHEET', rgb: it.color }, p.br, true, it.pts.map((q) => [q[0], q[1], 0]), !!it.closed);
        else if (it.k === 'segs') for (const [a, b] of it.segs) { head(f, 'LINE', { layer: 'SHEET', rgb: it.color }, p.br, true, 'AcDbLine'); pt3(f, 0, a[0], a[1]); pt3(f, 1, b[0], b[1]); }
        else if (it.k === 'fill') hatch(f, { layer: 'SHEET', rgb: it.color }, p.br, true, [it.pts.map((q) => [q[0], q[1], 0])], null);
        else if (it.k === 'text') {
          const w = it.align === 'center' ? DM.CW * it.h * String(it.str).length / 2 : 0;
          text(f, { layer: 'SHEET', rgb: it.color }, p.br, true, [it.p[0] - Math.cos(it.rot || 0) * w, it.p[1] - Math.sin(it.rot || 0) * w], it.h, it.rot || 0, it.str);
        }
      }
      void own;
      return { W, Hh };
    });

    // ---- extents ----
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const e of model) { const b = G.bbox(e); if (b && isFinite(b.minX)) { x0 = Math.min(x0, b.minX); y0 = Math.min(y0, b.minY); x1 = Math.max(x1, b.maxX); y1 = Math.max(y1, b.maxY); } }
    if (!isFinite(x0)) { x0 = y0 = 0; x1 = y1 = 1; }

    // ===== assemble =====
    const out = buf(), f = out;
    // HEADER
    f(0, 'SECTION'); f(2, 'HEADER');
    f(9, '$ACADVER'); f(1, ver);
    f(9, '$HANDSEED'); f(5, '@@HANDSEED@@');
    f(9, '$INSBASE'); f(10, 0); f(20, 0); f(30, 0);
    f(9, '$EXTMIN'); f(10, n(x0)); f(20, n(y0)); f(30, 0);
    f(9, '$EXTMAX'); f(10, n(x1)); f(20, n(y1)); f(30, 0);
    f(9, '$LTSCALE'); f(40, 1);
    f(9, '$INSUNITS'); f(70, UNITS_CODE[units] || 4);
    f(9, '$MEASUREMENT'); f(70, 1);
    f(9, '$LWDISPLAY'); f(290, 0);
    f(9, '$CLAYER'); f(8, '0');
    f(9, '$TEXTSTYLE'); f(7, 'Standard');
    f(9, '$CELTYPE'); f(6, 'ByLayer');
    f(9, '$CECOLOR'); f(62, 256);
    f(9, '$TILEMODE'); f(70, 1);
    f(9, '$DWGCODEPAGE'); f(3, 'ANSI_1252');
    f(0, 'ENDSEC');
    // CLASSES
    f(0, 'SECTION'); f(2, 'CLASSES');
    const klass = (name, cpp, app, ent, cnt) => { f(0, 'CLASS'); f(1, name); f(2, cpp); f(3, app); f(90, 0); if (modern) f(91, cnt || 0); f(280, 0); f(281, ent ? 1 : 0); };
    klass('HATCH', 'AcDbHatch', 'AutoCAD 2000', true); klass('LWPOLYLINE', 'AcDbPolyline', 'AutoCAD 2000', true);
    klass('LAYOUT', 'AcDbLayout', 'AutoCAD 2000', false); klass('ACDBDICTIONARYWDFLT', 'AcDbDictionaryWithDefault', 'AutoCAD 2000', false); klass('ACDBPLACEHOLDER', 'AcDbPlaceHolder', 'AutoCAD 2000', false);
    f(0, 'ENDSEC');
    // TABLES
    f(0, 'SECTION'); f(2, 'TABLES');
    const table = (name, count, fn) => { const th = H(); f(0, 'TABLE'); f(2, name); f(5, th); f(330, 0); f(100, 'AcDbSymbolTable'); f(70, count); fn(th); f(0, 'ENDTAB'); };
    const rec = (type, th, sub) => { f(0, type); f(5, H()); f(330, th); f(100, 'AcDbSymbolTableRecord'); f(100, sub); };
    table('VPORT', 1, (th) => {
      rec('VPORT', th, 'AcDbViewportTableRecord'); f(2, '*Active'); f(70, 0); f(10, 0); f(20, 0); f(11, 1); f(21, 1);
      f(12, n((x0 + x1) / 2)); f(22, n((y0 + y1) / 2)); f(13, 0); f(23, 0); f(14, 10); f(24, 10); f(15, 10); f(25, 10);
      f(16, 0); f(26, 0); f(36, 1); f(17, 0); f(27, 0); f(37, 0); f(40, n(Math.max((y1 - y0) * 1.1, 1e-6))); f(41, 1.5); f(42, 50); f(43, 0); f(44, 0); f(50, 0); f(51, 0);
      f(71, 0); f(72, 100); f(73, 1); f(74, 3); f(75, 0); f(76, 0); f(77, 0); f(78, 0);
    });
    table('LTYPE', 3 + ltNames.length - 1, (th) => {
      const lt = (nm, desc, pat) => {
        rec('LTYPE', th, 'AcDbLinetypeTableRecord'); f(2, nm); f(70, 0); f(3, desc); f(72, 65); f(73, pat.length); f(40, n(pat.reduce((a, b) => a + Math.abs(b), 0)));
        pat.forEach((v) => { f(49, n(v)); f(74, 0); });
      };
      lt('ByBlock', '', []); lt('ByLayer', '', []); lt('CONTINUOUS', 'Solid line', []);
      for (const nm of ltNames) {
        if (nm === 'Continuous') continue;
        const pat = ST.dashModel(data, nm); lt(LT_UP(nm), ST.LT_NOTE[nm] || '', pat.map((v, i) => (i % 2 === 0 ? (v < 1e-6 ? 0 : v) : -v)));
      }
    });
    table('LAYER', layers.length, (th) => {
      for (const l of layers) {
        f(0, 'LAYER'); f(5, layerH.get(l.name)); f(330, th); f(100, 'AcDbSymbolTableRecord'); f(100, 'AcDbLayerTableRecord');
        f(2, l.name); f(70, (l.frozen ? 1 : 0) | (l.locked ? 4 : 0));
        f(62, (l.on === false ? -1 : 1) * (l.rgb ? ST.nearestAci(l.rgb) : (l.color >= 1 && l.color <= 255 ? l.color : 7)));
        if (l.rgb && rgbInt(l.rgb) != null) f(420, rgbInt(l.rgb));
        f(6, ST.LINETYPES[l.ltype] ? LT_UP(l.ltype) : 'CONTINUOUS'); f(290, l.plot === false ? 0 : 1); f(370, lwOk(l.lw));
      }
    });
    table('STYLE', 1, (th) => { rec('STYLE', th, 'AcDbTextStyleTableRecord'); f(2, 'Standard'); f(70, 0); f(40, 0); f(41, 1); f(50, 0); f(71, 0); f(42, 2.5); f(3, 'arial.ttf'); f(4, ''); });
    table('VIEW', 0, () => {});
    table('UCS', 0, () => {});
    table('APPID', 1, (th) => { rec('APPID', th, 'AcDbRegAppTableRecord'); f(2, 'ACAD'); f(70, 0); });
    table('DIMSTYLE', 1, (th) => { f(100, 'AcDbDimStyleTable'); f(71, 1); f(0, 'DIMSTYLE'); f(105, H()); f(330, th); f(100, 'AcDbSymbolTableRecord'); f(100, 'AcDbDimStyleTableRecord'); f(2, 'Standard'); f(70, 0); });
    table('BLOCK_RECORD', 2 + paper.length - 1 + blocks.length + 1 - 1, (th) => {
      const br = (h, nm, layoutH) => { f(0, 'BLOCK_RECORD'); f(5, h); f(330, th); f(100, 'AcDbSymbolTableRecord'); f(100, 'AcDbBlockTableRecord'); f(2, nm); f(340, layoutH || 0); if (modern) { f(70, 0); f(280, 1); f(281, 0); } };
      br(hModelBR, '*Model_Space', hModelLayout);
      for (const p of paper) br(p.br, p.brName, p.lh);
      for (const b of blocks) br(b.br, b.name, 0);
    });
    f(0, 'ENDSEC');
    // BLOCKS
    f(0, 'SECTION'); f(2, 'BLOCKS');
    const block = (bh, eh, br, nm, inPaper, body) => {
      f(0, 'BLOCK'); f(5, bh); f(330, br); f(100, 'AcDbEntity'); if (inPaper) f(67, 1); f(8, '0'); f(100, 'AcDbBlockBegin'); f(2, nm); f(70, 0); f(10, 0); f(20, 0); f(30, 0); f(3, nm); f(1, '');
      if (body) app(out.a, body.a);
      f(0, 'ENDBLK'); f(5, eh); f(330, br); f(100, 'AcDbEntity'); if (inPaper) f(67, 1); f(8, '0'); f(100, 'AcDbBlockEnd');
    };
    block(H(), H(), hModelBR, '*Model_Space', false, null);
    paper.forEach((p, i) => block(p.bh, p.eh, p.br, p.brName, true, i === 0 ? null : p.ents));
    for (const b of blocks) block(b.bh, b.eh, b.br, b.name, false, b.ents);
    f(0, 'ENDSEC');
    // ENTITIES
    f(0, 'SECTION'); f(2, 'ENTITIES');
    app(out.a, modelF.a);
    if (paper.length) app(out.a, paper[0].ents.a);
    f(0, 'ENDSEC');
    // OBJECTS
    f(0, 'SECTION'); f(2, 'OBJECTS');
    f(0, 'DICTIONARY'); f(5, hRootDict); f(330, 0); f(100, 'AcDbDictionary'); f(281, 1);
    f(3, 'ACAD_GROUP'); f(350, hGroupDict); f(3, 'ACAD_LAYOUT'); f(350, hLayoutDict); f(3, 'ACAD_PLOTSTYLENAME'); f(350, hPsDict);
    const sub = (h, owner) => { f(5, h); f(102, '{ACAD_REACTORS'); f(330, owner); f(102, '}'); f(330, owner); };
    f(0, 'DICTIONARY'); sub(hGroupDict, hRootDict); f(100, 'AcDbDictionary'); f(281, 1);
    f(0, 'DICTIONARY'); sub(hLayoutDict, hRootDict); f(100, 'AcDbDictionary'); f(281, 1);
    f(3, 'Model'); f(350, hModelLayout); for (const p of paper) { f(3, p.name); f(350, p.lh); }
    f(0, 'ACDBDICTIONARYWDFLT'); sub(hPsDict, hRootDict); f(100, 'AcDbDictionary'); f(281, 1); f(3, 'Normal'); f(350, hPlaceholder); f(100, 'AcDbDictionaryWithDefault'); f(340, hPlaceholder);
    f(0, 'ACDBPLACEHOLDER'); f(5, hPlaceholder); f(102, '{ACAD_REACTORS'); f(330, hPsDict); f(102, '}'); f(330, hPsDict);
    const layoutObj = (h, name, tab, brH, w, hh, vpH) => {
      f(0, 'LAYOUT'); sub(h, hLayoutDict);
      f(100, 'AcDbPlotSettings'); f(1, ''); f(2, 'none_device'); f(4, ''); f(6, '');
      f(40, 0); f(41, 0); f(42, 0); f(43, 0); f(44, n(w)); f(45, n(hh)); f(46, 0); f(47, 0); f(48, 0); f(49, 0);
      f(140, 0); f(141, 0); f(142, 1); f(143, 1); f(70, 688); f(72, 1); f(73, 0); f(74, 5); f(7, ''); f(75, 16); f(76, 0); f(77, 2); f(78, 300);
      f(147, 1); f(148, 0); f(149, 0);
      f(100, 'AcDbLayout'); f(1, name); f(70, 1); f(71, tab);
      f(10, 0); f(20, 0); f(11, n(w)); f(21, n(hh)); f(12, 0); f(22, 0); f(32, 0);
      f(14, 0); f(24, 0); f(34, 0); f(15, n(w)); f(25, n(hh)); f(35, 0); f(146, 0);
      f(13, 0); f(23, 0); f(33, 0); f(16, 1); f(26, 0); f(36, 0); f(17, 0); f(27, 1); f(37, 0); f(76, 0);
      f(330, brH); if (vpH) f(331, vpH);
    };
    layoutObj(hModelLayout, 'Model', 0, hModelBR, 420, 297, null);
    paper.forEach((p, i) => layoutObj(p.lh, p.name, i + 1, p.br, sheets[i].W, sheets[i].Hh, null));
    f(0, 'ENDSEC'); f(0, 'EOF');
    const hs = out.a.indexOf('@@HANDSEED@@'); out.a[hs] = hn.toString(16).toUpperCase();
    return out.a.join('\r\n') + '\r\n';
  }

  return { write };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = CadDxfX;
