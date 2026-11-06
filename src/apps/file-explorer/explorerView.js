/**
 * @file ExplorerView — the visual shell of one File Explorer window.
 * Built once per window (by ExplorerManager, at launch) and reused
 * for its entire lifetime — navigation only ever swaps the list
 * contents, sidebar highlight, breadcrumbs, and status text, never
 * rebuilds the whole window. Like every other *View in this
 * codebase, it makes no decisions: it renders what it's told and
 * forwards raw actions upward (button clicks, item clicks, keydowns),
 * so exactly one place — ExplorerManager — decides what they mean.
 *
 * List-container-level interaction (marquee selection, keyboard nav,
 * empty-space context menu) is deliberately NOT routed through
 * callbacks here — ExplorerManager attaches those directly to
 * `getListContainer()`, the same pattern DesktopManager uses on its
 * icon layer, since that state (drag origin, focus index) belongs to
 * the manager, not the view.
 */

import { createElement, clearElement } from "../../utils/dom.js";

class ExplorerView {
  /**
   * @param {object} callbacks
   * @param {() => void} callbacks.onBack
   * @param {() => void} callbacks.onForward
   * @param {() => void} callbacks.onUp
   * @param {() => void} callbacks.onRefresh
   * @param {() => void} callbacks.onNewFolder
   * @param {() => void} callbacks.onNewTextDocument
   * @param {() => void} callbacks.onCopy
   * @param {() => void} callbacks.onCut
   * @param {() => void} callbacks.onPaste
   * @param {() => void} callbacks.onDelete
   * @param {(mode: "grid"|"list"|"details") => void} callbacks.onViewModeChange
   * @param {(field: string) => void} callbacks.onSortChange
   * @param {() => void} callbacks.onAddressToggle
   * @param {(value: string) => void} callbacks.onAddressSubmit
   * @param {(value: string) => void} callbacks.onSearchInput
   * @param {(checked: boolean) => void} callbacks.onSearchRecursiveToggle
   * @param {(path: string) => void} callbacks.onSidebarNavigate
   * @param {(files: File[]) => void} callbacks.onImportFiles - Files chosen with Import or dropped onto the list.
   */
  constructor(callbacks) {
    this._callbacks = callbacks;
    this._viewMode = "grid";
    /** @type {{size: boolean, modified: boolean, type: boolean}} */
    this._columns = { size: true, modified: true, type: true };
    this._buildDom();
  }

  /** @returns {HTMLElement} */
  getElement() {
    return this._el;
  }

  /** @returns {HTMLElement} */
  getListContainer() {
    return this._listEl;
  }

  // ---------------------------------------------------------------
  // Toolbar
  // ---------------------------------------------------------------

  /**
   * Import is only possible into real folders, not Home or Favorites.
   * @param {boolean} enabled
   * @returns {void}
   */
  setImportEnabled(enabled) {
    this._importButton.disabled = !enabled;
  }

  /**
   * @param {{canBack: boolean, canForward: boolean, canUp: boolean}} state
   * @returns {void}
   */
  setNavButtonsState(state) {
    this._backButton.disabled = !state.canBack;
    this._forwardButton.disabled = !state.canForward;
    this._upButton.disabled = !state.canUp;
  }

  /**
   * @param {"grid"|"list"|"details"} mode
   * @returns {void}
   */
  setViewMode(mode) {
    this._viewMode = mode;
    this._listEl.className = `explorer__list explorer__list--${mode}`;
    for (const [key, button] of Object.entries(this._viewModeButtons)) {
      button.classList.toggle("explorer__view-button--active", key === mode);
    }
    this._detailsHeaderEl.hidden = mode !== "details";
  }

  /**
   * Which metadata columns the Details view shows (and which details
   * the List view adds after each name). Name is always shown. Takes
   * effect on the next renderItems().
   * @param {{size: boolean, modified: boolean, type: boolean}} columns
   * @returns {void}
   */
  setColumnVisibility(columns) {
    this._columns = { ...columns };
    const tracks = ["minmax(0, 1fr)"];
    if (columns.modified) tracks.push("140px");
    if (columns.type) tracks.push("100px");
    if (columns.size) tracks.push("90px");
    // One per-window custom property keeps the header and every row on
    // the same grid tracks.
    this._el.style.setProperty("--explorer-details-columns", tracks.join(" "));
    this._detailsHeaderButtons.modified.hidden = !columns.modified;
    this._detailsHeaderButtons.type.hidden = !columns.type;
    this._detailsHeaderButtons.size.hidden = !columns.size;
  }

  /**
   * @param {Array<{key: string, label: string, direction: "asc"|"desc"|null}>} columns
   * @returns {void}
   */
  setSortIndicators(columns) {
    for (const column of columns) {
      const button = this._detailsHeaderButtons[column.key];
      if (!button) continue;
      button.dataset.direction = column.direction ?? "";
      button.setAttribute("aria-sort", column.direction === "asc" ? "ascending" : column.direction === "desc" ? "descending" : "none");
    }
  }

  // ---------------------------------------------------------------
  // Address bar / breadcrumbs
  // ---------------------------------------------------------------

  /**
   * @param {Array<{label: string, path: string|null}>} segments - `path: null` renders as an inert ellipsis (collapsed segments).
   * @returns {void}
   */
  setBreadcrumbs(segments) {
    clearElement(this._breadcrumbsEl);
    segments.forEach((segment, index) => {
      if (index > 0) {
        this._breadcrumbsEl.append(createElement("span", { className: "explorer__breadcrumb-sep", attrs: { "aria-hidden": "true" }, text: "\u203a" }));
      }
      if (segment.path === null) {
        this._breadcrumbsEl.append(createElement("span", { className: "explorer__breadcrumb-ellipsis", text: segment.label }));
        return;
      }
      this._breadcrumbsEl.append(
        createElement("button", {
          className: "explorer__breadcrumb",
          attrs: { type: "button" },
          text: segment.label,
          on: { click: () => this._callbacks.onSidebarNavigate(segment.path) },
        })
      );
    });
  }

  /**
   * @param {"breadcrumbs"|"editing"} mode
   * @param {string} [pathValue] - Required when mode is "editing".
   * @returns {void}
   */
  setAddressMode(mode, pathValue = "") {
    const editing = mode === "editing";
    this._breadcrumbsEl.hidden = editing;
    this._addressInputEl.hidden = !editing;
    if (editing) {
      this._addressInputEl.value = pathValue;
      requestAnimationFrame(() => {
        this._addressInputEl.focus();
        this._addressInputEl.select();
      });
    }
  }

  // ---------------------------------------------------------------
  // Sidebar
  // ---------------------------------------------------------------

  /**
   * @param {Array<{key: string, label: string, path: string, icon: string}>} items
   * @returns {void}
   */
  setSidebarItems(items) {
    clearElement(this._sidebarListEl);
    for (const item of items) {
      this._sidebarListEl.append(
        createElement("button", {
          className: "explorer__sidebar-item",
          attrs: { type: "button", "data-sidebar-path": item.path },
          children: [
            createElement("span", { className: "explorer__sidebar-icon", attrs: { "aria-hidden": "true" }, text: item.icon }),
            createElement("span", { className: "explorer__sidebar-label", text: item.label }),
          ],
          on: { click: () => this._callbacks.onSidebarNavigate(item.path) },
        })
      );
    }
  }

  /**
   * @param {string} activePath
   * @returns {void}
   */
  setActiveSidebarPath(activePath) {
    for (const el of this._sidebarListEl.querySelectorAll(".explorer__sidebar-item")) {
      el.classList.toggle("explorer__sidebar-item--active", el.dataset.sidebarPath === activePath);
    }
  }

  // ---------------------------------------------------------------
  // List rendering
  // ---------------------------------------------------------------

  /**
   * @param {Array<object>} items - VFS entries, each with `_selected`/`_cut`/`_typeLabel`/`_sizeLabel`/`_modifiedLabel` UI fields mixed in by the manager.
   * @param {object} rowCallbacks
   * @param {(entryId: string, e: MouseEvent) => void} rowCallbacks.onClick
   * @param {(entryId: string) => void} rowCallbacks.onDoubleClick
   * @param {(entryId: string, x: number, y: number) => void} rowCallbacks.onContextMenu
   * @returns {void}
   */
  renderItems(items, rowCallbacks) {
    clearElement(this._listEl);
    if (items.length === 0) {
      this._listEl.append(createElement("div", { className: "explorer__empty", text: "This folder is empty" }));
      return;
    }
    for (const item of items) {
      this._listEl.append(this._buildRow(item, rowCallbacks));
    }
  }

  /**
   * @param {string} message
   * @returns {void}
   */
  showEmptyState(message) {
    clearElement(this._listEl);
    this._listEl.append(createElement("div", { className: "explorer__empty", text: message }));
  }

  /** @returns {void} */
  showLoading() {
    clearElement(this._listEl);
    this._listEl.append(createElement("div", { className: "explorer__empty", text: "Loading\u2026" }));
  }

  /**
   * @param {string} message
   * @returns {void}
   */
  showError(message) {
    clearElement(this._listEl);
    this._listEl.append(createElement("div", { className: "explorer__empty explorer__empty--error", text: message }));
  }

  /**
   * @param {object} item
   * @param {object} rowCallbacks
   * @returns {HTMLElement}
   */
  _buildRow(item, rowCallbacks) {
    const icon = item._icon ?? (item.type === "folder" ? "\u25a4" : "\u25a2");
    const classNames = ["explorer__row"];
    if (item._selected) classNames.push("explorer__row--selected");
    if (item._cut) classNames.push("explorer__row--cut");

    const iconEl = createElement("span", { className: "explorer__row-icon", attrs: { "aria-hidden": "true" }, text: icon });
    const displayName = item._displayName ?? item.name;
    const nameEl = createElement("span", { className: "explorer__row-name", text: displayName });
    const columns = this._columns;

    let children;
    if (this._viewMode === "details") {
      children = [createElement("span", { className: "explorer__row-cell explorer__row-cell--name", children: [iconEl, nameEl] })];
      if (columns.modified) {
        children.push(createElement("span", { className: "explorer__row-cell explorer__row-cell--modified", text: item._modifiedLabel ?? "" }));
      }
      if (columns.type) {
        children.push(createElement("span", { className: "explorer__row-cell explorer__row-cell--type", text: item._typeLabel ?? "" }));
      }
      if (columns.size) {
        children.push(createElement("span", { className: "explorer__row-cell explorer__row-cell--size", text: item._sizeLabel ?? "" }));
      }
    } else if (this._viewMode === "list") {
      const details = [];
      if (columns.type) details.push(item._typeLabel);
      if (columns.size && item._sizeLabel) details.push(item._sizeLabel);
      if (columns.modified) details.push(item._modifiedLabel);
      children = [iconEl, nameEl, createElement("span", { className: "explorer__row-type", text: details.filter(Boolean).join(" \u00b7 ") })];
    } else {
      children = [iconEl, nameEl];
    }

    return createElement("button", {
      className: classNames.join(" "),
      attrs: {
        type: "button",
        "data-entry-id": item.id,
        "aria-selected": item._selected ? "true" : "false",
        // The accessible name and tooltip always carry the real name,
        // even when the extension is hidden from the visible label.
        "aria-label": item.name,
        title: item.path,
      },
      children,
      on: {
        click: (e) => rowCallbacks.onClick(item.id, e),
        dblclick: (e) => {
          e.stopPropagation();
          rowCallbacks.onDoubleClick(item.id);
        },
        contextmenu: (e) => {
          e.preventDefault();
          e.stopPropagation();
          rowCallbacks.onContextMenu(item.id, e.clientX, e.clientY);
        },
      },
    });
  }

  /**
   * Visible row elements in DOM (i.e. sorted) order — used by the
   * manager for Arrow-key navigation and Shift+Click ranges.
   * @returns {HTMLElement[]}
   */
  getRowElements() {
    return [...this._listEl.querySelectorAll(".explorer__row")];
  }

  /**
   * @param {string} entryId
   * @param {boolean} selected
   * @returns {void}
   */
  setRowSelected(entryId, selected) {
    const row = this._listEl.querySelector(`[data-entry-id="${cssEscape(entryId)}"]`);
    if (!row) return;
    row.classList.toggle("explorer__row--selected", selected);
    row.setAttribute("aria-selected", selected ? "true" : "false");
  }

  // ---------------------------------------------------------------
  // Rename (inline, within a row)
  // ---------------------------------------------------------------

  /**
   * @param {string} entryId
   * @param {{stem: string, extension: string, onConfirm: (value: string) => Promise<boolean>, onCancel: () => void}} config
   * @returns {void}
   */
  startRenameForItem(entryId, config) {
    const row = this._listEl.querySelector(`[data-entry-id="${cssEscape(entryId)}"]`);
    if (!row) return;
    const nameEl = row.querySelector(".explorer__row-name");
    if (!nameEl) return;

    // The visible label may omit the extension; the input always holds the real name.
    const fullName = `${config.stem}${config.extension}`;
    const inputEl = createElement("input", {
      className: "explorer__rename-input",
      attrs: { type: "text", "aria-label": `Rename ${fullName}`, spellcheck: "false" },
    });
    inputEl.value = fullName;

    const errorEl = createElement("div", { className: "explorer__rename-error", attrs: { role: "alert" } });

    nameEl.replaceWith(inputEl);
    row.append(errorEl);
    row.classList.add("explorer__row--renaming");

    const finish = async (confirm) => {
      if (confirm) {
        const ok = await config.onConfirm(inputEl.value);
        if (!ok) return;
      } else {
        config.onCancel();
      }
      errorEl.remove();
      inputEl.replaceWith(nameEl);
      row.classList.remove("explorer__row--renaming", "explorer__row--rename-error");
    };

    inputEl.addEventListener("pointerdown", (e) => e.stopPropagation());
    inputEl.addEventListener("click", (e) => e.stopPropagation());
    inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        finish(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        finish(false);
      }
    });
    inputEl.addEventListener("blur", () => finish(true));

    requestAnimationFrame(() => {
      inputEl.focus();
      if (config.extension) {
        inputEl.setSelectionRange(0, config.stem.length);
      } else {
        inputEl.select();
      }
    });
  }

  /**
   * @param {string} entryId
   * @param {string} message
   * @returns {void}
   */
  showRenameError(entryId, message) {
    const row = this._listEl.querySelector(`[data-entry-id="${cssEscape(entryId)}"]`);
    const errorEl = row?.querySelector(".explorer__rename-error");
    const inputEl = row?.querySelector(".explorer__rename-input");
    if (!errorEl || !inputEl) return;
    errorEl.textContent = message;
    row.classList.add("explorer__row--rename-error");
    inputEl.focus();
  }

  // ---------------------------------------------------------------
  // Home view
  // ---------------------------------------------------------------

  /**
   * @param {Array<{path: string, name: string}>} recentFiles
   * @param {Array<object>} favoriteFolders
   * @param {{onOpenPath: (path: string) => void}} rowCallbacks
   * @returns {void}
   */
  renderHome(recentFiles, favoriteFolders, rowCallbacks) {
    clearElement(this._listEl);
    this._listEl.className = "explorer__list explorer__list--home";

    const section = (title, entries, emptyText) => {
      const listEl = createElement("div", { className: "explorer__home-list" });
      if (entries.length === 0) {
        listEl.append(createElement("div", { className: "explorer__empty", text: emptyText }));
      } else {
        for (const entry of entries) {
          listEl.append(
            createElement("button", {
              className: "explorer__row explorer__row--home",
              attrs: { type: "button" },
              children: [
                createElement("span", {
                  className: "explorer__row-icon",
                  attrs: { "aria-hidden": "true" },
                  text: entry._icon ?? (entry.type === "folder" ? "\u25a4" : "\u25a2"),
                }),
                createElement("span", { className: "explorer__row-name", text: entry.name }),
                createElement("span", { className: "explorer__row-type", text: entry.path }),
              ],
              on: { dblclick: () => rowCallbacks.onOpenPath(entry.path) },
            })
          );
        }
      }
      return createElement("div", {
        className: "explorer__home-section",
        children: [createElement("div", { className: "explorer__home-title", text: title }), listEl],
      });
    };

    this._listEl.append(
      section("Recent Files", recentFiles, "No recent files"),
      section("Favorites", favoriteFolders, "No favorite folders yet")
    );
  }

  // ---------------------------------------------------------------
  // Status bar
  // ---------------------------------------------------------------

  /**
   * @param {string} text
   * @returns {void}
   */
  setStatus(text) {
    this._statusEl.textContent = text;
  }

  // ---------------------------------------------------------------
  // DOM construction (once)
  // ---------------------------------------------------------------

  /** @returns {void} */
  _buildDom() {
    this._backButton = this._navButton("\u2039", "Back", () => this._callbacks.onBack());
    this._forwardButton = this._navButton("\u203a", "Forward", () => this._callbacks.onForward());
    this._upButton = this._navButton("\u2191", "Up one level", () => this._callbacks.onUp());
    const refreshButton = this._navButton("\u21bb", "Refresh", () => this._callbacks.onRefresh());

    const navGroup = createElement("div", {
      className: "explorer__nav-buttons",
      children: [this._backButton, this._forwardButton, this._upButton, refreshButton],
    });

    this._breadcrumbsEl = createElement("div", { className: "explorer__breadcrumbs", attrs: { role: "navigation", "aria-label": "Breadcrumb" } });
    this._addressInputEl = createElement("input", {
      className: "explorer__address-input",
      attrs: { type: "text", "aria-label": "Path", hidden: "true" },
      on: {
        keydown: (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            this._callbacks.onAddressSubmit(this._addressInputEl.value);
          } else if (e.key === "Escape") {
            e.preventDefault();
            this.setAddressMode("breadcrumbs");
          }
        },
        blur: () => this.setAddressMode("breadcrumbs"),
      },
    });
    const addressBar = createElement("div", { className: "explorer__address", children: [this._breadcrumbsEl, this._addressInputEl] });
    addressBar.addEventListener("click", (e) => {
      if (e.target === addressBar || e.target === this._breadcrumbsEl) this._callbacks.onAddressToggle();
    });

    const searchInput = createElement("input", {
      className: "explorer__search-input",
      attrs: { type: "search", placeholder: "Search this folder", "aria-label": "Search" },
      on: { input: (e) => this._callbacks.onSearchInput(e.target.value) },
    });
    const searchRecursive = createElement("input", {
      className: "explorer__search-recursive",
      attrs: { type: "checkbox", id: "explorer-search-recursive", "aria-label": "Include subfolders" },
      on: { change: (e) => this._callbacks.onSearchRecursiveToggle(e.target.checked) },
    });
    const searchGroup = createElement("div", {
      className: "explorer__search",
      children: [
        searchInput,
        createElement("label", {
          className: "explorer__search-recursive-label",
          attrs: { for: "explorer-search-recursive" },
          children: [searchRecursive, createElement("span", { text: "Subfolders" })],
        }),
      ],
    });

    this._viewModeButtons = {
      grid: this._viewButton("\u25a6", "Grid view", "grid"),
      list: this._viewButton("\u2630", "List view", "list"),
      details: this._viewButton("\u2261", "Details view", "details"),
    };
    const viewModeGroup = createElement("div", {
      className: "explorer__view-buttons",
      children: [this._viewModeButtons.grid, this._viewModeButtons.list, this._viewModeButtons.details],
    });

    this._importInput = createElement("input", {
      className: "explorer__import-input",
      attrs: { type: "file", multiple: "", tabindex: "-1", "aria-hidden": "true" },
      on: {
        change: () => {
          const files = [...this._importInput.files];
          this._importInput.value = "";
          if (files.length > 0) this._callbacks.onImportFiles(files);
        },
      },
    });
    this._importButton = this._actionButton("Import\u2026", () => this._importInput.click());
    this._importButton.title = "Copy files from this computer into the current folder";

    const actionsGroup = createElement("div", {
      className: "explorer__toolbar-actions",
      children: [
        this._importButton,
        this._importInput,
        this._actionButton("New Folder", () => this._callbacks.onNewFolder()),
        this._actionButton("New Document", () => this._callbacks.onNewTextDocument()),
        this._actionButton("Copy", () => this._callbacks.onCopy()),
        this._actionButton("Cut", () => this._callbacks.onCut()),
        this._actionButton("Paste", () => this._callbacks.onPaste()),
        this._actionButton("Delete", () => this._callbacks.onDelete()),
      ],
    });

    const toolbar = createElement("div", {
      className: "explorer__toolbar",
      children: [navGroup, addressBar, searchGroup, viewModeGroup],
    });

    this._sidebarListEl = createElement("div", { className: "explorer__sidebar-list", attrs: { role: "list" } });
    const sidebar = createElement("div", { className: "explorer__sidebar", children: [this._sidebarListEl] });

    this._detailsHeaderButtons = {
      name: this._sortHeaderButton("Name", "name"),
      modified: this._sortHeaderButton("Date modified", "modified"),
      type: this._sortHeaderButton("Type", "type"),
      size: this._sortHeaderButton("Size", "size"),
    };
    this._detailsHeaderEl = createElement("div", {
      className: "explorer__list-header",
      attrs: { hidden: "true" },
      children: Object.values(this._detailsHeaderButtons),
    });

    this._listEl = createElement("div", {
      className: "explorer__list explorer__list--grid",
      attrs: { role: "list", "aria-label": "Folder contents", tabindex: "0" },
    });
    // Files dragged in from the host computer are imported here.
    this._listEl.addEventListener("dragover", (e) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      this._listEl.classList.add("explorer__list--drop-target");
    });
    this._listEl.addEventListener("dragleave", (e) => {
      if (!this._listEl.contains(e.relatedTarget)) this._listEl.classList.remove("explorer__list--drop-target");
    });
    this._listEl.addEventListener("drop", (e) => {
      this._listEl.classList.remove("explorer__list--drop-target");
      const files = [...(e.dataTransfer?.files ?? [])];
      if (files.length === 0) return;
      e.preventDefault();
      this._callbacks.onImportFiles(files);
    });

    const main = createElement("div", { className: "explorer__main", children: [this._detailsHeaderEl, this._listEl] });
    const body = createElement("div", { className: "explorer__body", children: [sidebar, main] });

    this._statusEl = createElement("div", { className: "explorer__status-text" });
    const statusBar = createElement("div", { className: "explorer__statusbar", children: [this._statusEl, actionsGroup] });

    this._el = createElement("div", { className: "explorer", children: [toolbar, body, statusBar] });
  }

  /**
   * @param {string} glyph
   * @param {string} label
   * @param {() => void} onClick
   * @returns {HTMLElement}
   */
  _navButton(glyph, label, onClick) {
    return createElement("button", {
      className: "explorer__nav-button",
      attrs: { type: "button", "aria-label": label, title: label },
      text: glyph,
      on: { click: onClick },
    });
  }

  /**
   * @param {string} label
   * @param {() => void} onClick
   * @returns {HTMLElement}
   */
  _actionButton(label, onClick) {
    return createElement("button", {
      className: "explorer__action-button",
      attrs: { type: "button" },
      text: label,
      on: { click: onClick },
    });
  }

  /**
   * @param {string} glyph
   * @param {string} label
   * @param {"grid"|"list"|"details"} mode
   * @returns {HTMLElement}
   */
  _viewButton(glyph, label, mode) {
    return createElement("button", {
      className: "explorer__view-button",
      attrs: { type: "button", "aria-label": label, title: label },
      text: glyph,
      on: { click: () => this._callbacks.onViewModeChange(mode) },
    });
  }

  /**
   * @param {string} label
   * @param {string} field
   * @returns {HTMLElement}
   */
  _sortHeaderButton(label, field) {
    return createElement("button", {
      className: `explorer__list-header-button explorer__list-header-button--${field}`,
      attrs: { type: "button", "aria-sort": "none" },
      text: label,
      on: { click: () => this._callbacks.onSortChange(field) },
    });
  }
}

/**
 * Minimal CSS.escape fallback for building attribute selectors from
 * VFS entry ids (which may contain characters like "-").
 * @param {string} value
 * @returns {string}
 */
function cssEscape(value) {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
  return value.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}

export { ExplorerView };
