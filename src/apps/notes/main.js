/**
 * @file Notes — a minimal plain-text notepad with two modes.
 *
 * Personal mode (no path given): unchanged from before — autosaves to
 * the existing StorageService (localStorage) under one fixed key, a
 * short beat after typing stops.
 *
 * VFS mode (launched with `{ path }`, e.g. by double-clicking a .txt
 * file on the desktop or in Explorer): loads content from the Virtual
 * File System, shows the file's name as the window title, and
 * autosaves back to that same VFS path instead of localStorage.
 *
 * VFS mode also tracks the file's entry id (not just its path) and
 * listens for filesystem:fileRenamed/fileMoved/fileDeleted, so a
 * rename from Explorer or Desktop updates this window's title and
 * keeps future saves pointed at the right path, and a delete
 * disables editing instead of silently failing the next autosave.
 */

import { Application } from "../../core/application.js";
import { createElement } from "../../utils/dom.js";
import { storage } from "../../core/storage.js";
import { vfs } from "../../core/vfs/virtualFileSystem.js";
import { getBaseName } from "../../core/vfs/pathResolver.js";
import { eventBus } from "../../core/eventBus.js";
import { ensureStylesheet } from "../../utils/loadStylesheet.js";

ensureStylesheet("src/apps/notes/notes.css");

const STORAGE_KEY = "notes:content";
const AUTOSAVE_DELAY_MS = 500;

export default class NotesApp extends Application {
  constructor(meta) {
    super(meta);
    this._textareaEl = null;
    this._statusEl = null;
    this._titleEl = null;
    this._saveTimeoutId = null;
    /** @type {string|null} Non-null when opened as a VFS file rather than the personal scratch note. */
    this._vfsPath = null;
    /** @type {string|null} Tracked separately from the path, since a rename/move changes the path but not the identity. */
    this._vfsEntryId = null;
    this._unsubscribeRename = null;
    this._unsubscribeMove = null;
    this._unsubscribeDelete = null;
  }

  /**
   * @param {{path?: string}} [options]
   * @returns {ReturnType<Application["launch"]>}
   */
  launch(options = {}) {
    this._vfsPath = options.path ?? null;
    return this._vfsPath ? this._launchVfsMode(this._vfsPath) : this._launchPersonalMode();
  }

  /** @returns {ReturnType<Application["launch"]>} */
  _launchPersonalMode() {
    const savedContent = storage.get(STORAGE_KEY, "");

    this._statusEl = createElement("span", {
      className: "notes__status",
      text: savedContent ? "Loaded" : "New note",
    });

    this._textareaEl = createElement("textarea", {
      className: "notes__textarea",
      attrs: { placeholder: "Start typing\u2026", "aria-label": "Notes" },
      on: { input: () => this._scheduleSave() },
    });
    this._textareaEl.value = savedContent;

    const toolbar = createElement("div", {
      className: "notes__toolbar",
      children: [createElement("span", { className: "notes__title", text: "Notes" }), this._statusEl],
    });

    const element = createElement("div", { className: "notes", children: [toolbar, this._textareaEl] });

    return {
      element,
      title: "Notes",
      icon: "\u270e",
      width: 420,
      height: 480,
      minWidth: 300,
      minHeight: 260,
      resizable: true,
      minimizable: true,
      maximizable: true,
      closable: true,
    };
  }

  /**
   * @param {string} path
   * @returns {ReturnType<Application["launch"]>}
   */
  _launchVfsMode(path) {
    const name = getBaseName(path);

    this._statusEl = createElement("span", { className: "notes__status", text: "Loading\u2026" });
    this._titleEl = createElement("span", { className: "notes__title", text: name });

    this._textareaEl = createElement("textarea", {
      className: "notes__textarea",
      attrs: { placeholder: "Loading\u2026", "aria-label": `Notes \u2014 ${name}`, disabled: "true" },
      on: { input: () => this._scheduleSave() },
    });

    const toolbar = createElement("div", { className: "notes__toolbar", children: [this._titleEl, this._statusEl] });
    const element = createElement("div", { className: "notes", children: [toolbar, this._textareaEl] });

    this._unsubscribeRename = eventBus.on("filesystem:fileRenamed", ({ entry }) => this._handleExternalRename(entry));
    this._unsubscribeMove = eventBus.on("filesystem:fileMoved", ({ entry }) => this._handleExternalMove(entry));
    this._unsubscribeDelete = eventBus.on("filesystem:fileDeleted", ({ entry }) => this._handleExternalDelete(entry));

    this._loadVfsContent(path);

    return {
      element,
      title: name,
      icon: "\u270e",
      width: 420,
      height: 480,
      minWidth: 300,
      minHeight: 260,
      resizable: true,
      minimizable: true,
      maximizable: true,
      closable: true,
    };
  }

  /**
   * @param {string} path
   * @returns {Promise<void>}
   */
  async _loadVfsContent(path) {
    try {
      const info = await vfs.getInfo(path);
      this._vfsEntryId = info.id;
      const content = await vfs.read(path);
      this._textareaEl.value = content;
      this._textareaEl.removeAttribute("disabled");
      this._statusEl.textContent = "Loaded";
    } catch (error) {
      // Opening a missing/moved file: fail visibly, not silently —
      // keep the textarea disabled rather than let the user type into
      // content that can never be saved anywhere.
      this._statusEl.textContent = "Couldn't load this file";
      this._textareaEl.placeholder = error.message;
    }
  }

  /**
   * @param {object} entry
   * @returns {void}
   */
  _handleExternalRename(entry) {
    if (entry.id !== this._vfsEntryId) return;
    this._vfsPath = entry.path;
    this._titleEl.textContent = entry.name;
    this.appManager?.updateWindowTitle(this.windowId, entry.name);
  }

  /**
   * @param {object} entry
   * @returns {void}
   */
  _handleExternalMove(entry) {
    // A move changes the path (needed so the next autosave targets
    // the right place) but never the name, so the title is untouched.
    if (entry.id !== this._vfsEntryId) return;
    this._vfsPath = entry.path;
  }

  /**
   * @param {object} entry
   * @returns {void}
   */
  _handleExternalDelete(entry) {
    if (entry.id !== this._vfsEntryId) return;
    this._vfsPath = null; // Stop autosave from trying to write to a path that's now in /Trash.
    this._textareaEl.setAttribute("disabled", "true");
    this._statusEl.textContent = "This file was moved to Trash";
  }

  /** @returns {void} */
  close() {
    this._unsubscribeRename?.();
    this._unsubscribeMove?.();
    this._unsubscribeDelete?.();

    if (this._saveTimeoutId !== null) {
      window.clearTimeout(this._saveTimeoutId);
      // Best-effort final save; the window is closing regardless, so
      // this intentionally isn't awaited.
      this._flushSave();
    }
  }

  /** @returns {void} */
  _scheduleSave() {
    this._statusEl.textContent = "Saving\u2026";
    if (this._saveTimeoutId !== null) {
      window.clearTimeout(this._saveTimeoutId);
    }
    this._saveTimeoutId = window.setTimeout(() => this._flushSave(), AUTOSAVE_DELAY_MS);
  }

  /** @returns {Promise<void>} */
  async _flushSave() {
    this._saveTimeoutId = null;
    if (this._vfsPath === null && this._vfsEntryId !== null) {
      // The file was deleted out from under us — nothing sane to save to.
      return;
    }
    try {
      if (this._vfsPath) {
        await vfs.write(this._vfsPath, this._textareaEl.value);
      } else {
        storage.set(STORAGE_KEY, this._textareaEl.value);
      }
      this._statusEl.textContent = "Saved";
    } catch (error) {
      // Failed autosave must be visible, not just console.error —
      // the status line is the one place the user is likely looking.
      this._statusEl.textContent = `Couldn't save: ${error.message}`;
    }
  }
}
