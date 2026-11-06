/**
 * @file ShellPanel — the floating panel used by every system tray
 * control (Notification Center, Quick Settings, date panel).
 *
 * A panel opens above the taskbar, aligned to the tray button that owns
 * it, and stacks above application windows. It closes on Escape (focus
 * returns to its button), on a click outside it and its button, and
 * when the owner closes it (another panel or the Start Menu opening).
 * The button's `aria-expanded` always matches the panel's state.
 *
 * Content is supplied by the owner and stays mounted while the panel is
 * closed, so reopening is instant and keeps scroll position.
 */

import { createElement } from "../../utils/dom.js";
import { getMotionDuration } from "../../utils/motion.js";

const VIEWPORT_MARGIN = 8;

export class ShellPanel {
  /**
   * @param {object} config
   * @param {string} config.id - DOM id of the panel (the button's aria-controls).
   * @param {string} config.label - Accessible name.
   * @param {HTMLElement} config.anchorEl - The tray button that toggles it.
   * @param {HTMLElement} config.content
   * @param {string} [config.className] - Extra class for size/variant.
   * @param {() => (HTMLElement|null)} [config.initialFocus] - Element focused on open; defaults to the panel itself.
   * @param {() => void} [config.onOpen]
   * @param {(reason: string) => void} [config.onClose]
   */
  constructor({ id, label, anchorEl, content, className = "", initialFocus, onOpen, onClose }) {
    this._anchorEl = anchorEl;
    this._initialFocus = initialFocus ?? null;
    this._onOpen = onOpen ?? null;
    this._onClose = onClose ?? null;
    this._open = false;
    this._hideTimer = null;

    this._el = createElement("section", {
      className: `shell-panel ${className}`.trim(),
      attrs: { id, role: "dialog", "aria-label": label, tabindex: "-1", hidden: "" },
      children: [content],
      on: { keydown: (e) => this._handleKeydown(e) },
    });
    document.body.append(this._el);

    anchorEl.setAttribute("aria-controls", id);
    anchorEl.setAttribute("aria-expanded", "false");
    anchorEl.setAttribute("aria-haspopup", "dialog");

    this._outsideHandler = (e) => {
      if (!this._open) return;
      const target = e.target;
      if (this._el.contains(target) || this._anchorEl.contains(target)) return;
      // Menus and dialogs opened from inside the panel are not "outside".
      if (target instanceof Element && target.closest(".context-menu, .dialog-backdrop, .dialog")) return;
      this.close({ reason: "outside", restoreFocus: false });
    };
    this._resizeHandler = () => {
      if (this._open) this._position();
    };
    // Escape closes the panel even when focus has left it (for example
    // after the focused entry was removed). Keys handled elsewhere first
    // (dialogs, menus, the panel's own controls) are left alone.
    this._documentKeyHandler = (e) => {
      if (this._open && e.key === "Escape" && !e.defaultPrevented && !this._el.contains(e.target)) {
        const target = e.target;
        if (target instanceof Element && target.closest(".dialog, .context-menu")) return;
        e.preventDefault();
        this.close({ reason: "escape", restoreFocus: true });
      }
    };
  }

  /** @returns {HTMLElement} */
  getElement() {
    return this._el;
  }

  /** @returns {boolean} */
  isOpen() {
    return this._open;
  }

  /** @returns {void} */
  open() {
    if (this._open) return;
    this._open = true;
    window.clearTimeout(this._hideTimer);
    this._el.hidden = false;
    this._el.classList.remove("shell-panel--leaving");
    this._position();
    this._anchorEl.setAttribute("aria-expanded", "true");
    this._anchorEl.classList.add("tray-button--open");
    requestAnimationFrame(() => {
      if (this._open) this._el.classList.add("shell-panel--visible");
    });
    document.addEventListener("pointerdown", this._outsideHandler, true);
    document.addEventListener("keydown", this._documentKeyHandler);
    window.addEventListener("resize", this._resizeHandler);
    this._onOpen?.();
    const target = this._initialFocus?.() ?? this._el;
    target.focus({ preventScroll: true });
  }

  /**
   * @param {{reason?: string, restoreFocus?: boolean}} [options]
   * @returns {void}
   */
  close({ reason = "programmatic", restoreFocus = false } = {}) {
    if (!this._open) return;
    this._open = false;
    this._anchorEl.setAttribute("aria-expanded", "false");
    this._anchorEl.classList.remove("tray-button--open");
    this._el.classList.remove("shell-panel--visible");
    this._el.classList.add("shell-panel--leaving");
    document.removeEventListener("pointerdown", this._outsideHandler, true);
    document.removeEventListener("keydown", this._documentKeyHandler);
    window.removeEventListener("resize", this._resizeHandler);
    const hadFocus = this._el.contains(document.activeElement);
    this._hideTimer = window.setTimeout(() => {
      if (!this._open) this._el.hidden = true;
    }, getMotionDuration("fast") + 40);
    if (restoreFocus || (hadFocus && reason !== "outside")) this._anchorEl.focus({ preventScroll: true });
    this._onClose?.(reason);
  }

  /** @returns {void} */
  toggle() {
    if (this._open) this.close({ reason: "toggle", restoreFocus: true });
    else this.open();
  }

  /** @returns {void} */
  destroy() {
    this.close({ reason: "destroyed" });
    window.clearTimeout(this._hideTimer);
    this._el.remove();
  }

  /** @returns {void} */
  _position() {
    const anchor = this._anchorEl.getBoundingClientRect();
    const width = this._el.offsetWidth;
    const right = Math.max(VIEWPORT_MARGIN, window.innerWidth - anchor.right);
    const maxRight = Math.max(VIEWPORT_MARGIN, window.innerWidth - width - VIEWPORT_MARGIN);
    this._el.style.right = `${Math.min(right, maxRight)}px`;
  }

  /**
   * @param {KeyboardEvent} e
   * @returns {void}
   */
  _handleKeydown(e) {
    if (e.key === "Escape" && !e.defaultPrevented) {
      e.preventDefault();
      e.stopPropagation();
      this.close({ reason: "escape", restoreFocus: true });
    }
  }
}
