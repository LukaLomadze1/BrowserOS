/**
 * @file Project explorer tree for Code Studio.
 *
 * Renders a ProjectTree (see project/projectStore.js) as an ARIA tree:
 * folders expand and collapse, the open file is highlighted, files with
 * unsaved changes show a dot, and items can be dragged onto folders to
 * move them. The tree makes no decisions: opening, renaming, deleting,
 * moving, and context menus are reported to the owner through
 * callbacks.
 *
 * Keyboard: Up/Down move, Right expands (or enters), Left collapses (or
 * goes to the parent), Enter opens, F2 renames, Delete deletes,
 * Home/End jump, Shift+F10 / ContextMenu opens the context menu.
 */

import { createElement } from "../../../utils/dom.js";
import { createIconElement } from "../../../utils/icons.js";
import { languageForPath } from "../languages/registry.js";

/**
 * @param {string} name
 * @returns {string} Short file-type badge text.
 */
function badgeFor(name) {
  const language = languageForPath(name);
  const map = { html: "<>", css: "#", javascript: "JS", json: "{}", markdown: "M\u2193" };
  return map[language.id] ?? "";
}

export class FileTree {
  /**
   * @param {object} callbacks
   * @param {(entry: object, options: {focus: boolean}) => void} callbacks.onOpen - A file was activated (focus: move focus to the editor).
   * @param {(entry: object|null, point: {x: number, y: number}) => void} callbacks.onContextMenu - entry null for the empty area.
   * @param {(entry: object) => void} callbacks.onRename
   * @param {(entry: object) => void} callbacks.onDelete
   * @param {(sourcePath: string, folderPath: string) => void} callbacks.onMove
   */
  constructor(callbacks) {
    this._callbacks = callbacks;
    /** @type {import("../project/projectStore.js").ProjectTree|null} */
    this._tree = null;
    /** @type {Set<string>} */
    this._expanded = new Set();
    this._activePath = null;
    this._focusedPath = null;
    /** @type {Set<string>} */
    this._dirty = new Set();
    /** @type {Map<string, HTMLElement>} */
    this._rows = new Map();
    this._dragPath = null;

    this._list = createElement("div", { className: "cs-tree__list", attrs: { role: "tree", "aria-label": "Project files", tabindex: "0" } });
    this._empty = createElement("p", { className: "cs-tree__empty", text: "This folder is empty." });
    this._root = createElement("div", { className: "cs-tree", children: [this._list, this._empty] });
    this._list.addEventListener("keydown", (e) => this._onKeyDown(e));
    this._list.addEventListener("focus", () => {
      if (!this._focusedPath || !this._rows.has(this._focusedPath)) {
        const first = this._visiblePaths()[0];
        if (first) this._setFocused(first, true);
      } else {
        this._rows.get(this._focusedPath)?.focus();
      }
    });
    this._root.addEventListener("contextmenu", (e) => {
      if (e.target.closest(".cs-tree__row")) return;
      e.preventDefault();
      this._callbacks.onContextMenu(null, { x: e.clientX, y: e.clientY });
    });
    // Dropping on the empty area moves to the project root.
    this._root.addEventListener("dragover", (e) => {
      if (!this._dragPath || e.target.closest(".cs-tree__row")) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      this._root.classList.add("cs-tree--drop-root");
    });
    this._root.addEventListener("dragleave", (e) => {
      if (!this._root.contains(e.relatedTarget)) this._root.classList.remove("cs-tree--drop-root");
    });
    this._root.addEventListener("drop", (e) => {
      this._root.classList.remove("cs-tree--drop-root");
      if (!this._dragPath || e.target.closest(".cs-tree__row") || !this._tree) return;
      e.preventDefault();
      const source = this._dragPath;
      this._dragPath = null;
      if (parentOf(source) !== this._tree.root) this._callbacks.onMove(source, this._tree.root);
    });
  }

  /** @returns {HTMLElement} */
  getElement() {
    return this._root;
  }

  /**
   * @param {import("../project/projectStore.js").ProjectTree|null} tree
   * @returns {void}
   */
  setTree(tree) {
    const previousRoot = this._tree?.root;
    this._tree = tree;
    if (tree && tree.root !== previousRoot) {
      this._expanded = new Set([tree.root]);
    }
    if (tree) {
      // Forget folders that no longer exist.
      for (const path of [...this._expanded]) if (!tree.entries.has(path)) this._expanded.delete(path);
      this._expanded.add(tree.root);
    }
    this.render();
  }

  /**
   * @param {string|null} path
   * @returns {void}
   */
  setActive(path) {
    this._activePath = path;
    for (const [rowPath, row] of this._rows) row.classList.toggle("cs-tree__row--active", rowPath === path);
  }

  /**
   * Expand every folder above a path and scroll it into view.
   * @param {string} path
   * @returns {void}
   */
  reveal(path) {
    if (!this._tree) return;
    let parent = parentOf(path);
    let changed = false;
    while (parent && parent.length >= this._tree.root.length && parent !== "/") {
      if (!this._expanded.has(parent)) {
        this._expanded.add(parent);
        changed = true;
      }
      if (parent === this._tree.root) break;
      parent = parentOf(parent);
    }
    if (changed) this.render();
    this._rows.get(path)?.scrollIntoView({ block: "nearest" });
  }

  /**
   * @param {Set<string>} paths - Files with unsaved changes.
   * @returns {void}
   */
  setDirty(paths) {
    this._dirty = new Set(paths);
    for (const [path, row] of this._rows) row.classList.toggle("cs-tree__row--dirty", this._dirty.has(path));
  }

  /** @returns {void} */
  collapseAll() {
    if (!this._tree) return;
    this._expanded = new Set([this._tree.root]);
    this.render();
  }

  /** @returns {void} */
  focus() {
    this._list.focus();
  }

  /** @returns {string|null} Path of the focused row. */
  getFocusedPath() {
    return this._focusedPath;
  }

  /** @returns {void} */
  render() {
    this._rows.clear();
    const items = [];
    if (this._tree) {
      const walk = (folder, depth) => {
        for (const entry of this._tree.children.get(folder) ?? []) {
          items.push(this._renderRow(entry, depth));
          if (entry.type === "folder" && this._expanded.has(entry.path)) walk(entry.path, depth + 1);
        }
      };
      walk(this._tree.root, 0);
    }
    this._list.replaceChildren(...items);
    this._empty.hidden = !this._tree || items.length > 0;
    if (this._focusedPath && !this._rows.has(this._focusedPath)) this._focusedPath = null;
    for (const [path, row] of this._rows) row.tabIndex = path === this._focusedPath ? 0 : -1;
    this._list.tabIndex = this._focusedPath ? -1 : 0;
  }

  /**
   * @param {object} entry
   * @param {number} depth
   * @returns {HTMLElement}
   */
  _renderRow(entry, depth) {
    const isFolder = entry.type === "folder";
    const expanded = isFolder && this._expanded.has(entry.path);
    const twisty = createElement("span", { className: "cs-tree__twisty", attrs: { "aria-hidden": "true" } });
    if (isFolder) twisty.append(createIconElement(expanded ? "icon:chevronDown" : "icon:chevronRight"));
    const icon = isFolder
      ? createIconElement("icon:folder", { className: "cs-tree__icon cs-tree__icon--folder" })
      : createElement("span", { className: "cs-tree__icon cs-tree__badge", text: badgeFor(entry.name) || "\u2022", attrs: { "aria-hidden": "true" } });
    const row = createElement("div", {
      className: `cs-tree__row${entry.path === this._activePath ? " cs-tree__row--active" : ""}${this._dirty.has(entry.path) ? " cs-tree__row--dirty" : ""}`,
      attrs: {
        role: "treeitem",
        "aria-level": String(depth + 1),
        "aria-expanded": isFolder ? String(expanded) : null,
        "aria-selected": String(entry.path === this._activePath),
        "data-path": entry.path,
        draggable: "true",
        title: entry.path,
        tabindex: "-1",
      },
      children: [
        twisty,
        icon,
        createElement("span", { className: "cs-tree__name", text: entry.name }),
        createElement("span", { className: "cs-tree__dirty", attrs: { "aria-label": "Unsaved changes" } }),
      ],
    });
    row.style.setProperty("--depth", String(depth));
    row.addEventListener("click", (e) => {
      this._setFocused(entry.path, false);
      if (isFolder) this._toggle(entry.path);
      else this._callbacks.onOpen(entry, { focus: e.detail > 1 });
    });
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this._setFocused(entry.path, true);
      this._callbacks.onContextMenu(entry, { x: e.clientX, y: e.clientY });
    });
    row.addEventListener("dragstart", (e) => {
      this._dragPath = entry.path;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", entry.path);
      row.classList.add("cs-tree__row--dragging");
    });
    row.addEventListener("dragend", () => {
      this._dragPath = null;
      row.classList.remove("cs-tree__row--dragging");
      this._root.classList.remove("cs-tree--drop-root");
    });
    const dropFolder = isFolder ? entry.path : parentOf(entry.path);
    row.addEventListener("dragover", (e) => {
      if (!this._dragPath || !this._canDrop(this._dragPath, dropFolder)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      row.classList.add("cs-tree__row--drop");
    });
    row.addEventListener("dragleave", () => row.classList.remove("cs-tree__row--drop"));
    row.addEventListener("drop", (e) => {
      row.classList.remove("cs-tree__row--drop");
      const source = this._dragPath;
      this._dragPath = null;
      if (!source || !this._canDrop(source, dropFolder)) return;
      e.preventDefault();
      e.stopPropagation();
      this._callbacks.onMove(source, dropFolder);
    });
    this._rows.set(entry.path, row);
    return row;
  }

  /**
   * @param {string} source
   * @param {string} folder
   * @returns {boolean} Whether moving `source` into `folder` makes sense.
   */
  _canDrop(source, folder) {
    if (parentOf(source) === folder) return false;
    if (folder === source || folder.startsWith(`${source}/`)) return false;
    return true;
  }

  /**
   * @param {string} path
   * @returns {void}
   */
  _toggle(path) {
    if (this._expanded.has(path)) this._expanded.delete(path);
    else this._expanded.add(path);
    this.render();
    this._rows.get(path)?.focus();
  }

  /**
   * @param {string} path
   * @param {boolean} focus
   * @returns {void}
   */
  _setFocused(path, focus) {
    const previous = this._rows.get(this._focusedPath);
    if (previous) previous.tabIndex = -1;
    this._focusedPath = path;
    const row = this._rows.get(path);
    if (row) {
      row.tabIndex = 0;
      if (focus) row.focus();
    }
    this._list.tabIndex = -1;
  }

  /** @returns {string[]} */
  _visiblePaths() {
    return [...this._rows.keys()];
  }

  /**
   * @param {KeyboardEvent} e
   * @returns {void}
   */
  _onKeyDown(e) {
    if (!this._tree) return;
    const paths = this._visiblePaths();
    if (paths.length === 0) return;
    const current = this._focusedPath && this._rows.has(this._focusedPath) ? this._focusedPath : null;
    const index = current ? paths.indexOf(current) : -1;
    const entry = current ? this._tree.entries.get(current) : null;
    const move = (target) => {
      e.preventDefault();
      if (target) this._setFocused(target, true);
    };
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    switch (e.key) {
      case "ArrowDown":
        return move(paths[Math.min(paths.length - 1, index + 1)]);
      case "ArrowUp":
        return move(paths[Math.max(0, index - 1)]);
      case "Home":
        return move(paths[0]);
      case "End":
        return move(paths[paths.length - 1]);
      case "ArrowRight":
        if (entry?.type === "folder") {
          e.preventDefault();
          if (!this._expanded.has(entry.path)) this._toggle(entry.path);
          else {
            const child = (this._tree.children.get(entry.path) ?? [])[0];
            if (child) this._setFocused(child.path, true);
          }
        }
        return;
      case "ArrowLeft":
        if (!entry) return;
        e.preventDefault();
        if (entry.type === "folder" && this._expanded.has(entry.path)) this._toggle(entry.path);
        else if (parentOf(entry.path) !== this._tree.root && this._rows.has(parentOf(entry.path))) this._setFocused(parentOf(entry.path), true);
        return;
      case "Enter":
        if (!entry) return;
        e.preventDefault();
        if (entry.type === "folder") this._toggle(entry.path);
        else this._callbacks.onOpen(entry, { focus: true });
        return;
      case "F2":
        if (entry) {
          e.preventDefault();
          this._callbacks.onRename(entry);
        }
        return;
      case "Delete":
        if (entry) {
          e.preventDefault();
          this._callbacks.onDelete(entry);
        }
        return;
      case "ContextMenu":
        if (entry) {
          e.preventDefault();
          const rect = this._rows.get(entry.path).getBoundingClientRect();
          this._callbacks.onContextMenu(entry, { x: rect.left + 24, y: rect.bottom });
        }
        return;
      default:
        if (e.key === "F10" && e.shiftKey && entry) {
          e.preventDefault();
          const rect = this._rows.get(entry.path).getBoundingClientRect();
          this._callbacks.onContextMenu(entry, { x: rect.left + 24, y: rect.bottom });
        }
    }
  }
}

/**
 * @param {string} path
 * @returns {string}
 */
function parentOf(path) {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
}
