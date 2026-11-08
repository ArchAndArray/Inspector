// Node tests for the select / fill engine pieces of ink.js
const assert = require('assert'); const Ink = require('../../js/ink.js'); let g = 0;
{ const r = Ink.newStroke('rect', { pts: [[10, 10], [110, 60]], w: 4 }); const h = Ink.handles(r).map((q) => q.id); assert.deepStrictEqual(h, ['c0', 'c1', 'c2', 'c3', 'rot']); assert.deepStrictEqual(Ink.dragHandle(r, 'c2', 210, 110, 110, 60).pts, [[10, 10], [210, 110]]); g++; }
{ const e = Ink.newStroke('ellipse', { pts: [[0, 0], [100, 60]], w: 4 }); assert(Ink.hit(e, 50, 0, 4)); assert(!Ink.hit(e, 50, 30, 4)); assert(Ink.hit(Object.assign({}, e, { fill: '#f00' }), 50, 30, 4)); g++; }
{ const f = Ink.newStroke('pen', { pts: [[0, 0, .5], [50, 0, .5], [100, 20, .5]], w: 4 }); const sc = Ink.dragHandle(f, 'c2', 200, 40, 100, 20); assert(Math.abs(sc.pts[2][0] - 200) < 1e-6 && sc.pts[0][0] === 0); const rt = Ink.dragHandle(f, 'rot', 50, 50, 100, 0); assert(rt.pts.length === 3); g++; }
{ const h = Ink.makeHistory(); const a = Ink.newStroke('pen', { pts: [[0, 0]] }), b = Ink.newStroke('pen', { pts: [[5, 5]] }); h.add(a); h.add(b); h.batch([{ t: 'del', id: a.id }, { t: 'del', id: b.id }]); assert.strictEqual(h.strokes.length, 0); h.undo(); assert.strictEqual(h.strokes.length, 2); h.redo(); assert.strictEqual(h.strokes.length, 0); h.undo(); const m = Object.assign({}, a, { c: '#f00' }); h.set(a, m); h.undo(); assert.strictEqual(h.strokes.find((q) => q.id === a.id).c, '#000000'); g++; }
{ const w = 20, hh = 20, m = new Uint8Array(w * hh); for (let i = 5; i <= 14; i++) { m[5 * w + i] = m[14 * w + i] = m[i * w + 5] = m[i * w + 14] = 1; }
  const r = Ink.floodRects(m, w, hh, 10, 10, 2, 0); assert.strictEqual(r.area, 64); assert(!r.edge); assert.strictEqual(r.rects.length, 1);
  const o = Ink.floodRects(m, w, hh, 1, 1, 2, 0); assert(o.edge); assert.strictEqual(Ink.floodRects(m, w, hh, 5, 5, 2, 0), null);
  // a one-pixel gap leaks without dilation and is closed by it
  const m2 = m.slice(); m2[5 * w + 9] = 0; assert(Ink.floodRects(m2, w, hh, 10, 10, 1, 0).edge); assert(!Ink.floodRects(Ink.dilate(m2, w, hh, 1), w, hh, 10, 10, 1, 0).edge);
  const st = Ink.newStroke('flood', { c: '#f00', w: 1, pts: [[10, 10]], rects: r.rects });
  assert.deepStrictEqual(Ink.bbox(st), { x0: 12, y0: 12, x1: 28, y1: 28 }); assert(Ink.hit(st, 20, 20, 0)); assert(!Ink.hit(st, 2, 2, 0));
  assert.deepStrictEqual(Ink.rotate90cw([st], 40)[0].rects[0], [12, 12, 16, 16].map((v, i) => [40 - 28, 12, 16, 16][i]));
  assert.deepStrictEqual(Ink.cropStrokes([st], 10, 10, 2)[0].rects[0], [4, 4, 32, 32]);
  assert.deepStrictEqual(Ink.moveStroke(st, 5, -2).rects[0], [17, 10, 16, 16]);
  assert.deepStrictEqual(Ink.unpack(Ink.pack([st]))[0].rects, st.rects); g++; }
console.log('select engine tests passed:', g, 'groups');
{ const a = Ink.newStroke('pen', { pts: [[0, 0]] }), b = Ink.newStroke('pen', { pts: [[5, 5]] }); const h = Ink.makeHistory([a, b]); assert.strictEqual(h.undo(), b); assert.strictEqual(h.undo(), a); assert.strictEqual(h.strokes.length, 0); h.redo(); assert.strictEqual(h.strokes.length, 1); console.log('loaded strokes undo one by one: ok'); }
