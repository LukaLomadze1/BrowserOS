/**
 * @file HTML structure checks for Code Studio.
 *
 * Reported problems:
 *   errors   — a comment or tag that is never closed, a closing tag
 *              with no matching opening tag;
 *   warnings — an element that is never closed (where HTML doesn't
 *              allow the end tag to be omitted), elements closed out of
 *              order, duplicate attributes, duplicate ids, and local
 *              files referenced by src/href that don't exist.
 *
 * Inline <script> and <style> blocks are returned separately so their
 * contents can be checked with the JavaScript and CSS checkers.
 */

const VOID_ELEMENTS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
/** Elements whose end tag may be omitted (closed implicitly by a sibling or parent). */
const OPTIONAL_END = new Set(["html", "head", "body", "p", "li", "dt", "dd", "option", "optgroup", "tr", "td", "th", "thead", "tbody", "tfoot", "colgroup", "caption", "rt", "rp"]);
const RAW_TEXT = new Set(["script", "style", "textarea", "title"]);

/**
 * @typedef {{line: number, column: number, severity: "error"|"warning"|"info", message: string}} HtmlProblem
 * @typedef {{kind: "script"|"style", text: string, line: number, column: number, module: boolean, src: string|null}} EmbeddedBlock
 * @typedef {{attribute: string, value: string, line: number, column: number, tag: string}} Reference
 */

/**
 * @param {string} text
 * @returns {{problems: HtmlProblem[], blocks: EmbeddedBlock[], references: Reference[]}}
 */
export function checkHtml(text) {
  const problems = [];
  const blocks = [];
  const references = [];
  /** @type {Array<{name: string, line: number, column: number}>} */
  const stack = [];
  const ids = new Map();
  const lineStarts = [0];
  for (let i = 0; i < text.length; i += 1) if (text[i] === "\n") lineStarts.push(i + 1);
  const locate = (offset) => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (lineStarts[mid] <= offset) low = mid;
      else high = mid - 1;
    }
    return { line: low + 1, column: offset - lineStarts[low] + 1 };
  };
  const report = (severity, message, offset) => problems.push({ ...locate(offset), severity, message });

  let i = 0;
  while (i < text.length) {
    const lt = text.indexOf("<", i);
    if (lt === -1) break;
    i = lt;
    if (text.startsWith("<!--", i)) {
      const end = text.indexOf("-->", i + 4);
      if (end === -1) {
        report("error", "Comment is never closed (missing -->)", i);
        break;
      }
      i = end + 3;
      continue;
    }
    if (text.startsWith("<!", i) || text.startsWith("<?", i)) {
      const end = text.indexOf(">", i);
      i = end === -1 ? text.length : end + 1;
      continue;
    }
    const closing = text[i + 1] === "/";
    const nameMatch = /^[A-Za-z][\w:-]*/.exec(text.slice(i + (closing ? 2 : 1), i + (closing ? 2 : 1) + 64));
    if (!nameMatch) {
      i += 1;
      continue;
    }
    const name = nameMatch[0].toLowerCase();
    const tagStart = i;
    // Find the end of the tag, honoring quoted attribute values.
    let j = i + (closing ? 2 : 1) + nameMatch[0].length;
    let quote = "";
    let tagEnd = -1;
    for (; j < text.length; j += 1) {
      const c = text[j];
      if (quote) {
        if (c === quote) quote = "";
        continue;
      }
      if (c === '"' || c === "'") quote = c;
      else if (c === ">") {
        tagEnd = j;
        break;
      } else if (c === "<" && !closing) {
        break;
      }
    }
    if (tagEnd === -1) {
      report("error", `<${closing ? "/" : ""}${name}> tag is never closed (missing >)`, tagStart);
      i = j;
      continue;
    }
    const inner = text.slice(i + (closing ? 2 : 1) + nameMatch[0].length, tagEnd);
    i = tagEnd + 1;

    if (closing) {
      if (VOID_ELEMENTS.has(name)) {
        report("warning", `</${name}> is not needed: <${name}> has no closing tag`, tagStart);
        continue;
      }
      let index = stack.length - 1;
      while (index >= 0 && stack[index].name !== name) index -= 1;
      if (index === -1) {
        if (!OPTIONAL_END.has(name)) report("error", `Unexpected closing tag </${name}> with no matching <${name}>`, tagStart);
        continue;
      }
      for (let k = stack.length - 1; k > index; k -= 1) {
        const open = stack[k];
        if (!OPTIONAL_END.has(open.name)) {
          problems.push({ line: open.line, column: open.column, severity: "warning", message: `<${open.name}> is not closed before </${name}>` });
        }
      }
      stack.length = index;
      continue;
    }

    // Opening tag: attributes.
    const attributes = parseAttributes(inner);
    const seen = new Set();
    for (const attribute of attributes) {
      const key = attribute.name.toLowerCase();
      const offset = tagStart + 1 + nameMatch[0].length + attribute.index;
      if (seen.has(key)) report("warning", `Duplicate attribute \u201c${key}\u201d on <${name}>`, offset);
      seen.add(key);
      if (key === "id" && attribute.value) {
        if (ids.has(attribute.value)) report("warning", `Duplicate id \u201c${attribute.value}\u201d (first used on line ${ids.get(attribute.value)})`, offset);
        else ids.set(attribute.value, locate(offset).line);
      }
      if ((key === "src" || (key === "href" && (name === "link" || name === "a" || name === "area")) || key === "poster" || (key === "data" && name === "object")) && attribute.value) {
        references.push({ attribute: key, value: attribute.value, tag: name, ...locate(offset) });
      }
    }
    const selfClosing = /\/\s*$/.test(inner);
    if (name === "script" || name === "style") {
      const closeRe = name === "script" ? /<\/script\s*>/gi : /<\/style\s*>/gi;
      closeRe.lastIndex = i;
      const close = closeRe.exec(text);
      const bodyEnd = close ? close.index : text.length;
      if (!close) report("error", `<${name}> is never closed (missing </${name}>)`, tagStart);
      const attrs = Object.fromEntries(attributes.map((a) => [a.name.toLowerCase(), a.value]));
      const type = (attrs.type ?? "").toLowerCase();
      const isJs = name === "script" && (!type || type === "module" || /javascript|ecmascript/.test(type));
      if (name === "style" || isJs) {
        const position = locate(i);
        blocks.push({
          kind: name,
          text: text.slice(i, bodyEnd),
          line: position.line,
          column: position.column,
          module: type === "module",
          src: name === "script" ? attrs.src ?? null : null,
        });
      }
      i = close ? close.index + close[0].length : text.length;
      continue;
    }
    if (RAW_TEXT.has(name)) {
      const closeRe = new RegExp(`</${name}\\s*>`, "gi");
      closeRe.lastIndex = i;
      const close = closeRe.exec(text);
      if (!close) report("error", `<${name}> is never closed (missing </${name}>)`, tagStart);
      i = close ? close.index + close[0].length : text.length;
      continue;
    }
    if (VOID_ELEMENTS.has(name) || selfClosing) continue;
    // Implicitly close optional-end siblings (a new <li> closes the previous <li>, etc.).
    const top = stack[stack.length - 1];
    if (top && OPTIONAL_END.has(top.name) && closesImplicitly(top.name, name)) stack.pop();
    stack.push({ name, ...locate(tagStart) });
  }

  for (const open of stack) {
    if (!OPTIONAL_END.has(open.name)) {
      problems.push({ line: open.line, column: open.column, severity: "warning", message: `<${open.name}> is never closed` });
    }
  }
  return { problems, blocks, references };
}

/**
 * @param {string} open - Element that may end implicitly.
 * @param {string} next - Element being opened.
 * @returns {boolean}
 */
function closesImplicitly(open, next) {
  if (open === "p") return /^(address|article|aside|blockquote|div|dl|fieldset|footer|form|h[1-6]|header|hr|main|nav|ol|p|pre|section|table|ul|figure|figcaption|details|menu)$/.test(next);
  if (open === "li") return next === "li";
  if (open === "dt" || open === "dd") return next === "dt" || next === "dd";
  if (open === "option") return next === "option" || next === "optgroup";
  if (open === "tr") return next === "tr" || next === "tbody" || next === "tfoot";
  if (open === "td" || open === "th") return next === "td" || next === "th" || next === "tr";
  if (open === "thead" || open === "tbody") return next === "tbody" || next === "tfoot";
  return false;
}

/**
 * @param {string} source - Text between the tag name and ">".
 * @returns {Array<{name: string, value: string, index: number}>}
 */
export function parseAttributes(source) {
  const attributes = [];
  const pattern = /([^\s"'=<>/`]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match;
  while ((match = pattern.exec(source))) {
    attributes.push({ name: match[1], value: match[2] ?? match[3] ?? match[4] ?? "", index: match.index });
  }
  return attributes;
}
