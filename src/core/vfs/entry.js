/**
 * @file FileEntry / DirectoryEntry — the metadata shape every item in
 * the Virtual File System is made of, plus small helpers for
 * constructing and identifying them.
 *
 * Deliberately plain data objects rather than ES classes: they're
 * stored via IndexedDB's structured clone, read back on every boot,
 * and passed across the EventBus — a plain object needs no special
 * handling anywhere in that chain, while a class instance would.
 */

import { getExtension } from "./pathResolver.js";

/**
 * Extensions this step treats as "metadata only" per the spec: their
 * content is never read or written through the VFS, only their
 * entry metadata (name, size, timestamps, etc.) is tracked. Adding a
 * new metadata-only type later is a one-line change here.
 * @type {ReadonlySet<string>}
 */
const BINARY_EXTENSIONS = new Set(["png", "jpg", "jpeg"]);

/**
 * @param {string|null} extension
 * @returns {boolean}
 */
export function isBinaryExtension(extension) {
  return extension !== null && BINARY_EXTENSIONS.has(extension);
}

/**
 * @returns {string} A new unique id.
 */
export function createId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Fallback for environments without crypto.randomUUID (older
  // browsers); collision odds are negligible for a single-origin,
  // client-side file system.
  return `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/**
 * @param {object} params
 * @param {string} params.id
 * @param {string} params.name
 * @param {string} params.parentId
 * @param {string} params.path
 * @param {boolean} [params.hidden]
 * @param {boolean} [params.readOnly]
 * @param {boolean} [params.system]
 * @param {boolean} [params.favorite]
 * @returns {object} A new folder entry.
 */
export function createDirectoryEntry(params) {
  const {
    id,
    name,
    parentId,
    path,
    hidden = false,
    readOnly = false,
    system = false,
    favorite = false,
  } = params;
  const now = Date.now();
  return {
    id,
    name,
    parentId,
    path,
    type: "folder",
    extension: null,
    content: null,
    size: 0,
    createdAt: now,
    modifiedAt: now,
    hidden,
    readOnly,
    system,
    favorite,
  };
}

/**
 * @param {object} params
 * @param {string} params.id
 * @param {string} params.name
 * @param {string} params.parentId
 * @param {string} params.path
 * @param {string|null} [params.content] - Ignored (stored as null) for binary/metadata-only extensions.
 * @param {number} [params.size] - Explicit size override; required for metadata-only types since there's no content to measure.
 * @param {boolean} [params.hidden]
 * @param {boolean} [params.readOnly]
 * @param {boolean} [params.system]
 * @param {boolean} [params.favorite]
 * @returns {object} A new file entry.
 */
export function createFileEntry(params) {
  const {
    id,
    name,
    parentId,
    path,
    content = null,
    size,
    hidden = false,
    readOnly = false,
    system = false,
    favorite = false,
  } = params;
  const now = Date.now();
  const extension = getExtension(name);
  const binary = isBinaryExtension(extension);
  const finalContent = binary ? null : content;
  const finalSize = typeof size === "number" ? size : finalContent !== null ? byteLength(finalContent) : 0;

  return {
    id,
    name,
    parentId,
    path,
    type: "file",
    extension,
    content: finalContent,
    size: finalSize,
    createdAt: now,
    modifiedAt: now,
    hidden,
    readOnly,
    system,
    favorite,
  };
}

/**
 * @param {object} entry
 * @returns {boolean}
 */
export function isFile(entry) {
  return entry.type === "file";
}

/**
 * @param {object} entry
 * @returns {boolean}
 */
export function isFolder(entry) {
  return entry.type === "folder";
}

/**
 * @param {string} str
 * @returns {number}
 */
function byteLength(str) {
  return new TextEncoder().encode(str).length;
}
