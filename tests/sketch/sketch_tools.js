const { chromium } = require('/opt/npm-tools/node_modules/playwright');
(async () => {
  const b = await chromium.launch(); const errs = [];
  const ctx = await b.newContext({ viewport: { width: 1180, height: 820 }, hasTouch: true });
  const pg = await ctx.newPage();
  pg.on('pageerror', e => errs.push('PE ' + e.message)); pg.on('console', m => { if (m.type() === 'error' && !/ERR_TUNNEL|ERR_FAILED/.test(m.text())) errs.push('CE ' + m.text()); });
  await pg.goto('http://localhost:8765/'); await pg.waitForTimeout(800);
  await pg.click('.launcher-tile[data-target="sketch"]'); await pg.waitForSelector('#mark-canvas'); await pg.waitForTimeout(500);
  const ink = (sel) => pg.evaluate((s) => { const c = document.querySelector(s || '#mark-canvas'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++; return n; }, sel);
  const ev = (type, id, ptype, x, y) => pg.evaluate(([type, id, ptype, x, y]) => { const c = document.querySelector('#mark-canvas'); c.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: ptype, clientX: x, clientY: y, pressure: type === 'pointerup' ? 0 : 0.5, isPrimary: true, bubbles: true, cancelable: true })); }, [type, id, ptype, x, y]);
  const drag = async (id, pt, x0, y0, x1, y1) => { await ev('pointerdown', id, pt, x0, y0); for (let i = 1; i <= 10; i++) await ev('pointermove', id, pt, x0 + (x1 - x0) * i / 10, y0 + (y1 - y0) * i / 10); await ev('pointerup', id, pt, x1, y1); };
  const box = await pg.evaluate(() => { const r = document.querySelector('#mark-canvas').getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; });
  const X = box[0] + box[2] / 2, Y = box[1] + box[3] / 2;
  let a = await ink(); await drag(1, 'pen', X - 150, Y, X + 150, Y + 40); let n1 = await ink(); console.log('stroke', n1 - a);
  await pg.click('#btn-undo'); await pg.waitForTimeout(100); console.log('after undo', await ink());
  await drag(2, 'pen', X - 150, Y, X + 150, Y + 40); await pg.click('#btn-erase'); await drag(3, 'pen', X - 160, Y + 10, X + 160, Y + 30); console.log('after erase', await ink()); await pg.click('#btn-erase');
  // grid
  await pg.click('#btn-more'); await pg.click('#btn-grid'); await pg.waitForTimeout(100); await pg.click('#btn-more'); await pg.click('#btn-grid'); await pg.click('#btn-more'); await pg.click('#btn-grid');
  // arc
  await pg.click('#btn-shapes'); await pg.click('#btn-arc'); await drag(4, 'pen', X - 100, Y - 100, X + 100, Y - 100); await pg.waitForTimeout(150);
  console.log('arc adjust visible', await pg.evaluate(() => getComputedStyle(document.querySelector('#adjust-handle-3')).display));
  await pg.click('#btn-adjust-done').catch(e => console.log('adjust done click failed', e.message.split('\n')[0])); await pg.waitForTimeout(200); await pg.click('#btn-shapes'); await pg.click('#btn-arc');
  // measure
  await pg.click('#btn-measure'); await drag(5, 'pen', X - 100, Y - 160, X + 100, Y - 160); await pg.waitForTimeout(150);
  await pg.click('#btn-adjust-done').catch(e => console.log('measure done failed', e.message.split('\n')[0])); await pg.waitForTimeout(200); await pg.click('#btn-measure');
  // text
  await pg.click('#btn-text-tool'); await ev('pointerdown', 6, 'pen', X, Y + 150); await ev('pointerup', 6, 'pen', X, Y + 150); await pg.waitForTimeout(300);
  console.log('text dialog', await pg.evaluate(() => !!document.querySelector('textarea, [contenteditable="true"]')));
  console.log('annotation ink', await ink('#annotation-canvas'));
  console.log('errs', JSON.stringify(errs)); await b.close();
})();
