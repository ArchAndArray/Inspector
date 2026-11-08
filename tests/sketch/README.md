Sketch / Annotator tests (written in the build sandbox; paths inside are absolute and may need editing).
Node-only: `node inktest.js` (pen engine). Browser (Playwright, app served at http://localhost:8765/ from the app folder):
ink_ui, shapes_ui, layout_ui, sketch_repro, sketch_tools, sketch_finger. `dups.js <appdir>` finds duplicate top-level declarations (a Safari SyntaxError).
Synthetic pointer events only - nothing here replaces trying it with a real Pencil on a real iPad.
