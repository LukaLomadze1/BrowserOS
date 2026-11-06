/**
 * @file VfsRenderer — shows a file from the BrowserOS file system
 * (vfs:///path) in a Browser tab, through the public VFS API.
 *
 *  - .html / .htm: rendered in an iframe with an empty sandbox — no
 *    scripts, no forms, no access to BrowserOS. Links inside open in
 *    the host browser.
 *  - images: displayed from a temporary Blob URL (revoked on unload).
 *  - other text files: shown as plain text.
 *  - anything else: a message with "Open with default app".
 *
 * Implements the same interface as FrameRenderer.
 */

import { vfs } from "../../../core/vfs/virtualFileSystem.js";
import { isBinaryExtension } from "../../../core/vfs/entry.js";
import { getExtension } from "../../../core/vfs/pathResolver.js";

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp", "ico", "avif", "svg"]);
const HTML_EXTENSIONS = new Set(["html", "htm"]);

export class VfsRenderer {
  /**
   * @param {object} callbacks - See FrameRenderer.
   * @param {(path: string) => void} openWithDefaultApp
   */
  constructor(callbacks, openWithDefaultApp) {
    this._callbacks = callbacks;
    this._openWithDefaultApp = openWithDefaultApp;
    this._objectUrl = null;
    this._path = null;
    this._token = 0;
    this.element = document.createElement("div");
    this.element.className = "browser-vfs";
  }

  /**
   * @param {string} path - Absolute VFS path.
   * @returns {Promise<void>}
   */
  async load(path) {
    this._path = path;
    const token = ++this._token;
    this._revoke();
    this._callbacks.onLoadStart();
    try {
      const entry = await vfs.getInfo(path);
      if (token !== this._token) return;
      if (entry.type === "folder") throw new Error(`${path} is a folder`);
      const extension = getExtension(entry.name);
      if (HTML_EXTENSIONS.has(extension)) {
        const html = await vfs.read(path);
        if (token !== this._token) return;
        const frame = document.createElement("iframe");
        frame.className = "browser-frame__iframe";
        frame.setAttribute("sandbox", "");
        frame.setAttribute("title", entry.name);
        frame.srcdoc = html;
        this.element.replaceChildren(frame);
        const title = new DOMParser().parseFromString(html, "text/html").title.trim();
        this._callbacks.onLoadEnd({ title: title || entry.name, favicon: null, url: null });
      } else if (IMAGE_EXTENSIONS.has(extension)) {
        const blob = isBinaryExtension(extension) ? await vfs.readBinary(path) : new Blob([await vfs.read(path)], { type: "image/svg+xml" });
        if (token !== this._token) return;
        this._objectUrl = URL.createObjectURL(blob);
        const img = document.createElement("img");
        img.className = "browser-vfs__image";
        img.alt = entry.name;
        img.src = this._objectUrl;
        this.element.replaceChildren(img);
        this._callbacks.onLoadEnd({ title: entry.name, favicon: null, url: null });
      } else if (!isBinaryExtension(extension)) {
        const text = await vfs.read(path);
        if (token !== this._token) return;
        const pre = document.createElement("pre");
        pre.className = "browser-vfs__text";
        pre.textContent = text;
        this.element.replaceChildren(pre);
        this._callbacks.onLoadEnd({ title: entry.name, favicon: null, url: null });
      } else {
        const message = document.createElement("div");
        message.className = "browser-vfs__message";
        const text = document.createElement("p");
        text.textContent = `The Browser can't display ${entry.name}.`;
        const button = document.createElement("button");
        button.type = "button";
        button.className = "browser-button browser-button--primary";
        button.textContent = "Open with default app";
        button.addEventListener("click", () => this._openWithDefaultApp(path));
        message.append(text, button);
        this.element.replaceChildren(message);
        this._callbacks.onLoadEnd({ title: entry.name, favicon: null, url: null });
      }
    } catch (error) {
      if (token !== this._token) return;
      this._callbacks.onError({ kind: "file", message: error?.code === "NOT_FOUND" ? `${path} doesn't exist.` : error.message });
    }
  }

  /** @returns {void} */
  reload() {
    if (this._path) this.load(this._path);
  }

  /** @returns {void} */
  stop() {}

  /** @returns {void} */
  destroy() {
    this._token += 1;
    this._revoke();
    this.element.remove();
  }

  /** @returns {void} */
  _revoke() {
    if (this._objectUrl) URL.revokeObjectURL(this._objectUrl);
    this._objectUrl = null;
  }
}
