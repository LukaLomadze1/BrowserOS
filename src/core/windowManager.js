/**
 * @file WindowManager — owns every window's lifecycle, z-order, and
 * focus state. This is the only module allowed to construct a
 * WindowView; the rest of BrowserOS creates windows exclusively
 * through `windowManager.createWindow(config)` and reacts to window
 * state via EventBus, never by importing WindowView or reaching into
 * another window's DOM directly.
 */

import { eventBus } from "./eventBus.js";
import { keyboardShortcuts } from "./keyboard/keyboardShortcuts.js";
import { WindowView } from "../components/window/window.js";

const DEFAULT_MIN_WIDTH = 320;
const DEFAULT_MIN_HEIGHT = 200;
const CASCADE_STEP_X = 32;
const CASCADE_STEP_Y = 28;
const CASCADE_ORIGIN_X = 80;
const CASCADE_ORIGIN_Y = 48;
const CASCADE_WRAP_COUNT = 8;
const BASE_Z_INDEX = 100;

class WindowManager {
  /**
   * @param {HTMLElement} containerElement - Element windows mount into (Desktop's window layer).
   */
  constructor(containerElement) {
    this._container = containerElement;
    /** @type {Map<string, {view: WindowView, config: object, onDestroy: (Function|null)}>} */
    this._windows = new Map();
    this._activeId = null;
    this._zCounter = BASE_Z_INDEX;
    this._createdCount = 0;
  }

  /**
   * Wire the EventBus requests that don't belong to any single
   * window (e.g. taskbar clicks). Call once during boot.
   * @returns {void}
   */
  init() {
    eventBus.on("window:requestToggleFromTaskbar", ({ id }) => this._handleTaskbarToggle(id));

    // Window-management shortcuts (gated by keyboard.windowShortcuts).
    // Each handler returns false when there is no window to act on, so
    // the key press is left alone.
    keyboardShortcuts.bind("window.toggleMaximize", () => this._withActiveWindow((id) => this._toggleMaximize(id)));
    keyboardShortcuts.bind("window.minimize", () => this._withActiveWindow((id) => this.minimizeWindow(id)));
    keyboardShortcuts.bind("window.close", () => this._withActiveWindow((id) => this.closeWindow(id)));
    keyboardShortcuts.bind("window.next", () => this.cycleFocus("next"));
    keyboardShortcuts.bind("window.previous", () => this.cycleFocus("previous"));
  }

  /**
   * @returns {string|null} The focused window's id, if any.
   */
  getActiveWindowId() {
    return this._activeId;
  }

  /**
   * Keyboard window switching. "next" focuses the window lowest in the
   * stack, so repeated presses visit every open window in turn;
   * "previous" returns to the most recently used window beneath the
   * active one. Minimized windows are restored when reached.
   * @param {"next"|"previous"} direction
   * @returns {boolean} Whether there was another window to switch to.
   */
  cycleFocus(direction) {
    const ordered = [...this._windows.entries()]
      .sort(([, a], [, b]) => Number(a.view.getElement().style.zIndex || 0) - Number(b.view.getElement().style.zIndex || 0))
      .map(([id]) => id);
    const others = ordered.filter((id) => id !== this._activeId);
    if (others.length === 0) return false;

    const target = direction === "next" ? others[0] : others[others.length - 1];
    this.focusWindow(target);
    return true;
  }

  /**
   * @param {(id: string) => void} action
   * @returns {boolean} False when no window is active.
   */
  _withActiveWindow(action) {
    if (!this._activeId || !this._windows.has(this._activeId)) return false;
    action(this._activeId);
    return true;
  }

  /**
   * @param {object} config
   * @param {string} config.id - Must be unique among currently open windows.
   * @param {string} config.title
   * @param {string} [config.icon]
   * @param {HTMLElement} config.content
   * @param {number} [config.width=640]
   * @param {number} [config.height=420]
   * @param {number} [config.x] - Omit to auto-cascade.
   * @param {number} [config.y] - Omit to auto-cascade.
   * @param {boolean} [config.center] - Without x and y: center the window on the desktop instead of cascading.
   * @param {number} [config.minWidth]
   * @param {number} [config.minHeight]
   * @param {boolean} [config.resizable=true]
   * @param {boolean} [config.minimizable=true]
   * @param {boolean} [config.maximizable=true]
   * @param {boolean} [config.closable=true]
   * @param {() => void} [config.onDestroy] - Called once, when the window is fully removed, so the app can clean up its own timers/listeners.
   * @param {() => (boolean|Promise<boolean>)} [config.onBeforeClose] - Asked before a normal close (close button, keyboard, taskbar); returning false keeps the window open, e.g. after the user cancels a "save changes?" prompt. destroyWindow() never asks.
   * @param {string} [config.appId] - Application the window belongs to; passed on in "window:created" so the taskbar can group and label it.
   * @returns {string} The window id.
   */
  createWindow(config) {
    if (!config || !config.id) {
      throw new Error("[WindowManager] createWindow requires a unique config.id");
    }
    if (this._windows.has(config.id)) {
      throw new Error(`[WindowManager] a window with id "${config.id}" already exists`);
    }

    const width = config.width ?? 640;
    const height = config.height ?? 420;
    const minWidth = config.minWidth ?? DEFAULT_MIN_WIDTH;
    const minHeight = config.minHeight ?? DEFAULT_MIN_HEIGHT;
    const position = this._resolvePosition(config, width, height);

    const view = new WindowView(
      {
        id: config.id,
        title: config.title,
        icon: config.icon,
        content: config.content,
        x: position.x,
        y: position.y,
        width,
        height,
        minWidth,
        minHeight,
        resizable: config.resizable ?? true,
        minimizable: config.minimizable ?? true,
        maximizable: config.maximizable ?? true,
        closable: config.closable ?? true,
        boundsElement: this._container,
      },
      {
        onRequestFocus: (id) => this.focusWindow(id),
        onRequestClose: (id) => this.closeWindow(id),
        onRequestMinimize: (id) => this.minimizeWindow(id),
        onRequestMaximizeToggle: (id) => this._toggleMaximize(id),
        onMoved: (id, pos) => eventBus.emit("window:moved", { id, ...pos }),
        onResized: (id, rect) => eventBus.emit("window:resized", { id, ...rect }),
      }
    );

    this._windows.set(config.id, { view, config, onDestroy: config.onDestroy ?? null, onBeforeClose: config.onBeforeClose ?? null, closing: false });
    this._container.append(view.getElement());
    view.playOpenAnimation();
    this._createdCount += 1;

    eventBus.emit("window:created", { id: config.id, title: config.title, appId: config.appId ?? null, icon: config.icon ?? null });
    this.focusWindow(config.id);

    return config.id;
  }

  /**
   * Close a window: asks its onBeforeClose hook (if any), then plays the
   * exit animation and destroys it.
   * @param {string} id
   * @returns {void}
   */
  closeWindow(id) {
    const entry = this._windows.get(id);
    if (!entry || entry.closing) return;

    if (entry.onBeforeClose) {
      entry.closing = true;
      Promise.resolve()
        .then(() => entry.onBeforeClose())
        .catch((error) => {
          console.error(`[WindowManager] onBeforeClose for "${id}" failed:`, error);
          return true;
        })
        .then((allowed) => {
          entry.closing = false;
          if (allowed === false || !this._windows.has(id)) return;
          entry.closing = true;
          entry.view.playCloseAnimation(() => this.destroyWindow(id));
        });
      return;
    }

    entry.closing = true;
    entry.view.playCloseAnimation(() => {
      this.destroyWindow(id);
    });
  }

  /**
   * Give a window input focus, dim every other window, and bring it
   * to the front of the stack.
   * @param {string} id
   * @returns {void}
   */
  focusWindow(id) {
    const entry = this._windows.get(id);
    if (!entry) return;

    if (entry.view.isMinimized()) {
      this.restoreWindow(id);
      return;
    }

    if (this._activeId === id) {
      this.bringToFront(id);
      return;
    }

    if (this._activeId) {
      const previous = this._windows.get(this._activeId);
      if (previous) previous.view.setActive(false);
    }

    entry.view.setActive(true);
    this._activeId = id;
    this.bringToFront(id);

    eventBus.emit("window:focused", { id });
  }

  /**
   * Hide a window without destroying it, and hand focus to the next
   * topmost non-minimized window, if any.
   * @param {string} id
   * @returns {void}
   */
  minimizeWindow(id) {
    const entry = this._windows.get(id);
    if (!entry) return;

    entry.view.setMinimized(true);
    entry.view.setActive(false);

    if (this._activeId === id) {
      this._activeId = null;
      this._focusTopmostVisible();
    }

    eventBus.emit("window:minimized", { id });
  }

  /**
   * Show a minimized window again and focus it.
   * @param {string} id
   * @returns {void}
   */
  restoreWindow(id) {
    const entry = this._windows.get(id);
    if (!entry) return;

    entry.view.setMinimized(false);
    eventBus.emit("window:restored", { id });
    this.focusWindow(id);
  }

  /**
   * Maximize a window to fill the available desktop area.
   * @param {string} id
   * @returns {void}
   */
  maximizeWindow(id) {
    const entry = this._windows.get(id);
    if (!entry || entry.view.isMaximized()) return;
    entry.view.maximize();
    this.focusWindow(id);
    eventBus.emit("window:maximized", { id });
  }

  /**
   * Restore a maximized window to its prior size and position.
   * @param {string} id
   * @returns {void}
   */
  restoreFromMaximize(id) {
    const entry = this._windows.get(id);
    if (!entry || !entry.view.isMaximized()) return;
    entry.view.restore();
    this.focusWindow(id);
    eventBus.emit("window:restored", { id });
  }

  /**
   * Raise a window's z-index above every other open window without
   * changing focus/active state.
   * @param {string} id
   * @returns {void}
   */
  bringToFront(id) {
    const entry = this._windows.get(id);
    if (!entry) return;
    this._zCounter += 1;
    entry.view.setZIndex(this._zCounter);
  }

  /**
   * Update a window's titlebar text after creation. Used when the
   * file/folder a window represents is renamed elsewhere (Explorer,
   * Desktop) — apps never call this directly (they have no
   * WindowManager reference); AppManager exposes it on their behalf.
   * @param {string} id
   * @param {string} title
   * @returns {void}
   */
  updateWindowTitle(id, title) {
    const entry = this._windows.get(id);
    if (!entry) return;
    entry.view.setTitle(title);
    entry.config = { ...entry.config, title };
    eventBus.emit("window:titleChanged", { id, title });
  }

  /**
   * Immediately remove a window: no animation, listeners cleaned up,
   * app's onDestroy hook invoked. closeWindow() is the normal path;
   * this is the low-level teardown it calls into.
   * @param {string} id
   * @returns {void}
   */
  destroyWindow(id) {
    const entry = this._windows.get(id);
    if (!entry) return;

    entry.view.destroy();
    this._windows.delete(id);

    if (this._activeId === id) {
      this._activeId = null;
      this._focusTopmostVisible();
    }

    if (entry.onDestroy) {
      entry.onDestroy();
    }

    eventBus.emit("window:closed", { id });
  }

  /**
   * @param {string} id
   * @returns {{view: WindowView, config: object}|undefined}
   */
  getWindow(id) {
    return this._windows.get(id);
  }

  /**
   * @returns {string[]} Ids of every currently open window.
   */
  listWindows() {
    return [...this._windows.keys()];
  }

  // ---------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------

  /**
   * @param {string} id
   * @returns {void}
   */
  _toggleMaximize(id) {
    const entry = this._windows.get(id);
    if (!entry) return;
    if (entry.view.isMaximized()) {
      this.restoreFromMaximize(id);
    } else {
      this.maximizeWindow(id);
    }
  }

  /**
   * Taskbar buttons emit one request event; the correct action
   * depends on the window's current state, which only WindowManager
   * knows.
   * @param {string} id
   * @returns {void}
   */
  _handleTaskbarToggle(id) {
    const entry = this._windows.get(id);
    if (!entry) return;

    if (entry.view.isMinimized()) {
      this.restoreWindow(id);
    } else if (this._activeId === id) {
      this.minimizeWindow(id);
    } else {
      this.focusWindow(id);
    }
  }

  /**
   * After closing/minimizing the active window, focus whichever
   * remaining window currently sits highest in the stack.
   * @returns {void}
   */
  _focusTopmostVisible() {
    let topId = null;
    let topZ = -Infinity;
    for (const [id, entry] of this._windows) {
      if (entry.view.isMinimized()) continue;
      const z = Number(entry.view.getElement().style.zIndex || 0);
      if (z > topZ) {
        topZ = z;
        topId = id;
      }
    }
    if (topId) this.focusWindow(topId);
  }

  /**
   * @param {object} config
   * @param {number} width
   * @param {number} height
   * @returns {{x:number,y:number}}
   */
  _resolvePosition(config, width, height) {
    if (typeof config.x === "number" && typeof config.y === "number") {
      return { x: config.x, y: config.y };
    }
    const bounds = this._container.getBoundingClientRect();
    if (config.center) {
      return {
        x: Math.max(0, Math.round((bounds.width - width) / 2)),
        y: Math.max(0, Math.round((bounds.height - height) / 2)),
      };
    }
    const step = this._createdCount % CASCADE_WRAP_COUNT;
    const x = Math.min(
      CASCADE_ORIGIN_X + step * CASCADE_STEP_X,
      Math.max(0, bounds.width - width - 16)
    );
    const y = Math.min(
      CASCADE_ORIGIN_Y + step * CASCADE_STEP_Y,
      Math.max(0, bounds.height - height - 16)
    );
    return { x, y };
  }
}

export { WindowManager };
