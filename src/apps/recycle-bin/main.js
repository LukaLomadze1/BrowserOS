/**
 * @file Recycle Bin — lists what is in /Trash and restores or
 * permanently deletes it, through the public VFS API (`vfs.list`,
 * `vfs.restore`, `vfs.deletePermanently`, `vfs.emptyTrash`).
 *
 * Each item shows where it was deleted from and when. Restoring puts
 * an item back in its original folder (re-creating missing folders;
 * a taken name gets a number). Items without a recorded location —
 * for example ones created directly inside Trash — ask for a folder.
 *
 * Keyboard: arrows move, Shift + arrows extend the selection,
 * Ctrl + A selects everything, Enter restores, Delete deletes
 * permanently (after confirmation), the context-menu key or
 * Shift + F10 opens the item menu.
 *
 * The list follows file-system events, so items deleted elsewhere
 * appear immediately and restored ones disappear.
 */

import { Application } from "../../core/application.js";
import { eventBus } from "../../core/eventBus.js";
import { vfs, TRASH_PATH, isTrashPath } from "../../core/vfs/virtualFileSystem.js";
import { getParentPath } from "../../core/vfs/pathResolver.js";
import { notificationService } from "../../core/notifications/notificationService.js";
import { ContextMenu } from "../../components/context-menu/contextMenu.js";
import { showConfirmDialog } from "../../components/dialog/confirmDialog.js";
import { showMessageDialog } from "../../components/dialog/messageDialog.js";
import { showFolderPickerDialog } from "../../components/dialog/folderPickerDialog.js";
import { createElement, hasModifierKey } from "../../utils/dom.js";
import { createIconElement } from "../../utils/icons.js";
import { formatBytes, formatDate } from "../../utils/format.js";
import { ensureStylesheet } from "../../utils/loadStylesheet.js";

ensureStylesheet("src/apps/recycle-bin/recycle-bin.css");

const REFRESH_DELAY_MS = 60;

export default class RecycleBinApp extends Application {
  constructor(meta) {
    super(meta);
    /** @type {object[]} */
    this._items = [];
    /** @type {Set<string>} selected entry ids */
    this._selection = new Set();
    this._anchorId = null;
    this._focusId = null;
    this._busy = false;
    this._refreshTimer = null;
    this._cleanups = [];
    this._contextMenu = new ContextMenu();
  }

  /** @returns {ReturnType<Application["launch"]>} */
  launch() {
    this._restoreButton = this._button("Restore", () => this._restoreSelection(), { primary: true });
    this._deleteButton = this._button("Delete permanently", () => this._deleteSelection());
    this._emptyButton = this._button("Empty Recycle Bin", () => this._emptyAll());

    this._listEl = createElement("div", {
      className: "recycle-bin__list",
      attrs: { role: "listbox", "aria-multiselectable": "true", "aria-label": "Items in the Recycle Bin", tabindex: "0" },
      on: {
        keydown: (e) => this._onKeyDown(e),
        contextmenu: (e) => this._onContextMenu(e),
        pointerdown: (e) => this._onPointerDown(e),
        focus: () => this._ensureFocusItem(),
      },
    });
    this._emptyEl = createElement("div", {
      className: "recycle-bin__empty",
      attrs: { hidden: "" },
      children: [
        createElement("div", { className: "recycle-bin__glyph", attrs: { "aria-hidden": "true" }, text: "♻" }),
        createElement("div", { className: "recycle-bin__message", text: "Recycle Bin is empty" }),
        createElement("p", {
          className: "recycle-bin__hint",
          text: "Items you delete stay here until you restore them, delete them permanently, or empty the Recycle Bin.",
        }),
      ],
    });
    this._summaryEl = createElement("p", { className: "recycle-bin__summary", attrs: { role: "status", "aria-live": "polite" } });

    const header = createElement("div", {
      className: "recycle-bin__columns",
      attrs: { "aria-hidden": "true" },
      children: ["Name", "Original location", "Date deleted", "Size"].map((label) => createElement("span", { text: label })),
    });

    this._root = createElement("div", {
      className: "recycle-bin",
      children: [
        createElement("div", {
          className: "recycle-bin__toolbar",
          attrs: { role: "toolbar", "aria-label": "Recycle Bin actions" },
          children: [this._restoreButton, this._deleteButton, createElement("span", { className: "recycle-bin__spacer" }), this._emptyButton],
        }),
        header,
        this._listEl,
        this._emptyEl,
        createElement("div", { className: "recycle-bin__footer", children: [this._summaryEl] }),
      ],
    });

    const schedule = () => this._scheduleRefresh();
    const touchesTrash = (payload) =>
      isTrashPath(payload?.entry?.path ?? "") || isTrashPath(payload?.oldPath ?? "") || payload?.permanent === true;
    for (const name of ["filesystem:fileDeleted", "filesystem:fileMoved", "filesystem:fileRenamed", "filesystem:fileCreated", "filesystem:folderCreated", "filesystem:fileCopied"]) {
      this._cleanups.push(eventBus.on(name, (payload) => touchesTrash(payload) && schedule()));
    }
    this._cleanups.push(eventBus.on("filesystem:replaced", schedule));

    this._refresh();

    return {
      element: this._root,
      title: "Recycle Bin",
      icon: "icon:trash",
      width: 760,
      height: 460,
      minWidth: 460,
      minHeight: 300,
      resizable: true,
      minimizable: true,
      maximizable: true,
      closable: true,
    };
  }

  /** @returns {void} */
  onFocus() {
    if (!this._root.contains(document.activeElement)) this._listEl.focus({ preventScroll: true });
  }

  /** @returns {void} */
  close() {
    window.clearTimeout(this._refreshTimer);
    for (const cleanup of this._cleanups) cleanup();
    this._cleanups = [];
    this._contextMenu.hide();
  }

  // ---------------------------------------------------------------
  // Data
  // ---------------------------------------------------------------

  /** @returns {void} */
  _scheduleRefresh() {
    window.clearTimeout(this._refreshTimer);
    this._refreshTimer = window.setTimeout(() => this._refresh(), REFRESH_DELAY_MS);
  }

  /** @returns {Promise<void>} */
  async _refresh() {
    let items;
    try {
      items = await vfs.list(TRASH_PATH);
    } catch (error) {
      this._summaryEl.textContent = `The Recycle Bin couldn't be read: ${error.message}`;
      return;
    }
    items.sort((a, b) => (b.deletedAt ?? b.modifiedAt ?? 0) - (a.deletedAt ?? a.modifiedAt ?? 0) || a.name.localeCompare(b.name));
    this._items = items;
    const ids = new Set(items.map((item) => item.id));
    this._selection = new Set([...this._selection].filter((id) => ids.has(id)));
    if (!ids.has(this._focusId)) this._focusId = null;
    if (!ids.has(this._anchorId)) this._anchorId = null;
    this._render();
  }

  // ---------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------

  /** @returns {void} */
  _render() {
    const empty = this._items.length === 0;
    this._emptyEl.hidden = !empty;
    this._listEl.hidden = empty;
    this._root.querySelector(".recycle-bin__columns").hidden = empty;
    const hadFocus = this._listEl.contains(document.activeElement) || document.activeElement === this._listEl;

    this._listEl.replaceChildren(...this._items.map((item) => this._renderRow(item)));
    this._updateState();
    if (hadFocus && !empty) this._listEl.focus({ preventScroll: true });
  }

  /**
   * @param {object} item
   * @returns {HTMLElement}
   */
  _renderRow(item) {
    const folder = item.type === "folder";
    const location = item.originalPath ? getParentPath(item.originalPath) ?? "/" : "Unknown";
    const deleted = formatDate(item.deletedAt ?? item.modifiedAt);
    const size = folder ? "Folder" : formatBytes(item.size);
    return createElement("div", {
      className: "recycle-bin__row",
      attrs: {
        role: "option",
        id: `recycle-bin-${item.id}`,
        "data-id": item.id,
        "aria-selected": "false",
        "aria-label": `${item.name}, ${folder ? "folder" : size}, deleted from ${location}, ${deleted}`,
      },
      children: [
        createElement("span", {
          className: "recycle-bin__name",
          children: [
            createIconElement(folder ? "icon:folder" : "icon:file", { className: "recycle-bin__icon" }),
            createElement("span", { className: "recycle-bin__label", text: item.name, attrs: { title: item.name } }),
          ],
        }),
        createElement("span", { className: "recycle-bin__cell", text: location, attrs: { title: item.originalPath ?? "" } }),
        createElement("span", { className: "recycle-bin__cell", text: deleted }),
        createElement("span", { className: "recycle-bin__cell recycle-bin__cell--size", text: size }),
      ],
    });
  }

  /** @returns {void} */
  _updateState() {
    for (const row of this._listEl.children) {
      const id = row.dataset.id;
      const selected = this._selection.has(id);
      row.classList.toggle("recycle-bin__row--selected", selected);
      row.classList.toggle("recycle-bin__row--focused", id === this._focusId);
      row.setAttribute("aria-selected", String(selected));
    }
    if (this._focusId) this._listEl.setAttribute("aria-activedescendant", `recycle-bin-${this._focusId}`);
    else this._listEl.removeAttribute("aria-activedescendant");

    const count = this._items.length;
    const selected = this._selection.size;
    this._restoreButton.disabled = this._busy || selected === 0;
    this._deleteButton.disabled = this._busy || selected === 0;
    this._emptyButton.disabled = this._busy || count === 0;
    const total = `${count} ${count === 1 ? "item" : "items"}`;
    this._summaryEl.textContent = count === 0 ? "" : selected ? `${selected} of ${total} selected` : total;
  }

  /**
   * @param {string} label
   * @param {() => void} onClick
   * @param {{primary?: boolean}} [options]
   * @returns {HTMLButtonElement}
   */
  _button(label, onClick, { primary = false } = {}) {
    return createElement("button", {
      className: `recycle-bin__button${primary ? " recycle-bin__button--primary" : ""}`,
      attrs: { type: "button" },
      text: label,
      on: { click: onClick },
    });
  }

  // ---------------------------------------------------------------
  // Selection and input
  // ---------------------------------------------------------------

  /** @returns {void} */
  _ensureFocusItem() {
    if (!this._focusId && this._items.length) {
      this._focusId = this._items[0].id;
      this._updateState();
    }
  }

  /**
   * @param {string} id
   * @param {{extend?: boolean, toggle?: boolean}} [options]
   * @returns {void}
   */
  _select(id, { extend = false, toggle = false } = {}) {
    if (extend && this._anchorId) {
      const ids = this._items.map((item) => item.id);
      const [a, b] = [ids.indexOf(this._anchorId), ids.indexOf(id)].sort((x, y) => x - y);
      this._selection = new Set(ids.slice(a, b + 1));
    } else if (toggle) {
      if (this._selection.has(id)) this._selection.delete(id);
      else this._selection.add(id);
      this._anchorId = id;
    } else {
      this._selection = new Set([id]);
      this._anchorId = id;
    }
    this._focusId = id;
    this._updateState();
    this._listEl.querySelector(`[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "nearest" });
  }

  /**
   * @param {PointerEvent} e
   * @returns {void}
   */
  _onPointerDown(e) {
    const row = e.target instanceof Element ? e.target.closest(".recycle-bin__row") : null;
    if (!row) {
      if (e.button === 0) {
        this._selection.clear();
        this._updateState();
      }
      return;
    }
    const id = row.dataset.id;
    if (e.button === 2 && this._selection.has(id)) return;
    this._select(id, { extend: e.shiftKey, toggle: e.ctrlKey || e.metaKey });
  }

  /**
   * @param {KeyboardEvent} e
   * @returns {void}
   */
  _onKeyDown(e) {
    const ids = this._items.map((item) => item.id);
    if (ids.length === 0) return;
    const current = Math.max(0, ids.indexOf(this._focusId));
    const move = (index) => {
      e.preventDefault();
      const target = ids[Math.max(0, Math.min(ids.length - 1, index))];
      if (e.ctrlKey || e.metaKey) {
        this._focusId = target;
        this._updateState();
      } else {
        this._select(target, { extend: e.shiftKey });
      }
    };
    if (e.key === "ArrowDown") return move(current + 1);
    if (e.key === "ArrowUp") return move(current - 1);
    if (e.key === "Home") return move(0);
    if (e.key === "End") return move(ids.length - 1);
    if (e.key === " " && this._focusId) {
      e.preventDefault();
      this._select(this._focusId, { toggle: e.ctrlKey || e.metaKey });
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a" && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      this._selection = new Set(ids);
      this._updateState();
      return;
    }
    if (e.key === "Enter" && !hasModifierKey(e)) {
      e.preventDefault();
      if (this._selection.size === 0 && this._focusId) this._select(this._focusId);
      this._restoreSelection();
      return;
    }
    if (e.key === "Delete" && !hasModifierKey(e)) {
      e.preventDefault();
      if (this._selection.size === 0 && this._focusId) this._select(this._focusId);
      this._deleteSelection();
      return;
    }
    if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
      e.preventDefault();
      const row = this._listEl.querySelector(`[data-id="${CSS.escape(this._focusId ?? ids[0])}"]`);
      const rect = (row ?? this._listEl).getBoundingClientRect();
      if (this._focusId && !this._selection.has(this._focusId)) this._select(this._focusId);
      this._showMenu(rect.left + 24, rect.bottom);
    }
  }

  /**
   * @param {MouseEvent} e
   * @returns {void}
   */
  _onContextMenu(e) {
    e.preventDefault();
    this._showMenu(e.clientX, e.clientY);
  }

  /**
   * @param {number} x
   * @param {number} y
   * @returns {void}
   */
  _showMenu(x, y) {
    const items = this._selection.size
      ? [
          { label: "Restore", action: () => this._restoreSelection() },
          { label: "Restore to…", action: () => this._restoreSelection({ choose: true }) },
          { separator: true },
          { label: "Delete permanently", action: () => this._deleteSelection() },
        ]
      : [{ label: "Empty Recycle Bin", disabled: this._items.length === 0, action: () => this._emptyAll() }];
    this._contextMenu.show(items, { x, y }, { onClose: () => {} });
  }

  // ---------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------

  /** @returns {object[]} */
  _selectedItems() {
    return this._items.filter((item) => this._selection.has(item.id));
  }

  /**
   * @param {() => Promise<void>} work
   * @returns {Promise<void>}
   */
  async _run(work) {
    if (this._busy) return;
    this._busy = true;
    this._updateState();
    try {
      await work();
    } finally {
      this._busy = false;
      await this._refresh();
    }
  }

  /**
   * @param {{choose?: boolean}} [options] - choose: ask for a folder instead of using the original location.
   * @returns {Promise<void>}
   */
  _restoreSelection({ choose = false } = {}) {
    const items = this._selectedItems();
    if (items.length === 0) return Promise.resolve();
    return this._run(async () => {
      let chosen = null;
      if (choose) {
        chosen = await showFolderPickerDialog({ vfs, title: "Restore to", initialPath: "/Documents" });
        if (!chosen) return;
      }
      const restored = [];
      const failures = [];
      for (const item of items) {
        try {
          restored.push(await this._restoreOne(item, chosen));
        } catch (error) {
          if (error?.code === "CANCELLED") continue;
          failures.push(`${item.name}: ${error.message}`);
        }
      }
      if (failures.length) {
        await showMessageDialog({
          title: failures.length === items.length ? "Couldn't restore" : "Some items couldn't be restored",
          message: failures.slice(0, 5).join(" · "),
        });
      }
      if (restored.length) {
        const single = restored.length === 1 ? restored[0] : null;
        notificationService.success(single ? `Restored “${single.name}”` : `Restored ${restored.length} items`, {
          title: single ? `Restored “${single.name}”` : `Restored ${restored.length} items`,
          message: single ? `Back in ${getParentPath(single.path) ?? "/"}` : "",
          source: "recycle-bin",
          action: single ? { type: "open", path: getParentPath(single.path) ?? "/" } : null,
        });
      }
    });
  }

  /**
   * @param {object} item
   * @param {string|null} destination
   * @returns {Promise<object>} The restored entry.
   */
  async _restoreOne(item, destination) {
    try {
      return await vfs.restore(item.path, destination ? { destination } : {});
    } catch (error) {
      if (error?.code !== "NO_ORIGINAL_LOCATION") throw error;
      const folder = await showFolderPickerDialog({ vfs, title: `Restore “${item.name}” to`, initialPath: "/Documents" });
      if (!folder) {
        const cancelled = new Error("cancelled");
        cancelled.code = "CANCELLED";
        throw cancelled;
      }
      return vfs.restore(item.path, { destination: folder });
    }
  }

  /** @returns {Promise<void>} */
  _deleteSelection() {
    const items = this._selectedItems();
    if (items.length === 0) return Promise.resolve();
    return this._run(async () => {
      const message =
        items.length === 1
          ? `Permanently delete “${items[0].name}”${items[0].type === "folder" ? " and everything in it" : ""}? This can't be undone.`
          : `Permanently delete these ${items.length} items? This can't be undone.`;
      const confirmed = await showConfirmDialog({ title: "Delete permanently", message, confirmLabel: "Delete permanently", destructive: true });
      if (!confirmed) return;
      const failures = [];
      for (const item of items) {
        try {
          await vfs.deletePermanently(item.path);
        } catch (error) {
          failures.push(`${item.name}: ${error.message}`);
        }
      }
      if (failures.length) {
        await showMessageDialog({ title: "Some items couldn't be deleted", message: failures.slice(0, 5).join(" · ") });
      }
    });
  }

  /** @returns {Promise<void>} */
  _emptyAll() {
    if (this._items.length === 0) return Promise.resolve();
    return this._run(async () => {
      const count = this._items.length;
      const confirmed = await showConfirmDialog({
        title: "Empty Recycle Bin",
        message: `Permanently delete ${count === 1 ? "the item" : `all ${count} items`} in the Recycle Bin? This can't be undone.`,
        confirmLabel: "Empty Recycle Bin",
        destructive: true,
      });
      if (!confirmed) return;
      try {
        await vfs.emptyTrash();
      } catch (error) {
        await showMessageDialog({ title: "Couldn't empty the Recycle Bin", message: error.message });
      }
    });
  }
}
