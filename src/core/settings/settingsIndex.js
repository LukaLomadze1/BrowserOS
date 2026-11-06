/**
 * @file Searchable index of Settings pages and sections.
 *
 * A small, dependency-free description of where each group of options
 * lives in the Settings app, so that the Start Menu (which must not
 * load the Settings app just to search it) and the Settings sidebar
 * search share one list. Each entry deep-links into Settings through
 * `appManager.launch("settings", { page, anchor })`; pages render the
 * matching section with `data-settings-anchor` set to `anchor`.
 */

/**
 * @typedef {object} SettingsIndexEntry
 * @property {string} page - Settings category id.
 * @property {string} pageLabel
 * @property {string} anchor - Section anchor within the page.
 * @property {string} label - Section title.
 * @property {ReadonlyArray<string>} keywords - Extra search terms.
 */

/** @type {ReadonlyArray<SettingsIndexEntry>} */
export const SETTINGS_INDEX = deepFreeze([
  { page: "appearance", pageLabel: "Appearance", anchor: "theme", label: "Theme", keywords: ["dark", "light", "system", "mode", "color scheme"] },
  { page: "appearance", pageLabel: "Appearance", anchor: "accent", label: "Accent color", keywords: ["color", "highlight", "violet", "blue", "green"] },
  { page: "appearance", pageLabel: "Appearance", anchor: "effects", label: "Transparency and blur", keywords: ["glass", "blur", "corner", "radius", "opaque"] },
  { page: "appearance", pageLabel: "Appearance", anchor: "motion", label: "Animation and reduced motion", keywords: ["speed", "animation", "accessibility"] },
  { page: "wallpaper", pageLabel: "Wallpaper", anchor: "preset", label: "Wallpaper", keywords: ["background", "desktop background", "image"] },
  { page: "wallpaper", pageLabel: "Wallpaper", anchor: "dim", label: "Wallpaper dimming", keywords: ["darken", "brightness", "dim"] },
  { page: "desktop", pageLabel: "Desktop", anchor: "icons", label: "Desktop icons", keywords: ["icon size", "labels", "show icons", "recycle bin", "shortcuts"] },
  { page: "desktop", pageLabel: "Desktop", anchor: "layout", label: "Icon layout", keywords: ["grid", "spacing", "auto arrange", "align"] },
  { page: "desktop", pageLabel: "Desktop", anchor: "interaction", label: "Desktop interaction", keywords: ["single click", "double click", "selection", "rectangle", "confirm", "delete", "trash"] },
  { page: "startMenu", pageLabel: "Start Menu", anchor: "sections", label: "Start Menu sections", keywords: ["pinned", "recent", "show"] },
  { page: "startMenu", pageLabel: "Start Menu", anchor: "recent", label: "Recent items", keywords: ["history", "clear", "recent files", "recent apps", "limit"] },
  { page: "startMenu", pageLabel: "Start Menu", anchor: "pinned", label: "Pinned applications", keywords: ["pin", "unpin", "order"] },
  { page: "startMenu", pageLabel: "Start Menu", anchor: "search", label: "Start Menu search", keywords: ["search", "find", "results", "case"] },
  { page: "fileExplorer", pageLabel: "File Explorer", anchor: "view", label: "Explorer view", keywords: ["grid", "list", "details", "layout"] },
  { page: "fileExplorer", pageLabel: "File Explorer", anchor: "display", label: "File display", keywords: ["extensions", "hidden files", "size", "date", "type"] },
  { page: "fileExplorer", pageLabel: "File Explorer", anchor: "sorting", label: "Sorting", keywords: ["sort", "order", "ascending", "descending", "folders first"] },
  { page: "fileExplorer", pageLabel: "File Explorer", anchor: "startup", label: "Startup location", keywords: ["home", "open", "default folder", "restore"] },
  { page: "fileExplorer", pageLabel: "File Explorer", anchor: "navigation", label: "Explorer navigation", keywords: ["new window", "same window", "confirm", "delete", "trash"] },
  { page: "notifications", pageLabel: "Notifications", anchor: "dnd", label: "Do Not Disturb", keywords: ["quiet", "silence", "mute", "focus", "dnd"] },
  { page: "notifications", pageLabel: "Notifications", anchor: "banners", label: "Notification banners", keywords: ["toast", "popup", "duration", "preview", "sound"] },
  { page: "notifications", pageLabel: "Notifications", anchor: "history", label: "Notification history", keywords: ["notification center", "clear", "limit", "history"] },
  { page: "taskbar", pageLabel: "Taskbar", anchor: "clock", label: "Taskbar clock", keywords: ["time", "date", "24-hour", "12-hour", "seconds", "tray"] },
  { page: "taskbar", pageLabel: "Taskbar", anchor: "task-manager", label: "Task Manager updates", keywords: ["refresh", "performance", "interval"] },
  { page: "browser", pageLabel: "Browser", anchor: "search", label: "Search engine and homepage", keywords: ["google", "bing", "duckduckgo", "home", "start page"] },
  { page: "browser", pageLabel: "Browser", anchor: "appearance", label: "Bookmarks bar and start page", keywords: ["bookmarks", "new tab", "clock", "background"] },
  { page: "browser", pageLabel: "Browser", anchor: "history", label: "Browsing history", keywords: ["clear", "privacy", "retention", "browsing data"] },
  { page: "browser", pageLabel: "Browser", anchor: "downloads", label: "Download settings", keywords: ["download", "size", "limit"] },
  { page: "browser", pageLabel: "Browser", anchor: "sites", label: "Site embedding choices", keywords: ["external", "open in browser", "embed", "frame"] },
  { page: "keyboard", pageLabel: "Keyboard Shortcuts", anchor: "global", label: "Global shortcuts", keywords: ["hotkeys", "windows key", "meta", "window switching"] },
  { page: "keyboard", pageLabel: "Keyboard Shortcuts", anchor: "reference", label: "Keyboard shortcut reference", keywords: ["keys", "hotkeys", "copy", "paste", "rename"] },
  { page: "system", pageLabel: "System", anchor: "reset", label: "Reset preferences", keywords: ["defaults", "restore", "reset all"] },
  { page: "system", pageLabel: "System", anchor: "about", label: "Settings storage", keywords: ["version", "storage", "customized"] },
]);

/**
 * @param {string} query
 * @param {{caseSensitive?: boolean}} [options]
 * @returns {Array<SettingsIndexEntry & {score: number}>} Matches, best first.
 */
export function searchSettingsIndex(query, options = {}) {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const normalize = options.caseSensitive ? (text) => text : (text) => text.toLowerCase();
  const needle = normalize(trimmed);

  const results = [];
  for (const entry of SETTINGS_INDEX) {
    const labelScore = scoreText(normalize(entry.label), needle);
    const pageScore = scoreText(normalize(entry.pageLabel), needle) * 0.6;
    const keywordScore = Math.max(0, ...entry.keywords.map((keyword) => scoreText(normalize(keyword), needle) * 0.8));
    const score = Math.max(labelScore, pageScore, keywordScore);
    if (score > 0) results.push({ ...entry, score });
  }
  return results.sort((a, b) => b.score - a.score);
}

/**
 * Shared relevance scoring: exact > prefix > word prefix > substring.
 * @param {string} text - Already normalized.
 * @param {string} needle - Already normalized.
 * @returns {number} 0 when there is no match.
 */
export function scoreText(text, needle) {
  if (!needle) return 0;
  if (text === needle) return 4;
  if (text.startsWith(needle)) return 3;
  if (text.split(/[\s._-]+/).some((word) => word.startsWith(needle))) return 2;
  if (text.includes(needle)) return 1;
  return 0;
}

/**
 * @template T
 * @param {T} value
 * @returns {T}
 */
function deepFreeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}
