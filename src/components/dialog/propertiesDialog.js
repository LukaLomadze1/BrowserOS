/**
 * @file PropertiesDialog — a reusable, read-only key/value display.
 * Used for the desktop item context menu's "Properties" action, for
 * application shortcuts' properties, and for the "unknown file type"
 * open behavior (showing metadata is honest; pretending to open the
 * file would not be).
 */

import { openDialog } from "./dialog.js";
import { createElement } from "../../utils/dom.js";

/**
 * @param {object} config
 * @param {string} config.title
 * @param {Array<{label: string, value: string}>} config.rows
 * @returns {Promise<void>} Resolves once the dialog is closed.
 */
export async function showPropertiesDialog(config) {
  const { title, rows } = config;

  const listEl = createElement("div", { className: "dialog__properties-list" });
  for (const row of rows) {
    listEl.append(
      createElement("div", {
        className: "dialog__properties-row",
        children: [
          createElement("span", { className: "dialog__properties-label", text: row.label }),
          createElement("span", { className: "dialog__properties-value", text: row.value }),
        ],
      })
    );
  }

  await openDialog({
    title,
    role: "dialog",
    bodyElement: listEl,
    buttons: [{ label: "Close", value: true, variant: "primary", autofocus: true }],
  });
}
