const DEFAULT_DB_NAME = "apps.nostr.cache";
const DEFAULT_EVENT_STORE = "events";
const DEFAULT_META_STORE = "meta";

const memoryDatabases = new Map();

export function createEventCache(options = {}) {
  const dbName = options.dbName || DEFAULT_DB_NAME;
  const eventStoreName = options.eventStoreName || DEFAULT_EVENT_STORE;
  const metaStoreName = options.metaStoreName || DEFAULT_META_STORE;
  const hasIndexedDb = typeof indexedDB !== "undefined";

  let dbPromise = null;
  const memoryDb = ensureMemoryDb(dbName);

  async function getDb() {
    if (!hasIndexedDb) return memoryDb;
    if (!dbPromise) {
      dbPromise = openIndexedDb(dbName, eventStoreName, metaStoreName);
    }
    return dbPromise;
  }

  return {
    async loadEvents(filter = {}) {
      const db = await getDb();
      const events = await db.loadEvents();
      return filterEvents(events, filter);
    },
    async upsertEvents(events) {
      const db = await getDb();
      return db.upsertEvents(events);
    },
    async loadMeta(key, fallback = null) {
      const db = await getDb();
      return db.loadMeta(key, fallback);
    },
    async saveMeta(key, value) {
      const db = await getDb();
      return db.saveMeta(key, value);
    },
    async clear() {
      const db = await getDb();
      return db.clear();
    },
  };
}

function filterEvents(events, filter) {
  let output = [...events];
  if (Array.isArray(filter.kinds) && filter.kinds.length) {
    const kinds = new Set(filter.kinds.map((kind) => Number(kind)));
    output = output.filter((event) => kinds.has(Number(event.kind)));
  }
  if (Array.isArray(filter.authors) && filter.authors.length) {
    const authors = new Set(filter.authors.map(String));
    output = output.filter((event) => authors.has(String(event.pubkey)));
  }
  if (Number.isFinite(filter.since)) {
    output = output.filter((event) => Number(event.created_at || 0) >= Number(filter.since));
  }
  if (Number.isFinite(filter.until)) {
    output = output.filter((event) => Number(event.created_at || 0) <= Number(filter.until));
  }
  return output;
}

function ensureMemoryDb(dbName) {
  if (!memoryDatabases.has(dbName)) {
    memoryDatabases.set(dbName, {
      events: new Map(),
      meta: new Map(),
    });
  }
  const db = memoryDatabases.get(dbName);
  return {
    async loadEvents() {
      return [...db.events.values()].map(cloneValue);
    },
    async upsertEvents(events) {
      for (const event of events || []) {
        if (!event?.id) continue;
        db.events.set(event.id, cloneValue(event));
      }
    },
    async loadMeta(key, fallback = null) {
      return db.meta.has(key) ? cloneValue(db.meta.get(key)) : fallback;
    },
    async saveMeta(key, value) {
      db.meta.set(key, cloneValue(value));
    },
    async clear() {
      db.events.clear();
      db.meta.clear();
    },
  };
}

function openIndexedDb(dbName, eventStoreName, metaStoreName) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, 1);

    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(eventStoreName)) {
        db.createObjectStore(eventStoreName, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(metaStoreName)) {
        db.createObjectStore(metaStoreName, { keyPath: "key" });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      resolve({
        async loadEvents() {
          return await readAll(db, eventStoreName);
        },
        async upsertEvents(events) {
          const tx = db.transaction(eventStoreName, "readwrite");
          const store = tx.objectStore(eventStoreName);
          for (const event of events || []) {
            if (!event?.id) continue;
            store.put(event);
          }
          await transactionComplete(tx);
        },
        async loadMeta(key, fallback = null) {
          const tx = db.transaction(metaStoreName, "readonly");
          const store = tx.objectStore(metaStoreName);
          const value = await requestValue(store.get(key));
          return value?.value ?? fallback;
        },
        async saveMeta(key, value) {
          const tx = db.transaction(metaStoreName, "readwrite");
          const store = tx.objectStore(metaStoreName);
          store.put({ key, value });
          await transactionComplete(tx);
        },
        async clear() {
          const tx = db.transaction([eventStoreName, metaStoreName], "readwrite");
          tx.objectStore(eventStoreName).clear();
          tx.objectStore(metaStoreName).clear();
          await transactionComplete(tx);
        },
      });
    };
  });
}

function readAll(db, storeName) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const store = tx.objectStore(storeName);
    const request = store.getAll();
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result || []);
  });
}

function requestValue(request) {
  return new Promise((resolve, reject) => {
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

function transactionComplete(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function cloneValue(value) {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
}
