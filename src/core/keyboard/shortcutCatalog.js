/**
 * @file The keyboard shortcut catalog — the single source of truth for
 * which key combinations BrowserOS responds to.
 *
 * Every subsystem that handles a shortcut matches incoming events
 * against these definitions through `keyboardShortcuts.matches(e, id)`
 * rather than comparing `e.key` itself, and the Settings app renders
 * its Keyboard Shortcuts reference from the same data. Changing a
 * binding here therefore changes both the behavior and the
 * documentation; they cannot drift apart.
 *
 * Definition fields:
 *
 *   id           "<category>.<name>", unique.
 *   category     One of SHORTCUT_CATEGORIES' ids.
 *   description  What the shortcut does, shown in Settings.
 *   context      Where it applies, shown in Settings.
 *   combos       Alternative key combinations; any one of them matches.
 *   scope        "global"  — dispatched by keyboardShortcuts' single
 *                            document listener to a handler bound with
 *                            keyboardShortcuts.bind().
 *                "local"   — handled by the owning component's own
 *                            listener (it only makes sense while that
 *                            component has focus).
 *   settingKey   Optional boolean setting that enables/disables a
 *                global shortcut.
 *   allowInEditable  Global shortcuts only: also fire while focus is in
 *                a text field. Defaults to false, so typing is never
 *                hijacked.
 *
 * Combo fields:
 *
 *   key     KeyboardEvent.key, compared case-insensitively.
 *   code    KeyboardEvent.code, for layout-independent physical keys
 *           (used instead of `key` when present).
 *   mod     Ctrl, or ⌘ on macOS.
 *   ctrl    Ctrl specifically (not ⌘).
 *   alt, shift
 *   loose   Ignore modifier state entirely (plain navigation keys whose
 *           handlers never cared about modifiers).
 */

/** Display order and labels of the shortcut groups. */
export const SHORTCUT_CATEGORIES = Object.freeze([
  Object.freeze({ id: "general", label: "General" }),
  Object.freeze({ id: "desktop", label: "Desktop" }),
  Object.freeze({ id: "window", label: "Window Management" }),
  Object.freeze({ id: "fileExplorer", label: "File Explorer" }),
  Object.freeze({ id: "terminal", label: "Terminal" }),
  Object.freeze({ id: "startMenu", label: "Start Menu" }),
]);

const DESKTOP_CONTEXT = "Desktop icons focused";
const EXPLORER_CONTEXT = "File Explorer focused";
const TERMINAL_CONTEXT = "Terminal input";
const START_CONTEXT = "Start Menu open";

/**
 * @typedef {object} KeyCombo
 * @property {string} [key]
 * @property {string} [code]
 * @property {boolean} [mod]
 * @property {boolean} [ctrl]
 * @property {boolean} [alt]
 * @property {boolean} [shift]
 * @property {boolean} [loose]
 */

/**
 * @typedef {object} ShortcutDefinition
 * @property {string} id
 * @property {string} category
 * @property {string} description
 * @property {string} context
 * @property {ReadonlyArray<KeyCombo>} combos
 * @property {"global"|"local"} scope
 * @property {string} [settingKey]
 * @property {boolean} [allowInEditable]
 */

/** @type {ReadonlyArray<ShortcutDefinition>} */
export const SHORTCUT_DEFINITIONS = deepFreeze([
  // ---- General ----
  {
    id: "general.openTerminal",
    category: "general",
    description: "Open a new Terminal window",
    context: "Anywhere",
    combos: [{ key: "t", ctrl: true, alt: true }],
    scope: "global",
    settingKey: "keyboard.appShortcuts",
    allowInEditable: true,
  },
  {
    id: "general.openExplorer",
    category: "general",
    description: "Open File Explorer",
    context: "Anywhere",
    combos: [{ key: "e", ctrl: true, alt: true }],
    scope: "global",
    settingKey: "keyboard.appShortcuts",
    allowInEditable: true,
  },
  {
    id: "general.openSettings",
    category: "general",
    description: "Open Settings",
    context: "Anywhere",
    combos: [{ key: ",", mod: true }],
    scope: "global",
    settingKey: "keyboard.appShortcuts",
    allowInEditable: true,
  },
  {
    id: "general.cancel",
    category: "general",
    description: "Close the open menu or dialog, or cancel an inline rename",
    context: "Menus, dialogs, rename fields",
    combos: [{ key: "Escape" }],
    scope: "local",
  },

  // ---- Desktop ----
  {
    id: "desktop.clearSelection",
    category: "desktop",
    description: "Clear the desktop selection",
    context: "Anywhere",
    combos: [{ key: "Escape" }],
    scope: "global",
    allowInEditable: true,
  },
  { id: "desktop.selectAll", category: "desktop", description: "Select all desktop icons", context: DESKTOP_CONTEXT, combos: [{ key: "a", mod: true }], scope: "local" },
  { id: "desktop.copy", category: "desktop", description: "Copy selected items", context: DESKTOP_CONTEXT, combos: [{ key: "c", mod: true }], scope: "local" },
  { id: "desktop.cut", category: "desktop", description: "Cut selected items", context: DESKTOP_CONTEXT, combos: [{ key: "x", mod: true }], scope: "local" },
  { id: "desktop.paste", category: "desktop", description: "Paste onto the desktop", context: DESKTOP_CONTEXT, combos: [{ key: "v", mod: true }], scope: "local" },
  { id: "desktop.delete", category: "desktop", description: "Move selected items to Trash", context: DESKTOP_CONTEXT, combos: [{ key: "Delete", loose: true }], scope: "local" },
  { id: "desktop.rename", category: "desktop", description: "Rename the selected item", context: DESKTOP_CONTEXT, combos: [{ key: "F2", loose: true }], scope: "local" },
  { id: "desktop.open", category: "desktop", description: "Open the focused item", context: DESKTOP_CONTEXT, combos: [{ key: "Enter", loose: true }], scope: "local" },
  { id: "desktop.refresh", category: "desktop", description: "Refresh the desktop from the file system", context: DESKTOP_CONTEXT, combos: [{ key: "F5" }], scope: "local" },
  {
    id: "desktop.navigate",
    category: "desktop",
    description: "Move focus and selection between icons",
    context: DESKTOP_CONTEXT,
    combos: [{ key: "ArrowUp", loose: true }, { key: "ArrowDown", loose: true }, { key: "ArrowLeft", loose: true }, { key: "ArrowRight", loose: true }],
    scope: "local",
  },

  // ---- Window management ----
  {
    id: "window.toggleMaximize",
    category: "window",
    description: "Maximize or restore the active window",
    context: "Anywhere",
    combos: [{ key: "ArrowUp", alt: true, shift: true }],
    scope: "global",
    settingKey: "keyboard.windowShortcuts",
    allowInEditable: true,
  },
  {
    id: "window.minimize",
    category: "window",
    description: "Minimize the active window",
    context: "Anywhere",
    combos: [{ key: "ArrowDown", alt: true, shift: true }],
    scope: "global",
    settingKey: "keyboard.windowShortcuts",
    allowInEditable: true,
  },
  {
    id: "window.close",
    category: "window",
    description: "Close the active window",
    context: "Anywhere",
    combos: [{ key: "w", alt: true, shift: true }],
    scope: "global",
    settingKey: "keyboard.windowShortcuts",
    allowInEditable: true,
  },
  {
    id: "window.next",
    category: "window",
    description: "Cycle through open windows",
    context: "Anywhere",
    combos: [{ code: "Backquote", alt: true }],
    scope: "global",
    settingKey: "keyboard.windowShortcuts",
    allowInEditable: true,
  },
  {
    id: "window.previous",
    category: "window",
    description: "Switch back to the previously used window",
    context: "Anywhere",
    combos: [{ code: "Backquote", alt: true, shift: true }],
    scope: "global",
    settingKey: "keyboard.windowShortcuts",
    allowInEditable: true,
  },

  // ---- File Explorer ----
  { id: "fileExplorer.selectAll", category: "fileExplorer", description: "Select all items in the folder", context: EXPLORER_CONTEXT, combos: [{ key: "a", mod: true }], scope: "local" },
  { id: "fileExplorer.copy", category: "fileExplorer", description: "Copy selected items", context: EXPLORER_CONTEXT, combos: [{ key: "c", mod: true }], scope: "local" },
  { id: "fileExplorer.cut", category: "fileExplorer", description: "Cut selected items", context: EXPLORER_CONTEXT, combos: [{ key: "x", mod: true }], scope: "local" },
  { id: "fileExplorer.paste", category: "fileExplorer", description: "Paste into the current folder", context: EXPLORER_CONTEXT, combos: [{ key: "v", mod: true }], scope: "local" },
  { id: "fileExplorer.delete", category: "fileExplorer", description: "Move selected items to Trash", context: EXPLORER_CONTEXT, combos: [{ key: "Delete", loose: true }], scope: "local" },
  { id: "fileExplorer.rename", category: "fileExplorer", description: "Rename the selected item", context: EXPLORER_CONTEXT, combos: [{ key: "F2", loose: true }], scope: "local" },
  { id: "fileExplorer.open", category: "fileExplorer", description: "Open the focused item", context: EXPLORER_CONTEXT, combos: [{ key: "Enter", loose: true }], scope: "local" },
  { id: "fileExplorer.clearSelection", category: "fileExplorer", description: "Clear the selection", context: EXPLORER_CONTEXT, combos: [{ key: "Escape", loose: true }], scope: "local" },
  { id: "fileExplorer.refresh", category: "fileExplorer", description: "Refresh the current folder", context: EXPLORER_CONTEXT, combos: [{ key: "F5" }], scope: "local" },
  { id: "fileExplorer.focusAddress", category: "fileExplorer", description: "Edit the address bar", context: EXPLORER_CONTEXT, combos: [{ key: "l", mod: true }], scope: "local" },
  { id: "fileExplorer.up", category: "fileExplorer", description: "Go up one folder", context: EXPLORER_CONTEXT, combos: [{ key: "ArrowUp", alt: true }], scope: "local" },
  { id: "fileExplorer.newFolder", category: "fileExplorer", description: "Create a new folder", context: EXPLORER_CONTEXT, combos: [{ key: "n", ctrl: true, alt: true }], scope: "local" },
  {
    id: "fileExplorer.navigate",
    category: "fileExplorer",
    description: "Move focus between items",
    context: EXPLORER_CONTEXT,
    combos: [{ key: "ArrowUp", loose: true }, { key: "ArrowDown", loose: true }, { key: "ArrowLeft", loose: true }, { key: "ArrowRight", loose: true }],
    scope: "local",
  },

  // ---- Terminal ----
  { id: "terminal.run", category: "terminal", description: "Run the command", context: TERMINAL_CONTEXT, combos: [{ key: "Enter", loose: true }], scope: "local" },
  { id: "terminal.complete", category: "terminal", description: "Complete a command or path", context: TERMINAL_CONTEXT, combos: [{ key: "Tab", loose: true }], scope: "local" },
  { id: "terminal.historyPrevious", category: "terminal", description: "Previous command from history", context: TERMINAL_CONTEXT, combos: [{ key: "ArrowUp", loose: true }], scope: "local" },
  { id: "terminal.historyNext", category: "terminal", description: "Next command from history", context: TERMINAL_CONTEXT, combos: [{ key: "ArrowDown", loose: true }], scope: "local" },
  { id: "terminal.clear", category: "terminal", description: "Clear the screen", context: TERMINAL_CONTEXT, combos: [{ key: "l", ctrl: true }], scope: "local" },
  { id: "terminal.cancel", category: "terminal", description: "Cancel the current line", context: TERMINAL_CONTEXT, combos: [{ key: "c", ctrl: true }], scope: "local" },

  // ---- Start Menu ----
  {
    id: "startMenu.toggle",
    category: "startMenu",
    description: "Open or close the Start Menu",
    context: "Anywhere",
    combos: [{ key: "Meta" }],
    scope: "global",
    settingKey: "keyboard.startMenuKey",
    allowInEditable: true,
  },
  { id: "startMenu.close", category: "startMenu", description: "Close the Start Menu", context: START_CONTEXT, combos: [{ key: "Escape", loose: true }], scope: "local" },
  { id: "startMenu.launchFirst", category: "startMenu", description: "Open the first search result", context: "Start Menu search box", combos: [{ key: "Enter", loose: true }], scope: "local" },
  { id: "startMenu.next", category: "startMenu", description: "Move to the next item", context: START_CONTEXT, combos: [{ key: "ArrowDown", loose: true }, { key: "ArrowRight", loose: true }], scope: "local" },
  { id: "startMenu.previous", category: "startMenu", description: "Move to the previous item", context: START_CONTEXT, combos: [{ key: "ArrowUp", loose: true }, { key: "ArrowLeft", loose: true }], scope: "local" },
]);

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
