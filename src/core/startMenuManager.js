/**
 * @file StartMenuManager — owns Start Menu behavior. Builds a single
 * StartMenuView at construction (never rebuilt), and is the only
 * place that decides what open/close, search, keyboard, and
 * launch-from-menu mean. It talks to AppManager (to list registered
 * apps and to launch them), RecentFilesService (for the Recent Files
 * section), the VFS (file and folder search), SettingsService (every
 * startMenu.* preference), and EventBus — never to WindowManager
 * directly, same rule every other subsystem in BrowserOS follows.
 *
 * Recent applications and recent files are deliberately two separate
 * lists, backed by two separate mechanisms: app launches are cheap
 * to track directly off "app:launched", but opening a *file* is not
 * "an application the user picked" — RecentFilesService (fed by
 * vfsOpener) is what tracks files, and it's the only one that reconciles against the
 * VFS, which is what keeps deleted files out of this list. Recent
 * files are reconciled every time the menu opens, before the list is
 * re-rendered, and again before any recent file is opened.
 *
 * Preferences: section visibility, display limits, pinned apps, and
 * search behavior all come from the `startMenu` settings category and
 * are re-applied on every change, so the menu never needs a reload.
 * The pinned list itself is the `startMenu.pinnedApps` setting; there
 * is no other pinned-apps storage.
 *
 * Search: applications and Settings entries are matched synchronously
 * on every keystroke (both are small, in-memory lists). Files and
 * folders come from `vfs.search()`, which walks IndexedDB, so that
 * lookup is debounced and each query carries a token — results from a
 * superseded query are discarded instead of overwriting newer ones.
 *
 * Requests (EventBus):
 *  - "startmenu:toggle"          toggle open/closed
 *  - "startmenu:clearRecentApps" forget recent applications
 * Events: "startmenu:opened", "startmenu:closed", "startmenu:search",
 * "startmenu:launch", "startmenu:recentAppsCleared".
 */

import { eventBus } from "./eventBus.js";
import { storage } from "./storage.js";
import { settingsService } from "./settings/settingsService.js";
import { searchSettingsIndex, scoreText } from "./settings/settingsIndex.js";
import { keyboardShortcuts } from "./keyboard/keyboardShortcuts.js";
import { StartMenuView } from "../components/start-menu/startMenu.js";
import { openVfsEntry } from "./vfs/vfsOpener.js";

const STORAGE_KEY_RECENTS = "startmenu:recentApps";
/** Stored history is capped at the largest allowed display limit. */
const MAX_STORED_RECENT_APPS = 12;
const VFS_SEARCH_DEBOUNCE_MS = 180;
const TRASH_PREFIX = "/Trash";

const RESULT_KIND_RANK = Object.freeze({ app: 0, setting: 1, folder: 2, file: 3 });

class StartMenuManager {
  /**
   * @param {object} config
   * @param {HTMLElement} config.startButtonEl - Desktop.getStartButton(); excluded from "click outside" detection and used to return focus on close.
   * @param {import("./appManager.js").AppManager} config.appManager
   * @param {import("./vfs/virtualFileSystem.js").vfs} config.vfs - Used to search files/folders and to look up a recent file's current entry before opening it.
   * @param {import("./recentFilesService.js").RecentFilesService} config.recentFilesService
   * @param {{restart: () => void, shutDown: () => void}} [config.powerActions] - Behind the Restart and Shut down buttons.
   */
  constructor(config) {
    this._startButtonEl = config.startButtonEl;
    this._appManager = config.appManager;
    this._vfs = config.vfs;
    this._recentFilesService = config.recentFilesService;

    const power = config.powerActions ?? null;
    this._view = new StartMenuView({
      onSearchInput: (query) => this._handleSearchInput(query),
      onKeyDown: (e) => this._handleMenuKeyDown(e),
      onRestart: power ? () => this._runPowerAction(power.restart) : undefined,
      onShutDown: power ? () => this._runPowerAction(power.shutDown) : undefined,
    });

    /** @type {Readonly<Record<string, *>>} */
    this._prefs = settingsService.getCategory("startMenu");
    /** @type {Array<{appId: string, launchTime: number}>} */
    this._recentApps = [];

    this._searchToken = 0;
    this._vfsSearchTimerId = null;
    /** @type {Array<() => void>} */
    this._unsubscribers = [];

    this._outsideClickHandler = (e) => this._handleOutsideClick(e);
  }

  /**
   * Mount the (already-built) menu, load persisted recents, and wire
   * every event source. Call once during boot.
   * @returns {void}
   */
  init() {
    document.body.append(this._view.getElement());

    const stored = storage.get(STORAGE_KEY_RECENTS, []);
    this._recentApps = Array.isArray(stored) ? stored.filter((entry) => entry && typeof entry.appId === "string") : [];

    this._applyPreferences();

    this._unsubscribers.push(
      eventBus.on("startmenu:toggle", () => this.toggle()),
      // Tray panels ask the menu to close without taking focus back.
      eventBus.on("startmenu:close", (payload) => this.close({ restoreFocus: payload?.restoreFocus !== false })),
      eventBus.on("startmenu:clearRecentApps", () => this.clearRecentApps()),
      eventBus.on("app:launched", ({ appId }) => {
        // Dynamically-registered per-path windows (notes:<path>,
        // file-explorer:<path>) represent an opened *file*, not an
        // application the user chose — RecentFilesService tracks those.
        if (this._appManager.isDynamic(appId)) return;
        this._recordRecentApp(appId);
      }),
      // Pinned tiles and search can only show apps that are registered.
      eventBus.on("app:registered", ({ appId }) => {
        if (!this._appManager.isDynamic(appId)) this._renderPinned();
      }),
      eventBus.on("recentFiles:changed", () => this._renderRecentFiles()),
      settingsService.subscribeCategory("startMenu", () => this._applyPreferences()),
      keyboardShortcuts.bind("startMenu.toggle", () => this.toggle())
    );

    document.addEventListener("pointerdown", this._outsideClickHandler);
  }

  /** @returns {void} */
  toggle() {
    if (this._view.isOpen()) {
      this.close();
    } else {
      this.open();
    }
  }

  /**
   * Safe to call when already open — isOpen() guards inside
   * StartMenuView mean the menu can never end up "opened twice".
   * Opens immediately with the reactively-maintained recent-files
   * list, then reconciles against the VFS and re-renders if anything
   * changed, so the open itself never waits on IndexedDB.
   * @returns {void}
   */
  open() {
    if (this._view.isOpen()) return;
    this._view.open();
    this._startButtonEl.setAttribute("aria-expanded", "true");
    eventBus.emit("startmenu:opened", {});

    this._recentFilesService.reconcile().then(() => this._renderRecentFiles());
  }

  /**
   * Close the menu, then run a Restart or Shut down action.
   * @param {() => (void|Promise<void>)} action
   * @returns {void}
   */
  _runPowerAction(action) {
    this.close({ restoreFocus: false });
    Promise.resolve()
      .then(action)
      .catch((error) => console.error("[StartMenu] power action failed:", error));
  }

  /**
   * @param {{restoreFocus?: boolean}} [options] - Return focus to the Start button (default true).
   * @returns {void}
   */
  close({ restoreFocus = true } = {}) {
    if (!this._view.isOpen()) return;
    this._cancelPendingSearch();
    this._view.close();
    this._startButtonEl.setAttribute("aria-expanded", "false");
    if (restoreFocus) this._startButtonEl.focus();
    eventBus.emit("startmenu:closed", {});
  }

  /**
   * Forget every recent application. Applications themselves are
   * untouched.
   * @returns {void}
   */
  clearRecentApps() {
    this._recentApps = [];
    storage.set(STORAGE_KEY_RECENTS, this._recentApps);
    this._renderRecentApps();
    eventBus.emit("startmenu:recentAppsCleared", Object.freeze({}));
  }

  /**
   * Detach every listener. Intended for tests and teardown.
   * @returns {void}
   */
  destroy() {
    this._cancelPendingSearch();
    for (const unsubscribe of this._unsubscribers) unsubscribe();
    this._unsubscribers = [];
    document.removeEventListener("pointerdown", this._outsideClickHandler);
  }

  // ---------------------------------------------------------------
  // Preferences
  // ---------------------------------------------------------------

  /** @returns {void} */
  _applyPreferences() {
    this._prefs = settingsService.getCategory("startMenu");
    this._view.setSectionVisibility({
      pinned: this._prefs["startMenu.showPinned"],
      recentApps: this._prefs["startMenu.showRecentApps"],
      recentFiles: this._prefs["startMenu.showRecentFiles"],
    });
    this._view.setSearchPlaceholder(this._buildSearchPlaceholder());
    this._renderPinned();
    this._renderRecentApps();
    this._renderRecentFiles();

    // Re-run an active search so new search preferences apply at once.
    const query = this._view.getSearchInput().value;
    if (this._view.isOpen() && query.trim()) this._handleSearchInput(query);
  }

  /** @returns {string} */
  _buildSearchPlaceholder() {
    const sources = [];
    if (this._prefs["startMenu.searchApps"]) sources.push("apps");
    if (this._prefs["startMenu.searchFiles"]) sources.push("files");
    if (this._prefs["startMenu.searchFolders"]) sources.push("folders");
    if (this._prefs["startMenu.searchSettings"]) sources.push("settings");
    if (sources.length === 0) return "Search is turned off in Settings";
    if (sources.length === 1) return `Search ${sources[0]}`;
    return `Search ${sources.slice(0, -1).join(", ")} and ${sources[sources.length - 1]}`;
  }

  /**
   * @returns {Array<{id: string, name: string, icon: string|null}>} User-facing apps only (no per-path windows).
   */
  _getInstalledApps() {
    return this._appManager.getRegisteredApps().filter((app) => !this._appManager.isDynamic(app.id));
  }

  // ---------------------------------------------------------------
  // Pinned / Recent Applications rendering
  // ---------------------------------------------------------------

  /** @returns {void} */
  _renderPinned() {
    const registered = new Map(this._getInstalledApps().map((app) => [app.id, app]));
    const apps = this._prefs["startMenu.pinnedApps"].map((id) => registered.get(id)).filter(Boolean);
    this._view.setPinnedItems(apps, (id) => this._launch(id));
  }

  /** @returns {void} */
  _renderRecentApps() {
    const registered = new Map(this._getInstalledApps().map((app) => [app.id, app]));
    const entries = this._recentApps
      .map((entry) => {
        const app = registered.get(entry.appId);
        if (!app) return null;
        return { id: app.id, name: app.name, icon: app.icon, launchTime: entry.launchTime };
      })
      .filter(Boolean)
      .slice(0, this._prefs["startMenu.recentAppsLimit"]);
    this._view.setRecentItems(entries, (id) => this._launch(id));
  }

  /**
   * @param {string} appId
   * @returns {void}
   */
  _recordRecentApp(appId) {
    this._recentApps = this._recentApps.filter((entry) => entry.appId !== appId);
    this._recentApps.unshift({ appId, launchTime: Date.now() });
    this._recentApps = this._recentApps.slice(0, MAX_STORED_RECENT_APPS);
    storage.set(STORAGE_KEY_RECENTS, this._recentApps);
    this._renderRecentApps();
  }

  // ---------------------------------------------------------------
  // Recent Files rendering
  // ---------------------------------------------------------------

  /** @returns {void} */
  _renderRecentFiles() {
    const entries = this._recentFilesService.getRecent(this._prefs["startMenu.recentFilesLimit"]);
    this._view.setRecentFiles(entries, (path) => this._openRecentFile(path));
  }

  /**
   * @param {string} path
   * @returns {Promise<void>}
   */
  async _openRecentFile(path) {
    this.close();
    try {
      const entry = await this._vfs.getInfo(path);
      await openVfsEntry(entry, { appManager: this._appManager, recentFilesService: this._recentFilesService });
    } catch (error) {
      console.error(`[StartMenuManager] failed to open recent file "${path}":`, error);
      // The file vanished between rendering the list and clicking it
      // — reconcile now so it doesn't linger for next time either.
      this._recentFilesService.reconcile().then(() => this._renderRecentFiles());
    }
  }

  // ---------------------------------------------------------------
  // Search
  // ---------------------------------------------------------------

  /**
   * @param {string} rawQuery
   * @returns {void}
   */
  _handleSearchInput(rawQuery) {
    const query = rawQuery.trim();
    this._cancelPendingSearch();
    const token = ++this._searchToken;
    eventBus.emit("startmenu:search", { query });

    if (!query) {
      this._view.showDefaultSections();
      return;
    }

    const immediate = [...this._searchApps(query), ...this._searchSettingsEntries(query)];
    const wantsVfs = this._prefs["startMenu.searchFiles"] || this._prefs["startMenu.searchFolders"];
    this._renderSearchResults(query, immediate, wantsVfs);

    if (wantsVfs) {
      this._vfsSearchTimerId = window.setTimeout(() => {
        this._vfsSearchTimerId = null;
        this._searchVfs(query, token, immediate);
      }, VFS_SEARCH_DEBOUNCE_MS);
    }
  }

  /** @returns {void} */
  _cancelPendingSearch() {
    if (this._vfsSearchTimerId !== null) {
      window.clearTimeout(this._vfsSearchTimerId);
      this._vfsSearchTimerId = null;
    }
    this._searchToken += 1;
  }

  /**
   * @param {string} query
   * @returns {(text: string) => number} Scores a candidate name against the query.
   */
  _createMatcher(query) {
    const caseInsensitive = this._prefs["startMenu.caseInsensitiveSearch"];
    const needle = caseInsensitive ? query.toLowerCase() : query;
    return (text) => scoreText(caseInsensitive ? text.toLowerCase() : text, needle);
  }

  /**
   * @param {string} query
   * @returns {Array<object>}
   */
  _searchApps(query) {
    if (!this._prefs["startMenu.searchApps"]) return [];
    const score = this._createMatcher(query);
    return this._getInstalledApps()
      .map((app) => ({ app, score: score(app.name) }))
      .filter(({ score: value }) => value > 0)
      .map(({ app, score: value }) => ({
        kind: "app",
        key: `app:${app.id}`,
        name: app.name,
        icon: app.icon,
        detail: app.description || "Application",
        score: value,
        activate: () => this._launch(app.id),
      }));
  }

  /**
   * @param {string} query
   * @returns {Array<object>}
   */
  _searchSettingsEntries(query) {
    if (!this._prefs["startMenu.searchSettings"]) return [];
    const caseSensitive = !this._prefs["startMenu.caseInsensitiveSearch"];
    return searchSettingsIndex(query, { caseSensitive }).map((entry) => ({
      kind: "setting",
      key: `setting:${entry.page}:${entry.anchor}`,
      name: entry.label,
      icon: "icon:gear",
      detail: `Settings \u203a ${entry.pageLabel}`,
      score: entry.score,
      activate: () => this._openSettings(entry.page, entry.anchor),
    }));
  }

  /**
   * @param {string} query
   * @param {number} token
   * @param {Array<object>} immediate - Results already shown, to merge with.
   * @returns {Promise<void>}
   */
  async _searchVfs(query, token, immediate) {
    let entries = [];
    try {
      entries = await this._vfs.search(query, { path: "/" });
    } catch (error) {
      console.error("[StartMenuManager] file search failed:", error);
    }
    if (token !== this._searchToken || !this._view.isOpen()) return; // Superseded or closed.

    const includeFiles = this._prefs["startMenu.searchFiles"];
    const includeFolders = this._prefs["startMenu.searchFolders"];
    const includeHidden = settingsService.get("fileExplorer.showHiddenFiles");
    const score = this._createMatcher(query);

    const vfsResults = [];
    for (const entry of entries) {
      if (entry.path === TRASH_PREFIX || entry.path.startsWith(`${TRASH_PREFIX}/`)) continue;
      if (entry.hidden && !includeHidden) continue;
      const isFolder = entry.type === "folder";
      if ((isFolder && !includeFolders) || (!isFolder && !includeFiles)) continue;
      const value = score(entry.name);
      if (value === 0) continue; // vfs.search is case-insensitive; enforce case sensitivity here.
      vfsResults.push({
        kind: isFolder ? "folder" : "file",
        key: `vfs:${entry.id}`,
        name: entry.name,
        icon: isFolder ? "icon:folder" : "icon:file",
        detail: entry.path,
        score: value,
        activate: () => this._openSearchEntry(entry.path),
      });
    }

    this._renderSearchResults(query, [...immediate, ...vfsResults], false);
  }

  /**
   * @param {string} query
   * @param {Array<object>} results
   * @param {boolean} pending - More results (files/folders) are still being looked up.
   * @returns {void}
   */
  _renderSearchResults(query, results, pending) {
    const prioritize = this._prefs["startMenu.prioritizeApps"];
    const sorted = [...results].sort((a, b) => {
      const rankDiff = RESULT_KIND_RANK[a.kind] - RESULT_KIND_RANK[b.kind];
      if (prioritize && rankDiff !== 0) return rankDiff;
      if (b.score !== a.score) return b.score - a.score;
      if (rankDiff !== 0) return rankDiff;
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });
    this._view.showSearchResults(query, sorted.slice(0, this._prefs["startMenu.searchResultLimit"]), { pending });
  }

  /**
   * @param {string} path
   * @returns {Promise<void>}
   */
  async _openSearchEntry(path) {
    this.close();
    try {
      // Re-read: the entry may have been renamed, moved, or deleted
      // since the results were rendered.
      const entry = await this._vfs.getInfo(path);
      await openVfsEntry(entry, { appManager: this._appManager, recentFilesService: this._recentFilesService });
    } catch (error) {
      console.error(`[StartMenuManager] failed to open "${path}":`, error);
    }
  }

  /**
   * @param {string} page
   * @param {string} [anchor]
   * @returns {void}
   */
  _openSettings(page, anchor) {
    this.close();
    this._appManager.launch("settings", { page, anchor }).catch((error) => {
      console.error("[StartMenuManager] failed to open Settings:", error);
    });
  }

  // ---------------------------------------------------------------
  // Launching
  // ---------------------------------------------------------------

  /**
   * AppManager.launch() already brings an existing single-instance
   * window to the front instead of duplicating it — the Start Menu
   * doesn't need any dedup logic of its own, just to call it.
   * @param {string} id
   * @returns {void}
   */
  _launch(id) {
    eventBus.emit("startmenu:launch", { appId: id });
    this._appManager.launch(id).catch((error) => {
      console.error(`[StartMenuManager] failed to launch "${id}":`, error);
    });
    this.close();
  }

  // ---------------------------------------------------------------
  // Keyboard
  // ---------------------------------------------------------------

  /**
   * Every keydown that occurs inside the menu, forwarded here by
   * StartMenuView. This is the single place Escape/Tab-trap/Arrow
   * nav/Enter-in-search are decided. The Win/Meta toggle is a global
   * shortcut bound in init().
   * @param {KeyboardEvent} e
   * @returns {void}
   */
  _handleMenuKeyDown(e) {
    if (keyboardShortcuts.matches(e, "startMenu.close")) {
      e.preventDefault();
      this.close();
    } else if (e.key === "Tab") {
      this._trapTabFocus(e);
    } else if (keyboardShortcuts.matches(e, "startMenu.next")) {
      e.preventDefault();
      this._moveFocus(1);
    } else if (keyboardShortcuts.matches(e, "startMenu.previous")) {
      e.preventDefault();
      this._moveFocus(-1);
    } else if (keyboardShortcuts.matches(e, "startMenu.launchFirst")) {
      if (document.activeElement === this._view.getSearchInput()) {
        // Launching closes the menu and moves focus to the Start
        // button; without preventDefault the same Enter press would
        // then activate that button and immediately reopen the menu.
        e.preventDefault();
        this._launchFirstVisibleResult();
      }
    }
  }

  /**
   * Keeps Tab/Shift+Tab cycling within the menu while it's open, so
   * focus never leaks out to the page behind it.
   * @param {KeyboardEvent} e
   * @returns {void}
   */
  _trapTabFocus(e) {
    const focusable = this._view.getFocusableElements();
    if (focusable.length === 0) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  /**
   * @param {number} delta - +1 for next, -1 for previous.
   * @returns {void}
   */
  _moveFocus(delta) {
    const focusable = this._view.getFocusableElements();
    if (focusable.length === 0) return;

    const currentIndex = focusable.indexOf(document.activeElement);
    const nextIndex = currentIndex === -1 ? 0 : (currentIndex + delta + focusable.length) % focusable.length;
    focusable[nextIndex]?.focus();
  }

  /** @returns {void} */
  _launchFirstVisibleResult() {
    this._view.getFirstResultButton()?.click();
  }

  // ---------------------------------------------------------------
  // Outside click
  // ---------------------------------------------------------------

  /**
   * pointerdown fires before the Start button's own click handler,
   * so excluding the button here means clicking it to close never
   * races with this "outside click" path — the toggle handler is
   * always what closes it in that case.
   * @param {PointerEvent} e
   * @returns {void}
   */
  _handleOutsideClick(e) {
    if (!this._view.isOpen()) return;
    if (this._view.getElement().contains(e.target)) return;
    if (this._startButtonEl.contains(e.target)) return;
    this.close();
  }
}

export { StartMenuManager };
