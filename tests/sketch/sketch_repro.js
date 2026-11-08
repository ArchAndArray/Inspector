const { chromium } = require('/opt/npm-tools/node_modules/playwright');
(async () => {
  const b = await chromium.launch(); const errs = [];
  const ctx = await b.newContext({ viewport: { width: 1180, height: 820 }, hasTouch: true });
  const pg = await ctx.newPage();
  pg.on('pageerror', e => errs.push('PE ' + e.message)); pg.on('console', m => { if (m.type() === 'error' && !/ERR_TUNNEL|ERR_FAILED/.test(m.text())) errs.push('CE ' + m.text()); });
  await pg.goto('http://localhost:8765/'); await pg.waitForTimeout(800);
  await pg.click('.launcher-tile[data-target="sketch"]'); await pg.waitForSelector('#mark-canvas', { timeout: 8000 });
  await pg.waitForTimeout(500);
  const ink = () => pg.evaluate(() => { const c = document.querySelector('#mark-canvas'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++; return n; });
  const ev = (type, id, ptype, x, y, extra) => pg.evaluate(([type, id, ptype, x, y, extra]) => { const c = document.querySelector('#mark-canvas'); c.dispatchEvent(new PointerEvent(type, Object.assign({ pointerId: id, pointerType: ptype, clientX: x, clientY: y, pressure: type === 'pointerup' ? 0 : 0.5, isPrimary: true, bubbles: true, cancelable: true }, extra || {}))); }, [type, id, ptype, x, y, extra]);
  const box = await pg.evaluate(() => { const r = document.querySelector('#mark-canvas').getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; });
  console.log('canvas box', box, 'size', await pg.evaluate(() => [document.querySelector('#mark-canvas').width, document.querySelector('#mark-canvas').height]));
  const X = box[0] + box[2] / 2, Y = box[1] + box[3] / 2;
  // 1. pen freehand
  await ev('pointerdown', 5, 'pen', X - 100, Y); for (let i = 1; i <= 10; i++) await ev('pointermove', 5, 'pen', X - 100 + i * 20, Y + i * 3); await ev('pointerup', 5, 'pen', X + 100, Y + 30);
  console.log('pen stroke ink', await ink());
  // 2. pen stroke with a palm touch landing mid-stroke
  const before = await ink();
  await ev('pointerdown', 6, 'pen', X - 100, Y + 100); await ev('pointermove', 6, 'pen', X - 80, Y + 100);
  await ev('pointerdown', 7, 'touch', X + 200, Y + 200);   // palm
  for (let i = 1; i <= 10; i++) await ev('pointermove', 6, 'pen', X - 80 + i * 20, Y + 100);
  await ev('pointerup', 6, 'pen', X + 120, Y + 100); await ev('pointerup', 7, 'touch', X + 200, Y + 200);
  console.log('pen+palm ink added', (await ink()) - before);
  // 3. straight line with pen
  await pg.click('#btn-shapes'); await pg.click('#btn-straight-line'); await pg.waitForTimeout(200);
  const b3 = await ink();
  await ev('pointerdown', 8, 'pen', X - 150, Y - 120); for (let i = 1; i <= 8; i++) await ev('pointermove', 8, 'pen', X - 150 + i * 40, Y - 120 + i * 5); await ev('pointerup', 8, 'pen', X + 170, Y - 80);
  console.log('straight line pen ink added', (await ink()) - b3);
  // 4. straight line with pen and palm touch
  const b4 = await ink();
  await ev('pointerdown', 9, 'pen', X - 150, Y - 200); await ev('pointermove', 9, 'pen', X - 100, Y - 200);
  await ev('pointerdown', 10, 'touch', X + 250, Y + 250);
  for (let i = 1; i <= 8; i++) await ev('pointermove', 9, 'pen', X - 100 + i * 30, Y - 200); await ev('pointerup', 9, 'pen', X + 140, Y - 200); await ev('pointerup', 10, 'touch', X + 250, Y + 250);
  console.log('straight line pen+palm ink added', (await ink()) - b4);
  // 4b. palm first, then pen (palm stays down)
  await pg.click('#btn-shapes'); await pg.click('#btn-straight-line'); // leave straight mode -> freehand
  const b6 = await ink();
  await ev('pointerdown', 11, 'touch', X + 250, Y + 250); await ev('pointermove', 11, 'touch', X + 255, Y + 255);
  await ev('pointerdown', 12, 'pen', X - 150, Y - 150); for (let i = 1; i <= 10; i++) await ev('pointermove', 12, 'pen', X - 150 + i * 30, Y - 150 + i * 4); await ev('pointerup', 12, 'pen', X + 150, Y - 110);
  await ev('pointerup', 11, 'touch', X + 255, Y + 255);
  console.log('palm-then-pen ink added', (await ink()) - b6);
  // 4c. two-finger pinch still zooms after the pen has been used
  await new Promise(r => setTimeout(r, 450));
  const z0 = await pg.evaluate(() => document.querySelector('#mark-canvas').getBoundingClientRect().width);
  await ev('pointerdown', 20, 'touch', X - 40, Y); await ev('pointerdown', 21, 'touch', X + 40, Y);
  for (let i = 1; i <= 6; i++) { await ev('pointermove', 20, 'touch', X - 40 - i * 20, Y); await ev('pointermove', 21, 'touch', X + 40 + i * 20, Y); }
  await ev('pointerup', 20, 'touch', X - 160, Y); await ev('pointerup', 21, 'touch', X + 160, Y);
  const z1 = await pg.evaluate(() => document.querySelector('#mark-canvas').getBoundingClientRect().width);
  console.log('pinch width', Math.round(z0), '->', Math.round(z1));
  // 4d. single finger no longer draws once a pen was seen
  const b7 = await ink(); await ev('pointerdown', 22, 'touch', X, Y - 50); for (let i = 1; i <= 5; i++) await ev('pointermove', 22, 'touch', X + i * 20, Y - 50); await ev('pointerup', 22, 'touch', X + 100, Y - 50);
  console.log('finger-after-pen ink added (expect 0)', (await ink()) - b7);
  // 5. mouse
  const b5 = await ink();
  await pg.mouse.move(X - 100, Y - 250); await pg.mouse.down(); await pg.mouse.move(X + 100, Y - 250, { steps: 8 }); await pg.mouse.up();
  console.log('straight line mouse ink added', (await ink()) - b5);
  console.log('errs', JSON.stringify(errs)); await b.close();
})();
