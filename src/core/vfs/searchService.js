/**
 * @file SearchService — recursive search over a folder's subtree.
 * Reuses StorageAdapter.getSubtree() for traversal (the same
 * indexed, breadth-first walk move()/copy()/delete() rely on) so
 * there's exactly one place in the codebase that knows how to walk
 * the tree efficiently.
 */

/**
 * @param {import("./storageAdapter.js").storageAdapter} storageAdapter
 * @param {string} rootId - Folder id to search within.
 * @param {object} [options]
 * @param {string} [options.query] - Case-insensitive name fragment.
 * @param {string} [options.extension] - Filter to a single extension (without the dot).
 * @param {"partial"|"exact"} [options.matchType]
 * @returns {Promise<object[]>}
 */
export async function searchEntries(storageAdapter, rootId, options = {}) {
  const { query = "", extension = null, matchType = "partial" } = options;
  const lowerQuery = query.trim().toLowerCase();
  const lowerExtension = extension ? extension.toLowerCase().replace(/^\./, "") : null;

  const subtree = await storageAdapter.getSubtree(rootId, { includeRoot: false });
  const results = [];

  for (const entry of subtree) {
    if (lowerExtension !== null && entry.extension !== lowerExtension) continue;

    if (lowerQuery) {
      const lowerName = entry.name.toLowerCase();
      const matches = matchType === "exact" ? lowerName === lowerQuery : lowerName.includes(lowerQuery);
      if (!matches) continue;
    }

    results.push(entry);
  }

  return results;
}
