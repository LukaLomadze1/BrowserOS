/**
 * @file MessageDialog — a titled message with a single dismiss
 * button, for errors and other information that must be acknowledged.
 * The BrowserOS-styled replacement for `window.alert()`.
 */

import { openDialog } from "./dialog.js";
import { createElement } from "../../utils/dom.js";

/**
 * @param {object} config
 * @param {string} config.title
 * @param {string} config.message
 * @param {string} [config.detail] - Secondary text, e.g. a technical reason.
 * @param {string} [config.buttonLabel]
 * @returns {Promise<void>} Resolves once dismissed.
 */
export async function showMessageDialog({ title, message, detail, buttonLabel = "OK" }) {
  const children = [createElement("p", { className: "dialog__message", text: message })];
  if (detail) children.push(createElement("p", { className: "dialog__message dialog__message--detail", text: detail }));

  await openDialog({
    title,
    role: "alertdialog",
    bodyElement: createElement("div", { children }),
    buttons: [{ label: buttonLabel, value: true, variant: "primary", autofocus: true }],
  });
}
