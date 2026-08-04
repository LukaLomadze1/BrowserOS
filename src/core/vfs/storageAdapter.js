/**
 * @file StorageAdapter — the single point of contact with IndexedDB
 * for the entire Virtual File System. No other module (not
 * VirtualFileSystem, not SearchService, not any future app) is
 * allowed to open a database connection or run a transaction
 * directly; everything goes through the methods here.
 *
 * Note on atomicity: each method below runs in its own short-lived
 * transaction. Multi-step VirtualFileSystem operations (move, copy,
 * rename-with-descendants) therefore aren't atomic as a single unit
 * — a browser crash mid-move could in principle leave a partial
 * update. Keeping one long-lived transaction alive across the
 * recursive async traversal those operations need would fight
 * IndexedDB's auto-commit-on-microtask-yield behavior, which is a
 * well-known source of much worse bugs. For a client-side, single-
 * user simulated file system this tradeoff is the right one.
 */

const DB_NAME = "browseros-vfs";
const DB_VERSION = 1;
const STORE_NAME = "entries";

class StorageAdapter {
  constructor() {
    /** @type {Promise<IDBDatabase>|null} */
    this._dbPromise = null;
  }

  /**
   * Open (or reuse) the database connection. Safe to call many
   * times — the connection is opened once and memoized.
   * @returns {Promise<IDBDatabase>}
   */
  open() {
    if (!this._dbPromise) {
      this._dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            const store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
            store.createIndex("path", "path", { unique: true });
            store.createIndex("parentId", "parentId", { unique: false });
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }
    return this._dbPromise;
  }

  /**
   * @param {IDBTransactionMode} mode
   * @returns {Promise<IDBObjectStore>}
   */
  async _store(mode = "readonly") {
    const db = await this.open();
    return db.transaction(STORE_NAME, mode).objectStore(STORE_NAME);
  }

  /**
   * @param {string} id
   * @returns {Promise<object|undefined>}
   */
  async getById(id) {
    const store = await this._store();
    return requestToPromise(store.get(id));
  }

  /**
   * @param {string} path - A normalized absolute path.
   * @returns {Promise<object|undefined>}
   */
  async getByPath(path) {
    const store = await this._store();
    return requestToPromise(store.index("path").get(path));
  }

  /**
   * Direct children of a folder — a single indexed lookup, not a
   * full-table scan.
   * @param {string} parentId
   * @returns {Promise<object[]>}
   */
  async getChildren(parentId) {
    const store = await this._store();
    const result = await requestToPromise(store.index("parentId").getAll(parentId));
    return result || [];
  }

  /**
   * Every descendant of a folder, gathered breadth-first via
   * repeated indexed getChildren() lookups — never a scan of the
   * whole store, so cost scales with subtree size, not database size.
   * @param {string} rootId
   * @param {{includeRoot?: boolean}} [options]
   * @returns {Promise<object[]>}
   */
  async getSubtree(rootId, options = {}) {
    const { includeRoot = true } = options;
    const collected = [];
    const queue = [rootId];

    while (queue.length > 0) {
      const currentId = queue.shift();
      const children = await this.getChildren(currentId);
      for (const child of children) {
        collected.push(child);
        if (child.type === "folder") queue.push(child.id);
      }
    }

    if (includeRoot) {
      const rootEntry = await this.getById(rootId);
      if (rootEntry) collected.unshift(rootEntry);
    }
    return collected;
  }

  /**
   * Insert or overwrite an entry.
   * @param {object} entry
   * @returns {Promise<object>} The same entry, for chaining.
   */
  async put(entry) {
    const store = await this._store("readwrite");
    await requestToPromise(store.put(entry));
    return entry;
  }

  /**
   * Low-level permanent removal by id. Not currently exposed by
   * VirtualFileSystem's public API — permanent deletion isn't
   * implemented yet per this step's spec — but a storage adapter's
   * CRUD surface should be complete, and a future "Empty Trash"
   * feature will need exactly this.
   * @param {string} id
   * @returns {Promise<void>}
   */
  async deleteById(id) {
    const store = await this._store("readwrite");
    await requestToPromise(store.delete(id));
  }

  /**
   * @returns {Promise<number>} Total entry count, for diagnostics.
   */
  async countAll() {
    const store = await this._store();
    return requestToPromise(store.count());
  }
}

/**
 * @param {IDBRequest} request
 * @returns {Promise<*>}
 */
function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Singleton adapter shared by VirtualFileSystem and SearchService.
 * @type {StorageAdapter}
 */
export const storageAdapter = new StorageAdapter();
