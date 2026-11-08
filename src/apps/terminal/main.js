/**
 * @file Terminal — a VFS-backed command line. Construction/teardown
 * only; all real behavior lives in TerminalManager (state/decisions)
 * and TerminalView (presentation), the same split every other
 * window-owning subsystem in BrowserOS follows. Not singleInstance:
 * every launch opens its own independent window, with its own
 * working directory, sharing only the persisted command history.
 */

import { Application } from "../../core/application.js";
import { TerminalManager } from "./terminalManager.js";
import { vfs } from "../../core/vfs/virtualFileSystem.js";
import { ensureStylesheet } from "../../utils/loadStylesheet.js";

ensureStylesheet("src/apps/terminal/terminal.css");

export default class TerminalApp extends Application {
  constructor(meta) {
    super(meta);
    this._manager = null;
  }

  /**
   * @param {{path?: string}} [options]
   * @returns {ReturnType<Application["launch"]>}
   */
  launch(options = {}) {
    this._manager = new TerminalManager({
      vfs,
      appManager: this.appManager,
      recentFilesService: this.recentFilesService,
      initialPath: options.path,
      focusWindow: () => {
        if (this.windowId) this.appManager.focusWindow(this.windowId);
      },
      isActive: () => Boolean(this.windowId) && this.appManager.getFocusedWindowId() === this.windowId,
    });
    this._manager.init();

    return {
      element: this._manager.getElement(),
      title: "Terminal",
      icon: "icon:terminal",
      width: 620,
      height: 420,
      minWidth: 360,
      minHeight: 240,
      resizable: true,
      minimizable: true,
      maximizable: true,
      closable: true,
    };
  }

  /** @returns {void} */
  close() {
    this._manager?.destroy();
  }

  /** @returns {void} */
  onFocus() {
    this._manager?.onFocus();
  }

  /** @returns {void} */
  onBlur() {
    this._manager?.onBlur();
  }
}
