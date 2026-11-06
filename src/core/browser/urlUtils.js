/**
 * @file Address parsing and URL helpers for the Browser.
 *
 * `parseAddressInput()` decides what text typed into the address bar
 * means:
 *
 *   "https://example.com/a"  → that URL
 *   "example.com", "a.b.org/x" → https://… (a host with a dot and a known-looking TLD)
 *   "localhost:8080", "192.168.1.5" → http://…
 *   "browseros://history"    → a built-in page
 *   "vfs:///Documents/a.html" → a file from the BrowserOS file system
 *   "cats and dogs"          → a search with the configured engine
 *   "javascript:…", "data:…", "file:…" → refused (unsupported scheme)
 *   "http://"                → an error ("not a valid address")
 */

import { buildSearchUrl } from "./searchEngines.js";

export const INTERNAL_SCHEME = "browseros:";
export const VFS_SCHEME = "vfs:";
export const START_PAGE_URL = "browseros://start";

/** Built-in pages, by host part of browseros:// URLs. */
export const INTERNAL_PAGES = Object.freeze({
  start: "New tab",
  history: "History",
  bookmarks: "Bookmarks",
  downloads: "Downloads",
});

const WEB_SCHEMES = new Set(["http:", "https:"]);
/** Schemes refused for safety or because a web page can't open them. */
const BLOCKED_SCHEMES = new Set(["javascript:", "data:", "file:", "blob:", "chrome:", "about:", "view-source:", "filesystem:", "ws:", "wss:"]);
/** Schemes handed to the host browser / operating system. */
const EXTERNAL_SCHEMES = new Set(["mailto:", "tel:", "sms:"]);

/** Host names: letters, digits, hyphens, and dots (international names arrive as punycode), or an IPv6 literal. */
const VALID_HOST = /^(?:[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?\.)*[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?\.?$|^\[[0-9a-f:.]+\]$/i;
const HOST_LIKE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}\.?(?::\d{1,5})?(?:[/?#].*)?$/i;
const LOCAL_HOST_LIKE = /^(?:localhost|(?:\d{1,3}\.){3}\d{1,3}|\[[0-9a-f:]+\])(?::\d{1,5})?(?:[/?#].*)?$/i;

/**
 * @typedef {object} AddressResult
 * @property {"url"|"search"|"internal"|"vfs"|"external"|"empty"|"error"} type
 * @property {string} [url] - The URL to open (for url, search, internal, vfs, external).
 * @property {string} [query] - For searches.
 * @property {string} [message] - For errors.
 */

/**
 * @param {string} input
 * @param {{searchEngine: string}} options
 * @returns {AddressResult}
 */
export function parseAddressInput(input, { searchEngine }) {
  const text = typeof input === "string" ? input.trim() : "";
  if (!text) return { type: "empty" };
  if (text === "about:blank") return { type: "url", url: "about:blank" };

  const lower = text.toLowerCase();
  if (lower.startsWith("browseros://")) {
    const page = lower.slice("browseros://".length).split(/[/?#]/)[0];
    if (Object.hasOwn(INTERNAL_PAGES, page)) return { type: "internal", url: `browseros://${page}` };
    return { type: "error", message: `"${text}" isn't a BrowserOS page. Try browseros://start, history, bookmarks, or downloads.` };
  }
  if (lower.startsWith("vfs:")) {
    const path = normalizeVfsPath(text.slice(4));
    if (!path) return { type: "error", message: `"${text}" isn't a valid file path.` };
    return { type: "vfs", url: `vfs://${path}` };
  }

  // Bare hosts first, so "localhost:3000" isn't read as the scheme "localhost:".
  if (!/\s/.test(text) && LOCAL_HOST_LIKE.test(text)) return toUrlResult(`http://${text}`, text);
  if (!/\s/.test(text) && HOST_LIKE.test(text) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return toUrlResult(`https://${text}`, text);

  const scheme = /^([a-z][a-z0-9+.-]*:)/i.exec(text)?.[1]?.toLowerCase() ?? null;
  if (scheme && !/\s/.test(text)) {
    if (WEB_SCHEMES.has(scheme)) return toUrlResult(text, text);
    if (EXTERNAL_SCHEMES.has(scheme)) return { type: "external", url: text };
    if (BLOCKED_SCHEMES.has(scheme)) {
      return { type: "error", message: `BrowserOS doesn't open ${scheme} addresses. Only web pages (http and https), BrowserOS pages, and BrowserOS files can be opened.` };
    }
    if (text.includes("//")) return { type: "error", message: `BrowserOS can't open ${scheme} addresses.` };
  }

  return { type: "search", query: text, url: buildSearchUrl(searchEngine, text) };
}

/**
 * @param {string} candidate
 * @param {string} original
 * @returns {AddressResult}
 */
function toUrlResult(candidate, original) {
  if (!isWebUrl(candidate)) return { type: "error", message: `"${original}" isn't a valid web address.` };
  return { type: "url", url: new URL(candidate).href };
}

/**
 * @param {string} raw - The part after "vfs:", e.g. "///Documents/a.html" or "/Documents/a.html".
 * @returns {string|null} An absolute VFS path.
 */
export function normalizeVfsPath(raw) {
  let path = decodeSafely(raw.replace(/^\/\/+/, "/").replace(/^\/{2,}/, "/"));
  if (!path.startsWith("/")) path = `/${path}`;
  if (path.includes("\0") || /(^|\/)\.\.(\/|$)/.test(path)) return null;
  return path.replace(/\/+$/, "") || "/";
}

/**
 * @param {string} url
 * @returns {string|null} The VFS path of a vfs:// URL.
 */
export function vfsPathOf(url) {
  return typeof url === "string" && url.startsWith("vfs://") ? normalizeVfsPath(url.slice(6)) : null;
}

/**
 * @param {string} url
 * @returns {string|null} The page name of a browseros:// URL.
 */
export function internalPageOf(url) {
  if (typeof url !== "string" || !url.startsWith("browseros://")) return null;
  const page = url.slice("browseros://".length).split(/[/?#]/)[0];
  return Object.hasOwn(INTERNAL_PAGES, page) ? page : null;
}

/**
 * @param {string} url
 * @returns {boolean}
 */
export function isWebUrl(url) {
  if (typeof url !== "string" || /\s/.test(url.trim())) return false;
  try {
    const parsed = new URL(url.trim());
    // Some URL parsers accept (and percent-encode) characters that can't
    // appear in a host name, so the host is checked explicitly.
    return WEB_SCHEMES.has(parsed.protocol) && VALID_HOST.test(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * @param {string} url
 * @returns {string|null} Lower-case host name of a web URL.
 */
export function hostOf(url) {
  try {
    const parsed = new URL(url);
    return WEB_SCHEMES.has(parsed.protocol) ? parsed.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} url
 * @returns {string|null} The site's conventional favicon location (it may not exist).
 */
export function faviconFor(url) {
  try {
    const parsed = new URL(url);
    return WEB_SCHEMES.has(parsed.protocol) ? `${parsed.origin}/favicon.ico` : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} url
 * @returns {"secure"|"insecure"|"internal"|"file"|"none"}
 */
export function securityOf(url) {
  if (typeof url !== "string") return "none";
  if (url.startsWith("browseros://")) return "internal";
  if (url.startsWith("vfs://")) return "file";
  if (url.startsWith("https://")) return "secure";
  if (url.startsWith("http://")) return "insecure";
  return "none";
}

/**
 * Text shown in the address bar for a URL (the start page shows an empty bar).
 * @param {string} url
 * @returns {string}
 */
export function displayUrl(url) {
  if (!url || url === START_PAGE_URL || url === "about:blank") return "";
  return url;
}

/**
 * Default title for a page whose own title can't be read.
 * @param {string} url
 * @returns {string}
 */
export function fallbackTitle(url) {
  const page = internalPageOf(url);
  if (page) return INTERNAL_PAGES[page];
  const vfsPath = vfsPathOf(url);
  if (vfsPath) return vfsPath.split("/").pop() || vfsPath;
  const host = hostOf(url);
  if (host) return host.replace(/^www\./, "");
  return url === "about:blank" ? "Blank page" : url;
}

/**
 * URL used to recognize the same page (history, bookmarks): no fragment.
 * @param {string} url
 * @returns {string}
 */
export function comparableUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.href;
  } catch {
    return url;
  }
}

/**
 * @param {string} value
 * @returns {string}
 */
function decodeSafely(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
