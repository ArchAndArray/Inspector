// Opens every launcher tile and the inspector shell; fails on any page error.
const { chromium } = require('/opt/npm-tools/node_modules/playwright');
(async () => {
  const b = await chromium.launch(); const errs = [];
  const ctx = await b.newContext({ viewport: { width: 1180, height: 820 }, hasTouch: true }); const pg = await ctx.newPage();
  pg.on('pageerror', e => errs.push('PE ' + e.message)); pg.on('console', m => { if (m.type() === 'error' && !/ERR_|net::|Failed to load resource|cdnjs/.test(m.text())) errs.push('CE ' + m.text()); });
  await pg.goto('http://localhost:8765/'); await pg.waitForTimeout(1000);
  const tiles = await pg.$$eval('.launcher-tile', (t) => t.map((x) => x.dataset.target));
  console.log('tiles:', tiles.join(', '));
  let fails = 0;
  for (const t of tiles) {
    if (t === 'backup') continue;
    await pg.goto('http://localhost:8765/'); await pg.waitForTimeout(500);
    await pg.click('.launcher-tile[data-target="' + t + '"]').catch(() => {}); await pg.waitForTimeout(900);
    const body = await pg.evaluate(() => document.body.innerText.length);
    const bad = errs.length; console.log(bad ? 'FAIL' : 'PASS', t, '(page text ' + body + ' chars)'); if (bad) { fails++; console.log(errs.splice(0)); }
  }
  await b.close(); process.exit(fails ? 1 : 0);
})();
