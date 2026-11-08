/**
 * @file Code Studio's bottom panel: Problems, Output, and Terminal tabs.
 *
 *   Problems  syntax and structure diagnostics of project files
 *             ("Syntax") and errors thrown by the running preview
 *             ("Runtime"), each with file and line; selecting one opens
 *             the file at that position.
 *   Output    console messages and errors from the preview page.
 *   Terminal  a BrowserOS terminal whose working directory starts at the
 *             project folder (created the first time the tab is shown).
 */

import { createElement } from "../../../utils/dom.js";
import { createIconElement } from "../../../utils/icons.js";
import { relativeTo } from "../project/paths.js";

const MAX_OUTPUT = 1000;

export class BottomPanel {
  /**
   * @param {object} host
   * @param {(path: string, line: number, column: number) => void} host.openAt
   * @param {() => string} host.getRoot
   * @param {() => HTMLElement} host.createTerminal - Called once, the first time the Terminal tab is shown.
   * @param {() => void} host.onTerminalShown
   * @param {() => void} host.openTerminalApp
   * @param {() => void} host.onClose
   */
  constructor(host) {
    this._host = host;
    this._tab = "problems";
    /** @type {Array<object>} */
    this._problems = [];
    /** @type {Array<object>} */
    this._runtime = [];
    this._outputCount = 0;
    this._terminalEl = null;
    this._build();
  }

  /** @returns {HTMLElement} */
  getElement() {
    return this._root;
  }

  /** @returns {string} */
  getTab() {
    return this._tab;
  }

  /**
   * @param {"problems"|"output"|"terminal"} tab
   * @returns {void}
   */
  showTab(tab) {
    this._tab = tab;
    this._tabs[tab].classList.remove("cs-panel__tab--attention");
    for (const [id, button] of Object.entries(this._tabs)) {
      const selected = id === tab;
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
      this._views[id].hidden = !selected;
    }
    if (tab === "terminal") {
      if (!this._terminalEl) {
        this._terminalEl = this._host.createTerminal();
        this._views.terminal.append(this._terminalEl);
      }
      this._host.onTerminalShown();
    }
    this._openTerminalButton.hidden = tab !== "terminal";
    this._clearButton.hidden = tab !== "output";
  }

  /**
   * @param {Array<{path: string, line: number, column: number, severity: string, message: string, source: string}>} problems - Syntax diagnostics for every checked file.
   * @returns {void}
   */
  setProblems(problems) {
    this._problems = problems;
    this._renderProblems();
  }

  /**
   * @param {{message: string, path: string|null, line: number, column: number}} error
   * @returns {void}
   */
  addRuntimeError(error) {
    const key = `${error.path}:${error.line}:${error.column}:${error.message}`;
    if (this._runtime.some((existing) => existing.key === key)) return;
    this._runtime.push({ ...error, key, severity: "error", source: "Runtime" });
    if (this._runtime.length > 100) this._runtime.shift();
    this._renderProblems();
  }

  /** Forget runtime errors (the page reloaded). */
  clearRuntimeErrors() {
    this._runtime = [];
    this._renderProblems();
  }

  /** @returns {{errors: number, warnings: number}} */
  getCounts() {
    const all = [...this._problems, ...this._runtime];
    return {
      errors: all.filter((p) => p.severity === "error").length,
      warnings: all.filter((p) => p.severity === "warning").length,
    };
  }

  /**
   * @param {{level: string, text: string, path: string|null, line: number, column: number, runtime?: boolean}} entry
   * @returns {void}
   */
  appendOutput(entry) {
    const location =
      entry.path && entry.line
        ? createElement("button", {
            className: "cs-output__location",
            text: `${relativeTo(entry.path, this._host.getRoot())}:${entry.line}`,
            attrs: { type: "button", title: `Open ${entry.path} at line ${entry.line}` },
            on: { click: () => this._host.openAt(entry.path, entry.line, entry.column || 1) },
          })
        : entry.path
          ? createElement("span", { className: "cs-output__location", text: relativeTo(entry.path, this._host.getRoot()) })
          : null;
    const row = createElement("div", {
      className: `cs-output__row cs-output__row--${entry.level}`,
      children: [
        createElement("span", { className: "cs-output__level", text: levelLabel(entry.level) }),
        createElement("span", { className: "cs-output__text", text: entry.text }),
      ],
    });
    if (location) row.append(location);
    const atBottom = this._output.scrollTop + this._output.clientHeight >= this._output.scrollHeight - 8;
    this._output.append(row);
    this._outputCount += 1;
    while (this._output.childElementCount > MAX_OUTPUT) this._output.firstElementChild.remove();
    this._outputEmpty.hidden = true;
    if (atBottom) this._output.scrollTop = this._output.scrollHeight;
    if (entry.level === "error" || entry.level === "warn") this._bump("output");
  }

  /**
   * @param {string} text
   * @returns {void}
   */
  appendSeparator(text) {
    if (!this._output.childElementCount) return;
    this._output.append(createElement("div", { className: "cs-output__separator", text }));
  }

  /** @returns {void} */
  clearOutput() {
    this._output.replaceChildren();
    this._outputCount = 0;
    this._outputEmpty.hidden = false;
    this._tabs.output.classList.remove("cs-panel__tab--attention");
  }

  // ---------------------------------------------------------------

  /** @returns {void} */
  _build() {
    const tab = (id, label) => {
      const button = createElement("button", {
        className: "cs-panel__tab",
        attrs: { type: "button", role: "tab", "aria-selected": "false", "data-tab": id, tabindex: "-1" },
        children: [createElement("span", { text: label }), createElement("span", { className: "cs-badge cs-panel__count", attrs: { hidden: "" } })],
        on: {
          click: () => this.showTab(id),
          keydown: (e) => {
            const ids = Object.keys(this._tabs);
            const index = ids.indexOf(id);
            if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
              e.preventDefault();
              const next = ids[(index + (e.key === "ArrowRight" ? 1 : -1) + ids.length) % ids.length];
              this.showTab(next);
              this._tabs[next].focus();
            }
          },
        },
      });
      return button;
    };
    this._tabs = { problems: tab("problems", "Problems"), output: tab("output", "Output"), terminal: tab("terminal", "Terminal") };
    this._problemsList = createElement("div", { className: "cs-problems", attrs: { role: "list", "aria-label": "Problems" } });
    this._output = createElement("div", { className: "cs-output", attrs: { role: "log", "aria-label": "Preview output" } });
    this._outputEmpty = createElement("p", { className: "cs-panel__empty", text: "Console messages from the preview appear here." });
    this._views = {
      problems: createElement("div", { className: "cs-panel__view", attrs: { role: "tabpanel", "aria-label": "Problems" }, children: [this._problemsList] }),
      output: createElement("div", { className: "cs-panel__view", attrs: { role: "tabpanel", "aria-label": "Output" }, children: [this._outputEmpty, this._output] }),
      terminal: createElement("div", { className: "cs-panel__view cs-panel__view--terminal", attrs: { role: "tabpanel", "aria-label": "Terminal" } }),
    };
    this._clearButton = createElement("button", {
      className: "cs-icon-button",
      attrs: { type: "button", title: "Clear output", "aria-label": "Clear output" },
      children: [createIconElement("icon:trash")],
      on: { click: () => this.clearOutput() },
    });
    this._openTerminalButton = createElement("button", {
      className: "cs-icon-button",
      attrs: { type: "button", title: "Open in the Terminal app", "aria-label": "Open in the Terminal app" },
      children: [createIconElement("icon:external")],
      on: { click: () => this._host.openTerminalApp() },
    });
    const close = createElement("button", {
      className: "cs-icon-button",
      attrs: { type: "button", title: "Hide panel (Ctrl + J)", "aria-label": "Hide panel" },
      children: [createIconElement("icon:close")],
      on: { click: () => this._host.onClose() },
    });
    this._root = createElement("section", {
      className: "cs-panel",
      attrs: { "aria-label": "Panel" },
      children: [
        createElement("div", {
          className: "cs-panel__header",
          children: [
            createElement("div", { className: "cs-panel__tabs", attrs: { role: "tablist", "aria-label": "Panel" }, children: Object.values(this._tabs) }),
            createElement("div", { className: "cs-panel__actions", children: [this._clearButton, this._openTerminalButton, close] }),
          ],
        }),
        ...Object.values(this._views),
      ],
    });
    this.showTab("problems");
    this._renderProblems();
  }

  /**
   * @param {"output"} id
   * @returns {void}
   */
  _bump(id) {
    if (this._tab !== id) this._tabs[id].classList.add("cs-panel__tab--attention");
  }

  /** @returns {void} */
  _renderProblems() {
    const root = this._host.getRoot();
    const all = [...this._runtime, ...this._problems];
    const counts = this.getCounts();
    const badge = this._tabs.problems.querySelector(".cs-panel__count");
    badge.textContent = String(counts.errors + counts.warnings);
    badge.hidden = counts.errors + counts.warnings === 0;
    if (!all.length) {
      this._problemsList.replaceChildren(createElement("p", { className: "cs-panel__empty", text: "No problems found in the checked files." }));
      return;
    }
    const byFile = new Map();
    for (const problem of all) {
      const key = problem.path ?? "";
      if (!byFile.has(key)) byFile.set(key, []);
      byFile.get(key).push(problem);
    }
    const groups = [];
    for (const [path, problems] of byFile) {
      groups.push(
        createElement("div", {
          className: "cs-problems__file",
          text: path ? relativeTo(path, root) : "Preview",
          attrs: { title: path || "" },
        })
      );
      for (const problem of problems) {
        const kind = problem.source === "Runtime" ? "Runtime error" : `${problem.source}`;
        const item = createElement("div", {
          className: `cs-problems__item cs-problems__item--${problem.severity}`,
          attrs: { role: "listitem", tabindex: "0" },
          children: [
            createIconElement(problem.severity === "error" ? "icon:error" : problem.severity === "warning" ? "icon:warning" : "icon:info", { className: "cs-problems__icon" }),
            createElement("span", { className: "cs-problems__message", text: problem.message }),
            createElement("span", { className: "cs-problems__kind", text: kind }),
            createElement("span", { className: "cs-problems__where", text: problem.line ? `${problem.line}:${problem.column || 1}` : "" }),
          ],
        });
        const open = () => {
          if (problem.path && problem.line) this._host.openAt(problem.path, problem.line, problem.column || 1);
          else if (problem.path) this._host.openAt(problem.path, 1, 1);
        };
        item.addEventListener("click", open);
        item.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            open();
          }
        });
        groups.push(item);
      }
    }
    this._problemsList.replaceChildren(...groups);
  }
}

/**
 * @param {string} level
 * @returns {string}
 */
function levelLabel(level) {
  return { log: "log", info: "info", warn: "warn", error: "error", debug: "debug" }[level] ?? level;
}
