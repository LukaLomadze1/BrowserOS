/**
 * @file PreviewSession — the live preview of one Code Studio window.
 *
 * A session knows which HTML page is being previewed, builds it (see
 * previewBuilder.js), and hands each build to whichever pane currently
 * hosts the frame: the pane docked in the Code Studio window, or a
 * separate "Preview" window. Only one pane shows a session at a time,
 * so console output is never duplicated.
 *
 * Messages from the frame are accepted only from the frame element the
 * hosting pane created and only with the current build's token; they
 * are reduced to plain data (text, numbers, project paths) before
 * anything else sees them. Nothing in a message can call into
 * BrowserOS: a "navigate" request is honored only for an HTML file
 * inside the project.
 */

import { buildPreview } from "./previewBuilder.js";
import { extname, isInside } from "../project/paths.js";

/** @type {Map<string, PreviewSession>} Sessions by id, so a pop-out window can find its session. */
const SESSIONS = new Map();

/**
 * @param {string} id
 * @returns {PreviewSession|undefined}
 */
export function getPreviewSession(id) {
  return SESSIONS.get(id);
}

export class PreviewSession {
  /**
   * @param {object} config
   * @param {() => string} config.getRoot - Project root ("/"-relative references resolve here).
   * @param {() => string[]} [config.listPages] - HTML pages that can be previewed.
   * @param {import("./previewBuilder.js").PreviewReaders} config.readers
   * @param {(entry: {level: string, text: string, path: string|null, line: number, column: number, runtime: boolean}) => void} config.onConsole
   * @param {(entry: {message: string, path: string|null, line: number, column: number}) => void} config.onRuntimeError
   * @param {() => void} [config.onReload] - A new build is about to load.
   * @param {(title: string) => void} [config.onTitle]
   */
  constructor(config) {
    this.id = `preview-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    this._config = config;
    this._entry = null;
    /** @type {import("./previewBuilder.js").PreviewBuild|null} */
    this._build = null;
    this._error = null;
    this._title = "";
    this._building = null;
    this._queued = false;
    /** @type {Map<string, [number, number]>} entry -> last scroll position */
    this._scroll = new Map();
    /** @type {Set<(event: object) => void>} */
    this._listeners = new Set();
    /** @type {"docked"|"window"} */
    this._host = "docked";
    this._disposed = false;
    SESSIONS.set(this.id, this);
  }

  /** @returns {string} The project root. */
  getRoot() {
    return this._config.getRoot();
  }

  /** @returns {string[]} HTML pages of the project. */
  listPages() {
    return this._config.listPages?.() ?? [];
  }

  /** @returns {string|null} The previewed page. */
  getEntry() {
    return this._entry;
  }

  /**
   * @param {string|null} path
   * @returns {void}
   */
  setEntry(path) {
    if (path === this._entry) return;
    this._entry = path;
    this._emit({ type: "entry", entry: path });
  }

  /** @returns {import("./previewBuilder.js").PreviewBuild|null} */
  getBuild() {
    return this._build;
  }

  /** @returns {string|null} Why the last build failed, if it did. */
  getError() {
    return this._error;
  }

  /** @returns {string} The page's <title>, once loaded. */
  getTitle() {
    return this._title;
  }

  /** @returns {"docked"|"window"} */
  getHost() {
    return this._host;
  }

  /**
   * @param {"docked"|"window"} host
   * @returns {void}
   */
  setHost(host) {
    if (host === this._host) return;
    this._host = host;
    this._emit({ type: "host", host });
  }

  /** @returns {boolean} Whether a build exists or is in progress. */
  isActive() {
    return Boolean(this._build || this._building || this._error);
  }

  /**
   * Whether a change to `path` affects the current page.
   * @param {string} path
   * @returns {boolean}
   */
  uses(path) {
    if (!this._build) return path === this._entry;
    if (this._build.files.includes(path)) return true;
    // A new or renamed file may now satisfy a reference that was missing.
    return this._build.warnings.length > 0;
  }

  /**
   * Build the page again (coalesces concurrent requests).
   * @returns {Promise<void>}
   */
  async rebuild() {
    if (this._disposed) return;
    if (this._building) {
      this._queued = true;
      return this._building;
    }
    this._building = this._doBuild();
    try {
      await this._building;
    } finally {
      this._building = null;
    }
    if (this._queued && !this._disposed) {
      this._queued = false;
      await this.rebuild();
    }
  }

  /** @returns {Promise<void>} */
  async _doBuild() {
    const entry = this._entry;
    if (!entry) {
      this._build = null;
      this._error = "Open an HTML file and select Run to preview it.";
      this._emit({ type: "build", build: null, error: this._error });
      return;
    }
    try {
      const build = await buildPreview({
        entryPath: entry,
        projectRoot: this._config.getRoot(),
        readers: this._config.readers,
        scroll: this._scroll.get(entry) ?? [0, 0],
      });
      if (this._disposed || entry !== this._entry) return;
      this._build = build;
      this._error = null;
      this._title = "";
      this._config.onReload?.();
      for (const warning of build.warnings) {
        this._config.onConsole({ level: "warn", text: warning.message, path: warning.path, line: 0, column: 0, runtime: false });
      }
      this._emit({ type: "build", build, error: null });
    } catch (error) {
      if (this._disposed) return;
      this._build = null;
      this._error = `Couldn't build the preview: ${error.message}`;
      this._emit({ type: "build", build: null, error: this._error });
    }
  }

  /**
   * Handle a message from the frame showing this session. The caller
   * has already checked that it came from its own frame.
   * @param {object} data
   * @returns {void}
   */
  handleFrameMessage(data) {
    const build = this._build;
    if (!build || !data || data.codeStudioPreview !== build.token) return;
    const text = (value, max = 4000) => String(value ?? "").slice(0, max);
    const number = (value) => (Number.isFinite(Number(value)) ? Math.max(0, Math.floor(Number(value))) : 0);
    const projectPath = (value) => {
      const path = typeof value === "string" ? value : null;
      return path && (path === this._entry || isInside(path, this._config.getRoot())) ? path : null;
    };
    switch (data.type) {
      case "console": {
        const level = ["log", "info", "warn", "error", "debug"].includes(data.level) ? data.level : "log";
        const at = data.at && typeof data.at === "object" ? data.at : null;
        this._config.onConsole({
          level,
          text: text(data.text),
          path: at ? projectPath(at.path) : null,
          line: at ? number(at.line) : 0,
          column: at ? number(at.column) : 0,
          runtime: true,
        });
        break;
      }
      case "clear":
        this._emit({ type: "clearConsole" });
        break;
      case "error":
        this._config.onRuntimeError({
          message: text(data.message, 1000),
          path: projectPath(data.path),
          line: number(data.line),
          column: number(data.column),
        });
        break;
      case "navigate": {
        const target = typeof data.path === "string" ? data.path : "";
        const extension = extname(target);
        if ((extension === "html" || extension === "htm") && isInside(target, this._config.getRoot())) {
          if (this._entry) this._scroll.delete(target);
          this.setEntry(target);
          this.rebuild();
        }
        break;
      }
      case "scroll":
        if (this._entry) this._scroll.set(this._entry, [number(data.x), number(data.y)]);
        break;
      case "ready":
        this._title = text(data.title, 200);
        this._emit({ type: "ready", title: this._title });
        this._config.onTitle?.(this._title);
        break;
      default:
        break;
    }
  }

  /**
   * @param {(event: object) => void} listener
   * @returns {() => void}
   */
  subscribe(listener) {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  /**
   * @param {object} event
   * @returns {void}
   */
  _emit(event) {
    for (const listener of [...this._listeners]) {
      try {
        listener(event);
      } catch (error) {
        console.error("[CodeStudio] preview listener failed:", error);
      }
    }
  }

  /** @returns {void} */
  dispose() {
    this._disposed = true;
    this._emit({ type: "disposed" });
    this._listeners.clear();
    SESSIONS.delete(this.id);
  }
}
