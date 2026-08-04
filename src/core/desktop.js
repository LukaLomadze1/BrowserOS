/**
 * @file The Desktop — the base screen BrowserOS boots into.
 *
 * This step builds the shell (wallpaper, empty icon grid, taskbar
 * with a start button and a live clock) plus the window layer that
 * WindowManager mounts windows into, and a taskbar window list that
 * reflects window state purely by listening to EventBus — Desktop
 * never imports or calls WindowManager directly. Icons, the start
 * menu, and context menus still belong to later subsystems.
 */

import { createElement } from "../utils/dom.js";
import { eventBus } from "./eventBus.js";

const CLOCK_TICK_MS = 1000;

export class Desktop {
  /**
   * @param {HTMLElement} rootElement - Container the desktop mounts into.
   */
  constructor(rootElement) {
    this._root = rootElement;
    this._clockTimeEl = null;
    this._clockDateEl = null;
    this._clockIntervalId = null;
    this._windowLayerEl = null;
    this._iconLayerEl = null;
    this._startButtonEl = null;
    this._taskbarWindowListEl = null;
    /** @type {Map<string, HTMLElement>} */
    this._taskbarButtons = new Map();
  }

  /**
   * Build the DOM and start the clock. Idempotent-ish: intended to
   * be called once during boot.
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
      // marquee completes, which is what actually fixes Delete not
      // working on rectangle-selected items (see desktopManager.js).
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
    this._startClock();
    this._wireTaskbarWindowList();

    eventBus.emit("desktop:ready", {});
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

    this._clockTimeEl = createElement("span", { className: "clock__time" });
    this._clockDateEl = createElement("span", { className: "clock__date" });

    const clock = createElement("div", {
      className: "clock",
      attrs: { "aria-label": "Clock" },
      children: [this._clockTimeEl, this._clockDateEl],
    });

    this._taskbarWindowListEl = createElement("div", {
      className: "taskbar__center",
      attrs: { role: "group", "aria-label": "Open windows" },
    });

    return createElement("div", {
      className: "taskbar",
      children: [
        createElement("div", { className: "taskbar__left", children: [startButton] }),
        this._taskbarWindowListEl,
        createElement("div", { className: "taskbar__right", children: [clock] }),
      ],
    });
  }

  /**
   * Keep a taskbar button per open window in sync with WindowManager
   * state, entirely through EventBus — Desktop never touches
   * WindowManager or Window instances directly.
   * @returns {void}
   */
  _wireTaskbarWindowList() {
    eventBus.on("window:created", ({ id, title }) => this._addTaskbarButton(id, title));
    eventBus.on("window:closed", ({ id }) => this._removeTaskbarButton(id));

    eventBus.on("window:focused", ({ id }) => {
      for (const [buttonId, buttonEl] of this._taskbarButtons) {
        buttonEl.classList.toggle("taskbar-window-button--active", buttonId === id);
      }
    });

    eventBus.on("window:minimized", ({ id }) => {
      const buttonEl = this._taskbarButtons.get(id);
      if (buttonEl) buttonEl.classList.add("taskbar-window-button--minimized");
    });

    eventBus.on("window:restored", ({ id }) => {
      const buttonEl = this._taskbarButtons.get(id);
      if (buttonEl) buttonEl.classList.remove("taskbar-window-button--minimized");
    });
  }

  /**
   * @param {string} id
   * @param {string} title
   * @returns {void}
   */
  _addTaskbarButton(id, title) {
    const buttonEl = createElement("button", {
      className: "taskbar-window-button",
      attrs: { type: "button", "aria-label": title, title },
      text: title,
      on: {
        click: () => eventBus.emit("window:requestToggleFromTaskbar", { id }),
      },
    });
    this._taskbarButtons.set(id, buttonEl);
    this._taskbarWindowListEl.append(buttonEl);
  }

  /**
   * @param {string} id
   * @returns {void}
   */
  _removeTaskbarButton(id) {
    const buttonEl = this._taskbarButtons.get(id);
    if (!buttonEl) return;
    buttonEl.remove();
    this._taskbarButtons.delete(id);
  }

  /**
   * Render the current time immediately, then refresh once a second.
   * @returns {void}
   */
  _startClock() {
    const render = () => {
      const now = new Date();
      this._clockTimeEl.textContent = new Intl.DateTimeFormat(undefined, {
        hour: "2-digit",
        minute: "2-digit",
      }).format(now);
      this._clockDateEl.textContent = new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
      }).format(now);
    };

    render();
    this._clockIntervalId = window.setInterval(render, CLOCK_TICK_MS);
  }

  /**
   * Stop timers. Intended for tests/teardown.
   * @returns {void}
   */
  destroy() {
    if (this._clockIntervalId !== null) {
      window.clearInterval(this._clockIntervalId);
      this._clockIntervalId = null;
    }
  }
}
