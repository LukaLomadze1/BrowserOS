/**
 * @file Dialog — a generic modal shell. Knows nothing about deletion,
 * file properties, or anything domain-specific: it renders a title, a
 * caller-supplied body element, and a row of buttons, then resolves a
 * Promise with whichever button's value was chosen (or `null` for
 * Escape / backdrop click). ConfirmDialog and PropertiesDialog are
 * both thin call sites built on this.
 *
 * Each call creates and disposes its own instance — dialogs are
 * inherently one-at-a-time in practice, so there's no shared state to
 * get wrong by not making this a singleton like ContextMenu.
 *
 * Modal behavior: while any dialog is open the desktop behind it
 * (#app-root) is inert — unreachable by mouse, keyboard, and assistive
 * technology — and only the topmost dialog responds to Escape, Tab,
 * and Enter. Tab and Shift+Tab cycle through the dialog's controls;
 * closing returns focus to whatever had it before.
 *
 * Form dialogs (event editor, rename/prompt) use three optional hooks:
 * `onBeforeClose` can veto a button (e.g. invalid input keeps the
 * dialog open while it shows an error), `submitValue` makes Enter in a
 * single-line field act like that button, and `initialFocus` focuses a
 * specific field instead of the autofocus button.
 */

import { createElement } from "../../utils/dom.js";
import { getMotionDuration } from "../../utils/motion.js";

/** Extra time allowed past the exit transition (--duration-normal) before the backdrop is removed. */
const CLOSE_ANIMATION_GRACE_MS = 40;
const FOCUSABLE = "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex='-1'])";

/** @type {Dialog[]} Open dialogs, topmost last. */
const openDialogs = [];

/**
 * Make the desktop inert while any dialog is open.
 * @returns {void}
 */
function syncBackgroundInert() {
  const appRoot = document.getElementById("app-root");
  if (!appRoot) return;
  if (openDialogs.length > 0) {
    if (!appRoot.hasAttribute("data-dialog-inert")) {
      appRoot.setAttribute("data-dialog-inert", appRoot.inert ? "kept" : "set");
      appRoot.inert = true;
    }
  } else if (appRoot.hasAttribute("data-dialog-inert")) {
    if (appRoot.getAttribute("data-dialog-inert") === "set" && !document.querySelector(".system-screen")) appRoot.inert = false;
    appRoot.removeAttribute("data-dialog-inert");
  }
}

class Dialog {
  /**
   * @param {object} config
   * @param {string} config.title
   * @param {"dialog"|"alertdialog"} [config.role]
   * @param {HTMLElement} config.bodyElement
   * @param {Array<{label: string, value: *, variant?: "default"|"primary"|"danger", autofocus?: boolean}>} config.buttons
   * @param {boolean} [config.closeOnOutsideClick]
   * @param {(result: *) => (boolean|Promise<boolean>)} [config.onBeforeClose] - Called for button and submit
   *   results (never for Escape/backdrop); returning false keeps the dialog open.
   * @param {*} [config.submitValue] - When set, Enter in a single-line input closes with this value.
   * @param {HTMLElement} [config.initialFocus] - Element focused when the dialog opens.
   * @param {string} [config.className] - Extra class on the dialog panel, e.g. "dialog--wide".
   * @param {(result: *) => void} config.onClose - Called exactly once with the chosen button's value, or null.
   */
  constructor(config) {
    this._config = config;
    this._settled = false;
    this._previousActiveElement = document.activeElement;
    this._keydownHandler = (e) => this._onKeyDown(e);
    this._buildDom();
    this._open();
  }

  /** @returns {HTMLElement} */
  getElement() {
    return this._dialogEl;
  }

  /**
   * @param {*} result
   * @returns {void}
   */
  close(result = null) {
    if (this._settled) return;
    this._settled = true;

    document.removeEventListener("keydown", this._keydownHandler, true);
    const index = openDialogs.indexOf(this);
    if (index !== -1) openDialogs.splice(index, 1);
    syncBackgroundInert();
    this._dialogEl.classList.remove("dialog--visible");
    this._backdropEl.classList.remove("dialog-backdrop--visible");

    const backdrop = this._backdropEl;
    window.setTimeout(() => backdrop.remove(), getMotionDuration("normal") + CLOSE_ANIMATION_GRACE_MS);

    if (this._previousActiveElement?.isConnected && typeof this._previousActiveElement.focus === "function") {
      this._previousActiveElement.focus({ preventScroll: true });
    }

    this._config.onClose(result);
  }

  /**
   * Close with a button or submit result, unless onBeforeClose vetoes it.
   * @param {*} result
   * @returns {Promise<void>}
   */
  async _requestClose(result) {
    if (this._settled || this._validating) return;
    if (typeof this._config.onBeforeClose === "function") {
      this._validating = true;
      let allowed = true;
      try {
        allowed = (await this._config.onBeforeClose(result)) !== false;
      } catch (error) {
        console.error("[Dialog] onBeforeClose threw:", error);
        allowed = false;
      } finally {
        this._validating = false;
      }
      if (!allowed) return;
    }
    this.close(result);
  }

  /** @returns {void} */
  _buildDom() {
    const titleId = `dialog-title-${Math.random().toString(36).slice(2)}`;

    const titleEl = createElement("h2", { className: "dialog__title", attrs: { id: titleId }, text: this._config.title });

    const buttonsEl = createElement("div", {
      className: "dialog__buttons",
      children: (this._config.buttons ?? []).map((button) => this._buildButton(button)),
    });

    this._dialogEl = createElement("div", {
      className: this._config.className ? `dialog ${this._config.className}` : "dialog",
      attrs: {
        role: this._config.role ?? "dialog",
        "aria-modal": "true",
        "aria-labelledby": titleId,
        tabindex: "-1",
      },
      children: [titleEl, createElement("div", { className: "dialog__body", children: [this._config.bodyElement] }), buttonsEl],
    });

    this._backdropEl = createElement("div", {
      className: "dialog-backdrop",
      children: [this._dialogEl],
      on: {
        pointerdown: (e) => {
          if (e.target === this._backdropEl && (this._config.closeOnOutsideClick ?? true)) {
            this.close(null);
          }
        },
      },
    });

    document.body.append(this._backdropEl);
  }

  /**
   * @param {{label: string, value: *, variant?: string, autofocus?: boolean}} button
   * @returns {HTMLElement}
   */
  _buildButton(button) {
    const variant = button.variant ?? "default";
    const el = createElement("button", {
      className: `dialog__button dialog__button--${variant}`,
      attrs: { type: "button" },
      text: button.label,
      // A null-valued button is a plain cancel and never needs validation.
      on: { click: () => (button.value === null ? this.close(null) : this._requestClose(button.value)) },
    });
    if (button.autofocus) this._autofocusTarget = el;
    return el;
  }

  /** @returns {void} */
  _open() {
    requestAnimationFrame(() => {
      this._backdropEl.classList.add("dialog-backdrop--visible");
      this._dialogEl.classList.add("dialog--visible");
      (this._config.initialFocus ?? this._autofocusTarget ?? this._dialogEl).focus();
    });
    document.addEventListener("keydown", this._keydownHandler, true);
    openDialogs.push(this);
    syncBackgroundInert();
  }

  /**
   * @param {KeyboardEvent} e
   * @returns {void}
   */
  _onKeyDown(e) {
    // Only the topmost dialog answers keys.
    if (openDialogs[openDialogs.length - 1] !== this) return;
    if (e.key === "Escape") {
      e.preventDefault();
      this.close(null);
      return;
    }
    if (e.key === "Tab") {
      this._trapTabFocus(e);
      return;
    }
    if (
      e.key === "Enter" &&
      "submitValue" in this._config &&
      e.target instanceof HTMLInputElement &&
      this._dialogEl.contains(e.target) &&
      !["checkbox", "radio", "button"].includes(e.target.type)
    ) {
      e.preventDefault();
      this._requestClose(this._config.submitValue);
    }
  }

  /**
   * @param {KeyboardEvent} e
   * @returns {void}
   */
  _trapTabFocus(e) {
    const focusable = [...this._dialogEl.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null);
    if (focusable.length === 0) {
      e.preventDefault();
      this._dialogEl.focus();
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const current = focusable.indexOf(document.activeElement);

    if (current === -1) {
      // Focus is on the dialog itself (or somewhere it shouldn't be): enter the cycle.
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
    } else if (e.shiftKey && current === 0) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && current === focusable.length - 1) {
      e.preventDefault();
      first.focus();
    }
  }
}

/**
 * @param {object} config - See Dialog's constructor JSDoc (minus onClose).
 * @returns {Promise<*>} Resolves with the chosen button's value, or null.
 */
export function openDialog(config) {
  return new Promise((resolve) => {
    new Dialog({ ...config, onClose: (result) => resolve(result) });
  });
}
