# Inspector by Arch&Array — Development Roadmap

**Status:** Living document — single source of truth
**Last updated:** 2026-08-18
**Last updated by:** PM module build chat — reversed the PM location decision back to "module inside Inspector," verified against real source, and built Phase 1 Step 1 (data model + WBS task table)

---

## 1. Introduction & Scope

This document exists because development on Inspector happens across multiple separate chat sessions, and no chat automatically knows what another chat has built, decided, or discovered. Without a shared record, work gets duplicated, contradictory assumptions get made, and design decisions get re-litigated from scratch each time.

**Purpose:** give any chat — starting cold, with no memory of prior sessions — enough information to understand the current state of the whole app and pick up work on any section without breaking what already exists.

**If you are a chat working on this project, before making changes:**
1. Read this whole document first, not just your section.
2. Check the **Cross-Cutting Decisions Log** (Section 5) — these are binding unless the user explicitly overrides them in your conversation.
3. Update **only your own section(s)** when your session ends, following the format below. Don't rewrite other sections' content, but you may flag a cross-section issue in Section 6.
4. If you build something that changes a decision in Section 5, update that log entry and explain what changed and why.
5. If you're not sure whether a file/feature described here still matches the real codebase, say so in your update rather than assuming — this document is a summary maintained by chats, not a live read of the source. Verify against actual project files when they're available before relying on details here.

**Core design principle carried through the whole app (do not violate without explicit user sign-off):** New ways of presenting or organizing data should reuse the existing data model wherever possible, rather than inventing parallel fields. This was established for New Style vs Old Style reports (both write to the same `insp.*` fields) and should be treated as the default assumption for new modules too — e.g., a 3D scan should be a new *attachment type* on an existing finding/element, not a new report concept. If/when the external Project Management tool (Section 4.1) is integrated back into Inspector, a task referencing inspection work should reference the actual Inspection record, not a duplicate of its data.

---

## 2. Document Conventions

**Status labels — use these exact terms:**
- `Not Started` — discussed only, no design decisions locked in
- `Scoping` — requirements/architecture being worked out, no code yet
- `In Progress` — actively being built
- `Built — Untested` — code exists, not yet verified in the field
- `Built — Field Tested` — working and confirmed on the iPad in real use
- `Stable` — mature, only receiving bug fixes, not active feature change

**Each section should contain, at minimum:**
- Status (per above)
- Short description of what it does / is meant to do
- Current capabilities (what actually works right now)
- Known issues / open bugs
- Next steps
- Key decisions specific to that section
- Date + which chat last touched it

---

## 3. Core Inspection App (Foundation)

> Sections 3.1–3.7 below have been verified directly against the actual `.js` source files in this session (not reconstructed from memory) — this replaces the earlier "unverified, needs a chat with source access" caveat that applied to most of this section previously.

### 3.1 Platform / PWA Shell
- **Status:** Stable
- **Description:** Offline-first PWA, vanilla JavaScript, no build step, IndexedDB for storage, hosted on GitHub Pages, installed via Safari "Add to Home Screen" on iPad Pro. No backend.
- **Current version:** v6.6 (DB schema version 6 — bumped this session for the new PM stores, see 4.1)
- **File list:** `index.html`, `manifest.json`, `sw.js`, `css/styles.css`, `js/db.js`, `js/bci.js`, `js/geo.js`, `js/backup.js`, `js/app.js`, `js/annotate.js`, `js/signature.js`, `js/pdf.js`, `js/pdfeditor.js`, `js/pm.js` (new this session — see 4.1), `js/launcher.js`, `js/shell.js`
- **CDN libraries (loaded dynamically, cached by the service worker on first fetch — not in the upfront precache list, matching how pdf.js has always been handled):** jsPDF + jspdf-autotable (report creation), pdf.js (page rendering/thumbnails), **pdf-lib (new this session — structural PDF editing, used only by the PDF Editor tool)**.
- **Current capabilities:** Full offline operation after first load; service worker caching; in-app update mechanism ("Check Updates" button clears cache/SW and reloads from GitHub Pages).
- **Known issues:** iOS can occasionally clear site data under storage pressure — no cloud backup exists; PDF export is the recommended durable backup method.
- **Next steps:** None currently planned — stable.
- **Key decisions:** No framework, no bundler, no backend. New modules should match this unless a decision log entry says otherwise (see Section 5). This was reaffirmed explicitly this session when scoping the Project Management module — see 4.1 and the Section 5 log update.

### 3.2 Data Layer (`db.js`)
- **Status:** Stable, extended as needed
- **Description:** IndexedDB data layer. **Now fully documented below from a direct source read — the earlier "unknown in detail" placeholder is resolved.**
- **Object stores (9 total):** `inspections`, `elements`, `findings`, `photos`, `templates`, `sections`, `riskAssessments`, `reportSections`, `reportTemplates`.
- **Notable fields added since the last roadmap update:**
  - `inspections`: `locationMapMode`, `locationMapScale`, `includeCoverPage`, `reportStyle` ('old'/'new', set once at creation), `inspectionType` and `currency` now editable from Report Info in addition to wherever else they're set.
  - `sections` (element-grouping, both styles): `reportSectionId` — links a Structure Section to its owning Inspection Findings report-section in New Style. Null for Old Style sections.
  - `elements`: `reportSectionId` — for elements added directly to an Inspection Findings report-section without a Structure Section (New Style only).
  - `photos`: `reportSectionId` (Drawing-type report sections), `editableMarkBlob` (the "Save, keep editable" annotator feature — see 3.5).
  - `reportSections` (New Style only): `id, inspectionId, order, type, title, textHtml, elementSectionId (legacy/unused — see note below), appendices[], includeRiskAssessment`.
- **Known minor cleanup item:** `reportSections.elementSectionId` is a leftover field from an earlier single-link design that was superseded by the nested Structure Sections model. It's still initialized to `null` on creation but nothing reads it anymore — harmless, but could be removed in a future pass.
- **Next steps:** None currently planned.

### 3.3 Old Style Report System
- **Status:** Stable
- **Description:** Original report-building system. Behavior and output are unchanged from the user's perspective.
- **Note for future chats:** several of its internal drawing routines (Inspection Details block, Element Summary table, per-section Findings loop, the per-element data loader) were extracted into shared functions this session (`drawInspectionDetailsBlock`, `drawElementSummaryTableForGroups`, `drawGroupFindings`, `loadElementDataForPdf` in `pdf.js`) so New Style could reuse them instead of duplicating the logic. This was verified not to change Old Style's actual output — treat these as shared infrastructure now, not Old-Style-only internals, when touching PDF generation.

### 3.4 New Style Report System
- **Status:** Built — field testing ongoing (extensively iterated on this session; several real bugs found and fixed, some fixes not yet confirmed by the user in the field — see Known issues)
- **Description:** Parallel report-building system alongside Old Style. Report style is chosen at inspection creation and is permanent for that inspection. Both systems write to the same underlying `insp.*` fields.
- **Terminology change this session:** "Inspection Details" section type is now labeled **"Basic Inspection Information"**; "Inspection" section type is now labeled **"Inspection Findings"** (internal `type` keys unchanged — `inspectionDetails` and `inspection` respectively — only the display label changed, no migration needed).
- **Current capabilities:**
  - Flexible ordered section list, 7 section types: Text, Drawing, Inspection Findings, Location Map, Basic Inspection Information, Element Summary, Appendices
  - Live insert-at-position reordering
  - Template builder with seeded "Standard Report" default, plus "save current section set as a new template"
  - **Inspection Findings now supports nested Structure Sections** (e.g. Span 1 / Span 2 on a multi-span structure) plus elements added directly without a Structure Section — replacing an earlier, simpler single-link design
  - All non-Drawing/Appendices section types now open as **full pages** rather than small sheets: Text, Location Map (now also handles map mode/scale/location editing in one place), Basic Inspection Information (now also handles the cover photo), Element Summary (now shows a live preview of the actual computed table, not just a description)
  - Report Info gained Inspection Type and Currency fields
  - Full PDF generator (`buildAndSaveNewStyleInspectionPDF` in `pdf.js`) reusing the Old Style shared primitives (see 3.3)
  - **PDF layout:** sections now flow onto shared pages rather than each always starting a fresh page, breaking only when a section's heading would land in the bottom quarter of a page (with a dedicated stricter check for Location Map specifically, since its image is much taller than a heading and the generic check wasn't sufficient — see Known issues, resolved)
  - Text section headings now match Element Summary/Location Map/Basic Inspection Information's style (previously used a different, larger "refined" style inherited from an early design pass); the Table of Contents no longer shows the structure name as a subtitle
- **Known issues (resolved, listed for context):** appendix name wrapping over structure name (fixed); bulleted/numbered list collapse in PDF from Safari `contenteditable` behavior (fixed with a recursive parser — the same fix also benefits Old Style's Introduction/Summary/Conclusion, which share the same rich-text renderer); Location Map clipping when it started partway down a page (fixed with a dedicated height-aware check, verified against a worked example); gap between sections doubled per user preference.
- **Next steps:** None currently planned by the user. Worth a continued field-testing pass given how much changed this session, particularly the nested Structure Sections model and the PDF page-flow logic.

### 3.5 Annotator (`annotate.js`)
- **Status:** Built — field tested, actively refined. By far the most extensively changed file this session — effectively rebuilt in several areas.
- **Description:** Apple Pencil markup canvas for photos/drawings/sketches, used throughout the app (Finding photos, Element photos, Drawings, Appendix items, standalone Scale/Annotate tool).
- **Toolbar:** now 2 rows (previously 3), grid-based (not flex) so the two color rows genuinely align between rows — left/middle/right sections in each row:
  - Row 1 left: Undo, Rotate, Crop, Calibrate, Grid (text-style buttons)
  - Row 1 middle: 5 fixed color swatches
  - Row 1 right: Line style picker (only visible for Arc/Straight Line — see below), 4 width options (Thin/Medium/Thick/Custom), Eraser
  - Row 2 left: Ruler, Measure, Text, Arc, Straight Line, 4 pen types (Pen/Airbrush/Fountain/Smoothing)
  - Row 2 middle: 5 custom (user-saveable, localStorage-persistent) color swatches
- **Pen types:** Pen (default), Airbrush (soft radial-gradient dabs), Fountain (angle-based calligraphy width variation between an average and maximum), Smoothing (quadratic-curve interpolation through recent points).
- **Tools:** Ruler, Measure (labeled double-arrow), Text (box placed by a simple tap; an optional leader can be dragged out afterward from a corner handle — text no longer requires deciding on a leader at initial placement), Arc (plain curved line, bulge adjustable via a third handle after placement), **Straight Line (new this session — press-drag-release commits a straight line directly, no adjust step, by design)**, Calibrate, Crop, Grid (cycles Off/Normal/Dense).
- **Adjust mode:** after placing a Measure arrow or a Text box, it stays live and draggable with a Done/Cancel confirmation rather than committing to pixels immediately — includes the magnifier during adjustment. Arc uses the same adjust-mode machinery with a third handle for its bulge point. Straight Line deliberately does **not** use adjust mode (explicit user decision — it's meant to be quick, no repositioning step needed).
- **Line style (dash patterns):** Solid/Dots/Small dashes/Dots-and-dashes/Large dashes. **Deliberately restricted to the Arc and Straight Line tools only** — freehand pen strokes are built from many short segments (one per pointer event), and even with the dash phase correctly tracked across segments (which was fixed this session), a dashed pattern on a hand-drawn wobbly line doesn't render as cleanly as on a single smooth path. The line-style button is hidden entirely when a tool other than Arc/Straight Line is active, rather than left visible-but-inert.
- **Custom colors/width:** 5 persistent custom color slots (localStorage) alongside 5 fixed ones — tap to select, hold to edit. A 4th "Custom" width slot alongside Thin/Medium/Thick, same tap/hold pattern. Fountain pen's custom width editor has two sliders (average + maximum) instead of one, since its whole point is width varying between those two values.
- **Save options:** "Save (editable)" keeps the mark layer as a separate PNG blob (`photo.editableMarkBlob`) alongside the flattened result, so reopening the photo reloads the original image plus that separate layer for continued editing (undo/erase still work on it). "Flatten & save" permanently merges everything and clears the editable layer. Session-only by design — no separate persisted "draft" state beyond what's stored on the photo record itself.
- **Known issues:**
  - **Not yet confirmed resolved:** a user report that "Save (editable)" doesn't allow further edits after reopening. Code review found the save/reload path structurally correct; a defensive fix was added (the mark-layer reload now fails loudly with a toast instead of silently, in case that was the actual mechanism) but the root cause was not conclusively identified. Needs the user to confirm whether it's actually fixed, and if not, exactly what happens on reopen (marks missing entirely? present but won't erase? present but new drawing doesn't save?).
  - **Not yet confirmed resolved:** a reported missing vertical grid line near the canvas center, on both grid density settings. Several hypotheses were investigated (sub-pixel SVG rendering under the grid's viewBox scale-down, loop logic, overlapping UI elements) without finding a mechanism specifically explaining "near the center." A plausible, technically-grounded fix (increased stroke width to reduce sub-pixel rendering fragility) was applied, but this is not confirmed to be the actual cause.
  - Resolved this session (high confidence, verified): pinch-zoom now correctly anchors on the pinch point rather than always zooming from the top-left corner (was previously mis-diagnosed as fixed in an earlier session but the fix was never actually implemented); arrowhead line pullback so the connecting line no longer pokes through the arrowhead tip; magnifier z-index (was rendering behind the annotator's own overlay, so it never appeared); touch-action fixes so tap/hold on the small custom color/width controls no longer intermittently fails; dash-phase continuity across freehand stroke segments (ultimately superseded by restricting dashes to Arc/Straight Line only, but the underlying fix is still in place for those two tools).
- **Next steps:** None currently planned by the user. Logged but explicitly deferred (not built): shapes (rectangles/circles/triangles/squares, movable/scalable, outline or filled), hatch patterns (concrete/45°-ANSI31/earth/ANSI32 with a boundary-drawing and "close object" workflow), an adjustable protractor tool. Will eventually need to coexist with the 3D annotation tooling described in Section 4.2 — worth noting that section's plan predates this session's major annotator expansion and should be re-read with that in mind before assuming its scope estimates still hold (see Section 6 flag).

### 3.6 PDF Generation (`pdf.js`)
- **Status:** Stable
- **Description:** Report export using jsPDF (CDN-loaded, cached offline). Now contains both the Old Style generator and the New Style generator (`buildAndSaveNewStyleInspectionPDF`), sharing the primitives described in 3.3.
- **Key decisions:** Layout calculations must measure actual rendered content (e.g. real line counts, real map image height) rather than assuming fixed offsets — reconfirmed multiple times this session (list-wrapping bug, Location Map clipping bug) and should stay a default practice for any new PDF layout work.

### 3.7 PDF Editor (`pdfeditor.js`) — new this session
- **Status:** Built — field tested, iterated on based on real usage feedback
- **Description:** Standalone tool for structural PDF editing (rotate, delete, duplicate, reorder, extract, split, combine/insert/append pages from other PDFs) — not tied to any inspection. Reached via its own button on the home screen. Built on **pdf-lib** for actual page manipulation and **pdf.js** for thumbnail/preview rendering.
- **Current capabilities:**
  - Open a PDF, or combine several into one from the start
  - Left sidebar of page thumbnails; main preview shows every page continuously (not one page at a time), with pinch-to-zoom (built on real width changes / layout reflow rather than a CSS transform, after an initial transform-based attempt turned out to have cross-browser scroll-bounds reliability concerns)
  - Multi-select via checkboxes; single-page actions fall back to whichever page is in preview if nothing's selected
  - Rotate (baked directly into both the real PDF page and the thumbnail's actual pixels — not a CSS transform, which was an early bug: rotating an `<img>` via `transform:rotate()` without resizing its box clipped the result)
  - Delete, Duplicate, Extract selected pages
  - Insert or Append pages from a second PDF
  - Split at user-chosen page numbers, producing separate downloaded files
  - Rename, then Save (whole document) or Export (selection if present, else whole document)
  - Drag-and-drop reordering (HTML5 drag-and-drop plus a manual long-press-and-drag fallback, since native drag-and-drop is known to be unreliable on iPadOS Safari)
- **Explicit design decision:** session-only — Save/Export both act on the current in-memory document; nothing persists once the tool is closed. No new database store was added for this reason.
- **Known limitation, stated honestly:** this is the first feature in the app built on a library (pdf-lib, and heavier pdf.js usage) that couldn't be execute-tested in a sandbox during development — both are browser libraries needing real PDF binaries and Canvas rendering. Array-index logic (reorder/duplicate/split) was verified by hand-traced worked examples; the pdf-lib API surface itself was verified only by careful reading of its documented behavior, not live execution, until real device testing confirmed it.
- **Next steps:** None currently planned by the user.

---

## 4. Planned / External Modules

### 4.1 Project Management / Scheduling (Gantt)

- **Status:** In Progress — Phase 1 Step 1 built (untested on device)
- **Decision reversed back:** this module lives **inside Inspector**, vanilla JS, no build step — **not** the separate React/TS/Vite PWA the prior session had pivoted to. Decided explicitly this session after being shown the conflict between the two sessions' opposite conclusions. See the amended Section 5 entry.
- **Description:** Full build brief exists (Microsoft-Project-inspired — WBS, CPM scheduling engine, interactive Gantt, resources, calendars, milestones, baselines, cost tracking, dashboards). Agreed build sequence (unchanged from original scoping):
  1. **Data model + plain editable task table** — ✅ built this session
  2. Read-only Gantt render — not started
  3. CPM scheduling engine (pure, framework-free, unit-testable) — not started
  4. Drag interaction + undo/redo — not started
- **Current capabilities (Step 1, built this session):**
  - New file `js/pm.js`, reached via a new "Project Management" Launcher tile → `#/pm`, same route pattern as Scale/Annotate and PDF Editor
  - New IndexedDB stores in `db.js` (`DB_VERSION` bumped 5→6): `pmProjects`, `pmTasks` (indexed by `projectId` and `parentId`), `pmDependencies` (indexed by `projectId`/`predecessorId`/`successorId` — schema exists now so Step 3 won't need another migration, but nothing reads/writes it yet)
  - Project list screen (create/select projects) → project workspace with a full WBS task table: unlimited nesting, add task/add subtask, indent/outdent, delete (cascades to subtasks + any dependency rows), tap-to-select then tap-to-edit (matches the app's existing sheet-based editing pattern rather than inline tiny inputs)
  - Manual duration/start/finish/% complete per leaf task; milestone flag (zero duration, start=finish, shown with a ◆ marker)
  - **Summary (parent) task rollup is computed at render time, not stored** — earliest child start, latest child finish, total duration, duration-weighted % complete. Matches brief §7 and keeps it impossible for a rollup to drift from the real leaf data.
  - `APP_VERSION` bumped 6.5→6.6, `sw.js` `CACHE_NAME` bumped in step, per the project's own release convention
- **Verification done this session (not yet device-tested):**
  - `node --check` on every new/modified JS file
  - Grepped all files for duplicate top-level `const`/`let`/`function` names — none found
  - Ran a full shared-scope Node `vm` simulation loading all 12 app JS files together — all loaded without cross-file reference errors
  - **Not yet done: real iPad Safari testing.** Treat as `Built — Untested` until confirmed in the field.
- **Explicitly not built yet (by design, per the agreed sequence):** no dependency creation/editing UI, no auto-scheduling from dependencies, no Gantt visual at all, no undo/redo, no resources/calendars/baselines/costs (Phase 2+ per the original brief).
- **Open questions carried forward, not yet decided:**
  - Whether the eventual Gantt chart gets built fully custom or via an open-source library
  - Whether a PM task should be able to link to a real Inspection record — raised as a possibility, not decided
  - `.mpp` compatibility not realistic in-browser; MS Project XML export achievable later if wanted
- **Next steps:** Step 2 — read-only Gantt render from the same data model, no interaction yet.

### 4.2 3D Capture & Monitoring (LiDAR / Object Capture)

- **Status:** Scoping — **not reviewed or touched this session; content below is carried over unchanged from the prior scoping chat.**
- **Description:** Two distinct capture pipelines for structural inspection, driven by the need for native ARKit/Object Capture access that a wrapped web app cannot reach — this is the one capability that requires native Swift code, unlike the rest of the app.
- **Current capabilities:** None yet — concept and architecture only.
- **Key decisions locked in:**
  - **Architecture:** Hybrid — keep Inspector as-is, wrap via Capacitor for App Store distribution, and add a narrow native Swift plugin whose only job is capture (ARKit / Object Capture session) and exporting a mesh file (USDZ/OBJ+texture) back to the JS layer. Full native rewrite explicitly rejected — too costly relative to benefit (see Section 5 decision log).
  - **Viewing/measuring/annotation stays in the web layer** using Three.js (already available), with raycasting for point placement and measurement — not native code.
  - **Two pipelines, not one:**
    - **Pipeline 1 — ARKit scene mesh:** whole-structure / whole-collapse spatial capture. Lower fidelity, real-time. Use case: locating defects against the structure, defining contractor work areas/extents (e.g. wall collapse scope).
    - **Pipeline 2 — Object Capture (photogrammetry):** high-fidelity, non-real-time, photo-series based. Use case: precise defect documentation and **monitoring** — repeated capture of the same location over time (e.g. crack width, spall growth).
  - **Data model direction:** Both pipelines attach to a finding/element as a new attachment type, consistent with the "no new fields, new way of using existing ones" principle. Monitoring specifically needs a **monitoring point** entity distinct from a one-off attachment, since it accumulates multiple dated scans of the same location.
  - **Monitoring requires control points, not just repeated scans.** Confirmed as a genuine structural-survey requirement: fixed points off the structure (so they can't move with it, e.g. a leaning/bulging wall) are needed to align successive scans against a stable reference, otherwise operator position drift is indistinguishable from real structural movement. This is being treated as its own hard sub-problem, not folded into the general Object Capture pipeline.
- **Open questions (unresolved, explicitly parked):**
  1. **Control point alignment method** — physical fiducial markers (reliable, needs field kit) vs. manual "tap to mark Control Point A" + software registration (ICP-style) each visit (flexible, relies on operator care). Not decided.
  2. **Monitoring point persistence scope** — does a monitoring point need to survive across separate inspections for multi-year tracking (likely yes, ideally), or just within one inspection's visit history? Leans toward "yes, multi-year" but not confirmed.
  3. **Geolocation against Location Map section** — should the ARKit structure scan be oriented/geolocated against the existing Location Map section, or stand alone as a per-structure viewable object? Explicitly deferred — to be decided after field-testing a basic scan, not before.
- **Next steps:** Nothing started. Recommended first step when work begins: a minimal ARKit scene-scan plugin (Pipeline 1) with Three.js viewing only — no annotation, no measurement, no control points — to prove the native↔web handoff works at all, before adding complexity.
- **Sequencing relative to other modules:** No hard dependency on the Project Management module. See Section 6 for a flag about this section's annotator-coexistence assumption needing a re-read given how much `annotate.js` changed this session.

### 4.3 Maintenance Module

- **Status:** Not Started — not touched this session.
- **Description:** Mentioned as a future module. No scoping conversation has happened yet.
- **Next steps:** Needs its own scoping discussion before any design decisions are logged here.

---

## 5. Cross-Cutting Decisions Log

Binding decisions that apply across more than one section. Any chat proposing to override one of these should update the entry and explain why, rather than silently contradicting it.

| Date | Decision | Reasoning | Status |
|---|---|---|---|
| 2026-08-15 | ~~New modules (Project Management, 3D Capture) live inside Inspector, vanilla JS, no build step~~ ~~Superseded 2026-08-15: PM module built as a separate PWA outside Inspector~~ **Re-reversed 2026-08-18: Project Management is back to being a module inside Inspector, vanilla JS, no build step — same as 3D Capture and everything else.** Two sessions on the same day reached opposite conclusions on this from the same trade-off; surfaced explicitly to the user this session and decided in favor of staying inside Inspector. | The stack-mismatch cost (React/TS/Vite vs. vanilla JS) that motivated the separate-PWA pivot was judged smaller than the cost of maintaining two codebases and doing a real integration effort later. A pure, framework-free scheduling engine (Step 3) can be written in vanilla JS just as easily as in TypeScript — the mismatch mainly affected the *Gantt rendering* convenience, not the engine itself. | Locked (re-amended — if this flips again, please explain what new information changed it, not just restate the tradeoff) |
| 2026-08-15 | Full native Xcode rewrite of the whole app rejected | Cost (annotator, PDF generation, and data layer all need full re-implementation with no transferable bug fixes) outweighs benefit for most of the app's functionality | Locked |
| 2026-08-15 | Packaging as a native-ish app will be via Capacitor wrapping the existing web code, not a rewrite | Gets native APIs (camera, files, durable storage, App Store distribution) at a fraction of the cost; existing JS/CSS/HTML ports directly into a WKWebView | Locked, not yet implemented |
| 2026-08-15 | LiDAR/Object Capture requires a native Swift plugin (Capacitor plugin), everything else (viewing, measuring, annotating, storage) stays in the web layer via Three.js | ARKit/depth capture has no web API equivalent, wrapped or not — this is the one true native-only requirement in the whole app | Locked |
| 2026-08-15 | Capacitor wrapping should happen only after the Project Management and/or 3D Capture modules are stable, not before | Avoids maintaining two build paths (wrapped + unwrapped) while core files are still under active change | Recommendation, not yet due. (2026-08-18: PM is back inside Inspector, so this no longer implies waiting on a separate integration effort — just on PM/3D Capture reaching a stable point, same as originally intended.) |

---

## 6. Cross-Section Flags

Use this space to note something that affects another section but that you're not the right chat to fix. Format: `[Date] [Your section] → [Affected section]: issue`

- **[2026-08-15] Annotator (3.5) → 3D Capture (4.2):** Section 4.2's plan was written before this session's major Annotator expansion (new tools, adjust-mode system, custom colors/pens, etc.) and its note that the Annotator "will eventually need to coexist with 3D annotation tooling" was a much smaller claim at the time it was written. Whoever picks up 3D Capture next should re-read 3.5 in full before assuming how much overlap or shared infrastructure is realistic between the two.

---

## 7. Change Log

| Date | Chat / Session | What changed |
|---|---|---|
| 2026-08-15 | Scoping chat (PM module + 3D Capture planning) | Created this document. Populated Sections 3 (from prior conversation memory, unverified against source), 4.1 and 4.2 (from live scoping discussion), 5 (initial decisions). Sections 3.2 and 4.3 flagged as needing real content from a chat with source access / a dedicated scoping session respectively. |
| 2026-08-15 | Main development chat (New Style reports, Annotator overhaul, PDF Editor) | Verified Section 3 in full directly against actual `.js` source (resolving the earlier "unverified" caveats on 3.1–3.6). Substantially rewrote 3.2 (real DB schema), 3.4 (extensive New Style changes: renames, nested Structure Sections, full-page section editors, PDF page-flow logic), 3.5 (major Annotator expansion: new tools, adjust mode, custom colors/pens, line styles, two unconfirmed bug fixes flagged honestly). Added new Section 3.7 for the PDF Editor tool (built this session). Updated 4.1 to reflect the Project Management module now being built as a separate PWA outside Inspector, with integration intended later — amended the corresponding Section 5 decision log entry rather than silently overwriting it. Added a Section 6 flag for 3D Capture given how much the Annotator changed. Did not touch 4.2 or 4.3 beyond noting they weren't reviewed this session. |
| 2026-08-18 | PM module build chat | Read `PROJECT_SUMMARY.md` and the real source directly (`db.js`, `app.js`, `launcher.js`, `index.html`, `styles.css`, `sw.js`) — found and surfaced to the user that this roadmap's 4.1 conflicted with a decision made live in conversation. User decided: PM module stays inside Inspector, vanilla JS. Re-amended the Section 5 log entry accordingly. Built Phase 1 Step 1: new `js/pm.js` (WBS task table UI), new `pmProjects`/`pmTasks`/`pmDependencies` stores in `db.js` (`DB_VERSION` 5→6), launcher tile + route wiring, `APP_VERSION`/`CACHE_NAME` bump, small additive CSS block. Verified via `node --check` on all touched files, a full duplicate-top-level-declaration grep across all 12 app JS files, and a shared-scope Node `vm` load simulation of all 12 files together — all clean. **Not yet tested on a real device.** Corrected the stale v4.2/DB-v5 reference in 3.1 to the real current version. Did not touch 4.2 or 4.3. |
