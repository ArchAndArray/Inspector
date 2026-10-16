// monitoring.js - Monitoring inspections (CS 470 "Management of sub-standard highway structures").
//
// MODEL
//   plan   (monitoringPlans)  one per structure: class, reason/assessment findings, failure mode,
//                             start / planned end / next formal review dates. Shared by every
//                             Monitoring inspection of the structure.
//   point  (monitoringPoints) the thing being monitored (a crack, a bulge, a joint, an area).
//                             Located by a pin on an image, has a master photo of the defect,
//                             instructions for the inspector (what / measure / how) and one or
//                             more parameters with Amber and Red trigger levels and actions.
//   visit  (monitoringVisits) one per point per inspection: a note. Its readings are
//                             monitoringReadings (pointId + parameterId + inspectionId) and its
//                             photos are photos of kind 'monitoringVisit' (pointId + inspectionId).
//
// REPORT SECTION TYPES
//   monitoringSpec     the plan and a summary of the points and their triggers
//   monitoringReadings this visit: each point's readings, RAG, change, note and photos
//   monitoringHistory  the history of chosen points over a chosen date range (also exportable
//                      on its own as a standalone PDF from the specification editor)
//
// Parts: (1) pure logic, also loadable by Node tests, (2) shell editors and previews,
// (3) data loading for reports, (4) PDF drawing. Every global is prefixed mon / MON / shellMon.

// ---------------------------------------------------------------------------------------------
// 1. Pure logic
// ---------------------------------------------------------------------------------------------
const MON_CLASS_INFO = {
  1: { label: 'Class 1 - Basic', detail: 'Visual observation and recording, photography essential, inspection at touching distance; observations at intervals of weeks or months.' },
  2: { label: 'Class 2 - Detailed', detail: 'Class 1 plus quantitative records (crack widths, levels, NDT) and/or measurement of displacement or strain at typical or critical positions.' },
  3: { label: 'Class 3 - Extensive', detail: 'Class 1 and 2 plus frequent or continuous monitoring over extensive coverage, often with data loggers and alarms.' }
};
const MON_POINT_TYPES = ['Crack', 'Movement / deflection', 'Bulge / tilt', 'Settlement / level', 'Joint', 'Spalling / corrosion', 'Scour / undermining', 'Other'];
const MON_RAG_COLOURS = { green: [60, 150, 90], amber: [224, 150, 30], red: [200, 30, 30] };
const MON_RAG_LABELS = { green: 'Green', amber: 'Amber', red: 'Red' };
const MON_RAG_ORDER = { green: 1, amber: 2, red: 3 };
const MON_DEFAULT_COLOURS = ['#d32f2f', '#f57c00', '#fbc02d', '#388e3c', '#0097a7', '#1976d2', '#7b1fa2', '#e91e63'];
const MON_MAX_PLANNED_MONTHS = 24; // CS 470 6.13 - planned maximum duration of monitoring

function monNum(x) {
  if (x === null || x === undefined || x === '') return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

// RAG for one value against one parameter. basis 'value' compares |value|; basis 'change'
// compares |value - baseline|. Returns null when there is nothing to judge (no value, no trigger
// levels, or no baseline for a change-based parameter).
function monRag(param, value, baseline) {
  const v = monNum(value);
  if (v === null) return null;
  const amber = monNum(param.amber), red = monNum(param.red);
  if (amber === null && red === null) return null;
  let measure = v;
  if (param.basis === 'change') {
    const b = monNum(baseline);
    if (b === null) return null;
    measure = v - b;
  }
  const m = Math.abs(measure);
  if (red !== null && m >= Math.abs(red)) return 'red';
  if (amber !== null && m >= Math.abs(amber)) return 'amber';
  return 'green';
}

function monWorstRag(list) {
  let worst = null;
  for (const r of list) if (r && (!worst || MON_RAG_ORDER[r] > MON_RAG_ORDER[worst])) worst = r;
  return worst;
}

function monSortReadings(readings) {
  return readings.slice().sort((a, b) => {
    const d = String(a.date || '').localeCompare(String(b.date || ''));
    return d !== 0 ? d : String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
  });
}

// Per-parameter summary for ONE visit (inspectionId). `holder` is anything with parameters[]
// (a point). allReadings are that point's readings. baseline = the parameter's entered baseline,
// else the first reading ever taken.
function monBuildSummary(holder, allReadings, inspectionId) {
  const sorted = monSortReadings(allReadings || []);
  return (holder.parameters || []).map((param) => {
    const series = sorted.filter((r) => r.parameterId === param.id);
    const currentIdx = series.findIndex((r) => r.inspectionId === inspectionId);
    const current = currentIdx >= 0 ? series[currentIdx] : null;
    const upTo = currentIdx >= 0 ? series.slice(0, currentIdx + 1) : series;
    const previous = currentIdx >= 0 ? (currentIdx > 0 ? series[currentIdx - 1] : null) : (series.length ? series[series.length - 1] : null);
    const entered = monNum(param.baseline);
    const baseline = entered !== null ? entered : (series.length ? series[0].value : null);
    const cur = current ? current.value : null;
    return {
      param,
      current,
      previous,
      baseline,
      changePrev: current && previous ? current.value - previous.value : null,
      changeBase: current && baseline !== null ? current.value - baseline : null,
      rag: current ? monRag(param, cur, baseline) : null,
      history: upTo.slice(-6).map((r) => ({ date: r.date, value: r.value, rag: monRag(param, r.value, baseline) }))
    };
  });
}

// The history of one point: a row per visit (inspection) with a value and RAG for each
// parameter, filtered by date range (inclusive, 'YYYY-MM-DD', either end optional).
function monBuildPointHistory(point, readings, visits, range) {
  const from = range && range.from ? range.from : null;
  const to = range && range.to ? range.to : null;
  const sorted = monSortReadings(readings || []);
  const baselines = {};
  for (const param of point.parameters || []) {
    const entered = monNum(param.baseline);
    const first = sorted.find((r) => r.parameterId === param.id);
    baselines[param.id] = entered !== null ? entered : (first ? first.value : null);
  }
  const byInsp = {};
  const touch = (inspectionId, date) => {
    if (!byInsp[inspectionId]) byInsp[inspectionId] = { inspectionId, date: date || '', note: '', values: {}, rag: null };
    if (date && (!byInsp[inspectionId].date || date < byInsp[inspectionId].date)) byInsp[inspectionId].date = date;
    return byInsp[inspectionId];
  };
  for (const v of visits || []) {
    const row = touch(v.inspectionId, v.date);
    row.note = v.note || '';
  }
  for (const r of sorted) {
    const param = (point.parameters || []).find((x) => x.id === r.parameterId);
    if (!param) continue; // parameter was removed
    const row = touch(r.inspectionId, r.date);
    row.values[r.parameterId] = { value: r.value, rag: monRag(param, r.value, baselines[param.id]) };
  }
  const rows = Object.values(byInsp)
    .filter((row) => (!from || row.date >= from) && (!to || row.date <= to))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  rows.forEach((row) => { row.rag = monWorstRag(Object.values(row.values).map((x) => x.rag)); });
  return { point, rows, baselines };
}

// Latest overall status of a point (across all dates).
function monLatestRag(point, readings, visits) {
  const h = monBuildPointHistory(point, readings, visits, null);
  for (let i = h.rows.length - 1; i >= 0; i--) if (h.rows[i].rag) return h.rows[i].rag;
  return null;
}

// Which points a filter selects. filter.pointIds null/undefined/[] means every point.
function monSelectPoints(points, filter) {
  const ids = filter && Array.isArray(filter.pointIds) && filter.pointIds.length ? filter.pointIds : null;
  return points.filter((p) => !ids || ids.includes(p.id));
}

// Plan-level warnings drawn from CS 470 6.13 (max planned duration 2 years) and 7.1 (formal
// review at intervals not exceeding 2 years). today is 'YYYY-MM-DD'.
function monPlanWarnings(plan, today) {
  const out = [];
  const addMonths = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 10); };
  if (plan.startDate && plan.endDate && plan.endDate > addMonths(plan.startDate, MON_MAX_PLANNED_MONTHS)) {
    out.push('Planned end date is more than 2 years after the start; CS 470 6.13 sets 2 years as the planned maximum, with a formal review to continue beyond it.');
  }
  if (!plan.endDate) out.push('No planned end date set (CS 470 6.13 requires a planned maximum duration, not exceeding 2 years).');
  if (plan.reviewDate && today) {
    if (plan.reviewDate < today) out.push('The formal review date has passed (CS 470 7.1: formal review at intervals not exceeding 2 years).');
    else if (plan.reviewDate <= addMonths(today, 1)) out.push('The formal review is due within a month.');
  }
  if (!plan.reviewDate) out.push('No formal review date set (CS 470 7.1).');
  return out;
}

// "MP3" - the permanent label of a point or area; "MP3 - P1 Soffit crack" with the name.
function monLabel(point) { return point && point.number != null ? 'MP' + point.number : ''; }
function monPointTitle(point) {
  const name = (point && point.name) || 'Unnamed';
  return point && point.number != null ? 'MP' + point.number + ' - ' + name : name;
}

// A point is a mark with a pin; an area is a mark with a polygon. Returns the geometry in use or null.
function monMarkGeometry(m) {
  if (m.shape === 'area') return m.area && m.area.length >= 3 ? { kind: 'area', pts: m.area } : null;
  return m.pin ? { kind: 'point', pin: m.pin } : null;
}
function monCentroid(pts) {
  let x = 0, y = 0;
  for (const p of pts) { x += p.x; y += p.y; }
  return { x: x / pts.length, y: y / pts.length };
}

// Layout of every mark on one image, in a virtual space VW wide (VH tall by the image aspect), so the
// same result is drawn as SVG on screen and onto a canvas for the PDF. Marks may sit on top of each
// other (a crack inside a bulge); their MP# labels are stacked so none hides another.
// marks: [{ id, number, color, shape, pin, area }]; opts: { highlightId }.
function monMarkPrims(marks, imgW, imgH, opts) {
  const VW = 1000, VH = VW * ((imgH || 3) / (imgW || 4));
  const hl = opts && opts.highlightId;
  const FONT = 24, LH = 34, CHAR = 15, PAD = 14, R = 15;
  const sorted = marks.filter((m) => monMarkGeometry(m)).sort((a, b) => (a.number || 0) - (b.number || 0));
  const prims = [];
  const placed = [];
  for (const m of sorted) {
    const g = monMarkGeometry(m);
    const dim = hl && m.id !== hl;
    const color = m.color || '#d32f2f';
    let ax, ay, lx, ly;
    const text = monLabel(m) || 'MP';
    const lw = CHAR * text.length + PAD;
    if (g.kind === 'area') {
      const pts = g.pts.map((p) => ({ x: p.x * VW, y: p.y * VH }));
      prims.push({ kind: 'area', pts, color, dim, hl: !!hl && m.id === hl });
      const c = monCentroid(pts);
      ax = c.x; ay = c.y; lx = ax - lw / 2; ly = ay - LH / 2;
    } else {
      ax = g.pin.x * VW; ay = g.pin.y * VH;
      // points sitting on top of each other get nested rings, so each one stays visible
      const stacked = prims.filter((q) => q.kind === 'point' && Math.abs(q.x - ax) < 14 && Math.abs(q.y - ay) < 14).length;
      prims.push({ kind: 'point', x: ax, y: ay, r: R + stacked * 9, color, dim, hl: !!hl && m.id === hl });
      lx = ax + R + 6; ly = ay - LH - 2;
    }
    const clamp = () => { lx = Math.max(2, Math.min(VW - lw - 2, lx)); ly = Math.max(2, Math.min(VH - LH - 2, ly)); };
    clamp();
    const hits = (x, y) => placed.some((r) => x < r.x + r.w + 3 && x + lw + 3 > r.x && y < r.y + r.h + 3 && y + LH + 3 > r.y);
    const x0 = lx, y0 = ly;
    let guard = 0;
    while (hits(lx, ly) && guard++ < 60) {
      ly += LH + 4;
      if (ly + LH > VH - 2) { ly = y0; lx += lw + 4; }
      lx = Math.max(2, Math.min(VW - lw - 2, lx));
    }
    placed.push({ x: lx, y: ly, w: lw });
    placed[placed.length - 1].h = LH;
    prims.push({ kind: 'label', x: lx, y: ly, w: lw, h: LH, text, color, font: FONT, dim, hl: !!hl && m.id === hl, ax, ay });
  }
  // areas first, then points, then labels, so labels are never covered
  const order = { area: 0, point: 1, label: 2 };
  prims.sort((a, b) => order[a.kind] - order[b.kind]);
  return { VW, VH, prims };
}

// Human description of a filter, for report headings.
function monFilterText(points, filter, fmt) {
  const f = fmt || ((d) => d);
  const sel = monSelectPoints(points, filter);
  const which = sel.length === points.length ? 'All points' : sel.map((p) => monPointTitle(p)).join(', ');
  const from = filter && filter.from, to = filter && filter.to;
  const when = from && to ? `${f(from)} to ${f(to)}` : from ? `from ${f(from)}` : to ? `up to ${f(to)}` : 'all dates';
  return `${which} · ${when}`;
}

// ---- Workspace helpers: records, frequency, overview (pure) ----
// "Monitoring Record 3 - 14/10/26"
function monShortDate(iso) {
  if (!iso) return '';
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? m[3] + '/' + m[2] + '/' + m[1].slice(2) : '';
}
function monRecordTitle(rec) {
  return 'Monitoring Record ' + (rec && rec.recordNumber != null ? rec.recordNumber : '?') + ' - ' + monShortDate(rec && rec.date);
}
function monAddInterval(iso, value, unit) {
  const n = monNum(value);
  if (!iso || n === null || n <= 0) return null;
  const d = new Date(String(iso).slice(0, 10) + 'T00:00:00Z');
  if (unit === 'days') d.setUTCDate(d.getUTCDate() + Math.round(n));
  else {
    const day = d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + Math.round(n));
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, last));
  }
  return d.toISOString().slice(0, 10);
}
function monDaysBetween(fromIso, toIso) {
  const a = new Date(String(fromIso).slice(0, 10) + 'T00:00:00Z'), b = new Date(String(toIso).slice(0, 10) + 'T00:00:00Z');
  return Math.round((b - a) / 86400000);
}
// Is the reading moving toward the triggers? Compares the size of the measure (|value|, or
// |value - baseline| for change-based parameters) at the last two readings.
function monTrend(param, prevValue, lastValue, baseline) {
  const f = (v) => (param.basis === 'change' ? Math.abs(v - (baseline === null ? 0 : baseline)) : Math.abs(v));
  if (prevValue === null || lastValue === null) return null;
  if (param.basis === 'change' && baseline === null) return null;
  const a = f(prevValue), b = f(lastValue);
  if (Math.abs(a - b) < 1e-9) return 'steady';
  return b > a ? 'increasing' : 'decreasing';
}

// Everything the Monitoring Overview shows. records: monitoring-record inspections
// {id,date,recordNumber}; readings: all plan readings; today 'YYYY-MM-DD'.
function monBuildOverview(plan, points, readings, records, today, selectedRecordId) {
  const recs = (records || []).slice().sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')) || (a.recordNumber || 0) - (b.recordNumber || 0));
  const byPoint = {};
  for (const r of readings || []) (byPoint[r.pointId] = byPoint[r.pointId] || []).push(r);
  const ragAt = (rec) => {
    const list = [];
    for (const p of points) list.push(...monBuildSummary(p, byPoint[p.id] || [], rec.id).map((x) => x.rag));
    return monWorstRag(list);
  };
  const first = recs.length ? { record: recs[0], rag: ragAt(recs[0]) } : null;
  const latest = recs.length ? { record: recs[recs.length - 1], rag: ragAt(recs[recs.length - 1]) } : null;
  const activePoints = points.filter((p) => p.status !== 'closed');
  const out = {
    pointCount: points.length, activeCount: activePoints.length, closedCount: points.length - activePoints.length,
    recordCount: recs.length, first, latest,
    lastDate: latest ? latest.record.date : null,
    frequency: monNum(plan.frequencyValue) > 0 ? { value: monNum(plan.frequencyValue), unit: plan.frequencyUnit === 'days' ? 'days' : 'months' } : null,
    nextDue: null, daysToNext: null, triggers: [], noReading: [], overall: [], selected: []
  };
  if (out.frequency) {
    const base = out.lastDate || plan.startDate || null;
    out.nextDue = monAddInterval(base, out.frequency.value, out.frequency.unit);
    if (out.nextDue && today) out.daysToNext = monDaysBetween(today, out.nextDue);
  }
  // Points at Amber / Red at the latest record, and active points with no reading at it.
  if (latest) {
    for (const p of activePoints) {
      const sums = monBuildSummary(p, byPoint[p.id] || [], latest.record.id);
      if (!sums.some((x) => x.current)) out.noReading.push(p);
      for (const x of sums) if (x.rag === 'amber' || x.rag === 'red') out.triggers.push({ point: p, param: x.param, value: x.current.value, rag: x.rag, action: x.param.action || '' });
    }
    out.triggers.sort((a, b) => MON_RAG_ORDER[b.rag] - MON_RAG_ORDER[a.rag]);
  }
  // Overall: per point and parameter - first reading, last reading, change, status, trend.
  for (const p of points) {
    const sorted = monSortReadings(byPoint[p.id] || []);
    for (const param of p.parameters || []) {
      const series = sorted.filter((r) => r.parameterId === param.id);
      const entered = monNum(param.baseline);
      const baseline = entered !== null ? entered : (series.length ? series[0].value : null);
      const f = series[0] || null, l = series.length ? series[series.length - 1] : null, pr = series.length > 1 ? series[series.length - 2] : null;
      out.overall.push({
        point: p, param, first: f, last: l,
        change: f && l && series.length > 1 ? l.value - f.value : null,
        rag: l ? monRag(param, l.value, baseline) : null,
        trend: l && pr ? monTrend(param, pr.value, l.value, baseline) : null
      });
    }
  }
  // Selected record: this visit against the previous one and the first.
  if (selectedRecordId) {
    for (const p of points) {
      for (const x of monBuildSummary(p, byPoint[p.id] || [], selectedRecordId)) {
        const series = monSortReadings(byPoint[p.id] || []).filter((r) => r.parameterId === x.param.id);
        out.selected.push({ point: p, param: x.param, current: x.current, previous: x.previous, changePrev: x.changePrev, first: series[0] || null, changeFirst: x.current && series.length ? x.current.value - series[0].value : null, rag: x.rag });
      }
    }
  }
  return out;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { monLabel, monPointTitle, monMarkGeometry, monMarkPrims, MON_DEFAULT_COLOURS, monNum, monRag, monWorstRag, monSortReadings, monBuildSummary, monBuildPointHistory, monLatestRag, monSelectPoints, monPlanWarnings, monFilterText, MON_MAX_PLANNED_MONTHS, monShortDate, monRecordTitle, monAddInterval, monDaysBetween, monTrend, monBuildOverview };
}

// ---------------------------------------------------------------------------------------------
// 2. Shell helpers, editors and previews (browser only)
// ---------------------------------------------------------------------------------------------
function monFmtNum(n) {
  if (n === null || n === undefined) return '—';
  const r = Math.round(n * 10000) / 10000;
  return String(r);
}
function monSigned(n) {
  if (n === null || n === undefined) return '—';
  const r = Math.round(n * 10000) / 10000;
  return (r > 0 ? '+' : '') + r;
}
function monRagCss(rag) {
  if (!rag) return '#9a9fa8';
  const c = MON_RAG_COLOURS[rag];
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}
function monRagBadge(rag) {
  if (!rag) return `<span style="color:#9a9fa8;">—</span>`;
  return `<span style="display:inline-block; min-width:52px; text-align:center; background:${monRagCss(rag)}; color:#fff; border-radius:999px; padding:2px 10px; font-size:11.5px; font-weight:700;">${MON_RAG_LABELS[rag]}</span>`;
}
function monInputStyle(t) {
  return `width:100%; border:1px solid ${t.line}; border-radius:8px; padding:8px 10px; font-size:14px; box-sizing:border-box; margin-top:4px; background:#fff;`;
}
function monLabelStyle(t) {
  return `font-size:11.5px; font-weight:700; text-transform:uppercase; color:${t.muted};`;
}
function monBtnStyle(t) {
  return `border:1px solid ${t.line}; background:#fff; border-radius:8px; padding:8px 14px; font-size:13px; font-weight:650; color:${t.ink};`;
}
function monToday() { return new Date().toISOString().slice(0, 10); }

async function monLoadPlanFor(inspectionId) {
  const insp = await DB.get('inspections', inspectionId);
  const plan = await DB.ensureMonitoringPlanForInspection(insp);
  return { insp, plan };
}

// Image choosers --------------------------------------------------------------------------
async function monAddPointImageFromFiles(files, pointId, inspectionId, kind, caption) {
  const added = [];
  for (const file of Array.from(files)) {
    const normalized = await normalizeImageFile(file);
    added.push(await DB.addPointPhoto(pointId, inspectionId, kind, normalized, caption || ''));
  }
  return added;
}

// Existing photos/drawings in the inspection; the chosen image is COPIED into a new point photo
// so it never dangles if the source is deleted later.
function monOpenExistingImagePicker(inspectionId, onPick) {
  const t = SHELL_TOKENS;
  const sheet = document.createElement('div');
  sheet.className = 'sheet-backdrop';
  sheet.innerHTML = `<div class="sheet" style="max-height:80vh; overflow:auto;"><div class="sheet-handle"></div><h2>Choose an image from this inspection</h2><div id="mon-ex-grid" style="display:grid; grid-template-columns:repeat(3,1fr); gap:10px;">Loading…</div><button class="btn btn-ghost btn-block" id="mon-ex-cancel" style="margin-top:14px;">Cancel</button></div>`;
  presentOverlay(sheet);
  sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.remove(); });
  sheet.querySelector('#mon-ex-cancel').addEventListener('click', () => sheet.remove());
  (async () => {
    const kinds = ['drawing', 'finding', 'element', 'cover', 'appendixItem', 'monitoringLocation', 'monitoringMaster', 'monitoringVisit'];
    const photos = (await DB.getAllByIndex('photos', 'inspectionId', inspectionId)).filter((p) => kinds.includes(p.kind) && (p.originalBlob || p.annotatedBlob));
    const grid = sheet.querySelector('#mon-ex-grid');
    if (!photos.length) { grid.innerHTML = `<div style="grid-column:1/-1; color:${t.muted}; font-size:13.5px;">No photos or drawings in this inspection yet.</div>`; return; }
    grid.innerHTML = photos.map((p) => `<div class="mon-ex" data-id="${p.id}" style="cursor:pointer;"><div style="height:90px; background:${t.line}; border-radius:8px; overflow:hidden;"><img src="${blobUrl(p.annotatedBlob || p.originalBlob)}" style="width:100%; height:100%; object-fit:cover;"></div><div style="font-size:11.5px; margin-top:3px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${esc(p.title || p.caption || p.kind)}</div></div>`).join('');
    grid.querySelectorAll('.mon-ex').forEach((c) => c.addEventListener('click', () => {
      const p = photos.find((x) => x.id === c.dataset.id);
      sheet.remove();
      onPick(p.annotatedBlob || p.originalBlob);
    }));
  })();
}

// ---- Shared location images and their marks (points and areas) ----
function monMarkOf(p) { return { id: p.id, number: p.number, color: p.color, shape: p.shape, pin: p.pin, area: p.area }; }

// SVG drawn over an <img> (same aspect, so nothing is distorted). extraSvg is appended in the same space.
function monMarksSvg(marks, w, h, highlightId, extra) {
  const { VW, VH, prims } = monMarkPrims(marks, w, h, { highlightId });
  const body = prims.map((pr) => {
    const op = pr.dim && pr.kind !== 'label' ? ' opacity="0.5"' : '';
    if (pr.kind === 'area') {
      const pts = pr.pts.map((q) => q.x.toFixed(1) + ',' + q.y.toFixed(1)).join(' ');
      return `<g${op}><polygon points="${pts}" fill="none" stroke="#fff" stroke-width="${pr.hl ? 11 : 9}" stroke-linejoin="round"/><polygon points="${pts}" fill="${pr.color}" fill-opacity="0.28" stroke="${pr.color}" stroke-width="${pr.hl ? 7 : 5}" stroke-linejoin="round"/></g>`;
    }
    if (pr.kind === 'point') {
      return `<g${op}><circle cx="${pr.x}" cy="${pr.y}" r="${pr.r}" fill="none" stroke="#fff" stroke-width="${pr.hl ? 11 : 9}"/><circle cx="${pr.x}" cy="${pr.y}" r="${pr.r}" fill="${pr.color}" fill-opacity="0.3" stroke="${pr.color}" stroke-width="${pr.hl ? 7 : 5}"/></g>`;
    }
    return `<g${op}><rect x="${pr.x}" y="${pr.y}" width="${pr.w}" height="${pr.h}" rx="5" fill="#fff" stroke="${pr.color}" stroke-width="3"/><text x="${pr.x + pr.w / 2}" y="${pr.y + pr.h / 2 + 8.5}" text-anchor="middle" font-family="-apple-system,Helvetica,Arial,sans-serif" font-weight="700" font-size="${pr.font}" fill="#000">${esc(pr.text)}</text></g>`;
  }).join('');
  return `<svg viewBox="0 0 ${VW} ${VH.toFixed(1)}" preserveAspectRatio="none" style="position:absolute; left:0; top:0; width:100%; height:100%; pointer-events:none; overflow:visible;">${body}${extra ? extra(VW, VH) : ''}</svg>`;
}

// Same drawing onto a canvas (for the PDF). scale = canvas pixels per virtual unit.
function monDrawPrims(ctx, prims, scale) {
  for (const pr of prims) {
    ctx.save();
    ctx.globalAlpha = pr.dim && pr.kind !== 'label' ? 0.5 : 1;
    if (pr.kind === 'area') {
      ctx.beginPath();
      pr.pts.forEach((q, k) => (k ? ctx.lineTo(q.x * scale, q.y * scale) : ctx.moveTo(q.x * scale, q.y * scale)));
      ctx.closePath();
      ctx.lineJoin = 'round';
      ctx.lineWidth = (pr.hl ? 11 : 9) * scale; ctx.strokeStyle = '#fff'; ctx.stroke();
      ctx.globalAlpha = (pr.dim ? 0.5 : 1) * 0.28; ctx.fillStyle = pr.color; ctx.fill();
      ctx.globalAlpha = pr.dim ? 0.5 : 1;
      ctx.lineWidth = (pr.hl ? 7 : 5) * scale; ctx.strokeStyle = pr.color; ctx.stroke();
    } else if (pr.kind === 'point') {
      ctx.beginPath(); ctx.arc(pr.x * scale, pr.y * scale, pr.r * scale, 0, Math.PI * 2);
      ctx.lineWidth = (pr.hl ? 11 : 9) * scale; ctx.strokeStyle = '#fff'; ctx.stroke();
      ctx.globalAlpha = (pr.dim ? 0.5 : 1) * 0.3; ctx.fillStyle = pr.color; ctx.fill();
      ctx.globalAlpha = pr.dim ? 0.5 : 1;
      ctx.lineWidth = (pr.hl ? 7 : 5) * scale; ctx.strokeStyle = pr.color; ctx.stroke();
    } else {
      ctx.fillStyle = '#fff'; ctx.strokeStyle = pr.color; ctx.lineWidth = 3 * scale;
      const x = pr.x * scale, y = pr.y * scale, w = pr.w * scale, h = pr.h * scale, r = 5 * scale;
      ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
      ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#000'; ctx.font = `700 ${pr.font * scale}px Helvetica, Arial, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(pr.text, x + w / 2, y + h / 2 + 1 * scale);
    }
    ctx.restore();
  }
}

// One entry per shared image: { rec, photo, blob, w, h }. Measures (and remembers) the size once.
async function monLoadImageViews(planId) {
  const out = {};
  for (const rec of await DB.listMonitoringImages(planId)) {
    const photo = await DB.get('photos', rec.photoId);
    if (!photo) continue;
    const blob = photo.annotatedBlob || photo.originalBlob;
    let w = rec.w, h = rec.h;
    if (!w || !h) {
      try { const bm = await createImageBitmap(blob); w = bm.width; h = bm.height; if (bm.close) bm.close(); await DB.updateMonitoringImage(rec.id, { w, h }); } catch (e) { w = 4; h = 3; }
    }
    out[rec.id] = { rec, photo, blob, w, h };
  }
  return out;
}

function monMarkedImageHtml(view, marks, highlightId, maxH) {
  const t = SHELL_TOKENS;
  if (!view) return `<div style="height:${Math.min(maxH, 70)}px; background:${t.line}; border-radius:8px; display:flex; align-items:center; justify-content:center; color:${t.muted}; font-size:12.5px;">No image</div>`;
  return `<div style="position:relative; display:inline-block; line-height:0; max-width:100%;"><img src="${blobUrl(view.blob)}" style="max-width:100%; max-height:${maxH}px; border-radius:8px; display:block;">${monMarksSvg(marks, view.w, view.h, highlightId)}</div>`;
}

function monColourSwatches(current, prefix) {
  const all = MON_DEFAULT_COLOURS.slice();
  const custom = current && !all.includes(current) ? current : null;
  return all.map((c) => `<button class="${prefix}-sw" data-c="${c}" style="width:30px; height:30px; border-radius:50%; background:${c}; border:${c === current ? '3px solid #000' : '2px solid #fff'}; box-shadow:0 0 0 1px #bbb; padding:0;"></button>`).join('')
    + `<label style="display:inline-flex; align-items:center; gap:6px; font-size:12px; color:#666;"><input type="color" class="${prefix}-custom" value="${custom || current || '#d32f2f'}" style="width:34px; height:30px; padding:0; border:none; background:none;"> Custom</label>`;
}

// Full-screen placement of a point (one tap) or an area (tap each corner, then Done).
// Other points on the image are shown dimmed. onDone(patch) where patch is {pin} or {area}.
function monOpenMarkPicker(view, otherMarks, point, onDone) {
  const t = SHELL_TOKENS;
  const isArea = point.shape === 'area';
  let pin = point.pin ? { ...point.pin } : null;
  let verts = isArea && point.area ? point.area.map((q) => ({ ...q })) : [];
  const ov = document.createElement('div');
  ov.style.cssText = 'position:fixed; inset:0; background:#16181d; display:flex; flex-direction:column;';
  ov.innerHTML = `
    <div style="display:flex; gap:10px; align-items:center; padding:calc(var(--safe-top, 0px) + 10px) 14px 10px; background:#16181d; color:#fff;">
      <button id="mon-pin-cancel" style="${monBtnStyle(t)}">Cancel</button>
      <div style="flex:1; font-size:13.5px; text-align:center;">${isArea ? 'Tap each corner of the area, then Done' : 'Tap the image to place the point'} (${esc(monLabel(point))})</div>
      ${isArea ? `<button id="mon-pin-undo" style="${monBtnStyle(t)}">Undo corner</button>` : ''}
      <button id="mon-pin-clear" style="${monBtnStyle(t)}">Clear</button>
      <button id="mon-pin-done" style="background:${t.red}; color:#fff; border:none; border-radius:8px; padding:8px 16px; font-size:13px; font-weight:700;">Done</button>
    </div>
    <div style="flex:1; overflow:auto; display:flex; align-items:flex-start; justify-content:center; padding:10px;">
      <div id="mon-pin-wrap" style="position:relative; display:inline-block; line-height:0;">
        <img id="mon-pin-img" src="${blobUrl(view.blob)}" style="max-width:100%; max-height:calc(100vh - 110px); touch-action:manipulation; display:block;">
        <div id="mon-pin-svg"></div>
      </div>
    </div>`;
  presentOverlay(ov);
  const img = ov.querySelector('#mon-pin-img'), svgHost = ov.querySelector('#mon-pin-svg');
  const draw = () => {
    const cur = { ...monMarkOf(point), shape: point.shape, pin: isArea ? null : pin, area: isArea && verts.length >= 3 ? verts : null };
    const draft = (VW, VH) => {
      if (!isArea || verts.length === 0 || verts.length >= 3) return '';
      const pts = verts.map((q) => `${(q.x * VW).toFixed(1)},${(q.y * VH).toFixed(1)}`).join(' ');
      return `<polyline points="${pts}" fill="none" stroke="${point.color}" stroke-width="5"/>` + verts.map((q) => `<circle cx="${q.x * VW}" cy="${q.y * VH}" r="9" fill="${point.color}" stroke="#fff" stroke-width="3"/>`).join('');
    };
    svgHost.innerHTML = monMarksSvg(otherMarks.concat([cur]), view.w, view.h, point.id, draft);
  };
  draw();
  img.addEventListener('click', (e) => {
    const r = img.getBoundingClientRect();
    const q = { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
    if (isArea) verts.push(q); else pin = q;
    draw();
  });
  const undo = ov.querySelector('#mon-pin-undo');
  if (undo) undo.addEventListener('click', () => { verts.pop(); draw(); });
  ov.querySelector('#mon-pin-clear').addEventListener('click', () => { pin = null; verts = []; draw(); });
  ov.querySelector('#mon-pin-cancel').addEventListener('click', () => ov.remove());
  ov.querySelector('#mon-pin-done').addEventListener('click', () => {
    if (isArea && verts.length > 0 && verts.length < 3) { toast('An area needs at least 3 corners'); return; }
    ov.remove();
    onDone(isArea ? { area: verts.length >= 3 ? verts : null } : { pin });
  });
}

// Add a shared location image: an image already in the inspection, a new photo, or a sketch.
function monAddImageFlow(plan, insp, onAdded) {
  const sheet = el(`<div class="sheet-backdrop"><div class="sheet"><div class="sheet-handle"></div><h2>New location image</h2>
    <p style="font-size:12.5px; color:#666; margin:0 0 10px;">One image can carry many points and areas, so use as few as you can (for example one per abutment).</p>
    <button class="btn btn-primary btn-block" id="mon-l-existing">Use a photo or drawing from this inspection</button>
    <button class="btn btn-secondary btn-block" id="mon-l-photo" style="margin-top:10px;">Take or choose a photo</button>
    <button class="btn btn-secondary btn-block" id="mon-l-sketch" style="margin-top:10px;">Draw a sketch</button>
    <button class="btn btn-ghost btn-block" id="mon-l-cancel" style="margin-top:10px;">Cancel</button></div></div>`);
  presentOverlay(sheet);
  sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.remove(); });
  sheet.querySelector('#mon-l-cancel').addEventListener('click', () => sheet.remove());
  const finish = async (blob, openMarkup) => {
    const n = (await DB.listMonitoringImages(plan.id)).length + 1;
    const name = (prompt('Name for this image (e.g. North abutment)', `Image ${n}`) || '').trim() || `Image ${n}`;
    const rec = await DB.addMonitoringImage(plan.id, blob, name);
    if (openMarkup) await openAnnotator(rec.photoId, async () => { await DB.updateMonitoringImage(rec.id, { w: null, h: null }); onAdded(rec); });
    else onAdded(rec);
  };
  sheet.querySelector('#mon-l-existing').addEventListener('click', () => { sheet.remove(); monOpenExistingImagePicker(insp.id, (blob) => finish(blob, false)); });
  sheet.querySelector('#mon-l-photo').addEventListener('click', () => {
    sheet.remove();
    openPhotoSourceSheet({ onFiles: async (files) => finish(await normalizeImageFile(files[0]), false) });
  });
  sheet.querySelector('#mon-l-sketch').addEventListener('click', async () => {
    sheet.remove();
    finish(await createA4CanvasBlob(), true);
  });
}

// ---- Point editor (inside a host element; onBack returns to the caller's list) ----
async function monRenderPointEditor(host, plan, insp, pointId, onBack) {
  const t = SHELL_TOKENS;
  let point = await DB.get('monitoringPoints', pointId);
  if (!point) { onBack(); return; }
  async function savePoint(patch) { point = await DB.updateMonitoringPoint(point.id, patch); }

  const views = await monLoadImageViews(plan.id);
  const allPoints = await DB.listMonitoringPoints(plan.id);
  const view = point.imageId ? views[point.imageId] || null : null;
  const marksOnImage = view ? allPoints.filter((q) => q.imageId === view.rec.id).map(monMarkOf) : [];
  const masterPhoto = point.masterPhotoId ? await DB.get('photos', point.masterPhotoId) : null;
  const isArea = point.shape === 'area';
  const placed = !!monMarkGeometry(point);

  host.innerHTML = `
    <button id="mon-pt-back" style="background:none; border:none; color:${t.muted}; font-size:13px; font-weight:650; margin-bottom:10px; padding:0;">‹ Back</button>
    <h2 style="font-size:20px; font-weight:700; margin:0 0 14px;"><span style="background:#fff; color:#000; border:2px solid ${esc(point.color || '#d32f2f')}; border-radius:6px; padding:1px 8px; margin-right:8px;">${esc(monLabel(point))}</span>Monitoring ${isArea ? 'area' : 'point'}</h2>
    <div style="display:grid; grid-template-columns:2fr 1fr 1fr; gap:10px; margin-bottom:16px;">
      <div><label style="${monLabelStyle(t)}">Name / description</label><input type="text" id="mon-pt-name" value="${esc(point.name)}" placeholder="e.g. Span 2 soffit crack" style="${monInputStyle(t)}"></div>
      <div><label style="${monLabelStyle(t)}">Type</label><select id="mon-pt-type" style="${monInputStyle(t)}">${MON_POINT_TYPES.map((x) => `<option ${point.type === x ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select></div>
      <div><label style="${monLabelStyle(t)}">Status</label><select id="mon-pt-status" style="${monInputStyle(t)}"><option value="active" ${point.status !== 'closed' ? 'selected' : ''}>Active</option><option value="closed" ${point.status === 'closed' ? 'selected' : ''}>Closed</option></select></div>
    </div>

    <h3 style="font-size:15px; font-weight:700; margin:0 0 6px;">Where is it?</h3>
    <p style="color:${t.muted}; font-size:12.5px; line-height:1.5; margin:0 0 8px; max-width:560px;">Mark it on a shared image of the structure. Points and areas can overlap (a crack inside a bulge); each is labelled ${esc(monLabel(point))} in black on white whatever colour you choose.</p>
    <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-bottom:10px;">
      <div><label style="${monLabelStyle(t)}">Image</label><select id="mon-pt-image" style="${monInputStyle(t)}"><option value="">— choose an image —</option>${Object.values(views).map((v) => `<option value="${v.rec.id}" ${point.imageId === v.rec.id ? 'selected' : ''}>${esc(v.rec.name)}</option>`).join('')}<option value="__new">+ New image…</option></select></div>
      <div><label style="${monLabelStyle(t)}">Mark as</label><select id="mon-pt-shape" style="${monInputStyle(t)}"><option value="point" ${!isArea ? 'selected' : ''}>Point</option><option value="area" ${isArea ? 'selected' : ''}>Area</option></select></div>
    </div>
    <div style="margin-bottom:10px;"><label style="${monLabelStyle(t)}">Colour</label><div style="display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin-top:6px;">${monColourSwatches(point.color, 'mon-pt')}</div></div>
    <div id="mon-pt-loc" style="margin-bottom:8px;">${view ? monMarkedImageHtml(view, marksOnImage, point.id, 280) : `<div style="color:${t.muted}; font-size:13px;">No image chosen yet.</div>`}</div>
    <div style="display:flex; flex-wrap:wrap; gap:8px; margin-bottom:6px;">
      ${view ? `<button id="mon-pt-pin" style="${monBtnStyle(t)}">${placed ? 'Move ' : 'Place '}${esc(monLabel(point))} on image</button>` : ''}
    </div>
    ${view && !placed ? `<div style="color:${t.red}; font-size:12.5px; margin-bottom:12px;">${esc(monLabel(point))} is not placed on the image yet.</div>` : '<div style="margin-bottom:12px;"></div>'}

    <h3 style="font-size:15px; font-weight:700; margin:0 0 6px;">Master photo of the defect</h3>
    <p style="color:${t.muted}; font-size:12.5px; line-height:1.5; margin:0 0 8px; max-width:560px;">One clear photo that shows the inspector exactly what to look for.</p>
    <div id="mon-pt-master" style="margin-bottom:8px;">${masterPhoto ? `<img src="${blobUrl(masterPhoto.annotatedBlob || masterPhoto.originalBlob)}" style="max-width:100%; max-height:220px; border-radius:8px;">` : `<div style="color:${t.muted}; font-size:13px;">No master photo yet.</div>`}</div>
    <div style="display:flex; flex-wrap:wrap; gap:8px; margin-bottom:18px;">
      <button id="mon-pt-setmaster" style="${monBtnStyle(t)}">${masterPhoto ? 'Replace photo' : 'Add photo'}</button>
      ${masterPhoto ? `<button id="mon-pt-markmaster" style="${monBtnStyle(t)}">Mark up</button>` : ''}
    </div>

    <h3 style="font-size:15px; font-weight:700; margin:0 0 6px;">Instructions for the inspector</h3>
    <div style="margin-bottom:10px;"><label style="${monLabelStyle(t)}">What is being monitored</label><textarea id="mon-pt-what" rows="2" placeholder="e.g. Longitudinal crack in the soffit of Span 2, 3 m from Pier 1" style="${monInputStyle(t)} resize:vertical;">${esc(point.instrWhat)}</textarea></div>
    <div style="margin-bottom:10px;"><label style="${monLabelStyle(t)}">What to measure</label><textarea id="mon-pt-measure" rows="2" placeholder="e.g. Crack width at the marked gauge point, and total crack length" style="${monInputStyle(t)} resize:vertical;">${esc(point.instrMeasure)}</textarea></div>
    <div style="margin-bottom:18px;"><label style="${monLabelStyle(t)}">How to measure it</label><textarea id="mon-pt-how" rows="3" placeholder="e.g. Crack comparator held flat at the paint mark; take the widest reading; photograph with the scale ruler alongside" style="${monInputStyle(t)} resize:vertical;">${esc(point.instrHow)}</textarea></div>

    <h3 style="font-size:15px; font-weight:700; margin:0 0 6px;">Parameters and trigger levels</h3>
    <p style="color:${t.muted}; font-size:12.5px; line-height:1.5; margin:0 0 10px; max-width:560px;"><strong>Basis</strong>: <em>Value</em> compares the reading itself with the triggers; <em>Change</em> compares the change from the baseline. Triggers are magnitudes (−0.6 trips a 0.5 trigger). Leave a trigger blank if it does not apply.</p>
    <div id="mon-pt-params"></div>
    <button id="mon-pt-addparam" style="width:100%; border:1.5px dashed ${t.line}; background:none; border-radius:10px; padding:12px; font-size:13.5px; font-weight:650; color:${t.muted}; margin-top:8px;">+ Add parameter</button>
    <button id="mon-pt-delete" style="display:block; margin-top:22px; background:none; border:1px solid ${t.red}; color:${t.red}; border-radius:8px; padding:9px 16px; font-size:13.5px; font-weight:650;">Delete this point and its history</button>
  `;

  const rerender = () => monRenderPointEditor(host, plan, insp, pointId, onBack);
  host.querySelector('#mon-pt-back').addEventListener('click', onBack);
  shellWireAutosaveField(host.querySelector('#mon-pt-name'), (v) => savePoint({ name: v }));
  host.querySelector('#mon-pt-type').addEventListener('change', (e) => savePoint({ type: e.target.value }));
  host.querySelector('#mon-pt-status').addEventListener('change', (e) => savePoint({ status: e.target.value }));
  shellWireAutosaveField(host.querySelector('#mon-pt-what'), (v) => savePoint({ instrWhat: v }));
  shellWireAutosaveField(host.querySelector('#mon-pt-measure'), (v) => savePoint({ instrMeasure: v }));
  shellWireAutosaveField(host.querySelector('#mon-pt-how'), (v) => savePoint({ instrHow: v }));

  // Location: shared image, shape, colour, placement
  const openPicker = () => {
    const v = views[point.imageId];
    if (!v) return;
    monOpenMarkPicker(v, allPoints.filter((q) => q.id !== point.id && q.imageId === v.rec.id).map(monMarkOf), point, async (patch) => { await savePoint(patch); await rerender(); });
  };
  host.querySelector('#mon-pt-image').addEventListener('change', async (e) => {
    const val = e.target.value;
    if (val === '__new') {
      monAddImageFlow(plan, insp, async (rec) => { await savePoint({ imageId: rec.id, pin: null, area: null }); await rerender(); openPicker(); });
      e.target.value = point.imageId || '';
      return;
    }
    await savePoint({ imageId: val || null, pin: null, area: null });
    await rerender();
    if (val) openPicker();
  });
  host.querySelector('#mon-pt-shape').addEventListener('change', async (e) => { await savePoint({ shape: e.target.value }); await rerender(); });
  host.querySelectorAll('.mon-pt-sw').forEach((b) => b.addEventListener('click', async () => { await savePoint({ color: b.dataset.c }); await rerender(); }));
  host.querySelector('.mon-pt-custom').addEventListener('change', async (e) => { await savePoint({ color: e.target.value }); await rerender(); });
  const pinBtn = host.querySelector('#mon-pt-pin');
  if (pinBtn) pinBtn.addEventListener('click', openPicker);

  // Master photo
  host.querySelector('#mon-pt-setmaster').addEventListener('click', () => {
    openPhotoSourceSheet({ onFiles: async (files) => {
      const blob = await normalizeImageFile(files[0]);
      const photo = await DB.addPointPhoto(point.id, insp.id, 'monitoringMaster', blob, 'Master photo');
      if (point.masterPhotoId) await DB.delete('photos', point.masterPhotoId);
      await savePoint({ masterPhotoId: photo.id });
      await rerender();
    } });
  });
  const markMaster = host.querySelector('#mon-pt-markmaster');
  if (markMaster) markMaster.addEventListener('click', () => openAnnotator(masterPhoto.id, rerender));

  // Parameters
  const paramFields = [['name', 'Parameter', 'e.g. Crack width'], ['unit', 'Unit', 'mm'], ['accuracy', 'Accuracy', '± 0.05 mm']];
  function renderParams() {
    const box = host.querySelector('#mon-pt-params');
    box.innerHTML = (point.parameters || []).map((p, i) => `
      <div class="mon-param" data-i="${i}" style="border:1px solid ${t.line}; border-radius:10px; padding:12px; margin-bottom:10px; background:#fff;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
          <div style="font-weight:700; font-size:13.5px;">Parameter ${i + 1}</div>
          <button class="mon-param-remove" data-i="${i}" style="background:none; border:none; color:${t.red}; font-size:13px; font-weight:650;">Remove</button>
        </div>
        <div style="display:grid; grid-template-columns:repeat(2,1fr); gap:10px;">
          ${paramFields.map(([k, label, ph]) => `<div><label style="${monLabelStyle(t)}">${label}</label><input type="text" data-k="${k}" value="${esc(p[k] || '')}" placeholder="${esc(ph)}" style="${monInputStyle(t)}"></div>`).join('')}
          <div><label style="${monLabelStyle(t)}">Trigger basis</label>
            <select data-k="basis" style="${monInputStyle(t)}"><option value="value" ${p.basis !== 'change' ? 'selected' : ''}>Value</option><option value="change" ${p.basis === 'change' ? 'selected' : ''}>Change from baseline</option></select></div>
          <div><label style="${monLabelStyle(t)}">Baseline (optional)</label><input type="number" step="any" data-k="baseline" value="${p.baseline ?? ''}" placeholder="First reading if blank" style="${monInputStyle(t)}"></div>
          <div><label style="${monLabelStyle(t)}">Amber trigger</label><input type="number" step="any" data-k="amber" value="${p.amber ?? ''}" style="${monInputStyle(t)}"></div>
          <div><label style="${monLabelStyle(t)}">Red trigger</label><input type="number" step="any" data-k="red" value="${p.red ?? ''}" style="${monInputStyle(t)}"></div>
        </div>
        <div style="margin-top:10px;"><label style="${monLabelStyle(t)}">Action if a trigger is reached (who to contact, what happens)</label>
          <textarea data-k="action" rows="2" placeholder="e.g. Amber: inform Supervising Engineer within 24 h and double frequency. Red: notify TAA and Overseeing Organisation immediately." style="${monInputStyle(t)} resize:vertical;">${esc(p.action || '')}</textarea></div>
      </div>
    `).join('') || `<div style="color:${t.muted}; font-size:13.5px;">No parameters yet.</div>`;
    box.querySelectorAll('.mon-param').forEach((card) => {
      const i = Number(card.dataset.i);
      card.querySelectorAll('[data-k]').forEach((input) => {
        const k = input.dataset.k;
        const commit = async (raw) => {
          const params = (point.parameters || []).slice();
          const numeric = ['baseline', 'amber', 'red'].includes(k);
          params[i] = { ...params[i], [k]: numeric ? monNum(raw) : raw };
          await savePoint({ parameters: params });
        };
        if (input.tagName === 'SELECT') input.addEventListener('change', () => commit(input.value));
        else shellWireAutosaveField(input, commit);
      });
    });
    box.querySelectorAll('.mon-param-remove').forEach((btn) => btn.addEventListener('click', async () => {
      const i = Number(btn.dataset.i);
      const p = point.parameters[i];
      const used = (await DB.listPointReadings(point.id)).filter((r) => r.parameterId === p.id).length;
      if (used && !confirm(`This parameter has ${used} recorded reading${used === 1 ? '' : 's'}. Removing it deletes them. Remove anyway?`)) return;
      await DB.removeMonitoringParameterReadings(p.id, point.id);
      const params = point.parameters.slice();
      params.splice(i, 1);
      await savePoint({ parameters: params });
      renderParams();
    }));
  }
  renderParams();
  host.querySelector('#mon-pt-addparam').addEventListener('click', async () => {
    const params = (point.parameters || []).slice();
    params.push({ id: uid(), name: '', unit: '', accuracy: '', basis: 'value', baseline: null, amber: null, red: null, action: '' });
    await savePoint({ parameters: params });
    renderParams();
    const names = host.querySelectorAll('.mon-param [data-k="name"]');
    if (names.length) names[names.length - 1].focus();
  });
  host.querySelector('#mon-pt-delete').addEventListener('click', async () => {
    if (!confirm('Delete this monitoring point together with all its readings and photos? This cannot be undone.')) return;
    await DB.deleteMonitoringPoint(point.id);
    onBack();
  });
}

// ---- History filter controls (used by the history section and the standalone export) ----
function monRenderFilterControls(container, points, filter, onChange) {
  const t = SHELL_TOKENS;
  const all = !filter.pointIds || !filter.pointIds.length;
  container.innerHTML = `
    <div style="margin-bottom:12px;">
      <label style="${monLabelStyle(t)}">Points</label>
      <label style="display:flex; align-items:center; gap:8px; font-size:14px; margin-top:6px;"><input type="checkbox" id="mon-f-all" ${all ? 'checked' : ''} style="width:18px; height:18px;"> All points (whole structure)</label>
      <div id="mon-f-list" style="margin-top:4px; ${all ? 'opacity:.45; pointer-events:none;' : ''}">${points.map((p) => `<label style="display:flex; align-items:center; gap:8px; font-size:14px; padding:4px 0;"><input type="checkbox" class="mon-f-pt" data-id="${p.id}" ${!all && filter.pointIds.includes(p.id) ? 'checked' : ''} style="width:18px; height:18px;"> ${esc(monPointTitle(p))}${p.status === 'closed' ? ' <span style="color:' + t.muted + ';">(closed)</span>' : ''}</label>`).join('') || `<div style="color:${t.muted}; font-size:13px;">No points yet.</div>`}</div>
    </div>
    <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px;">
      <div><label style="${monLabelStyle(t)}">From</label><input type="date" id="mon-f-from" value="${esc(filter.from || '')}" style="${monInputStyle(t)}"></div>
      <div><label style="${monLabelStyle(t)}">To</label><input type="date" id="mon-f-to" value="${esc(filter.to || '')}" style="${monInputStyle(t)}"></div>
    </div>`;
  const emit = () => {
    const allChecked = container.querySelector('#mon-f-all').checked;
    const ids = allChecked ? null : Array.from(container.querySelectorAll('.mon-f-pt:checked')).map((c) => c.dataset.id);
    onChange({ pointIds: ids, from: container.querySelector('#mon-f-from').value || '', to: container.querySelector('#mon-f-to').value || '' });
  };
  container.querySelector('#mon-f-all').addEventListener('change', (e) => {
    const list = container.querySelector('#mon-f-list');
    list.style.opacity = e.target.checked ? '.45' : '1';
    list.style.pointerEvents = e.target.checked ? 'none' : 'auto';
    emit();
  });
  container.querySelectorAll('.mon-f-pt').forEach((c) => c.addEventListener('change', emit));
  container.querySelector('#mon-f-from').addEventListener('change', emit);
  container.querySelector('#mon-f-to').addEventListener('change', emit);
}

// Standalone history report: choose points and dates, export a PDF.
async function monOpenHistoryExportSheet(plan) {
  const points = await DB.listMonitoringPoints(plan.id);
  let filter = { pointIds: null, from: '', to: '' };
  const sheet = document.createElement('div');
  sheet.className = 'sheet-backdrop';
  sheet.innerHTML = `<div class="sheet" style="max-height:85vh; overflow:auto;"><div class="sheet-handle"></div><h2>Monitoring history report</h2><div id="mon-x-filter"></div><button class="btn btn-primary btn-block" id="mon-x-go" style="margin-top:16px;">Export PDF</button><button class="btn btn-ghost btn-block" id="mon-x-cancel" style="margin-top:8px;">Cancel</button></div>`;
  presentOverlay(sheet);
  sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.remove(); });
  sheet.querySelector('#mon-x-cancel').addEventListener('click', () => sheet.remove());
  monRenderFilterControls(sheet.querySelector('#mon-x-filter'), points, filter, (f) => { filter = f; });
  sheet.querySelector('#mon-x-go').addEventListener('click', async () => {
    if (!points.length) { toast('No monitoring points yet'); return; }
    sheet.remove();
    toast('Building report…');
    try { await monExportHistoryPdf(plan.id, filter); } catch (err) { console.error(err); toast('Could not build the report'); }
  });
}

// ---- A shared location image: rename, mark up, delete; shows every point and area on it ----
async function monRenderImageDetail(host, plan, insp, imageId, onBack) {
  const t = SHELL_TOKENS;
  const views = await monLoadImageViews(plan.id);
  const view = views[imageId];
  if (!view) { onBack(); return; }
  const points = (await DB.listMonitoringPoints(plan.id)).filter((p) => p.imageId === imageId);
  host.innerHTML = `
    <button id="mon-im-back" style="background:none; border:none; color:${t.muted}; font-size:13px; font-weight:650; margin-bottom:10px; padding:0;">‹ Back</button>
    <h2 style="font-size:20px; font-weight:700; margin:0 0 12px;">Location image</h2>
    <div style="margin-bottom:12px;"><label style="${monLabelStyle(t)}">Name</label><input type="text" id="mon-im-name" value="${esc(view.rec.name)}" style="${monInputStyle(t)}"></div>
    <div style="margin-bottom:12px;">${monMarkedImageHtml(view, points.map(monMarkOf), null, 420)}</div>
    <div style="font-size:13px; color:${t.muted}; margin-bottom:12px;">${points.length ? points.map((p) => esc(monPointTitle(p))).join('<br>') : 'No points or areas on this image yet. Add one from a monitoring point.'}</div>
    <div style="display:flex; flex-wrap:wrap; gap:8px;">
      <button id="mon-im-markup" style="${monBtnStyle(t)}">Mark up image</button>
      <button id="mon-im-del" style="background:none; border:1px solid ${t.red}; color:${t.red}; border-radius:8px; padding:8px 14px; font-size:13px; font-weight:650;">Delete image</button>
    </div>`;
  host.querySelector('#mon-im-back').addEventListener('click', onBack);
  shellWireAutosaveField(host.querySelector('#mon-im-name'), (v) => DB.updateMonitoringImage(imageId, { name: v || 'Location image' }));
  host.querySelector('#mon-im-markup').addEventListener('click', () => openAnnotator(view.photo.id, async () => {
    await DB.updateMonitoringImage(imageId, { w: null, h: null });
    monRenderImageDetail(host, plan, insp, imageId, onBack);
  }));
  host.querySelector('#mon-im-del').addEventListener('click', async () => {
    if (!confirm(points.length ? `Delete this image? The ${points.length} point${points.length === 1 ? '' : 's'}/area${points.length === 1 ? '' : 's'} on it will be kept but will need placing on another image.` : 'Delete this image?')) return;
    await DB.deleteMonitoringImage(imageId);
    onBack();
  });
}

// ---- Specification editor: plan + images + points list ----
async function shellEditMonitoringSpecSection(body, section) {
  const t = SHELL_TOKENS;
  const { insp, plan: loaded } = await monLoadPlanFor(shellState.selectedInspectionId);
  let plan = loaded;
  async function savePlan(patch) { plan = await DB.updateMonitoringPlan(plan.id, patch); }
  const host = document.createElement('div');
  body.appendChild(host);

  const warningsHtml = () => {
    const w = monPlanWarnings(plan, monToday());
    return w.length ? `<div style="background:#fff7e6; border:1px solid #f0c36d; border-radius:8px; padding:10px 12px; margin-bottom:14px; font-size:12.5px; line-height:1.5;">${w.map((x) => `<div>⚠ ${esc(x)}</div>`).join('')}</div>` : '';
  };

  async function renderMain() {
    const points = await DB.listMonitoringPoints(plan.id);
    const readings = await DB.listMonitoringReadings(plan.id);
    const visits = await DB.listMonitoringVisits(plan.id);
    host.innerHTML = `
      <h2 style="font-size:20px; font-weight:700; margin:0 0 4px;">Monitoring specification</h2>
      <p style="color:${t.muted}; font-size:13px; line-height:1.5; margin:0 0 16px; max-width:560px;">Shared by every monitoring record of <strong>${esc(plan.structureName || 'this structure')}</strong>. Changes here apply to the whole series (CS 470 6.12, Appendix A2).</p>
      <div id="mon-warnings">${warningsHtml()}</div>
      <div style="margin-bottom:14px;">
        <label style="${monLabelStyle(t)}">Monitoring class</label>
        <select id="mon-class" style="${monInputStyle(t)}">${[1, 2, 3].map((c) => `<option value="${c}" ${Number(plan.monitoringClass) === c ? 'selected' : ''}>${esc(MON_CLASS_INFO[c].label)}</option>`).join('')}</select>
        <div id="mon-class-detail" style="font-size:12.5px; color:${t.muted}; margin-top:6px;">${esc(MON_CLASS_INFO[plan.monitoringClass || 1].detail)}</div>
      </div>
      <div style="display:grid; grid-template-columns:repeat(3,1fr); gap:10px; margin-bottom:14px;">
        <div><label style="${monLabelStyle(t)}">Start date</label><input type="date" id="mon-start" value="${esc(plan.startDate || '')}" style="${monInputStyle(t)}"></div>
        <div><label style="${monLabelStyle(t)}">Planned end (max 2 yrs)</label><input type="date" id="mon-end" value="${esc(plan.endDate || '')}" style="${monInputStyle(t)}"></div>
        <div><label style="${monLabelStyle(t)}">Next formal review</label><input type="date" id="mon-review" value="${esc(plan.reviewDate || '')}" style="${monInputStyle(t)}"></div>
      </div>
      <div style="margin-bottom:14px;">
        <label style="${monLabelStyle(t)}">Monitoring frequency (a record is due every...)</label>
        <div style="display:flex; gap:10px; max-width:360px;">
          <input type="number" min="1" step="1" inputmode="numeric" id="mon-freq-value" value="${plan.frequencyValue != null ? esc(plan.frequencyValue) : ''}" placeholder="e.g. 3" style="${monInputStyle(t)}">
          <select id="mon-freq-unit" style="${monInputStyle(t)}"><option value="days" ${plan.frequencyUnit === 'days' ? 'selected' : ''}>days</option><option value="months" ${plan.frequencyUnit !== 'days' ? 'selected' : ''}>months</option></select>
        </div>
        <div style="font-size:12px; color:${t.muted}; margin-top:6px;">Used on the Overview to show when the next record is due.</div>
      </div>
      <div style="margin-bottom:14px;"><label style="${monLabelStyle(t)}">Reason for monitoring and assessment findings</label><textarea id="mon-reason" rows="4" placeholder="Basis of the sub-standard status: location, nature and degree of inadequacy, capacity factor C and required K, level of assessment, condition and distress." style="${monInputStyle(t)} resize:vertical;">${esc(plan.reason || '')}</textarea></div>
      <div style="margin-bottom:20px;"><label style="${monLabelStyle(t)}">Anticipated failure mode(s)</label><textarea id="mon-failure" rows="3" placeholder="Anticipated mode(s) of failure, how it progresses from local distress to collapse, likelihood and consequence." style="${monInputStyle(t)} resize:vertical;">${esc(plan.failureMode || '')}</textarea></div>

      <h3 style="font-size:15px; font-weight:700; margin:0 0 6px;">Location images</h3>
      <p style="color:${t.muted}; font-size:12.5px; line-height:1.5; margin:0 0 10px; max-width:560px;">Photos, drawings or sketches that show where the points and areas are. Use as few as you can: for example one photo per abutment carries all of its points.</p>
      <div id="mon-images"></div>
      <button id="mon-add-image" style="width:100%; border:1.5px dashed ${t.line}; background:none; border-radius:10px; padding:12px; font-size:13.5px; font-weight:650; color:${t.muted}; margin:8px 0 22px;">+ Add location image</button>

      <h3 style="font-size:15px; font-weight:700; margin:0 0 6px;">Monitoring points and areas</h3>
      <p style="color:${t.muted}; font-size:12.5px; line-height:1.5; margin:0 0 10px; max-width:560px;">Each item, problem or area that needs monitoring is numbered MP1, MP2… Mark it on a location image, add a master photo and instructions on the first visit; every visit then records a new reading against it.</p>
      <div id="mon-points"></div>
      <button id="mon-add-point" style="width:100%; border:1.5px dashed ${t.line}; background:none; border-radius:10px; padding:12px; font-size:13.5px; font-weight:650; color:${t.muted}; margin-top:8px;">+ Add monitoring point or area</button>
      <button id="mon-export" style="${monBtnStyle(t)} margin-top:16px;">Generate a history report…</button>
    `;
    host.querySelector('#mon-class').addEventListener('change', async (e) => { await savePlan({ monitoringClass: Number(e.target.value) }); host.querySelector('#mon-class-detail').textContent = MON_CLASS_INFO[plan.monitoringClass].detail; });
    [['mon-start', 'startDate'], ['mon-end', 'endDate'], ['mon-review', 'reviewDate']].forEach(([id, key]) => {
      host.querySelector('#' + id).addEventListener('change', async (e) => { await savePlan({ [key]: e.target.value }); host.querySelector('#mon-warnings').innerHTML = warningsHtml(); });
    });
    host.querySelector('#mon-freq-value').addEventListener('change', async (e) => { const n = monNum(e.target.value); await savePlan({ frequencyValue: n !== null && n > 0 ? Math.round(n) : null }); });
    host.querySelector('#mon-freq-unit').addEventListener('change', async (e) => { await savePlan({ frequencyUnit: e.target.value === 'days' ? 'days' : 'months' }); });
    shellWireAutosaveField(host.querySelector('#mon-reason'), (v) => savePlan({ reason: v }));
    shellWireAutosaveField(host.querySelector('#mon-failure'), (v) => savePlan({ failureMode: v }));

    const views = await monLoadImageViews(plan.id);
    const imgBox = host.querySelector('#mon-images');
    imgBox.innerHTML = Object.values(views).map((v) => {
      const onIt = points.filter((p) => p.imageId === v.rec.id);
      return `<div class="mon-im-card" data-id="${v.rec.id}" style="display:flex; gap:12px; align-items:center; border:1px solid ${t.line}; border-radius:10px; padding:10px; margin-bottom:8px; background:#fff; cursor:pointer;"><div style="width:96px; flex:none;">${monMarkedImageHtml(v, onIt.map(monMarkOf), null, 64)}</div><div style="flex:1; min-width:0;"><div style="font-weight:700; font-size:14px;">${esc(v.rec.name)}</div><div style="font-size:12px; color:${t.muted};">${onIt.length ? onIt.map((p) => esc(monLabel(p))).join(', ') : 'nothing marked yet'}</div></div></div>`;
    }).join('') || `<div style="color:${t.muted}; font-size:13.5px;">No location images yet.</div>`;
    imgBox.querySelectorAll('.mon-im-card').forEach((c) => c.addEventListener('click', () => monRenderImageDetail(host, plan, insp, c.dataset.id, renderMain)));
    host.querySelector('#mon-add-image').addEventListener('click', () => monAddImageFlow(plan, insp, () => renderMain()));

    const list = host.querySelector('#mon-points');
    const cards = [];
    for (const p of points) {
      const view = p.imageId ? views[p.imageId] : null;
      const rag = monLatestRag(p, readings.filter((r) => r.pointId === p.id), visits.filter((v) => v.pointId === p.id));
      const located = !!monMarkGeometry(p);
      cards.push(`<div class="mon-pt-card" data-id="${p.id}" style="display:flex; gap:12px; align-items:center; border:1px solid ${t.line}; border-radius:10px; padding:10px; margin-bottom:8px; background:#fff; cursor:pointer;">
        <div style="width:96px; flex:none;">${monMarkedImageHtml(view, view ? points.filter((q) => q.imageId === view.rec.id).map(monMarkOf) : [], p.id, 64)}</div>
        <div style="flex:1; min-width:0;"><div style="font-weight:700; font-size:14px;"><span style="background:#fff; color:#000; border:2px solid ${esc(p.color || '#d32f2f')}; border-radius:5px; padding:0 6px; margin-right:6px;">${esc(monLabel(p))}</span>${esc(p.name) || 'Unnamed'}</div><div style="font-size:12px; color:${t.muted};">${p.shape === 'area' ? 'Area' : 'Point'} · ${esc(p.type)} · ${(p.parameters || []).length} parameter${(p.parameters || []).length === 1 ? '' : 's'}${p.status === 'closed' ? ' · closed' : ''}${!located ? ' · <span style="color:' + t.red + ';">not placed</span>' : ''}${!p.masterPhotoId ? ' · <span style="color:' + t.red + ';">no master photo</span>' : ''}</div></div>
        <div>${monRagBadge(rag)}</div></div>`);
    }
    list.innerHTML = cards.join('') || `<div style="color:${t.muted}; font-size:13.5px;">No monitoring points yet.</div>`;
    list.querySelectorAll('.mon-pt-card').forEach((c) => c.addEventListener('click', () => monRenderPointEditor(host, plan, insp, c.dataset.id, renderMain)));
    host.querySelector('#mon-add-point').addEventListener('click', async () => {
      const p = await DB.addMonitoringPoint(plan.id, insp.id, {});
      monRenderPointEditor(host, plan, insp, p.id, renderMain);
    });
    host.querySelector('#mon-export').addEventListener('click', () => monOpenHistoryExportSheet(plan));
  }
  await renderMain();
}


// ---- Monitoring workspace: Overview tab and sidebar (browser only) ----
function monCard(t, title, inner, extra) {
  return `<div style="background:#fff; border:1px solid ${t.line}; border-radius:14px; padding:18px 20px; ${extra || ''}"><div style="font-size:15px; font-weight:650; margin-bottom:14px;">${title}</div>${inner}</div>`;
}
function monStat(t, label, value, color) {
  return `<div><div style="font-size:11px; font-weight:700; letter-spacing:0.4px; text-transform:uppercase; color:${t.muted};">${esc(label)}</div><div style="font-size:19px; font-weight:700; margin-top:3px; ${color ? 'color:' + color + ';' : ''}">${value}</div></div>`;
}
function monReadingText(r, param) {
  return r ? monFmtNum(r.value) + (param && param.unit ? ' ' + esc(param.unit) : '') : '—';
}

async function monRenderOverviewTab(content, insp) {
  const t = SHELL_TOKENS;
  const plan = await DB.ensureMonitoringPlanForInspection(insp);
  const points = await DB.listMonitoringPoints(plan.id);
  const readings = await DB.listMonitoringReadings(plan.id);
  const records = await DB.listMonitoringRecords(plan.id);
  const isRecord = !!insp.monitoringRecord;
  const mode = isRecord ? (shellState.monOverviewMode || 'record') : 'overall';
  const ov = monBuildOverview(plan, points, readings, records, monToday(), isRecord ? insp.id : null);
  const warn = monPlanWarnings(plan, monToday());

  const ragCell = (item, label) => item
    ? `<div>${monRagBadge(item.rag)}<div style="font-size:12px; color:${t.muted}; margin-top:4px;">${esc(monRecordTitle(item.record))}</div></div>`
    : `<div style="color:${t.muted}; font-size:13px;">${label}</div>`;
  let nextDue;
  if (!ov.frequency) nextDue = `<span style="font-size:13px; font-weight:500; color:${t.muted};">Set a frequency in the Monitoring Specification</span>`;
  else if (ov.daysToNext === null) nextDue = '—';
  else if (ov.daysToNext < 0) nextDue = `<span style="color:${t.red};">${-ov.daysToNext} day${ov.daysToNext === -1 ? '' : 's'} overdue</span>`;
  else nextDue = `${ov.daysToNext} day${ov.daysToNext === 1 ? '' : 's'}`;

  const detailFields = [
    ['Structure', insp.structureName], ['Structure ID', insp.structureId],
    [isRecord ? 'This record' : 'Type', isRecord ? monRecordTitle(insp) : 'Monitoring set-up'],
    ['Inspector', insp.inspector], ['Class', MON_CLASS_INFO[plan.monitoringClass || 1].label],
    ['Period', [plan.startDate && fmtDate(plan.startDate), plan.endDate && fmtDate(plan.endDate)].filter(Boolean).join(' to ') || '—']
  ];
  const th = `style="text-align:left; font-size:11px; text-transform:uppercase; color:${t.muted}; padding:6px 8px; border-bottom:1px solid ${t.line};"`;
  const td = `style="padding:8px; border-bottom:1px solid ${t.line}; font-size:13px; vertical-align:top;"`;
  const trendText = { increasing: '↑ increasing', decreasing: '↓ decreasing', steady: '→ steady' };

  let tableHtml;
  if (!points.length) tableHtml = `<div style="color:${t.muted}; font-size:13.5px;">No monitoring points yet. Add them in Set up monitoring.</div>`;
  else if (mode === 'overall') {
    const rows = ov.overall.map((r) => `<tr><td ${td}><strong>${esc(monLabel(r.point))}</strong> ${esc(r.point.name || '')}</td><td ${td}>${esc(r.param.name || 'Parameter')}</td><td ${td}>${monReadingText(r.first, r.param)}<div style="font-size:11px; color:${t.muted};">${r.first ? fmtDate(r.first.date) : ''}</div></td><td ${td}>${r.change === null ? '—' : monSigned(r.change) + (r.param.unit ? ' ' + esc(r.param.unit) : '')}</td><td ${td}>${monReadingText(r.last, r.param)}<div style="font-size:11px; color:${t.muted};">${r.last ? fmtDate(r.last.date) : ''}</div></td><td ${td}>${monRagBadge(r.rag)}</td><td ${td}>${r.trend ? trendText[r.trend] : '—'}</td></tr>`).join('');
    tableHtml = `<div style="overflow-x:auto;"><table style="width:100%; border-collapse:collapse;"><thead><tr><th ${th}>Point</th><th ${th}>Parameter</th><th ${th}>First reading</th><th ${th}>Change</th><th ${th}>Last reading</th><th ${th}>Status</th><th ${th}>Trend</th></tr></thead><tbody>${rows || `<tr><td ${td} colspan="7">No parameters defined.</td></tr>`}</tbody></table></div>`;
  } else {
    const rows = ov.selected.map((r) => `<tr><td ${td}><strong>${esc(monLabel(r.point))}</strong> ${esc(r.point.name || '')}</td><td ${td}>${esc(r.param.name || 'Parameter')}</td><td ${td}>${monReadingText(r.current, r.param)}</td><td ${td}>${monReadingText(r.previous && r.current ? r.previous : null, r.param)}</td><td ${td}>${r.changePrev === null ? '—' : monSigned(r.changePrev)}</td><td ${td}>${r.changeFirst === null ? '—' : monSigned(r.changeFirst)}</td><td ${td}>${monRagBadge(r.rag)}</td></tr>`).join('');
    tableHtml = `<div style="overflow-x:auto;"><table style="width:100%; border-collapse:collapse;"><thead><tr><th ${th}>Point</th><th ${th}>Parameter</th><th ${th}>This record</th><th ${th}>Previous</th><th ${th}>Change since previous</th><th ${th}>Change since first</th><th ${th}>Status</th></tr></thead><tbody>${rows || `<tr><td ${td} colspan="7">No parameters defined.</td></tr>`}</tbody></table></div>`;
  }

  const trig = ov.triggers.length ? ov.triggers.map((x) => `<div style="padding:9px 0; border-bottom:1px solid ${t.line}; display:flex; gap:12px; align-items:flex-start;"><div>${monRagBadge(x.rag)}</div><div style="min-width:0;"><div style="font-size:13.5px; font-weight:650;">${esc(monPointTitle(x.point))} · ${esc(x.param.name || 'Parameter')}: ${monFmtNum(x.value)}${x.param.unit ? ' ' + esc(x.param.unit) : ''}</div>${x.action ? `<div style="font-size:12.5px; color:${t.muted}; margin-top:2px;">Action: ${esc(x.action)}</div>` : ''}</div></div>`).join('') : `<div style="color:${t.muted}; font-size:13.5px;">${ov.latest ? 'No points at Amber or Red at the latest record.' : 'No records yet.'}</div>`;

  content.innerHTML = `
    <div style="display:grid; grid-template-columns:1fr 1fr; gap:18px; align-items:start;">
      ${monCard(t, 'Monitoring details', `<div style="display:grid; grid-template-columns:1fr 1fr; gap:14px 20px;">${detailFields.map(([l, v]) => `<div><div style="font-size:11px; font-weight:700; letter-spacing:0.4px; text-transform:uppercase; color:${t.muted};">${esc(l)}</div><div style="font-size:14px; font-weight:550; margin-top:3px;">${esc(v) || '—'}</div></div>`).join('')}</div>${plan.reason ? `<div style="font-size:12.5px; color:${t.muted}; margin-top:14px; line-height:1.5;"><strong>Reason:</strong> ${esc(plan.reason.length > 220 ? plan.reason.slice(0, 220) + '…' : plan.reason)}</div>` : ''}`)}
      ${monCard(t, 'Status', `
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:16px 20px;">
          ${monStat(t, 'Monitoring points', `${ov.activeCount}${ov.closedCount ? `<span style="font-size:12px; font-weight:500; color:${t.muted};"> active, ${ov.closedCount} closed</span>` : ''}`)}
          ${monStat(t, 'Records', String(ov.recordCount))}
          <div><div style="font-size:11px; font-weight:700; letter-spacing:0.4px; text-transform:uppercase; color:${t.muted}; margin-bottom:5px;">Condition - first record</div>${ragCell(ov.first, 'No records yet')}</div>
          <div><div style="font-size:11px; font-weight:700; letter-spacing:0.4px; text-transform:uppercase; color:${t.muted}; margin-bottom:5px;">Condition - latest record</div>${ragCell(ov.latest, 'No records yet')}</div>
          ${monStat(t, 'Last record', ov.lastDate ? esc(fmtDate(ov.lastDate)) : '—')}
          ${monStat(t, 'Next record due', nextDue + (ov.nextDue && ov.daysToNext !== null ? `<div style="font-size:12px; font-weight:500; color:${t.muted};">${esc(fmtDate(ov.nextDue))}</div>` : ''))}
        </div>`)}
      ${warn.length ? `<div style="grid-column:1 / -1; background:#fff7e6; border:1px solid #f0c36d; border-radius:12px; padding:12px 16px; font-size:12.5px; line-height:1.5;">${warn.map((x) => `<div>⚠ ${esc(x)}</div>`).join('')}</div>` : ''}
      ${monCard(t, `Trigger points - latest record${ov.triggers.length ? ` (${ov.triggers.length})` : ''}`, trig, 'grid-column:1 / -1;')}
      ${ov.noReading.length ? monCard(t, 'No reading at the latest record', ov.noReading.map((p) => `<span style="display:inline-block; background:${t.page}; border:1px solid ${t.line}; border-radius:20px; padding:5px 12px; margin:0 6px 6px 0; font-size:12.5px; font-weight:600;">${esc(monPointTitle(p))}</span>`).join(''), 'grid-column:1 / -1;') : ''}
      <div style="grid-column:1 / -1;">
        ${monCard(t, `<span style="display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap;"><span>Readings</span>${isRecord ? `<span id="mon-ov-mode" style="display:inline-flex; border:1px solid ${t.line}; border-radius:8px; overflow:hidden; font-size:12.5px; font-weight:650;"><button data-m="record" style="border:none; padding:6px 12px; background:${mode === 'record' ? t.ink : '#fff'}; color:${mode === 'record' ? '#fff' : t.ink};">This record</button><button data-m="overall" style="border:none; padding:6px 12px; background:${mode === 'overall' ? t.ink : '#fff'}; color:${mode === 'overall' ? '#fff' : t.ink};">Overall</button></span>` : ''}</span>`, tableHtml)}
      </div>
    </div>`;
  content.querySelectorAll('#mon-ov-mode button').forEach((b) => b.addEventListener('click', () => { shellState.monOverviewMode = b.dataset.m; monRenderOverviewTab(content, insp); }));
}

// Sidebar for the monitoring workspace. Three views:
//  - home (the structure picked from the list): Set up monitoring, + New monitoring record and the
//    scrolling records list only - no sections;
//  - set-up (after Set up monitoring): "< Monitoring" and the set-up sections;
//  - record: the buttons and records list, then that record's own sections (readings, history...).
async function monRenderWorkspaceSidebar(sidebar, insp) {
  const t = SHELL_TOKENS;
  const plan = await DB.ensureMonitoringPlanForInspection(insp);
  const setupId = insp.isMonitoringSetup ? insp.id : plan.setupInspectionId;
  const isRecord = !!insp.monitoringRecord;
  const view = isRecord ? 'record' : (shellState.monSetupOpen ? 'setup' : 'home');
  const records = (await DB.listMonitoringRecords(plan.id)).slice().reverse();
  const sections = view === 'home' ? [] : await DB.listReportSections(insp.id);
  const btn = (id, label, active, accent) => `<button id="${id}" style="width:100%; background:${accent ? t.red : (active ? t.inkHover : 'transparent')}; color:#fff; border:1px solid ${accent ? t.red : (active ? '#fff' : t.inkBorder)}; border-radius:9px; padding:10px; font-size:13.5px; font-weight:650; margin-bottom:8px;">${label}</button>`;
  const header = (backId, backLabel) => `
    <div style="padding:14px 16px; display:flex; align-items:center; justify-content:space-between; border-bottom:1px solid ${t.inkBorder}; flex-shrink:0;">
      <button id="${backId}" style="background:none; border:none; color:${t.mutedLight}; font-size:13px; font-weight:650;">${backLabel}</button>
      <button id="shell-sec-home" style="background:none; border:none; color:${t.mutedLight}; font-size:13px; font-weight:650;">⌂ Home</button>
    </div>`;
  const sectionsBlock = (label) => `
    <div style="padding:10px 16px 6px; border-top:1px solid ${t.inkBorder}; display:flex; align-items:center; justify-content:space-between; flex-shrink:0;">
      <div style="font-size:11px; font-weight:700; letter-spacing:0.5px; text-transform:uppercase; color:${t.mutedLight}; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${esc(label)}</div>
      <button id="shell-sec-addsection" style="background:${t.inkHover}; color:#fff; border:1px solid ${t.inkBorder}; border-radius:8px; padding:5px 10px; font-size:12px; font-weight:650; flex-shrink:0;">+ Add</button>
    </div>
    <div id="shell-sec-list" style="flex:1; min-height:0; overflow-y:auto; padding:0 12px calc(14px + var(--safe-bottom));"></div>`;
  const recordsBlock = `
    <div style="padding:12px 16px 4px; flex-shrink:0;">
      ${btn('mon-sb-setup', 'Set up monitoring', false, false)}
      ${btn('mon-sb-new', '+ New monitoring record', false, true)}
    </div>
    <div style="padding:4px 16px 6px; font-size:11px; font-weight:700; letter-spacing:0.5px; text-transform:uppercase; color:${t.mutedLight}; flex-shrink:0;">Records (${records.length})</div>
    <div id="mon-sb-records" style="${view === 'home' ? 'flex:1; min-height:0;' : 'max-height:34%; min-height:48px; flex-shrink:0;'} overflow-y:auto; padding:0 12px 6px; -webkit-overflow-scrolling:touch;"></div>`;

  if (view === 'setup') {
    sidebar.innerHTML = header('mon-sb-tohome', '‹ Monitoring') + sectionsBlock('Set-up sections');
  } else if (view === 'record') {
    sidebar.innerHTML = header('shell-sec-back', '‹ Back') + recordsBlock + sectionsBlock('Record ' + (insp.recordNumber != null ? insp.recordNumber : '') + ' sections');
  } else {
    sidebar.innerHTML = header('shell-sec-back', '‹ Back') + recordsBlock;
  }

  const goList = () => { shellState.selectedInspectionId = null; shellState.editingSectionId = null; shellState.monSetupOpen = false; renderShellSidebar(); renderShellMainPane(); };
  const backBtn = document.getElementById('shell-sec-back');
  if (backBtn) backBtn.addEventListener('click', goList);
  document.getElementById('shell-sec-home').addEventListener('click', () => navigate('#/'));
  const toHome = document.getElementById('mon-sb-tohome');
  if (toHome) toHome.addEventListener('click', () => shellSelectInspection(setupId || insp.id));
  const addBtn = document.getElementById('shell-sec-addsection');
  if (addBtn) addBtn.addEventListener('click', shellOpenAddSectionMenu);

  if (view !== 'setup') {
    const open = async (id) => { shellState.monOverviewMode = null; await shellSelectInspection(id); };
    document.getElementById('mon-sb-setup').addEventListener('click', () => { if (setupId) { shellState.monSetupOpen = true; shellSelectInspection(setupId, { keepSetup: true }); } });
    document.getElementById('mon-sb-new').addEventListener('click', async () => {
      const rec = await DB.createMonitoringRecord(plan.id);
      toast('Created ' + monRecordTitle(rec));
      open(rec.id);
    });
    const recBox = document.getElementById('mon-sb-records');
    const ragMap = {};
    const points = await DB.listMonitoringPoints(plan.id);
    const readings = await DB.listMonitoringReadings(plan.id);
    for (const r of records) {
      const list = [];
      for (const p of points) list.push(...monBuildSummary(p, readings.filter((x) => x.pointId === p.id), r.id).map((x) => x.rag));
      ragMap[r.id] = monWorstRag(list);
    }
    recBox.innerHTML = records.length ? records.map((r) => {
      const active = r.id === insp.id;
      return `<div class="mon-sb-rec" data-id="${r.id}" style="display:flex; align-items:center; gap:9px; background:${active ? t.inkHover : 'transparent'}; border:1px solid ${active ? t.inkBorder : 'transparent'}; border-radius:9px; padding:9px 10px; margin-bottom:4px; cursor:pointer;"><span style="width:9px; height:9px; border-radius:50%; flex-shrink:0; background:${ragMap[r.id] ? monRagCss(ragMap[r.id]) : 'transparent'}; border:1px solid ${ragMap[r.id] ? monRagCss(ragMap[r.id]) : t.inkBorder};"></span><span style="font-size:13px; font-weight:650; color:#fff; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${esc(monRecordTitle(r))}</span></div>`;
    }).join('') : `<div style="padding:8px 4px; color:${t.mutedLight}; font-size:12.5px;">No records yet. Tap "New monitoring record" to log a visit.</div>`;
    recBox.querySelectorAll('.mon-sb-rec').forEach((el2) => el2.addEventListener('click', () => open(el2.dataset.id)));
  }

  const listBox = document.getElementById('shell-sec-list');
  if (listBox) {
    listBox.innerHTML = sections.map((s) => {
      const info = REPORT_SECTION_TYPES[s.type] || { label: s.type };
      const hasCustomTitle = ['text', 'inspection'].includes(s.type);
      const title = (hasCustomTitle && s.title) ? s.title : info.label;
      const subtitle = hasCustomTitle ? info.label : null;
      const active = s.id === shellState.editingSectionId;
      return `
        <div class="shell-rep-card" draggable="true" data-id="${s.id}" style="background:${active ? t.inkHover : 'transparent'}; border:1px solid ${active ? t.inkBorder : 'transparent'}; border-radius:9px; padding:9px 10px; margin-bottom:5px; cursor:pointer;">
          <div style="font-size:13px; font-weight:650; color:#fff; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${esc(title)}</div>
          ${subtitle ? `<div style="font-size:10.5px; color:${t.mutedLight}; margin-top:1px;">${esc(subtitle)}</div>` : ''}
        </div>`;
    }).join('');
    listBox.querySelectorAll('.shell-rep-card').forEach((card) => {
      card.addEventListener('click', () => shellSelectSection(card.dataset.id));
      shellWireReportCardDrag(card, sections);
    });
  }
}

// ---- Visit editor: record this visit's readings, notes and photos for each point ----
async function shellEditMonitoringReadingsSection(body, section) {
  const t = SHELL_TOKENS;
  const { insp, plan } = await monLoadPlanFor(shellState.selectedInspectionId);
  const host = document.createElement('div');
  body.appendChild(host);
  const visitDate = (insp.date || '').slice(0, 10) || monToday();

  async function renderMain() {
    const points = (await DB.listMonitoringPoints(plan.id)).filter((p) => p.status !== 'closed');
    host.innerHTML = `
      <h2 style="font-size:20px; font-weight:700; margin:0 0 4px;">Monitoring readings</h2>
      <p style="color:${t.muted}; font-size:13px; line-height:1.5; margin:0 0 14px;">Visit date: <strong>${esc(fmtDate(insp.date))}</strong>. Record a reading, note and photos for each point. Readings save as you go and are judged against the trigger levels.</p>
      <div id="mon-banner"></div>
      <div id="mon-visit-cards"></div>
      <button id="mon-v-addpoint" style="width:100%; border:1.5px dashed ${t.line}; background:none; border-radius:10px; padding:12px; font-size:13.5px; font-weight:650; color:${t.muted}; margin-top:8px;">+ New monitoring point or area</button>`;
    const box = host.querySelector('#mon-visit-cards');
    if (!points.length) box.innerHTML = `<div style="color:${t.muted}; font-size:13.5px; max-width:460px;">No monitoring points yet. On the first visit, add each item that needs monitoring, locate it on an image, add a master photo and the instructions.</div>`;
    for (const p of points) {
      const card = document.createElement('div');
      card.dataset.id = p.id;
      card.style.cssText = `border:1px solid ${t.line}; border-radius:10px; padding:12px; margin-bottom:12px; background:#fff;`;
      box.appendChild(card);
      await drawCard(card, p.id);
    }
    await refreshBanner();
    host.querySelector('#mon-v-addpoint').addEventListener('click', async () => {
      const p = await DB.addMonitoringPoint(plan.id, insp.id, {});
      monRenderPointEditor(host, plan, insp, p.id, renderMain);
    });
  }

  async function refreshBanner() {
    const points = (await DB.listMonitoringPoints(plan.id)).filter((p) => p.status !== 'closed');
    const readings = await DB.listMonitoringReadings(plan.id);
    const flagged = [];
    for (const p of points) {
      for (const s of monBuildSummary(p, readings.filter((r) => r.pointId === p.id), insp.id)) {
        if (s.rag === 'amber' || s.rag === 'red') flagged.push({ p, s });
      }
    }
    const red = flagged.some((f) => f.s.rag === 'red');
    host.querySelector('#mon-banner').innerHTML = flagged.length
      ? `<div style="background:${red ? '#fdecec' : '#fff7e6'}; border:1px solid ${red ? '#e49a9a' : '#f0c36d'}; border-radius:8px; padding:10px 12px; margin-bottom:14px; font-size:13px; line-height:1.5;"><strong>Trigger level reached:</strong> ${flagged.map((f) => esc(monPointTitle(f.p) + ' – ' + (f.s.param.name || 'parameter')) + ' (' + MON_RAG_LABELS[f.s.rag] + ')').join(', ')}. Record the action taken, who was told and when in the "Trigger Exceedances and Actions Taken" section.${flagged.map((f) => f.s.param.action ? `<div style="margin-top:6px;"><em>${esc(monLabel(f.p))} – ${esc(f.s.param.name)}:</em> ${esc(f.s.param.action)}</div>` : '').join('')}</div>`
      : '';
  }

  async function drawCard(card, pointId) {
    const point = await DB.get('monitoringPoints', pointId);
    const readings = await DB.listPointReadings(pointId);
    const visit = await DB.getPointVisit(pointId, insp.id);
    const photos = await DB.listPointPhotos(pointId, 'monitoringVisit', insp.id);
    const master = point.masterPhotoId ? await DB.get('photos', point.masterPhotoId) : null;
    const views = await monLoadImageViews(plan.id);
    const view = point.imageId ? views[point.imageId] || null : null;
    const onImage = view ? (await DB.listMonitoringPoints(plan.id)).filter((q) => q.imageId === view.rec.id).map(monMarkOf) : [];
    const summary = monBuildSummary(point, readings, insp.id);
    const overall = monWorstRag(summary.map((s) => s.rag));
    const hasInstr = point.instrWhat || point.instrMeasure || point.instrHow;
    card.innerHTML = `
      <div style="display:flex; gap:12px; align-items:center;">
        ${master ? `<img src="${blobUrl(master.annotatedBlob || master.originalBlob)}" style="width:64px; height:64px; object-fit:cover; border-radius:8px; flex:none;">` : ''}
        <div style="flex:1; min-width:0;"><div style="font-weight:700; font-size:14.5px;"><span style="background:#fff; color:#000; border:2px solid ${esc(point.color || '#d32f2f')}; border-radius:5px; padding:0 6px; margin-right:6px;">${esc(monLabel(point))}</span>${esc(point.name) || 'Unnamed'}</div><div style="font-size:12px; color:${t.muted};">${point.shape === 'area' ? 'Area' : 'Point'} · ${esc(point.type)}</div></div>
        ${monRagBadge(overall)}
        <button class="mon-edit-point" style="${monBtnStyle(t)}">Edit point</button>
      </div>
      ${hasInstr || view ? `<details style="margin-top:8px;"><summary style="font-size:13px; font-weight:650; color:${t.muted}; cursor:pointer;">Where it is and how to measure it</summary>
        <div style="margin-top:8px;">${view ? monMarkedImageHtml(view, onImage, point.id, 260) : ''}</div>
        ${master ? `<div style="margin-top:8px;"><img src="${blobUrl(master.annotatedBlob || master.originalBlob)}" style="max-width:100%; max-height:220px; border-radius:8px;"></div>` : ''}
        ${point.instrWhat ? `<p style="font-size:13.5px; margin:8px 0 0;"><strong>Monitoring:</strong> ${esc(point.instrWhat)}</p>` : ''}
        ${point.instrMeasure ? `<p style="font-size:13.5px; margin:6px 0 0;"><strong>Measure:</strong> ${esc(point.instrMeasure)}</p>` : ''}
        ${point.instrHow ? `<p style="font-size:13.5px; margin:6px 0 0;"><strong>How:</strong> ${esc(point.instrHow)}</p>` : ''}</details>` : ''}
      ${summary.map((s, i) => `
        <div style="margin-top:10px; padding-top:10px; border-top:1px solid ${t.line};">
          <div style="display:flex; justify-content:space-between; align-items:center;"><div style="font-weight:650; font-size:13.5px;">${esc(s.param.name) || 'Unnamed parameter'}${s.param.accuracy ? ' <span style="font-weight:400; color:' + t.muted + ';">(' + esc(s.param.accuracy) + ')</span>' : ''}</div>${monRagBadge(s.rag)}</div>
          <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-top:6px;">
            <div><label style="${monLabelStyle(t)}">Reading${s.param.unit ? ' (' + esc(s.param.unit) + ')' : ''}</label><input type="number" step="any" class="mon-val" data-i="${i}" value="${s.current ? s.current.value : ''}" style="${monInputStyle(t)}"></div>
            <div><label style="${monLabelStyle(t)}">Reading note</label><input type="text" class="mon-rnote" data-i="${i}" value="${esc(s.current ? s.current.note : '')}" placeholder="Optional" style="${monInputStyle(t)}"></div>
          </div>
          <div style="font-size:12.5px; color:${t.muted}; margin-top:6px; display:flex; flex-wrap:wrap; gap:4px 18px;">
            <span>Baseline: <strong>${monFmtNum(s.baseline)}</strong></span>
            <span>Previous: <strong>${s.previous ? monFmtNum(s.previous.value) + ' (' + esc(fmtDate(s.previous.date)) + ')' : '—'}</strong></span>
            <span>Δ previous: <strong>${monSigned(s.changePrev)}</strong></span>
            <span>Δ baseline: <strong>${monSigned(s.changeBase)}</strong></span>
          </div>
        </div>`).join('') || `<div style="margin-top:10px; color:${t.muted}; font-size:13px;">No parameters defined for this point. Use "Edit point" to add them.</div>`}
      <div style="margin-top:12px;"><label style="${monLabelStyle(t)}">Notes for this visit</label><textarea class="mon-vnote" rows="2" placeholder="Condition observed, changes since last visit…" style="${monInputStyle(t)} resize:vertical;">${esc(visit ? visit.note : '')}</textarea></div>
      <div style="margin-top:10px;">
        <label style="${monLabelStyle(t)}">Photos from this visit</label>
        <div style="font-size:12px; color:${t.muted}; margin:2px 0 6px;">Include a scale ruler in close-ups (CS 450 5.24).</div>
        <div class="mon-vphotos" style="display:grid; grid-template-columns:repeat(4,1fr); gap:8px;">${photos.map((ph) => `<div class="mon-vphoto" data-id="${ph.id}" style="position:relative; cursor:pointer;"><img src="${blobUrl(ph.annotatedBlob || ph.originalBlob)}" style="width:100%; height:80px; object-fit:cover; border-radius:6px;"><button class="mon-vphoto-del" data-id="${ph.id}" style="position:absolute; top:3px; right:3px; background:rgba(0,0,0,.6); color:#fff; border:none; border-radius:50%; width:22px; height:22px; font-size:12px;">✕</button></div>`).join('')}</div>
        <button class="mon-vphoto-add" style="${monBtnStyle(t)} margin-top:8px;">+ Add photo</button>
      </div>`;

    card.querySelector('.mon-edit-point').addEventListener('click', () => monRenderPointEditor(host, plan, insp, pointId, renderMain));
    summary.forEach((s, i) => {
      const valEl = card.querySelector(`.mon-val[data-i="${i}"]`), noteEl = card.querySelector(`.mon-rnote[data-i="${i}"]`);
      const commit = async () => {
        await DB.setMonitoringReading(plan.id, pointId, s.param.id, insp.id, visitDate, valEl.value, noteEl.value);
        await drawCard(card, pointId);
        await refreshBanner();
      };
      valEl.addEventListener('change', commit);
      noteEl.addEventListener('change', async () => { if (valEl.value !== '') await commit(); });
    });
    shellWireAutosaveField(card.querySelector('.mon-vnote'), (v) => DB.savePointVisit(plan.id, pointId, insp.id, visitDate, { note: v }));
    card.querySelector('.mon-vphoto-add').addEventListener('click', () => {
      openPhotoSourceSheet({ multiple: true, onFiles: async (files) => {
        await DB.savePointVisit(plan.id, pointId, insp.id, visitDate, {});
        await monAddPointImageFromFiles(files, pointId, insp.id, 'monitoringVisit', '');
        await drawCard(card, pointId);
      } });
    });
    card.querySelectorAll('.mon-vphoto').forEach((d) => d.addEventListener('click', (e) => {
      if (e.target.closest('.mon-vphoto-del')) return;
      openAnnotator(d.dataset.id, () => drawCard(card, pointId));
    }));
    card.querySelectorAll('.mon-vphoto-del').forEach((b) => b.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm('Delete this photo?')) return;
      await DB.delete('photos', b.dataset.id);
      await drawCard(card, pointId);
    }));
  }
  await renderMain();
}

// ---- History section editor ----
async function shellEditMonitoringHistorySection(body, section) {
  const t = SHELL_TOKENS;
  const { plan } = await monLoadPlanFor(shellState.selectedInspectionId);
  const points = await DB.listMonitoringPoints(plan.id);
  let filter = { pointIds: section.pointIds || null, from: section.dateFrom || '', to: section.dateTo || '' };
  const host = document.createElement('div');
  host.innerHTML = `
    <h2 style="font-size:20px; font-weight:700; margin:0 0 4px;">Monitoring history</h2>
    <p style="color:${t.muted}; font-size:13px; line-height:1.5; margin:0 0 16px; max-width:560px;">Prints the history of the chosen points: where each is, the master photo, the instructions, every reading with its status, notes and photos. Choose one point, several, or the whole structure, and optionally a date range.</p>
    <div id="mon-h-filter"></div>
    <div id="mon-h-summary" style="margin-top:14px; font-size:13px; color:${t.muted};"></div>
    <button id="mon-h-export" style="${monBtnStyle(t)} margin-top:14px;">Export this as a standalone PDF</button>`;
  body.appendChild(host);
  const summaryEl = host.querySelector('#mon-h-summary');
  const updateSummary = () => { summaryEl.textContent = points.length ? monFilterText(points, filter, fmtDate) : 'No monitoring points yet.'; };
  updateSummary();
  monRenderFilterControls(host.querySelector('#mon-h-filter'), points, filter, async (f) => {
    filter = f;
    section.pointIds = f.pointIds; section.dateFrom = f.from; section.dateTo = f.to;
    await DB.updateReportSection(section.id, { pointIds: f.pointIds, dateFrom: f.from, dateTo: f.to });
    updateSummary();
  });
  host.querySelector('#mon-h-export').addEventListener('click', async () => {
    if (!points.length) { toast('No monitoring points yet'); return; }
    toast('Building report…');
    try { await monExportHistoryPdf(plan.id, filter); } catch (err) { console.error(err); toast('Could not build the report'); }
  });
}

// ---- Continuous preview blocks ----
async function shellRenderMonitoringPreviewBlock(insp, section, heading) {
  const t = SHELL_TOKENS;
  const plan = insp.monitoringPlanId ? await DB.get('monitoringPlans', insp.monitoringPlanId) : null;
  if (!plan) return `${heading}<div style="color:${t.muted}; font-size:13.5px;">No monitoring plan yet — open this section to create it.</div>`;
  const points = await DB.listMonitoringPoints(plan.id);
  const readings = await DB.listMonitoringReadings(plan.id);
  const visits = await DB.listMonitoringVisits(plan.id);
  const th = (x, last) => `<th style="text-align:left; padding:5px ${last ? '0' : '6px'} 5px 0;">${x}</th>`;
  if (section.type === 'monitoringSpec') {
    const rows = [['Class', MON_CLASS_INFO[plan.monitoringClass || 1].label], ['Start', plan.startDate ? fmtDate(plan.startDate) : '—'], ['Planned end', plan.endDate ? fmtDate(plan.endDate) : '—'], ['Next review', plan.reviewDate ? fmtDate(plan.reviewDate) : '—']];
    return `${heading}<table style="font-size:13.5px; border-collapse:collapse; margin-bottom:10px;">${rows.map(([k, v]) => `<tr><td style="padding:3px 14px 3px 0; color:${t.muted};">${k}</td><td>${esc(v)}</td></tr>`).join('')}</table>
      ${plan.reason ? `<p style="font-size:14px;"><strong>Reason and assessment findings.</strong> ${esc(plan.reason)}</p>` : ''}
      ${plan.failureMode ? `<p style="font-size:14px;"><strong>Anticipated failure mode.</strong> ${esc(plan.failureMode)}</p>` : ''}
      ${points.length ? `<table style="width:100%; font-size:12.5px; border-collapse:collapse; font-family:-apple-system,sans-serif;"><tr style="border-bottom:1px solid ${t.line};">${th('Point')}${th('Type')}${th('Parameters (Amber / Red)', true)}</tr>
      ${points.map((p) => `<tr style="border-bottom:1px solid ${t.line}; vertical-align:top;"><td style="padding:5px 6px 5px 0;">${esc(monPointTitle(p))}</td><td style="padding:5px 6px 5px 0;">${esc(p.type)}</td><td style="padding:5px 0;">${(p.parameters || []).map((x) => esc(x.name) + (x.unit ? ' (' + esc(x.unit) + ')' : '') + ': ' + monFmtNum(monNum(x.amber)) + ' / ' + monFmtNum(monNum(x.red))).join('<br>') || '—'}</td></tr>`).join('')}</table>` : `<div style="color:${t.muted}; font-size:13.5px;">No monitoring points defined.</div>`}`;
  }
  if (section.type === 'monitoringReadings') {
    const lines = [];
    for (const p of points.filter((x) => x.status !== 'closed')) {
      for (const s of monBuildSummary(p, readings.filter((r) => r.pointId === p.id), insp.id)) {
        lines.push(`<tr style="border-bottom:1px solid ${t.line};"><td style="padding:5px 6px 5px 0;">${esc(monPointTitle(p))}</td><td style="padding:5px 6px 5px 0;">${esc(s.param.name)}${s.param.unit ? ' (' + esc(s.param.unit) + ')' : ''}</td><td style="padding:5px 6px 5px 0;">${s.previous ? monFmtNum(s.previous.value) : '—'}</td><td style="padding:5px 6px 5px 0;"><strong>${s.current ? monFmtNum(s.current.value) : '—'}</strong></td><td style="padding:5px 6px 5px 0;">${monSigned(s.changePrev)}</td><td style="padding:5px 0;">${monRagBadge(s.rag)}</td></tr>`);
      }
    }
    return `${heading}${lines.length ? `<table style="width:100%; font-size:12.5px; border-collapse:collapse; font-family:-apple-system,sans-serif;"><tr style="border-bottom:1px solid ${t.line};">${th('Point')}${th('Parameter')}${th('Previous')}${th('Current')}${th('Δ prev.')}${th('Status', true)}</tr>${lines.join('')}</table>` : `<div style="color:${t.muted}; font-size:13.5px;">No readings recorded yet.</div>`}`;
  }
  // monitoringHistory
  const sel = monSelectPoints(points, { pointIds: section.pointIds });
  const range = { from: section.dateFrom || '', to: section.dateTo || '' };
  const lines = sel.map((p) => {
    const h = monBuildPointHistory(p, readings.filter((r) => r.pointId === p.id), visits.filter((v) => v.pointId === p.id), range);
    const last = h.rows.length ? h.rows[h.rows.length - 1] : null;
    return `<tr style="border-bottom:1px solid ${t.line};"><td style="padding:5px 6px 5px 0;">${esc(monPointTitle(p))}</td><td style="padding:5px 6px 5px 0;">${h.rows.length} visit${h.rows.length === 1 ? '' : 's'}</td><td style="padding:5px 6px 5px 0;">${last ? esc(fmtDate(last.date)) : '—'}</td><td style="padding:5px 0;">${monRagBadge(last && last.rag)}</td></tr>`;
  });
  return `${heading}<div style="font-size:13px; color:${t.muted}; margin-bottom:8px;">${esc(monFilterText(points, { pointIds: section.pointIds, from: range.from, to: range.to }, fmtDate))}</div>${lines.length ? `<table style="width:100%; font-size:12.5px; border-collapse:collapse; font-family:-apple-system,sans-serif;"><tr style="border-bottom:1px solid ${t.line};">${th('Point')}${th('Records')}${th('Last visit')}${th('Latest status', true)}</tr>${lines.join('')}</table>` : `<div style="color:${t.muted}; font-size:13.5px;">No monitoring points yet.</div>`}`;
}

// ---------------------------------------------------------------------------------------------
// 3. Loading data for reports (images are scaled down so many photos stay within memory)
// ---------------------------------------------------------------------------------------------
async function monScaledImage(blob, maxDim, markOpts) {
  const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  const sw = bitmap.width, sh = bitmap.height;
  const k = Math.min(1, maxDim / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * k)), h = Math.max(1, Math.round(sh * k));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0, w, h);
  if (bitmap.close) bitmap.close();
  if (markOpts && markOpts.marks && markOpts.marks.length) {
    const { VW, prims } = monMarkPrims(markOpts.marks, w, h, { highlightId: markOpts.highlightId });
    monDrawPrims(ctx, prims, w / VW);
  }
  return { url: canvas.toDataURL('image/jpeg', 0.82), w, h };
}

async function monPhotoImage(photoId, maxDim) {
  if (!photoId) return null;
  const p = await DB.get('photos', photoId);
  if (!p) return null;
  try { return await monScaledImage(p.annotatedBlob || p.originalBlob, maxDim, null); } catch (e) { return null; }
}

// History data for a plan, filtered.
async function monLoadHistoryData(plan, filter) {
  const allPoints = await DB.listMonitoringPoints(plan.id);
  const visits = await DB.listMonitoringVisits(plan.id);
  const readings = await DB.listMonitoringReadings(plan.id);
  const views = await monLoadImageViews(plan.id);
  const selected = monSelectPoints(allPoints, filter);
  const out = [];
  for (const point of selected) {
    const h = monBuildPointHistory(point, readings.filter((r) => r.pointId === point.id), visits.filter((v) => v.pointId === point.id), { from: filter && filter.from, to: filter && filter.to });
    const view = point.imageId ? views[point.imageId] : null;
    let locImg = null;
    if (view) { try { locImg = await monScaledImage(view.blob, 1400, { marks: allPoints.filter((q) => q.imageId === view.rec.id).map(monMarkOf), highlightId: point.id }); } catch (e) { locImg = null; } }
    const masterImg = await monPhotoImage(point.masterPhotoId, 900);
    const allPhotos = await DB.listPointPhotos(point.id, 'monitoringVisit');
    for (const row of h.rows) {
      row.photos = [];
      for (const ph of allPhotos.filter((x) => x.inspectionId === row.inspectionId)) {
        try { row.photos.push({ img: await monScaledImage(ph.annotatedBlob || ph.originalBlob, 800, null), caption: ph.caption || '' }); } catch (e) { /* skip unreadable */ }
      }
    }
    out.push({ point, locImg, masterImg, rows: h.rows, baselines: h.baselines });
  }
  return { plan, allPoints, points: out, filter: filter || {} };
}

// Every location image with all of its points and areas marked (for the specification section).
async function monLoadImagesData(plan) {
  const points = await DB.listMonitoringPoints(plan.id);
  const views = await monLoadImageViews(plan.id);
  const out = [];
  for (const v of Object.values(views)) {
    const marks = points.filter((q) => q.imageId === v.rec.id).map(monMarkOf);
    if (!marks.some((m) => monMarkGeometry(m))) continue;
    try { out.push({ name: v.rec.name, img: await monScaledImage(v.blob, 1400, { marks, highlightId: null }) }); } catch (e) { /* skip */ }
  }
  return out;
}

// This visit: each active point with its summary, note and photos.
async function monLoadVisitData(plan, insp) {
  const points = (await DB.listMonitoringPoints(plan.id)).filter((p) => p.status !== 'closed');
  const readings = await DB.listMonitoringReadings(plan.id);
  const rows = [];
  for (const point of points) {
    const summary = monBuildSummary(point, readings.filter((r) => r.pointId === point.id), insp.id);
    const visit = await DB.getPointVisit(point.id, insp.id);
    const photos = [];
    for (const ph of await DB.listPointPhotos(point.id, 'monitoringVisit', insp.id)) {
      try { photos.push({ img: await monScaledImage(ph.annotatedBlob || ph.originalBlob, 800, null), caption: ph.caption || '' }); } catch (e) { /* skip */ }
    }
    rows.push({ point, summary, note: visit ? visit.note : '', photos });
  }
  return { rows };
}

// ---------------------------------------------------------------------------------------------
// 4. PDF drawing (called from pdf.js)
// ---------------------------------------------------------------------------------------------
function monPdfRoom(doc, y, need, { margin, pageH }) {
  if (y + need > pageH - margin) { doc.addPage(); return margin; }
  return y;
}

function monPdfLabelled(doc, label, text, y, opts) {
  const { margin, contentW } = opts;
  if (!text) return y;
  if (label) {
    y = monPdfRoom(doc, y, 30, opts);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(28, 31, 38);
    doc.text(label, margin, y);
    y += 13;
  }
  for (const line of doc.splitTextToSize(String(text), contentW)) {
    y = monPdfRoom(doc, y, 13, opts);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(28, 31, 38);
    doc.text(line, margin, y);
    y += 13;
  }
  return y + 8;
}

function monPdfSubheading(doc, text, y, opts) {
  y = monPdfRoom(doc, y, 40, opts);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(28, 31, 38);
  doc.text(text, opts.margin, y);
  return y + 14;
}

// A grid of small images with captions. items: [{ img:{url,w,h}, caption }]
function monPdfPhotoGrid(doc, items, y, opts, cols) {
  const { margin, contentW } = opts;
  const n = cols || 3, gap = 8;
  const cellW = (contentW - gap * (n - 1)) / n;
  const maxH = n <= 2 ? 230 : 150;
  for (let i = 0; i < items.length; i += n) {
    const rowItems = items.slice(i, i + n);
    const dims = rowItems.map((it) => { let w = cellW, h = (it.img.h / it.img.w) * w; if (h > maxH) { h = maxH; w = (it.img.w / it.img.h) * h; } return { w, h }; });
    const rowH = Math.max(...dims.map((d) => d.h)) + 14;
    y = monPdfRoom(doc, y, rowH, opts);
    rowItems.forEach((it, j) => {
      const x = margin + j * (cellW + gap) + (cellW - dims[j].w) / 2;
      doc.addImage(it.img.url, 'JPEG', x, y, dims[j].w, dims[j].h, undefined, 'FAST');
      if (it.caption) {
        doc.setFont('helvetica', 'italic'); doc.setFontSize(8); doc.setTextColor(91, 96, 105);
        doc.text(doc.splitTextToSize(it.caption, cellW)[0], margin + j * (cellW + gap) + cellW / 2, y + dims[j].h + 9, { align: 'center' });
      }
    });
    y += rowH + 4;
  }
  return y;
}

// A single image printed margin to margin (full printable width); height follows the aspect
// ratio and is capped so a tall image still fits on one page (then it is centred, narrower).
function monPdfFullWidth(doc, item, y, opts) {
  const { margin, contentW, pageH } = opts;
  const maxH = Math.min(560, pageH - margin * 2 - 24);
  let w = contentW, h = (item.img.h / item.img.w) * w;
  if (h > maxH) { h = maxH; w = (item.img.w / item.img.h) * h; }
  y = monPdfRoom(doc, y, h + 16, opts);
  doc.addImage(item.img.url, 'JPEG', margin + (contentW - w) / 2, y, w, h, undefined, 'FAST');
  if (item.caption) {
    doc.setFont('helvetica', 'italic'); doc.setFontSize(8.5); doc.setTextColor(91, 96, 105);
    doc.text(doc.splitTextToSize(item.caption, contentW)[0], margin + contentW / 2, y + h + 10, { align: 'center' });
  }
  return y + h + 22;
}

function drawMonitoringSpecPdf(doc, plan, points, y, opts, images) {
  const { margin } = opts;
  if (doc.autoTable) {
    doc.autoTable({
      startY: y, margin: { left: margin, right: margin }, theme: 'plain',
      styles: { font: 'helvetica', fontSize: 9.5, cellPadding: 3 },
      columnStyles: { 0: { cellWidth: 110, textColor: [110, 115, 125] } },
      body: [
        ['Monitoring class', MON_CLASS_INFO[plan.monitoringClass || 1].label],
        ['Start date', plan.startDate || '—'],
        ['Planned end date', plan.endDate || '—'],
        ['Next formal review', plan.reviewDate || '—']
      ]
    });
    y = doc.lastAutoTable.finalY + 12;
  }
  y = monPdfLabelled(doc, 'Reason for monitoring and assessment findings', plan.reason, y, opts);
  y = monPdfLabelled(doc, 'Anticipated failure mode(s)', plan.failureMode, y, opts);
  if (!points.length) return monPdfLabelled(doc, 'Monitoring points', 'No monitoring points have been defined.', y, opts);
  y = monPdfSubheading(doc, 'Monitoring points, parameters and trigger levels', y, opts);
  if (doc.autoTable) {
    doc.autoTable({
      startY: y - 6, margin: { left: margin, right: margin },
      head: [['Point', 'Instructions', 'Parameters and triggers']],
      body: points.map((p) => [
        monPointTitle(p) + '\n' + (p.shape === 'area' ? 'Area' : 'Point') + ' · ' + p.type + (p.status === 'closed' ? ' (closed)' : ''),
        [p.instrWhat && 'Monitoring: ' + p.instrWhat, p.instrMeasure && 'Measure: ' + p.instrMeasure, p.instrHow && 'How: ' + p.instrHow].filter(Boolean).join('\n') || '—',
        (p.parameters || []).map((x) => `${x.name || 'Parameter'}${x.unit ? ' (' + x.unit + ')' : ''}${x.accuracy ? ', ' + x.accuracy : ''}: ${x.basis === 'change' ? 'change from baseline' : 'value'}; Amber ${monFmtNum(monNum(x.amber))}, Red ${monFmtNum(monNum(x.red))}${x.action ? '\nAction: ' + x.action : ''}`).join('\n\n') || '—'
      ]),
      styles: { font: 'helvetica', fontSize: 8.5, cellPadding: 4, overflow: 'linebreak', valign: 'top' },
      headStyles: { fillColor: [28, 31, 38], textColor: 255 },
      columnStyles: { 0: { cellWidth: 95 } }
    });
    y = doc.lastAutoTable.finalY + 12;
  }
  if (images && images.length) {
    y = monPdfSubheading(doc, 'Location of monitoring points and areas', y, opts);
    images.forEach((i) => { y = monPdfFullWidth(doc, { img: i.img, caption: i.name }, y, opts); });
  }
  return y;
}

function drawMonitoringReadingsPdf(doc, visitData, y, opts) {
  const { margin } = opts;
  const dash = '—';
  const body = [];
  const ragByRow = [];
  visitData.rows.forEach((r) => {
    if (!r.summary.length) { body.push([monPointTitle(r.point), 'No parameters', dash, dash, dash, dash, dash, dash]); ragByRow.push(null); }
    r.summary.forEach((s) => {
      body.push([
        monPointTitle(r.point),
        (s.param.name || dash) + (s.param.unit ? ' (' + s.param.unit + ')' : ''),
        monFmtNum(s.baseline),
        s.previous ? monFmtNum(s.previous.value) : dash,
        s.current ? monFmtNum(s.current.value) : 'not read',
        monSigned(s.changePrev),
        monSigned(s.changeBase),
        s.rag ? MON_RAG_LABELS[s.rag] : dash
      ]);
      ragByRow.push(s.rag);
    });
  });
  if (doc.autoTable && body.length) {
    doc.autoTable({
      startY: y, margin: { left: margin, right: margin },
      head: [['Point', 'Parameter', 'Baseline', 'Previous', 'Current', 'Δ previous', 'Δ baseline', 'Status']],
      body,
      styles: { font: 'helvetica', fontSize: 8.5, cellPadding: 4 },
      headStyles: { fillColor: [28, 31, 38], textColor: 255 },
      didParseCell: (data) => {
        if (data.section === 'body' && data.column.index === 7 && ragByRow[data.row.index]) {
          data.cell.styles.fillColor = MON_RAG_COLOURS[ragByRow[data.row.index]];
          data.cell.styles.textColor = 255;
          data.cell.styles.fontStyle = 'bold';
        }
      }
    });
    y = doc.lastAutoTable.finalY + 14;
  } else if (!body.length) {
    y = monPdfLabelled(doc, 'Readings', 'No monitoring points have been recorded.', y, opts);
  }
  for (const r of visitData.rows) {
    if (!r.note && !r.photos.length) continue;
    y = monPdfSubheading(doc, monPointTitle(r.point), y, opts);
    y = monPdfLabelled(doc, 'Notes', r.note, y, opts);
    if (r.photos.length) y = monPdfPhotoGrid(doc, r.photos, y, opts, 3);
    y += 6;
  }
  return y;
}

// The history of the loaded points. Each point after the first starts on a new page.
function drawMonitoringHistoryPdf(doc, hData, y, opts) {
  const { margin } = opts;
  const dash = '—';
  hData.points.forEach((entry, idx) => {
    const { point, locImg, masterImg, rows } = entry;
    if (idx > 0) { doc.addPage(); y = margin; }
    y = monPdfRoom(doc, y, 120, opts);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(13); doc.setTextColor(28, 31, 38);
    doc.text(monPointTitle(point), margin, y);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); doc.setTextColor(91, 96, 105);
    doc.text(`${point.shape === 'area' ? 'Area' : 'Point'} · ${point.type}${point.status === 'closed' ? ' · closed' : ''}`, margin, y + 13);
    y += 28;

    if (locImg) y = monPdfFullWidth(doc, { img: locImg, caption: 'Location (' + monLabel(point) + ' highlighted)' }, y, opts);
    if (masterImg) y = monPdfPhotoGrid(doc, [{ img: masterImg, caption: 'Master photo' }], y, opts, 2);
    y = monPdfLabelled(doc, 'What is being monitored', point.instrWhat, y, opts);
    y = monPdfLabelled(doc, 'What to measure', point.instrMeasure, y, opts);
    y = monPdfLabelled(doc, 'How to measure it', point.instrHow, y, opts);

    const params = point.parameters || [];
    if (params.length && doc.autoTable) {
      y = monPdfSubheading(doc, 'Trigger levels', y, opts);
      doc.autoTable({
        startY: y - 6, margin: { left: margin, right: margin },
        head: [['Parameter', 'Basis', 'Baseline', 'Amber', 'Red', 'Action if triggered']],
        body: params.map((x) => [(x.name || dash) + (x.unit ? ' (' + x.unit + ')' : ''), x.basis === 'change' ? 'Change' : 'Value', monFmtNum(entry.baselines[x.id]), monFmtNum(monNum(x.amber)), monFmtNum(monNum(x.red)), x.action || dash]),
        styles: { font: 'helvetica', fontSize: 8.5, cellPadding: 3, overflow: 'linebreak' },
        headStyles: { fillColor: [70, 76, 90], textColor: 255 },
        columnStyles: { 5: { cellWidth: 170 } }
      });
      y = doc.lastAutoTable.finalY + 12;
    }

    y = monPdfSubheading(doc, 'History', y, opts);
    if (!rows.length) {
      y = monPdfLabelled(doc, '', 'No visit records in the selected period.', y, opts);
    } else if (doc.autoTable) {
      const rowRags = rows.map((r) => params.map((x) => (r.values[x.id] ? r.values[x.id].rag : null)));
      doc.autoTable({
        startY: y - 6, margin: { left: margin, right: margin },
        head: [['Date', ...params.map((x) => (x.name || 'Parameter') + (x.unit ? ' (' + x.unit + ')' : '')), 'Status', 'Notes']],
        body: rows.map((r) => [fmtDate(r.date), ...params.map((x) => (r.values[x.id] ? monFmtNum(r.values[x.id].value) : dash)), r.rag ? MON_RAG_LABELS[r.rag] : dash, r.note || '']),
        styles: { font: 'helvetica', fontSize: 8.5, cellPadding: 3, overflow: 'linebreak', valign: 'top' },
        headStyles: { fillColor: [28, 31, 38], textColor: 255 },
        didParseCell: (data) => {
          if (data.section !== 'body') return;
          const ci = data.column.index;
          if (ci >= 1 && ci <= params.length) {
            const rag = rowRags[data.row.index][ci - 1];
            if (rag && rag !== 'green') { data.cell.styles.textColor = MON_RAG_COLOURS[rag]; data.cell.styles.fontStyle = 'bold'; }
          } else if (ci === params.length + 1) {
            const rag = rows[data.row.index].rag;
            if (rag) { data.cell.styles.fillColor = MON_RAG_COLOURS[rag]; data.cell.styles.textColor = 255; data.cell.styles.fontStyle = 'bold'; }
          }
        }
      });
      y = doc.lastAutoTable.finalY + 12;
    }
    for (const r of rows) {
      if (!r.photos || !r.photos.length) continue;
      y = monPdfSubheading(doc, `Photos – ${fmtDate(r.date)}`, y, opts);
      y = monPdfPhotoGrid(doc, r.photos.map((p) => ({ img: p.img, caption: fmtDate(r.date) + (p.caption ? ' – ' + p.caption : '') })), y, opts, 3);
    }
  });
  return y;
}

async function monExportHistoryPdf(planId, filter) {
  if (!window.jspdf) { toast('PDF library not loaded — connect to the internet once, then try again'); return; }
  const plan = await DB.get('monitoringPlans', planId);
  if (!plan) { toast('Monitoring plan not found'); return; }
  const hData = await monLoadHistoryData(plan, filter);
  if (!hData.points.length) { toast('No monitoring points selected'); return; }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth(), pageH = doc.internal.pageSize.getHeight();
  const margin = 48, contentW = pageW - margin * 2;
  doc.setFont('helvetica', 'bold'); doc.setFontSize(20); doc.setTextColor(28, 31, 38);
  doc.text('Monitoring History', margin, margin + 10);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(11); doc.setTextColor(91, 96, 105);
  doc.text(plan.structureName || 'Structure', margin, margin + 30);
  const lines = doc.splitTextToSize(`${MON_CLASS_INFO[plan.monitoringClass || 1].label} · ${monFilterText(hData.allPoints, filter, fmtDate)}`, contentW);
  doc.text(lines, margin, margin + 46);
  const y0 = margin + 46 + lines.length * 13 + 14;
  drawMonitoringHistoryPdf(doc, hData, y0, { margin, contentW, pageH });
  const filename = `${(plan.structureName || 'monitoring').replace(/[^a-z0-9]+/gi, '_')}_monitoring_history_${monToday()}.pdf`;
  doc.save(filename);
  toast('Report saved');
}
