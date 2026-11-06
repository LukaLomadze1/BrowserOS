/**
 * @file The Desktop — the base screen BrowserOS boots into.
 *
 * Builds the shell layout: wallpaper, the desktop icon layer, the
 * window layer that WindowManager mounts windows into, and the taskbar
 * (Start button, window buttons, and the system tray container that
 * TrayManager fills).
 *
 * Taskbar window buttons reflect window state purely through EventBus
 * ("window:*") — Desktop never calls WindowManager. Buttons show the
 * application's icon, stay next to the other windows of the same
 * application, follow title changes, and offer a context menu (restore
 * or minimize, close, close every window of the application, Task
 * Manager) through AppManager once it is attached.
 */

import { createElement } from "../utils/dom.js";
import { createIconElement } from "../utils/icons.js";
import { eventBus } from "./eventBus.js";
import { ContextMenu } from "../components/context-menu/contextMenu.js";

export class Desktop {
  /**
   * @param {HTMLElement} rootElement - Container the desktop mounts into.
   */
  constructor(rootElement) {
    this._root = rootElement;
    this._windowLayerEl = null;
    this._iconLayerEl = null;
    this._startButtonEl = null;
    this._trayEl = null;
    this._taskbarWindowListEl = null;
    /** @type {Map<string, {el: HTMLElement, labelEl: HTMLElement, appId: string|null, title: string}>} */
    this._taskbarButtons = new Map();
    /** @type {import("./appManager.js").AppManager|null} */
    this._appManager = null;
    this._contextMenu = new ContextMenu();
    this._cleanups = [];
  }

  /**
   * Build the DOM. Intended to be called once during boot.
   * @returns {void}
   */
  init() {
    const wallpaper = createElement("div", { className: "desktop__wallpaper" });
    this._iconLayerEl = createElement("div", {
      className: "desktop__icon-grid",
      // tabindex="-1": not part of Tab order, but focusable via
      // code. A marquee (rectangle) selection never makes any icon
      // the pointerdown target, so nothing about it triggers the
      // browser's native "click focuses this" behavior — this is
      // what lets DesktopManager explicitly focus something after a
      // marquee completes, so Delete works on rectangle-selected
      // items (see desktopManager.js).
      attrs: { role: "list", "aria-label": "Desktop icons", tabindex: "-1" },
    });
    this._windowLayerEl = createElement("div", {
      className: "desktop__window-layer",
      attrs: { role: "group", "aria-label": "Open application windows" },
    });
    const taskbar = this._buildTaskbar();

    const desktopEl = createElement("div", {
      className: "desktop",
      children: [wallpaper, this._iconLayerEl, this._windowLayerEl, taskbar],
    });

    this._root.append(desktopEl);
    this._wireTaskbarWindowList();

    eventBus.emit("desktop:ready", {});
  }

  /**
   * Give the taskbar access to application actions (window context
   * menu). Called once during boot, after AppManager exists.
   * @param {import("./appManager.js").AppManager} appManager
   * @returns {void}
   */
  attachAppManager(appManager) {
    this._appManager = appManager;
  }

  /**
   * The container DesktopManager mounts desktop icons into. Desktop
   * owns this element's position/z-index in the layout; DesktopManager
   * owns everything inside it.
   * @returns {HTMLElement}
   */
  getIconLayer() {
    return this._iconLayerEl;
  }

  /**
   * The container WindowManager mounts window elements into. Desktop
   * owns this element's position/z-index in the layout; WindowManager
   * owns everything inside it.
   * @returns {HTMLElement}
   */
  getWindowLayer() {
    return this._windowLayerEl;
  }

  /**
   * The Start button itself. StartMenuManager uses this to keep
   * aria-expanded in sync and to return keyboard focus to it when
   * the menu closes.
   * @returns {HTMLElement}
   */
  getStartButton() {
    return this._startButtonEl;
  }

  /**
   * The system tray container at the right end of the taskbar.
   * TrayManager owns everything inside it.
   * @returns {HTMLElement}
   */
  getTrayElement() {
    return this._trayEl;
  }

  /**
   * Remove subscriptions. Intended for tests/teardown.
   * @returns {void}
   */
  destroy() {
    for (const cleanup of this._cleanups) cleanup();
    this._cleanups = [];
    this._contextMenu.hide();
  }

  // ---------------------------------------------------------------
  // Taskbar
  // ---------------------------------------------------------------

  /**
   * @returns {HTMLElement}
   */
  _buildTaskbar() {
    const startButton = createElement("button", {
      className: "start-button",
      attrs: { type: "button", "aria-label": "Start", "aria-haspopup": "true", "aria-expanded": "false" },
      children: [
        createElement("span", { className: "start-button__glyph", attrs: { "aria-hidden": "true" } }),
        createElement("span", { className: "start-button__label", text: "Start" }),
      ],
      on: {
        click: () => eventBus.emit("startmenu:toggle", {}),
      },
    });
    this._startButtonEl = startButton;

    this._taskbarWindowListEl = createElement("div", {
      className: "taskbar__center",
      attrs: { role: "group", "aria-label": "Open windows" },
    });

    this._trayEl = createElement("div", {
      className: "tray",
      attrs: { role: "group", "aria-label": "System tray" },
    });

    return createElement("div", {
      className: "taskbar",
      children: [
        createElement("div", { className: "taskbar__left", children: [startButton] }),
        this._taskbarWindowListEl,
        createElement("div", { className: "taskbar__right", children: [this._trayEl] }),
      ],
    });
  }

  /**
   * Keep a taskbar button per open window in sync with WindowManager
   * state, entirely through EventBus.
   * @returns {void}
   */
  _wireTaskbarWindowList() {
    this._cleanups.push(
      eventBus.on("window:created", ({ id, title, appId, icon }) => this._addTaskbarButton(id, title, appId, icon)),
      eventBus.on("window:closed", ({ id }) => this._removeTaskbarButton(id)),
      eventBus.on("window:titleChanged", ({ id, title }) => this._setButtonTitle(id, title)),
      eventBus.on("window:focused", ({ id }) => {
        for (const [buttonId, button] of this._taskbarButtons) {
          const active = buttonId === id;
          button.el.classList.toggle("taskbar-window-button--active", active);
          button.el.setAttribute("aria-pressed", String(active));
        }
      }),
      eventBus.on("window:minimized", ({ id }) => {
        const button = this._taskbarButtons.get(id);
        if (!button) return;
        button.el.classList.add("taskbar-window-button--minimized");
        button.el.classList.remove("taskbar-window-button--active");
        button.el.setAttribute("aria-pressed", "false");
      }),
      eventBus.on("window:restored", ({ id }) => {
        this._taskbarButtons.get(id)?.el.classList.remove("taskbar-window-button--minimized");
      })
    );
  }

  /**
   * @param {string} id
   * @param {string} title
   * @param {string|null} appId
   * @param {string|null} icon
   * @returns {void}
   */
  _addTaskbarButton(id, title, appId, icon) {
    const labelEl = createElement("span", { className: "taskbar-window-button__label", text: title });
    const el = createElement("button", {
      className: "taskbar-window-button",
      attrs: { type: "button", "aria-pressed": "false", "data-window-id": id, "data-app-id": appId ?? "" },
      children: [createIconElement(icon, { className: "taskbar-window-button__icon" }), labelEl],
      on: {
        click: () => eventBus.emit("window:requestToggleFromTaskbar", { id }),
        contextmenu: (e) => {
          e.preventDefault();
          this._showButtonMenu(id, e.clientX, e.clientY);
        },
        keydown: (e) => {
          if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
            e.preventDefault();
            const rect = el.getBoundingClientRect();
            this._showButtonMenu(id, rect.left, rect.top - 8);
          }
        },
      },
    });
    const button = { el, labelEl, appId, title };
    this._taskbarButtons.set(id, button);

    // Keep windows of the same application next to each other.
    const sameApp = appId ? [...this._taskbarButtons.values()].filter((other) => other !== button && other.appId === appId) : [];
    if (sameApp.length > 0) {
      sameApp[sameApp.length - 1].el.after(el);
    } else {
      this._taskbarWindowListEl.append(el);
    }
    this._refreshGroupLabels(appId);
  }

  /**
   * @param {string} id
   * @returns {void}
   */
  _removeTaskbarButton(id) {
    const button = this._taskbarButtons.get(id);
    if (!button) return;
    button.el.remove();
    this._taskbarButtons.delete(id);
    this._refreshGroupLabels(button.appId);
  }

  /**
   * @param {string} id
   * @param {string} title
   * @returns {void}
   */
  _setButtonTitle(id, title) {
    const button = this._taskbarButtons.get(id);
    if (!button) return;
    button.title = title;
    button.labelEl.textContent = title;
    this._refreshGroupLabels(button.appId);
  }

  /**
   * Accessible names and tooltips say which application a window
   * belongs to and, for applications with several windows, which one it is.
   * @param {string|null} appId
   * @returns {void}
   */
  _refreshGroupLabels(appId) {
    const buttons = [...this._taskbarButtons.values()].filter((button) => button.appId === appId);
    const appName = appId ? this._appManager?.getApp(appId)?.name ?? null : null;
    buttons.forEach((button, index) => {
      const position = buttons.length > 1 ? `window ${index + 1} of ${buttons.length}` : "";
      const suffix = [appName && appName !== button.title ? appName : "", position].filter(Boolean).join(", ");
      const label = suffix ? `${button.title} \u2014 ${suffix}` : button.title;
      button.el.setAttribute("aria-label", label);
      button.el.title = label;
      button.el.classList.toggle("taskbar-window-button--grouped", buttons.length > 1);
    });
  }

  /**
   * @param {string} windowId
   * @param {number} x
   * @param {number} y
   * @returns {void}
   */
  _showButtonMenu(windowId, x, y) {
    const button = this._taskbarButtons.get(windowId);
    if (!button) return;
    const appManager = this._appManager;
    const minimized = button.el.classList.contains("taskbar-window-button--minimized");
    const appWindowCount = button.appId ? [...this._taskbarButtons.values()].filter((other) => other.appId === button.appId).length : 1;
    const appName = button.appId ? appManager?.getApp(button.appId)?.name ?? "this application" : "this application";

    const items = [
      {
        label: minimized ? "Restore" : "Minimize",
        action: () => (minimized ? appManager?.restoreWindow(windowId) : appManager?.minimizeWindow(windowId)),
        disabled: !appManager,
      },
      { label: "Close window", action: () => appManager?.closeWindow(windowId), disabled: !appManager },
    ];
    if (appWindowCount > 1) {
      items.push({ label: `Close all ${appWindowCount} ${appName} windows`, action: () => appManager?.close(button.appId), disabled: !appManager });
    }
    if (appManager?.isRegistered("task-manager")) {
      items.push({ separator: true }, { label: "Task Manager", action: () => appManager.launch("task-manager").catch(() => {}) });
    }
    this._contextMenu.show(items, { x, y: Math.max(8, y - 8) });
  }
}
