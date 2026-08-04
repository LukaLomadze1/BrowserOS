/**
 * @file vfsOpener — the single place that decides what happens when a
 * VFS file or folder is opened. The Desktop (double-click/Enter),
 * File Explorer (double-click on a child), the Start Menu (recent
 * files), and Terminal (`explorer`/`open` commands) all call this
 * instead of each implementing their own copy of "folder → Explorer,
 * .txt → Notes, anything else → properties" routing.
 *
 * File Explorer and per-file Notes windows are opened through
 * dynamically-registered, per-path AppManager app ids
 * (`file-explorer:<path>`, `notes:<path>`), registered with
 * `dynamic: true` — these represent "a file/folder window is open",
 * not "the user picked an application", so StartMenuManager keeps
 * them out of Recent Applications. This deliberately reuses
 * AppManager's existing singleInstance dedup instead of adding a new
 * one: opening the same folder/file twice focuses the existing
 * window, while different paths each get their own. The tradeoff is
 * that a renamed/moved path's old composite id stays registered but
 * unreachable — harmless for a client-side, single-session app.
 * ("Open in New Window" in Explorer's context menu bypasses this and
 * launches the base, multi-instance "file-explorer" id directly, so
 * it always gets a genuinely new window.)
 *
 * Opening a FILE (not a folder) is also the single point where
 * RecentFilesService records it — one call site, so "recent files"
 * can never fall out of sync with what "opening a file" actually
 * means.
 */

import { getBaseName } from "./pathResolver.js";
import { showPropertiesDialog } from "../../components/dialog/propertiesDialog.js";
import { formatBytes, formatDate } from "../../utils/format.js";

/**
 * @param {object} entry - A VFS entry (file or folder).
 * @param {{appManager: import("../appManager.js").AppManager, recentFilesService?: import("../recentFilesService.js").RecentFilesService}} deps
 * @returns {Promise<void>}
 */
export async function openVfsEntry(entry, { appManager, recentFilesService }) {
  if (entry.type === "folder") {
    await openInExplorer(entry.path, appManager);
    return;
  }

  recentFilesService?.add(entry);

  if (entry.extension === "txt") {
    await openTextFile(entry.path, appManager);
    return;
  }

  await showUnsupportedFileProperties(entry);
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
 * @param {string} path
 * @param {import("../appManager.js").AppManager} appManager
 * @returns {Promise<void>}
 */
async function openTextFile(path, appManager) {
  const appId = `notes:${path}`;
  if (!appManager.isRegistered(appId)) {
    appManager.register({
      id: appId,
      name: getBaseName(path),
      icon: "\u270e",
      singleInstance: true,
      dynamic: true,
      loader: () => import("../../apps/notes/main.js"),
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
    ],
  });
}
