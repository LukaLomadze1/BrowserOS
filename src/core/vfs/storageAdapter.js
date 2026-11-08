/**
 * @file StorageAdapter — the single point of contact with IndexedDB
 * for the entire Virtual File System. No other module (not
 * VirtualFileSystem, not SearchService, not any app) opens a database
 * connection or runs a transaction directly; everything goes through
 * the methods here.
 *
 * Durability: every method resolves only when its transaction has
 * committed (`complete`), and rejects when the transaction aborts.
 * IndexedDB can reject a write at commit time even after each request
 * succeeded — quota exhaustion is reported that way — so resolving on
 * request success alone would report data as saved when it wasn't.
 *
 * Atomicity: operations that change several entries at once (renaming,
 * moving, deleting, copying, or restoring a folder with everything in
 * it) are written with `putMany()`, which puts and deletes every entry
 * in one transaction: either all of the changes are stored or none
 * are. Reading the entries to change happens first, in separate
 * read-only transactions; the write transaction itself never waits on
 * anything, so IndexedDB's auto-commit can't close it early.
 *
 * Errors are translated into VFSError codes: a duplicate path becomes
 * ALREADY_EXISTS, a full disk QUOTA_EXCEEDED (also announced as
 * "storage:writeFailed" so the storage monitor can warn), and anything
 * else STORAGE_ERROR.
 */

import { eventBus } from "../eventBus.js";
import { VFSError } from "./vfsError.js";

const DB_NAME = "browseros-vfs";
const DB_VERSION = 1;
const STORE_NAME = "entries";

class StorageAdapter {
  constructor() {
    /** @type {Promise<IDBDatabase>|null} */
    this._dbPromise = null;
    this._dbName = DB_NAME;
  }

  /**
   * Use a different database (the unit tests use a throwaway one, so
   * they never touch real files). Only possible before the first open.
   * @param {string} name
   * @returns {void}
   */
  useDatabase(name) {
    if (this._dbPromise) throw new Error("useDatabase() must be called before the file system is opened");
    this._dbName = name;
  }

  /** @returns {string} The database in use. */
  getDatabaseName() {
    return this._dbName;
  }

  /**
   * Open (or reuse) the database connection. Safe to call many times —
   * the connection is opened once and memoized. If the browser closes
   * the connection (site data cleared, or a newer BrowserOS needs to
   * upgrade the database), the next call opens a new one.
   * @returns {Promise<IDBDatabase>}
   * @throws {VFSError} STORAGE_UNAVAILABLE, STORAGE_BLOCKED
   */
  open() {
    if (!this._dbPromise) {
      this._dbPromise = new Promise((resolve, reject) => {
        let request;
        try {
          if (typeof indexedDB === "undefined") throw new Error("IndexedDB is not available in this browser");
          request = indexedDB.open(this._dbName, DB_VERSION);
        } catch (error) {
          reject(new VFSError("STORAGE_UNAVAILABLE", `Browser storage can't be opened: ${error.message}`));
          return;
        }

        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            const store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
            store.createIndex("path", "path", { unique: true });
            store.createIndex("parentId", "parentId", { unique: false });
          }
        };
        request.onsuccess = () => {
          const db = request.result;
          // A newer version opened elsewhere: step aside so it can upgrade.
          db.onversionchange = () => {
            db.close();
            this._dbPromise = null;
            eventBus.emit("vfs:connectionClosed", Object.freeze({ reason: "versionchange" }));
          };
          db.onclose = () => {
            this._dbPromise = null;
            eventBus.emit("vfs:connectionClosed", Object.freeze({ reason: "closed" }));
          };
          resolve(db);
        };
        request.onerror = () => {
          this._dbPromise = null;
          reject(new VFSError("STORAGE_UNAVAILABLE", `Browser storage can't be opened: ${request.error?.message ?? "unknown error"}`));
        };
        request.onblocked = () => {
          this._dbPromise = null;
          reject(new VFSError("STORAGE_BLOCKED", "Another BrowserOS tab is using an older version of the file system. Close it, then reload."));
        };
      });
    }
    return this._dbPromise;
  }

  /**
   * Run `work` in one transaction and resolve when it has committed.
   * @template T
   * @param {IDBTransactionMode} mode
   * @param {(store: IDBObjectStore) => (() => T)|void} work - Issues requests synchronously; may return a getter for the result, read after commit.
   * @returns {Promise<T>}
   */
  async _run(mode, work) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      let transaction;
      try {
        transaction = db.transaction(STORE_NAME, mode);
      } catch (error) {
        // The connection was closed underneath us; reopen on the next call.
        this._dbPromise = null;
        reject(translateError(error, mode));
        return;
      }
      let getResult = null;
      transaction.oncomplete = () => {
        try {
          resolve(getResult ? getResult() : undefined);
        } catch (error) {
          reject(translateError(error, mode));
        }
      };
      // A failed request aborts the whole transaction (its error event is
      // deliberately left unhandled), and onabort reports it once.
      transaction.onabort = () => reject(translateError(transaction.error, mode));
      try {
        getResult = work(transaction.objectStore(STORE_NAME)) ?? null;
      } catch (error) {
        try {
          transaction.abort();
        } catch {
          /* already finished */
        }
        reject(translateError(error, mode));
      }
    });
  }

  /**
   * @param {string} id
   * @returns {Promise<object|undefined>}
   */
  getById(id) {
    return this._run("readonly", (store) => {
      const request = store.get(id);
      return () => request.result;
    });
  }

  /**
   * @param {string} path - A normalized absolute path.
   * @returns {Promise<object|undefined>}
   */
  getByPath(path) {
    return this._run("readonly", (store) => {
      const request = store.index("path").get(path);
      return () => request.result;
    });
  }

  /**
   * Direct children of a folder — a single indexed lookup, not a
   * full-table scan.
   * @param {string} parentId
   * @returns {Promise<object[]>}
   */
  getChildren(parentId) {
    return this._run("readonly", (store) => {
      const request = store.index("parentId").getAll(parentId);
      return () => request.result || [];
    });
  }

  /**
   * Every descendant of a folder, gathered breadth-first via repeated
   * indexed getChildren() lookups — never a scan of the whole store,
   * so cost scales with subtree size, not database size.
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
   * Every stored entry (backups and consistency checks).
   * @returns {Promise<object[]>}
   */
  getAll() {
    return this._run("readonly", (store) => {
      const request = store.getAll();
      return () => request.result || [];
    });
  }

  /**
   * Insert or overwrite one entry.
   * @param {object} entry
   * @returns {Promise<object>} The same entry, for chaining.
   */
  async put(entry) {
    await this._run("readwrite", (store) => {
      store.put(entry);
    });
    return entry;
  }

  /**
   * Put and delete several entries in one transaction: all of the
   * changes are stored, or none are.
   * @param {object[]} entries - Entries to insert or overwrite.
   * @param {string[]} [deleteIds] - Entries to remove.
   * @returns {Promise<void>}
   */
  putMany(entries, deleteIds = []) {
    if (entries.length === 0 && deleteIds.length === 0) return Promise.resolve();
    return this._run("readwrite", (store) => {
      // Deletes first, so an entry can take over the path of one removed in the same change.
      for (const id of deleteIds) store.delete(id);
      for (const entry of entries) store.put(entry);
    });
  }

  /**
   * Replace the entire store with `entries` in one transaction (full
   * backup restore). If anything fails, the previous contents remain.
   * @param {object[]} entries
   * @returns {Promise<void>}
   */
  replaceAll(entries) {
    return this._run("readwrite", (store) => {
      store.clear();
      for (const entry of entries) store.put(entry);
    });
  }

  /**
   * Permanently remove entries by id, in one transaction.
   * @param {string[]} ids
   * @returns {Promise<void>}
   */
  deleteMany(ids) {
    return this.putMany([], ids);
  }

  /**
   * @returns {Promise<number>} Total entry count, for diagnostics.
   */
  countAll() {
    return this._run("readonly", (store) => {
      const request = store.count();
      return () => request.result;
    });
  }
}

/**
 * @param {*} error - A DOMException from IndexedDB (or anything thrown while issuing requests).
 * @param {IDBTransactionMode} mode
 * @returns {VFSError}
 */
function translateError(error, mode) {
  if (error instanceof VFSError) return error;
  const name = error?.name ?? "";
  const detail = error?.message || name || "unknown error";
  if (name === "ConstraintError") {
    return new VFSError("ALREADY_EXISTS", "An item with that name already exists in this folder");
  }
  if (name === "QuotaExceededError") {
    eventBus.emit("storage:writeFailed", Object.freeze({ key: "vfs", message: detail }));
    return new VFSError("QUOTA_EXCEEDED", "Browser storage is full, so the change wasn't saved. Free up space (for example, empty the Recycle Bin) and try again.");
  }
  if (mode === "readwrite") {
    eventBus.emit("storage:writeFailed", Object.freeze({ key: "vfs", message: detail }));
  }
  return new VFSError("STORAGE_ERROR", `Browser storage reported an error: ${detail}`);
}

/**
 * Singleton adapter shared by VirtualFileSystem and SearchService.
 * @type {StorageAdapter}
 */
export const storageAdapter = new StorageAdapter();
