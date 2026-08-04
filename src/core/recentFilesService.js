/**
 * @file RecentFilesService — the single, VFS-reconciled source of
 * truth for "recently opened files". Shared by the Start Menu,
 * Explorer's Home view, and anything else that wants it, so there is
 * exactly one place a stale record could exist, and exactly one
 * place that cleans it up.
 *
 * This is the fix for the Step 8 bug: recent files used to be
 * tracked as a side effect of AppManager's "app:launched" event,
 * which has no idea a file even exists in the VFS, let alone whether
 * it still does — a deleted file's window had already launched, so
 * its (path-derived) app id stayed in "recent" forever. This service
 * instead stores VFS entry ids and reconciles against the VFS both
 * reactively (rename/move/delete events) and on demand (reconcile()),
 * so a stale entry can't survive either path.
 *
 * Step 9 note: the reactive path here was already correct — the real
 * gap turned out to be one level up, in VirtualFileSystem.delete():
 * deleting a folder only ever emitted one filesystem:fileDeleted
 * event (for the folder itself), never one per descendant dragged
 * into /Trash along with it. This service's own "remove on delete"
 * listener was therefore never told about those descendants
 * individually — reconcile() eventually caught it (a stale path
 * throws NOT_FOUND), but not reactively. That's fixed at the source
 * in virtualFileSystem.js; nothing here needed to change.
 */

import { eventBus } from "./eventBus.js";
import { storage } from "./storage.js";

const STORAGE_KEY = "recentFiles";
const MAX_RECENTS = 10;
const TRASH_PATH_PREFIX = "/Trash/";
const TRASH_PATH = "/Trash";

class RecentFilesService {
  /**
   * @param {import("./vfs/virtualFileSystem.js").vfs} vfs
   */
  constructor(vfs) {
    this._vfs = vfs;
    /** @type {Array<{entryId: string, path: string, name: string, type: string, lastOpenedAt: number}>} */
    this._records = storage.get(STORAGE_KEY, []);
  }

  /**
   * Wire VFS events for reactive cleanup. Call once during boot.
   * @returns {void}
   */
  init() {
    eventBus.on("filesystem:fileRenamed", ({ entry }) => this._handleRenameOrMove(entry));
    eventBus.on("filesystem:fileMoved", ({ entry }) => this._handleRenameOrMove(entry));
    eventBus.on("filesystem:fileDeleted", ({ entry }) => this.remove(entry.id));
  }

  /**
   * Record that a file was just opened. Folders, Trash items, and
   * hidden files are never tracked as "recent files".
   * @param {object} entry - A VFS entry (only `type === "file"` entries are recorded).
   * @returns {void}
   */
  add(entry) {
    if (entry.type !== "file") return;
    if (this._isInTrash(entry.path)) return;
    if (entry.hidden) return;

    this._records = this._records.filter((record) => record.entryId !== entry.id);
    this._records.unshift(this._toRecord(entry));
    this._records = this._records.slice(0, MAX_RECENTS);
    this._persist();
  }

  /**
   * @param {string} entryId
   * @returns {void}
   */
  remove(entryId) {
    const before = this._records.length;
    this._records = this._records.filter((record) => record.entryId !== entryId);
    if (this._records.length !== before) this._persist();
  }

  /**
   * Refresh a record's display fields (name/path/type) in place —
   * used when a tracked file is renamed or moved. Deliberately does
   * NOT change its position or timestamp; "recent" reflects when it
   * was opened, not when it was last touched.
   * @param {object} entry
   * @returns {void}
   */
  update(entry) {
    const index = this._records.findIndex((record) => record.entryId === entry.id);
    if (index === -1) return;
    this._records[index] = this._toRecord(entry, this._records[index].lastOpenedAt);
    this._persist();
  }

  /**
   * @returns {Array<object>} Defensive copies, most recently opened first.
   */
  getRecent() {
    return this._records.map((record) => ({ ...record }));
  }

  /**
   * Validate every stored record against the VFS, dropping anything
   * that no longer exists at its recorded path, has moved into
   * Trash, has become hidden, or has been replaced by a different
   * entry at that path. Call whenever a consumer is about to display
   * the list (e.g. the Start Menu opening) as a defensive backstop
   * alongside the reactive event handling above.
   * @returns {Promise<Array<object>>}
   */
  async reconcile() {
    const stillValid = [];
    for (const record of this._records) {
      if (this._isInTrash(record.path)) continue;
      try {
        const info = await this._vfs.getInfo(record.path);
        if (info.id !== record.entryId) continue; // A different file now lives at that path.
        if (info.type !== "file") continue;
        if (info.hidden) continue;
        stillValid.push(this._toRecord(info, record.lastOpenedAt));
      } catch {
        // NOT_FOUND (or any other lookup failure) — the file is gone; drop it.
      }
    }
    this._records = stillValid;
    this._persist();
    return this.getRecent();
  }

  /**
   * @returns {void}
   */
  clear() {
    this._records = [];
    this._persist();
  }

  // ---------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------

  /**
   * @param {object} entry
   * @returns {void}
   */
  _handleRenameOrMove(entry) {
    if (this._isInTrash(entry.path)) {
      this.remove(entry.id);
      return;
    }
    this.update(entry);
  }

  /**
   * @param {string} path
   * @returns {boolean}
   */
  _isInTrash(path) {
    return path === TRASH_PATH || path.startsWith(TRASH_PATH_PREFIX);
  }

  /**
   * Extracts only primitive display fields — never the raw VFS
   * entry object — so nothing here can hold a stale mutable
   * reference to VFS-owned data.
   * @param {object} entry
   * @param {number} [lastOpenedAt]
   * @returns {{entryId: string, path: string, name: string, type: string, lastOpenedAt: number}}
   */
  _toRecord(entry, lastOpenedAt = Date.now()) {
    return {
      entryId: entry.id,
      path: entry.path,
      name: entry.name,
      type: entry.extension ?? "file",
      lastOpenedAt,
    };
  }

  /** @returns {void} */
  _persist() {
    storage.set(STORAGE_KEY, this._records);
  }
}

export { RecentFilesService };
