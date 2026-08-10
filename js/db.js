// db.js - IndexedDB wrapper for the Site Inspection app
// Stores: inspections, sections, elements, findings, photos, templates

const DB_NAME = 'siteInspectionDB';
const DB_VERSION = 2;

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
      introduction: data.introduction || '',
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
    const inspPhotos = await this.getAllByIndex('photos', 'inspectionId', id);
    for (const p of inspPhotos) await this.delete('photos', p.id);
    await this.delete('inspections', id);
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
      name: data.name || 'Untitled element',
      category: data.category || '',
      materialType: data.materialType || '',
      location: data.location || '',
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
  // photo: { id, kind: 'cover'|'logo'|'element'|'finding', findingId, elementId, inspectionId, originalBlob, annotatedBlob, order, createdAt }
  async addPhoto({ kind = 'finding', findingId = null, elementId = null, inspectionId = null, originalBlob, order = 0 }) {
    const photo = {
      id: uid(),
      kind,
      findingId,
      elementId,
      inspectionId,
      originalBlob,
      annotatedBlob: null,
      order,
      createdAt: new Date().toISOString()
    };
    return this.put('photos', photo);
  },
  async setAnnotatedBlob(photoId, blob) {
    const existing = await this.get('photos', photoId);
    if (!existing) throw new Error('Photo not found');
    existing.annotatedBlob = blob;
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
