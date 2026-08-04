/**
 * @file WindowView — the visual, interactive shell of a single window.
 *
 * This module owns DOM construction, dragging, resizing, and
 * animation for one window. It holds no cross-window state (z-index
 * ordering, focus, minimize/maximize bookkeeping) — that belongs to
 * WindowManager, which creates a WindowView per window and drives it
 * through the callbacks passed into the constructor.
 *
 * Values like MIN_VISIBLE_PX below are kept in sync by hand with the
 * corresponding tokens in styles/variables.css / styles/window.css;
 * they describe interaction behavior (how far a window may be
 * dragged) rather than visual styling, so they live in JS.
 */

import { createElement } from "../../utils/dom.js";

/** Minimum horizontal sliver of a window that must stay reachable when dragged near an edge. */
const MIN_VISIBLE_PX = 120;
/** Titlebar height in pixels; must match --window-titlebar-height. */
const TITLEBAR_HEIGHT_PX = 40;

const RESIZE_HANDLES = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];

export class WindowView {
  /**
   * @param {object} config
   * @param {string} config.id
   * @param {string} config.title
   * @param {string} [config.icon] - Single character/emoji glyph shown in the titlebar.
   * @param {HTMLElement} config.content - App content to mount in the window body.
   * @param {number} config.x
   * @param {number} config.y
   * @param {number} config.width
   * @param {number} config.height
   * @param {number} config.minWidth
   * @param {number} config.minHeight
   * @param {boolean} config.resizable
   * @param {boolean} config.minimizable
   * @param {boolean} config.maximizable
   * @param {boolean} config.closable
   * @param {HTMLElement} config.boundsElement - Element windows are clamped within.
   * @param {object} callbacks
   * @param {(id: string) => void} callbacks.onRequestFocus
   * @param {(id: string) => void} callbacks.onRequestClose
   * @param {(id: string) => void} callbacks.onRequestMinimize
   * @param {(id: string) => void} callbacks.onRequestMaximizeToggle
   * @param {(id: string, position: {x:number,y:number}) => void} callbacks.onMoved
   * @param {(id: string, rect: {x:number,y:number,width:number,height:number}) => void} callbacks.onResized
   */
  constructor(config, callbacks) {
    this.id = config.id;
    this._config = config;
    this._callbacks = callbacks;
    this._boundsElement = config.boundsElement;

    this._rect = {
      x: config.x,
      y: config.y,
      width: config.width,
      height: config.height,
    };
    this._pendingRect = null;
    this._preMaximizeRect = null;
    this._isMaximized = false;
    this._isMinimized = false;

    this._activeDrag = null;
    this._rafId = null;

    this._buildDom();
    this._applyRect(this._rect);
  }

  /** @returns {HTMLElement} */
  getElement() {
    return this._el;
  }

  /** @returns {{x:number,y:number,width:number,height:number}} */
  getRect() {
    return { ...this._rect };
  }

  /**
   * @param {boolean} isActive
   * @returns {void}
   */
  setActive(isActive) {
    this._el.classList.toggle("window--active", isActive);
    this._el.classList.toggle("window--inactive", !isActive);
    this._el.setAttribute("aria-current", isActive ? "true" : "false");
  }

  /**
   * Update the titlebar text after creation — e.g. when the file a
   * window represents gets renamed elsewhere (Explorer, Desktop).
   * @param {string} title
   * @returns {void}
   */
  setTitle(title) {
    this._titleEl.textContent = title;
  }

  /**
   * @param {number} zIndex
   * @returns {void}
   */
  setZIndex(zIndex) {
    this._el.style.zIndex = String(zIndex);
  }

  /**
   * @param {boolean} isMinimized
   * @returns {void}
   */
  setMinimized(isMinimized) {
    this._isMinimized = isMinimized;
    this._el.classList.toggle("window--minimized", isMinimized);
  }

  /** @returns {boolean} */
  isMinimized() {
    return this._isMinimized;
  }

  /** @returns {boolean} */
  isMaximized() {
    return this._isMaximized;
  }

  /**
   * Fill the bounds element, remembering the prior rect for restore.
   * @returns {void}
   */
  maximize() {
    if (this._isMaximized) return;
    this._preMaximizeRect = { ...this._rect };
    this._isMaximized = true;
    this._el.classList.add("window--maximized");
    this._el.style.left = "0px";
    this._el.style.top = "0px";
    this._el.style.width = "100%";
    this._el.style.height = "100%";
    if (this._maximizeButton) {
      this._maximizeButton.setAttribute("aria-label", `Restore ${this._config.title}`);
      this._maximizeButton.textContent = "\u2750";
    }
  }

  /**
   * Revert to the rect captured before maximize().
   * @returns {void}
   */
  restore() {
    if (!this._isMaximized) return;
    this._isMaximized = false;
    this._el.classList.remove("window--maximized");
    const rect = this._preMaximizeRect ?? this._rect;
    this._preMaximizeRect = null;
    this._applyRect(rect);
    if (this._maximizeButton) {
      this._maximizeButton.setAttribute("aria-label", `Maximize ${this._config.title}`);
      this._maximizeButton.textContent = "\u25a1";
    }
  }

  /**
   * Play the entrance animation. The element must already be mounted.
   * @returns {void}
   */
  playOpenAnimation() {
    this._el.classList.add("window--entering");
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        this._el.classList.remove("window--entering");
      });
    });
  }

  /**
   * Play the exit animation, then invoke onComplete once it finishes.
   * @param {() => void} onComplete
   * @returns {void}
   */
  playCloseAnimation(onComplete) {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      this._el.removeEventListener("transitionend", finish);
      onComplete();
    };
    this._el.addEventListener("transitionend", finish);
    // Safety net in case transitionend never fires (e.g. reduced motion).
    setTimeout(finish, 260);
    this._el.classList.add("window--exiting");
  }

  /**
   * Remove listeners and detach from the DOM. Safe to call once.
   * @returns {void}
   */
  destroy() {
    if (this._rafId !== null) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
    this._activeDrag = null;
    this._el.remove();
  }

  // ---------------------------------------------------------------
  // DOM construction
  // ---------------------------------------------------------------

  /** @returns {void} */
  _buildDom() {
    const { title, icon, content, resizable, minimizable, maximizable, closable } = this._config;

    this._titleEl = createElement("span", { className: "window__title", text: title });

    const iconEl = createElement("span", {
      className: "window__icon",
      attrs: { "aria-hidden": "true" },
      text: icon || "\u25a2",
    });

    const controls = [];
    if (minimizable) {
      controls.push(
        createElement("button", {
          className: "window__control window__control--minimize",
          attrs: { type: "button", "aria-label": `Minimize ${title}` },
          text: "\u2013",
          on: { click: (e) => { e.stopPropagation(); this._callbacks.onRequestMinimize(this.id); } },
        })
      );
    }
    if (maximizable) {
      this._maximizeButton = createElement("button", {
        className: "window__control window__control--maximize",
        attrs: { type: "button", "aria-label": `Maximize ${title}` },
        text: "\u25a1",
        on: { click: (e) => { e.stopPropagation(); this._callbacks.onRequestMaximizeToggle(this.id); } },
      });
      controls.push(this._maximizeButton);
    }
    if (closable) {
      controls.push(
        createElement("button", {
          className: "window__control window__control--close",
          attrs: { type: "button", "aria-label": `Close ${title}` },
          text: "\u2715",
          on: { click: (e) => { e.stopPropagation(); this._callbacks.onRequestClose(this.id); } },
        })
      );
    }

    this._titlebarEl = createElement("div", {
      className: "window__titlebar",
      children: [
        createElement("div", { className: "window__titlebar-info", children: [iconEl, this._titleEl] }),
        createElement("div", { className: "window__controls", children: controls }),
      ],
      on: {
        pointerdown: (e) => this._onTitlebarPointerDown(e),
        dblclick: (e) => {
          if (e.target.closest(".window__control")) return;
          if (maximizable) this._callbacks.onRequestMaximizeToggle(this.id);
        },
      },
    });

    const bodyEl = createElement("div", { className: "window__body", children: [content] });

    const handles = resizable
      ? RESIZE_HANDLES.map((handle) =>
          createElement("div", {
            className: `window__resize-handle window__resize-handle--${handle}`,
            attrs: { "aria-hidden": "true" },
            on: { pointerdown: (e) => this._onResizePointerDown(e, handle) },
          })
        )
      : [];

    this._el = createElement("div", {
      className: "window",
      attrs: {
        role: "dialog",
        "aria-label": title,
        tabindex: "-1",
        "data-window-id": this.id,
      },
      children: [this._titlebarEl, bodyEl, ...handles],
      on: {
        pointerdown: () => this._callbacks.onRequestFocus(this.id),
      },
    });
  }

  // ---------------------------------------------------------------
  // Layout
  // ---------------------------------------------------------------

  /**
   * @param {{x:number,y:number,width:number,height:number}} rect
   * @returns {void}
   */
  _applyRect(rect) {
    this._rect = rect;
    this._el.style.left = `${rect.x}px`;
    this._el.style.top = `${rect.y}px`;
    this._el.style.width = `${rect.width}px`;
    this._el.style.height = `${rect.height}px`;
  }

  /** @returns {{width:number,height:number}} */
  _getBounds() {
    const boundsRect = this._boundsElement.getBoundingClientRect();
    return { width: boundsRect.width, height: boundsRect.height };
  }

  /**
   * @param {number} x
   * @param {number} y
   * @param {number} width
   * @returns {{x:number,y:number}}
   */
  _clampPosition(x, y, width) {
    const bounds = this._getBounds();
    const minX = -(width - MIN_VISIBLE_PX);
    const maxX = bounds.width - MIN_VISIBLE_PX;
    const minY = 0;
    const maxY = bounds.height - TITLEBAR_HEIGHT_PX;
    return {
      x: Math.min(Math.max(x, minX), Math.max(minX, maxX)),
      y: Math.min(Math.max(y, minY), Math.max(minY, maxY)),
    };
  }

  // ---------------------------------------------------------------
  // Dragging
  // ---------------------------------------------------------------

  /**
   * @param {PointerEvent} e
   * @returns {void}
   */
  _onTitlebarPointerDown(e) {
    if (e.target.closest(".window__control")) return;
    if (this._isMaximized) return;
    if (e.button !== 0) return;

    this._callbacks.onRequestFocus(this.id);

    const startRect = { ...this._rect };
    this._activeDrag = {
      type: "move",
      startClientX: e.clientX,
      startClientY: e.clientY,
      startRect,
    };

    this._titlebarEl.setPointerCapture(e.pointerId);
    const onMove = (moveEvent) => this._handleMovePointerMove(moveEvent);
    const onUp = () => {
      this._titlebarEl.removeEventListener("pointermove", onMove);
      this._titlebarEl.removeEventListener("pointerup", onUp);
      this._titlebarEl.removeEventListener("pointercancel", onUp);
      this._finishMove();
    };
    this._titlebarEl.addEventListener("pointermove", onMove);
    this._titlebarEl.addEventListener("pointerup", onUp);
    this._titlebarEl.addEventListener("pointercancel", onUp);
  }

  /**
   * @param {PointerEvent} e
   * @returns {void}
   */
  _handleMovePointerMove(e) {
    if (!this._activeDrag || this._activeDrag.type !== "move") return;
    const drag = this._activeDrag;
    const dx = e.clientX - drag.startClientX;
    const dy = e.clientY - drag.startClientY;

    if (this._rafId !== null) cancelAnimationFrame(this._rafId);
    this._rafId = requestAnimationFrame(() => {
      const clamped = this._clampPosition(
        drag.startRect.x + dx,
        drag.startRect.y + dy,
        drag.startRect.width
      );
      this._el.style.left = `${clamped.x}px`;
      this._el.style.top = `${clamped.y}px`;
      this._pendingRect = { ...this._rect, x: clamped.x, y: clamped.y };
    });
  }

  /** @returns {void} */
  _finishMove() {
    if (this._pendingRect) {
      this._rect = this._pendingRect;
      this._pendingRect = null;
    }
    this._activeDrag = null;
    this._callbacks.onMoved(this.id, { x: this._rect.x, y: this._rect.y });
  }

  // ---------------------------------------------------------------
  // Resizing
  // ---------------------------------------------------------------

  /**
   * @param {PointerEvent} e
   * @param {string} handle
   * @returns {void}
   */
  _onResizePointerDown(e, handle) {
    if (this._isMaximized) return;
    if (e.button !== 0) return;
    e.stopPropagation();

    this._callbacks.onRequestFocus(this.id);

    const startRect = { ...this._rect };
    this._activeDrag = {
      type: "resize",
      handle,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startRect,
    };

    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    const onMove = (moveEvent) => this._handleResizePointerMove(moveEvent);
    const onUp = () => {
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onUp);
      target.removeEventListener("pointercancel", onUp);
      this._finishResize();
    };
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onUp);
    target.addEventListener("pointercancel", onUp);
  }

  /**
   * @param {PointerEvent} e
   * @returns {void}
   */
  _handleResizePointerMove(e) {
    if (!this._activeDrag || this._activeDrag.type !== "resize") return;
    const drag = this._activeDrag;
    const dx = e.clientX - drag.startClientX;
    const dy = e.clientY - drag.startClientY;
    const { minWidth, minHeight } = this._config;

    if (this._rafId !== null) cancelAnimationFrame(this._rafId);
    this._rafId = requestAnimationFrame(() => {
      let { x, y, width, height } = drag.startRect;

      if (drag.handle.includes("e")) width = drag.startRect.width + dx;
      if (drag.handle.includes("s")) height = drag.startRect.height + dy;
      if (drag.handle.includes("w")) {
        width = drag.startRect.width - dx;
        x = drag.startRect.x + dx;
      }
      if (drag.handle.includes("n")) {
        height = drag.startRect.height - dy;
        y = drag.startRect.y + dy;
      }

      if (width < minWidth) {
        if (drag.handle.includes("w")) x -= minWidth - width;
        width = minWidth;
      }
      if (height < minHeight) {
        if (drag.handle.includes("n")) y -= minHeight - height;
        height = minHeight;
      }

      this._el.style.left = `${x}px`;
      this._el.style.top = `${y}px`;
      this._el.style.width = `${width}px`;
      this._el.style.height = `${height}px`;
      this._pendingRect = { x, y, width, height };
    });
  }

  /** @returns {void} */
  _finishResize() {
    if (this._pendingRect) {
      this._rect = this._pendingRect;
      this._pendingRect = null;
    }
    this._activeDrag = null;
    this._callbacks.onResized(this.id, { ...this._rect });
  }
}
