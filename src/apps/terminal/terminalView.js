/**
 * @file TerminalView — the visual shell of one Terminal window: a
 * scrollable output log plus a single always-present input line. As
 * with every other *View in this codebase, it renders what it's told
 * and forwards raw DOM facts upward (just one: the input's keydown)
 * — TerminalManager is the only place that decides what Enter, Tab,
 * and the arrow keys mean.
 *
 * The output keeps the most recent SCROLLBACK_LIMIT blocks (a command's
 * output is one block), so a long session can't grow the page forever.
 */

import { createElement, clearElement } from "../../utils/dom.js";

/** Output blocks kept on screen; older ones are dropped, like a terminal's scrollback limit. */
export const SCROLLBACK_LIMIT = 2000;

class TerminalView {
  /**
   * @param {object} callbacks
   * @param {(e: KeyboardEvent) => void} callbacks.onInputKeyDown
   */
  constructor(callbacks) {
    this._callbacks = callbacks;
    this._buildDom();
  }

  /** @returns {HTMLElement} */
  getElement() {
    return this._el;
  }

  /** @returns {HTMLInputElement} */
  getInputElement() {
    return this._inputEl;
  }

  /** @returns {string} */
  getInputValue() {
    return this._inputEl.value;
  }

  /**
   * @param {string} value
   * @returns {void}
   */
  setInputValue(value) {
    this._inputEl.value = value;
    // Keep the caret at the end after programmatic changes (history
    // recall, tab completion) — matches how a real shell behaves.
    requestAnimationFrame(() => {
      this._inputEl.setSelectionRange(value.length, value.length);
    });
  }

  /**
   * @param {string} text
   * @returns {void}
   */
  setPrompt(text) {
    this._promptLabelEl.textContent = text;
  }

  /** @returns {void} */
  focusInput() {
    this._inputEl.focus();
  }

  /**
   * @param {{text: string, type: "input"|"success"|"error"}} line
   * @returns {void}
   */
  appendLine(line) {
    const lineEl = createElement("div", {
      className: `terminal__line terminal__line--${line.type}`,
      text: line.text,
    });
    this._outputEl.append(lineEl);
    while (this._outputEl.childElementCount > SCROLLBACK_LIMIT) this._outputEl.firstElementChild.remove();
    this._scrollToBottom();
  }

  /** @returns {void} */
  clearOutput() {
    clearElement(this._outputEl);
  }

  /** @returns {void} */
  _scrollToBottom() {
    this._viewportEl.scrollTop = this._viewportEl.scrollHeight;
  }

  /** @returns {void} */
  _buildDom() {
    this._outputEl = createElement("div", {
      className: "terminal__output",
      attrs: { role: "log", "aria-label": "Terminal output" },
    });

    this._promptLabelEl = createElement("span", { className: "terminal__prompt-label" });

    this._inputEl = createElement("input", {
      className: "terminal__input",
      attrs: {
        type: "text",
        spellcheck: "false",
        autocomplete: "off",
        autocapitalize: "off",
        "aria-label": "Terminal command input",
      },
      on: { keydown: (e) => this._callbacks.onInputKeyDown(e) },
    });

    const promptLineEl = createElement("div", {
      className: "terminal__prompt-line",
      children: [this._promptLabelEl, this._inputEl],
    });

    this._viewportEl = createElement("div", {
      className: "terminal__viewport",
      children: [this._outputEl, promptLineEl],
      on: {
        click: () => {
          // Clicking anywhere in the viewport focuses the input, like
          // a real terminal — but not if the click was actually the
          // end of a text selection (copying prior output), which
          // focusing the input would otherwise immediately collapse.
          const selection = window.getSelection();
          if (selection && selection.toString().length > 0) return;
          this._inputEl.focus();
        },
      },
    });

    this._el = createElement("div", {
      className: "terminal-app",
      attrs: { tabindex: "-1" },
      children: [this._viewportEl],
    });
  }
}

export { TerminalView };
