/**
 * @file VirtualFileSystem — the public API for BrowserOS's storage
 * backbone. Orchestrates PathResolver (path math), StorageAdapter
 * (the only IndexedDB access point), ValidationService (the rules),
 * and SearchService (recursive search) — none of which know about
 * each other. This is the one module that does.
 *
 * Start-up: init() opens the database, creates the root folder on
 * first boot, and re-creates any default folder that is missing (for
 * example /Trash), so a damaged database never leaves delete() without
 * somewhere to put things.
 *
 * Atomicity: an operation that changes several entries (renaming,
 * moving, deleting, copying, restoring, or permanently deleting a
 * folder and its contents) reads what it needs first and then stores
 * every change in a single transaction, so an interruption leaves
 * either the old state or the new one — never a folder whose contents
 * still carry the old path. Every write resolves only once the
 * browser has committed it.
 *
 * Trash: delete() moves an entry (and, if it's a folder, its subtree)
 * into /Trash and records where it came from (`originalPath`,
 * `originalParentId`, `deletedAt`). restore() puts it back,
 * deletePermanently() and emptyTrash() remove items for good. Moving an
 * item into the Trash folder is the same as deleting it; moving it out
 * clears its Trash details.
 *
 * Events (all on the EventBus, emitted after the change is committed):
 *   filesystem:folderCreated  { entry }
 *   filesystem:fileCreated    { entry }
 *   filesystem:fileModified   { entry }
 *   filesystem:fileRenamed    { entry, oldPath }
 *   filesystem:fileMoved      { entry, oldPath, restored? }   restored: true when it came back from Trash
 *   filesystem:fileCopied     { entry, sourcePath }
 *   filesystem:fileDeleted    { entry, oldPath, permanent? }  one per entry, descendants included;
 *                                                             permanent: true (and entry.parentId null) when it is gone for good
 *   filesystem:replaced       {}                              the whole file system was replaced from a backup
 */

import { eventBus } from "../eventBus.js";
import { storageAdapter } from "./storageAdapter.js";
import * as pathResolver from "./pathResolver.js";
import { createId, createDirectoryEntry, createFileEntry, isFolder, isBinaryExtension, getMimeType } from "./entry.js";
import * as validate from "./validationService.js";
import { searchEntries } from "./searchService.js";
import { VFSError } from "./vfsError.js";

const ROOT_ID = "root";
export const TRASH_PATH = "/Trash";
const DEFAULT_FOLDERS = ["Desktop", "Documents", "Downloads", "Pictures", "Music", "Videos", "Applications"];
const PROTECTED_FOLDERS = ["Trash", "System"];
/** Fields that only items at the top level of Trash carry. */
const TRASH_FIELDS = ["originalParentId", "originalPath", "deletedAt"];

/**
 * @param {string} path
 * @returns {boolean} Whether `path` is the Trash folder or inside it.
 */
export function isTrashPath(path) {
  return path === TRASH_PATH || (typeof path === "string" && path.startsWith(`${TRASH_PATH}/`));
}

class VirtualFileSystem {
  constructor() {
    /** @type {Promise<void>|null} */
    this._ready = null;
    this._newInstallation = false;
  }

  /**
   * @returns {boolean} Whether this start created the file system, that
   *   is, BrowserOS had no stored files before (a new installation, or
   *   site data that was cleared). Meaningful after `init()`.
   */
  isNewInstallation() {
    return this._newInstallation;
  }

  /**
   * Open the database, seed the root folder on first boot, and
   * re-create any missing default folder. Safe to call more than once —
   * subsequent calls reuse the same in-flight/completed promise. Every
   * other public method awaits this internally. If opening fails, the
   * next call tries again.
   * @returns {Promise<void>}
   * @throws {VFSError} STORAGE_UNAVAILABLE, STORAGE_BLOCKED, STORAGE_ERROR
   */
  init() {
    if (!this._ready) {
      this._ready = this._bootstrap().catch((error) => {
        this._ready = null;
        throw error;
      });
    }
    return this._ready;
  }

  /** @returns {Promise<void>} */
  async _bootstrap() {
    await storageAdapter.open();

    if (!(await storageAdapter.getById(ROOT_ID))) {
      this._newInstallation = true;
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
    }

    const missing = [];
    for (const name of [...DEFAULT_FOLDERS, ...PROTECTED_FOLDERS]) {
      if (!(await storageAdapter.getByPath(`/${name}`))) {
        missing.push(
          createDirectoryEntry({ id: createId(), name, parentId: ROOT_ID, path: `/${name}`, system: PROTECTED_FOLDERS.includes(name) })
        );
      }
    }
    await storageAdapter.putMany(missing);
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
   * @throws {VFSError} INVALID_NAME, NOT_FOUND, NOT_A_FOLDER, ALREADY_EXISTS, QUOTA_EXCEEDED
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
   * @param {string|Blob} [content] - Text for text files; a Blob for binary types (png, jpg, jpeg, webp, gif, …).
   * @param {object} [options]
   * @param {number} [options.size] - Only for metadata-only binary entries (no content to measure).
   * @param {boolean} [options.hidden]
   * @param {boolean} [options.readOnly]
   * @param {boolean} [options.favorite]
   * @param {string} [currentDir]
   * @returns {Promise<object>} The created file entry.
   * @throws {VFSError} INVALID_NAME, NOT_FOUND, NOT_A_FOLDER, ALREADY_EXISTS, INVALID_CONTENT, QUOTA_EXCEEDED
   */
  async createFile(path, content = "", options = {}, currentDir = "/") {
    await this.init();
    const resolved = pathResolver.resolvePath(path, currentDir);
    const name = pathResolver.getBaseName(resolved);
    validate.validateName(name);
    const binary = isBinaryExtension(pathResolver.getExtension(name));
    if (content instanceof Blob && !binary) {
      throw new VFSError("INVALID_CONTENT", `"${name}" is a text file; pass its content as a string`);
    }

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
   * the file doesn't exist yet — the two are deliberately separate
   * operations, so a write can never create a file by accident.
   * @param {string} path
   * @param {string} content
   * @param {string} [currentDir]
   * @returns {Promise<object>} The updated file entry.
   * @throws {VFSError} NOT_FOUND, NOT_A_FILE, READ_ONLY, BINARY_CONTENT, QUOTA_EXCEEDED
   */
  async write(path, content, currentDir = "/") {
    await this.init();
    const entry = await this._getEntryOrThrow(path, currentDir);
    validate.assertIsFile(entry);
    validate.assertNotReadOnly(entry);
    this._assertReadableContent(entry);

    const text = typeof content === "string" ? content : String(content ?? "");
    entry.content = text;
    entry.size = new TextEncoder().encode(text).length;
    entry.modifiedAt = Date.now();
    await storageAdapter.put(entry);

    eventBus.emit("filesystem:fileModified", { entry: { ...entry } });
    return { ...entry };
  }

  /**
   * Read a file's content as a Blob. Binary files return their stored
   * data; text files return their text wrapped in a Blob of the
   * matching MIME type (e.g. an SVG for an image element).
   * @param {string} path
   * @param {string} [currentDir]
   * @returns {Promise<Blob>}
   * @throws {VFSError} NOT_FOUND, NOT_A_FILE, NO_CONTENT
   */
  async readBinary(path, currentDir = "/") {
    await this.init();
    const entry = await this._getEntryOrThrow(path, currentDir);
    validate.assertIsFile(entry);
    const type = getMimeType(entry.extension);
    if (entry.content instanceof Blob) {
      // Re-type rather than trust whatever type the stored Blob carries.
      return entry.content.type === type ? entry.content : new Blob([entry.content], { type });
    }
    if (typeof entry.content === "string") return new Blob([entry.content], { type });
    throw new VFSError("NO_CONTENT", `"${entry.path}" has no stored data (it was created as metadata only)`);
  }

  /**
   * Replace a binary file's content.
   * @param {string} path
   * @param {Blob} blob
   * @param {string} [currentDir]
   * @returns {Promise<object>} The updated file entry.
   * @throws {VFSError} NOT_FOUND, NOT_A_FILE, READ_ONLY, INVALID_CONTENT, QUOTA_EXCEEDED
   */
  async writeBinary(path, blob, currentDir = "/") {
    await this.init();
    const entry = await this._getEntryOrThrow(path, currentDir);
    validate.assertIsFile(entry);
    validate.assertNotReadOnly(entry);
    if (!(blob instanceof Blob)) throw new VFSError("INVALID_CONTENT", "writeBinary() requires a Blob");
    if (!isBinaryExtension(entry.extension)) {
      throw new VFSError("INVALID_CONTENT", `"${entry.path}" is a text file; use write() instead`);
    }

    entry.content = blob;
    entry.size = blob.size;
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
   * @throws {VFSError} NOT_FOUND, PROTECTED
   */
  async setFavorite(path, isFavorite, currentDir = "/") {
    await this.init();
    const entry = await this._getEntryOrThrow(path, currentDir);
    if (entry.id === ROOT_ID) throw new VFSError("PROTECTED", "The root folder can't be a favorite");
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
    const newPath = joinChild(parent.path, newName);

    entry.name = newName;
    entry.path = newPath;
    entry.extension = entry.type === "file" ? pathResolver.getExtension(newName) : null;
    entry.modifiedAt = Date.now();
    const descendants = isFolder(entry) ? await this._retargetedDescendants(entry.id, oldPath, newPath) : [];
    await storageAdapter.putMany([entry, ...descendants.map(({ entry: descendant }) => descendant)]);

    eventBus.emit("filesystem:fileRenamed", { entry: { ...entry }, oldPath });
    return { ...entry };
  }

  /**
   * Move an entry into another folder. Moving into the Trash folder is
   * the same as delete(); moving an item out of Trash clears its Trash
   * details (use restore() to send it back where it came from).
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

    if (destination.path === TRASH_PATH && !isTrashPath(entry.path)) {
      return this.delete(entry.path);
    }
    if (destination.id === entry.parentId) {
      throw new VFSError("ALREADY_EXISTS", `"${entry.name}" is already in "${destination.path}"`);
    }
    if (isFolder(entry)) {
      validate.assertNoCircularMove(entry, destination);
    }

    const siblings = await storageAdapter.getChildren(destination.id);
    validate.assertNoDuplicateSibling(siblings, entry.name);

    const oldPath = entry.path;
    const newPath = joinChild(destination.path, entry.name);

    entry.parentId = destination.id;
    entry.path = newPath;
    entry.modifiedAt = Date.now();
    if (!isTrashPath(newPath)) stripTrashFields(entry);
    const descendants = isFolder(entry) ? await this._retargetedDescendants(entry.id, oldPath, newPath) : [];
    await storageAdapter.putMany([entry, ...descendants.map(({ entry: descendant }) => descendant)]);

    eventBus.emit("filesystem:fileMoved", { entry: { ...entry }, oldPath });
    return { ...entry };
  }

  /**
   * Deep-copies a file or folder (with new ids throughout) into a
   * destination folder, in one transaction.
   * @param {string} sourcePath
   * @param {string} destinationFolderPath
   * @param {object} [options]
   * @param {string} [options.currentDir]
   * @param {string} [options.newName] - Use a different name for the copy at the destination (e.g. "file (2).txt" when "file.txt" already exists there) instead of throwing ALREADY_EXISTS. Only applies to the top-level copied item; nested children always keep their own names.
   * @returns {Promise<object>} The newly created copy's entry.
   * @throws {VFSError} NOT_FOUND, NOT_A_FOLDER, CIRCULAR_REFERENCE, ALREADY_EXISTS, INVALID_NAME, QUOTA_EXCEEDED
   */
  async copy(sourcePath, destinationFolderPath, options = {}) {
    const { currentDir = "/", newName } = options;
    await this.init();
    const entry = await this._getEntryOrThrow(sourcePath, currentDir);
    if (entry.id === ROOT_ID) throw new VFSError("PROTECTED", "The root folder cannot be copied");
    const destination = await this._getEntryOrThrow(destinationFolderPath, currentDir);
    validate.assertIsFolder(destination);

    if (isFolder(entry)) {
      validate.assertNoCircularMove(entry, destination);
    }

    const nameToUse = newName ?? entry.name;
    if (newName) validate.validateName(newName);

    const siblings = await storageAdapter.getChildren(destination.id);
    validate.assertNoDuplicateSibling(siblings, nameToUse);

    const copies = await this._buildCopies(entry, destination.id, destination.path, nameToUse);
    await storageAdapter.putMany(copies);

    eventBus.emit("filesystem:fileCopied", { entry: { ...copies[0] }, sourcePath: entry.path });
    return { ...copies[0] };
  }

  /**
   * Soft delete: moves the entry (and, if it's a folder, everything
   * inside it) into /Trash, remembering where it came from. Items
   * already in Trash are removed with deletePermanently() instead.
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
    if (isTrashPath(entry.path)) {
      throw new VFSError("ALREADY_EXISTS", `"${entry.name}" is already in Trash. Delete it permanently to remove it.`);
    }

    const trash = await this._getTrash();
    // Trash accumulates items with the same name over time (deleting
    // "notes.txt" from two folders), so the name is made unique
    // instead of failing a routine delete.
    const trashSiblings = await storageAdapter.getChildren(trash.id);
    const finalName = dedupeName(entry.name, trashSiblings);

    const oldPath = entry.path;
    const newPath = `${TRASH_PATH}/${finalName}`;

    entry.originalParentId = entry.parentId;
    entry.originalPath = oldPath;
    entry.deletedAt = Date.now();
    entry.name = finalName;
    entry.parentId = trash.id;
    entry.path = newPath;
    entry.modifiedAt = Date.now();
    const descendants = isFolder(entry) ? await this._retargetedDescendants(entry.id, oldPath, newPath) : [];
    await storageAdapter.putMany([entry, ...descendants.map(({ entry: descendant }) => descendant)]);

    // One event per descendant as well, so listeners that track
    // individual files (recent files, open editors) learn that each
    // file inside a deleted folder is gone.
    for (const { entry: descendant, oldPath: descendantOldPath } of descendants) {
      eventBus.emit("filesystem:fileDeleted", { entry: { ...descendant }, oldPath: descendantOldPath });
    }
    eventBus.emit("filesystem:fileDeleted", { entry: { ...entry }, oldPath });
    return { ...entry };
  }

  // ---------------------------------------------------------------
  // Trash
  // ---------------------------------------------------------------

  /**
   * Put an item from the top level of Trash back where it was deleted
   * from (or into `destination`). Missing folders on the way are
   * re-created; if the name is taken there, the restored item gets a
   * numbered name such as "report (1).txt".
   * @param {string} path - An item directly inside /Trash.
   * @param {{destination?: string}} [options] - Folder to restore into instead of the original location.
   * @returns {Promise<object>} The restored entry.
   * @throws {VFSError} NOT_FOUND, NOT_IN_TRASH, NO_ORIGINAL_LOCATION, INVALID_PATH, NOT_A_FOLDER
   */
  async restore(path, options = {}) {
    await this.init();
    const entry = await this._getEntryOrThrow(path);
    const trash = await this._getTrash();
    if (entry.parentId !== trash.id) {
      throw new VFSError("NOT_IN_TRASH", `"${entry.path}" isn't in Trash, so there is nothing to restore`);
    }

    let folderPath = null;
    let desiredName = entry.name;
    if (options.destination) {
      folderPath = pathResolver.resolvePath(options.destination);
    } else if (typeof entry.originalPath === "string" && entry.originalPath.startsWith("/") && entry.originalPath !== "/") {
      folderPath = pathResolver.getParentPath(pathResolver.resolvePath(entry.originalPath));
      desiredName = pathResolver.getBaseName(entry.originalPath);
    }
    if (!folderPath) {
      throw new VFSError("NO_ORIGINAL_LOCATION", `BrowserOS doesn't know where "${entry.name}" came from. Choose a folder to restore it to.`);
    }
    if (isTrashPath(folderPath)) {
      throw new VFSError("INVALID_PATH", "Choose a folder outside Trash to restore to");
    }
    try {
      validate.validateName(desiredName);
    } catch {
      desiredName = entry.name;
    }

    const destination = await this._ensureFolder(folderPath);
    const siblings = await storageAdapter.getChildren(destination.id);
    const finalName = dedupeName(desiredName, siblings);

    const oldPath = entry.path;
    const newPath = joinChild(destination.path, finalName);
    entry.name = finalName;
    entry.extension = entry.type === "file" ? pathResolver.getExtension(finalName) : null;
    entry.parentId = destination.id;
    entry.path = newPath;
    stripTrashFields(entry);
    const descendants = isFolder(entry) ? await this._retargetedDescendants(entry.id, oldPath, newPath, { touch: false }) : [];
    await storageAdapter.putMany([entry, ...descendants.map(({ entry: descendant }) => descendant)]);

    eventBus.emit("filesystem:fileMoved", { entry: { ...entry }, oldPath, restored: true });
    return { ...entry };
  }

  /**
   * Remove an item in Trash (and everything inside it) for good.
   * @param {string} path - An item inside /Trash.
   * @returns {Promise<{removed: number}>} How many entries were removed.
   * @throws {VFSError} NOT_FOUND, NOT_IN_TRASH, PROTECTED
   */
  async deletePermanently(path) {
    await this.init();
    const entry = await this._getEntryOrThrow(path);
    if (entry.path === TRASH_PATH || !isTrashPath(entry.path)) {
      throw new VFSError("NOT_IN_TRASH", `Only items in Trash can be deleted permanently; move "${entry.name}" to Trash first`);
    }
    validate.assertNotProtected(entry);
    const subtree = await storageAdapter.getSubtree(entry.id, { includeRoot: true });
    await storageAdapter.deleteMany(subtree.map((item) => item.id));
    for (const item of subtree.reverse()) {
      eventBus.emit("filesystem:fileDeleted", { entry: { ...item, parentId: null }, oldPath: item.path, permanent: true });
    }
    return { removed: subtree.length };
  }

  /**
   * Permanently delete everything in Trash, in one transaction.
   * @returns {Promise<{removed: number, items: number}>} Entries removed, and how many top-level items that was.
   */
  async emptyTrash() {
    await this.init();
    const trash = await this._getTrash();
    const subtree = await storageAdapter.getSubtree(trash.id, { includeRoot: false });
    if (subtree.length === 0) return { removed: 0, items: 0 };
    await storageAdapter.deleteMany(subtree.map((item) => item.id));
    let items = 0;
    for (const item of subtree.reverse()) {
      if (item.parentId === trash.id) items += 1;
      eventBus.emit("filesystem:fileDeleted", { entry: { ...item, parentId: null }, oldPath: item.path, permanent: true });
    }
    return { removed: subtree.length, items };
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
  // Backup support
  // ---------------------------------------------------------------

  /**
   * Every entry at or below `path`, parents before children, as copies
   * (file content included: strings for text, Blobs for binary data).
   * Used by the backup service.
   * @param {string} [path]
   * @returns {Promise<object[]>}
   * @throws {VFSError} NOT_FOUND
   */
  async exportEntries(path = "/") {
    await this.init();
    const root = await this._getEntryOrThrow(path);
    const subtree = await storageAdapter.getSubtree(root.id, { includeRoot: true });
    return subtree.map((entry) => ({ ...entry }));
  }

  /**
   * Add the entries of a folder backup under `destinationPath`, in one
   * transaction, without touching anything that exists: the backed-up
   * folder arrives as a new folder (numbered if its name is taken), with
   * fresh ids and its original timestamps.
   * @param {string} destinationPath - Folder to restore into (not in Trash).
   * @param {object[]} entries - Parents first; entries[0] is the backed-up folder.
   * @returns {Promise<object>} The new top-level folder.
   * @throws {VFSError} NOT_FOUND, NOT_A_FOLDER, INVALID_PATH, INVALID_NAME, INVALID_BACKUP, QUOTA_EXCEEDED
   */
  async importEntries(destinationPath, entries) {
    await this.init();
    const destination = await this._getEntryOrThrow(destinationPath);
    validate.assertIsFolder(destination);
    if (isTrashPath(destination.path)) throw new VFSError("INVALID_PATH", "Choose a folder outside Trash to restore to");
    if (!Array.isArray(entries) || entries.length === 0 || entries[0].type !== "folder") {
      throw new VFSError("INVALID_BACKUP", "The backup has no folder to restore");
    }

    const [top, ...rest] = entries;
    const topName = top.path === "/" ? "Restored files" : top.name;
    validate.validateName(topName);
    for (const entry of rest) validate.validateName(entry.name);
    const siblings = await storageAdapter.getChildren(destination.id);
    const finalName = dedupeName(topName, siblings);

    const created = [];
    const copyOf = new Map();
    const make = (source, parentId, parentPath, name) => {
      const params = { id: createId(), name, parentId, path: joinChild(parentPath, name), hidden: source.hidden === true, favorite: source.favorite === true };
      const entry =
        source.type === "folder"
          ? createDirectoryEntry(params)
          : createFileEntry({ ...params, content: source.content ?? null, size: source.size, readOnly: source.readOnly === true });
      if (Number.isFinite(source.createdAt)) entry.createdAt = source.createdAt;
      if (Number.isFinite(source.modifiedAt)) entry.modifiedAt = source.modifiedAt;
      created.push(entry);
      copyOf.set(source.id, entry);
      return entry;
    };
    const root = make(top, destination.id, destination.path, finalName);
    for (const entry of rest) {
      const parent = copyOf.get(entry.parentId);
      if (!parent || parent.type !== "folder") throw new VFSError("INVALID_BACKUP", `"${entry.path}" has no parent folder in the backup`);
      make(entry, parent.id, parent.path, entry.name);
    }
    await storageAdapter.putMany(created);

    eventBus.emit("filesystem:folderCreated", { entry: { ...root } });
    return { ...root };
  }

  /**
   * Replace the entire file system with `entries` (a full backup), in
   * one transaction: if anything fails, the current contents remain.
   * The entries are checked first: one root, unique ids and paths,
   * every parent present and a folder, and every path equal to its
   * parent's path plus its name.
   * @param {object[]} entries
   * @returns {Promise<void>}
   * @throws {VFSError} INVALID_BACKUP, QUOTA_EXCEEDED, STORAGE_ERROR
   */
  async replaceAll(entries) {
    await this.init();
    assertConsistentTree(entries);
    await storageAdapter.replaceAll(entries);
    this._ready = null;
    await this.init();
    eventBus.emit("filesystem:replaced", {});
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

  /** @returns {Promise<object>} The Trash folder entry (re-created if missing). */
  async _getTrash() {
    const trash = await storageAdapter.getByPath(TRASH_PATH);
    if (trash) return trash;
    const created = createDirectoryEntry({ id: createId(), name: "Trash", parentId: ROOT_ID, path: TRASH_PATH, system: true });
    await storageAdapter.put(created);
    return created;
  }

  /**
   * The folder at `path`, creating it (and any missing parents) if needed.
   * @param {string} path - Normalized absolute path.
   * @returns {Promise<object>}
   * @throws {VFSError} NOT_A_FOLDER, INVALID_NAME
   */
  async _ensureFolder(path) {
    const existing = await storageAdapter.getByPath(path);
    if (existing) {
      validate.assertIsFolder(existing);
      return existing;
    }
    const parentPath = pathResolver.getParentPath(path);
    await this._ensureFolder(parentPath);
    await this.createFolder(path);
    return storageAdapter.getByPath(path);
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
        `"${entry.path}" is a binary .${entry.extension} file; read it with readBinary()`
      );
    }
  }

  /**
   * The descendants of a folder whose path changes from oldPrefix to
   * newPrefix, already updated (not yet stored) — a descendant's path
   * always starts with its folder's path, so this is a single pass
   * over the subtree.
   * @param {string} folderId
   * @param {string} oldPrefix
   * @param {string} newPrefix
   * @param {{touch?: boolean}} [options] - touch: false keeps modification times (restore).
   * @returns {Promise<Array<{entry: object, oldPath: string}>>}
   */
  async _retargetedDescendants(folderId, oldPrefix, newPrefix, { touch = true } = {}) {
    const descendants = await storageAdapter.getSubtree(folderId, { includeRoot: false });
    const now = Date.now();
    return descendants.map((descendant) => {
      const oldPath = descendant.path;
      descendant.path = newPrefix + descendant.path.slice(oldPrefix.length);
      if (touch) descendant.modifiedAt = now;
      return { entry: descendant, oldPath };
    });
  }

  /**
   * New entries (fresh ids) copying `sourceEntry` and its subtree under
   * a new parent, parents first.
   * @param {object} sourceEntry
   * @param {string} newParentId
   * @param {string} newParentPath
   * @param {string} nameToUse - Name of the top-level copy.
   * @returns {Promise<object[]>}
   */
  async _buildCopies(sourceEntry, newParentId, newParentPath, nameToUse) {
    const copies = [];
    const copyOne = (source, parentId, parentPath, name) => {
      const path = joinChild(parentPath, name);
      const params = { id: createId(), name, parentId, path, hidden: source.hidden, favorite: source.favorite };
      const copy = isFolder(source)
        ? createDirectoryEntry(params)
        : createFileEntry({ ...params, content: source.content, size: source.size, readOnly: source.readOnly });
      copies.push(copy);
      return copy;
    };
    const top = copyOne(sourceEntry, newParentId, newParentPath, nameToUse);
    if (isFolder(sourceEntry)) {
      // Map each source folder id to its copy, then walk the subtree breadth-first.
      const copyOf = new Map([[sourceEntry.id, top]]);
      const descendants = await storageAdapter.getSubtree(sourceEntry.id, { includeRoot: false });
      for (const descendant of descendants) {
        const parentCopy = copyOf.get(descendant.parentId);
        const copy = copyOne(descendant, parentCopy.id, parentCopy.path, descendant.name);
        if (isFolder(descendant)) copyOf.set(descendant.id, copy);
      }
    }
    return copies;
  }
}

/**
 * @param {string} parentPath
 * @param {string} name
 * @returns {string}
 */
function joinChild(parentPath, name) {
  return parentPath === "/" ? `/${name}` : `${parentPath}/${name}`;
}

/**
 * @param {object} entry
 * @returns {void}
 */
function stripTrashFields(entry) {
  for (const field of TRASH_FIELDS) delete entry[field];
}

/**
 * @param {string} name
 * @param {object[]} siblings
 * @returns {string} `name` if it's free, otherwise "name (1)", "name (2)", ... with the extension preserved.
 */
function dedupeName(name, siblings) {
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

/**
 * Structural check for a complete set of entries (a full backup).
 * @param {object[]} entries
 * @returns {void}
 * @throws {VFSError} INVALID_BACKUP
 */
export function assertConsistentTree(entries) {
  const fail = (message) => {
    throw new VFSError("INVALID_BACKUP", message);
  };
  if (!Array.isArray(entries) || entries.length === 0) fail("The backup contains no files or folders");
  const byId = new Map();
  const paths = new Set();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") fail("The backup contains an entry that isn't an object");
    if (typeof entry.id !== "string" || !entry.id) fail("An entry has no id");
    if (byId.has(entry.id)) fail(`Two entries share the id "${entry.id}"`);
    if (entry.type !== "file" && entry.type !== "folder") fail(`"${entry.path}" has an unknown type`);
    if (typeof entry.path !== "string" || !entry.path.startsWith("/")) fail(`An entry has an invalid path: ${String(entry.path)}`);
    const lower = entry.path.toLowerCase();
    if (paths.has(lower)) fail(`Two entries share the path "${entry.path}"`);
    paths.add(lower);
    byId.set(entry.id, entry);
  }
  const root = byId.get(ROOT_ID);
  if (!root || root.path !== "/" || root.type !== "folder" || root.parentId !== null) fail("The backup has no root folder");
  for (const entry of entries) {
    if (entry.id === ROOT_ID) continue;
    const parent = byId.get(entry.parentId);
    if (!parent) fail(`"${entry.path}" has no parent folder in the backup`);
    if (parent.type !== "folder") fail(`"${entry.path}" is inside a file`);
    if (entry.path !== joinChild(parent.path, entry.name)) fail(`"${entry.path}" doesn't match its folder and name`);
    if (entry.type === "file" && entry.content !== null && typeof entry.content !== "string" && !(entry.content instanceof Blob)) {
      fail(`"${entry.path}" has content of an unsupported type`);
    }
  }
}

/**
 * Singleton VFS shared by every app that needs storage. Nothing else
 * in BrowserOS should construct a VirtualFileSystem of its own.
 * @type {VirtualFileSystem}
 */
export const vfs = new VirtualFileSystem();
