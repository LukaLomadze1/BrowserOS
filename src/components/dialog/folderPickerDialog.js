/**
 * @file FolderPickerDialog — choose a folder from the virtual file
 * system. Built on the generic Dialog shell: it browses with the public
 * VFS API (`list`, `getInfo`) only, never touches storage directly, and
 * resolves with the chosen absolute path or null.
 *
 * Trash and hidden folders are never offered.
 */

import { openDialog } from "./dialog.js";
import { createElement, clearElement } from "../../utils/dom.js";
import { getParentPath } from "../../core/vfs/pathResolver.js";

const TRASH_PATH = "/Trash";

/**
 * @param {object} config
 * @param {import("../../core/vfs/virtualFileSystem.js").vfs} config.vfs
 * @param {string} [config.title]
 * @param {string} [config.initialPath] - Starting folder; falls back to "/" if missing.
 * @returns {Promise<string|null>} The selected folder path, or null if cancelled.
 */
export async function showFolderPickerDialog({ vfs, title = "Choose a folder", initialPath = "/" }) {
  let currentPath = "/";
  try {
    const info = await vfs.getInfo(initialPath);
    if (info.type === "folder" && !isTrash(info.path)) currentPath = info.path;
  } catch {
    // Missing start folder: begin at the root.
  }

  const pathEl = createElement("div", { className: "folder-picker__path", attrs: { "aria-live": "polite" } });
  const upButton = createElement("button", {
    className: "dialog__button dialog__button--default folder-picker__up",
    attrs: { type: "button", "aria-label": "Up one folder" },
    text: "\u2191 Up",
  });
  const listEl = createElement("div", { className: "folder-picker__list", attrs: { role: "list", "aria-label": "Folders" } });

  const render = async (path) => {
    let children = [];
    try {
      children = await vfs.list(path);
    } catch (error) {
      listEl.textContent = error.message;
      return;
    }
    currentPath = path;
    pathEl.textContent = path;
    upButton.disabled = path === "/";

    clearElement(listEl);
    const folders = children.filter((entry) => entry.type === "folder" && !entry.hidden && !isTrash(entry.path));
    if (folders.length === 0) {
      listEl.append(createElement("div", { className: "folder-picker__empty", text: "No subfolders" }));
      return;
    }
    for (const folder of folders) {
      listEl.append(
        createElement("button", {
          className: "folder-picker__item",
          attrs: { type: "button", role: "listitem", "aria-label": `Open ${folder.name}` },
          children: [
            createElement("span", { className: "folder-picker__icon", attrs: { "aria-hidden": "true" }, text: "\u25a4" }),
            createElement("span", { className: "folder-picker__name", text: folder.name }),
          ],
          on: { click: () => render(folder.path).then(() => listEl.querySelector("button")?.focus()) },
        })
      );
    }
  };

  upButton.addEventListener("click", () => {
    if (currentPath === "/") return;
    render(getParentPath(currentPath) ?? "/");
  });

  await render(currentPath);

  const bodyElement = createElement("div", {
    className: "folder-picker",
    children: [
      createElement("div", { className: "folder-picker__toolbar", children: [upButton, pathEl] }),
      listEl,
      createElement("p", { className: "dialog__message folder-picker__hint", text: "Open a folder, then choose \u201cSelect folder\u201d." }),
    ],
  });

  const result = await openDialog({
    title,
    role: "dialog",
    bodyElement,
    buttons: [
      { label: "Cancel", value: null, variant: "default" },
      { label: "Select folder", value: "select", variant: "primary", autofocus: true },
    ],
  });

  return result === "select" ? currentPath : null;
}

/**
 * @param {string} path
 * @returns {boolean}
 */
function isTrash(path) {
  return path === TRASH_PATH || path.startsWith(`${TRASH_PATH}/`);
}
