const { chromium } = require('/opt/npm-tools/node_modules/playwright');
(async () => {
  const b = await chromium.launch(); const errs = [];
  const ctx = await b.newContext({ viewport: { width: 1180, height: 820 }, hasTouch: true });
  const pg = await ctx.newPage();
  pg.on('pageerror', e => errs.push('PE ' + e.message)); pg.on('console', m => { if (m.type() === 'error' && !/ERR_TUNNEL|ERR_FAILED/.test(m.text())) errs.push('CE ' + m.text()); });
  await pg.goto('http://localhost:8765/'); await pg.waitForTimeout(800);
  await pg.click('.launcher-tile[data-target="sketch"]'); await pg.waitForSelector('#mark-canvas'); await pg.waitForTimeout(500);
  const ink = () => pg.evaluate(() => { const c = document.querySelector('#mark-canvas'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++; return n; });
  const ev = (type, id, ptype, x, y, t) => pg.evaluate(([type, id, ptype, x, y]) => { const c = document.querySelector('#mark-canvas'); c.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: ptype, clientX: x, clientY: y, pressure: type === 'pointerup' ? 0 : 0.5, isPrimary: true, bubbles: true, cancelable: true })); }, [type, id, ptype, x, y]);
  const drag = async (id, pt, x0, y0, x1, y1, n = 12) => { await ev('pointerdown', id, pt, x0, y0); for (let i = 1; i <= n; i++) await ev('pointermove', id, pt, x0 + (x1 - x0) * i / n + Math.sin(i) * 3, y0 + (y1 - y0) * i / n); await ev('pointerup', id, pt, x1, y1); };
  const box = await pg.evaluate(() => { const r = document.querySelector('#mark-canvas').getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; });
  const X = box[0] + box[2] / 2, Y = box[1] + box[3] / 2;
  const ok = (n, c) => console.log(c ? 'PASS' : 'FAIL', n);
  await drag(1, 'pen', X - 200, Y - 50, X + 200, Y - 50); const i1 = await ink();
  await drag(2, 'pen', X - 200, Y + 50, X + 200, Y + 80); const i2 = await ink();
  ok('two strokes draw', i1 > 0 && i2 > i1);
  await pg.click('#btn-undo'); const iu = await ink(); ok('undo removes last', iu === i1);
  await pg.click('#btn-redo'); const ir = await ink(); ok('redo restores identical pixels', ir === i2);
  await pg.click('#btn-undo'); await drag(3, 'pen', X, Y - 100, X + 50, Y + 100); await pg.click('#btn-redo'); ok('new stroke clears redo', (await ink()) > i1 && (await pg.evaluate(() => document.querySelector('#btn-redo').style.opacity)) === '0.45');
  // two finger tap undo
  await pg.waitForTimeout(500); const before = await ink();
  await ev('pointerdown', 11, 'touch', X - 40, Y + 150); await ev('pointerdown', 12, 'touch', X + 40, Y + 150); await ev('pointerup', 11, 'touch', X - 40, Y + 150); await ev('pointerup', 12, 'touch', X + 40, Y + 150);
  ok('two-finger tap undoes', (await ink()) < before);
  // hold to straighten
  await ev('pointerdown', 21, 'pen', X - 300, Y + 200); for (let i = 1; i <= 8; i++) await ev('pointermove', 21, 'pen', X - 300 + i * 20, Y + 200 + (i % 2 ? 6 : -6));
  const wiggly = await ink(); await pg.waitForTimeout(1000); const straight = await ink(); await ev('pointerup', 21, 'pen', X - 140, Y + 200);
  ok('hold straightens (pixels change)', straight !== wiggly);
  // pen settings
  await pg.click('#btn-more'); await pg.click('#btn-pen-settings'); await pg.waitForTimeout(150);
  ok('pen sheet opens', await pg.evaluate(() => !!document.querySelector('.pen-seg')));
  await pg.click('.pen-seg[data-k="holdStraighten"] button[data-v="false"]'); await pg.click('#btn-pen-done');
  ok('pref saved', await pg.evaluate(() => JSON.parse(localStorage.getItem('annotate.inkPrefs')).holdStraighten === false));
  // rotate keeps strokes
  const pre = await ink(); await pg.click('#btn-rotate'); await pg.waitForTimeout(300); const post = await ink();
  ok('rotate keeps ink (±15%)', Math.abs(post - pre) / pre < 0.15);
  await pg.click('#btn-undo'); ok('undo works after rotate', (await ink()) < post);
  // performance: 300 strokes then one more stroke latency
  await pg.evaluate(() => { const c = document.querySelector('#mark-canvas'); const r = c.getBoundingClientRect(); for (let s = 0; s < 300; s++) { const x0 = r.x + 50 + (s % 20) * 30, y0 = r.y + 50 + Math.floor(s / 20) * 20; c.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 100 + s, pointerType: 'pen', clientX: x0, clientY: y0, pressure: .5, isPrimary: true, bubbles: true })); for (let i = 1; i <= 15; i++) c.dispatchEvent(new PointerEvent('pointermove', { pointerId: 100 + s, pointerType: 'pen', clientX: x0 + i * 2, clientY: y0 + (i % 3), pressure: .5, isPrimary: true, bubbles: true })); c.dispatchEvent(new PointerEvent('pointerup', { pointerId: 100 + s, pointerType: 'pen', clientX: x0 + 30, clientY: y0, pressure: 0, isPrimary: true, bubbles: true })); } });
  const tm = await pg.evaluate(() => { const c = document.querySelector('#mark-canvas'); const r = c.getBoundingClientRect(); const t0 = performance.now(); c.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 999, pointerType: 'pen', clientX: r.x + 100, clientY: r.y + 400, pressure: .5, isPrimary: true, bubbles: true })); for (let i = 1; i <= 30; i++) c.dispatchEvent(new PointerEvent('pointermove', { pointerId: 999, pointerType: 'pen', clientX: r.x + 100 + i * 5, clientY: r.y + 400 + i, pressure: .5, isPrimary: true, bubbles: true })); const t1 = performance.now(); c.dispatchEvent(new PointerEvent('pointerup', { pointerId: 999, pointerType: 'pen', clientX: r.x + 250, clientY: r.y + 430, pressure: 0, isPrimary: true, bubbles: true })); const t2 = performance.now(); return [t1 - t0, t2 - t1]; });
  console.log('30 moves with 300 strokes ms', tm[0].toFixed(1), 'finish ms', tm[1].toFixed(1)); ok('stroke latency fine', tm[0] < 300);
  await pg.click('#btn-undo'); const tu = await pg.evaluate(() => 0);
  // save editable and check DB
  await pg.click('#btn-done'); await pg.click('[data-act=editable]'); await pg.waitForTimeout(800);
  const saved = await pg.evaluate(() => new Promise((res) => { const rq = indexedDB.databases ? indexedDB.databases() : Promise.resolve([]); rq.then(async (dbs) => { const out = []; for (const d of dbs) { const o = indexedDB.open(d.name); await new Promise((r) => { o.onsuccess = () => { const db = o.result; if (!db.objectStoreNames.contains('photos')) { db.close(); return r(); } const g = db.transaction('photos').objectStore('photos').getAll(); g.onsuccess = () => { g.result.forEach(p => { if (p.editableStrokes) out.push(p.editableStrokes.length); }); db.close(); r(); }; }; }); } res(out); }); }));
  console.log('saved strokes counts', JSON.stringify(saved)); ok('strokes persisted', saved.length > 0 && saved[0] > 300);
  console.log('errs', JSON.stringify(errs)); await b.close();
})();
