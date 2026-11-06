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
 * Extensions whose content is binary. Their content is stored as a
 * Blob (IndexedDB stores Blobs natively) and is read and written only
 * through the binary API (`vfs.readBinary` / `vfs.writeBinary`); the
 * text API (`vfs.read` / `vfs.write`) refuses them with BINARY_CONTENT.
 * Entries created before binary content was supported have `content:
 * null` (metadata only) and are reported as having no data.
 * @type {ReadonlySet<string>}
 */
const BINARY_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif"]);

/** MIME types for extensions BrowserOS knows how to handle. */
const MIME_TYPES = Object.freeze({
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  svg: "image/svg+xml",
  txt: "text/plain",
  md: "text/markdown",
  note: "application/vnd.browseros.note+json",
  json: "application/json",
  csv: "text/csv",
});

/**
 * @param {string|null} extension
 * @returns {boolean}
 */
export function isBinaryExtension(extension) {
  return extension !== null && BINARY_EXTENSIONS.has(extension);
}

/**
 * @param {string|null} extension
 * @returns {string} The MIME type for an extension, or "application/octet-stream".
 */
export function getMimeType(extension) {
  return (extension && MIME_TYPES[extension]) || "application/octet-stream";
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
 * @param {string|Blob|null} [params.content] - A string for text types; a Blob for binary types (anything else is stored as null, i.e. metadata only).
 * @param {number} [params.size] - Explicit size override; only needed for metadata-only binary entries, since content is measured otherwise.
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
  let finalContent;
  if (binary) {
    finalContent = content instanceof Blob ? content : null;
  } else {
    finalContent = typeof content === "string" ? content : content === null ? null : String(content);
  }
  let finalSize;
  if (finalContent instanceof Blob) {
    finalSize = finalContent.size;
  } else if (typeof size === "number") {
    finalSize = size;
  } else {
    finalSize = typeof finalContent === "string" ? byteLength(finalContent) : 0;
  }

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
