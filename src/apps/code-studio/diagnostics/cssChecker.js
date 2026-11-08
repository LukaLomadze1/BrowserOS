/**
 * @file CSS checks for Code Studio.
 *
 * Errors (the stylesheet is malformed): unclosed comments, strings,
 * and blocks; a `}` without a matching `{`; a declaration without a
 * colon.
 *
 * Warnings (the browser will ignore the declaration): a property this
 * browser doesn't know, or a value it rejects for that property. Both
 * are answered by the browser itself through `CSS.supports()`, so they
 * describe exactly what the preview will do. Vendor-prefixed
 * properties, custom properties, values using var()/env()/attr(), and
 * descriptor blocks such as @font-face are not judged.
 */

/** At-rules whose blocks contain style rules. */
const GROUP_AT_RULES = new Set(["media", "supports", "container", "layer", "scope", "document", "starting-style"]);

/**
 * @typedef {{line: number, column: number, severity: "error"|"warning", message: string}} CssProblem
 */

/**
 * @param {string} text
 * @param {{lineOffset?: number, inlineDeclarations?: boolean}} [options] - lineOffset shifts reported lines (for <style> blocks); inlineDeclarations treats the text as a declaration list (style="").
 * @returns {CssProblem[]}
 */
export function checkCss(text, { lineOffset = 0, inlineDeclarations = false } = {}) {
  const problems = [];
  const supports = typeof CSS !== "undefined" && typeof CSS.supports === "function";
  /** @type {Array<{kind: "rule"|"group"|"descriptor"|"keyframes", line: number, column: number}>} */
  const stack = inlineDeclarations ? [{ kind: "rule", line: 1, column: 1 }] : [];
  let segment = "";
  let segmentStart = null;
  let line = 1;
  let column = 1;
  let i = 0;
  let parens = 0; // inside url(), calc(), etc. \u2014 ; { } belong to the value

  const report = (severity, message, atLine, atColumn) => {
    problems.push({ line: atLine + lineOffset, column: atColumn, severity, message });
  };
  const markSegmentStart = () => {
    if (segmentStart === null) segmentStart = { line, column };
  };
  const advance = (ch) => {
    if (ch === "\n") {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  };

  const flushDeclaration = () => {
    const raw = segment;
    const start = segmentStart;
    segment = "";
    segmentStart = null;
    const trimmed = raw.trim();
    if (!trimmed || !start) return;
    const top = stack[stack.length - 1];
    if (!top) {
      if (trimmed.startsWith("@")) return; // @import, @charset, @layer a, b;
      report("error", `Unexpected \u201c${truncate(trimmed)}\u201d outside of a rule`, start.line, start.column);
      return;
    }
    if (top.kind === "group" || top.kind === "keyframes") {
      if (trimmed.startsWith("@")) return;
      report("error", `Unexpected \u201c${truncate(trimmed)}\u201d \u2014 expected a selector followed by {`, start.line, start.column);
      return;
    }
    if (trimmed.startsWith("@")) return; // nested at-rule statements such as @apply or @include
    const colon = trimmed.indexOf(":");
    if (colon === -1) {
      report("error", `Expected \u201c:\u201d in declaration \u201c${truncate(trimmed)}\u201d`, start.line, start.column);
      return;
    }
    if (top.kind !== "rule" || !supports || stack.some((entry) => entry.kind === "descriptor")) return;
    const property = trimmed.slice(0, colon).trim();
    let value = trimmed.slice(colon + 1).trim();
    if (!property) {
      report("error", "Declaration is missing a property name", start.line, start.column);
      return;
    }
    if (property.startsWith("--") || property.startsWith("-")) return;
    if (!/^[a-zA-Z][\w-]*$/.test(property)) {
      report("error", `\u201c${truncate(property)}\u201d is not a valid property name`, start.line, start.column);
      return;
    }
    if (!value) {
      report("error", `\u201c${property}\u201d has no value`, start.line, start.column);
      return;
    }
    if (!CSS.supports(property, "initial")) {
      report("warning", `Unknown property \u201c${property}\u201d`, start.line, start.column);
      return;
    }
    value = value.replace(/\s*!\s*important\s*$/i, "");
    if (/\b(?:var|env|attr)\s*\(/i.test(value)) return;
    if (!CSS.supports(property, value)) {
      report("warning", `Invalid value for \u201c${property}\u201d: ${truncate(value)}`, start.line, start.column);
    }
  };

  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];

    if (ch === "/" && next === "*") {
      const startLine = line;
      const startColumn = column;
      const end = text.indexOf("*/", i + 2);
      if (end === -1) {
        report("error", "Comment is never closed (missing */)", startLine, startColumn);
        break;
      }
      for (let j = i; j < end + 2; j += 1) advance(text[j]);
      i = end + 2;
      continue;
    }

    if (ch === '"' || ch === "'") {
      markSegmentStart();
      const startLine = line;
      const startColumn = column;
      let j = i + 1;
      let closed = false;
      segment += ch;
      advance(ch);
      while (j < text.length) {
        const c = text[j];
        if (c === "\\" && j + 1 < text.length) {
          segment += c + text[j + 1];
          advance(c);
          advance(text[j + 1]);
          j += 2;
          continue;
        }
        if (c === "\n") break;
        segment += c;
        advance(c);
        j += 1;
        if (c === ch) {
          closed = true;
          break;
        }
      }
      if (!closed) report("error", "String is never closed", startLine, startColumn);
      i = j;
      continue;
    }

    if (ch === "(" || (parens > 0 && ch === ")") || parens > 0) {
      if (ch === "(") parens += 1;
      else if (ch === ")") parens -= 1;
      markSegmentStart();
      segment += ch;
      advance(ch);
      i += 1;
      continue;
    }

    if (ch === ")") {
      report("error", "Unexpected \u201c)\u201d", line, column);
      markSegmentStart();
      segment += ch;
      advance(ch);
      i += 1;
      continue;
    }

    if (ch === "{") {
      const header = segment.trim();
      const start = segmentStart ?? { line, column };
      segment = "";
      segmentStart = null;
      let kind = "rule";
      if (header.startsWith("@")) {
        const name = /^@([\w-]+)/.exec(header)?.[1]?.toLowerCase() ?? "";
        const bare = name.replace(/^-\w+-/, "");
        if (GROUP_AT_RULES.has(bare)) kind = "group";
        else if (bare === "keyframes") kind = "keyframes";
        else kind = "descriptor";
      } else if (!header && !inlineDeclarations) {
        report("error", "Block has no selector", start.line, start.column);
      }
      stack.push({ kind, line: start.line, column: start.column });
      advance(ch);
      i += 1;
      continue;
    }

    if (ch === "}") {
      if (stack.length === 0 || (inlineDeclarations && stack.length === 1)) {
        report("error", "Unexpected \u201c}\u201d with no matching \u201c{\u201d", line, column);
        segment = "";
        segmentStart = null;
      } else {
        flushDeclaration();
        stack.pop();
      }
      advance(ch);
      i += 1;
      continue;
    }

    if (ch === ";") {
      flushDeclaration();
      advance(ch);
      i += 1;
      continue;
    }

    if (!/\s/.test(ch)) markSegmentStart();
    segment += ch;
    advance(ch);
    i += 1;
  }

  if (segment.trim()) {
    const top = stack[stack.length - 1];
    if (top && top.kind === "rule") flushDeclaration();
    else if (!top && segmentStart && !segment.trim().startsWith("@")) {
      report("error", `Unexpected \u201c${truncate(segment.trim())}\u201d at the end of the stylesheet`, segmentStart.line, segmentStart.column);
    }
  }
  if (parens > 0) {
    report("error", "Missing \u201c)\u201d \u2014 a parenthesis is never closed", segmentStart?.line ?? line, segmentStart?.column ?? column);
  }
  const unclosed = inlineDeclarations ? stack.slice(1) : stack;
  for (const open of unclosed) {
    report("error", "Block is never closed (missing \u201c}\u201d)", open.line, open.column);
  }
  return problems;
}

/**
 * @param {string} text
 * @returns {string}
 */
function truncate(text) {
  const single = text.replace(/\s+/g, " ");
  return single.length > 40 ? `${single.slice(0, 39)}\u2026` : single;
}
