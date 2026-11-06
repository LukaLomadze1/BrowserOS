/**
 * @file Note document formats and HTML sanitizing.
 *
 * Two document kinds share one editor:
 *  - "rich"  — `.note` files: JSON `{ format, version, html }`, edited
 *              with formatting (headings, lists, checklists, links, …).
 *  - "plain" — `.txt` and `.md` files: plain text, saved byte-for-byte
 *              as typed (Markdown is edited as text, not rendered).
 *
 * Rich content is always passed through `sanitizeHtml()` before it is
 * placed in the editor and before it is saved. Parsing uses DOMParser,
 * which never executes scripts, and the output is rebuilt from an
 * allowlist of elements and attributes, so a crafted .note file cannot
 * inject script, event handlers, styles, or `javascript:` links.
 */

export const NOTE_FORMAT_ID = "browseros-note";
export const NOTE_FORMAT_VERSION = 1;

/** Extensions handled as rich documents. */
const RICH_EXTENSIONS = new Set(["note"]);
/** Extensions Notes can open. */
export const NOTE_EXTENSIONS = Object.freeze(["note", "txt", "md"]);

/** Allowed elements, with the attributes each may keep. */
const ALLOWED = Object.freeze({
  P: [],
  DIV: [],
  BR: [],
  B: [],
  STRONG: [],
  I: [],
  EM: [],
  U: [],
  S: [],
  STRIKE: [],
  DEL: [],
  H1: [],
  H2: [],
  H3: [],
  UL: ["data-checklist"],
  OL: [],
  LI: ["data-checked"],
  A: ["href"],
  BLOCKQUOTE: [],
  CODE: [],
  PRE: [],
});

/** Elements removed together with their content. */
const DROPPED = new Set(["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "TEMPLATE", "NOSCRIPT", "SVG", "MATH", "LINK", "META", "TITLE", "HEAD", "FORM", "INPUT", "BUTTON", "SELECT", "TEXTAREA", "IMG", "VIDEO", "AUDIO", "CANVAS"]);

const SAFE_LINK = /^(https?:|mailto:)/i;

/**
 * @param {string|null} extension
 * @returns {"rich"|"plain"}
 */
export function documentKind(extension) {
  return RICH_EXTENSIONS.has((extension ?? "").toLowerCase()) ? "rich" : "plain";
}

/**
 * @param {string} name - File name.
 * @returns {boolean} Whether Notes can open this file.
 */
export function isNoteFile(name) {
  const dot = name.lastIndexOf(".");
  return dot > 0 && NOTE_EXTENSIONS.includes(name.slice(dot + 1).toLowerCase());
}

/**
 * Parse stored `.note` text. Tolerates legacy or hand-written content:
 * anything that isn't a valid note document is treated as plain text.
 * @param {string} raw
 * @returns {{html: string, recovered: boolean}} `recovered` is true when the file wasn't a valid note document.
 */
export function parseNoteDocument(raw) {
  if (!raw || !raw.trim()) return { html: "", recovered: false };
  try {
    const parsed = JSON.parse(raw);
    if (parsed && parsed.format === NOTE_FORMAT_ID && typeof parsed.html === "string") {
      return { html: sanitizeHtml(parsed.html), recovered: false };
    }
  } catch {
    // Not JSON: fall through and keep the text.
  }
  return { html: plainTextToHtml(raw), recovered: true };
}

/**
 * @param {string} html - Editor HTML.
 * @returns {string} Serialized `.note` document.
 */
export function serializeNoteDocument(html) {
  return JSON.stringify({ format: NOTE_FORMAT_ID, version: NOTE_FORMAT_VERSION, html: sanitizeHtml(html) });
}

/**
 * Rebuild HTML keeping only allowlisted elements and attributes.
 * Unknown elements are unwrapped (their text is kept); dangerous ones
 * are dropped entirely.
 * @param {string} html
 * @returns {string}
 */
export function sanitizeHtml(html) {
  const source = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html").body;
  const output = document.createElement("div");
  copyChildren(source, output);
  return output.innerHTML;
}

/**
 * @param {Node} from
 * @param {Node} to
 * @returns {void}
 */
function copyChildren(from, to) {
  for (const node of from.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      to.append(document.createTextNode(node.textContent));
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;

    const tag = node.tagName;
    if (DROPPED.has(tag)) continue;
    const allowedAttributes = ALLOWED[tag];
    if (!allowedAttributes) {
      copyChildren(node, to); // Unwrap unknown elements.
      continue;
    }

    const clean = document.createElement(tag.toLowerCase());
    for (const name of allowedAttributes) {
      const value = node.getAttribute(name);
      if (value === null) continue;
      if (name === "href") {
        if (SAFE_LINK.test(value.trim())) clean.setAttribute("href", value.trim());
      } else if (name === "data-checklist") {
        if (value === "true") clean.setAttribute(name, "true");
      } else if (name === "data-checked") {
        clean.setAttribute(name, value === "true" ? "true" : "false");
      }
    }
    copyChildren(node, clean);
    to.append(clean);
  }
}

/**
 * @param {string} text
 * @returns {string} Paragraph HTML for plain text (escaped).
 */
export function plainTextToHtml(text) {
  const container = document.createElement("div");
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    const paragraph = document.createElement("p");
    if (line) {
      paragraph.textContent = line;
    } else {
      paragraph.append(document.createElement("br"));
    }
    container.append(paragraph);
  }
  return container.innerHTML;
}

/**
 * Extract readable text from rich HTML (for search, snippets, counts).
 * Block elements become line breaks.
 * @param {string} html
 * @returns {string}
 */
export function htmlToPlainText(html) {
  const body = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html").body;
  const lines = [];
  let current = "";
  const BLOCKS = new Set(["P", "DIV", "H1", "H2", "H3", "LI", "BLOCKQUOTE", "PRE", "UL", "OL"]);
  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        current += child.textContent;
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        if (child.tagName === "BR") {
          lines.push(current);
          current = "";
          continue;
        }
        const block = BLOCKS.has(child.tagName);
        if (block && current) {
          lines.push(current);
          current = "";
        }
        walk(child);
        if (block && current) {
          lines.push(current);
          current = "";
        }
      }
    }
  };
  walk(body);
  if (current) lines.push(current);
  return lines.join("\n");
}

/**
 * @param {string} text
 * @returns {{words: number, characters: number}}
 */
export function countText(text) {
  const trimmed = text.trim();
  return {
    words: trimmed ? trimmed.split(/\s+/u).length : 0,
    characters: text.replace(/\n/g, "").length,
  };
}
