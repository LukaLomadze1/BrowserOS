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
deliberately not used, since a web page cannot intercept them.

| Shortcut                     | Action                                     | Context          |
| ---------------------------- | ------------------------------------------ | ---------------- |
| Win / ⌘                      | Toggle the Start Menu                      | Anywhere         |
| Ctrl + Alt + T / E           | Open Terminal / File Explorer              | Anywhere         |
| Ctrl + ,                     | Open Settings                              | Anywhere         |
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

Every application is registered once in `src/main.js` and reaches the
Start Menu (all apps, search, pinning) and the Settings pin list from
that registration. Notes, Calendar, Calculator, Clock, File Explorer,
Terminal, About, and Recycle Bin also have desktop shortcuts; Image
Viewer is opened through files.

### Building an application

```js
appManager.register({
  id: "my-app",
  name: "My App",
  icon: "★",
  description: "One line shown in Start Menu search", // optional
  category: "Utilities", // optional
  singleInstance: true, // focus the open window instead of opening another
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
| `close()`                | The window is closing. Release everything here: EventBus and settings subscriptions, timers, animation frames, observers, object URLs, document-level listeners. |

`this.appManager` lets an application open other applications;
applications never call WindowManager directly. Window titles are
updated with `this.appManager.updateWindowTitle(this.windowId, title)`.

Long-lived state that must outlive a window belongs in a service in
`src/core/` (as Calendar and Clock do), not in the application, so
closing a window never stops a reminder, alarm, or timer.

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

### Settings

**Settings** opens from the Start Menu, the desktop's _Personalize_
context-menu submenu, Ctrl + `,`, or `appManager.launch("settings")`.
Pages: Appearance, Wallpaper, Desktop, Start Menu, File Explorer,
Keyboard Shortcuts, and System (reset one category or everything,
with confirmation). Every change applies immediately, every option can
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

```js
const handle = notificationService.notify({
  title: "Timer finished",
  body: "5:00",
  icon: "⏱",
  source: "clock",
  urgency: "normal", // "alarm": announced assertively and never auto-dismissed
  timeout: 8000, // 0 keeps it until dismissed
  sound: "chime", // chime | bell | digital | soft | none
  loopSound: false, // repeat until dismissed
  actions: [{ id: "restart", label: "Restart" }, { id: "dismiss", label: "Dismiss", primary: true }],
  onAction: (actionId) => {},
  onDismiss: (reason) => {}, // "user" | "timeout" | "action" | "programmatic"
});
handle.dismiss();
```

Notifications stack above the taskbar (at most four regular ones;
alarms are never pushed out), pause their timeout while hovered or
focused, and use `role="status"` or, for alarms, `role="alert"`.
Sounds are synthesized with the Web Audio API
(`src/utils/alertSound.js`); browsers only allow audio after the user
has interacted with the page, so before that, alerts are visual only.

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

## Persistence

| Data                             | Where                                                    |
| -------------------------------- | -------------------------------------------------------- |
| Files, folders, notes, images    | VFS (IndexedDB), including `/Documents/Notes/*.note`     |
| Calendar events                  | VFS: `/Documents/Calendar/events.json`                   |
| Note drafts                      | StorageService: `notes:draft:<entryId>`                  |
| Calculator history / preferences | StorageService: `calculator:history`, `calculator:preferences` |
| Fired calendar reminders         | StorageService: `calendar:firedReminders` (pruned after 3 days) |
| Alarms, timer, stopwatch, cities | StorageService: `clock:*`                                |
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
| `notification:shown`                                        | `{ id, title, source }`               |
| `notification:action`                                       | `{ id, actionId, source }`            |
| `notification:dismissed`                                    | `{ id, source, reason }`              |

VFS changes are announced as `filesystem:fileCreated`,
`filesystem:fileModified`, `filesystem:fileRenamed`,
`filesystem:fileMoved`, `filesystem:fileCopied`,
`filesystem:fileDeleted`, and `filesystem:folderCreated`; applications
that show files subscribe to these instead of polling.

## Known limitations

- Reminders, alarms, timers, and notifications only work while
  BrowserOS is open in a browser tab. Nothing is delivered while it is
  closed, and the operating system's notification center is not used.
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
