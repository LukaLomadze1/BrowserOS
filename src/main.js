/**
 * @file BrowserOS entry point.
 *
 * Before anything else: BrowserOS refuses to start inside a frame of
 * its own origin, and waits until this tab holds the session — one
 * active tab per browser profile (src/core/system/sessionGuard.js).
 * If start-up fails (for example, browser storage can't be opened), a
 * full-window notice explains why instead of a half-built desktop.
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
 * AppManager, the VFS, and RecentFilesService → background services
 * start → on a new installation, the Welcome tour opens
 * (src/apps/welcome/); otherwise the desktop opens with no windows.
 *
 * The start-up screen in index.html shows each of these stages as it
 * finishes (src/core/system/bootScreen.js) and fades out once the
 * desktop is ready.
 *
 * System applications: Notes, Calculator, Calendar, Clock, and Image
 * Viewer are registered alongside the shell apps, and Code Studio (the
 * IDE, see src/apps/code-studio/) with its additional-window and
 * preview-window entries. Calendar reminders
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
 * start, so `vfs.init()` is awaited before constructing them.
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
import { eventBus } from "./core/eventBus.js";
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
import { openVfsEntry } from "./core/vfs/vfsOpener.js";
import { serviceManager } from "./core/services/serviceManager.js";
import { systemClock } from "./core/shell/systemClock.js";
import { TrayManager } from "./core/shell/trayManager.js";
import { appMonitor } from "./core/system/appMonitor.js";
import { storageMonitor } from "./core/system/storageMonitor.js";
import { bookmarkService } from "./core/browser/bookmarkService.js";
import { historyService } from "./core/browser/historyService.js";
import { downloadService } from "./core/downloads/downloadService.js";
import { sessionGuard } from "./core/system/sessionGuard.js";
import { showSystemScreen } from "./components/system-screen/systemScreen.js";
import { showConfirmDialog } from "./components/dialog/confirmDialog.js";
import { bootScreen } from "./core/system/bootScreen.js";
import { onboarding } from "./core/onboarding.js";

/** App ids shown as desktop shortcuts; names and icons come from AppManager. */
const DESKTOP_SHORTCUT_APPS = [
  { appId: "about", type: "application" },
  { appId: "calculator", type: "application" },
  { appId: "notes", type: "application" },
  { appId: "file-explorer", type: "application" },
  { appId: "terminal", type: "application" },
  { appId: "calendar", type: "application" },
  { appId: "clock", type: "application" },
  { appId: "browser", type: "application" },
  { appId: "code-studio", type: "application" },
  { appId: "recycle-bin", type: "system" },
];

/** Text and code files Code Studio opens by default (no other app handles them). */
const CODE_STUDIO_DEFAULT_EXTENSIONS = [
  "css", "js", "mjs", "cjs", "jsx", "ts", "tsx", "json", "webmanifest", "map",
  "xml", "yml", "yaml", "toml", "ini", "cfg", "conf", "env", "csv", "log",
  "scss", "sass", "less", "vue", "svelte", "sh", "bash", "ps1", "bat",
  "py", "rb", "php", "java", "kt", "c", "h", "cpp", "hpp", "cs", "go", "rs", "swift", "sql", "lua", "pl", "r",
];
/** sessionStorage flag: after "Use BrowserOS here" in a paused tab, ask for the session right away. */
const TAKEOVER_FLAG = "browseros:takeover";
/** Start-up stages shown on the start-up screen; the first (loading the code) is done once this module runs. */
const BOOT_STAGES = 5;
/** Files other apps open by default; Code Studio is offered under "Open with". */
const CODE_STUDIO_ALTERNATIVE_EXTENSIONS = ["html", "htm", "svg", "md", "txt"];

async function boot() {
  bootScreen.setStageCount(BOOT_STAGES);
  bootScreen.report(1, "Checking for other BrowserOS tabs");
  if (sessionGuard.isNestedInItself()) {
    bootScreen.remove();
    bootScreen.setState("failed");
    showSystemScreen({
      title: "BrowserOS is already running",
      message: "This page is BrowserOS itself, opened inside BrowserOS. It isn't started here, because two copies would share and overwrite the same files and settings.",
    });
    return;
  }
  await claimSession();
  try {
    await startDesktop();
  } catch (error) {
    console.error("[BrowserOS] start-up failed:", error);
    bootScreen.remove();
    bootScreen.setState("failed");
    showStartupFailure(error);
  }
}

/** @returns {Promise<void>} */
async function startDesktop() {
  bootScreen.report(1, "Loading settings");
  settingsService.init();
  themeManager.init();
  bootScreen.report(2, "Opening your files");

  const root = document.getElementById("app-root");
  const desktop = new Desktop(root);
  desktop.init();

  const windowManager = new WindowManager(desktop.getWindowLayer());
  windowManager.init();

  const appManager = new AppManager(windowManager);
  appManager.init();
  desktop.attachAppManager(appManager);

  appManager.register({
    id: "about",
    name: "About BrowserOS",
    icon: "icon:browseros",
    description: "Version, system information, applications, and credits",
    category: "System",
    singleInstance: true,
    loader: () => import("./apps/about/main.js"),
  });
  appManager.register({
    id: "welcome",
    name: "Welcome",
    icon: "icon:compass",
    description: "Get started: appearance, a short tour, and sample files",
    category: "System",
    singleInstance: true,
    loader: () => import("./apps/welcome/main.js"),
  });
  appManager.register({
    id: "notes",
    name: "Notes",
    icon: "icon:notes",
    description: "Rich-text notes and plain-text documents",
    category: "Productivity",
    singleInstance: true,
    loader: () => import("./apps/notes/main.js"),
  });
  appManager.register({
    id: "calendar",
    name: "Calendar",
    icon: "icon:calendar",
    description: "Events, recurring schedules, and reminders",
    category: "Productivity",
    singleInstance: true,
    loader: () => import("./apps/calendar/main.js"),
  });
  appManager.register({
    id: "calculator",
    name: "Calculator",
    icon: "icon:calculator",
    description: "Standard and scientific calculator with history",
    category: "Utilities",
    singleInstance: false,
    loader: () => import("./apps/calculator/main.js"),
  });
  appManager.register({
    id: "clock",
    name: "Clock",
    icon: "icon:clock",
    description: "World clock, alarms, stopwatch, and timer",
    category: "Utilities",
    singleInstance: true,
    loader: () => import("./apps/clock/main.js"),
  });
  appManager.register({
    id: "image-viewer",
    name: "Image Viewer",
    icon: "icon:image",
    description: "View PNG, JPEG, WebP, GIF, and SVG images",
    category: "Utilities",
    singleInstance: false,
    loader: () => import("./apps/image-viewer/main.js"),
  });
  appManager.register({
    id: "file-explorer",
    name: "File Explorer",
    icon: "icon:folder",
    description: "Browse and manage files and folders",
    category: "System",
    singleInstance: false,
    loader: () => import("./apps/file-explorer/main.js"),
  });
  appManager.register({
    id: "terminal",
    name: "Terminal",
    icon: "icon:terminal",
    description: "Command-line access to the file system",
    category: "System",
    singleInstance: false,
    loader: () => import("./apps/terminal/main.js"),
  });
  appManager.register({
    id: "settings",
    name: "Settings",
    icon: "icon:gear",
    description: "Appearance, desktop, and system preferences",
    category: "System",
    singleInstance: true,
    loader: () => import("./apps/settings/main.js"),
  });
  appManager.register({
    id: "recycle-bin",
    name: "Recycle Bin",
    icon: "icon:trash",
    description: "Items moved to Trash",
    category: "System",
    singleInstance: true,
    loader: () => import("./apps/recycle-bin/main.js"),
  });
  appManager.register({
    id: "task-manager",
    name: "Task Manager",
    icon: "icon:activity",
    description: "Running applications, performance, and background services",
    category: "System",
    singleInstance: true,
    loader: () => import("./apps/task-manager/main.js"),
  });
  appManager.register({
    id: "browser",
    name: "Browser",
    icon: "icon:globe",
    description: "Browse the web with tabs, bookmarks, history, and downloads",
    category: "Internet",
    singleInstance: false,
    loader: () => import("./apps/browser/main.js"),
  });
  appManager.register({
    id: "code-studio",
    name: "Code Studio",
    icon: "icon:code",
    description: "Code editor with projects, live preview, search, and diagnostics",
    category: "Development",
    singleInstance: true,
    loader: () => import("./apps/code-studio/main.js"),
  });
  // Additional Code Studio windows (File > New window) and pop-out
  // previews belong to the Code Studio application in the taskbar and
  // Task Manager, but aren't separate entries in the Start Menu.
  appManager.register({
    id: "code-studio-window",
    name: "Code Studio",
    icon: "icon:code",
    description: "Another Code Studio window",
    category: "Development",
    dynamic: true,
    groupId: "code-studio",
    loader: () => import("./apps/code-studio/main.js"),
  });
  appManager.register({
    id: "code-studio-preview",
    name: "Code Studio Preview",
    icon: "icon:play",
    description: "Live preview opened from Code Studio",
    category: "Development",
    dynamic: true,
    groupId: "code-studio",
    loader: () => import("./apps/code-studio/previewWindow.js"),
  });
  appManager.register({
    id: "downloads",
    name: "Downloads",
    icon: "icon:download",
    description: "Download Manager: files downloaded into /Downloads",
    category: "Internet",
    singleInstance: true,
    loader: () => import("./apps/downloads/main.js"),
  });

  // Code Studio handles source files; existing defaults (Browser for
  // HTML, Notes for text, Image Viewer for SVG) stay first.
  fileAssociations.register({ appId: "code-studio", label: "Code Studio", extensions: CODE_STUDIO_DEFAULT_EXTENSIONS, description: "Source file" });
  fileAssociations.register({ appId: "code-studio", label: "Code Studio", extensions: CODE_STUDIO_ALTERNATIVE_EXTENSIONS, description: "Source file" });

  await vfs.init();
  bootScreen.report(3, "Loading the desktop");

  // Data for services that run whether or not their app windows are open.
  calendarService.init({ vfs, appManager });
  bookmarkService.init({ vfs });
  clockService.init();

  const recentFilesService = new RecentFilesService(vfs);
  recentFilesService.init();
  appManager.setRecentFilesService(recentFilesService);

  // Notifications name their source application and open what they
  // refer to through the same paths as the rest of the shell.
  notificationService.configure({
    resolveSource: (source) => {
      const app = appManager.getApp(source);
      return app ? { name: app.name, icon: app.icon } : null;
    },
    performAction: async (action) => {
      if (action.type === "launch") {
        if (!appManager.isRegistered(action.appId)) return false;
        await appManager.launch(action.appId, action.options ?? {});
        return true;
      }
      if (action.type === "open") {
        if (!(await vfs.exists(action.path))) return false;
        await openVfsEntry(await vfs.getInfo(action.path), { appManager, recentFilesService });
        return true;
      }
      return false;
    },
  });
  appMonitor.configure({ appManager });
  downloadService.configure({
    vfs,
    openPath: async (path) => openVfsEntry(await vfs.getInfo(path), { appManager, recentFilesService }),
  });

  // Background services (see src/core/services/serviceManager.js).
  serviceManager.register({
    id: "notifications",
    name: "Notifications",
    description: "Notification banners, the Notification Center, and Do Not Disturb.",
    essential: true,
    start: () => notificationService.start(),
    stop: () => notificationService.stop(),
    getDetails: () => notificationService.getDetails(),
  });
  serviceManager.register({
    id: "system-clock",
    name: "System clock",
    description: "Keeps the taskbar clock and date panel up to date.",
    start: () => systemClock.start(),
    stop: () => systemClock.stop(),
    getDetails: () => systemClock.getDetails(),
  });
  serviceManager.register({
    id: "calendar-reminders",
    name: "Calendar reminders",
    description: "Shows reminders for upcoming Calendar events.",
    dependencies: ["notifications"],
    start: () => calendarService.startReminders(),
    stop: () => calendarService.stopReminders(),
    getDetails: () => calendarService.getReminderDetails(),
  });
  serviceManager.register({
    id: "clock-alarms",
    name: "Alarms and timer",
    description: "Rings Clock alarms and announces when the timer finishes.",
    dependencies: ["notifications"],
    start: () => clockService.startScheduler(),
    stop: () => clockService.stopScheduler(),
    getDetails: () => clockService.getSchedulerDetails(),
  });
  serviceManager.register({
    id: "app-monitor",
    name: "Application monitor",
    description: "Reports application errors and measures how responsive BrowserOS is.",
    dependencies: ["notifications"],
    start: () => appMonitor.start(),
    stop: () => appMonitor.stop(),
    getDetails: () => appMonitor.getDetails(),
  });
  serviceManager.register({
    id: "storage-monitor",
    name: "Storage monitor",
    description: "Warns when BrowserOS can't save data or browser storage is nearly full.",
    dependencies: ["notifications"],
    start: () => storageMonitor.start(),
    stop: () => storageMonitor.stop(),
    getDetails: () => storageMonitor.getDetails(),
  });
  serviceManager.register({
    id: "downloads",
    name: "Downloads",
    description: "Downloads files from the web into /Downloads and keeps the download list.",
    dependencies: ["notifications"],
    start: () => downloadService.start(),
    stop: () => downloadService.stop(),
    getDetails: () => downloadService.getDetails(),
  });

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
    powerActions: {
      restart: () => restartBrowserOS({ appManager }),
      shutDown: () => shutDownBrowserOS({ appManager }),
    },
  });
  startMenuManager.init();

  const trayManager = new TrayManager({ trayEl: desktop.getTrayElement(), appManager, calendarService });
  trayManager.init();
  bootScreen.report(4, "Starting services");

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
  keyboardShortcuts.bind("general.openTaskManager", () => launchFromShortcut("task-manager"));

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
  window.serviceManager = serviceManager;
  window.trayManager = trayManager;
  window.appMonitor = appMonitor;
  window.bookmarkService = bookmarkService;
  window.historyService = historyService;
  window.downloadService = downloadService;

  await serviceManager.startAll();

  watchStorageConnection();
  handOverSessionOnRequest({ appManager });

  // The Welcome tour opens on a new installation, and again at the next
  // start if it was neither finished nor skipped.
  if (onboarding.shouldShowAtStart({ newInstallation: vfs.isNewInstallation() })) {
    try {
      await appManager.launch("welcome", { firstRun: true });
    } catch (error) {
      console.error("[BrowserOS] the Welcome tour couldn't open:", error);
    }
  }
  bootScreen.finish();
}

/**
 * Wait until this tab holds the BrowserOS session (see sessionGuard.js),
 * showing a notice while another tab has it.
 * @returns {Promise<void>}
 */
async function claimSession() {
  let screen = null;
  let autoTakeover = false;
  try {
    autoTakeover = window.sessionStorage.getItem(TAKEOVER_FLAG) === "1";
    window.sessionStorage.removeItem(TAKEOVER_FLAG);
  } catch {
    autoTakeover = false;
  }
  await sessionGuard.claim({
    onWaiting: ({ requestTakeover, onStatus }) => {
      bootScreen.remove();
      bootScreen.setState("waiting");
      const useHere = { label: "Use BrowserOS here", primary: true, onClick: () => requestTakeover() };
      screen = showSystemScreen({
        title: "BrowserOS is open in another tab",
        message: "BrowserOS runs in one tab at a time, so that two copies never overwrite each other's files and settings. Close the other tab, or use BrowserOS here instead.",
        actions: [useHere],
      });
      onStatus((status) => {
        if (status === "requested") screen.update({ status: "Waiting for the other tab to save and pause BrowserOS\u2026", actions: [] });
        if (status === "waiting-unsaved") screen.update({ status: "The other tab has unsaved changes. Switch to it to save them, or to confirm that this tab can continue.", actions: [] });
        if (status === "denied") screen.update({ status: "The other tab is still being used.", actions: [useHere] });
      });
      if (autoTakeover) requestTakeover();
    },
  });
  screen?.remove();
}

/**
 * In the active tab: hand the session to another tab that asks for it,
 * after asking the user if any application has unsaved work.
 * @param {{appManager: AppManager}} deps
 * @returns {void}
 */
function handOverSessionOnRequest({ appManager }) {
  let asking = false;
  sessionGuard.onTakeoverRequest(async (request) => {
    if (asking) return;
    const unsaved = [];
    for (const app of appManager.getRunningApplications()) {
      for (const warning of appManager.getCloseWarnings(app.appId)) unsaved.push(`${app.name}: ${warning}`);
    }
    if (unsaved.length > 0) {
      request.respondWaiting("unsaved");
      asking = true;
      const proceed = await showConfirmDialog({
        title: "BrowserOS was opened in another tab",
        message: `Switch to the other tab? Unsaved work here will be lost: ${unsaved.slice(0, 3).join(" \u00b7 ")}`,
        confirmLabel: "Switch to the other tab",
        cancelLabel: "Keep using this tab",
        destructive: true,
      });
      asking = false;
      if (!proceed) {
        request.deny();
        return;
      }
    }
    // Save what is pending, stop timers and services, then let go.
    settingsService.flush();
    historyService.flush();
    serviceManager.stopAll();
    sessionGuard.release();
    showSystemScreen({
      title: "BrowserOS is open in another tab",
      message: "BrowserOS moved to another tab. Everything was saved there; this tab is paused so the two never overwrite each other.",
      actions: [
        {
          label: "Use BrowserOS here",
          primary: true,
          onClick: () => {
            try {
              window.sessionStorage.setItem(TAKEOVER_FLAG, "1");
            } catch {
              /* without the flag, the next start shows the button again */
            }
            window.location.reload();
          },
        },
      ],
    });
  });
}

/**
 * If the browser closes the file-system database underneath BrowserOS
 * (site data cleared, or a newer version upgrading it), stop and offer
 * a reload rather than failing on every later file operation.
 * @returns {void}
 */
function watchStorageConnection() {
  eventBus.on("vfs:connectionClosed", ({ reason }) => {
    showSystemScreen({
      title: reason === "versionchange" ? "BrowserOS was updated" : "BrowserOS lost access to its storage",
      message:
        reason === "versionchange"
          ? "A newer version of BrowserOS opened in another tab and needs to update the file system. Reload to continue with the new version."
          : "The browser closed BrowserOS's file storage (for example because site data was cleared). Reload to continue.",
      actions: [{ label: "Reload", primary: true, onClick: () => window.location.reload() }],
    });
  });
}

/**
 * @param {*} error
 * @returns {void}
 */
function showStartupFailure(error) {
  const code = error?.code;
  let message = "Something went wrong while BrowserOS was starting. Your files have not been changed.";
  if (code === "STORAGE_BLOCKED") {
    message = "Another tab is holding BrowserOS's file storage open with an older version. Close other BrowserOS tabs, then try again.";
  } else if (code === "STORAGE_UNAVAILABLE" || code === "STORAGE_ERROR") {
    message =
      "BrowserOS keeps files in the browser's storage (IndexedDB), and it couldn't be opened. This happens when site data is blocked for this address, in some private browsing modes, or when browser storage is full or damaged.";
  }
  showSystemScreen({
    title: "BrowserOS couldn't start",
    message,
    detail: error?.message ? String(error.message) : String(error),
    actions: [{ label: "Try again", primary: true, onClick: () => window.location.reload() }],
  });
}

/**
 * Start menu › Restart: let applications finish (asking first if any
 * has unsaved work), save what is pending, and load BrowserOS again.
 * @param {{appManager: AppManager}} deps
 * @returns {Promise<void>}
 */
async function restartBrowserOS({ appManager }) {
  if (!(await confirmEndingSession(appManager, "Restart"))) return;
  endSession(appManager);
  window.location.reload();
}

/**
 * Start menu › Shut down: like Restart, but BrowserOS stays stopped
 * (and gives up the session, so another tab can use it) until the user
 * starts it again.
 * @param {{appManager: AppManager}} deps
 * @returns {Promise<void>}
 */
async function shutDownBrowserOS({ appManager }) {
  if (!(await confirmEndingSession(appManager, "Shut down"))) return;
  endSession(appManager);
  sessionGuard.release();
  showSystemScreen({
    title: "BrowserOS has shut down",
    message: "Everything was saved in this browser. You can close this tab, or start BrowserOS again.",
    actions: [{ label: "Start BrowserOS", primary: true, onClick: () => window.location.reload() }],
  });
}

/**
 * @param {AppManager} appManager
 * @param {string} action - "Restart" or "Shut down".
 * @returns {Promise<boolean>} Whether to go ahead.
 */
async function confirmEndingSession(appManager, action) {
  const unsaved = [];
  for (const app of appManager.getRunningApplications()) {
    for (const warning of appManager.getCloseWarnings(app.appId)) unsaved.push(`${app.name}: ${warning}`);
  }
  if (unsaved.length === 0) return true;
  return showConfirmDialog({
    title: `${action} with unsaved work?`,
    message: `Unsaved work will be lost: ${unsaved.slice(0, 3).join(" \u00b7 ")}`,
    confirmLabel: `${action} anyway`,
    cancelLabel: "Cancel",
    destructive: true,
  });
}

/**
 * End every application, save pending settings and history, and stop
 * the background services.
 * @param {AppManager} appManager
 * @returns {void}
 */
function endSession(appManager) {
  for (const app of appManager.getRunningApplications()) {
    try {
      appManager.endApplication(app.appId);
    } catch (error) {
      console.error(`[BrowserOS] "${app.appId}" didn't close cleanly:`, error);
    }
  }
  settingsService.flush();
  historyService.flush();
  serviceManager.stopAll();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
