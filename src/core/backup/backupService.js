/**
 * @file BackupService — exports BrowserOS data to a file on the host
 * computer and restores it, using the format in backupFormat.js.
 *
 *   Full backup     every file and folder (Trash included) plus
 *                   BrowserOS's settings and application data in
 *                   localStorage. Restoring it replaces all current
 *                   BrowserOS data and restarts BrowserOS.
 *   Folder backup   one folder and everything in it. Restoring it adds
 *                   the folder somewhere you choose; nothing existing is
 *                   replaced (a taken name gets a number).
 *
 * Safety:
 *  - A backup is validated completely (format, version, checksum,
 *    structure, every file's size) before anything is changed.
 *  - Full restores write the file system in one transaction: if it
 *    fails, the current files remain. Settings are then replaced (the
 *    previous ones are put back if the browser refuses), every open
 *    application is closed first, and the page reloads with further
 *    writes blocked, so nothing in memory can overwrite the restored
 *    data on the way out.
 *  - Callers (the Settings app) ask for explicit confirmation first.
 *
 * Files go through the public VFS API (exportEntries, replaceAll,
 * importEntries) and settings through StorageService; nothing here
 * opens IndexedDB or localStorage itself.
 */

import { vfs } from "../vfs/virtualFileSystem.js";
import { storage } from "../storage.js";
import { BROWSEROS_VERSION } from "../version.js";
import { buildBackup, parseBackup } from "./backupFormat.js";

/** Largest backup file read for restoring. */
export const MAX_BACKUP_BYTES = 512 * 1024 * 1024;

class BackupService {
  /**
   * Create a full backup.
   * @returns {Promise<{blob: Blob, filename: string, counts: object}>}
   */
  async createFullBackup() {
    const entries = await vfs.exportEntries("/");
    const { text, counts } = await buildBackup({ scope: "full", root: "/", entries, storage: storage.exportItems(), appVersion: BROWSEROS_VERSION });
    return this._result(text, counts, "browseros-backup");
  }

  /**
   * Create a backup of one folder.
   * @param {string} path
   * @returns {Promise<{blob: Blob, filename: string, counts: object}>}
   */
  async createFolderBackup(path) {
    const info = await vfs.getInfo(path);
    if (info.type !== "folder") throw new Error(`"${path}" is not a folder`);
    const entries = await vfs.exportEntries(info.path);
    const { text, counts } = await buildBackup({ scope: "folder", root: info.path, entries, appVersion: BROWSEROS_VERSION });
    const label = info.path === "/" ? "files" : info.name;
    return this._result(text, counts, `browseros-folder-${safeFilePart(label)}`);
  }

  /**
   * Read and validate a backup file without changing anything.
   * @param {File|Blob} file
   * @returns {Promise<import("./backupFormat.js").ParsedBackup>}
   * @throws {import("./backupFormat.js").BackupError|Error}
   */
  async inspect(file) {
    if (file.size > MAX_BACKUP_BYTES) {
      throw new Error(`The file is larger than ${Math.round(MAX_BACKUP_BYTES / (1024 * 1024))} MB, the largest backup BrowserOS can restore.`);
    }
    return parseBackup(await file.text());
  }

  /**
   * Replace all BrowserOS data with a full backup. The caller has
   * confirmed with the user and reloads the page afterwards (this
   * method freezes further localStorage writes).
   * @param {import("./backupFormat.js").ParsedBackup} backup
   * @param {{closeApplications?: () => (void|Promise<void>)}} [options] - Awaited before anything is replaced, to end running applications.
   * @returns {Promise<void>}
   */
  async restoreFull(backup, { closeApplications } = {}) {
    if (backup.scope !== "full") throw new Error("This is a folder backup; restore it into a folder instead.");
    await closeApplications?.();
    await vfs.replaceAll(backup.entries);
    storage.replaceItems(backup.storage);
    storage.freeze();
  }

  /**
   * Add a folder backup's folder under `destination`.
   * @param {import("./backupFormat.js").ParsedBackup} backup
   * @param {string} destination
   * @returns {Promise<object>} The restored folder's entry.
   */
  async restoreFolder(backup, destination) {
    return vfs.importEntries(destination, backup.entries);
  }

  /**
   * Hand a file to the host browser as a download.
   * @param {Blob} blob
   * @param {string} filename
   * @returns {void}
   */
  saveToComputer(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.rel = "noopener";
    link.style.display = "none";
    document.body.append(link);
    link.click();
    link.remove();
    // Give the browser time to start the download before the URL goes away.
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  /**
   * @param {string} text
   * @param {object} counts
   * @param {string} stem
   * @returns {{blob: Blob, filename: string, counts: object}}
   */
  _result(text, counts, stem) {
    const blob = new Blob([text], { type: "application/json" });
    const stamp = new Date().toISOString().slice(0, 16).replace("T", "-").replace(":", "");
    return { blob, filename: `${stem}-${stamp}.json`, counts };
  }
}

/**
 * @param {string} value
 * @returns {string}
 */
function safeFilePart(value) {
  return value.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "folder";
}

/**
 * Singleton backup service.
 * @type {BackupService}
 */
export const backupService = new BackupService();
