const { chromium } = require('/opt/npm-tools/node_modules/playwright');
(async () => {
  const b = await chromium.launch(); const errs = [];
  const ok = (n, c) => console.log(c ? 'PASS' : 'FAIL', n);
  for (const [name, w, h] of [['land', 1180, 820], ['port', 820, 1180]]) {
    const ctx = await b.newContext({ viewport: { width: w, height: h }, hasTouch: true });
    const pg = await ctx.newPage();
    pg.on('pageerror', e => errs.push('PE ' + e.message)); pg.on('console', m => { if (m.type() === 'error' && !/ERR_TUNNEL|ERR_FAILED/.test(m.text())) errs.push('CE ' + m.text()); });
    await pg.goto('http://localhost:8765/'); await pg.waitForTimeout(800);
    await pg.click('.launcher-tile[data-target="sketch"]'); await pg.waitForSelector('#mark-canvas'); await pg.waitForTimeout(500);
    const rect = (s) => pg.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, r: r.right, b: r.bottom }; }, s);
    const bar = await rect('#main-toolbar'); const isl = await rect('#tool-island'); const strip = await rect('#pen-strip');
    console.log(name, 'bar bottom', bar.b, 'island', JSON.stringify(isl), 'strip', JSON.stringify(strip));
    ok(name + ' island below top bar', isl.y >= bar.b);
    ok(name + ' island inside screen', isl.r <= w && isl.b <= h && isl.x >= 0);
    ok(name + ' strip inside screen and clear of island', strip.x >= isl.r - 1 && strip.r <= w && strip.b <= h);
    // all buttons >= 44px
    const small = await pg.evaluate(() => [...document.querySelectorAll('#annotate-view button, #annotate-view .color-dot')].filter(b => b.offsetParent && (b.getBoundingClientRect().width < 30 || b.getBoundingClientRect().height < 30)).map(b => b.id || b.className));
    console.log(name, 'small controls', JSON.stringify(small));
    // pen active by default, erase switches
    ok(name + ' pen active', await pg.evaluate(() => document.querySelector('#btn-pen-tool').classList.contains('active')));
    await pg.click('#btn-erase'); await pg.waitForTimeout(50);
    ok(name + ' erase deactivates pen', await pg.evaluate(() => !document.querySelector('#btn-pen-tool').classList.contains('active') && document.querySelector('#btn-erase').classList.contains('active')));
    await pg.click('#btn-pen-tool'); await pg.waitForTimeout(50);
    ok(name + ' pen button returns to pen', await pg.evaluate(() => document.querySelector('#btn-pen-tool').classList.contains('active') && !document.querySelector('#btn-erase').classList.contains('active')));
    await pg.click('#btn-shapes'); await pg.click('#btn-straight-line'); await pg.waitForTimeout(50);
    ok(name + ' line tool active, pen not', await pg.evaluate(() => document.querySelector('#btn-straight-line').classList.contains('active') && !document.querySelector('#btn-pen-tool').classList.contains('active')));
    await pg.click('#btn-shapes'); await pg.click('#btn-straight-line');
    // More menu
    await pg.click('#btn-more'); const mp = await rect('#more-pop'); ok(name + ' more pop visible on screen', mp.w > 100 && mp.r <= w && mp.b <= h && mp.y >= bar.b);
    await pg.click('#btn-calibrate'); await pg.waitForTimeout(150);
    ok(name + ' calibrate hides island and shows cal toolbar', await pg.evaluate(() => getComputedStyle(document.querySelector('#ruler-toolbar')).display === 'none' && getComputedStyle(document.querySelector('#cal-toolbar')).display !== 'none'));
    await pg.click('#btn-cal-cancel'); await pg.waitForTimeout(100);
    ok(name + ' island back after calibrate', await pg.evaluate(() => getComputedStyle(document.querySelector('#ruler-toolbar')).display !== 'none'));
    await pg.click('#btn-crop'); await pg.waitForTimeout(100); await pg.click('#btn-crop-cancel'); await pg.waitForTimeout(100);
    ok(name + ' crop round trip', await pg.evaluate(() => getComputedStyle(document.querySelector('#main-toolbar')).display !== 'none'));
    // collapse by tapping grip
    await pg.click('#isl-grip'); await pg.waitForTimeout(100);
    const col = await rect('#tool-island'); ok(name + ' collapsed island small', col.h < 80 && col.w < 80);
    await pg.click('#isl-grip'); await pg.waitForTimeout(100);
    // drag to right edge
    const g = await rect('#isl-grip');
    await pg.mouse.move(g.x + g.w / 2, g.y + g.h / 2); await pg.mouse.down(); await pg.mouse.move(w - 40, g.y + 200, { steps: 8 }); await pg.mouse.up(); await pg.waitForTimeout(150);
    const r2 = await rect('#tool-island'); ok(name + ' dragged to right edge', r2.r > w - 30 && r2.x > w / 2);
    ok(name + ' edge persisted', await pg.evaluate(() => JSON.parse(localStorage.getItem('annotate.island')).edge === 'right'));
    // drag to bottom
    const g2 = await rect('#isl-grip');
    await pg.mouse.move(g2.x + g2.w / 2, g2.y + g2.h / 2); await pg.mouse.down(); await pg.mouse.move(w / 2, h - 30, { steps: 8 }); await pg.mouse.up(); await pg.waitForTimeout(150);
    const r3 = await rect('#tool-island'); const s3 = await rect('#pen-strip');
    ok(name + ' docked bottom horizontally', r3.w > r3.h && r3.b > h - 40);
    ok(name + ' strip moved above bottom island', s3.b <= r3.y);
    console.log(name, 'bottom island', JSON.stringify(r3), 'strip', JSON.stringify(s3));
    await pg.screenshot({ path: `/tmp/claude-0/shots/new-${name}-bottom.png` });
    // drag to top: must stay below top bar
    const g3 = await rect('#isl-grip');
    await pg.mouse.move(g3.x + g3.w / 2, g3.y + g3.h / 2); await pg.mouse.down(); await pg.mouse.move(w / 2, 5, { steps: 8 }); await pg.mouse.up(); await pg.waitForTimeout(150);
    const r4 = await rect('#tool-island'); ok(name + ' top dock stays below bar', r4.y >= bar.b && r4.w > r4.h);
    // back to left for later
    const g4 = await rect('#isl-grip');
    await pg.mouse.move(g4.x + g4.w / 2, g4.y + g4.h / 2); await pg.mouse.down(); await pg.mouse.move(20, h / 2, { steps: 8 }); await pg.mouse.up(); await pg.waitForTimeout(150);
    // draw, then Back asks; Done sheet; discard closes
    const box = await rect('#mark-canvas');
    await pg.evaluate(([x, y]) => { const c = document.querySelector('#mark-canvas'); const ev = (t, px, py) => c.dispatchEvent(new PointerEvent(t, { pointerId: 5, pointerType: 'pen', clientX: px, clientY: py, pressure: .5, isPrimary: true, bubbles: true })); ev('pointerdown', x, y); for (let i = 1; i < 10; i++) ev('pointermove', x + i * 15, y + i * 4); ev('pointerup', x + 150, y + 40); }, [box.x + 300, box.y + 200]);
    await pg.click('#btn-cancel'); await pg.waitForTimeout(150);
    ok(name + ' back with edits opens finish sheet', await pg.evaluate(() => !!document.querySelector('[data-act="discard"]')));
    await pg.click('[data-act="keep"]'); await pg.waitForTimeout(100);
    ok(name + ' keep editing stays', await pg.evaluate(() => !!document.querySelector('#annotate-view')));
    await pg.click('#btn-done'); await pg.click('[data-act="discard"]'); await pg.waitForTimeout(150);
    ok(name + ' discard closes', await pg.evaluate(() => !document.querySelector('#annotate-view')));
    // reopen: no edits -> back closes immediately; island position remembered
    await pg.goto('http://localhost:8765/'); await pg.waitForTimeout(800); await pg.click('.launcher-tile[data-target="sketch"]'); await pg.waitForSelector('#mark-canvas'); await pg.waitForTimeout(400);
    const r5 = await rect('#tool-island'); ok(name + ' island position remembered on reopen', r5.x < 60);
    await pg.click('#btn-cancel'); await pg.waitForTimeout(150);
    ok(name + ' back with no edits closes at once', await pg.evaluate(() => !document.querySelector('#annotate-view')));
    await ctx.close();
  }
  console.log('errs', JSON.stringify(errs)); await b.close();
})();
