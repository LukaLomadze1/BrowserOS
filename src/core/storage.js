/**
 * @file Key/value persistence for small system state (theme choice,
 * preferences, window positions, etc).
 *
 * This is intentionally scoped to localStorage. The virtual file
 * system (folders, files, byte content) is a much larger subsystem
 * backed by IndexedDB and will be introduced as its own module in
 * the File System step — it does not belong here, and stubbing it
 * out now would only produce dead API surface.
 */

const NAMESPACE = "browseros";

class StorageService {
  /**
   * @param {string} namespace - Prefix applied to every key so
   *   BrowserOS never collides with other data in the same origin.
   */
  constructor(namespace) {
    this._namespace = namespace;
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
    try {
      window.localStorage.setItem(this._namespaced(key), JSON.stringify(value));
      return true;
    } catch (error) {
      console.error(`[Storage] failed to write "${key}":`, error);
      return false;
    }
  }

  /**
   * @param {string} key
   * @returns {void}
   */
  remove(key) {
    window.localStorage.removeItem(this._namespaced(key));
  }

  /**
   * Remove every BrowserOS key, leaving unrelated origin data alone.
   * @returns {void}
   */
  clear() {
    const prefix = `${this._namespace}:`;
    const keysToRemove = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (key && key.startsWith(prefix)) {
        keysToRemove.push(key);
      }
    }
    keysToRemove.forEach((key) => window.localStorage.removeItem(key));
  }
}

/**
 * Singleton storage instance shared across the OS.
 * @type {StorageService}
 */
export const storage = new StorageService(NAMESPACE);
