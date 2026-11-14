// library.js — Biblioteca en IndexedDB: metadatos y archivos por separado,
// para que listar sea rápido aunque tengas cientos de canciones.

const DB_NAME = 'pianola';
const DB_VERSION = 1;
let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('songs')) db.createObjectStore('songs', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(stores, mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    let result;
    Promise.resolve(fn(t)).then(r => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('abort'));
  }));
}

const reqP = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export function newId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

export const library = {
  async list() {
    return tx(['songs'], 'readonly', t => reqP(t.objectStore('songs').getAll()));
  },
  async add(meta, data) {
    return tx(['songs', 'files'], 'readwrite', t => {
      t.objectStore('songs').put(meta);
      t.objectStore('files').put(data, meta.id);
      return meta;
    });
  },
  async data(id) {
    return tx(['files'], 'readonly', t => reqP(t.objectStore('files').get(id)));
  },
  async update(id, patch) {
    return tx(['songs'], 'readwrite', async t => {
      const store = t.objectStore('songs');
      const cur = await reqP(store.get(id));
      if (!cur) return null;
      const next = { ...cur, ...patch };
      store.put(next);
      return next;
    });
  },
  async remove(id) {
    return tx(['songs', 'files'], 'readwrite', t => {
      t.objectStore('songs').delete(id);
      t.objectStore('files').delete(id);
    });
  },
};

export async function persistStorage() {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist();
  } catch {}
}

export async function storageEstimate() {
  try { return await navigator.storage.estimate(); } catch { return null; }
}
