/**
 * @file HTML highlighting for Code Studio, including embedded
 * `<style>` (CSS) and `<script>` (JavaScript) blocks, comments that
 * span lines, tags whose attributes span lines, and entities.
 */

import { registerLanguage } from "./registry.js";
import { tokenizeCss, cssInitialState } from "./css.js";
import { tokenizeJs } from "./javascript.js";

/**
 * mode: "text" | "comment" | "tag" (inside <...>, after the name) | "css" | "js"
 * @returns {object}
 */
function initialState() {
  return { mode: "text", tagName: "", quote: "", sub: null };
}

/**
 * @param {string} text
 * @param {object} state
 * @returns {{tokens: Array<[string|null, string]>, state: object}}
 */
function tokenizeHtml(text, state) {
  const tokens = [];
  let mode = state.mode;
  let tagName = state.tagName;
  let quote = state.quote;
  let sub = state.sub;
  let i = 0;
  const push = (type, part) => part && tokens.push([type, part]);

  while (i < text.length) {
    const rest = text.slice(i);

    if (mode === "comment") {
      const end = rest.indexOf("-->");
      if (end === -1) {
        push("com", rest);
        i = text.length;
        break;
      }
      push("com", rest.slice(0, end + 3));
      i += end + 3;
      mode = "text";
      continue;
    }

    if (mode === "css" || mode === "js") {
      const closer = mode === "css" ? /<\/style\s*>/i : /<\/script\s*>/i;
      const match = closer.exec(rest);
      const body = match ? rest.slice(0, match.index) : rest;
      if (body) {
        const result = mode === "css" ? tokenizeCss(body, sub) : tokenizeJs(body, sub);
        tokens.push(...result.tokens);
        sub = result.state;
      }
      if (!match) {
        i = text.length;
        break;
      }
      i += match.index;
      mode = "text";
      sub = null;
      continue;
    }

    if (mode === "tag") {
      if (quote) {
        const end = rest.indexOf(quote);
        if (end === -1) {
          push("str", rest);
          i = text.length;
          break;
        }
        push("str", rest.slice(0, end + 1));
        i += end + 1;
        quote = "";
        continue;
      }
      const ws = /^\s+/.exec(rest);
      if (ws) {
        push(null, ws[0]);
        i += ws[0].length;
        continue;
      }
      if (rest.startsWith("/>") || rest[0] === ">") {
        const close = rest.startsWith("/>") ? "/>" : ">";
        push("punc", close);
        i += close.length;
        const name = tagName.toLowerCase();
        mode = "text";
        tagName = "";
        if (close === ">" && (name === "style" || name === "script")) {
          mode = name === "style" ? "css" : "js";
          sub = name === "style" ? cssInitialState() : { block: false, template: false };
        }
        continue;
      }
      const attr = /^[^\s=>"'/]+/.exec(rest);
      if (attr) {
        push("attr", attr[0]);
        i += attr[0].length;
        continue;
      }
      if (rest[0] === "=") {
        push("op", "=");
        i += 1;
        continue;
      }
      if (rest[0] === '"' || rest[0] === "'") {
        const end = rest.indexOf(rest[0], 1);
        if (end === -1) {
          push("str", rest);
          quote = rest[0];
          i = text.length;
          break;
        }
        push("str", rest.slice(0, end + 1));
        i += end + 1;
        continue;
      }
      push("punc", rest[0]);
      i += 1;
      continue;
    }

    // mode === "text"
    if (rest.startsWith("<!--")) {
      mode = "comment";
      continue;
    }
    const doctype = /^<!doctype[^>]*>/i.exec(rest);
    if (doctype) {
      push("kw", doctype[0]);
      i += doctype[0].length;
      continue;
    }
    const open = /^(<\/?)([A-Za-z][\w:-]*)/.exec(rest);
    if (open) {
      push("punc", open[1]);
      push("tag", open[2]);
      i += open[0].length;
      if (open[1] === "</") {
        const end = /^\s*>/.exec(text.slice(i));
        if (end) {
          push("punc", end[0]);
          i += end[0].length;
        } else {
          mode = "tag";
          tagName = "";
        }
      } else {
        mode = "tag";
        tagName = open[2];
      }
      continue;
    }
    const entity = /^&(?:#\d+|#x[\da-fA-F]+|[A-Za-z][\w]*);/.exec(rest);
    if (entity) {
      push("ent", entity[0]);
      i += entity[0].length;
      continue;
    }
    const plain = /^[^<&]+/.exec(rest);
    if (plain) {
      push(null, plain[0]);
      i += plain[0].length;
      continue;
    }
    push(null, rest[0]);
    i += 1;
  }
  return { tokens, state: { mode, tagName, quote, sub } };
}

registerLanguage({
  id: "html",
  name: "HTML",
  extensions: ["html", "htm", "xhtml", "svg", "xml"],
  initialState,
  tokenize: tokenizeHtml,
  comment: { block: ["<!--", "-->"] },
  indentAfter: /<(?!\/|!|br\b|hr\b|img\b|input\b|meta\b|link\b|area\b|base\b|col\b|embed\b|source\b|track\b|wbr\b)[A-Za-z][^>]*(?<!\/)>\s*$/,
});

registerLanguage({
  id: "markdown",
  name: "Markdown",
  extensions: ["md", "markdown"],
  initialState: () => ({ fence: false }),
  tokenize: (text, state) => {
    if (/^\s*```/.test(text)) return { tokens: [["str", text]], state: { fence: !state.fence } };
    if (state.fence) return { tokens: text ? [["str", text]] : [], state };
    if (/^#{1,6}\s/.test(text)) return { tokens: [["head", text]], state };
    const tokens = [];
    const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*|__[^_]+__)|(\[[^\]]*\]\([^)]*\))|(^\s*(?:[-*+]|\d+\.)\s)|(^>\s?)/g;
    let last = 0;
    let match;
    while ((match = pattern.exec(text))) {
      if (match.index > last) tokens.push([null, text.slice(last, match.index)]);
      const type = match[1] ? "str" : match[2] ? "kw" : match[3] ? "link" : match[4] ? "punc" : "com";
      tokens.push([type, match[0]]);
      last = match.index + match[0].length;
      if (match[0].length === 0) pattern.lastIndex += 1;
    }
    if (last < text.length) tokens.push([null, text.slice(last)]);
    return { tokens, state };
  },
  comment: { block: ["<!--", "-->"] },
});
