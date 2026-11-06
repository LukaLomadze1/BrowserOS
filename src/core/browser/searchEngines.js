/**
 * @file Search engines the Browser can send address-bar searches to.
 *
 * This is the only place search URLs are defined; the active engine is
 * the `browser.searchEngine` setting.
 */

/**
 * @typedef {object} SearchEngine
 * @property {string} id
 * @property {string} name
 * @property {string} searchUrl - "%s" is replaced with the encoded query.
 * @property {string} homepage
 */

/** @type {ReadonlyArray<SearchEngine>} */
export const SEARCH_ENGINES = Object.freeze([
  Object.freeze({ id: "google", name: "Google", searchUrl: "https://www.google.com/search?q=%s", homepage: "https://www.google.com/" }),
  Object.freeze({ id: "bing", name: "Bing", searchUrl: "https://www.bing.com/search?q=%s", homepage: "https://www.bing.com/" }),
  Object.freeze({ id: "duckduckgo", name: "DuckDuckGo", searchUrl: "https://duckduckgo.com/?q=%s", homepage: "https://duckduckgo.com/" }),
]);

export const SEARCH_ENGINE_IDS = Object.freeze(SEARCH_ENGINES.map((engine) => engine.id));
export const DEFAULT_SEARCH_ENGINE_ID = "google";

/**
 * @param {string} id
 * @returns {SearchEngine} The engine, or the default one for an unknown id.
 */
export function getSearchEngine(id) {
  return SEARCH_ENGINES.find((engine) => engine.id === id) ?? SEARCH_ENGINES.find((engine) => engine.id === DEFAULT_SEARCH_ENGINE_ID);
}

/**
 * @param {string} engineId
 * @param {string} query
 * @returns {string}
 */
export function buildSearchUrl(engineId, query) {
  return getSearchEngine(engineId).searchUrl.replace("%s", encodeURIComponent(query.trim()));
}
