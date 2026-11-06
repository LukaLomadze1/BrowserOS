# BrowserOS

A desktop environment that runs entirely in the browser — windows,
apps, and processes built from plain HTML, CSS, and JavaScript, with
no frameworks.

## Running locally

Serve the project root with any static file server (ES modules
require `http(s)://`, not `file://`), e.g.:

```
npx serve .
```

then open the served URL.

## Architecture

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
  never open IndexedDB themselves.
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
- **Icons** (`src/utils/icons.js`) — an icon is either a text glyph or
  a built-in line icon (`"icon:clock"`); every shell surface renders
  icons through `renderIcon()` / `createIconElement()`.
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
| Recycle Bin   | `recycle-bin`   | System       | single    | —                                  |
| Task Manager  | `task-manager`  | System       | single    | —                                  |

Every application is registered once in `src/main.js` and reaches the
Start Menu (all apps, search, pinning) and the Settings pin list from
that registration. Notes, Calendar, Calculator, Clock, File Explorer,
Terminal, About, and Recycle Bin also have desktop shortcuts; Image
Viewer is opened through files; Task Manager opens from the Start
Menu, Ctrl + Alt + Esc, or a taskbar button's context menu.

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
- closing one window of a multi-window app never touches the others.

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

### Settings

**Settings** opens from the Start Menu, the desktop's _Personalize_
context-menu submenu, Ctrl + `,`, or `appManager.launch("settings")`.
Pages: Appearance, Wallpaper, Desktop, Start Menu, File Explorer,
Notifications, Taskbar, Keyboard Shortcuts, and System (reset one
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

1. opens folders in File Explorer;
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

### Text and binary content

Text files (`.txt`, `.md`, `.note`, `.svg`, `.json`, `.csv`, …) are
stored as strings and read with `vfs.read(path)` / written with
`vfs.write(path, text)`. Raster images (`png`, `jpg`, `jpeg`, `webp`,
`gif`) are stored as Blobs in IndexedDB:

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

On first start, `/Pictures/Sample Pictures` is created with three
generated PNG images and one SVG.

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
focus restoration, and theming. Ready-made helpers:

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
| Settings                         | StorageService: `settings`                               |

StorageService (`src/core/storage.js`) stores JSON in localStorage and
prefixes every key with `browseros:` (so `calculator:history` is
stored as `browseros:calculator:history`). Each service validates
what it loads and falls back to defaults for anything malformed, so
damaged storage never prevents BrowserOS from starting.

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
| `application:started` / `application:stopped`               | `{ appId }`                           |
| `application:focused`                                       | `{ appId, windowId }`                 |
| `application:crashed` / `application:error`                 | `{ appId, phase, message }`           |
| `application:restarted`                                     | `{ appId }`                           |
| `service:started` / `service:stopped` / `service:registered` | `{ id }`                             |
| `service:error`                                             | `{ id, message, phase }`              |
| `service:statusChanged`                                     | `{ id, status }`                      |
| `window:titleChanged`                                       | `{ id, title }`                       |
| `storage:writeFailed`                                       | `{ key, message }`                    |

Request events: `shell:togglePanel` `{ panel }`, `shell:closePanels`,
`startmenu:close` `{ restoreFocus }`.

VFS changes are announced as `filesystem:fileCreated`,
`filesystem:fileModified`, `filesystem:fileRenamed`,
`filesystem:fileMoved`, `filesystem:fileCopied`,
`filesystem:fileDeleted`, and `filesystem:folderCreated`; applications
that show files subscribe to these instead of polling.

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
- The VFS has no permanent deletion: deleting always moves items to
  `/Trash`, so there is no "confirm permanent delete" preference.
- File operations on the Desktop and in File Explorer can't be undone;
  undo and redo are available for text in Notes.
- Settings and application data are stored per browser profile; there
  is no import/export or sync.
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
