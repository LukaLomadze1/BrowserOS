/**
 * @file Search across the project, with optional replace.
 *
 * Searches every text file of the project (open files use their
 * current, possibly unsaved, text). Results are grouped by file; each
 * match shows its line and opens the file at that position. Replacing
 * in a file that is open edits the editor (undoable, saved like any
 * other change); replacing in a file that isn't open writes it through
 * the VFS after a confirmation that names the files and match counts.
 * Read-only, binary, and very large files are never changed.
 */

import { createElement } from "../../../utils/dom.js";
import { createIconElement } from "../../../utils/icons.js";
import { buildSearchPattern } from "../editor/codeEditor.js";
import { expandReplacement } from "./findWidget.js";
import { relativeTo } from "../project/paths.js";

const SEARCH_DELAY_MS = 250;
const MAX_RESULTS = 5000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/**
 * @typedef {object} SearchHost
 * @property {() => object[]} getFiles - Project file entries.
 * @property {() => string} getRoot - Project root (for display).
 * @property {(path: string) => Promise<string|null>} readText - Current text (unsaved edits included), or null.
 * @property {(path: string) => boolean} isOpen - Whether a file is open in an editor.
 * @property {(path: string, line: number, column: number, length: number) => void} openAt
 * @property {(changes: Array<{path: string, text: string, count: number}>) => Promise<void>} applyReplacements
 */

export class SearchPanel {
  /**
   * @param {SearchHost} host
   */
  constructor(host) {
    this._host = host;
    this._options = { caseSensitive: false, wholeWord: false, regex: false };
    this._timer = 0;
    this._runId = 0;
    /** @type {Array<{path: string, matches: Array<{line: number, column: number, length: number, preview: string, offset: number}>}>} */
    this._results = [];
    this._collapsed = new Set();
    this._build();
  }

  /** @returns {HTMLElement} */
  getElement() {
    return this._root;
  }

  /**
   * @param {string} [query] - Seed text (e.g. the editor selection).
   * @param {{replace?: boolean}} [options]
   * @returns {void}
   */
  focus(query, { replace = false } = {}) {
    if (query && !query.includes("\n")) {
      this._query.value = query;
      this.schedule();
    }
    if (replace) this._setReplaceVisible(true);
    this._query.focus();
    this._query.select();
  }

  /** Re-run the current search soon (files changed). */
  schedule() {
    window.clearTimeout(this._timer);
    this._timer = window.setTimeout(() => this._run(), SEARCH_DELAY_MS);
  }

  /** @returns {void} */
  clear() {
    this._results = [];
    this._renderResults();
  }

  /** @returns {void} */
  destroy() {
    window.clearTimeout(this._timer);
    this._runId += 1;
  }

  // ---------------------------------------------------------------

  /** @returns {void} */
  _build() {
    const toggle = (label, text, key) => {
      const button = createElement("button", {
        className: "cs-find__toggle",
        text,
        attrs: { type: "button", title: label, "aria-label": label, "aria-pressed": "false" },
        on: {
          click: () => {
            this._options[key] = !this._options[key];
            button.setAttribute("aria-pressed", String(this._options[key]));
            this.schedule();
          },
        },
      });
      return button;
    };
    this._query = createElement("input", {
      className: "cs-find__input",
      attrs: { type: "search", placeholder: "Search", "aria-label": "Search in project", spellcheck: "false", autocomplete: "off" },
      on: {
        input: () => this.schedule(),
        keydown: (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            window.clearTimeout(this._timer);
            this._run();
          }
        },
      },
    });
    this._include = createElement("input", {
      className: "cs-find__input",
      attrs: { type: "text", placeholder: "Files to include (e.g. .css, src/)", "aria-label": "Files to include", spellcheck: "false", autocomplete: "off" },
      on: { input: () => this.schedule() },
    });
    this._replace = createElement("input", {
      className: "cs-find__input",
      attrs: { type: "text", placeholder: "Replace", "aria-label": "Replace with", spellcheck: "false", autocomplete: "off" },
    });
    this._replaceAllButton = createElement("button", {
      className: "cs-text-button",
      text: "Replace all",
      attrs: { type: "button" },
      on: { click: () => this._replaceAll(null) },
    });
    this._replaceRow = createElement("div", { className: "cs-search__row", children: [this._replace, this._replaceAllButton] });
    this._replaceRow.hidden = true;
    this._expand = createElement("button", {
      className: "cs-icon-button",
      attrs: { type: "button", title: "Toggle replace", "aria-label": "Toggle replace", "aria-expanded": "false" },
      children: [createIconElement("icon:chevronRight")],
      on: { click: () => this._setReplaceVisible(this._replaceRow.hidden) },
    });
    this._summary = createElement("p", { className: "cs-search__summary", attrs: { role: "status", "aria-live": "polite" } });
    this._list = createElement("div", { className: "cs-search__results", attrs: { role: "tree", "aria-label": "Search results" } });
    this._root = createElement("div", {
      className: "cs-search",
      children: [
        createElement("div", {
          className: "cs-search__row",
          children: [this._expand, this._query, toggle("Match case", "Aa", "caseSensitive"), toggle("Whole word", "ab", "wholeWord"), toggle("Regular expression", ".*", "regex")],
        }),
        this._replaceRow,
        createElement("div", { className: "cs-search__row", children: [this._include] }),
        this._summary,
        this._list,
      ],
    });
  }

  /**
   * @param {boolean} visible
   * @returns {void}
   */
  _setReplaceVisible(visible) {
    this._replaceRow.hidden = !visible;
    this._expand.setAttribute("aria-expanded", String(visible));
    this._expand.replaceChildren(createIconElement(visible ? "icon:chevronDown" : "icon:chevronRight"));
    this._renderResults();
  }

  /**
   * @param {string} path
   * @returns {boolean}
   */
  _included(path) {
    const filters = this._include.value
      .split(",")
      .map((part) => part.trim().toLowerCase())
      .filter(Boolean);
    if (filters.length === 0) return true;
    const relative = relativeTo(path, this._host.getRoot()).toLowerCase();
    return filters.some((filter) => {
      if (filter.startsWith("*.")) return relative.endsWith(filter.slice(1));
      if (filter.startsWith(".")) return relative.endsWith(filter);
      return relative.includes(filter);
    });
  }

  /** @returns {Promise<void>} */
  async _run() {
    const runId = ++this._runId;
    const query = this._query.value;
    const pattern = buildSearchPattern(query, this._options);
    this._query.classList.toggle("cs-find__input--error", Boolean(pattern.error));
    if (!query || !pattern.regex) {
      this._results = [];
      this._summary.textContent = pattern.error ? `Invalid pattern: ${pattern.error}` : "";
      this._renderResults();
      return;
    }
    this._summary.textContent = "Searching\u2026";
    const results = [];
    let total = 0;
    let truncated = false;
    for (const entry of this._host.getFiles()) {
      if (runId !== this._runId) return;
      if (!this._included(entry.path) || (entry.size ?? 0) > MAX_FILE_BYTES) continue;
      const text = await this._host.readText(entry.path);
      if (text === null || runId !== this._runId) continue;
      const matches = findMatches(text, pattern.regex);
      if (!matches.length) continue;
      results.push({ path: entry.path, matches });
      total += matches.length;
      if (total >= MAX_RESULTS) {
        truncated = true;
        break;
      }
    }
    if (runId !== this._runId) return;
    this._results = results;
    const files = results.length;
    this._summary.textContent = total
      ? `${total.toLocaleString()} result${total === 1 ? "" : "s"} in ${files} file${files === 1 ? "" : "s"}${truncated ? " (showing the first 5,000)" : ""}`
      : "No results";
    this._renderResults();
  }

  /** @returns {void} */
  _renderResults() {
    const root = this._host.getRoot();
    const showReplace = !this._replaceRow.hidden;
    this._replaceAllButton.disabled = this._results.length === 0;
    const groups = this._results.map((group) => {
      const collapsed = this._collapsed.has(group.path);
      const header = createElement("div", {
        className: "cs-search__file",
        attrs: { role: "treeitem", "aria-expanded": String(!collapsed), tabindex: "0", title: group.path },
        children: [
          createIconElement(collapsed ? "icon:chevronRight" : "icon:chevronDown", { className: "cs-search__twisty" }),
          createElement("span", { className: "cs-search__name", text: group.path.split("/").pop() }),
          createElement("span", { className: "cs-search__dir", text: relativeTo(group.path, root).split("/").slice(0, -1).join("/") }),
          createElement("span", { className: "cs-badge", text: String(group.matches.length) }),
          showReplace
            ? createElement("button", {
                className: "cs-icon-button cs-search__replace-file",
                attrs: { type: "button", title: "Replace in this file", "aria-label": `Replace in ${group.path.split("/").pop()}` },
                children: [createIconElement("icon:edit")],
                on: {
                  click: (e) => {
                    e.stopPropagation();
                    this._replaceAll(group.path);
                  },
                },
              })
            : null,
        ].filter(Boolean),
      });
      const toggle = () => {
        if (this._collapsed.has(group.path)) this._collapsed.delete(group.path);
        else this._collapsed.add(group.path);
        this._renderResults();
      };
      header.addEventListener("click", toggle);
      header.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          toggle();
        }
      });
      const items = collapsed
        ? []
        : group.matches.map((match) => {
            const before = match.preview.slice(0, match.previewStart);
            const hit = match.preview.slice(match.previewStart, match.previewStart + match.previewLength);
            const after = match.preview.slice(match.previewStart + match.previewLength);
            const item = createElement("div", {
              className: "cs-search__match",
              attrs: { role: "treeitem", tabindex: "0", title: `Line ${match.line}` },
              children: [
                createElement("span", { className: "cs-search__line", text: String(match.line) }),
                createElement("span", {
                  className: "cs-search__preview",
                  children: [before, createElement("mark", { text: hit }), after],
                }),
              ],
            });
            const open = () => this._host.openAt(group.path, match.line, match.column, match.length);
            item.addEventListener("click", open);
            item.addEventListener("keydown", (e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                open();
              }
            });
            return item;
          });
      return createElement("div", { className: "cs-search__group", attrs: { role: "group" }, children: [header, ...items] });
    });
    this._list.replaceChildren(...groups);
  }

  /**
   * Replace every match, in one file or in all files with results.
   * @param {string|null} onlyPath
   * @returns {Promise<void>}
   */
  async _replaceAll(onlyPath) {
    const pattern = buildSearchPattern(this._query.value, this._options);
    if (!pattern.regex) return;
    const replacement = this._replace.value;
    const changes = [];
    for (const group of this._results) {
      if (onlyPath && group.path !== onlyPath) continue;
      const text = await this._host.readText(group.path);
      if (text === null) continue;
      let count = 0;
      const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
      const next = text.replace(regex, (...args) => {
        const matched = args[0];
        if (!matched) return matched;
        count += 1;
        if (!this._options.regex) return replacement;
        const groups = typeof args[args.length - 1] === "object" ? args[args.length - 1] : undefined;
        return expandReplacement(replacement, matched, args.slice(1, groups ? -3 : -2), groups);
      });
      if (count && next !== text) changes.push({ path: group.path, text: next, count });
    }
    if (!changes.length) return;
    await this._host.applyReplacements(changes);
    this._run();
  }
}

/**
 * @param {string} text
 * @param {RegExp} regex - Global.
 * @returns {Array<{line: number, column: number, length: number, offset: number, preview: string, previewStart: number, previewLength: number}>}
 */
function findMatches(text, regex) {
  const results = [];
  const pattern = new RegExp(regex.source, regex.flags);
  let match;
  let lineStart = 0;
  let line = 1;
  let scanned = 0;
  while ((match = pattern.exec(text)) && results.length < 1000) {
    if (match[0].length === 0) {
      pattern.lastIndex += 1;
      continue;
    }
    // Advance the line counter up to the match.
    for (let i = scanned; i < match.index; i += 1) {
      if (text.charCodeAt(i) === 10) {
        line += 1;
        lineStart = i + 1;
      }
    }
    scanned = match.index;
    const lineEnd = text.indexOf("\n", match.index);
    const lineText = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd);
    const column = match.index - lineStart;
    const length = Math.min(match[0].length, lineText.length - column);
    // Trim long lines around the match.
    const start = Math.max(0, column - 40);
    const indent = /^\s*/.exec(lineText.slice(start))[0].length;
    const previewFrom = column - start > indent ? start + indent : start;
    const preview = lineText.slice(previewFrom, previewFrom + 200);
    results.push({
      line,
      column: column + 1,
      length: match[0].length,
      offset: match.index,
      preview,
      previewStart: column - previewFrom,
      previewLength: Math.max(0, length),
    });
  }
  return results;
}
