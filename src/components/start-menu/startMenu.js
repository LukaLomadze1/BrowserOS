/**
 * @file StartMenuView — the visual shell of the Start Menu.
 *
 * Built exactly once (by StartMenuManager, at boot) and reused for
 * every open/close — nothing here gets torn down and rebuilt, only
 * the pinned/recent/results sections' contents are swapped out.
 * Like every other *View in this codebase, it holds no cross-cutting
 * state and makes no decisions: it renders what it's told and
 * forwards raw keyboard events upward, so exactly one place
 * (StartMenuManager) owns Escape/Tab/Arrow/Enter behavior.
 */

import { createElement, clearElement } from "../../utils/dom.js";
import { createIconElement } from "../../utils/icons.js";

class StartMenuView {
  /**
   * @param {object} callbacks
   * @param {(query: string) => void} callbacks.onSearchInput
   * @param {(e: KeyboardEvent) => void} callbacks.onKeyDown - Every keydown that occurs anywhere inside the menu.
   */
  constructor(callbacks) {
    this._callbacks = callbacks;
    this._isOpen = false;
    this._sectionVisibility = { pinned: true, recentApps: true, recentFiles: true };
    this._buildDom();
  }

  /** @returns {HTMLElement} */
  getElement() {
    return this._el;
  }

  /** @returns {HTMLInputElement} */
  getSearchInput() {
    return this._searchInputEl;
  }

  /** @returns {void} */
  open() {
    if (this._isOpen) return;
    this._isOpen = true;
    this._el.classList.add("start-menu--visible");
    this._el.setAttribute("aria-hidden", "false");
    // Wait for the visibility class (and thus layout) to apply
    // before focusing, so the focus ring animates in cleanly.
    requestAnimationFrame(() => this._searchInputEl.focus());
  }

  /** @returns {void} */
  close() {
    if (!this._isOpen) return;
    this._isOpen = false;
    this._el.classList.remove("start-menu--visible");
    this._el.setAttribute("aria-hidden", "true");
    this._searchInputEl.value = "";
    this.showDefaultSections();
  }

  /** @returns {boolean} */
  isOpen() {
    return this._isOpen;
  }

  /**
   * @param {Array<{id: string, name: string, icon: string|null}>} apps
   * @param {(id: string) => void} onLaunch
   * @returns {void}
   */
  setPinnedItems(apps, onLaunch) {
    clearElement(this._pinnedGridEl);
    if (apps.length === 0) {
      this._pinnedGridEl.append(createElement("div", { className: "start-menu__empty", text: "No pinned apps" }));
      return;
    }
    for (const app of apps) {
      this._pinnedGridEl.append(this._buildTile(app, onLaunch));
    }
  }

  /**
   * @param {Array<{id: string, name: string, icon: string|null, launchTime: number}>} entries
   * @param {(id: string) => void} onLaunch
   * @returns {void}
   */
  setRecentItems(entries, onLaunch) {
    clearElement(this._recentListEl);
    if (entries.length === 0) {
      this._recentListEl.append(createElement("div", { className: "start-menu__empty", text: "No recent apps yet" }));
      return;
    }
    for (const entry of entries) {
      this._recentListEl.append(this._buildRow(entry, onLaunch, formatRelativeTime(entry.launchTime)));
    }
  }

  /**
   * Recent *files* are a distinct section from recent *applications*
   * — see RecentFilesService for why they're tracked separately.
   * @param {Array<{entryId: string, path: string, name: string, type: string, lastOpenedAt: number}>} entries
   * @param {(path: string) => void} onOpen
   * @returns {void}
   */
  setRecentFiles(entries, onOpen) {
    clearElement(this._recentFilesListEl);
    if (entries.length === 0) {
      this._recentFilesListEl.append(createElement("div", { className: "start-menu__empty", text: "No recent files" }));
      return;
    }
    for (const entry of entries) {
      this._recentFilesListEl.append(this._buildFileRow(entry, onOpen));
    }
  }

  /**
   * Replace the default sections with a list of search results.
   * @param {string} query
   * @param {Array<{key: string, kind: string, name: string, icon: string|null, detail: string, activate: () => void}>} results - Already sorted and limited.
   * @param {{pending?: boolean}} [options] - `pending` shows that more results are still being looked up.
   * @returns {void}
   */
  showSearchResults(query, results, options = {}) {
    this._pinnedSectionEl.hidden = true;
    this._recentSectionEl.hidden = true;
    this._recentFilesSectionEl.hidden = true;
    this._allHiddenEl.hidden = true;
    this._resultsSectionEl.hidden = false;

    clearElement(this._resultsListEl);
    for (const result of results) {
      this._resultsListEl.append(this._buildResultRow(result));
    }
    if (options.pending) {
      this._resultsListEl.append(
        createElement("div", { className: "start-menu__empty start-menu__empty--pending", attrs: { role: "status" }, text: "Searching files\u2026" })
      );
    } else if (results.length === 0) {
      this._resultsListEl.append(
        createElement("div", { className: "start-menu__empty", attrs: { role: "status" }, text: `No results for "${query}"` })
      );
    }
  }

  /** @returns {void} */
  showDefaultSections() {
    this._resultsSectionEl.hidden = true;
    this._applySectionVisibility();
  }

  /**
   * Show or hide the default sections (Pinned, Recent Applications,
   * Recent Files). Takes effect immediately unless search results are
   * currently displayed, in which case it applies once search clears.
   * @param {{pinned: boolean, recentApps: boolean, recentFiles: boolean}} visibility
   * @returns {void}
   */
  setSectionVisibility(visibility) {
    this._sectionVisibility = { ...visibility };
    if (this._resultsSectionEl.hidden) this._applySectionVisibility();
  }

  /**
   * @param {string} text
   * @returns {void}
   */
  setSearchPlaceholder(text) {
    this._searchInputEl.placeholder = text;
  }

  /**
   * @returns {HTMLElement|null} The first search result row, if any.
   */
  getFirstResultButton() {
    if (this._resultsSectionEl.hidden) return null;
    return this._resultsListEl.querySelector(".start-menu__row");
  }

  /** @returns {void} */
  _applySectionVisibility() {
    const { pinned, recentApps, recentFiles } = this._sectionVisibility;
    this._pinnedSectionEl.hidden = !pinned;
    this._recentSectionEl.hidden = !recentApps;
    this._recentFilesSectionEl.hidden = !recentFiles;
    this._allHiddenEl.hidden = pinned || recentApps || recentFiles;
  }

  /**
   * Visible, enabled, focusable elements inside the menu, in DOM
   * order — used by StartMenuManager for the Tab focus trap and
   * Arrow-key navigation.
   * @returns {HTMLElement[]}
   */
  getFocusableElements() {
    return [...this._el.querySelectorAll("input, button:not([disabled])")].filter((el) => el.offsetParent !== null);
  }

  // ---------------------------------------------------------------
  // DOM construction (once)
  // ---------------------------------------------------------------

  /** @returns {void} */
  _buildDom() {
    this._searchInputEl = createElement("input", {
      className: "start-menu__search-input",
      attrs: {
        type: "text",
        placeholder: "Search apps",
        "aria-label": "Search applications",
        autocomplete: "off",
      },
      on: {
        input: (e) => this._callbacks.onSearchInput(e.target.value),
      },
    });

    const searchBar = createElement("div", {
      className: "start-menu__search",
      children: [
        createElement("span", { className: "start-menu__search-icon", attrs: { "aria-hidden": "true" }, text: "\u2315" }),
        this._searchInputEl,
      ],
    });

    this._pinnedGridEl = createElement("div", { className: "start-menu__pinned-grid" });
    this._pinnedSectionEl = createElement("div", {
      className: "start-menu__section",
      children: [
        createElement("div", { className: "start-menu__section-title", text: "Pinned Applications" }),
        this._pinnedGridEl,
      ],
    });

    this._recentListEl = createElement("div", { className: "start-menu__recent-list" });
    this._recentSectionEl = createElement("div", {
      className: "start-menu__section",
      children: [
        createElement("div", { className: "start-menu__section-title", text: "Recent Applications" }),
        this._recentListEl,
      ],
    });

    this._recentFilesListEl = createElement("div", { className: "start-menu__recent-list" });
    this._recentFilesSectionEl = createElement("div", {
      className: "start-menu__section",
      children: [
        createElement("div", { className: "start-menu__section-title", text: "Recent Files" }),
        this._recentFilesListEl,
      ],
    });

    this._resultsListEl = createElement("div", { className: "start-menu__results-list" });
    this._resultsSectionEl = createElement("div", {
      className: "start-menu__section start-menu__section--results",
      attrs: { hidden: "true" },
      children: [
        createElement("div", { className: "start-menu__section-title", text: "Search Results" }),
        this._resultsListEl,
      ],
    });

    this._allHiddenEl = createElement("div", {
      className: "start-menu__empty start-menu__empty--sections",
      text: "Pinned and recent sections are turned off. Type to search, or change this in Settings \u203a Start Menu.",
    });
    this._allHiddenEl.hidden = true;

    const body = createElement("div", {
      className: "start-menu__body",
      children: [
        this._pinnedSectionEl,
        this._recentSectionEl,
        this._recentFilesSectionEl,
        this._allHiddenEl,
        this._resultsSectionEl,
      ],
    });

    const footer = createElement("div", {
      className: "start-menu__footer",
      children: [
        createElement("div", { className: "start-menu__brand", text: "BrowserOS" }),
        createElement("div", {
          className: "start-menu__power",
          attrs: { role: "group", "aria-label": "Power" },
          children: [
            this._buildPowerButton("Lock", "\u{1F512}"),
            this._buildPowerButton("Restart", "\u21bb"),
            this._buildPowerButton("Shut down", "\u23fb"),
          ],
        }),
      ],
    });

    this._el = createElement("div", {
      className: "start-menu",
      attrs: {
        role: "dialog",
        "aria-modal": "true",
        "aria-label": "Start menu",
        "aria-hidden": "true",
      },
      children: [searchBar, body, footer],
      on: {
        keydown: (e) => this._callbacks.onKeyDown(e),
      },
    });
  }

  /**
   * @param {string} label
   * @param {string} glyph
   * @returns {HTMLElement}
   */
  _buildPowerButton(label, glyph) {
    return createElement("button", {
      className: "start-menu__power-button",
      attrs: { type: "button", "aria-label": label, title: label, disabled: "true" },
      text: glyph,
    });
  }

  /**
   * @param {{id: string, name: string, icon: string|null}} app
   * @param {(id: string) => void} onLaunch
   * @returns {HTMLElement}
   */
  _buildTile(app, onLaunch) {
    return createElement("button", {
      className: "start-menu__pinned-tile",
      attrs: { type: "button", "aria-label": app.name, "data-app-id": app.id },
      children: [
        createIconElement(app.icon, { className: "start-menu__pinned-icon" }),
        createElement("span", { className: "start-menu__pinned-label", text: app.name }),
      ],
      on: { click: () => onLaunch(app.id) },
    });
  }

  /**
   * @param {{id: string, name: string, icon: string|null}} app
   * @param {(id: string) => void} onLaunch
   * @param {string|null} timeLabel - Shown as a secondary line when provided (recent items); omitted for search results.
   * @returns {HTMLElement}
   */
  _buildRow(app, onLaunch, timeLabel) {
    const textChildren = [createElement("span", { className: "start-menu__row-name", text: app.name })];
    if (timeLabel) {
      textChildren.push(createElement("span", { className: "start-menu__row-time", text: timeLabel }));
    }

    return createElement("button", {
      className: "start-menu__row",
      attrs: { type: "button", "aria-label": app.name, "data-app-id": app.id },
      children: [
        createIconElement(app.icon, { className: "start-menu__row-icon" }),
        createElement("span", { className: "start-menu__row-text", children: textChildren }),
      ],
      on: { click: () => onLaunch(app.id) },
    });
  }

  /**
   * @param {{key: string, kind: string, name: string, icon: string|null, detail: string, activate: () => void}} result
   * @returns {HTMLElement}
   */
  _buildResultRow(result) {
    return createElement("button", {
      className: `start-menu__row start-menu__row--${result.kind}`,
      attrs: { type: "button", "aria-label": `${result.name}, ${result.detail}`, "data-result-key": result.key },
      children: [
        createIconElement(result.icon, { className: "start-menu__row-icon" }),
        createElement("span", {
          className: "start-menu__row-text",
          children: [
            createElement("span", { className: "start-menu__row-name", text: result.name }),
            createElement("span", { className: "start-menu__row-time", text: result.detail }),
          ],
        }),
      ],
      on: { click: () => result.activate() },
    });
  }

  /**
   * @param {{path: string, name: string, lastOpenedAt: number}} fileEntry
   * @param {(path: string) => void} onOpen
   * @returns {HTMLElement}
   */
  _buildFileRow(fileEntry, onOpen) {
    return createElement("button", {
      className: "start-menu__row",
      attrs: { type: "button", "aria-label": fileEntry.name, "data-file-path": fileEntry.path },
      children: [
        createElement("span", { className: "start-menu__row-icon", attrs: { "aria-hidden": "true" }, text: "\u25a2" }),
        createElement("span", {
          className: "start-menu__row-text",
          children: [
            createElement("span", { className: "start-menu__row-name", text: fileEntry.name }),
            createElement("span", { className: "start-menu__row-time", text: formatRelativeTime(fileEntry.lastOpenedAt) }),
          ],
        }),
      ],
      on: { click: () => onOpen(fileEntry.path) },
    });
  }
}

/**
 * @param {number} timestamp
 * @returns {string}
 */
function formatRelativeTime(timestamp) {
  const diffMs = Date.now() - timestamp;
  const diffMin = Math.round(diffMs / 60000);
  if (diffMin < 1) return "Just now";
  if (diffMin < 60) return `${diffMin} minute${diffMin === 1 ? "" : "s"} ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr} hour${diffHr === 1 ? "" : "s"} ago`;
  const diffDay = Math.round(diffHr / 24);
  return `${diffDay} day${diffDay === 1 ? "" : "s"} ago`;
}

export { StartMenuView };
