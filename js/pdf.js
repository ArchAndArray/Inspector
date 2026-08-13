// pdf.js - builds the exportable inspection report using jsPDF (loaded from CDN, cached by service worker)

const SEV_COLORS_RGB = {
  1: [79, 157, 92],
  2: [143, 174, 63],
  3: [224, 167, 46],
  4: [224, 103, 46],
  5: [200, 30, 30]
};

const PRIORITY_COLORS_RGB = {
  High: [200, 30, 30],
  Medium: [224, 103, 46],
  Low: [79, 157, 92],
  Monitor: [30, 125, 200]
};

// CURRENCY_SYMBOLS is defined once, in app.js (which loads before this file) — declaring
// it again here as well was a real bug: two top-level `const` bindings with the same name
// sharing the same global scope is a SyntaxError in Safari, and it silently prevented this
// entire file from loading, which is what broke both Export buttons.

// Loads a blob as an upright, normalized image (corrects EXIF rotation even for photos
// captured before the in-app fix) and returns a dataURL + pixel dimensions ready for jsPDF.
async function loadNormalizedImage(blob) {
  try {
    const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    const w = bitmap.width, h = bitmap.height; // capture before close() — close() resets these to 0
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    if (bitmap.close) bitmap.close();
    return { url: canvas.toDataURL('image/jpeg', 0.92), w, h };
  } catch (err) {
    // Fallback: plain read, no orientation correction available
    const url = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
    const dims = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
      img.onerror = reject;
      img.src = url;
    });
    return { url, ...dims };
  }
}

// ---------- Location Map (auto-generated from OpenStreetMap tiles, no API key needed) ----------
//
// There's no free "static map image" service usable without an account, so this fetches
// the raw OSM tiles directly (the same source the in-app map picker already uses) and
// composites them into one image itself, with a pin at the exact structure location.
//
// The target scale (1:2500) is genuinely an approximation: true cartographic scale depends
// on both latitude (Web Mercator distorts by latitude) and the physical print size of the
// image, so the zoom level is calculated to land close to 1:2500 for THIS image's actual
// placement size in the report — not a universal guarantee at every location on Earth.
function lonToTileX(lon, zoom) { return ((lon + 180) / 360) * Math.pow(2, zoom); }
function latToTileY(lat, zoom) {
  const latRad = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * Math.pow(2, zoom);
}
function computeZoomForScale(lat, targetScale, placementWidthPt, pxW) {
  const dpi = pxW / (placementWidthPt / 72);
  const metersPerPixelOnPaper = 0.0254 / dpi;
  const targetGroundResolution = metersPerPixelOnPaper * targetScale;
  const latRad = (lat * Math.PI) / 180;
  const zoomFloat = Math.log2((156543.03392 * Math.cos(latRad)) / targetGroundResolution);
  return Math.max(1, Math.min(19, Math.round(zoomFloat)));
}

async function generateLocationMapImage(lat, lng, placementWidthPt, pxW, pxH, scale) {
  const zoom = computeZoomForScale(lat, scale || 2500, placementWidthPt, pxW);
  const TILE_SIZE = 256;
  const centerPxX = lonToTileX(lng, zoom) * TILE_SIZE;
  const centerPxY = latToTileY(lat, zoom) * TILE_SIZE;
  const originWorldX = centerPxX - pxW / 2;
  const originWorldY = centerPxY - pxH / 2;
  const firstTileX = Math.floor(originWorldX / TILE_SIZE);
  const firstTileY = Math.floor(originWorldY / TILE_SIZE);
  const lastTileX = Math.floor((originWorldX + pxW) / TILE_SIZE);
  const lastTileY = Math.floor((originWorldY + pxH) / TILE_SIZE);
  const numTiles = Math.pow(2, zoom);

  const canvas = document.createElement('canvas');
  canvas.width = pxW; canvas.height = pxH;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#e8e8e8';
  ctx.fillRect(0, 0, pxW, pxH);

  const loads = [];
  for (let tx = firstTileX; tx <= lastTileX; tx++) {
    for (let ty = firstTileY; ty <= lastTileY; ty++) {
      if (ty < 0 || ty >= numTiles) continue;
      const wrappedX = ((tx % numTiles) + numTiles) % numTiles;
      const destX = tx * TILE_SIZE - originWorldX;
      const destY = ty * TILE_SIZE - originWorldY;
      const url = `https://tile.openstreetmap.org/${zoom}/${wrappedX}/${ty}.png`;
      loads.push(new Promise((resolve) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => { try { ctx.drawImage(img, destX, destY); } catch (e) {} resolve(); };
        img.onerror = () => resolve(); // a missing tile just leaves the grey background showing through
        img.src = url;
      }));
    }
  }
  await Promise.all(loads);

  // Pin marker at the exact center — that pixel is precisely the structure's coordinates,
  // since the tile fetch was centered on them.
  const cx = pxW / 2, cy = pxH / 2;
  ctx.fillStyle = '#c81e1e';
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx - 9, cy - 22);
  ctx.lineTo(cx + 9, cy - 22);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx, cy - 28, 11, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2.5;
  ctx.stroke();

  // Throws SecurityError if any tile load left the canvas cross-origin-tainted — caught by
  // the caller, which treats it the same as any other map-generation failure (skip + warn).
  return canvas.toDataURL('image/jpeg', 0.85);
}

async function buildLocationMapForReport(insp, { contentW }) {
  const MAP_PX_W = 900, MAP_PX_H = 680; // doubled height per feedback — lands close to true half-page
  const placementW = contentW;
  const placementH = contentW * (MAP_PX_H / MAP_PX_W);

  if (insp.locationMapMode === 'custom') {
    try {
      const custom = await DB.getCustomLocationMap(insp.id);
      if (!custom) return null;
      const data = await loadNormalizedImage(custom.originalBlob);
      let w = placementW, h = (data.h / data.w) * w;
      if (h > placementH) { h = placementH; w = (data.w / data.h) * h; }
      return { url: data.url, w, h };
    } catch (err) {
      console.error('Custom map load failed', err);
      return null;
    }
  }

  const lat = insp.location && insp.location.lat;
  const lng = insp.location && insp.location.lng;
  if (lat == null || lng == null) return null;

  try {
    const url = await generateLocationMapImage(lat, lng, placementW, MAP_PX_W, MAP_PX_H, insp.locationMapScale);
    return { url, w: placementW, h: placementH };
  } catch (err) {
    console.error('Location map generation failed', err);
    return null;
  }
}

function drawInspectionDetailsBlock(doc, insp, y, { margin, contentW }) {
  const details = [
    ['Structure name', insp.structureName || '—'],
    ['Structure ID', insp.structureId || '—'],
    ['Client', insp.client || '—'],
    ['Reference', insp.reference || '—'],
    ['Inspection type', insp.inspectionType || '—'],
    ['Date', fmtDate(insp.date)],
    ['Inspector', insp.inspector || '—'],
    ['Weather', insp.weather || '—'],
    ['Location', (insp.location && insp.location.manual) || '—']
  ];
  doc.setFontSize(11);
  for (const [label, value] of details) {
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(74, 79, 90);
    doc.text(label, margin, y);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(28, 31, 38);
    doc.text(String(value), margin + 150, y, { maxWidth: contentW - 150 });
    y += 22;
  }
  if (insp.notes) {
    y += 10;
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(74, 79, 90);
    doc.text('Notes', margin, y);
    y += 16;
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(28, 31, 38);
    const lines = doc.splitTextToSize(insp.notes, contentW);
    doc.text(lines, margin, y);
    y += lines.length * 14;
  }
  return y;
}

function drawElementSummaryTableForGroups(doc, groups, y, { margin, contentW, pageH, title }) {
  if (y > pageH - 150) { doc.addPage(); y = margin; }
  y = pageHeading(doc, title || 'Element Summary', y);

  const rows = [];
  for (const g of groups) {
    for (const ed of g.elementData) {
      let worstSeverity = 0, worstExtent = '';
      const extentOrder = ['A', 'B', 'C', 'D', 'E'];
      ed.findings.forEach((f) => {
        if (f.severity && f.severity > worstSeverity) worstSeverity = f.severity;
        if (f.extent && (!worstExtent || extentOrder.indexOf(f.extent) > extentOrder.indexOf(worstExtent))) worstExtent = f.extent;
      });
      rows.push([
        g.section ? g.section.name : '—',
        ed.element.name,
        ed.element.materialType || '—',
        ed.element.location || '—',
        String(ed.findings.length),
        worstSeverity ? String(worstSeverity) : '—',
        worstExtent || '—'
      ]);
    }
  }

  if (doc.autoTable) {
    doc.autoTable({
      startY: y,
      margin: { left: margin, right: margin },
      head: [['Section', 'Element', 'Material', 'Location', 'Findings', 'Worst Sev.', 'Worst Ext.']],
      body: rows,
      styles: { font: 'helvetica', fontSize: 8.5, cellPadding: 5 },
      headStyles: { fillColor: [28, 31, 38], textColor: 255 },
      didParseCell: (data) => {
        if (data.section === 'body' && data.column.index === 5) {
          const sev = Number(data.cell.raw);
          if (SEV_COLORS_RGB[sev]) {
            data.cell.styles.textColor = SEV_COLORS_RGB[sev];
            data.cell.styles.fontStyle = 'bold';
          }
        }
      }
    });
    y = doc.lastAutoTable.finalY + 20;
  } else {
    doc.setFontSize(9);
    rows.forEach((r) => { doc.text(r.join('   |   '), margin, y); y += 14; });
  }
  return y;
}

// Draws one group's (section's) header plus every element and finding within it — the
// reusable core of the detailed findings loop, used both for Old Style's all-groups-in-
// sequence flow and for New Style's single Inspection-type section.
function drawGroupFindings(doc, insp, g, y, { margin, contentW, pageH, pageW }) {
  if (g.section) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(18);
    doc.setTextColor(200, 30, 30);
    doc.text(g.section.name, margin, y);
    y += 22;
    if (g.section.comments) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(10.5);
      doc.setTextColor(74, 79, 90);
      const lines = doc.splitTextToSize(g.section.comments, contentW);
      doc.text(lines, margin, y);
      y += lines.length * 13 + 6;
    }
    doc.setDrawColor(220, 223, 228);
    doc.line(margin, y, pageW - margin, y);
    y += 20;
  }

  for (const ed of g.elementData) {
    if (y > pageH - margin - 60) { doc.addPage(); y = margin; }

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(15);
    doc.setTextColor(28, 31, 38);
    doc.text(ed.element.name, margin, y);
    y += 18;

    const meta = [ed.element.materialType, ed.element.location].filter(Boolean).join('   ·   ');
    if (meta) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(10);
      doc.setTextColor(120, 124, 132);
      doc.text(meta, margin, y);
      y += 16;
    }

    if (ed.refPhotos.length) {
      for (const p of ed.refPhotos) {
        y = drawPhotoBlock(doc, p, p.caption, y, { margin, contentW, pageH });
      }
    }

    doc.setDrawColor(235, 236, 239);
    doc.line(margin, y, pageW - margin, y);
    y += 16;

    if (!ed.findings.length) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(10.5);
      doc.setTextColor(120, 124, 132);
      doc.text('No findings recorded for this element.', margin, y);
      y += 24;
      continue;
    }

    for (const f of ed.findings) {
      if (y + 60 > pageH - margin) { doc.addPage(); y = margin; }

      let bx = margin;
      if (f.severity) {
        const col = SEV_COLORS_RGB[f.severity];
        doc.setFillColor(col[0], col[1], col[2]);
        const label = `S${f.severity} · ${SEVERITY_LABELS[f.severity]}`;
        const w = doc.getTextWidth(label) + 16;
        doc.roundedRect(bx, y, w, 20, 10, 10, 'F');
        doc.setTextColor(255, 255, 255);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(10);
        doc.text(label, bx + 8, y + 14);
        bx += w + 8;
      }
      if (f.extent) {
        doc.setFillColor(28, 31, 38);
        const label = `${f.extent} · ${EXTENT_LABELS[f.extent]}`;
        const w = doc.getTextWidth(label) + 16;
        doc.roundedRect(bx, y, w, 20, 10, 10, 'F');
        doc.setTextColor(255, 255, 255);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(10);
        doc.text(label, bx + 8, y + 14);
        bx += w + 8;
      }
      if (f.priority) {
        const col = PRIORITY_COLORS_RGB[f.priority] || [120, 124, 132];
        doc.setFillColor(col[0], col[1], col[2]);
        const label = `Priority: ${f.priority}`;
        const w = doc.getTextWidth(label) + 16;
        doc.roundedRect(bx, y, w, 20, 10, 10, 'F');
        doc.setTextColor(255, 255, 255);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(10);
        doc.text(label, bx + 8, y + 14);
      }
      y += 32;

      if (f.notes) {
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(10.5);
        doc.setTextColor(28, 31, 38);
        const lines = doc.splitTextToSize(f.notes, contentW);
        if (y + lines.length * 13 > pageH - margin) { doc.addPage(); y = margin; }
        doc.text(lines, margin, y);
        y += lines.length * 13 + 8;
      }

      if (f.worksRequired) {
        if (y + 40 > pageH - margin) { doc.addPage(); y = margin; }
        const boxTop = y;
        let boxLines = [];
        if (f.worksDescription) {
          doc.setFont('helvetica', 'normal');
          boxLines = doc.splitTextToSize(f.worksDescription, contentW - 20);
        }
        const currencySymbol = CURRENCY_SYMBOLS[insp.currency] || '$';
        const cleanCost = String(f.costEstimate || '').replace(/^[\$£€\s]+/, '');
        const estLine = cleanCost ? `Cost estimate: ${currencySymbol}${cleanCost}` : '';
        const totalLines = boxLines.length + (estLine ? 1 : 0);
        const boxH = 22 + totalLines * 13 + 8;
        doc.setFillColor(247, 238, 233);
        doc.roundedRect(margin, boxTop, contentW, boxH, 4, 4, 'F');
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(10);
        doc.setTextColor(28, 31, 38);
        doc.text('Works required', margin + 10, boxTop + 15);
        let wy = boxTop + 15 + 15;
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(10);
        if (boxLines.length) {
          doc.text(boxLines, margin + 10, wy);
          wy += boxLines.length * 13;
        }
        if (estLine) {
          doc.setFont('helvetica', 'bold');
          doc.text(estLine, margin + 10, wy);
        }
        y = boxTop + boxH + 10;
      }

      if (f.photos.length) {
        for (const p of f.photos) {
          y = drawPhotoBlock(doc, p, p.caption, y, { margin, contentW, pageH });
        }
      }
      y += 8;
      doc.setDrawColor(235, 236, 239);
      doc.line(margin, y - 8, pageW - margin, y - 8);
    }
    y += 12;
  }
  return y;
}

// Standalone version of the element-data loader used inside buildAndSaveInspectionPDF's
// closure — needed as a free function here since New Style gathers elements per report
// section rather than for the whole inspection at once.
async function loadElementDataForPdf(elmt) {
  const refPhotos = [];
  for (const p of await DB.listPhotosForElement(elmt.id)) {
    refPhotos.push({ ...(await loadNormalizedImage(p.annotatedBlob || p.originalBlob)), caption: p.caption || '' });
  }
  const findings = await DB.listFindings(elmt.id);
  const findingsWithPhotos = [];
  for (const f of findings) {
    const photoData = [];
    for (const p of await DB.listPhotosForFinding(f.id)) {
      photoData.push({ ...(await loadNormalizedImage(p.annotatedBlob || p.originalBlob)), caption: p.caption || '' });
    }
    findingsWithPhotos.push({ ...f, photos: photoData });
  }
  return { element: elmt, refPhotos, findings: findingsWithPhotos };
}

async function buildAllElementGroups(inspectionId) {
  const sections = await DB.listSections(inspectionId);
  const groups = [];
  for (const sec of sections) {
    const elements = await DB.listElementsBySection(inspectionId, sec.id);
    const elementData = [];
    for (const e of elements) elementData.push(await loadElementDataForPdf(e));
    groups.push({ section: sec, elementData });
  }
  const ungrouped = await DB.listElementsBySection(inspectionId, null);
  if (ungrouped.length) {
    const elementData = [];
    for (const e of ungrouped) elementData.push(await loadElementDataForPdf(e));
    groups.push({ section: null, elementData });
  }
  return groups;
}

async function exportInspectionPDF(inspectionId) {
  if (!window.jspdf) {
    toast('PDF library not loaded. Connect to the internet once to cache it, then try again.');
    return;
  }
  toast('Building report…');
  try {
    await buildAndSaveInspectionPDF(inspectionId);
  } catch (err) {
    console.error('PDF export failed', err);
    toast('Export failed: ' + (err && err.message ? err.message : 'unknown error'));
  }
}

async function buildAndSaveInspectionPDF(inspectionId) {
  const insp = await DB.get('inspections', inspectionId);
  const sections = await DB.listSections(inspectionId);
  const coverPhoto = await DB.getCoverPhoto(inspectionId);
  const companyLogoPhoto = await DB.getLogoByRole(inspectionId, 'company');
  const clientLogoPhoto = await DB.getLogoByRole(inspectionId, 'client');

  let coverData = null;
  if (coverPhoto) coverData = await loadNormalizedImage(coverPhoto.annotatedBlob || coverPhoto.originalBlob);

  const companyLogoData = companyLogoPhoto ? await loadNormalizedImage(companyLogoPhoto.originalBlob) : null;
  const clientLogoData = clientLogoPhoto ? await loadNormalizedImage(clientLogoPhoto.originalBlob) : null;
  const logoData = [companyLogoData, clientLogoData].filter(Boolean);

  async function loadElementData(elmt) {
    const refPhotos = [];
    for (const p of await DB.listPhotosForElement(elmt.id)) {
      refPhotos.push({ ...(await loadNormalizedImage(p.annotatedBlob || p.originalBlob)), caption: p.caption || '' });
    }

    const findings = await DB.listFindings(elmt.id);
    const findingsWithPhotos = [];
    for (const f of findings) {
      const photoData = [];
      for (const p of await DB.listPhotosForFinding(f.id)) {
        photoData.push({ ...(await loadNormalizedImage(p.annotatedBlob || p.originalBlob)), caption: p.caption || '' });
      }
      findingsWithPhotos.push({ ...f, photos: photoData });
    }
    return { element: elmt, refPhotos, findings: findingsWithPhotos };
  }

  // Build ordered group list: named sections first (in order), then an "Ungrouped" bucket if it has elements
  const groups = [];
  for (const sec of sections) {
    const elements = await DB.listElementsBySection(inspectionId, sec.id);
    const elementData = [];
    for (const e of elements) elementData.push(await loadElementData(e));
    groups.push({ section: sec, elementData });
  }
  const ungrouped = await DB.listElementsBySection(inspectionId, null);
  if (ungrouped.length) {
    const elementData = [];
    for (const e of ungrouped) elementData.push(await loadElementData(e));
    groups.push({ section: null, elementData });
  }

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 48;
  const contentW = pageW - margin * 2;

  // ---------- Cover page ----------
  const includeCover = insp.includeCoverPage !== false;
  if (includeCover) {
    if (insp.coverStyle === 'archarray') {
      drawArchArrayCover(doc, { insp, coverData, companyLogoData, clientLogoData, pageW, pageH, margin, contentW });
    } else {
      drawBasicCover(doc, { insp, coverData, logoData, pageW, pageH, margin, contentW });
    }
  }

  // ---------- Table of Contents (reserved blank page; backfilled at the very end once
  // every section's actual page number is known — the standard two-pass jsPDF technique).
  // jsPDF always creates page 1 automatically; when the cover is included that page holds
  // it and this addPage() moves to a fresh page 2 for the ToC. When the cover is excluded,
  // that same unused page 1 becomes the ToC directly instead. ----------
  if (includeCover) doc.addPage();
  const tocPageNum = doc.internal.getNumberOfPages();
  const tocEntries = [];

  // ---------- Introduction ----------
  if (insp.introduction) {
    doc.addPage();
    tocEntries.push({ label: 'Introduction', page: doc.internal.getNumberOfPages(), group: 'report' });
    let iy = margin;
    iy = drawRefinedPageTitle(doc, 'Introduction', insp.structureName, iy, { margin, contentW });
    drawRichHtmlContent(doc, insp.introduction, iy, { margin, contentW, pageH });
  }

  // ---------- Summary ----------
  if (insp.summary) {
    doc.addPage();
    tocEntries.push({ label: 'Summary', page: doc.internal.getNumberOfPages(), group: 'report' });
    let sy = margin;
    sy = drawRefinedPageTitle(doc, 'Summary', insp.structureName, sy, { margin, contentW });
    drawRichHtmlContent(doc, insp.summary, sy, { margin, contentW, pageH });
  }

  // ---------- Location Map ----------
  const mapMode = insp.locationMapMode || 'auto';
  if (mapMode !== 'off') {
    const mapResult = await buildLocationMapForReport(insp, { pageW, margin, contentW });
    if (mapResult) {
      doc.addPage();
      tocEntries.push({ label: 'Location Map', page: doc.internal.getNumberOfPages(), group: 'report' });
      let my = margin;
      my = pageHeading(doc, 'Location Map', my);
      doc.addImage(mapResult.url, 'JPEG', margin, my, mapResult.w, mapResult.h, undefined, 'FAST');
    } else if (mapMode === 'auto' && (!insp.location || insp.location.lat == null)) {
      toast('No coordinates set for this structure — location map skipped');
    } else if (mapMode === 'auto') {
      toast('Could not generate the location map — check your internet connection. Section skipped.');
    }
  }

  // ---------- Details page ----------
  doc.addPage();
  tocEntries.push({ label: 'Inspection Details', page: doc.internal.getNumberOfPages(), group: 'report' });
  let y = margin;
  y = pageHeading(doc, 'Inspection Details', y);
  y = drawInspectionDetailsBlock(doc, insp, y, { margin, contentW });

  // ---- BCI / MDCI summary (GI Bridges inspections only) ----
  if (insp.inspectionType === 'GI Bridges') {
    const bci = await computeBciSummary(inspectionId);
    y += 26;
    if (y + 150 > pageH - margin) { doc.addPage(); y = margin; }
    y = pageHeading(doc, 'BCI / MDCI Condition Scores', y);

    doc.setDrawColor(28, 31, 38);
    doc.setLineWidth(1);
    const boxTop = y;
    const boxH = 108;
    doc.rect(margin, boxTop, contentW, boxH);

    function scoreLine(label, track, ly) {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(10.5);
      doc.setTextColor(74, 79, 90);
      doc.text(label, margin + 12, ly);
      doc.setTextColor(28, 31, 38);
      doc.setFontSize(11);
      const aveTxt = track.bciAv != null ? String(Math.round(track.bciAv)) : '—';
      const critTxt = track.bciCrit != null ? String(Math.round(track.bciCrit)) : '—';
      doc.text(`Ave: ${aveTxt}     Crit: ${critTxt}`, pageW - margin - 12, ly, { align: 'right' });
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8.5);
      doc.setTextColor(120, 124, 132);
      const bcsAveTxt = track.bcsAv != null ? track.bcsAv.toFixed(2) : '—';
      const bcsCritTxt = track.bcsCrit != null ? track.bcsCrit.toFixed(2) : '—';
      doc.text(`BCS Ave: ${bcsAveTxt}   ·   BCS Crit: ${bcsCritTxt}`, pageW - margin - 12, ly + 12, { align: 'right' });
    }
    scoreLine('Official BCI', bci.vanilla, boxTop + 22);
    doc.setDrawColor(220, 223, 228);
    doc.line(margin + 8, boxTop + 42, pageW - margin - 8, boxTop + 42);
    scoreLine('House MDCI', bci.mdci, boxTop + 64);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(120, 124, 132);
    const noteLines = doc.splitTextToSize(
      "MDCI is a house-developed condition index that blends multiple defects per element more granularly than the official method. It is not directly comparable to another authority's BCI figures.",
      contentW - 24
    );
    doc.text(noteLines, margin + 12, boxTop + 88);

    y = boxTop + boxH + 14;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(120, 124, 132);
    const approxLines = doc.splitTextToSize(
      "Official BCI's multi-defect interaction rule is an algorithmic approximation — engineer judgement should override where defects genuinely compound in severity." +
      (bci.excludedCount ? ` ${bci.excludedCount} element${bci.excludedCount === 1 ? '' : 's'} excluded from scoring (no Element Type set, or marked Not Inspected).` : ''),
      contentW
    );
    doc.text(approxLines, margin, y);
    y += approxLines.length * 11 + 10;
  }

  // Element summary table (grouped by section)
  y += 20;
  y = drawElementSummaryTableForGroups(doc, groups, y, { margin, contentW, pageH });

  // ---------- Detailed findings, grouped by section ----------
  let isFirstGroup = true;
  for (const g of groups) {
    doc.addPage();
    if (isFirstGroup) { tocEntries.push({ label: 'Findings', page: doc.internal.getNumberOfPages(), group: 'report' }); isFirstGroup = false; }
    y = margin;
    y = drawGroupFindings(doc, insp, g, y, { margin, contentW, pageH, pageW });
  }

  // ---------- Conclusion & Recommendations ----------
  if (insp.conclusion || (insp.recommendations && insp.recommendations.length)) {
    doc.addPage();
    tocEntries.push({ label: 'Conclusion & Recommendations', page: doc.internal.getNumberOfPages(), group: 'report' });
    let cy = margin;
    if (insp.conclusion) {
      cy = drawRefinedPageTitle(doc, 'Conclusion', insp.structureName, cy, { margin, contentW });
      cy = drawRichHtmlContent(doc, insp.conclusion, cy, { margin, contentW, pageH });
    }
    if (insp.recommendations && insp.recommendations.length) {
      cy += 20;
      if (cy > pageH - margin - 60) { doc.addPage(); cy = margin; }
      cy = pageHeading(doc, 'Recommendations', cy);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(11);
      doc.setTextColor(28, 31, 38);
      insp.recommendations.forEach((rec, i) => {
        const lines = doc.splitTextToSize(`${i + 1}. ${rec}`, contentW);
        if (cy + lines.length * 15 > pageH - margin) { doc.addPage(); cy = margin; }
        doc.text(lines, margin, cy);
        cy += lines.length * 15 + 6;
      });
    }
  }

  // ---------- Back matter: Drawings, named Appendices, and Risk Assessment — each gets its
  // own lettered cover page ("Appendix A - Name"), computed live from position so it's
  // always correct regardless of what's included. Each image item gets its own page sized
  // to its native orientation (a landscape drawing gets a landscape page, not squeezed onto
  // portrait), rather than flowing multiple items down a shared page. ----
  const backMatterSections = [];
  const drawingsToInclude = (await DB.listDrawings(inspectionId)).filter((d) => d.includeInReport);
  if (drawingsToInclude.length) backMatterSections.push({ type: 'images', title: 'Drawings', items: drawingsToInclude });

  const appendices = await DB.listAppendices(inspectionId);
  for (const appendix of appendices) {
    const items = await DB.listAppendixItems(appendix.id);
    if (items.length) backMatterSections.push({ type: 'images', title: appendix.name, items });
  }

  if (insp.includeRiskAssessmentAppendix) {
    const ra = await DB.getRiskAssessment(inspectionId);
    if (ra) backMatterSections.push({ type: 'riskAssessment', title: 'Risk Assessment', ra });
  }

  const APPENDIX_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  for (let i = 0; i < backMatterSections.length; i++) {
    const section = backMatterSections[i];
    const letter = APPENDIX_LETTERS[i] || String(i + 1);
    const fullTitle = `Appendix ${letter} - ${section.title}`;

    // Cover page
    doc.addPage('a4', 'portrait');
    tocEntries.push({ label: fullTitle, page: doc.internal.getNumberOfPages(), group: 'appendix' });
    let cvy = margin;
    drawRefinedPageTitle(doc, fullTitle, insp.structureName, cvy, { margin, contentW });

    if (section.type === 'riskAssessment') {
      doc.addPage('a4', 'portrait');
      const sigData = await loadRiskAssessmentSignatures(section.ra);
      drawRiskAssessmentContent(doc, insp, section.ra, sigData);
    } else {
      for (const item of section.items) {
        const data = await loadNormalizedImage(item.annotatedBlob || item.originalBlob);
        const isLandscape = data.w > data.h;
        doc.addPage('a4', isLandscape ? 'landscape' : 'portrait');
        const pw = doc.internal.pageSize.getWidth();
        const ph = doc.internal.pageSize.getHeight();
        const cw2 = pw - margin * 2;
        let iy = margin;
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(10.5);
        doc.setTextColor(28, 31, 38);
        doc.text(item.title || 'Untitled', margin, iy);
        iy += 14;
        const maxH = ph - margin - iy;
        let w = cw2, h = (data.h / data.w) * w;
        if (h > maxH) { h = maxH; w = (data.w / data.h) * h; }
        doc.addImage(data.url, 'JPEG', margin, iy, w, h, undefined, 'FAST');
      }
    }
  }

  // ---------- Backfill the Table of Contents now that every section's actual page is known ----------
  doc.setPage(tocPageNum);
  let ty = margin;
  ty = drawRefinedPageTitle(doc, 'Contents', insp.structureName, ty, { margin, contentW });

  function drawTocGroup(label, entries) {
    if (!entries.length) return;
    // No addPage() here deliberately: this runs during the backfill pass with the cursor
    // pinned to the reserved ToC page via setPage(). Calling addPage() would append a new
    // page at the very END of the whole document (that's how jsPDF works — it can't insert
    // mid-document), which would silently corrupt every other section's already-recorded
    // page number. In the extreme case of far more entries than fit, later ones are simply
    // not drawn rather than risking that.
    if (ty > pageH - margin - 40) return;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10.5);
    doc.setTextColor(200, 30, 30);
    drawTrackedText(doc, label.toUpperCase(), margin, ty, 1.6);
    ty += 22;
    for (const entry of entries) {
      if (ty > pageH - margin) break;
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(11.5);
      doc.setTextColor(28, 31, 38);
      doc.text(entry.label, margin, ty, { maxWidth: contentW - 50 });
      const pageLabel = String(entry.page);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(91, 96, 105);
      doc.text(pageLabel, pageW - margin, ty, { align: 'right' });
      const labelW = doc.getTextWidth(entry.label);
      const pageLabelW = doc.getTextWidth(pageLabel);
      drawDotLeader(doc, margin + labelW + 8, pageW - margin - pageLabelW - 8, ty - 3);
      ty += 25;
    }
    ty += 14;
  }

  drawTocGroup('Report', tocEntries.filter((e) => e.group === 'report'));
  drawTocGroup('Appendices', tocEntries.filter((e) => e.group === 'appendix'));

  doc.setPage(doc.internal.getNumberOfPages()); // don't leave the cursor on the ToC page

  const filename = `${(insp.structureName || 'inspection').replace(/[^a-z0-9]+/gi, '_')}_${(insp.date || '').slice(0, 10)}.pdf`;
  doc.save(filename);
  toast('Report saved');
}

// Draws a photo properly contained (never distorted — both dimensions recalculated
// together, unlike the old per-row-grid code which capped height but left width fixed,
// squashing tall photos) at roughly half-page height with real margins, plus an optional
// caption underneath. Used for both element reference photos and finding photos.
// ---------- Rich text rendering (Introduction / Summary / Conclusion) ----------
//
// jsPDF's text() can only draw one plain style at a time — there's no built-in way to mix
// bold/italic/color within a line. This walks the saved HTML into a flat list of "runs"
// (a span of text plus its style), then lays those runs out word-by-word, wrapping lines
// and drawing each run with its own font/color, rather than one plain text block.
function colorNameToRgb(cssColor) {
  if (!cssColor) return null;
  const hexMatch = cssColor.match(/^#([0-9a-f]{6})$/i);
  if (hexMatch) {
    const n = parseInt(hexMatch[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const rgbMatch = cssColor.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (rgbMatch) return [Number(rgbMatch[1]), Number(rgbMatch[2]), Number(rgbMatch[3])];
  return null;
}

function parseRichHtmlToParagraphs(html) {
  const container = document.createElement('div');
  container.innerHTML = html || '';
  const paragraphs = [];

  function walkInline(node, style, runs) {
    if (node.nodeType === Node.TEXT_NODE) {
      if (node.textContent) runs.push({ text: node.textContent, ...style });
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const tag = node.tagName.toLowerCase();
    if (tag === 'br') { runs.push({ text: '\n', ...style }); return; }
    const newStyle = { ...style };
    if (tag === 'b' || tag === 'strong') newStyle.bold = true;
    if (tag === 'i' || tag === 'em') newStyle.italic = true;
    if (tag === 'u') newStyle.underline = true;
    const elStyle = node.getAttribute && node.getAttribute('style');
    if (elStyle) {
      const colorMatch = elStyle.match(/(?:^|;)\s*color:\s*([^;]+)/i);
      if (colorMatch) newStyle.color = colorMatch[1].trim();
      const bgMatch = elStyle.match(/background-color:\s*([^;]+)/i);
      if (bgMatch) newStyle.highlight = bgMatch[1].trim();
    }
    node.childNodes.forEach((child) => walkInline(child, newStyle, runs));
  }

  function walkBlock(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      if (node.textContent.trim()) {
        const runs = [];
        walkInline(node, {}, runs);
        paragraphs.push({ type: 'p', runs });
      }
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const tag = node.tagName.toLowerCase();
    if (tag === 'ul' || tag === 'ol') {
      let index = 1;
      node.querySelectorAll(':scope > li').forEach((li) => {
        const runs = [];
        walkInline(li, {}, runs);
        paragraphs.push({ type: tag === 'ol' ? 'ol' : 'ul', runs, number: index });
        index++;
      });
      return;
    }
    if (tag === 'div' || tag === 'p') {
      const runs = [];
      walkInline(node, {}, runs);
      if (runs.length) paragraphs.push({ type: 'p', runs });
      return;
    }
    const runs = [];
    walkInline(node, {}, runs);
    if (runs.length) paragraphs.push({ type: 'p', runs });
  }

  container.childNodes.forEach((node) => walkBlock(node));
  return paragraphs;
}

function drawRichHtmlContent(doc, html, y, { margin, contentW, pageH }) {
  const paragraphs = parseRichHtmlToParagraphs(html);
  const fontSize = 11;
  const lineHeight = 15;

  paragraphs.forEach((para) => {
    const indent = (para.type === 'ul' || para.type === 'ol') ? 18 : 0;
    const bulletText = para.type === 'ul' ? '•' : para.type === 'ol' ? `${para.number}.` : '';
    const availW = contentW - indent;

    const words = [];
    para.runs.forEach((run) => {
      run.text.split('\n').forEach((part, idx) => {
        if (idx > 0) words.push({ hardBreak: true });
        part.split(/(\s+)/).filter(Boolean).forEach((w) => {
          words.push({ text: w, bold: run.bold, italic: run.italic, underline: run.underline, color: run.color, highlight: run.highlight });
        });
      });
    });

    let line = [];
    let lineW = 0;
    let firstLineOfPara = true;

    function fontStyleFor(w) { return w.bold && w.italic ? 'bolditalic' : w.bold ? 'bold' : w.italic ? 'italic' : 'normal'; }
    function measureWord(w) {
      doc.setFont('helvetica', fontStyleFor(w));
      doc.setFontSize(fontSize);
      return doc.getTextWidth(w.text);
    }

    function flushLine() {
      if (line.length === 0 && !bulletText) return;
      if (y > pageH - margin) { doc.addPage(); y = margin; }
      let x = margin + indent;
      if (firstLineOfPara && bulletText) {
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(fontSize);
        doc.setTextColor(28, 31, 38);
        doc.text(bulletText, margin + indent - 14, y);
      }
      line.forEach((w) => {
        doc.setFont('helvetica', fontStyleFor(w));
        doc.setFontSize(fontSize);
        const wWidth = doc.getTextWidth(w.text);
        if (w.highlight) {
          const rgb = colorNameToRgb(w.highlight);
          if (rgb) { doc.setFillColor(rgb[0], rgb[1], rgb[2]); doc.rect(x, y - fontSize + 2, wWidth, fontSize + 2, 'F'); }
        }
        const rgb = w.color ? colorNameToRgb(w.color) : null;
        doc.setTextColor(rgb ? rgb[0] : 28, rgb ? rgb[1] : 31, rgb ? rgb[2] : 38);
        doc.text(w.text, x, y);
        if (w.underline) {
          doc.setDrawColor(rgb ? rgb[0] : 28, rgb ? rgb[1] : 31, rgb ? rgb[2] : 38);
          doc.setLineWidth(0.6);
          doc.line(x, y + 2, x + wWidth, y + 2);
        }
        x += wWidth;
      });
      y += lineHeight;
      line = [];
      lineW = 0;
      firstLineOfPara = false;
    }

    if (words.length === 0) {
      flushLine(); // empty paragraph still takes a blank line, matching what was typed
    } else {
      words.forEach((w) => {
        if (w.hardBreak) { flushLine(); return; }
        const ww = measureWord(w);
        if (lineW + ww > availW && line.length) flushLine();
        line.push(w);
        lineW += ww;
      });
      if (line.length) flushLine();
    }
    y += 6;
  });

  return y;
}

function drawPhotoBlock(doc, data, caption, y, { margin, contentW, pageH }) {
  const maxH = (pageH - margin * 2) * 0.42;
  let w = contentW, h = (data.h / data.w) * w;
  if (h > maxH) { h = maxH; w = (data.w / data.h) * h; }
  const captionLines = caption ? doc.splitTextToSize(caption, contentW) : [];
  const captionH = captionLines.length ? captionLines.length * 12 + 6 : 0;
  if (y + h + captionH > pageH - margin) { doc.addPage(); y = margin; }
  const x = margin + (contentW - w) / 2;
  doc.addImage(data.url, 'JPEG', x, y, w, h, undefined, 'FAST');
  y += h + 8;
  if (captionLines.length) {
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(9.5);
    doc.setTextColor(91, 96, 105);
    doc.text(captionLines, margin, y);
    y += captionLines.length * 12;
  }
  y += 18;
  return y;
}

function pageHeading(doc, text, y) {
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.setTextColor(200, 30, 30);
  doc.text(text.toUpperCase(), 48, y);
  doc.setDrawColor(200, 30, 30);
  doc.setLineWidth(1.5);
  doc.line(48, y + 6, 48 + 36, y + 6);
  return y + 30;
}

// A more editorial page-title treatment — Times serif (one of jsPDF's built-in fonts, no
// embedding needed), an optional italic subtitle, and a short red accent rule. Used for the
// Table of Contents, Introduction/Summary, and Conclusion & Recommendations pages; other
// pages keep the compact pageHeading() style above.
function drawRefinedPageTitle(doc, title, subtitle, y, { margin, contentW }) {
  doc.setFont('times', 'bold');
  doc.setFontSize(29);
  doc.setTextColor(28, 31, 38);
  // Measure how many lines the title actually wraps to — it previously assumed one line
  // always, so a long appendix name wrapping to two lines printed the subtitle straight
  // over the top of the second line instead of below it.
  const titleLines = doc.splitTextToSize(title, contentW);
  doc.text(titleLines, margin, y);
  y += titleLines.length * 34;
  if (subtitle) {
    doc.setFont('times', 'italic');
    doc.setFontSize(12.5);
    doc.setTextColor(91, 96, 105);
    doc.text(subtitle, margin, y, { maxWidth: contentW });
    y += 19;
  }
  y += 19;
  doc.setFillColor(200, 30, 30);
  doc.rect(margin, y, 50, 4, 'F');
  return y + 28;
}

// Dot leader between a ToC label and its page number — small filled circles rather than a
// dashed line, since doc.circle() is a stable, well-documented jsPDF primitive (unlike the
// path-drawing APIs that caused problems previously).
function drawDotLeader(doc, x1, x2, y) {
  if (x2 <= x1) return;
  doc.setFillColor(180, 184, 190);
  for (let x = x1; x < x2; x += 4.5) {
    doc.circle(x, y, 0.5, 'F');
  }
}

// Draws text with manual letter-spacing (jsPDF's core text() has no tracking option).
function drawTrackedText(doc, text, x, y, tracking) {
  let cx = x;
  for (const ch of text) {
    doc.text(ch, cx, y);
    cx += doc.getTextWidth(ch) + tracking;
  }
  return cx;
}

function drawBasicCover(doc, { insp, coverData, logoData, pageW, pageH, margin, contentW }) {
  doc.setFillColor(255, 255, 255);
  doc.rect(0, 0, pageW, pageH, 'F');

  // Red curved swoosh, bleeding off the bottom-right — built from an overlapping filled
  // ellipse (avoids relying on jsPDF's less consistent low-level path API).
  doc.setFillColor(200, 30, 30);
  const swooshR = pageW * 0.85;
  doc.ellipse(pageW * 0.78, pageH * 1.02, swooshR, swooshR * 0.62, 'F');

  // Logos strip at the top (letterhead-style), if any
  if (logoData.length) {
    const logoH = 34;
    const gap = 16;
    const widths = logoData.map((l) => (l.w / l.h) * logoH);
    const totalW = widths.reduce((a, b) => a + b, 0) + gap * (logoData.length - 1);
    let lx = pageW - margin - totalW;
    const ly = 44;
    logoData.forEach((l, i) => {
      doc.addImage(l.url, 'JPEG', lx, ly, widths[i], logoH, undefined, 'FAST');
      lx += widths[i] + gap;
    });
  }

  doc.setTextColor(28, 31, 38);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(28);
  doc.text(insp.title || 'Structural Inspection Report', margin, 110, { maxWidth: contentW });

  if (insp.subtitle) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(14);
    doc.setTextColor(74, 79, 90);
    doc.text(insp.subtitle, margin, 136, { maxWidth: contentW });
  }

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(20);
  doc.setTextColor(28, 31, 38);
  doc.text(insp.structureName || '', margin, 175, { maxWidth: contentW });

  if (insp.client || insp.reference) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(11);
    doc.setTextColor(74, 79, 90);
    const line = [insp.client ? `Client: ${insp.client}` : null, insp.reference ? `Reference: ${insp.reference}` : null].filter(Boolean).join('    ·    ');
    doc.text(line, margin, 196, { maxWidth: contentW });
  }

  if (coverData) {
    const maxW = contentW * 0.8;
    const maxH = pageH * 0.3;
    let w = maxW, h = (coverData.h / coverData.w) * w;
    if (h > maxH) { h = maxH; w = (coverData.w / coverData.h) * h; }
    const x = (pageW - w) / 2;
    const y = pageH - h - 90;
    doc.setFillColor(255, 255, 255);
    doc.roundedRect(x - 6, y - 6, w + 12, h + 12, 4, 4, 'F');
    doc.addImage(coverData.url, 'JPEG', x, y, w, h, undefined, 'FAST');
  }

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(120, 124, 132);
  doc.text(fmtDate(insp.date), margin, pageH - 40);
}

function drawArchArrayCover(doc, { insp, coverData, companyLogoData, clientLogoData, pageW, pageH, margin, contentW }) {
  doc.setFillColor(255, 255, 255);
  doc.rect(0, 0, pageW, pageH, 'F');

  // Background: pylon + fanning cable array
  const pylonX = pageW * 0.82;
  doc.setFillColor(28, 31, 38);
  doc.rect(pylonX - 6, pageH * 0.11, 12, pageH * 0.89, 'F');

  const fanTopY = pageH * 0.15;
  doc.setDrawColor(200, 30, 30);
  doc.setLineWidth(1);
  [0.18, 0.30, 0.42, 0.54, 0.66, 0.78].forEach((frac, i) => {
    doc.line(pylonX, fanTopY + i * 16, pageW * frac * 0.9, pageH);
  });
  doc.setDrawColor(230, 150, 150);
  doc.setLineWidth(0.8);
  [0.18, 0.26, 0.34].forEach((frac, i) => {
    doc.line(pylonX, fanTopY + 30 + i * 24, pageW, pageH * (0.55 + frac));
  });

  doc.setFillColor(28, 31, 38);
  doc.rect(0, pageH - 6, pageW, 6, 'F');

  // Company logo, top-left
  if (companyLogoData) {
    const h = 48;
    const w = (companyLogoData.w / companyLogoData.h) * h;
    doc.addImage(companyLogoData.url, 'JPEG', margin, 40, w, h, undefined, 'FAST');
  }

  // Kicker (report title, tracked-out small caps)
  let ty = 118;
  doc.setTextColor(200, 30, 30);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  drawTrackedText(doc, (insp.title || 'Structural Inspection Report').toUpperCase(), margin, ty, 1.6);

  // Hero: structure name, serif
  ty += 34;
  doc.setTextColor(28, 31, 38);
  doc.setFont('times', 'bold');
  doc.setFontSize(30);
  const heroLines = doc.splitTextToSize(insp.structureName || '', contentW - 60);
  doc.text(heroLines, margin, ty);
  ty += heroLines.length * 30;

  // Subtitle, serif italic
  if (insp.subtitle) {
    ty += 6;
    doc.setFont('times', 'italic');
    doc.setFontSize(13);
    doc.setTextColor(91, 96, 105);
    doc.text(insp.subtitle, margin, ty, { maxWidth: contentW - 60 });
    ty += 18;
  }

  // Red rule
  ty += 8;
  doc.setDrawColor(200, 30, 30);
  doc.setLineWidth(2);
  doc.line(margin, ty, margin + 40, ty);

  // Date, then Reference — tracked small text
  ty += 22;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(91, 96, 105);
  drawTrackedText(doc, fmtDate(insp.date), margin, ty, 1);
  if (insp.reference) {
    ty += 15;
    drawTrackedText(doc, `Ref. ${insp.reference}`, margin, ty, 1);
  }

  // Cover photo, roughly mid-page
  if (coverData) {
    const w = contentW - 20;
    const maxH = pageH * 0.3;
    let h = (coverData.h / coverData.w) * w;
    if (h > maxH) h = maxH;
    const x = margin;
    const y = pageH * 0.44;
    doc.setFillColor(255, 255, 255);
    doc.setDrawColor(220, 223, 228);
    doc.roundedRect(x - 4, y - 4, w + 8, h + 8, 3, 3, 'FD');
    doc.addImage(coverData.url, 'JPEG', x, y, w, h, undefined, 'FAST');
  }

  // Client whiteout box, bottom — client logo (if any) + client name
  if (insp.client) {
    const boxH = 64;
    const boxY = pageH - 116;
    const logoBox = clientLogoData;
    const logoH = boxH - 20;
    const logoW = logoBox ? (logoBox.w / logoBox.h) * logoH : 0;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(11);
    const textW = doc.getTextWidth(insp.client) + 4;
    const boxW = 20 + (logoBox ? logoW + 12 : 0) + textW;
    doc.setFillColor(255, 255, 255);
    doc.setDrawColor(215, 218, 222);
    doc.setLineWidth(0.75);
    doc.roundedRect(margin, boxY, boxW, boxH, 3, 3, 'FD');

    let tx = margin + 10;
    if (logoBox) {
      doc.addImage(logoBox.url, 'JPEG', tx, boxY + 10, logoW, logoH, undefined, 'FAST');
      tx += logoW + 12;
    }
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.5);
    doc.setTextColor(154, 160, 168);
    drawTrackedText(doc, 'CLIENT', tx, boxY + boxH / 2 - 6, 1.4);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(11);
    doc.setTextColor(28, 31, 38);
    doc.text(insp.client, tx, boxY + boxH / 2 + 10);
  }
}

// ---------- Risk Assessment (standalone export, matches the uploaded template layout) ----------

function riskBandPdf(l, s) {
  const r = (l || 0) * (s || 0);
  const label = r === 0 ? '' : r <= 3 ? 'Low' : r <= 6 ? 'Medium' : 'High';
  const color = r <= 3 ? [79, 157, 92] : r <= 6 ? [224, 167, 46] : [200, 30, 30];
  return { r, label, color };
}

async function exportRiskAssessmentPDF(inspectionId) {
  if (!window.jspdf) {
    toast('PDF library not loaded. Connect to the internet once to cache it, then try again.');
    return;
  }
  toast('Building risk assessment…');
  try {
    await buildAndSaveRiskAssessmentPDF(inspectionId);
  } catch (err) {
    console.error('Risk assessment export failed', err);
    toast('Export failed: ' + (err && err.message ? err.message : 'unknown error'));
  }
}

async function buildAndSaveRiskAssessmentPDF(inspectionId) {
  const insp = await DB.get('inspections', inspectionId);
  const ra = await DB.getRiskAssessment(inspectionId);
  if (!ra) { toast('No risk assessment to export yet'); return; }

  const sigData = await loadRiskAssessmentSignatures(ra);
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  drawRiskAssessmentContent(doc, insp, ra, sigData);

  const filename = `${(insp.structureName || 'inspection').replace(/[^a-z0-9]+/gi, '_')}_RiskAssessment_${(ra.assessmentDate || '').slice(0, 10)}.pdf`;
  doc.save(filename);
  toast('Risk assessment saved');
}

// Gathers the Risk Assessment's signature images once, reused whether the RA is exported
// standalone or embedded as an appendix in the main report.
async function loadRiskAssessmentSignatures(ra) {
  const inspectorSigPhoto = await DB.getSignature(ra.id, 'inspector');
  const inspectorSigData = inspectorSigPhoto ? await loadNormalizedImage(inspectorSigPhoto.originalBlob) : null;

  const staffSigData = [];
  for (const s of (ra.additionalStaff || [])) {
    const sigPhoto = await DB.getSignature(ra.id, `staff:${s.id}`);
    staffSigData.push({
      initials: s.initials,
      sig: sigPhoto ? await loadNormalizedImage(sigPhoto.originalBlob) : null
    });
  }

  const riskSigMap = {};
  for (const r of (ra.risks || [])) {
    const sigPhoto = await DB.getSignature(ra.id, `risk:${r.id}`);
    if (sigPhoto) riskSigMap[r.id] = await loadNormalizedImage(sigPhoto.originalBlob);
  }

  return { inspectorSigData, staffSigData, riskSigMap };
}

// Draws the full Risk Assessment content into an already-open jsPDF document, starting on
// whatever the current page is — the caller decides whether that's a brand-new document
// (standalone export) or a page just added to the main report (appendix embedding).
function drawRiskAssessmentContent(doc, insp, ra, { inspectorSigData, staffSigData, riskSigMap }) {
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 40;
  const contentW = pageW - margin * 2;
  let y = margin;

  function blackBar(text, yPos, h) {
    h = h || 20;
    if (yPos + h > pageH - margin) { doc.addPage(); yPos = margin; }
    doc.setFillColor(20, 20, 20);
    doc.rect(margin, yPos, contentW, h, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.text(text, margin + 8, yPos + h - 6);
    return yPos + h + 10;
  }

  // ---- Header ----
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(28, 31, 38);
  doc.text('Company Name:', margin, y + 10);
  doc.setFont('helvetica', 'bold');
  doc.text(ra.companyName || '—', margin + 95, y + 10);
  y += 20;
  doc.setFont('helvetica', 'normal');
  doc.text('Address:', margin, y + 10);
  doc.setFont('helvetica', 'bold');
  doc.text(ra.companyAddress || '—', margin + 95, y + 10);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(26);
  doc.setTextColor(28, 31, 38);
  doc.text('Risk Assessment', pageW - margin, margin + 26, { align: 'right' });

  y = margin + 56;
  doc.setDrawColor(20, 20, 20);
  doc.setLineWidth(1.2);
  doc.line(margin, y, pageW - margin, y);
  y += 20;

  function labelValueRow(label1, val1, label2, val2, yy) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(74, 79, 90);
    doc.text(label1, margin, yy);
    doc.setTextColor(28, 31, 38);
    doc.setFont('helvetica', 'bold');
    doc.text(val1 || '—', margin + 110, yy);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(74, 79, 90);
    doc.text(label2, margin + contentW / 2, yy);
    doc.setTextColor(28, 31, 38);
    doc.setFont('helvetica', 'bold');
    doc.text(val2 || '—', margin + contentW / 2 + 90, yy);
    return yy + 20;
  }
  y = labelValueRow('Assessment Title:', ra.assessmentTitle, 'Reference:', ra.assessmentReference, y);
  y = labelValueRow('Assessor:', ra.assessorName, 'Date:', fmtDate(ra.assessmentDate), y);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(74, 79, 90);
  doc.text('Location / Site Address:', margin, y);
  doc.setTextColor(28, 31, 38);
  doc.setFont('helvetica', 'bold');
  doc.text(ra.locationSiteAddress || '—', margin + 130, y);
  y += 22;

  // ---- Task description ----
  y = blackBar('Description of Task / Activity', y);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(28, 31, 38);
  const taskLines = doc.splitTextToSize(ra.taskDescription || '—', contentW - 10);
  doc.text(taskLines, margin + 5, y);
  y += taskLines.length * 13 + 16;

  // ---- Risk matrix legend ----
  if (y + 80 > pageH - margin) { doc.addPage(); y = margin; }
  y = blackBar('Risk Matrix', y);
  doc.setDrawColor(210, 213, 218);
  doc.rect(margin, y, contentW, 62);
  doc.setFontSize(9);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(28, 31, 38);
  doc.text('Likelihood (L): 1 – Unlikely   2 – Possible   3 – Likely', margin + 8, y + 18);
  doc.text('Severity (S): 1 – Minor Injury   2 – Serious Injury   3 – Major Injury / Fatality', margin + 8, y + 34);
  doc.text('Risk Rating (R) = L × S    (1–3 Low   4–6 Medium   7–9 High)', margin + 8, y + 50);
  y += 62 + 18;

  // ---- Hazard Identification table (sourced from combined Risk entries) ----
  if (y + 60 > pageH - margin) { doc.addPage(); y = margin; }
  y = blackBar('Hazard Identification & Initial Risk Rating', y);
  const hazardRows = (ra.risks || []).map((h) => {
    const band = riskBandPdf(h.likelihood, h.severity);
    return [h.hazardType || '', h.description || '', h.whoMightBeHarmed || '', h.existingControls || '', h.likelihood || '', h.severity || '', band.r || ''];
  });
  if (doc.autoTable && hazardRows.length) {
    doc.autoTable({
      startY: y,
      margin: { left: margin, right: margin },
      head: [['Hazard Type', 'Location / Description', 'Who Might Be Harmed', 'Existing Controls', 'L', 'S', 'R']],
      body: hazardRows,
      styles: { font: 'helvetica', fontSize: 8.5, cellPadding: 5 },
      headStyles: { fillColor: [20, 20, 20], textColor: 255 },
      columnStyles: { 4: { halign: 'center' }, 5: { halign: 'center' }, 6: { halign: 'center' } },
      didParseCell: (data) => {
        if (data.section === 'body' && data.column.index === 6) {
          const r = Number(data.cell.raw);
          if (r) {
            data.cell.styles.fillColor = r <= 3 ? [79, 157, 92] : r <= 6 ? [224, 167, 46] : [200, 30, 30];
            data.cell.styles.textColor = 255;
            data.cell.styles.fontStyle = 'bold';
          }
        }
      }
    });
    y = doc.lastAutoTable.finalY + 18;
  } else {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(120, 124, 132);
    doc.text('No risks logged.', margin, y);
    y += 20;
  }

  // ---- Control Actions table (same Risk entries, control-action half) ----
  if (y + 60 > pageH - margin) { doc.addPage(); y = margin; }
  y = blackBar('Control Actions & Residual Risk Rating', y);
  const controlRows = (ra.risks || []).map((c) => [
    c.controlRequired || '', c.actionBy || '',
    c.targetDate ? fmtDate(c.targetDate) : '', c.completionDate ? fmtDate(c.completionDate) : '',
    c.signedOffByName || ''
  ]);
  if (doc.autoTable && controlRows.length) {
    doc.autoTable({
      startY: y,
      margin: { left: margin, right: margin },
      head: [['Additional Controls Required', 'Action By', 'Target Date', 'Completion Date', 'Signed Off By']],
      body: controlRows,
      styles: { font: 'helvetica', fontSize: 8.5, cellPadding: 5, minCellHeight: 28 },
      headStyles: { fillColor: [20, 20, 20], textColor: 255 },
      didDrawCell: (data) => {
        if (data.section === 'body' && data.column.index === 4) {
          const rowRecord = (ra.risks || [])[data.row.index];
          const sigData = rowRecord && riskSigMap[rowRecord.id];
          if (sigData) {
            const h = Math.min(data.cell.height - 6, 18);
            const w = (sigData.w / sigData.h) * h;
            doc.addImage(sigData.url, 'PNG', data.cell.x + 2, data.cell.y + data.cell.height - h - 3, w, h, undefined, 'FAST');
          }
        }
      }
    });
    y = doc.lastAutoTable.finalY + 18;
  } else {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(120, 124, 132);
    doc.text('No risks logged.', margin, y);
    y += 20;
  }

  // ---- Responsible Person(s) ----
  if (y + 40 > pageH - margin) { doc.addPage(); y = margin; }
  y = blackBar('Responsible Person(s)', y);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(28, 31, 38);
  const respLines = doc.splitTextToSize(ra.responsiblePersons || '—', contentW - 10);
  doc.text(respLines, margin + 5, y);
  y += respLines.length * 13 + 16;

  // ---- Residual Risk Acceptable ----
  if (y + 50 > pageH - margin) { doc.addPage(); y = margin; }
  y = blackBar('Residual Risk Acceptable?', y);
  const yesChecked = ra.residualRiskAcceptable === 'yes';
  const noChecked = ra.residualRiskAcceptable === 'no';
  doc.setDrawColor(28, 31, 38);
  doc.rect(margin + 5, y - 8, 10, 10);
  if (yesChecked) { doc.setFillColor(20, 20, 20); doc.rect(margin + 6.5, y - 6.5, 7, 7, 'F'); }
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(28, 31, 38);
  doc.text('Yes', margin + 20, y);
  doc.setFont('helvetica', 'normal');
  doc.text('— Risk reduced to as low as reasonably practicable', margin + 46, y);
  y += 18;
  doc.rect(margin + 5, y - 8, 10, 10);
  if (noChecked) { doc.setFillColor(20, 20, 20); doc.rect(margin + 6.5, y - 6.5, 7, 7, 'F'); }
  doc.setFont('helvetica', 'bold');
  doc.text('No', margin + 20, y);
  doc.setFont('helvetica', 'normal');
  doc.text('— Further controls required before work proceeds', margin + 46, y);
  y += 30;

  // ---- Sign-off: Inspector/Engineer (primary), plus any additional inspection staff ----
  if (y + 90 > pageH - margin) { doc.addPage(); y = margin; }
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(28, 31, 38);
  doc.text('Inspector / Engineer', margin, y);
  doc.setFont('helvetica', 'normal');
  doc.text(`Name: ${ra.inspectorName || '—'}`, margin, y + 16);
  if (inspectorSigData) {
    const h = 30;
    const w = Math.min((inspectorSigData.w / inspectorSigData.h) * h, 160);
    doc.addImage(inspectorSigData.url, 'PNG', margin, y + 22, w, h, undefined, 'FAST');
  }
  doc.text(`Date: ${ra.inspectorDate ? fmtDate(ra.inspectorDate) : '—'}   Time: ${ra.inspectorTime || '—'}`, margin, y + 62);
  y += 78;

  if (staffSigData.length) {
    if (y + 30 > pageH - margin) { doc.addPage(); y = margin; }
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9.5);
    doc.setTextColor(74, 79, 90);
    doc.text('Additional Inspection Staff', margin, y);
    y += 16;
    const staffColW = contentW / 3;
    let col = 0, rowStartY = y, rowMaxH = 0;
    for (const s of staffSigData) {
      if (col === 0 && y + 40 > pageH - margin) { doc.addPage(); y = margin; rowStartY = y; }
      const x = margin + col * staffColW;
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(10);
      doc.setTextColor(28, 31, 38);
      doc.text(s.initials || '—', x, y);
      if (s.sig) {
        const h = 22;
        const w = Math.min((s.sig.w / s.sig.h) * h, staffColW - 10);
        doc.addImage(s.sig.url, 'PNG', x, y + 6, w, h, undefined, 'FAST');
        rowMaxH = Math.max(rowMaxH, h + 10);
      } else {
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(9);
        doc.setTextColor(120, 124, 132);
        doc.text('Not signed', x, y + 16);
        rowMaxH = Math.max(rowMaxH, 20);
      }
      col++;
      if (col === 3) { col = 0; y = rowStartY + rowMaxH + 14; rowStartY = y; rowMaxH = 0; }
    }
    if (col !== 0) y = rowStartY + rowMaxH + 14;
  }
}

// ---------- New Style report export: builds the whole PDF from an ordered list of
// user-defined report sections, reusing every drawing block already built for Old Style
// (rich text, location map, details, element summary, findings, photos, appendices, risk
// assessment) rather than duplicating that logic. ----------
async function exportInspectionPDFNewStyle(inspectionId) {
  if (!window.jspdf) {
    toast('PDF library not loaded. Connect to the internet once to cache it, then try again.');
    return;
  }
  toast('Building report…');
  try {
    await buildAndSaveNewStyleInspectionPDF(inspectionId);
  } catch (err) {
    console.error('New Style PDF export failed', err);
    toast('Export failed: ' + (err && err.message ? err.message : 'unknown error'));
  }
}

async function buildAndSaveNewStyleInspectionPDF(inspectionId) {
  const insp = await DB.get('inspections', inspectionId);
  if (!insp) { toast('Inspection not found'); return; }

  const coverPhoto = await DB.getCoverPhoto(inspectionId);
  const companyLogoPhoto = await DB.getLogoByRole(inspectionId, 'company');
  const clientLogoPhoto = await DB.getLogoByRole(inspectionId, 'client');
  const coverData = coverPhoto ? await loadNormalizedImage(coverPhoto.annotatedBlob || coverPhoto.originalBlob) : null;
  const companyLogoData = companyLogoPhoto ? await loadNormalizedImage(companyLogoPhoto.originalBlob) : null;
  const clientLogoData = clientLogoPhoto ? await loadNormalizedImage(clientLogoPhoto.originalBlob) : null;
  const logoData = [companyLogoData, clientLogoData].filter(Boolean);

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 48;
  const contentW = pageW - margin * 2;

  const includeCover = insp.includeCoverPage !== false;
  if (includeCover) {
    if (insp.coverStyle === 'archarray') {
      drawArchArrayCover(doc, { insp, coverData, companyLogoData, clientLogoData, pageW, pageH, margin, contentW });
    } else {
      drawBasicCover(doc, { insp, coverData, logoData, pageW, pageH, margin, contentW });
    }
  }
  if (includeCover) doc.addPage();
  const tocPageNum = doc.internal.getNumberOfPages();
  const tocEntries = [];

  function addImageItemPage(item, data) {
    const isLandscape = data.w > data.h;
    doc.addPage('a4', isLandscape ? 'landscape' : 'portrait');
    const pw = doc.internal.pageSize.getWidth();
    const ph = doc.internal.pageSize.getHeight();
    const cw2 = pw - margin * 2;
    let iy = margin;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10.5);
    doc.setTextColor(28, 31, 38);
    doc.text(item.title || 'Untitled', margin, iy);
    iy += 14;
    const maxH = ph - margin - iy;
    let w = cw2, h = (data.h / data.w) * w;
    if (h > maxH) { h = maxH; w = (data.w / data.h) * h; }
    doc.addImage(data.url, 'JPEG', margin, iy, w, h, undefined, 'FAST');
  }

  const reportSections = await DB.listReportSections(inspectionId);

  for (const section of reportSections) {
    if (section.type === 'text') {
      if (!section.textHtml) continue;
      doc.addPage();
      tocEntries.push({ label: section.title || 'Text', page: doc.internal.getNumberOfPages() });
      let y = margin;
      y = drawRefinedPageTitle(doc, section.title || 'Text', insp.structureName, y, { margin, contentW });
      drawRichHtmlContent(doc, section.textHtml, y, { margin, contentW, pageH });
      continue;
    }

    if (section.type === 'locationMap') {
      const mapResult = await buildLocationMapForReport(insp, { contentW });
      if (!mapResult) {
        const noCoords = (insp.locationMapMode || 'auto') === 'auto' && (!insp.location || insp.location.lat == null);
        toast(noCoords
          ? `No coordinates set — "${section.title || 'Location Map'}" skipped`
          : `Could not generate the location map — "${section.title || 'Location Map'}" skipped`);
        continue;
      }
      doc.addPage();
      tocEntries.push({ label: section.title || 'Location Map', page: doc.internal.getNumberOfPages() });
      let y = margin;
      y = pageHeading(doc, section.title || 'Location Map', y);
      doc.addImage(mapResult.url, 'JPEG', margin, y, mapResult.w, mapResult.h, undefined, 'FAST');
      continue;
    }

    if (section.type === 'inspectionDetails') {
      doc.addPage();
      tocEntries.push({ label: section.title || 'Inspection Details', page: doc.internal.getNumberOfPages() });
      let y = margin;
      y = pageHeading(doc, section.title || 'Inspection Details', y);
      drawInspectionDetailsBlock(doc, insp, y, { margin, contentW });
      continue;
    }

    if (section.type === 'elementSummary') {
      const allGroups = await buildAllElementGroups(inspectionId);
      doc.addPage();
      tocEntries.push({ label: section.title || 'Element Summary', page: doc.internal.getNumberOfPages() });
      drawElementSummaryTableForGroups(doc, allGroups, margin, { margin, contentW, pageH, title: section.title });
      continue;
    }

    if (section.type === 'inspection') {
      if (!section.elementSectionId) continue;
      const elSection = await DB.get('sections', section.elementSectionId);
      const elements = await DB.listElementsBySection(inspectionId, section.elementSectionId);
      const elementData = [];
      for (const e of elements) elementData.push(await loadElementDataForPdf(e));
      doc.addPage();
      tocEntries.push({ label: section.title || (elSection && elSection.name) || 'Inspection', page: doc.internal.getNumberOfPages() });
      const y = margin;
      drawGroupFindings(doc, insp, { section: elSection, elementData }, y, { margin, contentW, pageH, pageW });
      continue;
    }

    if (section.type === 'drawing') {
      const items = await DB.listSectionDrawings(section.id);
      if (!items.length) continue;
      let firstPage = true;
      for (const item of items) {
        const data = await loadNormalizedImage(item.annotatedBlob || item.originalBlob);
        addImageItemPage(item, data);
        if (firstPage) { tocEntries.push({ label: section.title || 'Drawings', page: doc.internal.getNumberOfPages() }); firstPage = false; }
      }
      continue;
    }

    if (section.type === 'appendices') {
      const appendices = await DB.listSectionAppendices(section.id);
      const backMatter = [];
      for (const appendix of appendices) {
        const items = await DB.listAppendixItems(appendix.id);
        if (items.length) backMatter.push({ title: appendix.name, items });
      }
      if (section.includeRiskAssessment) {
        const ra = await DB.getRiskAssessment(inspectionId);
        if (ra) backMatter.push({ title: 'Risk Assessment', ra, isRA: true });
      }
      if (!backMatter.length) continue;

      const APPENDIX_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
      for (let i = 0; i < backMatter.length; i++) {
        const bm = backMatter[i];
        const letter = APPENDIX_LETTERS[i] || String(i + 1);
        const fullTitle = `Appendix ${letter} - ${bm.title}`;
        doc.addPage('a4', 'portrait');
        tocEntries.push({ label: fullTitle, page: doc.internal.getNumberOfPages() });
        drawRefinedPageTitle(doc, fullTitle, insp.structureName, margin, { margin, contentW });

        if (bm.isRA) {
          doc.addPage('a4', 'portrait');
          const sigData = await loadRiskAssessmentSignatures(bm.ra);
          drawRiskAssessmentContent(doc, insp, bm.ra, sigData);
        } else {
          for (const item of bm.items) {
            const data = await loadNormalizedImage(item.annotatedBlob || item.originalBlob);
            addImageItemPage(item, data);
          }
        }
      }
      continue;
    }
  }

  // Backfill the Table of Contents — a flat list, since sections are already user-ordered
  // (no "Report" vs "Appendices" grouping needed, unlike Old Style's fixed structure).
  doc.setPage(tocPageNum);
  let ty = margin;
  ty = drawRefinedPageTitle(doc, 'Contents', insp.structureName, ty, { margin, contentW });
  for (const entry of tocEntries) {
    if (ty > pageH - margin) break;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(11.5);
    doc.setTextColor(28, 31, 38);
    doc.text(entry.label, margin, ty, { maxWidth: contentW - 50 });
    const pageLabel = String(entry.page);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(91, 96, 105);
    doc.text(pageLabel, pageW - margin, ty, { align: 'right' });
    const labelW = doc.getTextWidth(entry.label);
    const pageLabelW = doc.getTextWidth(pageLabel);
    drawDotLeader(doc, margin + labelW + 8, pageW - margin - pageLabelW - 8, ty - 3);
    ty += 25;
  }
  doc.setPage(doc.internal.getNumberOfPages());

  const filename = `${(insp.structureName || 'inspection').replace(/[^a-z0-9]+/gi, '_')}_${(insp.date || '').slice(0, 10)}.pdf`;
  doc.save(filename);
  toast('Report saved');
}
