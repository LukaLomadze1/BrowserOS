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
 * System applications: Notes, Calculator, Calendar, Clock, and Image
 * Viewer are registered alongside the shell apps. Calendar reminders
 * and Clock alarms/timers are owned by CalendarService and
 * ClockService, which start right after the VFS so they keep working
 * whether or not their windows are open. Files open in the application
 * chosen by src/core/fileAssociations.js.
 *
 * Desktop shortcuts list only app ids; their names and icons come from
 * AppManager's registry, the single source of application metadata.
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
import { calendarService } from "./core/calendar/calendarService.js";
import { clockService } from "./core/clock/clockService.js";
import { notificationService } from "./core/notifications/notificationService.js";
import { fileAssociations } from "./core/fileAssociations.js";
import { seedSamplePictures } from "./core/vfs/sampleContent.js";

/** App ids shown as desktop shortcuts; names and icons come from AppManager. */
const DESKTOP_SHORTCUT_APPS = [
  { appId: "about", type: "application" },
  { appId: "calculator", type: "application" },
  { appId: "notes", type: "application" },
  { appId: "file-explorer", type: "application" },
  { appId: "terminal", type: "application" },
  { appId: "calendar", type: "application" },
  { appId: "clock", type: "application" },
  { appId: "recycle-bin", type: "system" },
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
    description: "Version and system information",
    category: "System",
    singleInstance: true,
    loader: () => import("./apps/about/main.js"),
  });
  appManager.register({
    id: "notes",
    name: "Notes",
    icon: "\u270e",
    description: "Rich-text notes and plain-text documents",
    category: "Productivity",
    singleInstance: true,
    loader: () => import("./apps/notes/main.js"),
  });
  appManager.register({
    id: "calendar",
    name: "Calendar",
    icon: "\u25a3",
    description: "Events, recurring schedules, and reminders",
    category: "Productivity",
    singleInstance: true,
    loader: () => import("./apps/calendar/main.js"),
  });
  appManager.register({
    id: "calculator",
    name: "Calculator",
    icon: "\u25a6",
    description: "Standard and scientific calculator with history",
    category: "Utilities",
    singleInstance: false,
    loader: () => import("./apps/calculator/main.js"),
  });
  appManager.register({
    id: "clock",
    name: "Clock",
    icon: "\u23f0",
    description: "World clock, alarms, stopwatch, and timer",
    category: "Utilities",
    singleInstance: true,
    loader: () => import("./apps/clock/main.js"),
  });
  appManager.register({
    id: "image-viewer",
    name: "Image Viewer",
    icon: "\u25a7",
    description: "View PNG, JPEG, WebP, GIF, and SVG images",
    category: "Utilities",
    singleInstance: false,
    loader: () => import("./apps/image-viewer/main.js"),
  });
  appManager.register({
    id: "file-explorer",
    name: "File Explorer",
    icon: "\u25a4",
    description: "Browse and manage files and folders",
    category: "System",
    singleInstance: false,
    loader: () => import("./apps/file-explorer/main.js"),
  });
  appManager.register({
    id: "terminal",
    name: "Terminal",
    icon: "\u276f",
    description: "Command-line access to the file system",
    category: "System",
    singleInstance: false,
    loader: () => import("./apps/terminal/main.js"),
  });
  appManager.register({
    id: "settings",
    name: "Settings",
    icon: "\u2699",
    description: "Appearance, desktop, and system preferences",
    category: "System",
    singleInstance: true,
    loader: () => import("./apps/settings/main.js"),
  });
  appManager.register({
    id: "recycle-bin",
    name: "Recycle Bin",
    icon: "\u267b",
    description: "Items moved to Trash",
    category: "System",
    singleInstance: true,
    loader: () => import("./apps/recycle-bin/main.js"),
  });

  await vfs.init();

  // Services that must run whether or not their app windows are open.
  calendarService.init({ vfs, appManager });
  clockService.init();

  const recentFilesService = new RecentFilesService(vfs);
  recentFilesService.init();
  appManager.setRecentFilesService(recentFilesService);

  const desktopManager = new DesktopManager({
    container: desktop.getIconLayer(),
    shortcuts: DESKTOP_SHORTCUT_APPS.map(({ appId, type }) => {
      const app = appManager.getApp(appId);
      return { id: appId, appId, type, label: app.name, icon: app.icon ?? "\u25a2" };
    }),
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

  // Core services exposed on window for inspection and scripting from
  // the browser's developer console.
  window.appManager = appManager;
  window.vfs = vfs;
  window.settingsService = settingsService;
  window.keyboardShortcuts = keyboardShortcuts;
  window.notificationService = notificationService;
  window.fileAssociations = fileAssociations;
  window.calendarService = calendarService;
  window.clockService = clockService;

  // First-run sample images, created in the background.
  seedSamplePictures(vfs);

  await appManager.launch("about");
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
