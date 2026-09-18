// ============================================================================
// Cross-section SVG diagrams — mass wall and cantilever wall.
// Pure functions of the geometry state; no DOM dependency, so these are
// testable head-on with plain Node before ever touching a browser.
// Coordinate convention matches calc.js exactly: x=0 at the toe/front face,
// y=0 at the underside of the base (founding level).
// ============================================================================
'use strict';

const SVG_W = 640, SVG_H = 400;
const MARGIN = 64;

function svgHead() {
  return `<svg viewBox="0 0 ${SVG_W} ${SVG_H}" xmlns="http://www.w3.org/2000/svg" font-family="var(--sans),sans-serif">
  <defs>
    <pattern id="hatchBackfill" width="8" height="8" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
      <rect width="8" height="8" fill="#E8EDE2"/>
      <line x1="0" y1="0" x2="0" y2="8" stroke="#AFC08F" stroke-width="1.6"/>
    </pattern>
    <pattern id="hatchFound" width="8" height="8" patternTransform="rotate(-45)" patternUnits="userSpaceOnUse">
      <rect width="8" height="8" fill="#EFE7D8"/>
      <line x1="0" y1="0" x2="0" y2="8" stroke="#C7AE7E" stroke-width="1.6"/>
    </pattern>
    <marker id="arrowL" viewBox="0 0 10 10" refX="1" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M10,1 L1,5 L10,9 Z" fill="#546076"/>
    </marker>
    <marker id="arrowR" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,1 L9,5 L0,9 Z" fill="#546076"/>
    </marker>
    <marker id="thrustHead" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M0,1 L9,5 L0,9 Z" fill="#B5482F"/>
    </marker>
  </defs>
  <rect x="0" y="0" width="${SVG_W}" height="${SVG_H}" fill="#FBFCFE"/>`;
}

// Build a coordinate transform given the real-world (metre) bounding box.
function makeTransform(xMin, xMax, yMin, yMax) {
  const availW = SVG_W - 2 * MARGIN, availH = SVG_H - 2 * MARGIN;
  const xRange = xMax - xMin, yRange = yMax - yMin;
  const scale = Math.min(availW / xRange, availH / yRange);
  const drawW = xRange * scale, drawH = yRange * scale;
  const offX = MARGIN + (availW - drawW) / 2;
  const offY = MARGIN + (availH - drawH) / 2;
  return {
    scale,
    X: (x) => offX + (x - xMin) * scale,
    Y: (y) => (SVG_H - offY) - (y - yMin) * scale, // flip: y up in model, down in SVG
  };
}

function poly(T, pts, fill, opts = {}) {
  const d = pts.map(([x, y]) => `${T.X(x).toFixed(1)},${T.Y(y).toFixed(1)}`).join(' ');
  return `<polygon points="${d}" fill="${fill}" stroke="${opts.stroke || '#3A4256'}" stroke-width="${opts.sw || 1.5}"/>`;
}
function lineSeg(T, x1, y1, x2, y2, opts = {}) {
  return `<line x1="${T.X(x1).toFixed(1)}" y1="${T.Y(y1).toFixed(1)}" x2="${T.X(x2).toFixed(1)}" y2="${T.Y(y2).toFixed(1)}"
    stroke="${opts.stroke || '#3A4256'}" stroke-width="${opts.sw || 1.5}" ${opts.dash ? `stroke-dasharray="${opts.dash}"` : ''}/>`;
}
function label(T, x, y, text, opts = {}) {
  const anchor = opts.anchor || 'middle';
  const dy = opts.dy ?? 0;
  return `<text x="${T.X(x).toFixed(1)}" y="${(T.Y(y) + dy).toFixed(1)}" font-size="${opts.size || 12}"
    fill="${opts.fill || '#26304A'}" text-anchor="${anchor}" ${opts.weight ? `font-weight="${opts.weight}"` : ''}>${text}</text>`;
}

// A horizontal dimension line with end-ticks, placed at real-world y=dimY,
// spanning x1..x2, with a text label centred above/below it.
function dimH(T, x1, x2, dimY, text, opts = {}) {
  const y1 = T.Y(dimY), x1p = T.X(x1), x2p = T.X(x2);
  const tick = 5;
  let s = `<line x1="${x1p}" y1="${y1}" x2="${x2p}" y2="${y1}" stroke="#7A8496" stroke-width="1" marker-start="url(#arrowL)" marker-end="url(#arrowR)"/>`;
  s += `<line x1="${x1p}" y1="${y1 - tick}" x2="${x1p}" y2="${y1 + tick}" stroke="#7A8496" stroke-width="1"/>`;
  s += `<line x1="${x2p}" y1="${y1 - tick}" x2="${x2p}" y2="${y1 + tick}" stroke="#7A8496" stroke-width="1"/>`;
  const midX = T.X((x1 + x2) / 2);
  const dy = opts.below ? 14 : -6;
  s += `<text x="${midX}" y="${y1 + dy}" font-size="11.5" fill="#4A5568" text-anchor="middle">${text}</text>`;
  return s;
}
// A vertical dimension line with end-ticks, placed at real-world x=dimX.
function dimV(T, y1, y2, dimX, text, opts = {}) {
  const x1p = T.X(dimX), y1p = T.Y(y1), y2p = T.Y(y2);
  const tick = 5;
  let s = `<line x1="${x1p}" y1="${y1p}" x2="${x1p}" y2="${y2p}" stroke="#7A8496" stroke-width="1" marker-start="url(#arrowL)" marker-end="url(#arrowR)" transform="rotate(90 ${x1p} ${(y1p + y2p) / 2})"/>`;
  // (rotating a horizontal arrow-line 90deg about its own midpoint keeps arrowheads correct without separate vertical markers)
  s += `<line x1="${x1p - tick}" y1="${y1p}" x2="${x1p + tick}" y2="${y1p}" stroke="#7A8496" stroke-width="1"/>`;
  s += `<line x1="${x1p - tick}" y1="${y2p}" x2="${x1p + tick}" y2="${y2p}" stroke="#7A8496" stroke-width="1"/>`;
  const midY = (y1p + y2p) / 2;
  const dx = opts.left ? -10 : 10;
  s += `<text x="${x1p + dx}" y="${midY + 4}" font-size="11.5" fill="#4A5568" text-anchor="${opts.left ? 'end' : 'start'}">${text}</text>`;
  return s;
}

// Pressure-triangle glyph along a vertical back plane at x=xBack, showing the
// active-pressure profile increasing linearly with depth (zero at yTop, max
// at yBase), pointing left into the wall.
function pressureTriangle(T, xBack, yBase, yTop, label_) {
  const pxWidth = 34;
  const xOuter = xBack + pxWidth / T.scale;
  const pts = [[xBack, yTop], [xOuter, yBase], [xBack, yBase]];
  let s = poly(T, pts, 'rgba(181,72,47,0.16)', { stroke: '#B5482F', sw: 1 });
  // a few arrows across the height showing direction of thrust
  const n = 3;
  for (let i = 1; i <= n; i++) {
    const y = yBase + ((yTop - yBase) * i) / (n + 1);
    const frac = (yBase === yTop) ? 0 : (y - yTop) / (yBase - yTop);
    const xStart = xBack + (pxWidth / T.scale) * frac;
    s += `<line x1="${T.X(xStart).toFixed(1)}" y1="${T.Y(y).toFixed(1)}" x2="${T.X(xBack).toFixed(1)}" y2="${T.Y(y).toFixed(1)}"
      stroke="#B5482F" stroke-width="1.4" marker-end="url(#thrustHead)"/>`;
  }
  s += label(T, xOuter + 0.15, (yBase + yTop) / 2, label_, { anchor: 'start', size: 11, fill: '#8C3A22', weight: 600 });
  return s;
}

function legendSwatch(x, y, fill, text) {
  return `<rect x="${x}" y="${y}" width="12" height="12" fill="${fill}" stroke="#8a94a6" stroke-width="0.75"/>
    <text x="${x + 18}" y="${y + 10.5}" font-size="11" fill="#4A5568">${text}</text>`;
}

// ---------------------------------------------------------------------------
// MASS WALL diagram
// ---------------------------------------------------------------------------
function svgMassWall(geo) {
  const { H, b1, B } = geo;
  const Df = geo.Df;
  const padFront = Math.max(0.8, B * 0.35);
  const padBack = Math.max(0.8, B * 0.45);
  const padBelow = Math.max(0.4, H * 0.12);
  const padAbove = Math.max(0.6, H * 0.18);

  const xMin = -padFront, xMax = B + padBack;
  const yMin = -padBelow, yMax = H + padAbove;
  const T = makeTransform(xMin, xMax, yMin, yMax);

  let s = svgHead();

  // founding stratum
  s += poly(T, [[xMin, yMin], [xMax, yMin], [xMax, 0], [xMin, 0]], 'url(#hatchFound)', { stroke: 'none' });
  // front cover soil (toe embedment)
  s += poly(T, [[xMin, 0], [0, 0], [0, Df], [xMin, Df]], 'url(#hatchFound)', { stroke: 'none' });
  // retained soil wedge behind battered face
  s += poly(T, [[b1, H], [B, H], [B, 0]], 'url(#hatchBackfill)', { stroke: '#3A4256', sw: 1 });
  // ground lines
  s += lineSeg(T, xMin, Df, 0, Df, { stroke: '#5B6B45', sw: 2 });
  s += lineSeg(T, b1, H, xMax, H, { stroke: '#5B6B45', sw: 2 });
  // founding level line
  s += lineSeg(T, xMin, 0, xMax, 0, { stroke: '#8a7a4f', sw: 1, dash: '3,3' });

  // wall body
  s += poly(T, [[0, 0], [0, H], [b1, H], [B, 0]], '#C7CCD6');

  // active pressure indicator on virtual back plane at x=B
  s += pressureTriangle(T, B, 0, H, 'Ka·γ·z (+ q)');

  // dimensions
  s += dimV(T, 0, H, xMin + padFront * 0.28, 'H', { left: true });
  s += dimV(T, 0, Df, xMin + padFront * 0.62, 'Df', { left: true });
  s += dimH(T, 0, b1, H, 'b1', { below: false });
  s += dimH(T, 0, B, yMin + padBelow * 0.4, 'B', { below: true });

  // labels
  s += label(T, b1 / 2, H * 0.55, 'Mass wall', { size: 12.5, weight: 700, fill: '#26304A' });
  s += label(T, (b1 + B) / 2, H * 0.6, 'Retained fill', { size: 10.5, fill: '#4A6236' });

  // legend
  s += legendSwatch(SVG_W - 168, 14, '#C7CCD6', 'Concrete');
  s += legendSwatch(SVG_W - 168, 32, '#E8EDE2', 'Backfill');
  s += legendSwatch(SVG_W - 168, 50, '#EFE7D8', 'Founding stratum');

  s += '</svg>';
  return s;
}

// ---------------------------------------------------------------------------
// CANTILEVER WALL diagram
// ---------------------------------------------------------------------------
function svgCantileverWall(geo) {
  const { hs, ts, tb, Lt, Lh } = geo;
  const Df = geo.Df;
  const B = Lt + ts + Lh;
  const H = hs + tb;
  const xStemBack = Lt + ts;

  const padFront = Math.max(0.8, B * 0.3);
  const padBack = Math.max(0.8, B * 0.28);
  const padBelow = Math.max(0.4, H * 0.12);
  const padAbove = Math.max(0.6, H * 0.16);

  const xMin = -padFront, xMax = B + padBack;
  const yMin = -padBelow, yMax = H + padAbove;
  const T = makeTransform(xMin, xMax, yMin, yMax);

  let s = svgHead();

  // founding stratum
  s += poly(T, [[xMin, yMin], [xMax, yMin], [xMax, 0], [xMin, 0]], 'url(#hatchFound)', { stroke: 'none' });

  const frontGroundY = Math.max(Df, 0);
  const toeBuried = frontGroundY > tb;

  // genuine ground in front of the wall, down to founding level
  s += poly(T, [[xMin, 0], [0, 0], [0, frontGroundY], [xMin, frontGroundY]], 'url(#hatchFound)', { stroke: 'none' });
  // fill placed over the toe slab, if the toe is buried below the front ground line
  if (toeBuried) {
    s += poly(T, [[0, tb], [Lt, tb], [Lt, frontGroundY], [0, frontGroundY]], 'url(#hatchBackfill)', { stroke: 'none' });
  }

  // retained soil on heel
  s += poly(T, [[xStemBack, tb], [B, tb], [B, H], [xStemBack, H]], 'url(#hatchBackfill)', { stroke: '#3A4256', sw: 1 });

  // ground lines
  s += lineSeg(T, xMin, frontGroundY, xStemBack, frontGroundY, { stroke: '#5B6B45', sw: 2 });
  s += lineSeg(T, B, H, xMax, H, { stroke: '#5B6B45', sw: 2 });
  s += lineSeg(T, xMin, 0, xMax, 0, { stroke: '#8a7a4f', sw: 1, dash: '3,3' });

  // wall body: base slab + stem
  s += poly(T, [[0, 0], [B, 0], [B, tb], [0, tb]], '#C7CCD6');
  s += poly(T, [[Lt, tb], [xStemBack, tb], [xStemBack, H], [Lt, H]], '#C7CCD6');

  // active pressure indicator on virtual back plane at x=B, over full height H
  s += pressureTriangle(T, B, 0, H, 'Ka·γ·z (+ q)');

  // dimensions
  s += dimV(T, tb, H, xMin + padFront * 0.18, 'hs', { left: true });
  s += dimV(T, 0, tb, xMin + padFront * 0.5, 'tb', { left: true });
  s += dimV(T, 0, frontGroundY, xMin + padFront * 0.82, 'Df', { left: true });
  s += dimH(T, 0, Lt, yMin + padBelow * 0.4, 'Lt', { below: true });
  s += dimH(T, xStemBack, B, yMin + padBelow * 0.4, 'Lh', { below: true });
  s += dimH(T, Lt, xStemBack, tb + hs * 0.12, 'ts', { below: false });
  s += dimH(T, 0, B, yMin - padBelow * 0.55, 'B', { below: true });

  // labels
  s += label(T, xStemBack + Lh / 2, H * 0.55, 'Cantilever wall', { size: 12.5, weight: 700, fill: '#26304A', anchor: 'middle' });

  // legend
  s += legendSwatch(SVG_W - 168, 14, '#C7CCD6', 'Concrete');
  s += legendSwatch(SVG_W - 168, 32, '#E8EDE2', 'Backfill');
  s += legendSwatch(SVG_W - 168, 50, '#EFE7D8', 'Founding stratum');

  s += '</svg>';
  return s;
}

if (typeof module !== 'undefined') {
  module.exports = { svgMassWall, svgCantileverWall, makeTransform };
}
