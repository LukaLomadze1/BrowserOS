/**
 * @file Code Studio — the integrated development environment.
 *
 * A window holds at most one project (a VFS folder) plus any loose
 * files opened from elsewhere. Layout, left to right: activity bar,
 * sidebar (project explorer or project search), the editor column
 * (tabs, editor, bottom panel with Problems / Output / Terminal), and
 * the live preview. Every panel can be hidden and resized; sizes are
 * remembered.
 *
 * Files: every open file is a document with its own CodeEditor (and so
 * its own undo history and scroll position). Edits stay in the editor
 * until saved; unsaved files are marked in the tabs, the explorer, and
 * the title bar, and closing a file, the project, or the window asks
 * first. Changes made elsewhere (File Explorer, Terminal, another Code
 * Studio window) are followed through filesystem events: renames and
 * moves re-point documents, edits reload clean documents and warn on
 * modified ones, deletions keep the text so it can be saved again.
 *
 * Code Studio is registered twice: "code-studio" (single instance; file
 * associations, Start Menu, and desktop shortcut open it) and
 * "code-studio-window" (additional windows, opened from File > New
 * Window). Opening a file routes to the window whose project contains
 * it.
 */

import { Application } from "../../core/application.js";
import { eventBus } from "../../core/eventBus.js";
import { vfs } from "../../core/vfs/virtualFileSystem.js";
import { openVfsEntry } from "../../core/vfs/vfsOpener.js";
import { storage } from "../../core/storage.js";
import { settingsService } from "../../core/settings/settingsService.js";
import { keyboardShortcuts } from "../../core/keyboard/keyboardShortcuts.js";
import { notificationService } from "../../core/notifications/notificationService.js";
import { fileAssociations } from "../../core/fileAssociations.js";
import { ContextMenu } from "../../components/context-menu/contextMenu.js";
import { openDialog } from "../../components/dialog/dialog.js";
import { showConfirmDialog } from "../../components/dialog/confirmDialog.js";
import { showPromptDialog } from "../../components/dialog/promptDialog.js";
import { showMessageDialog } from "../../components/dialog/messageDialog.js";
import { showFolderPickerDialog } from "../../components/dialog/folderPickerDialog.js";
import { showFormDialog } from "../../components/dialog/formDialog.js";
import { createElement } from "../../utils/dom.js";
import { createIconElement } from "../../utils/icons.js";
import { ensureStylesheet } from "../../utils/loadStylesheet.js";
import { TerminalManager } from "../terminal/terminalManager.js";
import "./languages/javascript.js";
import "./languages/css.js";
import "./languages/html.js";
import { languageForPath } from "./languages/registry.js";
import { CodeEditor, LARGE_DOCUMENT_LINES } from "./editor/codeEditor.js";
import { diagnose } from "./diagnostics/diagnostics.js";
import { PreviewSession } from "./preview/previewSession.js";
import { PreviewPane } from "./ui/previewPane.js";
import { FileTree } from "./ui/fileTree.js";
import { FindWidget } from "./ui/findWidget.js";
import { SearchPanel } from "./ui/searchPanel.js";
import { QuickOpen } from "./ui/quickOpen.js";
import { BottomPanel } from "./ui/bottomPanel.js";
import { PROJECT_TEMPLATES } from "./project/templates.js";
import {
  PROJECTS_FOLDER,
  readProjectTree,
  listProjectFiles,
  createProject,
  getRecentProjects,
  addRecentProject,
  removeRecentProject,
  renameRecentProject,
} from "./project/projectStore.js";
import { basename, dirname, extname, isInside, joinPath, relativeTo, validateName } from "./project/paths.js";

ensureStylesheet("src/apps/code-studio/codeStudio.css");

const LAYOUT_KEY = "codeStudio:layout";
const TREE_RELOAD_MS = 150;
const DIAGNOSE_DELAY_MS = 600;
const PREVIEW_DELAY_MS = 500;
const MAX_DIAGNOSED_FILES = 300;
const MAX_DIAGNOSED_BYTES = 512 * 1024;
const DIAGNOSED_LANGUAGES = new Set(["html", "css", "javascript", "json"]);
const DEFAULT_LAYOUT = Object.freeze({ sidebar: 260, panel: 220, preview: 460, showSidebar: true, showPanel: false, showPreview: true });

/** Every open Code Studio window (for routing files to the window that has their project). */
const INSTANCES = new Set();

/**
 * @typedef {object} Doc
 * @property {string} path
 * @property {object} language
 * @property {CodeEditor} editor
 * @property {string} savedText - Text as last loaded from or saved to the VFS.
 * @property {boolean} dirty
 * @property {boolean} readOnly
 * @property {boolean} missing - The file was deleted (or moved to Trash) while open.
 * @property {boolean} conflict - The file changed elsewhere while it had unsaved changes.
 * @property {HTMLElement} tab
 * @property {Array<object>} diagnostics
 * @property {number} diagnoseRun
 */

export default class CodeStudioApp extends Application {
  constructor(meta) {
    super(meta);
    /** @type {{root: string, tree: import("./project/projectStore.js").ProjectTree}|null} */
    this._project = null;
    /** @type {Map<string, Doc>} */
    this._docs = new Map();
    /** @type {string[]} */
    this._order = [];
    this._activePath = null;
    /** @type {string[]} Recently active files, most recent first (Quick Open). */
    this._recent = [];
    /** @type {Map<string, Array<object>>} Diagnostics of project files that aren't open. */
    this._fileDiagnostics = new Map();
    this._layout = { ...DEFAULT_LAYOUT, ...readLayout() };
    this._sidebarView = "explorer";
    this._cleanups = [];
    this._timers = new Map();
    this._menu = new ContextMenu();
    this._terminal = null;
    this._closed = false;
    this._beforeUnload = (e) => {
      if (this._dirtyDocs().length === 0) return;
      e.preventDefault();
      e.returnValue = "";
    };
  }

  // ---------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------

  /**
   * @param {{path?: string, newProject?: boolean}} [options]
   * @returns {ReturnType<Application["launch"]>}
   */
  launch(options = {}) {
    INSTANCES.add(this);
    this._settings = readEditorSettings();
    this._buildDom();
    this._wireEvents();
    this._applyTheme();
    this._applyLayout();
    this._renderAll();
    this._start(options);

    return {
      element: this._root,
      title: "Code Studio",
      icon: "icon:code",
      width: 1180,
      height: 760,
      minWidth: 640,
      minHeight: 420,
    };
  }

  /**
   * Another launch of the single-instance window: open what was asked for.
   * @param {{path?: string, newProject?: boolean}} [options]
   * @returns {void}
   */
  onRelaunch(options = {}) {
    if (options.newProject) {
      this._newProject();
      return;
    }
    if (options.path) this._openPathRouted(options.path);
  }

  /** @returns {void} */
  onFocus() {
    if (this._quickOpen?.isOpen()) return;
    const active = document.activeElement;
    if (active && this._root.contains(active) && active !== this._root) return;
    this._activeDoc()?.editor.focus();
  }

  /**
   * Ask before closing a window with unsaved changes.
   * @returns {Promise<boolean>}
   */
  async onBeforeClose() {
    const dirty = this._dirtyDocs();
    if (dirty.length === 0) return true;
    return this._confirmDiscard(dirty, "closing Code Studio");
  }

  /**
   * Task Manager warns before ending Code Studio with unsaved changes.
   * @returns {string|null}
   */
  getCloseWarning() {
    const dirty = this._dirtyDocs();
    if (dirty.length === 0) return null;
    const names = dirty.slice(0, 3).map((doc) => basename(doc.path)).join(", ");
    return `${dirty.length} file${dirty.length === 1 ? " has" : "s have"} unsaved changes (${names}${dirty.length > 3 ? ", \u2026" : ""}).`;
  }

  /** @returns {void} */
  close() {
    this._closed = true;
    INSTANCES.delete(this);
    for (const timer of this._timers.values()) window.clearTimeout(timer);
    this._timers.clear();
    for (const cleanup of this._cleanups) {
      try {
        cleanup();
      } catch (error) {
        console.error("[CodeStudio] cleanup failed:", error);
      }
    }
    this._cleanups = [];
    window.removeEventListener("beforeunload", this._beforeUnload);
    for (const doc of this._docs.values()) doc.editor.destroy();
    this._docs.clear();
    this._menu.hide();
    this._find.destroy();
    this._search.destroy();
    this._previewPane.destroy();
    this._preview.dispose();
    this._terminal?.destroy();
  }

  /**
   * @param {{path?: string, newProject?: boolean}} options
   * @returns {Promise<void>}
   */
  async _start(options) {
    if (options.newProject) {
      this._newProject();
      return;
    }
    if (options.path) {
      await this._openPathRouted(options.path, { fromLaunch: true });
    }
  }

  // ---------------------------------------------------------------
  // DOM
  // ---------------------------------------------------------------

  /** @returns {void} */
  _buildDom() {
    const iconButton = (label, icon, onClick, extra = {}) =>
      createElement("button", {
        className: `cs-icon-button ${extra.className ?? ""}`,
        attrs: { type: "button", title: label, "aria-label": label, ...(extra.attrs ?? {}) },
        children: [createIconElement(icon)],
        on: { click: onClick },
      });

    // Menu bar
    const menus = [
      ["File", () => this._fileMenuItems()],
      ["Edit", () => this._editMenuItems()],
      ["View", () => this._viewMenuItems()],
      ["Run", () => this._runMenuItems()],
      ["Help", () => this._helpMenuItems()],
    ];
    this._menuButtons = menus.map(([label, items]) => {
      const button = createElement("button", {
        className: "cs-menubar__item",
        text: label,
        attrs: { type: "button", "aria-haspopup": "menu", "aria-expanded": "false" },
      });
      button.addEventListener("click", () => this._openMenu(button, items()));
      button.addEventListener("keydown", (e) => {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          this._openMenu(button, items());
        } else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
          e.preventDefault();
          const index = this._menuButtons.indexOf(button);
          const next = this._menuButtons[(index + (e.key === "ArrowRight" ? 1 : -1) + this._menuButtons.length) % this._menuButtons.length];
          next.focus();
        }
      });
      return button;
    });
    this._projectLabel = createElement("span", { className: "cs-menubar__project" });
    this._runButton = createElement("button", {
      className: "cs-run-button",
      attrs: { type: "button", title: "Run: preview the page (Ctrl + Enter)" },
      children: [createIconElement("icon:play"), createElement("span", { text: "Run" })],
      on: { click: () => this._run() },
    });
    this._previewToggle = iconButton("Toggle preview (Alt + P)", "icon:panel-right", () => this._togglePreview(), { attrs: { "aria-pressed": "false" } });
    this._panelToggle = iconButton("Toggle panel (Ctrl + J)", "icon:panel-bottom", () => this._togglePanel(), { attrs: { "aria-pressed": "false" } });
    const menubar = createElement("div", {
      className: "cs-menubar",
      children: [
        createElement("div", { className: "cs-menubar__menus", attrs: { role: "menubar", "aria-label": "Code Studio" }, children: this._menuButtons }),
        this._projectLabel,
        createElement("div", { className: "cs-menubar__actions", children: [this._panelToggle, this._previewToggle, this._runButton] }),
      ],
    });

    // Activity bar
    this._activityExplorer = iconButton("Explorer", "icon:files", () => this._onActivity("explorer"), { className: "cs-activity__item", attrs: { "aria-pressed": "true" } });
    this._activitySearch = iconButton("Search (Ctrl + Shift + F)", "icon:search", () => this._onActivity("search"), { className: "cs-activity__item", attrs: { "aria-pressed": "false" } });
    const activity = createElement("nav", {
      className: "cs-activity",
      attrs: { "aria-label": "Views" },
      children: [
        this._activityExplorer,
        this._activitySearch,
        createElement("span", { className: "cs-activity__spacer" }),
        iconButton("Code Studio settings", "icon:gear", () => this.appManager?.launch("settings", { page: "codeStudio" }).catch(() => {}), { className: "cs-activity__item" }),
      ],
    });

    // Sidebar: explorer
    this._tree = new FileTree({
      // A single click keeps focus in the tree (F2, Delete, arrows keep working); double-click or Enter moves to the editor.
      onOpen: (entry, { focus }) => this._openFile(entry.path, { focus }),
      onContextMenu: (entry, point) => this._showTreeMenu(entry, point),
      onRename: (entry) => this._renameEntry(entry),
      onDelete: (entry) => this._deleteEntry(entry),
      onMove: (source, folder) => this._moveEntry(source, folder),
    });
    this._explorerTitle = createElement("span", { className: "cs-sidebar__title", text: "Explorer" });
    this._explorerActions = createElement("div", {
      className: "cs-sidebar__actions",
      children: [
        iconButton("New file (Alt + N)", "icon:file-plus", () => this._newFile()),
        iconButton("New folder", "icon:folder-plus", () => this._newFolder()),
        iconButton("Refresh", "icon:reload", () => this._reloadTree()),
        iconButton("Collapse folders", "icon:collapse", () => this._tree.collapseAll()),
      ],
    });
    this._projectBanner = createElement("div", { className: "cs-banner", attrs: { role: "status" } });
    this._projectBanner.hidden = true;
    this._noProject = createElement("div", { className: "cs-sidebar__placeholder" });
    this._explorerView = createElement("div", {
      className: "cs-sidebar__view",
      children: [
        createElement("div", { className: "cs-sidebar__header", children: [this._explorerTitle, this._explorerActions] }),
        this._projectBanner,
        this._noProject,
        this._tree.getElement(),
      ],
    });

    // Sidebar: search
    this._search = new SearchPanel({
      getFiles: () => this._searchableFiles(),
      getRoot: () => this._rootPath(),
      readText: (path) => this._readCurrentText(path),
      isOpen: (path) => this._docs.has(path),
      openAt: (path, line, column, length) => this._openFile(path, { line, column, select: length }),
      applyReplacements: (changes) => this._applyProjectReplacements(changes),
    });
    this._searchView = createElement("div", {
      className: "cs-sidebar__view",
      children: [createElement("div", { className: "cs-sidebar__header", children: [createElement("span", { className: "cs-sidebar__title", text: "Search" })] }), this._search.getElement()],
    });
    this._searchView.hidden = true;
    this._sidebar = createElement("aside", { className: "cs-sidebar", attrs: { "aria-label": "Sidebar" }, children: [this._explorerView, this._searchView] });

    // Editor column
    this._tabs = createElement("div", { className: "cs-tabs", attrs: { role: "tablist", "aria-label": "Open files" } });
    this._tabs.addEventListener("wheel", (e) => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) this._tabs.scrollLeft += e.deltaY;
    }, { passive: true });
    this._find = new FindWidget({ onClose: () => {} });
    this._docBanner = createElement("div", { className: "cs-banner cs-banner--doc", attrs: { role: "alert" } });
    this._docBanner.hidden = true;
    this._welcome = createElement("div", { className: "cs-welcome" });
    this._editorHost = createElement("div", { className: "cs-editor-host", children: [this._find.getElement(), this._welcome] });
    this._editorColumn = createElement("div", {
      className: "cs-editor-column",
      attrs: { role: "tabpanel", "aria-label": "Editor" },
      children: [this._tabs, this._docBanner, this._editorHost],
    });
    this._bottom = new BottomPanel({
      openAt: (path, line, column) => this._openFile(path, { line, column }),
      getRoot: () => this._rootPath(),
      createTerminal: () => this._createTerminal(),
      onTerminalShown: () => this._terminal?.onFocus(),
      openTerminalApp: () => this.appManager?.launch("terminal", { path: this._terminal?.getCwd() ?? this._rootPath() }).catch(() => {}),
      onClose: () => this._togglePanel(false),
    });
    this._panelResizer = this._createResizer("panel", "horizontal");
    this._center = createElement("div", { className: "cs-center", children: [this._editorColumn, this._panelResizer, this._bottom.getElement()] });

    // Preview
    this._preview = new PreviewSession({
      getRoot: () => this._rootPath(),
      listPages: () => this._htmlPages(),
      readers: {
        readText: (path) => this._readCurrentText(path),
        readBlob: (path) => this._readBlob(path),
      },
      onConsole: (entry) => this._bottom.appendOutput(entry),
      onRuntimeError: (error) => {
        this._bottom.addRuntimeError(error);
        this._bottom.appendOutput({ level: "error", text: `Uncaught ${error.message}`, path: error.path, line: error.line, column: error.column, runtime: true });
        this._updateStatus();
      },
      onReload: () => {
        this._bottom.clearRuntimeErrors();
        this._bottom.appendSeparator(`Preview reloaded \u00b7 ${new Date().toLocaleTimeString()}`);
        this._updateStatus();
      },
    });
    this._previewPane = new PreviewPane({
      mode: "docked",
      getRoot: () => this._rootPath(),
      listPages: () => this._htmlPages(),
      getAutoPreview: () => this._settings.autoPreview,
      setAutoPreview: (value) => settingsService.set("codeStudio.autoPreview", value),
      onPopOut: () => this._popOutPreview(),
      onDock: () => this._dockPreview(),
      onClose: () => this._togglePreview(false),
      onRun: () => this._run(),
    });
    this._previewPane.setSession(this._preview);
    this._previewHost = createElement("div", { className: "cs-preview-host", children: [this._previewPane.getElement()] });

    this._sidebarResizer = this._createResizer("sidebar", "vertical");
    this._previewResizer = this._createResizer("preview", "vertical");
    this._body = createElement("div", {
      className: "cs-body",
      children: [activity, this._sidebar, this._sidebarResizer, this._center, this._previewResizer, this._previewHost],
    });

    // Status bar
    this._status = {
      problems: createElement("button", { className: "cs-status__item cs-status__button", attrs: { type: "button", title: "Show problems" }, on: { click: () => this._showPanelTab("problems") } }),
      message: createElement("span", { className: "cs-status__item cs-status__message", attrs: { role: "status", "aria-live": "polite" } }),
      cursor: createElement("button", { className: "cs-status__item cs-status__button", attrs: { type: "button", title: "Go to line (Ctrl + G)" }, on: { click: () => this._goToLine() } }),
      indent: createElement("button", { className: "cs-status__item cs-status__button", attrs: { type: "button", title: "Indentation" }, on: { click: (e) => this._showIndentMenu(e.currentTarget) } }),
      eol: createElement("span", { className: "cs-status__item", text: "LF" }),
      language: createElement("span", { className: "cs-status__item" }),
      wrap: createElement("button", { className: "cs-status__item cs-status__button", attrs: { type: "button", title: "Toggle word wrap (Alt + Z)" }, on: { click: () => this._toggleWordWrap() } }),
    };
    const statusBar = createElement("footer", {
      className: "cs-statusbar",
      children: [
        this._status.problems,
        this._status.message,
        createElement("span", { className: "cs-status__spacer" }),
        this._status.cursor,
        this._status.indent,
        this._status.eol,
        this._status.language,
        this._status.wrap,
      ],
    });

    this._quickOpen = new QuickOpen({
      getFiles: () => this._searchableFiles(),
      getRoot: () => this._rootPath(),
      getRecent: () => this._recent,
      onPick: (path, line) => this._openFile(path, line ? { line } : {}),
      onGoToLine: (line) => {
        const editor = this._activeDoc()?.editor;
        if (!editor) return;
        editor.goTo(line);
        editor.focus();
      },
    });

    this._root = createElement("div", {
      className: "code-studio",
      attrs: { tabindex: "-1" },
      children: [menubar, this._body, statusBar, this._quickOpen.getElement()],
    });
  }

  /**
   * @param {"sidebar"|"panel"|"preview"} which
   * @param {"vertical"|"horizontal"} orientation - vertical = a bar between columns.
   * @returns {HTMLElement}
   */
  _createResizer(which, orientation) {
    const handle = createElement("div", {
      className: `cs-resizer cs-resizer--${orientation}`,
      attrs: {
        role: "separator",
        tabindex: "0",
        "aria-orientation": orientation === "vertical" ? "vertical" : "horizontal",
        "aria-label": `Resize ${which === "panel" ? "panel" : which}`,
      },
    });
    const limits = { sidebar: [160, 600], panel: [90, 700], preview: [220, 1400] };
    const apply = (value) => {
      const [min, max] = limits[which];
      this._layout[which] = Math.round(Math.min(max, Math.max(min, value)));
      this._applyLayout();
    };
    handle.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      const start = orientation === "vertical" ? e.clientX : e.clientY;
      const initial = this._layout[which];
      this._root.classList.add("code-studio--resizing");
      const move = (event) => {
        const delta = (orientation === "vertical" ? event.clientX : event.clientY) - start;
        // Sidebar grows to the right; preview and panel grow toward the editor.
        apply(which === "sidebar" ? initial + delta : initial - delta);
      };
      const up = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        handle.removeEventListener("pointercancel", up);
        this._root.classList.remove("code-studio--resizing");
        saveLayout(this._layout);
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
      handle.addEventListener("pointercancel", up);
    });
    handle.addEventListener("keydown", (e) => {
      const step = e.shiftKey ? 40 : 12;
      const grow = which === "sidebar" ? 1 : -1;
      const keys = orientation === "vertical" ? ["ArrowLeft", "ArrowRight"] : ["ArrowUp", "ArrowDown"];
      if (e.key === keys[0]) apply(this._layout[which] - step * grow);
      else if (e.key === keys[1]) apply(this._layout[which] + step * grow);
      else return;
      e.preventDefault();
      saveLayout(this._layout);
    });
    return handle;
  }

  /** @returns {void} */
  _applyLayout() {
    const layout = this._layout;
    this._root.style.setProperty("--cs-sidebar-width", `${layout.sidebar}px`);
    this._root.style.setProperty("--cs-panel-height", `${layout.panel}px`);
    this._root.style.setProperty("--cs-preview-width", `${layout.preview}px`);
    this._sidebar.hidden = !layout.showSidebar;
    this._sidebarResizer.hidden = !layout.showSidebar;
    this._bottom.getElement().hidden = !layout.showPanel;
    this._panelResizer.hidden = !layout.showPanel;
    this._previewHost.hidden = !layout.showPreview || this._preview.getHost() === "window";
    this._previewResizer.hidden = this._previewHost.hidden;
    this._previewToggle.setAttribute("aria-pressed", String(!this._previewHost.hidden));
    this._panelToggle.setAttribute("aria-pressed", String(layout.showPanel));
    this._activityExplorer.setAttribute("aria-pressed", String(layout.showSidebar && this._sidebarView === "explorer"));
    this._activitySearch.setAttribute("aria-pressed", String(layout.showSidebar && this._sidebarView === "search"));
  }

  // ---------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------

  /** @returns {void} */
  _wireEvents() {
    this._root.addEventListener("keydown", (e) => this._onKeyDown(e));
    this._cleanups.push(settingsService.subscribeCategory("codeStudio", () => this._onSettingsChanged()));
    this._cleanups.push(
      this._preview.subscribe((event) => {
        if (event.type === "host") this._applyLayout();
      })
    );
    const themeObserver = new MutationObserver(() => this._applyTheme());
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    this._cleanups.push(() => themeObserver.disconnect());

    const on = (name, handler) => this._cleanups.push(eventBus.on(name, (payload) => {
      if (!this._closed) handler(payload ?? {});
    }));
    on("filesystem:fileCreated", ({ entry }) => this._onEntryCreated(entry));
    on("filesystem:folderCreated", ({ entry }) => this._onEntryCreated(entry));
    on("filesystem:fileModified", ({ entry }) => this._onFileModified(entry));
    on("filesystem:fileRenamed", ({ entry, oldPath }) => this._onEntryMoved(entry, oldPath));
    on("filesystem:fileMoved", ({ entry, oldPath }) => this._onEntryMoved(entry, oldPath));
    on("filesystem:fileDeleted", ({ entry, oldPath }) => this._onEntryDeleted(entry, oldPath));
  }

  /**
   * @param {KeyboardEvent} e
   * @returns {void}
   */
  _onKeyDown(e) {
    if (e.defaultPrevented) return;
    const shortcut = (id) => keyboardShortcuts.matches(e, id);
    const handle = (action) => {
      e.preventDefault();
      e.stopPropagation();
      action();
    };
    // While a terminal input has focus, its own keys (Ctrl + C, Ctrl + L, Tab…) win.
    const inTerminal = e.target instanceof Element && e.target.closest(".cs-panel__view--terminal");
    if (shortcut("codeStudio.saveAll")) return handle(() => this._saveAll());
    if (shortcut("codeStudio.saveAs")) return handle(() => this._saveAs());
    if (shortcut("codeStudio.save")) return handle(() => this._save());
    if (shortcut("codeStudio.quickOpen")) return handle(() => this._quickOpen.open());
    if (shortcut("codeStudio.findInProject")) return handle(() => this._showSidebar("search", { query: this._activeDoc()?.editor.getSelectedText() }));
    if (shortcut("codeStudio.run") && !inTerminal) return handle(() => this._run());
    if (shortcut("codeStudio.toggleTerminal")) return handle(() => this._toggleTerminal());
    if (shortcut("codeStudio.togglePanel")) return handle(() => this._togglePanel());
    if (shortcut("codeStudio.togglePreview")) return handle(() => this._togglePreview());
    if (shortcut("codeStudio.newFile")) return handle(() => this._newFile());
    if (shortcut("codeStudio.closeTab")) return handle(() => this._activePath && this._closeDoc(this._activePath));
    if (shortcut("codeStudio.nextTab")) return handle(() => this._cycleTab(1));
    if (shortcut("codeStudio.previousTab")) return handle(() => this._cycleTab(-1));
    if (shortcut("codeStudio.wordWrap")) return handle(() => this._toggleWordWrap());
    if (inTerminal) return;
    if (shortcut("codeStudio.toggleSidebar")) return handle(() => this._toggleSidebar());
    const doc = this._activeDoc();
    if (!doc) return;
    if (shortcut("codeStudio.find")) return handle(() => this._find.open(doc.editor));
    if (shortcut("codeStudio.replace")) return handle(() => this._find.open(doc.editor, { replace: true }));
    if (shortcut("codeStudio.goToLine")) return handle(() => this._goToLine());
    const inEditorArea = e.target instanceof Element && this._editorHost.contains(e.target);
    if (e.key === "Escape" && this._find.isOpen() && inEditorArea) {
      e.preventDefault();
      this._find.close();
      doc.editor.focus();
    }
  }

  /** @returns {void} */
  _onSettingsChanged() {
    const previous = this._settings;
    this._settings = readEditorSettings();
    for (const doc of this._docs.values()) doc.editor.applySettings(this._settings);
    this._applyTheme();
    this._previewPane.syncAutoPreview();
    if (this._settings.autoPreview && !previous.autoPreview) this._schedulePreview();
    this._updateStatus();
  }

  /** @returns {void} */
  _applyTheme() {
    const setting = this._settings.theme;
    const theme = setting === "system" ? (document.documentElement.dataset.theme === "light" ? "light" : "dark") : setting;
    this._root.classList.toggle("cs-theme-light", theme === "light");
    this._root.classList.toggle("cs-theme-dark", theme !== "light");
  }

  // ---------------------------------------------------------------
  // Projects
  // ---------------------------------------------------------------

  /** @returns {string} Root of the project, or "/" without one. */
  _rootPath() {
    if (this._project) return this._project.root;
    const doc = this._activeDoc();
    return doc ? dirname(doc.path) : "/";
  }

  /**
   * Open a path given to the app: a folder becomes the project, a file
   * opens in the window whose project contains it (this one otherwise).
   * @param {string} path
   * @param {{fromLaunch?: boolean}} [options]
   * @returns {Promise<void>}
   */
  async _openPathRouted(path, { fromLaunch = false } = {}) {
    let entry;
    try {
      entry = await vfs.getInfo(path);
    } catch (error) {
      await showMessageDialog({ title: "Couldn't open", message: `${path} doesn't exist.`, detail: error.message });
      return;
    }
    if (entry.type === "folder") {
      await this._openProject(entry.path);
      return;
    }
    const owner = [...INSTANCES].find((instance) => instance !== this && instance._project && isInside(entry.path, instance._project.root));
    if (owner && !(this._project && isInside(entry.path, this._project.root))) {
      owner._openFile(entry.path);
      if (owner.windowId) owner.appManager?.focusWindow(owner.windowId);
      if (fromLaunch && !this._project && this._docs.size === 0) this._setStatusMessage(`${basename(entry.path)} is open in another Code Studio window.`);
      return;
    }
    // Nothing open yet: open the file's project folder when there is one.
    if (!this._project) {
      const folder = dirname(entry.path);
      if (folder !== "/" && (isInside(folder, PROJECTS_FOLDER) || (await looksLikeProject(folder)))) {
        await this._openProject(projectRootFor(folder), { keepDocs: true });
      }
    }
    await this._openFile(entry.path);
  }

  /**
   * @param {string} root
   * @param {{keepDocs?: boolean, open?: string[]}} [options]
   * @returns {Promise<boolean>}
   */
  async _openProject(root, { keepDocs = true, open = [] } = {}) {
    let tree;
    try {
      tree = await readProjectTree(vfs, root);
    } catch (error) {
      removeRecentProject(root);
      await showMessageDialog({ title: "Couldn't open the project", message: `${root} can't be opened as a project.`, detail: error.message });
      return false;
    }
    if (this._project && this._project.root !== root && !keepDocs) {
      const closed = await this._closeAllDocs();
      if (!closed) return false;
    }
    this._project = { root, tree };
    this._fileDiagnostics.clear();
    addRecentProject(root);
    this._tree.setTree(tree);
    this._projectBanner.hidden = true;
    this._terminal?.setCwd(root);
    this._search.clear();
    this._preview.setEntry(null);
    this._renderAll();
    this._diagnoseProject();
    for (const path of open) await this._openFile(path, { focus: false });
    const firstHtml = open.find((path) => /\.html?$/i.test(path)) ?? this._defaultPage();
    if (firstHtml) {
      this._preview.setEntry(firstHtml);
      if (this._layout.showPreview) this._preview.rebuild();
    }
    this._activeDoc()?.editor.focus();
    return true;
  }

  /**
   * Choose a folder and open it as the project.
   * @returns {Promise<void>}
   */
  async _openProjectDialog() {
    const initial = (await vfs.exists(PROJECTS_FOLDER)) ? PROJECTS_FOLDER : "/";
    const folder = await showFolderPickerDialog({ vfs, title: "Open project folder", initialPath: this._project?.root ?? initial });
    if (!folder) return;
    if (folder === "/") {
      await showMessageDialog({ title: "Choose a project folder", message: "The root folder can't be a project. Choose or create a folder for the project." });
      return;
    }
    await this._switchProject(folder);
  }

  /**
   * Open another project in this window, after dealing with unsaved files.
   * @param {string} root
   * @returns {Promise<void>}
   */
  async _switchProject(root) {
    if (this._project?.root === root) return;
    if (!(await this._closeAllDocs())) return;
    await this._openProject(root, { keepDocs: false });
  }

  /** @returns {Promise<void>} */
  async _newProject() {
    const templateOptions = PROJECT_TEMPLATES.map((template) => ({ value: template.id, label: `${template.name} \u2014 ${template.description}` }));
    const values = await showFormDialog({
      title: "New project",
      confirmLabel: "Create",
      fields: [
        { id: "name", label: "Project name", type: "text", value: await uniqueProjectName(), placeholder: "My Website" },
        { id: "template", label: "Template", type: "select", value: "web", options: templateOptions },
        { id: "location", label: "Location", type: "text", value: PROJECTS_FOLDER },
      ],
      validate: async (input) => {
        const error = validateName(input.name ?? "");
        if (error) return error;
        const location = (input.location ?? "").trim() || PROJECTS_FOLDER;
        if (!location.startsWith("/")) return "The location must be a folder path such as /Projects.";
        if (location !== PROJECTS_FOLDER && !(await vfs.exists(location))) return `${location} doesn't exist.`;
        if (await vfs.exists(joinPath(location, input.name.trim()))) return `\u201c${input.name.trim()}\u201d already exists in ${location}.`;
        return null;
      },
    });
    if (!values) return;
    if (!(await this._closeAllDocs())) return;
    try {
      const { root, open } = await createProject(vfs, { name: values.name, templateId: values.template, parent: (values.location ?? "").trim() || PROJECTS_FOLDER });
      await this._openProject(root, { keepDocs: false, open });
      notificationService.success(`Created ${basename(root)}`, { title: "Project created", message: `${root}`, source: "code-studio", duration: 3000 });
    } catch (error) {
      await showMessageDialog({ title: "Couldn't create the project", message: "The project folder or its files couldn't be created.", detail: error.message });
    }
  }

  /** @returns {Promise<void>} */
  async _closeProject() {
    if (!this._project) return;
    if (!(await this._closeAllDocs())) return;
    this._project = null;
    this._fileDiagnostics.clear();
    this._tree.setTree(null);
    this._preview.setEntry(null);
    this._preview.rebuild();
    this._search.clear();
    this._renderAll();
  }

  /** @returns {Promise<void>} */
  async _reloadTree() {
    if (!this._project) return;
    const root = this._project.root;
    try {
      const tree = await readProjectTree(vfs, root);
      if (!this._project || this._project.root !== root) return;
      this._project.tree = tree;
      this._tree.setTree(tree);
      this._tree.setActive(this._activePath);
      this._tree.setDirty(new Set(this._dirtyDocs().map((doc) => doc.path)));
      this._previewPane.refreshPages();
      if (tree.truncated) this._setStatusMessage("Large project: only the first 20,000 items are listed.");
    } catch {
      /* the folder vanished; fileDeleted handling shows the banner */
    }
  }

  /** @returns {void} */
  _scheduleTreeReload() {
    this._debounce("tree", TREE_RELOAD_MS, () => {
      this._reloadTree();
      this._search.schedule();
    });
  }

  /** @returns {object[]} Text files of the project (or the open files without one). */
  _searchableFiles() {
    if (!this._project) return [...this._docs.values()].map((doc) => ({ path: doc.path, name: basename(doc.path), type: "file", size: 0 }));
    return listProjectFiles(this._project.tree).filter((entry) => !isBinaryEntry(entry));
  }

  /** @returns {string[]} HTML files of the project. */
  _htmlPages() {
    const files = this._project ? listProjectFiles(this._project.tree) : [...this._docs.values()].map((doc) => ({ path: doc.path }));
    return files.map((entry) => entry.path).filter((path) => /\.html?$/i.test(path));
  }

  /** @returns {string|null} index.html at the root, else the first HTML page. */
  _defaultPage() {
    const pages = this._htmlPages();
    if (!pages.length) return null;
    const root = this._rootPath();
    return pages.find((path) => path === joinPath(root, "index.html")) ?? pages.find((path) => basename(path) === "index.html") ?? pages[0];
  }

  // ---------------------------------------------------------------
  // Documents
  // ---------------------------------------------------------------

  /** @returns {Doc|null} */
  _activeDoc() {
    return this._activePath ? this._docs.get(this._activePath) ?? null : null;
  }

  /** @returns {Doc[]} */
  _dirtyDocs() {
    return [...this._docs.values()].filter((doc) => doc.dirty);
  }

  /**
   * Open a file (or switch to it) and optionally move to a position.
   * @param {string} path
   * @param {{line?: number, column?: number, select?: number, focus?: boolean}} [options]
   * @returns {Promise<Doc|null>}
   */
  async _openFile(path, { line, column = 1, select = 0, focus = true } = {}) {
    let doc = this._docs.get(path);
    if (!doc) {
      let entry;
      let text;
      try {
        entry = await vfs.getInfo(path);
        if (entry.type !== "file") return null;
        if (isBinaryEntry(entry)) {
          await this._openBinary(entry);
          return null;
        }
        text = await vfs.read(path);
      } catch (error) {
        if (error?.code === "BINARY_CONTENT" && entry) {
          await this._openBinary(entry);
          return null;
        }
        await showMessageDialog({ title: "Couldn't open the file", message: `${path} couldn't be read.`, detail: error.message });
        return null;
      }
      if (this._docs.has(path)) {
        doc = this._docs.get(path);
      } else {
        doc = this._createDoc(path, text, entry);
        this.recentFilesService?.add(entry);
      }
    }
    this._activate(path, { focus });
    if (line) doc.editor.goTo(line, column, { select });
    return doc;
  }

  /**
   * Images, media, and other binary files open in their own application.
   * @param {object} entry
   * @returns {Promise<void>}
   */
  async _openBinary(entry) {
    const handler = fileAssociations.getDefault(entry);
    if (handler && handler.appId !== "code-studio") {
      await openVfsEntry(entry, { appManager: this.appManager, recentFilesService: this.recentFilesService });
      return;
    }
    await showMessageDialog({ title: "Binary file", message: `${entry.name} isn't a text file, so it can't be edited in Code Studio.` });
  }

  /**
   * @param {string} path
   * @param {string} text
   * @param {object} entry
   * @returns {Doc}
   */
  _createDoc(path, text, entry) {
    const language = languageForPath(path);
    /** @type {Doc} */
    const doc = {
      path,
      language,
      editor: null,
      savedText: text.replace(/\r\n?/g, "\n"),
      originalText: text,
      dirty: false,
      readOnly: Boolean(entry.readOnly),
      missing: false,
      conflict: false,
      tab: null,
      diagnostics: [],
      diagnoseRun: 0,
    };
    doc.editor = new CodeEditor({
      language,
      text,
      settings: this._settings,
      label: `${basename(path)} \u2014 code editor`,
      onChange: () => this._onDocChanged(doc),
      onCursor: () => {
        if (this._activePath === doc.path) this._updateCursorStatus();
      },
    });
    doc.editor.getElement().hidden = true;
    doc.editor.getElement().addEventListener("contextmenu", (e) => this._showEditorMenu(e, doc));
    this._editorHost.append(doc.editor.getElement());
    doc.tab = this._createTab(doc);
    this._docs.set(path, doc);
    this._order.push(path);
    this._renderTabs();
    this._diagnoseDoc(doc);
    return doc;
  }

  /**
   * @param {Doc} doc
   * @returns {HTMLElement}
   */
  _createTab(doc) {
    const label = createElement("span", { className: "cs-tab__label" });
    const close = createElement("span", {
      className: "cs-tab__close",
      attrs: { role: "button", "aria-label": "Close", title: "Close (Alt + W)" },
      children: [createIconElement("icon:close")],
    });
    const tab = createElement("div", {
      className: "cs-tab",
      attrs: { role: "tab", "aria-selected": "false", tabindex: "-1" },
      children: [createElement("span", { className: "cs-tab__badge", attrs: { "aria-hidden": "true" } }), label, close],
    });
    tab.addEventListener("click", (e) => {
      if (e.target.closest(".cs-tab__close")) {
        e.stopPropagation();
        this._closeDoc(doc.path);
        return;
      }
      this._activate(doc.path);
    });
    tab.addEventListener("auxclick", (e) => {
      if (e.button === 1) {
        e.preventDefault();
        this._closeDoc(doc.path);
      }
    });
    tab.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        this._activate(doc.path);
      } else if (e.key === "Delete") {
        e.preventDefault();
        this._closeDoc(doc.path);
      } else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        e.preventDefault();
        const index = this._order.indexOf(doc.path);
        const next = this._order[(index + (e.key === "ArrowRight" ? 1 : -1) + this._order.length) % this._order.length];
        this._docs.get(next)?.tab.focus();
      }
    });
    tab.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this._menu.show(
        [
          { label: "Close", action: () => this._closeDoc(doc.path), shortcut: "Alt + W" },
          { label: "Close others", action: () => this._closeOthers(doc.path), disabled: this._order.length < 2 },
          { label: "Close all", action: () => this._closeAllDocs() },
          { separator: true },
          { label: "Copy path", action: () => copyText(doc.path) },
          { label: "Reveal in explorer", action: () => this._revealInTree(doc.path), disabled: !this._project || !isInside(doc.path, this._project.root) },
        ],
        { x: e.clientX, y: e.clientY }
      );
    });
    return tab;
  }

  /**
   * @param {string} path
   * @param {{focus?: boolean}} [options]
   * @returns {void}
   */
  _activate(path, { focus = true } = {}) {
    const doc = this._docs.get(path);
    if (!doc) return;
    const previous = this._activeDoc();
    if (previous && previous !== doc) previous.editor.getElement().hidden = true;
    this._activePath = path;
    doc.editor.getElement().hidden = false;
    this._recent = [path, ...this._recent.filter((p) => p !== path)].slice(0, 30);
    this._find.attach(doc.editor);
    this._renderTabs();
    this._renderDocBanner();
    this._tree.setActive(path);
    this._updateTitle();
    this._updateStatus();
    this._welcome.hidden = true;
    doc.tab.scrollIntoView({ block: "nearest", inline: "nearest" });
    if (focus) doc.editor.focus();
  }

  /**
   * @param {1|-1} direction
   * @returns {void}
   */
  _cycleTab(direction) {
    if (this._order.length < 2) return;
    const index = this._order.indexOf(this._activePath);
    this._activate(this._order[(index + direction + this._order.length) % this._order.length]);
  }

  /**
   * @param {Doc} doc
   * @returns {void}
   */
  _onDocChanged(doc) {
    const text = doc.editor.getValue();
    const dirty = text !== doc.savedText;
    if (dirty !== doc.dirty) {
      doc.dirty = dirty;
      this._renderTabs();
      this._tree.setDirty(new Set(this._dirtyDocs().map((d) => d.path)));
      this._updateTitle();
      this._syncBeforeUnload();
    }
    if (this._activePath === doc.path) this._find.refresh();
    this._debounce(`diagnose:${doc.path}`, DIAGNOSE_DELAY_MS, () => this._diagnoseDoc(doc));
    if (this._settings.autoPreview && this._preview.uses(doc.path)) this._schedulePreview();
  }

  /** @returns {void} */
  _syncBeforeUnload() {
    window.removeEventListener("beforeunload", this._beforeUnload);
    if (this._dirtyDocs().length) window.addEventListener("beforeunload", this._beforeUnload);
  }

  /**
   * @param {string} path
   * @param {{force?: boolean}} [options]
   * @returns {Promise<boolean>} Whether the file was closed.
   */
  async _closeDoc(path, { force = false } = {}) {
    const doc = this._docs.get(path);
    if (!doc) return true;
    if (doc.dirty && !force) {
      const choice = await this._askSave([doc], `closing ${basename(path)}`);
      if (choice === "cancel") return false;
      if (choice === "save" && !(await this._saveDoc(doc))) return false;
    }
    this._removeDoc(doc);
    return true;
  }

  /**
   * @param {Doc} doc
   * @returns {void}
   */
  _removeDoc(doc) {
    const index = this._order.indexOf(doc.path);
    this._order.splice(index, 1);
    this._docs.delete(doc.path);
    this._recent = this._recent.filter((p) => p !== doc.path);
    doc.editor.destroy();
    doc.tab.remove();
    if (this._activePath === doc.path) {
      this._activePath = null;
      const next = this._recent.find((p) => this._docs.has(p)) ?? this._order[Math.min(index, this._order.length - 1)];
      if (next) this._activate(next);
      else this._find.close();
    }
    this._tree.setDirty(new Set(this._dirtyDocs().map((d) => d.path)));
    this._syncBeforeUnload();
    this._collectProblems();
    this._renderAll();
  }

  /**
   * @param {string} keep
   * @returns {Promise<void>}
   */
  async _closeOthers(keep) {
    for (const path of [...this._order]) {
      if (path !== keep && !(await this._closeDoc(path))) return;
    }
  }

  /**
   * Close every open file, asking once about unsaved changes.
   * @returns {Promise<boolean>} False when cancelled.
   */
  async _closeAllDocs() {
    const dirty = this._dirtyDocs();
    if (dirty.length && !(await this._confirmDiscard(dirty, "closing these files"))) return false;
    for (const doc of [...this._docs.values()]) this._removeDoc(doc);
    return true;
  }

  /**
   * Ask about unsaved files; saves them when asked.
   * @param {Doc[]} dirty
   * @param {string} reason
   * @returns {Promise<boolean>} True to go ahead (saved or discarded), false to cancel.
   */
  async _confirmDiscard(dirty, reason) {
    const choice = await this._askSave(dirty, reason);
    if (choice === "cancel") return false;
    if (choice === "save") {
      for (const doc of dirty) {
        if (!(await this._saveDoc(doc))) return false;
      }
    }
    return true;
  }

  /**
   * @param {Doc[]} docs
   * @param {string} reason
   * @returns {Promise<"save"|"discard"|"cancel">}
   */
  async _askSave(docs, reason) {
    const names = docs.map((doc) => basename(doc.path));
    const body = createElement("div", {
      children: [
        createElement("p", {
          className: "dialog__message",
          text:
            docs.length === 1
              ? `\u201c${names[0]}\u201d has unsaved changes. Save them before ${reason}?`
              : `${docs.length} files have unsaved changes. Save them before ${reason}?`,
        }),
        docs.length > 1 ? createElement("ul", { className: "cs-dialog-list", children: names.slice(0, 8).map((name) => createElement("li", { text: name })) }) : createElement("span"),
      ],
    });
    const result = await openDialog({
      title: "Unsaved changes",
      role: "alertdialog",
      bodyElement: body,
      buttons: [
        { label: "Cancel", value: "cancel" },
        { label: "Don\u2019t save", value: "discard", variant: "danger" },
        { label: docs.length === 1 ? "Save" : "Save all", value: "save", variant: "primary", autofocus: true },
      ],
    });
    return result ?? "cancel";
  }

  // ---------------------------------------------------------------
  // Saving
  // ---------------------------------------------------------------

  /** @returns {Promise<void>} */
  async _save() {
    const doc = this._activeDoc();
    if (doc) await this._saveDoc(doc);
  }

  /** @returns {Promise<void>} */
  async _saveAll() {
    let saved = 0;
    for (const doc of this._dirtyDocs()) {
      if (await this._saveDoc(doc, { quiet: true })) saved += 1;
    }
    if (saved) this._setStatusMessage(`Saved ${saved} file${saved === 1 ? "" : "s"}`);
  }

  /**
   * @param {Doc} doc
   * @param {{quiet?: boolean}} [options]
   * @returns {Promise<boolean>}
   */
  async _saveDoc(doc, { quiet = false } = {}) {
    if (doc.readOnly) {
      const saveAs = await showConfirmDialog({ title: "Read-only file", message: `${basename(doc.path)} is read-only. Save a copy under another name?`, confirmLabel: "Save As\u2026" });
      return saveAs ? this._saveAs(doc) : false;
    }
    if (doc.conflict) {
      const overwrite = await showConfirmDialog({
        title: "File changed elsewhere",
        message: `${basename(doc.path)} was changed outside this editor after you started editing. Saving replaces those changes with yours.`,
        confirmLabel: "Save anyway",
        destructive: true,
      });
      if (!overwrite) return false;
    }
    const text = doc.editor.getValue();
    try {
      doc.saving = text;
      if (doc.missing || !(await vfs.exists(doc.path))) {
        const parent = dirname(doc.path);
        if (!(await vfs.exists(parent))) await createFolderTree(parent);
        await vfs.createFile(doc.path, text);
      } else {
        await vfs.write(doc.path, text);
      }
    } catch (error) {
      doc.saving = null;
      await showMessageDialog({ title: "Couldn't save", message: `${basename(doc.path)} couldn't be saved. Your changes are still in the editor.`, detail: error.message });
      return false;
    }
    doc.saving = null;
    doc.savedText = text;
    doc.missing = false;
    doc.conflict = false;
    this._onDocChanged(doc);
    this._renderDocBanner();
    this._renderTabs();
    if (!quiet) this._setStatusMessage(`Saved ${basename(doc.path)}`);
    // Without auto-preview, saving is what updates the preview.
    if (this._preview.isActive() && this._preview.uses(doc.path)) this._schedulePreview(0);
    return true;
  }

  /**
   * Save the active (or given) file under a new path.
   * @param {Doc} [doc]
   * @returns {Promise<boolean>}
   */
  async _saveAs(doc = this._activeDoc()) {
    if (!doc) return false;
    const target = await showPromptDialog({
      title: "Save As",
      label: "File path",
      initialValue: doc.path,
      confirmLabel: "Save",
      selection: [dirname(doc.path).length + (dirname(doc.path) === "/" ? 0 : 1), doc.path.length - (extname(doc.path) ? extname(doc.path).length + 1 : 0)],
      validate: async (value) => {
        const path = value.trim();
        if (!path.startsWith("/")) return "Enter a full path, for example /Projects/Site/page.html.";
        const name = basename(path);
        const error = validateName(name);
        if (error) return error;
        const parent = dirname(path);
        if (!(await vfs.exists(parent))) return `The folder ${parent} doesn't exist.`;
        if ((await vfs.getInfo(parent)).type !== "folder") return `${parent} isn't a folder.`;
        if (path !== doc.path && this._docs.has(path)) return `${name} is open in another tab; close it first.`;
        return null;
      },
    });
    if (!target) return false;
    const path = joinPath(target.trim());
    if (path === doc.path) return this._saveDoc(doc);
    const text = doc.editor.getValue();
    try {
      if (await vfs.exists(path)) {
        const info = await vfs.getInfo(path);
        if (info.type !== "file") throw new Error(`${path} is a folder`);
        const overwrite = await showConfirmDialog({ title: "Replace file?", message: `${basename(path)} already exists. Replace it?`, confirmLabel: "Replace", destructive: true });
        if (!overwrite) return false;
        await vfs.write(path, text);
      } else {
        await vfs.createFile(path, text);
      }
    } catch (error) {
      await showMessageDialog({ title: "Couldn't save", message: `The file couldn't be saved as ${path}.`, detail: error.message });
      return false;
    }
    // The tab now edits the new file; the original keeps its saved contents.
    this._rekeyDoc(doc, path);
    doc.savedText = text;
    doc.missing = false;
    doc.conflict = false;
    doc.readOnly = false;
    this._onDocChanged(doc);
    this._renderAll();
    this._setStatusMessage(`Saved as ${path}`);
    return true;
  }

  /**
   * Point a document at a new path (Save As, rename, move).
   * @param {Doc} doc
   * @param {string} newPath
   * @returns {void}
   */
  _rekeyDoc(doc, newPath) {
    const oldPath = doc.path;
    if (oldPath === newPath) return;
    this._docs.delete(oldPath);
    doc.path = newPath;
    this._docs.set(newPath, doc);
    this._order = this._order.map((p) => (p === oldPath ? newPath : p));
    this._recent = this._recent.map((p) => (p === oldPath ? newPath : p));
    if (this._activePath === oldPath) this._activePath = newPath;
    const language = languageForPath(newPath);
    if (language.id !== doc.language.id) {
      doc.language = language;
      doc.editor.setLanguage(language);
    }
    if (this._preview.getEntry() === oldPath) this._preview.setEntry(newPath);
    this._fileDiagnostics.delete(oldPath);
    this._diagnoseDoc(doc);
  }

  // ---------------------------------------------------------------
  // External changes
  // ---------------------------------------------------------------

  /**
   * @param {object} entry
   * @returns {void}
   */
  _onEntryCreated(entry) {
    if (!entry?.path) return;
    if (this._project && isInside(entry.path, this._project.root)) {
      this._scheduleTreeReload();
      if (this._preview.isActive() && this._preview.uses(entry.path)) this._schedulePreview();
    }
  }

  /**
   * @param {object} entry
   * @returns {Promise<void>}
   */
  async _onFileModified(entry) {
    if (!entry?.path) return;
    const doc = this._docs.get(entry.path);
    if (doc) {
      let text;
      try {
        text = (await vfs.read(entry.path)).replace(/\r\n?/g, "\n");
      } catch {
        return;
      }
      if (text === doc.saving || text === doc.savedText) {
        // Our own save, or nothing new.
      } else if (!doc.dirty) {
        doc.savedText = text;
        doc.editor.setValue(text, { keepHistory: true });
        this._setStatusMessage(`${basename(doc.path)} was changed elsewhere and reloaded`);
      } else if (doc.editor.getValue() === text) {
        doc.savedText = text;
        this._onDocChanged(doc);
      } else {
        doc.conflict = true;
        doc.externalText = text;
        this._renderDocBanner();
      }
    } else if (this._project && isInside(entry.path, this._project.root) && this._fileDiagnostics.has(entry.path)) {
      this._diagnosePath(entry.path);
    }
    // A file changed elsewhere: the preview shows the new contents (open files are handled by their editor).
    if (!doc && this._preview.isActive() && this._preview.uses(entry.path)) this._schedulePreview();
  }

  /**
   * A file or folder was renamed or moved.
   * @param {object} entry
   * @param {string} oldPath
   * @returns {void}
   */
  _onEntryMoved(entry, oldPath) {
    if (!entry?.path || !oldPath) return;
    const newPath = entry.path;
    // The project folder itself (or a folder above it) moved.
    if (this._project && isInside(this._project.root, oldPath)) {
      const newRoot = newPath + this._project.root.slice(oldPath.length);
      renameRecentProject(this._project.root, newRoot);
      this._project.root = newRoot;
      this._terminal?.setCwd(newRoot);
    }
    for (const doc of [...this._docs.values()]) {
      if (isInside(doc.path, oldPath)) this._rekeyDoc(doc, newPath + doc.path.slice(oldPath.length));
    }
    if (this._preview.getEntry() && isInside(this._preview.getEntry(), oldPath)) {
      this._preview.setEntry(newPath + this._preview.getEntry().slice(oldPath.length));
    }
    for (const path of [...this._fileDiagnostics.keys()]) if (isInside(path, oldPath)) this._fileDiagnostics.delete(path);
    if (this._project && (isInside(newPath, this._project.root) || isInside(oldPath, this._project.root))) this._scheduleTreeReload();
    this._renderAll();
  }

  /**
   * @param {object} entry
   * @param {string} oldPath
   * @returns {void}
   */
  _onEntryDeleted(entry, oldPath) {
    const path = oldPath ?? entry?.path;
    if (!path) return;
    if (this._project && isInside(this._project.root, path)) {
      this._projectBanner.hidden = false;
      this._projectBanner.textContent = `The project folder ${this._project.root} was moved to Trash. Open files keep their text; saving recreates them.`;
    }
    let changed = false;
    for (const doc of this._docs.values()) {
      if (isInside(doc.path, path) && !doc.missing) {
        doc.missing = true;
        changed = true;
      }
    }
    this._fileDiagnostics.delete(path);
    if (changed) {
      this._renderDocBanner();
      this._renderTabs();
    }
    if (this._project && isInside(path, this._project.root)) this._scheduleTreeReload();
    this._collectProblems();
  }

  /** @returns {void} */
  _renderDocBanner() {
    const doc = this._activeDoc();
    const banner = this._docBanner;
    if (!doc || (!doc.missing && !doc.conflict)) {
      banner.hidden = true;
      return;
    }
    const button = (label, action) => createElement("button", { className: "cs-text-button", text: label, attrs: { type: "button" }, on: { click: action } });
    if (doc.conflict) {
      banner.replaceChildren(
        createElement("span", { text: `${basename(doc.path)} was changed elsewhere while you were editing it.` }),
        button("Load the other version", () => {
          doc.savedText = doc.externalText ?? doc.savedText;
          doc.conflict = false;
          doc.editor.setValue(doc.savedText, { keepHistory: true });
          this._onDocChanged(doc);
          this._renderDocBanner();
        }),
        button("Keep mine", () => {
          doc.conflict = false;
          doc.savedText = doc.externalText ?? doc.savedText;
          this._onDocChanged(doc);
          this._renderDocBanner();
        })
      );
    } else {
      banner.replaceChildren(
        createElement("span", { text: `${basename(doc.path)} no longer exists on disk. Save to create it again.` }),
        button("Save", () => this._saveDoc(doc)),
        button("Close", () => this._closeDoc(doc.path, { force: true }))
      );
    }
    banner.hidden = false;
  }

  // ---------------------------------------------------------------
  // File operations (explorer)
  // ---------------------------------------------------------------

  /**
   * Folder new items go into: the focused/selected folder in the tree, else the project root.
   * @param {object|null} [entry]
   * @returns {string|null}
   */
  _targetFolder(entry = null) {
    if (!this._project) return null;
    const tree = this._project.tree;
    const candidate = entry ?? (this._tree.getFocusedPath() ? tree.entries.get(this._tree.getFocusedPath()) : null);
    if (!candidate) return this._project.root;
    return candidate.type === "folder" ? candidate.path : dirname(candidate.path);
  }

  /**
   * @param {object|null} [entry]
   * @returns {Promise<void>}
   */
  async _newFile(entry = null) {
    const folder = this._targetFolder(entry);
    if (!folder) {
      await this._newProject();
      return;
    }
    const name = await showPromptDialog({
      title: "New file",
      label: `File name (in ${relativeTo(folder, this._project.root) || basename(folder)})`,
      placeholder: "index.html",
      confirmLabel: "Create",
      validate: async (value) => validateName(value) ?? ((await vfs.exists(joinPath(folder, value.trim()))) ? `${value.trim()} already exists.` : null),
    });
    if (!name) return;
    const path = joinPath(folder, name.trim());
    try {
      await createFolderTree(dirname(path));
      await vfs.createFile(path, "");
    } catch (error) {
      await showMessageDialog({ title: "Couldn't create the file", message: `${path} couldn't be created.`, detail: error.message });
      return;
    }
    await this._reloadTree();
    this._tree.reveal(path);
    await this._openFile(path);
  }

  /**
   * @param {object|null} [entry]
   * @returns {Promise<void>}
   */
  async _newFolder(entry = null) {
    const folder = this._targetFolder(entry);
    if (!folder) return;
    const name = await showPromptDialog({
      title: "New folder",
      label: `Folder name (in ${relativeTo(folder, this._project.root) || basename(folder)})`,
      placeholder: "assets",
      confirmLabel: "Create",
      validate: async (value) => validateName(value) ?? ((await vfs.exists(joinPath(folder, value.trim()))) ? `${value.trim()} already exists.` : null),
    });
    if (!name) return;
    const path = joinPath(folder, name.trim());
    try {
      await vfs.createFolder(path);
    } catch (error) {
      await showMessageDialog({ title: "Couldn't create the folder", message: `${path} couldn't be created.`, detail: error.message });
      return;
    }
    await this._reloadTree();
    this._tree.reveal(path);
  }

  /**
   * @param {object} entry
   * @returns {Promise<void>}
   */
  async _renameEntry(entry) {
    if (this._project && entry.path === this._project.root) {
      await showMessageDialog({ title: "Rename project", message: "Rename the project folder from File Explorer; Code Studio follows the new name automatically." });
      return;
    }
    const dot = entry.type === "file" ? entry.name.lastIndexOf(".") : -1;
    const name = await showPromptDialog({
      title: entry.type === "folder" ? "Rename folder" : "Rename file",
      label: "New name",
      initialValue: entry.name,
      selection: [0, dot > 0 ? dot : entry.name.length],
      confirmLabel: "Rename",
      validate: async (value) => {
        const trimmed = value.trim();
        const error = validateName(trimmed);
        if (error) return error;
        if (trimmed !== entry.name && (await vfs.exists(joinPath(dirname(entry.path), trimmed)))) return `${trimmed} already exists.`;
        return null;
      },
    });
    if (!name || name.trim() === entry.name) return;
    try {
      await vfs.rename(entry.path, name.trim());
    } catch (error) {
      await showMessageDialog({ title: "Couldn't rename", message: `${entry.name} couldn't be renamed.`, detail: error.message });
    }
  }

  /**
   * @param {object} entry
   * @returns {Promise<void>}
   */
  async _deleteEntry(entry) {
    if (this._project && entry.path === this._project.root) {
      await showMessageDialog({ title: "Delete project", message: "Close the project, then delete its folder from File Explorer." });
      return;
    }
    const affected = [...this._docs.values()].filter((doc) => isInside(doc.path, entry.path));
    const unsaved = affected.filter((doc) => doc.dirty);
    const confirmed = await showConfirmDialog({
      title: entry.type === "folder" ? "Delete folder?" : "Delete file?",
      message: `\u201c${entry.name}\u201d${entry.type === "folder" ? " and everything in it" : ""} will be moved to Trash.${unsaved.length ? ` Unsaved changes in ${unsaved.length} open file${unsaved.length === 1 ? "" : "s"} will be lost.` : ""}`,
      confirmLabel: "Move to Trash",
      destructive: true,
    });
    if (!confirmed) return;
    try {
      await vfs.delete(entry.path);
    } catch (error) {
      await showMessageDialog({ title: "Couldn't delete", message: `${entry.name} couldn't be moved to Trash.`, detail: error.message });
      return;
    }
    for (const doc of affected) this._removeDoc(doc);
  }

  /**
   * @param {string} source
   * @param {string} folder
   * @returns {Promise<void>}
   */
  async _moveEntry(source, folder) {
    try {
      if (await vfs.exists(joinPath(folder, basename(source)))) {
        await showMessageDialog({ title: "Couldn't move", message: `${basename(folder) || folder} already contains ${basename(source)}.` });
        return;
      }
      await vfs.move(source, folder);
    } catch (error) {
      await showMessageDialog({ title: "Couldn't move", message: `${basename(source)} couldn't be moved.`, detail: error.message });
    }
  }

  /**
   * Choose a destination folder (inside the project) and move an item there.
   * @param {object} entry
   * @returns {Promise<void>}
   */
  async _moveEntryDialog(entry) {
    if (!this._project) return;
    const folder = await showFolderPickerDialog({ vfs, title: `Move \u201c${entry.name}\u201d to`, initialPath: dirname(entry.path) });
    if (!folder || folder === dirname(entry.path)) return;
    if (isInside(folder, entry.path)) {
      await showMessageDialog({ title: "Couldn't move", message: "A folder can't be moved into itself." });
      return;
    }
    await this._moveEntry(entry.path, folder);
  }

  /**
   * @param {object|null} entry
   * @param {{x: number, y: number}} point
   * @returns {void}
   */
  _showTreeMenu(entry, point) {
    if (!this._project) return;
    const isRoot = !entry || entry.path === this._project.root;
    const target = entry ?? this._project.tree.entries.get(this._project.root);
    const items = [];
    if (entry?.type === "file") {
      items.push({ label: "Open", action: () => this._openFile(entry.path) });
      if (/\.html?$/i.test(entry.path)) items.push({ label: "Open in preview", action: () => this._runPage(entry.path) });
      items.push({ separator: true });
    }
    items.push(
      { label: "New file\u2026", action: () => this._newFile(target), shortcut: "Alt + N" },
      { label: "New folder\u2026", action: () => this._newFolder(target) },
      { separator: true }
    );
    if (!isRoot) {
      items.push(
        { label: "Rename\u2026", action: () => this._renameEntry(entry), shortcut: "F2" },
        { label: "Move to\u2026", action: () => this._moveEntryDialog(entry) },
        { label: "Delete", action: () => this._deleteEntry(entry), shortcut: "Delete" },
        { separator: true }
      );
    }
    items.push(
      { label: "Copy path", action: () => copyText(target.path) },
      { label: "Reveal in File Explorer", action: () => this._revealInExplorer(target) },
      { label: "Open in Terminal", action: () => this.appManager?.launch("terminal", { path: target.type === "folder" ? target.path : dirname(target.path) }).catch(() => {}) }
    );
    this._menu.show(items, point);
  }

  /**
   * @param {object} entry
   * @returns {Promise<void>}
   */
  async _revealInExplorer(entry) {
    const folder = entry.type === "folder" ? entry.path : dirname(entry.path);
    try {
      await openVfsEntry(await vfs.getInfo(folder), { appManager: this.appManager, recentFilesService: this.recentFilesService });
    } catch (error) {
      this._setStatusMessage(error.message);
    }
  }

  /**
   * @param {string} path
   * @returns {void}
   */
  _revealInTree(path) {
    this._showSidebar("explorer");
    this._tree.reveal(path);
    this._tree.setActive(path);
  }

  /**
   * Apply project-wide replacements: open files are edited in place,
   * other files are written after a confirmation.
   * @param {Array<{path: string, text: string, count: number}>} changes
   * @returns {Promise<void>}
   */
  async _applyProjectReplacements(changes) {
    const total = changes.reduce((sum, change) => sum + change.count, 0);
    const closed = changes.filter((change) => !this._docs.has(change.path));
    const confirmed = await showConfirmDialog({
      title: "Replace in files?",
      message: `Replace ${total.toLocaleString()} match${total === 1 ? "" : "es"} in ${changes.length} file${changes.length === 1 ? "" : "s"}?${closed.length ? ` ${closed.length} file${closed.length === 1 ? " that isn't" : "s that aren't"} open will be saved right away; open files keep the change unsaved until you save them.` : " The files stay unsaved until you save them."}`,
      confirmLabel: "Replace",
      destructive: closed.length > 0,
    });
    if (!confirmed) return;
    const failures = [];
    for (const change of changes) {
      const doc = this._docs.get(change.path);
      if (doc) {
        const caret = doc.editor.getSelection().start;
        doc.editor.replaceDocument(change.text, [Math.min(caret, change.text.length), Math.min(caret, change.text.length)], "replace");
        continue;
      }
      try {
        const info = await vfs.getInfo(change.path);
        if (info.readOnly) throw new Error("read-only");
        await vfs.write(change.path, change.text);
      } catch (error) {
        failures.push(`${basename(change.path)}: ${error.message}`);
      }
    }
    if (failures.length) {
      await showMessageDialog({ title: "Some files weren't changed", message: `${failures.length} file${failures.length === 1 ? "" : "s"} couldn't be written.`, detail: failures.join("\n") });
    } else {
      this._setStatusMessage(`Replaced ${total.toLocaleString()} match${total === 1 ? "" : "es"}`);
    }
  }

  // ---------------------------------------------------------------
  // Reading for preview / search
  // ---------------------------------------------------------------

  /**
   * @param {string} path
   * @returns {Promise<string|null>} Current text (open file's editor first), or null.
   */
  async _readCurrentText(path) {
    const doc = this._docs.get(path);
    if (doc) return doc.editor.getValue();
    try {
      const entry = await vfs.getInfo(path);
      if (entry.type !== "file" || isBinaryEntry(entry)) return null;
      return await vfs.read(path);
    } catch {
      return null;
    }
  }

  /**
   * @param {string} path
   * @returns {Promise<Blob|null>}
   */
  async _readBlob(path) {
    try {
      return await vfs.readBinary(path);
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------
  // Diagnostics
  // ---------------------------------------------------------------

  /**
   * @param {Doc} doc
   * @returns {Promise<void>}
   */
  async _diagnoseDoc(doc) {
    if (!DIAGNOSED_LANGUAGES.has(doc.language.id)) {
      doc.diagnostics = [];
      doc.editor.setDiagnostics([]);
      this._collectProblems();
      return;
    }
    const run = ++doc.diagnoseRun;
    const text = doc.editor.getValue();
    const results = await diagnose({
      path: doc.path,
      text,
      languageId: doc.language.id,
      projectRoot: this._rootPath(),
      fileExists: (path) => this._fileExists(path),
    });
    if (this._closed || run !== doc.diagnoseRun || !this._docs.has(doc.path) || doc.editor.getValue() !== text) return;
    doc.diagnostics = results;
    doc.editor.setDiagnostics(results);
    this._collectProblems();
  }

  /**
   * @param {string} path
   * @returns {Promise<boolean>}
   */
  async _fileExists(path) {
    if (this._docs.has(path) && !this._docs.get(path).missing) return true;
    if (this._project && isInside(path, this._project.root)) return this._project.tree.entries.has(path) || vfs.exists(path);
    return vfs.exists(path);
  }

  /**
   * Check project files that aren't open (once per project load and when they change).
   * @returns {Promise<void>}
   */
  async _diagnoseProject() {
    if (!this._project) return;
    const root = this._project.root;
    const files = listProjectFiles(this._project.tree)
      .filter((entry) => DIAGNOSED_LANGUAGES.has(languageForPath(entry.path).id) && (entry.size ?? 0) <= MAX_DIAGNOSED_BYTES)
      .slice(0, MAX_DIAGNOSED_FILES);
    for (const entry of files) {
      if (this._closed || !this._project || this._project.root !== root) return;
      if (this._docs.has(entry.path)) continue;
      await this._diagnosePath(entry.path);
    }
  }

  /**
   * @param {string} path
   * @returns {Promise<void>}
   */
  async _diagnosePath(path) {
    const text = await this._readCurrentText(path);
    if (text === null || this._docs.has(path)) return;
    const results = await diagnose({ path, text, languageId: languageForPath(path).id, projectRoot: this._rootPath(), fileExists: (p) => this._fileExists(p) });
    if (this._closed || this._docs.has(path)) return;
    if (results.length) this._fileDiagnostics.set(path, results);
    else this._fileDiagnostics.delete(path);
    this._collectProblems();
  }

  /** @returns {void} */
  _collectProblems() {
    const problems = [];
    for (const doc of this._docs.values()) problems.push(...doc.diagnostics);
    for (const [path, list] of this._fileDiagnostics) if (!this._docs.has(path)) problems.push(...list);
    problems.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.column - b.column);
    this._bottom.setProblems(problems);
    this._updateStatus();
  }

  // ---------------------------------------------------------------
  // Preview
  // ---------------------------------------------------------------

  /** Run: preview the active HTML file, or the current/default page. */
  _run() {
    const doc = this._activeDoc();
    const page = doc && /\.html?$/i.test(doc.path) ? doc.path : this._preview.getEntry() ?? this._defaultPage();
    if (!page) {
      this._showPreviewHost();
      this._preview.setEntry(null);
      this._preview.rebuild();
      return;
    }
    this._runPage(page);
  }

  /**
   * @param {string} path
   * @returns {void}
   */
  _runPage(path) {
    this._showPreviewHost();
    this._preview.setEntry(path);
    this._preview.rebuild();
  }

  /** @returns {void} */
  _showPreviewHost() {
    if (this._preview.getHost() === "window") {
      this._focusPreviewWindow();
      return;
    }
    if (!this._layout.showPreview) this._togglePreview(true);
  }

  /**
   * @param {number} [delay]
   * @returns {void}
   */
  _schedulePreview(delay = PREVIEW_DELAY_MS) {
    if (!this._preview.getEntry()) return;
    if (this._preview.getHost() === "docked" && !this._layout.showPreview) return;
    this._debounce("preview", delay, () => this._preview.rebuild());
  }

  /** @returns {Promise<void>} */
  async _popOutPreview() {
    if (!this.appManager) return;
    try {
      this._preview.setHost("window");
      this._applyLayout();
      await this.appManager.launch("code-studio-preview", { sessionId: this._preview.id, title: this._project ? basename(this._project.root) : "Preview" });
      if (!this._preview.getBuild()) this._run();
    } catch (error) {
      this._preview.setHost("docked");
      this._applyLayout();
      this._setStatusMessage(`Couldn't open the preview window: ${error.message}`);
    }
  }

  /** Bring the preview back into this window. */
  _dockPreview() {
    if (this._preview.getHost() !== "window") return;
    this._preview.setHost("docked");
    // The preview window closes itself when its session is docked again.
    this._layout.showPreview = true;
    this._applyLayout();
    this._preview.rebuild();
  }

  /** @returns {void} */
  _focusPreviewWindow() {
    const app = this.appManager;
    if (!app) return;
    for (const windowId of app.getWindowIds("code-studio")) {
      const instance = app.getInstance(windowId);
      if (instance?.sessionId === this._preview.id) app.focusWindow(windowId);
    }
  }

  // ---------------------------------------------------------------
  // Terminal
  // ---------------------------------------------------------------

  /** @returns {HTMLElement} */
  _createTerminal() {
    this._terminal = new TerminalManager({
      vfs,
      appManager: this.appManager,
      recentFilesService: this.recentFilesService,
      initialPath: this._project?.root ?? "/",
      focusWindow: () => {
        if (this.windowId) this.appManager?.focusWindow(this.windowId);
      },
      isActive: () => Boolean(this.windowId) && this.appManager?.getFocusedWindowId() === this.windowId,
      greeting:
        'Code Studio terminal \u2014 BrowserOS commands only (type "help"); it starts in the project folder.\n' +
        "There is no Node.js, npm, or other runtime here: pages run in the live preview. \u201ccode <file>\u201d opens a file in Code Studio.",
    });
    this._terminal.init();
    return this._terminal.getElement();
  }

  /** @returns {void} */
  _toggleTerminal() {
    if (this._layout.showPanel && this._bottom.getTab() === "terminal" && this._root.querySelector(".cs-panel__view--terminal")?.contains(document.activeElement)) {
      this._togglePanel(false);
      this._activeDoc()?.editor.focus();
      return;
    }
    this._showPanelTab("terminal");
  }

  // ---------------------------------------------------------------
  // Layout commands
  // ---------------------------------------------------------------

  /**
   * @param {"explorer"|"search"} view
   * @param {{query?: string, replace?: boolean}} [options]
   * @returns {void}
   */
  _showSidebar(view, { query, replace } = {}) {
    this._sidebarView = view;
    this._layout.showSidebar = true;
    this._explorerView.hidden = view !== "explorer";
    this._searchView.hidden = view !== "search";
    this._applyLayout();
    saveLayout(this._layout);
    if (view === "search") this._search.focus(query || undefined, { replace });
    else this._tree.focus();
  }

  /**
   * Activity bar: show a view, or hide the sidebar when that view is already showing.
   * @param {"explorer"|"search"} view
   * @returns {void}
   */
  _onActivity(view) {
    if (this._layout.showSidebar && this._sidebarView === view) this._toggleSidebar(false);
    else this._showSidebar(view);
  }

  /**
   * @param {boolean} [show]
   * @returns {void}
   */
  _toggleSidebar(show = !this._layout.showSidebar) {
    this._layout.showSidebar = show;
    this._applyLayout();
    saveLayout(this._layout);
  }

  /**
   * @param {boolean} [show]
   * @returns {void}
   */
  _togglePanel(show = !this._layout.showPanel) {
    this._layout.showPanel = show;
    this._applyLayout();
    saveLayout(this._layout);
    if (show && this._bottom.getTab() === "terminal") this._terminal?.onFocus();
  }

  /**
   * @param {"problems"|"output"|"terminal"} tab
   * @returns {void}
   */
  _showPanelTab(tab) {
    if (!this._layout.showPanel) this._togglePanel(true);
    this._bottom.showTab(tab);
  }

  /**
   * @param {boolean} [show]
   * @returns {void}
   */
  _togglePreview(show) {
    if (this._preview.getHost() === "window") {
      this._focusPreviewWindow();
      return;
    }
    this._layout.showPreview = show ?? !this._layout.showPreview;
    this._applyLayout();
    saveLayout(this._layout);
    if (this._layout.showPreview) {
      if (!this._preview.getEntry()) this._preview.setEntry(this._defaultPage());
      this._preview.rebuild();
    }
  }

  /** @returns {void} */
  _toggleWordWrap() {
    settingsService.set("codeStudio.wordWrap", !this._settings.wordWrap);
  }

  /** @returns {Promise<void>} */
  async _goToLine() {
    const doc = this._activeDoc();
    if (!doc) return;
    const cursor = doc.editor.getCursor();
    const lines = doc.editor.getLineCount();
    const value = await showPromptDialog({
      title: "Go to line",
      label: `Line (1\u2013${lines}), optionally :column`,
      initialValue: String(cursor.line),
      confirmLabel: "Go",
      validate: (input) => (/^\s*\d+\s*(:\s*\d+\s*)?$/.test(input) ? null : "Enter a line number, such as 42 or 42:7."),
    });
    if (!value) {
      doc.editor.focus();
      return;
    }
    const [line, column] = value.split(":").map((part) => Number(part.trim()));
    doc.editor.goTo(Math.min(Math.max(1, line), lines), column || 1);
    doc.editor.focus();
  }

  // ---------------------------------------------------------------
  // Menus
  // ---------------------------------------------------------------

  /**
   * @param {HTMLElement} button
   * @param {Array<object>} items
   * @returns {void}
   */
  _openMenu(button, items) {
    const rect = button.getBoundingClientRect();
    for (const other of this._menuButtons) other.setAttribute("aria-expanded", String(other === button));
    this._menu.show(items, { x: rect.left, y: rect.bottom + 2 }, {
      onClose: () => {
        button.setAttribute("aria-expanded", "false");
      },
    });
  }

  /** @returns {Array<object>} */
  _fileMenuItems() {
    const doc = this._activeDoc();
    const recent = getRecentProjects().filter((path) => path !== this._project?.root);
    return [
      { label: "New project\u2026", action: () => this._newProject() },
      { label: "Open project\u2026", action: () => this._openProjectDialog() },
      {
        label: "Open recent",
        submenu: recent.length
          ? [...recent.map((path) => ({ label: path, action: () => this._switchProject(path) }))]
          : [{ label: "No recent projects", disabled: true }],
      },
      { label: "New window", action: () => this.appManager?.launch("code-studio-window").catch(() => {}) },
      { separator: true },
      { label: "New file\u2026", action: () => this._newFile(), shortcut: "Alt + N", disabled: !this._project },
      { label: "New folder\u2026", action: () => this._newFolder(), disabled: !this._project },
      { label: "Go to file\u2026", action: () => this._quickOpen.open(), shortcut: "Ctrl + P" },
      { separator: true },
      { label: "Save", action: () => this._save(), shortcut: "Ctrl + S", disabled: !doc },
      { label: "Save as\u2026", action: () => this._saveAs(), shortcut: "Ctrl + Shift + S", disabled: !doc },
      { label: "Save all", action: () => this._saveAll(), shortcut: "Ctrl + Alt + S", disabled: this._dirtyDocs().length === 0 },
      { separator: true },
      { label: "Close file", action: () => doc && this._closeDoc(doc.path), shortcut: "Alt + W", disabled: !doc },
      { label: "Close project", action: () => this._closeProject(), disabled: !this._project },
      { label: "Reveal project in File Explorer", action: () => this._project && this._revealInExplorer(this._project.tree.entries.get(this._project.root)), disabled: !this._project },
    ];
  }

  /** @returns {Array<object>} */
  _editMenuItems() {
    const doc = this._activeDoc();
    const editor = doc?.editor;
    return [
      { label: "Undo", action: () => editor?.undo(), shortcut: "Ctrl + Z", disabled: !editor?.canUndo() },
      { label: "Redo", action: () => editor?.redo(), shortcut: "Ctrl + Y", disabled: !editor?.canRedo() },
      { separator: true },
      { label: "Select all", action: () => editor && (editor.focus(), editor.setSelection(0, editor.getValue().length, { reveal: false })), shortcut: "Ctrl + A", disabled: !editor },
      { label: "Find", action: () => editor && this._find.open(editor), shortcut: "Ctrl + F", disabled: !editor },
      { label: "Replace", action: () => editor && this._find.open(editor, { replace: true }), shortcut: "Ctrl + H", disabled: !editor },
      { label: "Search in project", action: () => this._showSidebar("search", { query: editor?.getSelectedText() }), shortcut: "Ctrl + Shift + F" },
      { label: "Replace in project", action: () => this._showSidebar("search", { query: editor?.getSelectedText(), replace: true }) },
      { separator: true },
      { label: "Go to line\u2026", action: () => this._goToLine(), shortcut: "Ctrl + G", disabled: !editor },
      { label: "Toggle comment", action: () => editor && (editor.toggleComment(), editor.focus()), shortcut: "Ctrl + /", disabled: !editor },
      { label: "Indent lines", action: () => editor && (editor.indentLines(false), editor.focus()), shortcut: "Ctrl + ]", disabled: !editor },
      { label: "Outdent lines", action: () => editor && (editor.indentLines(true), editor.focus()), shortcut: "Ctrl + [", disabled: !editor },
    ];
  }

  /** @returns {Array<object>} */
  _viewMenuItems() {
    const s = this._settings;
    return [
      { label: "Explorer", action: () => this._showSidebar("explorer"), checked: this._layout.showSidebar && this._sidebarView === "explorer" },
      { label: "Search", action: () => this._showSidebar("search"), checked: this._layout.showSidebar && this._sidebarView === "search", shortcut: "Ctrl + Shift + F" },
      { label: "Sidebar", action: () => this._toggleSidebar(), checked: this._layout.showSidebar, shortcut: "Ctrl + B" },
      { separator: true },
      { label: "Problems", action: () => this._showPanelTab("problems") },
      { label: "Output", action: () => this._showPanelTab("output") },
      { label: "Terminal", action: () => this._showPanelTab("terminal"), shortcut: "Ctrl + `" },
      { label: "Panel", action: () => this._togglePanel(), checked: this._layout.showPanel, shortcut: "Ctrl + J" },
      { label: "Preview", action: () => this._togglePreview(), checked: !this._previewHost.hidden, shortcut: "Alt + P" },
      { separator: true },
      { label: "Word wrap", action: () => this._toggleWordWrap(), checked: s.wordWrap, shortcut: "Alt + Z" },
      { label: "Line numbers", action: () => settingsService.set("codeStudio.lineNumbers", !s.lineNumbers), checked: s.lineNumbers },
      { label: "Bigger text", action: () => settingsService.set("codeStudio.fontSize", Math.min(24, s.fontSize + 1)), disabled: s.fontSize >= 24 },
      { label: "Smaller text", action: () => settingsService.set("codeStudio.fontSize", Math.max(10, s.fontSize - 1)), disabled: s.fontSize <= 10 },
      {
        label: "Editor theme",
        submenu: [
          { label: "System", action: () => settingsService.set("codeStudio.theme", "system"), checked: s.theme === "system", radio: true },
          { label: "Dark", action: () => settingsService.set("codeStudio.theme", "dark"), checked: s.theme === "dark", radio: true },
          { label: "Light", action: () => settingsService.set("codeStudio.theme", "light"), checked: s.theme === "light", radio: true },
        ],
      },
      { label: "Code Studio settings\u2026", action: () => this.appManager?.launch("settings", { page: "codeStudio" }).catch(() => {}) },
    ];
  }

  /** @returns {Array<object>} */
  _runMenuItems() {
    const pages = this._htmlPages();
    return [
      { label: "Run", action: () => this._run(), shortcut: "Ctrl + Enter" },
      { label: "Refresh preview", action: () => this._preview.rebuild(), disabled: !this._preview.getEntry() },
      { label: "Update preview while typing", action: () => settingsService.set("codeStudio.autoPreview", !this._settings.autoPreview), checked: this._settings.autoPreview },
      {
        label: "Preview page",
        submenu: pages.length
          ? pages.slice(0, 40).map((path) => ({ label: relativeTo(path, this._rootPath()), action: () => this._runPage(path), checked: path === this._preview.getEntry(), radio: true }))
          : [{ label: "No HTML pages", disabled: true }],
      },
      { separator: true },
      { label: "Open preview in a separate window", action: () => this._popOutPreview(), disabled: this._preview.getHost() === "window" },
      { label: "Show preview in this window", action: () => this._dockPreview(), disabled: this._preview.getHost() !== "window" },
      { separator: true },
      { label: "Clear output", action: () => this._bottom.clearOutput() },
    ];
  }

  /** @returns {Array<object>} */
  _helpMenuItems() {
    return [
      { label: "Keyboard shortcuts", action: () => this.appManager?.launch("settings", { page: "keyboard" }).catch(() => {}) },
      { label: "About Code Studio", action: () => this._showAbout() },
    ];
  }

  /** @returns {Promise<void>} */
  async _showAbout() {
    await showMessageDialog({
      title: "About Code Studio",
      message:
        "Code Studio edits HTML, CSS, JavaScript, JSON, Markdown, and other text files in the BrowserOS file system, checks their syntax, and shows web pages in a sandboxed live preview.",
      detail:
        "JavaScript runs only inside the preview page, in the browser's sandbox. There is no Node.js, npm, build step, or server: fetch() of project files and other server features aren't available to previewed pages. The terminal runs BrowserOS commands.",
    });
  }

  /**
   * @param {MouseEvent} e
   * @param {Doc} doc
   * @returns {void}
   */
  _showEditorMenu(e, doc) {
    e.preventDefault();
    const editor = doc.editor;
    const hasSelection = editor.getSelection().start !== editor.getSelection().end;
    this._menu.show(
      [
        { label: "Undo", action: () => editor.undo(), shortcut: "Ctrl + Z", disabled: !editor.canUndo() },
        { label: "Redo", action: () => editor.redo(), shortcut: "Ctrl + Y", disabled: !editor.canRedo() },
        { separator: true },
        { label: "Cut", action: () => this._clipboardAction(editor, "cut"), shortcut: "Ctrl + X", disabled: !hasSelection },
        { label: "Copy", action: () => this._clipboardAction(editor, "copy"), shortcut: "Ctrl + C", disabled: !hasSelection },
        { label: "Paste", action: () => this._clipboardAction(editor, "paste"), shortcut: "Ctrl + V" },
        { label: "Select all", action: () => editor.setSelection(0, editor.getValue().length, { reveal: false }), shortcut: "Ctrl + A" },
        { separator: true },
        { label: "Find", action: () => this._find.open(editor), shortcut: "Ctrl + F" },
        { label: "Replace", action: () => this._find.open(editor, { replace: true }), shortcut: "Ctrl + H" },
        { label: "Toggle comment", action: () => editor.toggleComment(), shortcut: "Ctrl + /" },
        { label: "Go to line\u2026", action: () => this._goToLine(), shortcut: "Ctrl + G" },
        ...(/\.html?$/i.test(doc.path) ? [{ separator: true }, { label: "Open in preview", action: () => this._runPage(doc.path) }] : []),
      ],
      { x: e.clientX, y: e.clientY }
    );
  }

  /**
   * Clipboard from the context menu, through the async Clipboard API.
   * @param {CodeEditor} editor
   * @param {"cut"|"copy"|"paste"} action
   * @returns {Promise<void>}
   */
  async _clipboardAction(editor, action) {
    const { start, end } = editor.getSelection();
    try {
      if (action === "paste") {
        const text = await navigator.clipboard.readText();
        editor.replaceRange(start, end, text, { kind: "edit" });
      } else {
        await navigator.clipboard.writeText(editor.getValue().slice(start, end));
        if (action === "cut") editor.replaceRange(start, end, "", { kind: "delete" });
      }
    } catch {
      this._setStatusMessage(`The browser didn't allow ${action === "paste" ? "pasting" : "copying"} from the menu; use Ctrl + ${action === "paste" ? "V" : action === "cut" ? "X" : "C"}.`);
    }
    editor.focus();
  }

  /**
   * @param {HTMLElement} anchor
   * @returns {void}
   */
  _showIndentMenu(anchor) {
    const rect = anchor.getBoundingClientRect();
    const s = this._settings;
    this._menu.show(
      [
        { label: "Indent with spaces", action: () => settingsService.set("codeStudio.insertSpaces", true), checked: s.insertSpaces, radio: true },
        { label: "Indent with tabs", action: () => settingsService.set("codeStudio.insertSpaces", false), checked: !s.insertSpaces, radio: true },
        { separator: true },
        ...[2, 4, 8].map((width) => ({ label: `Tab width ${width}`, action: () => settingsService.set("codeStudio.tabWidth", width), checked: s.tabWidth === width, radio: true })),
      ],
      { x: rect.left, y: rect.top - 4 }
    );
  }

  // ---------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------

  /** @returns {void} */
  _renderAll() {
    this._renderTabs();
    this._renderSidebarHeader();
    this._renderWelcome();
    this._renderDocBanner();
    this._previewPane.refreshPages();
    this._updateTitle();
    this._updateStatus();
    this._applyLayout();
  }

  /** @returns {void} */
  _renderTabs() {
    const tabs = this._order.map((path) => {
      const doc = this._docs.get(path);
      const active = path === this._activePath;
      doc.tab.classList.toggle("cs-tab--active", active);
      doc.tab.classList.toggle("cs-tab--dirty", doc.dirty);
      doc.tab.classList.toggle("cs-tab--missing", doc.missing);
      doc.tab.setAttribute("aria-selected", String(active));
      doc.tab.tabIndex = active ? 0 : -1;
      doc.tab.title = `${path}${doc.dirty ? " (unsaved)" : ""}${doc.missing ? " (deleted)" : ""}`;
      const name = basename(path);
      const duplicate = this._order.some((other) => other !== path && basename(other) === name);
      doc.tab.querySelector(".cs-tab__label").textContent = duplicate ? `${name} \u2014 ${basename(dirname(path))}` : name;
      doc.tab.querySelector(".cs-tab__badge").textContent = { html: "<>", css: "#", javascript: "JS", json: "{}", markdown: "M" }[doc.language.id] ?? "";
      doc.tab.querySelector(".cs-tab__close").setAttribute("aria-label", `Close ${name}${doc.dirty ? " (unsaved changes)" : ""}`);
      return doc.tab;
    });
    this._tabs.replaceChildren(...tabs);
    this._tabs.hidden = tabs.length === 0;
    this._welcome.hidden = tabs.length > 0;
    if (tabs.length === 0) this._renderWelcome();
  }

  /** @returns {void} */
  _renderSidebarHeader() {
    const project = this._project;
    this._explorerTitle.textContent = project ? basename(project.root) : "Explorer";
    this._explorerTitle.title = project?.root ?? "";
    this._explorerActions.hidden = !project;
    this._tree.getElement().hidden = !project;
    this._noProject.hidden = Boolean(project);
    this._projectLabel.textContent = project ? project.root : "No project";
    if (!project) {
      this._noProject.replaceChildren(
        createElement("p", { text: "No project is open." }),
        createElement("button", { className: "cs-text-button cs-text-button--primary", text: "New project\u2026", attrs: { type: "button" }, on: { click: () => this._newProject() } }),
        createElement("button", { className: "cs-text-button", text: "Open project\u2026", attrs: { type: "button" }, on: { click: () => this._openProjectDialog() } })
      );
    }
  }

  /** @returns {void} */
  _renderWelcome() {
    if (this._order.length) return;
    const recent = getRecentProjects();
    const action = (label, onClick, primary = false) =>
      createElement("button", { className: `cs-text-button${primary ? " cs-text-button--primary" : ""}`, text: label, attrs: { type: "button" }, on: { click: onClick } });
    const shortcuts = [
      ["Go to file", "Ctrl + P"],
      ["Search in project", "Ctrl + Shift + F"],
      ["Run the page", "Ctrl + Enter"],
      ["Save", "Ctrl + S"],
      ["Terminal", "Ctrl + `"],
    ];
    const children = [
      createElement("div", { className: "cs-welcome__logo", children: [createIconElement("icon:code")] }),
      createElement("h2", { className: "cs-welcome__title", text: this._project ? basename(this._project.root) : "Code Studio" }),
      createElement("p", {
        className: "cs-welcome__text",
        text: this._project ? "Open a file from the explorer, or create one." : "Create a project from a template or open a folder from the BrowserOS file system.",
      }),
      createElement("div", {
        className: "cs-welcome__actions",
        children: this._project
          ? [action("New file\u2026", () => this._newFile(), true), action("Go to file\u2026", () => this._quickOpen.open()), action("Run", () => this._run())]
          : [action("New project\u2026", () => this._newProject(), true), action("Open project\u2026", () => this._openProjectDialog())],
      }),
    ];
    if (!this._project && recent.length) {
      children.push(
        createElement("h3", { className: "cs-welcome__subtitle", text: "Recent projects" }),
        createElement("ul", {
          className: "cs-welcome__recent",
          children: recent.map((path) =>
            createElement("li", {
              children: [
                createElement("button", { className: "cs-link-button", text: basename(path), attrs: { type: "button", title: path }, on: { click: () => this._switchProject(path) } }),
                createElement("span", { className: "cs-welcome__path", text: dirname(path) }),
              ],
            })
          ),
        })
      );
    }
    children.push(
      createElement("dl", {
        className: "cs-welcome__shortcuts",
        children: shortcuts.flatMap(([label, keys]) => [createElement("dt", { text: label }), createElement("dd", { children: [createElement("kbd", { text: keys })] })]),
      })
    );
    this._welcome.replaceChildren(createElement("div", { className: "cs-welcome__inner", children }));
  }

  /** @returns {void} */
  _updateTitle() {
    if (!this.windowId || !this.appManager) {
      // Not attached yet; launch() returns the initial title.
      queueMicrotask(() => this.windowId && this._updateTitle());
      return;
    }
    const doc = this._activeDoc();
    const parts = [];
    if (doc) parts.push(`${doc.dirty ? "\u25cf " : ""}${basename(doc.path)}`);
    if (this._project) parts.push(basename(this._project.root));
    parts.push("Code Studio");
    this.appManager.updateWindowTitle(this.windowId, parts.join(" \u2014 "));
  }

  /** @returns {void} */
  _updateStatus() {
    const counts = this._bottom.getCounts();
    this._status.problems.replaceChildren(
      createIconElement("icon:error", { className: "cs-status__icon" }),
      document.createTextNode(String(counts.errors)),
      createIconElement("icon:warning", { className: "cs-status__icon" }),
      document.createTextNode(String(counts.warnings))
    );
    this._status.problems.setAttribute("aria-label", `${counts.errors} errors, ${counts.warnings} warnings. Show problems`);
    const doc = this._activeDoc();
    const s = this._settings;
    for (const key of ["cursor", "indent", "eol", "language"]) this._status[key].hidden = !doc;
    this._updateWrapStatus(doc);
    if (doc) {
      this._updateCursorStatus();
      this._status.indent.textContent = s.insertSpaces ? `Spaces: ${s.tabWidth}` : `Tab size: ${s.tabWidth}`;
      this._status.language.textContent = doc.language.name;
      this._status.eol.textContent = /\r\n/.test(doc.originalText ?? "") ? "CRLF \u2192 LF" : "LF";
      this._status.eol.title = /\r\n/.test(doc.originalText ?? "") ? "The file used Windows line endings; it is saved with LF line endings." : "Line endings";
    }
  }

  /** @returns {void} */
  _updateCursorStatus() {
    const doc = this._activeDoc();
    if (!doc) return;
    const cursor = doc.editor.getCursor();
    this._status.cursor.textContent = `Ln ${cursor.line}, Col ${cursor.column}${cursor.selected ? ` (${cursor.selected} selected)` : ""}`;
    this._updateWrapStatus(doc);
  }

  /**
   * @param {object|null} doc
   * @returns {void}
   */
  _updateWrapStatus(doc) {
    const suspended = Boolean(doc?.editor.isWrapSuspended());
    this._status.wrap.textContent = suspended ? "Wrap: off (large file)" : this._settings.wordWrap ? "Wrap: on" : "Wrap: off";
    this._status.wrap.title = suspended
      ? `Word wrap is paused for files over ${LARGE_DOCUMENT_LINES.toLocaleString()} lines, so they stay fast to edit.`
      : "Toggle word wrap (Alt + Z)";
  }

  /**
   * @param {string} text
   * @returns {void}
   */
  _setStatusMessage(text) {
    this._status.message.textContent = text;
    this._debounce("status", 5000, () => {
      this._status.message.textContent = "";
    });
  }

  /**
   * @param {string} key
   * @param {number} delay
   * @param {() => void} action
   * @returns {void}
   */
  _debounce(key, delay, action) {
    window.clearTimeout(this._timers.get(key));
    this._timers.set(
      key,
      window.setTimeout(() => {
        this._timers.delete(key);
        if (!this._closed) action();
      }, delay)
    );
  }
}

// -----------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------

/** @returns {object} Editor settings from SettingsService. */
function readEditorSettings() {
  return {
    theme: settingsService.get("codeStudio.theme"),
    fontSize: settingsService.get("codeStudio.fontSize"),
    fontFamily: settingsService.get("codeStudio.fontFamily"),
    tabWidth: settingsService.get("codeStudio.tabWidth"),
    insertSpaces: settingsService.get("codeStudio.insertSpaces"),
    lineNumbers: settingsService.get("codeStudio.lineNumbers"),
    wordWrap: settingsService.get("codeStudio.wordWrap"),
    autoPreview: settingsService.get("codeStudio.autoPreview"),
    autoCloseBrackets: settingsService.get("codeStudio.autoCloseBrackets"),
  };
}

/** @returns {object} */
function readLayout() {
  const stored = storage.get(LAYOUT_KEY, {});
  if (!stored || typeof stored !== "object") return {};
  const result = {};
  for (const key of ["sidebar", "panel", "preview"]) if (Number.isFinite(stored[key])) result[key] = stored[key];
  for (const key of ["showSidebar", "showPanel", "showPreview"]) if (typeof stored[key] === "boolean") result[key] = stored[key];
  return result;
}

/**
 * @param {object} layout
 * @returns {void}
 */
function saveLayout(layout) {
  storage.set(LAYOUT_KEY, { ...layout });
}

/**
 * @param {object} entry
 * @returns {boolean}
 */
function isBinaryEntry(entry) {
  return entry.content instanceof Blob || ["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif", "tif", "tiff", "pdf", "zip", "mp3", "mp4", "wav", "ogg", "webm", "woff", "woff2", "ttf", "otf", "wasm", "docx", "xlsx", "pptx"].includes(entry.extension ?? extname(entry.path));
}

/**
 * Create a folder and any missing parents.
 * @param {string} path
 * @returns {Promise<void>}
 */
async function createFolderTree(path) {
  if (path === "/" || (await vfs.exists(path))) return;
  await createFolderTree(dirname(path));
  await vfs.createFolder(path);
}

/**
 * @param {string} folder
 * @returns {Promise<boolean>} Whether a folder holds web project files (index.html or package.json).
 */
async function looksLikeProject(folder) {
  try {
    const children = await vfs.list(folder);
    return children.some((entry) => entry.type === "file" && ["index.html", "package.json"].includes(entry.name.toLowerCase()));
  } catch {
    return false;
  }
}

/**
 * The project folder for a file's folder: under /Projects it is the
 * folder directly inside /Projects; elsewhere the folder itself.
 * @param {string} folder
 * @returns {string}
 */
function projectRootFor(folder) {
  if (isInside(folder, PROJECTS_FOLDER) && folder !== PROJECTS_FOLDER) {
    const relative = relativeTo(folder, PROJECTS_FOLDER).split("/")[0];
    return joinPath(PROJECTS_FOLDER, relative);
  }
  return folder;
}

/** @returns {Promise<string>} "My Project", "My Project 2", … whichever doesn't exist yet. */
async function uniqueProjectName() {
  const base = "My Project";
  for (let n = 1; n < 100; n += 1) {
    const name = n === 1 ? base : `${base} ${n}`;
    if (!(await vfs.exists(joinPath(PROJECTS_FOLDER, name)))) return name;
  }
  return `${base} ${Date.now()}`;
}

/**
 * @param {string} text
 * @returns {void}
 */
function copyText(text) {
  navigator.clipboard?.writeText(text).catch(() => {});
}
