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

// Stub content for every tab except Overview (built this phase) — the rest are their own
// later phases (4: Elements, 5: Drawings/Appendices, 7: Risk Assessment, 8: Report).
async function renderShellTabContent() {
  const content = document.getElementById('shell-tab-content');
  if (shellState.activeTab === 'overview') {
    await shellRenderOverviewTab(content);
    return;
  }
  if (shellState.activeTab === 'elements') {
    await shellRenderElementsTab(content);
    return;
  }
  if (shellState.activeTab === 'drawings') {
    await shellRenderDrawingsTab(content);
    return;
  }
  if (shellState.activeTab === 'appendices') {
    await shellRenderAppendicesTab(content);
    return;
  }
  if (shellState.activeTab === 'risk') {
    await shellRenderRiskTab(content);
    return;
  }
  if (shellState.activeTab === 'report') {
    await shellRenderReportTab(content);
    return;
  }
  const tab = SHELL_TABS.find((t2) => t2.id === shellState.activeTab);
  content.innerHTML = `
    <div style="color:${SHELL_TOKENS.muted}; font-size:14px;">${esc(tab ? tab.label : '')} — coming in a later phase.</div>
  `;
}

// Computes every stat the Overview tab needs in one pass over elements/findings, rather
// than separate queries per stat — same two-hop indexed path as the sidebar's severity dot.
async function shellComputeInspectionStats(inspectionId) {
  const elements = await DB.getAllByIndex('elements', 'inspectionId', inspectionId);
  const stats = { elementCount: elements.length, findingCount: 0, worksRequiredCount: 0, severityCounts: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } };
  for (const el2 of elements) {
    const findings = await DB.getAllByIndex('findings', 'elementId', el2.id);
    stats.findingCount += findings.length;
    findings.forEach((f) => {
      if (f.worksRequired) stats.worksRequiredCount++;
      if (f.severity && stats.severityCounts[f.severity] != null) stats.severityCounts[f.severity]++;
    });
  }
  return stats;
}

async function shellRenderOverviewTab(content) {
  const t = SHELL_TOKENS;
  const insp = await DB.get('inspections', shellState.selectedInspectionId);
  const isGiBridges = insp.inspectionType === 'GI Bridges';
  const stats = await shellComputeInspectionStats(insp.id);
  const reportSections = await DB.listReportSections(insp.id);

  let bci = null;
  if (isGiBridges) {
    try { bci = await computeBciSummary(insp.id); } catch (err) { console.error('BCI computation failed', err); }
  }

  const severityTotal = Object.values(stats.severityCounts).reduce((a, b) => a + b, 0);
  const barSegments = [1, 2, 3, 4, 5].map((sev) => {
    const count = stats.severityCounts[sev];
    const pct = severityTotal ? (count / severityTotal) * 100 : 0;
    return pct > 0 ? `<div style="width:${pct}%; background:${t.sev[sev]}; height:100%;" title="Severity ${sev}: ${count}"></div>` : '';
  }).join('');

  const detailFields = [
    ['Structure ID', insp.structureId],
    ['Type', insp.inspectionType],
    ['Date', fmtDate(insp.date)],
    ['Inspector', insp.inspector],
    ['Weather', insp.weather],
    ['Location', (insp.location && insp.location.manual) || '']
  ];

  content.innerHTML = `
    <div style="display:grid; grid-template-columns:1.3fr 1fr; gap:18px; align-items:start;">
      <div style="background:#fff; border:1px solid ${t.line}; border-radius:14px; padding:18px 20px;">
        <div style="font-size:15px; font-weight:650; margin-bottom:14px;">Inspection Details</div>
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:14px 20px;">
          ${detailFields.map(([label, value]) => `
            <div>
              <div style="font-size:11px; font-weight:700; letter-spacing:0.4px; text-transform:uppercase; color:${t.muted};">${esc(label)}</div>
              <div style="font-size:14.5px; font-weight:550; margin-top:3px;">${esc(value) || '—'}</div>
            </div>
          `).join('')}
        </div>
      </div>

      <div style="background:#fff; border:1px solid ${t.line}; border-radius:14px; padding:18px 20px;">
        <div style="font-size:15px; font-weight:650; margin-bottom:14px;">Condition Summary</div>
        ${bci ? `
          <div style="display:flex; gap:20px; margin-bottom:16px; padding-bottom:14px; border-bottom:1px solid ${t.line};">
            <div><div style="font-size:11px; color:${t.muted}; font-weight:700; text-transform:uppercase;">BCI</div><div style="font-size:19px; font-weight:700;">${bci.vanilla.bciAv != null ? bci.vanilla.bciAv.toFixed(1) : '—'}</div></div>
            <div><div style="font-size:11px; color:${t.muted}; font-weight:700; text-transform:uppercase;">MDCI</div><div style="font-size:19px; font-weight:700;">${bci.mdci.bciAv != null ? bci.mdci.bciAv.toFixed(1) : '—'}</div></div>
          </div>
        ` : ''}
        <div style="display:flex; gap:24px; margin-bottom:16px;">
          <div><div style="font-size:22px; font-weight:700;">${stats.elementCount}</div><div style="font-size:11.5px; color:${t.muted};">Elements</div></div>
          <div><div style="font-size:22px; font-weight:700;">${stats.findingCount}</div><div style="font-size:11.5px; color:${t.muted};">Findings</div></div>
          <div><div style="font-size:22px; font-weight:700; color:${t.red};">${stats.worksRequiredCount}</div><div style="font-size:11.5px; color:${t.muted};">Works required</div></div>
        </div>
        <div style="display:flex; height:10px; border-radius:5px; overflow:hidden; background:${t.line};">${barSegments}</div>
        <div style="display:flex; justify-content:space-between; margin-top:6px; font-size:10.5px; color:${t.muted};">
          <span>As New</span><span>Failed</span>
        </div>
      </div>

      <div style="grid-column:1 / -1; background:#fff; border:1px solid ${t.line}; border-radius:14px; padding:18px 20px;">
        <div style="font-size:15px; font-weight:650; margin-bottom:14px;">Report Sections</div>
        <div style="display:flex; flex-wrap:wrap; gap:8px;">
          ${reportSections.length ? reportSections.map((s) => {
            const info = REPORT_SECTION_TYPES[s.type] || { label: s.type };
            return `<span style="background:${t.page}; border:1px solid ${t.line}; border-radius:20px; padding:6px 14px; font-size:12.5px; font-weight:600;">${esc(s.title) || esc(info.label)}</span>`;
          }).join('') : `<span style="color:${t.muted}; font-size:13px;">No report sections yet.</span>`}
        </div>
      </div>
    </div>
  `;
}


// ============================================================================
// Phase 4: Elements tab, Element Drawer, and Finding Sheet.
//
// The Drawer and Finding Sheet are appended directly to document.body (not
// appEl), matching the design's own layered-overlay model — a backdrop
// covering the whole shell, with the Finding Sheet able to stack on top of
// the Drawer rather than replacing it. This mirrors how the rest of the app
// already handles sheets/overlays (presentOverlay), just outside appEl's own
// remount cycle so the shell underneath is never touched.
// ============================================================================

async function shellRenderElementsTab(content) {
  const t = SHELL_TOKENS;
  const insp = await DB.get('inspections', shellState.selectedInspectionId);
  const isGiBridges = insp.inspectionType === 'GI Bridges';
  const sections = await DB.listSections(insp.id);
  const elements = await DB.listElements(insp.id);

  const worstByElement = {};
  for (const el2 of elements) {
    worstByElement[el2.id] = await shellWorstFindingForElement(el2.id);
  }

  const groups = sections.map((sec) => ({ section: sec, elements: elements.filter((e) => e.sectionId === sec.id) }));
  const ungrouped = elements.filter((e) => !e.sectionId);
  if (ungrouped.length) groups.push({ section: null, elements: ungrouped });

  const renderRow = (elmt) => {
    const subline = elementSublineParts(elmt, isGiBridges).join(' · ');
    const worst = worstByElement[elmt.id];
    return `
      <div class="shell-el-row" data-id="${elmt.id}" style="display:flex; align-items:center; gap:10px; background:#fff; border:1px solid ${t.line}; border-radius:12px; padding:12px 14px; margin-bottom:8px; cursor:pointer;">
        <div style="flex:1; min-width:0;">
          <div style="font-size:14.5px; font-weight:650;">${esc(elmt.name)}</div>
          ${subline ? `<div style="font-size:12.5px; color:${t.muted}; margin-top:2px;">${esc(subline)}</div>` : ''}
        </div>
        ${worst ? `<span style="background:${t.sev[worst.severity]}; color:#fff; border-radius:20px; padding:3px 10px; font-size:11.5px; font-weight:700; flex-shrink:0;">${worst.severity}${worst.extent || ''}</span>` : ''}
        <span style="color:${t.muted}; font-size:16px; flex-shrink:0;">›</span>
      </div>
    `;
  };

  content.innerHTML = `
    <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:16px;">
      <div style="font-size:15px; font-weight:650;">Elements</div>
      <button id="shell-el-add" style="background:${t.ink}; color:#fff; border:none; border-radius:8px; padding:8px 14px; font-size:13px; font-weight:650;">+ Add</button>
    </div>
    ${groups.length ? groups.map((g) => `
      <div style="margin-bottom:20px;">
        <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:8px;">
          <div style="font-size:11px; font-weight:700; letter-spacing:0.5px; text-transform:uppercase; color:${t.muted};">${esc(g.section ? g.section.name : 'Ungrouped')}</div>
          ${g.section ? `<button class="shell-el-add-to-section" data-section="${g.section.id}" style="background:none; border:none; color:${t.muted}; font-size:12px; font-weight:600;">+ Add element</button>` : ''}
        </div>
        ${g.elements.length ? g.elements.map(renderRow).join('') : `<div style="color:${t.muted}; font-size:13px; padding:4px 0;">No elements yet.</div>`}
      </div>
    `).join('') : `<div style="color:${t.muted}; font-size:14px;">No elements yet — tap + Add to get started.</div>`}
  `;

  document.getElementById('shell-el-add').addEventListener('click', shellOpenAddMenu);
  content.querySelectorAll('.shell-el-add-to-section').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openAddElementSheet(insp.id, btn.dataset.section, { onDone: () => renderShellTabContent() });
    });
  });
  content.querySelectorAll('.shell-el-row').forEach((row) => {
    row.addEventListener('click', () => shellOpenElementDrawer(row.dataset.id));
  });
}

function shellOpenAddMenu() {
  const insp = { id: shellState.selectedInspectionId };
  const sheet = el(`
    <div class="sheet-backdrop">
      <div class="sheet">
        <div class="sheet-handle"></div>
        <h2>Add</h2>
        <button class="btn btn-secondary btn-block" id="shell-menu-section">New Section</button>
        <button class="btn btn-secondary btn-block" id="shell-menu-element" style="margin-top:10px;">New Element</button>
        <button class="btn btn-ghost btn-block" id="shell-menu-cancel" style="margin-top:10px;">Cancel</button>
      </div>
    </div>
  `);
  presentOverlay(sheet);
  sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.remove(); });
  sheet.querySelector('#shell-menu-cancel').addEventListener('click', () => sheet.remove());
  sheet.querySelector('#shell-menu-section').addEventListener('click', () => {
    sheet.remove();
    openAddSectionSheet(insp.id, () => renderShellTabContent());
  });
  sheet.querySelector('#shell-menu-element').addEventListener('click', () => {
    sheet.remove();
    openAddElementSheet(insp.id, null, { onDone: () => renderShellTabContent() });
  });
}

// Highest-severity finding for one element, paired with its own extent (not the
// independently-worst extent) — used for the Elements tab's severity/extent badge.
async function shellWorstFindingForElement(elementId) {
  const findings = await DB.listFindings(elementId);
  let worst = null;
  findings.forEach((f) => {
    if (f.severity && (!worst || f.severity > worst.severity)) worst = f;
  });
  return worst ? { severity: worst.severity, extent: worst.extent } : null;
}

let shellDrawerEl = null;

async function shellOpenElementDrawer(elementId) {
  shellCloseElementDrawer();
  const t = SHELL_TOKENS;
  const insp = await DB.get('inspections', shellState.selectedInspectionId);
  const isGiBridges = insp.inspectionType === 'GI Bridges';
  const elmt = await DB.get('elements', elementId);
  if (!elmt) return;
  const findings = await DB.listFindings(elementId);
  const photos = await DB.listPhotosForElement(elementId);
  const subline = elementSublineParts(elmt, isGiBridges).join(' · ');

  const backdrop = el(`
    <div id="shell-drawer-backdrop" style="position:fixed; inset:0; background:rgba(20,22,28,0.32); z-index:200; display:flex; justify-content:flex-end;">
      <div id="shell-drawer-panel" style="width:440px; max-width:92vw; height:100%; background:#fff; box-shadow:-16px 0 40px rgba(0,0,0,0.16); display:flex; flex-direction:column; box-sizing:border-box;">
        <div style="padding:18px 20px; border-bottom:1px solid ${t.line}; display:flex; align-items:flex-start; justify-content:space-between; gap:10px; flex-shrink:0;">
          <div style="min-width:0;">
            <div style="font-size:17px; font-weight:700;">${esc(elmt.name)}</div>
            ${subline ? `<div style="font-size:12.5px; color:${t.muted}; margin-top:2px;">${esc(subline)}</div>` : ''}
            <button id="shell-drawer-edit" style="background:none; border:none; color:${t.muted}; font-size:12px; font-weight:650; padding:6px 0 0;">Edit</button>
          </div>
          <button id="shell-drawer-close" style="background:none; border:none; font-size:20px; color:${t.muted}; flex-shrink:0;">✕</button>
        </div>
        <div style="flex:1; min-height:0; overflow-y:auto; padding:18px 20px;">
          <div style="font-size:11px; font-weight:700; letter-spacing:0.5px; text-transform:uppercase; color:${t.muted}; margin-bottom:10px;">Findings</div>
          <div id="shell-drawer-findings"></div>
          <button id="shell-drawer-add-finding" style="width:100%; border:1.5px dashed ${t.line}; background:none; border-radius:10px; padding:12px; font-size:13.5px; font-weight:650; color:${t.muted}; margin-top:4px;">+ Add finding</button>

          <div style="font-size:11px; font-weight:700; letter-spacing:0.5px; text-transform:uppercase; color:${t.muted}; margin:22px 0 10px;">Element Photos</div>
          <div id="shell-drawer-photos" style="display:grid; grid-template-columns:repeat(4,1fr); gap:8px;"></div>
        </div>
      </div>
    </div>
  `);
  document.body.appendChild(backdrop);
  shellDrawerEl = backdrop;

  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) shellCloseElementDrawer(); });
  document.getElementById('shell-drawer-close').addEventListener('click', shellCloseElementDrawer);
  document.getElementById('shell-drawer-edit').addEventListener('click', () => {
    openEditElementSheet(insp.id, elmt, null, {
      onSaved: () => shellOpenElementDrawer(elementId),
      onDeleted: () => { shellCloseElementDrawer(); renderShellTabContent(); }
    });
  });

  const renderFindings = (list) => {
    const box = document.getElementById('shell-drawer-findings');
    box.innerHTML = list.length ? list.map((f) => `
      <div class="shell-finding-card" data-id="${f.id}" style="background:${t.page}; border-radius:10px; padding:12px; margin-bottom:8px; cursor:pointer;">
        <div style="display:flex; gap:6px; margin-bottom:6px;">
          ${f.severity ? `<span style="background:${t.sev[f.severity]}; color:#fff; border-radius:20px; padding:2px 9px; font-size:11px; font-weight:700;">Sev ${f.severity}</span>` : ''}
          ${f.extent ? `<span style="background:${t.ink}; color:#fff; border-radius:20px; padding:2px 9px; font-size:11px; font-weight:700;">${f.extent}</span>` : ''}
        </div>
        <div style="font-size:13px; color:${t.muted}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${esc(f.notes) || 'No notes'}</div>
      </div>
    `).join('') : `<div style="color:${t.muted}; font-size:13px;">No findings yet.</div>`;
    box.querySelectorAll('.shell-finding-card').forEach((card) => {
      card.addEventListener('click', () => shellOpenFindingSheet(elementId, card.dataset.id));
    });
  };
  renderFindings(findings);

  document.getElementById('shell-drawer-add-finding').addEventListener('click', async () => {
    const f = await DB.createFinding(elementId, {});
    shellOpenFindingSheet(elementId, f.id);
  });

  const renderPhotos = (list) => {
    const grid = document.getElementById('shell-drawer-photos');
    grid.innerHTML = list.map((p) => `
      <div class="shell-el-photo" data-id="${p.id}" style="aspect-ratio:1; border-radius:8px; overflow:hidden; cursor:pointer; background:${t.line};">
        <img src="${blobUrl(p.annotatedBlob || p.originalBlob)}" style="width:100%; height:100%; object-fit:cover;">
      </div>
    `).join('') + `
      <div id="shell-el-photo-add" style="aspect-ratio:1; border-radius:8px; border:1.5px dashed ${t.line}; display:flex; align-items:center; justify-content:center; color:${t.muted}; font-size:22px; cursor:pointer;">+</div>
    `;
    grid.querySelectorAll('.shell-el-photo').forEach((tile) => {
      tile.addEventListener('click', async () => {
        await openAnnotator(tile.dataset.id, async () => {
          const updated = await DB.listPhotosForElement(elementId);
          renderPhotos(updated);
        });
      });
    });
    document.getElementById('shell-el-photo-add').addEventListener('click', () => {
      openPhotoSourceSheet({
        multiple: true,
        onFiles: async (files) => {
          for (const file of Array.from(files)) {
            const normalized = await normalizeImageFile(file);
            await DB.addPhoto({ kind: 'element', elementId, originalBlob: normalized, order: list.length });
          }
          renderPhotos(await DB.listPhotosForElement(elementId));
        },
        onSketch: async () => {
          const blank = await createBlankCanvasBlob();
          const photo = await DB.addPhoto({ kind: 'element', elementId, originalBlob: blank, order: list.length });
          await openAnnotator(photo.id, async () => renderPhotos(await DB.listPhotosForElement(elementId)));
        }
      });
    });
  };
  renderPhotos(photos);

  shellDrawerEl._refreshFindings = async () => renderFindings(await DB.listFindings(elementId));
}

function shellCloseElementDrawer() {
  if (shellDrawerEl) { shellDrawerEl.remove(); shellDrawerEl = null; }
}

async function shellOpenFindingSheet(elementId, findingId) {
  const t = SHELL_TOKENS;
  const insp = await DB.get('inspections', shellState.selectedInspectionId);
  const isSafety = insp.inspectionType === 'Safety Inspection';
  let finding = await DB.get('findings', findingId);
  const currencySymbol = CURRENCY_SYMBOLS[insp.currency] || '$';
  let photos = await DB.listPhotosForFinding(findingId);

  const showDetail = !isSafety || finding.showDetail;
  const showWorks = !isSafety || finding.showWorks;

  const backdrop = el(`
    <div id="shell-finding-backdrop" style="position:fixed; inset:0; background:rgba(20,22,28,0.4); z-index:300; display:flex; align-items:center; justify-content:center; padding:20px; box-sizing:border-box;">
      <div style="width:600px; max-width:100%; max-height:760px; background:#fff; border-radius:16px; display:flex; flex-direction:column; box-shadow:0 30px 60px rgba(0,0,0,0.3); overflow:hidden;">
        <div style="padding:16px 20px; border-bottom:1px solid ${t.line}; display:flex; align-items:center; justify-content:space-between; flex-shrink:0;">
          <button id="shell-finding-back" style="background:none; border:none; font-size:15px; font-weight:650; color:${t.muted};">‹</button>
          <div style="font-size:15px; font-weight:650;">Finding</div>
          <button id="shell-finding-delete" style="background:none; border:none; font-size:13px; font-weight:650; color:${t.red};">Delete</button>
        </div>
        <div id="shell-finding-body" style="flex:1; min-height:0; overflow-y:auto; padding:20px;"></div>
      </div>
    </div>
  `);
  document.body.appendChild(backdrop);

  document.getElementById('shell-finding-back').addEventListener('click', closeSheet);
  document.getElementById('shell-finding-delete').addEventListener('click', async () => {
    if (!confirm('Delete this finding?')) return;
    await DB.deleteFindingCascade(findingId);
    closeSheet();
    if (shellDrawerEl && shellDrawerEl._refreshFindings) shellDrawerEl._refreshFindings();
  });

  function closeSheet() { backdrop.remove(); }

  function renderBody() {
    const body = document.getElementById('shell-finding-body');
    body.innerHTML = `
      ${isSafety ? `
        <label style="display:flex; align-items:center; gap:8px; font-size:13.5px; margin-bottom:14px;">
          <input type="checkbox" id="f-show-detail" ${finding.showDetail ? 'checked' : ''} style="width:19px; height:19px;"> Add severity / extent
        </label>
      ` : ''}
      <div id="detail-fields" style="${showDetail ? '' : 'display:none;'}">
        <div style="font-size:12px; font-weight:700; text-transform:uppercase; color:${t.muted}; margin-bottom:8px;">Severity</div>
        <div style="display:flex; gap:6px; margin-bottom:16px;">
          ${[1, 2, 3, 4, 5].map((s) => `
            <button class="shell-chip-sev" data-v="${s}" style="flex:1; padding:10px 0; border-radius:9px; border:2px solid ${finding.severity === s ? 'transparent' : t.line}; background:${finding.severity === s ? t.sev[s] : '#fff'}; color:${finding.severity === s ? '#fff' : '#000'};">
              <div style="font-size:15px; font-weight:750;">${s}</div>
            </button>
          `).join('')}
        </div>
        <div style="font-size:12px; font-weight:700; text-transform:uppercase; color:${t.muted}; margin-bottom:8px;">Extent</div>
        <div style="display:flex; gap:6px; margin-bottom:16px;">
          ${['A', 'B', 'C', 'D', 'E'].map((x) => `
            <button class="shell-chip-ext" data-v="${x}" style="flex:1; padding:10px 0; border-radius:9px; border:2px solid ${finding.extent === x ? 'transparent' : t.line}; background:${finding.extent === x ? t.ink : '#fff'}; color:${finding.extent === x ? '#fff' : '#000'};">
              <div style="font-size:15px; font-weight:750;">${x}</div>
            </button>
          `).join('')}
        </div>
        <div style="font-size:12px; font-weight:700; text-transform:uppercase; color:${t.muted}; margin-bottom:8px;">Priority</div>
        <div style="display:flex; gap:6px; margin-bottom:18px;">
          ${['High', 'Medium', 'Low', 'Monitor'].map((p) => `
            <button class="shell-chip-pri" data-v="${p}" style="flex:1; padding:10px 6px; border-radius:9px; border:2px solid ${finding.priority === p ? 'transparent' : t.line}; background:${finding.priority === p ? PRIORITY_UI_COLORS[p] : '#fff'}; color:${finding.priority === p ? '#fff' : '#000'}; font-size:12px; font-weight:650;">${p}</button>
          `).join('')}
        </div>
      </div>

      ${isSafety ? `
        <label style="display:flex; align-items:center; gap:8px; font-size:13.5px; margin-bottom:10px;">
          <input type="checkbox" id="f-show-works" ${finding.showWorks ? 'checked' : ''} style="width:19px; height:19px;"> Add works required
        </label>
      ` : ''}
      <div id="works-section" style="${showWorks ? '' : 'display:none;'}">
        <label style="display:flex; align-items:center; gap:8px; font-size:13.5px; margin-bottom:12px;">
          <input type="checkbox" id="f-works-required" ${finding.worksRequired ? 'checked' : ''} style="width:19px; height:19px;"> Works required
        </label>
        <div id="works-detail" style="${finding.worksRequired ? '' : 'display:none;'} margin-bottom:16px;">
          <textarea id="f-works-desc" placeholder="Describe the works required…" style="width:100%; min-height:70px; border:1px solid ${t.line}; border-radius:8px; padding:10px; font-size:14px; box-sizing:border-box;">${esc(finding.worksDescription)}</textarea>
          <div style="display:flex; align-items:center; gap:8px; margin-top:8px;">
            <span style="font-size:16px; font-weight:700;">${currencySymbol}</span>
            <input type="text" id="f-cost" value="${esc(finding.costEstimate)}" placeholder="e.g. 12,500" style="flex:1; border:1px solid ${t.line}; border-radius:8px; padding:9px 11px; font-size:14px;">
          </div>
        </div>
      </div>

      <div style="font-size:12px; font-weight:700; text-transform:uppercase; color:${t.muted}; margin-bottom:8px;">Notes</div>
      <textarea id="f-notes" style="width:100%; min-height:90px; border:1px solid ${t.line}; border-radius:8px; padding:10px; font-size:14px; box-sizing:border-box; margin-bottom:18px;">${esc(finding.notes)}</textarea>

      <div style="font-size:12px; font-weight:700; text-transform:uppercase; color:${t.muted}; margin-bottom:8px;">Photos</div>
      <div id="shell-finding-photos" style="display:grid; grid-template-columns:repeat(5,1fr); gap:7px;"></div>
    `;
    wireBody();
    renderFindingPhotos();
  }

  async function persist(patch) {
    finding = await DB.updateFinding(findingId, patch);
    if (shellDrawerEl && shellDrawerEl._refreshFindings) shellDrawerEl._refreshFindings();
  }

  function wireBody() {
    const body = document.getElementById('shell-finding-body');
    body.querySelectorAll('.shell-chip-sev').forEach((btn) => btn.addEventListener('click', async () => {
      const v = Number(btn.dataset.v);
      await persist({ severity: finding.severity === v ? null : v });
      renderBody();
    }));
    body.querySelectorAll('.shell-chip-ext').forEach((btn) => btn.addEventListener('click', async () => {
      await persist({ extent: finding.extent === btn.dataset.v ? null : btn.dataset.v });
      renderBody();
    }));
    body.querySelectorAll('.shell-chip-pri').forEach((btn) => btn.addEventListener('click', async () => {
      await persist({ priority: finding.priority === btn.dataset.v ? null : btn.dataset.v });
      renderBody();
    }));
    const showDetailCb = body.querySelector('#f-show-detail');
    if (showDetailCb) showDetailCb.addEventListener('change', async (e) => {
      await persist({ showDetail: e.target.checked });
      renderBody();
    });
    const showWorksCb = body.querySelector('#f-show-works');
    if (showWorksCb) showWorksCb.addEventListener('change', async (e) => {
      await persist({ showWorks: e.target.checked });
      renderBody();
    });
    const worksRequiredCb = body.querySelector('#f-works-required');
    if (worksRequiredCb) worksRequiredCb.addEventListener('change', async (e) => {
      await persist({ worksRequired: e.target.checked });
      renderBody();
    });
    const notesEl = body.querySelector('#f-notes');
    if (notesEl) shellWireAutosaveField(notesEl, (val) => persist({ notes: val }));
    const worksDescEl = body.querySelector('#f-works-desc');
    if (worksDescEl) shellWireAutosaveField(worksDescEl, (val) => persist({ worksDescription: val }));
    const costEl = body.querySelector('#f-cost');
    if (costEl) shellWireAutosaveField(costEl, (val) => persist({ costEstimate: val }));
  }

  function renderFindingPhotos() {
    const grid = document.getElementById('shell-finding-photos');
    grid.innerHTML = photos.map((p) => `
      <div class="shell-f-photo" data-id="${p.id}" style="position:relative; aspect-ratio:1; border-radius:8px; overflow:hidden; cursor:pointer; background:${t.line};">
        <img src="${blobUrl(p.annotatedBlob || p.originalBlob)}" style="width:100%; height:100%; object-fit:cover;">
        ${p.annotatedBlob ? `<div style="position:absolute; top:4px; right:4px; width:8px; height:8px; border-radius:50%; background:${t.red}; border:1.5px solid #fff;"></div>` : ''}
      </div>
    `).join('') + `
      <div id="shell-f-photo-add" style="aspect-ratio:1; border-radius:8px; border:1.5px dashed ${t.line}; display:flex; align-items:center; justify-content:center; color:${t.muted}; font-size:20px; cursor:pointer;">+</div>
    `;
    grid.querySelectorAll('.shell-f-photo').forEach((tile) => {
      tile.addEventListener('click', async () => {
        await openAnnotator(tile.dataset.id, async () => {
          photos = await DB.listPhotosForFinding(findingId);
          renderFindingPhotos();
        });
      });
    });
    document.getElementById('shell-f-photo-add').addEventListener('click', () => {
      openPhotoSourceSheet({
        multiple: true,
        onFiles: async (files) => {
          for (const file of Array.from(files)) {
            const normalized = await normalizeImageFile(file);
            await DB.addPhoto({ kind: 'finding', findingId, originalBlob: normalized, order: photos.length });
          }
          photos = await DB.listPhotosForFinding(findingId);
          renderFindingPhotos();
        },
        onSketch: async () => {
          const blank = await createBlankCanvasBlob();
          const photo = await DB.addPhoto({ kind: 'finding', findingId, originalBlob: blank, order: photos.length });
          await openAnnotator(photo.id, async () => { photos = await DB.listPhotosForFinding(findingId); renderFindingPhotos(); });
        }
      });
    });
  }

  renderBody();
}

// Debounced autosave + flush-on-blur for free-text fields — matches the pattern already
// established for the Report tab's section editors, so jumping away mid-sentence is always
// safe here too.
function shellWireAutosaveField(el2, save) {
  let debounce = null;
  el2.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => save(el2.value), 700);
  });
  el2.addEventListener('blur', () => {
    clearTimeout(debounce);
    save(el2.value);
  });
}

const PRIORITY_UI_COLORS = {
  High: SHELL_TOKENS.sev[5],
  Medium: SHELL_TOKENS.sev[4],
  Low: SHELL_TOKENS.sev[1],
  Monitor: 'oklch(0.58 0.13 240)'
};

// ============================================================================
// Phase 5: Drawings and Appendices tabs — quick-access views into the SAME
// underlying Drawing/Appendices-type report sections New Style already uses
// (per an explicit decision: consistent with how Elements tab already works
// as a shortcut into Inspection Findings, not a separate concept). A fresh
// inspection may have zero such sections yet, since New Style requires
// explicitly adding them — resolved transparently below (auto-create if
// none, use directly if exactly one, ask if several) rather than forcing a
// trip through the Report tab just to add a first drawing.
// ============================================================================

async function shellResolveOrCreateSection(insp, type, defaultTitle) {
  const sections = (await DB.listReportSections(insp.id)).filter((s) => s.type === type);
  if (sections.length === 1) return sections[0];
  if (sections.length === 0) return DB.addReportSection(insp.id, type, defaultTitle);
  return new Promise((resolve) => {
    const t = SHELL_TOKENS;
    const sheet = el(`
      <div class="sheet-backdrop">
        <div class="sheet">
          <div class="sheet-handle"></div>
          <h2>Which section?</h2>
          ${sections.map((s) => `<button class="shell-section-pick" data-id="${s.id}" style="width:100%; text-align:left; background:${t.page}; border:1px solid ${t.line}; border-radius:10px; padding:12px 14px; margin-top:8px; font-size:14px; font-weight:600;">${esc(s.title) || defaultTitle}</button>`).join('')}
        </div>
      </div>
    `);
    presentOverlay(sheet);
    sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.remove(); });
    sheet.querySelectorAll('.shell-section-pick').forEach((btn) => {
      btn.addEventListener('click', () => {
        sheet.remove();
        resolve(sections.find((s) => s.id === btn.dataset.id));
      });
    });
  });
}

async function shellRenderDrawingsTab(content) {
  const t = SHELL_TOKENS;
  const insp = await DB.get('inspections', shellState.selectedInspectionId);
  const drawSections = (await DB.listReportSections(insp.id)).filter((s) => s.type === 'drawing');
  const grouped = [];
  for (const sec of drawSections) {
    const drawings = await DB.listSectionDrawings(sec.id);
    if (drawings.length) grouped.push({ section: sec, drawings });
  }

  content.innerHTML = `
    <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:16px;">
      <div style="font-size:15px; font-weight:650;">Drawings</div>
      <button id="shell-draw-add" style="background:${t.ink}; color:#fff; border:none; border-radius:8px; padding:8px 14px; font-size:13px; font-weight:650;">+ Add</button>
    </div>
    ${grouped.length ? grouped.map((g) => `
      <div style="margin-bottom:20px;">
        <div style="font-size:11px; font-weight:700; letter-spacing:0.5px; text-transform:uppercase; color:${t.muted}; margin-bottom:8px;">${esc(g.section.title) || 'Drawings'}</div>
        <div style="display:grid; grid-template-columns:repeat(3,1fr); gap:12px;">
          ${g.drawings.map((d) => `
            <div class="shell-drawing-card" data-id="${d.id}" style="cursor:pointer;">
              <div style="height:120px; border-radius:10px; overflow:hidden; background:repeating-linear-gradient(45deg, ${t.line}, ${t.line} 6px, #fff 6px, #fff 12px); border:1px solid ${t.line};">
                <img src="${blobUrl(d.annotatedBlob || d.originalBlob)}" style="width:100%; height:100%; object-fit:cover;">
              </div>
              <div style="font-size:12.5px; font-weight:600; margin-top:6px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${esc(d.title) || 'Untitled'}</div>
            </div>
          `).join('')}
        </div>
      </div>
    `).join('') : `<div style="color:${t.muted}; font-size:14px;">No drawings yet — tap + Add to get started.</div>`}
  `;

  document.getElementById('shell-draw-add').addEventListener('click', async () => {
    const sec = await shellResolveOrCreateSection(insp, 'drawing', 'Drawings');
    openAddSectionDrawingSheet(insp.id, sec.id, () => renderShellTabContent());
  });
  content.querySelectorAll('.shell-drawing-card').forEach((card) => {
    card.addEventListener('click', async () => {
      const allDrawings = grouped.flatMap((g) => g.drawings);
      const d = allDrawings.find((x) => x.id === card.dataset.id);
      openDrawingDetailSheet(d, { onChanged: () => renderShellTabContent() });
    });
  });
}

async function shellRenderAppendicesTab(content) {
  const t = SHELL_TOKENS;
  const insp = await DB.get('inspections', shellState.selectedInspectionId);
  const apxSections = (await DB.listReportSections(insp.id)).filter((s) => s.type === 'appendices');
  const grouped = [];
  for (const sec of apxSections) {
    const appendices = await DB.listSectionAppendices(sec.id);
    if (appendices.length) grouped.push({ section: sec, appendices });
  }

  content.innerHTML = `
    <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:16px;">
      <div style="font-size:15px; font-weight:650;">Appendices</div>
      <button id="shell-apx-add" style="background:${t.ink}; color:#fff; border:none; border-radius:8px; padding:8px 14px; font-size:13px; font-weight:650;">+ Add</button>
    </div>
    ${grouped.length ? grouped.map((g) => `
      <div style="margin-bottom:16px;">
        <div style="font-size:11px; font-weight:700; letter-spacing:0.5px; text-transform:uppercase; color:${t.muted}; margin-bottom:8px;">${esc(g.section.title) || 'Appendices'}</div>
        ${g.appendices.map((a) => `
          <div class="shell-apx-row" data-id="${a.id}" data-section="${g.section.id}" style="display:flex; align-items:center; justify-content:space-between; background:#fff; border:1px solid ${t.line}; border-radius:10px; padding:12px 14px; margin-bottom:6px; cursor:pointer;">
            <span style="font-size:14px; font-weight:600;">${esc(a.name)}</span>
            <span style="color:${t.muted};">›</span>
          </div>
        `).join('')}
      </div>
    `).join('') : `<div style="color:${t.muted}; font-size:14px;">No appendices yet — tap + Add to get started.</div>`}
  `;

  document.getElementById('shell-apx-add').addEventListener('click', async () => {
    const sec = await shellResolveOrCreateSection(insp, 'appendices', 'Appendices');
    const name = prompt('Appendix name (e.g. "Appendix A: Photos")');
    if (!name || !name.trim()) return;
    await DB.addSectionAppendix(sec.id, name.trim());
    renderShellTabContent();
  });
  content.querySelectorAll('.shell-apx-row').forEach((row) => {
    row.addEventListener('click', () => shellOpenAppendixItems(row.dataset.section, row.dataset.id));
  });
}

async function shellOpenAppendixItems(reportSectionId, appendixId) {
  const t = SHELL_TOKENS;
  const insp = await DB.get('inspections', shellState.selectedInspectionId);
  const appendices = await DB.listSectionAppendices(reportSectionId);
  const apx = appendices.find((a) => a.id === appendixId);
  if (!apx) return;
  let items = await DB.listAppendixItems(appendixId);

  const backdrop = el(`
    <div id="shell-apx-backdrop" style="position:fixed; inset:0; background:rgba(20,22,28,0.4); z-index:300; display:flex; align-items:center; justify-content:center; padding:20px; box-sizing:border-box;">
      <div style="width:520px; max-width:100%; max-height:700px; background:#fff; border-radius:16px; display:flex; flex-direction:column; box-shadow:0 30px 60px rgba(0,0,0,0.3); overflow:hidden;">
        <div style="padding:16px 20px; border-bottom:1px solid ${t.line}; display:flex; align-items:center; justify-content:space-between; flex-shrink:0;">
          <div style="font-size:15px; font-weight:650;">${esc(apx.name)}</div>
          <button id="shell-apx-close" style="background:none; border:none; font-size:18px; color:${t.muted};">✕</button>
        </div>
        <div id="shell-apx-items" style="flex:1; min-height:0; overflow-y:auto; padding:16px 20px;"></div>
        <div style="padding:14px 20px; border-top:1px solid ${t.line}; flex-shrink:0;">
          <button id="shell-apx-add-item" style="width:100%; background:${SHELL_TOKENS.ink}; color:#fff; border:none; border-radius:9px; padding:11px; font-size:13.5px; font-weight:650;">+ Add item</button>
        </div>
      </div>
    </div>
  `);
  document.body.appendChild(backdrop);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.remove(); });
  document.getElementById('shell-apx-close').addEventListener('click', () => backdrop.remove());

  function renderItems() {
    const box = document.getElementById('shell-apx-items');
    box.innerHTML = items.length ? `<div style="display:grid; grid-template-columns:repeat(3,1fr); gap:10px;">${items.map((it) => `
      <div style="aspect-ratio:1; border-radius:8px; overflow:hidden; background:${t.line}; border:1px solid ${t.line};">
        <img src="${blobUrl(it.annotatedBlob || it.originalBlob)}" style="width:100%; height:100%; object-fit:cover;">
      </div>
    `).join('')}</div>` : `<div style="color:${t.muted}; font-size:13.5px;">No items yet.</div>`;
  }
  renderItems();

  document.getElementById('shell-apx-add-item').addEventListener('click', () => {
    openAddAppendixItemSheet(insp.id, appendixId, async () => {
      items = await DB.listAppendixItems(appendixId);
      renderItems();
    });
  });
}

// ============================================================================
// Phase 7: Risk Assessment tab.
//
// Two levels, matching what the real data model already tracks (a genuine
// gap found between the design prototype's simple hazard-card view and the
// actual document, which also carries company info, task description, staff,
// and an inspector sign-off/signature): document-level fields get their own
// editor here since the prototype didn't show them at all, and per-risk
// fields (who might be harmed, existing controls, control required,
// action-by, dates, sign-off) live in a detail sheet. Rating is a single
// Negligible/Low/Medium/High field per an explicit decision, replacing the
// old likelihood×severity multiplication — no migration needed since no
// existing inspections use it.
// ============================================================================

const SHELL_RATING_COLORS = {
  Negligible: 'oklch(0.7 0.03 150)',
  Low: SHELL_TOKENS.sev[1],
  Medium: SHELL_TOKENS.sev[4],
  High: SHELL_TOKENS.sev[5]
};

async function shellRenderRiskTab(content) {
  const t = SHELL_TOKENS;
  const insp = await DB.get('inspections', shellState.selectedInspectionId);
  const ra = await DB.getOrCreateRiskAssessment(insp.id);
  const risks = ra.risks || [];

  content.innerHTML = `
    <div style="background:#fff; border:1px solid ${t.line}; border-radius:14px; padding:16px 18px; margin-bottom:18px;">
      <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:10px;">
        <div style="font-size:14px; font-weight:650;">${esc(ra.assessmentTitle) || 'Risk Assessment'}</div>
        <button id="shell-ra-edit-doc" style="background:none; border:none; color:${t.muted}; font-size:12px; font-weight:650;">Edit details</button>
      </div>
      <div style="font-size:12.5px; color:${t.muted}; line-height:1.6;">
        ${ra.companyName ? esc(ra.companyName) + '<br>' : ''}
        ${ra.assessorName ? 'Assessor: ' + esc(ra.assessorName) + (ra.assessmentDate ? ' · ' + fmtDate(ra.assessmentDate) : '') + '<br>' : ''}
        ${ra.locationSiteAddress ? esc(ra.locationSiteAddress) : ''}
      </div>
    </div>
    <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:16px;">
      <div style="font-size:15px; font-weight:650;">Hazards</div>
      <button id="shell-ra-add" style="background:${t.ink}; color:#fff; border:none; border-radius:8px; padding:8px 14px; font-size:13px; font-weight:650;">+ Add</button>
    </div>
    ${risks.length ? risks.map((r) => `
      <div class="shell-risk-row" data-id="${r.id}" style="display:flex; align-items:center; gap:10px; background:#fff; border:1px solid ${t.line}; border-radius:12px; padding:12px 14px; margin-bottom:8px; cursor:pointer;">
        ${r.rating ? `<span style="background:${SHELL_RATING_COLORS[r.rating]}; color:#fff; border-radius:20px; padding:3px 10px; font-size:11.5px; font-weight:700; flex-shrink:0;">${r.rating}</span>` : ''}
        <div style="flex:1; min-width:0;">
          <div style="font-size:14px; font-weight:650;">${esc(r.hazardType) || 'Untitled hazard'}</div>
          ${r.controlRequired ? `<div style="font-size:12.5px; color:${t.muted}; margin-top:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${esc(r.controlRequired)}</div>` : ''}
        </div>
        <span style="color:${t.muted};">›</span>
      </div>
    `).join('') : `<div style="color:${t.muted}; font-size:14px;">No hazards logged for this inspection.</div>`}
  `;

  document.getElementById('shell-ra-edit-doc').addEventListener('click', () => shellOpenRiskDocFieldsSheet(ra.id));
  document.getElementById('shell-ra-add').addEventListener('click', async () => {
    const risks2 = [...(ra.risks || [])];
    const newRisk = { id: uid(), hazardType: '', description: '', whoMightBeHarmed: '', existingControls: '', rating: null, controlRequired: '', actionBy: '', targetDate: '', completionDate: '', signedOffByName: '' };
    risks2.push(newRisk);
    await DB.updateRiskAssessment(ra.id, { risks: risks2 });
    shellOpenRiskDetailSheet(newRisk.id);
  });
  content.querySelectorAll('.shell-risk-row').forEach((row) => {
    row.addEventListener('click', () => shellOpenRiskDetailSheet(row.dataset.id));
  });
}

async function shellOpenRiskDetailSheet(riskId) {
  const t = SHELL_TOKENS;
  const insp = await DB.get('inspections', shellState.selectedInspectionId);
  const ra = await DB.getOrCreateRiskAssessment(insp.id);
  let risk = (ra.risks || []).find((x) => x.id === riskId);
  if (!risk) return;
  const sigRole = `risk:${riskId}`;
  let sig = await DB.getSignature(ra.id, sigRole);

  const backdrop = el(`
    <div style="position:fixed; inset:0; background:rgba(20,22,28,0.4); z-index:300; display:flex; align-items:center; justify-content:center; padding:20px; box-sizing:border-box;">
      <div style="width:560px; max-width:100%; max-height:760px; background:#fff; border-radius:16px; display:flex; flex-direction:column; box-shadow:0 30px 60px rgba(0,0,0,0.3); overflow:hidden;">
        <div style="padding:16px 20px; border-bottom:1px solid ${t.line}; display:flex; align-items:center; justify-content:space-between; flex-shrink:0;">
          <button id="shell-risk-back" style="background:none; border:none; font-size:15px; font-weight:650; color:${t.muted};">‹</button>
          <div style="font-size:15px; font-weight:650;">Hazard</div>
          <button id="shell-risk-delete" style="background:none; border:none; font-size:13px; font-weight:650; color:${t.red};">Delete</button>
        </div>
        <div id="shell-risk-body" style="flex:1; min-height:0; overflow-y:auto; padding:20px;"></div>
      </div>
    </div>
  `);
  document.body.appendChild(backdrop);
  document.getElementById('shell-risk-back').addEventListener('click', () => backdrop.remove());
  document.getElementById('shell-risk-delete').addEventListener('click', async () => {
    if (!confirm('Delete this hazard?')) return;
    await DB.removeSignature(ra.id, sigRole);
    const risks2 = (ra.risks || []).filter((x) => x.id !== riskId);
    await DB.updateRiskAssessment(ra.id, { risks: risks2 });
    backdrop.remove();
    renderShellTabContent();
  });

  async function persist(patch) {
    const fresh = await DB.getOrCreateRiskAssessment(insp.id);
    const risks2 = [...(fresh.risks || [])];
    const idx = risks2.findIndex((x) => x.id === riskId);
    if (idx < 0) return;
    risks2[idx] = { ...risks2[idx], ...patch };
    risk = risks2[idx];
    await DB.updateRiskAssessment(ra.id, { risks: risks2 });
  }

  function renderBody() {
    const body = document.getElementById('shell-risk-body');
    body.innerHTML = `
      <div class="field"><label style="font-size:12px; font-weight:700; text-transform:uppercase; color:${t.muted};">Hazard type</label><input type="text" id="f-hazType" value="${esc(risk.hazardType)}" style="width:100%; border:1px solid ${t.line}; border-radius:8px; padding:9px 11px; font-size:14px; box-sizing:border-box; margin-top:4px;"></div>
      <div class="field" style="margin-top:12px;"><label style="font-size:12px; font-weight:700; text-transform:uppercase; color:${t.muted};">Description / location</label><textarea id="f-hazDesc" style="width:100%; min-height:60px; border:1px solid ${t.line}; border-radius:8px; padding:9px 11px; font-size:14px; box-sizing:border-box; margin-top:4px;">${esc(risk.description)}</textarea></div>
      <div class="field" style="margin-top:12px;"><label style="font-size:12px; font-weight:700; text-transform:uppercase; color:${t.muted};">Who might be harmed</label><textarea id="f-hazWho" style="width:100%; min-height:50px; border:1px solid ${t.line}; border-radius:8px; padding:9px 11px; font-size:14px; box-sizing:border-box; margin-top:4px;">${esc(risk.whoMightBeHarmed)}</textarea></div>
      <div class="field" style="margin-top:12px;"><label style="font-size:12px; font-weight:700; text-transform:uppercase; color:${t.muted};">Existing controls</label><textarea id="f-hazControls" style="width:100%; min-height:50px; border:1px solid ${t.line}; border-radius:8px; padding:9px 11px; font-size:14px; box-sizing:border-box; margin-top:4px;">${esc(risk.existingControls)}</textarea></div>

      <div style="font-size:12px; font-weight:700; text-transform:uppercase; color:${t.muted}; margin:16px 0 8px;">Rating</div>
      <div style="display:flex; gap:6px; margin-bottom:16px;">
        ${['Negligible', 'Low', 'Medium', 'High'].map((r) => `
          <button class="shell-rating-chip" data-v="${r}" style="flex:1; padding:10px 4px; border-radius:9px; border:2px solid ${risk.rating === r ? 'transparent' : t.line}; background:${risk.rating === r ? SHELL_RATING_COLORS[r] : '#fff'}; color:${risk.rating === r ? '#fff' : '#000'}; font-size:12px; font-weight:650;">${r}</button>
        `).join('')}
      </div>

      <div class="field"><label style="font-size:12px; font-weight:700; text-transform:uppercase; color:${t.muted};">Control required</label><textarea id="f-controlReq" style="width:100%; min-height:60px; border:1px solid ${t.line}; border-radius:8px; padding:9px 11px; font-size:14px; box-sizing:border-box; margin-top:4px;">${esc(risk.controlRequired)}</textarea></div>
      <div style="display:flex; gap:10px; margin-top:12px;">
        <div class="field" style="flex:1;"><label style="font-size:12px; font-weight:700; text-transform:uppercase; color:${t.muted};">Action by</label><input type="text" id="f-actionBy" value="${esc(risk.actionBy)}" style="width:100%; border:1px solid ${t.line}; border-radius:8px; padding:9px 11px; font-size:14px; box-sizing:border-box; margin-top:4px;"></div>
        <div class="field" style="flex:1;"><label style="font-size:12px; font-weight:700; text-transform:uppercase; color:${t.muted};">Target date</label><input type="date" id="f-targetDate" value="${esc(risk.targetDate)}" style="width:100%; border:1px solid ${t.line}; border-radius:8px; padding:9px 11px; font-size:14px; box-sizing:border-box; margin-top:4px;"></div>
      </div>
      <div style="display:flex; gap:10px; margin-top:12px;">
        <div class="field" style="flex:1;"><label style="font-size:12px; font-weight:700; text-transform:uppercase; color:${t.muted};">Completion date</label><input type="date" id="f-completionDate" value="${esc(risk.completionDate)}" style="width:100%; border:1px solid ${t.line}; border-radius:8px; padding:9px 11px; font-size:14px; box-sizing:border-box; margin-top:4px;"></div>
        <div class="field" style="flex:1;"><label style="font-size:12px; font-weight:700; text-transform:uppercase; color:${t.muted};">Signed off by</label><input type="text" id="f-signedOff" value="${esc(risk.signedOffByName)}" style="width:100%; border:1px solid ${t.line}; border-radius:8px; padding:9px 11px; font-size:14px; box-sizing:border-box; margin-top:4px;"></div>
      </div>
      <div style="margin-top:14px;">
        <label style="font-size:12px; font-weight:700; text-transform:uppercase; color:${t.muted};">Signature</label>
        <div id="shell-risk-sig" style="margin-top:6px;"></div>
      </div>
    `;
    wireBody();
    renderSig();
  }

  function renderSig() {
    const box = document.getElementById('shell-risk-sig');
    box.innerHTML = sig
      ? `<div id="shell-risk-sig-thumb" style="width:110px; height:46px; border:1px solid ${t.line}; border-radius:8px; overflow:hidden; cursor:pointer;"><img src="${blobUrl(sig.originalBlob)}" style="width:100%; height:100%; object-fit:contain; background:#fff;"></div>`
      : `<button id="shell-risk-sign-btn" style="background:${t.page}; border:1px solid ${t.line}; border-radius:8px; padding:8px 14px; font-size:13px; font-weight:650;">✍️ Sign</button>`;
    const signBtn = box.querySelector('#shell-risk-sign-btn');
    if (signBtn) signBtn.addEventListener('click', () => {
      openSignaturePad(null, async (blob) => { sig = await DB.setSignature(ra.id, sigRole, blob); renderSig(); });
    });
    const thumb = box.querySelector('#shell-risk-sig-thumb');
    if (thumb) thumb.addEventListener('click', () => {
      openSignaturePad(sig.originalBlob, async (blob) => { sig = await DB.setSignature(ra.id, sigRole, blob); renderSig(); });
    });
  }

  function wireBody() {
    const body = document.getElementById('shell-risk-body');
    body.querySelectorAll('.shell-rating-chip').forEach((btn) => btn.addEventListener('click', async () => {
      await persist({ rating: risk.rating === btn.dataset.v ? null : btn.dataset.v });
      renderBody();
    }));
    shellWireAutosaveField(body.querySelector('#f-hazType'), (v) => persist({ hazardType: v }));
    shellWireAutosaveField(body.querySelector('#f-hazDesc'), (v) => persist({ description: v }));
    shellWireAutosaveField(body.querySelector('#f-hazWho'), (v) => persist({ whoMightBeHarmed: v }));
    shellWireAutosaveField(body.querySelector('#f-hazControls'), (v) => persist({ existingControls: v }));
    shellWireAutosaveField(body.querySelector('#f-controlReq'), (v) => persist({ controlRequired: v }));
    shellWireAutosaveField(body.querySelector('#f-actionBy'), (v) => persist({ actionBy: v }));
    shellWireAutosaveField(body.querySelector('#f-targetDate'), (v) => persist({ targetDate: v }));
    shellWireAutosaveField(body.querySelector('#f-completionDate'), (v) => persist({ completionDate: v }));
    shellWireAutosaveField(body.querySelector('#f-signedOff'), (v) => persist({ signedOffByName: v }));
  }

  renderBody();
}

async function shellOpenRiskDocFieldsSheet(raId) {
  const t = SHELL_TOKENS;
  const insp = await DB.get('inspections', shellState.selectedInspectionId);
  let ra = await DB.get('riskAssessments', raId);
  const inspectorSigRole = 'inspector';
  let inspectorSig = await DB.getSignature(ra.id, inspectorSigRole);

  const backdrop = el(`
    <div style="position:fixed; inset:0; background:rgba(20,22,28,0.4); z-index:300; display:flex; align-items:center; justify-content:center; padding:20px; box-sizing:border-box;">
      <div style="width:560px; max-width:100%; max-height:760px; background:#fff; border-radius:16px; display:flex; flex-direction:column; box-shadow:0 30px 60px rgba(0,0,0,0.3); overflow:hidden;">
        <div style="padding:16px 20px; border-bottom:1px solid ${t.line}; display:flex; align-items:center; justify-content:space-between; flex-shrink:0;">
          <div style="font-size:15px; font-weight:650;">Risk Assessment details</div>
          <button id="shell-radoc-close" style="background:none; border:none; font-size:18px; color:${t.muted};">✕</button>
        </div>
        <div id="shell-radoc-body" style="flex:1; min-height:0; overflow-y:auto; padding:20px;"></div>
      </div>
    </div>
  `);
  document.body.appendChild(backdrop);
  document.getElementById('shell-radoc-close').addEventListener('click', () => { backdrop.remove(); renderShellTabContent(); });

  async function persist(patch) {
    ra = await DB.updateRiskAssessment(raId, patch);
  }

  function field(id, label, value, type = 'text') {
    return `<div class="field" style="margin-bottom:12px;"><label style="font-size:12px; font-weight:700; text-transform:uppercase; color:${t.muted};">${label}</label><input type="${type}" id="${id}" value="${esc(value)}" style="width:100%; border:1px solid ${t.line}; border-radius:8px; padding:9px 11px; font-size:14px; box-sizing:border-box; margin-top:4px;"></div>`;
  }

  function renderBody() {
    const body = document.getElementById('shell-radoc-body');
    body.innerHTML = `
      ${field('f-companyName', 'Company name', ra.companyName)}
      ${field('f-companyAddress', 'Company address', ra.companyAddress)}
      ${field('f-assessmentTitle', 'Assessment title', ra.assessmentTitle)}
      ${field('f-assessmentReference', 'Reference', ra.assessmentReference)}
      ${field('f-assessorName', 'Assessor name', ra.assessorName)}
      ${field('f-assessmentDate', 'Assessment date', ra.assessmentDate, 'date')}
      ${field('f-locationSiteAddress', 'Site address', ra.locationSiteAddress)}
      <div class="field" style="margin-bottom:12px;"><label style="font-size:12px; font-weight:700; text-transform:uppercase; color:${t.muted};">Task description</label><textarea id="f-taskDescription" style="width:100%; min-height:70px; border:1px solid ${t.line}; border-radius:8px; padding:9px 11px; font-size:14px; box-sizing:border-box; margin-top:4px;">${esc(ra.taskDescription)}</textarea></div>
      <div class="field" style="margin-bottom:12px;"><label style="font-size:12px; font-weight:700; text-transform:uppercase; color:${t.muted};">Responsible persons</label><textarea id="f-responsiblePersons" style="width:100%; min-height:50px; border:1px solid ${t.line}; border-radius:8px; padding:9px 11px; font-size:14px; box-sizing:border-box; margin-top:4px;">${esc(ra.responsiblePersons)}</textarea></div>

      <div style="font-size:12px; font-weight:700; text-transform:uppercase; color:${t.muted}; margin:16px 0 8px;">Additional staff</div>
      <div id="shell-radoc-staff"></div>
      <button id="shell-radoc-add-staff" style="background:none; border:1.5px dashed ${t.line}; border-radius:8px; padding:8px 14px; font-size:13px; font-weight:650; color:${t.muted}; width:100%; margin-top:6px;">+ Add staff</button>

      <div style="font-size:12px; font-weight:700; text-transform:uppercase; color:${t.muted}; margin:18px 0 8px;">Inspector sign-off</div>
      ${field('f-inspectorName', 'Inspector name', ra.inspectorName)}
      <div style="display:flex; gap:10px;">
        <div class="field" style="flex:1;"><label style="font-size:12px; font-weight:700; text-transform:uppercase; color:${t.muted};">Date</label><input type="date" id="f-inspectorDate" value="${esc(ra.inspectorDate)}" style="width:100%; border:1px solid ${t.line}; border-radius:8px; padding:9px 11px; font-size:14px; box-sizing:border-box; margin-top:4px;"></div>
        <div class="field" style="flex:1;"><label style="font-size:12px; font-weight:700; text-transform:uppercase; color:${t.muted};">Time</label><input type="time" id="f-inspectorTime" value="${esc(ra.inspectorTime)}" style="width:100%; border:1px solid ${t.line}; border-radius:8px; padding:9px 11px; font-size:14px; box-sizing:border-box; margin-top:4px;"></div>
      </div>
      <div style="margin-top:10px;">
        <label style="font-size:12px; font-weight:700; text-transform:uppercase; color:${t.muted};">Signature</label>
        <div id="shell-radoc-sig" style="margin-top:6px;"></div>
      </div>
    `;
    wireBody();
    renderStaff();
    renderInspectorSig();
  }

  function renderStaff() {
    const box = document.getElementById('shell-radoc-staff');
    const staff = ra.additionalStaff || [];
    box.innerHTML = staff.length ? staff.map((s) => `<div style="font-size:13.5px; padding:6px 0;">${esc(s.initials)}</div>`).join('') : `<div style="color:${t.muted}; font-size:13px;">None added.</div>`;
  }

  function renderInspectorSig() {
    const box = document.getElementById('shell-radoc-sig');
    box.innerHTML = inspectorSig
      ? `<div id="shell-radoc-sig-thumb" style="width:110px; height:46px; border:1px solid ${t.line}; border-radius:8px; overflow:hidden; cursor:pointer;"><img src="${blobUrl(inspectorSig.originalBlob)}" style="width:100%; height:100%; object-fit:contain; background:#fff;"></div>`
      : `<button id="shell-radoc-sign-btn" style="background:${t.page}; border:1px solid ${t.line}; border-radius:8px; padding:8px 14px; font-size:13px; font-weight:650;">✍️ Sign</button>`;
    const signBtn = box.querySelector('#shell-radoc-sign-btn');
    if (signBtn) signBtn.addEventListener('click', () => {
      openSignaturePad(null, async (blob) => { inspectorSig = await DB.setSignature(ra.id, inspectorSigRole, blob); renderInspectorSig(); });
    });
    const thumb = box.querySelector('#shell-radoc-sig-thumb');
    if (thumb) thumb.addEventListener('click', () => {
      openSignaturePad(inspectorSig.originalBlob, async (blob) => { inspectorSig = await DB.setSignature(ra.id, inspectorSigRole, blob); renderInspectorSig(); });
    });
  }

  function wireBody() {
    const body = document.getElementById('shell-radoc-body');
    const map = {
      'f-companyName': 'companyName', 'f-companyAddress': 'companyAddress', 'f-assessmentTitle': 'assessmentTitle',
      'f-assessmentReference': 'assessmentReference', 'f-assessorName': 'assessorName', 'f-assessmentDate': 'assessmentDate',
      'f-locationSiteAddress': 'locationSiteAddress', 'f-taskDescription': 'taskDescription', 'f-responsiblePersons': 'responsiblePersons',
      'f-inspectorName': 'inspectorName', 'f-inspectorDate': 'inspectorDate', 'f-inspectorTime': 'inspectorTime'
    };
    Object.entries(map).forEach(([id, key]) => {
      const el2 = body.querySelector('#' + id);
      if (el2) shellWireAutosaveField(el2, (v) => persist({ [key]: v }));
    });
    document.getElementById('shell-radoc-add-staff').addEventListener('click', async () => {
      const initials = prompt('Staff initials');
      if (!initials || !initials.trim()) return;
      const staff = [...(ra.additionalStaff || []), { id: uid(), initials: initials.trim() }];
      await persist({ additionalStaff: staff });
      renderStaff();
    });
  }

  renderBody();
}

// ============================================================================
// Phase 8: the Report tab — the full spec worked out across many rounds of
// discussion. Two panes within this one tab: a lightweight, reorderable
// section list (preview panel), and a main area that's either a continuous,
// PDF-styled preview of the whole assembled report, or — when a section is
// clicked — that section's editor replacing the main area entirely, with a
// back action returning to the continuous preview. Autosave (debounced +
// flush-on-blur, same shellWireAutosaveField already used in Phases 4/5/7)
// means the preview-panel list stays clickable throughout editing — jumping
// to a different section is always safe, never risks losing an edit.
// ============================================================================

let shellReportEditingSectionId = null;

async function shellRenderReportTab(content) {
  const t = SHELL_TOKENS;
  shellReportEditingSectionId = null;
  content.innerHTML = `
    <div style="display:flex; height:100%; margin:-24px -28px; box-sizing:border-box;">
      <div id="shell-report-panel" style="width:260px; flex-shrink:0; border-right:1px solid ${t.line}; overflow-y:auto; padding:16px;"></div>
      <div id="shell-report-main" style="flex:1; min-width:0; overflow-y:auto; padding:24px 28px;"></div>
    </div>
  `;
  await shellRenderReportPreviewList();
  await shellRenderReportMainArea();
}

async function shellRenderReportPreviewList() {
  const t = SHELL_TOKENS;
  const panel = document.getElementById('shell-report-panel');
  if (!panel) return;
  const insp = await DB.get('inspections', shellState.selectedInspectionId);
  const sections = await DB.listReportSections(insp.id);

  panel.innerHTML = `
    <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:12px;">
      <div style="font-size:11px; font-weight:700; letter-spacing:0.5px; text-transform:uppercase; color:${t.muted};">Sections</div>
      <button id="shell-rep-add" style="background:none; border:none; color:${t.red}; font-size:18px; font-weight:700; line-height:1;">+</button>
    </div>
    <div id="shell-rep-list">
      ${sections.map((s) => {
        const info = REPORT_SECTION_TYPES[s.type] || { label: s.type };
        const namedTypes = ['text', 'inspection'];
        const hasCustomTitle = namedTypes.includes(s.type);
        const title = (hasCustomTitle && s.title) ? s.title : info.label;
        const subtitle = hasCustomTitle ? info.label : null;
        const active = s.id === shellReportEditingSectionId;
        return `
          <div class="shell-rep-card" draggable="true" data-id="${s.id}" style="background:${active ? t.page : '#fff'}; border:1px solid ${active ? t.ink : t.line}; border-radius:10px; padding:10px 12px; margin-bottom:6px; cursor:pointer;">
            <div style="font-size:13.5px; font-weight:650; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${esc(title)}</div>
            ${subtitle ? `<div style="font-size:11px; color:${t.muted}; margin-top:1px;">${esc(subtitle)}</div>` : ''}
          </div>
        `;
      }).join('')}
    </div>
    <button id="shell-rep-templates" style="width:100%; background:none; border:1.5px dashed ${t.line}; border-radius:8px; padding:8px; font-size:12px; font-weight:650; color:${t.muted}; margin-top:8px;">Templates</button>
  `;

  document.getElementById('shell-rep-add').addEventListener('click', shellOpenAddSectionMenu);
  document.getElementById('shell-rep-templates').addEventListener('click', () => {
    openSaveReportTemplateSheet(sections);
  });
  panel.querySelectorAll('.shell-rep-card').forEach((card) => {
    card.addEventListener('click', () => {
      shellReportEditingSectionId = card.dataset.id;
      shellRenderReportPreviewList();
      shellRenderReportMainArea();
    });
    shellWireReportCardDrag(card, sections);
  });
}

// HTML5 drag-and-drop reordering — same pattern already proven in the PDF
// Editor's page reordering.
function shellWireReportCardDrag(card, sections) {
  card.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', card.dataset.id); });
  card.addEventListener('dragover', (e) => e.preventDefault());
  card.addEventListener('drop', async (e) => {
    e.preventDefault();
    const draggedId = e.dataTransfer.getData('text/plain');
    const targetId = card.dataset.id;
    if (draggedId === targetId) return;
    const ids = sections.map((s) => s.id);
    const from = ids.indexOf(draggedId);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0) return;
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    for (let i = 0; i < ids.length; i++) {
      await DB.reorderReportSection(shellState.selectedInspectionId, ids[i], i + 1);
    }
    shellRenderReportPreviewList();
    if (!shellReportEditingSectionId) shellRenderReportMainArea();
  });
}

function shellOpenAddSectionMenu() {
  const t = SHELL_TOKENS;
  const insp = { id: shellState.selectedInspectionId };
  const sheet = el(`
    <div class="sheet-backdrop">
      <div class="sheet">
        <div class="sheet-handle"></div>
        <h2>Add section</h2>
        ${Object.entries(REPORT_SECTION_TYPES).map(([type, info]) => `
          <button class="shell-add-section-type" data-type="${type}" style="width:100%; text-align:left; background:${t.page}; border:1px solid ${t.line}; border-radius:10px; padding:12px 14px; margin-top:8px; font-size:14px; font-weight:600;">${info.icon} ${info.label}</button>
        `).join('')}
        <button class="btn btn-ghost btn-block" id="shell-add-section-cancel" style="margin-top:12px;">Cancel</button>
      </div>
    </div>
  `);
  presentOverlay(sheet);
  sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.remove(); });
  sheet.querySelector('#shell-add-section-cancel').addEventListener('click', () => sheet.remove());
  sheet.querySelectorAll('.shell-add-section-type').forEach((btn) => {
    btn.addEventListener('click', async () => {
      sheet.remove();
      const sec = await DB.addReportSection(insp.id, btn.dataset.type, '');
      shellReportEditingSectionId = sec.id;
      shellRenderReportPreviewList();
      shellRenderReportMainArea();
    });
  });
}

async function shellRenderReportMainArea() {
  const main = document.getElementById('shell-report-main');
  if (!main) return;
  if (!shellReportEditingSectionId) {
    await shellRenderReportContinuousPreview(main);
    return;
  }
  const section = await DB.get('reportSections', shellReportEditingSectionId);
  if (!section) { shellReportEditingSectionId = null; return shellRenderReportMainArea(); }
  await shellRenderReportSectionEditor(main, section);
}

// ---- Continuous, PDF-styled preview of the whole assembled report ----
// Deliberately a close visual match (serif headings, professional report
// typography/spacing) rather than a literal reuse of the jsPDF drawing
// calls, which can't run in HTML — and deliberately flowing continuously
// with no page-break simulation, per an explicit decision.
async function shellRenderReportContinuousPreview(main) {
  const t = SHELL_TOKENS;
  const insp = await DB.get('inspections', shellState.selectedInspectionId);
  const sections = await DB.listReportSections(insp.id);
  const isGiBridges = insp.inspectionType === 'GI Bridges';

  const blocks = [];
  for (const s of sections) {
    blocks.push(await shellRenderReportSectionPreviewBlock(insp, s, isGiBridges));
  }

  main.innerHTML = `
    <div style="max-width:720px; margin:0 auto; font-family:Georgia,'Times New Roman',serif; color:#1a1a1a; line-height:1.55;">
      <h1 style="font-size:26px; font-weight:700; margin-bottom:4px;">${esc(insp.title) || esc(insp.structureName) || 'Untitled report'}</h1>
      ${insp.subtitle ? `<div style="font-size:15px; color:${t.muted}; margin-bottom:28px;">${esc(insp.subtitle)}</div>` : '<div style="margin-bottom:28px;"></div>'}
      ${blocks.join('<div style="height:1px; background:' + t.line + '; margin:28px 0;"></div>')}
    </div>
  `;
}

async function shellRenderReportSectionPreviewBlock(insp, section, isGiBridges) {
  const t = SHELL_TOKENS;
  const heading = `<h2 style="font-family:-apple-system,sans-serif; font-size:18px; font-weight:700; margin-bottom:12px;">${esc(section.title) || REPORT_SECTION_TYPES[section.type]?.label || section.type}</h2>`;

  if (section.type === 'text') {
    return `${heading}<div style="font-size:14.5px;">${section.textHtml || '<p style="color:' + t.muted + ';">Empty.</p>'}</div>`;
  }
  if (section.type === 'inspectionDetails') {
    const rows = [['Structure', insp.structureName], ['Structure ID', insp.structureId], ['Date', fmtDate(insp.date)], ['Inspector', insp.inspector], ['Weather', insp.weather], ['Location', insp.location && insp.location.manual]];
    return `${heading}<table style="width:100%; font-size:13.5px; border-collapse:collapse;">${rows.map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0; color:${t.muted}; width:140px;">${k}</td><td style="padding:4px 0;">${esc(v) || '—'}</td></tr>`).join('')}</table>`;
  }
  if (section.type === 'locationMap') {
    return `${heading}<div style="font-size:13.5px; color:${t.muted};">${esc((insp.location && insp.location.manual) || 'No location set.')}</div>`;
  }
  if (section.type === 'elementSummary') {
    const summary = await DB.getInspectionSummary(insp.id);
    let bciHtml = '';
    if (isGiBridges) {
      try {
        const bci = await computeBciSummary(insp.id);
        bciHtml = `<div style="display:flex; gap:20px; margin-bottom:14px; font-family:-apple-system,sans-serif;"><div><strong>BCI:</strong> ${bci.vanilla.bciAv != null ? bci.vanilla.bciAv.toFixed(1) : '—'}</div><div><strong>MDCI:</strong> ${bci.mdci.bciAv != null ? bci.mdci.bciAv.toFixed(1) : '—'}</div></div>`;
      } catch (err) { /* BCI computation not available */ }
    }
    return `${heading}${bciHtml}<table style="width:100%; font-size:13px; border-collapse:collapse;">
      <tr style="border-bottom:1px solid ${t.line};"><th style="text-align:left; padding:6px 8px 6px 0;">Element</th><th style="text-align:left; padding:6px 8px;">Findings</th><th style="text-align:left; padding:6px 0;">Worst</th></tr>
      ${summary.map((s) => `<tr style="border-bottom:1px solid ${t.line};"><td style="padding:6px 8px 6px 0;">${esc(s.element.name)}</td><td style="padding:6px 8px;">${s.findingCount}</td><td style="padding:6px 0;">${s.worstSeverity ? `S${s.worstSeverity}${s.worstExtent || ''}` : '—'}</td></tr>`).join('')}
    </table>`;
  }
  if (section.type === 'inspection') {
    const structureSections = await DB.listStructureSections(insp.id, section.id);
    const directElements = await DB.listDirectElements(insp.id, section.id);
    let body = '';
    for (const ss of structureSections) {
      const els = (await DB.listElements(insp.id)).filter((e) => e.sectionId === ss.id);
      body += `<div style="font-weight:650; font-size:14.5px; margin:14px 0 6px;">${esc(ss.name)}</div>`;
      body += els.map((e) => `<div style="font-size:13.5px; padding:3px 0;">${esc(e.name)}</div>`).join('') || `<div style="color:${t.muted}; font-size:13px;">No elements.</div>`;
    }
    if (directElements.length) {
      body += directElements.map((e) => `<div style="font-size:13.5px; padding:3px 0;">${esc(e.name)}</div>`).join('');
    }
    return `${heading}${body || `<div style="color:${t.muted}; font-size:13.5px;">No content yet.</div>`}`;
  }
  if (section.type === 'drawing') {
    const drawings = await DB.listSectionDrawings(section.id);
    return `${heading}${drawings.length ? `<div style="display:grid; grid-template-columns:repeat(3,1fr); gap:10px;">${drawings.map((d) => `<div><div style="height:90px; background:${t.line}; border-radius:6px; overflow:hidden;"><img src="${blobUrl(d.annotatedBlob || d.originalBlob)}" style="width:100%; height:100%; object-fit:cover;"></div><div style="font-size:11.5px; margin-top:4px;">${esc(d.title) || 'Untitled'}</div></div>`).join('')}</div>` : `<div style="color:${t.muted}; font-size:13.5px;">No drawings yet.</div>`}`;
  }
  if (section.type === 'appendices') {
    const appendices = await DB.listSectionAppendices(section.id);
    return `${heading}${appendices.length ? appendices.map((a) => `<div style="font-size:13.5px; padding:3px 0;">${esc(a.name)}</div>`).join('') : `<div style="color:${t.muted}; font-size:13.5px;">No appendices yet.</div>`}`;
  }
  return heading;
}

// ---- Section editors — dispatches to the right editor for the section's
// type, replacing the main area entirely until Back returns to the preview. ----
async function shellRenderReportSectionEditor(main, section) {
  const editors = {
    text: shellEditTextSection,
    inspectionDetails: shellEditBasicInfoSection,
    locationMap: shellEditLocationMapSection,
    elementSummary: shellEditElementSummarySection,
    inspection: shellEditInspectionFindingsSection,
    drawing: shellEditDrawingSection,
    appendices: shellEditAppendicesSection
  };
  const fn = editors[section.type];
  const t = SHELL_TOKENS;
  main.innerHTML = `
    <button id="shell-rep-back" style="background:none; border:none; color:${t.muted}; font-size:13px; font-weight:650; margin-bottom:14px;">‹ Back to preview</button>
    <div id="shell-rep-editor-body"></div>
  `;
  document.getElementById('shell-rep-back').addEventListener('click', () => {
    shellReportEditingSectionId = null;
    shellRenderReportPreviewList();
    shellRenderReportMainArea();
  });
  const body = document.getElementById('shell-rep-editor-body');
  if (fn) await fn(body, section);
  else body.innerHTML = `<div style="color:${t.muted};">Unknown section type.</div>`;
}

function shellSectionTitleField(body, section, extraOnSave) {
  const t = SHELL_TOKENS;
  const info = REPORT_SECTION_TYPES[section.type] || { label: section.type };
  const namedTypes = ['text', 'inspection'];
  if (!namedTypes.includes(section.type)) return; // per decision — only these types get a custom name
  const wrap = document.createElement('div');
  wrap.style.marginBottom = '16px';
  wrap.innerHTML = `<label style="font-size:12px; font-weight:700; text-transform:uppercase; color:${t.muted};">Section name</label><input type="text" id="shell-sec-title" value="${esc(section.title)}" placeholder="${esc(info.label)}" style="width:100%; border:1px solid ${t.line}; border-radius:8px; padding:9px 11px; font-size:14px; box-sizing:border-box; margin-top:4px;">`;
  body.appendChild(wrap);
  shellWireAutosaveField(wrap.querySelector('#shell-sec-title'), async (v) => {
    await DB.updateReportSection(section.id, { title: v });
    shellRenderReportPreviewList(); // reflect the new name in the sidebar card immediately
  });
}

async function shellEditTextSection(body, section) {
  shellSectionTitleField(body, section);
  const editorWrap = document.createElement('div');
  editorWrap.innerHTML = `${richTextToolbarHTML('shrt')}<div class="rt-editor" id="shrt-editor" contenteditable="true"></div>`;
  body.appendChild(editorWrap);
  const editorApi = wireRichTextEditor(body, 'shrt', section.textHtml);
  const editorEl = body.querySelector('#shrt-editor');
  let debounce = null;
  const save = () => { DB.updateReportSection(section.id, { textHtml: editorApi.getHTML() }); };
  editorEl.addEventListener('input', () => { clearTimeout(debounce); debounce = setTimeout(save, 700); });
  editorEl.addEventListener('blur', () => { clearTimeout(debounce); save(); });
}

async function shellEditBasicInfoSection(body, section) {
  const t = SHELL_TOKENS;
  const insp = await DB.get('inspections', shellState.selectedInspectionId);
  const coverPhoto = await DB.getCoverPhoto(insp.id);
  shellSectionTitleField(body, section);

  const wrap = document.createElement('div');
  wrap.innerHTML = `
    ${['structureName', 'structureId', 'inspector', 'weather', 'title', 'subtitle'].map((k) => `
      <div class="field" style="margin-bottom:12px;"><label style="font-size:12px; font-weight:700; text-transform:uppercase; color:${t.muted};">${k}</label><input type="text" id="f-${k}" value="${esc(insp[k])}" style="width:100%; border:1px solid ${t.line}; border-radius:8px; padding:9px 11px; font-size:14px; box-sizing:border-box; margin-top:4px;"></div>
    `).join('')}
    <div class="field" style="margin-bottom:12px;"><label style="font-size:12px; font-weight:700; text-transform:uppercase; color:${t.muted};">Date</label><input type="date" id="f-date" value="${(insp.date || '').slice(0, 10)}" style="width:100%; border:1px solid ${t.line}; border-radius:8px; padding:9px 11px; font-size:14px; box-sizing:border-box; margin-top:4px;"></div>
    <div class="field" style="margin-bottom:12px;"><label style="font-size:12px; font-weight:700; text-transform:uppercase; color:${t.muted};">General notes</label><textarea id="f-notes" style="width:100%; min-height:70px; border:1px solid ${t.line}; border-radius:8px; padding:9px 11px; font-size:14px; box-sizing:border-box; margin-top:4px;">${esc(insp.notes)}</textarea></div>
    <div style="margin-top:16px;">
      <label style="font-size:12px; font-weight:700; text-transform:uppercase; color:${t.muted};">Cover photo</label>
      <div id="shell-cover-photo" style="margin-top:6px;"></div>
    </div>
  `;
  body.appendChild(wrap);

  ['structureName', 'structureId', 'inspector', 'weather', 'title', 'subtitle', 'date', 'notes'].forEach((k) => {
    shellWireAutosaveField(body.querySelector('#f-' + k), (v) => DB.updateInspection(insp.id, { [k]: v }));
  });

  function renderCover() {
    const box = document.getElementById('shell-cover-photo');
    box.innerHTML = coverPhoto
      ? `<div id="shell-cover-thumb" style="width:110px; height:110px; border-radius:8px; overflow:hidden; cursor:pointer; background:${t.line};"><img src="${blobUrl(coverPhoto.originalBlob)}" style="width:100%; height:100%; object-fit:cover;"></div>`
      : `<button id="shell-cover-add" style="background:${t.page}; border:1px solid ${t.line}; border-radius:8px; padding:8px 14px; font-size:13px; font-weight:650;">+ Add cover photo</button>`;
    const addBtn = box.querySelector('#shell-cover-add');
    if (addBtn) addBtn.addEventListener('click', () => {
      openPhotoSourceSheet({
        onFiles: async (files) => {
          const normalized = await normalizeImageFile(files[0]);
          await DB.setCoverPhoto(insp.id, normalized);
          shellRenderReportMainArea();
        }
      });
    });
    const thumb = box.querySelector('#shell-cover-thumb');
    if (thumb) thumb.addEventListener('click', () => {
      openPhotoActionSheet(coverPhoto.id, { onAnnotated: () => shellRenderReportMainArea(), onRemoved: () => shellRenderReportMainArea() });
    });
  }
  renderCover();
}

async function shellEditLocationMapSection(body, section) {
  const t = SHELL_TOKENS;
  const insp = await DB.get('inspections', shellState.selectedInspectionId);
  shellSectionTitleField(body, section);
  const wrap = document.createElement('div');
  wrap.innerHTML = locationFieldHTML((insp.location && insp.location.manual) || '');
  body.appendChild(wrap);
  const locationField = wireLocationField(body, insp.location);
  // wireLocationField's own inputs use whatever change mechanism it already implements —
  // persisting on blur of the whole field group is a safe, simple way to autosave without
  // needing to know its exact internal DOM structure.
  wrap.addEventListener('focusout', async () => {
    const coords = locationField.getCoords();
    await DB.updateInspection(insp.id, { location: { ...(coords || {}), manual: locationField.getManualText() } });
  });
}

async function shellEditElementSummarySection(body, section) {
  const t = SHELL_TOKENS;
  const insp = await DB.get('inspections', shellState.selectedInspectionId);
  const isGiBridges = insp.inspectionType === 'GI Bridges';
  shellSectionTitleField(body, section);
  const summary = await DB.getInspectionSummary(insp.id);

  let bciHtml = '';
  if (isGiBridges) {
    try {
      const bci = await computeBciSummary(insp.id);
      bciHtml = `<div style="display:flex; gap:20px; margin-bottom:16px; padding:14px; background:${t.page}; border-radius:10px;"><div><div style="font-size:11px; color:${t.muted}; text-transform:uppercase; font-weight:700;">BCI</div><div style="font-size:19px; font-weight:700;">${bci.vanilla.bciAv != null ? bci.vanilla.bciAv.toFixed(1) : '—'}</div></div><div><div style="font-size:11px; color:${t.muted}; text-transform:uppercase; font-weight:700;">MDCI</div><div style="font-size:19px; font-weight:700;">${bci.mdci.bciAv != null ? bci.mdci.bciAv.toFixed(1) : '—'}</div></div></div>`;
    } catch (err) { /* not available */ }
  }
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    ${bciHtml}
    <div style="font-size:12.5px; color:${t.muted}; margin-bottom:12px;">Computed automatically from every element and finding — nothing else to fill in here.</div>
    ${summary.length ? summary.map((s) => `
      <div style="background:#fff; border:1px solid ${t.line}; border-radius:10px; padding:10px 12px; margin-bottom:6px;">
        <div style="font-size:14px; font-weight:650;">${esc(s.element.name)}</div>
        <div style="font-size:12.5px; color:${t.muted}; margin-top:2px;">${s.element.materialType ? esc(s.element.materialType) + ' · ' : ''}${s.findingCount} finding${s.findingCount === 1 ? '' : 's'}${s.worstSeverity ? ` · Worst: S${s.worstSeverity} ${s.worstExtent || ''}` : ''}</div>
      </div>
    `).join('') : `<div style="color:${t.muted}; font-size:14px;">No elements yet.</div>`}
  `;
  body.appendChild(wrap);
}

async function shellEditInspectionFindingsSection(body, section) {
  const t = SHELL_TOKENS;
  const insp = await DB.get('inspections', shellState.selectedInspectionId);
  shellSectionTitleField(body, section);
  const structureSections = await DB.listStructureSections(insp.id, section.id);
  const directElements = await DB.listDirectElements(insp.id, section.id);

  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <div style="font-size:12.5px; color:${t.muted}; margin-bottom:16px;">Use Structure Sections to split this into parts with their own elements (e.g. Span 1 / Span 2) — or add elements directly below for a simple, single structure.</div>
    <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:8px;"><div style="font-size:13px; font-weight:700; text-transform:uppercase; color:${t.muted};">Structure Sections</div><button id="shell-if-add-ss" style="background:none; border:none; color:${t.red}; font-size:12px; font-weight:650;">+ Add</button></div>
    <div id="shell-if-ss-list">
      ${structureSections.length ? structureSections.map((s) => `<div class="shell-if-ss-row" data-id="${s.id}" style="display:flex; align-items:center; justify-content:space-between; background:#fff; border:1px solid ${t.line}; border-radius:10px; padding:10px 12px; margin-bottom:6px; cursor:pointer;"><span style="font-size:14px; font-weight:600;">${esc(s.name)}</span><span style="color:${t.muted};">›</span></div>`).join('') : `<div style="color:${t.muted}; font-size:13px; margin-bottom:10px;">None yet.</div>`}
    </div>
    <div style="display:flex; align-items:center; justify-content:space-between; margin:18px 0 8px;"><div style="font-size:13px; font-weight:700; text-transform:uppercase; color:${t.muted};">Elements</div><button id="shell-if-add-el" style="background:none; border:none; color:${t.red}; font-size:12px; font-weight:650;">+ Add</button></div>
    <div id="shell-if-el-list">
      ${directElements.length ? directElements.map((e) => `<div class="shell-if-el-row" data-id="${e.id}" style="display:flex; align-items:center; justify-content:space-between; background:#fff; border:1px solid ${t.line}; border-radius:10px; padding:10px 12px; margin-bottom:6px; cursor:pointer;"><div><div style="font-size:14px; font-weight:600;">${esc(e.name)}</div>${e.materialType ? `<div style="font-size:12px; color:${t.muted};">${esc(e.materialType)}</div>` : ''}</div><span style="color:${t.muted};">›</span></div>`).join('') : `<div style="color:${t.muted}; font-size:13px;">Elements not in a Structure Section appear here.</div>`}
    </div>
  `;
  body.appendChild(wrap);

  document.getElementById('shell-if-add-ss').addEventListener('click', () => {
    const name = prompt('Structure section name (e.g. "Span 1")');
    if (!name || !name.trim()) return;
    DB.listSections(insp.id).then(async (existing) => {
      await DB.createStructureSection(insp.id, section.id, { name: name.trim(), order: existing.length });
      shellRenderReportMainArea();
    });
  });
  document.getElementById('shell-if-add-el').addEventListener('click', () => {
    openAddElementSheet(insp.id, null, { reportSectionId: section.id, onDone: () => shellRenderReportMainArea() });
  });
  wrap.querySelectorAll('.shell-if-ss-row').forEach((row) => {
    row.addEventListener('click', () => shellOpenStructureSectionDetail(row.dataset.id, insp.id, section.id));
  });
  wrap.querySelectorAll('.shell-if-el-row').forEach((row) => {
    row.addEventListener('click', () => shellOpenElementDrawer(row.dataset.id));
  });
}

// Small overlay for the elements within one Structure Section — the shell has no full
// "structure section detail" screen of its own, so this stays intentionally compact,
// reusing the already-built Element Drawer for any individual element clicked into.
async function shellOpenStructureSectionDetail(structureSectionId, inspectionId, reportSectionId) {
  const t = SHELL_TOKENS;
  const sec = await DB.get('sections', structureSectionId);
  if (!sec) return;
  let elements = (await DB.listElements(inspectionId)).filter((e) => e.sectionId === structureSectionId);

  const backdrop = el(`
    <div style="position:fixed; inset:0; background:rgba(20,22,28,0.4); z-index:300; display:flex; align-items:center; justify-content:center; padding:20px; box-sizing:border-box;">
      <div style="width:480px; max-width:100%; max-height:680px; background:#fff; border-radius:16px; display:flex; flex-direction:column; box-shadow:0 30px 60px rgba(0,0,0,0.3); overflow:hidden;">
        <div style="padding:16px 20px; border-bottom:1px solid ${t.line}; display:flex; align-items:center; justify-content:space-between; flex-shrink:0;">
          <div style="font-size:15px; font-weight:650;">${esc(sec.name)}</div>
          <button id="shell-ss-close" style="background:none; border:none; font-size:18px; color:${t.muted};">✕</button>
        </div>
        <div id="shell-ss-body" style="flex:1; min-height:0; overflow-y:auto; padding:16px 20px;"></div>
        <div style="padding:14px 20px; border-top:1px solid ${t.line}; flex-shrink:0;">
          <button id="shell-ss-add-el" style="width:100%; background:${t.ink}; color:#fff; border:none; border-radius:9px; padding:11px; font-size:13.5px; font-weight:650;">+ Add element</button>
        </div>
      </div>
    </div>
  `);
  document.body.appendChild(backdrop);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.remove(); });
  document.getElementById('shell-ss-close').addEventListener('click', () => backdrop.remove());

  function renderList() {
    const box = document.getElementById('shell-ss-body');
    box.innerHTML = elements.length ? elements.map((e) => `
      <div class="shell-ss-el-row" data-id="${e.id}" style="display:flex; align-items:center; justify-content:space-between; background:${t.page}; border-radius:10px; padding:10px 12px; margin-bottom:6px; cursor:pointer;">
        <span style="font-size:14px; font-weight:600;">${esc(e.name)}</span><span style="color:${t.muted};">›</span>
      </div>
    `).join('') : `<div style="color:${t.muted}; font-size:13.5px;">No elements yet.</div>`;
    box.querySelectorAll('.shell-ss-el-row').forEach((row) => {
      row.addEventListener('click', () => shellOpenElementDrawer(row.dataset.id));
    });
  }
  renderList();

  document.getElementById('shell-ss-add-el').addEventListener('click', () => {
    openAddElementSheet(inspectionId, structureSectionId, {
      reportSectionId,
      onDone: async () => { elements = (await DB.listElements(inspectionId)).filter((e) => e.sectionId === structureSectionId); renderList(); }
    });
  });
}

async function shellEditDrawingSection(body, section) {
  const t = SHELL_TOKENS;
  const insp = await DB.get('inspections', shellState.selectedInspectionId);
  shellSectionTitleField(body, section);
  let drawings = await DB.listSectionDrawings(section.id);

  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <div id="shell-sec-drawings" style="display:grid; grid-template-columns:repeat(3,1fr); gap:12px;"></div>
    <button id="shell-sec-add-drawing" style="width:100%; border:1.5px dashed ${t.line}; background:none; border-radius:10px; padding:12px; font-size:13.5px; font-weight:650; color:${t.muted}; margin-top:12px;">+ Add drawing</button>
  `;
  body.appendChild(wrap);

  function renderGrid() {
    const grid = document.getElementById('shell-sec-drawings');
    grid.innerHTML = drawings.map((d) => `
      <div class="shell-sec-drawing" data-id="${d.id}" style="cursor:pointer;">
        <div style="height:100px; border-radius:8px; overflow:hidden; background:${t.line};"><img src="${blobUrl(d.annotatedBlob || d.originalBlob)}" style="width:100%; height:100%; object-fit:cover;"></div>
        <div style="font-size:12px; font-weight:600; margin-top:5px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${esc(d.title) || 'Untitled'}</div>
      </div>
    `).join('');
    grid.querySelectorAll('.shell-sec-drawing').forEach((card) => {
      card.addEventListener('click', () => {
        const d = drawings.find((x) => x.id === card.dataset.id);
        openDrawingDetailSheet(d, { onChanged: async () => { drawings = await DB.listSectionDrawings(section.id); renderGrid(); } });
      });
    });
  }
  renderGrid();

  document.getElementById('shell-sec-add-drawing').addEventListener('click', () => {
    openAddSectionDrawingSheet(insp.id, section.id, async () => { drawings = await DB.listSectionDrawings(section.id); renderGrid(); });
  });
}

async function shellEditAppendicesSection(body, section) {
  const t = SHELL_TOKENS;
  shellSectionTitleField(body, section);
  let appendices = await DB.listSectionAppendices(section.id);

  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <label style="display:flex; align-items:center; gap:8px; font-size:13.5px; margin-bottom:16px;">
      <input type="checkbox" id="shell-sec-ra" ${section.includeRiskAssessment ? 'checked' : ''} style="width:18px; height:18px;"> Include Risk Assessment as an appendix (always last)
    </label>
    <div id="shell-sec-apx-list"></div>
    <button id="shell-sec-add-apx" style="width:100%; border:1.5px dashed ${t.line}; background:none; border-radius:10px; padding:12px; font-size:13.5px; font-weight:650; color:${t.muted}; margin-top:8px;">+ Add appendix</button>
  `;
  body.appendChild(wrap);

  document.getElementById('shell-sec-ra').addEventListener('change', (e) => {
    DB.updateReportSection(section.id, { includeRiskAssessment: e.target.checked });
  });

  function renderList() {
    const box = document.getElementById('shell-sec-apx-list');
    box.innerHTML = appendices.length ? appendices.map((a) => `
      <div class="shell-sec-apx-row" data-id="${a.id}" style="display:flex; align-items:center; justify-content:space-between; background:#fff; border:1px solid ${t.line}; border-radius:10px; padding:10px 12px; margin-bottom:6px; cursor:pointer;">
        <span style="font-size:14px; font-weight:600;">${esc(a.name)}</span><span style="color:${t.muted};">›</span>
      </div>
    `).join('') : `<div style="color:${t.muted}; font-size:13.5px;">No appendices yet.</div>`;
    box.querySelectorAll('.shell-sec-apx-row').forEach((row) => {
      row.addEventListener('click', () => shellOpenAppendixItems(section.id, row.dataset.id));
    });
  }
  renderList();

  document.getElementById('shell-sec-add-apx').addEventListener('click', async () => {
    const name = prompt('Appendix name (e.g. "Appendix A: Photos")');
    if (!name || !name.trim()) return;
    await DB.addSectionAppendix(section.id, name.trim());
    appendices = await DB.listSectionAppendices(section.id);
    renderList();
  });
}
