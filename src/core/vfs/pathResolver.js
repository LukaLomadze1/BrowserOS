/**
 * @file PathResolver — pure path-string math. Nothing in this file
 * touches storage; it only knows how to parse, normalize, join, and
 * decompose path strings. VirtualFileSystem is the only module that
 * combines these with actual lookups.
 *
 * Every public VirtualFileSystem method accepts an optional
 * `currentDir` (defaulting to "/") alongside its path argument, so
 * relative paths resolve the way a shell resolves them: Terminal
 * tracks its working directory and passes it through.
 */

import { VFSError } from "./vfsError.js";

/**
 * Split a raw path string into clean segments, resolving "." and
 * ".." along the way. ".." above the root is simply absorbed (mirrors
 * how real shells behave at "/").
 * @param {string} path
 * @returns {string[]}
 */
export function normalizeSegments(path) {
  const rawParts = path.split("/");
  const stack = [];
  for (const part of rawParts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (stack.length > 0) stack.pop();
      continue;
    }
    stack.push(part);
  }
  return stack;
}

/**
 * @param {string} path
 * @returns {boolean}
 */
export function isAbsolute(path) {
  return typeof path === "string" && path.startsWith("/");
}

/**
 * Join path fragments with "/", ignoring empty ones. Does NOT
 * normalize "." / ".." — call resolvePath() for that.
 * @param {...string} parts
 * @returns {string}
 */
export function joinPaths(...parts) {
  return parts.filter((part) => part && part.length > 0).join("/");
}

/**
 * Turn any path (absolute or relative) into a clean, normalized
 * absolute path, resolving it against `currentDir` if it's relative.
 * @param {string} path
 * @param {string} [currentDir]
 * @returns {string}
 */
export function resolvePath(path, currentDir = "/") {
  if (typeof path !== "string" || path.length === 0) {
    throw new VFSError("INVALID_PATH", "Path must be a non-empty string");
  }
  const base = isAbsolute(path) ? path : joinPaths(currentDir, path);
  const segments = normalizeSegments(base);
  return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}

/**
 * @param {string} path - Must already be a normalized absolute path.
 * @returns {string|null} The parent path, or null if `path` is root.
 */
export function getParentPath(path) {
  const segments = normalizeSegments(path);
  if (segments.length === 0) return null;
  segments.pop();
  return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}

/**
 * @param {string} path - Must already be a normalized absolute path.
 * @returns {string} The final path segment (file/folder name), or "/" for root.
 */
export function getBaseName(path) {
  const segments = normalizeSegments(path);
  return segments.length === 0 ? "/" : segments[segments.length - 1];
}

/**
 * @param {string} name - A file name, not a path.
 * @returns {string|null} Lowercased extension without the dot, or
 *   null for dotfiles / names with no extension.
 */
export function getExtension(name) {
  const lastDot = name.lastIndexOf(".");
  if (lastDot <= 0 || lastDot === name.length - 1) return null;
  return name.slice(lastDot + 1).toLowerCase();
}
