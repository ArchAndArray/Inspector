const { chromium } = require('/opt/npm-tools/node_modules/playwright');
(async () => {
  const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 1180, height: 820 }, hasTouch: true }); const pg = await ctx.newPage(); const errs=[]; pg.on('pageerror', e => errs.push(e.message));
  await pg.goto('http://localhost:8765/'); await pg.waitForTimeout(800);
  await pg.click('.launcher-tile[data-target="sketch"]'); await pg.waitForSelector('#mark-canvas'); await pg.waitForTimeout(400);
  const ink = () => pg.evaluate(() => { const c = document.querySelector('#mark-canvas'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++; return n; });
  const ev = (type, id, x, y) => pg.evaluate(([type, id, x, y]) => document.querySelector('#mark-canvas').dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', clientX: x, clientY: y, pressure: 0.5, isPrimary: true, bubbles: true, cancelable: true })), [type, id, x, y]);
  await ev('pointerdown', 1, 400, 400); for (let i = 1; i <= 8; i++) await ev('pointermove', 1, 400 + i * 20, 400); await ev('pointerup', 1, 560, 400);
  console.log('finger-only ink', await ink(), 'penSeen flag', await pg.evaluate(() => localStorage.getItem('annotate.penSeen')), errs); await b.close();
})();
