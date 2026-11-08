/**
 * @file Builds the self-contained document shown by the live preview.
 *
 * A project page refers to its stylesheets, scripts, images, fonts, and
 * other pages by relative paths. The preview frame has no file system
 * (it is sandboxed with an opaque origin and loaded from `srcdoc`), so
 * the builder reads every referenced project file through the provided
 * readers — which return the editor's unsaved text when there is any —
 * and rewrites each reference in place:
 *
 *   <link rel="stylesheet" href>     data: URL of the CSS (its url() and @import rewritten too)
 *   <script src>                     data: URL of the script
 *   <script type="module">, imports  every local import/export-from/import() becomes a
 *                                    key in an import map whose values are data: URLs,
 *                                    so module graphs (cycles included) resolve
 *   src, poster, srcset, <link href> data: URL of the file (images, media, fonts, icons)
 *   style="…url()…", <style>         url() and @import rewritten
 *   <a href="page.html">             marked so the preview can open that project page
 *
 * Rewriting only replaces attribute values and string literals, never
 * adds or removes line breaks, so line numbers in the preview are the
 * line numbers in the editor. Script data: URLs carry the file's path
 * as a MIME parameter (`x-path=`), which lets runtime errors be traced
 * back to the right file and line.
 */

import { createBridgeScript } from "./previewBridge.js";
import { dirname, extname, isExternalReference, resolveProjectPath } from "../project/paths.js";
import { parseAttributes } from "../diagnostics/htmlChecker.js";

const MODULE_KEY_ORIGIN = "https://project.code-studio.invalid";
const MAX_CSS_IMPORT_DEPTH = 8;

const TEXT_TYPES = Object.freeze({
  css: "text/css",
  js: "text/javascript",
  mjs: "text/javascript",
  cjs: "text/javascript",
  json: "application/json",
  html: "text/html",
  htm: "text/html",
  svg: "image/svg+xml",
  txt: "text/plain",
  md: "text/markdown",
  xml: "application/xml",
  csv: "text/csv",
});

/**
 * @typedef {object} PreviewReaders
 * @property {(path: string) => Promise<string|null>} readText - Text of a project file (unsaved edits included), or null when missing or binary.
 * @property {(path: string) => Promise<Blob|null>} readBlob - Any file as a Blob, or null when missing.
 */

/**
 * @typedef {object} PreviewBuild
 * @property {string} html - The srcdoc document.
 * @property {string} token - Identifies messages from this build's bridge.
 * @property {string[]} files - Project files the page uses (rebuild when they change).
 * @property {Array<{path: string, message: string}>} warnings
 */

/**
 * @param {object} input
 * @param {string} input.entryPath - The HTML file to show.
 * @param {string} input.projectRoot - Root for "/"-relative references.
 * @param {PreviewReaders} input.readers
 * @param {[number, number]} [input.scroll] - Scroll position to restore after loading.
 * @returns {Promise<PreviewBuild>}
 */
export async function buildPreview({ entryPath, projectRoot, readers, scroll = [0, 0] }) {
  const context = new BuildContext(projectRoot, readers);
  const token = createToken();
  const source = await readers.readText(entryPath);
  if (source === null) throw new Error(`${entryPath} could not be read`);
  context.files.add(entryPath);

  let html = await rewriteHtml(source, entryPath, context);

  // Import map: must precede every module script.
  const imports = await context.finishModules();
  const importMap = Object.keys(imports).length
    ? `<script type="importmap">${JSON.stringify({ imports }).replace(/</g, "\\u003c")}</script>`
    : "";

  const insertAt = findHeadInsertionPoint(html);
  const before = html.slice(0, insertAt);
  const bridgeLine = before.split("\n").length;
  const lineStartColumn = insertAt - before.lastIndexOf("\n");
  // A srcdoc document resolves relative URLs against BrowserOS's own
  // address. Every project reference has been rewritten above; the base
  // makes anything left over (a missing file, fetch("data.json"))
  // fail inside the frame instead of requesting BrowserOS's server,
  // while "#section" links keep working.
  const base = '<base href="about:srcdoc">';
  const provisional = createBridgeScript({ token, entryPath, scroll, bridgeLine, bridgeEnd: 0 });
  const bridgeEnd = lineStartColumn + base.length + provisional.length + importMap.length + 16;
  const bridge = createBridgeScript({ token, entryPath, scroll, bridgeLine, bridgeEnd });
  html = `${before}${base}${bridge}${importMap}${html.slice(insertAt)}`;

  return { html, token, files: [...context.files], warnings: context.warnings };
}

/**
 * Tracks the files used by a build and the module graph.
 */
class BuildContext {
  /**
   * @param {string} projectRoot
   * @param {PreviewReaders} readers
   */
  constructor(projectRoot, readers) {
    this.projectRoot = projectRoot;
    this.readers = readers;
    /** @type {Set<string>} */
    this.files = new Set();
    /** @type {Array<{path: string, message: string}>} */
    this.warnings = [];
    /** @type {Map<string, Promise<string|null>>} path -> data URL */
    this._dataUrls = new Map();
    /** @type {Map<string, Promise<void>>} module path -> processing */
    this._modules = new Map();
    /** @type {Record<string, string>} */
    this._importMap = {};
  }

  /**
   * @param {string} path
   * @param {string} message
   * @returns {void}
   */
  warn(path, message) {
    if (!this.warnings.some((w) => w.path === path && w.message === message)) this.warnings.push({ path, message });
  }

  /**
   * Resolve a reference made from `fromPath`.
   * @param {string} reference
   * @param {string} fromPath
   * @returns {string|null}
   */
  resolve(reference, fromPath) {
    return resolveProjectPath(reference, dirname(fromPath), this.projectRoot);
  }

  /**
   * data: URL for any project file (CSS has its own references rewritten).
   * @param {string} path
   * @param {string} referencedFrom
   * @param {number} [cssDepth]
   * @returns {Promise<string|null>}
   */
  dataUrlFor(path, referencedFrom, cssDepth = 0) {
    if (!this._dataUrls.has(path)) {
      this._dataUrls.set(path, this._createDataUrl(path, referencedFrom, cssDepth));
    }
    return this._dataUrls.get(path);
  }

  /**
   * @param {string} path
   * @param {string} referencedFrom
   * @param {number} cssDepth
   * @returns {Promise<string|null>}
   */
  async _createDataUrl(path, referencedFrom, cssDepth) {
    const extension = extname(path);
    this.files.add(path);
    if (extension === "css") {
      const css = await this.readers.readText(path);
      if (css === null) return this._missing(path, referencedFrom);
      const rewritten = cssDepth >= MAX_CSS_IMPORT_DEPTH ? css : await rewriteCss(css, path, this, cssDepth + 1);
      return textDataUrl(rewritten, "text/css", path);
    }
    if (extension === "js" || extension === "mjs" || extension === "cjs") {
      const js = await this.readers.readText(path);
      if (js === null) return this._missing(path, referencedFrom);
      return textDataUrl(js, "text/javascript", path);
    }
    if (TEXT_TYPES[extension]) {
      const text = await this.readers.readText(path);
      if (text === null) return this._missing(path, referencedFrom);
      return textDataUrl(text, TEXT_TYPES[extension], null);
    }
    const blob = await this.readers.readBlob(path);
    if (!blob) return this._missing(path, referencedFrom);
    return blobToDataUrl(blob);
  }

  /**
   * @param {string} path
   * @param {string} referencedFrom
   * @returns {null}
   */
  _missing(path, referencedFrom) {
    this.warn(referencedFrom, `Not found: ${path}`);
    return null;
  }

  /**
   * Import-map key for a module file, processing the module (and its imports) once.
   * @param {string} path
   * @param {string} referencedFrom
   * @returns {string}
   */
  moduleKey(path, referencedFrom) {
    const key = `${MODULE_KEY_ORIGIN}${encodeURI(path)}`;
    if (!this._modules.has(path)) {
      this._modules.set(path, this._processModule(path, key, referencedFrom));
    }
    return key;
  }

  /**
   * @param {string} path
   * @param {string} key
   * @param {string} referencedFrom
   * @returns {Promise<void>}
   */
  async _processModule(path, key, referencedFrom) {
    this.files.add(path);
    const source = await this.readers.readText(path);
    if (source === null) {
      this._missing(path, referencedFrom);
      return;
    }
    const rewritten = await rewriteModuleSpecifiers(source, path, this);
    this._importMap[key] = textDataUrl(rewritten, "text/javascript", path);
  }

  /**
   * Wait for the whole module graph and return the import map entries.
   * @returns {Promise<Record<string, string>>}
   */
  async finishModules() {
    let pending = -1;
    // Processing a module can discover more modules; loop until stable.
    while (pending !== this._modules.size) {
      pending = this._modules.size;
      await Promise.all(this._modules.values());
    }
    return { ...this._importMap };
  }
}

// -----------------------------------------------------------------
// HTML
// -----------------------------------------------------------------

/**
 * @param {string} html
 * @param {string} path
 * @param {BuildContext} context
 * @returns {Promise<string>}
 */
async function rewriteHtml(html, path, context) {
  /** @type {Array<{start: number, end: number, text: Promise<string|null>|string}>} */
  const edits = [];
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) break;
    i = lt;
    if (html.startsWith("<!--", i)) {
      const end = html.indexOf("-->", i + 4);
      i = end === -1 ? html.length : end + 3;
      continue;
    }
    const match = /^<([A-Za-z][\w:-]*)/.exec(html.slice(i, i + 64));
    if (!match) {
      i += 1;
      continue;
    }
    const name = match[1].toLowerCase();
    const tagEnd = findTagEnd(html, i + match[0].length);
    if (tagEnd === -1) break;
    const attrSource = html.slice(i + match[0].length, tagEnd);
    const attrOffset = i + match[0].length;
    const attributes = parseAttributesWithRanges(attrSource, attrOffset);
    const get = (attrName) => attributes.find((a) => a.name === attrName);
    i = tagEnd + 1;

    const rewriteValue = (attribute, producer) => {
      if (!attribute || attribute.valueStart === -1) return;
      edits.push({ start: attribute.valueStart, end: attribute.valueEnd, text: producer(attribute.value) });
    };
    const localUrl = async (value) => {
      if (isExternalReference(value)) return null;
      const target = context.resolve(value, path);
      if (!target) return null;
      const url = await context.dataUrlFor(target, path);
      return url ? escapeAttribute(url) : null;
    };

    if (name === "script") {
      const type = (get("type")?.value ?? "").trim().toLowerCase();
      const isModule = type === "module";
      const isJs = !type || isModule || /javascript|ecmascript/.test(type);
      const src = get("src");
      const close = /<\/script\s*>/gi;
      close.lastIndex = i;
      const closeMatch = close.exec(html);
      const bodyEnd = closeMatch ? closeMatch.index : html.length;
      if (isJs && src && src.value && !isExternalReference(src.value)) {
        const target = context.resolve(src.value, path);
        if (target) {
          if (isModule) {
            const key = context.moduleKey(target, path);
            rewriteValue(src, () => moduleDataUrlLater(context, key, target));
          } else {
            rewriteValue(src, () => context.dataUrlFor(target, path).then((url) => (url ? escapeAttribute(url) : null)));
          }
        }
      } else if (isModule && !src) {
        const body = html.slice(i, bodyEnd);
        edits.push({ start: i, end: bodyEnd, text: rewriteModuleSpecifiers(body, path, context).then((text) => text.replace(/<\/script/gi, "<\\/script")) });
      }
      i = closeMatch ? closeMatch.index + closeMatch[0].length : html.length;
      continue;
    }

    if (name === "style") {
      const close = /<\/style\s*>/gi;
      close.lastIndex = i;
      const closeMatch = close.exec(html);
      const bodyEnd = closeMatch ? closeMatch.index : html.length;
      const body = html.slice(i, bodyEnd);
      edits.push({ start: i, end: bodyEnd, text: rewriteCss(body, path, context, 1) });
      i = closeMatch ? closeMatch.index + closeMatch[0].length : html.length;
      continue;
    }

    if (name === "textarea" || name === "title") {
      const close = new RegExp(`</${name}\\s*>`, "gi");
      close.lastIndex = i;
      const closeMatch = close.exec(html);
      i = closeMatch ? closeMatch.index + closeMatch[0].length : html.length;
      continue;
    }

    if (name === "link") {
      const href = get("href");
      const rel = (get("rel")?.value ?? "").toLowerCase();
      if (href && /\b(stylesheet|icon|apple-touch-icon|preload|manifest)\b/.test(rel)) {
        rewriteValue(href, (value) => localUrl(value));
      }
    } else if (name === "a" || name === "area") {
      const href = get("href");
      if (href && href.value && !isExternalReference(href.value)) {
        const target = context.resolve(href.value, path);
        const extension = target ? extname(target) : "";
        if (target && (extension === "html" || extension === "htm")) {
          const hash = /#.*$/.exec(href.value)?.[0] ?? "";
          edits.push({
            start: attrOffset + attrSource.length,
            end: attrOffset + attrSource.length,
            text: ` data-cs-href="${escapeAttribute(target)}"${hash ? ` data-cs-hash="${escapeAttribute(hash)}"` : ""}`,
          });
        }
      }
    }

    for (const attribute of attributes) {
      if (attribute.name === "src" && name !== "script" && name !== "iframe" && name !== "frame") {
        rewriteValue(attribute, (value) => localUrl(value));
      } else if (attribute.name === "poster" || (attribute.name === "data" && name === "object")) {
        rewriteValue(attribute, (value) => localUrl(value));
      } else if (attribute.name === "srcset" || attribute.name === "imagesrcset") {
        rewriteValue(attribute, (value) => rewriteSrcset(value, path, context));
      } else if (attribute.name === "style" && /url\(|@import/i.test(attribute.value)) {
        rewriteValue(attribute, (value) => rewriteCss(value, path, context, 1).then(escapeAttribute));
      }
    }
  }

  // Apply the edits back to front.
  const resolved = await Promise.all(edits.map(async (edit) => ({ ...edit, text: await edit.text })));
  resolved.sort((a, b) => b.start - a.start);
  let output = html;
  for (const edit of resolved) {
    if (edit.text === null || edit.text === undefined) continue;
    output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
  }
  return output;
}

/**
 * A module <script src> needs the data: URL of the module itself (script
 * src isn't resolved through the import map).
 * @param {BuildContext} context
 * @param {string} key
 * @param {string} path
 * @returns {Promise<string|null>}
 */
async function moduleDataUrlLater(context, key, path) {
  await context.finishModules();
  const url = context._importMap[key];
  return url ? escapeAttribute(url) : null;
}

/**
 * @param {string} value
 * @param {string} path
 * @param {BuildContext} context
 * @returns {Promise<string>}
 */
async function rewriteSrcset(value, path, context) {
  const parts = value.split(",");
  const rewritten = await Promise.all(
    parts.map(async (part) => {
      const match = /^(\s*)(\S+)(.*)$/s.exec(part);
      if (!match || isExternalReference(match[2])) return part;
      const target = context.resolve(match[2], path);
      const url = target ? await context.dataUrlFor(target, path) : null;
      return url ? `${match[1]}${url}${match[3]}` : part;
    })
  );
  return escapeAttribute(rewritten.join(","));
}

// -----------------------------------------------------------------
// CSS
// -----------------------------------------------------------------

/**
 * Rewrite url() and @import references in CSS.
 * @param {string} css
 * @param {string} path - File the CSS belongs to (references are relative to it).
 * @param {BuildContext} context
 * @param {number} depth
 * @returns {Promise<string>}
 */
async function rewriteCss(css, path, context, depth) {
  const edits = [];
  const pattern = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)|@import\s+(?:"([^"]*)"|'([^']*)')/gi;
  let match;
  while ((match = pattern.exec(css))) {
    const isImport = match[0][0] === "@";
    const value = isImport ? match[4] ?? match[5] : match[1] ?? match[2] ?? match[3];
    if (!value || isExternalReference(value)) continue;
    const target = context.resolve(value, path);
    if (!target) continue;
    const isCss = extname(target) === "css";
    const promise = (isCss ? context.dataUrlFor(target, path, depth) : context.dataUrlFor(target, path)).then((url) =>
      url ? (isImport ? `@import url("${url}")` : `url("${url}")`) : null
    );
    edits.push({ start: match.index, end: match.index + match[0].length, text: promise });
  }
  const resolved = await Promise.all(edits.map(async (edit) => ({ ...edit, text: await edit.text })));
  let output = css;
  for (const edit of resolved.sort((a, b) => b.start - a.start)) {
    if (edit.text === null) continue;
    output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
  }
  return output;
}

// -----------------------------------------------------------------
// JavaScript modules
// -----------------------------------------------------------------

/**
 * Replace local module specifiers with import-map keys.
 * @param {string} source
 * @param {string} path
 * @param {BuildContext} context
 * @returns {Promise<string>}
 */
async function rewriteModuleSpecifiers(source, path, context) {
  const pattern = /(\bimport\s*(?:[\w$*{}\s,]+?\s*from\s*)?|\bexport\s*(?:\*(?:\s*as\s+[\w$]+)?|\{[^}]*\})\s*from\s*|\bimport\s*\(\s*)(["'])([^"'\n]+)\2/g;
  let output = "";
  let last = 0;
  let match;
  while ((match = pattern.exec(source))) {
    const specifier = match[3];
    if (!/^(?:\.{1,2}\/|\/)/.test(specifier)) continue;
    const target = context.resolve(specifier, path);
    if (!target) continue;
    const key = context.moduleKey(target, path);
    const specStart = match.index + match[1].length + 1;
    output += source.slice(last, specStart) + key;
    last = specStart + specifier.length;
  }
  return output + source.slice(last);
}

// -----------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------

/**
 * @param {string} html
 * @param {number} from - Index just after the tag name.
 * @returns {number} Index of the closing ">", or -1.
 */
function findTagEnd(html, from) {
  let quote = "";
  for (let j = from; j < html.length; j += 1) {
    const c = html[j];
    if (quote) {
      if (c === quote) quote = "";
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === ">") {
      return j;
    }
  }
  return -1;
}

/**
 * @param {string} source
 * @param {number} offset - Index of `source` within the document.
 * @returns {Array<{name: string, value: string, valueStart: number, valueEnd: number}>} valueStart/End delimit the raw value (inside quotes), -1 when the attribute has no value.
 */
function parseAttributesWithRanges(source, offset) {
  return parseAttributes(source).map((attribute) => {
    const raw = source.slice(attribute.index);
    const match = /^[^\s"'=<>/`]+\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/.exec(raw);
    if (!match) return { name: attribute.name.toLowerCase(), value: attribute.value, valueStart: -1, valueEnd: -1 };
    const valueText = match[1] ?? match[2] ?? match[3];
    const quoted = match[1] !== undefined || match[2] !== undefined;
    const valueStart = offset + attribute.index + match[0].length - valueText.length - (quoted ? 1 : 0);
    return {
      name: attribute.name.toLowerCase(),
      value: decodeEntities(attribute.value),
      valueStart,
      valueEnd: valueStart + valueText.length,
    };
  });
}

/**
 * @param {string} html
 * @returns {number} Where the bridge goes: just inside <head>, else after <html>, else after the doctype, else at the start.
 */
function findHeadInsertionPoint(html) {
  const head = /<head\b[^>]*>/i.exec(html);
  if (head) return head.index + head[0].length;
  const root = /<html\b[^>]*>/i.exec(html);
  if (root) return root.index + root[0].length;
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  if (doctype) return doctype[0].length;
  return 0;
}

/**
 * @param {string} text
 * @param {string} type
 * @param {string|null} path - Recorded as an x-path parameter so errors map back to the file.
 * @returns {string}
 */
function textDataUrl(text, type, path) {
  const params = `;charset=utf-8${path ? `;x-path=${encodeURIComponent(path)}` : ""}`;
  return `data:${type}${params};base64,${utf8ToBase64(text)}`;
}

/**
 * @param {string} text
 * @returns {string}
 */
function utf8ToBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * @param {Blob} blob
 * @returns {Promise<string>}
 */
function blobToDataUrl(blob) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(blob);
  });
}

/**
 * @param {string} value
 * @returns {string}
 */
function escapeAttribute(value) {
  return String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/**
 * @param {string} value
 * @returns {string} Common HTML entities decoded (attribute values).
 */
function decodeEntities(value) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** @returns {string} */
function createToken() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
