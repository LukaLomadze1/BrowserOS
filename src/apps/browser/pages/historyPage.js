/**
 * @file History page (browseros://history) — visits grouped by day,
 * with search, removal of single visits, and "Clear browsing data" for
 * a chosen time range.
 */

import { createElement } from "../../../utils/dom.js";
import { createIconElement } from "../../../utils/icons.js";
import { eventBus } from "../../../core/eventBus.js";
import { historyService } from "../../../core/browser/historyService.js";
import { showClearBrowsingDataDialog } from "../../../components/dialog/clearBrowsingDataDialog.js";
import { createFavicon } from "../favicon.js";

const MAX_SHOWN = 400;

export class HistoryPage {
  /**
   * @param {{private: boolean, navigate: (url: string, options?: {newTab?: boolean}) => void}} ctx
   */
  constructor(ctx) {
    this.title = "History";
    this._ctx = ctx;
    this._query = "";
    this._listEl = createElement("div", { className: "browser-page__list" });
    this._countEl = createElement("p", { className: "browser-page__note", attrs: { role: "status" } });
    this._searchInput = createElement("input", {
      className: "browser-page__search",
      attrs: { type: "search", placeholder: "Search history", "aria-label": "Search history" },
      on: {
        input: () => {
          this._query = this._searchInput.value;
          this.render();
        },
      },
    });
    this.element = createElement("div", {
      className: "browser-page",
      children: [
        createElement("header", {
          className: "browser-page__header",
          children: [
            createElement("h1", { className: "browser-page__title", text: "History" }),
            this._searchInput,
            createElement("button", {
              className: "browser-button",
              attrs: { type: "button" },
              children: [createIconElement("icon:trash"), createElement("span", { text: "Clear browsing data\u2026" })],
              on: { click: () => showClearBrowsingDataDialog() },
            }),
          ],
        }),
        ...(ctx.private ? [createElement("p", { className: "browser-page__banner", text: "This is a private window: pages you visit here aren't added to history." })] : []),
        this._countEl,
        this._listEl,
      ],
    });
    this._cleanup = eventBus.on("browser:historyChanged", () => this.render());
    this.render();
  }

  /** @returns {HTMLElement} */
  getFocusTarget() {
    return this._searchInput;
  }

  /** @returns {void} */
  destroy() {
    this._cleanup();
  }

  /** @returns {void} */
  render() {
    const visits = historyService.getVisits({ query: this._query, limit: MAX_SHOWN + 1 });
    const shown = visits.slice(0, MAX_SHOWN);
    const groups = new Map();
    for (const visit of shown) {
      const label = dayLabel(visit.at);
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push(visit);
    }
    const sections = [...groups].map(([label, items]) =>
      createElement("section", {
        className: "browser-page__group",
        children: [
          createElement("h2", { className: "browser-page__group-title", text: label }),
          createElement("ul", {
            className: "browser-page__rows",
            children: items.map((visit) =>
              createElement("li", {
                className: "browser-row",
                children: [
                  createElement("span", { className: "browser-row__time", text: new Date(visit.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) }),
                  createElement("button", {
                    className: "browser-row__main",
                    attrs: { type: "button", title: visit.url },
                    children: [
                      createFavicon(visit.url, visit.favicon),
                      createElement("span", { className: "browser-row__title", text: visit.title }),
                      createElement("span", { className: "browser-row__meta", text: shortUrl(visit.url) }),
                    ],
                    on: {
                      click: (e) => this._ctx.navigate(visit.url, { newTab: e.ctrlKey || e.metaKey }),
                      auxclick: (e) => e.button === 1 && this._ctx.navigate(visit.url, { newTab: true }),
                    },
                  }),
                  createElement("button", {
                    className: "browser-icon-button",
                    attrs: { type: "button", "aria-label": `Remove ${visit.title} at ${new Date(visit.at).toLocaleTimeString()} from history`, title: "Remove from history" },
                    children: [createIconElement("icon:close")],
                    on: { click: () => historyService.removeVisit(visit.url, visit.at) },
                  }),
                ],
              })
            ),
          }),
        ],
      })
    );
    this._listEl.replaceChildren(
      ...(sections.length
        ? sections
        : [createElement("p", { className: "browser-page__empty", text: this._query ? "No history matches your search." : "Your browsing history is empty." })])
    );
    this._countEl.textContent = visits.length > MAX_SHOWN ? `Showing the ${MAX_SHOWN} most recent visits${this._query ? " that match" : ""}.` : "";
    this._countEl.hidden = !this._countEl.textContent;
  }
}

/**
 * @param {number} at
 * @returns {string}
 */
function dayLabel(at) {
  const date = new Date(at);
  const today = new Date();
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  if (at >= startOfToday) return "Today";
  if (at >= startOfToday - 86_400_000) return "Yesterday";
  return date.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: date.getFullYear() === today.getFullYear() ? undefined : "numeric" });
}

/**
 * @param {string} url
 * @returns {string}
 */
function shortUrl(url) {
  return url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");
}
