/**
 * @file Base class for every BrowserOS application.
 *
 * Apps never touch WindowManager. AppManager owns that relationship:
 * it calls `launch()` to get this app's window content and desired
 * window options, creates the actual window itself, then drives the
 * app's lifecycle (`close()`, `onFocus()`, `onBlur()`) from there.
 *
 * Apps MAY talk to AppManager directly — "Application → AppManager →
 * WindowManager" was always meant as an allowed chain, not a ban on
 * the first arrow. `this.appManager` exists so an app can open
 * another app (e.g. the Folder Viewer opening a file it contains)
 * without ever reaching for WindowManager itself.
 */

export class Application {
  /**
   * @param {{id: string, name: string, icon?: string, appManager?: import("./appManager.js").AppManager, recentFilesService?: import("./recentFilesService.js").RecentFilesService}} meta - The
   *   registration record AppManager created this instance for.
   */
  constructor(meta) {
    this.id = meta.id;
    this.meta = meta;
    /** @type {import("./appManager.js").AppManager|null} Set by AppManager; lets an app launch other apps without ever touching WindowManager. */
    this.appManager = meta.appManager ?? null;
    /** @type {import("./recentFilesService.js").RecentFilesService|null} Set by AppManager; lets an app record/query recent files (e.g. a Folder Viewer opening one of its children). */
    this.recentFilesService = meta.recentFilesService ?? null;
    /** @type {string|null} Set by AppManager once the window exists. */
    this.windowId = null;
  }

  /**
   * Build this app's window content and describe how its window
   * should be created. Every subclass must implement this.
   * @param {object} [options] - Launch-time parameters forwarded from
   *   `appManager.launch(id, options)` — e.g. `{ path }` for an app
   *   opening a specific VFS file or folder. Apps that don't need any
   *   just omit the parameter; extra arguments are always safe to
   *   ignore in JavaScript.
   * @returns {{
   *   element: HTMLElement,
   *   title?: string,
   *   icon?: string,
   *   width?: number,
   *   height?: number,
   *   minWidth?: number,
   *   minHeight?: number,
   *   resizable?: boolean,
   *   minimizable?: boolean,
   *   maximizable?: boolean,
   *   closable?: boolean
   * }}
   */
  launch(options) {
    throw new Error(`Application "${this.id}" must implement launch()`);
  }

  /**
   * Called by AppManager when a singleInstance app is launched again
   * while already running. The existing window has already been
   * focused; `options` are the new launch's parameters, letting the
   * app navigate to whatever the caller asked for (a deep link)
   * instead of opening a second window. Default: ignore them.
   * @param {object} [options] - Same shape as launch(options).
   * @returns {void}
   */
  onRelaunch(options) {}

  /**
   * Called once by AppManager right before the window is torn down.
   * Subclasses override this to clear timers, remove listeners, and
   * flush any unsaved state.
   * @returns {void}
   */
  close() {}

  /**
   * @returns {string|null} This app's window id, once launched.
   */
  getWindow() {
    return this.windowId;
  }

  /**
   * Called by AppManager whenever this app's window gains focus.
   * @returns {void}
   */
  onFocus() {}

  /**
   * Called by AppManager whenever this app's window loses focus.
   * @returns {void}
   */
  onBlur() {}
}
