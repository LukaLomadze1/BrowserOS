/**
 * @file The settings schema — the single source of truth for every
 * setting's key, category, default value, type, and validation.
 *
 * Nothing else in BrowserOS may hardcode a setting's default. UI code
 * reads defaults and ranges from here (via SettingsService), and
 * SettingsService validates every stored or incoming value against
 * the descriptor below before accepting it.
 *
 * Keys are always "<category>.<name>". Categories:
 *
 *   appearance    Theme, accent, glass effects, motion (ThemeManager).
 *   wallpaper     Desktop background preset and dimming (ThemeManager).
 *   desktop       Icon size, layout, interaction (DesktopManager).
 *   startMenu     Sections, recent items, pinned apps, search (StartMenuManager).
 *   fileExplorer  View, display, sorting, startup, navigation (ExplorerManager).
 *   keyboard      Which global shortcut groups are active (keyboardShortcuts).
 *
 * Descriptor fields:
 *
 *   category       Category id the key belongs to. Must match the key prefix.
 *   type           "string" | "number" | "boolean" | "array".
 *   defaultValue   Used for first boot, for invalid stored values, and for resets.
 *   allowedValues  Optional closed set of accepted values.
 *   min / max      Inclusive numeric bounds (type "number" only).
 *   integer        Reject non-integer numbers (type "number" only).
 *   itemType       Type of every element (type "array" only).
 *   maxItems       Maximum length (type "array" only).
 *   uniqueItems    Reject duplicate elements (type "array" only).
 *   validate       Optional extra predicate, run after the built-in checks.
 *   persist        false keeps the value for the current session only.
 *   migrate        Optional (storedValue) => value. Called once during load when
 *                  a stored value fails validation, so a recoverable older shape
 *                  (e.g. "24px" instead of 24) can be converted instead of being
 *                  discarded. The result is validated again; on failure the
 *                  default is used.
 *   description    Short developer-facing explanation.
 */

import { ACCENT_IDS, DEFAULT_ACCENT_ID } from "./accentPresets.js";

/**
 * Version of the persisted settings document. Increment it whenever
 * the stored shape changes, and add a matching step to
 * settingsMigrations.js.
 */
export const SETTINGS_VERSION = 2;

/** Wallpaper presets; their visuals live in styles/wallpapers.css. */
export const WALLPAPER_PRESETS = Object.freeze([
  Object.freeze({ id: "aurora", label: "Aurora" }),
  Object.freeze({ id: "nebula", label: "Nebula" }),
  Object.freeze({ id: "sunset", label: "Sunset" }),
  Object.freeze({ id: "ocean", label: "Ocean" }),
  Object.freeze({ id: "graphite", label: "Graphite" }),
  Object.freeze({ id: "solid", label: "Solid" }),
]);

/** Apps pinned to the Start Menu on first boot and after a reset. */
export const DEFAULT_PINNED_APP_IDS = Object.freeze(["about", "calculator", "notes", "settings", "recycle-bin"]);

const CONFIRM_TRASH_VALUES = ["always", "smart", "never"];

/**
 * @typedef {object} SettingDescriptor
 * @property {string} category
 * @property {"string"|"number"|"boolean"|"array"} type
 * @property {*} defaultValue
 * @property {ReadonlyArray<string|number|boolean>} [allowedValues]
 * @property {number} [min]
 * @property {number} [max]
 * @property {boolean} [integer]
 * @property {"string"|"number"|"boolean"} [itemType]
 * @property {number} [maxItems]
 * @property {boolean} [uniqueItems]
 * @property {(value: *) => boolean} [validate]
 * @property {boolean} persist
 * @property {(storedValue: *) => *} [migrate]
 * @property {string} [description]
 */

/** @type {Readonly<Record<string, SettingDescriptor>>} */
export const SETTINGS_SCHEMA = freezeSchema({
  // ---------------------------------------------------------------
  // Appearance
  // ---------------------------------------------------------------
  "appearance.theme": {
    category: "appearance",
    type: "string",
    defaultValue: "dark",
    allowedValues: ["dark", "light", "system"],
    persist: true,
    description:
      "Selected theme mode. \"system\" follows prefers-color-scheme; the effective theme is resolved by ThemeManager and is never written back here.",
  },
  "appearance.accentColor": {
    category: "appearance",
    type: "string",
    defaultValue: DEFAULT_ACCENT_ID,
    allowedValues: ACCENT_IDS,
    persist: true,
    description: "Id of a curated accent preset (see accentPresets.js).",
  },
  "appearance.transparency": {
    category: "appearance",
    type: "boolean",
    defaultValue: true,
    persist: true,
    description: "Translucent, blurred glass surfaces when true; opaque surfaces with no blur when false.",
  },
  "appearance.blurIntensity": {
    category: "appearance",
    type: "number",
    defaultValue: 24,
    min: 0,
    max: 40,
    integer: true,
    persist: true,
    migrate: parsePixelValue,
    description: "Glass blur radius in pixels. Retained, but not applied, while transparency is off.",
  },
  "appearance.windowRadius": {
    category: "appearance",
    type: "number",
    defaultValue: 16,
    min: 0,
    max: 24,
    integer: true,
    persist: true,
    migrate: parsePixelValue,
    description: "Corner radius of windows in pixels. Large system panels scale from it; maximized windows always use 0.",
  },
  "appearance.animationSpeed": {
    category: "appearance",
    type: "string",
    defaultValue: "normal",
    allowedValues: ["fast", "normal", "slow"],
    persist: true,
    description: "Selects one of the centralized motion-duration scales in styles/variables.css.",
  },
  "appearance.reducedMotion": {
    category: "appearance",
    type: "string",
    defaultValue: "system",
    allowedValues: ["system", "on", "off"],
    persist: true,
    description:
      "Reduced-motion preference. \"system\" follows prefers-reduced-motion; the effective state is resolved by ThemeManager.",
  },

  // ---------------------------------------------------------------
  // Wallpaper
  // ---------------------------------------------------------------
  "wallpaper.preset": {
    category: "wallpaper",
    type: "string",
    defaultValue: "aurora",
    allowedValues: WALLPAPER_PRESETS.map((preset) => preset.id),
    persist: true,
    description: "Desktop background preset. Every preset adapts to the active theme; Aurora also follows the accent color.",
  },
  "wallpaper.dim": {
    category: "wallpaper",
    type: "number",
    defaultValue: 0,
    min: 0,
    max: 60,
    integer: true,
    persist: true,
    description: "Percentage of darkening (or, in the light theme, softening) laid over the wallpaper.",
  },

  // ---------------------------------------------------------------
  // Desktop
  // ---------------------------------------------------------------
  "desktop.iconSize": {
    category: "desktop",
    type: "string",
    defaultValue: "medium",
    allowedValues: ["small", "medium", "large"],
    persist: true,
    description: "Icon glyph and label dimensions. Also changes the grid cell size used for positioning.",
  },
  "desktop.showLabels": {
    category: "desktop",
    type: "boolean",
    defaultValue: true,
    persist: true,
    description: "Show item names under desktop icons. Hidden labels remain available to assistive technology.",
  },
  "desktop.gridSpacing": {
    category: "desktop",
    type: "string",
    defaultValue: "normal",
    allowedValues: ["compact", "normal", "spacious"],
    persist: true,
    description: "Gap added around every grid cell; changes actual icon positions, not just visuals.",
  },
  "desktop.autoArrange": {
    category: "desktop",
    type: "boolean",
    defaultValue: false,
    persist: true,
    description: "Keep icons packed into columns in sort order; dragging reorders rather than freely placing.",
  },
  "desktop.alignToGrid": {
    category: "desktop",
    type: "boolean",
    defaultValue: true,
    persist: true,
    description: "Snap dropped icons to grid cells. When off, icons stay exactly where they are dropped.",
  },
  "desktop.showIcons": {
    category: "desktop",
    type: "boolean",
    defaultValue: true,
    persist: true,
    description: "Show or hide every desktop icon. Hiding never changes files or saved positions.",
  },
  "desktop.showSystemShortcuts": {
    category: "desktop",
    type: "boolean",
    defaultValue: true,
    persist: true,
    description: "Show system shortcuts (Recycle Bin) on the desktop.",
  },
  "desktop.openItemsWith": {
    category: "desktop",
    type: "string",
    defaultValue: "doubleClick",
    allowedValues: ["doubleClick", "singleClick"],
    persist: true,
    description: "Whether a single or a double click opens desktop items.",
  },
  "desktop.rectangleSelection": {
    category: "desktop",
    type: "boolean",
    defaultValue: true,
    persist: true,
    description: "Allow dragging on empty desktop space to select icons with a rectangle.",
  },
  "desktop.confirmTrash": {
    category: "desktop",
    type: "string",
    defaultValue: "smart",
    allowedValues: CONFIRM_TRASH_VALUES,
    persist: true,
    description:
      "When to confirm moving desktop items to Trash: always, only for several items or non-empty folders (smart), or never.",
  },

  // ---------------------------------------------------------------
  // Start Menu
  // ---------------------------------------------------------------
  "startMenu.showPinned": {
    category: "startMenu",
    type: "boolean",
    defaultValue: true,
    persist: true,
    description: "Show the Pinned Applications section.",
  },
  "startMenu.pinnedApps": {
    category: "startMenu",
    type: "array",
    itemType: "string",
    maxItems: 24,
    uniqueItems: true,
    defaultValue: DEFAULT_PINNED_APP_IDS,
    persist: true,
    description:
      "Ordered app ids pinned to the Start Menu. Ids of apps that are not registered are kept but not displayed.",
  },
  "startMenu.showRecentApps": {
    category: "startMenu",
    type: "boolean",
    defaultValue: true,
    persist: true,
    description: "Show the Recent Applications section.",
  },
  "startMenu.recentAppsLimit": {
    category: "startMenu",
    type: "number",
    defaultValue: 6,
    min: 1,
    max: 12,
    integer: true,
    persist: true,
    description: "Maximum number of recent applications displayed.",
  },
  "startMenu.showRecentFiles": {
    category: "startMenu",
    type: "boolean",
    defaultValue: true,
    persist: true,
    description: "Show the Recent Files section.",
  },
  "startMenu.recentFilesLimit": {
    category: "startMenu",
    type: "number",
    defaultValue: 10,
    min: 1,
    max: 20,
    integer: true,
    persist: true,
    description: "Maximum number of recent files displayed.",
  },
  "startMenu.searchApps": {
    category: "startMenu",
    type: "boolean",
    defaultValue: true,
    persist: true,
    description: "Include installed applications in Start Menu search.",
  },
  "startMenu.searchFiles": {
    category: "startMenu",
    type: "boolean",
    defaultValue: true,
    persist: true,
    description: "Include files from the virtual file system in Start Menu search.",
  },
  "startMenu.searchFolders": {
    category: "startMenu",
    type: "boolean",
    defaultValue: true,
    persist: true,
    description: "Include folders from the virtual file system in Start Menu search.",
  },
  "startMenu.searchSettings": {
    category: "startMenu",
    type: "boolean",
    defaultValue: true,
    persist: true,
    description: "Include Settings pages and options in Start Menu search.",
  },
  "startMenu.prioritizeApps": {
    category: "startMenu",
    type: "boolean",
    defaultValue: true,
    persist: true,
    description: "List application matches before settings, folders, and files regardless of match quality.",
  },
  "startMenu.caseInsensitiveSearch": {
    category: "startMenu",
    type: "boolean",
    defaultValue: true,
    persist: true,
    description: "Ignore letter case when matching search queries.",
  },
  "startMenu.searchResultLimit": {
    category: "startMenu",
    type: "number",
    defaultValue: 12,
    min: 5,
    max: 30,
    integer: true,
    persist: true,
    description: "Maximum number of search results shown.",
  },

  // ---------------------------------------------------------------
  // File Explorer
  // ---------------------------------------------------------------
  "fileExplorer.defaultView": {
    category: "fileExplorer",
    type: "string",
    defaultValue: "grid",
    allowedValues: ["grid", "list", "details"],
    persist: true,
    description: "View used by every Explorer window. The toolbar view buttons change this setting.",
  },
  "fileExplorer.showExtensions": {
    category: "fileExplorer",
    type: "boolean",
    defaultValue: true,
    persist: true,
    description: "Display file extensions. Display only: names on disk and in rename fields are never changed.",
  },
  "fileExplorer.showHiddenFiles": {
    category: "fileExplorer",
    type: "boolean",
    defaultValue: false,
    persist: true,
    description: "List entries whose hidden flag is set.",
  },
  "fileExplorer.showSize": {
    category: "fileExplorer",
    type: "boolean",
    defaultValue: true,
    persist: true,
    description: "Show file sizes in the Details and List views.",
  },
  "fileExplorer.showModified": {
    category: "fileExplorer",
    type: "boolean",
    defaultValue: true,
    persist: true,
    description: "Show modification dates in the Details and List views.",
  },
  "fileExplorer.showType": {
    category: "fileExplorer",
    type: "boolean",
    defaultValue: true,
    persist: true,
    description: "Show file type information in the Details and List views.",
  },
  "fileExplorer.sortField": {
    category: "fileExplorer",
    type: "string",
    defaultValue: "name",
    allowedValues: ["name", "modified", "created", "size", "type"],
    persist: true,
    description: "Field every Explorer window sorts by. Column headers in the Details view change this setting.",
  },
  "fileExplorer.sortDirection": {
    category: "fileExplorer",
    type: "string",
    defaultValue: "asc",
    allowedValues: ["asc", "desc"],
    persist: true,
    description: "Sort direction.",
  },
  "fileExplorer.foldersFirst": {
    category: "fileExplorer",
    type: "boolean",
    defaultValue: true,
    persist: true,
    description: "Group folders before files regardless of the sort field.",
  },
  "fileExplorer.startupLocation": {
    category: "fileExplorer",
    type: "string",
    defaultValue: "home",
    allowedValues: ["home", "desktop", "documents", "downloads", "custom"],
    persist: true,
    description: "Folder a new Explorer window opens when no specific path is requested.",
  },
  "fileExplorer.customStartupPath": {
    category: "fileExplorer",
    type: "string",
    defaultValue: "/Documents",
    validate: (value) => value.startsWith("/") && value.length <= 1024,
    persist: true,
    description:
      "Absolute folder path used when the startup location is \"custom\". Checked against the VFS on every launch; a missing folder falls back to Home.",
  },
  "fileExplorer.restoreLastLocation": {
    category: "fileExplorer",
    type: "boolean",
    defaultValue: false,
    persist: true,
    description: "Open the most recently visited location instead of the startup location.",
  },
  "fileExplorer.openFoldersIn": {
    category: "fileExplorer",
    type: "string",
    defaultValue: "sameWindow",
    allowedValues: ["sameWindow", "newWindow"],
    persist: true,
    description: "Whether opening a folder inside Explorer navigates the current window or opens a new one.",
  },
  "fileExplorer.confirmTrash": {
    category: "fileExplorer",
    type: "string",
    defaultValue: "smart",
    allowedValues: CONFIRM_TRASH_VALUES,
    persist: true,
    description:
      "When to confirm moving items to Trash from Explorer: always, only for several items or non-empty folders (smart), or never.",
  },

  // ---------------------------------------------------------------
  // Keyboard
  // ---------------------------------------------------------------
  "keyboard.startMenuKey": {
    category: "keyboard",
    type: "boolean",
    defaultValue: true,
    persist: true,
    description: "Pressing the Windows / Meta key toggles the Start Menu.",
  },
  "keyboard.windowShortcuts": {
    category: "keyboard",
    type: "boolean",
    defaultValue: true,
    persist: true,
    description: "Enable window management shortcuts (maximize, minimize, close, switch).",
  },
  "keyboard.appShortcuts": {
    category: "keyboard",
    type: "boolean",
    defaultValue: true,
    persist: true,
    description: "Enable shortcuts that open Terminal, File Explorer, and Settings.",
  },
});

/** @type {ReadonlyArray<string>} Every category id that has at least one setting, in schema order. */
export const SETTINGS_CATEGORY_IDS = Object.freeze([
  ...new Set(Object.values(SETTINGS_SCHEMA).map((descriptor) => descriptor.category)),
]);

/**
 * Converts legacy string pixel values ("24px", "24") into numbers.
 * @param {*} storedValue
 * @returns {*}
 */
function parsePixelValue(storedValue) {
  if (typeof storedValue !== "string") return storedValue;
  const parsed = Number.parseFloat(storedValue);
  return Number.isFinite(parsed) ? Math.round(parsed) : storedValue;
}

/**
 * Freeze the schema (including allowedValues and array defaults) and
 * assert, at module load, that every key's prefix matches its declared
 * category. A mismatch is a programming error, so failing loudly here
 * is preferable to silently routing a key to the wrong subscribers.
 * @param {Record<string, object>} schema
 * @returns {Readonly<Record<string, SettingDescriptor>>}
 */
function freezeSchema(schema) {
  for (const [key, descriptor] of Object.entries(schema)) {
    const prefix = key.split(".")[0];
    if (prefix !== descriptor.category) {
      throw new Error(`[SettingsSchema] key "${key}" is declared in category "${descriptor.category}"`);
    }
    if (!("defaultValue" in descriptor)) {
      throw new Error(`[SettingsSchema] key "${key}" has no defaultValue`);
    }
    if (descriptor.allowedValues) Object.freeze(descriptor.allowedValues);
    if (Array.isArray(descriptor.defaultValue)) Object.freeze(descriptor.defaultValue);
    Object.freeze(descriptor);
  }
  return Object.freeze(schema);
}
