/**
 * @file clipboardPaste — the one place "paste" actually happens.
 * Desktop and Explorer both call `pasteClipboard()` instead of each
 * implementing their own copy here, so pasting behaves identically
 * everywhere and a conflict-naming bug only ever needs fixing once.
 *
 * Name conflicts are resolved by generating a safe alternate name
 * (reusing the exact same nameGenerator used for "New Folder (2)"),
 * rather than showing a conflict dialog: silent safe-renaming matches how real desktop OSes behave on
 * paste and never leaves the user staring at a blocking prompt for a
 * multi-item paste.
 */

import { generateDefaultName, splitNameForRename } from "../../utils/nameGenerator.js";

/**
 * @param {import("./virtualFileSystem.js").vfs} vfs
 * @param {import("../clipboardService.js").clipboardService} clipboardService
 * @param {string} destinationPath
 * @returns {Promise<{pasted: object[], errors: Array<{path: string, message: string}>}>}
 */
export async function pasteClipboard(vfs, clipboardService, destinationPath) {
  const record = clipboardService.get();
  if (!record) return { pasted: [], errors: [] };

  const destChildren = await vfs.list(destinationPath);
  const existingNames = destChildren.map((entry) => entry.name);

  const pasted = [];
  const errors = [];

  for (const sourcePath of record.sourcePaths) {
    try {
      if (record.operation === "copy") {
        const result = await pasteCopy(vfs, sourcePath, destinationPath, existingNames);
        pasted.push(result);
        existingNames.push(result.name);
      } else {
        const result = await pasteMove(vfs, sourcePath, destinationPath, existingNames);
        pasted.push(result);
        existingNames.push(result.name);
      }
    } catch (error) {
      errors.push({ path: sourcePath, message: error.message });
    }
  }

  if (record.operation === "cut" && errors.length === 0) {
    clipboardService.clear();
  }

  return { pasted, errors };
}

/**
 * @param {import("./virtualFileSystem.js").vfs} vfs
 * @param {string} sourcePath
 * @param {string} destinationPath
 * @param {string[]} existingNames
 * @returns {Promise<object>}
 */
async function pasteCopy(vfs, sourcePath, destinationPath, existingNames) {
  const info = await vfs.getInfo(sourcePath);
  const finalName = resolveConflictName(info.name, existingNames);
  return finalName === info.name
    ? vfs.copy(sourcePath, destinationPath)
    : vfs.copy(sourcePath, destinationPath, { newName: finalName });
}

/**
 * Cut/move can't ask the VFS to move-with-a-different-name directly,
 * so on conflict this renames the item at its CURRENT location first
 * (which only has to avoid colliding with its current siblings, a
 * completely separate namespace from the destination) and then moves
 * the renamed item.
 * @param {import("./virtualFileSystem.js").vfs} vfs
 * @param {string} sourcePath
 * @param {string} destinationPath
 * @param {string[]} existingNames
 * @returns {Promise<object>}
 */
async function pasteMove(vfs, sourcePath, destinationPath, existingNames) {
  const info = await vfs.getInfo(sourcePath);
  const finalName = resolveConflictName(info.name, existingNames);
  if (finalName === info.name) {
    return vfs.move(sourcePath, destinationPath);
  }
  const renamed = await vfs.rename(sourcePath, finalName);
  return vfs.move(renamed.path, destinationPath);
}

/**
 * @param {string} name
 * @param {string[]} existingNames
 * @returns {string} `name` unchanged if it doesn't collide, otherwise a safe alternate.
 */
function resolveConflictName(name, existingNames) {
  const lowerExisting = new Set(existingNames.map((n) => n.toLowerCase()));
  if (!lowerExisting.has(name.toLowerCase())) return name;

  const { stem, extension } = splitNameForRename(name);
  const ext = extension ? extension.slice(1) : null;
  return generateDefaultName(stem, ext, existingNames);
}
