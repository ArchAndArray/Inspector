const { chromium } = require('/opt/npm-tools/node_modules/playwright');
let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : (fail++, console.log('FAIL', m)); };
(async () => {
  const b = await chromium.launch();
  for (const [W, H] of [[1180, 820], [820, 1180]]) {
    const ctx = await b.newContext({ viewport: { width: W, height: H } }); const pg = await ctx.newPage();
    const errs = []; pg.on('pageerror', (e) => errs.push(String(e)));
    await pg.goto('http://localhost:8765/'); await pg.waitForTimeout(900);
    const id = await pg.evaluate(async () => { const c = document.createElement('canvas'); c.width = 1600; c.height = 1200; const x = c.getContext('2d'); x.fillStyle = '#7a8f9e'; x.fillRect(0, 0, 1600, 1200); const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9)); return (await DB.addPhoto({ kind: 'pdfPage', originalBlob: blob })).id; });
    await pg.evaluate((id) => openAnnotator(id, () => {}), id); await pg.waitForSelector('#mark-canvas'); await pg.waitForTimeout(600);
    const rect = () => pg.evaluate(() => { const r = document.querySelector('#mark-canvas').getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)].join(','); });
    const r0 = await rect();
    const box = (await rect()).split(',').map(Number); const X = box[0] + box[2] / 2, Y = box[1] + box[3] / 2;
    await pg.click('#btn-text-tool'); await pg.mouse.click(X - 150, Y - 100);
    await pg.waitForSelector('#f-text'); await pg.fill('#f-text', 'Crack'); await pg.click('#btn-place'); await pg.waitForTimeout(300);
    const rAdj = await rect(); ok(rAdj === r0, W + ' canvas same entering adjust ' + r0 + ' vs ' + rAdj);
    // tap on photo aims the leader
    await pg.mouse.click(X + 100, Y + 80); await pg.waitForTimeout(100);
    const h2 = await pg.evaluate(() => { const e = document.querySelector('#adjust-handle-2'); const r = e.getBoundingClientRect(); return { d: e.style.display, w: r.width, x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    ok(h2.d !== 'none' && Math.abs(h2.x - (X + 100)) < 3 && Math.abs(h2.y - (Y + 80)) < 3, W + ' tap aims leader ' + JSON.stringify(h2));
    ok(h2.w >= 44, W + ' handle >=44px ' + h2.w);
    // drag the handle somewhere else
    await pg.mouse.move(h2.x, h2.y); await pg.mouse.down(); await pg.mouse.move(X + 160, Y + 140, { steps: 6 }); await pg.mouse.up();
    // Aa reopens the text sheet
    await pg.click('#btn-adjust-text'); await pg.waitForSelector('#f-text'); await pg.fill('#f-text', 'Crack 2'); await pg.click('#btn-place'); await pg.waitForTimeout(200);
    await pg.click('#btn-adjust-done'); await pg.waitForTimeout(300);
    const r1 = await rect(); ok(r1 === r0, W + ' canvas same after tick ' + r0 + ' vs ' + r1);
    const o = await pg.evaluate(() => 0);
    // drop leader onto box removes it: re-edit
    await pg.click('#btn-text-tool'); await pg.click('#btn-select').catch(() => {});
    await pg.screenshot({ path: '/tmp/claude-0/an/tl_' + W + '.png' });
    ok(errs.length === 0, W + ' errs ' + errs.join('|'));
    await ctx.close();
  }
  console.log('pass', pass, 'fail', fail); await b.close();
})();
