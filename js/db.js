// db.js - IndexedDB wrapper for the Site Inspection app
// Stores: inspections, sections, elements, findings, photos, templates

const DB_NAME = 'siteInspectionDB';
const DB_VERSION = 7;

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (event) => {
      const db = event.target.result;
      const tx = event.target.transaction;
      const oldVersion = event.oldVersion;

      if (oldVersion < 1) {
        db.createObjectStore('inspections', { keyPath: 'id' });

        const elStore = db.createObjectStore('elements', { keyPath: 'id' });
        elStore.createIndex('inspectionId', 'inspectionId', { unique: false });

        const fStore = db.createObjectStore('findings', { keyPath: 'id' });
        fStore.createIndex('elementId', 'elementId', { unique: false });

        const pStore = db.createObjectStore('photos', { keyPath: 'id' });
        pStore.createIndex('findingId', 'findingId', { unique: false });
        pStore.createIndex('inspectionId', 'inspectionId', { unique: false });

        db.createObjectStore('templates', { keyPath: 'id' });
      }

      if (oldVersion < 2) {
        if (!db.objectStoreNames.contains('sections')) {
          const sStore = db.createObjectStore('sections', { keyPath: 'id' });
          sStore.createIndex('inspectionId', 'inspectionId', { unique: false });
        }
        const photosStore = tx.objectStore('photos');
        if (!photosStore.indexNames.contains('elementId')) {
          photosStore.createIndex('elementId', 'elementId', { unique: false });
        }
      }

      if (oldVersion < 3) {
        if (!db.objectStoreNames.contains('riskAssessments')) {
          const raStore = db.createObjectStore('riskAssessments', { keyPath: 'id' });
          raStore.createIndex('inspectionId', 'inspectionId', { unique: false });
        }
        const photosStore2 = tx.objectStore('photos');
        if (!photosStore2.indexNames.contains('riskAssessmentId')) {
          photosStore2.createIndex('riskAssessmentId', 'riskAssessmentId', { unique: false });
        }
      }

      if (oldVersion < 4) {
        const photosStore3 = tx.objectStore('photos');
        if (!photosStore3.indexNames.contains('appendixId')) {
          photosStore3.createIndex('appendixId', 'appendixId', { unique: false });
        }
      }

      if (oldVersion < 5) {
        // New Style reports: a flexible, user-ordered list of report sections, plus
        // reusable templates defining a starter set of section shells.
        if (!db.objectStoreNames.contains('reportSections')) {
          const rsStore = db.createObjectStore('reportSections', { keyPath: 'id' });
          rsStore.createIndex('inspectionId', 'inspectionId', { unique: false });
        }
        if (!db.objectStoreNames.contains('reportTemplates')) {
          db.createObjectStore('reportTemplates', { keyPath: 'id' });
        }
        const photosStore4 = tx.objectStore('photos');
        if (!photosStore4.indexNames.contains('reportSectionId')) {
          photosStore4.createIndex('reportSectionId', 'reportSectionId', { unique: false });
        }
      }

      if (oldVersion < 6) {
        // Project Management module: WBS task hierarchy + scheduling. Data model is the
        // source of truth (Gantt is a view of it, built in a later pass) — matches the
        // New Style report principle of not inventing parallel storage for a new UI.
        if (!db.objectStoreNames.contains('pmProjects')) {
          db.createObjectStore('pmProjects', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('pmTasks')) {
          const ptStore = db.createObjectStore('pmTasks', { keyPath: 'id' });
          ptStore.createIndex('projectId', 'projectId', { unique: false });
          ptStore.createIndex('parentId', 'parentId', { unique: false });
        }
        if (!db.objectStoreNames.contains('pmDependencies')) {
          const pdStore = db.createObjectStore('pmDependencies', { keyPath: 'id' });
          pdStore.createIndex('projectId', 'projectId', { unique: false });
          pdStore.createIndex('predecessorId', 'predecessorId', { unique: false });
          pdStore.createIndex('successorId', 'successorId', { unique: false });
        }
      }

      if (oldVersion < 7) {
        // Project Management: Resources. Resources are GLOBAL (no projectId) — a named person
        // or piece of plant is a real-world entity that outlives any one project and gets
        // reused across them, not duplicated per project. Assignments are what's project-scoped
        // (a resource linked to a specific task within a specific project).
        if (!db.objectStoreNames.contains('pmResources')) {
          db.createObjectStore('pmResources', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('pmAssignments')) {
          const paStore = db.createObjectStore('pmAssignments', { keyPath: 'id' });
          paStore.createIndex('projectId', 'projectId', { unique: false });
          paStore.createIndex('taskId', 'taskId', { unique: false });
          paStore.createIndex('resourceId', 'resourceId', { unique: false });
        }
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function uid() {
  return 'id_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 9);
}

function txStore(storeName, mode) {
  return openDB().then((db) => db.transaction(storeName, mode).objectStore(storeName));
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const DB = {
  uid,

  // Generic CRUD
  async put(storeName, obj) {
    const store = await txStore(storeName, 'readwrite');
    await reqToPromise(store.put(obj));
    return obj;
  },
  async get(storeName, id) {
    const store = await txStore(storeName, 'readonly');
    return reqToPromise(store.get(id));
  },
  async getAll(storeName) {
    const store = await txStore(storeName, 'readonly');
    return reqToPromise(store.getAll());
  },
  async delete(storeName, id) {
    const store = await txStore(storeName, 'readwrite');
    return reqToPromise(store.delete(id));
  },
  async getAllByIndex(storeName, indexName, value) {
    const store = await txStore(storeName, 'readonly');
    const idx = store.index(indexName);
    return reqToPromise(idx.getAll(value));
  },

  // --- Inspections ---
  async createInspection(data) {
    const now = new Date().toISOString();
    const inspection = {
      id: uid(),
      structureId: data.structureId || '',
      structureName: data.structureName || '',
      title: data.title || 'Structural Inspection Report',
      coverStyle: data.coverStyle || 'basic',
      subtitle: data.subtitle || '',
      client: data.client || '',
      reference: data.reference || '',
      companyName: data.companyName || '',
      companyAddress: data.companyAddress || '',
      currency: data.currency || 'USD',
      locationMapMode: data.locationMapMode || 'auto', // 'auto' (generated) | 'custom' (uploaded) | 'off'
      locationMapScale: data.locationMapScale || 2500,
      includeCoverPage: data.includeCoverPage != null ? !!data.includeCoverPage : true,
      reportStyle: data.reportStyle === 'new' ? 'new' : 'old', // set at creation; can later change via convertInspectionToNewStyle
      includeRiskAssessmentAppendix: !!data.includeRiskAssessmentAppendix,
      introduction: data.introduction || '',
      summary: data.summary || '',
      conclusion: data.conclusion || '',
      recommendations: data.recommendations || [],
      location: data.location || { lat: null, lng: null, manual: '' },
      weather: data.weather || '',
      inspectionType: data.inspectionType || '',
      inspector: data.inspector || '',
      date: data.date || now,
      notes: data.notes || '',
      createdAt: now,
      updatedAt: now
    };
    return this.put('inspections', inspection);
  },
  async updateInspection(id, patch) {
    const existing = await this.get('inspections', id);
    if (!existing) throw new Error('Inspection not found');
    const updated = { ...existing, ...patch, updatedAt: new Date().toISOString() };
    return this.put('inspections', updated);
  },
  async deleteInspectionCascade(id) {
    const sections = await this.getAllByIndex('sections', 'inspectionId', id);
    for (const s of sections) await this.deleteSectionCascade(s.id);
    const elements = await this.getAllByIndex('elements', 'inspectionId', id);
    for (const el of elements) {
      if (!el.sectionId) await this.deleteElementCascade(el.id);
    }
    const ra = await this.getRiskAssessment(id);
    if (ra) await this.deleteRiskAssessmentCascade(ra.id);
    const insp = await this.get('inspections', id);
    for (const a of ((insp && insp.appendices) || [])) {
      const items = await this.listAppendixItems(a.id);
      for (const item of items) await this.delete('photos', item.id);
    }
    const reportSections = await this.getAllByIndex('reportSections', 'inspectionId', id);
    for (const rs of reportSections) {
      // Drawing/appendix items and any linked element-grouping `sections` record; the
      // `sections` cleanup above already covers the element side for the whole inspection.
      if (rs.type === 'drawing') {
        const items = await this.getAllByIndex('photos', 'reportSectionId', rs.id);
        for (const item of items) await this.delete('photos', item.id);
      }
      if (rs.type === 'appendices') {
        for (const a of (rs.appendices || [])) {
          const items = await this.listAppendixItems(a.id);
          for (const item of items) await this.delete('photos', item.id);
        }
      }
      await this.delete('reportSections', rs.id);
    }
    const inspPhotos = await this.getAllByIndex('photos', 'inspectionId', id);
    for (const p of inspPhotos) await this.delete('photos', p.id);
    await this.delete('inspections', id);
  },

  // One-time, deliberate migration from Old Style to New Style — never happened
  // automatically before this, since reportStyle was previously a permanent,
  // creation-time-only choice. Doesn't touch elements/findings/photos at all
  // (already shared between both styles) — only auto-generates an equivalent
  // reportSections scaffold from Old Style's fixed fields, then flips the flag.
  async convertInspectionToNewStyle(inspectionId) {
    const insp = await this.get('inspections', inspectionId);
    if (!insp || insp.reportStyle === 'new') return insp;

    if (insp.introduction) {
      const s = await this.addReportSection(inspectionId, 'text', 'Introduction');
      await this.updateReportSection(s.id, { textHtml: insp.introduction });
    }
    if (insp.summary) {
      const s = await this.addReportSection(inspectionId, 'text', 'Summary');
      await this.updateReportSection(s.id, { textHtml: insp.summary });
    }
    await this.addReportSection(inspectionId, 'locationMap', '');
    await this.addReportSection(inspectionId, 'inspectionDetails', '');

    // Old Style's existing sections become nested Structure Sections under one
    // new Inspection Findings entry, preserving their current grouping exactly.
    const findingsSection = await this.addReportSection(inspectionId, 'inspection', '');
    const sections = await this.listSections(inspectionId);
    for (const sec of sections) {
      await this.updateSection(sec.id, { reportSectionId: findingsSection.id });
    }

    await this.addReportSection(inspectionId, 'elementSummary', '');

    if (insp.conclusion) {
      const s = await this.addReportSection(inspectionId, 'text', 'Conclusion');
      await this.updateReportSection(s.id, { textHtml: insp.conclusion });
    }
    if (insp.recommendations && insp.recommendations.length) {
      const s = await this.addReportSection(inspectionId, 'recommendations', 'Recommendations');
      await this.updateReportSection(s.id, { recommendations: insp.recommendations.filter(Boolean) });
    }

    await this.addReportSection(inspectionId, 'drawing', 'Drawings');
    const apx = await this.addReportSection(inspectionId, 'appendices', 'Appendices');
    if (insp.includeRiskAssessmentAppendix) {
      await this.updateReportSection(apx.id, { includeRiskAssessment: true });
    }

    await this.updateInspection(inspectionId, { reportStyle: 'new' });
    return await this.get('inspections', inspectionId);
  },
  async listInspections() {
    const all = await this.getAll('inspections');
    return all.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  },

  // --- Sections ---
  async createSection(inspectionId, data) {
    const section = {
      id: uid(),
      inspectionId,
      reportSectionId: data.reportSectionId || null, // links a Structure Section to its owning Inspection Findings report section (New Style only)
      name: data.name || 'Untitled section',
      comments: data.comments || '',
      order: data.order || 0,
      createdAt: new Date().toISOString()
    };
    return this.put('sections', section);
  },
  async updateSection(id, patch) {
    const existing = await this.get('sections', id);
    if (!existing) throw new Error('Section not found');
    return this.put('sections', { ...existing, ...patch });
  },
  async listSections(inspectionId) {
    const all = await this.getAllByIndex('sections', 'inspectionId', inspectionId);
    return all.sort((a, b) => a.order - b.order);
  },
  async deleteSectionCascade(sectionId) {
    const section = await this.get('sections', sectionId);
    if (!section) return;
    const elements = await this.getAllByIndex('elements', 'inspectionId', section.inspectionId);
    const inSection = elements.filter((e) => e.sectionId === sectionId);
    for (const el of inSection) await this.deleteElementCascade(el.id);
    await this.delete('sections', sectionId);
  },

  // --- Elements ---
  async createElement(inspectionId, data) {
    const el = {
      id: uid(),
      inspectionId,
      sectionId: data.sectionId || null,
      reportSectionId: data.reportSectionId || null, // for elements added directly under an Inspection Findings report section, no Structure Section (New Style only)
      name: data.name || 'Untitled element',
      category: data.category || '',
      materialType: data.materialType || '',
      location: data.location || '',
      elementType: data.elementType || '',
      importance: data.importance || '',
      notInspected: !!data.notInspected,
      order: data.order || 0,
      createdAt: new Date().toISOString()
    };
    return this.put('elements', el);
  },
  async updateElement(id, patch) {
    const existing = await this.get('elements', id);
    if (!existing) throw new Error('Element not found');
    return this.put('elements', { ...existing, ...patch });
  },
  async listElements(inspectionId) {
    const all = await this.getAllByIndex('elements', 'inspectionId', inspectionId);
    return all.sort((a, b) => a.order - b.order);
  },
  async listElementsBySection(inspectionId, sectionId) {
    const all = await this.listElements(inspectionId);
    return all.filter((e) => (e.sectionId || null) === (sectionId || null));
  },
  // --- Nested content within an Inspection Findings report section (New Style) ---
  async listStructureSections(inspectionId, reportSectionId) {
    const all = await this.listSections(inspectionId);
    return all.filter((s) => s.reportSectionId === reportSectionId);
  },
  async createStructureSection(inspectionId, reportSectionId, data) {
    return this.createSection(inspectionId, { ...data, reportSectionId });
  },
  async listDirectElements(inspectionId, reportSectionId) {
    const all = await this.listElements(inspectionId);
    return all.filter((e) => e.reportSectionId === reportSectionId && !e.sectionId);
  },
  async deleteElementCascade(elementId) {
    const findings = await this.getAllByIndex('findings', 'elementId', elementId);
    for (const f of findings) {
      await this.deleteFindingCascade(f.id);
    }
    const elPhotos = await this.getAllByIndex('photos', 'elementId', elementId);
    for (const p of elPhotos) await this.delete('photos', p.id);
    await this.delete('elements', elementId);
  },

  // --- Findings ---
  async createFinding(elementId, data) {
    const finding = {
      id: uid(),
      elementId,
      severity: data.severity || null,
      extent: data.extent || null,
      priority: data.priority || null,
      worksRequired: !!data.worksRequired,
      worksDescription: data.worksDescription || '',
      costEstimate: data.costEstimate || '',
      notes: data.notes || '',
      // For Safety Inspection: whether severity/extent/works are shown for this finding.
      // Defaults false there (simple mode); irrelevant for other inspection types, which
      // always show the full fields regardless of this flag.
      // Safety Inspection: severity/extent and works-required are each shown/hidden
      // independently, per finding, via their own toggle.
      showDetail: data.showDetail != null ? !!data.showDetail : false,
      showWorks: data.showWorks != null ? !!data.showWorks : false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    return this.put('findings', finding);
  },
  async updateFinding(id, patch) {
    const existing = await this.get('findings', id);
    if (!existing) throw new Error('Finding not found');
    const updated = { ...existing, ...patch, updatedAt: new Date().toISOString() };
    return this.put('findings', updated);
  },
  async listFindings(elementId) {
    const all = await this.getAllByIndex('findings', 'elementId', elementId);
    return all.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  },
  async deleteFindingCascade(findingId) {
    const photos = await this.getAllByIndex('photos', 'findingId', findingId);
    for (const p of photos) await this.delete('photos', p.id);
    await this.delete('findings', findingId);
  },

  // --- Photos ---
  // photo: { id, kind: 'cover'|'logo'|'element'|'finding'|'signature'|'drawing'|'standalone'|'appendixItem', findingId, elementId,
  //          inspectionId, riskAssessmentId, appendixId, reportSectionId, role, originalBlob, annotatedBlob, order, createdAt }
  async addPhoto({ kind = 'finding', findingId = null, elementId = null, inspectionId = null, riskAssessmentId = null, appendixId = null, reportSectionId = null, originalBlob, order = 0, role = null, title = '' }) {
    const photo = {
      id: uid(),
      kind,
      findingId,
      elementId,
      inspectionId,
      riskAssessmentId,
      appendixId,
      reportSectionId,
      role,
      title,
      originalBlob,
      annotatedBlob: null,
      order,
      createdAt: new Date().toISOString()
    };
    return this.put('photos', photo);
  },
  async setAnnotatedBlob(photoId, blob, annotationObjects) {
    const existing = await this.get('photos', photoId);
    if (!existing) throw new Error('Photo not found');
    existing.annotatedBlob = blob;
    // Committing a flattened save clears any previously saved editable layer — from this
    // point the marks are permanently part of the image, matching "Flatten & commit".
    // annotationObjects (Text/Measure) is deliberately NOT cleared here — "Flatten" has
    // always referred specifically to the Drawing layer's pixels; keeping annotation
    // objects editable regardless of which save button was used is the entire point of
    // that layer existing as structured data instead of pixels in the first place.
    existing.editableMarkBlob = null;
    if (annotationObjects) existing.annotationObjects = annotationObjects;
    return this.put('photos', existing);
  },
  // "Save, keep editable" — stores the flattened result for display/export (same as
  // setAnnotatedBlob) but also keeps the raw, unflattened mark layer so a later visit to
  // the annotator can reload it and continue editing individual marks rather than starting
  // from an image with everything already baked in.
  async saveEditableAnnotation(photoId, mergedBlob, markBlob, annotationObjects) {
    const existing = await this.get('photos', photoId);
    if (!existing) throw new Error('Photo not found');
    existing.annotatedBlob = mergedBlob;
    existing.editableMarkBlob = markBlob;
    if (annotationObjects) existing.annotationObjects = annotationObjects;
    return this.put('photos', existing);
  },
  async listPhotosForFinding(findingId) {
    const all = await this.getAllByIndex('photos', 'findingId', findingId);
    return all.filter((p) => p.kind !== 'logo').sort((a, b) => a.order - b.order);
  },
  async listPhotosForElement(elementId) {
    const all = await this.getAllByIndex('photos', 'elementId', elementId);
    return all.sort((a, b) => a.order - b.order);
  },
  async addElementPhoto(elementId, blob) {
    const existing = await this.listPhotosForElement(elementId);
    return this.addPhoto({ kind: 'element', elementId, originalBlob: blob, order: existing.length });
  },
  async getCoverPhoto(inspectionId) {
    const all = await this.getAllByIndex('photos', 'inspectionId', inspectionId);
    return all.find((p) => p.kind === 'cover' || !p.kind) || null;
  },
  async setCoverPhoto(inspectionId, blob) {
    const existing = await this.getCoverPhoto(inspectionId);
    if (existing) {
      existing.originalBlob = blob;
      existing.annotatedBlob = null;
      existing.kind = 'cover';
      return this.put('photos', existing);
    }
    return this.addPhoto({ kind: 'cover', inspectionId, originalBlob: blob });
  },
  async removeCoverPhoto(inspectionId) {
    const existing = await this.getCoverPhoto(inspectionId);
    if (existing) await this.delete('photos', existing.id);
  },
  async listLogos(inspectionId) {
    const all = await this.getAllByIndex('photos', 'inspectionId', inspectionId);
    return all.filter((p) => p.kind === 'logo').sort((a, b) => a.order - b.order);
  },
  async addLogo(inspectionId, blob) {
    const existing = await this.listLogos(inspectionId);
    return this.addPhoto({ kind: 'logo', inspectionId, originalBlob: blob, order: existing.length });
  },
  // Explicit role-based logo access (Company / Client). Falls back to upload order for
  // logos saved before roles existed, so old data still displays sensibly.
  async getLogoByRole(inspectionId, role) {
    const all = await this.listLogos(inspectionId);
    let found = all.find((p) => p.role === role);
    if (!found && !all.some((p) => p.role)) {
      const idx = role === 'company' ? 0 : 1;
      found = all[idx] || null;
    }
    return found || null;
  },
  async setLogoByRole(inspectionId, role, blob) {
    const existing = await this.getLogoByRole(inspectionId, role);
    if (existing) {
      existing.originalBlob = blob;
      existing.role = role;
      return this.put('photos', existing);
    }
    return this.addPhoto({ kind: 'logo', inspectionId, originalBlob: blob, order: 0, role });
  },
  async removeLogoByRole(inspectionId, role) {
    const existing = await this.getLogoByRole(inspectionId, role);
    if (existing) await this.delete('photos', existing.id);
  },

  // --- Drawings (imported PDF pages, annotatable like photos) ---
  async listDrawings(inspectionId) {
    const all = await this.getAllByIndex('photos', 'inspectionId', inspectionId);
    return all.filter((p) => p.kind === 'drawing').sort((a, b) => a.order - b.order);
  },
  async addDrawing(inspectionId, blob, title) {
    const existing = await this.listDrawings(inspectionId);
    const photo = {
      id: uid(),
      kind: 'drawing',
      findingId: null,
      elementId: null,
      inspectionId,
      riskAssessmentId: null,
      role: null,
      originalBlob: blob,
      annotatedBlob: null,
      order: existing.length,
      title: title || '',
      includeInReport: true,
      createdAt: new Date().toISOString()
    };
    return this.put('photos', photo);
  },
  async updateDrawing(id, patch) {
    const existing = await this.get('photos', id);
    if (!existing) throw new Error('Drawing not found');
    return this.put('photos', { ...existing, ...patch });
  },
  // Generic photo update — used for calibration data, which can apply to any photo kind
  // (element/finding photos, cover photo, drawings), not just drawings specifically.
  async updatePhoto(id, patch) {
    const existing = await this.get('photos', id);
    if (!existing) throw new Error('Photo not found');
    return this.put('photos', { ...existing, ...patch });
  },

  // --- Appendices (named groups of PDFs/photos, appear after Conclusion & Recommendations) ---
  // Lightweight metadata lives as an array on the inspection itself; items (photos / imported
  // PDF pages) live in the photos store, same pattern as Drawings, linked via appendixId.
  async listAppendices(inspectionId) {
    const insp = await this.get('inspections', inspectionId);
    return ((insp && insp.appendices) || []).slice().sort((a, b) => a.order - b.order);
  },
  async addAppendix(inspectionId, name) {
    const insp = await this.get('inspections', inspectionId);
    const appendices = [...((insp && insp.appendices) || [])];
    const appendix = { id: uid(), name: name || 'Untitled appendix', order: appendices.length };
    appendices.push(appendix);
    await this.updateInspection(inspectionId, { appendices });
    return appendix;
  },
  async updateAppendix(inspectionId, appendixId, patch) {
    const insp = await this.get('inspections', inspectionId);
    const appendices = ((insp && insp.appendices) || []).map((a) => (a.id === appendixId ? { ...a, ...patch } : a));
    await this.updateInspection(inspectionId, { appendices });
  },
  async deleteAppendixCascade(inspectionId, appendixId) {
    const insp = await this.get('inspections', inspectionId);
    const appendices = ((insp && insp.appendices) || []).filter((a) => a.id !== appendixId);
    await this.updateInspection(inspectionId, { appendices });
    const items = await this.listAppendixItems(appendixId);
    for (const item of items) await this.delete('photos', item.id);
  },
  async listAppendixItems(appendixId) {
    const all = await this.getAllByIndex('photos', 'appendixId', appendixId);
    return all.sort((a, b) => a.order - b.order);
  },
  async addAppendixItem(appendixId, blob, title) {
    const existing = await this.listAppendixItems(appendixId);
    return this.addPhoto({ kind: 'appendixItem', appendixId, originalBlob: blob, order: existing.length, title: title || '' });
  },

  // --- Custom location map image (alternative to the auto-generated map) ---
  async getCustomLocationMap(inspectionId) {
    const all = await this.getAllByIndex('photos', 'inspectionId', inspectionId);
    return all.find((p) => p.kind === 'locationMapCustom') || null;
  },
  async setCustomLocationMap(inspectionId, blob) {
    const existing = await this.getCustomLocationMap(inspectionId);
    if (existing) {
      existing.originalBlob = blob;
      return this.put('photos', existing);
    }
    return this.addPhoto({ kind: 'locationMapCustom', inspectionId, originalBlob: blob });
  },
  async removeCustomLocationMap(inspectionId) {
    const existing = await this.getCustomLocationMap(inspectionId);
    if (existing) await this.delete('photos', existing.id);
  },

  // --- New Style reports: flexible, user-ordered report sections ---
  // reportSection: { id, inspectionId, order, type, title,
  //   textHtml (type='text'), elementSectionId (type='inspection', links to `sections`),
  //   appendices[] + includeRiskAssessment (type='appendices'), createdAt, updatedAt }
  // type is one of: 'text' | 'drawing' | 'inspection' | 'locationMap' | 'inspectionDetails' |
  //                 'elementSummary' | 'appendices'
  async listReportSections(inspectionId) {
    const all = await this.getAllByIndex('reportSections', 'inspectionId', inspectionId);
    return all.sort((a, b) => a.order - b.order);
  },
  async addReportSection(inspectionId, type, title) {
    const existing = await this.listReportSections(inspectionId);
    const section = {
      id: uid(),
      inspectionId,
      order: existing.length + 1,
      type,
      title: title || '',
      textHtml: '',
      elementSectionId: null,
      appendices: [],
      includeRiskAssessment: false,
      recommendations: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await this.put('reportSections', section);
    return section;
  },
  async updateReportSection(id, patch) {
    const existing = await this.get('reportSections', id);
    if (!existing) throw new Error('Report section not found');
    const updated = { ...existing, ...patch, updatedAt: new Date().toISOString() };
    await this.put('reportSections', updated);
    return updated;
  },
  async deleteReportSectionCascade(id) {
    const section = await this.get('reportSections', id);
    if (!section) return;
    if (section.type === 'inspection') {
      // Every Structure Section (and its elements/findings) nested under this Inspection
      // Findings section, plus any elements added directly without a Structure Section.
      const structureSections = await this.listStructureSections(section.inspectionId, id);
      for (const ss of structureSections) await this.deleteSectionCascade(ss.id);
      const directElements = await this.listDirectElements(section.inspectionId, id);
      for (const el of directElements) await this.deleteElementCascade(el.id);
    }
    if (section.type === 'drawing') {
      const items = await this.getAllByIndex('photos', 'reportSectionId', id);
      for (const item of items) await this.delete('photos', item.id);
    }
    if (section.type === 'appendices') {
      for (const a of (section.appendices || [])) {
        const items = await this.listAppendixItems(a.id);
        for (const item of items) await this.delete('photos', item.id);
      }
    }
    await this.delete('reportSections', id);
    // Renumber remaining sections so order stays a contiguous 1..N sequence.
    const remaining = await this.listReportSections(section.inspectionId);
    for (let i = 0; i < remaining.length; i++) {
      if (remaining[i].order !== i + 1) await this.updateReportSection(remaining[i].id, { order: i + 1 });
    }
  },
  // Moves a section to a new position, shifting everything between old and new position to
  // make room — insert-at-position semantics, matching how you'd expect renumbering to work.
  async reorderReportSection(inspectionId, sectionId, newOrder) {
    const sections = await this.listReportSections(inspectionId);
    const moving = sections.find((s) => s.id === sectionId);
    if (!moving) return;
    const clampedOrder = Math.max(1, Math.min(sections.length, newOrder));
    const others = sections.filter((s) => s.id !== sectionId);
    others.splice(clampedOrder - 1, 0, moving);
    for (let i = 0; i < others.length; i++) {
      if (others[i].order !== i + 1) await this.updateReportSection(others[i].id, { order: i + 1 });
    }
  },

  // --- Drawing items scoped to a specific Drawing-type report section ---
  async listSectionDrawings(reportSectionId) {
    const all = await this.getAllByIndex('photos', 'reportSectionId', reportSectionId);
    return all.filter((p) => p.kind === 'drawing').sort((a, b) => a.order - b.order);
  },
  async addSectionDrawing(reportSectionId, inspectionId, blob, title) {
    const existing = await this.listSectionDrawings(reportSectionId);
    return this.addPhoto({ kind: 'drawing', reportSectionId, inspectionId, originalBlob: blob, order: existing.length, title: title || '' });
  },

  // --- Appendices scoped to a specific Appendices-type report section ---
  async listSectionAppendices(reportSectionId) {
    const section = await this.get('reportSections', reportSectionId);
    return ((section && section.appendices) || []).slice().sort((a, b) => a.order - b.order);
  },
  async addSectionAppendix(reportSectionId, name) {
    const section = await this.get('reportSections', reportSectionId);
    const appendices = [...((section && section.appendices) || [])];
    const appendix = { id: uid(), name: name || 'Untitled appendix', order: appendices.length };
    appendices.push(appendix);
    await this.updateReportSection(reportSectionId, { appendices });
    return appendix;
  },
  async updateSectionAppendix(reportSectionId, appendixId, patch) {
    const section = await this.get('reportSections', reportSectionId);
    const appendices = ((section && section.appendices) || []).map((a) => (a.id === appendixId ? { ...a, ...patch } : a));
    await this.updateReportSection(reportSectionId, { appendices });
  },
  async deleteSectionAppendixCascade(reportSectionId, appendixId) {
    const section = await this.get('reportSections', reportSectionId);
    const appendices = ((section && section.appendices) || []).filter((a) => a.id !== appendixId);
    await this.updateReportSection(reportSectionId, { appendices });
    const items = await this.listAppendixItems(appendixId);
    for (const item of items) await this.delete('photos', item.id);
  },

  // --- Report templates: reusable starter shells (type + title, no content) for New Style ---
  async listReportTemplates() {
    const all = await this.getAll('reportTemplates');
    return all.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  },
  async saveReportTemplate(name, sectionShells) {
    const template = { id: uid(), name, sections: sectionShells, createdAt: new Date().toISOString() };
    await this.put('reportTemplates', template);
    return template;
  },
  async deleteReportTemplate(id) {
    await this.delete('reportTemplates', id);
  },
  async applyReportTemplate(inspectionId, templateId) {
    const template = await this.get('reportTemplates', templateId);
    if (!template) return;
    for (const shell of template.sections) {
      await this.addReportSection(inspectionId, shell.type, shell.title);
    }
  },
  async seedDefaultReportTemplate() {
    // Always kept in sync with the current default sequence, unlike user-saved templates —
    // this is a system-owned definition, not something a user customized, so silently
    // overwriting it when the default sequence changes (rather than only seeding once) is
    // the correct behavior here.
    await this.put('reportTemplates', {
      id: 'default-template',
      name: 'Standard Report',
      sections: [
        { type: 'inspectionDetails', title: 'Basic Inspection Data' },
        { type: 'text', title: 'Introduction' },
        { type: 'locationMap', title: 'Location Map' },
        { type: 'inspection', title: 'Inspection Findings' },
        { type: 'text', title: 'Conclusion' },
        { type: 'recommendations', title: 'Recommendations' }
      ],
      createdAt: new Date().toISOString()
    });
  },

  // --- Standalone Scale/Annotate sessions (not tied to any inspection) ---
  async listStandaloneAnnotations() {
    const all = await this.getAll('photos');
    return all.filter((p) => p.kind === 'standalone').sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  },
  async addStandaloneAnnotation(blob, title, sourceType) {
    const photo = {
      id: uid(),
      kind: 'standalone',
      findingId: null,
      elementId: null,
      inspectionId: null,
      riskAssessmentId: null,
      role: null,
      originalBlob: blob,
      annotatedBlob: null,
      order: 0,
      title: title || '',
      sourceType: sourceType || 'image', // 'image' | 'pdf' — determines Save-to-file options
      createdAt: new Date().toISOString()
    };
    return this.put('photos', photo);
  },

  // --- Signatures (used by Risk Assessment sign-off and per-risk rows) ---
  // role is 'inspector' | `staff:<staffId>` | `risk:<riskId>`
  async getSignature(riskAssessmentId, role) {
    const all = await this.getAllByIndex('photos', 'riskAssessmentId', riskAssessmentId);
    return all.find((p) => p.kind === 'signature' && p.role === role) || null;
  },
  async setSignature(riskAssessmentId, role, blob) {
    const existing = await this.getSignature(riskAssessmentId, role);
    if (existing) {
      existing.originalBlob = blob;
      return this.put('photos', existing);
    }
    return this.addPhoto({ kind: 'signature', riskAssessmentId, originalBlob: blob, role });
  },
  async removeSignature(riskAssessmentId, role) {
    const existing = await this.getSignature(riskAssessmentId, role);
    if (existing) await this.delete('photos', existing.id);
  },

  // --- Risk Assessments (one per inspection) ---
  async getRiskAssessment(inspectionId) {
    const all = await this.getAllByIndex('riskAssessments', 'inspectionId', inspectionId);
    return all[0] || null;
  },
  async getOrCreateRiskAssessment(inspectionId) {
    const existing = await this.getRiskAssessment(inspectionId);
    if (existing) return existing;
    const insp = await this.get('inspections', inspectionId);
    const ra = {
      id: uid(),
      inspectionId,
      companyName: (insp && insp.companyName) || '',
      companyAddress: (insp && insp.companyAddress) || '',
      assessmentTitle: '',
      assessmentReference: (insp && insp.reference) || '',
      assessorName: (insp && insp.inspector) || '',
      assessmentDate: (insp && insp.date) || '',
      locationSiteAddress: (insp && insp.location && insp.location.manual) || '',
      taskDescription: '',
      risks: [],
      responsiblePersons: '',
      residualRiskAcceptable: null,
      inspectorName: (insp && insp.inspector) || '',
      inspectorDate: '',
      inspectorTime: '',
      additionalStaff: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    return this.put('riskAssessments', ra);
  },
  async updateRiskAssessment(id, patch) {
    const existing = await this.get('riskAssessments', id);
    if (!existing) throw new Error('Risk assessment not found');
    const updated = { ...existing, ...patch, updatedAt: new Date().toISOString() };
    return this.put('riskAssessments', updated);
  },
  async deleteRiskAssessmentCascade(id) {
    const photos = await this.getAllByIndex('photos', 'riskAssessmentId', id);
    for (const p of photos) await this.delete('photos', p.id);
    await this.delete('riskAssessments', id);
  },
  // Distinct hazard type strings used across all risk assessments on this device, for
  // autocomplete suggestions (most-recently-seen order isn't tracked — alphabetical).
  async listHazardTypeSuggestions() {
    const all = await this.getAll('riskAssessments');
    const seen = new Set();
    for (const ra of all) {
      for (const h of (ra.hazards || [])) {
        if (h.hazardType && h.hazardType.trim()) seen.add(h.hazardType.trim());
      }
    }
    return Array.from(seen).sort((a, b) => a.localeCompare(b));
  },

  // --- Templates ---
  async saveTemplate(name, elementNames) {
    const tpl = {
      id: uid(),
      name,
      elements: elementNames.map((n, i) => ({ name: n, category: '', order: i })),
      createdAt: new Date().toISOString()
    };
    return this.put('templates', tpl);
  },
  async listTemplates() {
    const all = await this.getAll('templates');
    return all.sort((a, b) => a.name.localeCompare(b.name));
  },
  async deleteTemplate(id) {
    return this.delete('templates', id);
  },
  async applyTemplate(inspectionId, templateId, sectionId = null) {
    const tpl = await this.get('templates', templateId);
    if (!tpl) throw new Error('Template not found');
    const existing = await this.listElements(inspectionId);
    let order = existing.length;
    const created = [];
    for (const e of tpl.elements) {
      created.push(await this.createElement(inspectionId, { name: e.name, category: e.category, sectionId, order: order++ }));
    }
    return created;
  },

  // --- Project Management: Projects ---
  async createPMProject(data) {
    const now = new Date().toISOString();
    const project = {
      id: uid(),
      name: data.name || 'Untitled Project',
      structureRef: data.structureRef || '',
      client: data.client || '',
      startDate: data.startDate || now.slice(0, 10),
      notes: data.notes || '',
      // Working-day calendar for this project — Mon-Fri, no holidays, by default. This is the
      // PRODUCT-level default (a plain data literal, not logic, so duplicating it here rather
      // than importing pmcalendar.js's PMCalendar.DEFAULT is low-risk — see pmcalendar.js's own
      // note on why the engine's default and the product default are deliberately different
      // things). Projects created before this field existed simply won't have it; pm.js treats
      // a missing calendar as this same default at read time rather than requiring a migration.
      calendar: data.calendar || { workingWeekdays: [1, 2, 3, 4, 5], holidays: [], hoursPerDay: 7.4 },
      createdAt: now,
      updatedAt: now
    };
    return this.put('pmProjects', project);
  },
  async listPMProjects() {
    const all = await this.getAll('pmProjects');
    return all.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  },
  async updatePMProject(id, patch) {
    const existing = await this.get('pmProjects', id);
    if (!existing) throw new Error('Project not found');
    const updated = { ...existing, ...patch, updatedAt: new Date().toISOString() };
    return this.put('pmProjects', updated);
  },
  async deletePMProjectCascade(id) {
    const tasks = await this.getAllByIndex('pmTasks', 'projectId', id);
    for (const t of tasks) await this.delete('pmTasks', t.id);
    const deps = await this.getAllByIndex('pmDependencies', 'projectId', id);
    for (const d of deps) await this.delete('pmDependencies', d.id);
    const assignments = await this.getAllByIndex('pmAssignments', 'projectId', id);
    for (const a of assignments) await this.delete('pmAssignments', a.id);
    await this.delete('pmProjects', id);
  },

  // --- Project Management: Tasks (WBS hierarchy) ---
  // parentId is null for a top-level task. `order` positions siblings under the same parent;
  // WBS numbers (1, 1.1, 1.2 ...) are derived at render time from hierarchy + order, not stored.
  async createPMTask(projectId, data) {
    const now = new Date().toISOString();
    const siblings = await this.listPMTasksByParent(projectId, data.parentId || null);
    const task = {
      id: uid(),
      projectId,
      parentId: data.parentId || null,
      order: siblings.length,
      name: data.name || 'New Task',
      duration: data.duration != null ? data.duration : 1, // whole days
      start: data.start || null,
      finish: data.finish || null,
      percentComplete: data.percentComplete || 0,
      isMilestone: !!data.isMilestone,
      hoursPerDayOverride: data.hoursPerDayOverride != null ? data.hoursPerDayOverride : null, // null = use project default (see pmcalendar.js hoursPerDay)
      notes: data.notes || '',
      createdAt: now,
      updatedAt: now
    };
    return this.put('pmTasks', task);
  },
  async listPMTasks(projectId) {
    const all = await this.getAllByIndex('pmTasks', 'projectId', projectId);
    return all.sort((a, b) => a.order - b.order);
  },
  async listPMTasksByParent(projectId, parentId) {
    const all = await this.listPMTasks(projectId);
    return all.filter((t) => (t.parentId || null) === (parentId || null));
  },
  async getPMTaskChildren(taskId) {
    const all = await this.getAll('pmTasks');
    return all.filter((t) => t.parentId === taskId).sort((a, b) => a.order - b.order);
  },
  async updatePMTask(id, patch) {
    const existing = await this.get('pmTasks', id);
    if (!existing) throw new Error('Task not found');
    const updated = { ...existing, ...patch, updatedAt: new Date().toISOString() };
    return this.put('pmTasks', updated);
  },
  async deletePMTaskCascade(id) {
    const children = await this.getPMTaskChildren(id);
    for (const c of children) await this.deletePMTaskCascade(c.id);
    const deps = await this.getAll('pmDependencies');
    for (const d of deps) {
      if (d.predecessorId === id || d.successorId === id) await this.delete('pmDependencies', d.id);
    }
    const assignments = await this.getAllByIndex('pmAssignments', 'taskId', id);
    for (const a of assignments) await this.delete('pmAssignments', a.id);
    await this.delete('pmTasks', id);
  },
  async movePMTask(id, newParentId, newOrder) {
    const task = await this.get('pmTasks', id);
    if (!task) throw new Error('Task not found');
    // Prevent a task becoming its own descendant's child.
    let check = newParentId;
    while (check) {
      if (check === id) throw new Error('Cannot move a task inside its own subtask');
      const parentTask = await this.get('pmTasks', check);
      check = parentTask ? parentTask.parentId : null;
    }
    return this.updatePMTask(id, { parentId: newParentId, order: newOrder });
  },

  // --- Project Management: Dependencies (FS/SS/FF/SF, stored now; only FS is actually used
  // by the scheduling engine so far — see pmschedule.js and roadmap.md 4.1) ---
  async createPMDependency(projectId, predecessorId, successorId, type, lagDays) {
    if (predecessorId === successorId) throw new Error('A task cannot depend on itself');
    // Cycle guard — mirrors movePMTask's existing ancestor-walk pattern below, applied to the
    // dependency graph instead of the WBS parent chain. A CPM engine cannot run on a graph
    // with cycles (it would either infinite-loop or produce meaningless dates), so this is
    // enforced here at the data layer, not left to the UI to get right.
    const existing = await this.getAllByIndex('pmDependencies', 'projectId', projectId);
    const adjacency = {};
    for (const d of existing) {
      (adjacency[d.predecessorId] = adjacency[d.predecessorId] || []).push(d.successorId);
    }
    const visited = new Set();
    const stack = [successorId];
    while (stack.length) {
      const node = stack.pop();
      if (node === predecessorId) throw new Error('That link would create a circular dependency');
      if (visited.has(node)) continue;
      visited.add(node);
      for (const next of (adjacency[node] || [])) stack.push(next);
    }
    const dep = {
      id: uid(),
      projectId,
      predecessorId,
      successorId,
      type: type || 'FS',
      lagDays: lagDays || 0,
      createdAt: new Date().toISOString()
    };
    return this.put('pmDependencies', dep);
  },
  async listPMDependencies(projectId) {
    return this.getAllByIndex('pmDependencies', 'projectId', projectId);
  },
  async listPMDependenciesForTask(taskId) {
    const all = await this.getAll('pmDependencies');
    return all.filter((d) => d.predecessorId === taskId || d.successorId === taskId);
  },
  async deletePMDependency(id) {
    return this.delete('pmDependencies', id);
  },

  // --- Project Management: Resources (global — see deletePMResourceCascade note on why) ---
  async createPMResource(data) {
    const now = new Date().toISOString();
    const resource = {
      id: uid(),
      name: data.name || 'Unnamed Resource',
      role: data.role || '',
      type: data.type || 'person', // 'person' | 'team' | 'plant' | 'equipment' | 'contractor' | 'material'
      costRate: data.costRate != null ? data.costRate : null,
      contactInfo: data.contactInfo || '',
      notes: data.notes || '',
      createdAt: now,
      updatedAt: now
    };
    return this.put('pmResources', resource);
  },
  async listPMResources() {
    const all = await this.getAll('pmResources');
    return all.sort((a, b) => a.name.localeCompare(b.name));
  },
  async updatePMResource(id, patch) {
    const existing = await this.get('pmResources', id);
    if (!existing) throw new Error('Resource not found');
    const updated = { ...existing, ...patch, updatedAt: new Date().toISOString() };
    return this.put('pmResources', updated);
  },
  // Resources are global, so deleting one must clean up every assignment referencing it across
  // every project — not just the current one, since the same resource can be assigned to tasks
  // in multiple projects.
  async deletePMResourceCascade(id) {
    const assignments = await this.getAllByIndex('pmAssignments', 'resourceId', id);
    for (const a of assignments) await this.delete('pmAssignments', a.id);
    await this.delete('pmResources', id);
  },

  // --- Project Management: Assignments (resource <-> task, project-scoped) ---
  async createPMAssignment(projectId, taskId, resourceId, effortHours, entryMode) {
    const assignment = {
      id: uid(),
      projectId,
      taskId,
      resourceId,
      effortHours: Math.max(0, effortHours || 0),
      entryMode: entryMode || 'hours', // 'pct' | 'days' | 'hours' — last-used entry mode, display convenience only
      createdAt: new Date().toISOString()
    };
    return this.put('pmAssignments', assignment);
  },
  async listPMAssignmentsForTask(taskId) {
    return this.getAllByIndex('pmAssignments', 'taskId', taskId);
  },
  async listPMAssignmentsForProject(projectId) {
    return this.getAllByIndex('pmAssignments', 'projectId', projectId);
  },
  async updatePMAssignment(id, patch) {
    const existing = await this.get('pmAssignments', id);
    if (!existing) throw new Error('Assignment not found');
    const updated = { ...existing, ...patch };
    return this.put('pmAssignments', updated);
  },
  async deletePMAssignment(id) {
    return this.delete('pmAssignments', id);
  },

  // --- Aggregate helpers ---
  async getElementConditionSummary(elementId) {
    const findings = await this.listFindings(elementId);
    let worstSeverity = 0;
    let worstExtent = '';
    const extentOrder = ['A', 'B', 'C', 'D', 'E'];
    for (const f of findings) {
      if (f.severity && f.severity > worstSeverity) worstSeverity = f.severity;
      if (f.extent && (!worstExtent || extentOrder.indexOf(f.extent) > extentOrder.indexOf(worstExtent))) {
        worstExtent = f.extent;
      }
    }
    return { findingCount: findings.length, worstSeverity, worstExtent };
  },
  async getInspectionSummary(inspectionId) {
    const elements = await this.listElements(inspectionId);
    const summary = [];
    for (const elmt of elements) {
      const s = await this.getElementConditionSummary(elmt.id);
      summary.push({ element: elmt, ...s });
    }
    return summary;
  }
};

window.DB = DB;
