const { chromium } = require('/opt/npm-tools/node_modules/playwright');
(async () => {
  const b = await chromium.launch(); const errs = [];
  const ctx = await b.newContext({ viewport: { width: 1180, height: 820 }, hasTouch: true });
  const pg = await ctx.newPage();
  pg.on('pageerror', e => errs.push('PE ' + e.message)); pg.on('console', m => { if (m.type() === 'error' && !/ERR_TUNNEL|ERR_FAILED/.test(m.text())) errs.push('CE ' + m.text()); });
  await pg.goto('http://localhost:8765/'); await pg.waitForTimeout(800);
  await pg.click('.launcher-tile[data-target="sketch"]'); await pg.waitForSelector('#mark-canvas'); await pg.waitForTimeout(500);
  const ok = (n, c) => console.log(c ? 'PASS' : 'FAIL', n);
  const stats = () => pg.evaluate(() => { const c = document.querySelector('#mark-canvas'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0, mx = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) { n++; if (d[i] > mx) mx = d[i]; } return { n, mx }; });
  const ev = (type, id, x, y) => pg.evaluate(([type, id, x, y]) => { const c = document.querySelector('#mark-canvas'); c.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'pen', clientX: x, clientY: y, pressure: type === 'pointerup' ? 0 : 0.5, isPrimary: true, bubbles: true, cancelable: true })); }, [type, id, x, y]);
  const drag = async (id, x0, y0, x1, y1, n = 10) => { await ev('pointerdown', id, x0, y0); for (let i = 1; i <= n; i++) await ev('pointermove', id, x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n); await ev('pointerup', id, x1, y1); await pg.waitForTimeout(60); };
  const box = await pg.evaluate(() => { const r = document.querySelector('#mark-canvas').getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; });
  const X = box[0] + box[2] / 2, Y = box[1] + box[3] / 2;
  let id = 1;
  for (const [name, btn] of [['arrow', '#btn-shape-arrow'], ['ellipse', '#btn-shape-ellipse'], ['rect', '#btn-shape-rect']]) {
    await pg.waitForTimeout(400);
    await pg.click('#btn-shapes'); await pg.click(btn); await pg.waitForTimeout(80);
    ok(name + ' tool active', await pg.evaluate((s) => document.querySelector(s).classList.contains('active') && document.querySelector('#btn-shapes').classList.contains('active') && !document.querySelector('#btn-pen-tool').classList.contains('active'), btn));
    const a = await stats(); await drag(id++, X - 120, Y - 60, X + 120, Y + 60); const c = await stats();
    ok(name + ' draws', c.n > a.n + 200);
    await pg.click('#btn-undo'); ok(name + ' undo removes it', (await stats()).n === a.n);
    await pg.click('#btn-redo'); ok(name + ' redo restores it', (await stats()).n === c.n);
    // a tiny drag draws nothing
    const before = await stats(); await drag(id++, X, Y, X + 1, Y + 1, 2); ok(name + ' tiny drag ignored', (await stats()).n === before.n);
    await pg.click('#btn-undo');
  }
  // leaving shape mode with the pen button
  await pg.click('#btn-pen-tool'); ok('pen button leaves shape mode', await pg.evaluate(() => !document.querySelector('#btn-shape-rect').classList.contains('active') && document.querySelector('#btn-pen-tool').classList.contains('active')));
  // numbered markers
  await pg.waitForTimeout(400); await pg.click('#btn-num'); await pg.waitForTimeout(80);
  ok('marker row shown, starts at 1', await pg.evaluate(() => document.querySelector('#marker-row').style.display !== 'none' && document.querySelector('#mk-label').textContent === '1'));
  const m0 = await stats();
  await drag(id++, X - 200, Y - 100, X - 200, Y - 100, 1); await drag(id++, X, Y - 100, X, Y - 100, 1); await drag(id++, X + 200, Y - 100, X + 200, Y - 100, 1);
  const m3 = await stats(); ok('three markers drawn', m3.n > m0.n + 500);
  ok('counter advanced to 4', await pg.evaluate(() => document.querySelector('#mk-label').textContent === '4'));
  await pg.click('#btn-undo'); ok('undo marker -> next is 3', await pg.evaluate(() => document.querySelector('#mk-label').textContent === '3'));
  await pg.click('#mk-plus'); await pg.click('#mk-plus'); ok('plus sets 5', await pg.evaluate(() => document.querySelector('#mk-label').textContent === '5'));
  await pg.click('#mk-minus'); ok('minus sets 4', await pg.evaluate(() => document.querySelector('#mk-label').textContent === '4'));
  await drag(id++, X, Y + 100, X, Y + 100, 1); ok('after placing override, next is 5', await pg.evaluate(() => document.querySelector('#mk-label').textContent === '5'));
  await pg.screenshot({ path: '/tmp/claude-0/shots/markers.png' });
  // highlighter
  await pg.click('#btn-pen-tool'); await pg.click('.pen-type-btn[data-pentype="highlighter"]'); await pg.waitForTimeout(80);
  await pg.click('#btn-undo'); await pg.click('#btn-undo'); await pg.click('#btn-undo'); await pg.click('#btn-undo'); await pg.click('#btn-undo'); await pg.waitForTimeout(100);
  const h0 = await stats();
  // self-crossing highlighter stroke
  await ev('pointerdown', id, X - 150, Y); for (let i = 1; i <= 20; i++) await ev('pointermove', id, X - 150 + i * 15, Y + Math.sin(i / 2) * 40); for (let i = 20; i >= 0; i--) await ev('pointermove', id, X - 150 + i * 15, Y + Math.sin(i / 2) * 40 + 3); await ev('pointerup', id++, X - 150, Y + 3); await pg.waitForTimeout(100);
  const h1 = await stats(); ok('highlighter draws', h1.n > h0.n + 500);
  console.log('highlighter max alpha', h1.mx); ok('highlighter is see-through and does not double up on its own overlap', h1.mx > 60 && h1.mx < 110);
  await pg.screenshot({ path: '/tmp/claude-0/shots/highlighter.png' });
  // rotate keeps shapes
  const pre = await stats(); await pg.click('#btn-rotate'); await pg.waitForTimeout(300); const post = await stats(); ok('rotate keeps highlighter ink', Math.abs(post.n - pre.n) / pre.n < 0.15);
  console.log('errs', JSON.stringify(errs)); await b.close();
})();
