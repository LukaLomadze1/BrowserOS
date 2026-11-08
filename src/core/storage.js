/**
 * @file Key/value persistence for small system state (theme choice,
 * preferences, window positions, histories).
 *
 * This is intentionally scoped to localStorage. Files and folders live
 * in the virtual file system (src/core/vfs/), which is backed by
 * IndexedDB.
 *
 * A failed write (for example, storage full or blocked) is logged and
 * announced as "storage:writeFailed" { key, message } so the storage
 * monitor can warn the user.
 *
 * Backups: `exportItems()` returns every BrowserOS entry as stored, and
 * `replaceItems()` swaps them all for a backup's (putting the previous
 * ones back if the browser refuses). After a restore, `freeze()` stops
 * this page from writing anything else before it reloads, so services
 * saving their in-memory state on unload can't overwrite what was just
 * restored.
 */

import { eventBus } from "./eventBus.js";

const NAMESPACE = "browseros";

class StorageService {
  /**
   * @param {string} namespace - Prefix applied to every key so
   *   BrowserOS never collides with other data in the same origin.
   */
  constructor(namespace) {
    this._namespace = namespace;
    this._frozen = false;
  }

  /**
   * @param {string} key
   * @returns {string} Namespaced key.
   */
  _namespaced(key) {
    return `${this._namespace}:${key}`;
  }

  /**
   * Read and JSON-parse a value.
   * @param {string} key
   * @param {*} [fallback] - Returned if the key is missing or the
   *   stored value fails to parse.
   * @returns {*}
   */
  get(key, fallback = null) {
    try {
      const raw = window.localStorage.getItem(this._namespaced(key));
      if (raw === null) return fallback;
      return JSON.parse(raw);
    } catch (error) {
      console.error(`[Storage] failed to read "${key}":`, error);
      return fallback;
    }
  }

  /**
   * JSON-serialize and store a value.
   * @param {string} key
   * @param {*} value
   * @returns {boolean} Whether the write succeeded.
   */
  set(key, value) {
    if (this._frozen) return false;
    try {
      window.localStorage.setItem(this._namespaced(key), JSON.stringify(value));
      return true;
    } catch (error) {
      console.error(`[Storage] failed to write "${key}":`, error);
      eventBus.emit("storage:writeFailed", Object.freeze({ key, message: error?.message || String(error) }));
      return false;
    }
  }

  /**
   * @param {string} key
   * @returns {void}
   */
  remove(key) {
    if (this._frozen) return;
    try {
      window.localStorage.removeItem(this._namespaced(key));
    } catch (error) {
      console.error(`[Storage] failed to remove "${key}":`, error);
    }
  }

  /**
   * Remove every BrowserOS key, leaving unrelated origin data alone.
   * @returns {void}
   */
  clear() {
    if (this._frozen) return;
    for (const key of this._namespacedKeys()) window.localStorage.removeItem(key);
  }

  /**
   * Every BrowserOS entry, by key without the namespace prefix, with
   * its stored (JSON) text.
   * @returns {Record<string, string>}
   */
  exportItems() {
    const items = {};
    const prefix = `${this._namespace}:`;
    for (const key of this._namespacedKeys()) {
      const value = window.localStorage.getItem(key);
      if (value !== null) items[key.slice(prefix.length)] = value;
    }
    return items;
  }

  /**
   * Replace every BrowserOS entry with `items` (key without prefix →
   * stored JSON text). If the browser refuses part-way (storage full),
   * the previous entries are put back and the error is thrown.
   * @param {Record<string, string>} items
   * @returns {void}
   * @throws {Error} The browser's storage error.
   */
  replaceItems(items) {
    if (this._frozen) throw new Error("Storage is frozen until BrowserOS reloads");
    const previous = this.exportItems();
    const write = (values) => {
      for (const key of this._namespacedKeys()) window.localStorage.removeItem(key);
      for (const [key, value] of Object.entries(values)) window.localStorage.setItem(this._namespaced(key), value);
    };
    try {
      write(items);
    } catch (error) {
      try {
        write(previous);
      } catch (rollbackError) {
        console.error("[Storage] could not put the previous values back:", rollbackError);
      }
      throw error;
    }
  }

  /**
   * Ignore every later write from this page (used right before a reload
   * that follows a restore).
   * @returns {void}
   */
  freeze() {
    this._frozen = true;
  }

  /** @returns {string[]} Full localStorage keys belonging to BrowserOS. */
  _namespacedKeys() {
    const prefix = `${this._namespace}:`;
    const keys = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (key && key.startsWith(prefix)) keys.push(key);
    }
    return keys;
  }
}

/**
 * Singleton storage instance shared across the OS.
 * @type {StorageService}
 */
export const storage = new StorageService(NAMESPACE);
