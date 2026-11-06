/**
 * @file NotificationView — renders notification banners. Holds no
 * notification state of its own: NotificationService tells it what to
 * add and remove, and it reports clicks and hover back.
 *
 * Each banner is a container with three separate controls: the main
 * area (a button that opens the notification), optional action
 * buttons, and a close button — never nested interactive elements.
 * Regular banners use role="status" in a polite live region; alarms use
 * role="alert" so they are announced immediately.
 */

import { createElement } from "../../utils/dom.js";
import { createIconElement } from "../../utils/icons.js";
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
   * @param {string} config.message - Empty when previews are hidden.
   * @param {string} config.icon
   * @param {"info"|"success"|"warning"|"error"} config.type
   * @param {"normal"|"alarm"} config.urgency
   * @param {string} config.sourceName
   * @param {number} config.count - How many grouped notifications this banner stands for.
   * @param {Array<{id: string, label: string, primary?: boolean}>} config.actions
   * @param {() => void} config.onActivate
   * @param {(actionId: string) => void} config.onAction
   * @param {() => void} config.onDismiss
   * @param {(hovering: boolean) => void} config.onHoverChange
   * @returns {void}
   */
  add(id, config) {
    const titleId = `${id}-title`;
    const bodyId = `${id}-body`;
    const meta = config.count > 1 ? `${config.sourceName} \u00b7 ${config.count} notifications` : config.sourceName;

    const main = createElement("button", {
      className: "notification__main",
      attrs: { type: "button", "aria-describedby": config.message ? bodyId : null },
      children: [
        createIconElement(config.icon, { className: "notification__icon" }),
        createElement("span", {
          className: "notification__content",
          children: [
            createElement("span", { className: "notification__meta", text: meta }),
            createElement("span", { className: "notification__title", attrs: { id: titleId }, text: config.title }),
            ...(config.message ? [createElement("span", { className: "notification__body", attrs: { id: bodyId }, text: config.message })] : []),
          ],
        }),
      ],
      on: { click: () => config.onActivate() },
    });

    const actions = config.actions.map((action) =>
      createElement("button", {
        className: `notification__action${action.primary ? " notification__action--primary" : ""}`,
        attrs: { type: "button" },
        text: action.label,
        on: { click: () => config.onAction(action.id) },
      })
    );

    const el = createElement("div", {
      className: `notification notification--${config.type} notification--${config.urgency}`,
      attrs: {
        role: config.urgency === "alarm" ? "alert" : "status",
        "aria-labelledby": titleId,
        "data-notification-id": id,
      },
      children: [
        main,
        createElement("button", {
          className: "notification__close",
          attrs: { type: "button", "aria-label": `Dismiss ${config.title}`, title: "Dismiss" },
          children: [createIconElement("icon:close")],
          on: { click: () => config.onDismiss() },
        }),
        ...(actions.length > 0 ? [createElement("div", { className: "notification__actions", children: actions })] : []),
      ],
      on: {
        pointerenter: () => config.onHoverChange(true),
        pointerleave: () => config.onHoverChange(false),
        focusin: () => config.onHoverChange(true),
        focusout: (e) => {
          if (!el.contains(e.relatedTarget)) config.onHoverChange(false);
        },
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
