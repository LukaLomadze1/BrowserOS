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
  Menu search, and Terminal all share.
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
payloads are frozen.

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

The full, always-current list is in **Settings › Keyboard Shortcuts**.

## Apps

About, Calculator, Notes, File Explorer, Terminal, Settings,
Recycle Bin.

**Settings** opens from the Start Menu, the desktop's _Personalize_
context-menu submenu, Ctrl + `,`, or `appManager.launch("settings")`.
Pages: Appearance, Wallpaper, Desktop, Start Menu, File Explorer,
Keyboard Shortcuts, and System (reset one category or everything,
with confirmation). Every change applies immediately, every option can
be reset individually, and the sidebar search jumps straight to a
section. New pages are added by registering a category in
`src/apps/settings/settingsCategories.js`.

## Known limitations

- Wallpapers are a curated set of generated backgrounds; uploading
  images is not supported.
- The VFS has no permanent deletion: deleting always moves items to
  `/Trash`, so there is no "confirm permanent delete" preference.
- Undo (Ctrl + Z) is not implemented, so it is not offered as a
  shortcut.
- Settings are stored per browser profile (localStorage); there is no
  import/export or sync.
