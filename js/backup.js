// backup.js - full raw-data export/import (JSON backup) of everything stored in this app.
// Distinct from the PDF "Print" feature: this is a machine-readable backup of the whole
// database (inspections, elements, findings, photos, templates, risk assessments), meant
// for safekeeping or moving to a new device. Photos are embedded as base64 data URLs.

const BACKUP_STORES = ['inspections', 'sections', 'elements', 'findings', 'photos', 'templates', 'riskAssessments'];

function blobToDataURLBackup(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function dataURLToBlobBackup(dataURL) {
  const res = await fetch(dataURL);
  return res.blob();
}

async function exportRawDataBackup() {
  const payload = { app: 'Inspector', schemaVersion: DB_VERSION, exportedAt: new Date().toISOString(), stores: {} };
  for (const name of BACKUP_STORES) {
    const all = await DB.getAll(name);
    if (name === 'photos') {
      payload.stores[name] = await Promise.all(all.map(async (p) => ({
        ...p,
        originalBlob: p.originalBlob ? { __blob: true, mimeType: p.originalBlob.type, dataUrl: await blobToDataURLBackup(p.originalBlob) } : null,
        annotatedBlob: p.annotatedBlob ? { __blob: true, mimeType: p.annotatedBlob.type, dataUrl: await blobToDataURLBackup(p.annotatedBlob) } : null
      })));
    } else {
      payload.stores[name] = all;
    }
  }

  const json = JSON.stringify(payload);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `inspector-backup-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);

  const totalRecords = BACKUP_STORES.reduce((sum, name) => sum + (payload.stores[name] || []).length, 0);
  return totalRecords;
}

async function importRawDataBackup(file) {
  const text = await file.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (err) {
    throw new Error('That file is not valid JSON');
  }
  if (!payload || typeof payload !== 'object' || !payload.stores) {
    throw new Error('Not a recognized backup file');
  }

  let importedCount = 0;
  for (const name of BACKUP_STORES) {
    const records = payload.stores[name];
    if (!Array.isArray(records)) continue;
    for (const rec of records) {
      const clone = { ...rec };
      if (name === 'photos') {
        if (clone.originalBlob && clone.originalBlob.__blob) {
          clone.originalBlob = await dataURLToBlobBackup(clone.originalBlob.dataUrl);
        }
        if (clone.annotatedBlob && clone.annotatedBlob.__blob) {
          clone.annotatedBlob = await dataURLToBlobBackup(clone.annotatedBlob.dataUrl);
        }
      }
      await DB.put(name, clone);
      importedCount++;
    }
  }
  return importedCount;
}
