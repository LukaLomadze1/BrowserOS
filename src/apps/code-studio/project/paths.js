/**
 * @file Path helpers shared by Code Studio's project, preview, and
 * diagnostics code. VFS paths are absolute, "/"-separated, and never
 * end in "/" (except the root itself).
 */

/**
 * @param {string} path
 * @returns {string} Parent folder ("/" for top-level entries).
 */
export function dirname(path) {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
}

/**
 * @param {string} path
 * @returns {string}
 */
export function basename(path) {
  return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * @param {string} path
 * @returns {string} Lower-case extension without the dot, or "".
 */
export function extname(path) {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/**
 * @param {...string} parts
 * @returns {string} Normalized absolute path ("." and ".." resolved; ".." never climbs above "/").
 */
export function joinPath(...parts) {
  const segments = [];
  for (const part of parts.join("/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") segments.pop();
    else segments.push(part);
  }
  return `/${segments.join("/")}`;
}

/**
 * @param {string} path
 * @param {string} root
 * @returns {boolean} Whether `path` is `root` or inside it.
 */
export function isInside(path, root) {
  if (root === "/") return path.startsWith("/");
  return path === root || path.startsWith(`${root}/`);
}

/**
 * @param {string} path
 * @param {string} root
 * @returns {string} `path` relative to `root` (no leading "/"), or the absolute path when outside.
 */
export function relativeTo(path, root) {
  if (!isInside(path, root)) return path;
  if (root === "/") return path.slice(1);
  return path.slice(root.length + 1);
}

/**
 * @param {string} reference - A src/href/url()/import value.
 * @returns {boolean} Whether it points outside the project (a URL with a scheme, protocol-relative, a fragment, or a template placeholder).
 */
export function isExternalReference(reference) {
  const value = reference.trim();
  if (!value) return true;
  if (value.startsWith("#") || value.startsWith("//")) return true;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return true; // http:, https:, data:, blob:, mailto:, javascript:, \u2026
  if (/[{}<>]|\$\{/.test(value)) return true; // template placeholders
  return false;
}

/**
 * Resolve a project reference to a VFS path.
 * @param {string} reference
 * @param {string} fromFolder - Folder of the referencing file.
 * @param {string} projectRoot - "/"-relative references resolve against this.
 * @returns {string|null} The VFS path, or null for external references.
 */
export function resolveProjectPath(reference, fromFolder, projectRoot) {
  if (isExternalReference(reference)) return null;
  let value = reference.trim().replace(/[?#].*$/, "");
  if (!value) return null;
  try {
    value = decodeURIComponent(value);
  } catch {
    /* keep the raw value */
  }
  if (value.startsWith("/")) return joinPath(projectRoot, value);
  return joinPath(fromFolder, value);
}

/** Characters not allowed in file and folder names created from Code Studio. */
const INVALID_NAME = /[/\\:*?"<>|\u0000-\u001f]/;

/**
 * @param {string} name
 * @returns {string|null} An error message, or null when the name is acceptable.
 */
export function validateName(name) {
  const trimmed = name.trim();
  if (!trimmed) return "Enter a name.";
  if (trimmed === "." || trimmed === "..") return "That name is reserved.";
  if (INVALID_NAME.test(trimmed)) return 'Names can\u2019t contain / \\ : * ? " < > |';
  if (trimmed.length > 120) return "Use a name of 120 characters or fewer.";
  return null;
}
