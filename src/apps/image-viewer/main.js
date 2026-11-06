/**
 * @file Image Viewer — displays PNG, JPEG, WebP, GIF, and SVG files from
 * the VFS, with zoom, fit, actual size, rotation, fullscreen, and
 * previous/next navigation through the images in the same folder.
 *
 * Image data is read with `vfs.readBinary()` and shown through an
 * object URL, which is revoked as soon as another image is shown and
 * when the window closes. SVG files are rendered only through an
 * <img> element, where browsers never run scripts or load external
 * resources, so an SVG can't execute code. Zoom and rotation are view
 * transforms only; the file is never modified.
 *
 * Multiple viewer windows can be open at once; each follows renames,
 * moves, and deletions of the file it shows.
 */

import { Application } from "../../core/application.js";
import { eventBus } from "../../core/eventBus.js";
import { vfs } from "../../core/vfs/virtualFileSystem.js";
import { fileAssociations } from "../../core/fileAssociations.js";
import { keyboardShortcuts } from "../../core/keyboard/keyboardShortcuts.js";
import { createElement } from "../../utils/dom.js";
import { formatBytes } from "../../utils/format.js";
import { ensureStylesheet } from "../../utils/loadStylesheet.js";

ensureStylesheet("src/apps/image-viewer/imageViewer.css");

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 16;
const ZOOM_STEP = 1.25;

export default class ImageViewerApp extends Application {
  constructor(meta) {
    super(meta);
    /** @type {object|null} */
    this._entry = null;
    /** @type {object[]} Images in the current folder, sorted by name. */
    this._siblings = [];
    this._objectUrl = null;
    this._natural = { width: 0, height: 0 };
    this._zoom = 1;
    this._fit = true;
    this._rotation = 0;
    this._loadToken = 0;
    this._cleanups = [];
    this._resizeObserver = null;
  }

  /**
   * @param {{path?: string}} [options]
   * @returns {ReturnType<Application["launch"]>}
   */
  launch(options = {}) {
    this._buildDom();
    const on = (name, handler) => this._cleanups.push(eventBus.on(name, handler));
    on("filesystem:fileRenamed", ({ entry }) => this._handleExternalChange(entry));
    on("filesystem:fileMoved", ({ entry }) => this._handleExternalChange(entry));
    on("filesystem:fileDeleted", ({ entry }) => this._handleExternalChange(entry, true));
    on("filesystem:fileCreated", ({ entry }) => this._refreshSiblingsFor(entry));
    on("filesystem:fileCopied", ({ entry }) => this._refreshSiblingsFor(entry));
    on("filesystem:fileModified", ({ entry }) => entry.id === this._entry?.id && this._show(entry.path, { keepView: true }));

    this._resizeObserver = new ResizeObserver(() => this._fit && this._applyTransform());
    this._resizeObserver.observe(this._stage);
    this._fullscreenHandler = () => {
      this._fullscreenButton.setAttribute("aria-pressed", String(document.fullscreenElement === this._root));
      this._applyTransform();
    };
    document.addEventListener("fullscreenchange", this._fullscreenHandler);

    if (options.path) {
      this._show(options.path);
    } else {
      this._showEmpty();
    }

    return {
      element: this._root,
      title: "Image Viewer",
      icon: "\u25a7",
      width: 820,
      height: 600,
      minWidth: 360,
      minHeight: 300,
      resizable: true,
      minimizable: true,
      maximizable: true,
      closable: true,
    };
  }

  /** @returns {void} */
  close() {
    this._loadToken += 1;
    for (const cleanup of this._cleanups) cleanup();
    this._cleanups = [];
    this._resizeObserver?.disconnect();
    document.removeEventListener("fullscreenchange", this._fullscreenHandler);
    if (document.fullscreenElement === this._root) document.exitFullscreen().catch(() => {});
    this._revokeUrl();
  }

  /** @returns {void} */
  onFocus() {
    if (!this._root.contains(document.activeElement)) this._root.focus({ preventScroll: true });
  }

  // ---------------------------------------------------------------
  // DOM
  // ---------------------------------------------------------------

  /** @returns {void} */
  _buildDom() {
    const button = (label, glyph, onClick, shortcutId) => {
      const title = shortcutId ? `${label} (${shortcutLabel(shortcutId)})` : label;
      return createElement("button", { className: "viewer__tool", attrs: { type: "button", "aria-label": label, title }, text: glyph, on: { click: onClick } });
    };

    this._prevButton = button("Previous image", "\u2039", () => this._step(-1), "imageViewer.previous");
    this._nextButton = button("Next image", "\u203a", () => this._step(1), "imageViewer.next");
    this._zoomLabel = createElement("button", {
      className: "viewer__zoom-label",
      attrs: { type: "button", title: "Fit to window", "aria-label": "Zoom level. Activate to fit to window" },
      text: "100%",
      on: { click: () => this._setFit() },
    });
    this._fullscreenButton = button("Fullscreen", "\u26f6", () => this._toggleFullscreen(), "imageViewer.fullscreen");
    this._fullscreenButton.setAttribute("aria-pressed", "false");

    const group = (children) => createElement("div", { className: "viewer__group", children });
    this._toolbar = createElement("div", {
      className: "viewer__toolbar",
      attrs: { role: "toolbar", "aria-label": "Image controls" },
      children: [
        group([this._prevButton, this._nextButton]),
        group([
          button("Zoom out", "\u2212", () => this._zoomBy(1 / ZOOM_STEP), "imageViewer.zoomOut"),
          this._zoomLabel,
          button("Zoom in", "+", () => this._zoomBy(ZOOM_STEP), "imageViewer.zoomIn"),
        ]),
        group([
          button("Fit to window", "\u2922", () => this._setFit(), "imageViewer.fit"),
          button("Actual size", "1:1", () => this._setZoom(1), "imageViewer.actualSize"),
        ]),
        group([
          button("Rotate left", "\u21ba", () => this._rotate(-90), "imageViewer.rotateLeft"),
          button("Rotate right", "\u21bb", () => this._rotate(90), "imageViewer.rotateRight"),
          button("Reset view", "\u27f2", () => this._resetView(), "imageViewer.reset"),
        ]),
        group([this._fullscreenButton]),
      ],
    });

    this._img = createElement("img", { className: "viewer__image", attrs: { alt: "", draggable: "false", decoding: "async" } });
    this._img.addEventListener("load", () => this._handleImageLoad());
    this._img.addEventListener("error", () => this._handleImageError());
    this._canvas = createElement("div", { className: "viewer__canvas", children: [this._img] });
    this._messageEl = createElement("div", { className: "viewer__message", attrs: { role: "status" } });
    this._stage = createElement("div", {
      className: "viewer__stage",
      children: [this._canvas, this._messageEl],
      on: {
        wheel: (e) => this._handleWheel(e),
        pointerdown: (e) => this._startPan(e),
        dblclick: () => (this._fit ? this._setZoom(1) : this._setFit()),
      },
    });

    this._nameEl = createElement("span", { className: "viewer__name" });
    this._infoEl = createElement("span", { className: "viewer__info" });
    this._positionEl = createElement("span", { className: "viewer__position" });
    const status = createElement("div", { className: "viewer__status", children: [this._nameEl, this._infoEl, this._positionEl] });

    this._root = createElement("div", {
      className: "viewer",
      attrs: { tabindex: "0", "aria-label": "Image Viewer" },
      children: [this._toolbar, this._stage, status],
      on: { keydown: (e) => this._handleKeydown(e) },
    });
  }

  // ---------------------------------------------------------------
  // Loading
  // ---------------------------------------------------------------

  /**
   * @param {string} path
   * @param {{keepView?: boolean}} [options]
   * @returns {Promise<void>}
   */
  async _show(path, { keepView = false } = {}) {
    const token = ++this._loadToken;
    this._setMessage("Loading\u2026");
    let entry;
    let blob;
    try {
      entry = await vfs.getInfo(path);
      if (entry.type !== "file") throw new Error("This is not a file");
      blob = await vfs.readBinary(path);
    } catch (error) {
      if (token !== this._loadToken) return;
      this._entry = entry ?? null;
      this._clearImage();
      this._setMessage(`This image can't be opened. ${error.message}`, true);
      this._renderStatus();
      return;
    }
    if (token !== this._loadToken) return;

    this._entry = entry;
    if (!keepView) {
      this._fit = true;
      this._rotation = 0;
    }
    this._revokeUrl();
    this._objectUrl = URL.createObjectURL(blob);
    this._img.alt = entry.name;
    this._img.src = this._objectUrl;
    this.appManager?.updateWindowTitle(this.windowId, entry.name);
    this._renderStatus();
    await this._loadSiblings(entry);
  }

  /**
   * @param {object} entry
   * @returns {Promise<void>}
   */
  async _loadSiblings(entry) {
    const folder = entry.path.slice(0, entry.path.lastIndexOf("/")) || "/";
    const supported = new Set(fileAssociations.getExtensionsFor("image-viewer"));
    try {
      const children = await vfs.list(folder);
      this._siblings = children
        .filter((child) => child.type === "file" && supported.has(child.extension) && !child.hidden)
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
    } catch {
      this._siblings = [entry];
    }
    this._renderStatus();
  }

  /** @returns {void} */
  _handleImageLoad() {
    this._natural = { width: this._img.naturalWidth, height: this._img.naturalHeight };
    if (!this._natural.width || !this._natural.height) {
      // Some SVGs have no intrinsic size; give them a sensible default.
      this._natural = { width: 800, height: 600 };
    }
    this._setMessage("");
    this._canvas.hidden = false;
    this._applyTransform();
    this._renderStatus();
  }

  /** @returns {void} */
  _handleImageError() {
    if (!this._objectUrl) return;
    this._clearImage();
    this._setMessage("This file isn't a valid image or uses a format this browser can't display.", true);
    this._renderStatus();
  }

  /** @returns {void} */
  _showEmpty() {
    this._clearImage();
    this._messageEl.replaceChildren(
      createElement("p", { className: "viewer__message-title", text: "No image open" }),
      createElement("p", { text: "Open an image from File Explorer, or import pictures into the file system." }),
      createElement("button", {
        className: "viewer__button",
        attrs: { type: "button" },
        text: "Browse Pictures",
        on: { click: () => this.appManager?.launch("file-explorer", { path: "/Pictures" }) },
      })
    );
    this._messageEl.hidden = false;
    this._renderStatus();
  }

  /** @returns {void} */
  _clearImage() {
    this._revokeUrl();
    this._img.removeAttribute("src");
    this._canvas.hidden = true;
    this._natural = { width: 0, height: 0 };
  }

  /** @returns {void} */
  _revokeUrl() {
    if (this._objectUrl) {
      URL.revokeObjectURL(this._objectUrl);
      this._objectUrl = null;
    }
  }

  /**
   * @param {string} text
   * @param {boolean} [isError]
   * @returns {void}
   */
  _setMessage(text, isError = false) {
    this._messageEl.textContent = text;
    this._messageEl.hidden = !text;
    this._messageEl.classList.toggle("viewer__message--error", isError);
  }

  // ---------------------------------------------------------------
  // External changes
  // ---------------------------------------------------------------

  /**
   * @param {object} entry
   * @param {boolean} [deleted]
   * @returns {void}
   */
  _handleExternalChange(entry, deleted = false) {
    if (this._entry && entry.id === this._entry.id) {
      if (deleted) {
        this._clearImage();
        this._setMessage("This image was moved to Trash.", true);
        this._entry = null;
      } else {
        this._entry = entry;
        this.appManager?.updateWindowTitle(this.windowId, entry.name);
      }
    }
    if (this._siblings.some((sibling) => sibling.id === entry.id) || (this._entry && entry.parentId === this._entry.parentId)) {
      if (this._entry) this._loadSiblings(this._entry);
      else this._siblings = this._siblings.filter((sibling) => sibling.id !== entry.id);
    }
    this._renderStatus();
  }

  /**
   * @param {object} entry
   * @returns {void}
   */
  _refreshSiblingsFor(entry) {
    if (this._entry && entry.parentId === this._entry.parentId) this._loadSiblings(this._entry);
  }

  // ---------------------------------------------------------------
  // View transforms
  // ---------------------------------------------------------------

  /**
   * @param {-1|1} direction
   * @returns {void}
   */
  _step(direction) {
    if (this._siblings.length < 2 || !this._entry) return;
    const index = this._siblings.findIndex((sibling) => sibling.id === this._entry.id);
    const next = this._siblings[(index + direction + this._siblings.length) % this._siblings.length];
    this._show(next.path);
  }

  /**
   * @returns {number} Scale that fits the rotated image in the stage (never upscales).
   */
  _fitScale() {
    const { width, height } = this._natural;
    if (!width || !height) return 1;
    const rotated = this._rotation % 180 !== 0;
    const boxWidth = rotated ? height : width;
    const boxHeight = rotated ? width : height;
    const padding = 24;
    const available = { width: Math.max(1, this._stage.clientWidth - padding), height: Math.max(1, this._stage.clientHeight - padding) };
    return Math.min(1, available.width / boxWidth, available.height / boxHeight);
  }

  /**
   * @param {number} zoom
   * @returns {void}
   */
  _setZoom(zoom) {
    this._fit = false;
    this._zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
    this._applyTransform();
  }

  /**
   * @param {number} factor
   * @returns {void}
   */
  _zoomBy(factor) {
    const current = this._fit ? this._fitScale() : this._zoom;
    this._setZoom(current * factor);
  }

  /** @returns {void} */
  _setFit() {
    this._fit = true;
    this._applyTransform();
  }

  /**
   * @param {number} degrees
   * @returns {void}
   */
  _rotate(degrees) {
    this._rotation = (this._rotation + degrees + 360) % 360;
    this._applyTransform();
  }

  /** @returns {void} */
  _resetView() {
    this._rotation = 0;
    this._setFit();
  }

  /** @returns {void} */
  _applyTransform() {
    const { width, height } = this._natural;
    if (!width || !height) return;
    const scale = this._fit ? this._fitScale() : this._zoom;
    if (this._fit) this._zoom = scale;
    const rotated = this._rotation % 180 !== 0;
    const displayWidth = width * scale;
    const displayHeight = height * scale;
    this._canvas.style.width = `${rotated ? displayHeight : displayWidth}px`;
    this._canvas.style.height = `${rotated ? displayWidth : displayHeight}px`;
    this._img.style.width = `${displayWidth}px`;
    this._img.style.height = `${displayHeight}px`;
    this._img.style.transform = `translate(-50%, -50%) rotate(${this._rotation}deg)`;
    this._zoomLabel.textContent = `${Math.round(scale * 100)}%`;
    this._stage.classList.toggle("viewer__stage--pannable", this._stage.scrollWidth > this._stage.clientWidth || this._stage.scrollHeight > this._stage.clientHeight);
  }

  /** @returns {Promise<void>} */
  async _toggleFullscreen() {
    try {
      if (document.fullscreenElement === this._root) {
        await document.exitFullscreen();
      } else {
        await this._root.requestFullscreen();
      }
    } catch (error) {
      this._setMessage(`Fullscreen isn't available: ${error.message}`, true);
    }
  }

  /** @returns {void} */
  _renderStatus() {
    const entry = this._entry;
    this._nameEl.textContent = entry ? entry.name : "";
    const dimensions = this._natural.width && this._objectUrl ? `${this._natural.width} \u00d7 ${this._natural.height}` : "";
    this._infoEl.textContent = entry ? [dimensions, formatBytes(entry.size), entry.extension?.toUpperCase()].filter(Boolean).join(" \u00b7 ") : "";
    const index = entry ? this._siblings.findIndex((sibling) => sibling.id === entry.id) : -1;
    this._positionEl.textContent = index >= 0 && this._siblings.length > 1 ? `${index + 1} of ${this._siblings.length}` : "";
    const canStep = this._siblings.length > 1 && index >= 0;
    this._prevButton.disabled = !canStep;
    this._nextButton.disabled = !canStep;
  }

  // ---------------------------------------------------------------
  // Input
  // ---------------------------------------------------------------

  /**
   * Ctrl/⌘ + wheel zooms around the pointer; plain wheel scrolls.
   * @param {WheelEvent} e
   * @returns {void}
   */
  _handleWheel(e) {
    if (!(e.ctrlKey || e.metaKey) || !this._natural.width) return;
    e.preventDefault();
    const rect = this._stage.getBoundingClientRect();
    const pointer = { x: e.clientX - rect.left + this._stage.scrollLeft, y: e.clientY - rect.top + this._stage.scrollTop };
    const before = this._zoom;
    this._zoomBy(e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP);
    const ratio = this._zoom / before;
    this._stage.scrollLeft = pointer.x * ratio - (e.clientX - rect.left);
    this._stage.scrollTop = pointer.y * ratio - (e.clientY - rect.top);
  }

  /**
   * Drag to pan a zoomed image.
   * @param {PointerEvent} e
   * @returns {void}
   */
  _startPan(e) {
    if (e.button !== 0 || !this._stage.classList.contains("viewer__stage--pannable")) return;
    const start = { x: e.clientX, y: e.clientY, left: this._stage.scrollLeft, top: this._stage.scrollTop };
    this._stage.setPointerCapture(e.pointerId);
    this._stage.classList.add("viewer__stage--panning");
    const move = (event) => {
      this._stage.scrollLeft = start.left - (event.clientX - start.x);
      this._stage.scrollTop = start.top - (event.clientY - start.y);
    };
    const end = () => {
      this._stage.removeEventListener("pointermove", move);
      this._stage.removeEventListener("pointerup", end);
      this._stage.removeEventListener("pointercancel", end);
      this._stage.classList.remove("viewer__stage--panning");
    };
    this._stage.addEventListener("pointermove", move);
    this._stage.addEventListener("pointerup", end);
    this._stage.addEventListener("pointercancel", end);
  }

  /**
   * @param {KeyboardEvent} e
   * @returns {void}
   */
  _handleKeydown(e) {
    const actions = {
      "imageViewer.previous": () => this._step(-1),
      "imageViewer.next": () => this._step(1),
      "imageViewer.zoomIn": () => this._zoomBy(ZOOM_STEP),
      "imageViewer.zoomOut": () => this._zoomBy(1 / ZOOM_STEP),
      "imageViewer.fit": () => this._setFit(),
      "imageViewer.actualSize": () => this._setZoom(1),
      "imageViewer.rotateLeft": () => this._rotate(-90),
      "imageViewer.rotateRight": () => this._rotate(90),
      "imageViewer.reset": () => this._resetView(),
      "imageViewer.fullscreen": () => this._toggleFullscreen(),
    };
    for (const [id, action] of Object.entries(actions)) {
      if (keyboardShortcuts.matches(e, id)) {
        e.preventDefault();
        action();
        return;
      }
    }
  }
}

/**
 * @param {string} shortcutId
 * @returns {string}
 */
function shortcutLabel(shortcutId) {
  const shortcut = keyboardShortcuts.getGroupedShortcuts().flatMap((group) => group.shortcuts).find((s) => s.id === shortcutId);
  return shortcut?.keys.join(" / ") ?? "";
}
