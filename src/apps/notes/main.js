/**
 * @file Notes — a document editor for rich notes (.note) and plain
 * text (.txt, .md), backed by the VFS.
 *
 * One Notes window (single instance) holds the whole library
 * (/Documents/Notes) plus any note files opened from elsewhere in this
 * session. Opening a note file from File Explorer, the Desktop, the
 * Start Menu, or Terminal routes here through the file-association
 * system (`onRelaunch({ path })`), so one document is never edited in
 * two windows at once.
 *
 * Saving: changes autosave after a short pause, the status shows
 * Unsaved / Saving / Saved / error, and a draft is mirrored to storage
 * until the save succeeds (see NotesLibrary). Switching documents,
 * Ctrl + S, and closing the window all flush pending changes first.
 *
 * External changes are followed through filesystem events: renames
 * update titles, moves update paths, edits from elsewhere reload a
 * document that has no unsaved changes, and a document deleted while
 * open keeps its content in the editor with an option to save it as a
 * new note.
 */

import { Application } from "../../core/application.js";
import { eventBus } from "../../core/eventBus.js";
import { notificationService } from "../../core/notifications/notificationService.js";
import { vfs } from "../../core/vfs/virtualFileSystem.js";
import { keyboardShortcuts } from "../../core/keyboard/keyboardShortcuts.js";
import { ContextMenu } from "../../components/context-menu/contextMenu.js";
import { showConfirmDialog } from "../../components/dialog/confirmDialog.js";
import { showPromptDialog } from "../../components/dialog/promptDialog.js";
import { showMessageDialog } from "../../components/dialog/messageDialog.js";
import { createElement, clearElement, hasModifierKey } from "../../utils/dom.js";
import { formatDate } from "../../utils/format.js";
import { ensureStylesheet } from "../../utils/loadStylesheet.js";
import { NotesLibrary, NOTES_FOLDER, titleOf } from "./notesLibrary.js";
import { NotesEditor } from "./notesEditor.js";
import { countText, isNoteFile, plainTextToHtml, serializeNoteDocument } from "./noteFormat.js";

ensureStylesheet("src/apps/notes/notes.css");

const AUTOSAVE_DELAY_MS = 800;
const DRAFT_DELAY_MS = 300;
const COUNT_DELAY_MS = 150;
const SEARCH_DELAY_MS = 120;

/** Toolbar buttons: [command, label, glyph, shortcut id]. */
const FORMAT_BUTTONS = [
  ["bold", "Bold", "B", "notes.bold"],
  ["italic", "Italic", "I", "notes.italic"],
  ["underline", "Underline", "U", "notes.underline"],
  ["strike", "Strikethrough", "S", "notes.strike"],
];
const LIST_BUTTONS = [
  ["ul", "Bulleted list", "\u2022\u2261", "notes.bulletList"],
  ["ol", "Numbered list", "1\u2261", "notes.numberedList"],
  ["checklist", "Checklist", "\u2611", "notes.checklist"],
  ["link", "Link", "\u2197", "notes.link"],
];

export default class NotesApp extends Application {
  constructor(meta) {
    super(meta);
    this._library = new NotesLibrary(vfs);
    this._contextMenu = new ContextMenu();
    /** @type {object[]} */
    this._entries = [];
    /** @type {Map<string, object>} Files opened from outside the library this session. */
    this._external = new Map();
    /** @type {{entry: object, kind: "rich"|"plain", lastSaved: string, deleted: boolean}|null} */
    this._doc = null;
    this._dirty = false;
    this._saving = null;
    this._saveError = null;
    this._query = "";
    this._timers = { save: null, draft: null, count: null, search: null };
    this._cleanups = [];
    this._closed = false;
  }

  /**
   * @param {{path?: string}} [options]
   * @returns {ReturnType<Application["launch"]>}
   */
  launch(options = {}) {
    this._buildDom();
    this._renderDocumentChrome();
    this._wireEvents();
    this._initialize(options.path ?? null);

    return {
      element: this._root,
      title: "Notes",
      icon: "icon:notes",
      width: 920,
      height: 620,
      minWidth: 420,
      minHeight: 360,
      resizable: true,
      minimizable: true,
      maximizable: true,
      closable: true,
    };
  }

  /**
   * Another launch while open (e.g. a note file opened from Explorer).
   * @param {{path?: string}} [options]
   * @returns {void}
   */
  onRelaunch(options = {}) {
    if (options.path) this._openPath(options.path);
  }

  /** @returns {void} */
  close() {
    this._closed = true;
    for (const id of Object.values(this._timers)) window.clearTimeout(id);
    // Best effort: the draft stays in storage until this save succeeds,
    // so nothing is lost if the window closes first.
    if (this._dirty) this._flush();
    for (const cleanup of this._cleanups) cleanup();
    this._cleanups = [];
    this._editor.destroy();
    this._contextMenu.hide();
  }

  // ---------------------------------------------------------------
  // Startup
  // ---------------------------------------------------------------

  /**
   * @param {string|null} path
   * @returns {Promise<void>}
   */
  async _initialize(path) {
    try {
      await this._library.ensureFolder();
      this._entries = await this._library.list();
    } catch (error) {
      this._showListError(`The notes folder couldn't be opened: ${error.message}`);
      return;
    }
    this._renderList();

    if (path) {
      await this._openPath(path);
    } else if (this._entries.length > 0) {
      await this._openPath(this._entries[0].path);
    }

    // Index content for search in the background.
    await this._library.indexAll(this._entries);
    if (!this._closed) this._renderList();
  }

  // ---------------------------------------------------------------
  // DOM
  // ---------------------------------------------------------------

  /** @returns {void} */
  _buildDom() {
    this._searchInput = createElement("input", {
      className: "notes__search-input",
      attrs: { type: "search", placeholder: "Search notes", "aria-label": "Search notes", autocomplete: "off" },
      on: {
        input: () => this._scheduleSearch(),
        keydown: (e) => {
          if (e.key === "ArrowDown" && !hasModifierKey(e)) {
            e.preventDefault();
            this._listEl.querySelector(".notes__item")?.focus();
          }
        },
      },
    });

    this._listEl = createElement("div", { className: "notes__list", attrs: { role: "list", "aria-label": "Notes" } });
    this._listEl.addEventListener("keydown", (e) => this._handleListKeydown(e));

    const sidebar = createElement("aside", {
      className: "notes__sidebar",
      attrs: { "aria-label": "Notes library" },
      children: [
        createElement("div", {
          className: "notes__sidebar-top",
          children: [
            createElement("div", { className: "notes__search", children: [createElement("span", { className: "notes__search-icon", attrs: { "aria-hidden": "true" }, text: "\u2315" }), this._searchInput] }),
            createElement("button", {
              className: "notes__button notes__button--primary",
              attrs: { type: "button", title: "New note (Ctrl + Alt + N)" },
              text: "+ New note",
              on: { click: () => this._createNote() },
            }),
          ],
        }),
        this._listEl,
      ],
    });

    this._titleInput = createElement("input", {
      className: "notes__title-input",
      attrs: { type: "text", "aria-label": "Note title", spellcheck: "false", autocomplete: "off" },
      on: {
        keydown: (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            this._editor.focus();
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            this._titleInput.value = this._doc ? titleOf(this._doc.entry.name) : "";
            this._editor.focus();
          }
        },
        change: () => this._renameCurrent(this._titleInput.value),
      },
    });
    this._metaEl = createElement("span", { className: "notes__meta" });
    this._statusEl = createElement("span", { className: "notes__status", attrs: { role: "status", "aria-live": "polite" } });
    this._retryButton = createElement("button", {
      className: "notes__link-button",
      attrs: { type: "button" },
      text: "Retry",
      on: { click: () => this._flush() },
    });
    this._retryButton.hidden = true;

    this._sidebarToggle = createElement("button", {
      className: "notes__icon-button notes__sidebar-toggle",
      attrs: { type: "button", "aria-label": "Show notes list", "aria-expanded": "false" },
      text: "\u2630",
      on: { click: () => this._toggleSidebar() },
    });

    const header = createElement("div", {
      className: "notes__header",
      children: [
        this._sidebarToggle,
        createElement("div", {
          className: "notes__heading",
          children: [this._titleInput, createElement("div", { className: "notes__subline", children: [this._metaEl, this._statusEl, this._retryButton] })],
        }),
        createElement("button", {
          className: "notes__icon-button",
          attrs: { type: "button", "aria-label": "Delete note", title: "Delete note" },
          text: "\u{1F5D1}",
          on: { click: () => this._deleteCurrent() },
        }),
      ],
    });

    this._toolbar = this._buildToolbar();

    this._bannerEl = createElement("div", { className: "notes__banner", attrs: { role: "status" } });
    this._bannerEl.hidden = true;

    this._editor = new NotesEditor({
      onInput: () => this._handleEditorInput(),
      onStateChange: () => this._renderToolbarState(),
      onRequestLink: (href) => this._promptForLink(href),
    });

    this._countsEl = createElement("span", { className: "notes__counts" });
    this._kindEl = createElement("span", { className: "notes__kind" });
    const footer = createElement("div", { className: "notes__footer", children: [this._countsEl, this._kindEl] });

    this._docEl = createElement("div", {
      className: "notes__document",
      children: [header, this._toolbar, this._bannerEl, this._editor.getElement(), footer],
    });

    this._emptyEl = createElement("div", {
      className: "notes__empty",
      children: [
        createElement("span", { className: "notes__empty-glyph", attrs: { "aria-hidden": "true" }, text: "\u270e" }),
        createElement("p", { className: "notes__empty-title", text: "No note selected" }),
        createElement("p", { className: "notes__empty-text", text: "Choose a note from the list or create a new one." }),
        createElement("button", {
          className: "notes__button notes__button--primary",
          attrs: { type: "button" },
          text: "+ New note",
          on: { click: () => this._createNote() },
        }),
      ],
    });

    const main = createElement("section", { className: "notes__main", children: [this._docEl, this._emptyEl] });

    this._root = createElement("div", {
      className: "notes",
      children: [sidebar, main],
      on: { keydown: (e) => this._handleKeydown(e) },
    });
  }

  /** @returns {HTMLElement} */
  _buildToolbar() {
    this._toolButtons = new Map();
    const makeButton = ([command, label, glyph, shortcutId]) => {
      const keys = keyboardShortcuts.getDefinition(shortcutId)?.combos?.[0];
      const button = createElement("button", {
        className: `notes__tool notes__tool--${command}`,
        attrs: { type: "button", "aria-label": label, title: keys ? `${label} (${formatShortcut(shortcutId)})` : label, "aria-pressed": "false" },
        text: glyph,
        on: {
          // Keep the editor's selection: run the command without moving focus.
          pointerdown: (e) => e.preventDefault(),
          click: () => this._editor.exec(command),
        },
      });
      this._toolButtons.set(command, button);
      return button;
    };

    this._blockSelect = createElement("select", {
      className: "notes__block-select",
      attrs: { "aria-label": "Text style" },
      children: [
        ["p", "Paragraph"],
        ["h1", "Heading 1"],
        ["h2", "Heading 2"],
        ["h3", "Heading 3"],
      ].map(([value, label]) => createElement("option", { attrs: { value }, text: label })),
      on: { change: () => this._editor.exec(this._blockSelect.value) },
    });

    const historyButton = (command, label, glyph, shortcutId) =>
      createElement("button", {
        className: "notes__tool",
        attrs: { type: "button", "aria-label": label, title: `${label} (${formatShortcut(shortcutId)})` },
        text: glyph,
        on: { pointerdown: (e) => e.preventDefault(), click: () => this._editor.exec(command) },
      });

    const group = (children) => createElement("div", { className: "notes__tool-group", children });
    this._formatGroup = createElement("div", {
      className: "notes__tool-sections",
      children: [group([this._blockSelect]), group(FORMAT_BUTTONS.map(makeButton)), group(LIST_BUTTONS.map(makeButton))],
    });

    return createElement("div", {
      className: "notes__toolbar",
      attrs: { role: "toolbar", "aria-label": "Formatting" },
      children: [
        group([historyButton("undo", "Undo", "\u21b6", "notes.undo"), historyButton("redo", "Redo", "\u21b7", "notes.redo")]),
        this._formatGroup,
      ],
    });
  }

  // ---------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------

  /** @returns {void} */
  _wireEvents() {
    const on = (name, handler) => this._cleanups.push(eventBus.on(name, handler));
    on("filesystem:fileCreated", ({ entry }) => this._handleExternalCreate(entry));
    on("filesystem:fileCopied", ({ entry }) => this._handleExternalCreate(entry));
    on("filesystem:fileRenamed", ({ entry }) => this._handleExternalRename(entry));
    on("filesystem:fileMoved", ({ entry }) => this._handleExternalMove(entry));
    on("filesystem:fileDeleted", ({ entry }) => this._handleExternalDelete(entry));
    on("filesystem:fileModified", ({ entry }) => this._handleExternalModify(entry));
  }

  /**
   * @param {object} entry
   * @returns {void}
   */
  _handleExternalCreate(entry) {
    if (!this._library.isLibraryEntry(entry) || this._entries.some((e) => e.id === entry.id)) return;
    this._entries = [entry, ...this._entries];
    this._library.indexAll([entry]).then(() => this._renderList());
    this._renderList();
  }

  /**
   * @param {object} entry
   * @returns {void}
   */
  _handleExternalRename(entry) {
    this._replaceEntry(entry);
    if (this._doc?.entry.id === entry.id) {
      this._doc.entry = entry;
      this._renderDocumentChrome();
    }
    this._renderList();
  }

  /**
   * @param {object} entry
   * @returns {void}
   */
  _handleExternalMove(entry) {
    const wasListed = this._entries.some((e) => e.id === entry.id);
    const belongs = this._library.isLibraryEntry(entry);
    if (wasListed && !belongs) {
      this._entries = this._entries.filter((e) => e.id !== entry.id);
      if (this._doc?.entry.id === entry.id && isNoteFile(entry.name)) this._external.set(entry.id, entry);
    } else if (!wasListed && belongs) {
      this._entries = [entry, ...this._entries];
      this._external.delete(entry.id);
    } else {
      this._replaceEntry(entry);
    }
    if (this._doc?.entry.id === entry.id) {
      this._doc.entry = entry;
      this._renderDocumentChrome();
    }
    this._renderList();
  }

  /**
   * @param {object} entry
   * @returns {void}
   */
  _handleExternalDelete(entry) {
    this._entries = this._entries.filter((e) => e.id !== entry.id);
    this._external.delete(entry.id);
    this._library.forget(entry.id);
    if (this._doc?.entry.id === entry.id) {
      this._doc.deleted = true;
      window.clearTimeout(this._timers.save);
      this._editor.setEditable(false);
      this._showBanner("This note was moved to Trash. Its content is still shown here.", [
        { label: "Save as new note", action: () => this._rescueDeletedDocument() },
        { label: "Close", action: () => this._closeDocument() },
      ]);
      this._renderDocumentChrome();
    }
    this._renderList();
  }

  /**
   * @param {object} entry
   * @returns {Promise<void>}
   */
  async _handleExternalModify(entry) {
    this._replaceEntry(entry);
    if (this._doc?.entry.id !== entry.id) {
      // Keep the search index current for edits made elsewhere.
      if (this._entries.some((e) => e.id === entry.id)) this._library.forget(entry.id);
      this._library.indexAll(this._entries).then(() => this._renderList());
      return;
    }
    this._doc.entry = entry;
    if (this._saving || this._dirty) {
      this._renderDocumentChrome();
      return;
    }
    try {
      const { content } = await this._library.read(entry.path);
      if (content !== this._doc.lastSaved && !this._dirty) {
        this._editor.setDocument(this._doc.kind, content);
        this._doc.lastSaved = this._editor.getContent();
        this._updateCounts();
        this._setStatus("Updated from disk");
      }
    } catch (error) {
      console.warn("[Notes] could not reload a changed note:", error);
    }
    this._renderDocumentChrome();
    this._renderList();
  }

  /**
   * @param {object} entry
   * @returns {void}
   */
  _replaceEntry(entry) {
    this._entries = this._entries.map((existing) => (existing.id === entry.id ? entry : existing));
    if (this._external.has(entry.id)) this._external.set(entry.id, entry);
  }

  // ---------------------------------------------------------------
  // Opening and closing documents
  // ---------------------------------------------------------------

  /**
   * @param {string} path
   * @returns {Promise<void>}
   */
  async _openPath(path) {
    if (this._doc && this._doc.entry.path === path && !this._doc.deleted) {
      this._editor.focus();
      return;
    }
    await this._flush();

    let loaded;
    try {
      loaded = await this._library.read(path);
    } catch (error) {
      await showMessageDialog({ title: "Couldn't open note", message: `"${path}" could not be opened.`, detail: error.message });
      return;
    }

    const { entry, kind, content, recovered } = loaded;
    if (!this._library.isLibraryEntry(entry)) this._external.set(entry.id, entry);

    this._doc = { entry, kind, lastSaved: "", deleted: false };
    this._editor.setDocument(kind, content);
    this._editor.setEditable(!entry.readOnly);
    this._doc.lastSaved = this._editor.getContent();
    this._dirty = false;
    this._saveError = null;
    this._hideBanner();
    this._setStatus(entry.readOnly ? "Read-only" : "Saved");
    this._renderDocumentChrome();
    this._renderToolbarState();
    this._updateCounts();
    this._renderList();
    this._setSidebarOpen(false);

    if (recovered) {
      this._showBanner("This file wasn't a valid note document, so its text was loaded as plain paragraphs.", []);
    }
    this._offerDraftRecovery(entry, kind);
  }

  /**
   * If a newer unsaved draft exists for this document, offer to restore it.
   * @param {object} entry
   * @param {"rich"|"plain"} kind
   * @returns {void}
   */
  _offerDraftRecovery(entry, kind) {
    const draft = this._library.getDraft(entry.id);
    if (!draft) return;
    if (draft.kind !== kind || draft.content === this._doc.lastSaved || draft.savedAt < entry.modifiedAt) {
      this._library.clearDraft(entry.id);
      return;
    }
    this._showBanner(`This note has unsaved changes from ${formatDate(draft.savedAt)}.`, [
      {
        label: "Restore",
        primary: true,
        action: () => {
          this._editor.setDocument(kind, draft.content);
          this._hideBanner();
          this._handleEditorInput();
        },
      },
      {
        label: "Discard",
        action: () => {
          this._library.clearDraft(entry.id);
          this._hideBanner();
        },
      },
    ]);
  }

  /** @returns {void} */
  _closeDocument() {
    if (this._doc) this._external.delete(this._doc.entry.id);
    this._doc = null;
    this._dirty = false;
    this._hideBanner();
    this._renderDocumentChrome();
    this._renderList();
  }

  // ---------------------------------------------------------------
  // Editing and saving
  // ---------------------------------------------------------------

  /** @returns {void} */
  _handleEditorInput() {
    if (!this._doc || this._doc.deleted) return;
    this._dirty = true;
    this._saveError = null;
    this._setStatus("Unsaved changes");

    window.clearTimeout(this._timers.save);
    this._timers.save = window.setTimeout(() => this._flush(), AUTOSAVE_DELAY_MS);

    window.clearTimeout(this._timers.draft);
    this._timers.draft = window.setTimeout(() => {
      if (this._doc && this._dirty) this._library.saveDraft(this._doc.entry.id, this._doc.kind, this._editor.getContent());
    }, DRAFT_DELAY_MS);

    window.clearTimeout(this._timers.count);
    this._timers.count = window.setTimeout(() => this._updateCounts(), COUNT_DELAY_MS);
  }

  /**
   * Save pending changes now. Resolves once the save settles.
   * @returns {Promise<void>}
   */
  async _flush() {
    window.clearTimeout(this._timers.save);
    if (this._saving) await this._saving;
    if (!this._doc || !this._dirty || this._doc.deleted) return;

    const doc = this._doc;
    const content = this._editor.getContent();
    this._setStatus("Saving\u2026");
    this._saving = (async () => {
      try {
        const entry = await this._library.save(doc.entry.path, doc.kind, content);
        doc.entry = entry;
        doc.lastSaved = content;
        this._replaceEntry(entry);
        // Still dirty if the user kept typing while this save ran.
        if (this._doc === doc && this._editor.getContent() === content) {
          this._dirty = false;
          this._library.clearDraft(entry.id);
          window.clearTimeout(this._timers.draft);
        }
        this._saveError = null;
        this._saveFailureNotified = false;
        if (!this._closed) {
          this._setStatus(this._dirty ? "Unsaved changes" : "Saved");
          this._renderDocumentChrome();
          this._renderList();
        }
      } catch (error) {
        this._saveError = error.message;
        this._library.saveDraft(doc.entry.id, doc.kind, content);
        if (!this._closed) this._setStatus(`Couldn't save: ${error.message}`, true);
        this._notifySaveFailure(doc, error);
      }
    })();
    try {
      await this._saving;
    } finally {
      this._saving = null;
    }
  }

  /**
   * Tell the user once per failure streak (not on every retry) that a
   * document couldn't be saved. Clicking the notification opens it.
   * @param {object} doc
   * @param {Error} error
   * @returns {void}
   */
  _notifySaveFailure(doc, error) {
    if (this._saveFailureNotified) return;
    this._saveFailureNotified = true;
    const name = isNoteFile(doc.entry.name) ? titleOf(doc.entry.name) : doc.entry.name;
    notificationService.error(`Couldn't save \u201c${name}\u201d`, {
      title: `Couldn't save \u201c${name}\u201d`,
      message: `${error.message}. Your changes are kept as a draft; Notes tries again when you keep editing or select Retry.`,
      source: "notes",
      groupKey: `notes-save:${doc.entry.id}`,
      action: { type: "open", path: doc.entry.path },
    });
  }

  /**
   * Task Manager asks before ending Notes while a document can't be saved.
   * @returns {string|null}
   */
  getCloseWarning() {
    if (!this._doc || !this._saveError || !this._dirty) return null;
    const name = isNoteFile(this._doc.entry.name) ? titleOf(this._doc.entry.name) : this._doc.entry.name;
    return `\u201c${name}\u201d has changes that couldn't be saved. They are kept as a draft and offered the next time it opens.`;
  }

  /** @returns {void} */
  _updateCounts() {
    if (!this._doc) return;
    const { words, characters } = countText(this._editor.getPlainText());
    this._countsEl.textContent = `${words.toLocaleString()} word${words === 1 ? "" : "s"} \u00b7 ${characters.toLocaleString()} character${characters === 1 ? "" : "s"}`;
  }

  /**
   * @param {string} message
   * @param {boolean} [isError]
   * @returns {void}
   */
  _setStatus(message, isError = false) {
    this._statusEl.textContent = message;
    this._statusEl.classList.toggle("notes__status--error", isError);
    this._retryButton.hidden = !isError;
  }

  // ---------------------------------------------------------------
  // Commands
  // ---------------------------------------------------------------

  /** @returns {Promise<void>} */
  async _createNote() {
    await this._flush();
    let entry;
    try {
      entry = await this._library.create();
    } catch (error) {
      await showMessageDialog({ title: "Couldn't create note", message: "A new note could not be created.", detail: error.message });
      return;
    }
    if (!this._entries.some((e) => e.id === entry.id)) this._entries = [entry, ...this._entries];
    await this._openPath(entry.path);
    this._titleInput.focus();
    this._titleInput.select();
  }

  /**
   * @param {string} title
   * @returns {Promise<void>}
   */
  async _renameCurrent(title) {
    if (!this._doc || this._doc.deleted) return;
    const trimmed = title.trim();
    const current = titleOf(this._doc.entry.name);
    if (!trimmed || trimmed === current) {
      this._titleInput.value = current;
      return;
    }
    await this._renamePath(this._doc.entry.path, trimmed);
  }

  /**
   * @param {string} path
   * @param {string} title
   * @returns {Promise<boolean>}
   */
  async _renamePath(path, title) {
    try {
      await this._library.rename(path, title);
      return true;
    } catch (error) {
      await showMessageDialog({ title: "Couldn't rename note", message: `"${title}" can't be used as a note name.`, detail: error.message });
      if (this._doc) this._titleInput.value = titleOf(this._doc.entry.name);
      return false;
    }
  }

  /**
   * @param {object} [entry]
   * @returns {Promise<void>}
   */
  async _promptRename(entry = this._doc?.entry) {
    if (!entry) return;
    const current = titleOf(entry.name);
    const title = await showPromptDialog({
      title: "Rename note",
      label: "Name",
      initialValue: current,
      confirmLabel: "Rename",
    });
    if (title && title !== current) await this._renamePath(entry.path, title);
  }

  /**
   * @param {object} [entry]
   * @returns {Promise<void>}
   */
  async _deleteCurrent(entry = this._doc?.entry) {
    if (!entry) return;
    const confirmed = await showConfirmDialog({
      title: "Delete note?",
      message: `"${titleOf(entry.name)}" will be moved to Trash.`,
      confirmLabel: "Move to Trash",
      destructive: true,
    });
    if (!confirmed) return;
    const wasCurrent = this._doc?.entry.id === entry.id;
    if (wasCurrent) {
      window.clearTimeout(this._timers.save);
      this._dirty = false;
    }
    try {
      await this._library.remove(entry.path);
    } catch (error) {
      await showMessageDialog({ title: "Couldn't delete note", message: `"${titleOf(entry.name)}" could not be moved to Trash.`, detail: error.message });
      return;
    }
    if (wasCurrent) {
      this._closeDocument();
      const next = this._entries[0];
      if (next) await this._openPath(next.path);
    }
  }

  /**
   * @param {object} entry
   * @returns {Promise<void>}
   */
  async _duplicate(entry) {
    try {
      const copy = await this._library.duplicate(entry.path);
      await this._openPath(copy.path);
    } catch (error) {
      await showMessageDialog({ title: "Couldn't duplicate note", message: `"${titleOf(entry.name)}" could not be duplicated.`, detail: error.message });
    }
  }

  /** @returns {Promise<void>} */
  async _rescueDeletedDocument() {
    if (!this._doc) return;
    const { kind } = this._doc;
    const content = this._editor.getContent();
    try {
      const entry = await this._library.create(`${titleOf(this._doc.entry.name)} (recovered)`);
      const html = kind === "rich" ? content : plainTextToHtml(content);
      await vfs.write(entry.path, serializeNoteDocument(html));
      this._doc = null;
      await this._openPath(entry.path);
    } catch (error) {
      await showMessageDialog({ title: "Couldn't save note", message: "The content could not be saved as a new note.", detail: error.message });
    }
  }

  /**
   * @param {string|null} currentHref
   * @returns {Promise<string|null>}
   */
  async _promptForLink(currentHref) {
    const value = await showPromptDialog({
      title: currentHref ? "Edit link" : "Insert link",
      label: currentHref ? "Web address (clear it to remove the link)" : "Web address",
      initialValue: currentHref ?? "https://",
      confirmLabel: currentHref ? "Update" : "Insert",
      allowEmpty: Boolean(currentHref),
      validate: (input) => (normalizeUrl(input) ? null : "Enter a web address starting with http://, https://, or mailto:"),
    });
    if (value === null) return null;
    return normalizeUrl(value) ?? "";
  }

  /**
   * @param {object} entry
   * @returns {void}
   */
  _showInExplorer(entry) {
    const folder = entry.path.slice(0, entry.path.lastIndexOf("/")) || "/";
    this.appManager?.launch("file-explorer", { path: folder });
  }

  // ---------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------

  /** @returns {void} */
  _renderDocumentChrome() {
    const doc = this._doc;
    this._docEl.hidden = !doc;
    this._emptyEl.hidden = Boolean(doc);
    if (!doc) {
      this.appManager?.updateWindowTitle(this.windowId, "Notes");
      return;
    }
    const title = titleOf(doc.entry.name);
    if (document.activeElement !== this._titleInput) this._titleInput.value = title;
    this._titleInput.disabled = doc.deleted || Boolean(doc.entry.readOnly);
    const inLibrary = this._library.isLibraryEntry(doc.entry);
    this._metaEl.textContent = `${doc.deleted ? "In Trash" : `Edited ${formatDate(doc.entry.modifiedAt)}`}${inLibrary ? "" : ` \u00b7 ${doc.entry.path}`}`;
    this._kindEl.textContent = doc.kind === "rich" ? "Note" : `Plain text (.${doc.entry.extension})`;
    this._formatGroup.hidden = doc.kind !== "rich";
    this._editor.setPlaceholder(doc.kind === "rich" ? "Start writing\u2026" : "Start typing\u2026");
    if (this.windowId) this.appManager?.updateWindowTitle(this.windowId, `${title} \u2014 Notes`);
  }

  /** @returns {void} */
  _renderToolbarState() {
    const state = this._editor.queryState();
    for (const [command, button] of this._toolButtons) {
      const pressed =
        command === "ul" || command === "ol" || command === "checklist" ? state.list === command : command === "link" ? state.link : Boolean(state[command]);
      button.setAttribute("aria-pressed", String(pressed));
    }
    if (document.activeElement !== this._blockSelect) this._blockSelect.value = state.block;
  }

  /** @returns {void} */
  _scheduleSearch() {
    window.clearTimeout(this._timers.search);
    this._timers.search = window.setTimeout(() => {
      this._query = this._searchInput.value;
      this._renderList();
    }, SEARCH_DELAY_MS);
  }

  /** @returns {void} */
  _renderList() {
    if (this._closed) return;
    const focusedId = document.activeElement?.dataset?.noteId ?? null;
    clearElement(this._listEl);

    const searching = this._query.trim() !== "";
    const libraryResults = this._library.search(this._query, this._entries);
    const externalResults = this._library.search(this._query, [...this._external.values()]);

    if (externalResults.length > 0) {
      this._listEl.append(createElement("h3", { className: "notes__list-heading", text: "Opened files" }));
      for (const result of externalResults) this._listEl.append(this._listItem(result, true));
    }
    if (externalResults.length > 0 || searching) {
      this._listEl.append(createElement("h3", { className: "notes__list-heading", text: searching ? "Matching notes" : "Notes" }));
    }
    for (const result of libraryResults) this._listEl.append(this._listItem(result, false));

    if (libraryResults.length === 0) {
      this._listEl.append(
        createElement("p", {
          className: "notes__list-empty",
          attrs: { role: "status" },
          text: searching ? `No notes match \u201c${this._query.trim()}\u201d` : "No notes yet. Create one to get started.",
        })
      );
    }
    if (focusedId) this._listEl.querySelector(`[data-note-id="${CSS.escape(focusedId)}"]`)?.focus();
  }

  /**
   * @param {{entry: object, snippet: string|null}} result
   * @param {boolean} external
   * @returns {HTMLElement}
   */
  _listItem({ entry, snippet }, external) {
    const active = this._doc?.entry.id === entry.id;
    const preview = snippet ?? firstLine(this._library.getIndexedText(entry.id));
    const children = [
      createElement("span", { className: "notes__item-title", children: highlight(titleOf(entry.name), this._query) }),
      createElement("span", { className: "notes__item-preview", children: highlight(preview || "No content", this._query) }),
      createElement("span", { className: "notes__item-date", text: external ? entry.path : formatDate(entry.modifiedAt) }),
    ];
    const item = createElement("button", {
      className: `notes__item${active ? " notes__item--active" : ""}`,
      attrs: { type: "button", role: "listitem", "data-note-id": entry.id, "aria-current": active ? "true" : "false" },
      children,
      on: {
        click: () => this._openPath(entry.path),
        contextmenu: (e) => {
          e.preventDefault();
          this._showItemMenu(entry, external, e.clientX, e.clientY);
        },
      },
    });
    return item;
  }

  /**
   * @param {object} entry
   * @param {boolean} external
   * @param {number} x
   * @param {number} y
   * @returns {void}
   */
  _showItemMenu(entry, external, x, y) {
    const items = [
      { label: "Open", action: () => this._openPath(entry.path) },
      { label: "Rename\u2026", action: () => this._promptRename(entry) },
      { label: "Duplicate", action: () => this._duplicate(entry) },
      { label: "Show in File Explorer", action: () => this._showInExplorer(entry) },
    ];
    if (external) {
      items.push({ label: "Remove from list", action: () => this._removeExternal(entry) });
    }
    items.push({ separator: true }, { label: "Delete", action: () => this._deleteCurrent(entry) });
    this._contextMenu.show(items, { x, y }, { onClose: () => {} });
  }

  /**
   * @param {object} entry
   * @returns {Promise<void>}
   */
  async _removeExternal(entry) {
    if (this._doc?.entry.id === entry.id) {
      await this._flush();
      this._closeDocument();
    }
    this._external.delete(entry.id);
    this._renderList();
  }

  /**
   * @param {string} message
   * @returns {void}
   */
  _showListError(message) {
    clearElement(this._listEl);
    this._listEl.append(createElement("p", { className: "notes__list-empty notes__list-empty--error", attrs: { role: "alert" }, text: message }));
  }

  /**
   * @param {string} message
   * @param {Array<{label: string, action: () => void, primary?: boolean}>} actions
   * @returns {void}
   */
  _showBanner(message, actions) {
    clearElement(this._bannerEl);
    this._bannerEl.append(
      createElement("span", { className: "notes__banner-text", text: message }),
      ...actions.map((action) =>
        createElement("button", {
          className: `notes__button${action.primary ? " notes__button--primary" : ""}`,
          attrs: { type: "button" },
          text: action.label,
          on: { click: () => action.action() },
        })
      )
    );
    this._bannerEl.hidden = false;
  }

  /** @returns {void} */
  _hideBanner() {
    this._bannerEl.hidden = true;
    clearElement(this._bannerEl);
  }

  /** @returns {void} */
  _toggleSidebar() {
    this._setSidebarOpen(!this._root.classList.contains("notes--sidebar-open"));
  }

  /**
   * @param {boolean} open
   * @returns {void}
   */
  _setSidebarOpen(open) {
    this._root.classList.toggle("notes--sidebar-open", open);
    this._sidebarToggle.setAttribute("aria-expanded", String(open));
    this._sidebarToggle.setAttribute("aria-label", open ? "Hide notes list" : "Show notes list");
  }

  // ---------------------------------------------------------------
  // Keyboard
  // ---------------------------------------------------------------

  /**
   * @param {KeyboardEvent} e
   * @returns {void}
   */
  _handleKeydown(e) {
    const match = (id) => keyboardShortcuts.matches(e, id);
    const inEditor = this._editor.getElement().contains(e.target);

    if (match("notes.save")) {
      e.preventDefault();
      this._flush();
    } else if (match("notes.search")) {
      e.preventDefault();
      this._setSidebarOpen(true);
      this._searchInput.focus();
      this._searchInput.select();
    } else if (match("notes.newNote")) {
      e.preventDefault();
      this._createNote();
    } else if (inEditor && this._doc?.kind === "rich") {
      const commands = {
        "notes.bold": "bold",
        "notes.italic": "italic",
        "notes.underline": "underline",
        "notes.strike": "strike",
        "notes.link": "link",
        "notes.bulletList": "ul",
        "notes.numberedList": "ol",
        "notes.checklist": "checklist",
        "notes.heading1": "h1",
        "notes.heading2": "h2",
        "notes.heading3": "h3",
        "notes.paragraph": "p",
      };
      for (const [shortcutId, command] of Object.entries(commands)) {
        if (match(shortcutId)) {
          e.preventDefault();
          this._editor.exec(command);
          return;
        }
      }
    }
  }

  /**
   * Arrow keys move between list items.
   * @param {KeyboardEvent} e
   * @returns {void}
   */
  _handleListKeydown(e) {
    if ((e.key !== "ArrowDown" && e.key !== "ArrowUp") || hasModifierKey(e)) return;
    const items = [...this._listEl.querySelectorAll(".notes__item")];
    const index = items.indexOf(document.activeElement);
    if (index === -1) return;
    e.preventDefault();
    const next = items[Math.max(0, Math.min(items.length - 1, index + (e.key === "ArrowDown" ? 1 : -1)))];
    next.focus();
  }
}

/**
 * @param {string} shortcutId
 * @returns {string}
 */
function formatShortcut(shortcutId) {
  const shortcut = keyboardShortcuts.getGroupedShortcuts().flatMap((group) => group.shortcuts).find((s) => s.id === shortcutId);
  return shortcut?.keys[0] ?? "";
}

/**
 * @param {string} value
 * @returns {string|null} A safe link URL, or null when invalid.
 */
function normalizeUrl(value) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^(https?:\/\/|mailto:)\S+$/i.test(trimmed)) return trimmed;
  if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(trimmed)) return `https://${trimmed}`;
  return null;
}

/**
 * @param {string} text
 * @returns {string}
 */
function firstLine(text) {
  return text.split("\n").find((line) => line.trim())?.trim().slice(0, 120) ?? "";
}

/**
 * Build text nodes with query matches wrapped in <mark>, without innerHTML.
 * @param {string} text
 * @param {string} query
 * @returns {Node[]}
 */
function highlight(text, query) {
  const needle = query.trim().toLowerCase();
  if (!needle) return [document.createTextNode(text)];
  const nodes = [];
  const lower = text.toLowerCase();
  let index = 0;
  for (;;) {
    const found = lower.indexOf(needle, index);
    if (found === -1) break;
    if (found > index) nodes.push(document.createTextNode(text.slice(index, found)));
    nodes.push(createElement("mark", { className: "notes__match", text: text.slice(found, found + needle.length) }));
    index = found + needle.length;
  }
  if (index < text.length) nodes.push(document.createTextNode(text.slice(index)));
  return nodes;
}

export { NOTES_FOLDER };
