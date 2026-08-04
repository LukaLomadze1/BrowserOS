/**
 * @file StartMenuManager — owns Start Menu behavior. Builds a single
 * StartMenuView at construction (never rebuilt), and is the only
 * place that decides what open/close, search, keyboard, and
 * launch-from-menu mean. It talks to AppManager (to list registered
 * apps and to launch them), RecentFilesService (for the Recent Files
 * section), and EventBus (for the existing "startmenu:toggle"
 * trigger from Desktop's Start button, and for "app:launched" to
 * track recent *applications*) — never to WindowManager directly,
 * same rule every other subsystem in BrowserOS follows.
 *
 * Recent applications and recent files are deliberately two separate
 * lists, backed by two separate mechanisms: app launches are cheap
 * to track directly off "app:launched", but a *file*-backed window
 * (opened via a dynamically-registered `notes:<path>` app id) is not
 * "an application the user picked" — RecentFilesService is what
 * tracks those, and it's the only one that reconciles against the
 * VFS, which is what fixes deleted files lingering in this list.
 */

import { eventBus } from "./eventBus.js";
import { storage } from "./storage.js";
import { StartMenuView } from "../components/start-menu/startMenu.js";
import { openVfsEntry } from "./vfs/vfsOpener.js";

const STORAGE_KEY_RECENTS = "startmenu:recentApps";
const MAX_RECENTS = 6;
const DEFAULT_PINNED_IDS = ["about", "calculator", "notes", "recycle-bin"];

class StartMenuManager {
  /**
   * @param {object} config
   * @param {HTMLElement} config.startButtonEl - Desktop.getStartButton(); excluded from "click outside" detection and used to return focus on close.
   * @param {import("./appManager.js").AppManager} config.appManager
   * @param {import("./vfs/virtualFileSystem.js").vfs} config.vfs - Used to look up a recent file's current entry before opening it.
   * @param {import("./recentFilesService.js").RecentFilesService} config.recentFilesService
   * @param {string[]} [config.pinnedIds] - App ids to show in the Pinned section. Defaults cover the four apps that exist so far; reordering or changing this list is the whole surface future pin/unpin UI needs to touch.
   */
  constructor(config) {
    this._startButtonEl = config.startButtonEl;
    this._appManager = config.appManager;
    this._vfs = config.vfs;
    this._recentFilesService = config.recentFilesService;
    this._pinnedIds = config.pinnedIds ?? DEFAULT_PINNED_IDS;

    this._view = new StartMenuView({
      onSearchInput: (query) => this._handleSearchInput(query),
      onKeyDown: (e) => this._handleMenuKeyDown(e),
    });

    /** @type {Array<{appId: string, launchTime: number}>} */
    this._recentApps = [];

    this._globalKeyHandler = (e) => this._handleGlobalKeyDown(e);
    this._outsideClickHandler = (e) => this._handleOutsideClick(e);
  }

  /**
   * Mount the (already-built) menu, load persisted recents, and wire
   * every event source. Call once during boot.
   * @returns {void}
   */
  init() {
    document.body.append(this._view.getElement());

    this._recentApps = storage.get(STORAGE_KEY_RECENTS, []);
    this._renderPinned();
    this._renderRecentApps();
    this._renderRecentFiles(this._recentFilesService.getRecent());

    eventBus.on("startmenu:toggle", () => this.toggle());
    eventBus.on("app:launched", ({ appId }) => {
      // Dynamically-registered per-path windows (notes:<path>,
      // file-explorer:<path>) represent an opened *file*, not an
      // application the user chose — RecentFilesService tracks those.
      if (this._appManager.isDynamic(appId)) return;
      this._recordRecentApp(appId);
    });

    document.addEventListener("keydown", this._globalKeyHandler);
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
   * Opens immediately with whatever recent-files data is already
   * cached, then reconciles against the VFS in the background and
   * re-renders if anything changed — validating on open per spec,
   * without making the open itself feel laggy.
   * @returns {void}
   */
  open() {
    if (this._view.isOpen()) return;
    this._view.open();
    this._startButtonEl.setAttribute("aria-expanded", "true");
    eventBus.emit("startmenu:opened", {});

    this._recentFilesService.reconcile().then((validated) => this._renderRecentFiles(validated));
  }

  /** @returns {void} */
  close() {
    if (!this._view.isOpen()) return;
    this._view.close();
    this._startButtonEl.setAttribute("aria-expanded", "false");
    this._startButtonEl.focus();
    eventBus.emit("startmenu:closed", {});
  }

  // ---------------------------------------------------------------
  // Pinned / Recent Applications rendering
  // ---------------------------------------------------------------

  /** @returns {void} */
  _renderPinned() {
    const registered = new Map(this._appManager.getRegisteredApps().map((app) => [app.id, app]));
    const apps = this._pinnedIds.map((id) => registered.get(id)).filter(Boolean);
    this._view.setPinnedItems(apps, (id) => this._launch(id));
  }

  /** @returns {void} */
  _renderRecentApps() {
    const registered = new Map(this._appManager.getRegisteredApps().map((app) => [app.id, app]));
    const entries = this._recentApps
      .map((entry) => {
        const app = registered.get(entry.appId);
        if (!app) return null;
        return { id: app.id, name: app.name, icon: app.icon, launchTime: entry.launchTime };
      })
      .filter(Boolean);
    this._view.setRecentItems(entries, (id) => this._launch(id));
  }

  /**
   * @param {string} appId
   * @returns {void}
   */
  _recordRecentApp(appId) {
    this._recentApps = this._recentApps.filter((entry) => entry.appId !== appId);
    this._recentApps.unshift({ appId, launchTime: Date.now() });
    this._recentApps = this._recentApps.slice(0, MAX_RECENTS);
    storage.set(STORAGE_KEY_RECENTS, this._recentApps);
    this._renderRecentApps();
  }

  // ---------------------------------------------------------------
  // Recent Files rendering
  // ---------------------------------------------------------------

  /**
   * @param {Array<{entryId: string, path: string, name: string, type: string, lastOpenedAt: number}>} entries
   * @returns {void}
   */
  _renderRecentFiles(entries) {
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
      this._recentFilesService.reconcile().then((validated) => this._renderRecentFiles(validated));
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
    eventBus.emit("startmenu:search", { query });

    if (!query) {
      this._view.showDefaultSections();
      return;
    }

    const lower = query.toLowerCase();
    const matches = this._appManager.getRegisteredApps().filter((app) => app.name.toLowerCase().includes(lower));
    this._view.showSearchResults(query, matches, (id) => this._launch(id));
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
   * Windows-key toggle. Works regardless of what currently has
   * focus, same reasoning as the desktop icons' global Escape fix.
   * @param {KeyboardEvent} e
   * @returns {void}
   */
  _handleGlobalKeyDown(e) {
    if (e.key !== "Meta" || e.repeat) return;
    e.preventDefault();
    this.toggle();
  }

  /**
   * Every keydown that occurs inside the menu, forwarded here by
   * StartMenuView. This is the single place Escape/Tab-trap/Arrow
   * nav/Enter-in-search are decided.
   * @param {KeyboardEvent} e
   * @returns {void}
   */
  _handleMenuKeyDown(e) {
    switch (e.key) {
      case "Escape":
        e.preventDefault();
        this.close();
        break;
      case "Tab":
        this._trapTabFocus(e);
        break;
      case "ArrowDown":
      case "ArrowRight":
        e.preventDefault();
        this._moveFocus(1);
        break;
      case "ArrowUp":
      case "ArrowLeft":
        e.preventDefault();
        this._moveFocus(-1);
        break;
      case "Enter":
        if (document.activeElement === this._view.getSearchInput()) {
          this._launchFirstVisibleResult();
        }
        break;
      default:
        break;
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
    const firstAppButton = this._view.getFocusableElements().find((el) => el.dataset && el.dataset.appId);
    firstAppButton?.click();
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
