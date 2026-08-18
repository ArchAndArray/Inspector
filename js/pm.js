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
  pmWorkspaceState = { project, tasks, selectedTaskId: null };
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
    out.push({ task, depth, wbs });
    pmBuildRows(task.id, depth + 1, wbs, out);
  });
}

function drawPMWorkspace() {
  const { project, selectedTaskId } = pmWorkspaceState;
  const rows = [];
  pmBuildRows(null, 0, '', rows);

  const rowsHtml = rows.map(({ task, depth, wbs }) => {
    const hasChildren = pmTaskChildren(task.id).length > 0;
    const r = hasChildren ? pmRollup(task.id) : task;
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
    </div>
    <div class="pm-toolbar">
      <button class="btn btn-secondary" id="btn-pm-add-task">+ Task</button>
      <button class="btn btn-secondary" id="btn-pm-add-subtask" ${selectedTaskId ? '' : 'disabled'}>+ Subtask</button>
      <button class="btn btn-secondary" id="btn-pm-indent" ${selectedTaskId ? '' : 'disabled'}>Indent</button>
      <button class="btn btn-secondary" id="btn-pm-outdent" ${selectedTaskId ? '' : 'disabled'}>Outdent</button>
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
}

async function pmRefreshTasks() {
  pmWorkspaceState.tasks = await DB.listPMTasks(pmWorkspaceState.project.id);
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

function openPMTaskSheet(task) {
  const hasChildren = pmTaskChildren(task.id).length > 0;
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
    }
    await DB.updatePMTask(task.id, patch);
    sheet.remove();
    await pmRefreshTasks();
    drawPMWorkspace();
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
