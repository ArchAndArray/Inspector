// cadexport.js — CAD export screen (PDF / PNG / DXF), "insert into report", and DXF import.
// Uses the pure modules CadPlot and CadDxf; globals from app.js: el, presentOverlay, esc, toast,
// downloadBlob, DB, navigate.

function cadSafeFile(name) { return String(name || 'drawing').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'drawing'; }

function cadOpenExportSheet(doc, onChanged) {
  if (!doc.entities.length) { toast('Nothing to export yet. Draw something first.'); return; }
  const d = doc.d;
  const tb0 = Object.assign(CadPlot.defaultTitleBlock(d), d.titleBlock || {});
  const ex0 = Object.assign({ format: 'pdf', size: 'A4', landscape: true, scale: 'fit', mono: false }, d.exportOpts || {});
  const stdOpts = CadPlot.STD_SCALES.slice(0, 20).map((s) => `<option value="${s}">1 : ${s}</option>`).join('');
  const sheet = el(`
    <div class="sheet-backdrop"><div class="sheet" style="max-height:90vh; overflow:auto;">
      <div class="sheet-handle"></div>
      <h2>Export drawing</h2>
      <div class="field"><label>Format</label>
        <select id="ex-format"><option value="pdf">PDF (vector, with title block)</option><option value="png">PNG image (with title block)</option><option value="dxf">DXF (for AutoCAD / BricsCAD)</option></select></div>
      <div id="ex-sheetopts">
        <div style="display:flex; gap:10px;">
          <div class="field" style="flex:1"><label>Sheet</label><select id="ex-size"><option>A4</option><option>A3</option></select></div>
          <div class="field" style="flex:1"><label>Orientation</label><select id="ex-orient"><option value="l">Landscape</option><option value="p">Portrait</option></select></div>
        </div>
        <div class="field"><label>Scale</label><select id="ex-scale"><option value="fit">Fit to sheet</option><option value="plot">Drawing plot scale (1 : ${d.plotScale || 50})</option>${stdOpts}</select></div>
        <label class="cad-mode" style="margin-bottom:10px"><input type="checkbox" id="ex-mono"> Black and white</label>
        <div id="ex-warn" style="display:none; color:#b3261e; font-size:13px; margin-bottom:8px"></div>
        <canvas id="ex-prev" style="display:block; max-width:100%; max-height:230px; margin:0 auto 12px; border:1px solid #d3d6db; border-radius:8px; background:#fff"></canvas>
        <div class="field"><label>Project / structure</label><input type="text" id="tb-project" value="${esc(tb0.project)}"></div>
        <div class="field"><label>Drawing title</label><input type="text" id="tb-title" value="${esc(tb0.title)}"></div>
        <div style="display:flex; gap:10px;">
          <div class="field" style="flex:2"><label>Drawing no.</label><input type="text" id="tb-no" value="${esc(tb0.drawingNo)}"></div>
          <div class="field" style="flex:1"><label>Rev</label><input type="text" id="tb-rev" value="${esc(tb0.rev)}"></div>
          <div class="field" style="flex:2"><label>Date</label><input type="text" id="tb-date" value="${esc(tb0.date)}"></div>
        </div>
        <div style="display:flex; gap:10px;">
          <div class="field" style="flex:1"><label>Drawn by</label><input type="text" id="tb-drawn" value="${esc(tb0.drawnBy)}"></div>
          <div class="field" style="flex:1"><label>Checked by</label><input type="text" id="tb-checked" value="${esc(tb0.checkedBy)}"></div>
        </div>
      </div>
      <p id="ex-dxfnote" class="muted" style="display:none; font-size:13px">DXF is written as AutoCAD R12 ASCII, the most widely readable version. Layers, lines, circles, arcs, polylines, points and text are kept. Dimensions are exported as plain lines and text, and multi-line text as one line per row.</p>
      <div style="position:sticky; bottom:0; background:#fff; padding-top:8px;">
        <button class="btn btn-primary btn-block" id="ex-save">Save file</button>
        <button class="btn btn-secondary btn-block" id="ex-insert" style="margin-top:8px;">Insert into a report…</button>
        <button class="btn btn-ghost btn-block" id="ex-cancel">Close</button>
      </div>
    </div></div>`);
  presentOverlay(sheet);
  const $ = (id) => sheet.querySelector(id);
  $('#ex-format').value = ex0.format; $('#ex-size').value = ex0.size; $('#ex-orient').value = ex0.landscape ? 'l' : 'p';
  $('#ex-scale').value = ex0.scale === 'fit' || ex0.scale === 'plot' ? ex0.scale : String(ex0.scale); $('#ex-mono').checked = !!ex0.mono;
  const tbNow = () => ({ project: $('#tb-project').value.trim(), title: $('#tb-title').value.trim(), drawingNo: $('#tb-no').value.trim(), rev: $('#tb-rev').value.trim(), date: $('#tb-date').value.trim(), drawnBy: $('#tb-drawn').value.trim(), checkedBy: $('#tb-checked').value.trim() });
  const optsNow = () => { const s = $('#ex-scale').value; return { format: $('#ex-format').value, size: $('#ex-size').value, landscape: $('#ex-orient').value === 'l', scale: s === 'fit' || s === 'plot' ? s : parseFloat(s), mono: $('#ex-mono').checked }; };
  const planNow = () => CadPlot.plan(d, { ...optsNow(), tb: tbNow() });
  function refresh() {
    const o = optsNow(), isDxf = o.format === 'dxf';
    $('#ex-sheetopts').style.display = isDxf ? 'none' : ''; $('#ex-dxfnote').style.display = isDxf ? '' : 'none';
    $('#ex-insert').style.display = o.format === 'png' ? '' : 'none';
    if (isDxf) return;
    const p = planNow(), warn = $('#ex-warn');
    if (!p.fits) { warn.style.display = ''; warn.textContent = `The drawing does not fit the sheet at 1:${p.scale}. Use Fit to sheet (1:${p.suggested}) or a larger sheet.`; } else warn.style.display = 'none';
    if (o.scale === 'fit') $('#ex-scale').options[0].textContent = `Fit to sheet (1 : ${p.suggested || p.scale})`;
    CadPlot.renderCanvas(p, $('#ex-prev'), 2.5);
  }
  sheet.addEventListener('input', refresh); sheet.addEventListener('change', refresh);
  function persist() { d.titleBlock = tbNow(); const o = optsNow(); d.exportOpts = { format: o.format, size: o.size, landscape: o.landscape, scale: o.scale, mono: o.mono }; if (onChanged) onChanged(); }
  async function makeBlob() {
    const o = optsNow(), base = cadSafeFile(tbNow().title || d.name);
    if (o.format === 'dxf') return { blob: new Blob([CadDxf.write(d)], { type: 'application/dxf' }), name: base + '.dxf' };
    const p = planNow();
    if (o.format === 'png') {
      const c = document.createElement('canvas'); CadPlot.renderCanvas(p, c, 200 / 25.4);
      const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
      return { blob, name: base + '.png' };
    }
    if (!window.jspdf) { toast('PDF library not loaded. Connect to the internet once, then try again.'); return null; }
    const pdf = CadPlot.renderPdf(p, window.jspdf.jsPDF);
    return { blob: pdf.output('blob'), name: base + '.pdf' };
  }
  $('#ex-cancel').addEventListener('click', () => { persist(); sheet.remove(); });
  sheet.addEventListener('click', (e) => { if (e.target === sheet) { persist(); sheet.remove(); } });
  $('#ex-save').addEventListener('click', async () => {
    persist();
    try { const r = await makeBlob(); if (r) { downloadBlob(r.blob, r.name); toast('Saved ' + r.name); } } catch (err) { console.error(err); toast('Export failed: ' + err.message); }
  });
  $('#ex-insert').addEventListener('click', async () => {
    persist();
    try { const r = await makeBlob(); if (r) cadOpenInsertSheet(r.blob, tbNow().title || d.name); } catch (err) { console.error(err); toast('Export failed: ' + err.message); }
  });
  refresh();
}

// Pick an inspection, then where in its report the PNG should go.
async function cadOpenInsertSheet(blob, title) {
  const inspections = (await DB.listInspections()).filter((i) => !i.deleted);
  if (!inspections.length) { toast('Create an inspection first, then insert the drawing into it.'); return; }
  const sheet = el(`
    <div class="sheet-backdrop"><div class="sheet" style="max-height:86vh; overflow:auto;">
      <div class="sheet-handle"></div>
      <h2>Insert into report</h2>
      <div class="field"><label>Inspection</label><select id="in-insp">${inspections.map((i) => `<option value="${i.id}">${esc(i.structureName || 'Untitled')}${i.inspectionDate ? ' · ' + esc(String(i.inspectionDate).slice(0, 10)) : ''}</option>`).join('')}</select></div>
      <div class="field"><label>Where</label><select id="in-dest"></select></div>
      <button class="btn btn-primary btn-block" id="in-ok">Insert</button>
      <button class="btn btn-ghost btn-block" id="in-cancel">Cancel</button>
    </div></div>`);
  presentOverlay(sheet);
  const $ = (id) => sheet.querySelector(id);
  let dests = [];
  async function loadDests() {
    const id = $('#in-insp').value; dests = [{ label: 'Inspection drawings', add: () => DB.addDrawing(id, blob, title) }];
    const secs = await DB.listReportSections(id);
    for (const s of secs) {
      if (s.type === 'drawing') dests.push({ label: 'Drawing section: ' + (s.title || 'Untitled'), add: () => DB.addSectionDrawing(s.id, id, blob, title) });
      if (s.type === 'appendices') {
        const aps = await DB.listSectionAppendices(s.id);
        aps.forEach((a, i) => dests.push({ label: `Appendix ${appendixLetter(i)} - ${a.name}`, add: () => DB.addAppendixItem(a.id, blob, title) }));
      }
    }
    $('#in-dest').innerHTML = dests.map((x, i) => `<option value="${i}">${esc(x.label)}</option>`).join('');
  }
  $('#in-insp').addEventListener('change', loadDests); await loadDests();
  $('#in-cancel').addEventListener('click', () => sheet.remove());
  $('#in-ok').addEventListener('click', async () => {
    try { await dests[parseInt($('#in-dest').value, 10)].add(); sheet.remove(); toast('Drawing inserted.'); } catch (err) { console.error(err); toast('Could not insert: ' + err.message); }
  });
}

// DXF import from the drawing list: creates a new drawing.
function cadPickDxfFile() {
  const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.dxf,application/dxf,image/vnd.dxf,text/plain';
  inp.addEventListener('change', async () => {
    const f = inp.files && inp.files[0]; if (!f) return;
    try {
      const r = CadDxf.read(await f.text());
      if (!r.entities.length) { toast('No drawable objects found in that DXF.'); return; }
      const d = await DB.createCadDrawing({ name: f.name.replace(/\.dxf$/i, ''), units: r.units });
      d.entities = r.entities; d.layers = r.layers; d.nextId = r.nextId; d.currentLayer = '0';
      const doc = new CadCmd.CadDoc(d), b = doc.extents();
      if (b) d.view = { cx: (b.minX + b.maxX) / 2, cy: (b.minY + b.maxY) / 2, scale: Math.min(900 / Math.max(b.maxX - b.minX, 1e-9), 600 / Math.max(b.maxY - b.minY, 1e-9)) * 0.9 };
      await DB.saveCadDrawing(d);
      const sk = Object.entries(r.skipped).map(([k, v]) => `${v} ${k}`);
      if (sk.length) alert('Imported ' + r.entities.length + ' objects.\n\nNot imported (unsupported): ' + sk.join(', ') + '.');
      navigate('#/cad/' + d.id);
    } catch (err) { console.error(err); toast('Could not read that DXF: ' + err.message); }
  });
  inp.click();
}
window.cadOpenExportSheet = cadOpenExportSheet;
window.cadPickDxfFile = cadPickDxfFile;
