const { chromium } = require('/opt/npm-tools/node_modules/playwright');
(async () => {
  const b = await chromium.launch(); const errs = [];
  const ctx = await b.newContext({ viewport: { width: 1180, height: 820 }, hasTouch: true });
  const pg = await ctx.newPage();
  pg.on('pageerror', e => errs.push('PE ' + e.message)); pg.on('console', m => { if (m.type() === 'error' && !/ERR_TUNNEL|ERR_FAILED/.test(m.text())) errs.push('CE ' + m.text()); });
  pg.on('dialog', d => d.accept());
  await pg.goto('http://localhost:8765/'); await pg.waitForTimeout(800);
  await pg.click('.launcher-tile[data-target="sketch"]'); await pg.waitForSelector('#mark-canvas'); await pg.waitForTimeout(500);
  let fails = 0; const ok = (n, c) => { if (!c) fails++; console.log(c ? 'PASS' : 'FAIL', n); };
  const ev = (type, id, x, y) => pg.evaluate(([type, id, x, y]) => { const c = document.querySelector('#mark-canvas'); c.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'pen', clientX: x, clientY: y, pressure: type === 'pointerup' ? 0 : 0.5, isPrimary: true, bubbles: true, cancelable: true })); }, [type, id, x, y]);
  const drag = async (id, x0, y0, x1, y1, n = 10) => { await ev('pointerdown', id, x0, y0); for (let i = 1; i <= n; i++) await ev('pointermove', id, x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n); await ev('pointerup', id, x1, y1); await pg.waitForTimeout(120); };
  const alpha = (x, y) => pg.evaluate(([x, y]) => { const c = document.querySelector('#mark-canvas'), r = c.getBoundingClientRect(), k = c.width / r.width; const cx = Math.round((x - r.left) * k), cy = Math.round((y - r.top) * k), rr = Math.round(4 * k); const d = c.getContext('2d').getImageData(Math.max(0, cx - rr), Math.max(0, cy - rr), rr * 2, rr * 2).data; let m = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > m) m = d[i]; return m; }, [x, y]);
  const box = await pg.evaluate(() => { const r = document.querySelector('#mark-canvas').getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; });
  const X = box[0] + box[2] / 2, Y = box[1] + box[3] / 2;
  let id = 1;
  const panel = async (sel) => { await pg.click(sel); await pg.waitForTimeout(60); };
  const open = async () => { if (await pg.evaluate(() => document.querySelector('.layers-panel').style.display === 'none')) await pg.click('#btn-layers'); await pg.waitForTimeout(60); };
  const shut = async () => { if (await pg.evaluate(() => document.querySelector('.layers-panel').style.display !== 'none')) await pg.click('#btn-layers'); await pg.waitForTimeout(60); };
  await drag(id++, X - 200, Y - 100, X - 100, Y - 100);               // A on layer 1
  ok('A drawn', await alpha(X - 150, Y - 100) > 100);
  await open(); await panel('.layers-panel [data-lp=add]');
  ok('two layers, chip shows count', await pg.evaluate(() => document.querySelectorAll('.lp-list .lp-row').length === 2 && /2/.test(document.querySelector('#btn-layers span').textContent)));
  await shut();
  await drag(id++, X + 100, Y - 100, X + 200, Y - 100);               // B on layer 2
  ok('B drawn, A still there', await alpha(X + 150, Y - 100) > 100 && await alpha(X - 150, Y - 100) > 100);
  // hide layer 2 (top row)
  await open(); await panel('.lp-list .lp-row:first-child [data-lp=vis]');
  ok('hiding layer 2 hides B only', await alpha(X + 150, Y - 100) === 0 && await alpha(X - 150, Y - 100) > 100);
  await panel('.lp-list .lp-row:first-child [data-lp=vis]');
  ok('showing it brings B back', await alpha(X + 150, Y - 100) > 100);
  // lock layer 2: drawing blocked
  await panel('.lp-list .lp-row:first-child [data-lp=lock]'); await shut();
  await drag(id++, X - 50, Y + 100, X + 50, Y + 100);
  ok('locked layer blocks drawing', await alpha(X, Y + 100) === 0);
  await open(); await panel('.lp-list .lp-row:first-child [data-lp=lock]'); await shut();
  // erase on layer 2 across A must not touch A
  await pg.click('#btn-erase'); await drag(id++, X - 230, Y - 100, X - 70, Y - 100, 16);
  ok('eraser only affects the active layer (A survives)', await alpha(X - 150, Y - 100) > 100);
  await pg.click('#btn-pen-tool');
  // switch active to layer 1 and erase A
  await open(); await panel('.lp-list .lp-row:last-child [data-lp=pick]'); await shut();
  await pg.click('#btn-erase'); await drag(id++, X - 230, Y - 100, X - 70, Y - 100, 16);
  ok('erasing on layer 1 removes A', await alpha(X - 150, Y - 100) === 0 && await alpha(X + 150, Y - 100) > 100);
  await pg.click('#btn-undo'); await pg.click('#btn-pen-tool');
  // opacity
  await open();
  await pg.evaluate(() => { const r = document.querySelector('.lp-list .lp-row:first-child .lp-op'); r.value = 50; r.dispatchEvent(new Event('input', { bubbles: true })); });
  const a50 = await alpha(X + 150, Y - 100); ok('layer opacity 50% (alpha ~half)', a50 > 80 && a50 < 190);
  await pg.evaluate(() => { const r = document.querySelector('.lp-list .lp-row:first-child .lp-op'); r.value = 100; r.dispatchEvent(new Event('input', { bubbles: true })); });
  // reorder keeps both visible
  await panel('.lp-list .lp-row:first-child [data-lp=down]');
  ok('reorder: layer 2 now bottom row', await pg.evaluate(() => document.querySelector('.lp-list .lp-row:last-child .lp-name').textContent.startsWith('Layer 2')) && await alpha(X + 150, Y - 100) > 100);
  // tracing paper
  await panel('.layers-panel [data-lp=trace]');
  ok('trace fades photo, white paper behind', await pg.evaluate(() => document.querySelector('#photo-canvas').style.opacity === '0.3' && document.querySelector('#canvas-stack').style.background.includes('255')));
  // save editable and inspect the record
  await shut(); await pg.click('#btn-done'); await pg.waitForTimeout(200);
  await pg.click('[data-act=editable]'); await pg.waitForTimeout(1200);
  const rec = await pg.evaluate(async () => { const all = await DB.getAll('photos'); const p = all.filter((q) => q.editableMeta)[0]; return p ? { layers: p.editableMeta.layers.length, bg: p.editableMeta.bg, ly: [...new Set(p.editableStrokes.map((s) => s.ly))].length, n: p.editableStrokes.length } : null; });
  ok('saved: 2 layers, bg 0.3, strokes tagged', !!rec && rec.layers === 2 && rec.bg.op === 0.3 && rec.ly === 2 && rec.n >= 2);
  console.log(JSON.stringify(rec));
  ok('no page errors', errs.length === 0); if (errs.length) console.log(errs.slice(0, 5));
  await b.close(); process.exit(fails ? 1 : 0);
})();
