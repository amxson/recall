const DB_NAME = "recall_local_index";
const DB_VERSION = 1;
const STORE_NAME = "snapshots";
const PRIMARY_KEY = "primary";

export interface SnapshotMeta {
  updatedAtMs: number;
  byteLength: number;
  documentCount: number;
  chunkCount: number;
}

export interface StoredSnapshot {
  key: string;
  json: string;
  meta: SnapshotMeta;
}

export interface StorageEstimate {
  usedBytes: number;
  quotaBytes: number;
}

function openDb(factory: IDBFactory = globalThis.indexedDB): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = factory.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("failed to open IndexedDB"));
  });
}

export async function saveSnapshot(
  json: string,
  stats: { documentCount: number; chunkCount: number },
  factory?: IDBFactory
): Promise<SnapshotMeta> {
  const db = await openDb(factory);
  const meta: SnapshotMeta = {
    updatedAtMs: Date.now(),
    byteLength: new TextEncoder().encode(json).byteLength,
    documentCount: stats.documentCount,
    chunkCount: stats.chunkCount,
  };

  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put({
        key: PRIMARY_KEY,
        json,
        meta,
      } satisfies StoredSnapshot);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("IndexedDB write failed"));
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    });
  } finally {
    db.close();
  }

  return meta;
}

export async function loadSnapshot(factory?: IDBFactory): Promise<StoredSnapshot | null> {
  const db = await openDb(factory);
  try {
    return await new Promise<StoredSnapshot | null>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const req = tx.objectStore(STORE_NAME).get(PRIMARY_KEY);
      req.onsuccess = () => {
        const result = req.result as StoredSnapshot | undefined;
        resolve(result ?? null);
      };
      req.onerror = () => reject(req.error ?? new Error("IndexedDB read failed"));
    });
  } finally {
    db.close();
  }
}

export async function clearSnapshot(factory?: IDBFactory): Promise<void> {
  const db = await openDb(factory);
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).delete(PRIMARY_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("IndexedDB delete failed"));
    });
  } finally {
    db.close();
  }
}

export async function estimateStorage(): Promise<StorageEstimate | null> {
  if (!globalThis.navigator?.storage?.estimate) {
    return null;
  }
  const est = await navigator.storage.estimate();
  return {
    usedBytes: est.usage ?? 0,
    quotaBytes: est.quota ?? 0,
  };
}
