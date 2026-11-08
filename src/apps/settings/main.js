/**
 * @file Settings — the BrowserOS Settings application. Construction,
 * deep links, and teardown only; navigation and page lifecycle live in
 * SettingsManager, presentation in SettingsView, and the pages
 * themselves under ./pages.
 *
 * Registered as singleInstance. Launch options:
 *   appManager.launch("settings", { page: "desktop", anchor: "layout" })
 * open Settings on that category (and section), or, if Settings is
 * already open, focus it and navigate the existing window there (via
 * onRelaunch).
 */

import { Application } from "../../core/application.js";
import { settingsService } from "../../core/settings/settingsService.js";
import { SettingsManager } from "./settingsManager.js";
import { ensureStylesheet } from "../../utils/loadStylesheet.js";

ensureStylesheet("src/apps/settings/settings.css");

export default class SettingsApp extends Application {
  constructor(meta) {
    super(meta);
    this._manager = null;
  }

  /**
   * @param {{page?: string, anchor?: string}} [options]
   * @returns {ReturnType<Application["launch"]>}
   */
  launch(options = {}) {
    // Normally already done during boot; harmless if so, and it keeps
    // Settings working if it is ever launched before boot finishes.
    settingsService.init();

    this._manager = new SettingsManager({
      initialCategory: options.page,
      initialAnchor: options.anchor,
      context: { appManager: this.appManager, recentFilesService: this.recentFilesService },
    });
    this._manager.init();

    return {
      element: this._manager.getElement(),
      title: "Settings",
      icon: "icon:gear",
      width: 900,
      height: 620,
      minWidth: 560,
      minHeight: 420,
      resizable: true,
      minimizable: true,
      maximizable: true,
      closable: true,
    };
  }

  /**
   * @param {{page?: string, anchor?: string}} [options]
   * @returns {void}
   */
  onRelaunch(options = {}) {
    if (options.page) {
      this._manager?.navigate(options.page, { focusPage: true, anchor: options.anchor });
    }
  }

  /** @returns {void} */
  close() {
    this._manager?.destroy();
    this._manager = null;
  }
}
