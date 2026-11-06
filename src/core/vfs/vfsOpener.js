/**
 * @file vfsOpener — the single place that decides what happens when a
 * VFS file or folder is opened. The Desktop (double-click/Enter and
 * "Open with"), File Explorer (double-click and "Open with"), the Start
 * Menu (recent files and search results), and Terminal (`explorer` /
 * `open`) all call this instead of each implementing their own routing.
 *
 * Folders open in File Explorer through dynamically-registered,
 * per-path AppManager ids (`file-explorer:<path>`, `dynamic: true`), so
 * opening the same folder twice focuses the existing window while
 * different folders each get their own; "Open in New Window" in
 * Explorer's context menu bypasses this and launches the base,
 * multi-instance "file-explorer" id directly.
 *
 * Files open in the application chosen by fileAssociations (or an
 * explicit `appId` for "Open with"), launched with `{ path }`. Each
 * application decides how to handle repeat opens (e.g. Notes is
 * single-instance and switches its open document). Files with no
 * registered handler show their properties instead.
 *
 * Opening a FILE is also the single point where RecentFilesService
 * records it, and where "application:fileOpened" is announced.
 */

import { getBaseName } from "./pathResolver.js";
import { eventBus } from "../eventBus.js";
import { fileAssociations } from "../fileAssociations.js";
import { showPropertiesDialog } from "../../components/dialog/propertiesDialog.js";
import { formatBytes, formatDate } from "../../utils/format.js";

/**
 * @param {object} entry - A VFS entry (file or folder).
 * @param {object} deps
 * @param {import("../appManager.js").AppManager} deps.appManager
 * @param {import("../recentFilesService.js").RecentFilesService} [deps.recentFilesService]
 * @param {string} [deps.appId] - Open with this application instead of the default ("Open with").
 * @returns {Promise<void>}
 */
export async function openVfsEntry(entry, { appManager, recentFilesService, appId }) {
  if (entry.type === "folder") {
    await openInExplorer(entry.path, appManager);
    return;
  }

  recentFilesService?.add(entry);

  const handlerId = appId ?? fileAssociations.getDefault(entry)?.appId ?? null;
  if (handlerId && appManager.isRegistered(handlerId)) {
    await appManager.launch(handlerId, { path: entry.path });
    eventBus.emit("application:fileOpened", Object.freeze({ appId: handlerId, path: entry.path, entryId: entry.id }));
    return;
  }

  await showUnsupportedFileProperties(entry);
}

/**
 * Context-menu entries for "Open with", shared by Desktop and File
 * Explorer so both offer exactly the same choices.
 * @param {object} entry
 * @param {(appId: string) => void} onChoose
 * @returns {Array<{label: string, action: () => void}>} Empty for folders and unassociated files.
 */
export function buildOpenWithItems(entry, onChoose) {
  return fileAssociations.getHandlers(entry).map((handler, index) => ({
    label: index === 0 ? `${handler.label} (default)` : handler.label,
    action: () => onChoose(handler.appId),
  }));
}

/**
 * @param {string} path
 * @param {import("../appManager.js").AppManager} appManager
 * @returns {Promise<void>}
 */
async function openInExplorer(path, appManager) {
  const appId = `file-explorer:${path}`;
  if (!appManager.isRegistered(appId)) {
    appManager.register({
      id: appId,
      name: getBaseName(path),
      icon: "\u25a4",
      singleInstance: true,
      dynamic: true,
      loader: () => import("../../apps/file-explorer/main.js"),
    });
  }
  await appManager.launch(appId, { path });
}

/**
 * @param {object} entry
 * @returns {Promise<void>}
 */
async function showUnsupportedFileProperties(entry) {
  await showPropertiesDialog({
    title: entry.name,
    rows: [
      { label: "Name", value: entry.name },
      { label: "Type", value: entry.extension ? `${entry.extension.toUpperCase()} File` : "File" },
      { label: "Size", value: formatBytes(entry.size) },
      { label: "Path", value: entry.path },
      { label: "Modified", value: formatDate(entry.modifiedAt) },
      { label: "Opens with", value: "No application is registered for this file type" },
    ],
  });
}
