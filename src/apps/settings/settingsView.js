/**
 * @file SettingsView — the Settings window's shell: sidebar (title,
 * search field, category navigation or search results) and a
 * scrollable content area that hosts one page at a time.
 *
 * Like every other *View in BrowserOS, it renders what it's told and
 * reports raw facts upward (a category or search result was
 * activated, the search text changed). Which page is shown, what a
 * search matches, and what navigating means are decided by
 * SettingsManager.
 */

import { createElement, clearElement } from "../../utils/dom.js";
import { createIconElement } from "../../utils/icons.js";
import { isCategoryAvailable } from "./settingsCategories.js";

/** How long a section stays highlighted after a deep link reveals it. */
const ANCHOR_HIGHLIGHT_MS = 1600;

class SettingsView {
  /**
   * @param {object} config
   * @param {ReadonlyArray<import("./settingsCategories.js").SettingsCategory>} config.categories
   * @param {object} callbacks
   * @param {(categoryId: string, anchor?: string) => void} callbacks.onNavigate
   * @param {(query: string) => void} callbacks.onSearch
   */
  constructor(config, callbacks) {
    this._categories = config.categories;
    this._callbacks = callbacks;
    /** @type {Map<string, HTMLButtonElement>} */
    this._navButtons = new Map();
    this._highlightTimerId = null;
    this._buildDom();
  }

  /** @returns {HTMLElement} */
  getElement() {
    return this._el;
  }

  /**
   * @param {string} categoryId
   * @returns {void}
   */
  setActiveCategory(categoryId) {
    for (const [id, button] of this._navButtons) {
      const isActive = id === categoryId;
      button.classList.toggle("settings-nav__item--active", isActive);
      if (isActive) {
        button.setAttribute("aria-current", "page");
      } else {
        button.removeAttribute("aria-current");
      }
    }
  }

  /**
   * Replace the content area with a page's element and scroll to top.
   * @param {HTMLElement} pageElement
   * @returns {void}
   */
  setPage(pageElement) {
    clearElement(this._pageHostEl);
    this._pageHostEl.append(pageElement);
    this._contentEl.scrollTop = 0;
  }

  /**
   * Move keyboard focus to the current page's heading, so screen
   * reader and keyboard users land at the start of the new page.
   * @returns {void}
   */
  focusPageHeading() {
    const heading = this._pageHostEl.querySelector("h1[tabindex]");
    heading?.focus({ preventScroll: true });
  }

  /**
   * Scroll a section of the current page into view, briefly highlight
   * it, and move focus to its heading.
   * @param {string} anchor
   * @returns {boolean} Whether the section was found.
   */
  revealAnchor(anchor) {
    const section = this._pageHostEl.querySelector(`[data-settings-anchor="${CSS.escape(anchor)}"]`);
    if (!section) return false;

    // Scroll only the content pane (scrollIntoView could also shift the
    // window body or the desktop behind it).
    const offset = section.getBoundingClientRect().top - this._contentEl.getBoundingClientRect().top;
    this._contentEl.scrollTop = Math.max(0, this._contentEl.scrollTop + offset - 12);
    const heading = section.querySelector("h2");
    if (heading) {
      heading.setAttribute("tabindex", "-1");
      heading.focus({ preventScroll: true });
    }

    for (const previous of this._pageHostEl.querySelectorAll(".settings-section--highlighted")) {
      previous.classList.remove("settings-section--highlighted");
    }
    section.classList.add("settings-section--highlighted");
    window.clearTimeout(this._highlightTimerId);
    this._highlightTimerId = window.setTimeout(() => section.classList.remove("settings-section--highlighted"), ANCHOR_HIGHLIGHT_MS);
    return true;
  }

  /**
   * Show search results in place of the category list, or (with null)
   * restore the category list.
   * @param {Array<{page: string, anchor: string, label: string, pageLabel: string}>|null} results
   * @returns {void}
   */
  setSearchResults(results) {
    const searching = results !== null;
    this._navListEl.hidden = searching;
    this._resultsEl.hidden = !searching;
    clearElement(this._resultsEl);
    if (!searching) return;

    if (results.length === 0) {
      this._resultsEl.append(createElement("li", { className: "settings-search__empty", attrs: { role: "status" }, text: "No matching settings" }));
      return;
    }
    for (const result of results) {
      this._resultsEl.append(
        createElement("li", {
          children: [
            createElement("button", {
              className: "settings-search__result",
              attrs: { type: "button" },
              children: [
                createElement("span", { className: "settings-search__result-label", text: result.label }),
                createElement("span", { className: "settings-search__result-page", text: result.pageLabel }),
              ],
              on: { click: () => this._callbacks.onNavigate(result.page, result.anchor) },
            }),
          ],
        })
      );
    }
  }

  /** @returns {void} */
  clearSearch() {
    this._searchInputEl.value = "";
    this.setSearchResults(null);
  }

  /**
   * Show (or, with null, hide) a status banner above the page.
   * @param {string|null} message
   * @returns {void}
   */
  setStatus(message) {
    this._statusEl.hidden = !message;
    this._statusEl.textContent = message ?? "";
  }

  /** @returns {void} */
  destroy() {
    window.clearTimeout(this._highlightTimerId);
  }

  // ---------------------------------------------------------------
  // DOM construction
  // ---------------------------------------------------------------

  /** @returns {void} */
  _buildDom() {
    const brand = createElement("div", {
      className: "settings-sidebar__brand",
      children: [
        createElement("span", { className: "settings-sidebar__logo", attrs: { "aria-hidden": "true" }, text: "\u2699" }),
        createElement("span", { className: "settings-sidebar__title", text: "Settings" }),
      ],
    });

    this._searchInputEl = createElement("input", {
      className: "settings-sidebar__search-input",
      attrs: { type: "search", placeholder: "Search settings", "aria-label": "Search settings", autocomplete: "off" },
      on: {
        input: () => this._callbacks.onSearch(this._searchInputEl.value),
        keydown: (e) => {
          if (e.key === "Escape" && this._searchInputEl.value) {
            e.preventDefault();
            e.stopPropagation();
            this.clearSearch();
          } else if (e.key === "Enter") {
            const first = this._resultsEl.querySelector("button");
            if (first) {
              e.preventDefault();
              first.click();
            }
          } else if (e.key === "ArrowDown") {
            const first = this._resultsEl.querySelector("button");
            if (first && !this._resultsEl.hidden) {
              e.preventDefault();
              first.focus();
            }
          }
        },
      },
    });

    const search = createElement("div", {
      className: "settings-sidebar__search",
      children: [
        createElement("span", { className: "settings-sidebar__search-icon", attrs: { "aria-hidden": "true" }, text: "\u2315" }),
        this._searchInputEl,
      ],
    });

    this._navListEl = createElement("ul", { className: "settings-nav__list" });
    for (const category of this._categories) {
      this._navListEl.append(createElement("li", { children: [this._buildNavButton(category)] }));
    }

    this._resultsEl = createElement("ul", {
      className: "settings-search__results",
      attrs: { "aria-label": "Settings search results" },
    });
    this._resultsEl.hidden = true;

    const sidebar = createElement("nav", {
      className: "settings-sidebar",
      attrs: { "aria-label": "Settings categories" },
      children: [brand, search, this._navListEl, this._resultsEl],
    });

    this._statusEl = createElement("div", {
      className: "settings-banner",
      attrs: { role: "status" },
    });
    this._statusEl.hidden = true;

    this._pageHostEl = createElement("div", { className: "settings-content__page" });
    this._contentEl = createElement("main", {
      className: "settings-content",
      children: [this._statusEl, this._pageHostEl],
    });

    this._el = createElement("div", {
      className: "settings-app",
      children: [sidebar, this._contentEl],
    });
  }

  /**
   * @param {import("./settingsCategories.js").SettingsCategory} category
   * @returns {HTMLButtonElement}
   */
  _buildNavButton(category) {
    const available = isCategoryAvailable(category);
    const children = [
      createIconElement(category.icon, { className: "settings-nav__icon" }),
      createElement("span", { className: "settings-nav__label", text: category.label }),
    ];
    if (!available) {
      children.push(createElement("span", { className: "settings-nav__badge", text: "Unavailable" }));
    }

    const button = createElement("button", {
      className: `settings-nav__item${available ? "" : " settings-nav__item--unavailable"}`,
      attrs: { type: "button", title: available ? category.label : `${category.label} (unavailable)` },
      children,
      on: available ? { click: () => this._callbacks.onNavigate(category.id) } : {},
    });
    if (!available) button.disabled = true;

    this._navButtons.set(category.id, button);
    return button;
  }
}

export { SettingsView };
