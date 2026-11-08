/**
 * @file Find and replace bar for the active Code Studio editor.
 *
 * Options: match case, whole word, regular expression. Matches are
 * highlighted in the editor with the current one emphasized; Enter /
 * F3 go to the next match, Shift + Enter / Shift + F3 to the previous
 * one. Replace changes the current match, Replace all changes every
 * match as a single undoable edit. With a regular expression, $1, $&
 * and the other JavaScript replacement patterns work in the
 * replacement text.
 */

import { createElement } from "../../../utils/dom.js";
import { createIconElement } from "../../../utils/icons.js";
import { keyboardShortcuts } from "../../../core/keyboard/keyboardShortcuts.js";
import { buildSearchPattern } from "../editor/codeEditor.js";

const UPDATE_DELAY_MS = 120;

export class FindWidget {
  /**
   * @param {{onClose: () => void}} callbacks
   */
  constructor({ onClose }) {
    this._onClose = onClose;
    /** @type {import("../editor/codeEditor.js").CodeEditor|null} */
    this._editor = null;
    this._matches = [];
    this._current = -1;
    this._options = { caseSensitive: false, wholeWord: false, regex: false };
    this._timer = 0;
    this._build();
  }

  /** @returns {HTMLElement} */
  getElement() {
    return this._root;
  }

  /** @returns {boolean} */
  isOpen() {
    return !this._root.hidden;
  }

  /**
   * Open for an editor, seeding the query from its selection.
   * @param {import("../editor/codeEditor.js").CodeEditor} editor
   * @param {{replace?: boolean}} [options]
   * @returns {void}
   */
  open(editor, { replace = false } = {}) {
    this.attach(editor);
    const selected = editor.getSelectedText();
    if (selected && !selected.includes("\n")) this._query.value = selected;
    this._root.hidden = false;
    this._setReplaceVisible(replace || !this._replaceRow.hidden);
    if (replace && this._query.value) this._replace.focus();
    else {
      this._query.focus();
      this._query.select();
    }
    this._update({ keepCurrent: false });
  }

  /**
   * Point the bar at another editor (after switching tabs).
   * @param {import("../editor/codeEditor.js").CodeEditor|null} editor
   * @returns {void}
   */
  attach(editor) {
    if (this._editor && this._editor !== editor) this._editor.setSearchMatches([]);
    this._editor = editor;
    if (this.isOpen()) this._update({ keepCurrent: false });
  }

  /** Refresh matches after the text changed. */
  refresh() {
    if (!this.isOpen()) return;
    window.clearTimeout(this._timer);
    this._timer = window.setTimeout(() => this._update({ keepCurrent: true }), UPDATE_DELAY_MS);
  }

  /** @returns {void} */
  close() {
    if (!this.isOpen()) return;
    this._root.hidden = true;
    this._editor?.setSearchMatches([]);
    this._onClose();
  }

  /** @returns {void} */
  destroy() {
    window.clearTimeout(this._timer);
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
            this._update({ keepCurrent: false });
          },
        },
      });
      return button;
    };
    this._query = createElement("input", {
      className: "cs-find__input",
      attrs: { type: "text", placeholder: "Find", "aria-label": "Find", spellcheck: "false", autocomplete: "off" },
      on: { input: () => this._update({ keepCurrent: false }), keydown: (e) => this._onKeyDown(e, "find") },
    });
    this._replace = createElement("input", {
      className: "cs-find__input",
      attrs: { type: "text", placeholder: "Replace", "aria-label": "Replace with", spellcheck: "false", autocomplete: "off" },
      on: { keydown: (e) => this._onKeyDown(e, "replace") },
    });
    this._count = createElement("span", { className: "cs-find__count", attrs: { role: "status", "aria-live": "polite" } });
    const iconButton = (label, icon, onClick) =>
      createElement("button", {
        className: "cs-icon-button",
        attrs: { type: "button", title: label, "aria-label": label },
        children: [createIconElement(icon)],
        on: { click: onClick },
      });
    this._expand = createElement("button", {
      className: "cs-icon-button cs-find__expand",
      attrs: { type: "button", title: "Toggle replace", "aria-label": "Toggle replace", "aria-expanded": "false" },
      children: [createIconElement("icon:chevronRight")],
      on: { click: () => this._setReplaceVisible(this._replaceRow.hidden) },
    });
    const findRow = createElement("div", {
      className: "cs-find__row",
      children: [
        this._query,
        toggle("Match case", "Aa", "caseSensitive"),
        toggle("Whole word", "ab", "wholeWord"),
        toggle("Regular expression", ".*", "regex"),
        this._count,
        iconButton("Previous match (Shift + Enter)", "icon:chevronUp", () => this._step(-1)),
        iconButton("Next match (Enter)", "icon:chevronDown", () => this._step(1)),
        iconButton("Close (Escape)", "icon:close", () => this._closeAndFocus()),
      ],
    });
    this._replaceRow = createElement("div", {
      className: "cs-find__row",
      children: [
        this._replace,
        createElement("button", { className: "cs-text-button", text: "Replace", attrs: { type: "button" }, on: { click: () => this._replaceCurrent() } }),
        createElement("button", { className: "cs-text-button", text: "Replace all", attrs: { type: "button" }, on: { click: () => this._replaceAll() } }),
      ],
    });
    this._replaceRow.hidden = true;
    this._root = createElement("div", {
      className: "cs-find",
      attrs: { role: "search", "aria-label": "Find and replace" },
      children: [this._expand, createElement("div", { className: "cs-find__rows", children: [findRow, this._replaceRow] })],
    });
    this._root.hidden = true;
  }

  /**
   * @param {boolean} visible
   * @returns {void}
   */
  _setReplaceVisible(visible) {
    this._replaceRow.hidden = !visible;
    this._expand.setAttribute("aria-expanded", String(visible));
    this._expand.replaceChildren(createIconElement(visible ? "icon:chevronDown" : "icon:chevronRight"));
  }

  /**
   * @param {KeyboardEvent} e
   * @param {"find"|"replace"} field
   * @returns {void}
   */
  _onKeyDown(e, field) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      this._closeAndFocus();
      return;
    }
    if (field === "replace" && e.key === "Enter" && !e.shiftKey && (e.ctrlKey || e.metaKey) && e.altKey) {
      e.preventDefault();
      this._replaceAll();
      return;
    }
    if (field === "replace" && e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      this._replaceCurrent();
      return;
    }
    if (keyboardShortcuts.matches(e, "codeStudio.findPrevious")) {
      e.preventDefault();
      this._step(-1);
    } else if (keyboardShortcuts.matches(e, "codeStudio.findNext")) {
      e.preventDefault();
      this._step(1);
    }
  }

  /** @returns {void} */
  _closeAndFocus() {
    const editor = this._editor;
    this.close();
    editor?.focus();
  }

  /**
   * @param {{keepCurrent: boolean}} options
   * @returns {void}
   */
  _update({ keepCurrent }) {
    const editor = this._editor;
    if (!editor) {
      this._count.textContent = "";
      return;
    }
    const { matches, error } = editor.findAll(this._query.value, this._options);
    this._matches = matches;
    this._query.classList.toggle("cs-find__input--error", Boolean(error));
    this._query.title = error ?? "";
    if (!keepCurrent || this._current >= matches.length) {
      const caret = editor.getSelection().start;
      const index = matches.findIndex(([from]) => from >= caret);
      this._current = matches.length ? (index === -1 ? 0 : index) : -1;
    }
    editor.setSearchMatches(matches, this._current);
    this._renderCount(error);
  }

  /**
   * @param {string|null} [error]
   * @returns {void}
   */
  _renderCount(error = null) {
    if (error) this._count.textContent = "Invalid pattern";
    else if (!this._query.value) this._count.textContent = "";
    else if (!this._matches.length) this._count.textContent = "No results";
    else this._count.textContent = `${this._current + 1} of ${this._matches.length.toLocaleString()}`;
    this._count.classList.toggle("cs-find__count--none", Boolean(this._query.value) && !this._matches.length);
  }

  /**
   * @param {1|-1} direction
   * @returns {void}
   */
  _step(direction) {
    if (!this._editor) return;
    this._update({ keepCurrent: true });
    if (!this._matches.length) return;
    const selection = this._editor.getSelection();
    const onCurrent = this._current >= 0 && this._matches[this._current][0] === selection.start && this._matches[this._current][1] === selection.end;
    if (onCurrent || this._current < 0) {
      this._current = (this._current + direction + this._matches.length) % this._matches.length;
    }
    const [from, to] = this._matches[this._current];
    this._editor.setSearchMatches(this._matches, this._current);
    this._editor.setSelection(from, to, { center: true });
    this._renderCount();
  }

  /** @returns {void} */
  _replaceCurrent() {
    const editor = this._editor;
    if (!editor) return;
    this._update({ keepCurrent: true });
    if (!this._matches.length) return;
    const selection = editor.getSelection();
    const match = this._matches[this._current];
    if (!match || match[0] !== selection.start || match[1] !== selection.end) {
      // Select the match first; the next Replace replaces it.
      this._step(1);
      return;
    }
    const text = this._replacementAt(editor.getValue(), match[0]);
    editor.replaceRange(match[0], match[1], text, { select: [match[0] + text.length, match[0] + text.length], kind: "replace" });
    this._update({ keepCurrent: false });
    if (this._matches.length) {
      const [from, to] = this._matches[this._current];
      editor.setSearchMatches(this._matches, this._current);
      editor.setSelection(from, to, { center: true });
      this._renderCount();
    }
  }

  /** @returns {void} */
  _replaceAll() {
    const editor = this._editor;
    if (!editor || !this._query.value) return;
    const pattern = buildSearchPattern(this._query.value, this._options);
    if (!pattern.regex) return;
    const before = editor.getValue();
    const replacement = this._replace.value;
    let count = 0;
    const after = before.replace(pattern.regex, (...args) => {
      const matched = args[0];
      if (!matched) return matched;
      count += 1;
      if (!this._options.regex) return replacement;
      const groups = typeof args[args.length - 1] === "object" ? args[args.length - 1] : undefined;
      const captures = args.slice(1, groups ? -3 : -2);
      return expandReplacement(replacement, matched, captures, groups);
    });
    if (!count) return;
    const caret = editor.getSelection().start;
    editor.replaceDocument(after, [Math.min(caret, after.length), Math.min(caret, after.length)], "replace");
    this._update({ keepCurrent: false });
    this._count.textContent = `Replaced ${count.toLocaleString()}`;
  }

  /**
   * @param {string} text - The whole document.
   * @param {number} from - Where the match starts.
   * @returns {string} The replacement text, with $-patterns expanded for regex searches.
   */
  _replacementAt(text, from) {
    if (!this._options.regex) return this._replace.value;
    const pattern = buildSearchPattern(this._query.value, this._options);
    if (!pattern.regex) return this._replace.value;
    // Re-run the expression at the match position so anchors and look-arounds see the real context.
    const sticky = new RegExp(pattern.regex.source, pattern.regex.flags.replace("g", "") + "y");
    sticky.lastIndex = from;
    const match = sticky.exec(text);
    if (!match) return this._replace.value;
    return expandReplacement(this._replace.value, match[0], match.slice(1), match.groups);
  }
}

/**
 * Expand $$, $&, $1-$99, and $<name> in a replacement string, the way String.prototype.replace does.
 * @param {string} template
 * @param {string} matched
 * @param {Array<string|undefined>} captures
 * @param {Record<string, string>|undefined} groups
 * @returns {string}
 */
export function expandReplacement(template, matched, captures, groups) {
  return template.replace(/\$(\$|&|<([^>]*)>|(\d{1,2}))/g, (token, kind, name, digits) => {
    if (kind === "$") return "$";
    if (kind === "&") return matched;
    if (name !== undefined) return groups && name in groups ? groups[name] ?? "" : token;
    if (digits !== undefined) {
      let index = Number(digits);
      if (index >= 1 && index <= captures.length) return captures[index - 1] ?? "";
      if (digits.length === 2) {
        index = Number(digits[0]);
        if (index >= 1 && index <= captures.length) return (captures[index - 1] ?? "") + digits[1];
      }
    }
    return token;
  });
}
