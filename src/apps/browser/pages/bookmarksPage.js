/**
 * @file Bookmark manager (browseros://bookmarks).
 *
 * Folder tree on the left, the selected folder (or search results) on
 * the right. Bookmarks can be opened (here or in a new tab), edited
 * (name, address, folder), deleted, reordered (Move up / Move down), and
 * moved between folders; folders can be created, renamed, and deleted.
 * Import reads a bookmarks HTML file (from any browser) or BrowserOS
 * JSON chosen from the computer; Export writes a bookmarks HTML file to
 * /Downloads.
 */

import { createElement } from "../../../utils/dom.js";
import { createIconElement } from "../../../utils/icons.js";
import { eventBus } from "../../../core/eventBus.js";
import { vfs } from "../../../core/vfs/virtualFileSystem.js";
import { bookmarkService, BAR_FOLDER_ID, OTHER_FOLDER_ID } from "../../../core/browser/bookmarkService.js";
import { notificationService } from "../../../core/notifications/notificationService.js";
import { ContextMenu } from "../../../components/context-menu/contextMenu.js";
import { showConfirmDialog } from "../../../components/dialog/confirmDialog.js";
import { showMessageDialog } from "../../../components/dialog/messageDialog.js";
import { showFormDialog } from "../../../components/dialog/formDialog.js";
import { createFavicon } from "../favicon.js";

const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

export class BookmarksPage {
  /**
   * @param {{navigate: (url: string, options?: {newTab?: boolean}) => void}} ctx
   */
  constructor(ctx) {
    this.title = "Bookmarks";
    this._ctx = ctx;
    this._folderId = BAR_FOLDER_ID;
    this._query = "";
    this._menu = new ContextMenu();

    this._treeEl = createElement("nav", { className: "browser-bookmarks__tree", attrs: { "aria-label": "Bookmark folders" } });
    this._listEl = createElement("ul", { className: "browser-page__rows", attrs: { "aria-label": "Bookmarks" } });
    this._folderTitleEl = createElement("h2", { className: "browser-page__group-title" });
    this._statusEl = createElement("p", { className: "browser-page__note", attrs: { role: "status" } });
    this._searchInput = createElement("input", {
      className: "browser-page__search",
      attrs: { type: "search", placeholder: "Search bookmarks", "aria-label": "Search bookmarks" },
      on: {
        input: () => {
          this._query = this._searchInput.value;
          this.render();
        },
      },
    });
    this._fileInput = createElement("input", {
      className: "browser-hidden-input",
      attrs: { type: "file", accept: ".html,.htm,.json,text/html,application/json", tabindex: "-1", "aria-hidden": "true" },
      on: { change: () => this._import() },
    });

    const button = (label, icon, onClick) =>
      createElement("button", {
        className: "browser-button",
        attrs: { type: "button" },
        children: [createIconElement(icon), createElement("span", { text: label })],
        on: { click: onClick },
      });

    this.element = createElement("div", {
      className: "browser-page browser-bookmarks",
      children: [
        createElement("header", {
          className: "browser-page__header",
          children: [
            createElement("h1", { className: "browser-page__title", text: "Bookmarks" }),
            this._searchInput,
            button("Add bookmark", "icon:plus", () => this._addBookmark()),
            button("New folder", "icon:folder", () => this._newFolder()),
            button("Import\u2026", "icon:download", () => this._fileInput.click()),
            button("Export", "icon:external", () => this._export()),
            this._fileInput,
          ],
        }),
        this._statusEl,
        createElement("div", {
          className: "browser-bookmarks__body",
          children: [this._treeEl, createElement("div", { className: "browser-bookmarks__main", children: [this._folderTitleEl, this._listEl] })],
        }),
      ],
    });
    this._cleanup = eventBus.on("bookmarks:changed", () => this.render());
    this._statusEl.hidden = true;
    bookmarkService.ready().then(() => this.render(), () => {});
    this.render();
  }

  /** @returns {HTMLElement} */
  getFocusTarget() {
    return this._searchInput;
  }

  /** @returns {void} */
  destroy() {
    this._cleanup();
    this._menu.hide();
  }

  /** @returns {void} */
  render() {
    if (!bookmarkService.get(this._folderId)) this._folderId = BAR_FOLDER_ID;
    this._renderTree();
    const searching = this._query.trim().length > 0;
    const items = searching ? bookmarkService.search(this._query) : bookmarkService.getChildren(this._folderId);
    this._folderTitleEl.textContent = searching ? `Results for \u201c${this._query.trim()}\u201d` : bookmarkService.get(this._folderId)?.title ?? "";
    this._listEl.replaceChildren(
      ...(items.length
        ? items.map((item, index) => this._row(item, index, items.length, searching))
        : [createElement("li", { className: "browser-page__empty", text: searching ? "No bookmarks match your search." : "This folder is empty." })])
    );
    const error = bookmarkService.getLoadError();
    if (error) this._setStatus(error);
  }

  // ---------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------

  /** @returns {void} */
  _renderTree() {
    const folders = bookmarkService.getFolders();
    this._treeEl.replaceChildren(
      ...folders.map((folder) =>
        createElement("button", {
          className: "browser-bookmarks__folder",
          attrs: { type: "button", "aria-current": !this._query && folder.id === this._folderId ? "true" : null, style: `--depth: ${folder.depth}` },
          children: [createIconElement("icon:folder"), createElement("span", { text: folder.title })],
          on: {
            click: () => {
              this._folderId = folder.id;
              this._query = "";
              this._searchInput.value = "";
              this.render();
            },
          },
        })
      )
    );
  }

  /**
   * @param {object} item
   * @param {number} index
   * @param {number} count
   * @param {boolean} searching
   * @returns {HTMLElement}
   */
  _row(item, index, count, searching) {
    const isFolder = item.type === "folder";
    const main = createElement("button", {
      className: "browser-row__main",
      attrs: { type: "button", title: isFolder ? item.title : item.url },
      children: [
        isFolder ? createIconElement("icon:folder", { className: "browser-favicon" }) : createFavicon(item.url),
        createElement("span", { className: "browser-row__title", text: item.title }),
        createElement("span", { className: "browser-row__meta", text: isFolder ? `${item.children.length} item${item.children.length === 1 ? "" : "s"}` : item.url }),
      ],
      on: {
        click: (e) => {
          if (isFolder) {
            this._folderId = item.id;
            this.render();
          } else {
            this._ctx.navigate(item.url, { newTab: e.ctrlKey || e.metaKey });
          }
        },
        auxclick: (e) => !isFolder && e.button === 1 && this._ctx.navigate(item.url, { newTab: true }),
        contextmenu: (e) => {
          e.preventDefault();
          this._showMenu(item, index, count, searching, { x: e.clientX, y: e.clientY });
        },
      },
    });
    return createElement("li", {
      className: "browser-row",
      attrs: { "data-bookmark-id": item.id },
      children: [
        main,
        createElement("button", {
          className: "browser-icon-button",
          attrs: { type: "button", "aria-label": `Options for ${item.title}`, title: "Options" },
          children: [createIconElement("icon:more")],
          on: {
            click: (e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              this._showMenu(item, index, count, searching, { x: rect.left - 160, y: rect.bottom + 4 });
            },
          },
        }),
      ],
    });
  }

  /**
   * @param {object} item
   * @param {number} index
   * @param {number} count
   * @param {boolean} searching
   * @param {{x: number, y: number}} position
   * @returns {void}
   */
  _showMenu(item, index, count, searching, position) {
    const isFolder = item.type === "folder";
    const parentId = searching ? item.folderId : this._folderId;
    const items = [];
    if (!isFolder) {
      items.push({ label: "Open", action: () => this._ctx.navigate(item.url) }, { label: "Open in new tab", action: () => this._ctx.navigate(item.url, { newTab: true }) }, { separator: true });
    }
    items.push(
      { label: "Edit\u2026", action: () => this._edit(item, parentId) },
      { label: "Move up", disabled: searching || index === 0, action: () => this._run(() => bookmarkService.move(item.id, { parentId, index: index - 1 })) },
      { label: "Move down", disabled: searching || index === count - 1, action: () => this._run(() => bookmarkService.move(item.id, { parentId, index: index + 2 })) },
      { separator: true },
      { label: "Delete", action: () => this._delete(item) }
    );
    this._menu.show(items, position);
  }

  // ---------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------

  /** @returns {Promise<void>} */
  async _addBookmark() {
    await showFormDialog({
      title: "Add bookmark",
      confirmLabel: "Add",
      fields: [
        { id: "title", label: "Name", placeholder: "Optional" },
        { id: "url", label: "Address", type: "url", placeholder: "https://example.com" },
        { id: "folder", label: "Folder", type: "select", value: this._folderId, options: this._folderOptions() },
      ],
      validate: async ({ title, url, folder }) => {
        try {
          const address = /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`;
          const { duplicate } = await bookmarkService.add({ title, url: address, parentId: folder });
          return duplicate ? "That address is already bookmarked in this folder." : null;
        } catch (error) {
          return error.message;
        }
      },
    });
  }

  /** @returns {Promise<void>} */
  async _newFolder() {
    await showFormDialog({
      title: "New folder",
      confirmLabel: "Create",
      fields: [
        { id: "title", label: "Name" },
        { id: "parent", label: "Inside", type: "select", value: this._folderId, options: this._folderOptions() },
      ],
      validate: async ({ title, parent }) => {
        try {
          const folder = await bookmarkService.createFolder({ title, parentId: parent });
          this._folderId = folder.id;
          return null;
        } catch (error) {
          return error.message;
        }
      },
    });
    this.render();
  }

  /**
   * @param {object} item
   * @param {string} parentId
   * @returns {Promise<void>}
   */
  async _edit(item, parentId) {
    const isFolder = item.type === "folder";
    const fields = [{ id: "title", label: "Name", value: item.title }];
    if (!isFolder) fields.push({ id: "url", label: "Address", type: "url", value: item.url });
    fields.push({
      id: "folder",
      label: "Folder",
      type: "select",
      value: parentId,
      options: this._folderOptions(isFolder ? item.id : null),
    });
    await showFormDialog({
      title: isFolder ? "Edit folder" : "Edit bookmark",
      fields,
      validate: async ({ title, url, folder }) => {
        try {
          await bookmarkService.update(item.id, isFolder ? { title } : { title, url });
          if (folder && folder !== parentId) await bookmarkService.move(item.id, { parentId: folder });
          return null;
        } catch (error) {
          return error.message;
        }
      },
    });
  }

  /**
   * @param {object} item
   * @returns {Promise<void>}
   */
  async _delete(item) {
    if (item.type === "folder" && item.children.length > 0) {
      const confirmed = await showConfirmDialog({
        title: `Delete \u201c${item.title}\u201d?`,
        message: `The folder and the ${item.children.length} item${item.children.length === 1 ? "" : "s"} in it will be deleted.`,
        confirmLabel: "Delete",
        destructive: true,
      });
      if (!confirmed) return;
    }
    await this._run(() => bookmarkService.remove(item.id));
  }

  /** @returns {Promise<void>} */
  async _import() {
    const file = this._fileInput.files?.[0];
    this._fileInput.value = "";
    if (!file) return;
    try {
      if (file.size > MAX_IMPORT_BYTES) throw new Error("The file is larger than 5 MB");
      const { imported, skipped, folderId } = await bookmarkService.importFile(await file.text());
      this._folderId = folderId;
      this.render();
      this._setStatus(`Imported ${imported} bookmark${imported === 1 ? "" : "s"}${skipped ? `; ${skipped} invalid entr${skipped === 1 ? "y was" : "ies were"} skipped` : ""}.`);
    } catch (error) {
      await showMessageDialog({ title: "Couldn't import bookmarks", message: error.message });
    }
  }

  /** @returns {Promise<void>} */
  async _export() {
    try {
      const date = new Date().toISOString().slice(0, 10);
      let path = `/Downloads/bookmarks-${date}.html`;
      for (let n = 2; await vfs.exists(path); n += 1) path = `/Downloads/bookmarks-${date} (${n}).html`;
      if (!(await vfs.exists("/Downloads"))) await vfs.createFolder("/Downloads");
      await vfs.createFile(path, bookmarkService.exportHtml());
      this._setStatus(`Exported ${bookmarkService.count()} bookmarks to ${path}.`);
      notificationService.success("Bookmarks exported", {
        title: "Bookmarks exported",
        message: path,
        source: "browser",
        action: { type: "open", path: "/Downloads" },
      });
    } catch (error) {
      await showMessageDialog({ title: "Couldn't export bookmarks", message: error.message });
    }
  }

  /**
   * @param {() => Promise<*>} task
   * @returns {Promise<void>}
   */
  async _run(task) {
    try {
      await task();
    } catch (error) {
      await showMessageDialog({ title: "Bookmarks", message: error.message });
    }
  }

  /**
   * @param {string|null} [excludeId] - A folder (with its subfolders) that can't be chosen.
   * @returns {Array<{value: string, label: string}>}
   */
  _folderOptions(excludeId = null) {
    let skipDepth = null;
    const options = [];
    for (const folder of bookmarkService.getFolders()) {
      if (skipDepth !== null && folder.depth > skipDepth) continue;
      skipDepth = null;
      if (folder.id === excludeId) {
        skipDepth = folder.depth;
        continue;
      }
      options.push({ value: folder.id, label: `${"\u2003".repeat(folder.depth)}${folder.title}` });
    }
    return options;
  }

  /**
   * @param {string} message
   * @returns {void}
   */
  _setStatus(message) {
    this._statusEl.textContent = message;
    this._statusEl.hidden = !message;
  }
}

export { BAR_FOLDER_ID, OTHER_FOLDER_ID };
