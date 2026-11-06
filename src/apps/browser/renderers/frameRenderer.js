/**
 * @file FrameRenderer — the web rendering backend: shows a web page in
 * a sandboxed iframe.
 *
 * Renderer interface (shared with VfsRenderer, and what a future native
 * backend — an Electron or Tauri web view — would implement):
 *   element                 HTMLElement to place in the tab's view
 *   load(url) / reload() / stop() / destroy()
 *   callbacks: onLoadStart(), onLoadEnd({ title, favicon, url }),
 *              onInPageNavigation({ url|null }), onDownloadRequest({ url, filename }),
 *              onError({ kind, message })
 *   static capabilities     what the backend can and can't observe
 *
 * What an iframe can do from inside a web page:
 *  - Cross-origin pages are opaque: their title, current address,
 *    content, and download links can't be read, and a refusal to be
 *    embedded (X-Frame-Options / frame-ancestors) can't be detected.
 *    Navigation inside them is noticed (the frame loads again) but the
 *    new address isn't known.
 *  - Pages from BrowserOS's own address are readable: title, address,
 *    and download links (routed to the Download Manager). They are
 *    shown without running their scripts, so they can't reach into
 *    BrowserOS.
 *
 * Sandbox: no top-level navigation (a page can't navigate BrowserOS
 * away), no camera/microphone/location permissions; scripts, forms,
 * pop-ups (opened by the host browser), and downloads (saved by the host
 * browser) are allowed for other sites so they work normally.
 */

const LOAD_TIMEOUT_MS = 30_000;
const CROSS_ORIGIN_SANDBOX = "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads";
const SAME_ORIGIN_SANDBOX = "allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads";
/** Links to these file types are downloads rather than pages. */
export const DOWNLOAD_LINK_EXTENSIONS = new Set(["zip", "7z", "rar", "gz", "tgz", "tar", "bz2", "xz", "iso", "dmg", "apk", "deb", "rpm", "jar", "bin", "dat", "exe", "msi"]);

export class FrameRenderer {
  static capabilities = Object.freeze({
    readsCrossOriginPages: false,
    tracksCrossOriginNavigation: false,
    detectsEmbeddingRefusal: false,
    interceptsDownloads: "same-origin pages only",
  });

  /**
   * @param {object} callbacks
   * @param {() => void} callbacks.onLoadStart
   * @param {(info: {title: string|null, favicon: string|null, url: string|null}) => void} callbacks.onLoadEnd
   * @param {(info: {url: string|null}) => void} callbacks.onInPageNavigation
   * @param {(info: {url: string, filename: string|null}) => void} callbacks.onDownloadRequest
   * @param {(info: {kind: string, message: string}) => void} callbacks.onError
   */
  constructor(callbacks) {
    this._callbacks = callbacks;
    this._frame = null;
    this._url = null;
    this._loads = 0;
    this._timeoutId = null;
    this._documentCleanup = null;
    this.element = document.createElement("div");
    this.element.className = "browser-frame";
  }

  /**
   * @param {string} url
   * @returns {void}
   */
  load(url) {
    this._url = url;
    this._replaceFrame(url);
  }

  /** @returns {void} */
  reload() {
    if (this._url) this._replaceFrame(this._url);
  }

  /** Stop loading (the frame is cleared). @returns {void} */
  stop() {
    if (!this._frame) return;
    window.clearTimeout(this._timeoutId);
    this._teardownDocument();
    this._frame.remove();
    this._frame = null;
    this._callbacks.onLoadEnd({ title: null, favicon: null, url: null, stopped: true });
  }

  /** @returns {void} */
  destroy() {
    window.clearTimeout(this._timeoutId);
    this._teardownDocument();
    this._frame?.remove();
    this._frame = null;
    this.element.remove();
  }

  /** @returns {boolean} Whether the current page can be read (same origin). */
  isReadable() {
    try {
      return Boolean(this._frame?.contentDocument);
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------

  /**
   * A fresh iframe per navigation keeps BrowserOS's own session history
   * clean and resets the per-page sandbox.
   * @param {string} url
   * @returns {void}
   */
  _replaceFrame(url) {
    window.clearTimeout(this._timeoutId);
    this._teardownDocument();
    this._frame?.remove();
    const frame = document.createElement("iframe");
    frame.className = "browser-frame__iframe";
    frame.setAttribute("sandbox", isSameOrigin(url) ? SAME_ORIGIN_SANDBOX : CROSS_ORIGIN_SANDBOX);
    frame.setAttribute("referrerpolicy", "strict-origin-when-cross-origin");
    frame.setAttribute("allow", "fullscreen; clipboard-write; picture-in-picture; autoplay");
    frame.setAttribute("title", "Web page");
    frame.addEventListener("load", () => this._handleLoad(frame));
    this._frame = frame;
    this._loads = 0;
    this._callbacks.onLoadStart();
    this._timeoutId = window.setTimeout(() => {
      if (this._frame === frame && this._loads === 0) {
        this._callbacks.onError({ kind: "timeout", message: "The page took too long to respond." });
      }
    }, LOAD_TIMEOUT_MS);
    frame.src = url;
    this.element.replaceChildren(frame);
  }

  /**
   * @param {HTMLIFrameElement} frame
   * @returns {void}
   */
  _handleLoad(frame) {
    if (frame !== this._frame) return;
    this._loads += 1;
    window.clearTimeout(this._timeoutId);
    const info = this._readPage(frame);
    if (this._loads === 1) {
      this._callbacks.onLoadEnd(info);
    } else {
      this._callbacks.onInPageNavigation({ url: info.url });
      this._callbacks.onLoadEnd(info);
    }
  }

  /**
   * @param {HTMLIFrameElement} frame
   * @returns {{title: string|null, favicon: string|null, url: string|null}}
   */
  _readPage(frame) {
    let doc = null;
    try {
      doc = frame.contentDocument;
    } catch {
      doc = null;
    }
    if (!doc) return { title: null, favicon: null, url: null };
    this._teardownDocument();
    const onClick = (event) => this._interceptDownload(event, doc);
    doc.addEventListener("click", onClick, true);
    this._documentCleanup = () => doc.removeEventListener("click", onClick, true);
    let url = null;
    try {
      url = doc.location.href === "about:blank" ? null : doc.location.href;
    } catch {
      url = null;
    }
    const icon = doc.querySelector('link[rel~="icon" i]');
    return {
      title: doc.title || null,
      favicon: icon?.href && /^https?:/.test(icon.href) ? icon.href : null,
      url,
    };
  }

  /**
   * Same-origin pages: links marked `download`, or pointing at archive
   * and installer files, go to the Download Manager.
   * @param {MouseEvent} event
   * @param {Document} doc
   * @returns {void}
   */
  _interceptDownload(event, doc) {
    if (event.defaultPrevented || event.button !== 0) return;
    const link = event.target instanceof doc.defaultView.Element ? event.target.closest("a[href]") : null;
    if (!link) return;
    const href = link.href;
    if (!/^https?:/.test(href)) return;
    let extension = "";
    try {
      extension = new URL(href).pathname.split(".").pop().toLowerCase();
    } catch {
      return;
    }
    if (!link.hasAttribute("download") && !DOWNLOAD_LINK_EXTENSIONS.has(extension)) return;
    event.preventDefault();
    this._callbacks.onDownloadRequest({ url: href, filename: link.getAttribute("download") || null });
  }

  /** @returns {void} */
  _teardownDocument() {
    this._documentCleanup?.();
    this._documentCleanup = null;
  }
}

/**
 * @param {string} url
 * @returns {boolean}
 */
export function isSameOrigin(url) {
  try {
    return new URL(url).origin === window.location.origin;
  } catch {
    return false;
  }
}
