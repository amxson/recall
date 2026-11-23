import { describe, expect, it } from "vitest";

import { clearSnapshot, loadSnapshot, saveSnapshot } from "./idb";

function createFakeIndexedDb(): IDBFactory {
  const stores = new Map<string, Map<string, unknown>>();

  return {
    open(_name: string) {
      const req = {
        result: null as unknown as IDBDatabase,
        error: null,
        onupgradeneeded: null as null | (() => void),
        onsuccess: null as null | (() => void),
        onerror: null as null | (() => void),
      };

      const db = {
        objectStoreNames: {
          contains: (storeName: string) => stores.has(storeName),
        },
        createObjectStore: (storeName: string) => {
          stores.set(storeName, new Map());
          return {} as IDBObjectStore;
        },
        transaction: (storeName: string) => {
          const map = stores.get(storeName) ?? new Map<string, unknown>();
          stores.set(storeName, map);
          const tx = {
            oncomplete: null as null | (() => void),
            onerror: null as null | (() => void),
            onabort: null as null | (() => void),
            error: null,
            objectStore: () => ({
              put: (value: { key: string }) => {
                map.set(value.key, value);
                queueMicrotask(() => tx.oncomplete?.());
                return {} as IDBRequest;
              },
              get: (key: string) => {
                const getReq = {
                  result: map.get(key),
                  error: null,
                  onsuccess: null as null | (() => void),
                  onerror: null as null | (() => void),
                };
                queueMicrotask(() => getReq.onsuccess?.());
                return getReq as unknown as IDBRequest;
              },
              delete: (key: string) => {
                map.delete(key);
                queueMicrotask(() => tx.oncomplete?.());
                return {} as IDBRequest;
              },
            }),
          };
          return tx as unknown as IDBTransaction;
        },
        close: () => {},
      } as unknown as IDBDatabase;

      req.result = db;
      queueMicrotask(() => {
        req.onupgradeneeded?.();
        req.onsuccess?.();
      });

      return req as unknown as IDBOpenDBRequest;
    },
  } as unknown as IDBFactory;
}

describe("IndexedDB snapshot persistence", () => {
  it("saves, loads, and clears serialized index snapshots", async () => {
    const fakeIdb = createFakeIndexedDb();

    expect(await loadSnapshot(fakeIdb)).toBeNull();

    const meta = await saveSnapshot(
      '{"chunks":{}}',
      { documentCount: 2, chunkCount: 9 },
      fakeIdb
    );
    expect(meta.documentCount).toBe(2);
    expect(meta.chunkCount).toBe(9);
    expect(meta.byteLength).toBeGreaterThan(0);

    const loaded = await loadSnapshot(fakeIdb);
    expect(loaded?.json).toBe('{"chunks":{}}');
    expect(loaded?.meta.chunkCount).toBe(9);

    await clearSnapshot(fakeIdb);
    expect(await loadSnapshot(fakeIdb)).toBeNull();
  });
});
