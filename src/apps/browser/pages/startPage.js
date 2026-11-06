/**
 * @file Start page (browseros://start) — the Browser's new-tab page.
 *
 * Shows the time and date (optional), a search box, the user's own
 * shortcuts (add, rename, edit, reorder, remove), frequently and
 * recently visited pages computed from real history, and bookmarks
 * from the bookmarks bar. Nothing is invented: empty sections say how
 * they fill up. Private windows show what private browsing does and
 * doesn't do instead of history.
 *
 * Customization (clock, background) is stored in Browser settings.
 */

import { createElement } from "../../../utils/dom.js";
import { createIconElement } from "../../../utils/icons.js";
import { eventBus } from "../../../core/eventBus.js";
import { settingsService } from "../../../core/settings/settingsService.js";
import { historyService } from "../../../core/browser/historyService.js";
import { bookmarkService } from "../../../core/browser/bookmarkService.js";
import { shortcutService, MAX_SHORTCUTS } from "../../../core/browser/shortcutService.js";
import { getSearchEngine } from "../../../core/browser/searchEngines.js";
import { ContextMenu } from "../../../components/context-menu/contextMenu.js";
import { showFormDialog } from "../../../components/dialog/formDialog.js";
import { createFavicon } from "../favicon.js";

export class StartPage {
  /**
   * @param {object} ctx
   * @param {boolean} ctx.private
   * @param {(url: string, options?: {newTab?: boolean}) => void} ctx.navigate
   * @param {(text: string) => void} ctx.submitAddress
   */
  constructor(ctx) {
    this.title = "New tab";
    this._ctx = ctx;
    this._menu = new ContextMenu();
    this._cleanups = [];

    this._timeEl = createElement("p", { className: "browser-start__time" });
    this._dateEl = createElement("p", { className: "browser-start__date" });
    this._clockEl = createElement("div", { className: "browser-start__clock", children: [this._timeEl, this._dateEl] });
    this._searchInput = createElement("input", {
      className: "browser-start__search-input",
      attrs: { type: "search", autocomplete: "off", spellcheck: "false", "aria-label": "Search or enter address" },
    });
    const searchForm = createElement("form", {
      className: "browser-start__search",
      attrs: { role: "search" },
      children: [
        createIconElement("icon:search", { className: "browser-start__search-icon" }),
        this._searchInput,
        createElement("button", { className: "browser-button browser-button--primary", attrs: { type: "submit" }, text: "Go" }),
      ],
      on: {
        submit: (e) => {
          e.preventDefault();
          if (this._searchInput.value.trim()) ctx.submitAddress(this._searchInput.value);
        },
      },
    });

    this._shortcutsEl = createElement("div", { className: "browser-start__tiles", attrs: { role: "list", "aria-label": "Shortcuts" } });
    this._frequentEl = createElement("div", { className: "browser-start__tiles", attrs: { role: "list", "aria-label": "Frequently visited" } });
    this._recentEl = createElement("ul", { className: "browser-start__list", attrs: { "aria-label": "Recently visited" } });
    this._bookmarksEl = createElement("div", { className: "browser-start__tiles", attrs: { role: "list", "aria-label": "Bookmarks bar" } });

    const sections = ctx.private
      ? [this._privateNotice(), this._section("Shortcuts", this._shortcutsEl)]
      : [
          this._section("Shortcuts", this._shortcutsEl),
          this._section("Frequently visited", this._frequentEl),
          this._section("Recently visited", this._recentEl),
          this._section("Bookmarks", this._bookmarksEl),
        ];

    this._wallpaperEl = createElement("div", { className: "browser-start__wallpaper", attrs: { "aria-hidden": "true" } });
    this.element = createElement("div", {
      className: `browser-start${ctx.private ? " browser-start--private" : ""}`,
      children: [
        this._wallpaperEl,
        createElement("button", {
          className: "browser-icon-button browser-start__customize",
          attrs: { type: "button", "aria-label": "Customize this page", title: "Customize" },
          children: [createIconElement("icon:sliders")],
          on: { click: (e) => this._showCustomizeMenu(e.currentTarget) },
        }),
        createElement("div", { className: "browser-start__inner", children: [this._clockEl, searchForm, ...sections] }),
      ],
    });

    const rerender = () => this.render();
    this._cleanups.push(
      eventBus.on("browser:shortcutsChanged", rerender),
      eventBus.on("browser:historyChanged", rerender),
      eventBus.on("bookmarks:changed", rerender),
      eventBus.on("system:clockTick", () => this._renderClock()),
      settingsService.subscribeCategory("browser", rerender),
      settingsService.subscribeCategory("wallpaper", rerender)
    );
    this.render();
  }

  /** @returns {HTMLElement} */
  getFocusTarget() {
    return this._searchInput;
  }

  /** @returns {void} */
  destroy() {
    for (const cleanup of this._cleanups) cleanup();
    this._cleanups = [];
    this._menu.hide();
  }

  /** @returns {void} */
  render() {
    const engine = getSearchEngine(settingsService.get("browser.searchEngine"));
    this._searchInput.placeholder = `Search with ${engine.name} or type an address`;
    const background = settingsService.get("browser.startPageBackground");
    this.element.dataset.background = background;
    // The desktop wallpaper's own preset rules (styles/wallpapers.css) paint this layer.
    this._wallpaperEl.hidden = background !== "wallpaper" || this._ctx.private;
    this._wallpaperEl.dataset.wallpaperPreview = settingsService.get("wallpaper.preset");
    this._clockEl.hidden = !settingsService.get("browser.startPageClock");
    this._renderClock();
    this._renderShortcuts();
    if (this._ctx.private) return;

    const frequent = historyService.getFrequent(8);
    this._fillTiles(this._frequentEl, frequent.map((record) => ({ title: record.title, url: record.url, favicon: record.favicon })), "Pages you visit often appear here.");

    const recent = historyService.getRecent(6);
    this._recentEl.replaceChildren(
      ...(recent.length
        ? recent.map((record) =>
            createElement("li", {
              children: [
                createElement("button", {
                  className: "browser-start__row",
                  attrs: { type: "button", title: record.url },
                  children: [
                    createFavicon(record.url, record.favicon),
                    createElement("span", { className: "browser-start__row-title", text: record.title }),
                    createElement("span", { className: "browser-start__row-meta", text: timeAgo(record.lastVisit) }),
                  ],
                  on: { click: (e) => this._ctx.navigate(record.url, { newTab: e.ctrlKey || e.metaKey }), auxclick: (e) => e.button === 1 && this._ctx.navigate(record.url, { newTab: true }) },
                }),
              ],
            })
          )
        : [createElement("li", { className: "browser-start__empty", text: "Pages you visit appear here. Open browseros://history for everything." })])
    );

    const bookmarks = bookmarkService.getBarItems().filter((item) => item.type === "bookmark").slice(0, 8);
    this._fillTiles(this._bookmarksEl, bookmarks, "Bookmark pages with the star in the address bar; bookmarks-bar items appear here.");
  }

  // ---------------------------------------------------------------
  // Sections
  // ---------------------------------------------------------------

  /**
   * @param {string} title
   * @param {HTMLElement} content
   * @returns {HTMLElement}
   */
  _section(title, content) {
    return createElement("section", {
      className: "browser-start__section",
      children: [createElement("h2", { className: "browser-start__heading", text: title }), content],
    });
  }

  /** @returns {HTMLElement} */
  _privateNotice() {
    return createElement("section", {
      className: "browser-start__private",
      children: [
        createIconElement("icon:shield", { className: "browser-start__private-icon" }),
        createElement("div", {
          children: [
            createElement("h2", { className: "browser-start__heading", text: "Private window" }),
            createElement("p", {
              text: "Pages you visit in this window aren't saved to BrowserOS history, and downloads from it aren't kept in the download list. Files you download are still saved to /Downloads.",
            }),
            createElement("p", {
              text: "This isn't anonymity: pages load through your host browser, which uses its own cookies and site data (shared with normal windows), and websites and your network can still see your visits.",
            }),
          ],
        }),
      ],
    });
  }

  /** @returns {void} */
  _renderClock() {
    if (this._clockEl.hidden) return;
    const now = new Date();
    this._timeEl.textContent = now.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    this._dateEl.textContent = now.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
  }

  /**
   * @param {HTMLElement} container
   * @param {Array<{title: string, url: string, favicon?: string|null}>} items
   * @param {string} emptyText
   * @returns {void}
   */
  _fillTiles(container, items, emptyText) {
    container.replaceChildren(
      ...(items.length
        ? items.map((item) => this._tile(item))
        : [createElement("p", { className: "browser-start__empty", text: emptyText })])
    );
  }

  /**
   * @param {{title: string, url: string, favicon?: string|null}} item
   * @param {{menu?: (anchor: HTMLElement) => void}} [options]
   * @returns {HTMLElement}
   */
  _tile(item, { menu } = {}) {
    const open = createElement("button", {
      className: "browser-start__tile",
      attrs: { type: "button", title: item.url },
      children: [createFavicon(item.url, item.favicon ?? null, "browser-start__tile-icon"), createElement("span", { className: "browser-start__tile-title", text: item.title })],
      on: {
        click: (e) => this._ctx.navigate(item.url, { newTab: e.ctrlKey || e.metaKey }),
        auxclick: (e) => e.button === 1 && this._ctx.navigate(item.url, { newTab: true }),
        contextmenu: menu
          ? (e) => {
              e.preventDefault();
              menu(e.currentTarget);
            }
          : null,
      },
    });
    const children = [open];
    if (menu) {
      children.push(
        createElement("button", {
          className: "browser-icon-button browser-start__tile-menu",
          attrs: { type: "button", "aria-label": `Options for ${item.title}`, title: "Options" },
          children: [createIconElement("icon:more")],
          on: { click: (e) => menu(e.currentTarget) },
        })
      );
    }
    return createElement("div", { className: "browser-start__tile-wrap", attrs: { role: "listitem" }, children });
  }

  /** @returns {void} */
  _renderShortcuts() {
    const items = shortcutService.list();
    const tiles = items.map((item, index) =>
      this._tile(item, {
        menu: (anchor) => {
          const rect = anchor.getBoundingClientRect();
          this._menu.show(
            [
              { label: "Open in new tab", action: () => this._ctx.navigate(item.url, { newTab: true }) },
              { label: "Edit\u2026", action: () => this._editShortcut(item) },
              { label: "Move left", disabled: index === 0, action: () => shortcutService.move(item.id, index - 1) },
              { label: "Move right", disabled: index === items.length - 1, action: () => shortcutService.move(item.id, index + 1) },
              { separator: true },
              { label: "Remove", action: () => shortcutService.remove(item.id) },
            ],
            { x: rect.left, y: rect.bottom + 4 }
          );
        },
      })
    );
    if (items.length < MAX_SHORTCUTS) {
      tiles.push(
        createElement("div", {
          className: "browser-start__tile-wrap",
          attrs: { role: "listitem" },
          children: [
            createElement("button", {
              className: "browser-start__tile browser-start__tile--add",
              attrs: { type: "button" },
              children: [createIconElement("icon:plus", { className: "browser-start__tile-icon" }), createElement("span", { className: "browser-start__tile-title", text: "Add shortcut" })],
              on: { click: () => this._addShortcut() },
            }),
          ],
        })
      );
    }
    this._shortcutsEl.replaceChildren(...tiles);
  }

  /** @returns {Promise<void>} */
  async _addShortcut() {
    await showFormDialog({
      title: "Add shortcut",
      confirmLabel: "Add",
      fields: [
        { id: "title", label: "Name", placeholder: "Optional" },
        { id: "url", label: "Address", type: "url", placeholder: "example.com" },
      ],
      validate: ({ title, url }) => {
        try {
          shortcutService.add({ title, url });
          return null;
        } catch (error) {
          return error.message;
        }
      },
    });
  }

  /**
   * @param {{id: string, title: string, url: string}} item
   * @returns {Promise<void>}
   */
  async _editShortcut(item) {
    await showFormDialog({
      title: "Edit shortcut",
      fields: [
        { id: "title", label: "Name", value: item.title },
        { id: "url", label: "Address", type: "url", value: item.url },
      ],
      validate: ({ title, url }) => {
        try {
          shortcutService.update(item.id, { title, url });
          return null;
        } catch (error) {
          return error.message;
        }
      },
    });
  }

  /**
   * @param {HTMLElement} anchor
   * @returns {void}
   */
  _showCustomizeMenu(anchor) {
    const rect = anchor.getBoundingClientRect();
    const background = settingsService.get("browser.startPageBackground");
    this._menu.show(
      [
        { label: "Show clock", checked: settingsService.get("browser.startPageClock"), action: () => settingsService.set("browser.startPageClock", !settingsService.get("browser.startPageClock")) },
        { separator: true },
        ...[
          ["wallpaper", "Background: desktop wallpaper"],
          ["accent", "Background: accent color"],
          ["plain", "Background: plain"],
        ].map(([value, label]) => ({ label, checked: background === value, radio: true, action: () => settingsService.set("browser.startPageBackground", value) })),
      ],
      { x: rect.left - 200, y: rect.bottom + 4 }
    );
  }
}

/**
 * @param {number} at
 * @returns {string}
 */
export function timeAgo(at) {
  const diff = Date.now() - at;
  if (diff < 60_000) return "Just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} h ago`;
  return new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}
