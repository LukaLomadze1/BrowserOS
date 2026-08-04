/**
 * @file ContextMenu — a generic right-click menu, now with submenu
 * support ("New >" needs it). Deliberately has no idea what a
 * "desktop" or "icon" is: it just renders items and reports clicks.
 * DesktopManager (or any future caller — Explorer, Taskbar, etc.)
 * supplies the items and positions it, and decides what EventBus
 * events, if any, surround opening/closing it.
 *
 * A submenu is just another ContextMenu instance, anchored to its
 * trigger item's rect instead of a click point. Keyboard input is
 * deferred to whichever menu is innermost: a menu with an active
 * submenu ignores its own keydown handler entirely (see _onKeyDown),
 * so Escape/Arrow keys always act on the submenu first and only
 * reach the parent once the submenu has closed.
 */

import { createElement } from "../../utils/dom.js";

const CLOSE_ANIMATION_MS = 160;

class ContextMenu {
  constructor() {
    this._el = null;
    /** @type {Array<{item: object, el: HTMLElement, hasSubmenu: boolean}>} */
    this._itemEls = [];
    this._outsideClickHandler = null;
    this._keydownHandler = null;
    this._onClose = null;
    /** @type {ContextMenu|null} Set when this instance IS a submenu. */
    this._parentMenu = null;
    /** @type {ContextMenu|null} Set on the parent while one of its submenus is open. */
    this._activeSubmenu = null;
    this._activeSubmenuTriggerEl = null;
  }

  /**
   * @param {Array<{label?: string, action?: () => void, disabled?: boolean, separator?: boolean, submenu?: Array}>} items
   * @param {{x: number, y: number}|{itemRect: DOMRect}} anchor - Either viewport coordinates (top-level menus) or a trigger item's rect (submenus, anchored beside it).
   * @param {{onClose?: () => void, parentMenu?: ContextMenu}} [options] - `onClose` fires once, whenever the menu closes for any reason. `parentMenu` is set internally when opening a submenu.
   * @returns {void}
   */
  show(items, anchor, options = {}) {
    this.hide();
    this._onClose = options.onClose ?? null;
    this._parentMenu = options.parentMenu ?? null;
    this._itemEls = [];

    const itemEls = items.map((item) => this._buildItemEl(item));

    this._el = createElement("div", { className: "context-menu", attrs: { role: "menu" }, children: itemEls });
    document.body.append(this._el);
    this._positionMenu(anchor);

    requestAnimationFrame(() => {
      this._el?.classList.add("context-menu--visible");
      this._focusFirstItem();
    });

    this._outsideClickHandler = (e) => {
      if (this._isEventInsideMenuTree(e.target)) return;
      this.hide();
    };
    this._keydownHandler = (e) => this._onKeyDown(e);
    // Bind on the next tick so the pointerdown/contextmenu that
    // opened this menu doesn't immediately trigger "outside click".
    window.setTimeout(() => {
      document.addEventListener("pointerdown", this._outsideClickHandler, true);
      document.addEventListener("keydown", this._keydownHandler, true);
    }, 0);
  }

  /**
   * Close the menu, if open. Safe to call when already closed. Also
   * closes any open submenu first, so a parent can never disappear
   * while a submenu is still hanging open on screen.
   * @returns {void}
   */
  hide() {
    if (!this._el) return;

    this._closeActiveSubmenu();

    document.removeEventListener("pointerdown", this._outsideClickHandler, true);
    document.removeEventListener("keydown", this._keydownHandler, true);

    const el = this._el;
    this._el = null;
    el.classList.remove("context-menu--visible");
    window.setTimeout(() => el.remove(), CLOSE_ANIMATION_MS);

    if (this._onClose) {
      const callback = this._onClose;
      this._onClose = null;
      callback();
    }
  }

  /**
   * @returns {boolean}
   */
  isOpen() {
    return this._el !== null;
  }

  // ---------------------------------------------------------------
  // Item construction
  // ---------------------------------------------------------------

  /**
   * @param {object} item
   * @returns {HTMLElement}
   */
  _buildItemEl(item) {
    if (item.separator) {
      return createElement("div", { className: "context-menu__separator", attrs: { role: "separator" } });
    }

    const disabled = item.disabled ?? false;
    const hasSubmenu = Array.isArray(item.submenu) && item.submenu.length > 0;

    const attrs = { type: "button", role: "menuitem" };
    if (hasSubmenu) {
      attrs["aria-haspopup"] = "true";
      attrs["aria-expanded"] = "false";
    }
    if (disabled) {
      attrs["aria-disabled"] = "true";
      attrs.disabled = "true";
    }

    const children = hasSubmenu
      ? [
          createElement("span", { className: "context-menu__item-label", text: item.label }),
          createElement("span", { className: "context-menu__item-arrow", attrs: { "aria-hidden": "true" }, text: "\u203a" }),
        ]
      : undefined;

    const className = [
      "context-menu__item",
      disabled ? "context-menu__item--disabled" : "",
      hasSubmenu ? "context-menu__item--has-submenu" : "",
    ]
      .filter(Boolean)
      .join(" ");

    const on = disabled
      ? {}
      : hasSubmenu
        ? { click: (e) => { e.stopPropagation(); this._toggleSubmenu(item, el); } }
        : { click: () => { this.hide(); item.action?.(); } };

    const el = createElement("button", {
      className,
      attrs,
      text: hasSubmenu ? undefined : item.label,
      children,
      on,
    });

    this._itemEls.push({ item, el, hasSubmenu });
    return el;
  }

  // ---------------------------------------------------------------
  // Positioning
  // ---------------------------------------------------------------

  /**
   * @param {{x: number, y: number}|{itemRect: DOMRect}} anchor
   * @returns {void}
   */
  _positionMenu(anchor) {
    const rect = this._el.getBoundingClientRect();

    if (anchor.itemRect) {
      const itemRect = anchor.itemRect;
      let x = itemRect.right - 4;
      let y = itemRect.top;
      if (x + rect.width > window.innerWidth - 8) {
        x = itemRect.left - rect.width + 4;
      }
      x = Math.max(8, x);
      y = Math.min(y, Math.max(8, window.innerHeight - rect.height - 8));
      this._el.style.left = `${x}px`;
      this._el.style.top = `${y}px`;
      return;
    }

    const maxX = window.innerWidth - rect.width - 8;
    const maxY = window.innerHeight - rect.height - 8;
    const x = Math.min(anchor.x, Math.max(8, maxX));
    const y = Math.min(anchor.y, Math.max(8, maxY));
    this._el.style.left = `${x}px`;
    this._el.style.top = `${y}px`;
  }

  // ---------------------------------------------------------------
  // Submenus
  // ---------------------------------------------------------------

  /**
   * @param {object} item
   * @param {HTMLElement} triggerEl
   * @returns {void}
   */
  _toggleSubmenu(item, triggerEl) {
    if (this._activeSubmenu && this._activeSubmenuTriggerEl === triggerEl) {
      this._closeActiveSubmenu();
      return;
    }
    this._openSubmenu(item, triggerEl);
  }

  /**
   * @param {object} item
   * @param {HTMLElement} triggerEl
   * @returns {void}
   */
  _openSubmenu(item, triggerEl) {
    this._closeActiveSubmenu();

    const submenu = new ContextMenu();
    const rect = triggerEl.getBoundingClientRect();
    triggerEl.setAttribute("aria-expanded", "true");
    triggerEl.classList.add("context-menu__item--submenu-open");

    submenu.show(
      item.submenu,
      { itemRect: rect },
      {
        parentMenu: this,
        onClose: () => {
          triggerEl.setAttribute("aria-expanded", "false");
          triggerEl.classList.remove("context-menu__item--submenu-open");
          if (this._activeSubmenu === submenu) {
            this._activeSubmenu = null;
            this._activeSubmenuTriggerEl = null;
          }
          triggerEl.focus();
        },
      }
    );

    this._activeSubmenu = submenu;
    this._activeSubmenuTriggerEl = triggerEl;
  }

  /** @returns {void} */
  _closeActiveSubmenu() {
    if (this._activeSubmenu) {
      this._activeSubmenu.hide();
    }
  }

  /**
   * @param {Node} target
   * @returns {boolean}
   */
  _isEventInsideMenuTree(target) {
    if (this._el && this._el.contains(target)) return true;
    if (this._activeSubmenu && this._activeSubmenu._isEventInsideMenuTree(target)) return true;
    return false;
  }

  // ---------------------------------------------------------------
  // Keyboard navigation
  // ---------------------------------------------------------------

  /**
   * @param {KeyboardEvent} e
   * @returns {void}
   */
  _onKeyDown(e) {
    // An open submenu owns keyboard input until it closes itself.
    if (this._activeSubmenu) return;

    switch (e.key) {
      case "Escape":
        e.preventDefault();
        this.hide();
        break;
      case "ArrowDown":
        e.preventDefault();
        this._moveFocus(1);
        break;
      case "ArrowUp":
        e.preventDefault();
        this._moveFocus(-1);
        break;
      case "ArrowRight":
        this._openSubmenuFromFocusedItem();
        break;
      case "ArrowLeft":
        if (this._parentMenu) {
          e.preventDefault();
          this.hide();
        }
        break;
      default:
        break;
    }
  }

  /**
   * @param {number} delta - +1 for next, -1 for previous.
   * @returns {void}
   */
  _moveFocus(delta) {
    const enabledEls = this._itemEls.filter(({ el }) => !el.disabled).map(({ el }) => el);
    if (enabledEls.length === 0) return;

    const currentIndex = enabledEls.indexOf(document.activeElement);
    const nextIndex = currentIndex === -1 ? 0 : (currentIndex + delta + enabledEls.length) % enabledEls.length;
    enabledEls[nextIndex].focus();
  }

  /** @returns {void} */
  _openSubmenuFromFocusedItem() {
    const current = this._itemEls.find(({ el }) => el === document.activeElement);
    if (current && current.hasSubmenu) {
      this._openSubmenu(current.item, current.el);
    }
  }

  /** @returns {void} */
  _focusFirstItem() {
    const firstEnabled = this._itemEls.find(({ el }) => !el.disabled);
    firstEnabled?.el.focus();
  }
}

export { ContextMenu };
