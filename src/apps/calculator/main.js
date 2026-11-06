/**
 * @file Calculator — standard and scientific calculator with history.
 *
 * Input is an editable expression evaluated by expression.js (a safe
 * recursive-descent parser; no eval). The display shows the expression,
 * a live preview of its value while typing, and the result or a clear
 * error message after "=".
 *
 * Keyboard input is handled on the calculator's own root element, so
 * it only applies while this window has focus and never reaches other
 * windows; several Calculator windows can be open at once.
 *
 * Persistence (StorageService): history (shared by every window, kept
 * in sync through "calculator:historyChanged") and preferences (mode,
 * angle unit, history panel visibility).
 */

import { Application } from "../../core/application.js";
import { eventBus } from "../../core/eventBus.js";
import { storage } from "../../core/storage.js";
import { keyboardShortcuts } from "../../core/keyboard/keyboardShortcuts.js";
import { createElement, clearElement } from "../../utils/dom.js";
import { ensureStylesheet } from "../../utils/loadStylesheet.js";
import { evaluate, formatResult, CalcError } from "./expression.js";

ensureStylesheet("src/apps/calculator/calculator.css");

const HISTORY_KEY = "calculator:history";
const PREFERENCES_KEY = "calculator:preferences";
const MAX_HISTORY = 50;
const COPY_FEEDBACK_MS = 1500;

/** Trailing input removed as a unit by Backspace. */
const TRAILING_TOKEN = /(asin\(|acos\(|atan\(|sin\(|cos\(|tan\(|abs\(|ln\(|log\(|mod|Ans|\u221a\(|\u221b\(|.)$/u;

/**
 * @typedef {object} KeyDef
 * @property {string} label
 * @property {string} [insert] - Text appended to the expression.
 * @property {string} [action] - "clear" | "backspace" | "equals" | "negate" | "inverse" | "angle"
 * @property {string} [aria]
 * @property {string} [variant] - "operator" | "function" | "equals" | "digit"
 * @property {string} [inverseLabel]
 * @property {string} [inverseInsert]
 */

/** @type {KeyDef[]} 4 × 6 */
const STANDARD_KEYS = [
  { label: "C", action: "clear", aria: "Clear", variant: "function" },
  { label: "\u232b", action: "backspace", aria: "Backspace", variant: "function" },
  { label: "(", insert: "(", aria: "Open parenthesis", variant: "function" },
  { label: ")", insert: ")", aria: "Close parenthesis", variant: "function" },
  { label: "7", insert: "7", variant: "digit" },
  { label: "8", insert: "8", variant: "digit" },
  { label: "9", insert: "9", variant: "digit" },
  { label: "\u00f7", insert: "\u00f7", aria: "Divide", variant: "operator" },
  { label: "4", insert: "4", variant: "digit" },
  { label: "5", insert: "5", variant: "digit" },
  { label: "6", insert: "6", variant: "digit" },
  { label: "\u00d7", insert: "\u00d7", aria: "Multiply", variant: "operator" },
  { label: "1", insert: "1", variant: "digit" },
  { label: "2", insert: "2", variant: "digit" },
  { label: "3", insert: "3", variant: "digit" },
  { label: "\u2212", insert: "\u2212", aria: "Subtract", variant: "operator" },
  { label: "\u00b1", action: "negate", aria: "Change sign", variant: "function" },
  { label: "0", insert: "0", variant: "digit" },
  { label: ".", insert: ".", aria: "Decimal point", variant: "digit" },
  { label: "+", insert: "+", aria: "Add", variant: "operator" },
  { label: "%", insert: "%", aria: "Percent", variant: "function" },
  { label: "=", action: "equals", aria: "Equals", variant: "equals" },
];

/** @type {KeyDef[]} 3 × 6 */
const SCIENTIFIC_KEYS = [
  { label: "Inv", action: "inverse", aria: "Inverse functions", variant: "function" },
  { label: "Deg", action: "angle", aria: "Angle unit", variant: "function" },
  { label: "\u03c0", insert: "\u03c0", aria: "Pi", variant: "function" },
  { label: "sin", insert: "sin(", inverseLabel: "sin\u207b\u00b9", inverseInsert: "asin(", aria: "Sine", variant: "function" },
  { label: "cos", insert: "cos(", inverseLabel: "cos\u207b\u00b9", inverseInsert: "acos(", aria: "Cosine", variant: "function" },
  { label: "tan", insert: "tan(", inverseLabel: "tan\u207b\u00b9", inverseInsert: "atan(", aria: "Tangent", variant: "function" },
  { label: "x\u00b2", insert: "^2", aria: "Square", variant: "function" },
  { label: "x\u02b8", insert: "^", aria: "Power", variant: "function" },
  { label: "\u221a", insert: "\u221a(", inverseLabel: "\u221b", inverseInsert: "\u221b(", aria: "Square root", variant: "function" },
  { label: "ln", insert: "ln(", inverseLabel: "e\u02e3", inverseInsert: "e^(", aria: "Natural logarithm", variant: "function" },
  { label: "log", insert: "log(", inverseLabel: "10\u02e3", inverseInsert: "10^(", aria: "Logarithm base 10", variant: "function" },
  { label: "e", insert: "e", aria: "Euler's number", variant: "function" },
  { label: "n!", insert: "!", aria: "Factorial", variant: "function" },
  { label: "EXP", insert: "E", aria: "Times ten to the power", variant: "function" },
  { label: "1/x", insert: "^(\u22121)", aria: "Reciprocal", variant: "function" },
  { label: "|x|", insert: "abs(", aria: "Absolute value", variant: "function" },
  { label: "mod", insert: "mod", aria: "Modulo", variant: "function" },
  { label: "Ans", insert: "Ans", aria: "Previous answer", variant: "function" },
];

/** Keyboard characters → inserted text. */
const KEY_INSERTS = Object.freeze({
  "+": "+",
  "-": "\u2212",
  "*": "\u00d7",
  "/": "\u00f7",
  "^": "^",
  "(": "(",
  ")": ")",
  "%": "%",
  "!": "!",
  ".": ".",
  ",": ".",
});

export default class CalculatorApp extends Application {
  constructor(meta) {
    super(meta);
    this._expression = "";
    this._result = null;
    this._error = null;
    this._ans = null;
    this._justEvaluated = false;
    this._inverse = false;
    this._preferences = loadPreferences();
    this._history = loadHistory();
    this._cleanups = [];
    this._copyTimerId = null;
  }

  /** @returns {ReturnType<Application["launch"]>} */
  launch() {
    this._buildDom();
    this._renderAll();

    this._cleanups.push(
      eventBus.on("calculator:historyChanged", ({ source }) => {
        if (source === this) return;
        this._history = loadHistory();
        this._renderHistory();
      })
    );

    return {
      element: this._root,
      title: "Calculator",
      icon: "\u25a6",
      width: 440,
      height: 580,
      minWidth: 300,
      minHeight: 460,
      resizable: true,
      minimizable: true,
      maximizable: true,
      closable: true,
    };
  }

  /** @returns {void} */
  close() {
    for (const cleanup of this._cleanups) cleanup();
    this._cleanups = [];
    window.clearTimeout(this._copyTimerId);
  }

  /** @returns {void} */
  onFocus() {
    // Route keyboard input here when the window gains focus, unless a
    // control inside the calculator already has it.
    if (!this._root.contains(document.activeElement)) this._root.focus({ preventScroll: true });
  }

  // ---------------------------------------------------------------
  // DOM
  // ---------------------------------------------------------------

  /** @returns {void} */
  _buildDom() {
    this._modeButtons = {
      standard: this._modeButton("standard", "Standard"),
      scientific: this._modeButton("scientific", "Scientific"),
    };
    this._historyToggle = createElement("button", {
      className: "calculator__icon-button",
      attrs: { type: "button", "aria-label": "Show history", "aria-pressed": "false", title: "History" },
      text: "\u21ba",
      on: { click: () => this._setPreference("showHistory", !this._preferences.showHistory) },
    });

    const header = createElement("div", {
      className: "calculator__header",
      children: [
        createElement("div", {
          className: "calculator__modes",
          attrs: { role: "group", "aria-label": "Calculator mode" },
          children: [this._modeButtons.standard, this._modeButtons.scientific],
        }),
        this._historyToggle,
      ],
    });

    this._expressionEl = createElement("div", { className: "calculator__expression", attrs: { "aria-label": "Expression" } });
    this._resultEl = createElement("output", { className: "calculator__result", attrs: { "aria-live": "polite" } });
    this._copyButton = createElement("button", {
      className: "calculator__icon-button calculator__copy",
      attrs: { type: "button", "aria-label": "Copy result", title: "Copy result (Ctrl + C)" },
      text: "\u2398",
      on: { click: () => this._copyResult() },
    });
    this._angleBadge = createElement("span", { className: "calculator__badge", attrs: { "aria-label": "Angle unit" } });

    const display = createElement("div", {
      className: "calculator__display",
      children: [
        createElement("div", { className: "calculator__display-top", children: [this._angleBadge, this._copyButton] }),
        this._expressionEl,
        this._resultEl,
      ],
    });

    this._sciGrid = createElement("div", {
      className: "calculator__grid calculator__grid--scientific",
      attrs: { role: "group", "aria-label": "Scientific functions" },
    });
    this._sciButtons = SCIENTIFIC_KEYS.map((key) => this._keyButton(key));
    this._sciGrid.append(...this._sciButtons.map(({ el }) => el));

    const mainGrid = createElement("div", {
      className: "calculator__grid calculator__grid--standard",
      attrs: { role: "group", "aria-label": "Keypad" },
      children: STANDARD_KEYS.map((key) => this._keyButton(key).el),
    });

    const pad = createElement("div", { className: "calculator__pad", children: [this._sciGrid, mainGrid] });

    this._historyListEl = createElement("ol", { className: "calculator__history-list", attrs: { "aria-label": "Calculation history" } });
    this._historyPanel = createElement("aside", {
      className: "calculator__history",
      attrs: { "aria-label": "History" },
      children: [
        createElement("div", {
          className: "calculator__history-header",
          children: [
            createElement("h2", { className: "calculator__history-title", text: "History" }),
            createElement("button", {
              className: "calculator__text-button",
              attrs: { type: "button" },
              text: "Clear",
              on: { click: () => this._clearHistory() },
            }),
          ],
        }),
        this._historyListEl,
      ],
    });

    const main = createElement("div", { className: "calculator__main", children: [display, pad] });

    this._root = createElement("div", {
      className: "calculator",
      attrs: { tabindex: "0", "aria-label": "Calculator" },
      children: [header, createElement("div", { className: "calculator__body", children: [main, this._historyPanel] })],
      on: { keydown: (e) => this._handleKeydown(e) },
    });
  }

  /**
   * @param {"standard"|"scientific"} mode
   * @param {string} label
   * @returns {HTMLButtonElement}
   */
  _modeButton(mode, label) {
    return createElement("button", {
      className: "calculator__mode",
      attrs: { type: "button", "aria-pressed": "false" },
      text: label,
      on: { click: () => this._setPreference("mode", mode) },
    });
  }

  /**
   * @param {KeyDef} key
   * @returns {{el: HTMLButtonElement, key: KeyDef}}
   */
  _keyButton(key) {
    const el = createElement("button", {
      className: `calculator__key calculator__key--${key.variant ?? "digit"}`,
      attrs: { type: "button", "aria-label": key.aria ?? key.label },
      text: key.label,
      on: { click: () => this._pressKey(key) },
    });
    if (key.action === "equals") el.classList.add("calculator__key--wide");
    return { el, key };
  }

  // ---------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------

  /** @returns {void} */
  _renderAll() {
    const { mode, angleUnit, showHistory } = this._preferences;
    this._root.dataset.mode = mode;
    this._root.dataset.history = showHistory ? "shown" : "hidden";
    for (const [key, button] of Object.entries(this._modeButtons)) {
      button.setAttribute("aria-pressed", String(key === mode));
      button.classList.toggle("calculator__mode--active", key === mode);
    }
    this._sciGrid.hidden = mode !== "scientific";
    this._historyToggle.setAttribute("aria-pressed", String(showHistory));
    this._historyToggle.setAttribute("aria-label", showHistory ? "Hide history" : "Show history");
    this._angleBadge.textContent = mode === "scientific" ? angleUnit.toUpperCase() : "";
    this._angleBadge.hidden = mode !== "scientific";

    for (const { el, key } of this._sciButtons) {
      if (key.action === "angle") {
        el.textContent = angleUnit === "deg" ? "Deg" : "Rad";
        el.setAttribute("aria-label", `Angle unit: ${angleUnit === "deg" ? "degrees" : "radians"}`);
      } else if (key.action === "inverse") {
        el.setAttribute("aria-pressed", String(this._inverse));
        el.classList.toggle("calculator__key--active", this._inverse);
      } else if (key.inverseLabel) {
        el.textContent = this._inverse ? key.inverseLabel : key.label;
      }
    }

    this._renderDisplay();
    this._renderHistory();
  }

  /** @returns {void} */
  _renderDisplay() {
    this._expressionEl.textContent = this._expression || "\u00a0";
    this._resultEl.classList.toggle("calculator__result--error", Boolean(this._error));
    this._resultEl.classList.toggle("calculator__result--preview", !this._justEvaluated && !this._error);

    if (this._error) {
      this._resultEl.textContent = this._error;
    } else if (this._justEvaluated && this._result !== null) {
      this._resultEl.textContent = formatResult(this._result);
    } else {
      this._resultEl.textContent = this._preview() ?? (this._expression ? "\u00a0" : "0");
    }
    this._copyButton.disabled = this._currentValue() === null;
  }

  /**
   * @returns {string|null} The value of the expression being typed, when it is valid and not a plain number.
   */
  _preview() {
    if (!this._expression || /^[0-9.]+$/.test(this._expression)) return null;
    try {
      return `= ${formatResult(evaluate(this._expression, this._evalOptions()))}`;
    } catch {
      return null;
    }
  }

  /** @returns {void} */
  _renderHistory() {
    clearElement(this._historyListEl);
    if (this._history.length === 0) {
      this._historyListEl.append(createElement("li", { className: "calculator__history-empty", text: "No calculations yet" }));
      return;
    }
    for (const item of this._history) {
      this._historyListEl.append(
        createElement("li", {
          children: [
            createElement("button", {
              className: "calculator__history-item",
              attrs: { type: "button", "aria-label": `${item.expression} equals ${item.result}. Use result.`, title: "Use this result" },
              children: [
                createElement("span", { className: "calculator__history-expression", text: item.expression }),
                createElement("span", { className: "calculator__history-result", text: `= ${item.result}` }),
              ],
              on: { click: () => this._reuse(item.result) },
            }),
          ],
        })
      );
    }
  }

  // ---------------------------------------------------------------
  // Input
  // ---------------------------------------------------------------

  /**
   * @param {KeyDef} key
   * @returns {void}
   */
  _pressKey(key) {
    switch (key.action) {
      case "clear":
        this._clear();
        break;
      case "backspace":
        this._backspace();
        break;
      case "equals":
        this._evaluate();
        break;
      case "negate":
        this._negate();
        break;
      case "inverse":
        this._inverse = !this._inverse;
        this._renderAll();
        break;
      case "angle":
        this._setPreference("angleUnit", this._preferences.angleUnit === "deg" ? "rad" : "deg");
        break;
      default: {
        const text = this._inverse && key.inverseInsert ? key.inverseInsert : key.insert;
        this._insert(text);
        if (this._inverse && key.inverseInsert) {
          this._inverse = false;
          this._renderAll();
        }
      }
    }
  }

  /**
   * @param {string} text
   * @returns {void}
   */
  _insert(text) {
    if (this._justEvaluated) {
      // After "=", an operator continues from the result; anything else starts fresh.
      const continues = /^[+\u2212\u00d7\u00f7^%!E]|^mod$/.test(text);
      this._expression = continues && this._result !== null ? formatResult(this._result) : "";
      this._justEvaluated = false;
    }
    this._error = null;
    this._expression += text;
    this._renderDisplay();
  }

  /** @returns {void} */
  _clear() {
    this._expression = "";
    this._error = null;
    this._result = null;
    this._justEvaluated = false;
    this._renderDisplay();
  }

  /** @returns {void} */
  _backspace() {
    if (this._justEvaluated) {
      this._justEvaluated = false;
      this._expression = this._result !== null ? formatResult(this._result) : "";
    }
    this._error = null;
    this._expression = this._expression.replace(TRAILING_TOKEN, "");
    this._renderDisplay();
  }

  /**
   * Toggle the sign of the number at the end of the expression.
   * @returns {void}
   */
  _negate() {
    if (this._justEvaluated && this._result !== null) {
      this._expression = formatResult(this._result);
      this._justEvaluated = false;
    }
    this._error = null;
    const match = /(^|[^0-9.)\u03c0eA-Za-z])(\u2212?)([0-9.]+|\u03c0|e|Ans)$/u.exec(this._expression);
    if (!match) {
      this._expression += "\u2212";
    } else {
      const [, before, sign, operand] = match;
      const head = this._expression.slice(0, match.index) + before;
      this._expression = head + (sign ? "" : "\u2212") + operand;
    }
    this._renderDisplay();
  }

  /** @returns {void} */
  _evaluate() {
    if (!this._expression) return;
    try {
      const value = evaluate(this._expression, this._evalOptions());
      this._result = value;
      this._ans = value;
      this._error = null;
      this._justEvaluated = true;
      this._addHistory(this._expression, formatResult(value));
    } catch (error) {
      this._error = error instanceof CalcError ? error.message : "That expression can't be calculated";
      this._justEvaluated = false;
      if (!(error instanceof CalcError)) console.error("[Calculator] unexpected evaluation error:", error);
    }
    this._renderDisplay();
  }

  /** @returns {import("./expression.js").EvaluateOptions} */
  _evalOptions() {
    return { angleUnit: this._preferences.angleUnit, ans: this._ans };
  }

  /**
   * Insert a previous result into the current expression.
   * @param {string} result
   * @returns {void}
   */
  _reuse(result) {
    if (this._justEvaluated) {
      this._expression = "";
      this._justEvaluated = false;
    }
    this._error = null;
    const needsMultiply = /[0-9.)\u03c0e]$/u.test(this._expression);
    this._expression += (needsMultiply ? "\u00d7" : "") + (result.startsWith("-") ? `(\u2212${result.slice(1)})` : result);
    this._renderDisplay();
    this._root.focus({ preventScroll: true });
  }

  /**
   * @param {KeyboardEvent} e
   * @returns {void}
   */
  _handleKeydown(e) {
    if (keyboardShortcuts.matches(e, "calculator.copy")) {
      if (window.getSelection()?.toString()) return; // Let a text selection copy normally.
      e.preventDefault();
      this._copyResult();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    if (keyboardShortcuts.matches(e, "calculator.evaluate")) {
      e.preventDefault();
      this._evaluate();
    } else if (keyboardShortcuts.matches(e, "calculator.clear")) {
      e.preventDefault();
      e.stopPropagation();
      this._clear();
    } else if (keyboardShortcuts.matches(e, "calculator.backspace")) {
      e.preventDefault();
      this._backspace();
    } else if (/^[0-9]$/.test(e.key)) {
      e.preventDefault();
      this._insert(e.key);
    } else if (KEY_INSERTS[e.key]) {
      e.preventDefault();
      this._insert(KEY_INSERTS[e.key]);
    } else if (/^[a-zA-Z]$/.test(e.key)) {
      e.preventDefault();
      this._insertLetter(e.key);
    }
  }

  /**
   * Letters spell function and constant names (sin, sqrt, pi, ans, mod).
   * "x" multiplies unless it continues a name (as in "exp"), and an
   * upper-case "E" is the "times ten to the power" operator.
   * @param {string} key
   * @returns {void}
   */
  _insertLetter(key) {
    const previous = this._justEvaluated ? "" : this._expression.slice(-1);
    if (key.toLowerCase() === "x" && !/[a-z]/i.test(previous)) {
      this._insert("\u00d7");
      return;
    }
    this._insert(key === "E" ? "E" : key.toLowerCase());
  }

  // ---------------------------------------------------------------
  // Clipboard, history, preferences
  // ---------------------------------------------------------------

  /**
   * @returns {number|null}
   */
  _currentValue() {
    if (this._error) return null;
    if (this._justEvaluated) return this._result;
    try {
      return this._expression ? evaluate(this._expression, this._evalOptions()) : null;
    } catch {
      return null;
    }
  }

  /** @returns {Promise<void>} */
  async _copyResult() {
    const value = this._currentValue();
    if (value === null) return;
    const text = formatResult(value);
    let copied = false;
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
    } catch {
      copied = copyWithSelectionFallback(text);
    }
    this._copyButton.textContent = copied ? "\u2713" : "\u2715";
    this._copyButton.setAttribute("aria-label", copied ? "Result copied" : "Copy failed");
    window.clearTimeout(this._copyTimerId);
    this._copyTimerId = window.setTimeout(() => {
      this._copyButton.textContent = "\u2398";
      this._copyButton.setAttribute("aria-label", "Copy result");
    }, COPY_FEEDBACK_MS);
  }

  /**
   * @param {string} expression
   * @param {string} result
   * @returns {void}
   */
  _addHistory(expression, result) {
    const latest = this._history[0];
    if (latest && latest.expression === expression && latest.result === result) return;
    this._history = [{ expression, result, at: Date.now() }, ...this._history].slice(0, MAX_HISTORY);
    this._persistHistory();
  }

  /** @returns {void} */
  _clearHistory() {
    this._history = [];
    this._persistHistory();
  }

  /** @returns {void} */
  _persistHistory() {
    storage.set(HISTORY_KEY, this._history);
    this._renderHistory();
    eventBus.emit("calculator:historyChanged", Object.freeze({ source: this }));
  }

  /**
   * @param {"mode"|"angleUnit"|"showHistory"} key
   * @param {*} value
   * @returns {void}
   */
  _setPreference(key, value) {
    this._preferences = { ...this._preferences, [key]: value };
    storage.set(PREFERENCES_KEY, this._preferences);
    this._renderAll();
  }
}

/**
 * @returns {{mode: "standard"|"scientific", angleUnit: "deg"|"rad", showHistory: boolean}}
 */
function loadPreferences() {
  const stored = storage.get(PREFERENCES_KEY, null);
  return {
    mode: stored?.mode === "scientific" ? "scientific" : "standard",
    angleUnit: stored?.angleUnit === "rad" ? "rad" : "deg",
    showHistory: stored?.showHistory === true,
  };
}

/**
 * @returns {Array<{expression: string, result: string, at: number}>} Stored history, with malformed entries dropped.
 */
function loadHistory() {
  const stored = storage.get(HISTORY_KEY, []);
  if (!Array.isArray(stored)) return [];
  return stored
    .filter((item) => item && typeof item.expression === "string" && typeof item.result === "string")
    .slice(0, MAX_HISTORY)
    .map((item) => ({ expression: item.expression, result: item.result, at: Number(item.at) || 0 }));
}

/**
 * Clipboard fallback for contexts where the async Clipboard API is unavailable.
 * @param {string} text
 * @returns {boolean}
 */
function copyWithSelectionFallback(text) {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }
  textarea.remove();
  return copied;
}
