// Uses REAL mouse input (full browser hit-testing, so overlapping canvases matter), not events dispatched straight onto the canvas.
const { chromium } = require('/opt/npm-tools/node_modules/playwright');
(async () => {
  const b = await chromium.launch(); const errs = [];
  const ctx = await b.newContext({ viewport: { width: 1180, height: 820 } }); const pg = await ctx.newPage();
  pg.on('pageerror', e => errs.push('PE ' + e.message));
  await pg.goto('http://localhost:8765/'); await pg.waitForTimeout(800);
  await pg.click('.launcher-tile[data-target="sketch"]'); await pg.waitForSelector('#mark-canvas'); await pg.waitForTimeout(500);
  let fails = 0; const ok = (n, c) => { if (!c) fails++; console.log(c ? 'PASS' : 'FAIL', n); };
  const box = await pg.evaluate(() => { const r = document.querySelector('#mark-canvas').getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; });
  const X = box[0] + box[2] / 2, Y = box[1] + box[3] / 2;
  const mdrag = async (x0, y0, x1, y1, n = 12) => { await pg.mouse.move(x0, y0); await pg.mouse.down(); for (let i = 1; i <= n; i++) await pg.mouse.move(x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n); await pg.mouse.up(); await pg.waitForTimeout(120); };
  const ink = (x, y) => pg.evaluate(([x, y]) => { const c = document.querySelector('#mark-canvas'), r = c.getBoundingClientRect(), k = c.width / r.width; const cx = Math.round((x - r.left) * k), cy = Math.round((y - r.top) * k), rr = Math.round(5 * k); const d = c.getContext('2d').getImageData(Math.max(0, cx - rr), Math.max(0, cy - rr), rr * 2, rr * 2).data; for (let i = 3; i < d.length; i += 4) if (d[i] > 40) return true; return false; }, [x, y]);
  const px = (x, y) => pg.evaluate(([x, y]) => { const c = document.querySelector('#mark-canvas'), r = c.getBoundingClientRect(), k = c.width / r.width; const d = c.getContext('2d').getImageData(Math.round((x - r.left) * k), Math.round((y - r.top) * k), 1, 1).data; return [d[0], d[1], d[2], d[3]]; }, [x, y]);

  // --- 3. custom colours ---
  ok('empty custom slots show a + ', await pg.evaluate(() => [...document.querySelectorAll('.color-dot-custom')].every((d) => d.textContent === '+')));
  await pg.click('.color-dot-custom[data-custom-index="0"]'); await pg.waitForSelector('#f-custom-color');
  ok('tapping an empty custom slot opens the colour picker', true);
  await pg.evaluate(() => { const i = document.querySelector('#f-custom-color'); i.value = '#12a34b'; }); await pg.click('#btn-save-color'); await pg.waitForTimeout(150);
  ok('slot now holds the colour and is selected', await pg.evaluate(() => { const d = document.querySelector('.color-dot-custom[data-custom-index="0"]'); return d.classList.contains('active') && d.textContent === '' && getComputedStyle(d).backgroundColor === 'rgb(18, 163, 75)'; }));
  await mdrag(X - 200, Y - 150, X - 100, Y - 150);
  const c1 = await px(X - 150, Y - 150); ok('pen draws in the custom colour', c1[1] > c1[0] + 40 && c1[3] > 100);
  await pg.click('#color-row-fixed .color-dot:nth-child(1)'); await pg.click('.color-dot-custom[data-custom-index="0"]');
  ok('tapping a filled custom slot selects it again', await pg.evaluate(() => document.querySelector('.color-dot-custom[data-custom-index="0"]').classList.contains('active')));

  // --- 2. text tool with real clicks ---
  await pg.click('#btn-text-tool');
  ok('text tool does not leave you in a text layer (pen layer still drawable)', await pg.evaluate(() => getComputedStyle(document.querySelector('#annotation-canvas')).pointerEvents === 'none'));
  await pg.mouse.click(X + 100, Y - 100); await pg.waitForSelector('#f-text', { timeout: 3000 }).catch(() => {});
  ok('one tap with the text tool opens the text box', await pg.evaluate(() => !!document.querySelector('#f-text')));
  await pg.fill('#f-text', 'C1 crack'); await pg.click('#btn-place'); await pg.waitForTimeout(300);
  const confirmBtn = await pg.$('#btn-adjust-done'); if (confirmBtn) await confirmBtn.click(); await pg.waitForTimeout(200);
  await pg.click('#btn-pen-tool'); await mdrag(X - 200, Y, X - 100, Y);
  ok('after placing text, the pen draws straight away (no layer toggle)', await ink(X - 150, Y));
  // tapping existing text with the Select tool offers Edit / Delete
  await pg.click('#btn-select'); await pg.mouse.click(X + 100, Y - 100); await pg.waitForTimeout(250);
  ok('Select can pick up existing text (Edit / Delete sheet)', await pg.evaluate(() => !!document.querySelector('#btn-ao-edit')));
  await pg.click('#btn-ao-cancel'); await pg.click('#btn-select');

  // --- 1. erased lines are not selectable ---
  await pg.click('#btn-pen-tool'); await mdrag(X - 200, Y + 100, X + 100, Y + 100);
  ok('line drawn', await ink(X - 50, Y + 100));
  await pg.click('#btn-erase'); await mdrag(X - 120, Y + 100, X + 20, Y + 100, 14);
  ok('eraser rubbed out the middle', !(await ink(X - 50, Y + 100)) && await ink(X - 190, Y + 100));
  await pg.click('#btn-select');
  await pg.mouse.click(X - 50, Y + 100); await pg.waitForTimeout(150);
  ok('tapping the erased gap selects nothing', await pg.evaluate(() => document.querySelector('.sel-bar').style.display === 'none'));
  await pg.mouse.click(X - 190, Y + 100); await pg.waitForTimeout(150);
  ok('tapping the part that is left still selects it', await pg.evaluate(() => document.querySelector('.sel-bar').style.display === 'flex'));
  await pg.mouse.click(X, Y + 250); await pg.waitForTimeout(100);
  // marquee over only the erased gap
  await mdrag(X - 110, Y + 80, X + 10, Y + 120, 8);
  ok('a selection box over only the erased gap picks nothing', await pg.evaluate(() => document.querySelector('.sel-bar').style.display === 'none'));
  await mdrag(X - 260, Y + 70, X + 140, Y + 130, 8);
  ok('a selection box over the whole line picks it', await pg.evaluate(() => /1 selected|flex/.test(document.querySelector('.sel-bar').style.display)));
  // a fully erased stroke
  await pg.mouse.click(X, Y + 250);
  await pg.click('#btn-pen-tool'); await mdrag(X + 150, Y + 150, X + 200, Y + 150, 6);
  await pg.click('#btn-erase'); await mdrag(X + 130, Y + 150, X + 220, Y + 150, 10);
  await pg.click('#btn-select'); await mdrag(X + 120, Y + 120, X + 240, Y + 180, 8);
  ok('a completely erased stroke cannot be selected or copied', await pg.evaluate(() => document.querySelector('.sel-bar').style.display === 'none'));
  ok('no page errors', errs.length === 0); if (errs.length) console.log(errs.slice(0, 5));
  await b.close(); process.exit(fails ? 1 : 0);
})();
