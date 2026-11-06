/**
 * @file NotesLibrary — Notes' data layer. Every file operation goes
 * through the public VFS API; this module never touches IndexedDB.
 *
 * Library: note documents live in /Documents/Notes (created on first
 * use). Notes can also open .note/.txt/.md files anywhere else in the
 * VFS; those are edited in place and saved back to their own path.
 *
 * Search: a plain-text index (entry id → text) is built by reading each
 * library note once and updated on every save, so searching never
 * re-reads files while typing.
 *
 * Drafts: unsaved editor content is mirrored to StorageService (one key
 * per note) on a short debounce and cleared after a successful save. If
 * BrowserOS closes before a save completes, the draft is offered for
 * recovery the next time the note is opened — content is never
 * silently discarded.
 *
 * Migration: the plain-text scratch note that earlier versions of
 * Notes kept in localStorage ("notes:content") becomes a real
 * "Quick Note.note" document the first time the library loads.
 *
 * Events (EventBus): "notes:created", "notes:updated", "notes:deleted",
 * each with { id, path, title }.
 */

import { eventBus } from "../../core/eventBus.js";
import { storage } from "../../core/storage.js";
import {
  documentKind,
  isNoteFile,
  parseNoteDocument,
  serializeNoteDocument,
  htmlToPlainText,
  plainTextToHtml,
} from "./noteFormat.js";

export const NOTES_FOLDER = "/Documents/Notes";
const LEGACY_CONTENT_KEY = "notes:content";
const WELCOME_FLAG_KEY = "notes:welcomeCreated";
const DRAFT_KEY_PREFIX = "notes:draft:";
const DEFAULT_TITLE = "Untitled";

const WELCOME_HTML = [
  "<h1>Welcome to Notes</h1>",
  "<p>Notes are saved automatically to <b>/Documents/Notes</b> in the file system, so they also appear in File Explorer.</p>",
  "<h2>Formatting</h2>",
  "<ul><li><b>Bold</b>, <i>italic</i>, <u>underline</u>, and <s>strikethrough</s></li><li>Headings, bullet and numbered lists</li><li>Links \u2014 Ctrl + click to open them</li></ul>",
  "<h2>Checklist</h2>",
  '<ul data-checklist="true"><li data-checked="true">Create a note</li><li data-checked="false">Try the search box</li><li data-checked="false">Open a .txt file from File Explorer</li></ul>',
].join("");

class NotesLibrary {
  /**
   * @param {import("../../core/vfs/virtualFileSystem.js").vfs} vfs
   */
  constructor(vfs) {
    this._vfs = vfs;
    /** @type {Map<string, string>} entry id → plain text */
    this._index = new Map();
    this._folderId = null;
  }

  // ---------------------------------------------------------------
  // Library folder
  // ---------------------------------------------------------------

  /**
   * Make sure the notes folder exists and run one-time content setup
   * (legacy migration, welcome note).
   * @returns {Promise<void>}
   */
  async ensureFolder() {
    let created = false;
    if (!(await this._vfs.exists("/Documents"))) await this._vfs.createFolder("/Documents");
    if (!(await this._vfs.exists(NOTES_FOLDER))) {
      await this._vfs.createFolder(NOTES_FOLDER);
      created = true;
    }
    this._folderId = (await this._vfs.getInfo(NOTES_FOLDER)).id;

    const migrated = await this._migrateLegacyScratchNote();
    if (created && !migrated && !storage.get(WELCOME_FLAG_KEY, false)) {
      try {
        await this._vfs.createFile(`${NOTES_FOLDER}/Welcome to Notes.note`, serializeNoteDocument(WELCOME_HTML));
      } catch (error) {
        console.warn("[Notes] could not create the welcome note:", error);
      }
    }
    storage.set(WELCOME_FLAG_KEY, true);
  }

  /**
   * @param {object} entry
   * @returns {boolean} Whether the entry is a note directly inside the library folder.
   */
  isLibraryEntry(entry) {
    return entry.type === "file" && entry.parentId === this._folderId && isNoteFile(entry.name) && !entry.path.startsWith("/Trash");
  }

  /**
   * @returns {Promise<object[]>} Library notes, most recently modified first.
   */
  async list() {
    const children = await this._vfs.list(NOTES_FOLDER);
    return children
      .filter((entry) => entry.type === "file" && isNoteFile(entry.name) && !entry.hidden)
      .sort((a, b) => b.modifiedAt - a.modifiedAt);
  }

  // ---------------------------------------------------------------
  // Documents
  // ---------------------------------------------------------------

  /**
   * @param {string} path
   * @returns {Promise<{entry: object, kind: "rich"|"plain", content: string, recovered: boolean}>}
   *   `content` is sanitized HTML for rich notes and raw text for plain files.
   */
  async read(path) {
    const entry = await this._vfs.getInfo(path);
    const raw = await this._vfs.read(path);
    const kind = documentKind(entry.extension);
    if (kind === "rich") {
      const { html, recovered } = parseNoteDocument(raw);
      this._index.set(entry.id, htmlToPlainText(html));
      return { entry, kind, content: html, recovered };
    }
    this._index.set(entry.id, raw);
    return { entry, kind, content: raw, recovered: false };
  }

  /**
   * @param {string} path
   * @param {"rich"|"plain"} kind
   * @param {string} content - HTML for rich, text for plain.
   * @returns {Promise<object>} The updated entry.
   */
  async save(path, kind, content) {
    const data = kind === "rich" ? serializeNoteDocument(content) : content;
    const entry = await this._vfs.write(path, data);
    this._index.set(entry.id, kind === "rich" ? htmlToPlainText(content) : content);
    eventBus.emit("notes:updated", Object.freeze({ id: entry.id, path: entry.path, title: titleOf(entry.name) }));
    return entry;
  }

  /**
   * Create a new, empty note in the library.
   * @param {string} [title]
   * @returns {Promise<object>} The created entry.
   */
  async create(title = DEFAULT_TITLE) {
    const name = await this._uniqueName(`${title}.note`);
    const entry = await this._vfs.createFile(`${NOTES_FOLDER}/${name}`, serializeNoteDocument(""));
    this._index.set(entry.id, "");
    eventBus.emit("notes:created", Object.freeze({ id: entry.id, path: entry.path, title: titleOf(entry.name) }));
    return entry;
  }

  /**
   * @param {string} path
   * @returns {Promise<object>} The copy.
   */
  async duplicate(path) {
    const entry = await this._vfs.getInfo(path);
    const raw = await this._vfs.read(path);
    const folder = entry.path.slice(0, entry.path.lastIndexOf("/")) || "/";
    const extension = entry.extension ? `.${entry.extension}` : "";
    const name = await this._uniqueName(`${titleOf(entry.name)} copy${extension}`, folder);
    const copy = await this._vfs.createFile(folder === "/" ? `/${name}` : `${folder}/${name}`, raw);
    this._index.set(copy.id, this._index.get(entry.id) ?? "");
    eventBus.emit("notes:created", Object.freeze({ id: copy.id, path: copy.path, title: titleOf(copy.name) }));
    return copy;
  }

  /**
   * Rename keeping the extension.
   * @param {string} path
   * @param {string} title
   * @returns {Promise<object>} The renamed entry.
   */
  async rename(path, title) {
    const entry = await this._vfs.getInfo(path);
    const extension = entry.extension ? `.${entry.extension}` : "";
    const renamed = await this._vfs.rename(path, `${title}${extension}`);
    eventBus.emit("notes:updated", Object.freeze({ id: renamed.id, path: renamed.path, title: titleOf(renamed.name) }));
    return renamed;
  }

  /**
   * Move a note to Trash.
   * @param {string} path
   * @returns {Promise<void>}
   */
  async remove(path) {
    const entry = await this._vfs.getInfo(path);
    await this._vfs.delete(path);
    this._index.delete(entry.id);
    this.clearDraft(entry.id);
    eventBus.emit("notes:deleted", Object.freeze({ id: entry.id, path, title: titleOf(entry.name) }));
  }

  // ---------------------------------------------------------------
  // Search
  // ---------------------------------------------------------------

  /**
   * Read every library note not yet indexed.
   * @param {object[]} entries
   * @returns {Promise<void>}
   */
  async indexAll(entries) {
    for (const entry of entries) {
      if (this._index.has(entry.id)) continue;
      try {
        await this.read(entry.path);
      } catch (error) {
        console.warn(`[Notes] could not index "${entry.path}":`, error);
        this._index.set(entry.id, "");
      }
    }
  }

  /**
   * @param {string} id
   * @returns {void}
   */
  forget(id) {
    this._index.delete(id);
  }

  /**
   * @param {string} id
   * @param {string} text
   * @returns {void}
   */
  setIndexedText(id, text) {
    this._index.set(id, text);
  }

  /**
   * @param {string} id
   * @returns {string}
   */
  getIndexedText(id) {
    return this._index.get(id) ?? "";
  }

  /**
   * @param {string} query
   * @param {object[]} entries
   * @returns {Array<{entry: object, inTitle: boolean, snippet: string|null}>} Matches; title matches first.
   */
  search(query, entries) {
    const needle = query.trim().toLowerCase();
    if (!needle) return entries.map((entry) => ({ entry, inTitle: false, snippet: null }));
    const results = [];
    for (const entry of entries) {
      const inTitle = titleOf(entry.name).toLowerCase().includes(needle);
      const text = this._index.get(entry.id) ?? "";
      const position = text.toLowerCase().indexOf(needle);
      if (!inTitle && position === -1) continue;
      results.push({ entry, inTitle, snippet: position === -1 ? null : makeSnippet(text, position, needle.length) });
    }
    return results.sort((a, b) => Number(b.inTitle) - Number(a.inTitle));
  }

  // ---------------------------------------------------------------
  // Drafts
  // ---------------------------------------------------------------

  /**
   * @param {string} id
   * @param {"rich"|"plain"} kind
   * @param {string} content
   * @returns {void}
   */
  saveDraft(id, kind, content) {
    storage.set(`${DRAFT_KEY_PREFIX}${id}`, { kind, content, savedAt: Date.now() });
  }

  /**
   * @param {string} id
   * @returns {{kind: "rich"|"plain", content: string, savedAt: number}|null}
   */
  getDraft(id) {
    const draft = storage.get(`${DRAFT_KEY_PREFIX}${id}`, null);
    if (!draft || typeof draft.content !== "string" || !Number.isFinite(draft.savedAt)) return null;
    if (draft.kind !== "rich" && draft.kind !== "plain") return null;
    return draft;
  }

  /**
   * @param {string} id
   * @returns {void}
   */
  clearDraft(id) {
    try {
      storage.remove(`${DRAFT_KEY_PREFIX}${id}`);
    } catch (error) {
      console.warn("[Notes] could not clear a draft:", error);
    }
  }

  // ---------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------

  /**
   * @returns {Promise<boolean>} Whether a legacy note was migrated.
   */
  async _migrateLegacyScratchNote() {
    const legacy = storage.get(LEGACY_CONTENT_KEY, null);
    if (typeof legacy !== "string") return false;
    if (legacy.trim()) {
      const name = await this._uniqueName("Quick Note.note");
      await this._vfs.createFile(`${NOTES_FOLDER}/${name}`, serializeNoteDocument(plainTextToHtml(legacy)));
    }
    storage.remove(LEGACY_CONTENT_KEY);
    return Boolean(legacy.trim());
  }

  /**
   * @param {string} name
   * @param {string} [folder]
   * @returns {Promise<string>}
   */
  async _uniqueName(name, folder = NOTES_FOLDER) {
    const siblings = new Set((await this._vfs.list(folder)).map((entry) => entry.name.toLowerCase()));
    if (!siblings.has(name.toLowerCase())) return name;
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const extension = dot > 0 ? name.slice(dot) : "";
    for (let counter = 2; ; counter += 1) {
      const candidate = `${stem} ${counter}${extension}`;
      if (!siblings.has(candidate.toLowerCase())) return candidate;
    }
  }
}

/**
 * @param {string} name
 * @returns {string} The title shown for a note (file name without extension).
 */
export function titleOf(name) {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/**
 * @param {string} text
 * @param {number} position
 * @param {number} length
 * @returns {string}
 */
function makeSnippet(text, position, length) {
  const start = Math.max(0, position - 30);
  const end = Math.min(text.length, position + length + 50);
  return `${start > 0 ? "\u2026" : ""}${text.slice(start, end).replace(/\s+/g, " ")}${end < text.length ? "\u2026" : ""}`;
}

export { NotesLibrary };
