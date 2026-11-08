/**
 * @file CodeEditor — the text editor used by Code Studio.
 *
 * Structure: one scroll container holds a "surface" with two layers
 * that share the same font, size, line height, tab size, padding, and
 * wrapping rules:
 *
 *   - the highlight layer: one row per line, a sticky line-number
 *     gutter (CSS counters, so inserting lines never renumbers DOM
 *     nodes), and syntax-colored token spans with decorations (current
 *     line, matching brackets, find matches, diagnostics);
 *   - a native <textarea> stretched over the text column with
 *     transparent glyphs and a visible caret and selection, so every
 *     platform text-input feature (IME, dead keys, clipboard, drag and
 *     drop, accessibility, spell-free selection) works natively.
 *
 * The textarea never scrolls by itself; the outer container scrolls
 * both layers together and the editor reveals the caret itself.
 *
 * Highlighting is incremental: each line keeps the tokenizer state it
 * starts in, and an edit re-tokenizes from the first changed line only
 * until a line ends in the same state as before.
 *
 * Large documents (more than LARGE_DOCUMENT_LINES lines) render only
 * the rows in and near the viewport: every line is exactly one line
 * height tall, so a row's position is its index times the line height,
 * and the line-number counter starts at the first rendered row. An
 * invisible copy of the widest line keeps the horizontal scroll range
 * right. Word wrap would make row heights unknowable without rendering
 * every row, so it is suspended for large documents (`isWrapSuspended()`)
 * and resumes when the document gets small again. The textarea always
 * holds the whole text, so selection, clipboard, and IME are unaffected.
 *
 * Undo/redo is the editor's own history (the browser's textarea undo
 * is never used), so programmatic edits — indentation, auto-closing
 * brackets, toggling comments, replace-all — undo exactly like typing.
 * Consecutive typing and deleting are grouped.
 */

import { createElement } from "../../../utils/dom.js";
import { keyboardShortcuts } from "../../../core/keyboard/keyboardShortcuts.js";
import { fontStackFor } from "../editorFonts.js";
import { PLAIN_TEXT } from "../languages/registry.js";

const HISTORY_LIMIT = 500;
const GROUP_DELAY_MS = 900;
const MAX_TOKENIZED_LINE = 10000;
const BRACKETS = Object.freeze({ "(": ")", "[": "]", "{": "}" });
const CLOSERS = Object.freeze({ ")": "(", "]": "[", "}": "{" });
const AUTO_PAIRS = Object.freeze({ "(": ")", "[": "]", "{": "}", '"': '"', "'": "'", "`": "`" });
/** Above this many lines, only visible rows are rendered and word wrap is suspended. */
export const LARGE_DOCUMENT_LINES = 2000;
/** Rows rendered above and below the viewport in a large document. */
const WINDOW_BUFFER = 40;

/**
 * @typedef {object} EditorSettings
 * @property {number} fontSize
 * @property {string} fontFamily - Id from editorFonts.js.
 * @property {number} tabWidth
 * @property {boolean} insertSpaces
 * @property {boolean} lineNumbers
 * @property {boolean} wordWrap
 * @property {boolean} autoCloseBrackets
 */

/**
 * @typedef {object} Mark
 * @property {number} line - Zero-based line.
 * @property {number} from - Column (UTF-16 offset in the line).
 * @property {number} to
 * @property {string} className
 */

export class CodeEditor {
  /**
   * @param {object} config
   * @param {object} [config.language] - From the language registry.
   * @param {string} [config.text]
   * @param {EditorSettings} config.settings
   * @param {string} [config.label] - Accessible name of the text area.
   * @param {(editor: CodeEditor) => void} [config.onChange] - After every text change (typing, undo, programmatic edits).
   * @param {(cursor: {line: number, column: number, selected: number}) => void} [config.onCursor]
   */
  constructor({ language = PLAIN_TEXT, text = "", settings, label = "Code editor", onChange, onCursor }) {
    this._language = language;
    this._settings = { ...settings };
    this._onChange = onChange ?? null;
    this._onCursor = onCursor ?? null;
    this._text = "";
    /** @type {string[]} */
    this._lines = [""];
    /** @type {object[]} Tokenizer state at the start of each line (length = lines + 1). */
    this._states = [];
    /** @type {Array<Array<[string|null, string]>>} */
    this._tokens = [];
    /** @type {HTMLElement[]} Rendered rows, for lines _rowStart … _rowStart + length - 1. */
    this._lineEls = [];
    this._rowStart = 0;
    /** Whether only the rows near the viewport are rendered (large documents). */
    this._virtual = false;
    this._wrapSuspended = false;
    /** @type {HTMLElement|null} Invisible copy of the widest line (large documents). */
    this._probeEl = null;
    this._widest = { index: -1, width: 0 };
    this._charWidthPx = 0;
    this._windowFrame = 0;
    /** @type {number[]|null} Offsets where each line starts; rebuilt lazily. */
    this._lineStarts = null;
    /** @type {Map<string, Mark[]>} Named decoration sets. */
    this._markSets = new Map();
    /** @type {Map<number, Mark[]>} */
    this._marksByLine = new Map();
    /** @type {Map<number, string>} line -> severity, for gutter markers */
    this._lineSeverity = new Map();
    this._currentLine = -1;
    this._undo = [];
    this._redo = [];
    this._selBefore = [0, 0];
    this._composing = false;
    this._escapeTab = false;
    this._revealFrame = 0;
    this._bracketFrame = 0;
    this._destroyed = false;

    this._build(label);
    this.applySettings(this._settings);
    this._resetDocument(text);
    this._wire();
  }

  // ---------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------

  /** @returns {HTMLElement} */
  getElement() {
    return this._root;
  }

  /** @returns {string} */
  getValue() {
    return this._text;
  }

  /**
   * Replace the whole document.
   * @param {string} text
   * @param {{keepHistory?: boolean}} [options] - keepHistory records the change as one undoable edit (used when reloading a file changed elsewhere).
   * @returns {void}
   */
  setValue(text, { keepHistory = false } = {}) {
    text = normalizeNewlines(text);
    if (keepHistory) {
      const caret = Math.min(this._input.selectionStart, text.length);
      this.replaceDocument(text, [caret, caret], "reload");
      return;
    }
    this._resetDocument(text);
  }

  /** @returns {object} The active language. */
  getLanguage() {
    return this._language;
  }

  /**
   * @param {object} language
   * @returns {void}
   */
  setLanguage(language) {
    this._language = language ?? PLAIN_TEXT;
    this._retokenizeAll();
  }

  /**
   * @param {Partial<EditorSettings>} settings
   * @returns {void}
   */
  applySettings(settings) {
    const before = { ...this._settings };
    Object.assign(this._settings, settings);
    const s = this._settings;
    this._root.style.setProperty("--cs-font-size", `${s.fontSize}px`);
    this._root.style.setProperty("--cs-font-family", fontStackFor(s.fontFamily));
    this._root.style.setProperty("--cs-tab-size", String(s.tabWidth));
    this._root.classList.toggle("cs-editor--no-numbers", !s.lineNumbers);
    this._charWidthPx = 0;
    const layoutChanged = before.wordWrap !== s.wordWrap || before.fontSize !== s.fontSize || before.fontFamily !== s.fontFamily || before.tabWidth !== s.tabWidth;
    if (this._states.length && (layoutChanged || this._virtual !== this._shouldVirtualize())) {
      this._rebuildRows();
    } else {
      this._applyWrapState();
    }
    this._updateGutterWidth();
    this._scheduleReveal();
  }

  /**
   * @returns {boolean} Whether word wrap is on in the settings but off for
   *   this document because it is too large (see LARGE_DOCUMENT_LINES).
   */
  isWrapSuspended() {
    return this._wrapSuspended;
  }

  /** @returns {EditorSettings} */
  getSettings() {
    return { ...this._settings };
  }

  /**
   * @param {{preventScroll?: boolean}} [options]
   * @returns {void}
   */
  focus({ preventScroll = true } = {}) {
    this._input.focus({ preventScroll });
  }

  /** @returns {boolean} */
  hasFocus() {
    return document.activeElement === this._input;
  }

  /** @returns {{start: number, end: number, direction: string}} */
  getSelection() {
    return { start: this._input.selectionStart, end: this._input.selectionEnd, direction: this._input.selectionDirection };
  }

  /** @returns {string} The selected text. */
  getSelectedText() {
    return this._text.slice(this._input.selectionStart, this._input.selectionEnd);
  }

  /**
   * @param {number} start
   * @param {number} [end]
   * @param {{reveal?: boolean, center?: boolean}} [options]
   * @returns {void}
   */
  setSelection(start, end = start, { reveal = true, center = false } = {}) {
    const length = this._text.length;
    start = clamp(start, 0, length);
    end = clamp(end, 0, length);
    this._input.setSelectionRange(Math.min(start, end), Math.max(start, end), start > end ? "backward" : "forward");
    this._selectionChanged();
    if (reveal) this._revealOffset(end, center);
  }

  /** @returns {{line: number, column: number, selected: number}} 1-based line and column. */
  getCursor() {
    const { start, end } = this.getSelection();
    const head = this._input.selectionDirection === "backward" ? start : end;
    const { line, column } = this.positionAt(head);
    return { line: line + 1, column: column + 1, selected: Math.abs(end - start) };
  }

  /** @returns {number} */
  getLineCount() {
    return this._lines.length;
  }

  /**
   * @param {number} line - Zero-based.
   * @returns {string}
   */
  getLine(line) {
    return this._lines[line] ?? "";
  }

  /**
   * @param {number} offset
   * @returns {{line: number, column: number}} Zero-based.
   */
  positionAt(offset) {
    const starts = this._getLineStarts();
    offset = clamp(offset, 0, this._text.length);
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (starts[mid] <= offset) low = mid;
      else high = mid - 1;
    }
    return { line: low, column: offset - starts[low] };
  }

  /**
   * @param {number} line - Zero-based.
   * @param {number} [column]
   * @returns {number} Offset, clamped to the document.
   */
  offsetAt(line, column = 0) {
    const starts = this._getLineStarts();
    const index = clamp(line, 0, starts.length - 1);
    return starts[index] + clamp(column, 0, this._lines[index].length);
  }

  /**
   * Move the caret to a line (1-based) and column (1-based), centered.
   * @param {number} line
   * @param {number} [column]
   * @param {{select?: number}} [options] - Select this many characters from there.
   * @returns {void}
   */
  goTo(line, column = 1, { select = 0 } = {}) {
    const offset = this.offsetAt(line - 1, column - 1);
    this.setSelection(offset, offset + select, { center: true });
  }

  /**
   * Replace a range as one undoable edit.
   * @param {number} from
   * @param {number} to
   * @param {string} text
   * @param {{select?: [number, number], kind?: string}} [options] - Selection afterwards (defaults to a caret after the text).
   * @returns {void}
   */
  replaceRange(from, to, text, { select, kind = "edit" } = {}) {
    text = normalizeNewlines(text);
    const selBefore = this._currentSelection();
    const removed = this._text.slice(from, to);
    this._input.setRangeText(text, from, to, "end");
    const selAfter = select ?? [from + text.length, from + text.length];
    this._input.setSelectionRange(selAfter[0], selAfter[1]);
    this._commit({ from, removed, inserted: text, selBefore, selAfter, kind });
  }

  /**
   * Replace the whole document as one undoable edit (only the changed span is stored).
   * @param {string} text
   * @param {[number, number]} selAfter
   * @param {string} [kind]
   * @returns {void}
   */
  replaceDocument(text, selAfter, kind = "edit") {
    text = normalizeNewlines(text);
    const { from, removed, inserted } = diffTexts(this._text, text, this._text.length);
    if (!removed && !inserted) return;
    const selBefore = this._currentSelection();
    this._input.value = text;
    this._input.setSelectionRange(selAfter[0], selAfter[1]);
    this._commit({ from, removed, inserted, selBefore, selAfter, kind });
  }

  /** @returns {boolean} */
  canUndo() {
    return this._undo.length > 0;
  }

  /** @returns {boolean} */
  canRedo() {
    return this._redo.length > 0;
  }

  /** @returns {void} */
  undo() {
    const record = this._undo.pop();
    if (!record) return;
    this._applyRecord(record, true);
    this._redo.push(record);
  }

  /** @returns {void} */
  redo() {
    const record = this._redo.pop();
    if (!record) return;
    this._applyRecord(record, false);
    this._undo.push(record);
  }

  /** @returns {void} */
  clearHistory() {
    this._undo = [];
    this._redo = [];
  }

  /**
   * Find every match of a query.
   * @param {string} query
   * @param {{caseSensitive?: boolean, regex?: boolean, wholeWord?: boolean}} [options]
   * @returns {{matches: Array<[number, number]>, error: string|null}}
   */
  findAll(query, options = {}) {
    const pattern = buildSearchPattern(query, options);
    if (pattern.error || !pattern.regex) return { matches: [], error: pattern.error };
    const matches = [];
    const regex = pattern.regex;
    let match;
    while ((match = regex.exec(this._text)) && matches.length < 100000) {
      if (match[0].length === 0) {
        regex.lastIndex += 1;
        continue;
      }
      matches.push([match.index, match.index + match[0].length]);
    }
    return { matches, error: null };
  }

  /**
   * Show find matches, one of them as the current match.
   * @param {Array<[number, number]>} matches
   * @param {number} [current]
   * @returns {void}
   */
  setSearchMatches(matches, current = -1) {
    const marks = [];
    matches.forEach(([from, to], index) => {
      const className = index === current ? "cs-mark-find cs-mark-find--current" : "cs-mark-find";
      marks.push(...this._rangeToMarks(from, to, className));
    });
    this._setMarks("find", marks);
  }

  /**
   * Show diagnostics: an underline on the range and a gutter marker.
   * @param {Array<{line: number, column?: number, endLine?: number, endColumn?: number, severity: "error"|"warning"|"info", message: string}>} diagnostics - 1-based lines and columns.
   * @returns {void}
   */
  setDiagnostics(diagnostics) {
    const marks = [];
    const severity = new Map();
    const rank = { error: 3, warning: 2, info: 1 };
    for (const d of diagnostics) {
      const line = clamp(d.line - 1, 0, this._lines.length - 1);
      const text = this._lines[line];
      let from = clamp((d.column ?? 1) - 1, 0, text.length);
      let to;
      if (d.endLine && d.endLine - 1 === line && d.endColumn) to = clamp(d.endColumn - 1, from, text.length);
      else {
        const word = /^[\w$#.-]+|^\S/.exec(text.slice(from));
        to = from + (word ? word[0].length : 0);
      }
      if (to === from) {
        // Nothing under the position (e.g. end of line): underline the line's last character.
        if (text.length === 0) to = from;
        else if (from >= text.length) {
          from = text.length - 1;
          to = text.length;
        } else to = from + 1;
      }
      if (to > from) marks.push({ line, from, to, className: `cs-mark-${d.severity}` });
      if ((rank[d.severity] ?? 0) > (rank[severity.get(line)] ?? 0)) severity.set(line, d.severity);
    }
    const changed = new Set([...this._lineSeverity.keys(), ...severity.keys()]);
    this._lineSeverity = severity;
    this._setMarks("diagnostics", marks, changed);
  }

  /**
   * Toggle the comment state of the selected lines.
   * @returns {void}
   */
  toggleComment() {
    const comment = this._language.comment ?? {};
    if (!comment.line && !comment.block) return;
    const { firstLine, lastLine, from, to } = this._selectedLineRange();
    const lines = this._lines.slice(firstLine, lastLine + 1);
    const { start, end } = this.getSelection();
    let replacement;
    if (comment.line) {
      const token = comment.line;
      const nonBlank = lines.filter((line) => line.trim());
      const allCommented = nonBlank.length > 0 && nonBlank.every((line) => line.trimStart().startsWith(token));
      if (allCommented) {
        replacement = lines.map((line) => line.replace(new RegExp(`^(\\s*)${escapeRegExp(token)} ?`), "$1"));
      } else {
        const indent = Math.min(...nonBlank.map((line) => /^\s*/.exec(line)[0].length), Infinity);
        const column = Number.isFinite(indent) ? indent : 0;
        replacement = lines.map((line) => (line.trim() ? `${line.slice(0, column)}${token} ${line.slice(column)}` : line));
      }
    } else {
      const [open, close] = comment.block;
      const joined = lines.join("\n");
      const trimmed = joined.trim();
      if (trimmed.startsWith(open) && trimmed.endsWith(close) && trimmed.length >= open.length + close.length) {
        const leading = joined.slice(0, joined.indexOf(open));
        const inner = trimmed.slice(open.length, trimmed.length - close.length).replace(/^ /, "").replace(/ $/, "");
        const trailing = joined.slice(joined.lastIndexOf(close) + close.length);
        replacement = `${leading}${inner}${trailing}`.split("\n");
      } else if (!trimmed) {
        return;
      } else {
        const leading = /^\s*/.exec(joined)[0];
        const trailing = /\s*$/.exec(joined)[0];
        replacement = `${leading}${open} ${joined.slice(leading.length, joined.length - trailing.length)} ${close}${trailing}`.split("\n");
      }
    }
    const text = replacement.join("\n");
    const delta = text.length - (to - from);
    if (start === end) {
      const firstDelta = replacement[0].length - lines[0].length;
      const caret = clamp(start + firstDelta, from, from + text.length);
      this.replaceRange(from, to, text, { select: [caret, caret], kind: "comment" });
    } else {
      this.replaceRange(from, to, text, { select: [from, to + delta], kind: "comment" });
    }
  }

  /**
   * Indent or outdent the selected lines.
   * @param {boolean} outdent
   * @returns {void}
   */
  indentLines(outdent) {
    const { firstLine, lastLine, from, to } = this._selectedLineRange();
    const unit = this._indentUnit();
    const width = this._settings.tabWidth;
    const lines = this._lines.slice(firstLine, lastLine + 1);
    const deltas = [];
    const replaced = lines.map((line) => {
      if (outdent) {
        const match = /^(\t| {1,})/.exec(line);
        if (!match) {
          deltas.push(0);
          return line;
        }
        const remove = match[1] === "\t" ? 1 : Math.min(match[1].length, width);
        deltas.push(-remove);
        return line.slice(remove);
      }
      if (!line.trim() && lines.length > 1) {
        deltas.push(0);
        return line;
      }
      deltas.push(unit.length);
      return unit + line;
    });
    const text = replaced.join("\n");
    if (text === lines.join("\n")) return;
    const { start, end } = this.getSelection();
    const total = deltas.reduce((sum, value) => sum + value, 0);
    const startLineDelta = deltas[0];
    const newStart = Math.max(from, start + startLineDelta);
    const newEnd = start === end ? newStart : Math.max(newStart, end + total);
    this.replaceRange(from, to, text, { select: [newStart, newEnd], kind: "indent" });
  }

  /**
   * Move the selected lines up or down by one line.
   * @param {-1|1} direction
   * @returns {void}
   */
  moveLines(direction) {
    const { firstLine, lastLine } = this._selectedLineRange();
    if ((direction < 0 && firstLine === 0) || (direction > 0 && lastLine >= this._lines.length - 1)) return;
    const { start, end } = this.getSelection();
    const block = this._lines.slice(firstLine, lastLine + 1);
    if (direction < 0) {
      const above = this._lines[firstLine - 1];
      const from = this.offsetAt(firstLine - 1, 0);
      const to = this.offsetAt(lastLine, this._lines[lastLine].length);
      const shift = above.length + 1;
      this.replaceRange(from, to, [...block, above].join("\n"), { select: [start - shift, end - shift], kind: "move" });
    } else {
      const below = this._lines[lastLine + 1];
      const from = this.offsetAt(firstLine, 0);
      const to = this.offsetAt(lastLine + 1, below.length);
      const shift = below.length + 1;
      this.replaceRange(from, to, [below, ...block].join("\n"), { select: [start + shift, end + shift], kind: "move" });
    }
  }

  /**
   * Scroll so a line is visible.
   * @param {number} line - 1-based.
   * @returns {void}
   */
  revealLine(line) {
    this._revealOffset(this.offsetAt(line - 1, 0), true);
  }

  /** @returns {{top: number, left: number}} */
  getScroll() {
    return { top: this._scroller.scrollTop, left: this._scroller.scrollLeft };
  }

  /**
   * @param {{top: number, left: number}} scroll
   * @returns {void}
   */
  setScroll({ top = 0, left = 0 }) {
    this._scroller.scrollTop = top;
    this._scroller.scrollLeft = left;
  }

  /** @returns {void} */
  destroy() {
    this._destroyed = true;
    cancelAnimationFrame(this._revealFrame);
    cancelAnimationFrame(this._bracketFrame);
    cancelAnimationFrame(this._windowFrame);
    document.removeEventListener("selectionchange", this._onSelectionChange);
    document.fonts?.removeEventListener?.("loadingdone", this._onFontsLoaded);
    this._resizeObserver?.disconnect();
    this._root.remove();
  }

  // ---------------------------------------------------------------
  // DOM
  // ---------------------------------------------------------------

  /**
   * @param {string} label
   * @returns {void}
   */
  _build(label) {
    this._linesEl = createElement("div", { className: "cs-editor__lines", attrs: { "aria-hidden": "true" } });
    this._input = createElement("textarea", {
      className: "cs-editor__input",
      attrs: {
        "aria-label": label,
        "aria-multiline": "true",
        spellcheck: "false",
        autocomplete: "off",
        autocorrect: "off",
        autocapitalize: "off",
        "data-gramm": "false",
        wrap: "off",
      },
    });
    this._surface = createElement("div", { className: "cs-editor__surface", children: [this._linesEl, this._input] });
    this._scroller = createElement("div", { className: "cs-editor__scroller", children: [this._surface] });
    this._root = createElement("div", { className: "cs-editor", children: [this._scroller] });
  }

  /** @returns {void} */
  _wire() {
    const input = this._input;
    input.addEventListener("keydown", (e) => this._onKeyDown(e));
    input.addEventListener("beforeinput", (e) => this._onBeforeInput(e));
    input.addEventListener("input", (e) => this._onInput(e));
    input.addEventListener("compositionstart", () => {
      this._composing = true;
      this._selBefore = this._currentSelection();
    });
    input.addEventListener("compositionend", () => {
      this._composing = false;
      this._syncFromInput("type");
    });
    input.addEventListener("scroll", () => {
      // The textarea is as large as its content; never let it scroll on its own.
      if (input.scrollTop || input.scrollLeft) {
        input.scrollTop = 0;
        input.scrollLeft = 0;
        this._scheduleReveal();
      }
    });
    input.addEventListener("focus", () => {
      this._root.classList.add("cs-editor--focused");
      this._selectionChanged();
    });
    input.addEventListener("blur", () => this._root.classList.remove("cs-editor--focused"));
    input.addEventListener("pointerup", () => this._selectionChanged());
    input.addEventListener("keyup", () => this._selectionChanged());
    this._onSelectionChange = () => {
      if (document.activeElement === input) this._selectionChanged();
    };
    document.addEventListener("selectionchange", this._onSelectionChange);
    // Large documents render the rows near the viewport as it moves.
    this._scroller.addEventListener("scroll", () => this._scheduleWindow(), { passive: true });
    if (typeof ResizeObserver === "function") {
      this._resizeObserver = new ResizeObserver(() => this._scheduleWindow());
      this._resizeObserver.observe(this._scroller);
    }
    this._onFontsLoaded = () => {
      this._charWidthPx = 0;
    };
    document.fonts?.addEventListener?.("loadingdone", this._onFontsLoaded);
    this._scroller.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      // A line number selects its line.
      const row = e.target instanceof Element ? e.target.closest(".cs-line") : null;
      if (row && this._linesEl.contains(row)) {
        e.preventDefault();
        this.focus();
        const position = this._lineEls.indexOf(row);
        const index = position >= 0 ? this._rowStart + position : -1;
        if (index >= 0) {
          const end = index + 1 < this._lines.length ? this.offsetAt(index + 1, 0) : this._text.length;
          this.setSelection(this.offsetAt(index, 0), end);
        }
        return;
      }
      // The empty area below the text puts the caret at the end.
      if (e.target === this._scroller || e.target === this._surface || e.target === this._linesEl) {
        e.preventDefault();
        this.focus();
        this.setSelection(this._text.length);
      }
    });
  }

  /** @returns {void} */
  _updateGutterWidth() {
    const digits = Math.max(2, String(this._lines.length).length);
    this._root.style.setProperty("--cs-gutter-digits", String(digits));
  }

  // ---------------------------------------------------------------
  // Row rendering (all rows, or the window near the viewport)
  // ---------------------------------------------------------------

  /** @returns {boolean} */
  _isLarge() {
    return this._lines.length > LARGE_DOCUMENT_LINES;
  }

  /** @returns {boolean} Whether rows should be windowed for the current document. */
  _shouldVirtualize() {
    return this._isLarge();
  }

  /**
   * Apply word wrap as the settings ask, unless the document is large.
   * @returns {void}
   */
  _applyWrapState() {
    const wrap = Boolean(this._settings.wordWrap) && !this._isLarge();
    this._wrapSuspended = Boolean(this._settings.wordWrap) && this._isLarge();
    this._root.classList.toggle("cs-editor--wrap", wrap);
    this._input.setAttribute("wrap", wrap ? "soft" : "off");
  }

  /**
   * Build the row layer from scratch for the current lines.
   * @returns {void}
   */
  _rebuildRows() {
    this._applyWrapState();
    this._virtual = this._shouldVirtualize();
    this._root.classList.toggle("cs-editor--virtual", this._virtual);
    this._lineEls = [];
    this._rowStart = 0;
    this._probeEl = null;
    const style = this._linesEl.style;
    style.paddingTop = "";
    style.height = "";
    style.boxSizing = "";
    style.counterReset = "";
    if (this._virtual) {
      this._recomputeWidest();
      this._linesEl.replaceChildren();
      this._renderWindow();
    } else {
      this._lineEls = this._lines.map((_, index) => this._renderLine(index));
      this._linesEl.replaceChildren(...this._lineEls);
    }
    this._updateGutterWidth();
  }

  /** @returns {number} Line height in pixels (the CSS uses font size × 1.5). */
  _lineHeight() {
    return (Number(this._settings.fontSize) || 14) * 1.5;
  }

  /** @returns {number} Top padding of the text, in pixels. */
  _padTop() {
    return parseFloat(getComputedStyle(this._root).getPropertyValue("--cs-pad-top")) || 6;
  }

  /** @returns {number} Width of one character of the editor font, in pixels. */
  _charWidth() {
    if (!this._charWidthPx) {
      const probe = document.createElement("span");
      probe.className = "cs-line__text";
      probe.style.cssText = "position:absolute;visibility:hidden;padding:0;white-space:pre";
      probe.textContent = "0".repeat(64);
      this._linesEl.append(probe);
      this._charWidthPx = probe.getBoundingClientRect().width / 64;
      probe.remove();
    }
    return this._charWidthPx || (Number(this._settings.fontSize) || 14) * 0.6;
  }

  /** @returns {void} */
  _scheduleWindow() {
    if (!this._virtual || this._windowFrame) return;
    this._windowFrame = requestAnimationFrame(() => {
      this._windowFrame = 0;
      this._renderWindow();
    });
  }

  /**
   * Render the rows around the viewport, reusing rows already rendered.
   * Rows are only replaced when the visible lines leave the rendered
   * range, so scrolling within it does no DOM work.
   * @returns {void}
   */
  _renderWindow() {
    if (!this._virtual || this._destroyed) return;
    const lineHeight = this._lineHeight();
    const total = this._lines.length;
    const top = Math.max(0, this._scroller.scrollTop - this._padTop());
    const height = this._scroller.clientHeight || 800;
    const visibleFirst = Math.min(total - 1, Math.floor(top / lineHeight));
    const visibleLast = Math.min(total, Math.ceil((top + height) / lineHeight));
    const currentStart = this._rowStart;
    const currentEnd = currentStart + this._lineEls.length;

    if (this._lineEls.length === 0 || visibleFirst < currentStart || visibleLast > currentEnd || currentEnd > total) {
      const first = Math.max(0, visibleFirst - WINDOW_BUFFER);
      const last = Math.min(total, visibleLast + WINDOW_BUFFER);
      const rows = [];
      for (let index = first; index < last; index += 1) {
        const reusable = index >= currentStart && index < currentEnd ? this._lineEls[index - currentStart] : null;
        rows.push(reusable ?? this._renderLine(index));
      }
      this._rowStart = first;
      this._lineEls = rows;
      this._linesEl.replaceChildren(...rows, this._widthProbe());
    } else {
      const probe = this._widthProbe();
      if (probe.parentNode !== this._linesEl) {
        this._linesEl.querySelector(".cs-line--probe")?.remove();
        this._linesEl.append(probe);
      }
    }
    const style = this._linesEl.style;
    const padTop = this._padTop();
    style.boxSizing = "border-box";
    style.paddingTop = `${padTop + this._rowStart * lineHeight}px`;
    style.height = `${padTop + total * lineHeight}px`;
    style.counterReset = `cs-line ${this._rowStart}`;
  }

  /**
   * After the lines from `first` changed in a large document: refresh or
   * drop the affected rows, then fill the window again.
   * @param {number} first - First changed line.
   * @param {number} replacedOld - Old lines replaced.
   * @param {number} replacedNew - New lines in their place.
   * @returns {void}
   */
  _updateWindowAfterChange(first, replacedOld, replacedNew) {
    const start = this._rowStart;
    if (replacedOld === replacedNew) {
      for (let index = first; index < first + replacedNew; index += 1) this._refreshLine(index);
    } else {
      // Rows from the first changed line on now show other lines.
      const keep = Math.max(0, Math.min(this._lineEls.length, first - start));
      for (const row of this._lineEls.splice(keep)) row.remove();
    }
    this._updateWidest(first, replacedOld, replacedNew);
    this._renderWindow();
  }

  /**
   * @param {number} index
   * @returns {number} Visual width of a line in character cells.
   */
  _lineWidth(index) {
    const line = this._lines[index] ?? "";
    return line.includes("\t") ? visualColumn(line, line.length, this._settings.tabWidth || 2) : line.length;
  }

  /** @returns {void} */
  _recomputeWidest() {
    let index = 0;
    let width = -1;
    for (let i = 0; i < this._lines.length; i += 1) {
      const lineWidth = this._lineWidth(i);
      if (lineWidth > width) {
        width = lineWidth;
        index = i;
      }
    }
    this._widest = { index, width: Math.max(0, width) };
    this._probeEl = null;
  }

  /**
   * Keep track of the widest line after an edit.
   * @param {number} first
   * @param {number} replacedOld
   * @param {number} replacedNew
   * @returns {void}
   */
  _updateWidest(first, replacedOld, replacedNew) {
    const widest = this._widest;
    let changed = false;
    if (widest.index >= first + replacedOld) {
      widest.index += replacedNew - replacedOld;
    } else if (widest.index >= first) {
      // The widest line itself was edited: if it got narrower, look again.
      const stillThere = widest.index < first + replacedNew;
      const width = stillThere ? this._lineWidth(widest.index) : -1;
      if (width < widest.width) {
        this._recomputeWidest();
        return;
      }
      widest.width = width;
      changed = true;
    }
    for (let index = first; index < first + replacedNew; index += 1) {
      const width = this._lineWidth(index);
      if (width > widest.width) {
        widest.index = index;
        widest.width = width;
        changed = true;
      }
    }
    if (changed) this._probeEl = null;
  }

  /** @returns {HTMLElement} Invisible row holding the widest line, so the scroll width is right. */
  _widthProbe() {
    if (!this._probeEl) {
      const probe = document.createElement("div");
      probe.className = "cs-line cs-line--probe";
      const text = document.createElement("span");
      text.className = "cs-line__text";
      text.textContent = this._lines[this._widest.index] ?? "";
      probe.append(text);
      this._probeEl = probe;
    }
    return this._probeEl;
  }

  /**
   * @param {number} index
   * @returns {HTMLElement|undefined} The rendered row of a line, if it is rendered.
   */
  _rowFor(index) {
    return index >= this._rowStart ? this._lineEls[index - this._rowStart] : undefined;
  }

  // ---------------------------------------------------------------
  // Document model and highlighting
  // ---------------------------------------------------------------

  /**
   * @param {string} text
   * @returns {void}
   */
  _resetDocument(text) {
    text = normalizeNewlines(text);
    this._text = text;
    this._input.value = text;
    this._lines = text.split("\n");
    this._lineStarts = null;
    this._markSets.clear();
    this._marksByLine.clear();
    this._lineSeverity.clear();
    this._currentLine = -1;
    this._undo = [];
    this._redo = [];
    this._retokenizeAll();
    this._input.setSelectionRange(0, 0);
    this._selBefore = [0, 0];
  }

  /** @returns {void} */
  _retokenizeAll() {
    const language = this._language;
    let state = language.initialState();
    this._states = [state];
    this._tokens = [];
    for (const line of this._lines) {
      const result = this._tokenizeLine(line, state);
      this._tokens.push(result.tokens);
      state = result.state;
      this._states.push(state);
    }
    this._currentLine = -1;
    this._rebuildRows();
    this._selectionChanged();
  }

  /**
   * @param {string} line
   * @param {object} state
   * @returns {{tokens: Array<[string|null, string]>, state: object}}
   */
  _tokenizeLine(line, state) {
    if (line.length > MAX_TOKENIZED_LINE) return { tokens: [[null, line]], state };
    try {
      return this._language.tokenize(line, state);
    } catch (error) {
      console.error("[CodeStudio] tokenizer failed:", error);
      return { tokens: line ? [[null, line]] : [], state };
    }
  }

  /**
   * Bring the line model (tokens, states, rows, decorations) up to date
   * with `newText`, re-rendering only what changed.
   * @param {string} _previous - Text the model showed (informational; the model's own lines are compared).
   * @param {string} newText
   * @returns {{first: number, oldEnd: number, newEnd: number}} The changed line span (end exclusive).
   */
  _updateModel(_previous, newText) {
    const oldLines = this._lines;
    const newLines = newText.split("\n");
    let first = 0;
    const minLength = Math.min(oldLines.length, newLines.length);
    while (first < minLength && oldLines[first] === newLines[first]) first += 1;
    let suffix = 0;
    while (
      suffix < minLength - first &&
      oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
    ) {
      suffix += 1;
    }
    const oldEnd = oldLines.length - suffix;
    let newEnd = newLines.length - suffix;
    if (first === oldEnd && first === newEnd) return { first, oldEnd, newEnd };

    // Tokenize the changed lines, then continue while the state differs.
    const newTokens = [];
    const newStates = [];
    let state = this._states[first];
    let index = first;
    for (; index < newEnd; index += 1) {
      const result = this._tokenizeLine(newLines[index], state);
      newTokens.push(result.tokens);
      state = result.state;
      newStates.push(state);
    }
    let oldIndex = oldEnd;
    while (index < newLines.length && !sameState(state, this._states[oldIndex])) {
      const result = this._tokenizeLine(newLines[index], state);
      newTokens.push(result.tokens);
      state = result.state;
      newStates.push(state);
      index += 1;
      oldIndex += 1;
    }
    const replacedOld = oldIndex - first;
    const replacedNew = index - first;

    this._lines = newLines;
    this._lineStarts = null;
    this._tokens.splice(first, replacedOld, ...newTokens);
    this._states.splice(first + 1, replacedOld, ...newStates);

    // Decorations: drop the changed lines' marks, shift the ones below.
    const delta = newEnd - oldEnd;
    for (const [name, marks] of this._markSets) {
      this._markSets.set(
        name,
        marks
          .filter((mark) => mark.line < first || mark.line >= oldEnd)
          .map((mark) => (mark.line >= oldEnd ? { ...mark, line: mark.line + delta } : mark))
      );
    }
    const severity = new Map();
    for (const [line, value] of this._lineSeverity) {
      if (line < first) severity.set(line, value);
      else if (line >= oldEnd) severity.set(line + delta, value);
    }
    this._lineSeverity = severity;
    this._indexMarks();
    if (this._currentLine >= first) this._currentLine = -1;

    // DOM: a document crossing the large-document size switches modes;
    // a windowed one updates its window; otherwise the changed rows are
    // replaced in place.
    if (this._shouldVirtualize() !== this._virtual) {
      this._rebuildRows();
      return { first, oldEnd, newEnd: first + replacedNew };
    }
    if (this._virtual) {
      this._updateWindowAfterChange(first, replacedOld, replacedNew);
      this._updateGutterWidth();
      return { first, oldEnd, newEnd: first + replacedNew };
    }
    const anchor = this._lineEls[first + replacedOld] ?? null;
    const removed = this._lineEls.splice(first, replacedOld);
    for (const el of removed) el.remove();
    const rows = [];
    for (let i = first; i < first + replacedNew; i += 1) rows.push(this._renderLine(i));
    this._lineEls.splice(first, 0, ...rows);
    if (anchor) anchor.before(...rows);
    else this._linesEl.append(...rows);
    this._updateGutterWidth();
    newEnd = first + replacedNew;
    return { first, oldEnd, newEnd };
  }

  /**
   * @param {number} index
   * @returns {HTMLElement}
   */
  _renderLine(index) {
    const row = document.createElement("div");
    row.className = "cs-line";
    this._fillLine(row, index);
    return row;
  }

  /**
   * @param {HTMLElement} row
   * @param {number} index
   * @returns {void}
   */
  _fillLine(row, index) {
    const text = this._lines[index] ?? "";
    const tokens = this._tokens[index] ?? [];
    const marks = this._marksByLine.get(index);
    const content = document.createElement("span");
    content.className = "cs-line__text";
    if (!marks || marks.length === 0) {
      for (const [type, value] of tokens) appendSegment(content, type, value, "");
    } else {
      // Split tokens at mark boundaries.
      const boundaries = new Set([0, text.length]);
      for (const mark of marks) {
        boundaries.add(clamp(mark.from, 0, text.length));
        boundaries.add(clamp(mark.to, 0, text.length));
      }
      let position = 0;
      for (const [type, value] of tokens) {
        const end = position + value.length;
        let cursor = position;
        const cuts = [...boundaries].filter((b) => b > position && b < end).sort((a, b) => a - b);
        for (const cut of [...cuts, end]) {
          const piece = text.slice(cursor, cut);
          const classes = marks.filter((m) => m.from <= cursor && m.to >= cut && m.to > m.from).map((m) => m.className).join(" ");
          appendSegment(content, type, piece, classes);
          cursor = cut;
        }
        position = end;
      }
    }
    row.className = "cs-line";
    if (index === this._currentLine) row.classList.add("cs-line--current");
    const severity = this._lineSeverity.get(index);
    if (severity) row.classList.add(`cs-line--${severity}`);
    row.replaceChildren(content);
  }

  /**
   * @param {number} index
   * @returns {void}
   */
  _refreshLine(index) {
    const row = this._rowFor(index);
    if (row) this._fillLine(row, index);
  }

  // ---------------------------------------------------------------
  // Decorations
  // ---------------------------------------------------------------

  /**
   * @param {string} name
   * @param {Mark[]} marks
   * @param {Set<number>} [extraLines] - Lines to repaint even without marks (gutter changes).
   * @returns {void}
   */
  _setMarks(name, marks, extraLines = new Set()) {
    const affected = new Set(extraLines);
    for (const mark of this._markSets.get(name) ?? []) affected.add(mark.line);
    for (const mark of marks) affected.add(mark.line);
    if (marks.length) this._markSets.set(name, marks);
    else this._markSets.delete(name);
    this._indexMarks();
    for (const line of affected) this._refreshLine(line);
  }

  /** @returns {void} */
  _indexMarks() {
    this._marksByLine = new Map();
    for (const marks of this._markSets.values()) {
      for (const mark of marks) {
        if (!this._marksByLine.has(mark.line)) this._marksByLine.set(mark.line, []);
        this._marksByLine.get(mark.line).push(mark);
      }
    }
  }

  /**
   * @param {number} from
   * @param {number} to
   * @param {string} className
   * @returns {Mark[]} One mark per line the range covers.
   */
  _rangeToMarks(from, to, className) {
    const start = this.positionAt(from);
    const end = this.positionAt(to);
    const marks = [];
    for (let line = start.line; line <= end.line; line += 1) {
      const a = line === start.line ? start.column : 0;
      const b = line === end.line ? end.column : this._lines[line].length;
      if (b > a) marks.push({ line, from: a, to: b, className });
    }
    return marks;
  }

  /** @returns {void} */
  _selectionChanged() {
    if (this._destroyed) return;
    const { line } = this.positionAt(this._input.selectionDirection === "backward" ? this._input.selectionStart : this._input.selectionEnd);
    if (line !== this._currentLine) {
      const previous = this._currentLine;
      this._currentLine = line;
      this._rowFor(previous)?.classList.remove("cs-line--current");
      this._rowFor(line)?.classList.add("cs-line--current");
    }
    cancelAnimationFrame(this._bracketFrame);
    this._bracketFrame = requestAnimationFrame(() => this._updateBracketMatch());
    this._onCursor?.(this.getCursor());
  }

  /** @returns {void} */
  _updateBracketMatch() {
    if (this._destroyed) return;
    const { start, end } = this.getSelection();
    if (start !== end) {
      this._setMarks("brackets", []);
      return;
    }
    const candidates = [start - 1, start];
    for (const offset of candidates) {
      const ch = this._text[offset];
      if (!ch || (!BRACKETS[ch] && !CLOSERS[ch])) continue;
      if (!this._isCodeBracket(offset)) continue;
      const match = this._findMatchingBracket(offset);
      const marks = [...this._rangeToMarks(offset, offset + 1, match === null ? "cs-mark-bracket cs-mark-bracket--unmatched" : "cs-mark-bracket")];
      if (match !== null) marks.push(...this._rangeToMarks(match, match + 1, "cs-mark-bracket"));
      this._setMarks("brackets", marks);
      return;
    }
    this._setMarks("brackets", []);
  }

  /**
   * @param {number} offset
   * @returns {boolean} Whether the character at offset is punctuation (not inside a string or comment).
   */
  _isCodeBracket(offset) {
    const { line, column } = this.positionAt(offset);
    return tokenTypeAt(this._tokens[line] ?? [], column) === "punc";
  }

  /**
   * @param {number} offset
   * @returns {number|null}
   */
  _findMatchingBracket(offset) {
    const ch = this._text[offset];
    const forward = Boolean(BRACKETS[ch]);
    const open = forward ? ch : CLOSERS[ch];
    const close = BRACKETS[open];
    const origin = this.positionAt(offset);
    let depth = 0;
    const lineCount = this._lines.length;
    for (let line = origin.line; forward ? line < lineCount : line >= 0; line += forward ? 1 : -1) {
      const segments = punctuationColumns(this._tokens[line] ?? []);
      const ordered = forward ? segments : segments.reverse();
      for (const [column, c] of ordered) {
        if (line === origin.line && (forward ? column < origin.column : column > origin.column)) continue;
        if (c === open) depth += forward ? 1 : -1;
        else if (c === close) depth += forward ? -1 : 1;
        else continue;
        if (depth === 0) return this.offsetAt(line, column);
      }
    }
    return null;
  }

  // ---------------------------------------------------------------
  // Input handling
  // ---------------------------------------------------------------

  /**
   * @param {InputEvent} e
   * @returns {void}
   */
  _onBeforeInput(e) {
    if (e.inputType === "historyUndo") {
      e.preventDefault();
      this.undo();
      return;
    }
    if (e.inputType === "historyRedo") {
      e.preventDefault();
      this.redo();
      return;
    }
    if (!this._composing) this._selBefore = this._currentSelection();
  }

  /**
   * @param {InputEvent} e
   * @returns {void}
   */
  _onInput(e) {
    if (this._composing || e.isComposing) {
      // Show the text being composed; it is recorded once composition ends.
      this._previewComposition();
      return;
    }
    const kind = /^delete/.test(e.inputType ?? "") ? "delete" : e.inputType === "insertText" ? "type" : "edit";
    this._syncFromInput(kind);
  }

  /** @returns {void} */
  _previewComposition() {
    const value = this._input.value;
    if (value === this._modelText()) return;
    // Only the view follows the composition; _text keeps the committed
    // document until the composition ends and is recorded.
    this._updateModel(this._modelText(), value);
    this._composedPreview = value;
  }

  /**
   * Record whatever the textarea now holds as one edit.
   * @param {string} kind
   * @returns {void}
   */
  _syncFromInput(kind) {
    const value = this._input.value;
    const base = this._text;
    if (value === base && !this._composedPreview) return;
    this._composedPreview = null;
    const { from, removed, inserted } = diffTexts(base, value, this._selBefore[0]);
    if (!removed && !inserted) {
      // Composition was cancelled: the model shows the preview, the text is unchanged.
      this._updateModel(this._modelText(), value);
      return;
    }
    const selAfter = this._currentSelection();
    this._commit({ from, removed, inserted, selBefore: this._selBefore, selAfter, kind }, { modelText: this._modelText() });
  }

  /** @returns {string} The text the line model currently reflects. */
  _modelText() {
    return this._lines.join("\n");
  }

  /**
   * Apply a finished change to the model, history, and listeners.
   * @param {{from: number, removed: string, inserted: string, selBefore: [number, number], selAfter: [number, number], kind: string}} record
   * @param {{modelText?: string, record?: boolean}} [options]
   * @returns {void}
   */
  _commit(record, { modelText, record: addToHistory = true } = {}) {
    const newText = this._input.value;
    const previousModel = modelText ?? this._text;
    this._text = newText;
    this._updateModel(previousModel, newText);
    if (addToHistory) this._pushHistory({ ...record, time: Date.now() });
    this._afterChange();
  }

  /**
   * @param {object} record
   * @returns {void}
   */
  _pushHistory(record) {
    this._redo = [];
    const last = this._undo[this._undo.length - 1];
    if (last && canGroup(last, record)) {
      if (record.kind === "type") {
        last.inserted += record.inserted;
      } else {
        // Backspace extends to the left, Delete to the right.
        if (record.from + record.removed.length === last.from) {
          last.removed = record.removed + last.removed;
          last.from = record.from;
        } else {
          last.removed += record.removed;
        }
      }
      last.selAfter = record.selAfter;
      last.time = record.time;
      return;
    }
    this._undo.push(record);
    if (this._undo.length > HISTORY_LIMIT) this._undo.shift();
  }

  /**
   * @param {object} record
   * @param {boolean} reverse - true to undo.
   * @returns {void}
   */
  _applyRecord(record, reverse) {
    const oldText = this._text;
    const removeText = reverse ? record.inserted : record.removed;
    const insertText = reverse ? record.removed : record.inserted;
    const newText = oldText.slice(0, record.from) + insertText + oldText.slice(record.from + removeText.length);
    this._input.value = newText;
    const selection = reverse ? record.selBefore : record.selAfter;
    this._input.setSelectionRange(Math.min(...selection), Math.max(...selection));
    this._text = newText;
    this._updateModel(oldText, newText);
    this._afterChange();
    this._revealOffset(selection[1], false);
  }

  /** @returns {void} */
  _afterChange() {
    this._selBefore = this._currentSelection();
    this._selectionChanged();
    this._scheduleReveal();
    this._onChange?.(this);
  }

  /** @returns {[number, number]} */
  _currentSelection() {
    return [this._input.selectionStart, this._input.selectionEnd];
  }

  /**
   * @param {KeyboardEvent} e
   * @returns {void}
   */
  _onKeyDown(e) {
    if (e.isComposing || e.keyCode === 229) return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key;
    const shortcut = (id) => keyboardShortcuts.matches(e, id);

    if (shortcut("codeStudio.undo")) return this._handled(e, () => this.undo());
    if (shortcut("codeStudio.redo")) return this._handled(e, () => this.redo());
    if (shortcut("codeStudio.toggleComment")) return this._handled(e, () => this.toggleComment());
    if (shortcut("codeStudio.indent")) return this._handled(e, () => this.indentLines(false));
    if (shortcut("codeStudio.outdent")) return this._handled(e, () => this.indentLines(true));
    if (shortcut("codeStudio.moveLineUp")) return this._handled(e, () => this.moveLines(-1));
    if (shortcut("codeStudio.moveLineDown")) return this._handled(e, () => this.moveLines(1));
    if (e.altKey || mod) return;

    if (shortcut("codeStudio.leaveEditor")) {
      // Escape, then Tab, moves focus out of the editor instead of indenting.
      this._escapeTab = true;
      return;
    }
    if (key === "Tab") {
      if (this._escapeTab) {
        this._escapeTab = false;
        return;
      }
      return this._handled(e, () => this._handleTab(e.shiftKey));
    }
    this._escapeTab = false;

    if (key === "Enter" && !e.shiftKey) return this._handled(e, () => this._handleEnter());
    if (key === "Backspace" && !e.shiftKey && this._handleBackspace()) return this._handled(e, () => {});
    if (key.length === 1 && this._handleCharacter(key)) return this._handled(e, () => {});
  }

  /**
   * @param {KeyboardEvent} e
   * @param {() => void} action
   * @returns {void}
   */
  _handled(e, action) {
    e.preventDefault();
    action();
  }

  /** @returns {string} */
  _indentUnit() {
    return this._settings.insertSpaces ? " ".repeat(this._settings.tabWidth) : "\t";
  }

  /**
   * @param {boolean} shift
   * @returns {void}
   */
  _handleTab(shift) {
    const { start, end } = this.getSelection();
    const multiLine = this._text.slice(start, end).includes("\n");
    if (shift || multiLine) {
      this.indentLines(shift);
      return;
    }
    let insert = this._indentUnit();
    if (this._settings.insertSpaces) {
      const { column } = this.positionAt(start);
      const visual = visualColumn(this._lines[this.positionAt(start).line], column, this._settings.tabWidth);
      insert = " ".repeat(this._settings.tabWidth - (visual % this._settings.tabWidth));
    }
    this.replaceRange(start, end, insert, { kind: "type" });
  }

  /** @returns {void} */
  _handleEnter() {
    const { start, end } = this.getSelection();
    const { line, column } = this.positionAt(start);
    const lineText = this._lines[line];
    const before = lineText.slice(0, column);
    const afterSelection = this._text.slice(end, this.offsetAt(this.positionAt(end).line, Infinity));
    const indent = /^[\t ]*/.exec(lineText)[0].slice(0, column);
    const unit = this._indentUnit();
    const opens = this._language.indentAfter?.test(before) ?? false;
    const prev = before.trimEnd().slice(-1);
    const next = afterSelection.trimStart()[0] ?? "";
    const betweenPair = (BRACKETS[prev] && BRACKETS[prev] === next) || (/>\s*$/.test(before) && /^\s*<\//.test(afterSelection) && opens);
    if (betweenPair) {
      const inner = indent + unit;
      const text = `\n${inner}\n${indent}`;
      const caret = start + 1 + inner.length;
      // Drop whitespace between the caret and the closing character.
      const trimmedEnd = end + (afterSelection.length - afterSelection.trimStart().length);
      this.replaceRange(start, trimmedEnd, text, { select: [caret, caret], kind: "edit" });
      return;
    }
    const text = `\n${indent}${opens ? unit : ""}`;
    this.replaceRange(start, end, text, { kind: "edit" });
  }

  /** @returns {boolean} Whether Backspace was handled (removing an empty pair or one indent level). */
  _handleBackspace() {
    const { start, end } = this.getSelection();
    if (start !== end || start === 0) return false;
    const prev = this._text[start - 1];
    const next = this._text[start];
    if (this._settings.autoCloseBrackets && AUTO_PAIRS[prev] && AUTO_PAIRS[prev] === next) {
      this.replaceRange(start - 1, start + 1, "", { kind: "delete" });
      return true;
    }
    if (this._settings.insertSpaces && prev === " ") {
      const { line, column } = this.positionAt(start);
      const before = this._lines[line].slice(0, column);
      if (/^ +$/.test(before)) {
        const width = this._settings.tabWidth;
        const remove = before.length % width || width;
        this.replaceRange(start - remove, start, "", { kind: "delete" });
        return true;
      }
    }
    return false;
  }

  /**
   * Auto-closing pairs and typing over an existing closing character.
   * @param {string} ch
   * @returns {boolean} Whether the key was handled.
   */
  _handleCharacter(ch) {
    if (!this._settings.autoCloseBrackets) return false;
    const { start, end } = this.getSelection();
    const next = this._text[end] ?? "";
    const prev = this._text[start - 1] ?? "";
    const isQuote = ch === '"' || ch === "'" || ch === "`";
    // Type over the closing character that is already there.
    if ((CLOSERS[ch] || isQuote) && start === end && next === ch) {
      const { line, column } = this.positionAt(start);
      const type = tokenTypeAt(this._tokens[line] ?? [], column);
      if (!isQuote || type === "str" || type === "attr") {
        this.setSelection(start + 1);
        return true;
      }
    }
    const close = AUTO_PAIRS[ch];
    if (!close) return false;
    if (start !== end) {
      const selected = this._text.slice(start, end);
      this.replaceRange(start, end, `${ch}${selected}${close}`, { select: [start + 1, end + 1], kind: "edit" });
      return true;
    }
    if (next && !/[\s)\]}>;,.:]/.test(next)) return false;
    if (isQuote) {
      if (/[\w$\\]/.test(prev)) return false;
      const { line, column } = this.positionAt(start);
      const type = tokenTypeAt(this._tokens[line] ?? [], Math.max(0, column - 1));
      if (column > 0 && (type === "str" || type === "com")) return false;
      if (this._language.id === "html" && ch === "'" && !this._inHtmlTag(start)) return false;
      if ((this._language.id === "markdown" || this._language.id === "plaintext") && ch !== "`") return false;
    }
    this.replaceRange(start, end, ch + close, { select: [start + 1, start + 1], kind: "type" });
    return true;
  }

  /**
   * @param {number} offset
   * @returns {boolean} Whether the caret is inside an HTML tag (where quotes are attribute delimiters).
   */
  _inHtmlTag(offset) {
    const before = this._text.slice(Math.max(0, offset - 400), offset);
    return before.lastIndexOf("<") > before.lastIndexOf(">");
  }

  /**
   * @returns {{firstLine: number, lastLine: number, from: number, to: number}} Lines touched by the selection.
   */
  _selectedLineRange() {
    const { start, end } = this.getSelection();
    const first = this.positionAt(start);
    const last = this.positionAt(end);
    let lastLine = last.line;
    if (end > start && last.column === 0 && lastLine > first.line) lastLine -= 1;
    return {
      firstLine: first.line,
      lastLine,
      from: this.offsetAt(first.line, 0),
      to: this.offsetAt(lastLine, this._lines[lastLine].length),
    };
  }

  /** @returns {number[]} */
  _getLineStarts() {
    if (!this._lineStarts) {
      const starts = new Array(this._lines.length);
      let offset = 0;
      for (let i = 0; i < this._lines.length; i += 1) {
        starts[i] = offset;
        offset += this._lines[i].length + 1;
      }
      this._lineStarts = starts;
    }
    return this._lineStarts;
  }

  // ---------------------------------------------------------------
  // Scrolling
  // ---------------------------------------------------------------

  /** @returns {void} */
  _scheduleReveal() {
    cancelAnimationFrame(this._revealFrame);
    this._revealFrame = requestAnimationFrame(() => {
      if (this._destroyed || !this.hasFocus()) return;
      const head = this._input.selectionDirection === "backward" ? this._input.selectionStart : this._input.selectionEnd;
      this._revealOffset(head, false);
    });
  }

  /**
   * Scroll the container so the caret at `offset` is visible.
   * @param {number} offset
   * @param {boolean} center
   * @returns {void}
   */
  _revealOffset(offset, center) {
    const rect = this._caretRect(offset);
    if (!rect) return;
    const scroller = this._scroller;
    const gutter = this._gutterWidth();
    const lineHeight = rect.height || 20;
    const viewTop = scroller.scrollTop;
    const viewHeight = scroller.clientHeight;
    if (center && (rect.top < viewTop || rect.top + lineHeight > viewTop + viewHeight)) {
      scroller.scrollTop = Math.max(0, rect.top - viewHeight / 2 + lineHeight / 2);
    } else if (rect.top < viewTop) {
      scroller.scrollTop = rect.top;
    } else if (rect.top + lineHeight > viewTop + viewHeight) {
      scroller.scrollTop = rect.top + lineHeight - viewHeight;
    }
    if (!this._settings.wordWrap) {
      const margin = 24;
      const viewLeft = scroller.scrollLeft;
      const viewWidth = scroller.clientWidth;
      if (rect.left - margin < viewLeft + gutter) {
        scroller.scrollLeft = Math.max(0, rect.left - gutter - margin);
      } else if (rect.left + margin > viewLeft + viewWidth) {
        scroller.scrollLeft = rect.left + margin - viewWidth;
      }
    }
  }

  /** @returns {number} */
  _gutterWidth() {
    const row = this._lineEls[0] ?? this._probeEl;
    return row?.firstChild ? row.firstChild.offsetLeft : 0;
  }

  /**
   * @param {number} offset
   * @returns {{top: number, left: number, height: number}|null} Caret position relative to the surface.
   */
  _caretRect(offset) {
    const { line, column } = this.positionAt(offset);
    const row = this._rowFor(line);
    if (!row) {
      if (!this._virtual) return null;
      // Not rendered yet (large document): rows are one line height each.
      const padLeft = parseFloat(getComputedStyle(this._root).getPropertyValue("--cs-pad-left")) || 10;
      const columns = visualColumn(this._lines[line] ?? "", column, this._settings.tabWidth || 2);
      return { top: this._padTop() + line * this._lineHeight(), left: this._gutterWidth() + padLeft + columns * this._charWidth(), height: this._lineHeight() };
    }
    const surfaceRect = this._surface.getBoundingClientRect();
    const content = row.firstChild;
    const position = findTextPosition(content, column);
    let rect = null;
    if (position) {
      const range = document.createRange();
      range.setStart(position.node, position.offset);
      range.setEnd(position.node, position.offset);
      const rects = range.getClientRects();
      rect = rects[rects.length - 1] ?? range.getBoundingClientRect();
    }
    if (!rect || (rect.width === 0 && rect.height === 0 && rect.top === 0)) {
      const rowRect = (content ?? row).getBoundingClientRect();
      return { top: rowRect.top - surfaceRect.top, left: rowRect.left - surfaceRect.left, height: row.offsetHeight };
    }
    return { top: rect.top - surfaceRect.top, left: rect.left - surfaceRect.left, height: rect.height || row.offsetHeight };
  }
}

// -----------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------

/**
 * @param {HTMLElement} parent
 * @param {string|null} type
 * @param {string} value
 * @param {string} extraClasses
 * @returns {void}
 */
function appendSegment(parent, type, value, extraClasses) {
  if (!value) return;
  if (!type && !extraClasses) {
    parent.append(value);
    return;
  }
  const span = document.createElement("span");
  span.className = `${type ? `cs-tok-${type}` : ""}${type && extraClasses ? " " : ""}${extraClasses}`;
  span.textContent = value;
  parent.append(span);
}

/**
 * @param {HTMLElement|null} root
 * @param {number} column
 * @returns {{node: Text, offset: number}|null}
 */
function findTextPosition(root, column) {
  if (!root) return null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let remaining = column;
  let last = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.nodeValue.length;
    if (remaining <= length) return { node, offset: remaining };
    remaining -= length;
    last = node;
  }
  return last ? { node: last, offset: last.nodeValue.length } : null;
}

/**
 * @param {Array<[string|null, string]>} tokens
 * @param {number} column
 * @returns {string|null} Token type covering the column.
 */
function tokenTypeAt(tokens, column) {
  let position = 0;
  for (const [type, value] of tokens) {
    if (column >= position && column < position + value.length) return type;
    position += value.length;
  }
  return null;
}

/**
 * @param {Array<[string|null, string]>} tokens
 * @returns {Array<[number, string]>} Columns of bracket characters in punctuation tokens.
 */
function punctuationColumns(tokens) {
  const result = [];
  let position = 0;
  for (const [type, value] of tokens) {
    if (type === "punc") {
      for (let i = 0; i < value.length; i += 1) {
        const c = value[i];
        if (BRACKETS[c] || CLOSERS[c]) result.push([position + i, c]);
      }
    }
    position += value.length;
  }
  return result;
}

/**
 * @param {object} a
 * @param {object} b
 * @returns {boolean}
 */
function sameState(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * @param {object} last
 * @param {object} record
 * @returns {boolean} Whether a new edit continues the previous one (typing or deleting a run of characters).
 */
function canGroup(last, record) {
  if (record.time - last.time > GROUP_DELAY_MS) return false;
  if (last.kind !== record.kind) return false;
  if (record.kind === "type") {
    if (record.removed || last.removed) return false;
    if (record.inserted.includes("\n")) return false;
    if (/\s/.test(record.inserted) && !/\s$/.test(last.inserted)) return false;
    return record.from === last.from + last.inserted.length;
  }
  if (record.kind === "delete") {
    if (record.inserted || last.inserted) return false;
    if (record.removed.includes("\n")) return false;
    return record.from + record.removed.length === last.from || record.from === last.from;
  }
  return false;
}

/**
 * Smallest single change turning `before` into `after`.
 * @param {string} before
 * @param {string} after
 * @param {number} hint - Where the change most likely starts (the caret before it); breaks ties when text repeats.
 * @returns {{from: number, removed: string, inserted: string}}
 */
export function diffTexts(before, after, hint) {
  const limit = Math.min(before.length, after.length, Math.max(0, hint ?? Infinity));
  let prefix = 0;
  const maxPrefix = Math.min(before.length, after.length);
  while (prefix < maxPrefix && before.charCodeAt(prefix) === after.charCodeAt(prefix)) prefix += 1;
  if (prefix > limit) prefix = limit;
  let suffix = 0;
  const maxSuffix = Math.min(before.length, after.length) - prefix;
  while (
    suffix < maxSuffix &&
    before.charCodeAt(before.length - 1 - suffix) === after.charCodeAt(after.length - 1 - suffix)
  ) {
    suffix += 1;
  }
  return {
    from: prefix,
    removed: before.slice(prefix, before.length - suffix),
    inserted: after.slice(prefix, after.length - suffix),
  };
}

/**
 * @param {string} query
 * @param {{caseSensitive?: boolean, regex?: boolean, wholeWord?: boolean}} options
 * @returns {{regex: RegExp|null, error: string|null}}
 */
export function buildSearchPattern(query, { caseSensitive = false, regex = false, wholeWord = false } = {}) {
  if (!query) return { regex: null, error: null };
  let source = regex ? query : escapeRegExp(query);
  if (wholeWord) source = `(?<![\\w$])(?:${source})(?![\\w$])`;
  try {
    return { regex: new RegExp(source, `g${caseSensitive ? "" : "i"}m`), error: null };
  } catch (error) {
    return { regex: null, error: error.message };
  }
}

/**
 * @param {string} text
 * @returns {string}
 */
export function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * @param {string} text
 * @returns {string} Text with \r\n and \r turned into \n.
 */
export function normalizeNewlines(text) {
  return String(text ?? "").replace(/\r\n?/g, "\n");
}

/**
 * @param {string} line
 * @param {number} column
 * @param {number} tabWidth
 * @returns {number} Visual column, with tabs expanded.
 */
function visualColumn(line, column, tabWidth) {
  let visual = 0;
  for (let i = 0; i < column; i += 1) {
    visual = line[i] === "\t" ? visual + tabWidth - (visual % tabWidth) : visual + 1;
  }
  return visual;
}

/**
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}
