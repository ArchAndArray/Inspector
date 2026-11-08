// The contract every caller of openAnnotator() relies on (inspection photos, PDF page editor, Scale/Annotate, drawings, monitoring):
// callback fires once on a save, not on Back/discard; annotatedBlob is written; old records still open; reopening restores everything.
const { chromium } = require('/opt/npm-tools/node_modules/playwright');
(async () => {
  const b = await chromium.launch(); const errs = [];
  const ctx = await b.newContext({ viewport: { width: 1180, height: 820 }, hasTouch: true });
  const pg = await ctx.newPage();
  pg.on('pageerror', e => errs.push('PE ' + e.message)); pg.on('console', m => { if (m.type() === 'error' && !/ERR_TUNNEL|ERR_FAILED|net::/.test(m.text())) errs.push('CE ' + m.text()); });
  await pg.goto('http://localhost:8765/'); await pg.waitForTimeout(1000);
  let fails = 0; const ok = (n, c) => { if (!c) fails++; console.log(c ? 'PASS' : 'FAIL', n); };
  const mkPhoto = (kind, withInk) => pg.evaluate(async ([kind, withInk]) => {
    const c = document.createElement('canvas'); c.width = 800; c.height = 600; const x = c.getContext('2d'); x.fillStyle = '#7a8f9e'; x.fillRect(0, 0, 800, 600);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
    const p = await DB.addPhoto({ kind, originalBlob: blob });
    if (withInk) { // legacy record: a PNG mark layer from before the rework + a text object, no stroke list
      const m = document.createElement('canvas'); m.width = 800; m.height = 600; const mx = m.getContext('2d'); mx.strokeStyle = '#e5322d'; mx.lineWidth = 10; mx.beginPath(); mx.moveTo(100, 100); mx.lineTo(300, 100); mx.stroke();
      const mb = await new Promise((r) => m.toBlob(r, 'image/png'));
      const rec = await DB.get('photos', p.id); rec.editableMarkBlob = mb; rec.annotatedBlob = blob; rec.annotationObjects = []; await DB.put('photos', rec);
    }
    return p.id;
  }, [kind, withInk]);
  const open = async (id) => { await pg.evaluate((id) => { window.__done = (window.__done || 0); openAnnotator(id, () => { window.__done++; }); }, id); await pg.waitForSelector('#mark-canvas'); await pg.waitForTimeout(500); };
  const doneCount = () => pg.evaluate(() => window.__done || 0);
  const gone = () => pg.evaluate(() => !document.querySelector('#annotate-view'));
  const ev = (type, id, x, y) => pg.evaluate(([type, id, x, y]) => { const c = document.querySelector('#mark-canvas'); c.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'pen', clientX: x, clientY: y, pressure: type === 'pointerup' ? 0 : 0.5, isPrimary: true, bubbles: true, cancelable: true })); }, [type, id, x, y]);
  let pid = 1; const drag = async (x0, y0, x1, y1, n = 10) => { const id = pid++; await ev('pointerdown', id, x0, y0); for (let i = 1; i <= n; i++) await ev('pointermove', id, x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n); await ev('pointerup', id, x1, y1); await pg.waitForTimeout(120); };
  const box = () => pg.evaluate(() => { const r = document.querySelector('#mark-canvas').getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; });
  const inkAt = (cx, cy) => pg.evaluate(([cx, cy]) => { const c = document.querySelector('#mark-canvas'); const d = c.getContext('2d').getImageData(Math.max(0, cx - 6), Math.max(0, cy - 6), 12, 12).data; for (let i = 3; i < d.length; i += 4) if (d[i] > 40) return true; return false; }, [cx, cy]);
  const rec = (id) => pg.evaluate((id) => DB.get('photos', id).then((p) => ({ ann: !!p.annotatedBlob, mark: !!p.editableMarkBlob, strokes: p.editableStrokes ? p.editableStrokes.length : 0, meta: !!p.editableMeta, objs: (p.annotationObjects || []).length })), id);

  // 1. flatten & commit
  let id = await mkPhoto('pdfPage'); await open(id); let [bx, by, bw, bh] = await box();
  await drag(bx + 100, by + 100, bx + 300, by + 100);
  await pg.click('#btn-done'); await pg.waitForTimeout(150); await pg.click('[data-act=flatten]'); await pg.waitForTimeout(1200);
  let r = await rec(id); ok('flatten: view closed, callback once, annotatedBlob set, strokes cleared', await gone() && await doneCount() === 1 && r.ann && r.strokes === 0 && !r.meta);
  await open(id); [bx, by, bw, bh] = await box();
  ok('flattened result reopens as the picture (stroke is part of the photo, nothing editable)', await pg.evaluate(([x, y]) => { const d = document.querySelector('#photo-canvas').getContext('2d').getImageData(x - 4, y - 4, 8, 8).data; let red = 0; for (let i = 0; i < d.length; i += 4) if (d[i] > 150 && d[i + 1] < 110) red++; return red > 5; }, [Math.round(200 * 800 / bw), Math.round(100 * 600 / bh)]) && !(await inkAt(Math.round(200 * 800 / bw), Math.round(100 * 600 / bh))));
  await pg.click('#btn-cancel'); await pg.waitForTimeout(200); ok('Back with no edits closes, no callback', await gone() && await doneCount() === 1);

  // 2. keep editable, then reopen and keep going
  id = await mkPhoto('finding'); await open(id); [bx, by, bw, bh] = await box();
  await pg.click('#btn-layers'); await pg.click('.layers-panel [data-lp=add]'); await pg.click('#btn-layers');
  await drag(bx + 100, by + 100, bx + 300, by + 100);
  await pg.click('#btn-layers'); await pg.click('.layers-panel [data-lp=trace]'); await pg.click('#btn-layers');
  await pg.click('#btn-done'); await pg.waitForTimeout(150); await pg.click('[data-act=editable]'); await pg.waitForTimeout(1200);
  r = await rec(id); ok('editable: callback fired, strokes + layer meta saved', await gone() && await doneCount() === 2 && r.ann && r.mark && r.strokes === 1 && r.meta);
  await open(id); [bx, by, bw, bh] = await box();
  const kx0 = 800 / bw, ky0 = 600 / bh; ok('reopen restores the stroke', await inkAt(Math.round(200 * kx0), Math.round(100 * ky0)));
  const re = await pg.evaluate(() => ({ layers: document.querySelectorAll('.lp-list .lp-row').length, chip: document.querySelector('#btn-layers span').textContent, photoOp: document.querySelector('#photo-canvas').style.opacity }));
  ok('reopen restores 2 layers and the tracing fade', /2/.test(re.chip) && re.photoOp === '0.3');
  await pg.click('#btn-layers'); ok('layer panel lists 2 layers after reopen', await pg.evaluate(() => document.querySelectorAll('.lp-list .lp-row').length === 2)); await pg.click('#btn-layers');
  await pg.click('#btn-undo'); ok('undo after reopen removes the saved stroke (individually editable)', !(await inkAt(Math.round(200 * kx0), Math.round(100 * ky0))));
  await drag(bx + 100, by + 200, bx + 300, by + 200);
  await pg.click('#btn-done'); await pg.waitForTimeout(150); await pg.click('[data-act=discard]'); await pg.waitForTimeout(500);
  r = await rec(id); ok('discard: view closed, no callback, record unchanged (still 1 stroke)', await gone() && await doneCount() === 2 && r.strokes === 1);

  // 3. legacy record: raster mark layer, no strokes
  id = await mkPhoto('element', true); await open(id); [bx, by, bw, bh] = await box();
  const kx = bw / 800, ky = bh / 600;
  ok('legacy mark layer shows on open', await pg.evaluate(() => { const c = document.querySelector('#mark-canvas'); const d = c.getContext('2d').getImageData(190, 95, 20, 10).data; for (let i = 3; i < d.length; i += 4) if (d[i] > 40) return true; return false; }));
  await drag(bx + 100 * kx, by + 300 * ky, bx + 300 * kx, by + 300 * ky);
  await pg.click('#btn-done'); await pg.waitForTimeout(150); await pg.click('[data-act=editable]'); await pg.waitForTimeout(1200); r = await rec(id);
  ok('legacy record saved: keeps raster layer and gains strokes', await gone() && r.mark && r.strokes === 1 && await doneCount() === 3);

  // 4. Back WITH edits asks before throwing away
  id = await mkPhoto('pdfPage'); await open(id); [bx, by, bw, bh] = await box();
  await drag(bx + 100, by + 100, bx + 300, by + 100); await pg.click('#btn-cancel'); await pg.waitForTimeout(250);
  ok('Back with edits does not just close', !(await gone()));
  await pg.evaluate(() => { const b = document.querySelector('[data-act=discard]'); if (b) b.click(); }); await pg.waitForTimeout(400);
  ok('discard from Back closes with no callback', await gone() && await doneCount() === 3);
  ok('no page errors', errs.length === 0); if (errs.length) console.log(errs.slice(0, 6));
  await b.close(); process.exit(fails ? 1 : 0);
})();
