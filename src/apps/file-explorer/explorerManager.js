/**
 * @file ExplorerManager — orchestrates one File Explorer window: its
 * own navigation history, current path, selection, view mode, and
 * sort — all independent per window, so multiple Explorer windows
 * never interfere with each other. Constructed fresh by
 * FileExplorerApp on every launch (unlike DesktopManager, which is a
 * system-wide singleton).
 *
 * Two pseudo-locations, `HOME_PATH` and `FAVORITES_PATH`, never touch
 * the VFS directly — Home aggregates RecentFilesService + favorited
 * folders, Favorites lists favorited folders alone. Every other path
 * is a real VFS folder, browsed exclusively through the public VFS
 * API (list/getInfo/createFolder/createFile/rename/delete/search) —
 * this manager never touches IndexedDB.
 *
 * Live sync: VFS event handlers here are deliberately synchronous
 * (they update from the event's own entry payload, never re-fetching
 * via an extra `await vfs.list(...)`) so that after
 * `await vfs.createFolder(...)` resolves, the new row is already in
 * the DOM — the same ordering guarantee DesktopManager relies on,
 * and for the same reason: an async re-render here would race
 * against the very createFolder() call that triggered it.
 *
 * Selection + focus: a rectangle (marquee) selection
 * never makes any row the pointerdown target, so nothing about it
 * triggers the browser's native "click focuses this element"
 * behavior — and that behavior isn't guaranteed cross-browser anyway
 * (Safari doesn't apply it to plain buttons/divs). Delete/F2 rely on
 * a keydown listener attached to the list container, which only
 * fires for events bubbling up *from inside it* — so after a marquee
 * selection with nothing focused, Delete silently did nothing even
 * though the selection itself was completely correct. Both
 * `_handleItemClick` and `_startMarquee`'s pointerup now explicitly
 * focus the appropriate row, rather than relying on any native
 * default.
 *
 * Preferences: view mode, display options, sorting, startup location,
 * folder-opening behavior, and delete confirmation all come from the
 * `fileExplorer` settings category. Every Explorer window subscribes
 * to that category and re-renders in place when it changes — the
 * current folder, history, and selection are kept — so all open
 * windows stay synchronized and new windows start from the same
 * values. The toolbar view buttons and Details column headers change
 * the shared settings rather than per-window state. Display options
 * never alter the VFS: hiding extensions only changes the rendered
 * label, and rename fields always show the real name.
 */

import { eventBus } from "../../core/eventBus.js";
import { notificationService } from "../../core/notifications/notificationService.js";
import { storage } from "../../core/storage.js";
import { settingsService } from "../../core/settings/settingsService.js";
import { keyboardShortcuts } from "../../core/keyboard/keyboardShortcuts.js";
import { createElement } from "../../utils/dom.js";
import { ExplorerView } from "./explorerView.js";
import { ContextMenu } from "../../components/context-menu/contextMenu.js";
import { showConfirmDialog } from "../../components/dialog/confirmDialog.js";
import { showPropertiesDialog } from "../../components/dialog/propertiesDialog.js";
import { openVfsEntry, buildOpenWithItems } from "../../core/vfs/vfsOpener.js";
import { importHostFiles } from "../../core/vfs/fileImport.js";
import { fileAssociations } from "../../core/fileAssociations.js";
import { showMessageDialog } from "../../components/dialog/messageDialog.js";
import { showFolderPickerDialog } from "../../components/dialog/folderPickerDialog.js";
import { pasteClipboard } from "../../core/vfs/clipboardPaste.js";
import { getParentPath } from "../../core/vfs/pathResolver.js";
import { generateDefaultName, splitNameForRename } from "../../utils/nameGenerator.js";
import { formatBytes, formatDate } from "../../utils/format.js";

const HOME_PATH = "home://";
const FAVORITES_PATH = "favorites://";
const MAX_BREADCRUMB_SEGMENTS = 5;
const SEARCH_DEBOUNCE_MS = 300;
/** Navigation state (not a preference): the last location any Explorer window showed. */
const LAST_LOCATION_STORAGE_KEY = "explorer:lastLocation";
/** How many recent files the Home view lists. */
const HOME_RECENT_LIMIT = 10;

/** fileExplorer.startupLocation values that map to a fixed location. */
const STARTUP_PATHS = Object.freeze({
  home: HOME_PATH,
  desktop: "/Desktop",
  documents: "/Documents",
  downloads: "/Downloads",
});

const SIDEBAR_LOCATIONS = [
  { key: "home", label: "Home", path: HOME_PATH, icon: "icon:home" },
  { key: "desktop", label: "Desktop", path: "/Desktop", icon: "icon:display" },
  { key: "documents", label: "Documents", path: "/Documents", icon: "icon:file-text" },
  { key: "downloads", label: "Downloads", path: "/Downloads", icon: "icon:download" },
  { key: "pictures", label: "Pictures", path: "/Pictures", icon: "icon:image" },
  { key: "music", label: "Music", path: "/Music", icon: "icon:music" },
  { key: "videos", label: "Videos", path: "/Videos", icon: "icon:video" },
  { key: "applications", label: "Applications", path: "/Applications", icon: "icon:apps" },
  { key: "trash", label: "Trash", path: "/Trash", icon: "icon:trash" },
  { key: "favorites", label: "Favorites", path: FAVORITES_PATH, icon: "icon:star" },
];

class ExplorerManager {
  /**
   * @param {object} config
   * @param {import("../../core/vfs/virtualFileSystem.js").vfs} config.vfs
   * @param {import("../../core/appManager.js").AppManager} config.appManager
   * @param {import("../../core/recentFilesService.js").RecentFilesService} config.recentFilesService
   * @param {import("../../core/clipboardService.js").clipboardService} config.clipboardService
   */
  constructor(config) {
    this._vfs = config.vfs;
    this._appManager = config.appManager;
    this._recentFilesService = config.recentFilesService;
    this._clipboardService = config.clipboardService;

    this._view = new ExplorerView({
      onBack: () => this.goBack(),
      onForward: () => this.goForward(),
      onUp: () => this.goUp(),
      onRefresh: () => this.refresh(),
      onNewFolder: () => this._createNewFolder(),
      onNewTextDocument: () => this._createNewTextDocument(),
      onCopy: () => this._copySelection(),
      onCut: () => this._cutSelection(),
      onPaste: () => this._pasteIntoCurrentFolder(),
      onDelete: () => this._deleteSelection(),
      onViewModeChange: (mode) => settingsService.set("fileExplorer.defaultView", mode),
      onSortChange: (field) => this._setSortField(field),
      onAddressToggle: () => this._toggleAddressMode(),
      onAddressSubmit: (value) => this._submitAddress(value),
      onSearchInput: (value) => this._handleSearchInput(value),
      onSearchRecursiveToggle: (checked) => this._handleSearchRecursiveToggle(checked),
      onSidebarNavigate: (path) => this.navigate(path),
      onImportFiles: (files) => this._importFiles(files),
    });

    this._contextMenu = new ContextMenu();

    this._path = HOME_PATH;
    this._currentFolderId = null;
    this._history = [];
    this._historyIndex = -1;

    /** @type {Readonly<Record<string, *>>} Snapshot of the fileExplorer.* settings currently applied. */
    this._prefs = settingsService.getCategory("fileExplorer");
    this._viewMode = this._prefs["fileExplorer.defaultView"];
    this._sort = { field: this._prefs["fileExplorer.sortField"], direction: this._prefs["fileExplorer.sortDirection"] };

    /** @type {Set<string>} */
    this._selection = new Set();
    this._lastClickedIndex = null;
    /** @type {object[]} Current folder's children (or search results), sorted and rendered. */
    this._items = [];

    this._searchQuery = "";
    this._searchRecursive = false;
    this._searchDebounceId = null;
    this._searchActive = false;

    this._addressEditing = false;

    this._marqueeEl = null;
    this._marqueeRafId = null;

    this._eventUnsubscribers = [];

    this._view.setViewMode(this._viewMode);
    this._view.setColumnVisibility(this._getColumnVisibility());
  }

  /** @returns {HTMLElement} */
  getElement() {
    return this._view.getElement();
  }

  /**
   * @param {string} [initialPath]
   * @returns {Promise<void>}
   */
  async init(initialPath) {
    this._wireContainerEvents();
    this._wireVfsEvents();
    this._eventUnsubscribers.push(
      settingsService.subscribeCategory("fileExplorer", (batch) => this._applyPreferences(batch))
    );
    this._renderSidebar();
    this._updateSortIndicators();
    const startPath = initialPath ?? (await this._resolveStartupPath());
    await this.navigate(startPath, { pushHistory: true });
  }

  /**
   * Where a window opened without an explicit path starts: the last
   * visited location (if that preference is on and it still exists),
   * otherwise the configured startup location (if it still exists),
   * otherwise Home.
   * @returns {Promise<string>}
   */
  async _resolveStartupPath() {
    const candidates = [];
    if (this._prefs["fileExplorer.restoreLastLocation"]) {
      const last = storage.get(LAST_LOCATION_STORAGE_KEY, null);
      if (typeof last === "string") candidates.push(last);
    }
    const startup = this._prefs["fileExplorer.startupLocation"];
    candidates.push(startup === "custom" ? this._prefs["fileExplorer.customStartupPath"] : STARTUP_PATHS[startup]);

    for (const candidate of candidates) {
      if (!candidate) continue;
      if (candidate === HOME_PATH || candidate === FAVORITES_PATH) return candidate;
      try {
        const info = await this._vfs.getInfo(candidate);
        if (info.type === "folder" && !this._isInTrash(info.path)) return info.path;
      } catch {
        // Missing or unreadable — try the next candidate.
      }
    }
    return HOME_PATH;
  }

  /**
   * @param {string} path
   * @returns {boolean}
   */
  _isInTrash(path) {
    return path === "/Trash" || path.startsWith("/Trash/");
  }

  // ---------------------------------------------------------------
  // Preferences
  // ---------------------------------------------------------------

  /**
   * Apply one batch of fileExplorer.* changes to this window without
   * leaving the current folder.
   * @param {import("../../core/settings/settingsService.js").SettingsBatch} batch
   * @returns {void}
   */
  _applyPreferences(batch) {
    const changed = new Set(batch.changes.map((change) => change.key));
    this._prefs = settingsService.getCategory("fileExplorer");

    if (changed.has("fileExplorer.defaultView")) {
      this._viewMode = this._prefs["fileExplorer.defaultView"];
      this._view.setViewMode(this._viewMode);
    }
    if (changed.has("fileExplorer.sortField") || changed.has("fileExplorer.sortDirection")) {
      this._sort = { field: this._prefs["fileExplorer.sortField"], direction: this._prefs["fileExplorer.sortDirection"] };
      this._updateSortIndicators();
    }
    this._view.setColumnVisibility(this._getColumnVisibility());

    if (this._path === HOME_PATH) return; // Home has its own fixed layout.

    if (changed.has("fileExplorer.showHiddenFiles")) {
      // Hidden entries were filtered out of _items, so they must be
      // re-read from the VFS rather than re-sorted.
      if (this._searchActive) {
        this._executeSearch();
      } else if (this._path === FAVORITES_PATH) {
        this._renderFavorites();
      } else {
        this._renderFolder({ preserveSelection: true });
      }
      return;
    }

    const resorts = ["fileExplorer.sortField", "fileExplorer.sortDirection", "fileExplorer.foldersFirst"];
    if (resorts.some((key) => changed.has(key))) this._items = this._sortItems(this._items);
    this._renderItemsList();
  }

  /**
   * @returns {{size: boolean, modified: boolean, type: boolean}}
   */
  _getColumnVisibility() {
    return {
      size: this._prefs["fileExplorer.showSize"],
      modified: this._prefs["fileExplorer.showModified"],
      type: this._prefs["fileExplorer.showType"],
    };
  }

  /**
   * @param {object} entry
   * @returns {string} The name to render, honoring the extension preference.
   */
  _displayName(entry) {
    if (this._prefs["fileExplorer.showExtensions"] || entry.type === "folder" || !entry.extension) return entry.name;
    const suffix = `.${entry.extension}`;
    // Dotfiles like ".profile" have no stem to show without the extension.
    if (!entry.name.toLowerCase().endsWith(suffix.toLowerCase()) || entry.name.length === suffix.length) return entry.name;
    return entry.name.slice(0, -suffix.length);
  }

  /**
   * Called when this Explorer window closes — cleans up every VFS/
   * clipboard listener this window registered, so closing it never
   * leaves a dangling subscription behind.
   * @returns {void}
   */
  destroy() {
    for (const unsubscribe of this._eventUnsubscribers) unsubscribe();
    this._eventUnsubscribers = [];
    if (this._searchDebounceId !== null) window.clearTimeout(this._searchDebounceId);
    if (this._marqueeRafId !== null) cancelAnimationFrame(this._marqueeRafId);
  }

  // ---------------------------------------------------------------
  // Navigation
  // ---------------------------------------------------------------

  /**
   * @param {string} path
   * @param {{pushHistory?: boolean}} [options]
   * @returns {Promise<void>}
   */
  async navigate(path, options = {}) {
    const { pushHistory = true } = options;
    const isVirtual = path === HOME_PATH || path === FAVORITES_PATH;

    if (!isVirtual) {
      let info;
      try {
        info = await this._vfs.getInfo(path);
      } catch (error) {
        this._view.showError(`Couldn't open "${path}": ${error.message}`);
        return;
      }
      if (info.type !== "folder") {
        this._view.showError(`"${info.name}" is not a folder`);
        return;
      }
      this._currentFolderId = info.id;
    } else {
      this._currentFolderId = null;
    }

    this._path = path;
    this._searchActive = false;
    this._searchQuery = "";
    this._selection.clear();
    this._lastClickedIndex = null;

    if (pushHistory) {
      this._history = this._history.slice(0, this._historyIndex + 1);
      this._history.push(path);
      this._historyIndex = this._history.length - 1;
    }

    this._refreshChrome();
    storage.set(LAST_LOCATION_STORAGE_KEY, path);
    await this._renderCurrentLocation();

    eventBus.emit("explorer:navigated", { path });
  }

  /** @returns {Promise<void>} */
  async goBack() {
    if (this._historyIndex <= 0) return;
    this._historyIndex -= 1;
    await this.navigate(this._history[this._historyIndex], { pushHistory: false });
  }

  /** @returns {Promise<void>} */
  async goForward() {
    if (this._historyIndex >= this._history.length - 1) return;
    this._historyIndex += 1;
    await this.navigate(this._history[this._historyIndex], { pushHistory: false });
  }

  /** @returns {Promise<void>} */
  async goUp() {
    if (this._path === HOME_PATH || this._path === FAVORITES_PATH || this._path === "/") return;
    await this.navigate(getParentPath(this._path) ?? "/");
  }

  /** @returns {Promise<void>} */
  async refresh() {
    if (this._searchActive) {
      await this._executeSearch();
      return;
    }
    await this._renderCurrentLocation();
  }

  /** @returns {void} */
  _refreshChrome() {
    this._view.setNavButtonsState({
      canBack: this._historyIndex > 0,
      canForward: this._historyIndex < this._history.length - 1,
      canUp: this._path !== HOME_PATH && this._path !== FAVORITES_PATH && this._path !== "/",
    });
    this._view.setBreadcrumbs(this._buildBreadcrumbs());
    this._view.setImportEnabled(this._path !== HOME_PATH && this._path !== FAVORITES_PATH && !this._isInTrash(this._path));
    this._view.setFolderBanner(
      this._path === "/Downloads" && this._appManager.isRegistered("downloads")
        ? {
            text: "Files downloaded with the Browser are saved here.",
            actionLabel: "Open Download Manager",
            onAction: () => this._appManager.launch("downloads").catch(() => {}),
          }
        : null
    );
    this._view.setAddressMode("breadcrumbs");
    this._addressEditing = false;
    this._view.setActiveSidebarPath(this._path);
  }

  /** @returns {Array<{label: string, path: string|null}>} */
  _buildBreadcrumbs() {
    if (this._path === HOME_PATH) return [{ label: "Home", path: HOME_PATH }];
    if (this._path === FAVORITES_PATH) return [{ label: "Favorites", path: FAVORITES_PATH }];

    const segments = this._path === "/" ? [] : this._path.split("/").filter(Boolean);
    const crumbs = [{ label: "This PC", path: "/" }];
    let cursor = "";
    for (const segment of segments) {
      cursor += `/${segment}`;
      crumbs.push({ label: segment, path: cursor });
    }
    if (crumbs.length > MAX_BREADCRUMB_SEGMENTS) {
      const collapsedCount = crumbs.length - 3;
      return [crumbs[0], { label: `\u2026 (${collapsedCount})`, path: null }, ...crumbs.slice(-2)];
    }
    return crumbs;
  }

  // ---------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------

  /** @returns {Promise<void>} */
  async _renderCurrentLocation() {
    if (this._path === HOME_PATH) {
      await this._renderHome();
      return;
    }
    if (this._path === FAVORITES_PATH) {
      await this._renderFavorites();
      return;
    }
    await this._renderFolder();
  }

  /** @returns {Promise<void>} */
  async _renderHome() {
    this._view.showLoading();
    const [recentFiles, favorites] = await Promise.all([
      this._recentFilesService.reconcile().then((all) => all.slice(0, HOME_RECENT_LIMIT)),
      this._loadFavorites(),
    ]);
    this._view.renderHome(recentFiles, favorites, { onOpenPath: (path) => this._openPath(path) });
    this._view.setStatus(`${recentFiles.length} recent file${recentFiles.length === 1 ? "" : "s"}`);
  }

  /**
   * Refresh the Home view's Recent Files / Favorites sections in
   * place, but only when this window is actually showing Home right
   * now — called reactively off VFS delete/rename events so a file
   * deleted or renamed elsewhere (Desktop, another Explorer window,
   * Terminal) disappears from an already-open Home view immediately,
   * not just the next time the user navigates back to it.
   * @returns {Promise<void>}
   */
  async _refreshHomeIfActive() {
    if (this._path !== HOME_PATH) return;
    const [recentFiles, favorites] = await Promise.all([
      this._recentFilesService.reconcile().then((all) => all.slice(0, HOME_RECENT_LIMIT)),
      this._loadFavorites(),
    ]);
    this._view.renderHome(recentFiles, favorites, { onOpenPath: (path) => this._openPath(path) });
    this._view.setStatus(`${recentFiles.length} recent file${recentFiles.length === 1 ? "" : "s"}`);
  }

  /** @returns {Promise<void>} */
  async _renderFavorites() {
    this._view.showLoading();
    const favorites = await this._loadFavorites();
    this._items = favorites;
    this._renderItemsList();
  }

  /**
   * @returns {Promise<object[]>}
   */
  async _loadFavorites() {
    try {
      const all = await this._vfs.search("", { path: "/" });
      return all.filter((entry) => entry.favorite && entry.type === "folder" && !entry.path.startsWith("/Trash"));
    } catch {
      return [];
    }
  }

  /**
   * @param {{preserveSelection?: boolean}} [options]
   * @returns {Promise<void>}
   */
  async _renderFolder(options = {}) {
    const { preserveSelection = false } = options;
    this._view.showLoading();

    let children;
    try {
      children = await this._vfs.list(this._path);
    } catch (error) {
      this._view.showError(error.message);
      return;
    }

    if (!preserveSelection) {
      this._selection.clear();
    } else {
      const validIds = new Set(children.map((entry) => entry.id));
      for (const id of [...this._selection]) {
        if (!validIds.has(id)) this._selection.delete(id);
      }
    }

    this._items = this._sortItems(children);
    const visibleIds = new Set(this._items.map((entry) => entry.id));
    for (const id of [...this._selection]) {
      if (!visibleIds.has(id)) this._selection.delete(id);
    }
    this._renderItemsList();
  }

  /** @returns {void} */
  _renderItemsList() {
    const decorated = this._items.map((entry) => ({
      ...entry,
      _selected: this._selection.has(entry.id),
      _cut: this._clipboardService.isCut(entry.id),
      _displayName: this._displayName(entry),
      _icon: fileAssociations.getIcon(entry),
      _typeLabel: entry.type === "folder" ? "Folder" : entry.extension ? `${entry.extension.toUpperCase()} File` : "File",
      _sizeLabel: entry.type === "folder" ? "" : formatBytes(entry.size),
      _modifiedLabel: formatDate(entry.modifiedAt),
    }));

    this._view.renderItems(decorated, {
      onClick: (id, e) => this._handleItemClick(id, e),
      onDoubleClick: (id) => this._openItem(id),
      onContextMenu: (id, x, y) => this._showItemContextMenu(id, x, y),
    });

    this._updateStatus();
  }

  /** @returns {void} */
  _updateStatus() {
    const total = this._items.length;
    let text = `${total} item${total === 1 ? "" : "s"}`;
    if (this._selection.size > 0) {
      text += ` \u2014 ${this._selection.size} selected`;
      const selectedSize = this._items
        .filter((entry) => this._selection.has(entry.id) && entry.type === "file")
        .reduce((sum, entry) => sum + entry.size, 0);
      if (selectedSize > 0) text += ` (${formatBytes(selectedSize)})`;
    }
    this._view.setStatus(text);
  }

  // ---------------------------------------------------------------
  // Sorting / view mode
  // ---------------------------------------------------------------

  /**
   * @param {object[]} items
   * @returns {object[]}
   */
  /**
   * Filter (hidden entries, per preference) and sort a list of entries.
   * Every path that sets `_items` goes through here, so the hidden-file
   * preference applies uniformly to folders, search results, and live
   * VFS updates.
   * @param {object[]} items
   * @returns {object[]}
   */
  _sortItems(items) {
    const { field, direction } = this._sort;
    const multiplier = direction === "desc" ? -1 : 1;
    const foldersFirst = this._prefs["fileExplorer.foldersFirst"];
    const showHidden = this._prefs["fileExplorer.showHiddenFiles"];
    const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" });

    return items
      .filter((entry) => showHidden || !entry.hidden)
      .sort((a, b) => {
        if (foldersFirst && (a.type === "folder") !== (b.type === "folder")) return a.type === "folder" ? -1 : 1;
        let cmp = 0;
        if (field === "name") {
          cmp = byName(a, b);
        } else if (field === "type") {
          const aType = a.type === "folder" ? "" : (a.extension ?? "");
          const bType = b.type === "folder" ? "" : (b.extension ?? "");
          cmp = aType.localeCompare(bType, undefined, { sensitivity: "base" });
        } else if (field === "modified") {
          cmp = a.modifiedAt - b.modifiedAt;
        } else if (field === "created") {
          cmp = (a.createdAt ?? 0) - (b.createdAt ?? 0);
        } else if (field === "size") {
          cmp = (a.type === "folder" ? 0 : a.size) - (b.type === "folder" ? 0 : b.size);
        }
        // Ties fall back to name so the order is always stable.
        return (cmp || byName(a, b)) * (cmp ? multiplier : 1);
      });
  }

  /**
   * @param {string} field
   * @returns {void}
   */
  _setSortField(field) {
    // Clicking the active column flips direction; a new column starts
    // ascending. Both values change in one settings batch, so every
    // Explorer window re-sorts exactly once.
    const direction = this._sort.field === field && this._sort.direction === "asc" ? "desc" : "asc";
    settingsService.setMany({ "fileExplorer.sortField": field, "fileExplorer.sortDirection": direction });
  }

  /**
   * @param {"name"|"modified"|"created"|"size"|"type"} field
   * @param {"asc"|"desc"} [direction]
   * @returns {void}
   */
  _sortBy(field, direction = this._sort.direction) {
    settingsService.setMany({ "fileExplorer.sortField": field, "fileExplorer.sortDirection": direction });
  }

  /** @returns {void} */
  _updateSortIndicators() {
    const columns = ["name", "modified", "type", "size"].map((key) => ({
      key,
      direction: this._sort.field === key ? this._sort.direction : null,
    }));
    this._view.setSortIndicators(columns);
  }

  // ---------------------------------------------------------------
  // Sidebar
  // ---------------------------------------------------------------

  /** @returns {void} */
  _renderSidebar() {
    this._view.setSidebarItems(SIDEBAR_LOCATIONS.map((location) => ({ ...location })));
    this._view.setActiveSidebarPath(this._path);
  }

  // ---------------------------------------------------------------
  // Selection
  // ---------------------------------------------------------------

  /**
   * @param {string} entryId
   * @param {MouseEvent} e
   * @returns {void}
   */
  _handleItemClick(entryId, e) {
    const rows = this._view.getRowElements();
    const index = rows.findIndex((el) => el.dataset.entryId === entryId);

    if (e.shiftKey && this._lastClickedIndex !== null) {
      const [start, end] = [this._lastClickedIndex, index].sort((a, b) => a - b);
      const rangeIds = rows.slice(start, end + 1).map((el) => el.dataset.entryId);
      this._selection = e.ctrlKey || e.metaKey ? new Set([...this._selection, ...rangeIds]) : new Set(rangeIds);
    } else if (e.ctrlKey || e.metaKey) {
      if (this._selection.has(entryId)) this._selection.delete(entryId);
      else this._selection.add(entryId);
      this._lastClickedIndex = index;
    } else {
      this._selection = new Set([entryId]);
      this._lastClickedIndex = index;
    }

    this._applySelectionToRows();
    this._updateStatus();
    // Explicit focus — not a reliance on native click-focus (which
    // Safari doesn't guarantee even for buttons) — so Delete/F2 work
    // immediately after any click, in every browser.
    rows[index]?.focus();
  }

  /** @returns {void} */
  _applySelectionToRows() {
    for (const row of this._view.getRowElements()) {
      const id = row.dataset.entryId;
      this._view.setRowSelected(id, this._selection.has(id));
    }
  }

  // ---------------------------------------------------------------
  // Container-level interaction: marquee, empty-click, keyboard, context menu
  // ---------------------------------------------------------------

  /** @returns {void} */
  _wireContainerEvents() {
    const container = this._view.getListContainer();
    container.addEventListener("pointerdown", (e) => this._onContainerPointerDown(e));
    container.addEventListener("contextmenu", (e) => this._onContainerContextMenu(e));
    container.addEventListener("keydown", (e) => this._onContainerKeyDown(e));
    // Listeners on this window's own elements need no explicit cleanup:
    // they are collected with the window's DOM when it closes.
    this._view.getElement().addEventListener("keydown", (e) => this._onRootKeyDown(e));
  }

  /**
   * @param {PointerEvent} e
   * @returns {void}
   */
  _onContainerPointerDown(e) {
    if (e.target !== e.currentTarget) return; // A row handled its own click; this is empty space.
    if (e.button !== 0) return;

    if (this._viewMode !== "grid") {
      this._selection.clear();
      this._applySelectionToRows();
      this._updateStatus();
      return;
    }
    this._startMarquee(e, e.currentTarget);
  }

  /**
   * @param {PointerEvent} e
   * @param {HTMLElement} container
   * @returns {void}
   */
  _startMarquee(e, container) {
    const containerRect = container.getBoundingClientRect();
    const startX = e.clientX - containerRect.left;
    const startY = e.clientY - containerRect.top;
    const additive = e.ctrlKey || e.metaKey;
    const preDragSelection = new Set(this._selection);

    this._marqueeEl = createElement("div", { className: "explorer-marquee" });
    container.append(this._marqueeEl);

    const applyForPoint = (currentX, currentY) => {
      const rectLeft = Math.min(startX, currentX);
      const rectTop = Math.min(startY, currentY);
      const rectWidth = Math.abs(currentX - startX);
      const rectHeight = Math.abs(currentY - startY);

      if (this._marqueeEl) {
        this._marqueeEl.style.left = `${rectLeft}px`;
        this._marqueeEl.style.top = `${rectTop}px`;
        this._marqueeEl.style.width = `${rectWidth}px`;
        this._marqueeEl.style.height = `${rectHeight}px`;
      }

      const intersecting = this._getRowsIntersecting(rectLeft, rectTop, rectWidth, rectHeight, containerRect);
      this._selection = additive ? new Set([...preDragSelection, ...intersecting]) : new Set(intersecting);
      this._applySelectionToRows();
      this._updateStatus();
    };

    applyForPoint(startX, startY);

    const onMove = (moveEvent) => {
      const currentX = Math.min(Math.max(moveEvent.clientX - containerRect.left, 0), containerRect.width);
      const currentY = Math.min(Math.max(moveEvent.clientY - containerRect.top, 0), containerRect.height);
      if (this._marqueeRafId !== null) cancelAnimationFrame(this._marqueeRafId);
      this._marqueeRafId = requestAnimationFrame(() => {
        this._marqueeRafId = null;
        applyForPoint(currentX, currentY);
      });
    };
    const onUp = () => {
      if (this._marqueeRafId !== null) {
        cancelAnimationFrame(this._marqueeRafId);
        this._marqueeRafId = null;
      }
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      if (this._marqueeEl) {
        this._marqueeEl.remove();
        this._marqueeEl = null;
      }
      // A marquee never makes any row the pointerdown target, so focus
      // moves to the list here; otherwise Delete right after a
      // rectangle selection would not reach the list's key handler.
      this._focusAfterMarquee();
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }

  /**
   * @returns {void}
   */
  _focusAfterMarquee() {
    const selectedIds = [...this._selection];
    if (selectedIds.length === 0) return;
    const anchorId = selectedIds[selectedIds.length - 1];
    const rowEl = this._view.getRowElements().find((el) => el.dataset.entryId === anchorId);
    if (rowEl) {
      rowEl.focus();
    } else {
      this._view.getListContainer().focus();
    }
  }

  /**
   * @param {number} rectLeft
   * @param {number} rectTop
   * @param {number} rectWidth
   * @param {number} rectHeight
   * @param {DOMRect} containerRect
   * @returns {string[]}
   */
  _getRowsIntersecting(rectLeft, rectTop, rectWidth, rectHeight, containerRect) {
    const ids = [];
    for (const row of this._view.getRowElements()) {
      const elRect = row.getBoundingClientRect();
      const left = elRect.left - containerRect.left;
      const top = elRect.top - containerRect.top;
      const overlaps =
        left < rectLeft + rectWidth && left + elRect.width > rectLeft && top < rectTop + rectHeight && top + elRect.height > rectTop;
      if (overlaps) ids.push(row.dataset.entryId);
    }
    return ids;
  }

  /**
   * @param {KeyboardEvent} e
   * @returns {void}
   */
  _onContainerKeyDown(e) {
    // Inline rename inputs live inside the list; their keys are text
    // editing, never Explorer shortcuts.
    if (keyboardShortcuts.isEditableTarget(e.target)) return;
    const shortcut = (id) => keyboardShortcuts.matches(e, id);

    if (shortcut("fileExplorer.up")) {
      e.preventDefault();
      this.goUp();
    } else if (shortcut("fileExplorer.selectAll")) {
      e.preventDefault();
      this._selection = new Set(this._items.map((entry) => entry.id));
      this._applySelectionToRows();
      this._updateStatus();
    } else if (shortcut("fileExplorer.copy")) {
      e.preventDefault();
      this._copySelection();
    } else if (shortcut("fileExplorer.cut")) {
      e.preventDefault();
      this._cutSelection();
    } else if (shortcut("fileExplorer.paste")) {
      e.preventDefault();
      this._pasteIntoCurrentFolder();
    } else if (shortcut("fileExplorer.navigate")) {
      e.preventDefault();
      this._moveFocus(e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : -1);
    } else if (shortcut("fileExplorer.open")) {
      const id = document.activeElement?.dataset?.entryId;
      if (id) {
        e.preventDefault();
        this._openItem(id);
      }
    } else if (shortcut("fileExplorer.rename")) {
      e.preventDefault();
      if (this._selection.size === 1) this._startRename([...this._selection][0]);
    } else if (shortcut("fileExplorer.delete")) {
      e.preventDefault();
      this._deleteSelection();
    } else if (shortcut("fileExplorer.clearSelection")) {
      this._selection.clear();
      this._applySelectionToRows();
      this._updateStatus();
    }
  }

  /**
   * Window-wide Explorer shortcuts: these work wherever focus is inside
   * this Explorer window (sidebar, toolbar, list), not only in the list.
   * @param {KeyboardEvent} e
   * @returns {void}
   */
  _onRootKeyDown(e) {
    if (e.defaultPrevented) return;
    const editable = keyboardShortcuts.isEditableTarget(e.target);

    if (keyboardShortcuts.matches(e, "fileExplorer.focusAddress")) {
      e.preventDefault();
      this._focusAddressBar();
    } else if (keyboardShortcuts.matches(e, "fileExplorer.refresh")) {
      e.preventDefault();
      this.refresh();
    } else if (!editable && keyboardShortcuts.matches(e, "fileExplorer.newFolder")) {
      e.preventDefault();
      this._createNewFolder();
    }
  }

  /** @returns {void} */
  _focusAddressBar() {
    if (this._path === HOME_PATH || this._path === FAVORITES_PATH) return;
    this._addressEditing = true;
    this._view.setAddressMode("editing", this._path);
  }

  /**
   * @param {number} delta
   * @returns {void}
   */
  _moveFocus(delta) {
    const rows = this._view.getRowElements();
    if (rows.length === 0) return;
    const currentIndex = rows.indexOf(document.activeElement);
    const nextIndex = currentIndex === -1 ? 0 : Math.min(Math.max(currentIndex + delta, 0), rows.length - 1);
    rows[nextIndex].focus();
  }

  /**
   * @param {MouseEvent} e
   * @returns {void}
   */
  _onContainerContextMenu(e) {
    if (e.target !== e.currentTarget) return;
    e.preventDefault();
    this._showEmptyContextMenu(e.clientX, e.clientY);
  }

  // ---------------------------------------------------------------
  // Opening items
  // ---------------------------------------------------------------

  /**
   * @param {string} entryId
   * @returns {Promise<void>}
   */
  async _openItem(entryId) {
    const entry = this._items.find((item) => item.id === entryId);
    if (!entry) return;

    eventBus.emit("explorer:itemOpened", { id: entry.id, path: entry.path, kind: entry.type });

    if (entry.type === "folder") {
      await this._openFolder(entry.path);
      return;
    }
    try {
      await openVfsEntry(entry, { appManager: this._appManager, recentFilesService: this._recentFilesService });
    } catch (error) {
      await this._showErrorDialog("Couldn't open item", error.message);
    }
  }

  /**
   * @param {string} path
   * @returns {Promise<void>}
   */
  async _openPath(path) {
    try {
      const info = await this._vfs.getInfo(path);
      if (info.type === "folder") {
        await this._openFolder(path);
      } else {
        await openVfsEntry(info, { appManager: this._appManager, recentFilesService: this._recentFilesService });
      }
    } catch (error) {
      await this._showErrorDialog("Couldn't open item", error.message);
    }
  }

  /**
   * @param {object} entry
   * @param {string} appId
   * @returns {Promise<void>}
   */
  async _openWith(entry, appId) {
    try {
      await openVfsEntry(entry, { appManager: this._appManager, recentFilesService: this._recentFilesService, appId });
    } catch (error) {
      await this._showErrorDialog("Couldn't open item", error.message);
    }
  }

  /**
   * Copy files from the host computer into the current folder.
   * @param {File[]} files
   * @returns {Promise<void>}
   */
  async _importFiles(files) {
    if (this._path === HOME_PATH || this._path === FAVORITES_PATH || this._isInTrash(this._path)) {
      await showMessageDialog({ title: "Can't import here", message: "Open a folder first, then import files into it." });
      return;
    }
    let result;
    const startedAt = Date.now();
    const folderPath = this._path;
    try {
      result = await importHostFiles(this._vfs, this._path, files);
    } catch (error) {
      await showMessageDialog({ title: "Import failed", message: "The files could not be imported.", detail: error.message });
      return;
    }
    const { imported, skipped } = result;
    if (isLargeOperation(imported.length, startedAt)) {
      notifyOperation({ type: "success", title: `Imported ${plural(imported.length, "file")}`, folderPath });
    }
    if (imported.length > 0) {
      this._selection = new Set(imported.map((entry) => entry.id));
      this._applySelectionToRows();
      this._updateStatus();
    }
    eventBus.emit("explorer:filesImported", Object.freeze({ path: this._path, count: imported.length, skipped: skipped.length }));
    if (skipped.length > 0) {
      await showMessageDialog({
        title: imported.length > 0 ? "Some files weren't imported" : "No files were imported",
        message: `Supported: images (PNG, JPEG, WebP, GIF, SVG) and text files (TXT, MD, NOTE, JSON, CSV). ${imported.length} imported, ${skipped.length} skipped.`,
        detail: skipped.map((item) => `${item.name}: ${item.reason}`).join("\n"),
      });
    }
  }

  /**
   * @param {string} path
   * @returns {Promise<void>}
   */
  async _openInNewWindow(path) {
    await this._appManager.launch("file-explorer", { path });
  }

  /**
   * Open a folder the user activated, honoring fileExplorer.openFoldersIn.
   * Navigation controls (sidebar, breadcrumbs, Back/Up) always stay in
   * the same window.
   * @param {string} path
   * @returns {Promise<void>}
   */
  async _openFolder(path) {
    if (this._prefs["fileExplorer.openFoldersIn"] === "newWindow") {
      await this._openInNewWindow(path);
      return;
    }
    await this.navigate(path);
  }

  // ---------------------------------------------------------------
  // Create
  // ---------------------------------------------------------------

  /** @returns {Promise<void>} */
  async _createNewFolder() {
    if (this._path === HOME_PATH || this._path === FAVORITES_PATH) return;
    let siblings;
    try {
      siblings = await this._vfs.list(this._path);
    } catch (error) {
      await this._showErrorDialog("Couldn't create folder", error.message);
      return;
    }
    const name = generateDefaultName("New Folder", null, siblings.map((entry) => entry.name));
    const targetPath = this._path === "/" ? `/${name}` : `${this._path}/${name}`;
    try {
      const folder = await this._vfs.createFolder(targetPath);
      // filesystem:folderCreated's listener already rendered this row
      // synchronously — select and rename it directly.
      this._selection = new Set([folder.id]);
      this._applySelectionToRows();
      this._updateStatus();
      this._startRename(folder.id);
    } catch (error) {
      await this._showErrorDialog("Couldn't create folder", error.message);
    }
  }

  /** @returns {Promise<void>} */
  async _createNewTextDocument() {
    if (this._path === HOME_PATH || this._path === FAVORITES_PATH) return;
    let siblings;
    try {
      siblings = await this._vfs.list(this._path);
    } catch (error) {
      await this._showErrorDialog("Couldn't create document", error.message);
      return;
    }
    const name = generateDefaultName("New Text Document", "txt", siblings.map((entry) => entry.name));
    const targetPath = this._path === "/" ? `/${name}` : `${this._path}/${name}`;
    try {
      const file = await this._vfs.createFile(targetPath, "");
      this._selection = new Set([file.id]);
      this._applySelectionToRows();
      this._updateStatus();
      this._startRename(file.id);
    } catch (error) {
      await this._showErrorDialog("Couldn't create document", error.message);
    }
  }

  // ---------------------------------------------------------------
  // Rename
  // ---------------------------------------------------------------

  /**
   * @param {string} entryId
   * @returns {void}
   */
  _startRename(entryId) {
    const entry = this._items.find((item) => item.id === entryId);
    if (!entry) return;
    const { stem, extension } = splitNameForRename(entry.name);
    this._view.startRenameForItem(entryId, {
      stem,
      extension,
      onConfirm: (newName) => this._confirmRename(entryId, newName),
      onCancel: () => {},
    });
  }

  /**
   * @param {string} entryId
   * @param {string} newName
   * @returns {Promise<boolean>}
   */
  async _confirmRename(entryId, newName) {
    const entry = this._items.find((item) => item.id === entryId);
    if (!entry) return true;

    const trimmed = newName.trim();
    if (trimmed.length === 0) {
      this._view.showRenameError(entryId, "Name cannot be empty");
      return false;
    }
    if (trimmed === entry.name) return true;

    try {
      await this._vfs.rename(entry.path, trimmed);
      return true;
    } catch (error) {
      this._view.showRenameError(entryId, error.message);
      return false;
    }
  }

  // ---------------------------------------------------------------
  // Delete
  // ---------------------------------------------------------------

  /** @returns {Promise<void>} */
  async _deleteSelection() {
    const entries = this._items.filter((item) => this._selection.has(item.id));
    if (entries.length === 0) return;
    if (this._isInTrash(entries[0].path)) {
      await this._deletePermanently(entries);
      return;
    }

    const confirmMode = this._prefs["fileExplorer.confirmTrash"];
    const isNonEmptyFolder = entries.length === 1 && (await this._anyNonEmptyFolder(entries));
    const needsConfirmation =
      confirmMode === "always" || (confirmMode === "smart" && (entries.length > 1 || isNonEmptyFolder));
    if (needsConfirmation) {
      let message;
      if (entries.length > 1) {
        message = `Move ${entries.length} items to Trash?`;
      } else if (isNonEmptyFolder) {
        message = `"${entries[0].name}" is not empty. Move it and everything inside to Trash?`;
      } else {
        message = `Move "${entries[0].name}" to Trash?`;
      }
      const confirmed = await showConfirmDialog({ title: "Delete", message, confirmLabel: "Move to Trash", destructive: true });
      if (!confirmed) return;
    }

    const startedAt = Date.now();
    const folderPath = this._path;
    const failures = [];
    for (const entry of entries) {
      try {
        await this._vfs.delete(entry.path);
      } catch (error) {
        failures.push({ name: entry.name, message: error.message });
      }
    }
    const moved = entries.length - failures.length;
    if (failures.length === 1 && entries.length === 1) {
      await this._showErrorDialog(`Couldn't delete "${failures[0].name}"`, failures[0].message);
    } else if (failures.length > 0) {
      notifyOperation({
        type: "error",
        title: `${plural(failures.length, "item")} couldn't be moved to Trash`,
        message: failures.slice(0, 3).map((failure) => `${failure.name}: ${failure.message}`).join(" \u00b7 "),
        folderPath,
      });
    } else if (isLargeOperation(moved, startedAt)) {
      notifyOperation({ type: "success", title: `Moved ${plural(moved, "item")} to Trash`, folderPath: "/Trash" });
    }
  }

  /**
   * Items already in Trash are removed for good, always after confirmation.
   * @param {object[]} entries
   * @returns {Promise<void>}
   */
  async _deletePermanently(entries) {
    const message =
      entries.length === 1
        ? `Permanently delete "${entries[0].name}"${entries[0].type === "folder" ? " and everything in it" : ""}? This can't be undone.`
        : `Permanently delete these ${entries.length} items? This can't be undone.`;
    const confirmed = await showConfirmDialog({ title: "Delete permanently", message, confirmLabel: "Delete permanently", destructive: true });
    if (!confirmed) return;
    const failures = [];
    for (const entry of entries) {
      try {
        await this._vfs.deletePermanently(entry.path);
      } catch (error) {
        failures.push({ name: entry.name, message: error.message });
      }
    }
    if (failures.length > 0) {
      await this._showErrorDialog(
        failures.length === 1 ? `Couldn't delete "${failures[0].name}"` : `${plural(failures.length, "item")} couldn't be deleted`,
        failures.slice(0, 3).map((failure) => `${failure.name}: ${failure.message}`).join(" · ")
      );
    }
  }

  /**
   * Put the selected Trash items back where they came from.
   * @returns {Promise<void>}
   */
  async _restoreSelection() {
    const entries = this._items.filter((item) => this._selection.has(item.id));
    const failures = [];
    let restored = 0;
    for (const entry of entries) {
      try {
        try {
          await this._vfs.restore(entry.path);
        } catch (error) {
          if (error?.code !== "NO_ORIGINAL_LOCATION") throw error;
          const folder = await showFolderPickerDialog({ vfs: this._vfs, title: `Restore "${entry.name}" to`, initialPath: "/Documents" });
          if (!folder) continue;
          await this._vfs.restore(entry.path, { destination: folder });
        }
        restored += 1;
      } catch (error) {
        failures.push({ name: entry.name, message: error.message });
      }
    }
    if (failures.length > 0) {
      await this._showErrorDialog(
        failures.length === 1 ? `Couldn't restore "${failures[0].name}"` : `${plural(failures.length, "item")} couldn't be restored`,
        failures.slice(0, 3).map((failure) => `${failure.name}: ${failure.message}`).join(" · ")
      );
    } else if (restored > 1) {
      notifyOperation({ type: "success", title: `Restored ${plural(restored, "item")}`, folderPath: "/Trash" });
    }
  }

  /** @returns {Promise<void>} */
  async _emptyTrash() {
    const count = (await this._vfs.list("/Trash")).length;
    if (count === 0) return;
    const confirmed = await showConfirmDialog({
      title: "Empty Trash",
      message: `Permanently delete ${count === 1 ? "the item" : `all ${count} items`} in Trash? This can't be undone.`,
      confirmLabel: "Empty Trash",
      destructive: true,
    });
    if (!confirmed) return;
    try {
      await this._vfs.emptyTrash();
    } catch (error) {
      await this._showErrorDialog("Couldn't empty Trash", error.message);
    }
  }

  /**
   * @param {object[]} entries
   * @returns {Promise<boolean>}
   */
  async _anyNonEmptyFolder(entries) {
    for (const entry of entries) {
      if (entry.type === "folder") {
        const children = await this._vfs.list(entry.path);
        if (children.length > 0) return true;
      }
    }
    return false;
  }

  // ---------------------------------------------------------------
  // Copy / cut / paste
  // ---------------------------------------------------------------

  /** @returns {void} */
  _copySelection() {
    const entries = this._items.filter((item) => this._selection.has(item.id));
    if (entries.length === 0) return;
    this._clipboardService.setCopy(entries);
    this._renderItemsList();
  }

  /** @returns {void} */
  _cutSelection() {
    const entries = this._items.filter((item) => this._selection.has(item.id));
    if (entries.length === 0) return;
    this._clipboardService.setCut(entries);
    this._renderItemsList();
  }

  /** @returns {Promise<void>} */
  async _pasteIntoCurrentFolder() {
    if (this._path === HOME_PATH || this._path === FAVORITES_PATH) return;
    if (!this._clipboardService.hasContent()) return;

    const operation = this._clipboardService.get()?.operation === "cut" ? "Moved" : "Copied";
    const startedAt = Date.now();
    const folderPath = this._path;
    const { pasted, errors } = await pasteClipboard(this._vfs, this._clipboardService, this._path);
    if (errors.length > 0) {
      notifyOperation({
        type: "error",
        title: `${plural(errors.length, "item")} couldn't be ${operation === "Moved" ? "moved" : "copied"}`,
        message: errors.slice(0, 3).map((error) => `${error.path}: ${error.message}`).join(" \u00b7 "),
        folderPath,
      });
    } else if (isLargeOperation(pasted.length, startedAt)) {
      notifyOperation({ type: "success", title: `${operation} ${plural(pasted.length, "item")}`, folderPath });
    }
  }

  // ---------------------------------------------------------------
  // Favorites
  // ---------------------------------------------------------------

  /**
   * @param {string} entryId
   * @returns {Promise<void>}
   */
  async _toggleFavorite(entryId) {
    const entry = this._items.find((item) => item.id === entryId);
    if (!entry) return;
    try {
      await this._vfs.setFavorite(entry.path, !entry.favorite);
    } catch (error) {
      await this._showErrorDialog("Couldn't update favorites", error.message);
    }
  }

  // ---------------------------------------------------------------
  // Search
  // ---------------------------------------------------------------

  /**
   * @param {string} value
   * @returns {void}
   */
  _handleSearchInput(value) {
    this._searchQuery = value.trim();
    if (this._searchDebounceId !== null) window.clearTimeout(this._searchDebounceId);

    if (!this._searchQuery) {
      this._searchActive = false;
      this._renderCurrentLocation();
      return;
    }
    this._searchDebounceId = window.setTimeout(() => this._executeSearch(), SEARCH_DEBOUNCE_MS);
  }

  /**
   * @param {boolean} checked
   * @returns {void}
   */
  _handleSearchRecursiveToggle(checked) {
    this._searchRecursive = checked;
    if (this._searchQuery) this._executeSearch();
  }

  /** @returns {Promise<void>} */
  async _executeSearch() {
    if (this._path === HOME_PATH || this._path === FAVORITES_PATH) return;
    this._searchActive = true;
    this._view.showLoading();

    let results;
    try {
      if (this._searchRecursive) {
        results = await this._vfs.search(this._searchQuery, { path: this._path });
      } else {
        const children = await this._vfs.list(this._path);
        const lowerQuery = this._searchQuery.toLowerCase();
        results = children.filter((entry) => entry.name.toLowerCase().includes(lowerQuery));
      }
    } catch (error) {
      this._view.showError(error.message);
      return;
    }

    this._items = this._sortItems(results);
    this._renderItemsList();
    eventBus.emit("explorer:search", { query: this._searchQuery, resultCount: results.length });
  }

  // ---------------------------------------------------------------
  // Address bar
  // ---------------------------------------------------------------

  /** @returns {void} */
  _toggleAddressMode() {
    if (this._path === HOME_PATH || this._path === FAVORITES_PATH) return;
    this._addressEditing = !this._addressEditing;
    this._view.setAddressMode(this._addressEditing ? "editing" : "breadcrumbs", this._path);
  }

  /**
   * @param {string} value
   * @returns {Promise<void>}
   */
  async _submitAddress(value) {
    const trimmed = value.trim();
    this._addressEditing = false;
    if (!trimmed) {
      this._view.setAddressMode("breadcrumbs");
      return;
    }
    // navigate() already validates (NOT_FOUND / not-a-folder) and
    // keeps the previous valid location on failure — no need to
    // duplicate that logic here.
    await this.navigate(trimmed);
  }

  // ---------------------------------------------------------------
  // Context menus
  // ---------------------------------------------------------------

  /**
   * @param {string} entryId
   * @param {number} x
   * @param {number} y
   * @returns {void}
   */
  _showItemContextMenu(entryId, x, y) {
    if (!this._selection.has(entryId)) {
      this._selection = new Set([entryId]);
      this._applySelectionToRows();
      this._updateStatus();
    }

    const selectedEntries = this._items.filter((item) => this._selection.has(item.id));
    const isSingle = selectedEntries.length === 1;
    const entry = selectedEntries[0];

    if (this._isInTrash(this._path)) {
      const trashItems = [{ label: "Open", action: () => { for (const selected of selectedEntries) this._openItem(selected.id); } }, { separator: true }];
      if (this._path === "/Trash") trashItems.push({ label: "Restore", action: () => this._restoreSelection() });
      trashItems.push(
        { label: "Delete permanently", action: () => this._deleteSelection() },
        { separator: true },
        { label: "Copy", action: () => this._copySelection() },
        { separator: true },
        { label: "Properties", disabled: !isSingle, action: () => this._showProperties(entry?.id) }
      );
      this._contextMenu.show(trashItems, { x, y }, { onClose: () => {} });
      return;
    }

    const items = [{ label: "Open", action: () => { for (const selected of selectedEntries) this._openItem(selected.id); } }];
    if (isSingle && entry.type === "folder") {
      items.push({ label: "Open in New Window", action: () => this._openInNewWindow(entry.path) });
    }
    const openWith = isSingle ? buildOpenWithItems(entry, (appId) => this._openWith(entry, appId)) : [];
    if (openWith.length > 0) items.push({ label: "Open with", submenu: openWith });
    items.push(
      { separator: true },
      { label: "Rename", disabled: !isSingle, action: () => this._startRename(entry?.id) },
      { label: "Delete", action: () => this._deleteSelection() },
      { separator: true },
      { label: "Copy", action: () => this._copySelection() },
      { label: "Cut", action: () => this._cutSelection() }
    );
    if (isSingle && entry.type === "folder") {
      items.push({
        label: entry.favorite ? "Remove from Favorites" : "Add to Favorites",
        action: () => this._toggleFavorite(entry.id),
      });
    }
    items.push({ separator: true }, { label: "Properties", disabled: !isSingle, action: () => this._showProperties(entry?.id) });

    this._contextMenu.show(items, { x, y }, { onClose: () => {} });
  }

  /**
   * @param {number} x
   * @param {number} y
   * @returns {void}
   */
  _showEmptyContextMenu(x, y) {
    if (this._path === HOME_PATH || this._path === FAVORITES_PATH) return;
    if (this._isInTrash(this._path)) {
      // Trash holds deleted items only: no new files, no paste.
      const trashItems = [{ label: "Refresh", action: () => this.refresh() }];
      if (this._path === "/Trash") trashItems.push({ separator: true }, { label: "Empty Trash", disabled: this._items.length === 0, action: () => this._emptyTrash() });
      this._contextMenu.show(trashItems, { x, y }, { onClose: () => {} });
      return;
    }
    const items = [
      {
        label: "New",
        submenu: [
          { label: "Folder", action: () => this._createNewFolder() },
          { label: "Text Document", action: () => this._createNewTextDocument() },
        ],
      },
      { separator: true },
      {
        label: "View",
        submenu: [
          ["grid", "Grid"],
          ["list", "List"],
          ["details", "Details"],
        ].map(([mode, label]) => ({
          label,
          checked: this._viewMode === mode,
          radio: true,
          action: () => settingsService.set("fileExplorer.defaultView", mode),
        })),
      },
      {
        label: "Sort by",
        submenu: [
          ...[
            ["name", "Name"],
            ["modified", "Date modified"],
            ["created", "Date created"],
            ["size", "Size"],
            ["type", "Type"],
          ].map(([field, label]) => ({
            label,
            checked: this._sort.field === field,
            radio: true,
            action: () => this._sortBy(field),
          })),
          { separator: true },
          { label: "Ascending", checked: this._sort.direction === "asc", radio: true, action: () => this._sortBy(this._sort.field, "asc") },
          { label: "Descending", checked: this._sort.direction === "desc", radio: true, action: () => this._sortBy(this._sort.field, "desc") },
        ],
      },
      { label: "Refresh", action: () => this.refresh() },
      { label: "Paste", disabled: !this._clipboardService.hasContent(), action: () => this._pasteIntoCurrentFolder() },
    ];
    this._contextMenu.show(items, { x, y }, { onClose: () => {} });
  }

  // ---------------------------------------------------------------
  // Properties
  // ---------------------------------------------------------------

  /**
   * @param {string} entryId
   * @returns {Promise<void>}
   */
  async _showProperties(entryId) {
    const entry = this._items.find((item) => item.id === entryId);
    if (!entry) return;

    // Item COUNT (one VFS list() call) rather than a recursive size
    // walk — real folder-size totals would need to walk every
    // descendant, which risks freezing the UI on a large tree; a
    // direct child count is fast and still genuinely useful.
    let sizeLabel = formatBytes(entry.size);
    if (entry.type === "folder") {
      try {
        const children = await this._vfs.list(entry.path);
        sizeLabel = `${children.length} item${children.length === 1 ? "" : "s"}`;
      } catch {
        sizeLabel = "Unknown";
      }
    }

    const parentPath = entry.path.slice(0, entry.path.length - entry.name.length - 1) || "/";

    await showPropertiesDialog({
      title: entry.name,
      rows: [
        { label: "Name", value: entry.name },
        { label: "Type", value: entry.type === "folder" ? "Folder" : entry.extension ? `${entry.extension.toUpperCase()} File` : "File" },
        { label: "Location", value: parentPath },
        { label: "Size", value: sizeLabel },
        { label: "Created", value: formatDate(entry.createdAt) },
        { label: "Modified", value: formatDate(entry.modifiedAt) },
        { label: "Extension", value: entry.extension ?? "\u2014" },
        { label: "Read-only", value: entry.readOnly ? "Yes" : "No" },
        { label: "Hidden", value: entry.hidden ? "Yes" : "No" },
        { label: "Favorite", value: entry.favorite ? "Yes" : "No" },
        { label: "System", value: entry.system ? "Yes" : "No" },
      ],
    });
  }

  /**
   * @param {string} title
   * @param {string} message
   * @returns {Promise<void>}
   */
  async _showErrorDialog(title, message) {
    await showPropertiesDialog({ title, rows: [{ label: "Details", value: message }] });
  }

  // ---------------------------------------------------------------
  // VFS live sync
  // ---------------------------------------------------------------

  /** @returns {void} */
  _wireVfsEvents() {
    const subscribe = (name, handler) => this._eventUnsubscribers.push(eventBus.on(name, handler));

    subscribe("filesystem:fileCreated", ({ entry }) => this._handleMembershipEvent(entry));
    subscribe("filesystem:folderCreated", ({ entry }) => this._handleMembershipEvent(entry));
    subscribe("filesystem:fileCopied", ({ entry }) => this._handleMembershipEvent(entry));
    subscribe("filesystem:fileMoved", ({ entry, oldPath }) => {
      this._handleMembershipEvent(entry);
      this._handleAncestorPathChange(entry, oldPath);
    });
    subscribe("filesystem:fileDeleted", ({ entry }) => this._handleMembershipEvent(entry));
    subscribe("filesystem:fileDeleted", () => this._refreshHomeIfActive());
    subscribe("filesystem:fileRenamed", ({ entry, oldPath }) => this._handleRenameEvent(entry, oldPath));
    subscribe("filesystem:fileRenamed", () => this._refreshHomeIfActive());
    subscribe("filesystem:fileModified", ({ entry }) => this._handleModifiedEvent(entry));
    subscribe("recentFiles:cleared", () => this._refreshHomeIfActive());
    subscribe("clipboard:changed", () => {
      if (!this._searchActive && this._path !== HOME_PATH && this._path !== FAVORITES_PATH) this._renderItemsList();
    });
  }

  /**
   * @param {object} entry
   * @returns {void}
   */
  _handleMembershipEvent(entry) {
    if (this._searchActive) return;
    if (this._path === HOME_PATH || this._path === FAVORITES_PATH) return;

    const belongsHere = entry.parentId === this._currentFolderId;
    const isTracked = this._items.some((item) => item.id === entry.id);

    if (belongsHere && !isTracked) {
      this._items = this._sortItems([...this._items, entry]);
      this._renderItemsList();
    } else if (!belongsHere && isTracked) {
      this._items = this._items.filter((item) => item.id !== entry.id);
      this._selection.delete(entry.id);
      this._renderItemsList();
    } else if (belongsHere && isTracked) {
      this._items = this._sortItems(this._items.map((item) => (item.id === entry.id ? entry : item)));
      this._renderItemsList();
    }
  }

  /**
   * @param {object} entry
   * @param {string} oldPath
   * @returns {void}
   */
  _handleRenameEvent(entry, oldPath) {
    if (!this._searchActive && entry.parentId === this._currentFolderId) {
      const index = this._items.findIndex((item) => item.id === entry.id);
      if (index !== -1) {
        this._items[index] = entry;
        this._items = this._sortItems(this._items);
        this._renderItemsList();
      }
    }
    this._handleAncestorPathChange(entry, oldPath);
  }

  /**
   * If the folder currently being browsed, or an ancestor of it, was
   * just renamed/moved, keep this window pointed at the right place
   * and refresh its breadcrumbs — otherwise this window would keep
   * displaying a path that no longer exists.
   * @param {object} entry
   * @param {string} oldPath
   * @returns {void}
   */
  _handleAncestorPathChange(entry, oldPath) {
    if (this._path === HOME_PATH || this._path === FAVORITES_PATH) return;
    if (this._path === oldPath) {
      this._path = entry.path;
      this._refreshChrome();
      return;
    }
    const oldPrefix = oldPath === "/" ? "/" : `${oldPath}/`;
    if (this._path.startsWith(oldPrefix)) {
      this._path = entry.path + this._path.slice(oldPath.length);
      this._refreshChrome();
    }
  }

  /**
   * @param {object} entry
   * @returns {void}
   */
  _handleModifiedEvent(entry) {
    if (this._searchActive) return;
    if (entry.parentId !== this._currentFolderId) return;
    const index = this._items.findIndex((item) => item.id === entry.id);
    if (index === -1) return;
    this._items[index] = entry;
    this._renderItemsList();
  }
}

export { ExplorerManager, HOME_PATH, FAVORITES_PATH };

// ---------------------------------------------------------------
// Operation notifications
// ---------------------------------------------------------------

/** Item count from which an operation is worth a completion notification. */
const LARGE_OPERATION_ITEMS = 10;
/** Duration from which an operation is worth a completion notification. */
const LARGE_OPERATION_MS = 3000;

/**
 * Routine single-file actions don't notify; bulk or slow ones do.
 * @param {number} count
 * @param {number} startedAt
 * @returns {boolean}
 */
function isLargeOperation(count, startedAt) {
  return count > 0 && (count >= LARGE_OPERATION_ITEMS || Date.now() - startedAt >= LARGE_OPERATION_MS);
}

/**
 * @param {{type: "success"|"error", title: string, message?: string, folderPath: string}} details
 * @returns {void}
 */
function notifyOperation({ type, title, message = "", folderPath }) {
  notificationService.notify({
    type,
    title,
    message: message || `In ${folderPath}`,
    source: "file-explorer",
    groupKey: `explorer:${type}`,
    action: { type: "open", path: folderPath },
  });
}

/**
 * @param {number} count
 * @param {string} noun
 * @returns {string}
 */
function plural(count, noun) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
