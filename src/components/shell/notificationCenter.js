/**
 * @file NotificationCenter — the notification history panel opened from
 * the tray's bell button.
 *
 * Shows every recorded notification grouped by the application that
 * sent it, newest first. Within an application, notifications sharing a
 * `groupKey` collapse into one entry with a "N more" toggle. Each entry
 * shows its icon, title, message, time, and an unread dot; clicking it
 * runs the notification's action, and each entry and group can be
 * dismissed. A Do Not Disturb switch and "Clear all" sit in the header.
 *
 * Rendering is incremental: entry elements are cached by notification id
 * and only their changing parts (read state, relative time) are updated.
 * Notifications that were visible while the panel was open are marked
 * read when it closes.
 */

import { createElement } from "../../utils/dom.js";
import { createIconElement } from "../../utils/icons.js";
import { eventBus } from "../../core/eventBus.js";
import { notificationService } from "../../core/notifications/notificationService.js";

export class NotificationCenter {
  /**
   * @param {object} deps
   * @param {(page: string, anchor?: string) => void} deps.openSettings
   * @param {(id: string) => ({icon: string|null}|null)} [deps.getAppIcon]
   * @param {() => void} deps.requestClose - Close the panel (after a notification was opened).
   */
  constructor({ openSettings, getAppIcon, requestClose }) {
    this._openSettings = openSettings;
    this._getAppIcon = getAppIcon ?? (() => null);
    this._requestClose = requestClose;
    this._visible = false;
    this._renderQueued = false;
    /** @type {Map<string, {el: HTMLElement, timeEl: HTMLElement, record: object}>} */
    this._items = new Map();
    /** @type {Set<string>} groupKeys the user expanded */
    this._expanded = new Set();
    this._seenIds = new Set();
    this._cleanups = [];

    this._dndToggle = createElement("button", {
      className: "shell-switch",
      attrs: { type: "button", role: "switch", "aria-checked": "false", "aria-label": "Do Not Disturb" },
      children: [createElement("span", { className: "shell-switch__thumb", attrs: { "aria-hidden": "true" } })],
      on: { click: () => notificationService.setDoNotDisturb(!notificationService.isDoNotDisturb()) },
    });
    this._clearButton = createElement("button", {
      className: "shell-text-button",
      attrs: { type: "button" },
      text: "Clear all",
      on: { click: () => notificationService.clearHistory() },
    });
    this._dndBanner = createElement("p", {
      className: "notification-center__dnd",
      attrs: { hidden: "" },
      children: [
        createIconElement("icon:bell-off"),
        createElement("span", { text: "Do Not Disturb is on. Banners are hidden; notifications still collect here." }),
      ],
    });
    this._listEl = createElement("div", { className: "notification-center__list", attrs: { role: "list", "aria-label": "Notification history" } });
    this._emptyEl = createElement("div", {
      className: "notification-center__empty",
      children: [
        createIconElement("icon:bell", { className: "notification-center__empty-icon" }),
        createElement("p", { className: "notification-center__empty-title", text: "No notifications" }),
        createElement("p", { className: "notification-center__empty-text", text: "Reminders, alarms, and system messages appear here." }),
      ],
    });

    this._el = createElement("div", {
      className: "notification-center",
      children: [
        createElement("header", {
          className: "shell-panel__header",
          children: [
            createElement("h2", { className: "shell-panel__title", text: "Notifications" }),
            createElement("label", {
              className: "notification-center__dnd-label",
              children: [createElement("span", { text: "Do Not Disturb" }), this._dndToggle],
            }),
          ],
        }),
        this._dndBanner,
        this._listEl,
        this._emptyEl,
        createElement("footer", {
          className: "shell-panel__footer",
          children: [
            createElement("button", {
              className: "shell-text-button",
              attrs: { type: "button" },
              text: "Notification settings",
              on: {
                click: () => {
                  this._requestClose();
                  this._openSettings("notifications");
                },
              },
            }),
            this._clearButton,
          ],
        }),
      ],
    });
    // The switch's own aria-label names it; the visible text is decorative.
    this._el.querySelector(".notification-center__dnd-label > span").setAttribute("aria-hidden", "true");

    this._cleanups.push(
      eventBus.on("notification:historyChanged", () => this._queueRender()),
      eventBus.on("system:dndChanged", () => this._renderDnd()),
      eventBus.on("system:clockTick", () => {
        if (this._visible) this._updateTimes();
      })
    );
    this._renderDnd();
    this._render();
  }

  /** @returns {HTMLElement} */
  getElement() {
    return this._el;
  }

  /** @returns {HTMLElement|null} First focusable control for the panel to focus on open. */
  getInitialFocus() {
    return this._listEl.querySelector(".notification-item__main") ?? this._dndToggle;
  }

  /**
   * Called when the panel opens.
   * @returns {void}
   */
  onOpen() {
    this._visible = true;
    this._seenIds.clear();
    this._render();
  }

  /**
   * Called when the panel closes: what was shown counts as read.
   * @returns {void}
   */
  onClose() {
    this._visible = false;
    if (this._seenIds.size > 0) notificationService.markAllAsRead([...this._seenIds]);
    this._seenIds.clear();
  }

  /** @returns {void} */
  destroy() {
    for (const cleanup of this._cleanups) cleanup();
    this._cleanups = [];
  }

  // ---------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------

  /** @returns {void} */
  _queueRender() {
    if (this._renderQueued) return;
    this._renderQueued = true;
    requestAnimationFrame(() => {
      this._renderQueued = false;
      this._render();
    });
  }

  /** @returns {void} */
  _renderDnd() {
    const enabled = notificationService.isDoNotDisturb();
    this._dndToggle.setAttribute("aria-checked", String(enabled));
    this._dndBanner.hidden = !enabled;
  }

  /** @returns {void} */
  _render() {
    const notifications = notificationService.getNotifications();
    const liveIds = new Set(notifications.map((record) => record.id));
    for (const [id, item] of this._items) {
      if (!liveIds.has(id)) {
        item.el.remove();
        this._items.delete(id);
      }
    }

    // Group by source application, ordered by each group's newest notification.
    const groups = new Map();
    for (const record of notifications) {
      if (!groups.has(record.source)) groups.set(record.source, []);
      groups.get(record.source).push(record);
    }

    const groupEls = [];
    for (const [source, records] of groups) {
      groupEls.push(this._buildGroup(source, records));
    }
    this._listEl.replaceChildren(...groupEls);
    this._emptyEl.hidden = notifications.length > 0;
    this._listEl.hidden = notifications.length === 0;
    this._clearButton.disabled = notifications.length === 0;
    if (this._visible) for (const record of notifications) this._seenIds.add(record.id);
  }

  /**
   * @param {string} source
   * @param {object[]} records - Newest first.
   * @returns {HTMLElement}
   */
  _buildGroup(source, records) {
    const first = records[0];
    const unread = records.filter((record) => !record.read).length;
    const appIcon = this._getAppIcon(source)?.icon ?? first.icon;

    // Collapse notifications that share a groupKey: the newest represents them.
    const entries = [];
    const byKey = new Map();
    for (const record of records) {
      if (record.groupKey) {
        const existing = byKey.get(record.groupKey);
        if (existing) {
          existing.others.push(record);
          continue;
        }
        const entry = { record, others: [] };
        byKey.set(record.groupKey, entry);
        entries.push(entry);
      } else {
        entries.push({ record, others: [] });
      }
    }

    const itemEls = [];
    for (const entry of entries) {
      itemEls.push(this._itemElement(entry.record, entry.others.length));
      if (entry.others.length > 0 && this._expanded.has(`${source}:${entry.record.groupKey}`)) {
        for (const other of entry.others) itemEls.push(this._itemElement(other, 0, true));
      }
    }

    const headingId = `notification-group-${cssSafe(source)}`;
    return createElement("section", {
      className: "notification-group",
      attrs: { role: "listitem", "aria-labelledby": headingId },
      children: [
        createElement("header", {
          className: "notification-group__header",
          children: [
            createIconElement(appIcon, { className: "notification-group__icon" }),
            createElement("h3", {
              className: "notification-group__title",
              attrs: { id: headingId },
              text: unread > 0 ? `${first.sourceName} \u00b7 ${unread} new` : first.sourceName,
            }),
            createElement("button", {
              className: "shell-icon-button",
              attrs: { type: "button", "aria-label": `Clear ${first.sourceName} notifications`, title: "Clear" },
              children: [createIconElement("icon:close")],
              on: {
                click: () => {
                  this._keepFocusInPanel();
                  for (const record of records) notificationService.dismiss(record.id);
                },
              },
            }),
          ],
        }),
        createElement("ul", { className: "notification-group__items", children: itemEls }),
      ],
    });
  }

  /**
   * @param {object} record
   * @param {number} collapsedCount - Related notifications hidden behind this one.
   * @param {boolean} [nested] - Shown because its group was expanded.
   * @returns {HTMLElement}
   */
  _itemElement(record, collapsedCount, nested = false) {
    let item = this._items.get(record.id);
    if (!item) {
      const timeEl = createElement("time", { className: "notification-item__time" });
      const main = createElement("button", {
        className: "notification-item__main",
        attrs: { type: "button" },
        children: [
          createIconElement(record.icon, { className: `notification-item__icon notification-item__icon--${record.type}` }),
          createElement("span", {
            className: "notification-item__text",
            children: [
              createElement("span", { className: "notification-item__title", text: record.title }),
              ...(record.message ? [createElement("span", { className: "notification-item__message", text: record.message })] : []),
              timeEl,
            ],
          }),
        ],
        on: { click: () => this._activate(record.id) },
      });
      const dismiss = createElement("button", {
        className: "shell-icon-button notification-item__dismiss",
        attrs: { type: "button", "aria-label": `Dismiss ${record.title}`, title: "Dismiss" },
        children: [createIconElement("icon:close")],
        on: {
          click: () => {
            this._keepFocusInPanel();
            notificationService.dismiss(record.id);
          },
        },
      });
      const el = createElement("li", {
        className: "notification-item",
        attrs: { "data-notification-id": record.id },
        children: [createElement("span", { className: "notification-item__dot", attrs: { "aria-hidden": "true" } }), main, dismiss],
      });
      item = { el, timeEl, main, record };
      this._items.set(record.id, item);
    }
    item.record = record;
    item.el.classList.toggle("notification-item--unread", !record.read);
    item.el.classList.toggle("notification-item--nested", nested);
    item.main.setAttribute("aria-label", `${record.read ? "" : "Unread: "}${record.title}${record.message ? `. ${record.message}` : ""}`);
    this._updateTime(item);

    item.el.querySelector(".notification-item__more")?.remove();
    if (collapsedCount > 0) {
      const key = `${record.source}:${record.groupKey}`;
      const expanded = this._expanded.has(key);
      item.el.append(
        createElement("button", {
          className: "shell-text-button notification-item__more",
          attrs: { type: "button", "aria-expanded": String(expanded) },
          text: expanded ? "Show less" : `${collapsedCount} more`,
          on: {
            click: () => {
              if (this._expanded.has(key)) this._expanded.delete(key);
              else this._expanded.add(key);
              this._render();
            },
          },
        })
      );
    }
    return item.el;
  }

  /**
   * The control being clicked is about to be removed; park focus on the
   * panel so keyboard use (Tab, Escape) continues inside it.
   * @returns {void}
   */
  _keepFocusInPanel() {
    this._el.closest(".shell-panel")?.focus({ preventScroll: true });
  }

  /** @returns {void} */
  _updateTimes() {
    for (const item of this._items.values()) this._updateTime(item);
  }

  /**
   * @param {{timeEl: HTMLElement, record: object}} item
   * @returns {void}
   */
  _updateTime(item) {
    const date = new Date(item.record.timestamp);
    const text = formatRelative(item.record.timestamp);
    if (item.timeEl.textContent !== text) item.timeEl.textContent = text;
    item.timeEl.dateTime = date.toISOString();
    item.timeEl.title = date.toLocaleString();
  }

  /**
   * @param {string} id
   * @returns {Promise<void>}
   */
  async _activate(id) {
    this._requestClose();
    await notificationService.activate(id);
  }
}

/**
 * @param {number} timestamp
 * @returns {string} "Just now", "5 min ago", "2 h ago", "Yesterday", or a date.
 */
export function formatRelative(timestamp) {
  const diff = Date.now() - timestamp;
  if (diff < 60_000) return "Just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  const date = new Date(timestamp);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return `${Math.floor(diff / 3_600_000)} h ago`;
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/**
 * @param {string} value
 * @returns {string}
 */
function cssSafe(value) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-");
}
