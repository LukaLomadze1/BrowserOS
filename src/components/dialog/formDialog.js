/**
 * @file showFormDialog — a small multi-field form dialog (text, URL, and
 * select fields with validation), built on openDialog() and its form
 * classes so it looks and behaves like every other BrowserOS dialog.
 */

import { openDialog } from "./dialog.js";
import { createElement } from "../../utils/dom.js";

let formCounter = 0;

/**
 * @param {object} config
 * @param {string} config.title
 * @param {Array<{id: string, label: string, type?: "text"|"url"|"select", value?: string, placeholder?: string, options?: Array<{value: string, label: string}>}>} config.fields
 * @param {string} [config.confirmLabel]
 * @param {(values: Record<string, string>) => (string|null|Promise<string|null>)} [config.validate] - Return an error message to keep the dialog open.
 * @returns {Promise<Record<string, string>|null>} Field values, or null when cancelled.
 */
export async function showFormDialog({ title, fields, confirmLabel = "Save", validate }) {
  const formId = `browser-form-${++formCounter}`;
  const controls = new Map();
  const errorEl = createElement("p", { className: "dialog__error", attrs: { role: "alert" } });
  const body = createElement("div", {
    className: "dialog__form",
    children: [
      ...fields.map((field) => {
        const id = `${formId}-${field.id}`;
        let control;
        if (field.type === "select") {
          control = createElement("select", {
            className: "dialog__select",
            attrs: { id },
            children: (field.options ?? []).map((option) => createElement("option", { attrs: { value: option.value }, text: option.label })),
          });
          control.value = field.value ?? field.options?.[0]?.value ?? "";
        } else {
          control = createElement("input", {
            className: "dialog__input",
            attrs: { id, type: field.type === "url" ? "url" : "text", placeholder: field.placeholder ?? "", autocomplete: "off", spellcheck: "false" },
          });
          control.value = field.value ?? "";
        }
        controls.set(field.id, control);
        return createElement("div", {
          className: "dialog__field",
          children: [createElement("label", { className: "dialog__label", attrs: { for: id }, text: field.label }), control],
        });
      }),
      errorEl,
    ],
  });

  let values = null;
  const result = await openDialog({
    title,
    role: "dialog",
    bodyElement: body,
    initialFocus: controls.values().next().value,
    submitValue: "save",
    buttons: [
      { label: "Cancel", value: null, variant: "default" },
      { label: confirmLabel, value: "save", variant: "primary" },
    ],
    onBeforeClose: async (value) => {
      if (value !== "save") return true;
      const current = Object.fromEntries([...controls].map(([id, control]) => [id, control.value.trim()]));
      const error = validate ? await validate(current) : null;
      if (error) {
        errorEl.textContent = error;
        return false;
      }
      values = current;
      return true;
    },
  });
  return result === "save" ? values : null;
}
