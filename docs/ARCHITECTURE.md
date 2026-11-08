# BrowserOS Architecture

How BrowserOS is put together: the core services, how applications are
built and registered, how data is stored and kept consistent, and the
limits of what runs inside a browser page. For installation and an
overview of features, see the [README](../README.md); for the security
model, [SECURITY.md](SECURITY.md); for tests, [TESTING.md](TESTING.md).

## Contents

- [Overview](#overview)
- [Settings and preferences](#settings-and-preferences)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Applications](#applications)
- [Files and file associations](#files-and-file-associations)
- [Shared services](#shared-services)
- [System shell](#system-shell)
- [Background services](#background-services)
- [Browser architecture and limits](#browser-architecture-and-limits)
- [Code Studio architecture](#code-studio-architecture)
- [File system integrity and Trash](#file-system-integrity-and-trash)
- [Sessions and start-up](#sessions-and-start-up)
- [Welcome tour and sample files](#welcome-tour-and-sample-files)
- [Backup and restore](#backup-and-restore)
- [Visual identity and design system](#visual-identity-and-design-system)
- [Deployment and builds](#deployment-and-builds)
- [Persistence](#persistence)
- [Events reference](#events-reference)
- [Known limitations](#known-limitations)

## Overview

- **Manager / View split** for every window-owning subsystem
  (Desktop, File Explorer, Start Menu, Terminal, Settings): a `*View`
  renders what it's told and forwards raw DOM facts upward; a
  `*Manager` owns state and decides what those facts mean.
- **EventBus** (`src/core/eventBus.js`) — the only channel core
  services, apps, and components use to talk to each other.
- **Application → AppManager → WindowManager** — apps never touch
  WindowManager directly. Single-instance apps receive repeat-launch
  options through `onRelaunch(options)`, which is how deep links such
  as `appManager.launch("settings", { page: "desktop", anchor: "layout" })`
  reach an already-open window.
- **Virtual File System** (`src/core/vfs/`) — the single source of
  truth for every file and folder, backed by IndexedDB, exposed
  through one public API (`vfs`) that Desktop, File Explorer, Start
  Menu search, Terminal, and every application share. Applications
  never open IndexedDB themselves. Writes resolve only once committed,
  and multi-entry changes are single transactions. See
  [File system integrity and Trash](#file-system-integrity-and-trash).
- **Sessions and start-up** (`src/core/system/sessionGuard.js`,
  `src/components/system-screen/`) — one active BrowserOS tab per
  browser profile, and a recovery screen instead of a broken desktop
  when start-up fails. See [Sessions and start-up](#sessions-and-start-up).
- **Backup and restore** (`src/core/backup/`) — a versioned, validated
  backup format for everything or for one folder. See
  [Backup and restore](#backup-and-restore).
- **File associations** (`src/core/fileAssociations.js`) and
  **vfsOpener** (`src/core/vfs/vfsOpener.js`) — one registry decides
  which application opens a file, and one function opens it, for
  every entry point. See [Files and file associations](#files-and-file-associations).
- **Shared services** for applications: notifications, dialogs,
  calendar data, and clock state live in `src/core/` and
  `src/components/`, not inside individual apps, so they keep working
  while the owning app's window is closed.
- **Background services** (`src/core/services/serviceManager.js`) —
  long-lived system components (notifications, the taskbar clock,
  calendar reminders, alarms, monitors) are registered with
  ServiceManager, which starts them in dependency order, prevents
  double initialization, records failures, and stops them on unload.
  See [Background services](#background-services).
- **System shell** — the taskbar (`src/core/desktop.js`), the system
  tray (`src/core/shell/trayManager.js`), and its panels
  (`src/components/shell/`): Notification Center, Quick Settings, and
  the date panel. See [System shell](#system-shell).
- **Browser** — the Browser application (`src/apps/browser/`) with
  shared data services in `src/core/browser/` (history, bookmarks,
  start-page shortcuts, embedding policy, address parsing, search
  engines) and the Download Manager service in `src/core/downloads/`.
  See [Browser architecture and limits](#browser-architecture-and-limits).
- **Code Studio** — the development environment (`src/apps/code-studio/`):
  a layered code editor, language registry, diagnostics, and a
  sandboxed live preview built from project files in the VFS. See
  [Code Studio architecture](#code-studio-architecture).
- **Icons** (`src/utils/icons.js`) — one set of line icons drawn on a
  24 × 24 grid (`"icon:clock"`), used for applications, file types,
  window controls, and toolbars; every surface renders them through
  `renderIcon()` / `createIconElement()`. See
  [Visual identity and design system](#visual-identity-and-design-system).
- **Start-up screen and first run** — `index.html` paints a start-up
  screen before any script runs; `src/core/system/bootScreen.js` reports
  real start-up stages on it. A new installation opens the Welcome tour
  (`src/apps/welcome/`), which can add sample files
  (`src/core/demo/`). See [Welcome tour and sample files](#welcome-tour-and-sample-files).
- **Settings** (`src/core/settings/`) — the single source of truth for
  every preference. See below.
- **Keyboard shortcuts** (`src/core/keyboard/`) — one catalog and one
  global dispatcher. See below.

## Settings and preferences

Every preference has exactly one authoritative value, held by
`settingsService`. Subsystems never keep their own copies: each one
subscribes to its category and applies changes as they happen, so
nothing needs a reload and every open window stays in sync.

| Module                               | Responsibility                                                                                                                                       |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `settingsSchema.js`                  | Declares every setting: key, category, type, default, allowed values or range, persistence, optional `migrate` hook. The only place defaults exist. |
| `settingsService.js`                 | Validates, stores, and persists values; notifies subscribers. Knows nothing about the DOM.                                                           |
| `settingsMigrations.js`              | Upgrades the persisted document (`{ version, values }`) between versions; tolerates missing, malformed, and newer documents.                        |
| `settingsIndex.js`                   | Searchable list of Settings sections, shared by Start Menu search and the Settings sidebar search.                                                  |
| `accentPresets.js`                   | Curated accent palettes, each with hand-tuned dark and light variants.                                                                               |
| `themePreboot.js`                    | Render-blocking script in `index.html` that sets the stored theme before first paint, so there is no flash of the wrong theme.                       |

### Categories and their consumers

| Category       | Applied by                                         | Settings                                                                                                                                                                                                 |
| -------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `appearance`   | `themeManager` (`src/core/theme.js`)               | theme (dark / light / system), accent, transparency, blur, window radius, animation speed, reduced motion                                                                                                |
| `wallpaper`    | `themeManager`                                     | preset (Aurora, Nebula, Sunset, Ocean, Graphite, Solid), dimming                                                                                                                                         |
| `desktop`      | `DesktopManager`                                   | icon size, labels, grid spacing, auto arrange, align to grid, show icons, show system shortcuts, single/double click to open, rectangle selection, Trash confirmation                                    |
| `startMenu`    | `StartMenuManager`                                 | show pinned / recent apps / recent files, recent limits, pinned app list, search sources (apps, files, folders, settings), apps first, case-insensitive matching, result limit                           |
| `fileExplorer` | every `ExplorerManager`                            | view (grid / list / details), extensions, hidden files, size / date / type columns, sort field and direction, folders first, startup location (incl. custom folder), reopen last location, open folders in same/new window, Trash confirmation |
| `keyboard`     | `keyboardShortcuts`                                | Win/Meta opens Start, window shortcuts, application shortcuts                                                                                                                                            |
| `notifications`| `notificationService`                              | Do Not Disturb, banner duration, message previews, sounds, history limit                                                                                                                                 |
| `taskbar`      | `TrayManager`                                      | show time, show date, clock format (automatic / 12-hour / 24-hour), seconds                                                                                                                              |
| `taskManager`  | every Task Manager window                          | refresh interval                                                                                                                                                                                         |
| `browser`      | every Browser window, `historyService`             | search engine, homepage, bookmarks bar, start page clock and background, history retention                                                                                                              |
| `codeStudio`   | every Code Studio window                           | editor theme (system / dark / light), font size, font, tab width, spaces or tabs, line numbers, word wrap, auto-closing brackets, live preview while typing |
| `downloads`    | `downloadService`                                  | largest download, completion notifications                                                                                                                                                               |

Defaults for every key are in `settingsSchema.js`. Highlights:
medium icons, normal spacing, double-click to open, grid view sorted
by name with folders first, File Explorer opening at Home, and every
search source enabled.

### Public API

```js
settingsService.get("desktop.iconSize"); // "small" | "medium" | "large"
settingsService.set("desktop.iconSize", "large"); // validated; false if rejected
settingsService.setMany({ "fileExplorer.sortField": "size", "fileExplorer.sortDirection": "desc" }); // one batch
settingsService.reset("desktop.iconSize"); // back to the schema default
settingsService.resetCategory("desktop"); // one batch, one write
settingsService.resetAll(); // every category; files and layouts are untouched
settingsService.getCategory("desktop"); // frozen snapshot
settingsService.getAll(); // frozen snapshot of everything
settingsService.getCustomizedKeys(); // keys that differ from their defaults

const off = settingsService.subscribe("desktop.iconSize", (change) => {});
const offCategory = settingsService.subscribeCategory("desktop", (batch) => {});
// each subscribe* call returns an idempotent cleanup function
```

Values are strings, numbers, booleans, or arrays of those (the pinned
app list). Arrays are handed out frozen; pass a new array to change
one.

### Persistence

Settings are stored through `StorageService` (localStorage) under
`browseros:settings` as `{ version, values }`. Only explicitly chosen
values are stored, so a key that was never changed (or was reset)
always follows the schema's current default. Writes are coalesced
briefly and flushed on `pagehide`. On load, every stored value is
validated; invalid values fall back to their defaults, a recoverable
older shape is repaired through the key's `migrate` hook, unknown keys
are preserved for newer builds, and malformed documents are discarded
without affecting boot. Document migrations also absorb older storage
keys (the original theme key and File Explorer's view and sort keys),
so each preference exists in exactly one place.

### Extending

1. Add a descriptor to `SETTINGS_SCHEMA` (`"<category>.<name>"`).
2. Read it with `settingsService.get()` and react with
   `subscribeCategory()` in the subsystem that owns the behavior;
   remember to call the returned cleanup when that subsystem is
   destroyed.
3. Add a control to the category's page in `src/apps/settings/pages/`.
   Pages built on `SettingsPage` bind a control to a key in one call
   (`toggleRow`, `segmentedRow`, `selectRow`, `sliderRow`), including
   live syncing and a per-setting reset.
4. Add an entry to `settingsIndex.js` if the section should be
   searchable.

If the stored shape changes, bump `SETTINGS_VERSION` and add a step to
`settingsMigrations.js`.

### Selected vs. effective appearance

The theme and reduced-motion settings both accept `"system"`.
SettingsService stores the _selected_ value; ThemeManager resolves the
_effective_ value from `prefers-color-scheme` /
`prefers-reduced-motion` and updates it live when the OS preference
changes, without ever rewriting the stored selection. Both are exposed
on `<html>` (`data-theme`, `data-theme-mode`, `data-reduced-motion`) and
through `themeManager.getAppearanceState()`.

ThemeManager writes a handful of `data-*` attributes and custom
properties on `<html>`; `styles/variables.css` and
`styles/wallpapers.css` map those onto the shared design tokens, so
components restyle themselves with no per-component code.

### Events

| Event                                                         | When                                                                                     |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `settings:initialized`                                        | Settings loaded and validated during boot.                                               |
| `settings:changed`                                            | A key's value changed through `set()`, `setMany()`, or `reset()` (once per key).         |
| `settings:<category>Changed`                                  | Once per batch for each affected category, e.g. `settings:desktopChanged`, for every kind of change including resets. |
| `settings:reset`                                              | `reset(key)` was called.                                                                 |
| `settings:categoryReset` / `settings:allReset`                | A category / every setting was reset (carries the batch's changes).                     |
| `settings:persistenceFailed` / `settings:persistenceRestored` | Storage writes started failing / recovered.                                              |
| `appearance:changed` and `appearance:*Changed`                | The effective appearance changed (theme, accent, motion, wallpaper).                     |
| `desktop:preferencesApplied`                                  | DesktopManager finished applying a batch of desktop settings.                            |
| `recentFiles:changed` / `recentFiles:cleared`                 | The recent-files list changed / was cleared.                                             |
| `keyboard:shortcutsChanged`                                   | Shortcut definitions, bindings, or their enabled state changed.                          |

Request events: `startmenu:toggle`, `startmenu:clearRecentApps`. All
payloads are frozen. Application and file events are listed under
[Events reference](#events-reference).

## Keyboard shortcuts

`src/core/keyboard/shortcutCatalog.js` defines every shortcut BrowserOS
responds to — keys, description, context, and whether it is _global_
(works anywhere) or _local_ (only while a component has focus).

- **Global** shortcuts are dispatched by `keyboardShortcuts`, the only
  document-level shortcut listener. Owners attach handlers with
  `keyboardShortcuts.bind(id, handler)`. Events already handled by a
  focused component are skipped, text fields are left alone unless a
  shortcut is explicitly typing-safe, Ctrl + Alt combinations never
  fire when they produce an AltGr character, and a shortcut with a
  `settingKey` only fires while that setting is on.
- **Local** shortcuts stay in their owners (Desktop icon layer,
  Explorer window, Terminal input, Start Menu), which test events with
  `keyboardShortcuts.matches(event, id)` instead of comparing keys
  themselves. Inline rename fields and other text inputs are excluded,
  so Ctrl + A, Delete, and arrow keys keep their editing meaning.

Because handlers and the Settings reference read the same catalog, the
reference can never advertise a shortcut that doesn't work. Runtime
definitions can be added with `keyboardShortcuts.register(definition)`;
the reference updates automatically. Browser-reserved combinations
(Ctrl + N, Ctrl + T, Ctrl + W, Ctrl + Shift + N/T, Alt + Tab) are
deliberately not used, since a web page cannot intercept them. The
same applies to combinations the operating system keeps for itself,
such as Ctrl + Shift + Esc and Win + N / Win + A on Windows, which is
why Task Manager and the tray panels use the combinations below.

| Shortcut                     | Action                                     | Context          |
| ---------------------------- | ------------------------------------------ | ---------------- |
| Win / ⌘                      | Toggle the Start Menu                      | Anywhere         |
| Ctrl + Alt + T / E           | Open Terminal / File Explorer              | Anywhere         |
| Ctrl + ,                     | Open Settings                              | Anywhere         |
| Ctrl + Alt + Esc             | Open Task Manager                          | Anywhere         |
| Alt + Shift + N              | Open or close the Notification Center      | Anywhere         |
| Alt + Shift + A              | Open or close Quick Settings               | Anywhere         |
| Esc                          | Close the open tray panel                  | Tray panel open  |
| Alt + Shift + ↑ / ↓          | Maximize-restore / minimize active window  | Anywhere         |
| Alt + Shift + W              | Close active window                        | Anywhere         |
| Alt + \` / Alt + Shift + \`  | Cycle windows / back to previous window    | Anywhere         |
| Ctrl + A / C / X / V         | Select all / copy / cut / paste            | Desktop, Explorer |
| Delete, F2, Enter, F5        | Trash, rename, open, refresh               | Desktop, Explorer |
| Ctrl + L, Alt + ↑            | Edit address bar, go up a folder           | Explorer         |
| Ctrl + Alt + N               | New folder                                 | Explorer         |
| Tab, ↑ / ↓, Ctrl + L, Ctrl + C | Complete, history, clear, cancel line    | Terminal         |

Application shortcuts are local to the focused application window:

| Shortcut                                   | Action                                              | Context              |
| ------------------------------------------ | --------------------------------------------------- | -------------------- |
| Ctrl + Alt + N                             | New note                                            | Notes                |
| Ctrl + S / Ctrl + F                        | Save now / search notes                             | Notes                |
| Ctrl + Z / Ctrl + Y (or Ctrl + Shift + Z)  | Undo / redo                                         | Notes                |
| Ctrl + B / I / U, Ctrl + Shift + X         | Bold / italic / underline, strikethrough            | Notes editor         |
| Ctrl + K                                   | Insert or edit a link                               | Notes editor         |
| Ctrl + Shift + 7 / 8 / 9                   | Numbered list / bulleted list / checklist           | Notes editor         |
| Ctrl + Alt + 1 / 2 / 3 / 0                 | Heading 1 / 2 / 3 / normal paragraph                | Notes editor         |
| Enter or =, Escape or Delete, Backspace    | Calculate, clear, delete last entry                 | Calculator           |
| Ctrl + C                                   | Copy the result                                     | Calculator           |
| T, Page Up / Page Down                     | Today, previous / next period                       | Calendar             |
| N, M / W / D                               | New event, month / week / day view                  | Calendar             |
| Space, L                                   | Start or pause, record a lap                        | Clock (Stopwatch, Timer) |
| ← / →                                      | Previous / next image in the folder                 | Image Viewer         |
| + / −, 0, 1                                | Zoom in / out, fit to window, actual size           | Image Viewer         |
| R / Shift + R, Home, F                     | Rotate clockwise / counter-clockwise, reset, fullscreen | Image Viewer     |
| Alt + T, Alt + W, Alt + Shift + T          | New tab, close tab, reopen closed tab               | Browser              |
| Alt + Page Down / Page Up                  | Next / previous tab                                 | Browser              |
| Ctrl + L, Alt + D, F6                      | Focus the address bar                               | Browser              |
| Alt + ← / →, Ctrl + R or F5, Alt + Home     | Back / forward, reload, home                        | Browser              |
| Ctrl + D, Ctrl + H, Ctrl + Shift + O, Ctrl + J | Bookmark, history, bookmark manager, downloads  | Browser              |
| Esc                                        | Stop loading                                        | Browser              |

The Browser uses Alt-based tab shortcuts because the host browser keeps
Ctrl + T, Ctrl + W, Ctrl + Shift + T, and Ctrl + Tab for its own tabs —
a web page never receives them, and Ctrl + W closes the host tab that
BrowserOS runs in. While the keyboard focus is inside an embedded web
page, keys go to that page, so Browser shortcuts work once focus is on
the Browser's own controls.

On macOS, ⌘ takes the place of Ctrl wherever a shortcut is defined
with the platform modifier. Arrow-key list navigation inside
applications ignores key presses that carry Ctrl, Alt, Shift, or ⌘, so
window shortcuts such as Alt + Shift + ↓ and Shift-selection in text
fields always work.

The full, always-current list is in **Settings › Keyboard Shortcuts**.

## Applications

| App           | Id              | Category     | Windows   | Opens                              |
| ------------- | --------------- | ------------ | --------- | ---------------------------------- |
| Notes         | `notes`         | Productivity | single    | `.note`, `.txt`, `.md`             |
| Calendar      | `calendar`      | Productivity | single    | —                                  |
| Calculator    | `calculator`    | Utilities    | multiple  | —                                  |
| Clock         | `clock`         | Utilities    | single    | —                                  |
| Image Viewer  | `image-viewer`  | Utilities    | multiple  | `.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`, `.svg` |
| File Explorer | `file-explorer` | System       | multiple  | folders                            |
| Terminal      | `terminal`      | System       | multiple  | —                                  |
| Settings      | `settings`      | System       | single    | —                                  |
| About         | `about`         | System       | single    | —                                  |
| Welcome       | `welcome`       | System       | single    | —                                  |
| Recycle Bin   | `recycle-bin`   | System       | single    | `/Trash` (restore, delete permanently, empty) |
| Task Manager  | `task-manager`  | System       | single    | —                                  |
| Browser       | `browser`       | Internet     | multiple  | `.html`, `.htm`                    |
| Downloads     | `downloads`     | Internet     | single    | —                                  |
| Code Studio   | `code-studio`   | Development  | multiple¹ | `.css`, `.js`, `.json`, and other source files; _Open with_ for `.html`, `.md`, `.txt`, `.svg`; folders as projects |

¹ The main window is single-instance; _File → New window_ opens more
(`code-studio-window`).

Every application is registered once in `src/main.js` and reaches the
Start Menu (all apps, search, pinning) and the Settings pin list from
that registration. Notes, Calendar, Calculator, Clock, Browser, Code
Studio, File Explorer, Terminal, About, and Recycle Bin also have
desktop shortcuts; Welcome opens by itself on a new installation and
from the Start Menu or Settings › System; Image Viewer is opened through files; Task Manager opens
from the Start Menu, Ctrl + Alt + Esc, or a taskbar button's context
menu; Downloads opens from the Start Menu, the Browser, download
notifications, and the `/Downloads` folder in File Explorer.

### Building an application

```js
appManager.register({
  id: "my-app",
  name: "My App",
  icon: "icon:activity", // a glyph such as "★", or a built-in line icon
  description: "One line shown in Start Menu search and Task Manager", // optional
  category: "Utilities", // optional
  singleInstance: true, // focus the open window instead of opening another
  restartable: true, // optional; false hides Restart in Task Manager
  loader: () => import("./apps/my-app/main.js"), // loaded on first launch
});
```

The module's default export extends `Application`
(`src/core/application.js`):

| Member                   | Called when                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------- |
| `launch(options)`        | The window is created. Returns `{ element, title?, icon?, width?, height?, minWidth?, minHeight?, … }`. `options` are the ones passed to `appManager.launch(id, options)`, e.g. `{ path }` when a file is opened. |
| `onRelaunch(options)`    | A single-instance app is launched again while open (the window is already focused).              |
| `onFocus()` / `onBlur()` | The app's window gains / loses focus.                                                             |
| `close()`                | The window is closing — by its close button, a shortcut, End task, or a restart. Release everything here: EventBus and settings subscriptions, timers, animation frames, observers, object URLs, document-level listeners. |
| `getCloseWarning()`      | Optional. Return a message when ending the application now would lose something (Notes returns one while a document can't be saved); Task Manager asks for confirmation first. |

`this.appManager` lets an application open other applications;
applications never call WindowManager directly. Window titles are
updated with `this.appManager.updateWindowTitle(this.windowId, title)`.

Long-lived state that must outlive a window belongs in a service in
`src/core/` (as Calendar and Clock do), not in the application, so
closing a window never stops a reminder, alarm, or timer.

### Application lifecycle

Each window has its own `Application` instance, and the windows of one
app form one *running application* (per-folder File Explorer windows
belong to `file-explorer`). AppManager guarantees that:

- app code loads on first launch; a module that fails to load, or a
  `launch()` that throws, is reported as `application:crashed` (with a
  notification) and leaves no half-created window behind;
- a single-instance app launched again — even several times while its
  first launch is still loading — focuses or reuses one window;
- every way a window goes away runs the instance's `close()`, and an
  exception thrown there is recorded instead of breaking the shell;
- closing one window of a multi-window app never touches the others;
- an application may define `onBeforeClose()` (returning a boolean or a
  promise of one) to keep its window open after a normal close request
  — for example when the user cancels a "save changes?" prompt. Ending
  an application from Task Manager doesn't ask; it shows the
  application's `getCloseWarning()` text instead.

```js
appManager.getRunningApplications(); // [{ appId, name, icon, startedAt, status, errorCount, lastError, windows: [...] }]
appManager.focusApplication("calculator"); // bring all its windows forward
appManager.toggleApplicationMinimized("calculator");
appManager.endApplication("calculator"); // remove every window now, running each close()
await appManager.restartApplication("clock"); // end, then reopen the same windows with their launch options
appManager.recordError("notes", error, "runtime"); // shown in Task Manager
appManager.focusWindow(windowId); appManager.minimizeWindow(windowId); appManager.closeWindow(windowId);
```

### Notes

Notes are files: each note is a `.note` document in
`/Documents/Notes`, created, renamed, and deleted through the VFS, so
notes also appear (and can be managed) in File Explorer. The sidebar
lists the library with live search over titles and content; files
opened from elsewhere (`.txt`, `.md`, or a `.note` outside the
library) are listed under _Opened files_.

- **Editing.** `.note` files use a rich editor: paragraphs, three
  heading levels, bold, italic, underline, strikethrough, bulleted
  and numbered lists, checklists, and links (Ctrl + click opens a
  link). `.txt` and `.md` files are edited as plain text and saved
  back as plain text; Markdown is not rendered.
- **Saving.** Changes save automatically 0.8 s after typing stops and
  when the note is switched or the window closes; Ctrl + S saves at
  once. The header shows _Unsaved changes_, _Saving…_, _Saved_, or an
  error with a retry button.
- **Drafts.** While a change is unsaved, a draft is mirrored to
  `StorageService` (`notes:draft:<entryId>`). If BrowserOS is closed
  before the save completes, the note offers _Restore_ / _Discard_ the
  next time it opens. Drafts older than the file are discarded.
- **External changes.** Renames, moves, edits, and deletions made in
  File Explorer, Terminal, or another window are followed live. A note
  deleted while open stays on screen, read-only, with _Save as new
  note_.
- **Single window.** Opening another note or text file switches the
  open Notes window to it after saving the current document.
- **Safety.** Note HTML is passed through an allowlist sanitizer
  (`src/apps/notes/noteFormat.js`) on load and on paste: only
  formatting elements survive, every attribute except checklist state
  and `http`, `https`, and `mailto` link targets is removed, and
  scripts, images, styles, and event handlers never reach the page.

`.note` format:

```json
{ "format": "browseros-note", "version": 1, "html": "<h1>Title</h1><p>…</p>" }
```

A `.note` file that is not valid JSON in this format is opened as
plain paragraphs, with a notice. Notes saved by earlier releases in
`localStorage` are moved into the library on first launch.

### Calculator

Standard and scientific modes, both evaluated by a recursive-descent
parser (`src/apps/calculator/expression.js`); `eval` and `Function` are
never used.

- Operators `+ − × ÷ ^ mod`, parentheses (unclosed ones are closed
  automatically), implicit multiplication (`2π`, `3(4+5)`), factorial,
  `E` for "times ten to the power", and percent: `200 + 10%` is 220,
  `50 × 10%` is 5.
- Functions: `sin cos tan asin acos atan sqrt cbrt ln log abs exp`,
  constants `π` (`pi`) and `e`, and `Ans` for the previous result.
  Trigonometry works in degrees or radians.
- Errors (division by zero, domain errors, overflow, malformed input)
  are shown in place of the result; the expression stays editable.
- Results are shown with up to 15 significant digits.
- The keyboard accepts digits, operators, parentheses, and letters for
  function names (`sin`, `sqrt`, `pi`, `ans`, `mod`); `x` multiplies
  unless it continues a name such as `exp`, and capital `E` is the
  exponent operator.
- History keeps the last 50 calculations (`calculator:history`),
  shared by every Calculator window; selecting an entry reuses its
  result. Mode, angle unit, and history visibility are remembered
  (`calculator:preferences`).

### Calendar

Month, week, and day views; create, edit, and delete events; all-day
and timed events; colors; location and notes; search; and reminders.

- **Data.** `calendarService` (`src/core/calendar/calendarService.js`)
  owns events and stores them in `/Documents/Calendar/events.json`
  through the VFS:

  ```json
  { "format": "browseros-calendar", "version": 1, "events": [ { "id": "…", "title": "Team sync",
    "allDay": false, "start": "2026-11-06T10:00", "end": "2026-11-06T11:00", "color": "violet",
    "location": "", "description": "", "reminder": 10, "recurrence": null, "exceptions": [] } ] }
  ```

  Times are local wall-clock times (`YYYY-MM-DDTHH:mm`, or
  `YYYY-MM-DD` for all-day events), so an event stays at 10:00 when
  the device's time zone changes. Every stored event is validated on
  load; invalid entries are skipped. A file that can't be read at all
  is renamed `events (unreadable <timestamp>).json` and kept, and a new
  calendar starts. Writes are queued; if a write fails, the change is
  rolled back and an error is shown.
- **Recurrence.** Daily, weekly, monthly, or yearly with an interval,
  ending never, on a date, or after a number of occurrences.
  Occurrences are computed on demand for the visible range; a monthly
  event on the 31st skips months without one. Editing or deleting one
  occurrence asks whether to change _this event_ (stored as an
  exception plus, for edits, a separate event) or _all events_.
- **Reminders.** None, at start, or 5, 10, 15, 30, 60 minutes or one
  day before. Reminders fire as notifications while BrowserOS is
  open, whether or not Calendar is, and are checked at least once a
  minute and whenever the page becomes visible again. Each occurrence's
  reminder fires once (`calendar:firedReminders`); reminders that came
  due while BrowserOS was closed are not shown later.
- **API.** `await calendarService.ready()`, `getEvents()`,
  `getEvent(id)`, `getOccurrences(from, to)`, `search(query)`,
  `create(data)`, `update(id, changes)`, `remove(id)`,
  `excludeOccurrence(id, dateKey)`, `detachOccurrence(id, dateKey, data)`.
  `appManager.launch("calendar", { date: "2026-12-24" })` or
  `{ eventId }` opens Calendar at a date or event.

### Clock

World clock, alarms, stopwatch, and timer. `clockService`
(`src/core/clock/clockService.js`) owns all state and scheduling, so
alarms and timers keep working with the Clock window closed.

- **World clock.** Local time plus any number of cities, searched by
  city, country, or any IANA time zone the browser supports. Times
  come from `Intl.DateTimeFormat`, so daylight saving is handled by
  the browser.
- **Alarms.** Time, label, repeat days, and sound. A one-time alarm
  turns itself off after ringing. A ringing alarm is a notification
  with _Snooze 5 min_ and _Dismiss_ that stays until handled; its
  sound repeats for up to one minute.
- **Stopwatch and timer** are timestamp-based (`startedAt`, `endAt`),
  not tick counters: they stay accurate in background tabs and across
  reloads, and keep running while the window is closed. A timer that
  ended while BrowserOS was closed is reported on the next start.
- Storage keys: `clock:alarms`, `clock:timer`, `clock:stopwatch`,
  `clock:worldClocks`, `clock:lastTab`.
- `appManager.launch("clock", { tab: "timer" })` opens a specific tab
  (`world`, `alarms`, `stopwatch`, `timer`).

### Image Viewer

Opens PNG, JPEG, WebP, GIF (animated), and SVG files from the VFS.
Fit to window (default), zoom from 5% to 1600% (buttons, keyboard,
Ctrl + wheel), drag to pan when zoomed, rotate in 90° steps, reset,
fullscreen, and previous / next through the other images in the same
folder. The status bar shows name, dimensions, size, type, and
position in the folder.

Viewing never modifies the file. Images are displayed through an
`<img>` element from a Blob URL that is revoked when the image changes
or the window closes. SVG files are displayed the same way, which
means scripts, event handlers, and external resources inside them are
never run or loaded. Unreadable or corrupt files show an error in the
window. Opening a file always opens a new Image Viewer window.

### Task Manager

- **Applications.** One row per running application with its icon,
  status (running, minimized, errors reported), number of windows,
  running time, and recorded errors. A row expands to its windows, each
  with Switch to, Minimize / Restore, and Close. Selected rows offer
  Switch to, Minimize / Restore, Restart, and End task; the keyboard
  works too (↑ / ↓ select, → / ← expand, Enter switches, Delete ends).
  Rows can be sorted and filtered.
- **Performance.** BrowserOS figures — running applications, open
  windows, running services, timers scheduled by services,
  notifications, errors since start, start time, page elements, and
  EventBus subscriptions — and figures measured in or reported by the
  browser: main-thread delay (measured by the application monitor),
  frame rate (measured while the tab is shown), JavaScript heap (where
  the browser exposes it), site storage, logical processors, and
  approximate device memory. BrowserOS cannot read the device's real
  CPU, memory, or disk usage, so none is shown; memory and storage
  figures are labelled as the browser's estimates.
- **Services.** Every background service with status, dependencies,
  live details, and Start / Stop / Restart. Essential services can be
  restarted but not stopped; stopping a service that others depend on
  asks first and stops them too.

Application and window changes appear immediately (event-driven, one
render per frame, only changed cells updated). Timed measurements
follow `taskManager.refreshInterval` and pause while Task Manager is
minimized or the tab is hidden. Launch options:
`{ tab: "applications" | "performance" | "services", select?: appId }`.

### Browser

A tabbed web browser: address/search bar with suggestions from history
and bookmarks, back / forward / reload / home, a security indicator,
bookmark star, bookmarks bar, downloads button, sidebar (bookmarks,
history, downloads), and a menu (new window, new private window,
history, bookmarks, downloads, save page to Downloads, open in your
browser, copy address, clear browsing data, settings).

- **Addresses.** `example.com` opens `https://example.com/`;
  `localhost:8080` and IP addresses use http; other text is searched
  with the configured engine (Google, Bing, or DuckDuckGo —
  `src/core/browser/searchEngines.js`); `browseros://start`, `history`,
  `bookmarks`, and `downloads` are built-in pages; `vfs:///path` opens a
  BrowserOS file; `javascript:`, `data:`, and `file:` are refused;
  invalid addresses show an error page that keeps what was typed.
- **Tabs.** Each window has its own tabs, each with its own history.
  Tabs show favicons (loaded from the site's icon link or
  `/favicon.ico`, else a globe), titles, and a loading spinner; the
  strip scrolls horizontally when full. Tab menu: new tab, reload,
  duplicate, bookmark, close, close others, reopen closed tab (the last
  ten keep their history). Middle-click closes. Only the six most
  recently used tabs keep a live page; older background tabs are
  unloaded (shown in italics) and reload when selected.
- **Start page.** Clock and date (optional), search box, your own
  shortcuts (add, rename, edit, reorder, remove — up to twelve),
  frequently and recently visited pages computed from history,
  bookmarks-bar items, and a background (accent, the desktop
  wallpaper, or plain). Empty sections say how they fill up; nothing is
  pre-filled.
- **Bookmarks** (`bookmarkService`, stored in the VFS at
  `/Documents/Browser/bookmarks.json`): "Bookmarks bar" and "Other
  bookmarks" plus your folders. Ctrl + D or the star adds the page and
  opens a small editor (name, folder, remove). The bookmark manager
  (`browseros://bookmarks`) adds, edits, deletes, reorders, moves
  between folders, creates folders, searches, imports a bookmarks HTML
  file (the standard format other browsers export) or BrowserOS JSON,
  and exports a bookmarks HTML file to `/Downloads`. Invalid addresses
  and duplicates (same address in the same folder) are refused; an
  unreadable file is kept aside and bookmarks start empty.
- **History** (`historyService`): one record per page with its title,
  favicon, visit count, and up to thirty visit times; a repeat visit
  within 30 seconds doesn't count again. `browseros://history` groups
  visits by day, searches, removes single visits, and clears the last
  hour, day, week, four weeks, or everything. History older than
  `browser.historyDays` and beyond 2,000 pages is removed.
- **Private windows** (`appManager.launch("browser", { private: true })`)
  are marked in the tab strip and window title, don't add to history,
  and their downloads aren't kept in the download list (the files are
  still saved). They are not anonymous: pages load through the host
  browser with its cookies and site data, shared with normal windows.

Launch options: `{ url?, private?, path? }` (`path` opens a BrowserOS
file; `.html` / `.htm` files open in the Browser from File Explorer).

### Downloads

The Download Manager (`src/core/downloads/downloadService.js`, the
`downloads` service) saves web files into `/Downloads` through the VFS
API. The Downloads window, the Browser's downloads button and sidebar,
`browseros://downloads`, and Terminal's `download <url>` all use it.

1. A download starts from a page link marked `download` or pointing at
   an archive or installer (on pages the Browser can read, i.e.
   BrowserOS's own address), from typing such an address, from "Save
   page to Downloads", from an address entered in the Downloads window,
   or from Terminal.
2. The file is fetched and streamed. Progress is shown only when the
   server sends a size (otherwise the bar shows activity and the
   received amount); speed and time left are measured from the bytes
   actually received.
3. The name comes from `Content-Disposition` (including `filename*=`)
   when the browser lets BrowserOS read it, else the URL; a missing
   extension is taken from the content type. Taken names get
   " (2)", " (3)", …
4. The content is written with `vfs.createFile`; the download completes
   and a notification opens the file.

Downloads can be cancelled, retried, removed from the list, opened,
shown in their folder, and filtered (in progress, completed, failed).
Failures are explained: network or cross-origin refusal (with
"Download with your browser", which saves outside BrowserOS), HTTP
errors, files over `downloads.maxSizeMb` (refused before saving when
the size is known), file types BrowserOS can't store, and storage
errors. Pause and resume aren't offered: a plain web request can't
resume a partial download. A download interrupted by closing
BrowserOS is listed as interrupted and can be retried. The list (up to
200 entries, without private downloads) is kept in StorageService
(`downloads:history`).

### Code Studio

**Code Studio** (`code-studio`) is the development environment: it edits
projects stored in the VFS and shows web pages in a sandboxed live
preview. It opens from the Start Menu, its desktop shortcut, any source
file (`.css`, `.js`, `.json`, … — see [Code Studio
associations](#code-studio-associations)), _Open with_ for HTML,
Markdown, text, and SVG files, Terminal's `code <path>`, and
`appManager.launch("code-studio", { path })`.

- **Projects** are folders. _File → New project_ creates one in
  `/Projects` (or another folder) from a template — Blank, HTML Website,
  HTML, CSS & JavaScript, or JavaScript Project — by writing real files
  through the VFS. _Open project_ opens any folder; recent projects are
  listed on the welcome page and under _File → Open recent_.
- **Explorer**: create, rename (F2), move (drag onto a folder, or
  _Move to…_), and delete (to Trash, after confirmation) files and
  folders; copy paths; reveal in File Explorer; open a Terminal there.
  Open files with unsaved changes are marked in the tree and the tabs.
- **Editor**: syntax highlighting for HTML (with embedded CSS and
  JavaScript), CSS, JavaScript, JSON, and Markdown; line numbers,
  current-line highlight, bracket matching, auto-indent, auto-closing
  brackets and quotes, Tab / Shift + Tab indentation, comment toggling,
  moving lines, find and replace (case, whole word, regular expressions
  with `$1` replacements), go to line, undo and redo, word wrap, and the
  font, size, tab width, and theme from Settings.
- **Search**: across the project (unsaved text included), with a
  files-to-include filter and replace in one file or all files; _Go to
  file_ (Ctrl + P) with `:line` support and recent files first.
- **Problems**: HTML structure, CSS, JavaScript, and JSON syntax checks
  for open files and the project's files, with file, line, and a click
  to jump there; errors thrown while the preview runs are listed
  separately as runtime errors.
- **Preview**: _Run_ (Ctrl + Enter) shows an HTML page with its linked
  stylesheets, scripts, modules, and assets from the VFS, updating while
  typing (or on save and Run). It can go fullscreen, move to its own
  window, and switch pages; `console` output and errors appear in the
  Output panel.
- **Terminal panel**: the BrowserOS terminal, starting in the project
  folder (Ctrl + `), with a button that opens the Terminal app there.
- **Windows**: the main window is single-instance and receives files
  opened elsewhere (a file goes to the window whose project contains
  it); _File → New window_ opens more windows (`code-studio-window`),
  and the pop-out preview is `code-studio-preview`. Both are dynamic
  entries grouped with Code Studio in the taskbar and Task Manager.

Closing a file, the project, or the window with unsaved changes asks
to save, discard, or cancel; Task Manager warns before ending Code
Studio with unsaved files, and leaving the BrowserOS tab asks too while
anything is unsaved. Launch options: `{ path?, newProject? }` — a
folder path opens it as the project, a file path opens the file.

### Settings

**Settings** opens from the Start Menu, the desktop's _Personalize_
context-menu submenu, Ctrl + `,`, or `appManager.launch("settings")`.
Pages: Appearance, Wallpaper, Desktop, Start Menu, File Explorer,
Notifications, Taskbar, Browser, Code Studio, Keyboard Shortcuts, and System (reset one
category or everything, with confirmation). Every change applies immediately, every option can
be reset individually, and the sidebar search jumps straight to a
section. New pages are added by registering a category in
`src/apps/settings/settingsCategories.js`.

## Files and file associations

### Opening files

`openVfsEntry(entry, { appManager, recentFilesService, appId? })` in
`src/core/vfs/vfsOpener.js` is the only code path that opens a file or
folder. Desktop (double-click / Enter / _Open with_), File Explorer
(double-click / Enter / _Open with_), Start Menu (recent files and
search results), and Terminal (`open <path>`, `explorer [path]`) all
call it. It:

1. opens folders in File Explorer (or in the application named by
   `appId`, such as Code Studio opening a folder as a project);
2. records the file in Recent Files;
3. launches the handler (`appId` if given, otherwise the default from
   `fileAssociations`) with `{ path }`, and emits
   `application:fileOpened`;
4. shows the file's properties when no application handles its type.

`buildOpenWithItems(entry, onChoose)` produces the _Open with_
submenu entries, so Desktop and File Explorer always offer the same
choices.

### Association registry

```js
fileAssociations.getDefault(entryOrExtension); // { appId, label, extensions } | null
fileAssociations.getHandlers(entryOrExtension); // every handler, default first
fileAssociations.getExtensionsFor("image-viewer"); // ["png", "jpg", …]
fileAssociations.getIcon(entry); // type glyph shared by Desktop and File Explorer
const unregister = fileAssociations.register({ appId: "my-app", label: "My App", extensions: ["csv"] });
```

The first registration for an extension is its default; later ones
become _Open with_ alternatives. Changes emit
`fileAssociations:changed`.

### Code Studio associations

At boot Code Studio registers as the default for source files no other
application handles — `css`, `js`, `mjs`, `cjs`, `jsx`, `ts`, `tsx`,
`json`, `webmanifest`, `map`, `xml`, `yml`, `yaml`, `toml`, `ini`,
`cfg`, `conf`, `env`, `csv`, `log`, `scss`, `sass`, `less`, `vue`,
`svelte`, `sh`, `bash`, `ps1`, `bat`, `py`, `rb`, `php`, `java`, `kt`,
`c`, `h`, `cpp`, `hpp`, `cs`, `go`, `rs`, `swift`, `sql`, `lua`, `pl`,
`r` — and as an _Open with_ alternative for `html`, `htm`, `svg`, `md`,
and `txt`, whose defaults stay the Browser, Image Viewer, and Notes.
Files without a dedicated highlighter open as plain text.

In Terminal, `open --with <app-id> <path>` opens a file (or, for
applications that accept folders, a folder) with a specific
application, and `code [path]` opens a file or folder in Code Studio.

### Text and binary content

Text files (`.txt`, `.md`, `.note`, `.svg`, `.json`, `.csv`, …) are
stored as strings and read with `vfs.read(path)` / written with
`vfs.write(path, text)`. Binary types are stored as Blobs in IndexedDB:
images (`png`, `jpg`, `jpeg`, `webp`, `gif`, `bmp`, `ico`, `avif`,
`tif`), documents (`pdf`, `docx`, `xlsx`, `pptx`, `odt`, `ods`, `odp`,
`epub`), archives and packages (`zip`, `7z`, `rar`, `gz`, `tgz`, `tar`,
`bz2`, `xz`, `jar`, `apk`, `deb`, `rpm`, `dmg`, `iso`), audio and video
(`mp3`, `wav`, `ogg`, `flac`, `m4a`, `aac`, `opus`, `mp4`, `m4v`,
`webm`, `mov`, `mkv`, `avi`), fonts, `wasm`, `bin`, and `dat`. Windows
programs (`exe`, `msi`) aren't stored: BrowserOS can't run them.
`getExtensionForMimeType()` (`src/core/vfs/entry.js`) maps a content
type back to an extension.

```js
const blob = await vfs.readBinary("/Pictures/photo.png"); // Blob with the right MIME type
await vfs.writeBinary("/Pictures/photo.png", blob); // binary extensions only
await vfs.createFile("/Pictures/new.png", blob); // create with binary content
```

Passing a Blob to a text file, or text to `writeBinary`, fails with
`VfsError` code `INVALID_CONTENT`; reading binary content that was
never stored (entries created by older releases) fails with
`NO_CONTENT`.

### Importing files

File Explorer's _Import…_ button, and dropping files from the host
operating system onto a File Explorer window or the desktop, copy
files into the VFS (`src/core/vfs/fileImport.js`). Supported: the
image types above and `txt`, `md`, `note`, `svg`, `json`, `csv`, up to
25 MB each. Existing names get a numbered suffix (`photo (2).png`);
unsupported or oversized files are skipped and listed in a dialog.

Sample files (documents, notes, two web projects, pictures, and a
download) are added only when the user asks; see
[Welcome tour and sample files](#welcome-tour-and-sample-files).

## Shared services

### Notifications

`notificationService` (`src/core/notifications/notificationService.js`)
is the one notification system for applications and the shell.

```js
const handle = notificationService.notify({
  title: "Timer finished", // required unless `message` is given
  message: "5:00 timer",
  type: "success", // info | success | warning | error
  source: "clock", // app id, or "system"; names and icons the notification
  icon: "icon:stopwatch", // optional; defaults to the source app's icon
  duration: 8000, // banner time in ms; default from settings; 0 = until dismissed
  persistent: false, // true keeps the banner until dismissed
  urgency: "normal", // "alarm": announced assertively, never auto-closes, shown during Do Not Disturb
  critical: false, // true: shown during Do Not Disturb
  groupKey: "clock-timer", // related notifications share a banner and a Notification Center entry
  action: { type: "launch", appId: "clock", options: { tab: "timer" } }, // or { type: "open", path }
  onClick: () => {}, // this session only; takes precedence over `action`
  actions: [{ id: "restart", label: "Restart" }, { id: "dismiss", label: "Dismiss", primary: true }],
  onAction: (actionId) => {},
  onDismiss: (reason) => {}, // banner closed: "user" | "timeout" | "action" | "programmatic"
  sound: "chime", // chime | bell | digital | soft | none
  loopSound: false,
  history: true, // false: banner only, not kept in the Notification Center
});
handle.dismiss(); // remove it everywhere

notificationService.success("Saved"); // also info(), warning(), error(); options as above
notificationService.dismiss(id); // remove one notification (banner and history)
notificationService.dismissAll(); // close every banner; history stays
notificationService.clearHistory(); // empty the Notification Center
notificationService.markAsRead(id); notificationService.markAllAsRead();
notificationService.getNotifications({ unreadOnly: false }); // newest first
notificationService.getUnreadCount();
notificationService.activate(id); // what a click does (below)
notificationService.setDoNotDisturb(true); notificationService.isDoNotDisturb();
```

**Lifecycle.** `notify()` validates its options (a notification
without a title or message is rejected with a console warning and an
inert handle; text is trimmed and length-limited), records the
notification in the history, and shows a banner unless Do Not Disturb
suppresses it. Banners close after their duration (hovering or
focusing pauses the countdown), stay until dismissed when persistent
or alarms, and are limited to four on screen — the oldest non-alarm
banner makes room. Closing a banner marks it read; a banner that
times out stays unread in the Notification Center. A new notification
with the same `groupKey` as a banner on screen replaces it and shows
how many it stands for.

**Clicking** a banner or a Notification Center entry marks it read and
runs its `onClick` (same session), else its serializable `action`
(still works after a reload), else opens its source application. If
the target no longer exists — a deleted file, an uninstalled app — a
short notice says so instead.

**Do Not Disturb** (`notifications.doNotDisturb`) hides banners and
mutes sounds but still records every notification; alarms and
`critical` warnings always appear. The tray bell shows a crossed-out
bell while it is on.

**History** is stored through StorageService
(`notifications:history`), validated on load, and limited to
`notifications.historyLimit` entries (20–200) and seven days. Runtime
callbacks are never stored. Banners use `role="status"`, alarms
`role="alert"`. Sounds are synthesized with the Web Audio API
(`src/utils/alertSound.js`); browsers only allow audio after the user
has interacted with the page, so before that, alerts are visual only.

**Who notifies.** Calendar reminders (open the event), Clock alarms,
timers, and missed alarms (open Clock), Notes save failures (once per
failure, open the note), File Explorer bulk operations of ten or more
items or taking over three seconds and failed multi-item operations
(open the folder), Terminal commands that ran five seconds or more and
finished while Terminal wasn't the active window, application crashes
and errors (open Task Manager), and storage problems (open Settings ›
System). Routine single-item actions don't notify.

### Dialogs

All modal UI is built on `openDialog()` (`src/components/dialog/dialog.js`),
which provides the backdrop, focus trap, Escape / Enter handling,
focus restoration, and theming. While a dialog is open the desktop
(`#app-root`) is `inert`, so it can't be reached by mouse, keyboard, or
assistive technology, and only the topmost dialog answers Escape, Tab,
and Enter. Ready-made helpers:

| Helper                    | Returns                                     |
| ------------------------- | ------------------------------------------- |
| `showConfirmDialog()`     | `true` / `false`                            |
| `showPromptDialog()`      | the entered string, or `null` (with optional `validate`) |
| `showMessageDialog()`     | resolves when acknowledged                  |
| `showPropertiesDialog()`  | resolves when closed                        |
| `showFolderPickerDialog()`| a folder path, or `null`                    |

Custom forms pass their own content element plus `onBeforeClose`
(return `false` to keep the dialog open, e.g. after a validation
error) and use the shared `.dialog__form`, `.dialog__field`,
`.dialog__input`, `.dialog__select`, and `.dialog__error` classes.

## System shell

**Taskbar.** Window buttons show the application's icon and title,
stay next to the other windows of the same application, and are
labelled "window 2 of 3" when an application has several. Clicking
focuses, minimizes, or restores; the context menu (right-click, or
Shift + F10 / the context-menu key) offers Restore / Minimize, Close
window, Close all windows of the application, and Task Manager.

**System tray** (`TrayManager`, mounted into the taskbar container that
Desktop provides) holds, left to right: Quick Settings, the
notification bell (with an unread count, and a crossed-out bell during
Do Not Disturb), and the clock. Each button opens a panel
(`ShellPanel`, `src/components/shell/shellPanel.js`):

- panels open above the taskbar and above every application window
  (the window layer is its own stacking context);
- only one panel is open at a time, and panels and the Start Menu
  close each other;
- Escape (focus returns to the button) or a click outside closes a
  panel; the button's `aria-expanded` follows it;
- notification banners move aside while a panel is open.

**Notification Center** — notifications grouped by application,
newest first; related notifications collapse behind "N more"; unread
dots, relative times, per-entry and per-application dismiss, Clear
all, a Do Not Disturb switch, and an empty state. Entries shown while
it was open are marked read when it closes.

**Quick Settings** — toggles for Do Not Disturb, notification sounds,
notification previews, transparency, and reduced motion; theme
(dark / light / system), accent color, blur, and animation speed; links
to Wallpaper, Desktop, Notifications, and all Settings. Every control
reads and writes SettingsService, so it stays in sync with Settings
windows and everything else. There are no volume, brightness, Wi-Fi,
or Bluetooth controls: a web page can't control them.

**Date panel** — the current time and date, a month calendar with
previous / next / Today and keyboard navigation (arrows, Page Up / Down),
dots on days with Calendar events, and Open Calendar; choosing a day
opens Calendar at that date. Event editing stays in Calendar.

The tray clock is updated by the `system-clock` service, which
schedules each update for the next minute (or second) boundary and
re-reads the time whenever the tab becomes visible, so it stays
correct when the browser throttles background timers. Format and
visibility come from the `taskbar.*` settings.

## Background services

```js
serviceManager.register({
  id: "my-sync", // unique
  name: "My sync",
  description: "Shown in Task Manager",
  dependencies: ["notifications"], // started first, stopped after
  essential: false, // true: can be restarted, not stopped
  start: async () => {}, // acquire timers and listeners; recover persisted state
  stop: () => {}, // release everything start() acquired
  getDetails: () => ({ summary: "next run 10:00", timers: 1 }), // optional, for Task Manager
});
await serviceManager.start("my-sync"); // dependencies first; concurrent calls share one start
await serviceManager.stop("my-sync"); // running dependents stop first
await serviceManager.restart("my-sync");
serviceManager.getServices(); // [{ id, name, status, dependencies, dependents, startedAt, error, startCount, summary, timers }]
```

Statuses are `stopped`, `starting`, `running`, `stopping`, and
`failed`. A service is never started twice without being stopped,
duplicate ids and dependency cycles are rejected at registration, a
failing `start()` marks only that service (and services needing it)
as failed with its error, and every running service is stopped on
`pagehide`. Events: `service:registered`, `service:started`,
`service:stopped`, `service:error`, `service:statusChanged`.

| Service              | What it does                                                            | Depends on    |
| -------------------- | ----------------------------------------------------------------------- | ------------- |
| `notifications`      | Banners, Notification Center, Do Not Disturb (essential)                | —             |
| `system-clock`       | Taskbar clock and date panel updates                                    | —             |
| `calendar-reminders` | Calendar reminder checks                                                | notifications |
| `clock-alarms`       | Alarms, snooze, timer completion, missed-alarm report                   | notifications |
| `app-monitor`        | Attributes errors to applications; measures main-thread delay           | notifications |
| `storage-monitor`    | Warns when settings or data can't be saved, or site storage is 90% full | notifications |
| `downloads`          | Downloads into /Downloads; keeps the download list                      | notifications |

**Application monitor.** Uncaught errors, unhandled rejections, and
exceptions thrown by EventBus listeners are attributed to an
application when their stack trace points into `src/apps/<id>/`; they
are recorded on the application (Task Manager's Errors column) and
produce at most one notification per application per minute.
Main-thread delay is measured with a short heartbeat timer, ignoring
time spent in a hidden tab.

Services run only while BrowserOS is open in a browser tab; nothing
runs after the tab closes. Services that matter across reloads keep
their state in storage (alarm times, timer end times, fired reminders)
and recover it when they start.

## Browser architecture and limits

BrowserOS runs inside a web browser, and the Browser renders web pages
in a sandboxed `<iframe>`. The web platform deliberately limits what
one page can do with another:

- **Embedding can be refused.** Sites that send `X-Frame-Options` or
  `Content-Security-Policy: frame-ancestors` can't be shown inside
  another page, and the embedding page can't detect the refusal or read
  those headers. The Browser therefore keeps a short list of popular
  sites known to refuse (`src/core/browser/framePolicy.js`) and shows
  an explanation with **Open in your browser**, **Always open this site
  in your browser**, and **Show here anyway** instead of a blank frame.
  For other sites it embeds the page and shows a notice in case it
  stays blank. BrowserOS never works around these protections (no
  proxies, no disabled security).
- **Other sites are opaque.** For pages from another origin, the title,
  current address, content, and links can't be read. The tab shows the
  host name, and when such a page navigates by itself the Browser knows
  that it happened but not where it went (the address bar says so).
  Pages from BrowserOS's own address are readable and are shown without
  running their scripts.
- **Sandbox.** Embedded pages can't navigate BrowserOS away (no
  top-level navigation), get no camera, microphone, or location access,
  and open pop-ups and their own downloads through the host browser
  (outside BrowserOS).
- **Downloads into BrowserOS use `fetch()`**, so they work for files
  from BrowserOS's own address and from servers that allow cross-origin
  requests (CORS). Other files fail with an explanation and can be
  downloaded by the host browser instead. `Content-Disposition` is only
  readable when the server exposes it to cross-origin requests.
- **Keyboard.** While focus is inside an embedded page, key presses go
  to that page. The host browser keeps some shortcuts for itself
  (Ctrl + T, Ctrl + W, Ctrl + Tab), so the Browser uses Alt-based ones.
- **Cookies and data** are the host browser's, shared by every
  BrowserOS window, private or not.

**Upgrade path.** The rendering backend is isolated behind a small
interface (`src/apps/browser/renderers/frameRenderer.js`: `load`,
`reload`, `stop`, `destroy`, and `onLoadStart` / `onLoadEnd` /
`onInPageNavigation` / `onDownloadRequest` / `onError` callbacks, plus
declared `capabilities`). Tabs and navigation (`tabSession.js`),
history, bookmarks, downloads, and preferences don't depend on it. A
desktop build with Electron (`<webview>` / `WebContentsView`) or Tauri
(a native web view per tab) could implement the same interface with a
real browser engine: every site would display, titles, favicons, and
in-page navigation would be reported by the engine, back / forward
could use the engine's own history, and downloads could be intercepted
from any page (Electron's `will-download`) and streamed into the VFS
without CORS limits.

## Code Studio architecture

Code Studio lives in `src/apps/code-studio/`:

| Module                                 | Responsibility                                                                 |
| -------------------------------------- | ------------------------------------------------------------------------------ |
| `main.js`                              | The window: layout, menus, documents and tabs, saving, file operations, filesystem events, diagnostics scheduling, preview wiring |
| `editor/codeEditor.js`                 | `CodeEditor`, the text editor component                                        |
| `languages/registry.js`                | Language registry (`registerLanguage`, `languageForPath`)                      |
| `languages/javascript.js`, `css.js`, `html.js` | Tokenizers for JavaScript and JSON, CSS, HTML (embedded CSS/JS) and Markdown |
| `diagnostics/`                         | `diagnose()`, HTML / CSS checkers, sandboxed JavaScript syntax checker         |
| `preview/previewBuilder.js`            | Turns a project page into a self-contained document                            |
| `preview/previewBridge.js`             | Script placed in previewed pages (console, errors, links, storage)             |
| `preview/previewSession.js`            | One window's preview: current page, builds, message filtering                  |
| `ui/`                                  | File tree, find bar, project search, Quick Open, bottom panel, preview pane    |
| `project/`                             | Templates, project tree and recent projects, path helpers                      |
| `previewWindow.js`                     | The separate Preview window                                                    |
| `editorFonts.js`                       | Font stacks for the `codeStudio.fontFamily` setting                            |

### Editor

`CodeEditor` layers a native `<textarea>` over a highlighted copy of
the text inside one scroll container. Both layers use the same font,
size, line height, tab size, padding, and wrapping rules; the textarea's
glyphs are transparent, so its caret and selection appear over the
colored text, and every platform text-input feature — input methods,
dead keys, clipboard, drag and drop, screen readers — is the browser's
own. The textarea is exactly as large as its content and never scrolls;
the container scrolls both layers, and the editor reveals the caret
itself.

- **Highlighting is incremental.** Each line stores the tokenizer state
  it starts in; an edit re-tokenizes from the first changed line until
  a line ends in the same state as before, and only those rows are
  re-rendered. Line numbers are CSS counters on a sticky gutter, so
  inserting lines renumbers nothing in the DOM.
- **Decorations** — current line, matching brackets, find matches,
  diagnostics — are classes on spans and rows that never change text
  metrics. Brackets inside strings and comments are not matched.
- **History** is the editor's own: typing and deleting runs are grouped,
  and programmatic edits (indentation, comment toggling, auto-closing
  pairs, replace all, reloading a file) are single undoable steps. The
  browser's textarea undo is never used.
- **Large documents** (more than 2,000 lines, `LARGE_DOCUMENT_LINES`)
  render only the rows near the viewport. Every row is exactly one line
  tall, so a row's position is its index times the line height; the
  line-number counter starts at the first rendered row, and an invisible
  copy of the widest line keeps the horizontal scroll range right. The
  textarea still holds the whole text, so selection, clipboard, search,
  and input methods are unchanged. Word wrap would make row heights
  unknowable without rendering every row, so it is paused for large
  documents (the status bar shows "Wrap: off (large file)") and resumes
  when the document is small again. Measured in Chromium with a 2 MB,
  37,000-line file: opening takes about 0.5 s and a keystroke about
  0.18 s (most of it the browser laying out the 2 MB textarea); a
  10,000-line file takes about 60 ms per keystroke.
- Files are edited with LF line endings; a file that used CRLF is shown
  as such in the status bar and saved with LF.

```js
const editor = new CodeEditor({ language, text, settings, onChange, onCursor });
editor.getValue(); editor.setValue(text, { keepHistory: true });
editor.replaceRange(from, to, text, { select: [start, end] });
editor.replaceDocument(text, [caret, caret]); // one undo step, only the changed span stored
editor.setSelection(start, end); editor.goTo(line, column);
editor.findAll("query", { caseSensitive, wholeWord, regex }); editor.setSearchMatches(ranges, current);
editor.setDiagnostics([{ line, column, severity, message }]);
editor.toggleComment(); editor.indentLines(outdent); editor.moveLines(-1);
editor.undo(); editor.redo(); editor.applySettings({ fontSize: 16, wordWrap: true });
```

Tab indents inside the editor; pressing Escape and then Tab moves focus
out of it instead.

### Project structure and VFS integration

A project is any VFS folder; templates create theirs under `/Projects`.
Code Studio reads the tree with `vfs.list()`, reads and writes text with
`vfs.read()` / `vfs.write()` / `vfs.createFile()`, reads assets for the
preview with `vfs.readBinary()`, and changes the tree with
`vfs.createFolder()`, `vfs.rename()`, `vfs.move()`, and `vfs.delete()`.
`node_modules` and `.git` folders are not listed or searched, and very
large projects list their first 20,000 items.

Changes made anywhere else arrive as `filesystem:*` events: created
items refresh the tree; a modified file reloads in clean editors, while
an editor with unsaved changes shows a banner offering the other
version or keeping its own; renames and moves re-point open files (and
the project, when its own folder moves); a deleted file keeps its text
with an offer to save it again.

### Preview sandbox

The preview frame is loaded from `srcdoc` with
`sandbox="allow-scripts allow-modals allow-forms"`. Without
`allow-same-origin` the page has an opaque origin: it cannot read or
change the BrowserOS document, its globals (`vfs`, `appManager`, …),
localStorage, IndexedDB, or cookies; without `allow-popups` and
`allow-top-navigation` it cannot open windows or navigate BrowserOS.
Project JavaScript runs only there, never in BrowserOS itself.

Because the frame has no file system, `previewBuilder` resolves the
page's references from the VFS (unsaved editor text first) and rewrites
them in place, without adding or removing lines, so line numbers in the
preview match the editor:

- `<link rel="stylesheet">`, `<script src>`, `src`, `srcset`, `poster`,
  icons, inline `style` attributes, `<style>` blocks, and CSS `url()` /
  `@import` become `data:` URLs;
- ES modules: every relative `import`, `export … from`, and literal
  `import()` becomes a key in an import map whose values are `data:`
  URLs, so module graphs — cycles included — load as written;
- links to other HTML files of the project open that page in the
  preview.

A one-line bridge script at the top of the page reports `console`
calls, uncaught errors, and unhandled rejections (with the project file
and line, traced through an `x-path` parameter on each script's `data:`
URL), page loads, scroll position (restored after rebuilds), and
project-link clicks through `postMessage`. Code Studio accepts a
message only when it comes from the frame element it created and
carries the current build's random token, keeps only plain text,
numbers, and project paths from it, and honors navigation only to HTML
files inside the project. The bridge also gives the page in-memory
`localStorage` / `sessionStorage`, which the opaque origin would
otherwise refuse; their contents last until the preview reloads. Every
build uses a new frame.

JavaScript syntax checks use the same isolation: the source is parsed
by the browser inside a throwaway sandboxed frame and never runs —
classic scripts start with a `throw` statement (a script is parsed
before its first statement runs), and modules start with an import of
a module that throws (imports are evaluated before the module body).

### Languages and limitations

| Language   | Highlighting | Checks                                                                 |
| ---------- | ------------ | ---------------------------------------------------------------------- |
| HTML       | yes, with embedded `<style>` and `<script>` | unclosed comments and tags, stray closing tags, elements never closed, duplicate attributes and ids, missing local files, inline script and style checks |
| CSS        | yes          | unclosed comments, strings, blocks, and parentheses; stray `}`; declarations without `:`; unknown properties and invalid values (warnings, answered by `CSS.supports()`) |
| JavaScript | yes (`.js`, `.mjs`, `.cjs`, `.jsx`) | syntax errors from the browser's parser, classic or module |
| JSON       | yes          | parse errors with line and column                                      |
| Markdown   | yes          | —                                                                      |
| Other text | plain        | —                                                                      |

- There is no Node.js, npm, build step, bundler, TypeScript compiler, or
  server. JavaScript runs only as part of a previewed page, and the
  terminal runs BrowserOS commands.
- Previewed pages can't `fetch()` or `XMLHttpRequest` project files
  (there is no server), can't use cookies or IndexedDB, and can't open
  pop-ups. Imports with computed specifiers (`import(variable)`) and
  bare package names aren't resolved. `<iframe>` elements in a page
  aren't rewritten.
- A previewed page shares the BrowserOS tab's main thread: an infinite
  loop in it can make BrowserOS unresponsive until the page stops.
- JavaScript checks report the first syntax error of a file; there is no
  type checking, linting, autocompletion, or minimap. Very long lines
  (over 10,000 characters) are shown without highlighting.

### Keyboard shortcuts

All Code Studio shortcuts are in the shortcut catalog (`codeStudio.*`)
and listed in Settings → Keyboard Shortcuts. Highlights: Ctrl + S save,
Ctrl + Shift + S save as, Ctrl + Alt + S save all, Alt + N new file,
Ctrl + P go to file, Ctrl + F / Ctrl + H find / replace, Ctrl + Shift + F
search the project, Ctrl + G go to line, Alt + W close the file,
Alt + PageDown / PageUp next / previous file, Ctrl + Enter or F5 run,
Alt + P preview, Ctrl + B sidebar, Ctrl + J panel, Ctrl + ` terminal,
Alt + Z word wrap, Ctrl + Z / Ctrl + Y (or Ctrl + Shift + Z) undo /
redo, Ctrl + / comment, Ctrl + ] / Ctrl + [ indent / outdent, Alt + Up
/ Down move lines. Browser-reserved combinations (Ctrl + W, Ctrl + Tab,
Ctrl + N) are not used.

### Extension points

- **Languages**: `registerLanguage({ id, name, extensions, initialState,
  tokenize, comment, indentAfter })` from `languages/registry.js` adds
  highlighting, comment toggling, and auto-indent for a file type.
  `tokenize(lineText, state)` returns `{ tokens: [[type, text], …],
  state }` without mutating `state`; token types map to `cs-tok-<type>`
  classes styled per editor theme in `codeStudio.css`.
- **Diagnostics**: `diagnose({ path, text, languageId, projectRoot,
  fileExists })` in `diagnostics/diagnostics.js` dispatches by language;
  a checker returns `{ line, column, severity, message }` items.
- **Templates**: add an entry to `PROJECT_TEMPLATES` in
  `project/templates.js` (`folders`, `files` as functions of the project
  name, and `open`).
- **File types**: `fileAssociations.register({ appId: "code-studio",
  label: "Code Studio", extensions: [...] })` makes Code Studio open
  more extensions.
- **Settings**: `codeStudio.*` keys in `settingsSchema.js`, edited on the
  Code Studio settings page and applied live through
  `settingsService.subscribeCategory("codeStudio", …)`.

## File system integrity and Trash

The VFS (`src/core/vfs/virtualFileSystem.js`) is the only file system
API. `storageAdapter.js` is the only module that opens IndexedDB.

**Durability.** Every adapter method resolves when its transaction has
committed (`complete`) and rejects when it aborts. IndexedDB can refuse
a write at commit time even after the request itself succeeded — a full
disk is reported that way — so `vfs.write()` never reports a save that
didn't happen. Storage errors become `VFSError` codes: `ALREADY_EXISTS`
(a duplicate path, including two simultaneous creates), `QUOTA_EXCEEDED`
(also announced as `storage:writeFailed` so the storage monitor warns),
`STORAGE_ERROR`, `STORAGE_UNAVAILABLE`, and `STORAGE_BLOCKED`.

**Atomicity.** Renaming, moving, deleting, copying, restoring, and
permanently deleting a folder change many entries (every descendant's
stored path). The VFS reads what it needs first and then stores every
change with `storageAdapter.putMany()` in one transaction, so an
interruption leaves the old tree or the new one, never a mixture.

**Start-up repair.** `vfs.init()` re-creates any missing default folder
(`/Desktop`, `/Documents`, `/Downloads`, `/Pictures`, `/Music`,
`/Videos`, `/Applications`, `/Trash`, `/System`).

**Names.** A name may not be empty, `.` or `..`, contain `/ \ : * ? " < > |`
or control characters (line breaks, tabs), or exceed 255 characters.

**Trash.**

| Call | Effect |
| ---- | ------ |
| `vfs.delete(path)` | Moves the item (and its contents) to `/Trash`, recording `originalPath`, `originalParentId`, and `deletedAt`. A taken name in Trash gets a number. |
| `vfs.move(path, "/Trash")` | Same as `delete()`. Moving an item out of Trash clears its Trash details. |
| `vfs.restore(path, { destination? })` | Puts a top-level Trash item back where it came from (missing folders are re-created; a taken name gets a number), or into `destination`. Items without a recorded location throw `NO_ORIGINAL_LOCATION`. |
| `vfs.deletePermanently(path)` | Removes an item in Trash and everything inside it. Anything outside Trash throws `NOT_IN_TRASH`. |
| `vfs.emptyTrash()` | Removes everything in Trash in one transaction. |

Recycle Bin (`src/apps/recycle-bin/`) lists Trash with each item's
original location and deletion date and offers Restore, Restore to…,
Delete permanently, and Empty Recycle Bin (keyboard: arrows, Shift +
arrows, Ctrl + A, Enter restores, Delete deletes permanently). File
Explorer's Trash folder offers the same actions, and Terminal has
`restore`, `purge`, and `emptytrash --yes`. Permanent deletion always
asks first in the graphical applications.

## Sessions and start-up

Every tab of the same site shares one IndexedDB database and one
localStorage, so two running copies of BrowserOS would silently
overwrite each other's settings, histories, and files. SessionGuard
(`src/core/system/sessionGuard.js`) therefore keeps BrowserOS active in
one tab per browser profile:

1. The first tab holds a Web Lock (`browseros-session`) for as long as
   it runs.
2. A tab opened later shows *BrowserOS is open in another tab* with
   **Use BrowserOS here**, and starts by itself as soon as the other tab
   closes.
3. **Use BrowserOS here** asks the active tab (over a BroadcastChannel)
   to hand over. If any application reports unsaved work
   (`getCloseWarning()`), the active tab asks its user first and may
   decline. Otherwise it saves pending settings and history, stops
   background services, releases the lock, and pauses behind a notice
   whose button moves the session back.

Browsers without the Web Locks API run without the guard.

BrowserOS also refuses to start inside a frame of its own origin (for
example, its own address opened in its Browser); embedding by another
site is not affected.

**Start-up screen.** `index.html` contains a start-up screen (logo,
progress bar, status line) that paints with the first frame, styled by
`styles/boot.css` from theme tokens only. `src/main.js` reports each
start-up stage as it finishes through `bootScreen.report()`: code
loaded, settings read, file system opened, desktop built, services
started. The bar moves only when a stage completes; nothing waits on a
timer. When the desktop is ready, `bootScreen.finish()` fades the screen
out over a desktop that already accepts input (a click or key press
ends the fade; with reduced motion there is none). `<body
data-boot-state>` is `starting`, `ready`, `waiting` (another tab holds
the session), or `failed`.

If the code itself can't be downloaded (a dropped connection, a server
error, an incomplete deployment), `src/main.js` never runs. A tiny
classic script loaded just before it, `src/core/system/bootFallback.js`,
listens for the module script's `error` event and turns the start-up
screen into a message with a **Reload** button.

No application opens by itself at start-up, except the Welcome tour on
a new installation. The first launch of each application fetches its
code; AppManager announces it (`app:loading` / `app:loaded`) and the
shell shows a progress pointer meanwhile.

If start-up fails — most often because browser storage can't be opened
(blocked site data, some private modes, a full or damaged profile) — a
full-window notice (`src/components/system-screen/`) explains the cause,
shows the technical message, and offers **Try again**. If the browser
closes the database while BrowserOS runs (site data cleared, or a newer
version upgrading it in another tab), the same notice offers a reload.

## Backup and restore

Settings › System › **Backup and restore** saves data to a file on the
host computer and restores it. Implementation: `src/core/backup/`
(`backupFormat.js` builds and validates the file, `backupService.js`
reads and writes through the public VFS API and StorageService).

| Backup | Contains | Restoring it |
| ------ | -------- | ------------ |
| Everything | Every file and folder (Trash included), plus every BrowserOS localStorage entry: settings, browsing history, download list, recent files, notification history, Terminal and Calculator history, layouts | Replaces all current BrowserOS data after an explicit confirmation (which also offers to back up the current data first); BrowserOS then restarts |
| A folder | One folder and everything in it | Adds the folder to a folder you choose; nothing existing is replaced (a taken name gets a number) |

**Format.** One UTF-8 JSON document: `format: "browseros-backup"`,
`formatVersion: 1`, `createdAt`, `browserOS` (the writing version),
`scope` (`"full"` or `"folder"`), `root`, `counts`, `checksum`
(SHA-256 of `JSON.stringify({ entries, storage })`), `entries` (parents
before children; text content as text, binary content as base64), and
`storage` for full backups. The full description is at the top of
`src/core/backup/backupFormat.js`. A reader accepts every format version
up to its own and refuses newer ones.

**Safety.**

- A backup is checked completely before anything changes: format,
  version, checksum, every entry's fields, every file's size against its
  content, and the tree structure (one root, unique ids and paths, every
  parent present, every path equal to its parent's path plus its name).
  Damaged, truncated, edited, newer, or foreign files are refused with a
  specific message.
- A full restore ends every application and background service, writes
  the whole file system in one transaction (if it fails, the current
  files remain), replaces the localStorage entries (the previous ones are
  put back if the browser refuses), blocks further localStorage writes
  from the page, and reloads.
- Backups larger than 512 MB are not read. Binary files grow by about a
  third in a backup (base64).

## Welcome tour and sample files

**Welcome** (`src/apps/welcome/`) is an ordinary single-instance
application with seven steps: a welcome with the sample-files offer,
appearance (theme, accent, wallpaper, applied live through
SettingsService), windows and the desktop (with the real shortcut keys
from the keyboard catalog), the Start menu, files and folders, the
installed applications (read from AppManager), and a summary.

Whether it opens at start-up is decided by `src/core/onboarding.js`,
which stores one record (`welcome:status`):

| Status      | Meaning                                                    | Opens at start-up |
| ----------- | ---------------------------------------------------------- | ----------------- |
| (none)      | New installation (`vfs.isNewInstallation()`: this start created the file system) | yes, and becomes `pending` |
| (none)      | BrowserOS already had files: recorded as `existing`        | no                |
| `pending`   | Shown, but neither finished nor skipped (the page was reloaded) | yes          |
| `completed` | Finished                                                   | no                |
| `skipped`   | *Skip tour*, or the window was closed during the first run | no                |

The tour can be opened at any time from the Start Menu or Settings ›
System; reopening it never changes this status unless it is finished.

**Sample files** (`src/core/demo/`): `sampleDocuments.js`,
`sampleProjects.js`, and `samplePictures.js` hold the content (21
files: a welcome text and a guide, three notes, a two-page portfolio
site, an animated JavaScript demo with an ES module import, four
pictures drawn locally, and a text file in `/Downloads`).
`sampleContent.js` writes them through the public VFS API and keeps a
manifest (`sampleContent:manifest`: each file's path, size, and
modification time, and the folders it created).

- They are added only by request: by continuing or skipping the tour
  with *Add sample files* checked (checked by default only on the first
  run of a new installation, which has no user files), or from Settings
  › System › *Add sample files*.
- A sample whose path already exists is skipped; nothing is replaced.
- They are never re-created at start-up.
- *Remove sample files* moves to Trash only files whose size and
  modification time still match the manifest; a sample folder whose
  contents are all unchanged moves as one item. Edited, renamed, or
  moved samples and anything the user added stay, and folders created
  for the samples are deleted only if they end up empty.

## Visual identity and design system

**Mark.** The BrowserOS mark is a window frame whose lower-right corner
gives way to a solid orb (a page and the world it opens onto). It
exists as:

- `icon:browseros` in `src/utils/icons.js` — used on the Start button,
  in the Start Menu, About, Welcome, and as the About application's
  icon. Inside an element with the `brand-mark` class
  (`styles/controls.css`) the orb takes the accent color; elsewhere the
  mark is monochrome like every other icon;
- `assets/brand/browseros-icon.svg` — the application tile (favicon),
  with PNG renderings at 32, 180 (touch icon), and 512 pixels;
- `assets/brand/browseros-mark.svg` and `browseros-mark-inverse.svg` —
  the mark alone for light and dark backgrounds;
- the start-up screen and the 404 page, as inline SVG with the same
  geometry.

**Tokens.** Every color, radius, spacing step, type size, duration, and
shadow comes from `styles/variables.css`; dark and light themes are
designed separately; the accent is one of six curated presets with
per-theme variants (`src/core/settings/accentPresets.js`).

**Typography.** Inter for interface text, Space Grotesk for headings
and the wordmark, JetBrains Mono for code and the Terminal. The fonts
are served with BrowserOS (`assets/fonts/`, declared in
`styles/fonts.css`, SIL Open Font License 1.1), so BrowserOS makes no
requests to other sites; Latin and Latin Extended are separate files
loaded only when used.

**Icons.** One line-icon set on a 24 × 24 grid with a 1.9 stroke and
round joins, drawn with `currentColor` so icons follow theme and
accent. Applications, file types (`fileAssociations.getIcon()`),
File Explorer, Settings categories, window controls, and the Start
Menu all use it; no emoji or text glyphs are used as icons.

**Controls.** `styles/controls.css` defines the shared button
(`.os-button`, with `--primary`, `--quiet`, and `--danger`), key caps
(`.os-kbd`), and the brand-mark coloring. One rule applies everywhere:
the primary action is a solid accent fill, secondary actions are quiet
glass, destructive actions use the danger color, and controls never
use gradients. Applications that define their own button classes
follow the same rule.

**Layout.** Application content fills its window edge to edge
(`.window__body` padding is removed per application with
`.window__body:has(> .app-root)`), with toolbars, sidebars, and status
bars drawing their own dividers.

## Deployment and builds

BrowserOS is a static site: `index.html`, `404.html`, `assets/`,
`src/`, and `styles/`. There is no compilation step and no server
code, so the repository itself runs as-is from any static web server.

`tools/build.py` makes the copy that is published (`dist/`):

1. copies only the site files (and the host configuration `_headers`
   and `.nojekyll`);
2. writes `src/core/buildInfo.js` with the Git commit, its date, the
   build time, and whether site files had uncommitted changes — About
   BrowserOS shows it (in the repository the file exports `null`);
3. rewrites the absolute links in `404.html` for the path the site is
   served from (`--base-path /BrowserOS/` for a GitHub Pages project
   site), because hosts serve that page at any missing URL;
4. checks that every static and dynamic module import,
   `ensureStylesheet()` path, CSS `url()`, and `index.html` reference
   resolves to a file in the copy, and fails if one doesn't.

All references inside the site are relative, so the same files work at
a domain root or under a sub-path. There are no client-side routes, so
no single-page-application fallback is needed: BrowserOS is always
`index.html`, and every other missing path gets `404.html`.

`_headers` (Netlify, Cloudflare Pages) sets `X-Content-Type-Options`,
`X-Frame-Options: SAMEORIGIN`, a referrer policy, a permissions policy,
and long caching for the font files; why there is no
Content-Security-Policy is explained in [SECURITY.md](SECURITY.md).
`tools/serve.py` serves the repository or `dist/` locally with the same
headers, correct content types, and the 404 page.
`.github/workflows/deploy-pages.yml` builds and publishes to GitHub
Pages when started by hand. See [INSTALLATION.md](INSTALLATION.md).

## Persistence

| Data                             | Where                                                    |
| -------------------------------- | -------------------------------------------------------- |
| Files, folders, notes, images    | VFS (IndexedDB), including `/Documents/Notes/*.note`     |
| Calendar events                  | VFS: `/Documents/Calendar/events.json`                   |
| Note drafts                      | StorageService: `notes:draft:<entryId>`                  |
| Calculator history / preferences | StorageService: `calculator:history`, `calculator:preferences` |
| Fired calendar reminders         | StorageService: `calendar:firedReminders` (pruned after 3 days) |
| Alarms, timer, stopwatch, cities | StorageService: `clock:*`                                |
| Notification history             | StorageService: `notifications:history` (limit and seven-day expiry) |
| Bookmarks                        | VFS: `/Documents/Browser/bookmarks.json`                 |
| Browsing history                 | StorageService: `browser:history` (retention setting, 2,000 pages) |
| Start page shortcuts             | StorageService: `browser:shortcuts`                      |
| Per-site embedding choices       | StorageService: `browser:sitePolicies`                   |
| Download list                    | StorageService: `downloads:history` (200 entries, no private downloads) |
| Downloaded files                 | VFS: `/Downloads`                                        |
| Code Studio projects             | VFS: `/Projects/<name>` (or any folder opened as a project) |
| Code Studio recent projects      | StorageService: `codeStudio:recentProjects` (10 folders) |
| Code Studio panel sizes          | StorageService: `codeStudio:layout`                      |
| Settings                         | StorageService: `settings`                               |
| Welcome tour status              | StorageService: `welcome:status`                         |
| Sample files added               | StorageService: `sampleContent:manifest` (and `sampleContent:removedAt` after removal) |
| Deleted items                    | VFS: `/Trash`, with `originalPath` and `deletedAt` on each top-level item |
| Backups                          | Files on the host computer (Settings › System); nothing is kept inside BrowserOS |

StorageService (`src/core/storage.js`) stores JSON in localStorage and
prefixes every key with `browseros:` (so `calculator:history` is
stored as `browseros:calculator:history`). Each service validates
what it loads and falls back to defaults for anything malformed, so
damaged storage never prevents BrowserOS from starting.

Only one tab runs BrowserOS at a time (see [Sessions and
start-up](#sessions-and-start-up)), so the in-memory state of one tab can
never overwrite what another saved.

## Events reference

| Event                                                       | Payload                               |
| ----------------------------------------------------------- | ------------------------------------- |
| `application:fileOpened`                                    | `{ appId, path, entryId }`            |
| `fileAssociations:changed`                                  | `{ appId }`                           |
| `explorer:filesImported`                                    | `{ path, count, skipped }`            |
| `notes:created` / `notes:updated` / `notes:deleted`         | `{ id, path, title }`                 |
| `calculator:historyChanged`                                 | `{ source }`                          |
| `calendar:ready`                                            | `{}`                                  |
| `calendar:eventCreated` / `calendar:eventDeleted`           | `{ event }`                           |
| `calendar:eventUpdated`                                     | `{ event, previous }`                 |
| `calendar:changed`                                          | `{ reason }`                          |
| `calendar:reminder`                                         | `{ event, occurrenceId, start }`      |
| `clock:alarmTriggered`                                      | `{ alarm }`                           |
| `clock:timerCompleted`                                      | `{ durationMs }`                      |
| `clock:alarmsChanged` / `timerChanged` / `stopwatchChanged` / `worldClocksChanged` | `{}`   |
| `notification:created`                                      | `{ id, notification, toast }`         |
| `notification:shown`                                        | `{ id, title, source }` (banner shown) |
| `notification:dismissed`                                    | `{ id, source, reason }` (banner closed) |
| `notification:action`                                       | `{ id, actionId, source }`            |
| `notification:activated`                                    | `{ id, source }`                      |
| `notification:read`                                         | `{ ids }`                             |
| `notification:removed` / `notification:cleared`             | `{ id }` / `{}`                       |
| `notification:historyChanged`                               | `{ total, unread }`                   |
| `system:dndChanged`                                         | `{ enabled }`                         |
| `system:trayUpdated`                                        | `{ unread, dnd }`                     |
| `system:clockTick`                                          | `{ now }`                             |
| `shell:panelOpened` / `shell:panelClosed`                   | `{ panel }`                           |
| `app:loading` / `app:loaded`                                | `{ appId }` (an application's code is fetched on its first launch) |
| `application:started` / `application:stopped`               | `{ appId }`                           |
| `application:focused`                                       | `{ appId, windowId }`                 |
| `application:crashed` / `application:error`                 | `{ appId, phase, message }`           |
| `application:restarted`                                     | `{ appId }`                           |
| `service:started` / `service:stopped` / `service:registered` | `{ id }`                             |
| `service:error`                                             | `{ id, message, phase }`              |
| `service:statusChanged`                                     | `{ id, status }`                      |
| `window:titleChanged`                                       | `{ id, title }`                       |
| `browser:historyChanged`                                    | `{ reason }`                          |
| `browser:shortcutsChanged` / `browser:sitePoliciesChanged`  | `{}`                                  |
| `bookmarks:ready`                                           | `{}`                                  |
| `bookmarks:changed`                                         | `{ reason }`                          |
| `downloads:changed`                                         | `{ id, reason }`                      |
| `downloads:started`                                         | `{ id }`                              |
| `downloads:completed`                                       | `{ id, path }`                        |
| `downloads:failed`                                          | `{ id, kind }`                        |
| `storage:writeFailed`                                       | `{ key, message }` (`key` is `"vfs"` for file-system writes) |
| `vfs:connectionClosed`                                      | `{ reason }` (`"versionchange"` or `"closed"`) |

Request events: `shell:togglePanel` `{ panel }`, `shell:closePanels`,
`startmenu:close` `{ restoreFocus }`.

VFS changes are announced after they are committed, as
`filesystem:fileCreated`, `filesystem:fileModified`,
`filesystem:fileRenamed`, `filesystem:fileMoved` (`{ entry, oldPath,
restored? }` — `restored: true` when it came back from Trash),
`filesystem:fileCopied`, `filesystem:fileDeleted` (`{ entry, oldPath,
permanent? }` — one event per entry, descendants included; for permanent
deletion `permanent: true` and `entry.parentId` is `null`),
`filesystem:folderCreated`, and `filesystem:replaced` (a full backup was
restored). Applications that show files subscribe to these instead of
polling.

## Known limitations

- Reminders, alarms, timers, notifications, and every background
  service only run while BrowserOS is open in a browser tab. Nothing
  is delivered while it is closed, and the operating system's
  notification center is not used.
  At the next start, one-time alarms and timers that came due are
  reported as missed; missed repeating alarms and calendar reminders
  are not.
- Background tabs may delay an alarm or reminder by up to about a
  minute, because browsers throttle timers in hidden pages.
- Alert sounds play only after the user has interacted with the page
  (browser autoplay policy).
- Calendar events use local wall-clock time with no per-event time
  zone. Recurrence supports a fixed interval of days, weeks, months, or
  years; rules such as "every second Tuesday" are not available.
  There is no import or export (iCalendar).
- The Notes rich editor uses the browser's built-in editing commands
  (`document.execCommand`). Notes can't contain images or tables, and
  Markdown is edited as plain text.
- Calculator arithmetic uses double-precision floating point (about
  15 significant digits).
- Image Viewer displays images only; rotation is not saved, and BMP,
  AVIF, HEIC, and other formats are not supported.
- Wallpapers are a curated set of generated backgrounds; uploading
  images is not supported.
- There is no text-size preference: interface text uses fixed pixel
  sizes, so only browser zoom (which scales everything) makes it
  larger.
- Restart and Shut down act on BrowserOS in this tab only; Shut down
  saves everything and stops BrowserOS until it is started again, but
  doesn't close the browser tab.
- Deleting moves items to Trash; permanent deletion (Recycle Bin, File
  Explorer's Trash folder, Terminal's `purge` and `emptytrash`) always
  asks for confirmation in the graphical applications, so there is no
  preference for it.
- File operations on the Desktop and in File Explorer can't be undone;
  undo and redo are available for text in Notes.
- Settings and application data are stored per browser profile. They
  can be backed up to a file and restored (Settings › System), but there
  is no automatic sync between browsers or devices.
- BrowserOS runs in one tab per browser profile at a time; other tabs
  wait (see [Sessions and start-up](#sessions-and-start-up)).
- Code Studio pauses word wrap for files over 2,000 lines, and files of
  several megabytes stay slower to edit (about 0.2 s per keystroke for a
  2 MB file in Chromium).
- Creating a file checks its folder for a duplicate name, so creating
  thousands of files in one folder slows down gradually (about 5.6 s for
  1,000 files).
- All applications share the page's single main thread, so Task
  Manager can detect that BrowserOS was unresponsive but not which
  application caused it; it can't measure CPU, memory, or disk use of
  individual applications or of the device.
- Application errors are attributed only when their stack trace points
  into the application's own folder; other errors are counted as
  system errors.
- Notification history keeps text and serializable actions only;
  action buttons such as Snooze work while their banner is on screen.
- There is no window overview (Win + Tab), and Win-key combinations
  other than Win alone aren't used, because the operating system
  handles them before the browser sees them.
- Code Studio has no Node.js, package manager, build tools, or server;
  see [Languages and limitations](#languages-and-limitations).
- The Browser shows web pages inside the host browser, so it inherits
  the limits described in [Browser architecture and
  limits](#browser-architecture-and-limits): many sites refuse to be
  embedded, embedded pages from other sites can't be read, their own
  navigation can't be followed, and only CORS-enabled (or same-origin)
  files can be downloaded into BrowserOS.
