// cadstyle.js — colours, line types and line weights shared by the editor, the plotter and DXF.
// No DOM; testable in Node. Global `CadStyle`.
//
//   layer:  { name, color (ACI 1-9), rgb (optional '#rrggbb', wins over color), ltype (name), lw (1/100 mm, -3 = drawing default), on, frozen, locked, plot }
//   entity: optional rgb, color (ACI), lt (line type name), lw (1/100 mm). Missing = ByLayer.
//   doc:    defaultLw (mm, 0.25), ltScale (1), pens { '#rrggbb': { color:'#rrggbb'|null, lw: mm|null } } for plotting.
// Dash patterns are defined in millimetres on paper at the drawing's plot scale, then converted to
// model units, so a dashed line has the same dash length at any zoom and prints at that length when
// the print scale equals the plot scale.

const CadStyle = (() => {
  'use strict';
  const ACI = { 1: '#d32f2f', 2: '#b8860b', 3: '#2e7d32', 4: '#00838f', 5: '#1565c0', 6: '#8e24aa', 7: '#111111', 8: '#808080', 9: '#a0a0a0' };
  const ACI_NAMES = { 1: 'Red', 2: 'Yellow', 3: 'Green', 4: 'Cyan', 5: 'Blue', 6: 'Magenta', 7: 'Black', 8: 'Dark grey', 9: 'Light grey' };
  // on, off, on, off ... in paper millimetres
  const LINETYPES = {
    Continuous: [],
    Dashed: [12, 6],
    Hidden: [6, 3],
    Center: [32, 6, 6, 6],
    Phantom: [32, 6, 6, 6, 6, 6],
    Dot: [0.5, 5],
    DashDot: [12, 6, 0.5, 6]
  };
  const LT_NOTE = { Continuous: 'Solid line', Dashed: 'Dashed __ __ __', Hidden: 'Hidden - - - -', Center: 'Center ___ _ ___ _', Phantom: 'Phantom ___ _ _ ___', Dot: 'Dot . . . .', DashDot: 'Dash dot __ . __ .' };
  const LW_LIST = [5, 9, 13, 15, 18, 20, 25, 30, 35, 40, 50, 53, 60, 70, 80, 90, 100, 106, 120, 140, 158, 200, 211];
  const UNIT_PER_MM = { mm: 1, m: 0.001, in: 1 / 25.4 };

  const layerOf = (d, name) => (d.layers || []).find((l) => l.name === name) || null;
  const colorHex = (d, e) => {
    if (e.rgb) return e.rgb;
    if (e.color != null && ACI[e.color]) return ACI[e.color];
    const l = layerOf(d, e.layer);
    if (l && l.rgb) return l.rgb;
    return ACI[l ? l.color : 7] || ACI[7];
  };
  const layerHex = (l) => (l.rgb || ACI[l.color] || ACI[7]);
  const ltypeName = (d, e) => {
    const n = e.lt || (layerOf(d, e.layer) || {}).ltype || 'Continuous';
    return LINETYPES[n] ? n : 'Continuous';
  };
  // Line weight in millimetres.
  const lwMm = (d, e) => {
    let v = e.lw;
    if (v == null) { const l = layerOf(d, e.layer); v = l && l.lw != null ? l.lw : -3; }
    return v >= 0 ? v / 100 : (d.defaultLw || 0.25);
  };
  // Pattern in model units (empty = continuous).
  const dashModel = (d, name) => {
    const p = LINETYPES[name] || [], k = (d.plotScale || 50) * (UNIT_PER_MM[d.units] || 1) * (d.ltScale || 1);
    return p.map((v) => v * k);
  };
  const hexToRgb = (h) => { const m = /^#?([0-9a-f]{6})$/i.exec(h || ''); if (!m) return null; const n = parseInt(m[1], 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  const rgbToHex = (r, g, b) => '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
  // Nearest of the nine basic colours (DXF R12 has no true colour).
  const nearestAci = (hex) => {
    const c = hexToRgb(hex); if (!c) return 7;
    let best = 7, bd = Infinity;
    for (const k of Object.keys(ACI)) { const a = hexToRgb(ACI[k]), dd = (a[0] - c[0]) ** 2 + (a[1] - c[1]) ** 2 + (a[2] - c[2]) ** 2; if (dd < bd) { bd = dd; best = +k; } }
    return best;
  };
  const normHex = (h) => { const c = hexToRgb(h); return c ? rgbToHex(c[0], c[1], c[2]) : null; };
  // Colour as printed: screen "black" (#111111) prints pure black.
  const printable = (hex) => (hex === ACI[7] ? '#000000' : hex);
  return { ACI, ACI_NAMES, LINETYPES, LT_NOTE, LW_LIST, layerOf, colorHex, layerHex, ltypeName, lwMm, dashModel, hexToRgb, rgbToHex, nearestAci, normHex, printable };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = CadStyle;
