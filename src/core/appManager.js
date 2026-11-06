/**
 * @file AppManager — the only module allowed to sit between an
 * Application and WindowManager.
 *
 * Flow: Application → AppManager → WindowManager. Apps describe what
 * they need (content + window options) through `launch()`; AppManager
 * turns that into an actual window and tracks every running instance,
 * so the shell (taskbar, Start Menu, Task Manager) has one place to ask
 * "what's running right now?"
 *
 * Applications and windows: every window has its own Application
 * instance, but windows of the same application form one *running
 * application* — three File Explorer windows are one application with
 * three windows. Per-folder Explorer windows (dynamic ids such as
 * `file-explorer:/Documents`) belong to the "file-explorer" application.
 *
 * Lifecycle guarantees:
 *  - App code is loaded lazily on first launch; a failed load or a
 *    failing `launch()` is reported (`application:crashed`) and leaves
 *    nothing half-created behind.
 *  - Launching a single-instance app while its first launch is still
 *    loading reuses that launch instead of opening a second window.
 *  - Every way a window goes away (close button, keyboard, End task,
 *    restart) runs the instance's `close()` so it can release its
 *    listeners, timers, and other resources.
 *
 * Events (EventBus), in addition to the window-level "app:launched",
 * "app:closed", "app:focused", "app:blurred":
 *  - "application:started"  { appId }            first window of an application opened
 *  - "application:stopped"  { appId }            its last window closed
 *  - "application:focused"  { appId, windowId }
 *  - "application:crashed"  { appId, phase, message }   load or launch failed
 *  - "application:error"    { appId, phase, message }   error recorded for a running application
 *  - "application:restarted" { appId }
 */

import { eventBus } from "./eventBus.js";

const MAX_ERRORS_PER_APP = 10;

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
    /** @type {Map<string, {appId: string, groupId: string, instance: import("./application.js").Application, launchTime: number, options: object, title: string}>} windowId -> running entry */
    this._running = new Map();
    /** @type {Map<string, string>} appId -> windowId, for singleInstance apps only */
    this._singleInstanceWindows = new Map();
    /** @type {Map<string, Promise<object>>} appId -> in-flight launch of a single-instance app */
    this._pendingLaunches = new Map();
    /** @type {Map<string, number>} groupId -> time its first window opened */
    this._appStartTimes = new Map();
    /** @type {Map<string, Array<{message: string, phase: string, at: number}>>} groupId -> recorded errors */
    this._errors = new Map();
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
   * @param {string} [descriptor.icon] - Glyph or built-in "icon:<name>" (see utils/icons.js).
   * @param {string} [descriptor.description] - One-line description shown in Start Menu search results and Task Manager.
   * @param {string} [descriptor.category] - Grouping such as "Productivity", "Utilities", or "System".
   * @param {boolean} [descriptor.singleInstance=false] - If true, launching an already-running instance focuses it instead of opening a second window.
   * @param {boolean} [descriptor.restartable=true] - Whether Task Manager offers Restart.
   * @param {boolean} [descriptor.dynamic=false] - True for on-demand, per-path app ids (`file-explorer:<path>`) registered by vfsOpener for folder windows. These represent "a folder window is open", not "the user picked an application" — StartMenuManager uses isDynamic() to keep such windows out of Recent Applications.
   * @param {string} [descriptor.groupId] - Application these windows belong to (defaults to the part of a dynamic id before ":", else the id).
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

    const dynamic = descriptor.dynamic ?? false;
    this._registry.set(descriptor.id, {
      id: descriptor.id,
      name: descriptor.name,
      icon: descriptor.icon ?? null,
      description: descriptor.description ?? "",
      category: descriptor.category ?? "Applications",
      singleInstance: descriptor.singleInstance ?? false,
      restartable: descriptor.restartable ?? true,
      dynamic,
      groupId: descriptor.groupId ?? (dynamic ? descriptor.id.split(":")[0] : descriptor.id),
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
          this.recordError(descriptor.groupId, error, "relaunch");
        }
        return existing;
      }
      const pending = this._pendingLaunches.get(id);
      if (pending) {
        const instance = await pending;
        try {
          instance.onRelaunch(options);
        } catch (error) {
          this.recordError(descriptor.groupId, error, "relaunch");
        }
        return instance;
      }
      const launch = this._createInstance(descriptor, options);
      this._pendingLaunches.set(id, launch);
      try {
        return await launch;
      } finally {
        this._pendingLaunches.delete(id);
      }
    }

    return this._createInstance(descriptor, options);
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
   * Close every running window belonging to an application (with the
   * normal close animation). Accepts an app id or an application group id.
   * @param {string} id
   * @returns {void}
   */
  close(id) {
    for (const [windowId, entry] of this._running) {
      if (entry.appId === id || entry.groupId === id) {
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
    const entry = this._running.get(windowId);
    if (entry) entry.title = title;
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
   * @returns {{id: string, name: string, icon: string|null, description: string, category: string, singleInstance: boolean, dynamic: boolean, restartable: boolean, groupId: string}|null}
   *   Public metadata for one registered app, or null. Shell components (Desktop shortcuts, Start Menu) read
   *   names and icons from here rather than keeping their own copies.
   */
  getApp(id) {
    const descriptor = this._registry.get(id);
    return descriptor ? this._publicMetadata(descriptor) : null;
  }

  /**
   * Snapshot of every running window, with live minimized state.
   * @returns {Array<{appId: string, groupId: string, windowId: string, launchTime: number, state: "running"|"minimized"}>}
   */
  getRunningApps() {
    return [...this._running.entries()].map(([windowId, entry]) => {
      const windowEntry = this._windowManager.getWindow(windowId);
      const isMinimized = windowEntry ? windowEntry.view.isMinimized() : false;
      return {
        appId: entry.appId,
        groupId: entry.groupId,
        windowId,
        launchTime: entry.launchTime,
        state: isMinimized ? "minimized" : "running",
      };
    });
  }

  /**
   * Running applications, one entry per application (not per window).
   * @returns {Array<{appId: string, name: string, icon: string|null, description: string, startedAt: number, status: "running"|"minimized", restartable: boolean, errorCount: number, lastError: string|null, windows: Array<{windowId: string, title: string, launchTime: number, minimized: boolean, maximized: boolean, active: boolean}>}>}
   */
  getRunningApplications() {
    const groups = new Map();
    const activeId = this._windowManager.getActiveWindowId();
    for (const [windowId, entry] of this._running) {
      const view = this._windowManager.getWindow(windowId)?.view;
      const windowInfo = {
        windowId,
        title: entry.title,
        launchTime: entry.launchTime,
        minimized: view ? view.isMinimized() : false,
        maximized: view ? view.isMaximized() : false,
        active: windowId === activeId,
      };
      if (!groups.has(entry.groupId)) groups.set(entry.groupId, []);
      groups.get(entry.groupId).push(windowInfo);
    }
    return [...groups.entries()].map(([groupId, windows]) => {
      const metadata = this._registry.get(groupId) ?? this._registry.get(this._running.get(windows[0].windowId).appId);
      const errors = this._errors.get(groupId) ?? [];
      windows.sort((a, b) => a.launchTime - b.launchTime);
      return {
        appId: groupId,
        name: metadata.name,
        icon: metadata.icon,
        description: metadata.description,
        startedAt: this._appStartTimes.get(groupId) ?? windows[0].launchTime,
        status: windows.every((w) => w.minimized) ? "minimized" : "running",
        restartable: metadata.restartable,
        errorCount: errors.length,
        lastError: errors.length ? errors[errors.length - 1].message : null,
        windows,
      };
    });
  }

  /**
   * @param {string} groupId
   * @returns {string[]} Ids of the application's open windows, oldest first.
   */
  getWindowIds(groupId) {
    return [...this._running.entries()]
      .filter(([, entry]) => entry.groupId === groupId)
      .sort((a, b) => a[1].launchTime - b[1].launchTime)
      .map(([windowId]) => windowId);
  }

  /**
   * @param {string} windowId
   * @returns {string|null} The application (group id) a window belongs to.
   */
  getWindowApp(windowId) {
    return this._running.get(windowId)?.groupId ?? null;
  }

  /**
   * Bring a window to the front (restoring it if minimized).
   * @param {string} windowId
   * @returns {void}
   */
  focusWindow(windowId) {
    this._windowManager.focusWindow(windowId);
  }

  /**
   * @param {string} windowId
   * @returns {void}
   */
  minimizeWindow(windowId) {
    this._windowManager.minimizeWindow(windowId);
  }

  /**
   * @param {string} windowId
   * @returns {void}
   */
  restoreWindow(windowId) {
    this._windowManager.restoreWindow(windowId);
  }

  /**
   * Close one window with its normal close animation.
   * @param {string} windowId
   * @returns {void}
   */
  closeWindow(windowId) {
    this._windowManager.closeWindow(windowId);
  }

  /**
   * Bring every window of an application forward, most recent on top.
   * @param {string} groupId
   * @returns {void}
   */
  focusApplication(groupId) {
    const windowIds = this.getWindowIds(groupId);
    for (const windowId of windowIds) this._windowManager.focusWindow(windowId);
  }

  /**
   * Minimize every window of an application, or restore them all when they are all minimized.
   * @param {string} groupId
   * @returns {"minimized"|"restored"|null}
   */
  toggleApplicationMinimized(groupId) {
    const windowIds = this.getWindowIds(groupId);
    if (windowIds.length === 0) return null;
    const allMinimized = windowIds.every((windowId) => this._windowManager.getWindow(windowId)?.view.isMinimized());
    for (const windowId of windowIds) {
      if (allMinimized) this._windowManager.restoreWindow(windowId);
      else this._windowManager.minimizeWindow(windowId);
    }
    return allMinimized ? "restored" : "minimized";
  }

  /**
   * Warnings an application gives before being ended (e.g. a document
   * that couldn't be saved). Apps provide them through the optional
   * `getCloseWarning()` hook.
   * @param {string} groupId
   * @returns {string[]}
   */
  getCloseWarnings(groupId) {
    const warnings = [];
    for (const windowId of this.getWindowIds(groupId)) {
      const instance = this._running.get(windowId)?.instance;
      try {
        const warning = typeof instance?.getCloseWarning === "function" ? instance.getCloseWarning() : null;
        if (typeof warning === "string" && warning) warnings.push(warning);
      } catch (error) {
        console.error(`[AppManager] "${groupId}" getCloseWarning() threw:`, error);
      }
    }
    return warnings;
  }

  /**
   * End an application: every window is removed at once and each
   * instance's `close()` runs, releasing its resources.
   * @param {string} groupId
   * @returns {number} How many windows were closed.
   */
  endApplication(groupId) {
    const windowIds = this.getWindowIds(groupId);
    for (const windowId of windowIds) this._windowManager.destroyWindow(windowId);
    return windowIds.length;
  }

  /**
   * Restart an application: end it, then open the same windows again
   * with the options they were launched with.
   * @param {string} groupId
   * @returns {Promise<boolean>} False when the application isn't running or can't be restarted.
   */
  async restartApplication(groupId) {
    const windowIds = this.getWindowIds(groupId);
    if (windowIds.length === 0) return false;
    const metadata = this._registry.get(groupId);
    if (metadata && !metadata.restartable) return false;
    const relaunches = windowIds.map((windowId) => {
      const entry = this._running.get(windowId);
      return { appId: entry.appId, options: entry.options };
    });
    this.endApplication(groupId);
    this._errors.delete(groupId);
    for (const { appId, options } of relaunches) {
      if (!this._registry.has(appId)) continue;
      try {
        await this.launch(appId, options);
      } catch (error) {
        console.error(`[AppManager] restarting "${appId}" failed:`, error);
        return false;
      }
    }
    eventBus.emit("application:restarted", Object.freeze({ appId: groupId }));
    return true;
  }

  /**
   * Record an error that belongs to an application (Task Manager shows them).
   * @param {string} appId - App or group id.
   * @param {*} error
   * @param {string} [phase] - "launch", "load", "close", "runtime", …
   * @returns {void}
   */
  recordError(appId, error, phase = "runtime") {
    const groupId = this._registry.get(appId)?.groupId ?? appId;
    const message = (error && typeof error === "object" && "message" in error ? String(error.message) : String(error)).slice(0, 300) || "Unknown error";
    const list = this._errors.get(groupId) ?? [];
    list.push({ message, phase, at: Date.now() });
    this._errors.set(groupId, list.slice(-MAX_ERRORS_PER_APP));
    eventBus.emit("application:error", Object.freeze({ appId: groupId, phase, message }));
  }

  /**
   * @param {string} groupId
   * @returns {Array<{message: string, phase: string, at: number}>}
   */
  getErrors(groupId) {
    return [...(this._errors.get(groupId) ?? [])];
  }

  /**
   * @returns {string|null} Id of the focused (active) window.
   */
  getFocusedWindowId() {
    return this._focusedWindowId;
  }

  /**
   * @returns {string|null} Id of the application whose window is focused.
   */
  getFocusedApplication() {
    return this._focusedWindowId ? this._running.get(this._focusedWindowId)?.groupId ?? null : null;
  }

  // ---------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------

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
      restartable: descriptor.restartable,
      groupId: descriptor.groupId,
    };
  }

  /**
   * Load the app class if needed, create the instance and its window.
   * @param {object} descriptor
   * @param {object} options
   * @returns {Promise<import("./application.js").Application>}
   */
  async _createInstance(descriptor, options) {
    const id = descriptor.id;
    if (!descriptor.AppClass) {
      try {
        const module = await descriptor.loader();
        if (typeof module?.default !== "function") throw new Error("The application module has no default export");
        descriptor.AppClass = module.default;
      } catch (error) {
        this._reportCrash(descriptor, "load", error);
        throw error;
      }
    }

    let instance = null;
    let built;
    try {
      instance = new descriptor.AppClass({
        id: descriptor.id,
        name: descriptor.name,
        icon: descriptor.icon,
        appManager: this,
        recentFilesService: this._recentFilesService,
      });
      built = instance.launch(options);
      if (!built || !(built.element instanceof HTMLElement)) throw new Error("launch() did not return a window element");
    } catch (error) {
      // Let a half-constructed instance release whatever it acquired.
      try {
        instance?.close();
      } catch {
        /* already failing; the launch error is the one reported */
      }
      this._reportCrash(descriptor, "launch", error);
      throw error;
    }

    const windowId = descriptor.singleInstance ? `app:${id}` : `app:${id}:${++this._instanceCounter}`;
    const title = built.title ?? descriptor.name;
    const isFirstWindow = this.getWindowIds(descriptor.groupId).length === 0;

    this._windowManager.createWindow({
      id: windowId,
      appId: descriptor.groupId,
      title,
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
    this._running.set(windowId, { appId: id, groupId: descriptor.groupId, instance, launchTime: Date.now(), options: cloneOptions(options), title });
    if (descriptor.singleInstance) {
      this._singleInstanceWindows.set(id, windowId);
    }
    if (isFirstWindow) {
      this._appStartTimes.set(descriptor.groupId, Date.now());
      eventBus.emit("application:started", Object.freeze({ appId: descriptor.groupId }));
    }

    eventBus.emit("app:launched", { appId: id, windowId });
    return instance;
  }

  /**
   * @param {object} descriptor
   * @param {"load"|"launch"} phase
   * @param {*} error
   * @returns {void}
   */
  _reportCrash(descriptor, phase, error) {
    console.error(`[AppManager] "${descriptor.id}" failed to ${phase}:`, error);
    const message = (error?.message ? String(error.message) : String(error)).slice(0, 300);
    if (error && typeof error === "object") {
      try {
        error.browserosReported = true;
      } catch {
        /* frozen error objects can't be tagged */
      }
    }
    this.recordError(descriptor.groupId, error, phase);
    eventBus.emit("application:crashed", Object.freeze({ appId: descriptor.groupId, phase, message }));
  }

  /**
   * @param {string} id - Focused window id.
   * @returns {void}
   */
  _handleWindowFocused(id) {
    if (this._focusedWindowId && this._focusedWindowId !== id) {
      const previous = this._running.get(this._focusedWindowId);
      if (previous) {
        try {
          previous.instance.onBlur();
        } catch (error) {
          this.recordError(previous.groupId, error, "blur");
        }
        eventBus.emit("app:blurred", { appId: previous.appId, windowId: this._focusedWindowId });
      }
    }

    const current = this._running.get(id);
    if (!current) return;

    this._focusedWindowId = id;
    try {
      current.instance.onFocus();
    } catch (error) {
      this.recordError(current.groupId, error, "focus");
    }
    eventBus.emit("app:focused", { appId: current.appId, windowId: id });
    eventBus.emit("application:focused", Object.freeze({ appId: current.groupId, windowId: id }));
  }

  /**
   * @param {string} appId
   * @param {string} windowId
   * @returns {void}
   */
  _handleWindowDestroyed(appId, windowId) {
    const entry = this._running.get(windowId);
    if (!entry) return;

    try {
      entry.instance.close();
    } catch (error) {
      console.error(`[AppManager] "${appId}" close() threw:`, error);
      this.recordError(entry.groupId, error, "close");
    }
    this._running.delete(windowId);

    if (this._singleInstanceWindows.get(appId) === windowId) {
      this._singleInstanceWindows.delete(appId);
    }
    if (this._focusedWindowId === windowId) {
      this._focusedWindowId = null;
    }

    eventBus.emit("app:closed", { appId, windowId });
    if (this.getWindowIds(entry.groupId).length === 0) {
      this._appStartTimes.delete(entry.groupId);
      eventBus.emit("application:stopped", Object.freeze({ appId: entry.groupId }));
    }
  }
}

/**
 * Keep a copy of launch options that can be replayed on restart.
 * @param {object} options
 * @returns {object}
 */
function cloneOptions(options) {
  if (!options || typeof options !== "object") return {};
  try {
    return JSON.parse(JSON.stringify(options));
  } catch {
    return {};
  }
}

export { AppManager };
