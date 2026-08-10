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

// Loads a blob as an upright, normalized image (corrects EXIF rotation even for photos
// captured before the in-app fix) and returns a dataURL + pixel dimensions ready for jsPDF.
async function loadNormalizedImage(blob) {
  try {
    const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    if (bitmap.close) bitmap.close();
    return { url: canvas.toDataURL('image/jpeg', 0.92), w: bitmap.width, h: bitmap.height };
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
  const logos = await DB.listLogos(inspectionId);

  let coverData = null;
  if (coverPhoto) coverData = await loadNormalizedImage(coverPhoto.annotatedBlob || coverPhoto.originalBlob);

  const logoData = [];
  for (const l of logos) logoData.push(await loadNormalizedImage(l.originalBlob));

  async function loadElementData(elmt) {
    const refPhotos = [];
    for (const p of await DB.listPhotosForElement(elmt.id)) refPhotos.push(await loadNormalizedImage(p.annotatedBlob || p.originalBlob));

    const findings = await DB.listFindings(elmt.id);
    const findingsWithPhotos = [];
    for (const f of findings) {
      const photoData = [];
      for (const p of await DB.listPhotosForFinding(f.id)) photoData.push(await loadNormalizedImage(p.annotatedBlob || p.originalBlob));
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
  doc.setFillColor(255, 255, 255);
  doc.rect(0, 0, pageW, pageH, 'F');

  // Red curved swoosh, bleeding off the bottom-right — built from overlapping filled
  // ellipses (avoids relying on jsPDF's less consistent low-level path API).
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

  // ---------- Introduction / Summary ----------
  if (insp.introduction) {
    doc.addPage();
    let iy = margin;
    iy = pageHeading(doc, 'Introduction / Summary', iy);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(11);
    doc.setTextColor(28, 31, 38);
    const introLines = doc.splitTextToSize(insp.introduction, contentW);
    for (const line of introLines) {
      if (iy > pageH - margin) { doc.addPage(); iy = margin; }
      doc.text(line, margin, iy);
      iy += 15;
    }
  }

  // ---------- Details page ----------
  doc.addPage();
  let y = margin;
  y = pageHeading(doc, 'Inspection Details', y);

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

  // Element summary table (grouped by section)
  y += 30;
  if (y > pageH - 150) { doc.addPage(); y = margin; }
  y = pageHeading(doc, 'Element Summary', y);

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

  // ---------- Detailed findings, grouped by section ----------
  for (const g of groups) {
    doc.addPage();
    y = margin;
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

      // Element reference photos
      if (ed.refPhotos.length) {
        const gap = 8;
        const thumbW = (contentW - gap * 3) / 4;
        let col = 0, rowH = 0;
        for (const p of ed.refPhotos) {
          const h = Math.min((p.h / p.w) * thumbW, 130);
          if (col === 0 && y + h > pageH - margin) { doc.addPage(); y = margin; }
          const x = margin + col * (thumbW + gap);
          doc.addImage(p.url, 'JPEG', x, y, thumbW, h, undefined, 'FAST');
          rowH = Math.max(rowH, h);
          col++;
          if (col === 4) { col = 0; y += rowH + gap; rowH = 0; }
        }
        if (col !== 0) y += rowH + gap;
        y += 6;
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
          const estLine = f.costEstimate ? `Cost estimate: ${f.costEstimate}` : '';
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
      y += 12;
    }
  }

  // ---------- Conclusion & Recommendations ----------
  if (insp.conclusion || (insp.recommendations && insp.recommendations.length)) {
    doc.addPage();
    let cy = margin;
    if (insp.conclusion) {
      cy = pageHeading(doc, 'Conclusion', cy);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(11);
      doc.setTextColor(28, 31, 38);
      const lines = doc.splitTextToSize(insp.conclusion, contentW);
      for (const line of lines) {
        if (cy > pageH - margin) { doc.addPage(); cy = margin; }
        doc.text(line, margin, cy);
        cy += 15;
      }
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
