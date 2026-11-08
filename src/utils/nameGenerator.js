/**
 * @file Pure helpers for two small, easy-to-get-subtly-wrong things:
 * generating a non-colliding "New Folder" / "New Text Document.txt"
 * style default name, and splitting a name into stem/extension for
 * inline-rename's "select the stem, leave the extension alone"
 * behavior. Neither function touches storage or the DOM, so both are
 * trivially testable on their own.
 */

/**
 * @param {string} baseName - e.g. "New Folder" or "New Text Document".
 * @param {string|null} extension - e.g. "txt", or null for folders.
 * @param {string[]} existingNames - Sibling names already present, any case.
 * @returns {string} `baseName` (+ extension) if free, otherwise
 *   "baseName (2)", "baseName (3)", ... (no "(1)"; the bare name is
 *   the first one).
 */
export function generateDefaultName(baseName, extension, existingNames) {
  const existingLower = new Set(existingNames.map((name) => name.toLowerCase()));
  const suffix = extension ? `.${extension}` : "";

  const first = `${baseName}${suffix}`;
  if (!existingLower.has(first.toLowerCase())) return first;

  let counter = 2;
  let candidate = `${baseName} (${counter})${suffix}`;
  while (existingLower.has(candidate.toLowerCase())) {
    counter += 1;
    candidate = `${baseName} (${counter})${suffix}`;
  }
  return candidate;
}

/**
 * Splits a name into stem + extension for rename-input pre-selection.
 * Mirrors the VFS's own extension rule exactly (no extension for
 * dotfiles like ".gitignore", or for a trailing dot with nothing
 * after it), so what gets pre-selected always matches what the VFS
 * will treat as the file's actual extension.
 * @param {string} name
 * @returns {{stem: string, extension: string}} `extension` includes the leading dot, or is "" if there isn't one.
 */
export function splitNameForRename(name) {
  const lastDot = name.lastIndexOf(".");
  if (lastDot <= 0 || lastDot === name.length - 1) {
    return { stem: name, extension: "" };
  }
  return { stem: name.slice(0, lastDot), extension: name.slice(lastDot) };
}
