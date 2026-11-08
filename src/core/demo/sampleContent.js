/**
 * @file Sample files: adding them, and removing them again.
 *
 * The sample set (documents and notes in /Documents, two web projects
 * in /Projects, pictures in /Pictures/Sample Pictures, and a text file
 * in /Downloads) is written through the public VFS API, so it consists
 * of ordinary files the user can open, edit, move, and delete.
 *
 * Rules:
 * - Nothing is ever replaced: a sample whose path already exists is
 *   skipped.
 * - Samples are added only when asked: the Welcome tour offers them
 *   (checked by default only on a new installation, which has no user
 *   files yet), and Settings › System can add them later. They are not
 *   re-created at start-up.
 * - What was added is recorded (path, size, and modification time of
 *   each file, plus the folders created for them). Removing moves only
 *   files that are still unchanged to Trash, whole sample folders as
 *   one item when nothing in them changed; edited, renamed, or moved
 *   files, and anything the user added, are kept.
 */

import { storage } from "../storage.js";
import { getParentPath } from "../vfs/pathResolver.js";
import { SAMPLE_DOCUMENTS } from "./sampleDocuments.js";
import { SAMPLE_PROJECT_FILES } from "./sampleProjects.js";
import { getSamplePictures } from "./samplePictures.js";

const MANIFEST_KEY = "sampleContent:manifest";
const REMOVED_KEY = "sampleContent:removedAt";
const MANIFEST_VERSION = 1;

/**
 * @typedef {object} SampleManifest
 * @property {number} version
 * @property {number} installedAt
 * @property {Array<{path: string, size: number, modifiedAt: number}>} files
 * @property {string[]} folders - Folders created for the samples, parents first.
 */

/**
 * @typedef {object} SampleItem
 * @property {string} path
 * @property {() => Promise<Blob|string|null>} content
 */

/** @returns {SampleItem[]} Every sample file, in the order it is written. */
function sampleItems() {
  return [
    ...SAMPLE_DOCUMENTS.map(({ path, text }) => ({ path, content: async () => text })),
    ...SAMPLE_PROJECT_FILES.map(({ path, text }) => ({ path, content: async () => text })),
    ...getSamplePictures().map(({ path, render }) => ({ path, content: render })),
  ];
}

class SampleContent {
  /** @returns {SampleManifest|null} */
  getManifest() {
    const manifest = storage.get(MANIFEST_KEY, null);
    if (!manifest || manifest.version !== MANIFEST_VERSION || !Array.isArray(manifest.files)) return null;
    return manifest;
  }

  /**
   * @returns {{installed: boolean, fileCount: number, installedAt: number|null, removedAt: number|null}}
   */
  getState() {
    const manifest = this.getManifest();
    return {
      installed: !!manifest && manifest.files.length > 0,
      fileCount: manifest?.files.length ?? 0,
      installedAt: manifest?.installedAt ?? null,
      removedAt: storage.get(REMOVED_KEY, null),
    };
  }

  /** @returns {number} How many files the sample set has. */
  getSampleCount() {
    return sampleItems().length;
  }

  /**
   * Write every sample file that doesn't exist yet.
   * @param {import("../vfs/virtualFileSystem.js").vfs} vfs
   * @returns {Promise<{created: string[], skipped: string[]}>}
   * @throws The VFS error that stopped the installation; what was
   *   written before it is recorded, so it can still be removed.
   */
  async install(vfs) {
    const previous = this.getManifest();
    const files = previous ? [...previous.files] : [];
    const folders = previous ? [...previous.folders] : [];
    const created = [];
    const skipped = [];
    const save = () =>
      storage.set(MANIFEST_KEY, { version: MANIFEST_VERSION, installedAt: previous?.installedAt ?? Date.now(), files, folders });

    try {
      for (const item of sampleItems()) {
        if (await vfs.exists(item.path)) {
          skipped.push(item.path);
          continue;
        }
        for (const folder of await this._createParents(vfs, item.path)) folders.push(folder);
        const content = await item.content();
        if (content === null) {
          skipped.push(item.path);
          continue;
        }
        const entry = await vfs.createFile(item.path, content);
        files.push({ path: entry.path, size: entry.size, modifiedAt: entry.modifiedAt });
        created.push(entry.path);
      }
    } finally {
      if (files.length > 0) save();
    }
    storage.remove(REMOVED_KEY);
    return { created, skipped };
  }

  /**
   * Move the sample files that are still unchanged to Trash.
   * @param {import("../vfs/virtualFileSystem.js").vfs} vfs
   * @returns {Promise<{removed: number, kept: string[]}>} `removed` counts
   *   Trash items (a whole folder counts once); `kept` lists sample files
   *   that were changed and stay where they are.
   */
  async remove(vfs) {
    const manifest = this.getManifest();
    if (!manifest) return { removed: 0, kept: [] };

    const recorded = new Map(manifest.files.map((file) => [file.path, file]));
    const createdFolders = new Set(manifest.folders);
    /** @type {Set<string>} */
    const handled = new Set();
    const kept = [];
    let removed = 0;

    const isUnchanged = (entry) => {
      const record = recorded.get(entry.path);
      return !!record && entry.type === "file" && entry.size === record.size && entry.modifiedAt === record.modifiedAt;
    };

    // Whole folders first: a sample folder whose contents are all
    // unchanged samples goes to Trash as one item.
    const topFirst = [...createdFolders].sort((a, b) => a.split("/").length - b.split("/").length);
    for (const folder of topFirst) {
      if ([...handled].some((path) => folder === path || folder.startsWith(`${path}/`))) continue;
      if (!(await vfs.exists(folder))) continue;
      const tree = await listTree(vfs, folder);
      const untouched = tree.every((entry) => (entry.type === "folder" ? createdFolders.has(entry.path) : isUnchanged(entry)));
      if (!untouched || tree.length === 0) continue;
      await vfs.delete(folder);
      handled.add(folder);
      for (const entry of tree) handled.add(entry.path);
      removed += 1;
    }

    // Then single files.
    for (const record of manifest.files) {
      if (handled.has(record.path)) continue;
      if (!(await vfs.exists(record.path))) continue;
      const entry = await vfs.getInfo(record.path);
      if (!isUnchanged(entry)) {
        kept.push(record.path);
        continue;
      }
      await vfs.delete(record.path);
      handled.add(record.path);
      removed += 1;
    }

    // Folders created for the samples that are now empty: there is
    // nothing in them to restore, so they don't stay in Trash.
    const deepestFirst = [...createdFolders].sort((a, b) => b.split("/").length - a.split("/").length);
    for (const folder of deepestFirst) {
      if (handled.has(folder) || !(await vfs.exists(folder))) continue;
      if ((await vfs.list(folder)).length > 0) continue;
      const inTrash = await vfs.delete(folder);
      await vfs.deletePermanently(inTrash.path);
    }

    storage.remove(MANIFEST_KEY);
    storage.set(REMOVED_KEY, Date.now());
    return { removed, kept };
  }

  /**
   * Create the missing folders above `path`.
   * @param {import("../vfs/virtualFileSystem.js").vfs} vfs
   * @param {string} path
   * @returns {Promise<string[]>} The folders created, parents first.
   */
  async _createParents(vfs, path) {
    const missing = [];
    for (let parent = getParentPath(path); parent && parent !== "/"; parent = getParentPath(parent)) {
      if (await vfs.exists(parent)) break;
      missing.unshift(parent);
    }
    for (const folder of missing) await vfs.createFolder(folder);
    return missing;
  }
}

/**
 * @param {import("../vfs/virtualFileSystem.js").vfs} vfs
 * @param {string} folder
 * @returns {Promise<Array<{path: string, type: string, size: number, modifiedAt: number}>>} Every item inside `folder`, at any depth.
 */
async function listTree(vfs, folder) {
  const result = [];
  for (const entry of await vfs.list(folder)) {
    result.push(entry);
    if (entry.type === "folder") result.push(...(await listTree(vfs, entry.path)));
  }
  return result;
}

export const sampleContent = new SampleContent();
