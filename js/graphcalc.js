// graphcalc.js — the Graphing Calculator tool. Two modes (Calculator / Graph) sharing the
// same expression engine (calcparse.js). Matches the app's own visual language (existing
// .btn/.card/.field classes and CSS variables) rather than being a separate, isolated
// experience — unlike the EC2 quiz (a pre-built standalone file with its own theme, isolated
// in an iframe for that reason), this is built from scratch specifically to fit in natively.

const GC_FUNCTION_COLORS = ['#c81e1e', '#1e7dc8', '#4f9d5c', '#9c6d1e', '#7a3fa8', '#1e9c9c'];

let gcState = {
  mode: 'calc',
  expression: '',
  angleMode: 'deg', // matches a physical scientific calculator's own default
  ans: 0,
  history: [], // { expr, result }
  functions: [{ expr: '', visible: true }],
  view: { xMin: -10, xMax: 10, yMin: -10, yMax: 10 }
};

async function renderGraphCalc() {
  appEl.innerHTML = `
    <div class="topbar">
      <button class="icon-btn" id="btn-gc-back">‹</button>
      <div style="flex:1; min-width:0;">
        <h1>Graphing Calculator</h1>
      </div>
      <button class="text-btn" id="btn-gc-mode">${gcState.mode === 'calc' ? 'Graph' : 'Calculator'}</button>
    </div>
    <div id="gc-body" style="flex:1; min-height:0; display:flex; flex-direction:column;"></div>
  `;
  document.getElementById('btn-gc-back').addEventListener('click', () => navigate('#/'));
  document.getElementById('btn-gc-mode').addEventListener('click', () => {
    gcState.mode = gcState.mode === 'calc' ? 'graph' : 'calc';
    renderGraphCalc();
  });
  if (gcState.mode === 'calc') gcRenderCalculator();
  else gcRenderGraph();
}

// ---------------------------------------------------------------------------
// Calculator mode
// ---------------------------------------------------------------------------
function gcRenderCalculator() {
  const body = document.getElementById('gc-body');
  let liveResult = '';
  try {
    if (gcState.expression.trim()) {
      const v = CalcParse.evaluateExpression(gcState.expression, { ans: gcState.ans }, gcState.angleMode);
      if (Number.isFinite(v)) liveResult = gcFormatNumber(v);
    }
  } catch (err) { /* incomplete expression while typing — no live preview, not an error state */ }

  body.innerHTML = `
    <div style="flex:1; overflow-y:auto; padding:10px 16px; display:flex; flex-direction:column-reverse;">
      <div id="gc-history"></div>
    </div>
    <div style="padding:14px 16px; border-top:1px solid var(--line); background:var(--paper);">
      <div style="text-align:right; font-size:13px; color:var(--ink-soft); min-height:18px;">${gcState.angleMode.toUpperCase()}</div>
      <div style="text-align:right; font-size:28px; font-weight:600; word-break:break-all; min-height:36px;">${esc(gcState.expression) || '0'}</div>
      <div style="text-align:right; font-size:16px; color:var(--ink-soft); min-height:20px;">${liveResult ? '= ' + esc(liveResult) : ''}</div>
    </div>
    <div id="gc-buttons" style="display:grid; grid-template-columns:repeat(5,1fr); gap:6px; padding:8px 16px calc(12px + var(--safe-bottom));"></div>
  `;

  const historyEl = document.getElementById('gc-history');
  historyEl.innerHTML = gcState.history.map((h) => `
    <div class="gc-history-row" data-expr="${esc(h.expr)}" style="padding:6px 4px; text-align:right; border-bottom:1px solid var(--line); cursor:pointer;">
      <div style="font-size:13px; color:var(--ink-soft);">${esc(h.expr)}</div>
      <div style="font-size:16px; font-weight:600;">${esc(h.result)}</div>
    </div>
  `).join('');
  historyEl.querySelectorAll('.gc-history-row').forEach((row) => {
    row.addEventListener('click', () => { gcState.expression = row.dataset.expr; gcRenderCalculator(); });
  });

  const buttons = [
    { label: gcState.angleMode.toUpperCase(), action: () => { gcState.angleMode = gcState.angleMode === 'deg' ? 'rad' : 'deg'; } },
    { label: 'AC', action: () => { gcState.expression = ''; } },
    { label: 'DEL', action: () => { gcState.expression = gcState.expression.slice(0, -1); } },
    { label: '(', insert: '(' }, { label: ')', insert: ')' },

    { label: 'sin', insert: 'sin(' }, { label: 'cos', insert: 'cos(' }, { label: 'tan', insert: 'tan(' }, { label: 'x²', insert: '^2' }, { label: 'xʸ', insert: '^' },
    { label: 'asin', insert: 'asin(' }, { label: 'acos', insert: 'acos(' }, { label: 'atan', insert: 'atan(' }, { label: '√', insert: 'sqrt(' }, { label: 'x!', insert: '!' },
    { label: 'log', insert: 'log(' }, { label: 'ln', insert: 'ln(' }, { label: 'π', insert: 'pi' }, { label: 'e', insert: 'e' }, { label: 'Ans', insert: 'ans' },

    { label: '7', insert: '7' }, { label: '8', insert: '8' }, { label: '9', insert: '9' }, { label: '÷', insert: '/' }, { label: '', spacer: true },
    { label: '4', insert: '4' }, { label: '5', insert: '5' }, { label: '6', insert: '6' }, { label: '×', insert: '*' }, { label: '', spacer: true },
    { label: '1', insert: '1' }, { label: '2', insert: '2' }, { label: '3', insert: '3' }, { label: '−', insert: '-' }, { label: '', spacer: true },
    { label: '0', insert: '0' }, { label: '.', insert: '.' }, { label: 'x', insert: 'x' }, { label: '+', insert: '+' }, { label: '=', primary: true, action: gcEvaluateNow }
  ];

  const grid = document.getElementById('gc-buttons');
  grid.innerHTML = buttons.map((b, i) => {
    if (b.spacer) return `<div></div>`;
    return `<button class="gc-btn" data-i="${i}" style="min-height:46px; border-radius:9px; border:1px solid var(--line); background:${b.primary ? 'var(--red)' : '#fff'}; color:${b.primary ? '#fff' : 'var(--ink)'}; font-size:15px; font-weight:650;">${esc(b.label)}</button>`;
  }).join('');
  grid.querySelectorAll('.gc-btn').forEach((btn) => {
    const b = buttons[Number(btn.dataset.i)];
    btn.addEventListener('click', () => {
      if (b.action) b.action();
      else if (b.insert) gcState.expression += b.insert;
      gcRenderCalculator();
    });
  });
}

function gcEvaluateNow() {
  if (!gcState.expression.trim()) return;
  try {
    const v = CalcParse.evaluateExpression(gcState.expression, { ans: gcState.ans }, gcState.angleMode);
    const formatted = gcFormatNumber(v);
    gcState.history.push({ expr: gcState.expression, result: formatted });
    if (gcState.history.length > 50) gcState.history.shift();
    gcState.ans = v;
    gcState.expression = formatted;
  } catch (err) {
    toast('Invalid expression');
  }
}

function gcFormatNumber(v) {
  if (!Number.isFinite(v)) return v > 0 ? '∞' : (v < 0 ? '-∞' : 'undefined');
  // Enough precision to be useful without the long floating-point tails calculators are
  // known for (e.g. 0.1+0.2 showing as 0.30000000000000004 instead of 0.3).
  const rounded = Math.round(v * 1e10) / 1e10;
  return String(rounded);
}

// ---------------------------------------------------------------------------
// Graph mode
// ---------------------------------------------------------------------------
function gcRenderGraph() {
  const body = document.getElementById('gc-body');
  body.innerHTML = `
    <div style="padding:12px 16px; border-bottom:1px solid var(--line);">
      <div id="gc-func-list"></div>
      <button class="btn btn-secondary btn-block" id="btn-gc-add-func" style="margin-top:8px;">+ Add function</button>
    </div>
    <div style="flex:1; min-height:0; position:relative; background:#fff;">
      <canvas id="gc-canvas" style="width:100%; height:100%; display:block; touch-action:none;"></canvas>
      <button id="btn-gc-reset-view" style="position:absolute; top:10px; right:10px; background:rgba(28,31,38,0.7); color:#fff; border:none; border-radius:16px; padding:6px 14px; font-size:12.5px; font-weight:600;">Reset view</button>
    </div>
  `;

  const listEl = document.getElementById('gc-func-list');
  function renderFuncList() {
    listEl.innerHTML = gcState.functions.map((f, i) => `
      <div style="display:flex; align-items:center; gap:8px; margin-bottom:6px;">
        <div style="width:14px; height:14px; border-radius:50%; background:${GC_FUNCTION_COLORS[i % GC_FUNCTION_COLORS.length]}; flex-shrink:0;"></div>
        <span style="font-size:14px; color:var(--ink-soft); flex-shrink:0;">y${i + 1}=</span>
        <input type="text" class="gc-func-input" data-i="${i}" value="${esc(f.expr)}" placeholder="e.g. x^2 - 3" style="flex:1; padding:8px 10px; border-radius:8px; border:1px solid var(--line); font-size:15px;">
        <button class="gc-func-remove" data-i="${i}" style="background:none; border:none; color:var(--red); font-size:20px; padding:4px;">✕</button>
      </div>
    `).join('');
    listEl.querySelectorAll('.gc-func-input').forEach((input) => {
      input.addEventListener('input', () => {
        gcState.functions[Number(input.dataset.i)].expr = input.value;
        gcDrawGraph();
      });
    });
    listEl.querySelectorAll('.gc-func-remove').forEach((btn) => {
      btn.addEventListener('click', () => {
        gcState.functions.splice(Number(btn.dataset.i), 1);
        if (!gcState.functions.length) gcState.functions.push({ expr: '', visible: true });
        renderFuncList();
        gcDrawGraph();
      });
    });
  }
  renderFuncList();

  document.getElementById('btn-gc-add-func').addEventListener('click', () => {
    if (gcState.functions.length >= 6) { toast('Up to 6 functions at once'); return; }
    gcState.functions.push({ expr: '', visible: true });
    renderFuncList();
  });
  document.getElementById('btn-gc-reset-view').addEventListener('click', () => {
    gcState.view = { xMin: -10, xMax: 10, yMin: -10, yMax: 10 };
    gcDrawGraph();
  });

  gcWireGraphTouch();
  // Canvas backing size must match its actual rendered size for crisp lines — deferred one
  // frame so the layout above has settled before reading clientWidth/clientHeight.
  requestAnimationFrame(() => gcDrawGraph());
}

function gcNiceStep(range) {
  const roughStep = range / 10;
  const magnitude = Math.pow(10, Math.floor(Math.log10(roughStep)));
  const residual = roughStep / magnitude;
  let niceResidual;
  if (residual > 5) niceResidual = 10;
  else if (residual > 2) niceResidual = 5;
  else if (residual > 1) niceResidual = 2;
  else niceResidual = 1;
  return niceResidual * magnitude;
}

function gcDrawGraph() {
  const canvas = document.getElementById('gc-canvas');
  if (!canvas) return;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  const { xMin, xMax, yMin, yMax } = gcState.view;

  const toPx = (x, y) => ({ px: ((x - xMin) / (xMax - xMin)) * w, py: h - ((y - yMin) / (yMax - yMin)) * h });

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);

  // Gridlines at "nice" intervals (1/2/5 × a power of 10) rather than a fixed step, so the
  // grid stays readable whether you're zoomed into a 0.1-wide range or zoomed out to 1000.
  const stepX = gcNiceStep(xMax - xMin), stepY = gcNiceStep(yMax - yMin);
  ctx.strokeStyle = '#e5e5e8'; ctx.lineWidth = 1;
  ctx.font = '11px -apple-system, sans-serif'; ctx.fillStyle = '#8a8f99';
  for (let x = Math.ceil(xMin / stepX) * stepX; x <= xMax; x += stepX) {
    const { px } = toPx(x, 0);
    ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, h); ctx.stroke();
    if (Math.abs(x) > stepX / 1000) ctx.fillText(gcFormatNumber(x), px + 3, h - 4);
  }
  for (let y = Math.ceil(yMin / stepY) * stepY; y <= yMax; y += stepY) {
    const { py } = toPx(0, y);
    ctx.beginPath(); ctx.moveTo(0, py); ctx.lineTo(w, py); ctx.stroke();
    if (Math.abs(y) > stepY / 1000) ctx.fillText(gcFormatNumber(y), 3, py - 3);
  }

  // Axes, only drawn where actually within the visible range.
  ctx.strokeStyle = '#8a8f99'; ctx.lineWidth = 1.5;
  if (xMin <= 0 && xMax >= 0) { const { px } = toPx(0, 0); ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, h); ctx.stroke(); }
  if (yMin <= 0 && yMax >= 0) { const { py } = toPx(0, 0); ctx.beginPath(); ctx.moveTo(0, py); ctx.lineTo(w, py); ctx.stroke(); }

  gcState.functions.forEach((f, i) => {
    if (!f.expr.trim()) return;
    let ast;
    try { ast = CalcParse.parse(f.expr, gcState.angleMode); } catch (err) { return; } // invalid mid-typing — just don't plot yet
    ctx.strokeStyle = GC_FUNCTION_COLORS[i % GC_FUNCTION_COLORS.length];
    ctx.lineWidth = 2;
    ctx.beginPath();
    let prevPx = null, prevPy = null, penDown = false;
    for (let px = 0; px <= w; px++) {
      const x = xMin + (px / w) * (xMax - xMin);
      let y;
      try { y = CalcParse.evaluate(ast, { x, ans: gcState.ans }, gcState.angleMode); } catch (err) { y = NaN; }
      if (!Number.isFinite(y)) { penDown = false; continue; }
      const py = h - ((y - yMin) / (yMax - yMin)) * h;
      // A huge jump between consecutive pixel columns means an asymptote (e.g. tan(x)) was
      // crossed, not a genuine near-vertical segment of the curve — lifting the pen here
      // avoids drawing a spurious vertical line straight across the whole graph.
      if (penDown && prevPy != null && Math.abs(py - prevPy) > h * 1.5) penDown = false;
      if (!penDown) { ctx.moveTo(px, py); penDown = true; } else { ctx.lineTo(px, py); }
      prevPx = px; prevPy = py;
    }
    ctx.stroke();
  });
}

// Single-pointer drag pans; two-pointer pinch zooms — same active-pointer-tracking approach
// already used for pinch-to-zoom elsewhere in this app (the PDF Editor's preview, the
// annotator), adapted here to pan/scale a math-space view window rather than a CSS width.
function gcWireGraphTouch() {
  const canvas = document.getElementById('gc-canvas');
  const pointers = new Map();
  let lastMid = null, lastDist = null;

  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    lastMid = null; lastDist = null;
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    const prev = pointers.get(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pts = Array.from(pointers.values());
    const { xMin, xMax, yMin, yMax } = gcState.view;
    const w = canvas.clientWidth, h = canvas.clientHeight;

    if (pts.length === 1) {
      const dxPx = e.clientX - prev.x, dyPx = e.clientY - prev.y;
      const dxMath = -(dxPx / w) * (xMax - xMin);
      const dyMath = (dyPx / h) * (yMax - yMin);
      gcState.view = { xMin: xMin + dxMath, xMax: xMax + dxMath, yMin: yMin + dyMath, yMax: yMax + dyMath };
      gcDrawGraph();
    } else if (pts.length === 2) {
      const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
      const dist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
      if (lastDist != null) {
        const scale = lastDist / dist; // pinch out (dist grows) -> scale<1 -> zoom in
        const rect = canvas.getBoundingClientRect();
        const mathMidX = xMin + ((mid.x - rect.left) / w) * (xMax - xMin);
        const mathMidY = yMax - ((mid.y - rect.top) / h) * (yMax - yMin);
        gcState.view = {
          xMin: mathMidX - (mathMidX - xMin) * scale, xMax: mathMidX + (xMax - mathMidX) * scale,
          yMin: mathMidY - (mathMidY - yMin) * scale, yMax: mathMidY + (yMax - mathMidY) * scale
        };
        gcDrawGraph();
      }
      lastMid = mid; lastDist = dist;
    }
  });
  function clearPointer(e) { pointers.delete(e.pointerId); lastMid = null; lastDist = null; }
  canvas.addEventListener('pointerup', clearPointer);
  canvas.addEventListener('pointercancel', clearPointer);
}
