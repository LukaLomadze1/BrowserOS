/**
 * @file Project model for Code Studio: a project is a folder in the
 * VFS. This module reads a project's file tree, creates projects from
 * templates, and remembers recently opened projects. Every read and
 * write goes through the public VFS API.
 */

import { storage } from "../../../core/storage.js";
import { getTemplate } from "./templates.js";
import { joinPath, isInside } from "./paths.js";

/** Folder new projects are created in by default. */
export const PROJECTS_FOLDER = "/Projects";

const RECENT_KEY = "codeStudio:recentProjects";
const MAX_RECENT = 10;
/** Folders not shown or searched (they are usually huge or generated). */
const IGNORED_FOLDERS = new Set(["node_modules", ".git"]);
const MAX_TREE_ENTRIES = 20000;

/**
 * @typedef {object} ProjectTree
 * @property {string} root
 * @property {Map<string, object>} entries - path -> VFS entry (root included).
 * @property {Map<string, object[]>} children - folder path -> sorted children.
 * @property {boolean} truncated - True when the project is larger than what is listed.
 */

/**
 * Read a project's whole tree (folders first, then files, alphabetical).
 * @param {import("../../../core/vfs/virtualFileSystem.js").vfs} vfs
 * @param {string} root
 * @returns {Promise<ProjectTree>}
 */
export async function readProjectTree(vfs, root) {
  const rootEntry = await vfs.getInfo(root);
  if (rootEntry.type !== "folder") throw new Error(`${root} is not a folder`);
  const entries = new Map([[root, rootEntry]]);
  const children = new Map();
  let truncated = false;
  const queue = [root];
  while (queue.length) {
    const folder = queue.shift();
    let list;
    try {
      list = await vfs.list(folder);
    } catch {
      continue;
    }
    children.set(folder, list);
    for (const entry of list) {
      if (entries.size >= MAX_TREE_ENTRIES) {
        truncated = true;
        break;
      }
      entries.set(entry.path, entry);
      if (entry.type === "folder" && !IGNORED_FOLDERS.has(entry.name)) queue.push(entry.path);
    }
    if (truncated) break;
  }
  return { root, entries, children, truncated };
}

/**
 * @param {ProjectTree} tree
 * @returns {object[]} Every file in the project, by path.
 */
export function listProjectFiles(tree) {
  return [...tree.entries.values()].filter((entry) => entry.type === "file").sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Create a project folder and its template files.
 * @param {import("../../../core/vfs/virtualFileSystem.js").vfs} vfs
 * @param {{name: string, templateId: string, parent?: string}} options
 * @returns {Promise<{root: string, open: string[]}>} The project folder and the files to open.
 */
export async function createProject(vfs, { name, templateId, parent = PROJECTS_FOLDER }) {
  const template = getTemplate(templateId);
  if (!template) throw new Error(`Unknown template "${templateId}"`);
  const projectName = name.trim();
  if (parent === PROJECTS_FOLDER && !(await vfs.exists(PROJECTS_FOLDER))) {
    await vfs.createFolder(PROJECTS_FOLDER);
  }
  const root = joinPath(parent, projectName);
  if (await vfs.exists(root)) {
    const error = new Error(`\u201c${projectName}\u201d already exists in ${parent}`);
    error.code = "ALREADY_EXISTS";
    throw error;
  }
  await vfs.createFolder(root);
  const folders = new Set(template.folders);
  for (const relative of Object.keys(template.files)) {
    const parts = relative.split("/");
    for (let i = 1; i < parts.length; i += 1) folders.add(parts.slice(0, i).join("/"));
  }
  for (const folder of [...folders].sort((a, b) => a.split("/").length - b.split("/").length)) {
    await vfs.createFolder(joinPath(root, folder));
  }
  for (const [relative, render] of Object.entries(template.files)) {
    await vfs.createFile(joinPath(root, relative), render(projectName));
  }
  return { root, open: template.open.map((relative) => joinPath(root, relative)) };
}

/**
 * @returns {string[]} Recently opened project folders, most recent first.
 */
export function getRecentProjects() {
  const list = storage.get(RECENT_KEY, []);
  return Array.isArray(list) ? list.filter((path) => typeof path === "string" && path.startsWith("/")) : [];
}

/**
 * @param {string} root
 * @returns {void}
 */
export function addRecentProject(root) {
  const list = [root, ...getRecentProjects().filter((path) => path !== root)].slice(0, MAX_RECENT);
  storage.set(RECENT_KEY, list);
}

/**
 * @param {string} root
 * @returns {void}
 */
export function removeRecentProject(root) {
  storage.set(
    RECENT_KEY,
    getRecentProjects().filter((path) => path !== root)
  );
}

/**
 * Keep recent projects pointing at the right folder after a rename or move.
 * @param {string} oldPath
 * @param {string} newPath
 * @returns {void}
 */
export function renameRecentProject(oldPath, newPath) {
  const list = getRecentProjects().map((path) => (isInside(path, oldPath) ? newPath + path.slice(oldPath.length) : path));
  storage.set(RECENT_KEY, [...new Set(list)]);
}
