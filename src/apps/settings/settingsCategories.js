/**
 * @file Settings navigation registry.
 *
 * Every entry in the Settings sidebar is declared here. Adding a page
 * means adding one entry with a `createPage` factory; SettingsManager
 * and SettingsView need no changes. Category ids match the settings
 * categories in settingsSchema.js where a page edits one, and the
 * `page` values in settingsIndex.js, so deep links and search results
 * resolve to the right page.
 *
 * An entry without `createPage` is listed but unavailable: it renders
 * as a disabled, clearly labelled item that can't be focused or
 * activated, and deep links to it fall back to the default category.
 *
 * Page contract — `createPage(context)` receives
 *   { appManager, recentFilesService }
 * (either may be null) and must return an object providing:
 *   getElement(): HTMLElement   The page's root element.
 *   destroy(): void             Remove every subscription and listener.
 *                               Called when navigating away and when the
 *                               Settings window closes.
 * Pages should render an <h1> carrying tabindex="-1" so keyboard focus
 * can move to it after navigation, and mark sections that search
 * results can target with `data-settings-anchor`.
 */

import AppearancePage from "./pages/appearancePage.js";
import WallpaperPage from "./pages/wallpaperPage.js";
import DesktopPage from "./pages/desktopPage.js";
import StartMenuPage from "./pages/startMenuPage.js";
import FileExplorerPage from "./pages/fileExplorerPage.js";
import KeyboardPage from "./pages/keyboardPage.js";
import NotificationsPage from "./pages/notificationsPage.js";
import TaskbarPage from "./pages/taskbarPage.js";
import BrowserPage from "./pages/browserPage.js";
import SystemPage from "./pages/systemPage.js";

/**
 * @typedef {object} SettingsPage
 * @property {() => HTMLElement} getElement
 * @property {() => void} destroy
 */

/**
 * @typedef {object} SettingsPageContext
 * @property {import("../../core/appManager.js").AppManager|null} appManager
 * @property {import("../../core/recentFilesService.js").RecentFilesService|null} recentFilesService
 */

/**
 * @typedef {object} SettingsCategory
 * @property {string} id
 * @property {string} label
 * @property {string} icon - Glyph or built-in "icon:<name>" shown in the sidebar.
 * @property {((context: SettingsPageContext) => SettingsPage)} [createPage] - Omitted for unavailable categories.
 */

/** @type {ReadonlyArray<SettingsCategory>} */
export const SETTINGS_CATEGORIES = Object.freeze([
  { id: "appearance", label: "Appearance", icon: "\u25d0", createPage: () => new AppearancePage() },
  { id: "wallpaper", label: "Wallpaper", icon: "\u25a7", createPage: (context) => new WallpaperPage(context) },
  { id: "desktop", label: "Desktop", icon: "\u25a6", createPage: (context) => new DesktopPage(context) },
  { id: "startMenu", label: "Start Menu", icon: "\u2630", createPage: (context) => new StartMenuPage(context) },
  { id: "fileExplorer", label: "File Explorer", icon: "\u25a4", createPage: (context) => new FileExplorerPage(context) },
  { id: "notifications", label: "Notifications", icon: "icon:bell", createPage: (context) => new NotificationsPage(context) },
  { id: "taskbar", label: "Taskbar", icon: "icon:display", createPage: (context) => new TaskbarPage(context) },
  { id: "browser", label: "Browser", icon: "icon:globe", createPage: (context) => new BrowserPage(context) },
  { id: "keyboard", label: "Keyboard Shortcuts", icon: "\u2328", createPage: (context) => new KeyboardPage(context) },
  { id: "system", label: "System", icon: "\u24d8", createPage: () => new SystemPage() },
]);

/** Category shown when Settings opens without a (valid) deep link. */
export const DEFAULT_CATEGORY_ID = "appearance";

/**
 * @param {string|undefined|null} id
 * @returns {SettingsCategory} The requested category if it exists and is available, otherwise the default.
 */
export function resolveCategory(id) {
  const requested = SETTINGS_CATEGORIES.find((category) => category.id === id);
  if (requested && typeof requested.createPage === "function") return requested;
  if (id && id !== DEFAULT_CATEGORY_ID) {
    console.warn(`[Settings] category "${id}" is ${requested ? "unavailable" : "unknown"}; opening "${DEFAULT_CATEGORY_ID}".`);
  }
  return SETTINGS_CATEGORIES.find((category) => category.id === DEFAULT_CATEGORY_ID);
}

/**
 * @param {SettingsCategory} category
 * @returns {boolean}
 */
export function isCategoryAvailable(category) {
  return typeof category.createPage === "function";
}
