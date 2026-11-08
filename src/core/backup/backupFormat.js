/**
 * @file The BrowserOS backup file format (version 1): building a backup
 * document and validating one before anything is restored. Pure data
 * handling — no storage access; see backupService.js for that.
 *
 * A backup is one JSON document (UTF-8, extension .json):
 *
 *   {
 *     "format": "browseros-backup",
 *     "formatVersion": 1,
 *     "createdAt": "2026-01-31T12:00:00.000Z",
 *     "browserOS": "1.0.0",                  version that wrote it (informational)
 *     "scope": "full" | "folder",
 *     "root": "/" | "/Documents/Project",    folder the entries were taken from
 *     "counts": { "folders": 9, "files": 42, "bytes": 123456, "storageKeys": 17 },
 *     "checksum": { "algorithm": "SHA-256", "value": "<hex>" } | null,
 *     "entries": [ Entry, ... ],              parents before children; the root folder first
 *     "storage": { "<key>": "<raw JSON text>", ... }   full backups only
 *   }
 *
 *   Entry: { id, parentId, name, path, type: "file"|"folder", size,
 *            createdAt, modifiedAt, hidden, readOnly, system, favorite,
 *            originalPath?, originalParentId?, deletedAt?,          (items in Trash)
 *            content: null
 *                   | { "encoding": "text", "data": "<string>" }
 *                   | { "encoding": "base64", "type": "<MIME>", "data": "<base64>" } }
 *
 * `storage` holds BrowserOS's localStorage entries (settings, histories,
 * preferences) by key without the "browseros:" prefix, as stored.
 *
 * The checksum is the SHA-256 of `JSON.stringify({ entries, storage })`
 * (storage omitted for folder backups) and detects truncated or edited
 * files. It is null when the browser has no Web Crypto (non-secure
 * origins); such backups are still checked structurally.
 *
 * Compatibility: a reader accepts every formatVersion up to its own and
 * refuses newer ones, so a backup is never half-understood.
 */

export const BACKUP_FORMAT_ID = "browseros-backup";
export const BACKUP_FORMAT_VERSION = 1;

/** Entry fields copied into a backup (content is encoded separately). */
const ENTRY_FIELDS = ["id", "parentId", "name", "path", "type", "size", "createdAt", "modifiedAt", "hidden", "readOnly", "system", "favorite", "extension"];
const TRASH_FIELDS = ["originalPath", "originalParentId", "deletedAt"];

export class BackupError extends Error {
  /**
   * @param {"NOT_A_BACKUP"|"NEWER_VERSION"|"DAMAGED"|"INVALID"} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = "BackupError";
    this.code = code;
  }
}

/**
 * Build a backup document.
 * @param {object} input
 * @param {"full"|"folder"} input.scope
 * @param {string} input.root
 * @param {object[]} input.entries - VFS entries, parents first (content: string, Blob, or null).
 * @param {Record<string, string>|null} [input.storage] - Raw localStorage values (full backups).
 * @param {string} input.appVersion
 * @param {Date} [input.now]
 * @returns {Promise<{text: string, counts: {folders: number, files: number, bytes: number, storageKeys: number}}>} The JSON text and what it contains.
 */
export async function buildBackup({ scope, root, entries, storage = null, appVersion, now = new Date() }) {
  const encoded = [];
  let bytes = 0;
  let folders = 0;
  let files = 0;
  for (const entry of entries) {
    const out = {};
    for (const field of ENTRY_FIELDS) {
      if (entry[field] !== undefined) out[field] = entry[field];
    }
    for (const field of TRASH_FIELDS) {
      if (entry[field] !== undefined) out[field] = entry[field];
    }
    if (entry.type === "folder") {
      folders += 1;
      out.content = null;
    } else {
      files += 1;
      out.content = await encodeContent(entry.content);
      // The recorded size always describes the content in the backup, so
      // restoring can tell a damaged file from an intact one.
      if (typeof entry.content === "string") out.size = new TextEncoder().encode(entry.content).length;
      else if (entry.content instanceof Blob) out.size = entry.content.size;
      bytes += Number.isFinite(out.size) ? out.size : 0;
    }
    encoded.push(out);
  }
  const payload = scope === "full" ? { entries: encoded, storage: storage ?? {} } : { entries: encoded };
  const checksum = await sha256Hex(JSON.stringify(payload));
  const document = {
    format: BACKUP_FORMAT_ID,
    formatVersion: BACKUP_FORMAT_VERSION,
    createdAt: now.toISOString(),
    browserOS: appVersion,
    scope,
    root,
    counts: { folders, files, bytes, storageKeys: scope === "full" ? Object.keys(storage ?? {}).length : 0 },
    checksum: checksum ? { algorithm: "SHA-256", value: checksum } : null,
    ...payload,
  };
  return { text: JSON.stringify(document), counts: document.counts };
}

/**
 * @typedef {object} ParsedBackup
 * @property {"full"|"folder"} scope
 * @property {string} root
 * @property {string} createdAt
 * @property {string} browserOS
 * @property {number} formatVersion
 * @property {{folders: number, files: number, bytes: number, storageKeys: number}} counts
 * @property {boolean} checksumVerified - False when the backup has no checksum (or the browser can't compute one).
 * @property {object[]} entries - Ready-to-store entries (content as string, Blob, or null).
 * @property {Record<string, string>} storage
 */

/**
 * Validate a backup completely and decode it. Nothing is restored here;
 * a backup that fails any check is rejected as a whole.
 * @param {string} text
 * @returns {Promise<ParsedBackup>}
 * @throws {BackupError}
 */
export async function parseBackup(text) {
  let document;
  try {
    document = JSON.parse(text);
  } catch {
    throw new BackupError("NOT_A_BACKUP", "This file isn't a BrowserOS backup: it isn't valid JSON, or it was cut off.");
  }
  if (!document || typeof document !== "object" || document.format !== BACKUP_FORMAT_ID) {
    throw new BackupError("NOT_A_BACKUP", "This file isn't a BrowserOS backup.");
  }
  if (!Number.isInteger(document.formatVersion) || document.formatVersion < 1) {
    throw new BackupError("INVALID", "The backup's format version is missing or invalid.");
  }
  if (document.formatVersion > BACKUP_FORMAT_VERSION) {
    throw new BackupError("NEWER_VERSION", `This backup was made by a newer version of BrowserOS (format ${document.formatVersion}); this version reads format ${BACKUP_FORMAT_VERSION}.`);
  }
  if (document.scope !== "full" && document.scope !== "folder") {
    throw new BackupError("INVALID", "The backup doesn't say whether it is a full or a folder backup.");
  }
  if (typeof document.root !== "string" || !document.root.startsWith("/")) {
    throw new BackupError("INVALID", "The backup's root folder is missing.");
  }
  if (!Array.isArray(document.entries) || document.entries.length === 0) {
    throw new BackupError("INVALID", "The backup contains no files or folders.");
  }
  const storage = document.scope === "full" ? document.storage : {};
  if (document.scope === "full") {
    if (!storage || typeof storage !== "object" || Array.isArray(storage)) throw new BackupError("INVALID", "The backup's settings section is missing.");
    for (const [key, value] of Object.entries(storage)) {
      if (typeof value !== "string") throw new BackupError("INVALID", `The stored value "${key}" isn't text.`);
    }
  }

  let checksumVerified = false;
  if (document.checksum !== null && document.checksum !== undefined) {
    if (document.checksum.algorithm !== "SHA-256" || typeof document.checksum.value !== "string") {
      throw new BackupError("INVALID", "The backup's checksum is in an unknown form.");
    }
    const payload = document.scope === "full" ? { entries: document.entries, storage } : { entries: document.entries };
    const actual = await sha256Hex(JSON.stringify(payload));
    if (actual !== null) {
      if (actual !== document.checksum.value) {
        throw new BackupError("DAMAGED", "The backup is damaged: its contents don't match its checksum, so it was changed or only partly saved.");
      }
      checksumVerified = true;
    }
  }

  const entries = document.entries.map((entry, index) => decodeEntry(entry, index));
  assertSubtree(entries, document.root, document.scope);

  const counts = {
    folders: entries.filter((entry) => entry.type === "folder").length,
    files: entries.filter((entry) => entry.type === "file").length,
    bytes: entries.reduce((sum, entry) => sum + (entry.type === "file" && Number.isFinite(entry.size) ? entry.size : 0), 0),
    storageKeys: Object.keys(storage).length,
  };
  return {
    scope: document.scope,
    root: document.root,
    createdAt: typeof document.createdAt === "string" ? document.createdAt : "",
    browserOS: typeof document.browserOS === "string" ? document.browserOS : "unknown",
    formatVersion: document.formatVersion,
    counts,
    checksumVerified,
    entries,
    storage: { ...storage },
  };
}

// -----------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------

/**
 * @param {string|Blob|null|undefined} content
 * @returns {Promise<object|null>}
 */
async function encodeContent(content) {
  if (typeof content === "string") return { encoding: "text", data: content };
  if (content instanceof Blob) return { encoding: "base64", type: content.type || "application/octet-stream", data: await blobToBase64(content) };
  return null;
}

/**
 * @param {object} raw
 * @param {number} index
 * @returns {object}
 * @throws {BackupError}
 */
function decodeEntry(raw, index) {
  const where = typeof raw?.path === "string" ? `"${raw.path}"` : `entry ${index + 1}`;
  const invalid = (detail) => new BackupError("INVALID", `The backup is invalid: ${where} ${detail}.`);
  if (!raw || typeof raw !== "object") throw invalid("isn't an object");
  if (typeof raw.id !== "string" || !raw.id) throw invalid("has no id");
  if (raw.type !== "file" && raw.type !== "folder") throw invalid("has an unknown type");
  if (typeof raw.path !== "string" || !raw.path.startsWith("/")) throw invalid("has no valid path");
  if (typeof raw.name !== "string" || !raw.name) throw invalid("has no name");
  if (raw.parentId !== null && typeof raw.parentId !== "string") throw invalid("has an invalid parent");

  const entry = {
    id: raw.id,
    parentId: raw.parentId,
    name: raw.name,
    path: raw.path,
    type: raw.type,
    extension: raw.type === "file" ? extensionOf(raw.name) : null,
    content: null,
    size: Number.isFinite(raw.size) && raw.size >= 0 ? raw.size : 0,
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
    modifiedAt: Number.isFinite(raw.modifiedAt) ? raw.modifiedAt : Date.now(),
    hidden: raw.hidden === true,
    readOnly: raw.readOnly === true,
    system: raw.system === true,
    favorite: raw.favorite === true,
  };
  if (typeof raw.originalPath === "string") entry.originalPath = raw.originalPath;
  if (typeof raw.originalParentId === "string") entry.originalParentId = raw.originalParentId;
  if (Number.isFinite(raw.deletedAt)) entry.deletedAt = raw.deletedAt;

  const content = raw.content;
  if (raw.type === "file" && content !== null && content !== undefined) {
    if (content.encoding === "text" && typeof content.data === "string") {
      entry.content = content.data;
      const size = new TextEncoder().encode(content.data).length;
      if (size !== entry.size) throw new BackupError("DAMAGED", `The backup is damaged: ${where} is ${size} bytes but should be ${entry.size}.`);
    } else if (content.encoding === "base64" && typeof content.data === "string") {
      let bytes;
      try {
        bytes = base64ToBytes(content.data);
      } catch {
        throw new BackupError("DAMAGED", `The backup is damaged: the data of ${where} can't be decoded.`);
      }
      if (bytes.length !== entry.size) throw new BackupError("DAMAGED", `The backup is damaged: ${where} is ${bytes.length} bytes but should be ${entry.size}.`);
      entry.content = new Blob([bytes], { type: typeof content.type === "string" ? content.type : "application/octet-stream" });
    } else {
      throw invalid("has content in an unknown encoding");
    }
  }
  return entry;
}

/**
 * Every entry must sit under the backup's root, with its parent present
 * (parents first), and paths must match parent path + name.
 * @param {object[]} entries
 * @param {string} root
 * @param {"full"|"folder"} scope
 * @returns {void}
 * @throws {BackupError}
 */
function assertSubtree(entries, root, scope) {
  const byId = new Map();
  const paths = new Set();
  const first = entries[0];
  if (first.path !== root || first.type !== "folder") {
    throw new BackupError("INVALID", "The backup is invalid: it doesn't start with its root folder.");
  }
  if (scope === "full" && (root !== "/" || first.parentId !== null)) {
    throw new BackupError("INVALID", "The backup is invalid: a full backup must start at the root folder.");
  }
  for (const [index, entry] of entries.entries()) {
    if (byId.has(entry.id)) throw new BackupError("INVALID", `The backup is invalid: two entries share the id "${entry.id}".`);
    const lower = entry.path.toLowerCase();
    if (paths.has(lower)) throw new BackupError("INVALID", `The backup is invalid: two entries share the path "${entry.path}".`);
    if (index > 0) {
      const parent = byId.get(entry.parentId);
      if (!parent || parent.type !== "folder") throw new BackupError("INVALID", `The backup is invalid: "${entry.path}" has no parent folder before it.`);
      const expected = parent.path === "/" ? `/${entry.name}` : `${parent.path}/${entry.name}`;
      if (entry.path !== expected) throw new BackupError("INVALID", `The backup is invalid: "${entry.path}" doesn't match its folder and name.`);
    }
    byId.set(entry.id, entry);
    paths.add(lower);
  }
}

/**
 * @param {string} name
 * @returns {string|null}
 */
function extensionOf(name) {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return null;
  return name.slice(dot + 1).toLowerCase();
}

/**
 * @param {Blob} blob
 * @returns {Promise<string>}
 */
async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * @param {string} base64
 * @returns {Uint8Array}
 */
function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * @param {string} text
 * @returns {Promise<string|null>} Hex digest, or null without Web Crypto.
 */
async function sha256Hex(text) {
  if (typeof crypto === "undefined" || !crypto.subtle?.digest) return null;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
