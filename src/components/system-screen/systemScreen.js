/**
 * @file SystemScreen — a full-window notice that covers the desktop,
 * for situations where BrowserOS can't (or shouldn't) be used in this
 * tab: storage that won't open, another tab holding the session, or a
 * copy of BrowserOS loaded inside itself.
 *
 * It sits above everything else (dialogs included), makes the rest of
 * the page inert, moves focus to its first action, and announces its
 * text to assistive technology. Built with DOM APIs only (no HTML
 * strings), so messages may safely include error text.
 */

import { createElement } from "../../utils/dom.js";
import { createIconElement } from "../../utils/icons.js";

/**
 * @typedef {object} SystemScreenAction
 * @property {string} label
 * @property {() => void} onClick
 * @property {boolean} [primary]
 */

/**
 * @typedef {object} SystemScreenHandle
 * @property {(changes: {title?: string, message?: string, detail?: string|null, status?: string|null, actions?: SystemScreenAction[]}) => void} update
 * @property {() => void} remove
 */

/**
 * @param {object} config
 * @param {string} config.title
 * @param {string} config.message
 * @param {string|null} [config.detail] - Secondary, usually technical, text.
 * @param {string|null} [config.status] - A changing progress line ("Waiting for the other tab…").
 * @param {SystemScreenAction[]} [config.actions]
 * @param {string} [config.icon] - A built-in icon ("icon:<name>"); the BrowserOS mark by default.
 * @returns {SystemScreenHandle}
 */
export function showSystemScreen({ title, message, detail = null, status = null, actions = [], icon = "icon:browseros" }) {
  const titleEl = createElement("h1", { className: "system-screen__title", attrs: { id: "system-screen-title" } });
  const messageEl = createElement("p", { className: "system-screen__message" });
  const detailEl = createElement("p", { className: "system-screen__detail" });
  const statusEl = createElement("p", { className: "system-screen__status", attrs: { role: "status", "aria-live": "polite" } });
  const actionsEl = createElement("div", { className: "system-screen__actions" });

  const card = createElement("div", {
    className: "system-screen__card",
    attrs: { role: "alertdialog", "aria-modal": "true", "aria-labelledby": "system-screen-title", tabindex: "-1" },
    children: [
      createIconElement(icon, { className: `system-screen__icon${icon === "icon:browseros" ? " brand-mark" : ""}` }),
      titleEl,
      messageEl,
      detailEl,
      statusEl,
      actionsEl,
    ],
  });
  const screen = createElement("div", { className: "system-screen", children: [card] });

  const appRoot = document.getElementById("app-root");
  const wasInert = appRoot?.inert ?? false;
  if (appRoot) appRoot.inert = true;
  for (const existing of document.querySelectorAll(".system-screen")) existing.remove();
  document.body.append(screen);

  const state = { title, message, detail, status, actions };
  const render = () => {
    titleEl.textContent = state.title;
    messageEl.textContent = state.message;
    detailEl.textContent = state.detail ?? "";
    detailEl.hidden = !state.detail;
    statusEl.textContent = state.status ?? "";
    statusEl.hidden = !state.status;
    actionsEl.replaceChildren(
      ...state.actions.map((action) =>
        createElement("button", {
          className: `system-screen__button${action.primary ? " system-screen__button--primary" : ""}`,
          attrs: { type: "button" },
          text: action.label,
          on: { click: () => action.onClick() },
        })
      )
    );
    actionsEl.hidden = state.actions.length === 0;
    (actionsEl.querySelector("button") ?? card).focus({ preventScroll: true });
  };
  render();

  return {
    update(changes) {
      Object.assign(state, changes);
      render();
    },
    remove() {
      screen.remove();
      // Stay inert while a dialog still needs the desktop blocked.
      if (appRoot && !document.querySelector(".system-screen")) appRoot.inert = wasInert || appRoot.hasAttribute("data-dialog-inert");
    },
  };
}
