/**
 * @file DesktopIconView — the visual, interactive shell of one
 * desktop icon. Like WindowView, it holds no cross-icon state
 * (selection set, grid layout, drag conflicts) — that belongs to
 * DesktopManager, which drives this view through callbacks.
 *
 * This view only reports raw gesture facts (pointer went down, a
 * click happened with no drag, a drag crossed the threshold, it
 * moved, it ended). It never decides what those facts mean for
 * selection — that decision lives in exactly one place,
 * DesktopManager + SelectionManager, so click, Ctrl+click, and drag
 * can never disagree about what should be selected.
 *
 * Inline rename (startRename/setLabel/showRenameError) follows the
 * same split: this view owns the input's DOM and interaction, but
 * DesktopManager decides whether a rename attempt is valid (VFS
 * validation is async) and is the one that calls showRenameError()
 * if it isn't — the input itself never talks to the VFS.
 */

import { createElement } from "../../utils/dom.js";
import { renderIcon } from "../../utils/icons.js";

const DRAG_THRESHOLD_PX = 4;

class DesktopIconView {
  /**
   * @param {{id: string, label: string, icon: string}} config
   * @param {object} callbacks
   * @param {(id: string, options: {additive: boolean}) => void} callbacks.onPointerDown - Fired immediately on pointerdown, before it's known whether this becomes a click or a drag.
   * @param {(id: string, options: {additive: boolean}) => void} callbacks.onClick - Fired on pointerup only when no drag occurred.
   * @param {(id: string) => void} callbacks.onOpen
   * @param {(id: string, clientX: number, clientY: number) => void} callbacks.onContextMenu
   * @param {(id: string) => void} callbacks.onDragStart
   * @param {(id: string, dx: number, dy: number) => void} callbacks.onDragMove
   * @param {(id: string, dx: number, dy: number) => void} callbacks.onDragEnd
   * @param {(id: string) => void} callbacks.onFocusIn
   */
  constructor(config, callbacks) {
    this.id = config.id;
    this._config = config;
    this._callbacks = callbacks;
    this._pointerDownState = null; // { startX, startY, dragging, additive }

    this._glyphEl = null;
    this._labelEl = null;
    this._inputEl = null;
    this._errorEl = null;
    this._isRenaming = false;

    this._buildDom();
  }

  /** @returns {HTMLElement} */
  getElement() {
    return this._el;
  }

  /**
   * @param {number} x
   * @param {number} y
   * @returns {void}
   */
  setPixelPosition(x, y) {
    this._el.style.left = `${x}px`;
    this._el.style.top = `${y}px`;
  }

  /**
   * Temporarily suppress the position transition while a drag is
   * actively updating style.left/top every frame, so it doesn't
   * fight the CSS transition meant for snap/sort animations.
   * @param {boolean} isDragging
   * @returns {void}
   */
  setDragging(isDragging) {
    this._el.classList.toggle("desktop-icon--dragging", isDragging);
  }

  /**
   * @param {boolean} isSelected
   * @returns {void}
   */
  setSelected(isSelected) {
    this._el.classList.toggle("desktop-icon--selected", isSelected);
    this._el.setAttribute("aria-selected", isSelected ? "true" : "false");
  }

  /**
   * Subtle pending visual for an item that's on the clipboard as a
   * "cut" (as opposed to "copy") — cleared automatically once the
   * paste completes and the clipboard clears.
   * @param {boolean} isCut
   * @returns {void}
   */
  setCut(isCut) {
    this._el.classList.toggle("desktop-icon--cut", isCut);
  }

  /**
   * Update the visible name. The VFS event listener is the only
   * caller of this after a successful rename — never rename-input
   * logic itself — so there is exactly one path that changes what's
   * on screen.
   * @param {string} label
   * @returns {void}
   */
  setLabel(label) {
    this._config.label = label;
    this._labelEl.textContent = label;
    this._el.setAttribute("aria-label", label);
  }

  /**
   * @returns {void}
   */
  focus() {
    this._el.focus();
  }

  /**
   * @returns {boolean}
   */
  isRenaming() {
    return this._isRenaming;
  }

  /**
   * Replace the label with a text input, pre-selected like a desktop
   * file manager (stem only for files, full name for folders), and wire
   * Enter/Escape/blur. `onConfirm` does the actual (async) VFS
   * rename and validation; returning `false` keeps rename mode open
   * with whatever error `showRenameError()` was called with,
   * returning `true` exits it normally.
   * @param {{stem: string, extension: string, onConfirm: (value: string) => Promise<boolean>, onCancel: () => void}} config
   * @returns {void}
   */
  startRename(config) {
    if (this._isRenaming) return;
    this._isRenaming = true;
    this._renameConfig = config;

    const fullName = `${config.stem}${config.extension}`;

    this._inputEl = createElement("input", {
      className: "desktop-icon__rename-input",
      attrs: { type: "text", "aria-label": `Rename ${fullName}`, spellcheck: "false" },
    });
    this._inputEl.value = fullName;

    this._errorEl = createElement("div", { className: "desktop-icon__rename-error", attrs: { role: "alert" } });

    this._labelEl.replaceWith(this._inputEl);
    this._el.append(this._errorEl);
    this._el.classList.add("desktop-icon--renaming");

    // Stop clicks/drags on the input from reaching the icon's own
    // pointer handling — native text-field interaction (caret
    // placement, drag-to-select) must work unimpeded.
    this._inputEl.addEventListener("pointerdown", (e) => e.stopPropagation());
    this._inputEl.addEventListener("click", (e) => e.stopPropagation());
    this._inputEl.addEventListener("dblclick", (e) => e.stopPropagation());

    this._inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        this._finishRename(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        // Stop this Escape from also reaching the desktop-wide
        // "clear selection" handler — cancelling a rename should
        // only cancel the rename.
        e.stopPropagation();
        this._finishRename(false);
      }
    });

    this._inputEl.addEventListener("blur", () => {
      // "Clicking outside confirms" — blur covers that plus Tab-away.
      this._finishRename(true);
    });

    requestAnimationFrame(() => {
      // Rename mode can end (Escape, blur, or a caller force-exiting
      // it) before this frame runs — guard rather than crash on a
      // now-null input.
      if (!this._isRenaming || !this._inputEl) return;
      this._inputEl.focus();
      if (config.extension) {
        this._inputEl.setSelectionRange(0, config.stem.length);
      } else {
        this._inputEl.select();
      }
    });
  }

  /**
   * Show a validation/rename error inline without leaving rename
   * mode, and refocus the input so the user can immediately correct
   * it.
   * @param {string} message
   * @returns {void}
   */
  showRenameError(message) {
    if (!this._isRenaming || !this._errorEl) return;
    this._errorEl.textContent = message;
    this._el.classList.add("desktop-icon--rename-error");
    this._inputEl?.focus();
  }

  /**
   * @param {boolean} confirm
   * @returns {void}
   */
  async _finishRename(confirm) {
    if (!this._isRenaming) return;
    const config = this._renameConfig;

    if (confirm) {
      const value = this._inputEl.value;
      const ok = await config.onConfirm(value);
      if (!ok) return; // Stay in rename mode; caller already surfaced the error.
    } else {
      config.onCancel();
    }

    this._exitRenameMode();
  }

  /** @returns {void} */
  _exitRenameMode() {
    if (!this._isRenaming) return;
    this._isRenaming = false;
    this._inputEl?.replaceWith(this._labelEl);
    this._errorEl?.remove();
    this._el.classList.remove("desktop-icon--renaming", "desktop-icon--rename-error");
    this._inputEl = null;
    this._errorEl = null;
    this._renameConfig = null;
  }

  /**
   * @returns {void}
   */
  destroy() {
    this._el.remove();
  }

  /** @returns {void} */
  _buildDom() {
    this._glyphEl = renderIcon(
      createElement("div", { className: "desktop-icon__glyph", attrs: { "aria-hidden": "true" } }),
      this._config.icon
    );
    this._labelEl = createElement("div", { className: "desktop-icon__label", text: this._config.label });

    this._el = createElement("div", {
      className: "desktop-icon",
      attrs: {
        role: "listitem",
        tabindex: "0",
        "aria-label": this._config.label,
        "aria-selected": "false",
        "data-icon-id": this.id,
      },
      children: [this._glyphEl, this._labelEl],
      on: {
        pointerdown: (e) => this._onPointerDown(e),
        dblclick: (e) => {
          if (this._isRenaming) return;
          e.stopPropagation();
          this._callbacks.onOpen(this.id);
        },
        contextmenu: (e) => {
          if (this._isRenaming) return;
          e.preventDefault();
          e.stopPropagation();
          this._callbacks.onContextMenu(this.id, e.clientX, e.clientY);
        },
        // This fires as a side effect of the browser's default
        // mousedown-focuses-the-target behavior, so it must stay a pure
        // "focus moved here" notification. Selecting here would
        // override whatever the click, Ctrl+click, or drag selection
        // logic has just decided.
        focusin: () => this._callbacks.onFocusIn(this.id),
      },
    });
  }

  /**
   * @param {PointerEvent} e
   * @returns {void}
   */
  _onPointerDown(e) {
    if (this._isRenaming) return;
    if (e.button !== 0) return;
    e.stopPropagation();

    const additive = e.ctrlKey || e.metaKey;
    this._callbacks.onPointerDown(this.id, { additive });

    this._pointerDownState = { startX: e.clientX, startY: e.clientY, dragging: false, additive };
    this._el.setPointerCapture(e.pointerId);

    const onMove = (moveEvent) => this._onPointerMove(moveEvent);
    const onUp = (upEvent) => {
      this._el.removeEventListener("pointermove", onMove);
      this._el.removeEventListener("pointerup", onUp);
      this._el.removeEventListener("pointercancel", onUp);
      this._onPointerUp(upEvent);
    };
    this._el.addEventListener("pointermove", onMove);
    this._el.addEventListener("pointerup", onUp);
    this._el.addEventListener("pointercancel", onUp);
  }

  /**
   * @param {PointerEvent} e
   * @returns {void}
   */
  _onPointerMove(e) {
    const state = this._pointerDownState;
    if (!state) return;

    const dx = e.clientX - state.startX;
    const dy = e.clientY - state.startY;

    if (!state.dragging) {
      if (Math.abs(dx) < DRAG_THRESHOLD_PX && Math.abs(dy) < DRAG_THRESHOLD_PX) return;
      state.dragging = true;
      this.setDragging(true);
      this._callbacks.onDragStart(this.id);
    }

    this._callbacks.onDragMove(this.id, dx, dy);
  }

  /**
   * @param {PointerEvent} e
   * @returns {void}
   */
  _onPointerUp(e) {
    const state = this._pointerDownState;
    this._pointerDownState = null;
    if (!state) return;

    this.setDragging(false);
    if (state.dragging) {
      const dx = e.clientX - state.startX;
      const dy = e.clientY - state.startY;
      this._callbacks.onDragEnd(this.id, dx, dy);
    } else {
      this._callbacks.onClick(this.id, { additive: state.additive });
    }
  }
}

export { DesktopIconView };
