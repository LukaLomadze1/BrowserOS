/**
 * @file DownloadService — downloads files from the web into the
 * BrowserOS file system (/Downloads), and keeps the Download Manager's
 * list of downloads.
 *
 * Flow for each download:
 *   1. `download(url)` creates a task ("pending").
 *   2. The file is requested with fetch(); the response streams in
 *      ("downloading"). Progress is reported only when the server sends
 *      a Content-Length; otherwise only the received size is known.
 *      Speed is measured from the bytes actually received.
 *   3. The filename comes from Content-Disposition (when the browser
 *      lets BrowserOS read it), else the URL, else the content type;
 *      a missing extension is derived from the content type.
 *   4. The content is written with the public VFS API ("saving") to
 *      /Downloads, renamed "name (2).ext" when the name is taken.
 *   5. The task becomes "completed" (or "failed" / "cancelled"), and a
 *      notification announces it.
 *
 * Limits of a web page: the request is a normal cross-origin fetch, so
 * a server that doesn't allow it (CORS) can't be downloaded into
 * BrowserOS — the task fails with an explanation and offers the host
 * browser's own download instead (saved outside BrowserOS). Downloads
 * can be cancelled and retried; pausing and resuming isn't offered
 * because fetch can't resume a partial download. A download in progress
 * when BrowserOS closes is marked "interrupted" and can be retried.
 *
 * Runs as the "downloads" background service. Finished downloads are
 * remembered through StorageService ("downloads:history", up to 200);
 * downloads from private Browser windows are not remembered.
 *
 * Events: "downloads:changed" { id, reason }, "downloads:started" { id },
 * "downloads:completed" { id, path }, "downloads:failed" { id, kind }.
 */

import { eventBus } from "../eventBus.js";
import { storage } from "../storage.js";
import { settingsService } from "../settings/settingsService.js";
import { notificationService } from "../notifications/notificationService.js";
import { createId, getExtensionForMimeType, getMimeType, isBinaryExtension } from "../vfs/entry.js";
import { getExtension } from "../vfs/pathResolver.js";

export const DOWNLOADS_FOLDER = "/Downloads";
const HISTORY_KEY = "downloads:history";
const MAX_HISTORY = 200;
const PROGRESS_INTERVAL_MS = 150;
const SPEED_WINDOW_MS = 2000;
const MB = 1024 * 1024;
const TEXT_EXTENSIONS = new Set(["txt", "md", "note", "json", "csv", "svg", "html", "htm", "css", "js", "mjs", "xml", "log", "ini", "yaml", "yml", "toml", "tsv", "rtf"]);
const ACTIVE_STATUSES = new Set(["pending", "downloading", "saving"]);

/**
 * @typedef {object} DownloadRecord
 * @property {string} id
 * @property {string} url
 * @property {string} filename - Display name (final name once saved).
 * @property {string|null} path - VFS path once saved.
 * @property {"pending"|"downloading"|"saving"|"completed"|"failed"|"cancelled"|"interrupted"} status
 * @property {number} receivedBytes
 * @property {number|null} totalBytes - null when the server didn't say.
 * @property {number|null} speed - Bytes per second, while downloading.
 * @property {number} startedAt
 * @property {number|null} completedAt
 * @property {string|null} error
 * @property {"network"|"http"|"too-large"|"unsupported-type"|"storage"|"invalid"|null} errorKind
 * @property {string|null} mimeType
 * @property {string} source - "browser", "terminal", "downloads", …
 * @property {boolean} private
 * @property {number} attempts
 */

class DownloadService {
  constructor() {
    this._vfs = null;
    this._openPath = null;
    /** @type {Map<string, DownloadRecord>} Newest last. */
    this._items = new Map();
    /** @type {Map<string, AbortController>} */
    this._controllers = new Map();
    this._running = false;
    this._loaded = false;
    this._saveTimer = null;
    this._lastProgressEmit = new Map();
  }

  /**
   * @param {{vfs: object, openPath?: (path: string) => Promise<void>}} deps
   * @returns {void}
   */
  configure({ vfs, openPath }) {
    this._vfs = vfs;
    this._openPath = openPath ?? null;
  }

  /** Start the service: load the remembered list. @returns {void} */
  start() {
    if (this._running) return;
    this._load();
    this._running = true;
  }

  /** Stop: downloads in progress are cancelled and marked interrupted. @returns {void} */
  stop() {
    if (!this._running) return;
    this._running = false;
    for (const [id, controller] of this._controllers) {
      const record = this._items.get(id);
      if (record) {
        record.status = "interrupted";
        record.error = "BrowserOS stopped before the download finished.";
        record.speed = null;
      }
      controller.abort();
    }
    this._controllers.clear();
    this._flush();
  }

  /** @returns {{summary: string, timers: number}} */
  getDetails() {
    const active = this.getActiveCount();
    return { summary: `${active} active \u00b7 ${this._items.size} in the list`, timers: this._saveTimer !== null ? 1 : 0 };
  }

  // ---------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------

  /**
   * Start downloading a URL into /Downloads.
   * @param {string} url - An http(s) URL (relative URLs resolve against BrowserOS's own address).
   * @param {{filename?: string, source?: string, private?: boolean}} [options]
   * @returns {string} The download's id.
   */
  download(url, { filename, source = "browser", private: isPrivate = false } = {}) {
    this._load();
    let href;
    try {
      href = new URL(url, window.location.href).href;
      if (!/^https?:/.test(href)) throw new Error("scheme");
    } catch {
      throw new Error("Only web addresses (http or https) can be downloaded");
    }
    const record = {
      id: createId(),
      url: href,
      filename: sanitizeFilename(filename) || nameFromUrl(href) || "download",
      requestedName: sanitizeFilename(filename) || null,
      path: null,
      status: "pending",
      receivedBytes: 0,
      totalBytes: null,
      speed: null,
      startedAt: Date.now(),
      completedAt: null,
      error: null,
      errorKind: null,
      mimeType: null,
      source,
      private: Boolean(isPrivate),
      attempts: 0,
    };
    this._items.set(record.id, record);
    this._changed(record.id, "added");
    this._run(record);
    return record.id;
  }

  /**
   * @param {string} id
   * @returns {void}
   */
  cancel(id) {
    const controller = this._controllers.get(id);
    if (controller) controller.abort();
  }

  /**
   * Download a failed, cancelled, or interrupted item again.
   * @param {string} id
   * @returns {boolean}
   */
  retry(id) {
    const record = this._items.get(id);
    if (!record || ACTIVE_STATUSES.has(record.status) || record.status === "completed") return false;
    // Move to the end: it is the most recent download again.
    this._items.delete(id);
    this._items.set(id, record);
    this._run(record);
    return true;
  }

  /**
   * Remove from the list (the downloaded file is not deleted).
   * @param {string} id
   * @returns {void}
   */
  remove(id) {
    this.cancel(id);
    if (this._items.delete(id)) this._changed(id, "removed");
  }

  /**
   * Remove every finished download (completed, failed, cancelled, interrupted) from the list.
   * @returns {number} How many were removed.
   */
  clearFinished() {
    let removed = 0;
    for (const [id, record] of [...this._items]) {
      if (!ACTIVE_STATUSES.has(record.status)) {
        this._items.delete(id);
        removed += 1;
      }
    }
    if (removed) this._changed(null, "cleared");
    return removed;
  }

  /** @returns {DownloadRecord[]} Newest first. */
  getDownloads() {
    this._load();
    return [...this._items.values()].reverse().map((record) => ({ ...record }));
  }

  /**
   * @param {string} id
   * @returns {DownloadRecord|null}
   */
  getDownload(id) {
    const record = this._items.get(id);
    return record ? { ...record } : null;
  }

  /** @returns {number} */
  getActiveCount() {
    this._load();
    return [...this._items.values()].filter((record) => ACTIVE_STATUSES.has(record.status)).length;
  }

  /**
   * Open a completed download with its default application.
   * @param {string} id
   * @returns {Promise<boolean>} False when the file no longer exists.
   */
  async openFile(id) {
    const record = this._items.get(id);
    if (!record?.path || !this._vfs || !(await this._vfs.exists(record.path))) return false;
    await this._openPath?.(record.path);
    return true;
  }

  /**
   * Open the folder that contains a download (or /Downloads).
   * @param {string} [id]
   * @returns {Promise<void>}
   */
  async showInFolder(id) {
    const record = id ? this._items.get(id) : null;
    const folder = record?.path ? record.path.slice(0, record.path.lastIndexOf("/")) || "/" : DOWNLOADS_FOLDER;
    const target = this._vfs && (await this._vfs.exists(folder)) ? folder : DOWNLOADS_FOLDER;
    await this._openPath?.(target);
  }

  /**
   * @param {string} id
   * @returns {Promise<boolean>} Whether the downloaded file still exists.
   */
  async fileExists(id) {
    const record = this._items.get(id);
    return Boolean(record?.path && this._vfs && (await this._vfs.exists(record.path)));
  }

  /**
   * Hand a URL to the host browser's own download handling. The file is
   * saved by the host browser, outside BrowserOS.
   * @param {string} url
   * @param {string} [filename]
   * @returns {void}
   */
  downloadWithHostBrowser(url, filename) {
    const link = document.createElement("a");
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    if (filename) link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
  }

  // ---------------------------------------------------------------
  // Internal: running a download
  // ---------------------------------------------------------------

  /**
   * @param {DownloadRecord} record
   * @returns {Promise<void>}
   */
  async _run(record) {
    const controller = new AbortController();
    this._controllers.set(record.id, controller);
    Object.assign(record, {
      status: "downloading",
      receivedBytes: 0,
      totalBytes: null,
      speed: null,
      startedAt: Date.now(),
      completedAt: null,
      error: null,
      errorKind: null,
      path: null,
      attempts: record.attempts + 1,
    });
    this._changed(record.id, "started");
    eventBus.emit("downloads:started", Object.freeze({ id: record.id }));

    try {
      if (!this._vfs) throw new DownloadError("storage", "The file system isn't available.");
      let response;
      try {
        response = await fetch(record.url, { signal: controller.signal, redirect: "follow", cache: "no-store" });
      } catch (error) {
        if (controller.signal.aborted) throw error;
        throw new DownloadError(
          "network",
          navigator.onLine === false
            ? "You appear to be offline."
            : "The file couldn't be requested. The server may not allow BrowserOS to download it (cross-origin restriction), or the network request failed."
        );
      }
      if (!response.ok) throw new DownloadError("http", `The server responded with ${response.status}${response.statusText ? ` ${response.statusText}` : ""}.`);

      const maxBytes = (settingsService.isInitialized() ? settingsService.get("downloads.maxSizeMb") : 250) * MB;
      const declared = Number(response.headers.get("content-length"));
      record.totalBytes = Number.isFinite(declared) && declared > 0 ? declared : null;
      if (record.totalBytes !== null && record.totalBytes > maxBytes) {
        throw new DownloadError("too-large", `The file is ${formatSize(record.totalBytes)}; downloads are limited to ${formatSize(maxBytes)} (Settings \u203a Browser).`);
      }
      record.mimeType = response.headers.get("content-type");
      const name = buildFilename({
        requested: record.requestedName,
        disposition: response.headers.get("content-disposition"),
        url: response.url || record.url,
        mimeType: record.mimeType,
      });
      record.filename = name;
      const storageKind = classify(name, record.mimeType);
      if (!storageKind) {
        const extension = getExtension(name);
        throw new DownloadError("unsupported-type", `BrowserOS can't store ${extension ? `.${extension} files` : "this kind of file"}. It can save documents, images, audio, video, archives, and text files.`);
      }
      this._changed(record.id, "progress");

      const blob = await this._readBody(record, response, controller.signal, maxBytes);
      record.status = "saving";
      record.speed = null;
      this._changed(record.id, "saving");

      let content;
      if (storageKind === "binary") {
        content = blob.type ? blob : new Blob([blob], { type: getMimeType(getExtension(name)) });
      } else {
        content = await blob.text();
      }
      if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
      try {
        if (!(await this._vfs.exists(DOWNLOADS_FOLDER))) await this._vfs.createFolder(DOWNLOADS_FOLDER);
        const path = await this._uniquePath(name);
        await this._vfs.createFile(path, content);
        record.path = path;
        record.filename = path.slice(DOWNLOADS_FOLDER.length + 1);
      } catch (error) {
        throw new DownloadError("storage", `The file couldn't be saved: ${error.message}`);
      }

      record.status = "completed";
      record.completedAt = Date.now();
      record.receivedBytes = blob.size;
      if (record.totalBytes === null) record.totalBytes = blob.size;
      this._controllers.delete(record.id);
      this._changed(record.id, "completed");
      eventBus.emit("downloads:completed", Object.freeze({ id: record.id, path: record.path }));
      if (!settingsService.isInitialized() || settingsService.get("downloads.notifyOnComplete")) {
        notificationService.success(`Downloaded \u201c${record.filename}\u201d`, {
          title: `Downloaded \u201c${record.filename}\u201d`,
          message: `${formatSize(blob.size)} \u00b7 saved to ${DOWNLOADS_FOLDER}`,
          source: "downloads",
          icon: "icon:download",
          groupKey: "downloads-completed",
          action: { type: "open", path: record.path },
        });
      }
    } catch (error) {
      this._controllers.delete(record.id);
      record.speed = null;
      if (controller.signal.aborted && !(error instanceof DownloadError)) {
        if (record.status !== "interrupted") {
          record.status = "cancelled";
          record.error = null;
        }
        this._changed(record.id, record.status);
        return;
      }
      record.status = "failed";
      record.errorKind = error instanceof DownloadError ? error.kind : "network";
      record.error = error instanceof DownloadError ? error.message : `The download failed: ${error?.message ?? error}`;
      record.completedAt = Date.now();
      this._changed(record.id, "failed");
      eventBus.emit("downloads:failed", Object.freeze({ id: record.id, kind: record.errorKind }));
      notificationService.error(`Couldn't download \u201c${record.filename}\u201d`, {
        title: `Couldn't download \u201c${record.filename}\u201d`,
        message: record.error,
        source: "downloads",
        icon: "icon:download",
        groupKey: "downloads-failed",
        action: { type: "launch", appId: "downloads", options: { select: record.id } },
      });
    }
  }

  /**
   * Stream the response body, tracking progress and speed.
   * @param {DownloadRecord} record
   * @param {Response} response
   * @param {AbortSignal} signal
   * @param {number} maxBytes
   * @returns {Promise<Blob>}
   */
  async _readBody(record, response, signal, maxBytes) {
    const type = (record.mimeType ?? "").split(";")[0].trim();
    if (!response.body || typeof response.body.getReader !== "function") {
      const blob = await response.blob();
      if (blob.size > maxBytes) throw new DownloadError("too-large", `The file is larger than ${formatSize(maxBytes)}.`);
      record.receivedBytes = blob.size;
      return blob;
    }
    const reader = response.body.getReader();
    const chunks = [];
    const samples = [{ at: performance.now(), bytes: 0 }];
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (signal.aborted) throw new DOMException("Aborted", "AbortError");
        chunks.push(value);
        record.receivedBytes += value.byteLength;
        if (record.receivedBytes > maxBytes) throw new DownloadError("too-large", `The file is larger than ${formatSize(maxBytes)} (Settings \u203a Browser).`);
        // Compressed transfers can report a smaller Content-Length than the data received.
        if (record.totalBytes !== null && record.receivedBytes > record.totalBytes) record.totalBytes = null;
        const now = performance.now();
        samples.push({ at: now, bytes: record.receivedBytes });
        while (samples.length > 2 && now - samples[0].at > SPEED_WINDOW_MS) samples.shift();
        const span = now - samples[0].at;
        record.speed = span >= 250 ? Math.round(((record.receivedBytes - samples[0].bytes) * 1000) / span) : record.speed;
        this._progress(record.id);
      }
    } catch (error) {
      reader.cancel().catch(() => {});
      throw error;
    }
    return new Blob(chunks, type ? { type } : undefined);
  }

  /**
   * @param {string} name
   * @returns {Promise<string>} A path in /Downloads that isn't taken.
   */
  async _uniquePath(name) {
    const dot = name.lastIndexOf(".");
    const base = dot > 0 ? name.slice(0, dot) : name;
    const extension = dot > 0 ? name.slice(dot) : "";
    let candidate = `${DOWNLOADS_FOLDER}/${name}`;
    for (let n = 2; await this._vfs.exists(candidate); n += 1) {
      candidate = `${DOWNLOADS_FOLDER}/${base} (${n})${extension}`;
      if (n > 999) throw new Error("Too many files with this name");
    }
    return candidate;
  }

  // ---------------------------------------------------------------
  // Internal: state
  // ---------------------------------------------------------------

  /**
   * @param {string} id
   * @returns {void}
   */
  _progress(id) {
    const now = performance.now();
    if (now - (this._lastProgressEmit.get(id) ?? 0) < PROGRESS_INTERVAL_MS) return;
    this._lastProgressEmit.set(id, now);
    eventBus.emit("downloads:changed", Object.freeze({ id, reason: "progress" }));
  }

  /**
   * @param {string|null} id
   * @param {string} reason
   * @returns {void}
   */
  _changed(id, reason) {
    if (reason !== "progress") this._scheduleSave();
    eventBus.emit("downloads:changed", Object.freeze({ id, reason }));
  }

  /** @returns {void} */
  _load() {
    if (this._loaded) return;
    this._loaded = true;
    const stored = storage.get(HISTORY_KEY, []);
    if (!Array.isArray(stored)) return;
    for (const item of stored) {
      const record = normalizeStored(item);
      if (record && !this._items.has(record.id)) this._items.set(record.id, record);
    }
  }

  /** @returns {void} */
  _scheduleSave() {
    if (this._saveTimer !== null) return;
    this._saveTimer = window.setTimeout(() => this._flush(), 300);
  }

  /** @returns {void} */
  _flush() {
    if (this._saveTimer !== null) {
      window.clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    if (!this._loaded) return;
    const persisted = [...this._items.values()]
      .filter((record) => !record.private)
      .slice(-MAX_HISTORY)
      .map(({ speed, requestedName, ...record }) =>
        ACTIVE_STATUSES.has(record.status) ? { ...record, status: "interrupted", error: "BrowserOS closed before the download finished." } : record
      );
    storage.set(HISTORY_KEY, persisted);
  }
}

class DownloadError extends Error {
  /**
   * @param {string} kind
   * @param {string} message
   */
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

/**
 * @param {*} item
 * @returns {DownloadRecord|null}
 */
function normalizeStored(item) {
  if (!item || typeof item !== "object" || typeof item.id !== "string" || typeof item.url !== "string") return null;
  const statuses = ["completed", "failed", "cancelled", "interrupted"];
  const status = statuses.includes(item.status) ? item.status : "interrupted";
  return {
    id: item.id,
    url: item.url,
    filename: sanitizeFilename(item.filename) || "download",
    requestedName: null,
    path: typeof item.path === "string" && item.path.startsWith("/") ? item.path : null,
    status,
    receivedBytes: Number.isFinite(item.receivedBytes) ? item.receivedBytes : 0,
    totalBytes: Number.isFinite(item.totalBytes) ? item.totalBytes : null,
    speed: null,
    startedAt: Number.isFinite(item.startedAt) ? item.startedAt : Date.now(),
    completedAt: Number.isFinite(item.completedAt) ? item.completedAt : null,
    error: typeof item.error === "string" ? item.error.slice(0, 400) : status === "interrupted" ? "BrowserOS closed before the download finished." : null,
    errorKind: typeof item.errorKind === "string" ? item.errorKind : null,
    mimeType: typeof item.mimeType === "string" ? item.mimeType : null,
    source: typeof item.source === "string" ? item.source : "browser",
    private: false,
    attempts: Number.isInteger(item.attempts) ? item.attempts : 1,
  };
}

/**
 * Choose the saved file's name.
 * @param {{requested: string|null, disposition: string|null, url: string, mimeType: string|null}} sources
 * @returns {string}
 */
export function buildFilename({ requested, disposition, url, mimeType }) {
  let name = requested || filenameFromDisposition(disposition) || nameFromUrl(url) || "download";
  if (!getExtension(name)) {
    const extension = getExtensionForMimeType(mimeType);
    if (extension) name = `${name}.${extension}`;
  }
  return name;
}

/**
 * @param {string|null} header - A Content-Disposition value.
 * @returns {string|null}
 */
export function filenameFromDisposition(header) {
  if (typeof header !== "string") return null;
  const extended = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(header);
  if (extended) {
    try {
      const decoded = sanitizeFilename(decodeURIComponent(extended[2].trim().replace(/^"|"$/g, "")));
      if (decoded) return decoded;
    } catch {
      /* fall back to the plain parameter */
    }
  }
  const quoted = /filename\s*=\s*"((?:[^"\\]|\\.)*)"/i.exec(header);
  if (quoted) return sanitizeFilename(quoted[1].replace(/\\(.)/g, "$1"));
  const token = /filename\s*=\s*([^;\s]+)/i.exec(header);
  return token ? sanitizeFilename(token[1]) : null;
}

/**
 * @param {string} url
 * @returns {string|null} The last path segment, decoded.
 */
export function nameFromUrl(url) {
  try {
    const parsed = new URL(url);
    const segment = parsed.pathname.split("/").filter(Boolean).pop();
    if (!segment) return sanitizeFilename(parsed.hostname.replace(/^www\./, "")) || null;
    let decoded = segment;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      /* keep encoded */
    }
    return sanitizeFilename(decoded);
  } catch {
    return null;
  }
}

/**
 * Make a name safe for the VFS: no path separators or reserved
 * characters, no control characters, at most 120 characters.
 * @param {*} name
 * @returns {string}
 */
export function sanitizeFilename(name) {
  if (typeof name !== "string") return "";
  let clean = name
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[/\\:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .replace(/[. ]+$/, "");
  if (clean.length > 120) {
    const dot = clean.lastIndexOf(".");
    const extension = dot > 0 && clean.length - dot <= 10 ? clean.slice(dot) : "";
    clean = clean.slice(0, 120 - extension.length) + extension;
  }
  return clean;
}

/**
 * @param {string} name
 * @param {string|null} mimeType
 * @returns {"binary"|"text"|null} How the VFS stores the file, or null when it can't.
 */
function classify(name, mimeType) {
  const extension = getExtension(name);
  if (extension && isBinaryExtension(extension)) return "binary";
  if (extension && TEXT_EXTENSIONS.has(extension)) return "text";
  const type = (mimeType ?? "").split(";")[0].trim().toLowerCase();
  if (type.startsWith("text/") || /(json|xml|javascript)$/.test(type)) return "text";
  return null;
}

/**
 * @param {number} bytes
 * @returns {string}
 */
export function formatSize(bytes) {
  if (!Number.isFinite(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < MB) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * MB) return `${(bytes / MB).toFixed(1)} MB`;
  return `${(bytes / (1024 * MB)).toFixed(2)} GB`;
}

/**
 * Singleton download service.
 * @type {DownloadService}
 */
export const downloadService = new DownloadService();
