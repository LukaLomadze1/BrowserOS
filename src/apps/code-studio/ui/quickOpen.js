/**
 * @file Quick Open (Ctrl + P): type part of a file name or path to jump
 * to a project file. With no query it lists recently opened files.
 * Typing ":<line>" after a name (or alone) also goes to a line.
 */

import { createElement } from "../../../utils/dom.js";
import { relativeTo } from "../project/paths.js";

const MAX_ITEMS = 60;

export class QuickOpen {
  /**
   * @param {object} host
   * @param {() => object[]} host.getFiles
   * @param {() => string} host.getRoot
   * @param {() => string[]} host.getRecent - Recently used file paths, most recent first.
   * @param {(path: string, line: number|null) => void} host.onPick
   * @param {(line: number) => void} host.onGoToLine - Line in the current file.
   */
  constructor(host) {
    this._host = host;
    this._items = [];
    this._index = 0;
    this._previousFocus = null;
    this._input = createElement("input", {
      className: "cs-quick__input",
      attrs: {
        type: "text",
        placeholder: "Go to file (type a name; add :line to jump to a line)",
        "aria-label": "Go to file",
        role: "combobox",
        "aria-expanded": "true",
        "aria-controls": "",
        autocomplete: "off",
        spellcheck: "false",
      },
      on: { input: () => this._update(), keydown: (e) => this._onKeyDown(e) },
    });
    this._list = createElement("ul", { className: "cs-quick__list", attrs: { role: "listbox", "aria-label": "Files" } });
    this._list.id = `cs-quick-${Math.random().toString(36).slice(2)}`;
    this._input.setAttribute("aria-controls", this._list.id);
    this._panel = createElement("div", { className: "cs-quick", attrs: { role: "dialog", "aria-label": "Go to file" }, children: [this._input, this._list] });
    this._root = createElement("div", { className: "cs-quick__backdrop", children: [this._panel] });
    this._root.hidden = true;
    this._root.addEventListener("pointerdown", (e) => {
      if (e.target === this._root) this.close();
    });
  }

  /** @returns {HTMLElement} */
  getElement() {
    return this._root;
  }

  /**
   * @param {string} [initial]
   * @returns {void}
   */
  open(initial = "") {
    this._previousFocus = document.activeElement;
    this._root.hidden = false;
    this._input.value = initial;
    this._update();
    this._input.focus();
    this._input.setSelectionRange(initial.length, initial.length);
  }

  /** @returns {boolean} */
  isOpen() {
    return !this._root.hidden;
  }

  /** @returns {void} */
  close() {
    if (this._root.hidden) return;
    this._root.hidden = true;
    if (this._previousFocus && this._previousFocus.isConnected) this._previousFocus.focus({ preventScroll: true });
  }

  /** @returns {void} */
  _update() {
    const raw = this._input.value;
    const lineMatch = /:(\d+)\s*$/.exec(raw);
    const query = (lineMatch ? raw.slice(0, lineMatch.index) : raw).trim().toLowerCase();
    const line = lineMatch ? Number(lineMatch[1]) : null;
    const root = this._host.getRoot();
    const files = this._host.getFiles();
    let items;
    if (!query && line !== null) {
      items = [{ kind: "line", line, label: `Go to line ${line}`, detail: "in the current file" }];
    } else if (!query) {
      const recent = this._host.getRecent();
      const byPath = new Map(files.map((entry) => [entry.path, entry]));
      const recentEntries = recent.map((path) => byPath.get(path)).filter(Boolean);
      const rest = files.filter((entry) => !recent.includes(entry.path));
      items = [...recentEntries, ...rest].slice(0, MAX_ITEMS).map((entry) => ({ kind: "file", path: entry.path, label: entry.name, detail: relativeTo(entry.path, root), line }));
    } else {
      items = files
        .map((entry) => ({ entry, score: scoreMatch(query, entry.name.toLowerCase(), relativeTo(entry.path, root).toLowerCase()) }))
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score || a.entry.path.length - b.entry.path.length)
        .slice(0, MAX_ITEMS)
        .map(({ entry }) => ({ kind: "file", path: entry.path, label: entry.name, detail: relativeTo(entry.path, root), line }));
    }
    this._items = items;
    this._index = 0;
    this._render();
  }

  /** @returns {void} */
  _render() {
    if (this._items.length === 0) {
      this._list.replaceChildren(createElement("li", { className: "cs-quick__empty", text: "No matching files" }));
      this._input.removeAttribute("aria-activedescendant");
      return;
    }
    this._list.replaceChildren(
      ...this._items.map((item, index) => {
        const li = createElement("li", {
          className: `cs-quick__item${index === this._index ? " cs-quick__item--active" : ""}`,
          attrs: { role: "option", "aria-selected": String(index === this._index), id: `${this._list.id}-${index}` },
          children: [createElement("span", { className: "cs-quick__label", text: item.label }), createElement("span", { className: "cs-quick__detail", text: item.detail })],
        });
        li.addEventListener("pointerdown", (e) => e.preventDefault());
        li.addEventListener("click", () => this._pick(index));
        return li;
      })
    );
    this._input.setAttribute("aria-activedescendant", `${this._list.id}-${this._index}`);
    this._list.children[this._index]?.scrollIntoView({ block: "nearest" });
  }

  /**
   * @param {KeyboardEvent} e
   * @returns {void}
   */
  _onKeyDown(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      this.close();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!this._items.length) return;
      const delta = e.key === "ArrowDown" ? 1 : -1;
      this._index = (this._index + delta + this._items.length) % this._items.length;
      this._render();
    } else if (e.key === "Enter") {
      e.preventDefault();
      this._pick(this._index);
    }
  }

  /**
   * @param {number} index
   * @returns {void}
   */
  _pick(index) {
    const item = this._items[index];
    if (!item) return;
    this._previousFocus = null;
    this._root.hidden = true;
    if (item.kind === "line") this._host.onGoToLine(item.line);
    else this._host.onPick(item.path, item.line);
  }
}

/**
 * Subsequence match with bonuses for name matches, word starts, and runs.
 * @param {string} query
 * @param {string} name
 * @param {string} path
 * @returns {number} 0 when the query doesn't match.
 */
export function scoreMatch(query, name, path) {
  if (name.includes(query)) return 1000 - name.indexOf(query) * 2 - name.length * 0.1 + (name.startsWith(query) ? 200 : 0);
  if (path.includes(query)) return 600 - path.indexOf(query) - path.length * 0.1;
  let score = 0;
  let position = 0;
  let run = 0;
  for (const ch of query) {
    const found = path.indexOf(ch, position);
    if (found === -1) return 0;
    run = found === position ? run + 1 : 0;
    score += 10 + run * 5 + (found === 0 || "/._-".includes(path[found - 1]) ? 8 : 0);
    position = found + 1;
  }
  return Math.max(1, score - path.length * 0.1);
}
