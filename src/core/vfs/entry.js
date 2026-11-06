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
 *
 * Windows programs (.exe, .msi) are deliberately not storable:
 * BrowserOS can't run them, and refusing them keeps downloads and
 * imports from collecting executables.
 * @type {ReadonlySet<string>}
 */
const BINARY_EXTENSIONS = new Set([
  // Images
  "png", "jpg", "jpeg", "webp", "gif", "bmp", "ico", "avif", "tif", "tiff",
  // Documents
  "pdf", "docx", "xlsx", "pptx", "odt", "ods", "odp", "epub",
  // Archives and packages
  "zip", "7z", "rar", "gz", "tgz", "tar", "bz2", "xz", "jar", "apk", "deb", "rpm", "dmg", "iso",
  // Audio and video
  "mp3", "wav", "ogg", "oga", "flac", "m4a", "aac", "opus", "mp4", "m4v", "webm", "mov", "mkv", "avi",
  // Fonts and other binary data
  "woff", "woff2", "ttf", "otf", "wasm", "bin", "dat",
]);

/** MIME types for extensions BrowserOS knows how to handle. */
const MIME_TYPES = Object.freeze({
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
  tif: "image/tiff",
  tiff: "image/tiff",
  svg: "image/svg+xml",
  txt: "text/plain",
  md: "text/markdown",
  note: "application/vnd.browseros.note+json",
  json: "application/json",
  csv: "text/csv",
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  js: "text/javascript",
  xml: "application/xml",
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odp: "application/vnd.oasis.opendocument.presentation",
  epub: "application/epub+zip",
  zip: "application/zip",
  "7z": "application/x-7z-compressed",
  rar: "application/vnd.rar",
  gz: "application/gzip",
  tgz: "application/gzip",
  tar: "application/x-tar",
  bz2: "application/x-bzip2",
  xz: "application/x-xz",
  jar: "application/java-archive",
  apk: "application/vnd.android.package-archive",
  deb: "application/vnd.debian.binary-package",
  rpm: "application/x-rpm",
  dmg: "application/x-apple-diskimage",
  iso: "application/x-iso9660-image",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  flac: "audio/flac",
  m4a: "audio/mp4",
  aac: "audio/aac",
  opus: "audio/opus",
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
  avi: "video/x-msvideo",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  wasm: "application/wasm",
  bin: "application/octet-stream",
  dat: "application/octet-stream",
});

/** Preferred extension for a MIME type (first extension listed for it above). */
const EXTENSION_FOR_MIME = Object.freeze(
  Object.entries(MIME_TYPES).reduce((map, [extension, type]) => {
    if (!(type in map)) map[type] = extension;
    return map;
  }, {})
);

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
 * @param {string|null|undefined} mimeType - e.g. "application/pdf; charset=binary".
 * @returns {string|null} A file extension for the type, or null when unknown.
 */
export function getExtensionForMimeType(mimeType) {
  if (typeof mimeType !== "string") return null;
  const type = mimeType.split(";")[0].trim().toLowerCase();
  if (!type || type === "application/octet-stream") return null;
  if (EXTENSION_FOR_MIME[type]) return EXTENSION_FOR_MIME[type];
  if (type.startsWith("text/")) return "txt";
  return null;
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
