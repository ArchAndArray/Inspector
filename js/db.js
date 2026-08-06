// db.js - IndexedDB wrapper for the Site Inspection app
// Stores: inspections, elements, findings, photos, templates

const DB_NAME = 'siteInspectionDB';
const DB_VERSION = 1;

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (event) => {
      const db = event.target.result;

      if (!db.objectStoreNames.contains('inspections')) {
        db.createObjectStore('inspections', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('elements')) {
        const store = db.createObjectStore('elements', { keyPath: 'id' });
        store.createIndex('inspectionId', 'inspectionId', { unique: false });
      }
      if (!db.objectStoreNames.contains('findings')) {
        const store = db.createObjectStore('findings', { keyPath: 'id' });
        store.createIndex('elementId', 'elementId', { unique: false });
      }
      if (!db.objectStoreNames.contains('photos')) {
        const store = db.createObjectStore('photos', { keyPath: 'id' });
        store.createIndex('findingId', 'findingId', { unique: false });
        store.createIndex('inspectionId', 'inspectionId', { unique: false });
      }
      if (!db.objectStoreNames.contains('templates')) {
        db.createObjectStore('templates', { keyPath: 'id' });
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

function tx(storeName, mode) {
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
    const store = await tx(storeName, 'readwrite');
    await reqToPromise(store.put(obj));
    return obj;
  },
  async get(storeName, id) {
    const store = await tx(storeName, 'readonly');
    return reqToPromise(store.get(id));
  },
  async getAll(storeName) {
    const store = await tx(storeName, 'readonly');
    return reqToPromise(store.getAll());
  },
  async delete(storeName, id) {
    const store = await tx(storeName, 'readwrite');
    return reqToPromise(store.delete(id));
  },
  async getAllByIndex(storeName, indexName, value) {
    const store = await tx(storeName, 'readonly');
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
      subtitle: data.subtitle || '',
      location: data.location || { lat: null, lng: null, manual: '' },
      weather: data.weather || '',
      inspectionType: data.inspectionType || '',
      inspector: data.inspector || '',
      date: data.date || now,
      notes: data.notes || '',
      coverPhotoId: null,
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
    const elements = await this.getAllByIndex('elements', 'inspectionId', id);
    for (const el of elements) {
      await this.deleteElementCascade(el.id);
    }
    const coverPhotos = await this.getAllByIndex('photos', 'inspectionId', id);
    for (const p of coverPhotos) await this.delete('photos', p.id);
    await this.delete('inspections', id);
  },
  async listInspections() {
    const all = await this.getAll('inspections');
    return all.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  },

  // --- Elements ---
  async createElement(inspectionId, data) {
    const el = {
      id: uid(),
      inspectionId,
      name: data.name || 'Untitled element',
      category: data.category || '',
      order: data.order || 0,
      createdAt: new Date().toISOString()
    };
    return this.put('elements', el);
  },
  async listElements(inspectionId) {
    const all = await this.getAllByIndex('elements', 'inspectionId', inspectionId);
    return all.sort((a, b) => a.order - b.order);
  },
  async deleteElementCascade(elementId) {
    const findings = await this.getAllByIndex('findings', 'elementId', elementId);
    for (const f of findings) {
      await this.deleteFindingCascade(f.id);
    }
    await this.delete('elements', elementId);
  },

  // --- Findings ---
  async createFinding(elementId, data) {
    const finding = {
      id: uid(),
      elementId,
      severity: data.severity || null,
      extent: data.extent || null,
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
  // photo: { id, findingId (or null), inspectionId (set for cover photo), originalBlob, annotatedBlob, order, createdAt }
  async addPhoto({ findingId = null, inspectionId = null, originalBlob, order = 0 }) {
    const photo = {
      id: uid(),
      findingId,
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
    return all.sort((a, b) => a.order - b.order);
  },
  async getCoverPhoto(inspectionId) {
    const all = await this.getAllByIndex('photos', 'inspectionId', inspectionId);
    return all[0] || null;
  },
  async setCoverPhoto(inspectionId, blob) {
    const existing = await this.getCoverPhoto(inspectionId);
    if (existing) {
      existing.originalBlob = blob;
      existing.annotatedBlob = null;
      return this.put('photos', existing);
    }
    return this.addPhoto({ inspectionId, originalBlob: blob });
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
  async applyTemplate(inspectionId, templateId) {
    const tpl = await this.get('templates', templateId);
    if (!tpl) throw new Error('Template not found');
    const existing = await this.listElements(inspectionId);
    let order = existing.length;
    const created = [];
    for (const e of tpl.elements) {
      created.push(await this.createElement(inspectionId, { name: e.name, category: e.category, order: order++ }));
    }
    return created;
  },

  // --- Aggregate helpers ---
  async getInspectionSummary(inspectionId) {
    const elements = await this.listElements(inspectionId);
    const summary = [];
    for (const el of elements) {
      const findings = await this.listFindings(el.id);
      let worstSeverity = 0;
      let worstExtent = '';
      const extentOrder = ['A', 'B', 'C', 'D', 'E'];
      for (const f of findings) {
        if (f.severity && f.severity > worstSeverity) worstSeverity = f.severity;
        if (f.extent && extentOrder.indexOf(f.extent) > extentOrder.indexOf(worstExtent || 'A') ) {
          if (!worstExtent || extentOrder.indexOf(f.extent) > extentOrder.indexOf(worstExtent)) {
            worstExtent = f.extent;
          }
        }
      }
      summary.push({ element: el, findingCount: findings.length, worstSeverity, worstExtent });
    }
    return summary;
  }
};

window.DB = DB;
