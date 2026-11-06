/**
 * @file Favicons for tabs, bookmarks, history, and shortcuts.
 *
 * A site's favicon is loaded as a plain image from the page's own icon
 * link (when BrowserOS could read it) or the conventional /favicon.ico;
 * when that image doesn't exist, the globe icon is shown instead.
 * BrowserOS pages and files use built-in icons.
 */

import { createIconElement } from "../../utils/icons.js";
import { faviconFor, internalPageOf } from "../../core/browser/urlUtils.js";

const INTERNAL_ICONS = Object.freeze({ start: "icon:home", history: "icon:history", bookmarks: "icon:star", downloads: "icon:download" });

/**
 * @param {string} url
 * @param {string|null} [favicon]
 * @param {string} [className]
 * @returns {HTMLElement}
 */
export function createFavicon(url, favicon = null, className = "browser-favicon") {
  const page = internalPageOf(url);
  if (page) return createIconElement(INTERNAL_ICONS[page] ?? "icon:globe", { className });
  if (typeof url === "string" && url.startsWith("vfs://")) return createIconElement("icon:file", { className });
  const source = favicon || faviconFor(url);
  if (!source) return createIconElement("icon:globe", { className });
  const wrapper = document.createElement("span");
  wrapper.className = className;
  wrapper.setAttribute("aria-hidden", "true");
  const img = document.createElement("img");
  img.alt = "";
  img.decoding = "async";
  img.loading = "lazy";
  img.referrerPolicy = "no-referrer";
  img.addEventListener("error", () => wrapper.replaceChildren(createIconElement("icon:globe")), { once: true });
  img.src = source;
  wrapper.append(img);
  return wrapper;
}
