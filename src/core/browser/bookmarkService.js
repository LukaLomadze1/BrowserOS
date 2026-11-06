/**
 * @file Bookmarks — shared by every Browser window, stored in the VFS at
 * /Documents/Browser/bookmarks.json so they survive reloads and appear
 * in File Explorer.
 *
 * The tree always has two top-level folders that can't be renamed,
 * moved, or deleted: "Bookmarks bar" (shown under the toolbar) and
 * "Other bookmarks". Everything else is user-defined:
 *
 *   folder:   { id, type: "folder", title, children: Node[], createdAt }
 *   bookmark: { id, type: "bookmark", title, url, createdAt }
 *
 * URLs must be http(s), browseros://, or vfs://. Adding a URL that is
 * already bookmarked in the same folder returns the existing bookmark.
 * Every change is validated, applied in memory, and written through a
 * queue; a failed write rolls the change back. A file that can't be
 * read is kept aside as "bookmarks (unreadable <time>).json". Edits to
 * the file made elsewhere (File Explorer, Terminal) are picked up.
 *
 * Import / export use the standard bookmarks HTML format (Netscape
 * bookmark file) that desktop browsers read and write; JSON exported by
 * BrowserOS can be imported too.
 *
 * Events: "bookmarks:changed" { reason }, "bookmarks:ready" {}.
 */

import { eventBus } from "../eventBus.js";
import { createId } from "../vfs/entry.js";
import { comparableUrl, fallbackTitle, isWebUrl } from "./urlUtils.js";

export const BOOKMARKS_FOLDER = "/Documents/Browser";
export const BOOKMARKS_FILE = `${BOOKMARKS_FOLDER}/bookmarks.json`;
export const BAR_FOLDER_ID = "bar";
export const OTHER_FOLDER_ID = "other";
const FORMAT_ID = "browseros-bookmarks";
const FORMAT_VERSION = 1;
const MAX_NODES = 5000;
const MAX_DEPTH = 12;

class BookmarkService {
  constructor() {
    this._vfs = null;
    this._root = createDefaultRoot();
    this._ready = null;
    this._loadError = null;
    this._writeQueue = Promise.resolve();
    this._writing = 0;
    this._fileHandler = ({ path, entry } = {}) => {
      const changedPath = path ?? entry?.path;
      if (changedPath === BOOKMARKS_FILE && this._writing === 0) this._reload();
    };
  }

  /**
   * Load bookmarks. Call once during boot, after the VFS is ready.
   * @param {{vfs: object}} deps
   * @returns {Promise<void>}
   */
  init({ vfs }) {
    if (this._ready) return this._ready;
    this._vfs = vfs;
    eventBus.on("filesystem:fileModified", this._fileHandler);
    this._ready = this._load().then(() => eventBus.emit("bookmarks:ready", Object.freeze({})));
    return this._ready;
  }

  /** @returns {Promise<void>} */
  ready() {
    return this._ready ?? Promise.reject(new Error("BookmarkService.init() has not been called"));
  }

  /** @returns {string|null} */
  getLoadError() {
    return this._loadError;
  }

  // ---------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------

  /** @returns {object} A deep copy of the whole tree. */
  getTree() {
    return structuredClone(this._root);
  }

  /**
   * @param {string} id
   * @returns {object|null} A copy of the node.
   */
  get(id) {
    const found = this._find(id);
    return found ? structuredClone(found.node) : null;
  }

  /**
   * @param {string} folderId
   * @returns {object[]} Copies of the folder's children.
   */
  getChildren(folderId) {
    const found = this._find(folderId);
    return found && found.node.type === "folder" ? structuredClone(found.node.children) : [];
  }

  /** @returns {object[]} Items on the bookmarks bar. */
  getBarItems() {
    return this.getChildren(BAR_FOLDER_ID);
  }

  /**
   * @returns {Array<{id: string, title: string, depth: number, path: string}>} Every folder, depth-first.
   */
  getFolders() {
    const folders = [];
    const walk = (node, depth, path) => {
      for (const child of node.children) {
        if (child.type !== "folder") continue;
        const childPath = path ? `${path} \u203a ${child.title}` : child.title;
        folders.push({ id: child.id, title: child.title, depth, path: childPath });
        walk(child, depth + 1, childPath);
      }
    };
    walk(this._root, 0, "");
    return folders;
  }

  /**
   * @param {string} url
   * @returns {object[]} Bookmarks for this page (fragment ignored).
   */
  findByUrl(url) {
    const key = comparableUrl(url);
    return this._allBookmarks().filter((bookmark) => comparableUrl(bookmark.url) === key).map((bookmark) => structuredClone(bookmark));
  }

  /**
   * @param {string} url
   * @returns {boolean}
   */
  isBookmarked(url) {
    return this.findByUrl(url).length > 0;
  }

  /**
   * @param {string} query
   * @param {number} [limit]
   * @returns {Array<object & {folderId: string}>} Bookmarks whose title or URL contains the query.
   */
  search(query, limit = 50) {
    const needle = query.trim().toLowerCase();
    const results = [];
    const walk = (folder) => {
      for (const child of folder.children) {
        if (child.type === "folder") walk(child);
        else if (!needle || child.title.toLowerCase().includes(needle) || child.url.toLowerCase().includes(needle)) {
          results.push({ ...structuredClone(child), folderId: folder.id });
        }
      }
    };
    walk(this._root);
    return results.slice(0, limit);
  }

  /** @returns {number} Number of bookmarks (not folders). */
  count() {
    return this._allBookmarks().length;
  }

  // ---------------------------------------------------------------
  // Changes
  // ---------------------------------------------------------------

  /**
   * @param {{url: string, title?: string, parentId?: string, index?: number}} data
   * @returns {Promise<{bookmark: object, duplicate: boolean}>}
   */
  async add({ url, title, parentId = BAR_FOLDER_ID, index }) {
    const cleanUrl = validateUrl(url);
    const parent = this._requireFolder(parentId);
    const existing = parent.children.find((child) => child.type === "bookmark" && comparableUrl(child.url) === comparableUrl(cleanUrl));
    if (existing) return { bookmark: structuredClone(existing), duplicate: true };
    this._assertCapacity();
    const bookmark = { id: createId(), type: "bookmark", title: cleanTitle(title, cleanUrl), url: cleanUrl, createdAt: Date.now() };
    const position = clampIndex(index, parent.children.length);
    await this._commit("add", () => parent.children.splice(position, 0, bookmark), () => removeNode(parent, bookmark.id));
    return { bookmark: structuredClone(bookmark), duplicate: false };
  }

  /**
   * @param {{title: string, parentId?: string, index?: number}} data
   * @returns {Promise<object>} The new folder.
   */
  async createFolder({ title, parentId = OTHER_FOLDER_ID, index }) {
    const parent = this._requireFolder(parentId);
    if (this._depthOf(parentId) >= MAX_DEPTH) throw new Error("Folders can't be nested that deeply");
    this._assertCapacity();
    const name = typeof title === "string" ? title.replace(/\s+/g, " ").trim().slice(0, 120) : "";
    if (!name) throw new Error("Enter a folder name");
    const folder = { id: createId(), type: "folder", title: name, children: [], createdAt: Date.now() };
    const position = clampIndex(index, parent.children.length);
    await this._commit("createFolder", () => parent.children.splice(position, 0, folder), () => removeNode(parent, folder.id));
    return structuredClone(folder);
  }

  /**
   * @param {string} id
   * @param {{title?: string, url?: string}} changes
   * @returns {Promise<object>}
   */
  async update(id, changes) {
    const found = this._find(id);
    if (!found) throw new Error("This bookmark no longer exists");
    const { node } = found;
    if (node.system) throw new Error(`"${node.title}" can't be renamed`);
    const previous = { title: node.title, url: node.url };
    const next = { ...previous };
    if (node.type === "bookmark" && changes.url !== undefined) next.url = validateUrl(changes.url);
    if (changes.title !== undefined) {
      next.title = node.type === "folder" ? String(changes.title).replace(/\s+/g, " ").trim().slice(0, 120) : cleanTitle(changes.title, next.url);
      if (!next.title) throw new Error("Enter a name");
    }
    await this._commit(
      "update",
      () => Object.assign(node, next),
      () => Object.assign(node, previous)
    );
    return structuredClone(node);
  }

  /**
   * Delete a bookmark or a folder with everything inside it.
   * @param {string} id
   * @returns {Promise<void>}
   */
  async remove(id) {
    const found = this._find(id);
    if (!found) return;
    if (found.node.system) throw new Error(`"${found.node.title}" can't be deleted`);
    const { parent, index, node } = found;
    await this._commit("remove", () => parent.children.splice(index, 1), () => parent.children.splice(index, 0, node));
  }

  /**
   * Move a node to another folder and/or position.
   * @param {string} id
   * @param {{parentId: string, index?: number}} target
   * @returns {Promise<void>}
   */
  async move(id, { parentId, index }) {
    const found = this._find(id);
    if (!found) throw new Error("This bookmark no longer exists");
    if (found.node.system) throw new Error(`"${found.node.title}" can't be moved`);
    const target = this._requireFolder(parentId);
    if (found.node.type === "folder" && (found.node.id === parentId || this._contains(found.node, parentId))) {
      throw new Error("A folder can't be moved into itself");
    }
    const { parent: oldParent, index: oldIndex, node } = found;
    let position = clampIndex(index, target.children.length);
    // Removing the node first shifts later positions in the same folder.
    if (oldParent === target && oldIndex < position) position -= 1;
    if (oldParent === target && oldIndex === position) return;
    await this._commit(
      "move",
      () => {
        oldParent.children.splice(oldIndex, 1);
        target.children.splice(Math.min(position, target.children.length), 0, node);
      },
      () => {
        removeNode(target, node.id);
        oldParent.children.splice(oldIndex, 0, node);
      }
    );
  }

  // ---------------------------------------------------------------
  // Import / export
  // ---------------------------------------------------------------

  /** @returns {string} The whole tree as a bookmarks HTML file. */
  exportHtml() {
    const lines = [
      "<!DOCTYPE NETSCAPE-Bookmark-file-1>",
      '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
      "<TITLE>Bookmarks</TITLE>",
      "<H1>Bookmarks</H1>",
      "<DL><p>",
    ];
    const walk = (folder, indent) => {
      for (const child of folder.children) {
        const date = Math.floor((child.createdAt ?? Date.now()) / 1000);
        if (child.type === "folder") {
          const barAttr = child.id === BAR_FOLDER_ID ? ' PERSONAL_TOOLBAR_FOLDER="true"' : "";
          lines.push(`${indent}<DT><H3 ADD_DATE="${date}"${barAttr}>${escapeHtml(child.title)}</H3>`);
          lines.push(`${indent}<DL><p>`);
          walk(child, `${indent}    `);
          lines.push(`${indent}</DL><p>`);
        } else {
          lines.push(`${indent}<DT><A HREF="${escapeHtml(child.url)}" ADD_DATE="${date}">${escapeHtml(child.title)}</A>`);
        }
      }
    };
    walk(this._root, "    ");
    lines.push("</DL><p>");
    return lines.join("\n");
  }

  /**
   * Import a bookmarks HTML file (or BrowserOS bookmarks JSON) into a
   * new folder under "Other bookmarks". Invalid entries are skipped.
   * @param {string} text
   * @returns {Promise<{imported: number, skipped: number, folderId: string}>}
   */
  async importFile(text) {
    if (typeof text !== "string" || !text.trim()) throw new Error("The file is empty");
    const parsed = text.trim().startsWith("{") ? parseJsonTree(text) : parseHtmlTree(text);
    let imported = 0;
    let skipped = 0;
    let nodes = this._countNodes(this._root);
    const convert = (items, depth) => {
      const result = [];
      for (const item of items) {
        if (nodes >= MAX_NODES) {
          skipped += 1;
          continue;
        }
        if (item.type === "folder") {
          if (depth >= MAX_DEPTH) {
            skipped += 1;
            continue;
          }
          nodes += 1;
          result.push({
            id: createId(),
            type: "folder",
            title: String(item.title || "Folder").replace(/\s+/g, " ").trim().slice(0, 120) || "Folder",
            children: convert(item.children ?? [], depth + 1),
            createdAt: item.createdAt ?? Date.now(),
          });
        } else {
          let url;
          try {
            url = validateUrl(item.url);
          } catch {
            skipped += 1;
            continue;
          }
          nodes += 1;
          imported += 1;
          result.push({ id: createId(), type: "bookmark", title: cleanTitle(item.title, url), url, createdAt: item.createdAt ?? Date.now() });
        }
      }
      return result;
    };
    const children = convert(parsed, 1);
    if (imported === 0) throw new Error(skipped ? "No valid bookmarks were found in the file" : "The file contains no bookmarks");
    const other = this._requireFolder(OTHER_FOLDER_ID);
    const folder = {
      id: createId(),
      type: "folder",
      title: `Imported ${new Date().toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}`,
      children,
      createdAt: Date.now(),
    };
    await this._commit("import", () => other.children.push(folder), () => removeNode(other, folder.id));
    return { imported, skipped, folderId: folder.id };
  }

  // ---------------------------------------------------------------
  // Internal: tree
  // ---------------------------------------------------------------

  /**
   * @param {string} id
   * @returns {{node: object, parent: object|null, index: number}|null}
   */
  _find(id) {
    if (id === "root") return { node: this._root, parent: null, index: -1 };
    const walk = (folder) => {
      for (let index = 0; index < folder.children.length; index += 1) {
        const child = folder.children[index];
        if (child.id === id) return { node: child, parent: folder, index };
        if (child.type === "folder") {
          const found = walk(child);
          if (found) return found;
        }
      }
      return null;
    };
    return walk(this._root);
  }

  /**
   * @param {string} id
   * @returns {object}
   */
  _requireFolder(id) {
    const found = this._find(id);
    if (!found || found.node.type !== "folder") throw new Error("That folder no longer exists");
    return found.node;
  }

  /**
   * @param {object} folder
   * @param {string} id
   * @returns {boolean}
   */
  _contains(folder, id) {
    return folder.children.some((child) => child.id === id || (child.type === "folder" && this._contains(child, id)));
  }

  /**
   * @param {string} id
   * @returns {number}
   */
  _depthOf(id) {
    let depth = 0;
    let current = this._find(id);
    while (current && current.parent) {
      depth += 1;
      current = current.parent === this._root ? null : this._find(current.parent.id);
    }
    return depth;
  }

  /**
   * @param {object} node
   * @returns {number}
   */
  _countNodes(node) {
    return node.children.reduce((sum, child) => sum + 1 + (child.type === "folder" ? this._countNodes(child) : 0), 0);
  }

  /** @returns {void} */
  _assertCapacity() {
    if (this._countNodes(this._root) >= MAX_NODES) throw new Error(`Bookmarks are limited to ${MAX_NODES} items`);
  }

  /** @returns {object[]} Every bookmark (live objects). */
  _allBookmarks() {
    const list = [];
    const walk = (folder) => {
      for (const child of folder.children) {
        if (child.type === "folder") walk(child);
        else list.push(child);
      }
    };
    walk(this._root);
    return list;
  }

  // ---------------------------------------------------------------
  // Internal: persistence
  // ---------------------------------------------------------------

  /**
   * @param {string} reason
   * @param {() => void} apply
   * @param {() => void} revert
   * @returns {Promise<void>}
   */
  async _commit(reason, apply, revert) {
    apply();
    try {
      await this._persist();
    } catch (error) {
      revert();
      eventBus.emit("bookmarks:changed", Object.freeze({ reason: "rollback" }));
      throw new Error(`Bookmarks couldn't be saved: ${error.message}`);
    }
    eventBus.emit("bookmarks:changed", Object.freeze({ reason }));
  }

  /** @returns {Promise<void>} */
  _persist() {
    const snapshot = JSON.stringify({ format: FORMAT_ID, version: FORMAT_VERSION, root: this._root }, null, 1);
    const write = async () => {
      this._writing += 1;
      try {
        if (!(await this._vfs.exists("/Documents"))) await this._vfs.createFolder("/Documents");
        if (!(await this._vfs.exists(BOOKMARKS_FOLDER))) await this._vfs.createFolder(BOOKMARKS_FOLDER);
        if (await this._vfs.exists(BOOKMARKS_FILE)) await this._vfs.write(BOOKMARKS_FILE, snapshot);
        else await this._vfs.createFile(BOOKMARKS_FILE, snapshot);
      } finally {
        this._writing -= 1;
      }
    };
    this._writeQueue = this._writeQueue.then(write, write);
    return this._writeQueue;
  }

  /** @returns {Promise<void>} */
  async _load() {
    this._root = createDefaultRoot();
    this._loadError = null;
    let raw;
    try {
      if (!(await this._vfs.exists(BOOKMARKS_FILE))) return;
      raw = await this._vfs.read(BOOKMARKS_FILE);
    } catch (error) {
      this._loadError = `Bookmarks couldn't be read: ${error.message}`;
      console.error("[BookmarkService]", this._loadError);
      return;
    }
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.format !== FORMAT_ID || !parsed.root || !Array.isArray(parsed.root.children)) throw new Error("not a bookmarks document");
      this._root = normalizeRoot(parsed.root);
    } catch (error) {
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
      const name = `bookmarks (unreadable ${stamp}).json`;
      try {
        await this._vfs.rename(BOOKMARKS_FILE, name);
        this._loadError = `The bookmarks file couldn't be read and was kept as "${name}". Bookmarks start empty.`;
      } catch {
        this._loadError = `The bookmarks file couldn't be read (${error.message}).`;
      }
      console.warn("[BookmarkService]", this._loadError);
    }
  }

  /** @returns {Promise<void>} */
  async _reload() {
    await this._load();
    eventBus.emit("bookmarks:changed", Object.freeze({ reason: "external" }));
  }
}

/** @returns {object} */
function createDefaultRoot() {
  return {
    id: "root",
    type: "folder",
    title: "Bookmarks",
    children: [
      { id: BAR_FOLDER_ID, type: "folder", title: "Bookmarks bar", system: true, children: [], createdAt: Date.now() },
      { id: OTHER_FOLDER_ID, type: "folder", title: "Other bookmarks", system: true, children: [], createdAt: Date.now() },
    ],
  };
}

/**
 * Rebuild a stored tree: unknown fields dropped, invalid nodes skipped,
 * duplicate ids replaced, system folders guaranteed.
 * @param {object} storedRoot
 * @returns {object}
 */
function normalizeRoot(storedRoot) {
  const root = createDefaultRoot();
  const seen = new Set(["root", BAR_FOLDER_ID, OTHER_FOLDER_ID]);
  let count = 0;
  const convert = (items, depth) => {
    const result = [];
    for (const item of Array.isArray(items) ? items : []) {
      if (!item || typeof item !== "object" || count >= MAX_NODES) continue;
      const id = typeof item.id === "string" && item.id && !seen.has(item.id) ? item.id : createId();
      seen.add(id);
      const createdAt = Number.isFinite(item.createdAt) ? item.createdAt : Date.now();
      if (item.type === "folder" && depth < MAX_DEPTH) {
        count += 1;
        const title = typeof item.title === "string" ? item.title.replace(/\s+/g, " ").trim().slice(0, 120) : "";
        result.push({ id, type: "folder", title: title || "Folder", children: convert(item.children, depth + 1), createdAt });
      } else if (item.type === "bookmark") {
        try {
          const url = validateUrl(item.url);
          count += 1;
          result.push({ id, type: "bookmark", title: cleanTitle(item.title, url), url, createdAt });
        } catch {
          /* skip invalid bookmark */
        }
      }
    }
    return result;
  };
  for (const system of root.children) {
    const stored = storedRoot.children.find((child) => child && child.id === system.id);
    if (stored) system.children = convert(stored.children, 1);
  }
  // User folders stored at the top level (not allowed) go to "Other bookmarks".
  const strays = storedRoot.children.filter((child) => child && child.id !== BAR_FOLDER_ID && child.id !== OTHER_FOLDER_ID);
  root.children[1].children.push(...convert(strays, 1));
  return root;
}

/**
 * @param {*} url
 * @returns {string} A normalized URL.
 * @throws {Error} When the URL can't be bookmarked.
 */
function validateUrl(url) {
  if (typeof url !== "string" || !url.trim()) throw new Error("Enter an address");
  const text = url.trim();
  if (/^browseros:\/\/[a-z]+$/i.test(text)) return text.toLowerCase();
  if (/^vfs:\/\/\//i.test(text)) return text;
  if (isWebUrl(text)) return new URL(text).href;
  throw new Error(`"${text.slice(0, 80)}" isn't a web address that can be bookmarked`);
}

/**
 * @param {*} title
 * @param {string} url
 * @returns {string}
 */
function cleanTitle(title, url) {
  const text = typeof title === "string" ? title.replace(/\s+/g, " ").trim().slice(0, 300) : "";
  return text || fallbackTitle(url);
}

/**
 * @param {*} index
 * @param {number} length
 * @returns {number}
 */
function clampIndex(index, length) {
  return Number.isInteger(index) ? Math.max(0, Math.min(length, index)) : length;
}

/**
 * @param {object} folder
 * @param {string} id
 * @returns {void}
 */
function removeNode(folder, id) {
  const index = folder.children.findIndex((child) => child.id === id);
  if (index !== -1) folder.children.splice(index, 1);
}

/**
 * @param {string} text
 * @returns {string}
 */
function escapeHtml(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Parse a bookmarks HTML file into plain {type, title, url, children}
 * items. DOMParser builds an inert document: no scripts run and nothing
 * is loaded.
 * @param {string} text
 * @returns {object[]}
 */
function parseHtmlTree(text) {
  const doc = new DOMParser().parseFromString(text, "text/html");
  const rootList = doc.querySelector("dl");
  if (!rootList) throw new Error("This isn't a bookmarks file");
  const readList = (dl) => {
    const items = [];
    for (const dt of dl.querySelectorAll(":scope > dt, :scope > p > dt")) {
      const heading = dt.querySelector(":scope > h3");
      const link = dt.querySelector(":scope > a");
      const date = (el) => (Number(el.getAttribute("add_date")) > 0 ? Number(el.getAttribute("add_date")) * 1000 : undefined);
      if (heading) {
        let sublist = dt.querySelector(":scope > dl");
        if (!sublist) {
          // Some exporters put the <DL> right after the <DT>.
          let next = dt.nextElementSibling;
          while (next && next.tagName === "P") next = next.nextElementSibling;
          if (next && next.tagName === "DL") sublist = next;
        }
        items.push({ type: "folder", title: heading.textContent, children: sublist ? readList(sublist) : [], createdAt: date(heading) });
      } else if (link) {
        items.push({ type: "bookmark", title: link.textContent, url: link.getAttribute("href"), createdAt: date(link) });
      }
    }
    return items;
  };
  return readList(rootList);
}

/**
 * @param {string} text
 * @returns {object[]}
 */
function parseJsonTree(text) {
  const parsed = JSON.parse(text);
  const root = parsed?.format === FORMAT_ID ? parsed.root : parsed;
  if (!root || !Array.isArray(root.children)) throw new Error("This isn't a bookmarks file");
  return root.children.flatMap((child) => (child && (child.id === BAR_FOLDER_ID || child.id === OTHER_FOLDER_ID) ? child.children ?? [] : [child]));
}

/**
 * Singleton bookmark store shared by every Browser window.
 * @type {BookmarkService}
 */
export const bookmarkService = new BookmarkService();
