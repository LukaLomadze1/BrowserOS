/**
 * @file CSS highlighting for Code Studio: selectors, at-rules,
 * properties, values, numbers with units, colors, strings, functions,
 * custom properties, comments (across lines), and !important.
 */

import { registerLanguage } from "./registry.js";

/** @returns {{block: boolean, depth: number, value: boolean}} */
export function cssInitialState() {
  return { block: false, depth: 0, value: false };
}

/**
 * @param {string} text
 * @param {{block: boolean, depth: number, value: boolean}} state
 * @returns {{tokens: Array<[string|null, string]>, state: object}}
 */
export function tokenizeCss(text, state) {
  const tokens = [];
  let { block, depth, value } = state;
  let i = 0;
  const push = (type, part) => part && tokens.push([type, part]);

  while (i < text.length) {
    const rest = text.slice(i);
    if (block) {
      const end = rest.indexOf("*/");
      if (end === -1) {
        push("com", rest);
        return { tokens, state: { block: true, depth, value } };
      }
      push("com", rest.slice(0, end + 2));
      i += end + 2;
      block = false;
      continue;
    }
    const ch = text[i];
    if (rest.startsWith("/*")) {
      block = true;
      continue;
    }
    if (ch === " " || ch === "\t") {
      const ws = /^[ \t]+/.exec(rest)[0];
      push(null, ws);
      i += ws.length;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== ch) j += text[j] === "\\" ? 2 : 1;
      const str = text.slice(i, Math.min(j + 1, text.length));
      push("str", str);
      i += str.length;
      continue;
    }
    if (ch === "{") {
      push("punc", ch);
      depth += 1;
      value = false;
      i += 1;
      continue;
    }
    if (ch === "}") {
      push("punc", ch);
      depth = Math.max(0, depth - 1);
      value = false;
      i += 1;
      continue;
    }
    if (ch === ";") {
      push("punc", ch);
      value = false;
      i += 1;
      continue;
    }
    if (ch === "@") {
      const at = /^@[\w-]+/.exec(rest);
      if (at) {
        push("at", at[0]);
        i += at[0].length;
        continue;
      }
    }
    if (value) {
      if (rest.startsWith("!important")) {
        push("kw", "!important");
        i += 10;
        continue;
      }
      const color = /^#[\da-fA-F]{3,8}\b/.exec(rest);
      if (color) {
        push("num", color[0]);
        i += color[0].length;
        continue;
      }
      const number = /^-?(?:\d+\.?\d*|\.\d+)(?:%|[a-zA-Z]+)?/.exec(rest);
      if (number && !/[\w-]/.test(text[i - 1] ?? "")) {
        push("num", number[0]);
        i += number[0].length;
        continue;
      }
      const custom = /^--[\w-]+/.exec(rest);
      if (custom) {
        push("var", custom[0]);
        i += custom[0].length;
        continue;
      }
      const word = /^-?[A-Za-z_][\w-]*/.exec(rest);
      if (word) {
        push(text[i + word[0].length] === "(" ? "fn" : "val", word[0]);
        i += word[0].length;
        continue;
      }
      push("punc", ch);
      i += 1;
      continue;
    }
    if (depth > 0) {
      // Inside a rule: "name:" starts a declaration; anything else is a nested selector.
      const decl = /^(--[\w-]+|-?[A-Za-z][\w-]*)(\s*)(:)(?!:)/.exec(rest);
      if (decl && !/^[\w-]+:[\w-]+\s*[{,]/.test(rest)) {
        push(decl[1].startsWith("--") ? "var" : "prop", decl[1]);
        push(null, decl[2]);
        push("punc", ":");
        i += decl[0].length;
        value = true;
        continue;
      }
    }
    const selector = /^[^{};"'/@\s]+/.exec(rest);
    if (selector) {
      push("sel", selector[0]);
      i += selector[0].length;
      continue;
    }
    push("punc", ch);
    i += 1;
  }
  return { tokens, state: { block, depth, value } };
}

registerLanguage({
  id: "css",
  name: "CSS",
  extensions: ["css"],
  initialState: cssInitialState,
  tokenize: tokenizeCss,
  comment: { block: ["/*", "*/"] },
  indentAfter: /\{\s*$/,
});
