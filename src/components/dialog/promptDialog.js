/**
 * @file PromptDialog — the BrowserOS-styled replacement for
 * `window.prompt()`: a single labelled text field with validation.
 * Used for renaming (Notes) and any other "enter a name" flow.
 *
 * Validation runs when the user confirms; an error keeps the dialog
 * open, is shown under the field, and is announced to assistive
 * technology.
 */

import { openDialog } from "./dialog.js";
import { createElement } from "../../utils/dom.js";

/**
 * @param {object} config
 * @param {string} config.title
 * @param {string} config.label - Visible field label.
 * @param {string} [config.initialValue]
 * @param {string} [config.confirmLabel]
 * @param {string} [config.placeholder]
 * @param {[number, number]} [config.selection] - Initial selection range (e.g. the stem of a file name).
 * @param {(value: string) => (string|null|Promise<string|null>)} [config.validate] - Returns an error message, or null when valid. Not called for an empty value when `allowEmpty` is set.
 * @param {boolean} [config.allowEmpty] - Accept an empty value (returned as "").
 * @returns {Promise<string|null>} The trimmed value, or null if cancelled.
 */
export async function showPromptDialog(config) {
  const { title, label, initialValue = "", confirmLabel = "OK", placeholder = "", selection, validate, allowEmpty = false } = config;
  const inputId = `prompt-input-${Math.random().toString(36).slice(2)}`;
  const errorId = `${inputId}-error`;

  const input = createElement("input", {
    className: "dialog__input",
    attrs: { id: inputId, type: "text", placeholder, spellcheck: "false", autocomplete: "off", "aria-describedby": errorId },
  });
  input.value = initialValue;
  const errorEl = createElement("p", { className: "dialog__error", attrs: { id: errorId, role: "alert" } });

  const body = createElement("div", {
    className: "dialog__form",
    children: [
      createElement("label", { className: "dialog__label", attrs: { for: inputId }, text: label }),
      input,
      errorEl,
    ],
  });

  requestAnimationFrame(() => {
    if (selection) {
      input.setSelectionRange(selection[0], selection[1]);
    } else {
      input.select();
    }
  });

  const result = await openDialog({
    title,
    role: "dialog",
    bodyElement: body,
    initialFocus: input,
    submitValue: "confirm",
    buttons: [
      { label: "Cancel", value: null, variant: "default" },
      { label: confirmLabel, value: "confirm", variant: "primary" },
    ],
    onBeforeClose: async () => {
      const value = input.value.trim();
      let message = null;
      if (value === "") {
        message = allowEmpty ? null : "Enter a value.";
      } else if (validate) {
        message = await validate(value);
      }
      errorEl.textContent = message ?? "";
      input.setAttribute("aria-invalid", message ? "true" : "false");
      if (message) input.focus();
      return !message;
    },
  });

  return result === "confirm" ? input.value.trim() : null;
}
