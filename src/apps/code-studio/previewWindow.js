/**
 * @file The separate Preview window of Code Studio.
 *
 * Opened from a Code Studio window ("Open in a separate window"), it
 * shows that window's PreviewSession in its own BrowserOS window, which
 * can be moved, resized, or maximized independently. Closing it returns
 * the preview to the Code Studio window; showing the preview in the
 * Code Studio window again closes it. If its Code Studio window closes,
 * it says so instead of showing a stale page.
 */

import { Application } from "../../core/application.js";
import { settingsService } from "../../core/settings/settingsService.js";
import { ensureStylesheet } from "../../utils/loadStylesheet.js";
import { createElement } from "../../utils/dom.js";
import { getPreviewSession } from "./preview/previewSession.js";
import { PreviewPane } from "./ui/previewPane.js";

ensureStylesheet("src/apps/code-studio/codeStudio.css");

export default class PreviewWindowApp extends Application {
  constructor(meta) {
    super(meta);
    this.sessionId = null;
    this._session = null;
    this._pane = null;
    this._cleanups = [];
    this._baseTitle = "Preview";
  }

  /**
   * @param {{sessionId?: string, title?: string}} [options]
   * @returns {ReturnType<Application["launch"]>}
   */
  launch(options = {}) {
    this.sessionId = options.sessionId ?? null;
    this._session = this.sessionId ? getPreviewSession(this.sessionId) ?? null : null;
    this._baseTitle = options.title ? `Preview \u2014 ${options.title}` : "Preview";
    const session = this._session;
    this._pane = new PreviewPane({
      mode: "window",
      getRoot: () => session?.getRoot() ?? "/",
      listPages: () => session?.listPages() ?? [],
      getAutoPreview: () => settingsService.get("codeStudio.autoPreview"),
      setAutoPreview: (value) => settingsService.set("codeStudio.autoPreview", value),
      onRun: () => session?.rebuild(),
    });
    this._cleanups.push(settingsService.subscribe("codeStudio.autoPreview", () => this._pane?.syncAutoPreview()));
    if (session) {
      if (session.getHost() !== "window") session.setHost("window");
      this._cleanups.push(
        session.subscribe((event) => {
          if (event.type === "host" && event.host === "docked" && this.windowId) {
            this.appManager?.closeWindow(this.windowId);
          } else if (event.type === "disposed") {
            this._session = null;
            this._pane?.setSession(null);
            this._setTitle(this._baseTitle);
          } else if (event.type === "ready") {
            this._setTitle(event.title ? `${event.title} \u2014 ${this._baseTitle}` : this._baseTitle);
          }
        })
      );
    }
    this._pane.setSession(session);
    const root = createElement("div", { className: "code-studio-preview-window", children: [this._pane.getElement()] });
    return {
      element: root,
      title: this._baseTitle,
      icon: "icon:play",
      width: 820,
      height: 600,
      minWidth: 320,
      minHeight: 240,
    };
  }

  /** @returns {void} */
  close() {
    for (const cleanup of this._cleanups) cleanup();
    this._cleanups = [];
    this._pane?.destroy();
    this._pane = null;
    // The preview goes back to its Code Studio window.
    if (this._session && this._session.getHost() === "window") this._session.setHost("docked");
  }

  /**
   * @param {string} title
   * @returns {void}
   */
  _setTitle(title) {
    if (this.windowId) this.appManager?.updateWindowTitle(this.windowId, title);
  }
}
