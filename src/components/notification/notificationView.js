/**
 * @file NotificationView — renders the notification stack. Holds no
 * notification state of its own: NotificationService tells it what to
 * add and remove, and it reports clicks and hover back.
 *
 * Regular notifications live in a polite live region; alarm-urgency
 * notifications use role="alert" so they are announced immediately.
 */

import { createElement } from "../../utils/dom.js";
import { getMotionDuration } from "../../utils/motion.js";

const EXIT_GRACE_MS = 40;

class NotificationView {
  constructor() {
    /** @type {Map<string, HTMLElement>} */
    this._items = new Map();
    this._el = createElement("section", {
      className: "notification-stack",
      attrs: { "aria-label": "Notifications", role: "region" },
    });
    this._liveEl = createElement("div", { className: "notification-stack__list", attrs: { "aria-live": "polite" } });
    this._el.append(this._liveEl);
  }

  /** @returns {HTMLElement} */
  getElement() {
    return this._el;
  }

  /**
   * @param {string} id
   * @param {object} config
   * @param {string} config.title
   * @param {string} config.body
   * @param {string} config.icon
   * @param {"normal"|"alarm"} config.urgency
   * @param {Array<{id: string, label: string, primary?: boolean}>} config.actions
   * @param {(actionId: string) => void} config.onAction
   * @param {() => void} config.onDismiss
   * @param {(hovering: boolean) => void} config.onHoverChange
   * @returns {void}
   */
  add(id, config) {
    const titleId = `${id}-title`;
    const actions = config.actions.map((action) =>
      createElement("button", {
        className: `notification__action${action.primary ? " notification__action--primary" : ""}`,
        attrs: { type: "button" },
        text: action.label,
        on: { click: () => config.onAction(action.id) },
      })
    );

    const el = createElement("div", {
      className: `notification notification--${config.urgency}`,
      attrs: {
        role: config.urgency === "alarm" ? "alert" : "status",
        "aria-labelledby": titleId,
        "data-notification-id": id,
      },
      children: [
        createElement("span", { className: "notification__icon", attrs: { "aria-hidden": "true" }, text: config.icon }),
        createElement("div", {
          className: "notification__content",
          children: [
            createElement("p", { className: "notification__title", attrs: { id: titleId }, text: config.title }),
            ...(config.body ? [createElement("p", { className: "notification__body", text: config.body })] : []),
            ...(actions.length > 0 ? [createElement("div", { className: "notification__actions", children: actions })] : []),
          ],
        }),
        createElement("button", {
          className: "notification__close",
          attrs: { type: "button", "aria-label": `Dismiss ${config.title}` },
          text: "\u2715",
          on: { click: () => config.onDismiss() },
        }),
      ],
      on: {
        pointerenter: () => config.onHoverChange(true),
        pointerleave: () => config.onHoverChange(false),
        focusin: () => config.onHoverChange(true),
        focusout: () => config.onHoverChange(false),
      },
    });

    this._items.set(id, el);
    this._liveEl.prepend(el);
    requestAnimationFrame(() => el.classList.add("notification--visible"));
  }

  /**
   * @param {string} id
   * @returns {void}
   */
  remove(id) {
    const el = this._items.get(id);
    if (!el) return;
    this._items.delete(id);
    el.classList.remove("notification--visible");
    el.classList.add("notification--leaving");
    window.setTimeout(() => el.remove(), getMotionDuration("normal") + EXIT_GRACE_MS);
  }
}

export { NotificationView };
