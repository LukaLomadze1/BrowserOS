/**
 * @file SelectionManager — the single source of truth for which
 * desktop icons are currently selected. DesktopIcon views never
 * decide their own selected state; they reflect whatever this class
 * says, driven by DesktopManager's click/drag/keyboard handling.
 */

import { eventBus } from "./eventBus.js";

class SelectionManager {
  constructor() {
    /** @type {Set<string>} */
    this._selected = new Set();
  }

  /**
   * Select one id. Clears everything else unless `additive` is set
   * (Ctrl+Click behavior).
   * @param {string} id
   * @param {{additive?: boolean}} [options]
   * @returns {void}
   */
  select(id, options = {}) {
    const additive = options.additive ?? false;
    if (!additive) {
      this._deselectAllExcept(id);
    }
    if (!this._selected.has(id)) {
      this._selected.add(id);
      eventBus.emit("desktop:iconSelected", { id });
    }
  }

  /**
   * Flip one id's selected state, leaving everything else alone
   * (Ctrl+Click on an already-selected icon).
   * @param {string} id
   * @returns {void}
   */
  toggle(id) {
    if (this._selected.has(id)) {
      this._selected.delete(id);
      eventBus.emit("desktop:iconDeselected", { id });
    } else {
      this._selected.add(id);
      eventBus.emit("desktop:iconSelected", { id });
    }
  }

  /**
   * Replace the entire selection with exactly this set of ids.
   * Used by the marquee/rectangle selection while dragging.
   * @param {Iterable<string>} ids
   * @returns {void}
   */
  setSelection(ids) {
    const next = new Set(ids);
    for (const id of this._selected) {
      if (!next.has(id)) {
        this._selected.delete(id);
        eventBus.emit("desktop:iconDeselected", { id });
      }
    }
    for (const id of next) {
      if (!this._selected.has(id)) {
        this._selected.add(id);
        eventBus.emit("desktop:iconSelected", { id });
      }
    }
  }

  /**
   * Deselect everything.
   * @returns {void}
   */
  clear() {
    for (const id of [...this._selected]) {
      this._selected.delete(id);
      eventBus.emit("desktop:iconDeselected", { id });
    }
  }

  /**
   * @param {string} id
   * @returns {boolean}
   */
  isSelected(id) {
    return this._selected.has(id);
  }

  /**
   * @returns {string[]}
   */
  getSelectedIds() {
    return [...this._selected];
  }

  /**
   * @param {string} keepId
   * @returns {void}
   */
  _deselectAllExcept(keepId) {
    for (const id of [...this._selected]) {
      if (id !== keepId) {
        this._selected.delete(id);
        eventBus.emit("desktop:iconDeselected", { id });
      }
    }
  }
}

export { SelectionManager };
