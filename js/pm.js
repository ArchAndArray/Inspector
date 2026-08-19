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
  pmWorkspaceState = { project, tasks, selectedTaskId: null, undoStack: [], redoStack: [] };
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

  let todayLineHtml = '';
  if (todayMs >= minMs && todayMs <= maxMs) {
    const left = pmDaysBetween(minMs, todayMs) * PM_GANTT_PX_PER_DAY;
    const totalHeight = PM_GANTT_ROW_H + rows.length * PM_GANTT_ROW_H;
    todayLineHtml = `<div class="pm-gantt-today" style="left:${left}px; height:${totalHeight}px;"></div>`;
  }

  return `
    <div class="pm-gantt-chart">
      <div style="position:relative; width:${totalDays * PM_GANTT_PX_PER_DAY}px;">
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

  const rowsHtml = rows.map(({ task, depth, wbs, hasChildren, eff }) => {
    const r = eff;
    const selected = task.id === selectedTaskId;
    return `
      <div class="pm-row${selected ? ' pm-row-selected' : ''}${hasChildren ? ' pm-row-summary' : ''}" data-id="${task.id}">
        <div class="pm-cell pm-cell-wbs">${wbs}</div>
        <div class="pm-cell pm-cell-name" style="padding-left:${depth * 20}px;">
          ${task.isMilestone ? '<span class="pm-milestone-diamond">◆</span>' : ''}${esc(task.name)}
        </div>
        <div class="pm-cell pm-cell-dur">${task.isMilestone ? '—' : (r.duration || 0) + 'd'}</div>
        <div class="pm-cell pm-cell-date">${r.start ? fmtDate(r.start) : '—'}</div>
        <div class="pm-cell pm-cell-date">${r.finish ? fmtDate(r.finish) : '—'}</div>
        <div class="pm-cell pm-cell-pct">${r.percentComplete || 0}%</div>
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
      <button class="text-btn" id="btn-pm-project-info">Info</button>
    </div>
    <div class="content" id="pm-table-content" style="padding:0;">
      <div class="pm-split-wrap">
        <div class="pm-table">
          <div class="pm-row pm-row-header">
            <div class="pm-cell pm-cell-wbs">WBS</div>
            <div class="pm-cell pm-cell-name">Task</div>
            <div class="pm-cell pm-cell-dur">Duration</div>
            <div class="pm-cell pm-cell-date">Start</div>
            <div class="pm-cell pm-cell-date">Finish</div>
            <div class="pm-cell pm-cell-pct">% Complete</div>
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
}

async function pmRefreshTasks() {
  pmWorkspaceState.tasks = await DB.listPMTasks(pmWorkspaceState.project.id);
}

const pmDateFns = { parse: pmParseISODate, format: pmFormatISODate };

function pmLeafTasks() {
  return pmWorkspaceState.tasks.filter((t) => pmTaskChildren(t.id).length === 0);
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
    const check = PMSchedule.validateManualStart(taskId, primaryPatch.start, leaf, deps, pmDateFns);
    if (!check.ok) {
      return { ok: false, error: `Can't start before ${fmtDate(check.minStart)} — blocked by "${check.blockedBy}"` };
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
  const cascaded = PMSchedule.computeForwardPass(updatedLeaf, deps, pmDateFns);
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
  const changed = PMSchedule.computeForwardPass(leaf, deps, pmDateFns);
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
        <div class="field"><label>Duration (days)</label><input type="number" min="0" step="1" id="f-pmt-duration" value="${task.duration}" ${task.isMilestone ? 'disabled' : ''}></div>
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

function openEditPMProjectSheet() {
  const { project } = pmWorkspaceState;
  const sheet = el(`
    <div class="sheet-backdrop">
      <div class="sheet">
        <div class="sheet-handle"></div>
        <h2>Project info</h2>
        <div class="field"><label>Project name</label><input type="text" id="f-pm-name" value="${esc(project.name)}"></div>
        <div class="field"><label>Structure reference</label><input type="text" id="f-pm-structureRef" value="${esc(project.structureRef || '')}"></div>
        <div class="field"><label>Client</label><input type="text" id="f-pm-client" value="${esc(project.client || '')}"></div>
        <div class="field"><label>Start date</label><input type="date" id="f-pm-start" value="${project.startDate ? project.startDate.slice(0, 10) : ''}"></div>
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
  sheet.querySelector('#btn-pm-save-project').addEventListener('click', async () => {
    const name = sheet.querySelector('#f-pm-name').value.trim();
    if (!name) { toast('Enter a project name'); return; }
    await DB.updatePMProject(project.id, {
      name,
      structureRef: sheet.querySelector('#f-pm-structureRef').value.trim(),
      client: sheet.querySelector('#f-pm-client').value.trim(),
      startDate: sheet.querySelector('#f-pm-start').value,
      notes: sheet.querySelector('#f-pm-notes').value.trim()
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
