/**
 * @file Notice pages — what a tab shows instead of a blank frame: a
 * site that refuses to be displayed inside BrowserOS, an address that
 * can't be opened, a page that didn't respond, or a missing file.
 * Every notice keeps the original address and offers a way forward.
 */

import { createElement } from "../../../utils/dom.js";
import { createIconElement } from "../../../utils/icons.js";

/**
 * @typedef {object} NoticeAction
 * @property {string} label
 * @property {() => void} onClick
 * @property {boolean} [primary]
 */

export class NoticePage {
  /**
   * @param {object} config
   * @param {string} config.icon
   * @param {string} config.title
   * @param {string[]} config.paragraphs
   * @param {string|null} [config.url] - Shown so the address is never lost.
   * @param {NoticeAction[]} [config.actions]
   * @param {"info"|"warning"|"error"} [config.tone]
   */
  constructor({ icon, title, paragraphs, url = null, actions = [], tone = "info" }) {
    this.title = title;
    this._actions = actions.map((action) =>
      createElement("button", {
        className: `browser-button${action.primary ? " browser-button--primary" : ""}`,
        attrs: { type: "button" },
        text: action.label,
        on: { click: action.onClick },
      })
    );
    this.element = createElement("div", {
      className: `browser-notice browser-notice--${tone}`,
      attrs: { role: "region", "aria-label": title },
      children: [
        createElement("div", {
          className: "browser-notice__card",
          children: [
            createIconElement(icon, { className: "browser-notice__icon" }),
            createElement("h1", { className: "browser-notice__title", text: title }),
            ...paragraphs.map((text) => createElement("p", { className: "browser-notice__text", text })),
            ...(url ? [createElement("p", { className: "browser-notice__url", text: url })] : []),
            createElement("div", { className: "browser-notice__actions", children: this._actions }),
          ],
        }),
      ],
    });
  }

  /** @returns {HTMLElement|null} */
  getFocusTarget() {
    return this._actions[0] ?? null;
  }

  /** @returns {void} */
  destroy() {}
}
