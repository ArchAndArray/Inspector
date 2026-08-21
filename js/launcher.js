// launcher.js — Phase 1 of the full UI rebuild (see project handoff docs). This is the new
// entry point (#/), replacing the old renderHome(). Values here (colors, spacing, sizes) are
// taken directly from the design handoff prototype, which the brief marks as authoritative —
// not approximated. Module/tool tiles use plain geometric CSS shapes, matching the
// prototype's own approach (no icon fonts/SVG assets).
//
// "Inspector" currently routes to renderInspectorBridge() (#/inspector) — a temporary bridge
// reusing the existing inspection-list screen, standing in until Phase 2 (the real persistent
// sidebar+main shell) replaces it. This keeps the Launcher's own scope honest: Phase 1 only.

const LAUNCHER_TOKENS = {
  ink: 'oklch(0.22 0.012 260)',
  red: 'oklch(0.56 0.19 27)',
  redHover: 'oklch(0.47 0.19 27)',
  page: 'oklch(0.973 0.003 90)',
  line: 'oklch(0.91 0.004 90)',
  muted: 'oklch(0.55 0.008 260)',
  mutedDark: 'oklch(0.32 0.008 260)',
  toolIconBg: 'oklch(0.9 0.004 90)',
  toolIconFg: 'oklch(0.4 0.008 260)'
};

async function renderLauncher() {
  const t = LAUNCHER_TOKENS;

  appEl.innerHTML = `
    <div style="width:100%; height:100vh; display:flex; flex-direction:column; box-sizing:border-box; overflow:hidden;">

      <div style="flex:1; min-height:0; display:flex; flex-direction:column; padding:clamp(20px,4vw,48px) clamp(24px,5vw,64px) clamp(14px,2vw,24px); padding-top:calc(clamp(20px,4vw,48px) + var(--safe-top)); border-bottom:1px solid ${t.line}; box-sizing:border-box;">
        <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:clamp(16px,3vh,32px); flex-shrink:0;">
          <div style="display:flex; align-items:center; gap:10px;">
            <div style="width:28px; height:28px; border-radius:8px; background:${t.red}; flex-shrink:0;"></div>
            <div style="font-size:15px; font-weight:650; letter-spacing:0.1px; color:${t.mutedDark};">Arch &amp; Array</div>
          </div>
          <button id="launcher-check-updates" style="background:none; border:none; color:${t.muted}; font-size:12px; font-weight:600; padding:6px; text-align:right;">Check Updates<br><span style="font-size:10.5px; opacity:0.8;">v${APP_VERSION}</span></button>
        </div>
        <div style="font-size:12px; font-weight:700; letter-spacing:0.6px; text-transform:uppercase; color:${t.muted}; margin-bottom:18px; flex-shrink:0;">Modules</div>
        <div style="flex:1; overflow-y:auto; display:flex; flex-wrap:wrap; align-content:flex-start; gap:14px;">
          <div class="launcher-tile" data-target="inspector" style="width:132px; display:flex; flex-direction:column; align-items:center; gap:10px; cursor:pointer; padding:16px 8px;">
            <div style="width:64px; height:64px; border-radius:16px; background:${t.red}; display:flex; align-items:center; justify-content:center;">
              <div style="display:flex; flex-direction:column; gap:5px; align-items:flex-start;">
                <div style="width:26px; height:3px; border-radius:2px; background:#fff;"></div>
                <div style="width:20px; height:3px; border-radius:2px; background:#fff;"></div>
                <div style="width:23px; height:3px; border-radius:2px; background:#fff;"></div>
              </div>
            </div>
            <div style="font-size:13.5px; font-weight:650; text-align:center;">Inspector</div>
          </div>

          <div class="launcher-tile" data-target="pm" style="width:132px; display:flex; flex-direction:column; align-items:center; gap:10px; cursor:pointer; padding:16px 8px;">
            <div style="width:64px; height:64px; border-radius:16px; background:${t.red}; display:flex; align-items:center; justify-content:center;">
              <div style="display:flex; align-items:flex-end; gap:3px; height:26px;">
                <div style="width:5px; height:14px; border-radius:1px; background:#fff;"></div>
                <div style="width:5px; height:22px; border-radius:1px; background:#fff;"></div>
                <div style="width:5px; height:9px; border-radius:1px; background:#fff;"></div>
                <div style="width:5px; height:18px; border-radius:1px; background:#fff;"></div>
              </div>
            </div>
            <div style="font-size:13.5px; font-weight:650; text-align:center;">Project<br>Management</div>
          </div>

          <div class="launcher-tile" data-target="pm-resources" style="width:132px; display:flex; flex-direction:column; align-items:center; gap:10px; cursor:pointer; padding:16px 8px;">
            <div style="width:64px; height:64px; border-radius:16px; background:${t.red}; display:flex; align-items:center; justify-content:center;">
              <div style="display:flex; align-items:center; justify-content:center;">
                <div style="width:22px; height:22px; border-radius:50%; border:3px solid #fff; margin-right:-6px;"></div>
                <div style="width:16px; height:16px; border-radius:50%; border:3px solid #fff; opacity:0.85;"></div>
              </div>
            </div>
            <div style="font-size:13.5px; font-weight:650; text-align:center;">Resources</div>
          </div>
        </div>
      </div>

      <div style="flex:1; min-height:0; display:flex; flex-direction:column; padding:clamp(14px,2vw,24px) clamp(24px,5vw,64px) clamp(20px,4vw,48px); padding-bottom:calc(clamp(20px,4vw,48px) + var(--safe-bottom)); box-sizing:border-box;">
        <div style="font-size:12px; font-weight:700; letter-spacing:0.6px; text-transform:uppercase; color:${t.muted}; margin-bottom:18px; flex-shrink:0;">Tools</div>
        <div style="flex:1; overflow-y:auto; display:flex; flex-wrap:wrap; align-content:flex-start; gap:14px;">

          <div class="launcher-tile" data-target="scale-annotate" style="width:132px; display:flex; flex-direction:column; align-items:center; gap:10px; cursor:pointer; padding:16px 8px;">
            <div style="width:64px; height:64px; border-radius:16px; background:${t.toolIconBg}; display:flex; align-items:center; justify-content:center;">
              <div style="position:relative; width:30px; height:30px;">
                <div style="position:absolute; width:34px; height:3px; background:${t.toolIconFg}; border-radius:2px; top:14px; left:-2px; transform:rotate(-40deg);"></div>
                <div style="position:absolute; width:9px; height:9px; border-radius:50%; border:2.5px solid ${t.toolIconFg}; top:-2px; right:-3px;"></div>
              </div>
            </div>
            <div style="font-size:13.5px; font-weight:650; text-align:center;">Scale &amp; Annotate</div>
          </div>

          <div class="launcher-tile" data-target="sketch" style="width:132px; display:flex; flex-direction:column; align-items:center; gap:10px; cursor:pointer; padding:16px 8px;">
            <div style="width:64px; height:64px; border-radius:16px; background:${t.toolIconBg}; display:flex; align-items:center; justify-content:center;">
              <div style="position:relative; width:26px; height:26px; background:#fff; border-radius:3px; border:1.5px solid oklch(0.75 0.006 90);">
                <div style="position:absolute; width:26px; height:2.5px; background:${t.red}; border-radius:2px; top:12px; left:-3px; transform:rotate(-24deg);"></div>
              </div>
            </div>
            <div style="font-size:13.5px; font-weight:650; text-align:center;">Sketch</div>
          </div>

          <div class="launcher-tile" data-target="pdf-editor" style="width:132px; display:flex; flex-direction:column; align-items:center; gap:10px; cursor:pointer; padding:16px 8px;">
            <div style="width:64px; height:64px; border-radius:16px; background:${t.toolIconBg}; display:flex; align-items:center; justify-content:center;">
              <div style="position:relative; width:24px; height:28px; background:${t.toolIconFg}; border-radius:3px;">
                <div style="position:absolute; top:0; right:0; width:0; height:0; border-style:solid; border-width:0 9px 9px 0; border-color:transparent ${t.toolIconBg} transparent transparent;"></div>
              </div>
            </div>
            <div style="font-size:13.5px; font-weight:650; text-align:center;">PDF Editor</div>
          </div>

          <div class="launcher-tile" data-target="backup" style="width:132px; display:flex; flex-direction:column; align-items:center; gap:10px; cursor:pointer; padding:16px 8px;">
            <div style="width:64px; height:64px; border-radius:16px; background:${t.toolIconBg}; display:flex; align-items:center; justify-content:center;">
              <div style="width:30px; height:30px; border-radius:50%; border:3px dashed ${t.toolIconFg};"></div>
            </div>
            <div style="font-size:13.5px; font-weight:650; text-align:center;">Backup &amp; Restore</div>
          </div>

        </div>
      </div>

    </div>
  `;

  appEl.querySelectorAll('.launcher-tile').forEach((tile) => {
    tile.addEventListener('click', () => onLauncherTileClick(tile.dataset.target));
  });
  document.getElementById('launcher-check-updates').addEventListener('click', forceUpdate);
}

async function onLauncherTileClick(target) {
  if (target === 'inspector') { navigate('#/inspector'); return; }
  if (target === 'pm') { navigate('#/pm'); return; }
  if (target === 'pm-resources') { navigate('#/pm-resources'); return; }
  if (target === 'scale-annotate') { navigate('#/scale-annotate'); return; }
  if (target === 'pdf-editor') { navigate('#/pdf-editor'); return; }
  if (target === 'backup') { openBackupRestoreSheet(); return; }
  if (target === 'sketch') {
    const blank = await createBlankCanvasBlob();
    const rec = await DB.addStandaloneAnnotation(blank, 'Sketch', 'image');
    navigate('#/scale-annotate');
    await openAnnotator(rec.id, () => renderScaleAnnotate());
    return;
  }
}

// Temporary bridge to the existing inspection-list screen, reached from the Launcher's
// "Inspector" module tile — reuses renderHome()'s inspection-list logic (list + "+" FAB),
// minus the old tool-button row (those are now Launcher tiles), plus a small link back for
// Element Templates, which isn't a Launcher tile per the design spec — it belongs in the
// real Inspector shell's Settings section once Phase 2 replaces this screen entirely.
async function renderInspectorBridge() {
  const inspections = await DB.listInspections();
  const rows = inspections.map((insp) => `
    <div class="list-item" data-id="${insp.id}">
      <div class="meta">
        <h3>${esc(insp.structureName || 'Untitled structure')}</h3>
        <p>${esc(insp.inspectionType || 'Inspection')} · ${fmtDate(insp.date)}${insp.inspector ? ' · ' + esc(insp.inspector) : ''}</p>
      </div>
      <span class="chevron">›</span>
    </div>
  `).join('');

  appEl.innerHTML = `
    <div class="topbar">
      <button class="icon-btn" id="btn-launcher-back">‹</button>
      <div style="flex:1; min-width:0;">
        <h1>Inspector</h1>
        <span class="sub">by Arch&amp;Array · v${APP_VERSION}</span>
      </div>
      <button class="text-btn" id="btn-element-templates">Templates</button>
    </div>
    <div class="content">
      ${inspections.length ? rows : `
        <div class="empty-state">
          <div class="glyph">＋</div>
          <h3>No inspections yet</h3>
          <p>Start a new inspection to begin logging findings.</p>
        </div>
      `}
    </div>
    <button class="fab" id="btn-new-inspection">＋</button>
  `;

  document.getElementById('btn-launcher-back').addEventListener('click', () => navigate('#/'));
  document.getElementById('btn-element-templates').addEventListener('click', () => navigate('#/templates'));
  appEl.querySelectorAll('.list-item').forEach((row) => row.addEventListener('click', () => navigate(`#/inspection/${row.dataset.id}`)));
  document.getElementById('btn-new-inspection').addEventListener('click', openNewInspectionSheet);
}
