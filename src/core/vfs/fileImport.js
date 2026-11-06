/**
 * @file fileImport — copies files from the host computer (a file
 * picker or drag-and-drop) into the virtual file system, through the
 * public VFS API only.
 *
 * Supported types:
 *  - binary images (png, jpg, jpeg, webp, gif) are stored as Blobs;
 *  - text formats (txt, md, note, svg, json, csv) are stored as text.
 * Other types are rejected with a reason rather than stored in a form
 * no BrowserOS application could read. Name collisions get a
 * "name (2).ext" suffix instead of overwriting anything.
 */

import { isBinaryExtension } from "./entry.js";
import { getExtension } from "./pathResolver.js";

/** Text formats imported as strings. */
const TEXT_EXTENSIONS = new Set(["txt", "md", "note", "svg", "json", "csv"]);
/** Largest file accepted, to keep IndexedDB usage reasonable. */
export const MAX_IMPORT_BYTES = 25 * 1024 * 1024;

/**
 * @param {string} name
 * @returns {boolean} Whether a host file with this name can be imported.
 */
export function isImportable(name) {
  const extension = getExtension(name);
  return extension !== null && (isBinaryExtension(extension) || TEXT_EXTENSIONS.has(extension));
}

/**
 * @param {import("./virtualFileSystem.js").vfs} vfs
 * @param {string} folderPath - Destination folder.
 * @param {Iterable<File>} files
 * @returns {Promise<{imported: object[], skipped: Array<{name: string, reason: string}>}>}
 */
export async function importHostFiles(vfs, folderPath, files) {
  const imported = [];
  const skipped = [];
  const siblings = await vfs.list(folderPath);
  const takenNames = new Set(siblings.map((entry) => entry.name.toLowerCase()));

  for (const file of files) {
    const extension = getExtension(file.name);
    if (!isImportable(file.name)) {
      skipped.push({ name: file.name, reason: "Unsupported file type" });
      continue;
    }
    if (file.size > MAX_IMPORT_BYTES) {
      skipped.push({ name: file.name, reason: `Larger than ${Math.round(MAX_IMPORT_BYTES / 1024 / 1024)} MB` });
      continue;
    }

    const name = uniqueName(file.name, takenNames);
    const target = folderPath === "/" ? `/${name}` : `${folderPath}/${name}`;
    try {
      const content = isBinaryExtension(extension) ? file : await file.text();
      imported.push(await vfs.createFile(target, content));
      takenNames.add(name.toLowerCase());
    } catch (error) {
      skipped.push({ name: file.name, reason: error.message });
    }
  }

  return { imported, skipped };
}

/**
 * @param {string} name
 * @param {Set<string>} takenLowerCase
 * @returns {string}
 */
function uniqueName(name, takenLowerCase) {
  if (!takenLowerCase.has(name.toLowerCase())) return name;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let counter = 2; ; counter += 1) {
    const candidate = `${stem} (${counter})${ext}`;
    if (!takenLowerCase.has(candidate.toLowerCase())) return candidate;
  }
}
