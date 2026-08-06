// pdf.js - builds the exportable inspection report using jsPDF (loaded from CDN, cached by service worker)

const SEV_COLORS_RGB = {
  1: [79, 157, 92],
  2: [143, 174, 63],
  3: [224, 167, 46],
  4: [224, 103, 46],
  5: [200, 30, 30]
};

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function loadImageDims(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = reject;
    img.src = dataUrl;
  });
}

async function exportInspectionPDF(inspectionId) {
  if (!window.jspdf) {
    toast('PDF library not loaded. Connect to the internet once to cache it, then try again.');
    return;
  }
  toast('Building report…');

  const insp = await DB.get('inspections', inspectionId);
  const elements = await DB.listElements(inspectionId);
  const coverPhoto = await DB.getCoverPhoto(inspectionId);

  // Preload cover photo
  let coverData = null;
  if (coverPhoto) {
    const url = await blobToDataURL(coverPhoto.annotatedBlob || coverPhoto.originalBlob);
    const dims = await loadImageDims(url);
    coverData = { url, ...dims };
  }

  // Preload element/finding data with photos
  const elementData = [];
  for (const elmt of elements) {
    const findings = await DB.listFindings(elmt.id);
    const findingsWithPhotos = [];
    for (const f of findings) {
      const photos = await DB.listPhotosForFinding(f.id);
      const photoData = [];
      for (const p of photos) {
        const url = await blobToDataURL(p.annotatedBlob || p.originalBlob);
        const dims = await loadImageDims(url);
        photoData.push({ url, ...dims });
      }
      findingsWithPhotos.push({ ...f, photos: photoData });
    }
    elementData.push({ element: elmt, findings: findingsWithPhotos });
  }

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 48;
  const contentW = pageW - margin * 2;

  // ---------- Cover page ----------
  doc.setFillColor(255, 255, 255);
  doc.rect(0, 0, pageW, pageH, 'F');

  // Red curved swoosh (bezier path), bleeding off the right/bottom edge
  doc.setFillColor(200, 30, 30);
  doc.path([
    { op: 'm', c: [pageW * 0.15, pageH * 0.62] },
    { op: 'c', c: [pageW * 0.55, pageH * 0.40, pageW * 0.78, pageH * 0.78, pageW * 1.05, pageH * 0.70] },
    { op: 'l', c: [pageW * 1.05, pageH * 1.05] },
    { op: 'l', c: [-10, pageH * 1.05] },
    { op: 'c', c: [pageW * 0.05, pageH * 0.85, pageW * 0.02, pageH * 0.70, pageW * 0.15, pageH * 0.62] },
    { op: 'h' }
  ]).fill();

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

  if (coverData) {
    const maxW = contentW * 0.8;
    const maxH = pageH * 0.32;
    let w = maxW, h = (coverData.h / coverData.w) * w;
    if (h > maxH) { h = maxH; w = (coverData.w / coverData.h) * h; }
    const x = (pageW - w) / 2;
    const y = pageH - h - 90;
    doc.setDrawColor(255, 255, 255);
    doc.setFillColor(255, 255, 255);
    doc.roundedRect(x - 6, y - 6, w + 12, h + 12, 4, 4, 'F');
    doc.addImage(coverData.url, 'JPEG', x, y, w, h, undefined, 'FAST');
  }

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(120, 124, 132);
  doc.text(fmtDate(insp.date), margin, pageH - 40);

  // ---------- Details page ----------
  doc.addPage();
  let y = margin;
  y = pageHeading(doc, 'Inspection Details', y);

  const details = [
    ['Structure name', insp.structureName || '—'],
    ['Structure ID', insp.structureId || '—'],
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

  // Element summary table
  y += 30;
  if (y > pageH - 150) { doc.addPage(); y = margin; }
  y = pageHeading(doc, 'Element Summary', y);

  const rows = elementData.map((ed) => {
    let worstSeverity = 0, worstExtent = '';
    const extentOrder = ['A', 'B', 'C', 'D', 'E'];
    ed.findings.forEach((f) => {
      if (f.severity && f.severity > worstSeverity) worstSeverity = f.severity;
      if (f.extent && extentOrder.indexOf(f.extent) > extentOrder.indexOf(worstExtent || 'A')) worstExtent = f.extent;
    });
    return [ed.element.name, String(ed.findings.length), worstSeverity ? String(worstSeverity) : '—', worstExtent || '—'];
  });

  if (doc.autoTable) {
    doc.autoTable({
      startY: y,
      margin: { left: margin, right: margin },
      head: [['Element', 'Findings', 'Worst Severity', 'Worst Extent']],
      body: rows,
      styles: { font: 'helvetica', fontSize: 10, cellPadding: 6 },
      headStyles: { fillColor: [28, 31, 38], textColor: 255 },
      didParseCell: (data) => {
        if (data.section === 'body' && data.column.index === 2) {
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
    // Fallback simple table if autotable isn't available
    doc.setFontSize(10);
    rows.forEach((r) => {
      doc.text(r.join('   |   '), margin, y);
      y += 16;
    });
  }

  // ---------- Detailed findings by element ----------
  for (const ed of elementData) {
    doc.addPage();
    y = margin;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(16);
    doc.setTextColor(28, 31, 38);
    doc.text(ed.element.name, margin, y);
    y += 26;
    doc.setDrawColor(220, 223, 228);
    doc.line(margin, y - 10, pageW - margin, y - 10);

    if (!ed.findings.length) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(11);
      doc.setTextColor(120, 124, 132);
      doc.text('No findings recorded for this element.', margin, y);
      continue;
    }

    for (const f of ed.findings) {
      const neededHeader = 60;
      if (y + neededHeader > pageH - margin) { doc.addPage(); y = margin; }

      // Severity + extent badges
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

      // Photos, 2 per row
      if (f.photos.length) {
        const gap = 10;
        const thumbW = (contentW - gap) / 2;
        let col = 0, rowMaxH = 0;
        for (const p of f.photos) {
          const h = Math.min((p.h / p.w) * thumbW, 260);
          if (col === 0 && y + h > pageH - margin) { doc.addPage(); y = margin; }
          const x = margin + col * (thumbW + gap);
          doc.addImage(p.url, 'JPEG', x, y, thumbW, h, undefined, 'FAST');
          rowMaxH = Math.max(rowMaxH, h);
          col++;
          if (col === 2) { col = 0; y += rowMaxH + gap; rowMaxH = 0; }
        }
        if (col !== 0) y += rowMaxH + gap;
      }
      y += 16;
      doc.setDrawColor(235, 236, 239);
      doc.line(margin, y - 8, pageW - margin, y - 8);
    }
  }

  const filename = `${(insp.structureName || 'inspection').replace(/[^a-z0-9]+/gi, '_')}_${(insp.date || '').slice(0, 10)}.pdf`;
  doc.save(filename);
  toast('Report saved');
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
