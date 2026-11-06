/**
 * @file SettingsManager — owns one Settings window's state: which
 * category is open, the lifecycle of the page object rendering it,
 * the sidebar search, and the persistence-failure banner.
 *
 * Only one page exists at a time. Navigating destroys the previous
 * page before creating the next, so page subscriptions never outlive
 * the page; destroy() does the same for the window as a whole.
 *
 * Deep links: navigate(categoryId, { anchor }) opens a page and
 * reveals the section marked with that anchor (data-settings-anchor),
 * which is how Start Menu and sidebar search results land on the
 * right option.
 */

import { eventBus } from "../../core/eventBus.js";
import { settingsService } from "../../core/settings/settingsService.js";
import { searchSettingsIndex } from "../../core/settings/settingsIndex.js";
import { SettingsView } from "./settingsView.js";
import { SETTINGS_CATEGORIES, resolveCategory } from "./settingsCategories.js";

class SettingsManager {
  /**
   * @param {object} [config]
   * @param {string} [config.initialCategory] - Category id to open first; invalid or unavailable ids fall back to the default.
   * @param {string} [config.initialAnchor] - Section to reveal on the initial page.
   * @param {import("./settingsCategories.js").SettingsPageContext} [config.context] - Services handed to every page.
   */
  constructor(config = {}) {
    this._initialCategory = config.initialCategory;
    this._initialAnchor = config.initialAnchor;
    this._context = Object.freeze({
      appManager: config.context?.appManager ?? null,
      recentFilesService: config.context?.recentFilesService ?? null,
    });
    /** @type {string|null} */
    this._currentCategoryId = null;
    /** @type {import("./settingsCategories.js").SettingsPage|null} */
    this._page = null;
    this._cleanups = [];

    this._view = new SettingsView(
      { categories: SETTINGS_CATEGORIES },
      {
        onNavigate: (id, anchor) => {
          this._view.clearSearch();
          this.navigate(id, { focusPage: true, anchor });
        },
        onSearch: (query) => this._handleSearch(query),
      }
    );
  }

  /** @returns {void} */
  init() {
    this._cleanups.push(
      eventBus.on("settings:persistenceFailed", ({ error }) => this._view.setStatus(error)),
      eventBus.on("settings:persistenceRestored", () => this._view.setStatus(null))
    );
    this._view.setStatus(settingsService.getPersistenceError());
    this.navigate(this._initialCategory, { anchor: this._initialAnchor, deferAnchor: true });
  }

  /** @returns {HTMLElement} */
  getElement() {
    return this._view.getElement();
  }

  /**
   * Show a category. Re-selecting the current category keeps the
   * existing page (and its scroll position) instead of rebuilding it.
   * @param {string} [categoryId]
   * @param {{focusPage?: boolean, anchor?: string, deferAnchor?: boolean}} [options] - focusPage moves
   *   keyboard focus to the page heading; anchor reveals a section instead; deferAnchor waits a frame
   *   (the window is not yet in the document during launch).
   * @returns {void}
   */
  navigate(categoryId, { focusPage = false, anchor, deferAnchor = false } = {}) {
    const category = resolveCategory(categoryId);

    if (category.id !== this._currentCategoryId) {
      let nextPage;
      try {
        nextPage = category.createPage(this._context);
      } catch (error) {
        console.error(`[Settings] failed to build the "${category.id}" page:`, error);
        this._view.setStatus(`The ${category.label} page could not be opened.`);
        return;
      }

      this._page?.destroy();
      this._page = nextPage;
      this._currentCategoryId = category.id;
      this._view.setPage(nextPage.getElement());
      this._view.setActiveCategory(category.id);
      eventBus.emit("settings:navigated", Object.freeze({ category: category.id, anchor: anchor ?? null }));
    }

    if (anchor) {
      const reveal = () => {
        if (!this._view.revealAnchor(anchor) && focusPage) this._view.focusPageHeading();
      };
      if (deferAnchor) {
        requestAnimationFrame(reveal);
      } else {
        reveal();
      }
      return;
    }
    if (focusPage) this._view.focusPageHeading();
  }

  /** @returns {void} */
  destroy() {
    this._page?.destroy();
    this._page = null;
    this._view.destroy();
    for (const cleanup of this._cleanups) cleanup();
    this._cleanups = [];
  }

  /**
   * @param {string} query
   * @returns {void}
   */
  _handleSearch(query) {
    if (!query.trim()) {
      this._view.setSearchResults(null);
      return;
    }
    this._view.setSearchResults(searchSettingsIndex(query));
  }
}

export { SettingsManager };
