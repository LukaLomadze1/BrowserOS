/**
 * @file DownloadList — the list of downloads with progress and actions,
 * shared by the Downloads app and the Browser (toolbar panel, sidebar).
 *
 * Each row shows the file name, status, size, measured speed, time
 * remaining (only when the size is known), destination, times, and
 * error details. Progress bars are determinate only when the server
 * reported the size; otherwise they show activity without a percentage.
 * Actions: Cancel (in progress); Open, Show in folder (completed); Retry
 * and, for blocked requests, "Download with your browser" (failed);
 * Remove from list.
 *
 * Rows are keyed by download id and updated in place on
 * "downloads:changed", so progress updates don't rebuild the list.
 */

import { createElement } from "../../utils/dom.js";
import { createIconElement } from "../../utils/icons.js";
import { eventBus } from "../../core/eventBus.js";
import { downloadService, formatSize } from "../../core/downloads/downloadService.js";
import { showMessageDialog } from "../dialog/messageDialog.js";

const STATUS_LABELS = Object.freeze({
  pending: "Starting\u2026",
  downloading: "Downloading",
  saving: "Saving to /Downloads\u2026",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  interrupted: "Interrupted",
});
const FILTERS = Object.freeze({
  all: () => true,
  active: (record) => ["pending", "downloading", "saving"].includes(record.status),
  completed: (record) => record.status === "completed",
  failed: (record) => ["failed", "cancelled", "interrupted"].includes(record.status),
});

export class DownloadList {
  /**
   * @param {object} [options]
   * @param {boolean} [options.compact] - Fewer details (Browser panels).
   * @param {number} [options.limit] - Show at most this many.
   * @param {string} [options.emptyText]
   */
  constructor({ compact = false, limit = Infinity, emptyText = "No downloads yet. Files you download are saved to /Downloads." } = {}) {
    this._compact = compact;
    this._limit = limit;
    this._filter = "all";
    this._query = "";
    this._selectedId = null;
    /** @type {Map<string, object>} */
    this._rows = new Map();
    this._listEl = createElement("ul", { className: "download-list__items", attrs: { "aria-label": "Downloads" } });
    this._emptyEl = createElement("p", { className: "download-list__empty", text: emptyText });
    this._el = createElement("div", { className: `download-list${compact ? " download-list--compact" : ""}`, children: [this._listEl, this._emptyEl] });
    this._cleanup = eventBus.on("downloads:changed", ({ id, reason }) => {
      if (reason === "progress" && id && this._rows.has(id)) this._updateRow(id);
      else this.render();
    });
    this.render();
  }

  /** @returns {HTMLElement} */
  getElement() {
    return this._el;
  }

  /**
   * @param {"all"|"active"|"completed"|"failed"} filter
   * @returns {void}
   */
  setFilter(filter) {
    this._filter = Object.hasOwn(FILTERS, filter) ? filter : "all";
    this.render();
  }

  /**
   * @param {string} query
   * @returns {void}
   */
  setQuery(query) {
    this._query = query.trim().toLowerCase();
    this.render();
  }

  /**
   * Highlight a download and scroll it into view.
   * @param {string|null} id
   * @returns {void}
   */
  select(id) {
    this._selectedId = id;
    for (const [rowId, row] of this._rows) row.el.classList.toggle("download-item--selected", rowId === id);
    this._rows.get(id)?.el.scrollIntoView({ block: "nearest" });
  }

  /** @returns {void} */
  destroy() {
    this._cleanup();
  }

  /** @returns {void} */
  render() {
    const records = downloadService
      .getDownloads()
      .filter(FILTERS[this._filter])
      .filter((record) => !this._query || record.filename.toLowerCase().includes(this._query) || record.url.toLowerCase().includes(this._query))
      .slice(0, this._limit);
    const live = new Set(records.map((record) => record.id));
    for (const [id, row] of this._rows) {
      if (!live.has(id)) {
        row.el.remove();
        this._rows.delete(id);
      }
    }
    const ordered = records.map((record) => this._row(record).el);
    const current = [...this._listEl.children];
    if (current.length !== ordered.length || current.some((el, index) => el !== ordered[index])) this._listEl.replaceChildren(...ordered);
    this._emptyEl.hidden = records.length > 0;
  }

  // ---------------------------------------------------------------
  // Rows
  // ---------------------------------------------------------------

  /**
   * @param {object} record
   * @returns {object}
   */
  _row(record) {
    let row = this._rows.get(record.id);
    if (!row) {
      const nameEl = createElement("span", { className: "download-item__name" });
      const statusEl = createElement("span", { className: "download-item__status" });
      const progressFill = createElement("span", { className: "download-item__progress-fill" });
      const progressEl = createElement("span", {
        className: "download-item__progress",
        attrs: { role: "progressbar", "aria-label": "Download progress" },
        children: [progressFill],
      });
      const detailsEl = createElement("span", { className: "download-item__details" });
      const errorEl = createElement("span", { className: "download-item__error", attrs: { role: "status" } });
      const actionsEl = createElement("span", { className: "download-item__actions" });
      const el = createElement("li", {
        className: "download-item",
        attrs: { "data-download-id": record.id },
        children: [
          createIconElement("icon:file", { className: "download-item__icon" }),
          createElement("span", { className: "download-item__body", children: [nameEl, statusEl, progressEl, detailsEl, errorEl] }),
          actionsEl,
        ],
      });
      row = { el, nameEl, statusEl, progressEl, progressFill, detailsEl, errorEl, actionsEl, actionsKey: "" };
      this._rows.set(record.id, row);
    }
    this._fill(row, record);
    return row;
  }

  /**
   * @param {string} id
   * @returns {void}
   */
  _updateRow(id) {
    const record = downloadService.getDownload(id);
    const row = this._rows.get(id);
    if (record && row) this._fill(row, record);
  }

  /**
   * @param {object} row
   * @param {object} record
   * @returns {void}
   */
  _fill(row, record) {
    setText(row.nameEl, record.filename);
    row.nameEl.title = record.url;
    row.el.dataset.status = record.status;
    row.el.classList.toggle("download-item--selected", record.id === this._selectedId);
    setText(row.statusEl, describeStatus(record));

    const active = record.status === "downloading" || record.status === "pending" || record.status === "saving";
    row.progressEl.hidden = !active;
    if (active) {
      const known = record.totalBytes !== null && record.totalBytes > 0 && record.status === "downloading";
      row.progressEl.classList.toggle("download-item__progress--indeterminate", !known);
      if (known) {
        const percent = Math.min(100, Math.floor((record.receivedBytes / record.totalBytes) * 100));
        row.progressFill.style.width = `${percent}%`;
        row.progressEl.setAttribute("aria-valuenow", String(percent));
        row.progressEl.setAttribute("aria-valuemin", "0");
        row.progressEl.setAttribute("aria-valuemax", "100");
        row.progressEl.removeAttribute("aria-valuetext");
      } else {
        row.progressFill.style.width = "";
        row.progressEl.removeAttribute("aria-valuenow");
        row.progressEl.setAttribute("aria-valuetext", `${formatSize(record.receivedBytes)} received, size unknown`);
      }
    }

    if (this._compact) {
      row.detailsEl.hidden = true;
    } else {
      const parts = [];
      if (record.path) parts.push(`Saved to ${record.path}`);
      else parts.push(`From ${hostOf(record.url)}`);
      parts.push(`Started ${formatTime(record.startedAt)}`);
      if (record.completedAt && record.status === "completed") parts.push(`finished ${formatTime(record.completedAt)}`);
      if (record.private) parts.push("private window");
      setText(row.detailsEl, parts.join(" \u00b7 "));
    }
    row.errorEl.hidden = !record.error || record.status === "completed";
    setText(row.errorEl, record.error && record.status !== "completed" ? record.error : "");

    const key = `${record.status}:${record.errorKind ?? ""}`;
    if (row.actionsKey !== key) {
      row.actionsKey = key;
      row.actionsEl.replaceChildren(...this._actions(record));
    }
  }

  /**
   * @param {object} record
   * @returns {HTMLElement[]}
   */
  _actions(record) {
    const button = (label, icon, onClick, variant = "") =>
      createElement("button", {
        className: `download-item__action${variant ? ` download-item__action--${variant}` : ""}`,
        attrs: { type: "button", "aria-label": `${label}: ${record.filename}`, title: label },
        children: [createIconElement(icon), ...(this._compact ? [] : [createElement("span", { text: label })])],
        on: { click: onClick },
      });
    const remove = button("Remove from list", "icon:close", () => downloadService.remove(record.id));
    switch (record.status) {
      case "pending":
      case "downloading":
      case "saving":
        return [button("Cancel", "icon:close", () => downloadService.cancel(record.id), "danger")];
      case "completed":
        return [
          button("Open", "icon:external", async () => {
            if (!(await downloadService.openFile(record.id))) {
              await showMessageDialog({ title: "File not found", message: `"${record.filename}" was moved or deleted from ${record.path ?? "/Downloads"}.` });
            }
          }),
          button("Show in folder", "icon:folder", () => downloadService.showInFolder(record.id)),
          remove,
        ];
      default: {
        const actions = [button("Retry", "icon:reload", () => downloadService.retry(record.id))];
        if (record.errorKind === "network") {
          actions.push(button("Download with your browser", "icon:download", () => downloadService.downloadWithHostBrowser(record.url, record.filename)));
        }
        actions.push(remove);
        return actions;
      }
    }
  }
}

/**
 * @param {object} record
 * @returns {string}
 */
export function describeStatus(record) {
  if (record.status === "downloading") {
    const parts = [];
    parts.push(record.totalBytes ? `${formatSize(record.receivedBytes)} of ${formatSize(record.totalBytes)}` : `${formatSize(record.receivedBytes)} \u00b7 size unknown`);
    if (record.speed) parts.push(`${formatSize(record.speed)}/s`);
    if (record.speed && record.totalBytes) {
      const seconds = Math.ceil((record.totalBytes - record.receivedBytes) / record.speed);
      if (Number.isFinite(seconds) && seconds >= 0) parts.push(seconds < 60 ? `${seconds} s left` : `${Math.ceil(seconds / 60)} min left`);
    }
    return parts.join(" \u00b7 ");
  }
  if (record.status === "completed") return `${formatSize(record.totalBytes ?? record.receivedBytes)} \u00b7 ${STATUS_LABELS.completed}`;
  return STATUS_LABELS[record.status] ?? record.status;
}

/**
 * @param {HTMLElement} el
 * @param {string} text
 * @returns {void}
 */
function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

/**
 * @param {string} url
 * @returns {string}
 */
function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * @param {number} at
 * @returns {string}
 */
function formatTime(at) {
  const date = new Date(at);
  const today = new Date().toDateString() === date.toDateString();
  return today ? date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : date.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}
