/**
 * @file ClipboardService — BrowserOS's own internal clipboard for
 * file operations. Deliberately has nothing to do with the system
 * browser clipboard API (Ctrl+C in an OS sense copies text; this
 * copies VFS entries) — using the real clipboard API would leak
 * VFS-internal identifiers into the user's actual OS clipboard for
 * no benefit.
 *
 * A single shared instance (constructed once in main.js) is handed
 * to both DesktopManager and Explorer, so cutting a file on the
 * desktop and pasting it in Explorer (or vice versa) works exactly
 * as one would expect from "the same clipboard".
 */

import { eventBus } from "./eventBus.js";

class ClipboardService {
  constructor() {
    /** @type {{entryIds: string[], sourcePaths: string[], operation: "copy"|"cut", timestamp: number}|null} */
    this._record = null;
  }

  /**
   * @param {object[]} entries - VFS entries to copy.
   * @returns {void}
   */
  setCopy(entries) {
    this._setRecord(entries, "copy");
  }

  /**
   * @param {object[]} entries - VFS entries to cut.
   * @returns {void}
   */
  setCut(entries) {
    this._setRecord(entries, "cut");
  }

  /**
   * @returns {{entryIds: string[], sourcePaths: string[], operation: "copy"|"cut", timestamp: number}|null} A defensive copy, or null if empty.
   */
  get() {
    if (!this._record) return null;
    return { ...this._record, entryIds: [...this._record.entryIds], sourcePaths: [...this._record.sourcePaths] };
  }

  /**
   * @returns {boolean}
   */
  hasContent() {
    return this._record !== null;
  }

  /**
   * @param {string} entryId
   * @returns {boolean} Whether this id is currently cut (for the "pending" visual state), not merely copied.
   */
  isCut(entryId) {
    return this._record?.operation === "cut" && this._record.entryIds.includes(entryId);
  }

  /**
   * @returns {void}
   */
  clear() {
    if (!this._record) return;
    this._record = null;
    eventBus.emit("clipboard:changed", { hasContent: false });
  }

  /**
   * @param {object[]} entries
   * @param {"copy"|"cut"} operation
   * @returns {void}
   */
  _setRecord(entries, operation) {
    if (!entries || entries.length === 0) return;
    this._record = {
      entryIds: entries.map((entry) => entry.id),
      sourcePaths: entries.map((entry) => entry.path),
      operation,
      timestamp: Date.now(),
    };
    eventBus.emit("clipboard:changed", { hasContent: true, operation });
  }
}

/**
 * Singleton clipboard shared by Desktop and Explorer.
 * @type {ClipboardService}
 */
export const clipboardService = new ClipboardService();
