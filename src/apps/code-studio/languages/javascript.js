/**
 * @file JavaScript (and JSON) highlighting for Code Studio.
 *
 * A line tokenizer that carries block comments and template literals
 * across lines. Regular-expression literals are recognized from the
 * previous significant token (a `/` after a value is division).
 */

import { registerLanguage } from "./registry.js";

const KEYWORDS = new Set(
  "await break case catch class const continue debugger default delete do else export extends finally for from function get if import in instanceof let new of return set static super switch this throw try typeof var void while with yield async".split(" ")
);
const LITERALS = new Set(["true", "false", "null", "undefined", "NaN", "Infinity"]);
const NUMBER = /^(?:0[xX][\da-fA-F_]+n?|0[bB][01_]+n?|0[oO][0-7_]+n?|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d+)?n?)/;
const IDENT = /^[A-Za-z_$\u00c0-\uffff][\w$\u00c0-\uffff]*/;
const OPERATOR = /^(?:=>|\.\.\.|\?\?=|\?\?|\?\.|\*\*=|\*\*|===|!==|==|!=|<=|>=|&&=|\|\|=|&&|\|\||<<=|>>>=|>>=|<<|>>>|>>|\+\+|--|[-+*/%&|^]=|[-+*/%=<>!&|^~?:])/;
const REGEX = /^\/(?![*/])(?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^/\\\n[])+\/[dgimsuyv]*/;

/** @returns {{block: boolean, template: boolean}} */
function initialState() {
  return { block: false, template: false };
}

/**
 * @param {string} text
 * @param {{block: boolean, template: boolean}} state
 * @param {{json?: boolean}} [options]
 * @returns {{tokens: Array<[string|null, string]>, state: object}}
 */
export function tokenizeJs(text, state, { json = false } = {}) {
  const tokens = [];
  let block = state.block;
  let template = state.template;
  let i = 0;
  let lastSignificant = null; // type of the previous non-space token, for regex detection
  const push = (type, value) => {
    if (!value) return;
    tokens.push([type, value]);
    if (type !== null || value.trim()) lastSignificant = type ?? "ident";
  };

  if (block) {
    const end = text.indexOf("*/");
    if (end === -1) return { tokens: text ? [["com", text]] : [], state: { block: true, template: false } };
    push("com", text.slice(0, end + 2));
    i = end + 2;
    block = false;
  } else if (template) {
    const end = findTemplateEnd(text, 0);
    if (end === -1) return { tokens: text ? [["str", text]] : [], state: { block: false, template: true } };
    push("str", text.slice(0, end + 1));
    i = end + 1;
    template = false;
  }

  while (i < text.length) {
    const rest = text.slice(i);
    const ch = text[i];
    if (ch === " " || ch === "\t") {
      const match = /^[ \t]+/.exec(rest)[0];
      tokens.push([null, match]);
      i += match.length;
      continue;
    }
    if (rest.startsWith("//")) {
      push("com", rest);
      break;
    }
    if (rest.startsWith("/*")) {
      const end = rest.indexOf("*/", 2);
      if (end === -1) {
        push("com", rest);
        block = true;
        break;
      }
      push("com", rest.slice(0, end + 2));
      i += end + 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== ch) j += text[j] === "\\" ? 2 : 1;
      const value = text.slice(i, Math.min(j + 1, text.length));
      // In JSON, a string followed by ":" is a property name.
      const isKey = json && /^\s*:/.test(text.slice(j + 1));
      push(isKey ? "prop" : "str", value);
      i += value.length;
      continue;
    }
    if (ch === "`") {
      const end = findTemplateEnd(text, i + 1);
      if (end === -1) {
        push("str", rest);
        template = true;
        break;
      }
      push("str", text.slice(i, end + 1));
      i = end + 1;
      continue;
    }
    if (/[\d.]/.test(ch) && NUMBER.test(rest) && !(ch === "." && !/^\.\d/.test(rest))) {
      const value = NUMBER.exec(rest)[0];
      push("num", value);
      i += value.length;
      continue;
    }
    const ident = IDENT.exec(rest);
    if (ident) {
      const word = ident[0];
      const prevChar = text.slice(0, i).trimEnd().slice(-1);
      let type = null;
      if (prevChar === "." && !text.slice(0, i).trimEnd().endsWith("..")) type = "prop";
      else if (LITERALS.has(word)) type = "lit";
      else if (!json && KEYWORDS.has(word)) type = "kw";
      else if (/^\s*\(/.test(text.slice(i + word.length))) type = "fn";
      else if (/^[A-Z]/.test(word) && !json) type = "type";
      push(type, word);
      i += word.length;
      continue;
    }
    if (ch === "/" && !json) {
      const valueBefore = lastSignificant !== null && ["ident", "num", "str", "lit", "prop", "fn", "type"].includes(lastSignificant) && !/[(,=:[!&|?{};]\s*$/.test(text.slice(0, i));
      const closingBefore = /[)\]]\s*$/.test(text.slice(0, i));
      if (!valueBefore && !closingBefore) {
        const regex = REGEX.exec(rest);
        if (regex) {
          push("re", regex[0]);
          i += regex[0].length;
          continue;
        }
      }
    }
    const op = OPERATOR.exec(rest);
    if (op) {
      push("op", op[0]);
      i += op[0].length;
      continue;
    }
    push("punc", ch);
    i += 1;
  }
  return { tokens, state: { block, template } };
}

/**
 * @param {string} text
 * @param {number} from
 * @returns {number} Index of the closing backtick, or -1.
 */
function findTemplateEnd(text, from) {
  for (let j = from; j < text.length; j += 1) {
    if (text[j] === "\\") {
      j += 1;
      continue;
    }
    if (text[j] === "`") return j;
  }
  return -1;
}

registerLanguage({
  id: "javascript",
  name: "JavaScript",
  extensions: ["js", "mjs", "cjs", "jsx"],
  initialState,
  tokenize: (text, state) => tokenizeJs(text, state),
  comment: { line: "//", block: ["/*", "*/"] },
  indentAfter: /[{([]\s*$/,
});

registerLanguage({
  id: "json",
  name: "JSON",
  extensions: ["json", "webmanifest"],
  initialState,
  tokenize: (text, state) => tokenizeJs(text, state, { json: true }),
  comment: {},
  indentAfter: /[{[]\s*$/,
});
