/**
 * @file Calculator — a small four-function calculator. Demonstrates
 * an app driving real interactive state (not just static content)
 * and using onFocus()/onBlur() to scope a document-level keyboard
 * listener to only the window that's actually active.
 */

import { Application } from "../../core/application.js";
import { createElement } from "../../utils/dom.js";
import { ensureStylesheet } from "../../utils/loadStylesheet.js";

ensureStylesheet("src/apps/calculator/calculator.css");

const MAX_DISPLAY_DIGITS = 14;

/** @type {Array<{label: string, type: "digit"|"decimal"|"operator"|"equals"|"clear"|"backspace"|"spacer", value?: string, wide?: boolean}>} */
const KEY_LAYOUT = [
  { label: "C", type: "clear" },
  { label: "\u232b", type: "backspace" },
  { label: "", type: "spacer" },
  { label: "\u00f7", type: "operator", value: "\u00f7" },
  { label: "7", type: "digit", value: "7" },
  { label: "8", type: "digit", value: "8" },
  { label: "9", type: "digit", value: "9" },
  { label: "\u00d7", type: "operator", value: "\u00d7" },
  { label: "4", type: "digit", value: "4" },
  { label: "5", type: "digit", value: "5" },
  { label: "6", type: "digit", value: "6" },
  { label: "\u2212", type: "operator", value: "\u2212" },
  { label: "1", type: "digit", value: "1" },
  { label: "2", type: "digit", value: "2" },
  { label: "3", type: "digit", value: "3" },
  { label: "+", type: "operator", value: "+" },
  { label: "0", type: "digit", value: "0", wide: true },
  { label: ".", type: "decimal" },
  { label: "=", type: "equals" },
];

export default class CalculatorApp extends Application {
  constructor(meta) {
    super(meta);
    this._display = "0";
    this._accumulator = null;
    this._operator = null;
    this._overwrite = false;
    this._isFocused = false;
    this._displayEl = null;
    this._keydownHandler = (e) => this._handleKeydown(e);
  }

  /** @returns {ReturnType<Application["launch"]>} */
  launch() {
    this._displayEl = createElement("div", {
      className: "calculator__display",
      text: this._display,
      attrs: { "aria-live": "polite" },
    });

    const grid = createElement("div", { className: "calculator__grid" });
    for (const key of KEY_LAYOUT) {
      grid.append(this._buildKeyElement(key));
    }

    const element = createElement("div", {
      className: "calculator",
      attrs: { tabindex: "0" },
      children: [this._displayEl, grid],
    });

    document.addEventListener("keydown", this._keydownHandler);

    return {
      element,
      title: "Calculator",
      icon: "\u25a6",
      width: 300,
      height: 420,
      minWidth: 260,
      minHeight: 380,
      resizable: true,
      minimizable: true,
      maximizable: false,
      closable: true,
    };
  }

  /** @returns {void} */
  close() {
    document.removeEventListener("keydown", this._keydownHandler);
  }

  /** @returns {void} */
  onFocus() {
    this._isFocused = true;
  }

  /** @returns {void} */
  onBlur() {
    this._isFocused = false;
  }

  /**
   * @param {{label: string, type: string, value?: string}} key
   * @returns {HTMLElement}
   */
  _buildKeyElement(key) {
    if (key.type === "spacer") {
      return createElement("div", { className: "calculator__key calculator__key--spacer" });
    }

    const classNames = ["calculator__key"];
    if (key.type === "operator") classNames.push("calculator__key--operator");
    if (key.type === "equals") classNames.push("calculator__key--equals");
    if (key.type === "clear" || key.type === "backspace") classNames.push("calculator__key--function");

    const buttonEl = createElement("button", {
      className: classNames.join(" "),
      attrs: {
        type: "button",
        "aria-label": key.type === "backspace" ? "Backspace" : key.label,
      },
      text: key.label,
      on: { click: () => this._handleKey(key) },
    });

    if (key.wide) {
      buttonEl.style.gridColumn = "span 2";
    }

    return buttonEl;
  }

  /**
   * @param {KeyboardEvent} e
   * @returns {void}
   */
  _handleKeydown(e) {
    if (!this._isFocused) return;

    if (/^[0-9]$/.test(e.key)) {
      this._handleKey({ type: "digit", value: e.key });
    } else if (e.key === ".") {
      this._handleKey({ type: "decimal" });
    } else if (e.key === "+") {
      this._handleKey({ type: "operator", value: "+" });
    } else if (e.key === "-") {
      this._handleKey({ type: "operator", value: "\u2212" });
    } else if (e.key === "*") {
      this._handleKey({ type: "operator", value: "\u00d7" });
    } else if (e.key === "/") {
      this._handleKey({ type: "operator", value: "\u00f7" });
    } else if (e.key === "Enter" || e.key === "=") {
      this._handleKey({ type: "equals" });
    } else if (e.key === "Backspace") {
      this._handleKey({ type: "backspace" });
    } else if (e.key === "Escape") {
      this._handleKey({ type: "clear" });
    } else {
      return;
    }

    e.preventDefault();
  }

  /**
   * @param {{type: string, value?: string}} key
   * @returns {void}
   */
  _handleKey(key) {
    switch (key.type) {
      case "digit":
        this._onDigit(key.value);
        break;
      case "decimal":
        this._onDecimal();
        break;
      case "operator":
        this._onOperator(key.value);
        break;
      case "equals":
        this._onEquals();
        break;
      case "clear":
        this._onClear();
        break;
      case "backspace":
        this._onBackspace();
        break;
      default:
        return;
    }
    this._render();
  }

  /** @param {string} digit @returns {void} */
  _onDigit(digit) {
    if (this._display === "Error") this._onClear();

    if (this._overwrite) {
      this._display = digit;
      this._overwrite = false;
      return;
    }

    const digitCount = this._display.replace("-", "").replace(".", "").length;
    if (this._display === "0") {
      this._display = digit;
    } else if (digitCount < MAX_DISPLAY_DIGITS) {
      this._display += digit;
    }
  }

  /** @returns {void} */
  _onDecimal() {
    if (this._display === "Error") this._onClear();

    if (this._overwrite) {
      this._display = "0.";
      this._overwrite = false;
      return;
    }
    if (!this._display.includes(".")) {
      this._display += ".";
    }
  }

  /** @param {string} operator @returns {void} */
  _onOperator(operator) {
    if (this._display === "Error") this._onClear();

    if (this._operator && !this._overwrite) {
      this._compute();
    } else {
      this._accumulator = parseFloat(this._display);
    }
    this._operator = operator;
    this._overwrite = true;
  }

  /** @returns {void} */
  _onEquals() {
    if (this._operator === null || this._display === "Error") return;
    this._compute();
    this._operator = null;
    this._overwrite = true;
  }

  /** @returns {void} */
  _onClear() {
    this._display = "0";
    this._accumulator = null;
    this._operator = null;
    this._overwrite = false;
  }

  /** @returns {void} */
  _onBackspace() {
    if (this._display === "Error" || this._overwrite) {
      this._onClear();
      return;
    }
    this._display = this._display.length > 1 ? this._display.slice(0, -1) : "0";
  }

  /** @returns {void} */
  _compute() {
    const current = parseFloat(this._display);
    let result;

    switch (this._operator) {
      case "+":
        result = this._accumulator + current;
        break;
      case "\u2212":
        result = this._accumulator - current;
        break;
      case "\u00d7":
        result = this._accumulator * current;
        break;
      case "\u00f7":
        if (current === 0) {
          this._display = "Error";
          this._accumulator = null;
          this._operator = null;
          this._overwrite = true;
          return;
        }
        result = this._accumulator / current;
        break;
      default:
        return;
    }

    result = Math.round(result * 1e10) / 1e10;
    this._display = String(result);
    this._accumulator = result;
  }

  /** @returns {void} */
  _render() {
    this._displayEl.textContent = this._display;
  }
}
