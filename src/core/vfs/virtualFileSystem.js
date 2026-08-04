/**
 * @file VirtualFileSystem — the public API for BrowserOS's storage
 * backbone. Orchestrates PathResolver (path math), StorageAdapter
 * (the only IndexedDB access point), ValidationService (the rules),
 * and SearchService (recursive search) — none of which know about
 * each other. This is the one module that does.
 *
 * On first boot it seeds a default directory tree; every boot after
 * that finds the existing root and does nothing further.
 *
 * Step 9 fix (Bug #2 root cause): delete() moves an entry (and, if
 * it's a folder, its entire subtree) into /Trash by retargeting
 * paths via `_retargetDescendantPaths`. That helper used to run
 * silently — only the top-level deleted entry ever got a
 * filesystem:fileDeleted event, so anything reacting only to that
 * event (RecentFilesService's reactive listener) never found out
 * that a descendant file had individually vanished. `delete()` now
 * emits one filesystem:fileDeleted per retargeted descendant too, so
 * reactive listeners never have to fall back on next-render
 * reconciliation to notice a deleted file that lived inside a
 * deleted folder.
 */

import { eventBus } from "../eventBus.js";
import { storageAdapter } from "./storageAdapter.js";
import * as pathResolver from "./pathResolver.js";
import { createId, createDirectoryEntry, createFileEntry, isFolder, isBinaryExtension } from "./entry.js";
import * as validate from "./validationService.js";
import { searchEntries } from "./searchService.js";
import { VFSError } from "./vfsError.js";

const ROOT_ID = "root";
const TRASH_PATH = "/Trash";
const DEFAULT_FOLDERS = ["Desktop", "Documents", "Downloads", "Pictures", "Music", "Videos", "Applications"];
const PROTECTED_FOLDERS = ["Trash", "System"];

class VirtualFileSystem {
  constructor() {
    /** @type {Promise<void>|null} */
    this._ready = null;
  }

  /**
   * Open the database and seed the default folder tree if this is
   * the first boot. Safe to call more than once — subsequent calls
   * reuse the same in-flight/completed promise. Every other public
   * method awaits this internally, so callers don't strictly have to
   * — but awaiting it once at startup avoids every first call paying
   * the bootstrap cost.
   * @returns {Promise<void>}
   */
  init() {
    if (!this._ready) {
      this._ready = this._bootstrap();
    }
    return this._ready;
  }

  /** @returns {Promise<void>} */
  async _bootstrap() {
    await storageAdapter.open();

    const existingRoot = await storageAdapter.getById(ROOT_ID);
    if (existingRoot) return;

    const now = Date.now();
    await storageAdapter.put({
      id: ROOT_ID,
      name: "/",
      parentId: null,
      path: "/",
      type: "folder",
      extension: null,
      content: null,
      size: 0,
      createdAt: now,
      modifiedAt: now,
      hidden: false,
      readOnly: true,
      system: true,
      favorite: false,
    });

    for (const name of DEFAULT_FOLDERS) {
      await storageAdapter.put(
        createDirectoryEntry({ id: createId(), name, parentId: ROOT_ID, path: `/${name}` })
      );
    }
    for (const name of PROTECTED_FOLDERS) {
      await storageAdapter.put(
        createDirectoryEntry({ id: createId(), name, parentId: ROOT_ID, path: `/${name}`, system: true })
      );
    }
  }

  // ---------------------------------------------------------------
  // Path
  // ---------------------------------------------------------------

  /**
   * @param {string} path
   * @param {string} [currentDir]
   * @returns {Promise<string>} The normalized absolute path.
   */
  async resolvePath(path, currentDir = "/") {
    return pathResolver.resolvePath(path, currentDir);
  }

  // ---------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------

  /**
   * @param {string} path
   * @param {string} [currentDir]
   * @returns {Promise<boolean>}
   */
  async exists(path, currentDir = "/") {
    await this.init();
    const resolved = pathResolver.resolvePath(path, currentDir);
    const entry = await storageAdapter.getByPath(resolved);
    return Boolean(entry);
  }

  /**
   * @param {string} path
   * @param {string} [currentDir]
   * @returns {Promise<object>} A copy of the entry's metadata.
   * @throws {VFSError} NOT_FOUND
   */
  async getInfo(path, currentDir = "/") {
    await this.init();
    const entry = await this._getEntryOrThrow(path, currentDir);
    return { ...entry };
  }

  /**
   * @param {string} [path]
   * @param {string} [currentDir]
   * @returns {Promise<object[]>} Direct children, folders first, then alphabetical.
   * @throws {VFSError} NOT_FOUND, NOT_A_FOLDER
   */
  async list(path = "/", currentDir = "/") {
    await this.init();
    const folder = await this._getEntryOrThrow(path, currentDir);
    validate.assertIsFolder(folder);

    const children = await storageAdapter.getChildren(folder.id);
    return children
      .map((entry) => ({ ...entry }))
      .sort((a, b) => {
        if (isFolder(a) !== isFolder(b)) return isFolder(a) ? -1 : 1;
        return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
      });
  }

  /**
   * @param {string} path
   * @param {string} [currentDir]
   * @returns {Promise<string>} File content (empty string if never written).
   * @throws {VFSError} NOT_FOUND, NOT_A_FILE, BINARY_CONTENT
   */
  async read(path, currentDir = "/") {
    await this.init();
    const entry = await this._getEntryOrThrow(path, currentDir);
    validate.assertIsFile(entry);
    this._assertReadableContent(entry);
    return entry.content ?? "";
  }

  // ---------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------

  /**
   * @param {string} path
   * @param {object} [options]
   * @param {boolean} [options.hidden]
   * @param {boolean} [options.favorite]
   * @param {string} [currentDir]
   * @returns {Promise<object>} The created folder entry.
   * @throws {VFSError} INVALID_NAME, NOT_FOUND, NOT_A_FOLDER, ALREADY_EXISTS
   */
  async createFolder(path, options = {}, currentDir = "/") {
    await this.init();
    const resolved = pathResolver.resolvePath(path, currentDir);
    if (resolved === "/") {
      throw new VFSError("ALREADY_EXISTS", "The root folder already exists");
    }

    const name = pathResolver.getBaseName(resolved);
    validate.validateName(name);

    const parent = await this._getEntryOrThrow(pathResolver.getParentPath(resolved));
    validate.assertIsFolder(parent);

    const siblings = await storageAdapter.getChildren(parent.id);
    validate.assertNoDuplicateSibling(siblings, name);

    const folder = createDirectoryEntry({
      id: createId(),
      name,
      parentId: parent.id,
      path: resolved,
      hidden: options.hidden ?? false,
      favorite: options.favorite ?? false,
    });
    await storageAdapter.put(folder);

    eventBus.emit("filesystem:folderCreated", { entry: { ...folder } });
    return { ...folder };
  }

  /**
   * @param {string} path
   * @param {string} [content]
   * @param {object} [options]
   * @param {number} [options.size] - Required for metadata-only types (png/jpg) since there's no content to measure.
   * @param {boolean} [options.hidden]
   * @param {boolean} [options.readOnly]
   * @param {boolean} [options.favorite]
   * @param {string} [currentDir]
   * @returns {Promise<object>} The created file entry.
   * @throws {VFSError} INVALID_NAME, NOT_FOUND, NOT_A_FOLDER, ALREADY_EXISTS
   */
  async createFile(path, content = "", options = {}, currentDir = "/") {
    await this.init();
    const resolved = pathResolver.resolvePath(path, currentDir);
    const name = pathResolver.getBaseName(resolved);
    validate.validateName(name);

    const parent = await this._getEntryOrThrow(pathResolver.getParentPath(resolved));
    validate.assertIsFolder(parent);

    const siblings = await storageAdapter.getChildren(parent.id);
    validate.assertNoDuplicateSibling(siblings, name);

    const file = createFileEntry({
      id: createId(),
      name,
      parentId: parent.id,
      path: resolved,
      content,
      size: options.size,
      hidden: options.hidden ?? false,
      readOnly: options.readOnly ?? false,
      favorite: options.favorite ?? false,
    });
    await storageAdapter.put(file);

    eventBus.emit("filesystem:fileCreated", { entry: { ...file } });
    return { ...file };
  }

  /**
   * Overwrites an existing file's content. Use createFile() first if
   * the file doesn't exist yet — the two are kept separate
   * operations deliberately, matching the spec's operation list.
   * @param {string} path
   * @param {string} content
   * @param {string} [currentDir]
   * @returns {Promise<object>} The updated file entry.
   * @throws {VFSError} NOT_FOUND, NOT_A_FILE, READ_ONLY, BINARY_CONTENT
   */
  async write(path, content, currentDir = "/") {
    await this.init();
    const entry = await this._getEntryOrThrow(path, currentDir);
    validate.assertIsFile(entry);
    validate.assertNotReadOnly(entry);
    this._assertReadableContent(entry);

    entry.content = content;
    entry.size = new TextEncoder().encode(content).length;
    entry.modifiedAt = Date.now();
    await storageAdapter.put(entry);

    eventBus.emit("filesystem:fileModified", { entry: { ...entry } });
    return { ...entry };
  }

  /**
   * Toggle a file or folder's favorite flag. Favorites are VFS
   * metadata, not a separate list any app keeps for itself — this is
   * what File Explorer's "Add/Remove from Favorites" calls.
   * @param {string} path
   * @param {boolean} isFavorite
   * @param {string} [currentDir]
   * @returns {Promise<object>} The updated entry.
   * @throws {VFSError} NOT_FOUND
   */
  async setFavorite(path, isFavorite, currentDir = "/") {
    await this.init();
    const entry = await this._getEntryOrThrow(path, currentDir);
    entry.favorite = Boolean(isFavorite);
    entry.modifiedAt = Date.now();
    await storageAdapter.put(entry);

    eventBus.emit("filesystem:fileModified", { entry: { ...entry } });
    return { ...entry };
  }

  /**
   * @param {string} path
   * @param {string} newName
   * @param {string} [currentDir]
   * @returns {Promise<object>} The updated entry.
   * @throws {VFSError} NOT_FOUND, PROTECTED, READ_ONLY, INVALID_NAME, ALREADY_EXISTS
   */
  async rename(path, newName, currentDir = "/") {
    await this.init();
    const entry = await this._getEntryOrThrow(path, currentDir);
    if (entry.id === ROOT_ID) {
      throw new VFSError("PROTECTED", "The root folder cannot be renamed");
    }
    validate.assertNotProtected(entry);
    validate.assertNotReadOnly(entry);
    validate.validateName(newName);

    const parent = await storageAdapter.getById(entry.parentId);
    const siblings = await storageAdapter.getChildren(parent.id);
    validate.assertNoDuplicateSibling(siblings, newName, entry.id);

    const oldPath = entry.path;
    const newPath = parent.path === "/" ? `/${newName}` : `${parent.path}/${newName}`;

    entry.name = newName;
    entry.path = newPath;
    entry.extension = entry.type === "file" ? pathResolver.getExtension(newName) : null;
    entry.modifiedAt = Date.now();
    await storageAdapter.put(entry);

    if (isFolder(entry)) {
      await this._retargetDescendantPaths(entry.id, oldPath, newPath);
    }

    eventBus.emit("filesystem:fileRenamed", { entry: { ...entry }, oldPath });
    return { ...entry };
  }

  /**
   * @param {string} sourcePath
   * @param {string} destinationFolderPath
   * @param {string} [currentDir]
   * @returns {Promise<object>} The updated entry.
   * @throws {VFSError} NOT_FOUND, PROTECTED, READ_ONLY, NOT_A_FOLDER, CIRCULAR_REFERENCE, ALREADY_EXISTS
   */
  async move(sourcePath, destinationFolderPath, currentDir = "/") {
    await this.init();
    const entry = await this._getEntryOrThrow(sourcePath, currentDir);
    if (entry.id === ROOT_ID) {
      throw new VFSError("PROTECTED", "The root folder cannot be moved");
    }
    validate.assertNotProtected(entry);
    validate.assertNotReadOnly(entry);

    const destination = await this._getEntryOrThrow(destinationFolderPath, currentDir);
    validate.assertIsFolder(destination);

    if (destination.id === entry.parentId) {
      throw new VFSError("ALREADY_EXISTS", `"${entry.name}" is already in "${destination.path}"`);
    }
    if (isFolder(entry)) {
      validate.assertNoCircularMove(entry, destination);
    }

    const siblings = await storageAdapter.getChildren(destination.id);
    validate.assertNoDuplicateSibling(siblings, entry.name);

    const oldPath = entry.path;
    const newPath = destination.path === "/" ? `/${entry.name}` : `${destination.path}/${entry.name}`;

    entry.parentId = destination.id;
    entry.path = newPath;
    entry.modifiedAt = Date.now();
    await storageAdapter.put(entry);

    if (isFolder(entry)) {
      await this._retargetDescendantPaths(entry.id, oldPath, newPath);
    }

    eventBus.emit("filesystem:fileMoved", { entry: { ...entry }, oldPath });
    return { ...entry };
  }

  /**
   * Deep-copies a file or folder (with new ids throughout) into a
   * destination folder.
   * @param {string} sourcePath
   * @param {string} destinationFolderPath
   * @param {object} [options]
   * @param {string} [options.currentDir]
   * @param {string} [options.newName] - Use a different name for the copy at the destination (e.g. "file (2).txt" when "file.txt" already exists there) instead of throwing ALREADY_EXISTS. Only applies to the top-level copied item; nested children always keep their own names.
   * @returns {Promise<object>} The newly created copy's entry.
   * @throws {VFSError} NOT_FOUND, NOT_A_FOLDER, CIRCULAR_REFERENCE, ALREADY_EXISTS, INVALID_NAME
   */
  async copy(sourcePath, destinationFolderPath, options = {}) {
    const { currentDir = "/", newName } = options;
    await this.init();
    const entry = await this._getEntryOrThrow(sourcePath, currentDir);
    const destination = await this._getEntryOrThrow(destinationFolderPath, currentDir);
    validate.assertIsFolder(destination);

    if (isFolder(entry)) {
      validate.assertNoCircularMove(entry, destination);
    }

    const nameToUse = newName ?? entry.name;
    if (newName) validate.validateName(newName);

    const siblings = await storageAdapter.getChildren(destination.id);
    validate.assertNoDuplicateSibling(siblings, nameToUse);

    const copiedRoot = await this._copyRecursive(entry, destination.id, destination.path, nameToUse);

    eventBus.emit("filesystem:fileCopied", { entry: { ...copiedRoot }, sourcePath: entry.path });
    return { ...copiedRoot };
  }

  /**
   * Soft delete: moves the entry (and, if it's a folder, everything
   * inside it) into /Trash. Permanent deletion isn't implemented yet.
   * @param {string} path
   * @param {string} [currentDir]
   * @returns {Promise<object>} The updated entry, now living in /Trash.
   * @throws {VFSError} NOT_FOUND, PROTECTED, READ_ONLY, ALREADY_EXISTS
   */
  async delete(path, currentDir = "/") {
    await this.init();
    const entry = await this._getEntryOrThrow(path, currentDir);
    if (entry.id === ROOT_ID) {
      throw new VFSError("PROTECTED", "The root folder cannot be deleted");
    }
    validate.assertNotProtected(entry);
    validate.assertNotReadOnly(entry);

    const trash = await storageAdapter.getByPath(TRASH_PATH);
    if (!trash) {
      throw new VFSError("NOT_FOUND", "Trash is unavailable");
    }
    if (entry.parentId === trash.id) {
      throw new VFSError("ALREADY_EXISTS", `"${entry.name}" is already in Trash`);
    }

    // Trash can accumulate items with the same name over time
    // (deleting "notes.txt" from two different folders); dedupe
    // instead of throwing, since re-throwing ALREADY_EXISTS for a
    // routine delete would be a confusing dead end for the caller.
    const trashSiblings = await storageAdapter.getChildren(trash.id);
    const finalName = this._dedupeName(entry.name, trashSiblings);

    const oldPath = entry.path;
    const newPath = `${TRASH_PATH}/${finalName}`;

    entry.originalParentId = entry.parentId;
    entry.originalPath = oldPath;
    entry.deletedAt = Date.now();
    entry.name = finalName;
    entry.parentId = trash.id;
    entry.path = newPath;
    entry.modifiedAt = Date.now();
    await storageAdapter.put(entry);

    if (isFolder(entry)) {
      // Bug #2 fix: a deleted folder's contents get retargeted into
      // /Trash right along with it, but until now nothing told
      // RecentFilesService (or anything else reacting only to
      // filesystem:fileDeleted) that any of those descendants had
      // individually vanished — only the folder's own event fired.
      // reconcile() eventually caught it (a stale path throws
      // NOT_FOUND), but not reactively. Emitting one event per
      // descendant closes that gap for good.
      const retargetedDescendants = await this._retargetDescendantPaths(entry.id, oldPath, newPath);
      for (const { entry: descendantEntry, oldPath: descendantOldPath } of retargetedDescendants) {
        eventBus.emit("filesystem:fileDeleted", { entry: { ...descendantEntry }, oldPath: descendantOldPath });
      }
    }

    eventBus.emit("filesystem:fileDeleted", { entry: { ...entry }, oldPath });
    return { ...entry };
  }

  // ---------------------------------------------------------------
  // Search
  // ---------------------------------------------------------------

  /**
   * Recursive, case-insensitive search.
   * @param {string} query
   * @param {object} [options]
   * @param {string} [options.path] - Folder to search within; defaults to the whole file system.
   * @param {string} [options.extension] - Filter to a single extension (without the dot).
   * @param {"partial"|"exact"} [options.matchType]
   * @returns {Promise<object[]>}
   * @throws {VFSError} NOT_FOUND, NOT_A_FOLDER
   */
  async search(query, options = {}) {
    await this.init();
    const rootPath = options.path ? pathResolver.resolvePath(options.path) : "/";
    const rootEntry = await this._getEntryOrThrow(rootPath);
    validate.assertIsFolder(rootEntry);

    const results = await searchEntries(storageAdapter, rootEntry.id, { ...options, query });
    return results.map((entry) => ({ ...entry }));
  }

  // ---------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------

  /**
   * @param {string} path
   * @param {string} [currentDir]
   * @returns {Promise<object>} The raw stored entry (not a copy) — internal use only.
   * @throws {VFSError} NOT_FOUND
   */
  async _getEntryOrThrow(path, currentDir = "/") {
    const resolved = pathResolver.resolvePath(path, currentDir);
    const entry = await storageAdapter.getByPath(resolved);
    if (!entry) {
      throw new VFSError("NOT_FOUND", `No such file or folder: "${resolved}"`);
    }
    return entry;
  }

  /**
   * @param {object} entry
   * @returns {void}
   * @throws {VFSError} BINARY_CONTENT
   */
  _assertReadableContent(entry) {
    if (isBinaryExtension(entry.extension)) {
      throw new VFSError(
        "BINARY_CONTENT",
        `"${entry.path}" is a .${entry.extension} file; only metadata is supported, not content`
      );
    }
  }

  /**
   * After a folder's own path changes from oldPrefix to newPrefix,
   * every descendant's stored path needs the same prefix swapped in
   * — a descendant's path always starts with its folder's path, so
   * this is a single pass over the subtree rather than per-level
   * recursion.
   * @param {string} folderId
   * @param {string} oldPrefix
   * @param {string} newPrefix
   * @returns {Promise<Array<{entry: object, oldPath: string}>>} Every retargeted descendant paired with its path before retargeting. rename()/move() ignore this return value; delete() uses it to emit a per-descendant filesystem:fileDeleted event (see above).
   */
  async _retargetDescendantPaths(folderId, oldPrefix, newPrefix) {
    const descendants = await storageAdapter.getSubtree(folderId, { includeRoot: false });
    const retargeted = [];
    for (const descendant of descendants) {
      const descendantOldPath = descendant.path;
      descendant.path = newPrefix + descendant.path.slice(oldPrefix.length);
      descendant.modifiedAt = Date.now();
      await storageAdapter.put(descendant);
      retargeted.push({ entry: descendant, oldPath: descendantOldPath });
    }
    return retargeted;
  }

  /**
   * Deep-copies one entry (and, recursively, its children) under a
   * new parent, generating fresh ids throughout.
   * @param {object} sourceEntry
   * @param {string} newParentId
   * @param {string} newParentPath
   * @param {string} [overrideName] - Only applied to this call's own entry, never passed down to recursive children.
   * @returns {Promise<object>} The newly created top-level copy.
   */
  async _copyRecursive(sourceEntry, newParentId, newParentPath, overrideName = null) {
    const nameToUse = overrideName ?? sourceEntry.name;
    const newPath = newParentPath === "/" ? `/${nameToUse}` : `${newParentPath}/${nameToUse}`;
    const newId = createId();

    const newEntry = isFolder(sourceEntry)
      ? createDirectoryEntry({
          id: newId,
          name: nameToUse,
          parentId: newParentId,
          path: newPath,
          hidden: sourceEntry.hidden,
          favorite: sourceEntry.favorite,
        })
      : createFileEntry({
          id: newId,
          name: nameToUse,
          parentId: newParentId,
          path: newPath,
          content: sourceEntry.content,
          size: sourceEntry.size,
          hidden: sourceEntry.hidden,
          readOnly: sourceEntry.readOnly,
          favorite: sourceEntry.favorite,
        });
    await storageAdapter.put(newEntry);

    if (isFolder(sourceEntry)) {
      const children = await storageAdapter.getChildren(sourceEntry.id);
      for (const child of children) {
        await this._copyRecursive(child, newId, newPath);
      }
    }

    return newEntry;
  }

  /**
   * @param {string} name
   * @param {object[]} siblings
   * @returns {string} `name` if it's free, otherwise "name (1)", "name (2)", ... with the extension preserved.
   */
  _dedupeName(name, siblings) {
    const existingNames = new Set(siblings.map((entry) => entry.name.toLowerCase()));
    if (!existingNames.has(name.toLowerCase())) return name;

    const dotIndex = name.lastIndexOf(".");
    const stem = dotIndex > 0 ? name.slice(0, dotIndex) : name;
    const ext = dotIndex > 0 ? name.slice(dotIndex) : "";

    let counter = 1;
    let candidate = `${stem} (${counter})${ext}`;
    while (existingNames.has(candidate.toLowerCase())) {
      counter += 1;
      candidate = `${stem} (${counter})${ext}`;
    }
    return candidate;
  }
}

/**
 * Singleton VFS shared by every app that needs storage. Nothing else
 * in BrowserOS should construct a VirtualFileSystem of its own.
 * @type {VirtualFileSystem}
 */
export const vfs = new VirtualFileSystem();
