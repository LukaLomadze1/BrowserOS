/**
 * @file ValidationService — every rule from the spec's Validation
 * section, as small pure functions. Each takes already-fetched data
 * (entries, sibling lists) rather than reaching into storage itself,
 * so VirtualFileSystem stays the only place that decides *when* to
 * validate, while this file stays the only place that decides *what
 * counts as valid*.
 */

import { VFSError } from "./vfsError.js";

const INVALID_NAME_CHARS = /[/\\:*?"<>|]/;

/**
 * @param {string} name
 * @returns {void}
 * @throws {VFSError}
 */
export function validateName(name) {
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new VFSError("INVALID_NAME", "Name must not be empty");
  }
  if (name === "." || name === "..") {
    throw new VFSError("INVALID_NAME", `"${name}" is not a valid name`);
  }
  if (INVALID_NAME_CHARS.test(name)) {
    throw new VFSError("INVALID_NAME", `Name "${name}" contains invalid characters`);
  }
}

/**
 * Case-insensitive duplicate check, matching how the default folder
 * names (and most real desktop OS file systems) treat uniqueness.
 * @param {object[]} siblings
 * @param {string} name
 * @param {string|null} [excludeId] - Pass the entry's own id when renaming/moving-in-place, so it doesn't collide with itself.
 * @returns {void}
 * @throws {VFSError}
 */
export function assertNoDuplicateSibling(siblings, name, excludeId = null) {
  const lowerName = name.toLowerCase();
  const clash = siblings.find((entry) => entry.id !== excludeId && entry.name.toLowerCase() === lowerName);
  if (clash) {
    throw new VFSError("ALREADY_EXISTS", `"${name}" already exists in this folder`);
  }
}

/**
 * @param {object|undefined} entry
 * @returns {void}
 * @throws {VFSError}
 */
export function assertIsFolder(entry) {
  if (!entry || entry.type !== "folder") {
    throw new VFSError("NOT_A_FOLDER", `"${entry ? entry.path : "(unknown)"}" is not a folder`);
  }
}

/**
 * @param {object|undefined} entry
 * @returns {void}
 * @throws {VFSError}
 */
export function assertIsFile(entry) {
  if (!entry || entry.type !== "file") {
    throw new VFSError("NOT_A_FILE", `"${entry ? entry.path : "(unknown)"}" is not a file`);
  }
}

/**
 * @param {object} entry
 * @returns {void}
 * @throws {VFSError}
 */
export function assertNotReadOnly(entry) {
  if (entry.readOnly) {
    throw new VFSError("READ_ONLY", `"${entry.path}" is read-only`);
  }
}

/**
 * Guards the small set of structural entries (root, Trash, System)
 * against rename/move/delete. Does NOT restrict creating content
 * inside them — Trash specifically must stay writable, since delete()
 * works by moving entries into it.
 * @param {object} entry
 * @returns {void}
 * @throws {VFSError}
 */
export function assertNotProtected(entry) {
  if (entry.system) {
    throw new VFSError("PROTECTED", `"${entry.path}" is a protected system item and cannot be modified`);
  }
}

/**
 * Prevents moving/copying a folder into itself or into one of its
 * own descendants, using the fact that a folder's full path is
 * always a prefix of every descendant's path.
 * @param {object} sourceEntry
 * @param {object} destinationFolder
 * @returns {void}
 * @throws {VFSError}
 */
export function assertNoCircularMove(sourceEntry, destinationFolder) {
  if (destinationFolder.id === sourceEntry.id) {
    throw new VFSError("CIRCULAR_REFERENCE", "Cannot move an item into itself");
  }
  const sourcePrefix = sourceEntry.path === "/" ? "/" : `${sourceEntry.path}/`;
  if (destinationFolder.path === sourceEntry.path || destinationFolder.path.startsWith(sourcePrefix)) {
    throw new VFSError("CIRCULAR_REFERENCE", "Cannot move a folder into itself or one of its own subfolders");
  }
}
