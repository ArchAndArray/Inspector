// pm.js — Project Management / Scheduling module.
//
// Build sequence agreed in roadmap.md 4.1:
//   1. Data model + plain editable WBS task table  <-- this file, first pass
//   2. Read-only Gantt render
//   3. CPM scheduling engine (pure, framework-free, unit-testable)
//   4. Drag interaction + undo/redo
//
// This pass deliberately does NOT auto-calculate dates from dependencies yet — start/finish
// are entered manually per task, same as the original Old Style report fields were before any
// engine existed. Dependencies (predecessor/successor + FS/SS/FF/SF + lag) are already storable
// via DB.createPMDependency so the schema doesn't need to change again in step 3, but nothing
// in the UI creates or reads them yet.
//
// Vanilla JS, no build step, reuses the app's existing shared helpers (el, esc, presentOverlay,
// navigate, fmtDate) and CSS classes (topbar/content/list-item/sheet/btn/fab/field/empty-state)
// rather than introducing a parallel visual language — this module is reached via a normal
// hash route (#/pm), same pattern as Scale/Annotate and PDF Editor, not the persistent shell.

let pmWorkspaceState = null; // { project, tasks, selectedTaskId } — in-memory, no hash change
// while inside a project workspace, matching the "don't reach for navigate() for internal
// state changes" convention established by shell.js.

async function renderPM() {
  const projects = await DB.listPMProjects();
  pmWorkspaceState = null;

  const rows = projects.map((p) => `
    <div class="list-item" data-id="${p.id}">
      <div class="meta">
        <h3>${esc(p.name)}</h3>
        <p>${esc(p.structureRef || 'No structure reference')}${p.client ? ' · ' + esc(p.client) : ''} · Starts ${fmtDate(p.startDate)}</p>
      </div>
      <span class="chevron">›</span>
    </div>
  `).join('');

  appEl.innerHTML = `
    <div class="topbar">
      <button class="icon-btn" id="btn-pm-back">‹</button>
      <div style="flex:1; min-width:0;">
        <h1>Project Management</h1>
        <span class="sub">WBS &amp; scheduling</span>
      </div>
    </div>
    <div class="content" id="pm-list-content">
      ${projects.length ? rows : `
        <div class="empty-state">
          <div class="glyph">＋</div>
          <h3>No projects yet</h3>
          <p>Create a project to start building a Work Breakdown Structure.</p>
        </div>
      `}
    </div>
    <button class="fab" id="btn-new-pm-project">＋</button>
  `;

  document.getElementById('btn-pm-back').addEventListener('click', () => navigate('#/'));
  document.getElementById('btn-new-pm-project').addEventListener('click', () => openNewPMProjectSheet(renderPM));
  appEl.querySelectorAll('#pm-list-content .list-item').forEach((row) => {
    row.addEventListener('click', () => renderPMWorkspace(row.dataset.id));
  });
}

// ---------- Global Resources directory ----------
// Resources are global (not per-project) — see db.js's note on deletePMResourceCascade for why:
// a named person/plant item is a real-world entity reused across projects, not duplicated per
// project. Reached via its own Launcher tile, same route pattern as the PM module itself.

const PM_RESOURCE_TYPES = [
  { value: 'person', label: 'Person' },
  { value: 'team', label: 'Team' },
  { value: 'plant', label: 'Plant' },
  { value: 'equipment', label: 'Equipment' },
  { value: 'contractor', label: 'Contractor' },
  { value: 'material', label: 'Material' }
];

async function renderPMResources() {
  const resources = await DB.listPMResources();
  const rows = resources.map((r) => {
    const typeLabel = (PM_RESOURCE_TYPES.find((t) => t.value === r.type) || {}).label || r.type;
    return `
      <div class="list-item" data-id="${r.id}">
        <div class="meta">
          <h3>${esc(r.name)}</h3>
          <p>${esc(typeLabel)}${r.role ? ' · ' + esc(r.role) : ''}${r.costRate != null ? ' · ' + r.costRate : ''}</p>
        </div>
        <span class="chevron">›</span>
      </div>
    `;
  }).join('');

  appEl.innerHTML = `
    <div class="topbar">
      <button class="icon-btn" id="btn-pm-resources-back">‹</button>
      <div style="flex:1; min-width:0;">
        <h1>Resources</h1>
        <span class="sub">People, plant &amp; equipment</span>
      </div>
    </div>
    <div class="content" id="pm-resources-content">
      ${resources.length ? rows : `
        <div class="empty-state">
          <div class="glyph">＋</div>
          <h3>No resources yet</h3>
          <p>Add people, plant, or equipment to assign them to tasks.</p>
        </div>
      `}
    </div>
    <button class="fab" id="btn-new-pm-resource">＋</button>
  `;

  document.getElementById('btn-pm-resources-back').addEventListener('click', () => navigate('#/'));
  document.getElementById('btn-new-pm-resource').addEventListener('click', () => openPMResourceSheet(null, renderPMResources));
  appEl.querySelectorAll('#pm-resources-content .list-item').forEach((row) => {
    const resource = resources.find((r) => r.id === row.dataset.id);
    row.addEventListener('click', () => openPMResourceSheet(resource, renderPMResources));
  });
}

function openPMResourceSheet(resource, onSaved) {
  const isNew = !resource;
  const typeOptionsHtml = PM_RESOURCE_TYPES.map((t) => `<option value="${t.value}" ${resource && resource.type === t.value ? 'selected' : ''}>${t.label}</option>`).join('');
  const sheet = el(`
    <div class="sheet-backdrop">
      <div class="sheet">
        <div class="sheet-handle"></div>
        <h2>${isNew ? 'New resource' : 'Edit resource'}</h2>
        <div class="field"><label>Name</label><input type="text" id="f-pmr-name" value="${resource ? esc(resource.name) : ''}" placeholder="e.g. O Richards"></div>
        <div class="field"><label>Type</label><select id="f-pmr-type">${typeOptionsHtml}</select></div>
        <div class="field"><label>Role</label><input type="text" id="f-pmr-role" value="${resource ? esc(resource.role || '') : ''}" placeholder="e.g. Principal Engineer"></div>
        <div class="field"><label>Cost rate</label><input type="number" min="0" step="0.01" id="f-pmr-costRate" value="${resource && resource.costRate != null ? resource.costRate : ''}" placeholder="Optional"></div>
        <div class="field"><label>Contact info</label><input type="text" id="f-pmr-contact" value="${resource ? esc(resource.contactInfo || '') : ''}" placeholder="Optional"></div>
        <div class="field"><label>Notes</label><textarea id="f-pmr-notes">${resource ? esc(resource.notes || '') : ''}</textarea></div>
        <button class="btn btn-primary btn-block" id="btn-pmr-save" style="margin-top:10px;">${isNew ? 'Add resource' : 'Save'}</button>
        ${isNew ? '' : '<button class="btn btn-danger btn-block" id="btn-pmr-delete" style="margin-top:10px;">Delete resource</button>'}
        <button class="btn btn-ghost btn-block" id="btn-pmr-cancel">Cancel</button>
      </div>
    </div>
  `);
  presentOverlay(sheet);
  sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.remove(); });
  sheet.querySelector('#btn-pmr-cancel').addEventListener('click', () => sheet.remove());
  sheet.querySelector('#btn-pmr-save').addEventListener('click', async () => {
    const name = sheet.querySelector('#f-pmr-name').value.trim();
    if (!name) { toast('Enter a resource name'); return; }
    const costRateVal = sheet.querySelector('#f-pmr-costRate').value;
    const patch = {
      name,
      type: sheet.querySelector('#f-pmr-type').value,
      role: sheet.querySelector('#f-pmr-role').value.trim(),
      costRate: costRateVal !== '' ? parseFloat(costRateVal) : null,
      contactInfo: sheet.querySelector('#f-pmr-contact').value.trim(),
      notes: sheet.querySelector('#f-pmr-notes').value.trim()
    };
    if (isNew) await DB.createPMResource(patch);
    else await DB.updatePMResource(resource.id, patch);
    sheet.remove();
    onSaved();
  });
  if (!isNew) {
    sheet.querySelector('#btn-pmr-delete').addEventListener('click', async () => {
      if (!confirm(`Delete "${resource.name}"? This removes it from every task it's assigned to, in every project.`)) return;
      await DB.deletePMResourceCascade(resource.id);
      sheet.remove();
      onSaved();
    });
  }
}


function openNewPMProjectSheet(onCreated) {
  const sheet = el(`
    <div class="sheet-backdrop">
      <div class="sheet">
        <div class="sheet-handle"></div>
        <h2>New project</h2>
        <div class="field"><label>Project name</label><input type="text" id="f-pm-name" placeholder="e.g. A487 Bridge Assessment"></div>
        <div class="field"><label>Structure reference</label><input type="text" id="f-pm-structureRef" placeholder="e.g. BR-0042"></div>
        <div class="field"><label>Client</label><input type="text" id="f-pm-client" placeholder="Optional"></div>
        <div class="field"><label>Start date</label><input type="date" id="f-pm-start"></div>
        <button class="btn btn-primary btn-block" id="btn-create-pm-project" style="margin-top:14px;">Create project</button>
        <button class="btn btn-ghost btn-block" id="btn-pm-cancel">Cancel</button>
      </div>
    </div>
  `);
  presentOverlay(sheet);
  sheet.querySelector('#f-pm-start').value = new Date().toISOString().slice(0, 10);
  sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.remove(); });
  sheet.querySelector('#btn-pm-cancel').addEventListener('click', () => sheet.remove());
  sheet.querySelector('#btn-create-pm-project').addEventListener('click', async () => {
    const name = sheet.querySelector('#f-pm-name').value.trim();
    if (!name) { toast('Enter a project name'); return; }
    await DB.createPMProject({
      name,
      structureRef: sheet.querySelector('#f-pm-structureRef').value.trim(),
      client: sheet.querySelector('#f-pm-client').value.trim(),
      startDate: sheet.querySelector('#f-pm-start').value
    });
    sheet.remove();
    if (onCreated) onCreated();
  });
}

// ---------- Project workspace: WBS task table ----------

async function renderPMWorkspace(projectId) {
  const project = await DB.get('pmProjects', projectId);
  if (!project) { renderPM(); return; }
  const tasks = await DB.listPMTasks(projectId);
  pmWorkspaceState = { project, tasks, selectedTaskId: null, undoStack: [], redoStack: [], collapsedColumns: pmWorkspaceState ? pmWorkspaceState.collapsedColumns : new Set() };
  drawPMWorkspace();
}

function pmTaskChildren(parentId) {
  return pmWorkspaceState.tasks
    .filter((t) => (t.parentId || null) === (parentId || null))
    .sort((a, b) => a.order - b.order);
}

// Summary (parent) tasks roll up from their descendants at render time — nothing is stored
// for this, so it can never drift out of sync with the leaf data underneath it.
function pmRollup(taskId) {
  const children = pmTaskChildren(taskId);
  if (children.length === 0) {
    const t = pmWorkspaceState.tasks.find((x) => x.id === taskId);
    return { start: t.start, finish: t.finish, duration: t.duration, percentComplete: t.percentComplete };
  }
  let start = null, finish = null, weightedPct = 0, totalDuration = 0;
  for (const c of children) {
    const r = pmRollup(c.id);
    if (r.start && (!start || r.start < start)) start = r.start;
    if (r.finish && (!finish || r.finish > finish)) finish = r.finish;
    const dur = r.duration || 0;
    weightedPct += (r.percentComplete || 0) * dur;
    totalDuration += dur;
  }
  return {
    start, finish,
    duration: totalDuration,
    percentComplete: totalDuration > 0 ? Math.round(weightedPct / totalDuration) : 0
  };
}

function pmBuildRows(parentId, depth, wbsPrefix, out) {
  const children = pmTaskChildren(parentId);
  children.forEach((task, i) => {
    const wbs = wbsPrefix ? `${wbsPrefix}.${i + 1}` : `${i + 1}`;
    const hasChildren = pmTaskChildren(task.id).length > 0;
    const eff = hasChildren ? pmRollup(task.id) : task;
    out.push({ task, depth, wbs, hasChildren, eff });
    pmBuildRows(task.id, depth + 1, wbs, out);
  });
}

// ---------- Gantt (Step 2 — read-only render, no drag/resize/zoom yet) ----------
// Date parsing/formatting lives in pmdate.js (pmParseISODate/pmFormatISODate/pmDaysBetween) —
// shared with pmschedule.js so the CPM engine can never drift from what the table/Gantt use.
const PM_GANTT_ROW_H = 44; // must match .pm-row / .pm-gantt-row height in styles.css
const PM_GANTT_PX_PER_DAY = 20;

// Column widths for the task table (Phase 2: collapsible columns). WBS and Name are always
// full width — only Duration/Start/Finish/%Complete can be tapped to collapse, per the user's
// explicit request. Collapsing frees width from the TABLE itself (not given to the Name
// column), which lets .pm-gantt-chart's flex:1 automatically expand into the freed space —
// there's no separate "resize the gantt" step, it's the same flex layout reacting to a smaller
// sibling, same principle as the table/gantt split itself.
const PM_COL_WIDTHS = { wbs: 52, name: 150, duration: 64, start: 82, finish: 82, pct: 56 };
const PM_COL_COLLAPSED_WIDTH = 28;
const PM_TABLE_ROW_PADDING = 32; // .pm-row's 16px left+right padding

function pmColWidth(col) {
  return pmWorkspaceState.collapsedColumns.has(col) ? PM_COL_COLLAPSED_WIDTH : PM_COL_WIDTHS[col];
}
function pmTableTotalWidth() {
  return PM_COL_WIDTHS.wbs + PM_COL_WIDTHS.name + pmColWidth('duration') + pmColWidth('start') + pmColWidth('finish') + pmColWidth('pct') + PM_TABLE_ROW_PADDING;
}

function pmFormatDayTick(ms) {
  const d = new Date(ms);
  return `${d.getUTCDate()} ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getUTCMonth()]}`;
}

function pmComputeGanttRange(rows) {
  let minMs = null, maxMs = null;
  rows.forEach(({ eff }) => {
    const s = pmParseISODate(eff.start);
    const f = pmParseISODate(eff.finish || eff.start);
    if (s != null && (minMs == null || s < minMs)) minMs = s;
    if (f != null && (maxMs == null || f > maxMs)) maxMs = f;
  });
  if (minMs == null) {
    // No dated tasks yet — show a plain 21-day window from the project start so the chart
    // isn't just blank.
    minMs = pmParseISODate(pmWorkspaceState.project.startDate) || Date.now();
    maxMs = minMs + 21 * 86400000;
  }
  // Padding either side so bars at the very edges aren't flush against the chart border.
  minMs -= 2 * 86400000;
  maxMs += 3 * 86400000;
  return { minMs, maxMs };
}

function pmGanttHeaderHtml(minMs, totalDays) {
  const ticks = [];
  for (let i = 0; i < totalDays; i++) {
    const dayMs = minMs + i * 86400000;
    const d = new Date(dayMs);
    if (d.getUTCDay() === 1) { // Monday — one label per week keeps it readable at this scale
      ticks.push(`<div style="position:absolute; left:${i * PM_GANTT_PX_PER_DAY}px; top:0; bottom:0; border-left:1px solid var(--line); padding-left:4px; font-size:10.5px; color:var(--ink-soft); display:flex; align-items:center;">${pmFormatDayTick(dayMs)}</div>`);
    }
  }
  return `<div class="pm-gantt-header pm-gantt-row" style="width:${totalDays * PM_GANTT_PX_PER_DAY}px;">${ticks.join('')}</div>`;
}

function pmGanttRowHtml(row, minMs, totalDays) {
  const { task, eff, hasChildren } = row;
  const width = totalDays * PM_GANTT_PX_PER_DAY;
  let barHtml = '';
  const s = pmParseISODate(eff.start);
  const f = pmParseISODate(eff.finish || eff.start);
  const draggable = !hasChildren; // summary bars are computed rollups, not independently dated

  if (s != null && f != null) {
    const left = pmDaysBetween(minMs, s) * PM_GANTT_PX_PER_DAY;
    if (task.isMilestone) {
      // Hit area is wider than the visual diamond so it's a comfortable touch target — the
      // 20x20 diamond alone is well under Apple's 44pt minimum tap-target guidance.
      barHtml = draggable ? `
        <div class="pm-gantt-hit pm-gantt-hit-milestone" data-task-id="${task.id}" style="left:${left - 15}px; width:30px;">
          <div class="pm-gantt-milestone" style="left:5px;" title="${esc(task.name)}"></div>
        </div>` : `<div class="pm-gantt-milestone" style="left:${left}px;" title="${esc(task.name)}"></div>`;
    } else {
      const spanDays = Math.max(1, pmDaysBetween(s, f) + 1);
      const barWidth = Math.max(6, spanDays * PM_GANTT_PX_PER_DAY - 2);
      const pct = Math.min(100, Math.max(0, eff.percentComplete || 0));
      // Resize handles only appear once the bar is wide enough to still leave a usable middle
      // "move" zone — below that, dragging still works (move only), and precise duration
      // changes go through the task sheet instead, same fallback the table already offers.
      const showHandles = draggable && barWidth >= 34;
      const handleW = showHandles ? Math.round(Math.min(16, Math.max(10, barWidth * 0.28))) : 0;
      barHtml = `
        <div class="pm-gantt-hit${draggable ? ' pm-gantt-hit-draggable' : ''}" ${draggable ? `data-task-id="${task.id}"` : ''} style="left:${left}px; width:${barWidth}px;">
          <div class="pm-gantt-bar${hasChildren ? ' pm-gantt-bar-summary' : ''}" title="${esc(task.name)} — ${pct}%">
            ${hasChildren ? '' : `<div class="pm-gantt-bar-progress" style="width:${pct}%;"></div>`}
          </div>
          ${showHandles ? `<div class="pm-gantt-handle pm-gantt-handle-left" style="width:${handleW}px;"></div><div class="pm-gantt-handle pm-gantt-handle-right" style="width:${handleW}px;"></div>` : ''}
        </div>
      `;
    }
  }
  return `<div class="pm-gantt-row" style="width:${width}px;">${barHtml}</div>`;
}

function pmGanttChartHtml(rows) {
  if (!rows.length) return '';
  const { minMs, maxMs } = pmComputeGanttRange(rows);
  const totalDays = Math.max(1, pmDaysBetween(minMs, maxMs));
  const todayMs = pmParseISODate(new Date().toISOString());
  const headerHtml = pmGanttHeaderHtml(minMs, totalDays);
  const rowsHtml = rows.map((row) => pmGanttRowHtml(row, minMs, totalDays)).join('');
  const totalHeight = PM_GANTT_ROW_H + rows.length * PM_GANTT_ROW_H;

  const cal = pmEffectiveCalendar();
  let shadingHtml = '';
  for (let i = 0; i < totalDays; i++) {
    const dayMs = minMs + i * 86400000;
    if (!PMCalendar.isWorkingDay(dayMs, cal)) {
      shadingHtml += `<div class="pm-gantt-nonworking" style="left:${i * PM_GANTT_PX_PER_DAY}px; width:${PM_GANTT_PX_PER_DAY}px; height:${totalHeight}px;"></div>`;
    }
  }

  let todayLineHtml = '';
  if (todayMs >= minMs && todayMs <= maxMs) {
    const left = pmDaysBetween(minMs, todayMs) * PM_GANTT_PX_PER_DAY;
    todayLineHtml = `<div class="pm-gantt-today" style="left:${left}px; height:${totalHeight}px;"></div>`;
  }

  return `
    <div class="pm-gantt-chart">
      <div style="position:relative; width:${totalDays * PM_GANTT_PX_PER_DAY}px;">
        ${shadingHtml}
        ${headerHtml}
        ${rowsHtml}
        ${todayLineHtml}
      </div>
    </div>
  `;
}

// ---------- Gantt drag/resize (Step 4) ----------
// Wired after every render, since drawPMWorkspace rebuilds the whole DOM each time. Live
// feedback during drag is done with direct style/transform writes on the dragged element (not
// a full re-render per pointermove — that would be far too slow to feel responsive), and a
// small floating label showing the tentative date, matching the app's existing pattern of
// giving precise visual feedback during touch-driven placement (the annotator's magnifier is
// the closest precedent). The actual commit — validation, persistence, cascade, undo — only
// happens once, on release, via the same pmCommitTaskDates() the task sheet uses.
function pmWireGanttDrag() {
  const chart = document.querySelector('.pm-gantt-chart');
  if (!chart) return;
  chart.querySelectorAll('.pm-gantt-hit-draggable, .pm-gantt-hit-milestone').forEach((hitEl) => {
    hitEl.addEventListener('pointerdown', (e) => pmStartGanttDrag(e, hitEl));
  });
}

function pmStartGanttDrag(downEvent, hitEl) {
  const taskId = hitEl.dataset.taskId;
  const task = pmWorkspaceState.tasks.find((t) => t.id === taskId);
  if (!task) return;
  downEvent.preventDefault();
  hitEl.setPointerCapture(downEvent.pointerId);

  let mode = 'move';
  if (downEvent.target.classList.contains('pm-gantt-handle-left')) mode = 'resize-left';
  else if (downEvent.target.classList.contains('pm-gantt-handle-right')) mode = 'resize-right';

  const startX = downEvent.clientX;
  const origStartMs = pmParseISODate(task.start);
  const origFinishMs = pmParseISODate(task.finish || task.start);
  const origLeft = parseFloat(hitEl.style.left);
  const origWidth = parseFloat(hitEl.style.width);

  const label = el(`<div class="pm-gantt-drag-label"></div>`);
  document.body.appendChild(label);
  function showLabel(text, clientX, clientY) {
    label.textContent = text;
    label.style.left = clientX + 'px';
    label.style.top = Math.max(8, clientY - 42) + 'px';
  }

  function dayDelta(ev) { return Math.round((ev.clientX - startX) / PM_GANTT_PX_PER_DAY); }

  function onMove(ev) {
    const deltaDays = dayDelta(ev);
    if (mode === 'move') {
      hitEl.style.left = (origLeft + deltaDays * PM_GANTT_PX_PER_DAY) + 'px';
      showLabel(fmtDate(pmFormatISODate(origStartMs + deltaDays * 86400000)), ev.clientX, ev.clientY);
    } else if (mode === 'resize-right') {
      const newWidthPx = Math.max(PM_GANTT_PX_PER_DAY, origWidth + deltaDays * PM_GANTT_PX_PER_DAY);
      hitEl.style.width = newWidthPx + 'px';
      const newFinishMs = origStartMs + (Math.round(newWidthPx / PM_GANTT_PX_PER_DAY) - 1) * 86400000;
      showLabel('Finish: ' + fmtDate(pmFormatISODate(newFinishMs)), ev.clientX, ev.clientY);
    } else if (mode === 'resize-left') {
      const newWidthPx = Math.max(PM_GANTT_PX_PER_DAY, origWidth - deltaDays * PM_GANTT_PX_PER_DAY);
      hitEl.style.left = (origLeft + (origWidth - newWidthPx)) + 'px';
      hitEl.style.width = newWidthPx + 'px';
      const newStartMs = origFinishMs - (Math.round(newWidthPx / PM_GANTT_PX_PER_DAY) - 1) * 86400000;
      showLabel('Start: ' + fmtDate(pmFormatISODate(newStartMs)), ev.clientX, ev.clientY);
    }
  }

  function cleanup() {
    hitEl.removeEventListener('pointermove', onMove);
    hitEl.removeEventListener('pointerup', onUp);
    hitEl.removeEventListener('pointercancel', onCancel);
    label.remove();
  }

  async function onUp(ev) {
    const deltaDays = dayDelta(ev);
    cleanup();
    if (deltaDays === 0) { drawPMWorkspace(); return; }

    let patch = null;
    if (mode === 'move') {
      const newStartMs = origStartMs + deltaDays * 86400000;
      const newFinishMs = task.isMilestone ? newStartMs : newStartMs + (origFinishMs - origStartMs);
      patch = { start: pmFormatISODate(newStartMs), finish: pmFormatISODate(newFinishMs) };
    } else if (mode === 'resize-right') {
      let newFinishMs = Math.max(origStartMs, origFinishMs + deltaDays * 86400000);
      patch = { finish: pmFormatISODate(newFinishMs), duration: pmDaysBetween(origStartMs, newFinishMs) + 1 };
    } else if (mode === 'resize-left') {
      let newStartMs = Math.min(origFinishMs, origStartMs + deltaDays * 86400000);
      patch = { start: pmFormatISODate(newStartMs), duration: pmDaysBetween(newStartMs, origFinishMs) + 1 };
    }

    const result = await pmCommitTaskDates(taskId, patch);
    if (!result.ok) { toast(result.error); drawPMWorkspace(); return; }
    pmReportMoved(result.movedOthers);
    drawPMWorkspace();
  }

  function onCancel() { cleanup(); drawPMWorkspace(); }

  hitEl.addEventListener('pointermove', onMove);
  hitEl.addEventListener('pointerup', onUp);
  hitEl.addEventListener('pointercancel', onCancel);
}

function drawPMWorkspace() {
  const { project, selectedTaskId } = pmWorkspaceState;
  const rows = [];
  pmBuildRows(null, 0, '', rows);

  const durW = pmColWidth('duration'), startW = pmColWidth('start'), finishW = pmColWidth('finish'), pctW = pmColWidth('pct');
  const durCollapsed = pmWorkspaceState.collapsedColumns.has('duration');
  const startCollapsed = pmWorkspaceState.collapsedColumns.has('start');
  const finishCollapsed = pmWorkspaceState.collapsedColumns.has('finish');
  const pctCollapsed = pmWorkspaceState.collapsedColumns.has('pct');

  const rowsHtml = rows.map(({ task, depth, wbs, hasChildren, eff }) => {
    const r = eff;
    const selected = task.id === selectedTaskId;
    return `
      <div class="pm-row${selected ? ' pm-row-selected' : ''}${hasChildren ? ' pm-row-summary' : ''}" data-id="${task.id}">
        <div class="pm-cell pm-cell-wbs">${wbs}</div>
        <div class="pm-cell pm-cell-name" style="width:${PM_COL_WIDTHS.name}px; padding-left:${depth * 20}px;">
          ${task.isMilestone ? '<span class="pm-milestone-diamond">◆</span>' : ''}${esc(task.name)}
        </div>
        <div class="pm-cell pm-cell-dur" style="width:${durW}px;">${durCollapsed ? '' : (task.isMilestone ? '—' : (r.duration || 0) + 'd')}</div>
        <div class="pm-cell pm-cell-date" style="width:${startW}px;">${startCollapsed ? '' : (r.start ? fmtDate(r.start) : '—')}</div>
        <div class="pm-cell pm-cell-date" style="width:${finishW}px;">${finishCollapsed ? '' : (r.finish ? fmtDate(r.finish) : '—')}</div>
        <div class="pm-cell pm-cell-pct" style="width:${pctW}px;">${pctCollapsed ? '' : (r.percentComplete || 0) + '%'}</div>
      </div>
    `;
  }).join('');

  const ganttHtml = pmGanttChartHtml(rows);

  appEl.innerHTML = `
    <div class="topbar">
      <button class="icon-btn" id="btn-pm-workspace-back">‹</button>
      <div style="flex:1; min-width:0;">
        <h1>${esc(project.name)}</h1>
        <span class="sub">${esc(project.structureRef || 'Project Management')}</span>
      </div>
      <button class="text-btn" id="btn-pm-workload">Workload</button>
      <button class="text-btn" id="btn-pm-project-info">Info</button>
    </div>
    <div class="content" id="pm-table-content" style="padding:0;">
      <div class="pm-split-wrap">
        <div class="pm-table" style="width:${pmTableTotalWidth()}px;">
          <div class="pm-row pm-row-header">
            <div class="pm-cell pm-cell-wbs">WBS</div>
            <div class="pm-cell pm-cell-name" style="width:${PM_COL_WIDTHS.name}px;">Task</div>
            <div class="pm-cell pm-cell-dur pm-col-toggle" data-col="duration" style="width:${durW}px;">${durCollapsed ? 'D' : 'Duration'}</div>
            <div class="pm-cell pm-cell-date pm-col-toggle" data-col="start" style="width:${startW}px;">${startCollapsed ? 'S' : 'Start'}</div>
            <div class="pm-cell pm-cell-date pm-col-toggle" data-col="finish" style="width:${finishW}px;">${finishCollapsed ? 'F' : 'Finish'}</div>
            <div class="pm-cell pm-cell-pct pm-col-toggle" data-col="pct" style="width:${pctW}px;">%</div>
          </div>
          ${rows.length ? rowsHtml : `
            <div class="empty-state">
              <div class="glyph">＋</div>
              <h3>No tasks yet</h3>
              <p>Add the first task to start the WBS.</p>
            </div>
          `}
        </div>
        ${ganttHtml}
      </div>
    </div>
    <div class="pm-toolbar">
      <button class="btn btn-secondary" id="btn-pm-add-task">+ Task</button>
      <button class="btn btn-secondary" id="btn-pm-add-subtask" ${selectedTaskId ? '' : 'disabled'}>+ Subtask</button>
      <button class="btn btn-secondary" id="btn-pm-indent" ${selectedTaskId ? '' : 'disabled'}>Indent</button>
      <button class="btn btn-secondary" id="btn-pm-outdent" ${selectedTaskId ? '' : 'disabled'}>Outdent</button>
      <button class="btn btn-secondary" id="btn-pm-undo" ${pmWorkspaceState.undoStack.length ? '' : 'disabled'}>↶ Undo</button>
      <button class="btn btn-secondary" id="btn-pm-redo" ${pmWorkspaceState.redoStack.length ? '' : 'disabled'}>↷ Redo</button>
      <button class="btn btn-danger" id="btn-pm-delete" ${selectedTaskId ? '' : 'disabled'}>Delete</button>
    </div>
  `;

  document.getElementById('btn-pm-workspace-back').addEventListener('click', renderPM);
  document.getElementById('btn-pm-workload').addEventListener('click', () => renderPMWorkload());
  document.getElementById('btn-pm-project-info').addEventListener('click', () => openEditPMProjectSheet());
  document.getElementById('btn-pm-add-task').addEventListener('click', () => addPMTaskAndEdit(null));
  document.getElementById('btn-pm-add-subtask').addEventListener('click', () => {
    if (pmWorkspaceState.selectedTaskId) addPMTaskAndEdit(pmWorkspaceState.selectedTaskId);
  });
  document.getElementById('btn-pm-indent').addEventListener('click', pmIndentSelected);
  document.getElementById('btn-pm-outdent').addEventListener('click', pmOutdentSelected);
  document.getElementById('btn-pm-undo').addEventListener('click', pmUndo);
  document.getElementById('btn-pm-redo').addEventListener('click', pmRedo);
  document.getElementById('btn-pm-delete').addEventListener('click', pmDeleteSelected);

  appEl.querySelectorAll('.pm-row[data-id]').forEach((rowEl) => {
    rowEl.addEventListener('click', () => {
      const id = rowEl.dataset.id;
      if (pmWorkspaceState.selectedTaskId === id) {
        openPMTaskSheet(pmWorkspaceState.tasks.find((t) => t.id === id));
      } else {
        pmWorkspaceState.selectedTaskId = id;
        drawPMWorkspace();
      }
    });
  });

  pmWireGanttDrag();

  appEl.querySelectorAll('.pm-col-toggle').forEach((headerEl) => {
    headerEl.addEventListener('click', () => {
      const col = headerEl.dataset.col;
      if (pmWorkspaceState.collapsedColumns.has(col)) pmWorkspaceState.collapsedColumns.delete(col);
      else pmWorkspaceState.collapsedColumns.add(col);
      drawPMWorkspace();
    });
  });
}

async function pmRefreshTasks() {
  pmWorkspaceState.tasks = await DB.listPMTasks(pmWorkspaceState.project.id);
}

const pmDateFns = { parse: pmParseISODate, format: pmFormatISODate };

function pmLeafTasks() {
  return pmWorkspaceState.tasks.filter((t) => pmTaskChildren(t.id).length === 0);
}

// A project created before calendars existed simply won't have this field — treated as the
// same Mon-Fri default at read time rather than requiring any data migration. Also defensively
// backfills hoursPerDay for projects created after calendars existed but before hoursPerDay was
// added to them — same "no migration needed" principle applied twice now.
function pmEffectiveCalendar() {
  const cal = pmWorkspaceState.project.calendar || PMCalendar.DEFAULT;
  return {
    workingWeekdays: cal.workingWeekdays || PMCalendar.DEFAULT.workingWeekdays,
    holidays: cal.holidays || [],
    hoursPerDay: cal.hoursPerDay != null ? cal.hoursPerDay : PMCalendar.DEFAULT.hoursPerDay
  };
}

// A task's own hours-per-day override (e.g. a 12-hour night-shift task) takes precedence;
// otherwise falls back to the project calendar's default. Per the user's explicit decision,
// this is a TASK-level setting, uniform for every resource assigned to it — not something that
// varies per resource on the same task.
function pmEffectiveHoursPerDay(task) {
  return task.hoursPerDayOverride != null ? task.hoursPerDayOverride : pmEffectiveCalendar().hoursPerDay;
}

function pmExplainValidationFailure(check) {
  if (check.reason === 'non-working-day') {
    return `That date isn't a working day on this project's calendar — try ${fmtDate(check.minStart)} or later`;
  }
  return `Can't start before ${fmtDate(check.minStart)} — blocked by "${check.blockedBy}"`;
}

// ---------- Schedule-change undo/redo (Step 4) ----------
// Scoped deliberately to DATE changes only (manual sheet edits, drag, resize) — not dependency
// create/remove, and not structural WBS edits (indent/outdent/add/delete). Those remain
// non-undoable for now; extending undo to cover them is real future scope, not silently implied
// by this being called "undo/redo". Every entry here represents ONE user-initiated action,
// covering every task it moved — the directly-edited task AND anything the forward-pass
// cascade moved as a result — so undo reverts the whole thing atomically, never leaving
// cascaded tasks stranded at now-unjustified positions.
function pmPushUndoEntry(entry) {
  if (!entry.length) return;
  pmWorkspaceState.undoStack.push(entry);
  pmWorkspaceState.redoStack = []; // a new action invalidates any redo history, standard behavior
}

async function pmUndo() {
  if (!pmWorkspaceState.undoStack.length) { toast('Nothing to undo'); return; }
  const entry = pmWorkspaceState.undoStack.pop();
  for (const c of entry) await DB.updatePMTask(c.id, { start: c.before.start, finish: c.before.finish });
  pmWorkspaceState.redoStack.push(entry);
  await pmRefreshTasks();
  drawPMWorkspace();
}

async function pmRedo() {
  if (!pmWorkspaceState.redoStack.length) { toast('Nothing to redo'); return; }
  const entry = pmWorkspaceState.redoStack.pop();
  for (const c of entry) await DB.updatePMTask(c.id, { start: c.after.start, finish: c.after.finish });
  pmWorkspaceState.undoStack.push(entry);
  await pmRefreshTasks();
  drawPMWorkspace();
}

// The single path every date-changing interaction (sheet save, drag, resize) goes through.
// Persists the full patch for the primary task (start/finish plus whatever else changed, e.g.
// name/duration/%complete from the sheet), runs the CPM forward pass, persists whatever it
// cascaded, and records ONE atomic undo entry. The undo entry only tracks start/finish —
// undo is scoped to date changes, not a general "revert this task edit" — see the note above
// pmPushUndoEntry.
// primaryPatch: any subset of task fields, but MUST include start/finish if either changed,
// since those are what the forward pass and validation key off.
async function pmCommitTaskDates(taskId, primaryPatch) {
  const leaf = pmLeafTasks();
  const deps = await DB.listPMDependencies(pmWorkspaceState.project.id);
  const primaryTask = leaf.find((t) => t.id === taskId);
  if (!primaryTask) return { ok: false, error: 'Task not found' };

  const startChanged = primaryPatch.start !== undefined && primaryPatch.start !== primaryTask.start;
  if (startChanged && primaryPatch.start) {
    const check = PMSchedule.validateManualStart(taskId, primaryPatch.start, leaf, deps, pmDateFns, pmEffectiveCalendar());
    if (!check.ok) {
      return { ok: false, error: pmExplainValidationFailure(check) };
    }
  }

  const beforeSnapshot = new Map(leaf.map((t) => [t.id, { start: t.start, finish: t.finish }]));
  const primaryBefore = beforeSnapshot.get(taskId);
  const primaryAfter = {
    start: primaryPatch.start !== undefined ? primaryPatch.start : primaryTask.start,
    finish: primaryPatch.finish !== undefined ? primaryPatch.finish : primaryTask.finish
  };

  await DB.updatePMTask(taskId, primaryPatch);

  const updatedLeaf = leaf.map((t) => (t.id === taskId ? { ...t, ...primaryPatch } : t));
  const cascaded = PMSchedule.computeForwardPass(updatedLeaf, deps, pmDateFns, pmEffectiveCalendar());
  for (const c of cascaded) await DB.updatePMTask(c.id, { start: c.start, finish: c.finish });

  const entryMap = new Map();
  if (primaryAfter.start !== primaryBefore.start || primaryAfter.finish !== primaryBefore.finish) {
    entryMap.set(taskId, { id: taskId, before: primaryBefore, after: primaryAfter });
  }
  for (const c of cascaded) {
    if (c.id === taskId) continue;
    entryMap.set(c.id, { id: c.id, before: beforeSnapshot.get(c.id), after: { start: c.start, finish: c.finish } });
  }
  pmPushUndoEntry(Array.from(entryMap.values()));

  await pmRefreshTasks();
  const movedOthers = cascaded.filter((c) => c.id !== taskId).map((c) => ({ id: c.id, name: (leaf.find((t) => t.id === c.id) || {}).name || '' }));
  return { ok: true, movedOthers };
}

function pmReportMoved(movedOthers) {
  if (movedOthers.length) toast(`Also moved: ${movedOthers.map((m) => m.name).join(', ')}`);
}

async function addPMTaskAndEdit(parentId) {
  const task = await DB.createPMTask(pmWorkspaceState.project.id, {
    parentId,
    name: 'New Task',
    duration: 1,
    start: pmWorkspaceState.project.startDate,
    finish: pmWorkspaceState.project.startDate
  });
  await pmRefreshTasks();
  pmWorkspaceState.selectedTaskId = task.id;
  drawPMWorkspace();
  openPMTaskSheet(task);
}

async function pmIndentSelected() {
  const id = pmWorkspaceState.selectedTaskId;
  const task = pmWorkspaceState.tasks.find((t) => t.id === id);
  if (!task) return;
  const siblings = pmTaskChildren(task.parentId).filter((t) => t.id !== id);
  const idx = pmTaskChildren(task.parentId).findIndex((t) => t.id === id);
  if (idx <= 0) { toast('No earlier sibling to nest under'); return; }
  const newParent = pmTaskChildren(task.parentId)[idx - 1];
  const newSiblingCount = pmTaskChildren(newParent.id).length;
  try {
    await DB.movePMTask(id, newParent.id, newSiblingCount);
  } catch (err) {
    toast(err.message);
    return;
  }
  await pmRefreshTasks();
  drawPMWorkspace();
}

async function pmOutdentSelected() {
  const id = pmWorkspaceState.selectedTaskId;
  const task = pmWorkspaceState.tasks.find((t) => t.id === id);
  if (!task || !task.parentId) { toast('Already at the top level'); return; }
  const parent = pmWorkspaceState.tasks.find((t) => t.id === task.parentId);
  const newSiblingCount = pmTaskChildren(parent ? parent.parentId : null).length;
  await DB.movePMTask(id, parent ? parent.parentId : null, newSiblingCount);
  await pmRefreshTasks();
  drawPMWorkspace();
}

async function pmDeleteSelected() {
  const id = pmWorkspaceState.selectedTaskId;
  if (!id) return;
  const task = pmWorkspaceState.tasks.find((t) => t.id === id);
  const hasChildren = pmTaskChildren(id).length > 0;
  if (!confirm(hasChildren ? `Delete "${task.name}" and all its subtasks?` : `Delete "${task.name}"?`)) return;
  await DB.deletePMTaskCascade(id);
  pmWorkspaceState.selectedTaskId = null;
  await pmRefreshTasks();
  drawPMWorkspace();
}

// Dependency add/remove aren't part of the date-change undo system (see the note above
// pmPushUndoEntry) — but adding a dependency can still push tasks later via cascade, so that
// still needs to run. Removing one never does (the forward pass only ever adds constraints
// forward, so relaxing one can't require moving anything).
async function pmRecomputeAfterDependencyChange() {
  const leaf = pmLeafTasks();
  const deps = await DB.listPMDependencies(pmWorkspaceState.project.id);
  const changed = PMSchedule.computeForwardPass(leaf, deps, pmDateFns, pmEffectiveCalendar());
  for (const c of changed) await DB.updatePMTask(c.id, { start: c.start, finish: c.finish });
  await pmRefreshTasks();
  return changed.map((c) => ({ id: c.id, name: (leaf.find((t) => t.id === c.id) || {}).name || '' }));
}

async function openPMTaskSheet(task) {
  const hasChildren = pmTaskChildren(task.id).length > 0;
  const allDeps = hasChildren ? [] : await DB.listPMDependencies(pmWorkspaceState.project.id);
  const incomingDeps = allDeps.filter((d) => d.successorId === task.id);
  const leaf = pmLeafTasks();

  const depRowsHtml = incomingDeps.map((d) => {
    const pred = leaf.find((t) => t.id === d.predecessorId);
    return `
      <div class="pm-dep-row" data-dep-id="${d.id}">
        <span class="pm-dep-row-name">After: ${esc(pred ? pred.name : 'Unknown task')}</span>
        <span class="pm-dep-row-lag">${d.lagDays ? (d.lagDays > 0 ? '+' : '') + d.lagDays + 'd lag' : ''}</span>
        <button class="pm-dep-remove" data-dep-id="${d.id}">✕</button>
      </div>
    `;
  }).join('');

  const sheet = el(`
    <div class="sheet-backdrop">
      <div class="sheet">
        <div class="sheet-handle"></div>
        <h2>Edit task</h2>
        <div class="field"><label>Name</label><input type="text" id="f-pmt-name" value="${esc(task.name)}"></div>
        ${hasChildren ? `<p class="hint">This is a summary task — duration and dates roll up from its subtasks and can't be edited directly here.</p>` : `
        <div class="field"><label>Duration (working days)</label><input type="number" min="1" step="1" id="f-pmt-duration" value="${task.duration}" ${task.isMilestone ? 'disabled' : ''}></div>
        <div class="field"><label>Start</label><input type="date" id="f-pmt-start" value="${task.start ? task.start.slice(0, 10) : ''}"></div>
        <div class="field"><label>Finish</label><input type="date" id="f-pmt-finish" value="${task.finish ? task.finish.slice(0, 10) : ''}" ${task.isMilestone ? 'disabled' : ''}></div>
        <div class="field"><label>% Complete</label><input type="number" min="0" max="100" step="5" id="f-pmt-pct" value="${task.percentComplete}"></div>
        <div class="field">
          <label><input type="checkbox" id="f-pmt-milestone" ${task.isMilestone ? 'checked' : ''} style="width:auto; margin-right:8px;">Milestone</label>
          <p class="hint">Milestones have zero duration and start = finish.</p>
        </div>
        <div class="field">
          <label>Dependencies (Finish-to-Start)</label>
          <div id="pmt-dep-list">${depRowsHtml || '<p class="hint">No predecessors — start date is fully manual.</p>'}</div>
          <button class="btn btn-secondary btn-block" id="btn-pmt-add-dep" style="margin-top:8px;">+ Add predecessor</button>
          <p class="hint">Once linked, this task can't start before its predecessor finishes (plus any lag) — but you can still schedule it later than that if you need to.</p>
        </div>
        <div class="field">
          <label>Hours per day for this task</label>
          <input type="number" min="0.1" step="0.1" id="f-pmt-hours-per-day" value="${task.hoursPerDayOverride != null ? task.hoursPerDayOverride : ''}" placeholder="Uses project default (${pmEffectiveCalendar().hoursPerDay}hrs)">
          <p class="hint">Leave blank to use the project default. Set this for tasks with a different working pattern — e.g. a 12-hour night-shift closure.</p>
        </div>
        <div class="field">
          <label>Resources</label>
          <div id="pmt-resource-list"></div>
          <button class="btn btn-secondary btn-block" id="btn-pmt-add-resource" style="margin-top:8px;">+ Assign resource</button>
        </div>
        `}
        <div class="field"><label>Notes</label><textarea id="f-pmt-notes">${esc(task.notes || '')}</textarea></div>
        <button class="btn btn-primary btn-block" id="btn-pmt-save" style="margin-top:10px;">Save</button>
        <button class="btn btn-ghost btn-block" id="btn-pmt-cancel">Cancel</button>
      </div>
    </div>
  `);
  presentOverlay(sheet);
  sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.remove(); });
  sheet.querySelector('#btn-pmt-cancel').addEventListener('click', () => sheet.remove());

  if (!hasChildren) {
    const msBox = sheet.querySelector('#f-pmt-milestone');
    const startInput = sheet.querySelector('#f-pmt-start');
    const finishInput = sheet.querySelector('#f-pmt-finish');
    const durationInput = sheet.querySelector('#f-pmt-duration');

    // Logged bug fix: Start/Finish/Duration could previously drift out of sync in this sheet —
    // only the Gantt drag/resize (Step 4) kept them consistent. Reuses the same already-tested
    // PMCalendar functions the engine itself uses, not a second implementation. Validation
    // against predecessors/non-working-days still only happens on Save, same "validate on
    // release, not while typing" philosophy already used for the Gantt drag interaction.
    function pmSheetRecomputeFinishFromDuration() {
      if (msBox.checked) return;
      const s = pmParseISODate(startInput.value);
      const dur = Math.max(1, parseInt(durationInput.value, 10) || 1);
      if (s == null) return;
      finishInput.value = pmFormatISODate(PMCalendar.addWorkingDays(s, dur, pmEffectiveCalendar()));
    }
    function pmSheetRecomputeDurationFromFinish() {
      if (msBox.checked) return;
      const s = pmParseISODate(startInput.value);
      const f = pmParseISODate(finishInput.value);
      if (s == null || f == null) return;
      durationInput.value = PMCalendar.countWorkingDays(s, f, pmEffectiveCalendar());
    }
    durationInput.addEventListener('input', pmSheetRecomputeFinishFromDuration);
    finishInput.addEventListener('input', pmSheetRecomputeDurationFromFinish);
    startInput.addEventListener('input', pmSheetRecomputeFinishFromDuration); // moving start preserves duration, shifts finish — same as the Gantt "move" drag

    msBox.addEventListener('change', () => {
      sheet.querySelector('#f-pmt-duration').disabled = msBox.checked;
      sheet.querySelector('#f-pmt-finish').disabled = msBox.checked;
      if (msBox.checked) {
        sheet.querySelector('#f-pmt-duration').value = 0;
        sheet.querySelector('#f-pmt-finish').value = sheet.querySelector('#f-pmt-start').value;
      }
    });

    sheet.querySelectorAll('.pm-dep-remove').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await DB.deletePMDependency(btn.dataset.depId);
        sheet.remove();
        await pmRefreshTasks(); // no recompute needed — relaxing a constraint never requires moving anything
        drawPMWorkspace();
        openPMTaskSheet(pmWorkspaceState.tasks.find((t) => t.id === task.id));
      });
    });

    sheet.querySelector('#btn-pmt-add-dep').addEventListener('click', () => {
      openAddPMDependencySheet(task, incomingDeps, allDeps, leaf, () => {
        sheet.remove();
        drawPMWorkspace();
        openPMTaskSheet(pmWorkspaceState.tasks.find((t) => t.id === task.id));
      });
    });

    // Resources — leaf, non-milestone tasks only (a milestone has no duration to spend effort
    // against, same reasoning as it being exempt from calendar-day scheduling).
    async function refreshResourceList() {
      const [assignments, resources] = await Promise.all([DB.listPMAssignmentsForTask(task.id), DB.listPMResources()]);
      const listEl = sheet.querySelector('#pmt-resource-list');
      if (!assignments.length) {
        listEl.innerHTML = '<p class="hint">No resources assigned.</p>';
        return;
      }
      listEl.innerHTML = assignments.map((a) => {
        const resource = resources.find((r) => r.id === a.resourceId);
        return `
          <div class="pm-dep-row" data-assignment-id="${a.id}">
            <span class="pm-dep-row-name">${esc(resource ? resource.name : 'Unknown resource')} — ${esc(pmFormatEffort(a, task))}</span>
            <button class="pm-dep-remove" data-assignment-id="${a.id}">✕</button>
          </div>
        `;
      }).join('');
      listEl.querySelectorAll('.pm-dep-row').forEach((row) => {
        row.addEventListener('click', (e) => {
          if (e.target.classList.contains('pm-dep-remove')) return;
          const assignment = assignments.find((a) => a.id === row.dataset.assignmentId);
          const resource = resources.find((r) => r.id === assignment.resourceId);
          openPMEffortSheet(task, resource, assignment, refreshResourceList);
        });
      });
      listEl.querySelectorAll('.pm-dep-remove').forEach((btn) => {
        btn.addEventListener('click', async () => {
          await DB.deletePMAssignment(btn.dataset.assignmentId);
          refreshResourceList();
        });
      });
    }
    refreshResourceList();

    sheet.querySelector('#btn-pmt-add-resource').addEventListener('click', async () => {
      const [assignments, resources] = await Promise.all([DB.listPMAssignmentsForTask(task.id), DB.listPMResources()]);
      const assignedIds = new Set(assignments.map((a) => a.resourceId));
      const candidates = resources.filter((r) => !assignedIds.has(r.id));
      openPMResourcePickerSheet(candidates, (resource) => {
        openPMEffortSheet(task, resource, null, refreshResourceList);
      });
    });
  }

  sheet.querySelector('#btn-pmt-save').addEventListener('click', async () => {
    const name = sheet.querySelector('#f-pmt-name').value.trim();
    if (!name) { toast('Enter a task name'); return; }
    const patch = { name, notes: sheet.querySelector('#f-pmt-notes').value.trim() };
    if (!hasChildren) {
      const isMilestone = sheet.querySelector('#f-pmt-milestone').checked;
      patch.isMilestone = isMilestone;
      patch.start = sheet.querySelector('#f-pmt-start').value || null;
      patch.finish = isMilestone ? patch.start : (sheet.querySelector('#f-pmt-finish').value || null);
      patch.duration = isMilestone ? 0 : Math.max(0, parseInt(sheet.querySelector('#f-pmt-duration').value, 10) || 0);
      patch.percentComplete = Math.min(100, Math.max(0, parseInt(sheet.querySelector('#f-pmt-pct').value, 10) || 0));
      const hpdVal = sheet.querySelector('#f-pmt-hours-per-day').value;
      patch.hoursPerDayOverride = hpdVal !== '' ? Math.max(0.1, parseFloat(hpdVal)) : null;

      const result = await pmCommitTaskDates(task.id, patch);
      if (!result.ok) { toast(result.error); return; }
      sheet.remove();
      pmReportMoved(result.movedOthers);
      drawPMWorkspace();
      return;
    }
    await DB.updatePMTask(task.id, patch);
    sheet.remove();
    await pmRefreshTasks();
    drawPMWorkspace();
  });
}

function openAddPMDependencySheet(task, incomingDeps, allDeps, leaf, onDone) {
  const linkedIds = new Set(incomingDeps.map((d) => d.predecessorId));
  const candidates = leaf.filter((t) => {
    if (t.id === task.id || linkedIds.has(t.id)) return false;
    // Pre-filter obviously-invalid choices for a better picker experience; db.js still
    // enforces this authoritatively regardless of what's shown here.
    return !PMSchedule.wouldCreateCycle(allDeps, t.id, task.id);
  });

  const rows = candidates.map((t) => `
    <div class="list-item" data-id="${t.id}">
      <div class="meta"><h3>${esc(t.name)}</h3></div>
      <span class="chevron">›</span>
    </div>
  `).join('');

  const sheet = el(`
    <div class="sheet-backdrop">
      <div class="sheet">
        <div class="sheet-handle"></div>
        <h2>Add predecessor</h2>
        ${candidates.length ? rows : '<p class="hint">No other tasks available to link — add more tasks first, or every remaining task would create a circular dependency.</p>'}
        <button class="btn btn-ghost btn-block" id="btn-pmt-dep-cancel" style="margin-top:10px;">Cancel</button>
      </div>
    </div>
  `);
  presentOverlay(sheet);
  sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.remove(); });
  sheet.querySelector('#btn-pmt-dep-cancel').addEventListener('click', () => sheet.remove());
  sheet.querySelectorAll('.list-item').forEach((row) => {
    row.addEventListener('click', async () => {
      try {
        await DB.createPMDependency(pmWorkspaceState.project.id, row.dataset.id, task.id, 'FS', 0);
      } catch (err) {
        toast(err.message);
        sheet.remove();
        return;
      }
      sheet.remove();
      const moved = await pmRecomputeAfterDependencyChange();
      pmReportMoved(moved);
      onDone();
    });
  });
}

// ---------- Resource assignment (effort entry with %/Days/Hours toggle) ----------

function pmFormatEffort(assignment, task) {
  const hoursPerDay = pmEffectiveHoursPerDay(task);
  const mode = assignment.entryMode || 'hours';
  if (mode === 'pct') {
    const pct = PMResource.percentFromEffortHours(assignment.effortHours, task.duration, hoursPerDay);
    return `${Math.round(pct)}%`;
  }
  if (mode === 'days') {
    const days = PMResource.daysFromEffortHours(assignment.effortHours, hoursPerDay);
    return `${days.toFixed(1)}d`;
  }
  return `${assignment.effortHours.toFixed(1)}h`;
}

function openPMResourcePickerSheet(candidates, onPick) {
  const rows = candidates.map((r) => `
    <div class="list-item" data-id="${r.id}">
      <div class="meta"><h3>${esc(r.name)}</h3>${r.role ? `<p>${esc(r.role)}</p>` : ''}</div>
      <span class="chevron">›</span>
    </div>
  `).join('');
  const sheet = el(`
    <div class="sheet-backdrop">
      <div class="sheet">
        <div class="sheet-handle"></div>
        <h2>Assign resource</h2>
        ${candidates.length ? rows : '<p class="hint">No resources available — add one from the Resources screen first, or every resource is already assigned to this task.</p>'}
        <button class="btn btn-ghost btn-block" id="btn-pmr-picker-cancel" style="margin-top:10px;">Cancel</button>
      </div>
    </div>
  `);
  presentOverlay(sheet);
  sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.remove(); });
  sheet.querySelector('#btn-pmr-picker-cancel').addEventListener('click', () => sheet.remove());
  sheet.querySelectorAll('.list-item').forEach((row) => {
    row.addEventListener('click', () => {
      const resource = candidates.find((r) => r.id === row.dataset.id);
      sheet.remove();
      onPick(resource);
    });
  });
}

// The %/Days/Hours toggle. Switching modes CONVERTS the current number rather than clearing
// it — typing 100 in % then tapping Hours shows the actual hour count for this task's duration
// and hours-per-day, which doubles as a sanity check without doing the maths by hand.
function openPMEffortSheet(task, resource, existingAssignment, onSaved) {
  const hoursPerDay = pmEffectiveHoursPerDay(task);
  const durationDays = task.duration || 1;
  let mode = existingAssignment ? (existingAssignment.entryMode || 'hours') : 'pct';
  let value = existingAssignment
    ? (mode === 'pct' ? PMResource.percentFromEffortHours(existingAssignment.effortHours, durationDays, hoursPerDay)
      : mode === 'days' ? PMResource.daysFromEffortHours(existingAssignment.effortHours, hoursPerDay)
      : existingAssignment.effortHours)
    : 100; // default a new assignment to full-time — the common case

  const modeLabels = { pct: 'Percent of task duration', days: 'Days of effort', hours: 'Hours of effort' };

  const sheet = el(`
    <div class="sheet-backdrop">
      <div class="sheet">
        <div class="sheet-handle"></div>
        <h2>Effort — ${esc(resource.name)}</h2>
        <div class="field">
          <label>Entry mode</label>
          <div style="display:flex; gap:8px;">
            <button class="btn btn-secondary pm-mode-btn" data-mode="pct">%</button>
            <button class="btn btn-secondary pm-mode-btn" data-mode="days">Days</button>
            <button class="btn btn-secondary pm-mode-btn" data-mode="hours">Hours</button>
          </div>
        </div>
        <div class="field">
          <label id="pmt-effort-label"></label>
          <input type="number" min="0" step="0.1" id="f-pmt-effort-value">
        </div>
        <p class="hint" id="pmt-effort-hint"></p>
        <button class="btn btn-primary btn-block" id="btn-pmt-effort-save" style="margin-top:10px;">Save</button>
        <button class="btn btn-ghost btn-block" id="btn-pmt-effort-cancel">Cancel</button>
      </div>
    </div>
  `);
  presentOverlay(sheet);
  sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.remove(); });
  sheet.querySelector('#btn-pmt-effort-cancel').addEventListener('click', () => sheet.remove());

  const valueInput = sheet.querySelector('#f-pmt-effort-value');
  const labelEl = sheet.querySelector('#pmt-effort-label');
  const hintEl = sheet.querySelector('#pmt-effort-hint');

  function redraw() {
    sheet.querySelectorAll('.pm-mode-btn').forEach((btn) => {
      btn.classList.toggle('pm-mode-btn-active', btn.dataset.mode === mode);
    });
    labelEl.textContent = modeLabels[mode];
    valueInput.value = Math.round(value * 10) / 10;
    const hours = mode === 'pct' ? PMResource.effortHoursFromPercent(durationDays, value, hoursPerDay)
      : mode === 'days' ? PMResource.effortHoursFromDays(value, hoursPerDay)
      : value;
    const pct = PMResource.percentFromEffortHours(hours, durationDays, hoursPerDay);
    const days = PMResource.daysFromEffortHours(hours, hoursPerDay);
    hintEl.textContent = `≈ ${hours.toFixed(1)} hours · ${days.toFixed(1)} working days · ${Math.round(pct)}% of this task's ${durationDays}-day duration (at ${hoursPerDay}hrs/day)`;
  }
  redraw();

  sheet.querySelectorAll('.pm-mode-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const newMode = btn.dataset.mode;
      value = PMResource.convertEffort(value, mode, newMode, durationDays, hoursPerDay);
      mode = newMode;
      redraw();
    });
  });
  valueInput.addEventListener('input', () => {
    value = Math.max(0, parseFloat(valueInput.value) || 0);
    redraw();
  });

  sheet.querySelector('#btn-pmt-effort-save').addEventListener('click', async () => {
    const hours = mode === 'pct' ? PMResource.effortHoursFromPercent(durationDays, value, hoursPerDay)
      : mode === 'days' ? PMResource.effortHoursFromDays(value, hoursPerDay)
      : value;
    if (existingAssignment) {
      await DB.updatePMAssignment(existingAssignment.id, { effortHours: hours, entryMode: mode });
    } else {
      await DB.createPMAssignment(pmWorkspaceState.project.id, task.id, resource.id, hours, mode);
    }
    sheet.remove();
    onSaved();
  });
}

// ---------- Workload view (resource overallocation heatmap) ----------
// Reached via the "Workload" button in the project workspace topbar — an in-memory screen
// switch, not a hash route, since it only makes sense inside an already-loaded project
// workspace (same convention as the workspace itself). Uses pmWorkspaceState directly rather
// than re-fetching, since it's only reachable from a screen where that's already loaded.

async function renderPMWorkload() {
  const { project } = pmWorkspaceState;
  const leaf = pmLeafTasks();
  const assignments = await DB.listPMAssignmentsForProject(project.id);
  const resources = await DB.listPMResources();
  const calendar = pmEffectiveCalendar();
  const getTaskHoursPerDay = (task) => pmEffectiveHoursPerDay(task);
  const workload = PMResource.computeWorkload(assignments, leaf, calendar, getTaskHoursPerDay, pmDateFns, PMCalendar);

  const resourceIds = Object.keys(workload);
  let allDates = [];
  resourceIds.forEach((rid) => workload[rid].days.forEach((d) => allDates.push(d.date)));
  allDates = Array.from(new Set(allDates)).sort();

  const dateLabelsHtml = allDates.map((d) => `<div class="pm-workload-cell pm-workload-date-label">${pmFormatDayTick(pmParseISODate(d))}</div>`).join('');

  const rowsHtml = resourceIds.map((rid) => {
    const resource = resources.find((r) => r.id === rid);
    const dayMap = Object.fromEntries(workload[rid].days.map((d) => [d.date, d]));
    const cellsHtml = allDates.map((date) => {
      const d = dayMap[date];
      const hours = d ? d.hours : 0;
      const overallocated = d ? d.overallocated : false;
      const bg = hours === 0 ? 'transparent' : overallocated ? 'var(--red)' : 'oklch(0.65 0.03 260)';
      const title = hours > 0 ? `${fmtDate(date)}: ${hours.toFixed(1)}h${overallocated ? ' — overallocated' : ''}` : fmtDate(date);
      return `<div class="pm-workload-cell" style="background:${bg};" title="${esc(title)}">${hours > 0 ? Math.round(hours) : ''}</div>`;
    }).join('');
    return `
      <div class="pm-workload-row">
        <div class="pm-workload-name">${esc(resource ? resource.name : 'Unknown resource')}</div>
        <div class="pm-workload-cells">${cellsHtml}</div>
      </div>
    `;
  }).join('');

  appEl.innerHTML = `
    <div class="topbar">
      <button class="icon-btn" id="btn-pm-workload-back">‹</button>
      <div style="flex:1; min-width:0;">
        <h1>Workload</h1>
        <span class="sub">${esc(project.name)}</span>
      </div>
    </div>
    <div class="content" id="pm-workload-content" style="padding:0;">
      ${resourceIds.length ? `
        <div class="pm-workload-grid">
          <div class="pm-workload-row pm-workload-header">
            <div class="pm-workload-name">Resource</div>
            <div class="pm-workload-cells">${dateLabelsHtml}</div>
          </div>
          ${rowsHtml}
        </div>
        <p class="hint" style="padding:16px;">Red cells mean this resource is committed beyond ${calendar.hoursPerDay}hrs on that day, across all overlapping task assignments.</p>
      ` : `
        <div class="empty-state">
          <div class="glyph">👥</div>
          <h3>No resource commitments yet</h3>
          <p>Assign resources to tasks to see their workload here.</p>
        </div>
      `}
    </div>
  `;
  document.getElementById('btn-pm-workload-back').addEventListener('click', () => drawPMWorkspace());
}

function openEditPMProjectSheet() {
  const { project } = pmWorkspaceState;
  const cal = project.calendar || PMCalendar.DEFAULT;
  const weekdayLabels = [
    { day: 1, label: 'Mon' }, { day: 2, label: 'Tue' }, { day: 3, label: 'Wed' },
    { day: 4, label: 'Thu' }, { day: 5, label: 'Fri' }, { day: 6, label: 'Sat' }, { day: 0, label: 'Sun' }
  ];
  const weekdayTogglesHtml = weekdayLabels.map(({ day, label }) => `
    <label style="display:inline-flex; align-items:center; gap:5px; margin-right:14px; margin-bottom:6px;">
      <input type="checkbox" class="f-pm-cal-weekday" value="${day}" style="width:auto;" ${cal.workingWeekdays.includes(day) ? 'checked' : ''}>${label}
    </label>
  `).join('');
  const holidayRowsHtml = (cal.holidays || []).slice().sort().map((d) => `
    <div class="pm-dep-row" data-holiday="${d}">
      <span class="pm-dep-row-name">${fmtDate(d)}</span>
      <button class="pm-dep-remove" data-holiday="${d}">✕</button>
    </div>
  `).join('');

  const sheet = el(`
    <div class="sheet-backdrop">
      <div class="sheet">
        <div class="sheet-handle"></div>
        <h2>Project info</h2>
        <div class="field"><label>Project name</label><input type="text" id="f-pm-name" value="${esc(project.name)}"></div>
        <div class="field"><label>Structure reference</label><input type="text" id="f-pm-structureRef" value="${esc(project.structureRef || '')}"></div>
        <div class="field"><label>Client</label><input type="text" id="f-pm-client" value="${esc(project.client || '')}"></div>
        <div class="field"><label>Start date</label><input type="date" id="f-pm-start" value="${project.startDate ? project.startDate.slice(0, 10) : ''}"></div>
        <div class="field">
          <label>Working days</label>
          <div>${weekdayTogglesHtml}</div>
          <p class="hint">Governs how task durations and dependencies are scheduled — a 3-day task skips any day not checked here.</p>
        </div>
        <div class="field">
          <label>Working hours per day</label>
          <input type="number" min="0.1" step="0.1" id="f-pm-cal-hours-per-day" value="${cal.hoursPerDay != null ? cal.hoursPerDay : 7.4}">
          <p class="hint">Used for resource effort calculations (e.g. "1 day of effort" = this many hours). Doesn't affect task scheduling dates — only which days are working days does that. Individual tasks can override this (e.g. a 12-hour night shift).</p>
        </div>
        <div class="field">
          <label>Holidays &amp; non-working dates</label>
          <div id="pmt-holiday-list">${holidayRowsHtml || '<p class="hint">None added.</p>'}</div>
          <div style="display:flex; gap:8px; margin-top:8px;">
            <input type="date" id="f-pm-cal-add-holiday" style="flex:1;">
            <button class="btn btn-secondary" id="btn-pm-cal-add-holiday">Add</button>
          </div>
          <p class="hint">Changing the calendar doesn't retroactively move existing task dates — it applies the next time a task is edited, dragged, or its schedule recalculates.</p>
        </div>
        <div class="field"><label>Notes</label><textarea id="f-pm-notes">${esc(project.notes || '')}</textarea></div>
        <button class="btn btn-primary btn-block" id="btn-pm-save-project" style="margin-top:10px;">Save</button>
        <button class="btn btn-danger btn-block" id="btn-pm-delete-project" style="margin-top:10px;">Delete project</button>
        <button class="btn btn-ghost btn-block" id="btn-pm-cancel">Cancel</button>
      </div>
    </div>
  `);
  presentOverlay(sheet);
  sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.remove(); });
  sheet.querySelector('#btn-pm-cancel').addEventListener('click', () => sheet.remove());

  let pendingHolidays = (cal.holidays || []).slice();
  function redrawHolidayList() {
    const list = sheet.querySelector('#pmt-holiday-list');
    list.innerHTML = pendingHolidays.slice().sort().map((d) => `
      <div class="pm-dep-row" data-holiday="${d}">
        <span class="pm-dep-row-name">${fmtDate(d)}</span>
        <button class="pm-dep-remove" data-holiday="${d}">✕</button>
      </div>
    `).join('') || '<p class="hint">None added.</p>';
    list.querySelectorAll('.pm-dep-remove').forEach((btn) => {
      btn.addEventListener('click', () => {
        pendingHolidays = pendingHolidays.filter((d) => d !== btn.dataset.holiday);
        redrawHolidayList();
      });
    });
  }
  redrawHolidayList();

  sheet.querySelector('#btn-pm-cal-add-holiday').addEventListener('click', () => {
    const val = sheet.querySelector('#f-pm-cal-add-holiday').value;
    if (!val) return;
    if (!pendingHolidays.includes(val)) pendingHolidays.push(val);
    sheet.querySelector('#f-pm-cal-add-holiday').value = '';
    redrawHolidayList();
  });

  sheet.querySelector('#btn-pm-save-project').addEventListener('click', async () => {
    const name = sheet.querySelector('#f-pm-name').value.trim();
    if (!name) { toast('Enter a project name'); return; }
    const workingWeekdays = Array.from(sheet.querySelectorAll('.f-pm-cal-weekday:checked')).map((cb) => parseInt(cb.value, 10));
    if (workingWeekdays.length === 0) { toast('At least one working day is required'); return; }
    const hoursPerDay = Math.max(0.1, parseFloat(sheet.querySelector('#f-pm-cal-hours-per-day').value) || 7.4);
    await DB.updatePMProject(project.id, {
      name,
      structureRef: sheet.querySelector('#f-pm-structureRef').value.trim(),
      client: sheet.querySelector('#f-pm-client').value.trim(),
      startDate: sheet.querySelector('#f-pm-start').value,
      notes: sheet.querySelector('#f-pm-notes').value.trim(),
      calendar: { workingWeekdays, holidays: pendingHolidays, hoursPerDay }
    });
    sheet.remove();
    renderPMWorkspace(project.id);
  });
  sheet.querySelector('#btn-pm-delete-project').addEventListener('click', async () => {
    if (!confirm(`Delete "${project.name}" and all its tasks? This can't be undone.`)) return;
    await DB.deletePMProjectCascade(project.id);
    sheet.remove();
    renderPM();
  });
}

window.renderPM = renderPM;
window.renderPMWorkspace = renderPMWorkspace;
