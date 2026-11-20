// Lokale Sicherung im Browser (IndexedDB): jede Spur wird in 1-Sekunden-Häppchen
// gespeichert, bevor sie zum Server geht. Übersteht Abstürze, Neuladen und Netzausfälle.
const DB_NAME = 'podcast-studio';
let dbp = null;

function db() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('tracks')) d.createObjectStore('tracks', { keyPath: 'trackId' });
        if (!d.objectStoreNames.contains('chunks')) d.createObjectStore('chunks', { keyPath: ['trackId', 'seq'] });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbp;
}

function tx(store, mode, fn) {
  return db().then(d => new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    const r = fn(s);
    if (r && 'onsuccess' in r) r.onsuccess = () => { out = r.result; };
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

export const putTrack = t => tx('tracks', 'readwrite', s => s.put(t));
export const getTrack = id => tx('tracks', 'readonly', s => s.get(id));
export const allTracks = () => tx('tracks', 'readonly', s => s.getAll());
export const putChunk = (trackId, seq, data) => tx('chunks', 'readwrite', s => s.put({ trackId, seq, data }));
export const getChunk = (trackId, seq) => tx('chunks', 'readonly', s => s.get([trackId, seq]));

export async function updateTrack(id, patch) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction('tracks', 'readwrite');
    const s = t.objectStore('tracks');
    const r = s.get(id);
    let val;
    r.onsuccess = () => { if (r.result) { val = { ...r.result, ...patch }; s.put(val); } };
    t.oncomplete = () => resolve(val);
    t.onerror = () => reject(t.error);
  });
}

export async function trackBlob(trackId) {
  const parts = await tx('chunks', 'readonly', s => s.getAll(IDBKeyRange.bound([trackId, 0], [trackId, Infinity])));
  parts.sort((a, b) => a.seq - b.seq);
  return new Blob(parts.map(p => p.data), { type: 'audio/mpeg' });
}

export async function deleteTrack(trackId) {
  await tx('chunks', 'readwrite', s => s.delete(IDBKeyRange.bound([trackId, 0], [trackId, Infinity])));
  await tx('tracks', 'readwrite', s => s.delete(trackId));
}

let persistAsked = false;
export async function storageInfo() {
  try {
    if (navigator.storage?.persist && !persistAsked) { persistAsked = true; await navigator.storage.persist(); }
    return await navigator.storage.estimate();
  } catch { return null; }
}
