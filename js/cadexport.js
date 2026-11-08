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
        ${(d.underlays || []).length ? `<div class="field"><label>Pictures to include</label>${d.underlays.map((u) => `<label class="cad-mode" style="margin-bottom:4px"><input type="checkbox" class="ex-ul" data-id="${esc(u.id)}" ${(ex0.ulOff || []).indexOf(u.id) >= 0 ? '' : 'checked'}> ${esc(u.name)}${u.on === false ? ' (hidden in editor)' : ''}</label>`).join('')}</div>` : ''}
        <button class="btn btn-secondary btn-block" id="ex-pens" style="margin-bottom:10px">Pen settings (print colours and weights)…</button>
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
  const ulIds = () => Array.from(sheet.querySelectorAll('.ex-ul')).filter((x) => x.checked).map((x) => x.dataset.id);
  const optsNow = () => { const s = $('#ex-scale').value; return { underlayIds: ulIds(), underlays: true, format: $('#ex-format').value, size: $('#ex-size').value, landscape: $('#ex-orient').value === 'l', scale: s === 'fit' || s === 'plot' ? s : parseFloat(s), mono: $('#ex-mono').checked }; };
  const planNow = () => CadPlot.plan(d, { ...optsNow(), tb: tbNow() });
  function refresh() {
    const o = optsNow(), isDxf = o.format === 'dxf';
    $('#ex-sheetopts').style.display = isDxf ? 'none' : ''; $('#ex-dxfnote').style.display = isDxf ? '' : 'none';
    $('#ex-insert').style.display = o.format === 'png' ? '' : 'none';
    if (isDxf) return;
    const p = planNow(), warn = $('#ex-warn');
    if (!p.fits) { warn.style.display = ''; warn.textContent = `The drawing does not fit the sheet at 1:${p.scale}. Use Fit to sheet (1:${p.suggested}) or a larger sheet.`; } else warn.style.display = 'none';
    if (o.scale === 'fit') $('#ex-scale').options[0].textContent = `Fit to sheet (1 : ${p.suggested || p.scale})`;
    CadPlot.renderCanvas(p, $('#ex-prev'), 2.5, images);
  }
  // underlay pictures are loaded once from the asset store
  const images = {};
  (async () => { for (const u of (d.underlays || [])) { try { const a = await DB.getCadAsset(u.assetId); if (a && a.blob) { const im = await createImageBitmap(a.blob); images[u.assetId] = im; } } catch (e) { console.error(e); } } refresh(); })();
  sheet.addEventListener('input', refresh); sheet.addEventListener('change', refresh);
  function persist() { d.titleBlock = tbNow(); const o = optsNow(); d.exportOpts = { format: o.format, size: o.size, landscape: o.landscape, scale: o.scale, mono: o.mono, ulOff: Array.from(sheet.querySelectorAll('.ex-ul')).filter((x) => !x.checked).map((x) => x.dataset.id) }; if (onChanged) onChanged(); }
  async function makeBlob() {
    const o = optsNow(), base = cadSafeFile(tbNow().title || d.name);
    if (o.format === 'dxf') return { blob: new Blob([CadDxf.write(d)], { type: 'application/dxf' }), name: base + '.dxf' };
    const p = planNow();
    if (o.format === 'png') {
      const c = document.createElement('canvas'); CadPlot.renderCanvas(p, c, 200 / 25.4, images);
      const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
      return { blob, name: base + '.png' };
    }
    if (!window.jspdf) { toast('PDF library not loaded. Connect to the internet once, then try again.'); return null; }
    const pdf = CadPlot.renderPdf(p, window.jspdf.jsPDF, images);
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
  const pb = $('#ex-pens'); if (pb) pb.addEventListener('click', () => cadOpenPenSheet(doc, () => { if (onChanged) onChanged(); refresh(); }));
  refresh();
}

// Export a layout (paper space): PDF of this sheet or of all sheets, PNG, flat DXF, or insert the sheet into a report.
function cadOpenLayoutExportSheet(doc, onChanged) {
  const lyt = doc.layout(doc.space); if (!lyt) return;
  const d = doc.d, model = doc.modelEntities();
  const data = { ...d, entities: model };
  const sheet = el(`
    <div class="sheet-backdrop"><div class="sheet" style="max-height:90vh; overflow:auto;">
      <div class="sheet-handle"></div>
      <h2>Print layout: ${esc(lyt.name)}</h2>
      <div class="field"><label>Format</label>
        <select id="lx-format"><option value="pdf">PDF, this layout</option>${d.layouts.length > 1 ? '<option value="pdfall">PDF, all layouts (one page each)</option>' : ''}<option value="png">PNG image, this layout</option><option value="dxf">DXF, this layout as drawn (flat, for AutoCAD / BricsCAD)</option></select></div>
      <label class="cad-mode" style="margin-bottom:10px"><input type="checkbox" id="lx-mono"> Black and white</label>
      <button class="btn btn-secondary btn-block" id="lx-pens" style="margin-bottom:10px">Pen settings (print colours and weights)…</button>
      <canvas id="lx-prev" style="display:block; max-width:100%; max-height:300px; margin:0 auto 12px; border:1px solid #d3d6db; border-radius:8px; background:#fff"></canvas>
      <p class="muted" style="font-size:13px">Sheet size, title block and scale text are set in Layout settings (the gear next to the tabs). The DXF is the sheet as plotted at true size in millimetres: objects are on one layer and viewports are cut to their windows.</p>
      <div style="position:sticky; bottom:0; background:#fff; padding-top:8px;">
        <button class="btn btn-primary btn-block" id="lx-save">Save file</button>
        <button class="btn btn-secondary btn-block" id="lx-insert" style="margin-top:8px;">Insert into a report…</button>
        <button class="btn btn-ghost btn-block" id="lx-cancel">Close</button>
      </div>
    </div></div>`);
  presentOverlay(sheet);
  const $ = (id) => sheet.querySelector(id), images = {};
  const ex = d.layoutExport || {}; $('#lx-format').value = ex.format && Array.from($('#lx-format').options).some((o) => o.value === ex.format) ? ex.format : 'pdf'; $('#lx-mono').checked = !!ex.mono;
  const optsNow = () => ({ mono: $('#lx-mono').checked, underlays: true });
  const planFor = (l) => CadPlot.planLayout(data, l, optsNow());
  function refresh() {
    const f = $('#lx-format').value;
    $('#lx-insert').style.display = f === 'png' ? '' : 'none';
    CadPlot.renderCanvas(planFor(lyt), $('#lx-prev'), 1.6, images);
  }
  (async () => { for (const u of (d.underlays || [])) { try { const a = await DB.getCadAsset(u.assetId); if (a && a.blob) images[u.assetId] = await createImageBitmap(a.blob); } catch (e) { console.error(e); } } refresh(); })();
  sheet.addEventListener('input', refresh); sheet.addEventListener('change', refresh);
  const persist = () => { d.layoutExport = { format: $('#lx-format').value, mono: $('#lx-mono').checked }; if (onChanged) onChanged(); };
  async function makeBlob() {
    const f = $('#lx-format').value, base = cadSafeFile((d.name || 'drawing') + ' - ' + lyt.name);
    if (f === 'dxf') return { blob: new Blob([CadDxf.writePlan(planFor(lyt))], { type: 'application/dxf' }), name: base + '.dxf' };
    if (f === 'png') {
      const c = document.createElement('canvas'); CadPlot.renderCanvas(planFor(lyt), c, 200 / 25.4, images);
      return { blob: await new Promise((res) => c.toBlob(res, 'image/png')), name: base + '.png' };
    }
    if (!window.jspdf) { toast('PDF library not loaded. Connect to the internet once, then try again.'); return null; }
    // other layouts are planned from their own object lists (they are not loaded into the editor while this one is open)
    const plans = f === 'pdfall' ? d.layouts.map((l) => planFor(l)) : [planFor(lyt)];
    const pdf = CadPlot.renderPdf(plans, window.jspdf.jsPDF, images);
    return { blob: pdf.output('blob'), name: cadSafeFile(d.name || 'drawing') + (f === 'pdfall' ? ' - all layouts' : ' - ' + lyt.name) + '.pdf' };
  }
  $('#lx-cancel').addEventListener('click', () => { persist(); sheet.remove(); });
  sheet.addEventListener('click', (e) => { if (e.target === sheet) { persist(); sheet.remove(); } });
  $('#lx-save').addEventListener('click', async () => { persist(); try { const r = await makeBlob(); if (r) { downloadBlob(r.blob, r.name); toast('Saved ' + r.name); } } catch (err) { console.error(err); toast('Export failed: ' + err.message); } });
  $('#lx-insert').addEventListener('click', async () => { persist(); try { const r = await makeBlob(); if (r) cadOpenInsertSheet(r.blob, (lyt.tb && lyt.tb.title) || lyt.name); } catch (err) { console.error(err); toast('Export failed: ' + err.message); } });
  $('#lx-pens').addEventListener('click', () => cadOpenPenSheet(doc, () => { if (onChanged) onChanged(); refresh(); }));
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

// ---- Pen settings: how each colour prints (colour and line weight), like a plot style table ----
function cadOpenPenSheet(doc, onChanged) {
  const dd = doc.d;
  const hexes = new Map();
  const add = (h, label) => { if (!hexes.has(h)) hexes.set(h, label); };
  for (const l of (dd.layers || [])) add(CadStyle.layerHex(l), l.name);
  for (const e of doc.modelEntities().concat(doc.inPaper() ? doc.entities : [])) add(CadStyle.colorHex(dd, e), e.layer);
  const pens = dd.pens = dd.pens || {};
  const lwOpts = (sel) => `<option value="" ${sel == null ? 'selected' : ''}>Object weight</option>` + CadStyle.LW_LIST.map((v) => `<option value="${v / 100}" ${sel === v / 100 ? 'selected' : ''}>${(v / 100).toFixed(2)} mm</option>`).join('');
  const sheet = el(`<div class="sheet-backdrop"><div class="sheet" style="max-height:88vh;overflow:auto"><div class="sheet-handle"></div><h2>Pen settings</h2>
    <p class="muted" style="font-size:13px;margin:0 0 8px">How each colour prints. Leave a pen on "Same colour" and "Object weight" to print exactly as drawn. A pen weight overrides the line weight of every object in that colour.</p>
    <div id="pen-list"></div>
    <button class="btn btn-secondary btn-block" id="pen-reset" style="margin:8px 0">Reset all pens</button>
    <button class="btn btn-primary btn-block" id="pen-done">Done</button></div></div>`);
  presentOverlay(sheet);
  const list = sheet.querySelector('#pen-list');
  function render() {
    list.innerHTML = Array.from(hexes.entries()).map(([h, label]) => { const p = pens[h] || {}; const mode = !p.color ? 'same' : p.color === '#000000' ? 'black' : 'custom';
      return `<div class="pen-row" data-h="${h}" style="display:flex;align-items:center;gap:6px;padding:6px 0;border-bottom:1px solid #eceef1;flex-wrap:wrap">
        <span style="width:18px;height:18px;border-radius:50%;background:${h};border:1px solid #bbb;flex-shrink:0"></span>
        <span style="flex:1;min-width:70px;font-size:14px">${esc(label)}</span>
        <select class="pen-col" style="height:38px;border:1px solid #d3d6db;border-radius:8px"><option value="same" ${mode === 'same' ? 'selected' : ''}>Same colour</option><option value="black" ${mode === 'black' ? 'selected' : ''}>Black</option><option value="custom" ${mode === 'custom' ? 'selected' : ''}>Custom…</option></select>
        <input type="color" class="pen-rgb" value="${p.color || CadStyle.printable(h)}" style="width:44px;height:38px;${mode === 'custom' ? '' : 'opacity:.4'}">
        <select class="pen-lw" style="height:38px;border:1px solid #d3d6db;border-radius:8px">${lwOpts(p.lw == null ? null : p.lw)}</select></div>`; }).join('') || '<p class="muted">Nothing to set yet.</p>';
  }
  list.addEventListener('change', (ev) => {
    const row = ev.target.closest('.pen-row'); if (!row) return; const h = row.dataset.h, p = pens[h] = pens[h] || {}, cl = ev.target.classList, v = ev.target.value;
    if (cl.contains('pen-col')) { p.color = v === 'same' ? null : v === 'black' ? '#000000' : (CadStyle.normHex(row.querySelector('.pen-rgb').value) || '#000000'); }
    else if (cl.contains('pen-rgb')) p.color = CadStyle.normHex(v);
    else if (cl.contains('pen-lw')) p.lw = v === '' ? null : parseFloat(v);
    if (!p.color && p.lw == null) delete pens[h];
    if (onChanged) onChanged(); render();
  });
  sheet.querySelector('#pen-reset').addEventListener('click', () => { for (const k of Object.keys(pens)) delete pens[k]; if (onChanged) onChanged(); render(); });
  sheet.querySelector('#pen-done').addEventListener('click', () => sheet.remove());
  sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.remove(); });
  render();
}
window.cadOpenPenSheet = cadOpenPenSheet;
