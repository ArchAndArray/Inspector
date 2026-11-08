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
  const drag = async (id, x0, y0, x1, y1, n = 10) => { await ev('pointerdown', id, x0, y0); for (let i = 1; i <= n; i++) await ev('pointermove', id, x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n); await ev('pointerup', id, x1, y1); await pg.waitForTimeout(100); };
  const ink = (x, y) => pg.evaluate(([x, y]) => { const c = document.querySelector('#mark-canvas'), r = c.getBoundingClientRect(), k = c.width / r.width; const cx = Math.round((x - r.left) * k), cy = Math.round((y - r.top) * k), rr = Math.round(4 * k); const d = c.getContext('2d').getImageData(Math.max(0, cx - rr), Math.max(0, cy - rr), rr * 2, rr * 2).data; for (let i = 3; i < d.length; i += 4) if (d[i] > 40) return true; return false; }, [x, y]);
  const box = await pg.evaluate(() => { const r = document.querySelector('#mark-canvas').getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; });
  const X = box[0] + box[2] / 2, Y = box[1] + box[3] / 2;
  let id = 1;
  // two boxes
  await pg.click('#btn-shapes'); await pg.click('#btn-shape-rect');
  await drag(id++, X - 300, Y - 150, X - 200, Y - 80); await drag(id++, X + 100, Y - 150, X + 200, Y - 80);
  ok('two boxes drawn', await ink(X - 300, Y - 115) && await ink(X + 200, Y - 115));
  // marquee select both
  await pg.click('#btn-select'); await drag(id++, X - 340, Y - 190, X + 240, Y - 40, 14);
  ok('marquee selects 2', await pg.evaluate(() => document.querySelector('.sel-bar').style.display === 'flex' && /2 selected/.test(document.querySelector('.sel-count').textContent)));
  ok('fill button hidden for multi', await pg.evaluate(() => document.querySelector('[data-sel=fill]').style.display === 'none'));
  // move both: grab left box edge
  await drag(id++, X - 300, Y - 115, X - 300, Y + 35, 10);
  ok('both moved down together', !(await ink(X - 300, Y - 115)) && await ink(X - 300, Y + 35) && !(await ink(X + 200, Y - 115)) && await ink(X + 200, Y + 35));
  await pg.click('#btn-undo'); ok('one undo moves both back', await ink(X - 300, Y - 115) && await ink(X + 200, Y - 115));
  // delete both, undo restores both
  await pg.click('.sel-bar [data-sel=delete]'); ok('delete removes both', !(await ink(X - 300, Y - 115)) && !(await ink(X + 200, Y - 115)));
  await pg.click('#btn-undo'); ok('undo restores both', await ink(X - 300, Y - 115) && await ink(X + 200, Y - 115));
  // tap empty clears the selection
  await drag(id++, X, Y + 250, X, Y + 250, 1);
  ok('tap empty clears', await pg.evaluate(() => document.querySelector('.sel-bar').style.display === 'none'));
  // marquee that catches only one
  await drag(id++, X + 60, Y - 190, X + 240, Y - 40, 12);
  ok('marquee of one selects 1 (handles, no count)', await pg.evaluate(() => document.querySelector('.sel-bar').style.display === 'flex' && document.querySelector('.sel-count').style.display === 'none'));
  await pg.click('#btn-select');
  // ---- bucket ----
  await pg.click('#btn-bucket'); ok('bucket active, select off', await pg.evaluate(() => document.querySelector('#btn-bucket').classList.contains('active') && !document.querySelector('#btn-select').classList.contains('active')));
  await drag(id++, X - 250, Y - 115, X - 250, Y - 115, 1);
  ok('fills inside a closed box', await ink(X - 250, Y - 115));
  await pg.click('#btn-undo'); ok('undo removes the fill', !(await ink(X - 250, Y - 115)));
  await pg.click('#btn-redo');
  // open area is refused
  await drag(id++, X, Y + 200, X, Y + 200, 1);
  ok('open background is not filled', !(await ink(X, Y + 200)));
  // move the fill with select
  await pg.click('#btn-select'); await drag(id++, X - 250, Y - 115, X - 250, Y + 60, 10);
  ok('select can move a fill', await ink(X - 250, Y + 60));
  await pg.click('#btn-undo');
  await pg.click('#btn-pen-tool'); ok('pen button leaves bucket', await pg.evaluate(() => !document.querySelector('#btn-bucket').classList.contains('active')));
  // free-hand closed loop with a small gap
  const cx = X, cy = Y + 120, R = 60, pts = []; for (let a = 0.03; a <= Math.PI * 2 - 0.03; a += 0.08) pts.push([cx + R * Math.cos(a), cy + R * Math.sin(a)]);
  await ev('pointerdown', id, pts[0][0], pts[0][1]); for (const q of pts) await ev('pointermove', id, q[0], q[1]); await ev('pointerup', id, pts[pts.length - 1][0], pts[pts.length - 1][1]); id++;
  await pg.click('#btn-bucket'); await drag(id++, cx, cy, cx, cy, 1);
  ok('fills inside a hand-drawn loop with a small gap', await ink(cx, cy) && !(await ink(cx + 140, cy)));
  ok('no page errors', errs.length === 0); if (errs.length) console.log(errs.slice(0, 5));
  await b.close(); process.exit(fails ? 1 : 0);
})();
