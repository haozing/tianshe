export const DOUDIAN_DB_NAME = "chihu20_doudian";
export const DOUDIAN_DB_VERSION = 4;

export const DOUDIAN_OBJECT_STORES = [
  "stores",
  "groups",
  "business_latest",
  "funds_latest",
  "violations_latest",
  "stale_scan_runs",
  "stale_candidates",
  "stale_execute_runs",
  "bulk_delete_scan_runs_v1",
  "bulk_delete_candidates_v1",
  "bulk_delete_execute_runs_v1",
  "bulk_delete_operation_events_v1",
  "operations",
  "runtime_meta"
] as const;

export type DoudianObjectStoreName = typeof DOUDIAN_OBJECT_STORES[number];

let dbPromise: Promise<IDBDatabase> | null = null;

function createStore(db: IDBDatabase, name: DoudianObjectStoreName) {
  if (db.objectStoreNames.contains(name)) return;
  const store = db.createObjectStore(name, { keyPath: "id" });
  if (name === "operations") {
    store.createIndex("operationId", "operationId", { unique: false });
    store.createIndex("status", "status", { unique: false });
    store.createIndex("updatedAt", "updatedAt", { unique: false });
  }
}

export function openDoudianRepository(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DOUDIAN_DB_NAME, DOUDIAN_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const storeName of DOUDIAN_OBJECT_STORES) createStore(db, storeName);
    };
    request.onerror = () => reject(request.error || new Error("failed to open doudian repository"));
    request.onsuccess = () => resolve(request.result);
  });
  return dbPromise;
}

export async function repositoryPut<T extends { id: string }>(storeName: DoudianObjectStoreName, record: T): Promise<T> {
  const db = await openDoudianRepository();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    const store = tx.objectStore(storeName);
    store.put(record);
    tx.oncomplete = () => resolve(record);
    tx.onerror = () => reject(tx.error || new Error(`failed to write ${storeName}`));
    tx.onabort = () => reject(tx.error || new Error(`write ${storeName} aborted`));
  });
}

export async function repositoryGet<T>(storeName: DoudianObjectStoreName, id: string): Promise<T | null> {
  const db = await openDoudianRepository();
  return new Promise((resolve, reject) => {
    const request = db.transaction(storeName, "readonly").objectStore(storeName).get(id);
    request.onerror = () => reject(request.error || new Error(`failed to read ${storeName}`));
    request.onsuccess = () => resolve(request.result || null);
  });
}

export async function repositoryGetAll<T>(storeName: DoudianObjectStoreName): Promise<T[]> {
  const db = await openDoudianRepository();
  return new Promise((resolve, reject) => {
    const request = db.transaction(storeName, "readonly").objectStore(storeName).getAll();
    request.onerror = () => reject(request.error || new Error(`failed to list ${storeName}`));
    request.onsuccess = () => resolve(request.result || []);
  });
}

export async function repositoryDelete(storeName: DoudianObjectStoreName, id: string): Promise<void> {
  const db = await openDoudianRepository();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error(`failed to delete ${storeName}`));
    tx.onabort = () => reject(tx.error || new Error(`delete ${storeName} aborted`));
  });
}

export async function runDoudianRepositorySelfCheck() {
  const id = `repo-self-check-${Date.now()}`;
  const record = {
    id,
    kind: "repository-self-check",
    createdAt: new Date().toISOString()
  };
  await repositoryPut("runtime_meta", record);
  const readBack = await repositoryGet<typeof record>("runtime_meta", id);
  await repositoryDelete("runtime_meta", id);
  return {
    ok: readBack?.id === id,
    dbName: DOUDIAN_DB_NAME,
    objectStores: [...DOUDIAN_OBJECT_STORES]
  };
}
