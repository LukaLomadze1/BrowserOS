/**
 * @file AppManager — the only module allowed to sit between an
 * Application and WindowManager.
 *
 * Flow: Application → AppManager → WindowManager. Apps describe what
 * they need (content + window options) through `launch()`; AppManager
 * turns that into an actual window and tracks the running instance
 * so later subsystems (Task Manager, Start Menu) have one place to
 * ask "what's running right now?"
 *
 * App code is loaded lazily: `register()` only stores a loader
 * function (typically a dynamic `import()`), which isn't invoked
 * until the app's first launch. Nothing is fetched or executed at
 * boot for apps that haven't been opened yet.
 */

import { eventBus } from "./eventBus.js";

class AppManager {
  /**
   * @param {import("./windowManager.js").WindowManager} windowManager
   */
  constructor(windowManager) {
    this._windowManager = windowManager;
    /** @type {import("./recentFilesService.js").RecentFilesService|null} */
    this._recentFilesService = null;
    /** @type {Map<string, object>} appId -> registration descriptor */
    this._registry = new Map();
    /** @type {Map<string, {appId: string, instance: import("./application.js").Application, launchTime: number}>} windowId -> running entry */
    this._running = new Map();
    /** @type {Map<string, string>} appId -> windowId, for singleInstance apps only */
    this._singleInstanceWindows = new Map();
    this._focusedWindowId = null;
    this._instanceCounter = 0;
  }

  /**
   * Wire the EventBus subscriptions AppManager needs regardless of
   * which apps are registered. Call once during boot.
   * @returns {void}
   */
  init() {
    eventBus.on("window:focused", ({ id }) => this._handleWindowFocused(id));
  }

  /**
   * Give every app instance access to RecentFilesService (alongside
   * `appManager`), the same way vfsOpener uses it — set once during
   * boot, after both AppManager and RecentFilesService exist.
   * @param {import("./recentFilesService.js").RecentFilesService} recentFilesService
   * @returns {void}
   */
  setRecentFilesService(recentFilesService) {
    this._recentFilesService = recentFilesService;
  }

  /**
   * Register an application. This does not load or run any app code.
   * @param {object} descriptor
   * @param {string} descriptor.id - Unique app id.
   * @param {string} descriptor.name - Display name (used as a title/icon fallback).
   * @param {string} [descriptor.icon] - Fallback icon glyph.
   * @param {string} [descriptor.description] - One-line description shown in Start Menu search results.
   * @param {string} [descriptor.category] - Grouping such as "Productivity", "Utilities", or "System".
   * @param {boolean} [descriptor.singleInstance=false] - If true, launching an already-running instance focuses it instead of opening a second window.
   * @param {boolean} [descriptor.dynamic=false] - True for on-demand, per-path app ids (`file-explorer:<path>`) registered by vfsOpener for folder windows. These represent "a folder window is open", not "the user picked an application" — StartMenuManager uses isDynamic() to keep such windows out of Recent Applications.
   * @param {() => Promise<{default: typeof import("./application.js").Application}>} descriptor.loader - Dynamic import of the app's module; only called on first launch.
   * @returns {void}
   */
  register(descriptor) {
    if (!descriptor || !descriptor.id || !descriptor.name || typeof descriptor.loader !== "function") {
      throw new Error("[AppManager] register() requires id, name, and a loader() function");
    }
    if (this._registry.has(descriptor.id)) {
      throw new Error(`[AppManager] an application with id "${descriptor.id}" is already registered`);
    }

    this._registry.set(descriptor.id, {
      id: descriptor.id,
      name: descriptor.name,
      icon: descriptor.icon ?? null,
      description: descriptor.description ?? "",
      category: descriptor.category ?? "Applications",
      singleInstance: descriptor.singleInstance ?? false,
      dynamic: descriptor.dynamic ?? false,
      loader: descriptor.loader,
      AppClass: null, // populated on first launch
    });

    eventBus.emit("app:registered", { appId: descriptor.id });
  }

  /**
   * Launch a registered application. Lazily imports its module on
   * first launch; subsequent launches reuse the cached class.
   * @param {string} id
   * @param {object} [options] - Forwarded verbatim to the app's launch(options). Existing apps that declare launch() with no parameters simply ignore it — this is backward compatible by construction.
   * @returns {Promise<import("./application.js").Application>} The running (or newly focused existing) instance.
   */
  async launch(id, options = {}) {
    const descriptor = this._registry.get(id);
    if (!descriptor) {
      throw new Error(`[AppManager] no application registered with id "${id}"`);
    }

    if (descriptor.singleInstance) {
      const existingWindowId = this._singleInstanceWindows.get(id);
      if (existingWindowId && this._running.has(existingWindowId)) {
        this._windowManager.focusWindow(existingWindowId);
        const existing = this._running.get(existingWindowId).instance;
        // Forward the new launch's options so a single-instance app can
        // honor deep links (e.g. Settings opening a specific page)
        // without a second window.
        try {
          existing.onRelaunch(options);
        } catch (error) {
          console.error(`[AppManager] "${id}" failed to handle relaunch options:`, error);
        }
        return existing;
      }
    }

    if (!descriptor.AppClass) {
      const module = await descriptor.loader();
      descriptor.AppClass = module.default;
    }

    const instance = new descriptor.AppClass({
      id: descriptor.id,
      name: descriptor.name,
      icon: descriptor.icon,
      appManager: this,
      recentFilesService: this._recentFilesService,
    });
    const built = instance.launch(options);
    const windowId = descriptor.singleInstance ? `app:${id}` : `app:${id}:${++this._instanceCounter}`;

    this._windowManager.createWindow({
      id: windowId,
      title: built.title ?? descriptor.name,
      icon: built.icon ?? descriptor.icon ?? undefined,
      width: built.width,
      height: built.height,
      minWidth: built.minWidth,
      minHeight: built.minHeight,
      resizable: built.resizable,
      minimizable: built.minimizable,
      maximizable: built.maximizable,
      closable: built.closable,
      content: built.element,
      onDestroy: () => this._handleWindowDestroyed(id, windowId),
    });

    instance.windowId = windowId;
    this._running.set(windowId, { appId: id, instance, launchTime: Date.now() });
    if (descriptor.singleInstance) {
      this._singleInstanceWindows.set(id, windowId);
    }

    eventBus.emit("app:launched", { appId: id, windowId });
    return instance;
  }

  /**
   * @param {string} id
   * @returns {boolean} Whether an app with this id is registered. Used by callers that dynamically register per-path apps (e.g. vfsOpener's `file-explorer:<path>` ids) and need to avoid re-registering on every open.
   */
  isRegistered(id) {
    return this._registry.has(id);
  }

  /**
   * @param {string} id
   * @returns {boolean} Whether this id was registered with `dynamic: true` — a per-path window rather than a real, user-chosen application.
   */
  isDynamic(id) {
    return this._registry.get(id)?.dynamic ?? false;
  }

  /**
   * Close every running window belonging to an application.
   * @param {string} id
   * @returns {void}
   */
  close(id) {
    for (const [windowId, entry] of this._running) {
      if (entry.appId === id) {
        this._windowManager.closeWindow(windowId);
      }
    }
  }

  /**
   * @param {string} windowId
   * @returns {import("./application.js").Application|undefined}
   */
  getInstance(windowId) {
    return this._running.get(windowId)?.instance;
  }

  /**
   * Update a running window's titlebar text. Exists so an app can
   * react to its own underlying file being renamed (e.g. Notes,
   * Explorer) without ever holding a WindowManager reference itself —
   * the same reasoning as every other AppManager-mediated capability.
   * @param {string} windowId
   * @param {string} title
   * @returns {void}
   */
  updateWindowTitle(windowId, title) {
    this._windowManager.updateWindowTitle(windowId, title);
  }

  /**
   * Every registered app's public metadata — id, name, icon — with no
   * internals (loader, cached AppClass) exposed. Used by the Start
   * Menu for pinned tiles, recent items, and search, so it never has
   * to keep its own duplicate list of installed apps.
   * @returns {Array<{id: string, name: string, icon: string|null}>}
   */
  getRegisteredApps() {
    return [...this._registry.values()].map((descriptor) => this._publicMetadata(descriptor));
  }

  /**
   * @param {string} id
   * @returns {{id: string, name: string, icon: string|null, description: string, category: string, singleInstance: boolean, dynamic: boolean}|null}
   *   Public metadata for one registered app, or null. Shell components (Desktop shortcuts, Start Menu) read
   *   names and icons from here rather than keeping their own copies.
   */
  getApp(id) {
    const descriptor = this._registry.get(id);
    return descriptor ? this._publicMetadata(descriptor) : null;
  }

  /**
   * @param {object} descriptor
   * @returns {object} Metadata without internals (loader, cached class).
   */
  _publicMetadata(descriptor) {
    return {
      id: descriptor.id,
      name: descriptor.name,
      icon: descriptor.icon,
      description: descriptor.description,
      category: descriptor.category,
      singleInstance: descriptor.singleInstance,
      dynamic: descriptor.dynamic,
    };
  }

  /**
   * Snapshot of every running app instance, with live minimized state
   * pulled from WindowManager. Intended for the future Task Manager.
   * @returns {Array<{appId: string, windowId: string, launchTime: number, state: "running"|"minimized"}>}
   */
  getRunningApps() {
    return [...this._running.entries()].map(([windowId, entry]) => {
      const windowEntry = this._windowManager.getWindow(windowId);
      const isMinimized = windowEntry ? windowEntry.view.isMinimized() : false;
      return {
        appId: entry.appId,
        windowId,
        launchTime: entry.launchTime,
        state: isMinimized ? "minimized" : "running",
      };
    });
  }

  // ---------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------

  /**
   * @param {string} id - Focused window id.
   * @returns {void}
   */
  _handleWindowFocused(id) {
    if (this._focusedWindowId && this._focusedWindowId !== id) {
      const previous = this._running.get(this._focusedWindowId);
      if (previous) {
        previous.instance.onBlur();
        eventBus.emit("app:blurred", { appId: previous.appId, windowId: this._focusedWindowId });
      }
    }

    const current = this._running.get(id);
    if (!current) return;

    this._focusedWindowId = id;
    current.instance.onFocus();
    eventBus.emit("app:focused", { appId: current.appId, windowId: id });
  }

  /**
   * @param {string} appId
   * @param {string} windowId
   * @returns {void}
   */
  _handleWindowDestroyed(appId, windowId) {
    const entry = this._running.get(windowId);
    if (!entry) return;

    entry.instance.close();
    this._running.delete(windowId);

    if (this._singleInstanceWindows.get(appId) === windowId) {
      this._singleInstanceWindows.delete(appId);
    }
    if (this._focusedWindowId === windowId) {
      this._focusedWindowId = null;
    }

    eventBus.emit("app:closed", { appId, windowId });
  }
}

export { AppManager };
