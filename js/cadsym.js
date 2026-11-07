// cadsym.js — stencil symbols (stone, trees, etc.). No DOM; testable in Node. Global `CadSym`.
//
//   SYM { t:'SYM', p:[x,y] (centre), name, sz (overall width in model units), rot (rad), seed }
// Each symbol is a function (random, seed-driven) returning shapes in unit coordinates, about -0.5..0.5:
//   { pts:[[x,y],...], closed:bool, fill:bool }
// Real-world symbols (stone, tree...) carry a default size in metres; paper symbols (north arrow, water level)
// carry a size in paper mm and are sized at the plot scale when placed, like text.

const CadSym = (() => {
  'use strict';
  const TAU = Math.PI * 2;
  function mulberry32(a) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  const circ = (cx, cy, r, n) => { const o = []; for (let i = 0; i < (n || 24); i++) { const a = TAU * i / (n || 24); o.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); } return o; };
  // Smooth irregular rounded outline (a stone).
  function blob(rnd, cx, cy, r, elong) {
    const f = [1 + 0.5 * rnd(), 2 + 2 * rnd(), 3 + 2 * rnd()].map(Math.round), ph = [rnd() * TAU, rnd() * TAU, rnd() * TAU], am = [0.07 + 0.05 * rnd(), 0.05 * rnd() + 0.03, 0.04 * rnd() + 0.02];
    const el = elong || 1, rot = rnd() * Math.PI, c = Math.cos(rot), s = Math.sin(rot), pts = [];
    for (let i = 0; i < 28; i++) {
      const a = TAU * i / 28; let k = 1; for (let j = 0; j < 3; j++) k += am[j] * Math.sin(f[j] * a + ph[j]);
      let x = r * k * Math.cos(a) * el, y = r * k * Math.sin(a) / Math.sqrt(el);
      pts.push([cx + x * c - y * s, cy + x * s + y * c]);
    }
    return pts;
  }
  // Cloud outline with inward cusps (canopy of a tree or shrub).
  function cloud(rnd, cx, cy, r, lobes, depth) {
    const pts = [], n = lobes * 8, jit = []; for (let i = 0; i < lobes; i++) jit.push(1 + (rnd() - 0.5) * 0.12);
    for (let i = 0; i < n; i++) {
      const a = TAU * i / n, lobe = Math.floor(i / 8) % lobes, t = (i % 8) / 8, bump = Math.sin(Math.PI * t);
      pts.push([cx + r * (1 - depth + depth * bump) * jit[lobe] * Math.cos(a), cy + r * (1 - depth + depth * bump) * jit[lobe] * Math.sin(a)]);
    }
    return pts;
  }
  const S = (pts, closed, fill) => ({ pts, closed: !!closed, fill: !!fill });

  const SYMBOLS = {
    Stone: { label: 'Stone', sizeM: 0.35, make: (rnd) => [S(blob(rnd, 0, 0, 0.46, 1.1 + 0.4 * rnd()), true)] },
    Rubble: {
      label: 'Rubble', sizeM: 1.2, make: (rnd) => {
        const out = [], placed = []; let tries = 0;
        while (out.length < 6 && tries++ < 60) {
          const r = 0.09 + 0.1 * rnd(), a = rnd() * TAU, d = Math.sqrt(rnd()) * (0.47 - r), x = d * Math.cos(a), y = d * Math.sin(a);
          if (placed.some((q) => Math.hypot(q[0] - x, q[1] - y) < q[2] + r + 0.02)) continue;
          placed.push([x, y, r]); out.push(S(blob(rnd, x, y, r, 1 + 0.5 * rnd()), true));
        }
        return out;
      }
    },
    Boulder: {
      label: 'Boulder', sizeM: 1.0, make: (rnd) => {
        const o = blob(rnd, 0, 0, 0.46, 1.2 + 0.3 * rnd()), out = [S(o, true)];
        for (let k = 0; k < 3; k++) { const i = Math.floor(rnd() * 28), j = (i + 8 + Math.floor(rnd() * 8)) % 28, a = o[i], b = o[j]; out.push(S([a, [(a[0] * 2 + b[0]) / 3 * 0.8, (a[1] * 2 + b[1]) / 3 * 0.8], [(a[0] + b[0] * 2) / 3 * 0.8, (a[1] + b[1] * 2) / 3 * 0.8]].slice(0, 2), false)); }
        return out;
      }
    },
    Tree: { label: 'Tree', sizeM: 6, make: (rnd) => [S(cloud(rnd, 0, 0, 0.5, 10, 0.12), true), S(circ(0, 0, 0.035, 12), true, true), S([[-0.07, 0], [0.07, 0]], false), S([[0, -0.07], [0, 0.07]], false)] },
    Conifer: {
      label: 'Conifer', sizeM: 4, make: () => {
        const pts = []; for (let i = 0; i < 24; i++) { const a = TAU * i / 24, r = i % 2 ? 0.26 : 0.5; pts.push([r * Math.cos(a), r * Math.sin(a)]); }
        return [S(pts, true), S(circ(0, 0, 0.035, 12), true, true)];
      }
    },
    Shrub: { label: 'Shrub', sizeM: 1.8, make: (rnd) => [S(cloud(rnd, 0, 0, 0.5, 7, 0.16), true), S(cloud(rnd, 0, 0, 0.26, 5, 0.18), true)] },
    Grass: {
      label: 'Grass tuft', sizeM: 0.4, make: () => {
        const out = []; [-0.38, -0.19, 0, 0.19, 0.38].forEach((x, i) => { const bend = (i - 2) * 0.05, h = 0.42 - Math.abs(i - 2) * 0.05; out.push(S([[x * 0.2, -0.4], [x * 0.7 + bend, 0], [x, h]], false)); });
        return out;
      }
    },
    Manhole: { label: 'Manhole', sizeM: 0.6, make: () => [S(circ(0, 0, 0.5, 32), true), S(circ(0, 0, 0.36, 32), true), S([[-0.25, -0.25], [0.25, 0.25]], false), S([[-0.25, 0.25], [0.25, -0.25]], false)] },
    Lamp: { label: 'Lamp column', sizeM: 0.4, make: () => [S(circ(0, 0, 0.5, 32), true), S(circ(0, 0, 0.16, 16), true, true)] },
    North: {
      label: 'North arrow', paperMm: 15, make: () => [
        S([[0, 0.3], [-0.16, -0.4], [0, -0.24], [0.16, -0.4]], true), S([[0, 0.3], [0, -0.24], [-0.16, -0.4]], true, true),
        S([[-0.07, 0.38], [-0.07, 0.52], [0.07, 0.38], [0.07, 0.52]], false)]
    },
    Water: {
      label: 'Water level', paperMm: 8, make: () => [
        S([[-0.3, 0.2], [0.3, 0.2], [0, -0.14]], true), S([[-0.3, -0.26], [0.3, -0.26]], false), S([[-0.2, -0.38], [0.2, -0.38]], false), S([[-0.1, -0.5], [0.1, -0.5]], false)]
    }
  };
  const NAMES = Object.keys(SYMBOLS);
  const UNIT_PER_M = { mm: 1000, m: 1, in: 39.37007874 }, UNIT_PER_MM = { mm: 1, m: 0.001, in: 1 / 25.4 };

  // Default overall width in model units for a symbol placed in a drawing.
  function defaultSize(name, doc) {
    const s = SYMBOLS[name] || SYMBOLS.Tree, u = doc.units || 'mm';
    return s.sizeM ? s.sizeM * (UNIT_PER_M[u] || 1000) : s.paperMm * (doc.plotScale || 50) * (UNIT_PER_MM[u] || 1);
  }

  // World-space shapes of a placed symbol (cached per entity object).
  const cache = new WeakMap();
  function shapes(e) {
    if (cache.has(e)) return cache.get(e);
    const def = SYMBOLS[e.name] || SYMBOLS.Tree, rnd = mulberry32((e.seed || 1) >>> 0), sz = e.sz || 1, rot = e.rot || 0, c = Math.cos(rot), s = Math.sin(rot);
    const out = def.make(rnd).map((sh) => ({ closed: sh.closed, fill: sh.fill, pts: sh.pts.map(([x, y]) => [e.p[0] + (x * c - y * s) * sz, e.p[1] + (x * s + y * c) * sz]) }));
    cache.set(e, out); return out;
  }
  // Unit-size shapes for thumbnails.
  const preview = (name, seed) => shapes({ t: 'SYM', p: [0, 0], name, sz: 1, rot: 0, seed: seed || 7 });

  return { SYMBOLS, NAMES, defaultSize, shapes, preview };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = CadSym;
