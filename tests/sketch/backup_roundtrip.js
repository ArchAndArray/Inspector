// Backup -> wipe -> restore must keep a "saved, keep editable" sketch editable (raster layer, strokes, layers, tracing fade).
const { chromium } = require('/opt/npm-tools/node_modules/playwright'); const fs = require('fs');
(async () => {
  const b = await chromium.launch(); const errs = [];
  const ctx = await b.newContext({ viewport: { width: 1180, height: 820 }, hasTouch: true, acceptDownloads: true });
  const pg = await ctx.newPage(); pg.on('pageerror', e => errs.push('PE ' + e.message));
  await pg.goto('http://localhost:8765/'); await pg.waitForTimeout(1000);
  let fails = 0; const ok = (n, c) => { if (!c) fails++; console.log(c ? 'PASS' : 'FAIL', n); };
  const id = await pg.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 800; c.height = 600; c.getContext('2d').fillRect(0, 0, 800, 600);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9)); const p = await DB.addPhoto({ kind: 'pdfPage', originalBlob: blob });
    const m = document.createElement('canvas'); m.width = 800; m.height = 600; m.getContext('2d').fillRect(0, 0, 50, 50); const mb = await new Promise((r) => m.toBlob(r, 'image/png'));
    await DB.saveEditableAnnotation(p.id, blob, mb, [], [{ id: 's1', k: 'line', c: '#e5322d', w: 5, pts: [[1, 1], [50, 50]], ly: 'l1' }], { layers: [{ id: 'l1', name: 'Layer 1', vis: true, lock: false, op: 1 }], active: 'l1', bg: { vis: true, op: 0.3 } });
    return p.id;
  });
  const [dl] = await Promise.all([pg.waitForEvent('download'), pg.evaluate(() => exportRawDataBackup())]);
  const path = await dl.path(); const text = fs.readFileSync(path, 'utf8');
  await pg.evaluate((id) => DB.delete('photos', id), id);
  ok('photo wiped', await pg.evaluate((id) => DB.get('photos', id).then((p) => !p), id));
  await pg.evaluate(async (t) => { await importRawDataBackup(new File([t], 'b.json', { type: 'application/json' })); }, text);
  const r = await pg.evaluate((id) => DB.get('photos', id).then((p) => ({ markIsBlob: p.editableMarkBlob instanceof Blob, markSize: p.editableMarkBlob && p.editableMarkBlob.size, strokes: (p.editableStrokes || []).length, bg: p.editableMeta && p.editableMeta.bg.op })), id);
  ok('restored: raster mark layer is a real image again', r.markIsBlob && r.markSize > 0);
  ok('restored: strokes and tracing fade kept', r.strokes === 1 && r.bg === 0.3);
  await pg.evaluate((id) => { openAnnotator(id, () => {}); }, id); await pg.waitForSelector('#mark-canvas'); await pg.waitForTimeout(600);
  ok('restored sketch opens in the annotator without errors', errs.length === 0);
  if (errs.length) console.log(errs.slice(0, 4));
  await b.close(); process.exit(fails ? 1 : 0);
})();
