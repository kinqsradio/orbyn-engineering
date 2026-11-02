/** Optional, bounded image previews. This store never holds service URLs or tokens. */
export interface StoredProjectImage {
  key: string;
  project_id: string;
  revision: string;
  data_url: string;
  used_at: number;
}
const DB_NAME = "orbyn.project-images";
const STORE = "images";
const MAX_ENTRIES = 128;
const MAX_BYTES = 1024 * 1024;
const MAX_IMAGE = 32 * 1024;
const DATA_IMAGE = /^data:image\/(?:png|jpeg|gif|webp|avif|bmp|x-icon|svg\+xml|heic|heif|tiff);base64,[A-Za-z0-9+/]+={0,2}$/;
let database: Promise<IDBDatabase | null> | null = null;
let generation = 0;
interface Epoch { version: number; active: number }
const keys = new Map<string, Epoch>();
const projects = new Map<string, Epoch>();

export function smallProjectImage(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_IMAGE && DATA_IMAGE.test(value)
    && value.slice(value.indexOf(",") + 1).length % 4 === 0;
}
function valid(value: unknown): value is StoredProjectImage {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<StoredProjectImage>;
  return typeof item.key === "string" && item.key.length <= 65536
    && typeof item.project_id === "string" && item.project_id.length > 0 && item.project_id.length <= 256
    && typeof item.revision === "string" && /^[a-f0-9]{64}$/.test(item.revision)
    && smallProjectImage(item.data_url) && typeof item.used_at === "number" && Number.isFinite(item.used_at);
}
function epoch(map: Map<string, Epoch>, key: string) {
  let value = map.get(key);
  if (!value) { value = { version: 0, active: 0 }; map.set(key, value); }
  return value;
}
function observe(key: string, projectId: string, remove = false) {
  const item = epoch(keys, key);
  const project = epoch(projects, projectId);
  if (remove) item.version += 1;
  const itemVersion = item.version, projectVersion = project.version, current = generation;
  item.active += 1; project.active += 1;
  return {
    current: () => current === generation && itemVersion === item.version && projectVersion === project.version,
    release: () => {
      item.active -= 1; project.active -= 1;
      if (!item.active && keys.get(key) === item) keys.delete(key);
      if (!project.active && projects.get(projectId) === project) projects.delete(projectId);
    },
  };
}
function open(): Promise<IDBDatabase | null> {
  if (database) return database;
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  database = new Promise<IDBDatabase | null>((resolve) => {
    let settled = false;
    const done = (value: IDBDatabase | null) => {
      if (settled) { value?.close(); return; }
      settled = true; clearTimeout(timer); resolve(value);
    };
    const timer = setTimeout(() => done(null), 3000);
    try {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => { request.result.createObjectStore(STORE, { keyPath: "key" }); };
      request.onerror = () => done(null);
      request.onblocked = () => done(null);
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => { db.close(); database = null; };
        done(db);
      };
    } catch { done(null); }
  }).then((value) => {
    // Even synchronous failures settle after the promise is assigned, so the
    // next observation can retry optional storage rather than caching failure.
    if (!value) database = null;
    return value;
  });
  return database;
}
function finished(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = transaction.onabort = () => reject(new Error("Image cache transaction did not finish."));
  });
}

export async function readStoredProjectImage(key: string, projectId: string): Promise<StoredProjectImage | null> {
  const lease = observe(key, projectId);
  try {
    const db = await open();
    if (!db || !lease.current()) return null;
    const transaction = db.transaction(STORE, "readwrite");
    const complete = finished(transaction);
    const store = transaction.objectStore(STORE);
    let result: StoredProjectImage | null = null;
    const request = store.get(key);
    request.onsuccess = () => {
      if (!lease.current()) return;
      if (valid(request.result) && request.result.project_id === projectId && request.result.key === key) {
        result = { ...request.result, used_at: Date.now() };
        store.put(result);
      } else if (request.result !== undefined) store.delete(key);
    };
    await complete;
    return lease.current() ? result : null;
  } catch { return null; } finally { lease.release(); }
}

export async function storeProjectImage(item: StoredProjectImage): Promise<boolean> {
  if (!valid(item)) return false;
  const lease = observe(item.key, item.project_id);
  try {
    const db = await open();
    if (!db || !lease.current()) return false;
    const transaction = db.transaction(STORE, "readwrite");
    const complete = finished(transaction);
    const store = transaction.objectStore(STORE);
    const request = store.getAll();
    request.onsuccess = () => {
      if (!lease.current()) { transaction.abort(); return; }
      const old: unknown[] = request.result;
      const retained = old.filter(valid).filter((entry) => entry.key !== item.key);
      const next = { ...item, used_at: Date.now() };
      retained.push(next);
      retained.sort((a, b) => b.used_at - a.used_at
        || (a.key === item.key ? -1 : b.key === item.key ? 1 : a.key.localeCompare(b.key)));
      let bytes = 0;
      const keep = new Set<string>();
      for (const entry of retained) {
        if (keep.size >= MAX_ENTRIES || bytes + entry.data_url.length > MAX_BYTES) continue;
        keep.add(entry.key); bytes += entry.data_url.length;
      }
      // Invalid entries cannot escape the same size and type boundary on a later read.
      for (const entry of old) {
        if (entry && typeof entry === "object" && "key" in entry && typeof entry.key === "string" && !keep.has(entry.key)) store.delete(entry.key);
      }
      if (keep.has(item.key)) store.put(next);
    };
    await complete;
    return lease.current();
  } catch { return false; } finally { lease.release(); }
}

export async function deleteStoredProjectImage(key: string, projectId: string): Promise<boolean> {
  const lease = observe(key, projectId, true);
  try {
    const db = await open();
    if (!db || !lease.current()) return false;
    const transaction = db.transaction(STORE, "readwrite");
    const complete = finished(transaction);
    transaction.objectStore(STORE).delete(key);
    await complete;
    return lease.current();
  } catch { return false; } finally { lease.release(); }
}

export async function purgeStoredProjectImages(projectId: string): Promise<boolean> {
  const project = epoch(projects, projectId);
  project.version += 1; project.active += 1;
  const current = generation, version = project.version;
  try {
    const db = await open();
    if (!db || current !== generation || version !== project.version) return false;
    const transaction = db.transaction(STORE, "readwrite");
    const complete = finished(transaction);
    const store = transaction.objectStore(STORE);
    const request = store.openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      if (cursor.value?.project_id === projectId) cursor.delete();
      cursor.continue();
    };
    await complete;
    return current === generation && version === project.version;
  } catch { return false; } finally {
    project.active -= 1;
    if (!project.active && projects.get(projectId) === project) projects.delete(projectId);
  }
}

export async function clearStoredProjectImages(): Promise<boolean> {
  generation += 1;
  const current = generation;
  try {
    const db = await open();
    if (!db || current !== generation) return false;
    const transaction = db.transaction(STORE, "readwrite");
    const complete = finished(transaction);
    transaction.objectStore(STORE).clear();
    await complete;
    return current === generation;
  } catch { return false; }
}
