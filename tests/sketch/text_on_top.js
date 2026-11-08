// Text / measurements always sit above drawn marks, and objects can be ordered among themselves.
const { chromium } = require('/opt/npm-tools/node_modules/playwright');
(async () => {
  const b = await chromium.launch(); const errs = [];
  const ctx = await b.newContext({ viewport: { width: 1180, height: 820 } }); const pg = await ctx.newPage();
  pg.on('pageerror', e => errs.push('PE ' + e.message));
  await pg.goto('http://localhost:8765/'); await pg.waitForTimeout(900);
  let fails = 0; const ok = (n, c) => { if (!c) fails++; console.log(c ? 'PASS' : 'FAIL', n); };
  const id = await pg.evaluate(async () => { const c = document.createElement('canvas'); c.width = 800; c.height = 600; const x = c.getContext('2d'); x.fillStyle = '#7a8f9e'; x.fillRect(0, 0, 800, 600); const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9)); return (await DB.addPhoto({ kind: 'pdfPage', originalBlob: blob })).id; });
  await pg.evaluate((id) => openAnnotator(id, () => {}), id); await pg.waitForSelector('#mark-canvas'); await pg.waitForTimeout(500);
  const box = await pg.evaluate(() => { const r = document.querySelector('#mark-canvas').getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; });
  const X = box[0] + box[2] / 2, Y = box[1] + box[3] / 2;
  const mdrag = async (x0, y0, x1, y1, n = 12) => { await pg.mouse.move(x0, y0); await pg.mouse.down(); for (let i = 1; i <= n; i++) await pg.mouse.move(x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n); await pg.mouse.up(); await pg.waitForTimeout(100); };
  // box, then text over it
  await pg.click('#btn-shapes'); await pg.click('#btn-shape-rect'); await mdrag(X - 150, Y - 80, X + 150, Y + 80);
  await pg.click('#btn-text-tool'); await pg.mouse.click(X, Y); await pg.waitForSelector('#f-text'); await pg.fill('#f-text', 'THIS IS A BOX'); await pg.click('#btn-place'); await pg.waitForTimeout(300); await pg.click('#btn-adjust-done'); await pg.waitForTimeout(200);
  // a second, filled and very thick box drawn over the text
  await pg.click('#btn-pen-tool'); await pg.click('#btn-shapes'); await pg.click('#btn-shape-rect'); await mdrag(X - 100, Y - 60, X + 100, Y + 60);
  await pg.click('#btn-select'); await pg.mouse.click(X - 100, Y); await pg.waitForTimeout(150); await pg.click('.sel-bar [data-sel=fill]'); await pg.click('.sel-bar [data-sel=done]'); await pg.click('#btn-select');
  // what the saved picture looks like at the text: flatten and read the result
  await pg.click('#btn-done'); await pg.waitForTimeout(150); await pg.click('[data-act=flatten]'); await pg.waitForTimeout(1200);
  const res = await pg.evaluate(async (id) => { const p = await DB.get('photos', id); const bm = await createImageBitmap(p.annotatedBlob); const c = document.createElement('canvas'); c.width = bm.width; c.height = bm.height; const x = c.getContext('2d'); x.drawImage(bm, 0, 0); const d = x.getImageData(Math.round(bm.width / 2) - 6, Math.round(bm.height / 2) - 6, 12, 12).data; let white = 0, red = 0; for (let i = 0; i < d.length; i += 4) { if (d[i] > 225 && d[i + 1] > 225 && d[i + 2] > 225) white++; if (d[i] > 150 && d[i + 1] < 90) red++; } return { white, red }; }, id);
  ok('text is still on top of a box drawn over it (saved picture shows the text box, not the fill)', res.white > res.red);
  console.log(JSON.stringify(res));
  // ordering among objects
  await pg.evaluate((id) => openAnnotator(id, () => {}), id); await pg.waitForSelector('#mark-canvas'); await pg.waitForTimeout(500);
  await pg.click('#btn-select'); await pg.mouse.click(X, Y); await pg.waitForTimeout(250);
  ok('Edit sheet offers Bring to front / Send to back', await pg.evaluate(() => !!document.querySelector('#btn-ao-front') && !!document.querySelector('#btn-ao-back')));
  await pg.click('#btn-ao-back'); await pg.waitForTimeout(250);
  ok('sheet closes after ordering', await pg.evaluate(() => !document.querySelector('#btn-ao-front')));
  // put the text BEHIND the pen marks: the filled box must now cover it in the saved picture
  await pg.click('#btn-ao-cancel').catch(() => {});
  await pg.mouse.click(X, Y); await pg.waitForTimeout(250);
  ok('Edit sheet offers Put behind the pen marks', await pg.evaluate(() => /behind/i.test((document.querySelector('#btn-ao-behind') || {}).textContent || '')));
  await pg.click('#btn-ao-behind'); await pg.waitForTimeout(250);
  await pg.click('#btn-done'); await pg.waitForTimeout(150); await pg.click('[data-act=flatten]'); await pg.waitForTimeout(1200);
  const res2 = await pg.evaluate(async (id) => { const p = await DB.get('photos', id); const bm = await createImageBitmap(p.annotatedBlob); const c = document.createElement('canvas'); c.width = bm.width; c.height = bm.height; const x = c.getContext('2d'); x.drawImage(bm, 0, 0); const d = x.getImageData(Math.round(bm.width / 2) - 6, Math.round(bm.height / 2) - 6, 12, 12).data; let white = 0, red = 0; for (let i = 0; i < d.length; i += 4) { if (d[i] > 225 && d[i + 1] > 225 && d[i + 2] > 225) white++; if (d[i] > 150 && d[i + 1] < 120) red++; } return { white, red, behind: (p.annotationObjects || []).some((o) => o.behind) }; }, id);
  console.log(JSON.stringify(res2));
  ok('behind: the pen fill now covers the text (saved picture)', res2.behind && res2.red > res2.white);
  // reopen: the choice is remembered, and the live view also shows the fill above the text
  await pg.evaluate((id) => openAnnotator(id, () => {}), id); await pg.waitForSelector('#mark-canvas'); await pg.waitForTimeout(500);
  ok('behind choice survives reopening (drawn on the under canvas)', await pg.evaluate(() => { const c = document.querySelector('#annotation-under-canvas'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) return true; return false; }));
  ok('no page errors', errs.length === 0); if (errs.length) console.log(errs.slice(0, 4));
  await b.close(); process.exit(fails ? 1 : 0);
})();
