/**
 * @file Browser — BrowserOS's web browser.
 *
 * Responsibilities are split so the rendering backend can be replaced
 * (e.g. by a native web view in an Electron or Tauri build) without
 * touching anything else:
 *   - TabSession (tabSession.js): tabs and per-tab navigation history
 *   - renderers/: FrameRenderer (web pages in a sandboxed iframe) and
 *     VfsRenderer (BrowserOS files)
 *   - pages/: built-in pages (start, history, bookmarks, downloads) and
 *     notices (blocked, error)
 *   - core/browser/: history, bookmarks, start-page shortcuts, the
 *     embedding policy, URL parsing, search engines (shared by every
 *     window); core/downloads/: the Download Manager service
 *   - this file: the window's interface and wiring
 *
 * Every window has its own tabs and navigation; history, bookmarks,
 * downloads, and preferences are shared. Private windows
 * (`{ private: true }`) don't record history or remember downloads.
 *
 * Launch options: { url?: string, private?: boolean, path?: string }
 * (`path` opens a BrowserOS file, e.g. an .html file from File Explorer).
 */

import { Application } from "../../core/application.js";
import { eventBus } from "../../core/eventBus.js";
import { settingsService } from "../../core/settings/settingsService.js";
import { keyboardShortcuts } from "../../core/keyboard/keyboardShortcuts.js";
import { historyService } from "../../core/browser/historyService.js";
import { bookmarkService, BAR_FOLDER_ID } from "../../core/browser/bookmarkService.js";
import { framePolicy } from "../../core/browser/framePolicy.js";
import { buildSearchUrl, getSearchEngine } from "../../core/browser/searchEngines.js";
import {
  START_PAGE_URL,
  comparableUrl,
  displayUrl,
  fallbackTitle,
  faviconFor,
  hostOf,
  internalPageOf,
  isWebUrl,
  parseAddressInput,
  securityOf,
  vfsPathOf,
} from "../../core/browser/urlUtils.js";
import { downloadService } from "../../core/downloads/downloadService.js";
import { openVfsEntry } from "../../core/vfs/vfsOpener.js";
import { vfs } from "../../core/vfs/virtualFileSystem.js";
import { ContextMenu } from "../../components/context-menu/contextMenu.js";
import { DownloadList } from "../../components/downloads/downloadList.js";
import { showMessageDialog } from "../../components/dialog/messageDialog.js";
import { createElement, hasModifierKey } from "../../utils/dom.js";
import { createIconElement, renderIcon } from "../../utils/icons.js";
import { ensureStylesheet } from "../../utils/loadStylesheet.js";
import { TabSession } from "./tabSession.js";
import { FrameRenderer, DOWNLOAD_LINK_EXTENSIONS, isSameOrigin } from "./renderers/frameRenderer.js";
import { VfsRenderer } from "./renderers/vfsRenderer.js";
import { StartPage } from "./pages/startPage.js";
import { HistoryPage } from "./pages/historyPage.js";
import { showClearBrowsingDataDialog } from "../../components/dialog/clearBrowsingDataDialog.js";
import { BookmarksPage } from "./pages/bookmarksPage.js";
import { NoticePage } from "./pages/noticePage.js";
import { createFavicon } from "./favicon.js";
import { showFormDialog } from "../../components/dialog/formDialog.js";

ensureStylesheet("src/apps/browser/browser.css");

/** Tabs that keep a live page; older background tabs are unloaded and reload when shown. */
const MAX_LIVE_VIEWS = 6;
const MAX_SUGGESTIONS = 6;

export default class BrowserApp extends Application {
  constructor(meta) {
    super(meta);
    this._private = false;
    /** @type {Map<string, {kind: string, url: string, view: object, element: HTMLElement}>} tabId -> view */
    this._views = new Map();
    /** @type {Map<string, HTMLElement>} tabId -> tab button */
    this._tabEls = new Map();
    this._cleanups = [];
    this._menu = new ContextMenu();
    this._closed = false;
    this._suggestions = [];
    this._suggestionIndex = -1;
    this._sidebarSection = "bookmarks";
    this._embedNoticeTab = null;
  }

  /**
   * @param {{url?: string, private?: boolean, path?: string}} [options]
   * @returns {ReturnType<Application["launch"]>}
   */
  launch(options = {}) {
    this._private = options.private === true;
    this._session = new TabSession({ onChange: (type, tabId) => this._onSessionChange(type, tabId) });
    this._buildDom();

    const on = (name, handler) => this._cleanups.push(eventBus.on(name, handler));
    on("bookmarks:changed", () => {
      this._renderBookmarksBar();
      this._renderToolbar();
      if (this._sidebarOpen()) this._renderSidebar();
    });
    on("bookmarks:ready", () => this._renderBookmarksBar());
    on("browser:historyChanged", () => {
      if (this._sidebarOpen() && this._sidebarSection === "history") this._renderSidebar();
    });
    on("downloads:changed", ({ reason }) => reason !== "progress" && this._renderDownloadsButton());
    this._cleanups.push(
      settingsService.subscribeCategory("browser", () => {
        this._renderBookmarksBar();
        this._renderToolbar();
      })
    );

    const first = options.path ? `vfs://${options.path}` : options.url;
    this._openInNewTab(first ? null : START_PAGE_URL, { input: first ?? null });
    this._renderBookmarksBar();
    this._renderDownloadsButton();

    return {
      element: this._root,
      title: this._windowTitle(),
      icon: this._private ? "icon:shield" : "icon:globe",
      width: 1000,
      height: 680,
      minWidth: 520,
      minHeight: 380,
    };
  }

  /** @returns {void} */
  onFocus() {
    if (this._root.contains(document.activeElement)) return;
    const active = this._session.active();
    const view = active ? this._views.get(active.id) : null;
    const target = view?.view.getFocusTarget?.() ?? (active && internalPageOf(this._session.current(active).url) === "start" ? this._addressInput : this._root);
    target.focus({ preventScroll: true });
  }

  /** @returns {void} */
  close() {
    this._closed = true;
    for (const tabId of [...this._views.keys()]) this._destroyView(tabId);
    for (const cleanup of this._cleanups) cleanup();
    this._cleanups = [];
    this._menu.hide();
    this._downloadsList?.destroy();
    this._sidebarDownloads?.destroy();
  }

  // ---------------------------------------------------------------
  // DOM
  // ---------------------------------------------------------------

  /** @returns {void} */
  _buildDom() {
    const iconButton = (label, icon, onClick, extraClass = "") =>
      createElement("button", {
        className: `browser-icon-button ${extraClass}`.trim(),
        attrs: { type: "button", "aria-label": label, title: label },
        children: [createIconElement(icon)],
        on: { click: onClick },
      });

    // Tab strip
    this._tabsEl = createElement("div", {
      className: "browser__tabs",
      attrs: { role: "tablist", "aria-label": "Tabs" },
      on: {
        wheel: (e) => {
          if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
            this._tabsEl.scrollLeft += e.deltaY;
            e.preventDefault();
          }
        },
        keydown: (e) => this._tabStripKeys(e),
      },
    });
    const tabbar = createElement("div", {
      className: "browser__tabbar",
      children: [
        ...(this._private ? [createElement("span", { className: "browser__private-badge", children: [createIconElement("icon:shield"), createElement("span", { text: "Private" })] })] : []),
        this._tabsEl,
        iconButton("New tab (Alt + T)", "icon:plus", () => this._openInNewTab(START_PAGE_URL), "browser__new-tab"),
      ],
    });

    // Toolbar
    this._backButton = iconButton("Back (Alt + \u2190)", "icon:arrowLeft", () => this._go(-1));
    this._forwardButton = iconButton("Forward (Alt + \u2192)", "icon:arrowRight", () => this._go(1));
    this._reloadButton = iconButton("Reload (Ctrl + R)", "icon:reload", () => this._reloadOrStop());
    const homeButton = iconButton("Home (Alt + Home)", "icon:home", () => this._goHome());
    this._securityButton = createElement("button", {
      className: "browser__security",
      attrs: { type: "button" },
      on: { click: (e) => this._showSiteInfo(e.currentTarget) },
    });
    this._addressInput = createElement("input", {
      className: "browser__address",
      attrs: {
        type: "text",
        autocomplete: "off",
        spellcheck: "false",
        "aria-label": "Address and search bar",
        role: "combobox",
        "aria-expanded": "false",
        "aria-autocomplete": "list",
        "aria-controls": "",
      },
      on: {
        focus: () => this._addressInput.select(),
        input: () => this._updateSuggestions(),
        keydown: (e) => this._addressKeys(e),
        blur: () => window.setTimeout(() => this._hideSuggestions(), 120),
      },
    });
    this._suggestionsEl = createElement("ul", { className: "browser__suggestions", attrs: { role: "listbox", hidden: "" } });
    this._suggestionsEl.id = `browser-suggestions-${Math.random().toString(36).slice(2, 8)}`;
    this._addressInput.setAttribute("aria-controls", this._suggestionsEl.id);
    this._starButton = iconButton("Bookmark this page (Ctrl + D)", "icon:star", () => this._toggleBookmarkPopover(), "browser__star");
    const omnibox = createElement("div", {
      className: "browser__omnibox",
      children: [this._securityButton, this._addressInput, this._starButton, this._suggestionsEl],
    });
    this._downloadsBadge = createElement("span", { className: "browser__badge", attrs: { hidden: "", "aria-hidden": "true" } });
    this._downloadsButton = createElement("button", {
      className: "browser-icon-button browser__downloads-button",
      attrs: { type: "button", "aria-label": "Downloads (Ctrl + J)", title: "Downloads (Ctrl + J)", "aria-haspopup": "dialog", "aria-expanded": "false" },
      children: [createIconElement("icon:download"), this._downloadsBadge],
      on: { click: () => this._toggleDownloadsPanel() },
    });
    this._sidebarButton = iconButton("Sidebar", "icon:sidebar", () => this._toggleSidebar());
    this._sidebarButton.setAttribute("aria-pressed", "false");
    const menuButton = iconButton("Browser menu", "icon:more", (e) => this._showMenu(e.currentTarget));
    const toolbar = createElement("div", {
      className: "browser__toolbar",
      attrs: { role: "toolbar", "aria-label": "Navigation" },
      children: [this._backButton, this._forwardButton, this._reloadButton, homeButton, omnibox, this._downloadsButton, this._sidebarButton, menuButton],
    });

    this._progressEl = createElement("div", { className: "browser__progress", attrs: { role: "progressbar", "aria-label": "Page loading", hidden: "" } });
    this._bookmarksBarEl = createElement("div", { className: "browser__bookmarks-bar", attrs: { role: "toolbar", "aria-label": "Bookmarks bar" } });
    this._infoBarEl = createElement("div", { className: "browser__infobar", attrs: { role: "status", hidden: "" } });
    this._viewportEl = createElement("div", { className: "browser__viewport" });
    this._sidebarEl = createElement("aside", { className: "browser__sidebar", attrs: { "aria-label": "Sidebar", hidden: "" } });
    this._popoverEl = createElement("div", { className: "browser__popover", attrs: { role: "dialog", hidden: "" } });

    this._root = createElement("div", {
      className: `browser${this._private ? " browser--private" : ""}`,
      attrs: { tabindex: "-1" },
      children: [
        tabbar,
        toolbar,
        this._progressEl,
        this._bookmarksBarEl,
        this._infoBarEl,
        createElement("div", { className: "browser__main", children: [this._viewportEl, this._sidebarEl] }),
        this._popoverEl,
      ],
      on: { keydown: (e) => this._handleKeydown(e) },
    });
    this._popoverOutside = (e) => {
      if (this._popoverEl.hidden) return;
      if (this._popoverEl.contains(e.target) || this._popoverAnchor?.contains(e.target)) return;
      if (e.target instanceof Element && e.target.closest(".dialog, .context-menu")) return;
      this._closePopover();
    };
    document.addEventListener("pointerdown", this._popoverOutside, true);
    this._cleanups.push(() => document.removeEventListener("pointerdown", this._popoverOutside, true));
  }

  // ---------------------------------------------------------------
  // Tabs
  // ---------------------------------------------------------------

  /**
   * @param {string|null} url
   * @param {{input?: string|null, active?: boolean, index?: number}} [options]
   * @returns {object} The new tab.
   */
  _openInNewTab(url, { input = null, active = true, index } = {}) {
    let target = url ?? START_PAGE_URL;
    let error = null;
    if (input) {
      // A tab opened with an address starts there (no start-page entry to go back to).
      const result = parseAddressInput(input, { searchEngine: settingsService.get("browser.searchEngine") });
      if (result.type === "external") openExternally(result.url);
      else if (result.type === "error") {
        target = input.trim();
        error = result.message;
      } else if (result.url) target = result.url;
    }
    if (isDownloadUrl(target)) {
      this._startDownload(target, null);
      target = START_PAGE_URL;
    }
    const tab = this._session.createTab({ url: target, active, index });
    if (error) this._session.updateTab(tab.id, { state: "error", error });
    if (active) this._showEntry(this._session.get(tab.id), { force: Boolean(error) });
    return tab;
  }

  /**
   * @param {string} tabId
   * @returns {void}
   */
  _closeTab(tabId) {
    const tab = this._session.get(tabId);
    if (!tab) return;
    if (this._session.tabs.length === 1) {
      // Closing the last tab closes the window.
      this.appManager.closeWindow(this.windowId);
      return;
    }
    this._destroyView(tabId);
    this._session.closeTab(tabId);
  }

  /**
   * @param {"tabs"|"tab"} type
   * @param {string|null} tabId
   * @returns {void}
   */
  _onSessionChange(type, tabId) {
    if (this._closed || !this._tabsEl) return;
    if (type === "tabs") {
      this._renderTabs();
      this._showActiveView();
    } else if (tabId) {
      this._updateTabElement(tabId);
    }
    if (tabId === this._session.activeId || type === "tabs") this._renderToolbar();
  }

  /** @returns {void} */
  _renderTabs() {
    const ids = new Set(this._session.tabs.map((tab) => tab.id));
    for (const [id, el] of this._tabEls) {
      if (!ids.has(id)) {
        el.remove();
        this._tabEls.delete(id);
      }
    }
    const ordered = this._session.tabs.map((tab) => this._tabElement(tab));
    const current = [...this._tabsEl.children];
    if (current.length !== ordered.length || current.some((el, index) => el !== ordered[index])) this._tabsEl.replaceChildren(...ordered);
    for (const tab of this._session.tabs) this._updateTabElement(tab.id);
    this._tabEls.get(this._session.activeId)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  /**
   * @param {object} tab
   * @returns {HTMLElement}
   */
  _tabElement(tab) {
    let el = this._tabEls.get(tab.id);
    if (el) return el;
    const iconSlot = createElement("span", { className: "browser-tab__icon" });
    const title = createElement("span", { className: "browser-tab__title" });
    const close = createElement("button", {
      className: "browser-tab__close",
      attrs: { type: "button", tabindex: "-1", title: "Close tab (Alt + W)" },
      children: [createIconElement("icon:close")],
      on: {
        click: (e) => {
          e.stopPropagation();
          this._closeTab(tab.id);
        },
      },
    });
    el = createElement("div", {
      className: "browser-tab",
      attrs: { role: "tab", tabindex: "-1", "data-tab-id": tab.id },
      children: [iconSlot, title, close],
      on: {
        click: () => this._session.activate(tab.id),
        auxclick: (e) => {
          if (e.button === 1) {
            e.preventDefault();
            this._closeTab(tab.id);
          }
        },
        contextmenu: (e) => {
          e.preventDefault();
          this._showTabMenu(tab.id, e.clientX, e.clientY);
        },
      },
    });
    el._parts = { iconSlot, title, close, iconKey: "" };
    this._tabEls.set(tab.id, el);
    return el;
  }

  /**
   * @param {string} tabId
   * @returns {void}
   */
  _updateTabElement(tabId) {
    const tab = this._session.get(tabId);
    const el = this._tabEls.get(tabId);
    if (!tab || !el) return;
    const entry = this._session.current(tab);
    const title = entry.title || fallbackTitle(entry.url);
    const active = tab.id === this._session.activeId;
    if (el._parts.title.textContent !== title) el._parts.title.textContent = title;
    el.title = displayUrl(entry.url) ? `${title}\n${entry.url}` : title;
    el.setAttribute("aria-selected", String(active));
    el.setAttribute("aria-label", `${title}${tab.loading ? ", loading" : ""}${tab.state === "discarded" ? ", unloaded" : ""}`);
    el.tabIndex = active ? 0 : -1;
    el.classList.toggle("browser-tab--active", active);
    el.classList.toggle("browser-tab--loading", tab.loading);
    el.classList.toggle("browser-tab--discarded", tab.state === "discarded");
    el._parts.close.setAttribute("aria-label", `Close ${title}`);
    const iconKey = tab.loading ? "loading" : `${entry.url}|${entry.favicon ?? ""}`;
    if (el._parts.iconKey !== iconKey) {
      el._parts.iconKey = iconKey;
      el._parts.iconSlot.replaceChildren(tab.loading ? createElement("span", { className: "browser-spinner", attrs: { "aria-hidden": "true" } }) : createFavicon(entry.url, entry.favicon));
    }
    if (active) this._updateWindowTitle();
  }

  /**
   * @param {KeyboardEvent} e
   * @returns {void}
   */
  _tabStripKeys(e) {
    if (hasModifierKey(e)) return;
    const tabs = this._session.tabs;
    const index = tabs.findIndex((tab) => tab.id === this._session.activeId);
    let next = null;
    if (e.key === "ArrowRight") next = tabs[(index + 1) % tabs.length];
    else if (e.key === "ArrowLeft") next = tabs[(index - 1 + tabs.length) % tabs.length];
    else if (e.key === "Home") next = tabs[0];
    else if (e.key === "End") next = tabs[tabs.length - 1];
    else if (e.key === "Delete") {
      e.preventDefault();
      this._closeTab(this._session.activeId);
      this._tabEls.get(this._session.activeId)?.focus();
      return;
    }
    if (!next) return;
    e.preventDefault();
    this._session.activate(next.id);
    this._tabEls.get(next.id)?.focus();
  }

  /**
   * @param {string} tabId
   * @param {number} x
   * @param {number} y
   * @returns {void}
   */
  _showTabMenu(tabId, x, y) {
    const tab = this._session.get(tabId);
    if (!tab) return;
    const entry = this._session.current(tab);
    this._menu.show(
      [
        { label: "New tab", action: () => this._openInNewTab(START_PAGE_URL, { index: this._session.tabs.indexOf(tab) + 1 }) },
        { label: "Reload", action: () => this._reload(tabId) },
        { label: "Duplicate", action: () => this._duplicate(tabId) },
        { label: "Bookmark tab", disabled: !canBookmark(entry.url), action: () => this._bookmarkUrl(entry.url, entry.title) },
        { separator: true },
        { label: "Close tab", action: () => this._closeTab(tabId) },
        {
          label: "Close other tabs",
          disabled: this._session.tabs.length < 2,
          action: () => {
            for (const other of [...this._session.tabs]) if (other.id !== tabId) this._closeTab(other.id);
          },
        },
        { label: "Reopen closed tab", disabled: this._session.closed.length === 0, action: () => this._reopenClosed() },
      ],
      { x, y }
    );
  }

  /**
   * @param {string} tabId
   * @returns {void}
   */
  _duplicate(tabId) {
    const copy = this._session.duplicate(tabId);
    if (copy) this._showEntry(copy);
  }

  /** @returns {void} */
  _reopenClosed() {
    const tab = this._session.reopenClosed();
    if (tab) this._showEntry(tab);
  }

  // ---------------------------------------------------------------
  // Navigation
  // ---------------------------------------------------------------

  /**
   * Navigate a tab to what the user typed (address or search).
   * @param {string} tabId
   * @param {string} text
   * @returns {void}
   */
  _navigateInput(tabId, text) {
    const result = parseAddressInput(text, { searchEngine: settingsService.get("browser.searchEngine") });
    if (result.type === "empty") return;
    if (result.type === "external") {
      openExternally(result.url);
      return;
    }
    const tab = this._session.get(tabId);
    if (!tab) return;
    if (result.type === "error") {
      this._session.navigate(tabId, text.trim());
      this._session.updateTab(tabId, { state: "error", error: result.message });
      this._showEntry(this._session.get(tabId));
      return;
    }
    this._navigate(tabId, result.url);
  }

  /**
   * @param {string} tabId
   * @param {string} url
   * @returns {void}
   */
  _navigate(tabId, url) {
    if (isDownloadUrl(url)) {
      this._startDownload(url, null);
      return;
    }
    this._session.navigate(tabId, url);
    const tab = this._session.get(tabId);
    if (tab.id === this._session.activeId) this._showEntry(tab);
    else this._session.updateTab(tab.id, { state: "discarded" });
  }

  /**
   * Open a URL from a page, bookmark, or history entry.
   * @param {string} url
   * @param {{newTab?: boolean}} [options]
   * @returns {void}
   */
  _openUrl(url, { newTab = false } = {}) {
    if (newTab) {
      const tab = this._session.createTab({ url, active: false, index: this._session.tabs.indexOf(this._session.active()) + 1 });
      this._session.updateTab(tab.id, { state: "discarded" });
      return;
    }
    this._navigate(this._session.activeId, url);
  }

  /**
   * @param {number} delta
   * @returns {void}
   */
  _go(delta) {
    const tab = this._session.active();
    if (!tab) return;
    if (this._session.go(tab.id, delta)) this._showEntry(tab);
  }

  /** @returns {void} */
  _goHome() {
    const homepage = settingsService.get("browser.homepage");
    this._navigate(this._session.activeId, homepage || START_PAGE_URL);
  }

  /** @returns {void} */
  _reloadOrStop() {
    const tab = this._session.active();
    if (!tab) return;
    if (tab.loading) this._stop(tab.id);
    else this._reload(tab.id);
  }

  /**
   * @param {string} tabId
   * @returns {void}
   */
  _reload(tabId) {
    const tab = this._session.get(tabId);
    if (!tab) return;
    const view = this._views.get(tabId);
    if (view && typeof view.view.reload === "function" && tab.state === "page") {
      this._session.updateTab(tabId, { navigatedInPage: false });
      view.view.reload();
    } else {
      if (tab.state !== "error") this._session.updateTab(tabId, { state: "page", error: null });
      this._showEntry(tab, { force: true });
    }
  }

  /**
   * @param {string} tabId
   * @returns {void}
   */
  _stop(tabId) {
    this._views.get(tabId)?.view.stop?.();
    this._session.updateTab(tabId, { loading: false });
    this._renderProgress();
  }

  // ---------------------------------------------------------------
  // Views
  // ---------------------------------------------------------------

  /** Show the active tab's view, creating it if needed. @returns {void} */
  _showActiveView() {
    const tab = this._session.active();
    for (const [id, view] of this._views) view.element.hidden = id !== tab?.id;
    if (!tab) return;
    const view = this._views.get(tab.id);
    const entry = this._session.current(tab);
    if (!view || view.url !== entry.url || tab.state === "discarded") this._showEntry(tab);
    this._renderInfoBar();
    this._renderProgress();
  }

  /**
   * Render a tab's current entry into its view.
   * @param {object} tab
   * @param {{force?: boolean}} [options]
   * @returns {void}
   */
  _showEntry(tab, { force = false } = {}) {
    if (!tab || this._closed) return;
    const entry = this._session.current(tab);
    const existing = this._views.get(tab.id);
    if (existing && existing.url === entry.url && existing.state === tab.state && !force && tab.state !== "discarded") {
      this._showActiveViewElement();
      return;
    }
    this._destroyView(tab.id);
    if (tab.state === "discarded") this._session.updateTab(tab.id, { state: "page" });
    if (this._embedNoticeTab === tab.id) this._embedNoticeTab = null;

    const url = entry.url;
    let kind;
    let view;
    const element = createElement("div", { className: "browser__view", attrs: { "data-tab-id": tab.id } });

    if (tab.state === "error") {
      kind = "notice";
      view = this._errorNotice(tab, url, tab.error ?? "This address can't be opened.");
    } else if (internalPageOf(url)) {
      kind = "internal";
      view = this._createInternalPage(internalPageOf(url));
      this._session.updateEntry(tab.id, { title: view.title, favicon: null });
      this._session.updateTab(tab.id, { loading: false });
    } else if (vfsPathOf(url)) {
      kind = "vfs";
      view = new VfsRenderer(this._rendererCallbacks(tab.id), (path) => this._openVfsPath(path));
      view.load(vfsPathOf(url));
      this._recordVisit(url, null);
    } else if (isWebUrl(url)) {
      const decision = framePolicy.decide(url);
      this._recordVisit(url, faviconFor(url));
      if (decision === "embed") {
        kind = "frame";
        view = new FrameRenderer(this._rendererCallbacks(tab.id));
        view.load(url);
      } else {
        kind = "notice";
        this._session.updateTab(tab.id, { state: "blocked", loading: false });
        this._session.updateEntry(tab.id, { title: fallbackTitle(url), favicon: faviconFor(url) });
        view = decision === "external" ? this._externalChoiceNotice(tab, url) : this._refusalNotice(tab, url);
      }
    } else if (url === "about:blank") {
      kind = "internal";
      view = { element: createElement("div", { className: "browser-blank" }), title: "Blank page", destroy() {} };
      this._session.updateEntry(tab.id, { title: "Blank page" });
    } else {
      kind = "notice";
      view = this._errorNotice(tab, url, "This address can't be opened.");
    }

    element.append(view.element);
    this._viewportEl.append(element);
    this._views.set(tab.id, { kind, url, view, element, state: this._session.get(tab.id)?.state ?? "page" });
    this._showActiveViewElement();
    this._enforceLiveLimit();
    this._renderToolbar();
    this._renderInfoBar();
  }

  /** @returns {void} */
  _showActiveViewElement() {
    for (const [id, view] of this._views) view.element.hidden = id !== this._session.activeId;
  }

  /**
   * @param {string} tabId
   * @returns {void}
   */
  _destroyView(tabId) {
    const view = this._views.get(tabId);
    if (!view) return;
    try {
      view.view.destroy?.();
    } catch (error) {
      console.error("[Browser] view cleanup failed:", error);
    }
    view.element.remove();
    this._views.delete(tabId);
  }

  /**
   * Unload the least recently used background tabs beyond the limit;
   * they keep their history and reload when shown again.
   * @returns {void}
   */
  _enforceLiveLimit() {
    if (this._views.size <= MAX_LIVE_VIEWS) return;
    const candidates = this._session.tabs
      .filter((tab) => tab.id !== this._session.activeId && this._views.has(tab.id))
      .sort((a, b) => a.lastActive - b.lastActive);
    while (this._views.size > MAX_LIVE_VIEWS && candidates.length) {
      const tab = candidates.shift();
      this._destroyView(tab.id);
      this._session.updateTab(tab.id, { state: "discarded", loading: false });
    }
  }

  /**
   * @param {string} tabId
   * @returns {object} Renderer callbacks bound to a tab.
   */
  _rendererCallbacks(tabId) {
    return {
      onLoadStart: () => {
        this._session.updateTab(tabId, { loading: true });
        this._renderProgress();
      },
      onLoadEnd: ({ title, favicon, url }) => {
        const tab = this._session.get(tabId);
        if (!tab) return;
        if (url && isSameOrigin(url) && comparableUrl(url) !== comparableUrl(this._session.current(tab).url)) {
          this._session.recordInPageNavigation(tabId, url);
          const view = this._views.get(tabId);
          if (view) view.url = url;
        }
        const entry = this._session.current(tab);
        const patch = {};
        if (title) patch.title = title;
        if (favicon) patch.favicon = favicon;
        else if (!entry.favicon && isWebUrl(entry.url)) patch.favicon = faviconFor(entry.url);
        this._session.updateEntry(tabId, patch);
        this._session.updateTab(tabId, { loading: false });
        if (title || favicon) historyService.updatePage(entry.url, { title, favicon });
        if (!url && isWebUrl(entry.url) && !isSameOrigin(entry.url)) this._offerEmbedNotice(tabId);
        this._renderProgress();
      },
      onInPageNavigation: ({ url }) => {
        if (url) return; // Same-origin: handled in onLoadEnd with the real address.
        this._session.updateTab(tabId, { navigatedInPage: true });
      },
      onDownloadRequest: ({ url, filename }) => this._startDownload(url, filename),
      onError: ({ kind, message }) => {
        const tab = this._session.get(tabId);
        if (!tab) return;
        this._session.updateTab(tabId, { loading: false, state: "error", error: kind === "timeout" ? `${message} The site may be down, or your connection may be offline.` : message });
        this._showEntry(this._session.get(tabId), { force: true });
        this._renderProgress();
      },
    };
  }

  /**
   * @param {string} page
   * @returns {object}
   */
  _createInternalPage(page) {
    const navigate = (url, options) => this._openUrl(url, options);
    switch (page) {
      case "start":
        return new StartPage({ private: this._private, navigate, submitAddress: (text) => this._navigateInput(this._session.activeId, text) });
      case "history":
        return new HistoryPage({ private: this._private, navigate });
      case "bookmarks":
        return new BookmarksPage({ navigate });
      case "downloads":
      default: {
        const list = new DownloadList();
        return {
          title: "Downloads",
          element: createElement("div", {
            className: "browser-page",
            children: [
              createElement("header", {
                className: "browser-page__header",
                children: [
                  createElement("h1", { className: "browser-page__title", text: "Downloads" }),
                  createElement("button", {
                    className: "browser-button",
                    attrs: { type: "button" },
                    text: "Open Download Manager",
                    on: { click: () => this.appManager.launch("downloads").catch(() => {}) },
                  }),
                ],
              }),
              list.getElement(),
            ],
          }),
          destroy: () => list.destroy(),
        };
      }
    }
  }

  /**
   * @param {object} tab
   * @param {string} url
   * @returns {NoticePage}
   */
  _refusalNotice(tab, url) {
    const host = hostOf(url);
    return new NoticePage({
      icon: "icon:external",
      title: `${host} can't be shown inside BrowserOS`,
      paragraphs: [
        `${host} tells browsers not to display it inside other pages, and BrowserOS runs inside your web browser. This protects the site and you, so BrowserOS doesn't work around it.`,
        "You can open the page in your browser instead. Your tabs, bookmarks, and history here keep working.",
      ],
      url,
      actions: [
        { label: "Open in your browser", primary: true, onClick: () => openExternally(url) },
        {
          label: "Always open this site in your browser",
          onClick: () => {
            framePolicy.setSiteChoice(url, "external");
            openExternally(url);
            this._showEntry(this._session.get(tab.id), { force: true });
          },
        },
        {
          label: "Show here anyway",
          onClick: () => {
            framePolicy.setSiteChoice(url, "embed");
            this._session.updateTab(tab.id, { state: "page" });
            this._showEntry(this._session.get(tab.id), { force: true });
          },
        },
      ],
    });
  }

  /**
   * @param {object} tab
   * @param {string} url
   * @returns {NoticePage}
   */
  _externalChoiceNotice(tab, url) {
    const host = hostOf(url);
    return new NoticePage({
      icon: "icon:external",
      title: `${host} opens in your browser`,
      paragraphs: [`You chose to open ${host} in your web browser instead of inside BrowserOS.`],
      url,
      actions: [
        { label: "Open in your browser", primary: true, onClick: () => openExternally(url) },
        {
          label: "Show it here instead",
          onClick: () => {
            framePolicy.setSiteChoice(url, null);
            this._session.updateTab(tab.id, { state: "page" });
            this._showEntry(this._session.get(tab.id), { force: true });
          },
        },
      ],
    });
  }

  /**
   * @param {object} tab
   * @param {string} url
   * @param {string} message
   * @returns {NoticePage}
   */
  _errorNotice(tab, url, message) {
    const actions = [{ label: "Try again", primary: true, onClick: () => this._retryEntry(tab.id) }];
    if (isWebUrl(url)) actions.push({ label: "Open in your browser", onClick: () => openExternally(url) });
    actions.push({ label: "Go to start page", onClick: () => this._navigate(tab.id, START_PAGE_URL) });
    this._session.updateEntry(tab.id, { title: "Can't open this page" });
    return new NoticePage({ icon: "icon:warning", tone: "warning", title: "Can't open this page", paragraphs: [message], url, actions });
  }

  /**
   * @param {string} tabId
   * @returns {void}
   */
  _retryEntry(tabId) {
    const tab = this._session.get(tabId);
    if (!tab) return;
    const url = this._session.current(tab).url;
    const reparsed = parseAddressInput(url, { searchEngine: settingsService.get("browser.searchEngine") });
    if (reparsed.type === "error") {
      this._addressInput.focus();
      return;
    }
    this._session.updateTab(tabId, { state: "page", error: null });
    this._showEntry(this._session.get(tabId), { force: true });
  }

  /**
   * @param {string} url
   * @param {string|null} favicon
   * @returns {void}
   */
  _recordVisit(url, favicon) {
    historyService.recordVisit(url, { title: fallbackTitle(url), favicon, private: this._private });
  }

  /**
   * @param {string} path
   * @returns {Promise<void>}
   */
  async _openVfsPath(path) {
    try {
      await openVfsEntry(await vfs.getInfo(path), { appManager: this.appManager, recentFilesService: this.recentFilesService });
    } catch (error) {
      await showMessageDialog({ title: "Can't open this file", message: error.message });
    }
  }

  // ---------------------------------------------------------------
  // Toolbar
  // ---------------------------------------------------------------

  /** @returns {void} */
  _renderToolbar() {
    const tab = this._session?.active();
    if (!tab || !this._addressInput) return;
    const entry = this._session.current(tab);
    const { back, forward } = this._session.canGo(tab);
    this._backButton.disabled = !back;
    this._forwardButton.disabled = !forward;
    renderIcon(this._reloadButton, tab.loading ? "icon:close" : "icon:reload");
    const reloadLabel = tab.loading ? "Stop loading (Esc)" : "Reload (Ctrl + R)";
    this._reloadButton.setAttribute("aria-label", reloadLabel);
    this._reloadButton.title = reloadLabel;
    if (document.activeElement !== this._addressInput) this._addressInput.value = displayUrl(entry.url);
    const engine = getSearchEngine(settingsService.get("browser.searchEngine"));
    this._addressInput.placeholder = `Search with ${engine.name} or enter an address`;

    const security = this._private && securityOf(entry.url) === "internal" ? "private" : securityOf(entry.url);
    const securityInfo = {
      secure: ["icon:lock", "Connection is encrypted (https)"],
      insecure: ["icon:lock-open", "Not secure: this connection isn't encrypted (http)"],
      internal: ["icon:globe", "BrowserOS page"],
      file: ["icon:file", "File from the BrowserOS file system"],
      private: ["icon:shield", "Private window"],
      none: ["icon:globe", "Page information"],
    }[security];
    renderIcon(this._securityButton, securityInfo[0]);
    this._securityButton.dataset.security = security;
    this._securityButton.setAttribute("aria-label", `${securityInfo[1]}. Page information`);
    this._securityButton.title = tab.navigatedInPage ? `${securityInfo[1]}. The page navigated by itself; the address shows where it started.` : securityInfo[1];
    this._root.classList.toggle("browser--navigated-in-page", tab.navigatedInPage);

    const bookmarked = canBookmark(entry.url) && bookmarkService.isBookmarked(entry.url);
    renderIcon(this._starButton, bookmarked ? "icon:star-filled" : "icon:star");
    this._starButton.disabled = !canBookmark(entry.url);
    this._starButton.setAttribute("aria-pressed", String(bookmarked));
    this._starButton.classList.toggle("browser__star--on", bookmarked);
    this._starButton.setAttribute("aria-label", bookmarked ? "Edit bookmark (Ctrl + D)" : "Bookmark this page (Ctrl + D)");
    this._renderProgress();
  }

  /** @returns {void} */
  _renderProgress() {
    const tab = this._session?.active();
    this._progressEl.hidden = !tab?.loading;
  }

  /** @returns {void} */
  _updateWindowTitle() {
    if (this.windowId) this.appManager.updateWindowTitle(this.windowId, this._windowTitle());
  }

  /** @returns {string} */
  _windowTitle() {
    const tab = this._session?.active();
    const entry = tab ? this._session.current(tab) : null;
    const title = entry ? entry.title || fallbackTitle(entry.url) : "New tab";
    return `${title} \u2014 ${this._private ? "Private Browser" : "Browser"}`;
  }

  /** @returns {void} */
  _renderDownloadsButton() {
    const active = downloadService.getActiveCount();
    this._downloadsBadge.hidden = active === 0;
    this._downloadsBadge.textContent = String(active);
    const label = active ? `Downloads, ${active} in progress (Ctrl + J)` : "Downloads (Ctrl + J)";
    this._downloadsButton.setAttribute("aria-label", label);
    this._downloadsButton.title = label;
  }

  // ---------------------------------------------------------------
  // Address bar
  // ---------------------------------------------------------------

  /**
   * @param {KeyboardEvent} e
   * @returns {void}
   */
  _addressKeys(e) {
    if (e.key === "Enter" && !e.altKey) {
      e.preventDefault();
      const chosen = this._suggestions[this._suggestionIndex];
      const value = chosen ? chosen.url : this._addressInput.value;
      this._hideSuggestions();
      if (chosen) this._navigate(this._session.activeId, chosen.url);
      else this._navigateInput(this._session.activeId, value);
      this._addressInput.blur();
      this._focusActiveView();
    } else if (e.key === "Escape") {
      if (!this._suggestionsEl.hidden) {
        e.preventDefault();
        e.stopPropagation();
        this._hideSuggestions();
        return;
      }
      const tab = this._session.active();
      if (tab) {
        e.preventDefault();
        e.stopPropagation();
        this._addressInput.value = displayUrl(this._session.current(tab).url);
        this._addressInput.select();
      }
    } else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !hasModifierKey(e) && this._suggestions.length) {
      e.preventDefault();
      const count = this._suggestions.length;
      this._suggestionIndex = e.key === "ArrowDown" ? (this._suggestionIndex + 1) % count : (this._suggestionIndex - 1 + count) % count;
      this._renderSuggestions();
    }
  }

  /** @returns {void} */
  _updateSuggestions() {
    const text = this._addressInput.value.trim();
    if (!text) {
      this._hideSuggestions();
      return;
    }
    const seen = new Set();
    const items = [];
    const push = (item) => {
      const key = comparableUrl(item.url);
      if (seen.has(key) || items.length >= MAX_SUGGESTIONS) return;
      seen.add(key);
      items.push(item);
    };
    for (const bookmark of bookmarkService.search(text, 3)) push({ kind: "bookmark", title: bookmark.title, url: bookmark.url });
    if (!this._private) for (const record of historyService.search(text, 5)) push({ kind: "history", title: record.title, url: record.url, favicon: record.favicon });
    const parsed = parseAddressInput(text, { searchEngine: settingsService.get("browser.searchEngine") });
    const engine = getSearchEngine(settingsService.get("browser.searchEngine"));
    if (parsed.type === "url") items.unshift({ kind: "url", title: parsed.url, url: parsed.url });
    if (parsed.type === "search" || parsed.type === "url") {
      items.push({ kind: "search", title: `Search ${engine.name} for \u201c${text}\u201d`, url: buildSearchUrl(engine.id, text) });
    }
    this._suggestions = items.slice(0, MAX_SUGGESTIONS + 1);
    this._suggestionIndex = -1;
    this._renderSuggestions();
  }

  /** @returns {void} */
  _renderSuggestions() {
    if (this._suggestions.length === 0) {
      this._hideSuggestions();
      return;
    }
    const icons = { bookmark: "icon:star", history: "icon:history", search: "icon:search", url: "icon:globe" };
    this._suggestionsEl.replaceChildren(
      ...this._suggestions.map((item, index) => {
        const id = `${this._suggestionsEl.id}-${index}`;
        return createElement("li", {
          className: `browser__suggestion${index === this._suggestionIndex ? " browser__suggestion--active" : ""}`,
          attrs: { role: "option", id, "aria-selected": String(index === this._suggestionIndex) },
          children: [
            createIconElement(icons[item.kind], { className: "browser__suggestion-icon" }),
            createElement("span", { className: "browser__suggestion-title", text: item.title }),
            ...(item.kind === "bookmark" || item.kind === "history" ? [createElement("span", { className: "browser__suggestion-url", text: item.url })] : []),
          ],
          on: {
            pointerdown: (e) => {
              e.preventDefault();
              this._hideSuggestions();
              this._navigate(this._session.activeId, item.url);
              this._addressInput.blur();
            },
          },
        });
      })
    );
    this._suggestionsEl.hidden = false;
    this._addressInput.setAttribute("aria-expanded", "true");
    if (this._suggestionIndex >= 0) this._addressInput.setAttribute("aria-activedescendant", `${this._suggestionsEl.id}-${this._suggestionIndex}`);
    else this._addressInput.removeAttribute("aria-activedescendant");
  }

  /** @returns {void} */
  _hideSuggestions() {
    this._suggestions = [];
    this._suggestionIndex = -1;
    this._suggestionsEl.hidden = true;
    this._addressInput.setAttribute("aria-expanded", "false");
    this._addressInput.removeAttribute("aria-activedescendant");
  }

  /** @returns {void} */
  _focusAddress() {
    this._addressInput.focus();
    this._addressInput.select();
  }

  /** @returns {void} */
  _focusActiveView() {
    // Focus stays in the Browser window rather than moving into an
    // embedded page: keys pressed inside a page go to that page's own
    // document, where the Browser's shortcuts can't be seen. Clicking
    // into the page focuses it as usual.
    const view = this._views.get(this._session.activeId);
    const target = view?.kind === "notice" ? view.view.getFocusTarget?.() : null;
    (target ?? this._root).focus({ preventScroll: true });
  }

  // ---------------------------------------------------------------
  // Info bar (embedded pages)
  // ---------------------------------------------------------------

  /**
   * After an embedded page from another site loads, explain that a blank
   * page means the site refuses embedding (BrowserOS can't detect it).
   * @param {string} tabId
   * @returns {void}
   */
  _offerEmbedNotice(tabId) {
    this._embedNoticeTab = tabId;
    this._renderInfoBar();
  }

  /** @returns {void} */
  _renderInfoBar() {
    const tab = this._session.active();
    const show = Boolean(tab && this._embedNoticeTab === tab.id && tab.state === "page");
    this._infoBarEl.hidden = !show;
    if (!show) return;
    const url = this._session.current(tab).url;
    const host = hostOf(url);
    this._infoBarEl.replaceChildren(
      createIconElement("icon:info", { className: "browser__infobar-icon" }),
      createElement("span", {
        className: "browser__infobar-text",
        text: tab.navigatedInPage
          ? `This page navigated by itself. BrowserOS can't read where it went; the address still shows ${host}.`
          : `If this page stays blank, ${host} doesn't allow being shown inside other pages.`,
      }),
      createElement("button", { className: "browser-button browser-button--small", attrs: { type: "button" }, text: "Open in your browser", on: { click: () => openExternally(url) } }),
      createElement("button", {
        className: "browser-button browser-button--small",
        attrs: { type: "button" },
        text: "Always open this site there",
        on: {
          click: () => {
            framePolicy.setSiteChoice(url, "external");
            openExternally(url);
            this._embedNoticeTab = null;
            this._showEntry(tab, { force: true });
          },
        },
      }),
      createElement("button", {
        className: "browser-icon-button",
        attrs: { type: "button", "aria-label": "Dismiss", title: "Dismiss" },
        children: [createIconElement("icon:close")],
        on: {
          click: () => {
            this._embedNoticeTab = null;
            this._renderInfoBar();
          },
        },
      })
    );
  }

  /**
   * @param {HTMLElement} anchor
   * @returns {void}
   */
  _showSiteInfo(anchor) {
    const tab = this._session.active();
    if (!tab) return;
    const url = this._session.current(tab).url;
    const security = securityOf(url);
    const rows = [];
    const text = {
      secure: "The connection to this site is encrypted.",
      insecure: "This site doesn't use an encrypted connection; don't enter passwords or payment details.",
      internal: "This is a built-in BrowserOS page.",
      file: "This file comes from the BrowserOS file system and is shown without running scripts.",
      none: "",
    }[security];
    rows.push(createElement("h2", { className: "browser__popover-title", text: hostOf(url) ?? fallbackTitle(url) }));
    if (text) rows.push(createElement("p", { className: "browser__popover-text", text }));
    if (isWebUrl(url)) {
      rows.push(
        createElement("p", {
          className: "browser__popover-text",
          text: isSameOrigin(url)
            ? "Shown inside BrowserOS without running its scripts."
            : "Shown inside BrowserOS in a sandbox. BrowserOS can't see the page's contents, and the site uses your host browser's cookies.",
        })
      );
      const choice = framePolicy.getSiteChoice(url);
      rows.push(
        createElement("div", {
          className: "browser__popover-actions",
          children: [
            createElement("button", { className: "browser-button browser-button--primary", attrs: { type: "button" }, text: "Open in your browser", on: { click: () => openExternally(url) } }),
            createElement("button", {
              className: "browser-button",
              attrs: { type: "button" },
              text: choice === "external" ? "Show this site here again" : "Always open this site in your browser",
              on: {
                click: () => {
                  framePolicy.setSiteChoice(url, choice === "external" ? null : "external");
                  this._closePopover();
                  this._showEntry(tab, { force: true });
                },
              },
            }),
          ],
        })
      );
    }
    if (this._private) rows.push(createElement("p", { className: "browser__popover-text", text: "Private window: visits aren't saved to history." }));
    this._openPopover(anchor, rows, "Page information");
  }

  // ---------------------------------------------------------------
  // Popovers: bookmark editor, downloads
  // ---------------------------------------------------------------

  /**
   * @param {HTMLElement} anchor
   * @param {HTMLElement[]} children
   * @param {string} label
   * @returns {void}
   */
  _openPopover(anchor, children, label) {
    this._closePopover();
    this._popoverAnchor = anchor;
    this._popoverEl.replaceChildren(...children);
    this._popoverEl.setAttribute("aria-label", label);
    this._popoverEl.hidden = false;
    anchor.setAttribute("aria-expanded", "true");
    const rootRect = this._root.getBoundingClientRect();
    const rect = anchor.getBoundingClientRect();
    const width = this._popoverEl.offsetWidth;
    const left = Math.max(8, Math.min(rect.left - rootRect.left, rootRect.width - width - 8));
    this._popoverEl.style.left = `${left}px`;
    this._popoverEl.style.top = `${rect.bottom - rootRect.top + 6}px`;
    this._popoverEl.querySelector("input, select, button")?.focus();
    this._popoverEl.onkeydown = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        this._closePopover({ restoreFocus: true });
      }
    };
  }

  /**
   * @param {{restoreFocus?: boolean}} [options]
   * @returns {void}
   */
  _closePopover({ restoreFocus = false } = {}) {
    if (this._popoverEl.hidden) return;
    this._popoverEl.hidden = true;
    this._popoverAnchor?.setAttribute("aria-expanded", "false");
    if (restoreFocus) this._popoverAnchor?.focus();
    this._popoverAnchor = null;
    this._downloadsList?.destroy();
    this._downloadsList = null;
    this._popoverEl.replaceChildren();
  }

  /** @returns {Promise<void>} */
  async _toggleBookmarkPopover() {
    if (!this._popoverEl.hidden && this._popoverAnchor === this._starButton) {
      this._closePopover({ restoreFocus: true });
      return;
    }
    const tab = this._session.active();
    if (!tab) return;
    const entry = this._session.current(tab);
    if (!canBookmark(entry.url)) return;
    await bookmarkService.ready().catch(() => {});
    let bookmark = bookmarkService.findByUrl(entry.url)[0];
    let created = false;
    try {
      if (!bookmark) {
        bookmark = (await bookmarkService.add({ url: entry.url, title: entry.title || fallbackTitle(entry.url), parentId: BAR_FOLDER_ID })).bookmark;
        created = true;
      }
    } catch (error) {
      await showMessageDialog({ title: "Couldn't add bookmark", message: error.message });
      return;
    }
    const parentId = findParentId(bookmarkService.getTree(), bookmark.id) ?? BAR_FOLDER_ID;
    const nameInput = createElement("input", { className: "dialog__input", attrs: { type: "text", "aria-label": "Bookmark name" } });
    nameInput.value = bookmark.title;
    const folderSelect = createElement("select", {
      className: "dialog__select",
      attrs: { "aria-label": "Folder" },
      children: bookmarkService.getFolders().map((folder) => createElement("option", { attrs: { value: folder.id }, text: `${"\u2003".repeat(folder.depth)}${folder.title}` })),
    });
    folderSelect.value = parentId;
    const save = async () => {
      try {
        if (nameInput.value.trim() && nameInput.value.trim() !== bookmark.title) await bookmarkService.update(bookmark.id, { title: nameInput.value });
        if (folderSelect.value !== parentId) await bookmarkService.move(bookmark.id, { parentId: folderSelect.value });
        this._closePopover({ restoreFocus: true });
      } catch (error) {
        await showMessageDialog({ title: "Couldn't save bookmark", message: error.message });
      }
    };
    nameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        save();
      }
    });
    this._openPopover(
      this._starButton,
      [
        createElement("h2", { className: "browser__popover-title", text: created ? "Bookmark added" : "Edit bookmark" }),
        createElement("label", { className: "browser__popover-field", children: [createElement("span", { text: "Name" }), nameInput] }),
        createElement("label", { className: "browser__popover-field", children: [createElement("span", { text: "Folder" }), folderSelect] }),
        createElement("div", {
          className: "browser__popover-actions",
          children: [
            createElement("button", {
              className: "browser-button",
              attrs: { type: "button" },
              text: "Remove",
              on: {
                click: async () => {
                  await bookmarkService.remove(bookmark.id).catch(() => {});
                  this._closePopover({ restoreFocus: true });
                },
              },
            }),
            createElement("button", { className: "browser-button browser-button--primary", attrs: { type: "button" }, text: "Done", on: { click: save } }),
          ],
        }),
      ],
      "Bookmark"
    );
    nameInput.focus();
    nameInput.select();
  }

  /**
   * Add a bookmark without the editor (tab menu, bookmark all).
   * @param {string} url
   * @param {string} title
   * @returns {Promise<void>}
   */
  async _bookmarkUrl(url, title) {
    try {
      await bookmarkService.add({ url, title: title || fallbackTitle(url) });
    } catch (error) {
      await showMessageDialog({ title: "Couldn't add bookmark", message: error.message });
    }
  }

  /** @returns {void} */
  _toggleDownloadsPanel() {
    if (!this._popoverEl.hidden && this._popoverAnchor === this._downloadsButton) {
      this._closePopover({ restoreFocus: true });
      return;
    }
    this._openDownloadsPanel({ focus: true });
  }

  /**
   * @param {{focus?: boolean}} [options]
   * @returns {void}
   */
  _openDownloadsPanel({ focus = false } = {}) {
    const list = new DownloadList({ compact: true, limit: 5, emptyText: "No downloads yet." });
    const panel = [
      createElement("h2", { className: "browser__popover-title", text: "Recent downloads" }),
      createElement("div", { className: "browser__popover-list", children: [list.getElement()] }),
      createElement("div", {
        className: "browser__popover-actions",
        children: [
          createElement("button", { className: "browser-button", attrs: { type: "button" }, text: "Open Downloads folder", on: { click: () => downloadService.showInFolder() } }),
          createElement("button", {
            className: "browser-button browser-button--primary",
            attrs: { type: "button" },
            text: "Show all downloads",
            on: {
              click: () => {
                this._closePopover();
                this.appManager.launch("downloads").catch(() => {});
              },
            },
          }),
        ],
      }),
    ];
    const previousFocus = document.activeElement;
    this._openPopover(this._downloadsButton, panel, "Downloads");
    this._downloadsList = list;
    if (!focus && previousFocus instanceof HTMLElement) previousFocus.focus({ preventScroll: true });
  }

  /**
   * @param {string} url
   * @param {string|null} filename
   * @returns {void}
   */
  _startDownload(url, filename) {
    try {
      downloadService.download(url, { filename: filename ?? undefined, source: "browser", private: this._private });
      this._openDownloadsPanel();
    } catch (error) {
      showMessageDialog({ title: "Can't download this address", message: error.message });
    }
  }

  // ---------------------------------------------------------------
  // Bookmarks bar
  // ---------------------------------------------------------------

  /** @returns {void} */
  _renderBookmarksBar() {
    const show = settingsService.get("browser.showBookmarksBar");
    this._bookmarksBarEl.hidden = !show;
    if (!show) return;
    const items = bookmarkService.getBarItems();
    if (items.length === 0) {
      this._bookmarksBarEl.replaceChildren(createElement("span", { className: "browser__bookmarks-empty", text: "Bookmarks you add to the bookmarks bar appear here." }));
      return;
    }
    const buttons = items.map((item) => this._barButton(item));
    const overflow = createElement("button", {
      className: "browser-icon-button browser__bar-overflow",
      attrs: { type: "button", "aria-label": "More bookmarks", title: "More bookmarks", hidden: "" },
      children: [createIconElement("icon:chevronDown")],
      on: {
        click: (e) => {
          const hidden = items.filter((_, index) => buttons[index].dataset.overflow === "true");
          const rect = e.currentTarget.getBoundingClientRect();
          this._menu.show(this._bookmarkMenuItems(hidden), { x: rect.left - 160, y: rect.bottom + 4 });
        },
      },
    });
    const track = createElement("div", { className: "browser__bar-track", children: buttons });
    this._bookmarksBarEl.replaceChildren(track, overflow);
    requestAnimationFrame(() => {
      let anyHidden = false;
      for (const button of buttons) {
        const hidden = button.offsetLeft + button.offsetWidth > track.clientWidth + 1;
        button.dataset.overflow = String(hidden);
        button.style.visibility = hidden ? "hidden" : "";
        button.tabIndex = hidden ? -1 : 0;
        anyHidden ||= hidden;
      }
      overflow.hidden = !anyHidden;
    });
  }

  /**
   * @param {object} item
   * @returns {HTMLElement}
   */
  _barButton(item) {
    if (item.type === "folder") {
      return createElement("button", {
        className: "browser__bar-item",
        attrs: { type: "button", title: item.title, "aria-haspopup": "menu" },
        children: [createIconElement("icon:folder", { className: "browser-favicon" }), createElement("span", { text: item.title })],
        on: {
          click: (e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const children = bookmarkService.getChildren(item.id);
            this._menu.show(children.length ? this._bookmarkMenuItems(children) : [{ label: "(empty)", disabled: true }], { x: rect.left, y: rect.bottom + 4 });
          },
        },
      });
    }
    return createElement("button", {
      className: "browser__bar-item",
      attrs: { type: "button", title: `${item.title}\n${item.url}` },
      children: [createFavicon(item.url), createElement("span", { text: item.title })],
      on: {
        click: (e) => this._openUrl(item.url, { newTab: e.ctrlKey || e.metaKey }),
        auxclick: (e) => e.button === 1 && this._openUrl(item.url, { newTab: true }),
        contextmenu: (e) => {
          e.preventDefault();
          this._menu.show(
            [
              { label: "Open", action: () => this._openUrl(item.url) },
              { label: "Open in new tab", action: () => this._openUrl(item.url, { newTab: true }) },
              { separator: true },
              { label: "Edit\u2026", action: () => this._editBookmark(item) },
              { label: "Delete", action: () => bookmarkService.remove(item.id).catch(() => {}) },
            ],
            { x: e.clientX, y: e.clientY }
          );
        },
      },
    });
  }

  /**
   * @param {object[]} items
   * @returns {object[]} ContextMenu items for bookmarks and folders.
   */
  _bookmarkMenuItems(items) {
    return items.map((item) =>
      item.type === "folder"
        ? { label: item.title, submenu: item.children.length ? this._bookmarkMenuItems(item.children) : [{ label: "(empty)", disabled: true }] }
        : { label: item.title, action: () => this._openUrl(item.url) }
    );
  }

  /**
   * @param {object} item
   * @returns {Promise<void>}
   */
  async _editBookmark(item) {
    await showFormDialog({
      title: "Edit bookmark",
      fields: [
        { id: "title", label: "Name", value: item.title },
        { id: "url", label: "Address", type: "url", value: item.url },
      ],
      validate: async ({ title, url }) => {
        try {
          await bookmarkService.update(item.id, { title, url });
          return null;
        } catch (error) {
          return error.message;
        }
      },
    });
  }

  // ---------------------------------------------------------------
  // Sidebar
  // ---------------------------------------------------------------

  /** @returns {boolean} */
  _sidebarOpen() {
    return !this._sidebarEl.hidden;
  }

  /** @returns {void} */
  _toggleSidebar(section) {
    const open = section ? true : !this._sidebarOpen();
    if (section) this._sidebarSection = section;
    this._sidebarEl.hidden = !open;
    this._sidebarButton.setAttribute("aria-pressed", String(open));
    if (open) this._renderSidebar();
    else {
      this._sidebarDownloads?.destroy();
      this._sidebarDownloads = null;
    }
  }

  /** @returns {void} */
  _renderSidebar() {
    const sections = [
      ["bookmarks", "Bookmarks", "icon:star"],
      ["history", "History", "icon:history"],
      ["downloads", "Downloads", "icon:download"],
    ];
    const tabs = createElement("div", {
      className: "browser__sidebar-tabs",
      attrs: { role: "tablist", "aria-label": "Sidebar" },
      children: sections.map(([id, label, icon]) =>
        createElement("button", {
          className: "browser__sidebar-tab",
          attrs: { type: "button", role: "tab", "aria-selected": String(id === this._sidebarSection), title: label },
          children: [createIconElement(icon), createElement("span", { text: label })],
          on: {
            click: () => {
              this._sidebarSection = id;
              this._renderSidebar();
            },
          },
        })
      ),
    });
    const query = this._sidebarQuery ?? "";
    const search = createElement("input", {
      className: "browser-page__search browser__sidebar-search",
      attrs: { type: "search", placeholder: "Search", "aria-label": `Search ${this._sidebarSection}` },
      on: {
        input: () => {
          this._sidebarQuery = search.value;
          this._fillSidebarList(list);
        },
      },
    });
    search.value = query;
    const list = createElement("div", { className: "browser__sidebar-list" });
    this._sidebarDownloads?.destroy();
    this._sidebarDownloads = null;
    this._sidebarEl.replaceChildren(tabs, ...(this._sidebarSection === "downloads" ? [] : [search]), list);
    this._fillSidebarList(list);
  }

  /**
   * @param {HTMLElement} list
   * @returns {void}
   */
  _fillSidebarList(list) {
    const query = (this._sidebarQuery ?? "").trim();
    if (this._sidebarSection === "downloads") {
      this._sidebarDownloads = new DownloadList({ compact: true, emptyText: "No downloads yet." });
      list.replaceChildren(this._sidebarDownloads.getElement());
      return;
    }
    const items =
      this._sidebarSection === "bookmarks"
        ? bookmarkService.search(query, 100).map((bookmark) => ({ title: bookmark.title, url: bookmark.url, meta: bookmark.url }))
        : historyService.search(query, 100).map((record) => ({ title: record.title, url: record.url, favicon: record.favicon, meta: new Date(record.lastVisit).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) }));
    list.replaceChildren(
      ...(items.length
        ? items.map((item) =>
            createElement("button", {
              className: "browser__sidebar-item",
              attrs: { type: "button", title: item.url },
              children: [createFavicon(item.url, item.favicon ?? null), createElement("span", { className: "browser__sidebar-title", text: item.title }), createElement("span", { className: "browser__sidebar-meta", text: item.meta })],
              on: {
                click: (e) => this._openUrl(item.url, { newTab: e.ctrlKey || e.metaKey }),
                auxclick: (e) => e.button === 1 && this._openUrl(item.url, { newTab: true }),
              },
            })
          )
        : [createElement("p", { className: "browser-page__empty", text: query ? "Nothing matches." : this._sidebarSection === "bookmarks" ? "No bookmarks yet." : "No history yet." })])
    );
  }

  // ---------------------------------------------------------------
  // Menu and keyboard
  // ---------------------------------------------------------------

  /**
   * @param {HTMLElement} anchor
   * @returns {void}
   */
  _showMenu(anchor) {
    const tab = this._session.active();
    const url = tab ? this._session.current(tab).url : "";
    const web = isWebUrl(url);
    const rect = anchor.getBoundingClientRect();
    this._menu.show(
      [
        { label: "New tab", action: () => this._openInNewTab(START_PAGE_URL) },
        { label: "New window", action: () => this.appManager.launch("browser").catch(() => {}) },
        { label: "New private window", action: () => this.appManager.launch("browser", { private: true }).catch(() => {}) },
        { separator: true },
        { label: "History", action: () => this._openPage("browseros://history") },
        { label: "Bookmarks", action: () => this._openPage("browseros://bookmarks") },
        { label: "Downloads", action: () => this.appManager.launch("downloads").catch(() => {}) },
        { label: "Reopen closed tab", disabled: this._session.closed.length === 0, action: () => this._reopenClosed() },
        { separator: true },
        { label: "Show bookmarks bar", checked: settingsService.get("browser.showBookmarksBar"), action: () => settingsService.set("browser.showBookmarksBar", !settingsService.get("browser.showBookmarksBar")) },
        { label: "Show sidebar", checked: this._sidebarOpen(), action: () => this._toggleSidebar() },
        { separator: true },
        { label: "Save page to Downloads", disabled: !web, action: () => this._startDownload(url, null) },
        { label: "Open in your browser", disabled: !web, action: () => openExternally(url) },
        { label: "Copy address", disabled: !displayUrl(url), action: () => navigator.clipboard?.writeText(url).catch(() => {}) },
        { separator: true },
        { label: "Clear browsing data\u2026", action: () => showClearBrowsingDataDialog() },
        { label: "Browser settings", action: () => this.appManager.launch("settings", { page: "browser" }).catch(() => {}) },
      ],
      { x: rect.right - 230, y: rect.bottom + 4 }
    );
  }

  /**
   * Open a built-in page: in the current tab when it shows the start page, else in a new tab.
   * @param {string} url
   * @returns {void}
   */
  _openPage(url) {
    const tab = this._session.active();
    const existing = this._session.tabs.find((candidate) => this._session.current(candidate).url === url);
    if (existing) {
      this._session.activate(existing.id);
      return;
    }
    if (tab && internalPageOf(this._session.current(tab).url) === "start") this._navigate(tab.id, url);
    else this._openInNewTab(url);
  }

  /**
   * @param {KeyboardEvent} e
   * @returns {void}
   */
  _handleKeydown(e) {
    const match = (id) => keyboardShortcuts.matches(e, id);
    const run = (action) => {
      e.preventDefault();
      e.stopPropagation();
      action();
    };
    if (match("browser.focusAddress")) run(() => this._focusAddress());
    else if (match("browser.newTab")) run(() => {
      this._openInNewTab(START_PAGE_URL);
      this._focusAddress();
    });
    else if (match("browser.closeTab")) run(() => this._closeTab(this._session.activeId));
    else if (match("browser.reopenTab")) run(() => this._reopenClosed());
    else if (match("browser.nextTab")) run(() => this._session.cycle(1));
    else if (match("browser.previousTab")) run(() => this._session.cycle(-1));
    else if (match("browser.back")) run(() => this._go(-1));
    else if (match("browser.forward")) run(() => this._go(1));
    else if (match("browser.reload")) run(() => this._reload(this._session.activeId));
    else if (match("browser.home")) run(() => this._goHome());
    else if (match("browser.bookmark")) run(() => this._toggleBookmarkPopover());
    else if (match("browser.history")) run(() => this._openPage("browseros://history"));
    else if (match("browser.bookmarks")) run(() => this._openPage("browseros://bookmarks"));
    else if (match("browser.downloads")) run(() => this._toggleDownloadsPanel());
    else if (match("browser.stop") && this._session.active()?.loading && document.activeElement !== this._addressInput) run(() => this._stop(this._session.activeId));
  }
}

/**
 * @param {string} url
 * @returns {boolean}
 */
function canBookmark(url) {
  return isWebUrl(url) || (typeof url === "string" && (url.startsWith("vfs:///") || /^browseros:\/\/(history|bookmarks|downloads)$/.test(url)));
}

/**
 * @param {string} url
 * @returns {boolean} Whether a navigation to this URL is a file download.
 */
function isDownloadUrl(url) {
  if (!isWebUrl(url)) return false;
  try {
    const extension = new URL(url).pathname.split("/").pop().split(".").pop().toLowerCase();
    return DOWNLOAD_LINK_EXTENSIONS.has(extension) && new URL(url).pathname.includes(".");
  } catch {
    return false;
  }
}

/**
 * Open a URL with the host browser (a new tab or the OS handler).
 * @param {string} url
 * @returns {void}
 */
function openExternally(url) {
  window.open(url, "_blank", "noopener,noreferrer");
}

/**
 * @param {object} tree
 * @param {string} id
 * @returns {string|null}
 */
function findParentId(tree, id) {
  const walk = (folder) => {
    for (const child of folder.children) {
      if (child.id === id) return folder.id;
      if (child.type === "folder") {
        const found = walk(child);
        if (found) return found;
      }
    }
    return null;
  };
  return walk(tree);
}
