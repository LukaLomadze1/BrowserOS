/**
 * @file BrowserOS entry point.
 *
 * Boot order: SettingsService loads, migrates, and validates the
 * persisted settings document → ThemeManager applies the appearance
 * settings to <html> before the desktop renders (the render-blocking
 * themePreboot.js script in index.html has already picked the right
 * theme for first paint, so there is no flash of the wrong theme) →
 * desktop builds its shell and exposes
 * a window layer + icon layer + start button → WindowManager attaches
 * to the window layer → AppManager attaches to WindowManager → apps
 * are registered (lazily — nothing is imported yet) → the Virtual
 * File System opens its database and seeds the default folder tree
 * on first boot → RecentFilesService attaches to the VFS, and
 * AppManager gets a reference to it so every app instance can record
 * recent files → DesktopManager attaches to the icon layer,
 * AppManager, the VFS, RecentFilesService, and the shared
 * ClipboardService, then reads `/Desktop` and renders it alongside
 * the application shortcuts → StartMenuManager attaches to
 * AppManager, the VFS, and RecentFilesService → About BrowserOS is
 * the only app auto-launched.
 *
 * Global keyboard shortcuts (src/core/keyboard/) are bound by the
 * subsystem that owns each behavior — WindowManager (window
 * management), DesktopManager (Escape), StartMenuManager (Win/Meta) —
 * and, for the application-launch shortcuts, at the end of boot()
 * below. Every subsystem reads its preferences from SettingsService
 * and re-applies them live when they change.
 *
 * The VFS must be ready before DesktopManager and RecentFilesService
 * start — that's why `vfs.init()` moved earlier and is awaited before
 * constructing them.
 *
 * File Explorer opens automatically whenever a folder is opened
 * (Desktop double-click, Start Menu, another Explorer window) via
 * vfsOpener's dynamic per-path registration, but it's also registered
 * here as a plain launchable app (Home view) so it's reachable from
 * the console and, via its desktop shortcut, without opening a folder
 * first:
 *   appManager.launch("file-explorer")
 *
 * Notes (personal mode, no file) is reachable the same way — desktop
 * text files open in Notes via double-click instead:
 *   appManager.launch("notes")
 *
 * Terminal is a full VFS-backed command line, reachable the
 * same way, or via its own desktop shortcut:
 *   appManager.launch("terminal")
 *
 * Settings is single-instance and accepts a deep link to a category;
 * launching it again focuses the open window and navigates it:
 *   appManager.launch("settings", { page: "appearance" })
 *
 * Settings values are reachable from the console as well, through the
 * same service the Settings app uses:
 *   settingsService.set("appearance.theme", "light")
 *
 * The VFS itself remains reachable from the console for anything
 * there's no UI for yet:
 *   await vfs.createFolder("/Documents/Projects")
 *   await vfs.list("/Documents")
 */

import { settingsService } from "./core/settings/settingsService.js";
import { themeManager } from "./core/theme.js";
import { Desktop } from "./core/desktop.js";
import { WindowManager } from "./core/windowManager.js";
import { AppManager } from "./core/appManager.js";
import { DesktopManager } from "./core/desktopManager.js";
import { StartMenuManager } from "./core/startMenuManager.js";
import { RecentFilesService } from "./core/recentFilesService.js";
import { clipboardService } from "./core/clipboardService.js";
import { vfs } from "./core/vfs/virtualFileSystem.js";
import { keyboardShortcuts } from "./core/keyboard/keyboardShortcuts.js";

const DESKTOP_SHORTCUTS = [
  { id: "about", label: "About BrowserOS", icon: "\u2726", appId: "about", type: "application" },
  { id: "calculator", label: "Calculator", icon: "\u25a6", appId: "calculator", type: "application" },
  { id: "notes", label: "Notes", icon: "\u270e", appId: "notes", type: "application" },
  { id: "file-explorer", label: "File Explorer", icon: "\u25a4", appId: "file-explorer", type: "application" },
  { id: "terminal", label: "Terminal", icon: "\u276f", appId: "terminal", type: "application" },
  { id: "recycle-bin", label: "Recycle Bin", icon: "\u267b", appId: "recycle-bin", type: "system" },
];

async function boot() {
  settingsService.init();
  themeManager.init();

  const root = document.getElementById("app-root");
  const desktop = new Desktop(root);
  desktop.init();

  const windowManager = new WindowManager(desktop.getWindowLayer());
  windowManager.init();

  const appManager = new AppManager(windowManager);
  appManager.init();

  appManager.register({
    id: "about",
    name: "About BrowserOS",
    icon: "\u2726",
    singleInstance: true,
    loader: () => import("./apps/about/main.js"),
  });
  appManager.register({
    id: "calculator",
    name: "Calculator",
    icon: "\u25a6",
    singleInstance: true,
    loader: () => import("./apps/calculator/main.js"),
  });
  appManager.register({
    id: "notes",
    name: "Notes",
    icon: "\u270e",
    singleInstance: false,
    loader: () => import("./apps/notes/main.js"),
  });
  appManager.register({
    id: "file-explorer",
    name: "File Explorer",
    icon: "\u25a4",
    singleInstance: false,
    loader: () => import("./apps/file-explorer/main.js"),
  });
  appManager.register({
    id: "terminal",
    name: "Terminal",
    icon: "\u276f",
    singleInstance: false,
    loader: () => import("./apps/terminal/main.js"),
  });
  appManager.register({
    id: "settings",
    name: "Settings",
    icon: "\u2699",
    singleInstance: true,
    loader: () => import("./apps/settings/main.js"),
  });
  appManager.register({
    id: "recycle-bin",
    name: "Recycle Bin",
    icon: "\u267b",
    singleInstance: true,
    loader: () => import("./apps/recycle-bin/main.js"),
  });

  await vfs.init();

  const recentFilesService = new RecentFilesService(vfs);
  recentFilesService.init();
  appManager.setRecentFilesService(recentFilesService);

  const desktopManager = new DesktopManager({
    container: desktop.getIconLayer(),
    shortcuts: DESKTOP_SHORTCUTS,
    appManager,
    vfs,
    recentFilesService,
    clipboardService,
  });
  await desktopManager.init();

  const startMenuManager = new StartMenuManager({
    startButtonEl: desktop.getStartButton(),
    appManager,
    vfs,
    recentFilesService,
  });
  startMenuManager.init();

  // Application shortcuts (gated by keyboard.appShortcuts). Launch
  // errors are logged rather than thrown into the key handler.
  const launchFromShortcut = (appId, options) => {
    appManager.launch(appId, options).catch((error) => {
      console.error(`[BrowserOS] shortcut failed to launch "${appId}":`, error);
    });
  };
  keyboardShortcuts.bind("general.openTerminal", () => launchFromShortcut("terminal"));
  keyboardShortcuts.bind("general.openExplorer", () => launchFromShortcut("file-explorer"));
  keyboardShortcuts.bind("general.openSettings", () => launchFromShortcut("settings"));

  // Exposed for manual testing per the app framework and virtual
  // file system steps' specs, and so future steps have something to
  // call without re-plumbing the boot sequence.
  window.appManager = appManager;
  window.vfs = vfs;
  window.settingsService = settingsService;
  window.keyboardShortcuts = keyboardShortcuts;

  await appManager.launch("about");
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
