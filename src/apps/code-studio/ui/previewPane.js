/**
 * @file The live preview pane: a toolbar and the sandboxed frame that
 * shows a PreviewSession's page.
 *
 * Sandbox: the frame is loaded from `srcdoc` with
 * `sandbox="allow-scripts allow-modals allow-forms"` and nothing else,
 * so the page runs with an opaque origin. It cannot read or change
 * BrowserOS (its DOM, storage, IndexedDB, the VFS, or any service),
 * open pop-ups, or navigate the top-level page; it can only post
 * messages, which the session filters (see previewSession.js).
 *
 * The same pane is used docked inside Code Studio and in the separate
 * Preview window.
 */

import { createElement } from "../../../utils/dom.js";
import { createIconElement } from "../../../utils/icons.js";
import { relativeTo } from "../project/paths.js";

export const PREVIEW_SANDBOX = "allow-scripts allow-modals allow-forms";

export class PreviewPane {
  /**
   * @param {object} config
   * @param {"docked"|"window"} config.mode
   * @param {() => string} config.getRoot
   * @param {() => string[]} config.listPages - HTML files of the project.
   * @param {() => boolean} config.getAutoPreview
   * @param {(value: boolean) => void} config.setAutoPreview
   * @param {() => void} [config.onPopOut]
   * @param {() => void} [config.onDock] - Bring a popped-out preview back.
   * @param {() => void} [config.onClose]
   * @param {() => void} [config.onRun] - Run requested from the toolbar (rebuild with the active file).
   */
  constructor(config) {
    this._config = config;
    /** @type {import("../preview/previewSession.js").PreviewSession|null} */
    this._session = null;
    this._unsubscribe = null;
    this._frame = null;
    this._token = null;
    this._onMessage = (event) => this._handleMessage(event);
    window.addEventListener("message", this._onMessage);
    this._onFullscreenChange = () => this._syncFullscreen();
    document.addEventListener("fullscreenchange", this._onFullscreenChange);
    this._build();
  }

  /** @returns {HTMLElement} */
  getElement() {
    return this._root;
  }

  /**
   * @param {import("../preview/previewSession.js").PreviewSession|null} session
   * @returns {void}
   */
  setSession(session) {
    this._unsubscribe?.();
    this._unsubscribe = null;
    this._session = session;
    if (session) {
      this._unsubscribe = session.subscribe((event) => this._onSessionEvent(event));
    }
    this._renderState();
  }

  /** Refresh the page list (project files changed). */
  refreshPages() {
    this._renderPages();
  }

  /** Update the Auto toggle from the setting. */
  syncAutoPreview() {
    this._auto.setAttribute("aria-pressed", String(this._config.getAutoPreview()));
  }

  /** @returns {void} */
  destroy() {
    this._unsubscribe?.();
    window.removeEventListener("message", this._onMessage);
    document.removeEventListener("fullscreenchange", this._onFullscreenChange);
    if (document.fullscreenElement === this._root) document.exitFullscreen?.().catch(() => {});
    this._clearFrame();
  }

  // ---------------------------------------------------------------

  /** @returns {void} */
  _build() {
    const button = (label, icon, onClick, extraClass = "") =>
      createElement("button", {
        className: `cs-icon-button ${extraClass}`,
        attrs: { type: "button", title: label, "aria-label": label },
        children: [createIconElement(icon)],
        on: { click: onClick },
      });
    this._pages = createElement("select", {
      className: "cs-preview__pages",
      attrs: { "aria-label": "Page to preview" },
      on: {
        change: () => {
          if (!this._session || !this._pages.value) return;
          this._session.setEntry(this._pages.value);
          this._session.rebuild();
        },
      },
    });
    this._auto = createElement("button", {
      className: "cs-text-button cs-preview__auto",
      text: "Auto",
      attrs: { type: "button", title: "Update the preview while typing", "aria-pressed": String(this._config.getAutoPreview()) },
      on: {
        click: () => {
          this._config.setAutoPreview(!this._config.getAutoPreview());
          this.syncAutoPreview();
        },
      },
    });
    const tools = [
      button("Run (Ctrl + Enter)", "icon:play", () => (this._config.onRun ? this._config.onRun() : this._session?.rebuild())),
      button("Refresh", "icon:reload", () => this._session?.rebuild()),
      this._pages,
      this._auto,
      button("Fullscreen", "icon:maximize", () => this._toggleFullscreen()),
    ];
    if (this._config.mode === "docked") {
      tools.push(button("Open in a separate window", "icon:external", () => this._config.onPopOut?.()));
      tools.push(button("Close preview", "icon:close", () => this._config.onClose?.()));
    }
    this._status = createElement("span", { className: "cs-preview__status", attrs: { role: "status", "aria-live": "polite" } });
    this._toolbar = createElement("div", { className: "cs-preview__toolbar", attrs: { role: "toolbar", "aria-label": "Preview" }, children: [...tools, this._status] });
    this._message = createElement("div", { className: "cs-preview__message" });
    this._stage = createElement("div", { className: "cs-preview__stage", children: [this._message] });
    this._root = createElement("section", { className: `cs-preview cs-preview--${this._config.mode}`, attrs: { "aria-label": "Live preview" }, children: [this._toolbar, this._stage] });
    this._root.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this._root.classList.contains("cs-preview--overlay")) {
        e.preventDefault();
        this._toggleFullscreen();
      }
    });
  }

  /** @returns {void} */
  _renderPages() {
    const pages = this._config.listPages();
    const entry = this._session?.getEntry() ?? null;
    const root = this._config.getRoot();
    const options = pages.map((path) => createElement("option", { text: relativeTo(path, root), attrs: { value: path } }));
    if (entry && !pages.includes(entry)) options.unshift(createElement("option", { text: relativeTo(entry, root), attrs: { value: entry } }));
    if (!options.length) options.push(createElement("option", { text: "No HTML pages", attrs: { value: "" } }));
    this._pages.replaceChildren(...options);
    this._pages.value = entry ?? "";
    this._pages.disabled = !pages.length && !entry;
  }

  /**
   * @param {object} event
   * @returns {void}
   */
  _onSessionEvent(event) {
    if (event.type === "build" || event.type === "host" || event.type === "entry" || event.type === "disposed") this._renderState();
    else if (event.type === "ready") this._status.textContent = event.title ? event.title : "";
  }

  /** @returns {void} */
  _renderState() {
    this._renderPages();
    const session = this._session;
    if (!session) {
      this._showMessage(this._config.mode === "window" ? "This preview is no longer connected to a Code Studio window." : "No preview.");
      return;
    }
    if (session.getHost() !== this._config.mode) {
      // The other pane shows this session.
      this._showMessage("The preview is open in a separate window.", this._config.mode === "docked" ? { label: "Show here", action: () => this._config.onDock?.() } : null);
      return;
    }
    const error = session.getError();
    if (error) {
      this._showMessage(error);
      return;
    }
    const build = session.getBuild();
    if (!build) {
      this._showMessage("Select Run to preview the page.");
      return;
    }
    this._load(build);
  }

  /**
   * @param {string} text
   * @param {{label: string, action: () => void}|null} [button]
   * @returns {void}
   */
  _showMessage(text, button = null) {
    this._clearFrame();
    this._status.textContent = "";
    this._message.replaceChildren(createElement("p", { text }));
    if (button) {
      this._message.append(createElement("button", { className: "cs-text-button", text: button.label, attrs: { type: "button" }, on: { click: button.action } }));
    }
    this._message.hidden = false;
  }

  /**
   * @param {import("../preview/previewBuilder.js").PreviewBuild} build
   * @returns {void}
   */
  _load(build) {
    this._message.hidden = true;
    // A fresh frame per build: nothing from the previous page survives.
    this._clearFrame();
    const frame = document.createElement("iframe");
    frame.className = "cs-preview__frame";
    frame.setAttribute("sandbox", PREVIEW_SANDBOX);
    frame.setAttribute("title", "Preview of the page");
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.setAttribute("allow", "");
    frame.srcdoc = build.html;
    this._frame = frame;
    this._token = build.token;
    this._status.textContent = "Loading\u2026";
    this._stage.append(frame);
  }

  /** @returns {void} */
  _clearFrame() {
    if (this._frame) {
      this._frame.remove();
      this._frame = null;
      this._token = null;
    }
  }

  /**
   * @param {MessageEvent} event
   * @returns {void}
   */
  _handleMessage(event) {
    if (!this._frame || event.source !== this._frame.contentWindow) return;
    const data = event.data;
    if (!data || typeof data !== "object" || data.codeStudioPreview !== this._token) return;
    if (data.type === "ready") this._status.textContent = "";
    this._session?.handleFrameMessage(data);
  }

  /** @returns {void} */
  _toggleFullscreen() {
    if (document.fullscreenElement === this._root) {
      document.exitFullscreen?.().catch(() => {});
      return;
    }
    if (this._root.classList.contains("cs-preview--overlay")) {
      this._root.classList.remove("cs-preview--overlay");
      return;
    }
    if (typeof this._root.requestFullscreen === "function") {
      this._root.requestFullscreen().catch(() => this._root.classList.add("cs-preview--overlay"));
    } else {
      this._root.classList.add("cs-preview--overlay");
    }
  }

  /** @returns {void} */
  _syncFullscreen() {
    this._root.classList.toggle("cs-preview--fullscreen", document.fullscreenElement === this._root);
  }
}
