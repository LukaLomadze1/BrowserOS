/**
 * @file ConfirmDialog — the BrowserOS-styled replacement for
 * `window.confirm()`. Used before destructive actions the spec flags
 * as needing confirmation (deleting a non-empty folder, deleting
 * multiple items).
 */

import { openDialog } from "./dialog.js";
import { createElement } from "../../utils/dom.js";

/**
 * @param {object} config
 * @param {string} config.title
 * @param {string} config.message
 * @param {string} [config.confirmLabel]
 * @param {string} [config.cancelLabel]
 * @param {boolean} [config.destructive] - Styles the confirm button as a destructive/danger action.
 * @returns {Promise<boolean>} true if confirmed, false if cancelled (Escape, backdrop click, or Cancel).
 */
export async function showConfirmDialog(config) {
  const {
    title,
    message,
    confirmLabel = "Confirm",
    cancelLabel = "Cancel",
    destructive = false,
  } = config;

  const bodyElement = createElement("p", { className: "dialog__message", text: message });

  const result = await openDialog({
    title,
    role: "alertdialog",
    bodyElement,
    buttons: [
      { label: cancelLabel, value: false, variant: "default" },
      { label: confirmLabel, value: true, variant: destructive ? "danger" : "primary", autofocus: true },
    ],
  });

  return result === true;
}
