/**
 * @file FileExplorerApp — the File Explorer application.
 * Construction/teardown only; all actual
 * behavior lives in ExplorerManager (state/decisions) and
 * ExplorerView (presentation), the same View/Manager split every
 * other window-owning subsystem in BrowserOS follows.
 */

import { Application } from "../../core/application.js";
import { ExplorerManager } from "./explorerManager.js";
import { vfs } from "../../core/vfs/virtualFileSystem.js";
import { clipboardService } from "../../core/clipboardService.js";
import { ensureStylesheet } from "../../utils/loadStylesheet.js";

ensureStylesheet("src/apps/file-explorer/explorer.css");

export default class FileExplorerApp extends Application {
  constructor(meta) {
    super(meta);
    this._manager = null;
  }

  /**
   * @param {{path?: string}} [options]
   * @returns {ReturnType<Application["launch"]>}
   */
  launch(options = {}) {
    this._manager = new ExplorerManager({
      vfs,
      appManager: this.appManager,
      recentFilesService: this.recentFilesService,
      clipboardService,
    });

    // init() is async (it navigates on launch), but AppManager needs
    // the window content synchronously — the manager shows its own
    // loading state until the initial navigation resolves.
    this._manager.init(options.path);

    return {
      element: this._manager.getElement(),
      title: "File Explorer",
      icon: "icon:folder",
      width: 760,
      height: 520,
      minWidth: 480,
      minHeight: 340,
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
}
