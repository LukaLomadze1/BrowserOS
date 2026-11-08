/**
 * @file JSON checks for Code Studio.
 *
 * `JSON.parse` decides whether the text is valid; when it isn't, the
 * position and wording come from a small scanner for the JSON grammar
 * (RFC 8259), because browsers word JSON errors differently and don't
 * always report where the problem is.
 */

/**
 * @param {string} text
 * @returns {{line: number, column: number, severity: "error", message: string}|null}
 */
export function checkJson(text) {
  if (!text.trim()) return null;
  try {
    JSON.parse(text);
    return null;
  } catch {
    const found = locateJsonError(text);
    const offset = Math.min(found.offset, text.length);
    const before = text.slice(0, offset);
    const line = before.split("\n").length;
    const column = offset - before.lastIndexOf("\n");
    return { line, column, severity: "error", message: found.message };
  }
}

/**
 * Find the first JSON syntax error by scanning.
 * @param {string} text
 * @returns {{offset: number, message: string}}
 */
export function locateJsonError(text) {
  let i = 0;
  const fail = (message, at = i) => {
    const error = new Error(message);
    error.offset = at;
    throw error;
  };
  const describe = (at) => (at >= text.length ? "end of file" : `\u201c${text[at]}\u201d`);
  const space = () => {
    while (i < text.length && (text[i] === " " || text[i] === "\t" || text[i] === "\n" || text[i] === "\r")) i += 1;
  };
  const value = () => {
    space();
    const ch = text[i];
    if (ch === "{") return object();
    if (ch === "[") return array();
    if (ch === '"') return string();
    if (ch === "-" || (ch >= "0" && ch <= "9")) return number();
    for (const word of ["true", "false", "null"]) {
      if (text.startsWith(word, i)) {
        i += word.length;
        return undefined;
      }
    }
    return fail(`Unexpected ${describe(i)}: expected a value`);
  };
  const object = () => {
    i += 1;
    space();
    if (text[i] === "}") {
      i += 1;
      return;
    }
    for (;;) {
      space();
      if (text[i] !== '"') fail(`Unexpected ${describe(i)}: expected a property name in double quotes`);
      string();
      space();
      if (text[i] !== ":") fail(`Unexpected ${describe(i)}: expected \u201c:\u201d`);
      i += 1;
      value();
      space();
      if (text[i] === ",") {
        const comma = i;
        i += 1;
        space();
        if (text[i] === "}") fail("Trailing comma before \u201c}\u201d", comma);
        continue;
      }
      if (text[i] === "}") {
        i += 1;
        return;
      }
      fail(`Unexpected ${describe(i)}: expected \u201c,\u201d or \u201c}\u201d`);
    }
  };
  const array = () => {
    i += 1;
    space();
    if (text[i] === "]") {
      i += 1;
      return;
    }
    for (;;) {
      value();
      space();
      if (text[i] === ",") {
        const comma = i;
        i += 1;
        space();
        if (text[i] === "]") fail("Trailing comma before \u201c]\u201d", comma);
        continue;
      }
      if (text[i] === "]") {
        i += 1;
        return;
      }
      fail(`Unexpected ${describe(i)}: expected \u201c,\u201d or \u201c]\u201d`);
    }
  };
  const string = () => {
    const start = i;
    i += 1;
    while (i < text.length) {
      const ch = text[i];
      if (ch === '"') {
        i += 1;
        return;
      }
      if (ch === "\\") {
        const next = text[i + 1];
        if (next === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) fail("Invalid \\u escape in string");
          i += 6;
          continue;
        }
        if (next === undefined || !'"\\/bfnrt'.includes(next)) fail("Invalid escape in string");
        i += 2;
        continue;
      }
      if (ch === "\n") fail("String is never closed on this line", start);
      if (ch < " ") fail("Control character in string");
      i += 1;
    }
    fail("String is never closed", start);
  };
  const number = () => {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i));
    if (!match) fail("Invalid number");
    i += match[0].length;
  };
  try {
    value();
    space();
    if (i < text.length) fail(`Unexpected ${describe(i)} after the end of the JSON value`);
  } catch (error) {
    return { offset: error.offset ?? i, message: error.message };
  }
  return { offset: 0, message: "Invalid JSON" };
}
