/**
 * @file Downloads — the Download Manager window.
 *
 * Lists every download (shared DownloadList), with filters (all, in
 * progress, completed, failed), search, "Clear finished", "Open
 * Downloads folder", and a field to download a file from an address.
 * Opened from the Start Menu, the Browser (toolbar, menu, Ctrl + J),
 * download notifications, and the /Downloads folder in File Explorer.
 *
 * Launch options: { select?: downloadId }
 */

import { Application } from "../../core/application.js";
import { eventBus } from "../../core/eventBus.js";
import { downloadService } from "../../core/downloads/downloadService.js";
import { DownloadList } from "../../components/downloads/downloadList.js";
import { showMessageDialog } from "../../components/dialog/messageDialog.js";
import { createElement, hasModifierKey } from "../../utils/dom.js";
import { createIconElement } from "../../utils/icons.js";
import { ensureStylesheet } from "../../utils/loadStylesheet.js";

ensureStylesheet("src/apps/downloads/downloads.css");

const FILTERS = Object.freeze([
  { id: "all", label: "All" },
  { id: "active", label: "In progress" },
  { id: "completed", label: "Completed" },
  { id: "failed", label: "Failed" },
]);

export default class DownloadsApp extends Application {
  constructor(meta) {
    super(meta);
    this._cleanups = [];
    this._filter = "all";
  }

  /**
   * @param {{select?: string}} [options]
   * @returns {ReturnType<Application["launch"]>}
   */
  launch(options = {}) {
    this._list = new DownloadList();
    this._urlInput = createElement("input", {
      className: "downloads-app__url",
      attrs: { type: "url", placeholder: "https://example.com/file.pdf", "aria-label": "Address of a file to download", autocomplete: "off", spellcheck: "false" },
      on: { keydown: (e) => e.key === "Enter" && !hasModifierKey(e) && this._downloadFromField() },
    });
    this._filterButtons = FILTERS.map((filter) =>
      createElement("button", {
        className: "downloads-app__filter",
        attrs: { type: "button", "aria-pressed": String(filter.id === this._filter), "data-filter": filter.id },
        text: filter.label,
        on: { click: () => this._setFilter(filter.id) },
      })
    );
    this._summaryEl = createElement("p", { className: "downloads-app__summary", attrs: { role: "status" } });
    this._clearButton = createElement("button", {
      className: "downloads-app__button",
      attrs: { type: "button" },
      text: "Clear finished",
      on: { click: () => downloadService.clearFinished() },
    });

    this._root = createElement("div", {
      className: "downloads-app",
      attrs: { tabindex: "-1" },
      children: [
        createElement("header", {
          className: "downloads-app__header",
          children: [
            createElement("div", {
              className: "downloads-app__add",
              children: [
                createIconElement("icon:download", { className: "downloads-app__add-icon" }),
                this._urlInput,
                createElement("button", {
                  className: "downloads-app__button downloads-app__button--primary",
                  attrs: { type: "button" },
                  text: "Download",
                  on: { click: () => this._downloadFromField() },
                }),
              ],
            }),
            createElement("div", {
              className: "downloads-app__toolbar",
              children: [
                createElement("div", { className: "downloads-app__filters", attrs: { role: "group", "aria-label": "Show" }, children: this._filterButtons }),
                createElement("input", {
                  className: "downloads-app__search",
                  attrs: { type: "search", placeholder: "Search downloads", "aria-label": "Search downloads" },
                  on: { input: (e) => this._list.setQuery(e.target.value) },
                }),
              ],
            }),
          ],
        }),
        createElement("div", { className: "downloads-app__list", children: [this._list.getElement()] }),
        createElement("footer", {
          className: "downloads-app__footer",
          children: [
            this._summaryEl,
            createElement("button", {
              className: "downloads-app__button",
              attrs: { type: "button" },
              children: [createIconElement("icon:folder"), createElement("span", { text: "Open Downloads folder" })],
              on: { click: () => downloadService.showInFolder() },
            }),
            this._clearButton,
          ],
        }),
      ],
    });

    this._cleanups.push(eventBus.on("downloads:changed", ({ reason }) => reason !== "progress" && this._renderSummary()));
    this._renderSummary();
    if (options.select) queueMicrotask(() => this._list.select(options.select));

    return { element: this._root, title: "Downloads", icon: "icon:download", width: 640, height: 520, minWidth: 420, minHeight: 320 };
  }

  /**
   * @param {{select?: string}} [options]
   * @returns {void}
   */
  onRelaunch(options = {}) {
    if (options.select) {
      this._setFilter("all");
      this._list.select(options.select);
    }
  }

  /** @returns {void} */
  close() {
    this._list.destroy();
    for (const cleanup of this._cleanups) cleanup();
    this._cleanups = [];
  }

  /**
   * @param {string} filter
   * @returns {void}
   */
  _setFilter(filter) {
    this._filter = filter;
    for (const button of this._filterButtons) button.setAttribute("aria-pressed", String(button.dataset.filter === filter));
    this._list.setFilter(filter);
  }

  /** @returns {Promise<void>} */
  async _downloadFromField() {
    const value = this._urlInput.value.trim();
    if (!value) return;
    const url = /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`;
    try {
      const id = downloadService.download(url, { source: "downloads" });
      this._urlInput.value = "";
      this._setFilter("all");
      this._list.select(id);
    } catch (error) {
      await showMessageDialog({ title: "Can't download this address", message: error.message });
    }
  }

  /** @returns {void} */
  _renderSummary() {
    const all = downloadService.getDownloads();
    const active = all.filter((record) => ["pending", "downloading", "saving"].includes(record.status)).length;
    const finished = all.length - active;
    this._summaryEl.textContent = all.length === 0 ? "No downloads" : `${active} in progress \u00b7 ${finished} finished`;
    this._clearButton.disabled = finished === 0;
  }
}
