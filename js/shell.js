// shell.js — Phase 2 of the full UI rebuild. The persistent Inspector shell: sidebar +
// main pane, reached via #/inspector.
//
// Deliberate architectural departure from the rest of the app: everywhere else, every
// navigation is a hash change that triggers route() and fully remounts appEl.innerHTML.
// The whole point of this shell is to NOT do that — it mounts once, and internal
// interactions (selecting an inspection, switching tabs) are handled as in-memory state
// changes with targeted DOM updates, not hash changes. Only entering (#/inspector) and
// leaving (back to Launcher, into Templates) go through the hash router. Losing this
// distinction anywhere in here would silently reintroduce the old remount-everything
// problem this whole redesign exists to fix.
//
// Tab content for Overview/Elements/Drawings/Risk Assessment/Appendices/Report is stub
// placeholder for now — each is its own later phase. This phase is scoped to the shell
// structure itself: sidebar, main pane header, tab bar mechanics, and inspection selection
// (including the Old Style conversion prompt).

const SHELL_TOKENS = {
  ink: 'oklch(0.22 0.012 260)',
  inkBorder: 'oklch(0.30 0.014 260)',
  inkHover: 'oklch(0.28 0.013 260)',
  red: 'oklch(0.56 0.19 27)',
  redHover: 'oklch(0.47 0.19 27)',
  page: 'oklch(0.973 0.003 90)',
  line: 'oklch(0.91 0.004 90)',
  muted: 'oklch(0.55 0.008 260)',
  mutedLight: 'oklch(0.65 0.01 260)',
  sev: {
    1: 'oklch(0.68 0.13 150)',
    2: 'oklch(0.74 0.14 115)',
    3: 'oklch(0.78 0.15 80)',
    4: 'oklch(0.68 0.18 45)',
    5: 'oklch(0.56 0.19 27)'
  }
};

const SHELL_TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'elements', label: 'Elements' },
  { id: 'drawings', label: 'Drawings' },
  { id: 'risk', label: 'Risk Assessment' },
  { id: 'appendices', label: 'Appendices' },
  { id: 'report', label: 'Report' }
];

let shellState = {
  selectedInspectionId: null,
  activeTab: 'overview',
  searchQuery: ''
};

async function renderInspectorShell() {
  const t = SHELL_TOKENS;
  appEl.innerHTML = `
    <div style="width:100%; height:100vh; display:flex; box-sizing:border-box; overflow:hidden;">
      <div id="shell-sidebar" style="width:280px; flex-shrink:0; background:${t.ink}; color:#fff; display:flex; flex-direction:column; box-sizing:border-box; padding-top:var(--safe-top);"></div>
      <div id="shell-main" style="flex:1; min-width:0; display:flex; flex-direction:column; background:${t.page}; box-sizing:border-box;"></div>
    </div>
  `;
  shellState.activeTab = 'overview';
  await renderShellSidebar();
  await renderShellMainPane();
}

async function renderShellSidebar() {
  const t = SHELL_TOKENS;
  const sidebar = document.getElementById('shell-sidebar');
  const inspections = await DB.listInspections();
  const q = shellState.searchQuery.trim().toLowerCase();
  const filtered = q ? inspections.filter((i) => (i.structureName || '').toLowerCase().includes(q)) : inspections;

  // Worst severity per inspection, for the sidebar dot — a bounded two-hop query
  // (elements indexed by inspectionId, findings indexed by elementId) per inspection.
  // Fine for realistic list sizes; worth revisiting if very large inspection counts
  // ever make this sluggish.
  const dots = {};
  for (const insp of filtered) {
    dots[insp.id] = await shellWorstSeverity(insp.id);
  }

  sidebar.innerHTML = `
    <div style="padding:16px 18px 12px;">
      <button id="shell-back" style="background:none; border:none; color:${t.mutedLight}; font-size:13px; font-weight:600; padding:4px 0;">‹ All Modules</button>
    </div>
    <div style="padding:0 18px 16px; display:flex; align-items:center; gap:10px; border-bottom:1px solid ${t.inkBorder};">
      <div style="width:30px; height:30px; border-radius:9px; background:${t.red}; flex-shrink:0;"></div>
      <div>
        <div style="font-size:17px; font-weight:650; color:#fff; line-height:1.2;">Inspector</div>
        <div style="font-size:11.5px; color:${t.mutedLight};">Arch &amp; Array</div>
      </div>
    </div>
    <div style="padding:16px 18px 12px;">
      <button id="shell-new-inspection" style="width:100%; background:${t.red}; color:#fff; border:none; border-radius:9px; padding:11px; font-size:14.5px; font-weight:650;">+ New Inspection</button>
    </div>
    <div style="padding:0 18px 12px;">
      <input id="shell-search" type="text" placeholder="Search inspections" value="${esc(shellState.searchQuery)}" style="width:100%; background:${t.inkHover}; border:1px solid ${t.inkBorder}; border-radius:8px; padding:9px 11px; font-size:13.5px; color:#fff; box-sizing:border-box;">
    </div>
    <div style="padding:0 18px 8px; font-size:11px; font-weight:700; letter-spacing:0.5px; text-transform:uppercase; color:${t.mutedLight};">Inspections</div>
    <div id="shell-inspection-list" style="flex:1; min-height:0; overflow-y:auto; padding:0 10px;">
      ${filtered.length ? filtered.map((insp) => shellInspectionRow(insp, dots[insp.id])).join('') : `<div style="padding:16px 8px; color:${t.mutedLight}; font-size:13px;">No inspections found.</div>`}
    </div>
    <div style="padding:14px 18px calc(14px + var(--safe-bottom)); border-top:1px solid ${t.inkBorder};">
      <div style="font-size:11px; font-weight:700; letter-spacing:0.5px; text-transform:uppercase; color:${t.mutedLight}; margin-bottom:8px;">Settings</div>
      <button id="shell-templates" style="background:none; border:none; color:#fff; font-size:13.5px; font-weight:600; padding:6px 0;">Element Templates</button>
    </div>
  `;

  document.getElementById('shell-back').addEventListener('click', () => navigate('#/'));
  document.getElementById('shell-templates').addEventListener('click', () => navigate('#/templates'));
  document.getElementById('shell-new-inspection').addEventListener('click', () => {
    openNewInspectionSheet((insp) => shellSelectInspection(insp.id));
  });
  const searchInput = document.getElementById('shell-search');
  searchInput.addEventListener('input', (e) => {
    shellState.searchQuery = e.target.value;
    renderShellSidebar(); // re-render sidebar only — main pane and its state are untouched
  });
  // Restores focus + cursor position after the re-render above, since innerHTML
  // replacement always drops focus even when the same input reappears.
  if (document.activeElement === document.body && q) {
    const el2 = document.getElementById('shell-search');
    el2.focus();
    el2.setSelectionRange(el2.value.length, el2.value.length);
  }

  sidebar.querySelectorAll('.shell-insp-row').forEach((row) => {
    row.addEventListener('click', () => shellSelectInspection(row.dataset.id));
  });
}

function shellInspectionRow(insp, worstSev) {
  const t = SHELL_TOKENS;
  const selected = insp.id === shellState.selectedInspectionId;
  const dotColor = worstSev ? t.sev[worstSev] : 'transparent';
  return `
    <div class="shell-insp-row" data-id="${insp.id}" style="display:flex; align-items:center; gap:10px; padding:10px 8px; border-radius:8px; cursor:pointer; background:${selected ? t.inkHover : 'transparent'};">
      <div style="width:8px; height:8px; border-radius:50%; background:${dotColor}; flex-shrink:0;"></div>
      <div style="min-width:0;">
        <div style="font-size:13.5px; font-weight:650; color:#fff; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${esc(insp.structureName || 'Untitled structure')}</div>
        <div style="font-size:11.5px; color:${t.mutedLight}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${esc(insp.inspectionType || 'Inspection')} · ${fmtDate(insp.date)}</div>
      </div>
    </div>
  `;
}

// Worst (highest-numbered) severity across every finding in this inspection, via the
// only indexed path available: elements by inspectionId, then findings by elementId.
async function shellWorstSeverity(inspectionId) {
  const elements = await DB.getAllByIndex('elements', 'inspectionId', inspectionId);
  let worst = 0;
  for (const el2 of elements) {
    const findings = await DB.getAllByIndex('findings', 'elementId', el2.id);
    for (const f of findings) {
      if (f.severity && f.severity > worst) worst = f.severity;
    }
  }
  return worst || null;
}

// Handles both plain selection and the Old Style → New Style conversion prompt. Declining
// leaves the inspection exactly as it was — still listed by name in the sidebar, just not
// opened — per an explicit decision that this should never happen silently/automatically.
async function shellSelectInspection(id) {
  const insp = await DB.get('inspections', id);
  if (!insp) return;
  if (insp.reportStyle === 'old') {
    const proceed = confirm(`"${insp.structureName || 'This inspection'}" uses the old report format. Convert it to the new format to open it here?\n\nThis cannot be undone.`);
    if (!proceed) return;
    await DB.convertInspectionToNewStyle(id);
  }
  shellState.selectedInspectionId = id;
  shellState.activeTab = 'overview';
  await renderShellSidebar();
  await renderShellMainPane();
}

async function renderShellMainPane() {
  const t = SHELL_TOKENS;
  const main = document.getElementById('shell-main');
  if (!shellState.selectedInspectionId) {
    main.innerHTML = `
      <div style="flex:1; display:flex; align-items:center; justify-content:center; color:${t.muted}; font-size:14.5px;">
        Select an inspection, or create a new one to get started.
      </div>
    `;
    return;
  }
  const insp = await DB.get('inspections', shellState.selectedInspectionId);
  if (!insp) { shellState.selectedInspectionId = null; return renderShellMainPane(); }

  main.innerHTML = `
    <div style="padding:22px 28px 0; flex-shrink:0;">
      <div style="display:flex; align-items:flex-start; justify-content:space-between; gap:16px;">
        <div style="min-width:0;">
          <div style="font-size:23px; font-weight:700; line-height:1.2;">${esc(insp.structureName || 'Untitled structure')}</div>
          <div style="font-size:13px; color:${t.muted}; margin-top:4px;">${esc(insp.inspectionType || 'Inspection')} · ${fmtDate(insp.date)}${insp.inspector ? ' · ' + esc(insp.inspector) : ''}</div>
        </div>
        <div style="display:flex; gap:8px; flex-shrink:0;">
          <button id="shell-edit" style="background:#fff; border:1px solid ${t.line}; border-radius:8px; padding:9px 16px; font-size:13.5px; font-weight:650;">Edit</button>
          <button id="shell-export" style="background:${t.red}; color:#fff; border:none; border-radius:8px; padding:9px 16px; font-size:13.5px; font-weight:650;">Export PDF</button>
        </div>
      </div>
      <div id="shell-tabbar" style="display:flex; gap:22px; margin-top:20px; border-bottom:1px solid ${t.line}; overflow-x:auto;">
        ${SHELL_TABS.map((tab) => `
          <button class="shell-tab" data-tab="${tab.id}" style="background:none; border:none; padding:10px 2px 12px; font-size:14px; font-weight:650; white-space:nowrap; color:${tab.id === shellState.activeTab ? '#000' : t.muted}; border-bottom:2px solid ${tab.id === shellState.activeTab ? t.red : 'transparent'};">${tab.label}</button>
        `).join('')}
      </div>
    </div>
    <div id="shell-tab-content" style="flex:1; min-height:0; overflow-y:auto; padding:24px 28px calc(28px + var(--safe-bottom));"></div>
  `;

  document.getElementById('shell-export').addEventListener('click', () => buildAndSaveNewStyleInspectionPDF(insp.id));
  document.getElementById('shell-edit').addEventListener('click', () => openReportInfoSheet(insp.id));
  main.querySelectorAll('.shell-tab').forEach((btn) => {
    btn.addEventListener('click', () => shellSwitchTab(btn.dataset.tab));
  });

  renderShellTabContent();
}

// Switches tabs by re-rendering only the tab bar's active state + the content area —
// never remounts the sidebar or the header above it.
function shellSwitchTab(tabId) {
  shellState.activeTab = tabId;
  document.querySelectorAll('.shell-tab').forEach((btn) => {
    const active = btn.dataset.tab === tabId;
    btn.style.color = active ? '#000' : SHELL_TOKENS.muted;
    btn.style.borderBottomColor = active ? SHELL_TOKENS.red : 'transparent';
  });
  renderShellTabContent();
}

// Stub content for every tab — each is its own later phase (3: Overview, 4: Elements,
// 5: Drawings/Appendices, 7: Risk Assessment, 8: Report). This phase only needs the tab
// mechanics to work, not the real content yet.
function renderShellTabContent() {
  const content = document.getElementById('shell-tab-content');
  const tab = SHELL_TABS.find((t2) => t2.id === shellState.activeTab);
  content.innerHTML = `
    <div style="color:${SHELL_TOKENS.muted}; font-size:14px;">${esc(tab ? tab.label : '')} — coming in a later phase.</div>
  `;
}
