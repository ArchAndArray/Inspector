const { chromium } = require('/opt/npm-tools/node_modules/playwright');
(async () => {
  const b = await chromium.launch(); const errs = [];
  const ctx = await b.newContext({ viewport: { width: 1180, height: 820 }, hasTouch: true });
  const pg = await ctx.newPage();
  pg.on('pageerror', e => errs.push('PE ' + e.message)); pg.on('console', m => { if (m.type() === 'error' && !/ERR_TUNNEL|ERR_FAILED/.test(m.text())) errs.push('CE ' + m.text()); });
  await pg.goto('http://localhost:8765/'); await pg.waitForTimeout(800);
  await pg.click('.launcher-tile[data-target="sketch"]'); await pg.waitForSelector('#mark-canvas'); await pg.waitForTimeout(500);
  let fails = 0; const ok = (n, c) => { if (!c) fails++; console.log(c ? 'PASS' : 'FAIL', n); };
  const ev = (type, id, x, y) => pg.evaluate(([type, id, x, y]) => { const c = document.querySelector('#mark-canvas'); c.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'pen', clientX: x, clientY: y, pressure: type === 'pointerup' ? 0 : 0.5, isPrimary: true, bubbles: true, cancelable: true })); }, [type, id, x, y]);
  const drag = async (id, x0, y0, x1, y1, n = 10) => { await ev('pointerdown', id, x0, y0); for (let i = 1; i <= n; i++) await ev('pointermove', id, x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n); await ev('pointerup', id, x1, y1); await pg.waitForTimeout(90); };
  // is there ink within 4 css px of this client point?
  const ink = (x, y) => pg.evaluate(([x, y]) => { const c = document.querySelector('#mark-canvas'), r = c.getBoundingClientRect(), k = c.width / r.width; const cx = Math.round((x - r.left) * k), cy = Math.round((y - r.top) * k), rr = Math.round(5 * k); const d = c.getContext('2d').getImageData(Math.max(0, cx - rr), Math.max(0, cy - rr), rr * 2, rr * 2).data; for (let i = 3; i < d.length; i += 4) if (d[i] > 40) return true; return false; }, [x, y]);
  const box = await pg.evaluate(() => { const r = document.querySelector('#mark-canvas').getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; });
  const X = box[0] + box[2] / 2, Y = box[1] + box[3] / 2;
  let id = 1;
  // draw a box
  await pg.click('#btn-shapes'); await pg.click('#btn-shape-rect'); await drag(id++, X - 100, Y - 50, X + 100, Y + 50);
  ok('box drawn', await ink(X - 100, Y) && !(await ink(X, Y)));
  await pg.click('#btn-select'); await pg.waitForTimeout(80);
  ok('select button active, pen not', await pg.evaluate(() => document.querySelector('#btn-select').classList.contains('active') && !document.querySelector('#btn-pen-tool').classList.contains('active') && !document.querySelector('#btn-shape-rect').classList.contains('active')));
  await drag(id++, X - 100, Y, X - 100, Y, 1);
  ok('tap selects (action bar shows)', await pg.evaluate(() => document.querySelector('.sel-bar').style.display === 'flex'));
  // move right 150
  await drag(id++, X - 100, Y, X + 50, Y, 12);
  ok('move: old left edge empty, new left edge inked', !(await ink(X - 100, Y)) && await ink(X + 50, Y));
  await pg.click('#btn-undo'); ok('undo move', await ink(X - 100, Y) && !(await ink(X + 50, Y)));
  await pg.click('#btn-redo'); ok('redo move', !(await ink(X - 100, Y)) && await ink(X + 50, Y));
  await pg.click('#btn-undo');
  // resize via bottom-right corner handle (box is still selected? reselect)
  await drag(id++, X - 100, Y, X - 100, Y, 1);
  await drag(id++, X + 100, Y + 50, X + 200, Y + 100, 12);
  ok('resize: right edge moved out', await ink(X + 200, Y) && !(await ink(X + 100, Y)) && await ink(X - 100, Y));
  await pg.click('#btn-undo'); ok('undo resize', await ink(X + 100, Y) && !(await ink(X + 200, Y)));
  // rotate 90deg: grab handle above top-middle, drag to the right of centre
  const k = await pg.evaluate(() => { const c = document.querySelector('#mark-canvas'); return c.width / c.getBoundingClientRect().width; });
  await drag(id++, X - 100, Y, X - 100, Y, 1);
  await drag(id++, X, Y - 50 - 38, X + 120, Y, 14);
  ok('rotate 90: left/right edges now at top/bottom', !(await ink(X - 100, Y)) && await ink(X, Y - 100) && await ink(X, Y + 100));
  await pg.click('#btn-undo');
  // fill
  await drag(id++, X - 100, Y, X - 100, Y, 1);
  await pg.click('.sel-bar [data-sel=fill]'); ok('fill paints inside', await ink(X, Y));
  await pg.click('#btn-undo'); ok('undo fill', !(await ink(X, Y)));
  // copy + delete
  await pg.click('.sel-bar [data-sel=copy]'); const off = 28 / 1; // client offset = 28*pxScale/k  (css px) 
  ok('copy makes a second box', await ink(X - 100 + 28, Y + 28) );
  await pg.click('.sel-bar [data-sel=delete]'); ok('delete removes the copy only', !(await ink(X - 100 + 28, Y + 28 + 100)) && await ink(X - 100, Y));
  await pg.click('#btn-undo'); await pg.click('#btn-undo');
  // tap empty deselects
  await drag(id++, X + 300, Y + 200, X + 300, Y + 200, 1);
  ok('tap empty deselects', await pg.evaluate(() => document.querySelector('.sel-bar').style.display === 'none'));
  // drawing a freehand stroke then selecting it and scaling
  await pg.click('#btn-pen-tool'); ok('pen button leaves select', await pg.evaluate(() => !document.querySelector('#btn-select').classList.contains('active')));
  await drag(id++, X - 300, Y + 100, X - 200, Y + 100, 10);
  await pg.click('#btn-select'); await drag(id++, X - 250, Y + 100, X - 250, Y + 100, 1);
  ok('freehand selectable', await pg.evaluate(() => document.querySelector('.sel-bar').style.display === 'flex'));
  await drag(id++, X - 200, Y + 100, X - 100, Y + 100, 10); // handle? bbox corners are at y0..y1 ~ same row; just ensure no crash
  await pg.click('#btn-select'); ok('select off', await pg.evaluate(() => document.querySelector('.sel-bar').style.display === 'none'));
  // snapping with grid
  await pg.click('#btn-more'); await pg.click('#btn-grid'); await pg.click('#btn-more'); await pg.click('#btn-snap');
  ok('snap button on', await pg.evaluate(() => /on/.test(document.querySelector('#btn-snap span').textContent)));
  await pg.click('#btn-more').catch(() => {});
  await pg.evaluate(() => document.querySelector('#btn-shapes').click()); await pg.click('#btn-shape-rect');
  const g = await pg.evaluate(() => { const c = document.querySelector('#mark-canvas'), r = c.getBoundingClientRect(); return { k: c.width / r.width, l: r.left, t: r.top }; });
  const sx = X - 133, sy = Y - 77, ex = X + 141, ey = Y + 66;
  await drag(id++, sx, sy, ex, ey, 12);
  const snapC = (v, o) => ((Math.round(((v - o) * g.k) / 100) * 100) / g.k) + o;
  ok('snap: corner lands on grid crossing', await ink(snapC(sx, g.l), snapC(sy, g.t) + 0) && !(await ink(sx, Math.abs(snapC(sy, g.t) - sy) > 8 ? sy + (sx * 0) : -99999)));
  ok('no page errors', errs.length === 0); if (errs.length) console.log(errs.slice(0, 5));
  await b.close(); process.exit(fails ? 1 : 0);
})();
