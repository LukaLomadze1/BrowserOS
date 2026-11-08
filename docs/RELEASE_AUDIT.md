# BrowserOS Engineering Audit

This document records the full engineering audit of BrowserOS carried
out for release 16.0 (November 2026): what was inspected, how, what was
found, and what was done about each finding.
Findings are classified by severity and by how they were established:

- **Confirmed (reproduced)** — observed in a running BrowserOS
  instance (headless Chromium driven by Playwright).
- **Confirmed (code)** — follows directly from the code and the
  documented behavior of the browser API involved, but was not
  reproduced because it requires a condition that is hard to create
  on demand (a full disk, a browser crash in the middle of a write).
- **Suspected** — a plausible risk that was not demonstrated.

Severity levels:

| Level    | Meaning |
| -------- | ------- |
| Critical | Security vulnerability, data loss, or an application-breaking defect |
| High     | Major functionality broken, missing behind a visible control, or unreliable |
| Medium   | Inconsistent behavior or a significant usability or accessibility problem |
| Low      | Minor polish, maintainability, or defense-in-depth improvement |

The **Status** column of each finding shows the state after the
remediation work described in [Remediation](#10-recommended-remediation-priorities).

---

## 1. Executive summary

BrowserOS is a large (about 60,000 lines), framework-free browser
desktop with a coherent core: one event bus, one application
registry, one window manager, one settings service, one virtual file
system (VFS) whose IndexedDB access is confined to a single adapter,
and no static import cycles. Automated end-to-end suites covering
the desktop, File Explorer, Terminal, Settings, the productivity
applications, the system shell, Browser, and Code Studio pass, and an
open/close cycle of every application leaks no window or document
listeners, intervals, event-bus subscriptions, or DOM nodes.

The audit found no remotely exploitable vulnerability. The weaknesses
that mattered for a release were in data integrity and in one
application that was only a placeholder:

1. A VFS write was reported as successful when the IndexedDB request
   finished, not when the transaction committed, so a write rejected
   at commit time (for example, storage quota exhausted) could be lost
   while the application reported it saved.
2. Folder rename, move, delete, and copy were stored as many separate
   transactions; an interruption part-way through could leave
   descendants with paths that no longer matched their folder.
3. Opening BrowserOS in two browser tabs let each tab silently
   overwrite the other's settings and files (reproduced).
4. Recycle Bin was a placeholder that always said it was empty. Items
   moved to Trash could not be restored or permanently deleted, so the
   Trash folder only ever grew.
5. Code Studio kept every line of a file in the DOM: a 2 MB file
   (37,000 lines) took about 6.5 seconds to open and over 2 seconds
   per keystroke.
6. There was no way to export or restore BrowserOS data.

All of these were fixed in this release, together with the medium and
low findings listed below except where a finding is marked as
accepted or open. The overall release assessment is in
[FINAL_RELEASE_REPORT.md](FINAL_RELEASE_REPORT.md).

---

## 2. Scope and method

**Inspected in full:** the VFS (`virtualFileSystem.js`,
`storageAdapter.js`, `pathResolver.js`, `validationService.js`,
`entry.js`), `storage.js`, the event bus, the dialog component, the
Notes sanitizer and editor paste path, the Browser renderers and
address parsing, the Download Manager's filename and size handling,
the Code Studio editor's rendering and input path, the Code Studio
preview builder, bridge, and sandbox attributes, and the Recycle Bin.

**Inspected by targeted search across all 199 JavaScript files:**
HTML injection sinks (`innerHTML`, `outerHTML`, `insertAdjacentHTML`,
`document.write`, `insertHTML`), dynamic code (`eval`, `Function`,
string timers), `postMessage` and `message` listeners, IndexedDB and
localStorage access, `window.open` and `target="_blank"`, iframe
`sandbox` values, Blob URL creation and revocation, collection size
limits, cross-tab coordination, and comments describing unfinished
work.

**Measured in a running instance:**

- Boot time (navigation timing), with and without the web-font request.
- Listener, interval, event-bus, and DOM-node growth across four
  open/close cycles of every launchable application.
- VFS throughput (1,000 file creations, listing, whole-tree search) and
  File Explorer rendering of a 1,000-item folder.
- Code Studio and Notes with a 2 MB, 37,000-line file: time to open and
  time per keystroke, with the editor's internal methods timed
  separately from browser layout.
- Two tabs changing different settings.
- WCAG contrast ratios of the text color tokens on the theme
  backgrounds.

**Static analysis:** a script built the import graph of `src/` to
produce the dependency map below, detect import cycles, and list
modules nothing imports.

**Not covered:** browsers other than Chromium were not exercised
automatically; screen-reader behavior was reviewed from markup
(roles, labels, live regions), not with a screen reader.

---

## 3. Architecture overview

```
index.html
  themePreboot.js (classic script: picks the theme before first paint)
  src/main.js (boot)
    core/settings   SettingsService: schema, migrations, validation, persistence
    core            Desktop, WindowManager, AppManager, DesktopManager,
                    StartMenuManager, RecentFilesService, ClipboardService,
                    EventBus, StorageService (localStorage), theme, file associations
    core/vfs        VirtualFileSystem -> StorageAdapter (the only IndexedDB access),
                    PathResolver, ValidationService, SearchService, vfsOpener
    core/services   ServiceManager (background service lifecycle)
    core/notifications, core/shell, core/system, core/keyboard
    core/calendar, core/clock, core/browser, core/downloads (shared data services)
    components/*    window, dialog, context menu, start menu, shell panels, icons
    apps/*          applications, lazily imported through AppManager
```

Group-level dependency map (static imports; generated from source):

| Module group | Depends on |
| ------------ | ---------- |
| `core` | components (window, dialog, context menu, start menu, desktop icon), `core/keyboard`, `core/settings`, `core/vfs`, utils |
| `core/vfs` | `core`, utils, `components/dialog` (vfsOpener's "no application" message) |
| `core/settings` | `core`, `core/browser` (search engine ids for validation) |
| `core/browser`, `core/calendar`, `core/clock`, `core/downloads` | `core`, `core/settings`, `core/vfs`, `core/notifications` |
| `core/notifications` | `core`, `core/settings`, `components/notification`, utils |
| `core/shell` | `core`, `core/keyboard`, `core/notifications`, `core/settings`, `components/shell` |
| `components/*` | utils; dialogs also `core/vfs` (folder picker) and `core/browser` (clear browsing data) |
| `apps/*` | `core/*`, `components/*`, utils; Code Studio also `apps/terminal` (embedded terminal); Settings also `apps/code-studio` (editor font list) |

Observations:

- **No static import cycles** were found at file level.
- **No unused modules**: the only module nothing imports,
  `themePreboot.js`, is loaded by `index.html` as a classic script.
- Applications reach system services only through public singletons
  and AppManager; none construct a second VFS, settings service, or
  window manager, and only `storageAdapter.js` opens IndexedDB.
- Layering exceptions (all Low, see section 9): `vfsOpener.js` shows
  a dialog from `core/vfs`; Settings imports Code Studio's font list.

---

## 4. Application-by-application audit

"Suites" refers to the automated end-to-end suites listed in
[docs/TESTING.md](TESTING.md). "Leak probe" refers to the open/close
measurement in section 2; every application showed zero growth.

| Application | Verified | Findings |
| ----------- | -------- | -------- |
| Desktop | Icon selection, rectangle and multi-selection, drag and drop, context menus, delete, shortcuts, persistence of positions and sort mode (suites) | — |
| Start Menu, taskbar | Pinned apps, recent apps and files, search, keyboard opening (suites) | — |
| Window Manager | Focus and z-order, minimize, maximize, restore, resize, close, close veto for unsaved work, focus hand-off (suites) | — |
| File Explorer | Navigation, CRUD, rename, copy/cut/paste, nested folders, duplicate names, search, sorting, views, import, Open with (suites); 1,000-item folder renders in 139 ms | Trash folder offered no restore or permanent delete (F-04) |
| Recycle Bin | Opened with items in Trash | Placeholder: always "Recycle Bin is empty" (F-04) |
| Terminal | Commands, path handling, completion, history, file operations, errors, multiple windows (suites) | Output kept every line for the life of the window (F-14) |
| Settings | Every category, live application of changes, persistence after reload, search, reset (suites) | Lost changes when two tabs were open (F-03) |
| Notes | Rich and plain documents, sanitizing of stored and pasted HTML, drafts, search, links (suites and code review) | — |
| Calculator | Standard and scientific modes, history, keyboard, no `eval` (suites and code review) | — |
| Calendar | Events, recurrence, reminders, unreadable-file quarantine (suites and code review) | — |
| Clock | World clock, alarms, stopwatch, timer, missed alarms (suites) | — |
| Image Viewer | Formats, zoom, Blob URL revocation (suites and code review) | — |
| Task Manager | Applications, performance view, services, end task with unsaved-work warning (suites) | — |
| Notification Center, Quick Settings, tray | Banners, history, Do Not Disturb, actions (suites) | — |
| Browser | Address parsing, tabs, bookmarks, history, private tabs, internal pages, VFS pages, downloads, host-browser fallback (suites and code review) | Defense-in-depth gap in the web page sandbox (F-15) |
| Downloads | Fetch into `/Downloads`, size cap, filename sanitizing, list persistence (suites and code review) | — |
| Code Studio | Projects, templates, editing, tabs, search, quick open, diagnostics, preview sandbox, terminal, associations, unsaved-work prompts (suites) | Unusable with large files (F-05) |
| About | Version information (suites) | — |

Cross-application workflows verified by the suites include: creating
a Code Studio project, finding it in File Explorer, opening and editing
a source file, saving, and reading it back from Terminal; downloading
a file and opening it from the Download Manager and File Explorer;
opening VFS HTML files in Browser; changing appearance settings and
observing every open application update.

---

## 5. Confirmed bugs

| ID | Severity | Finding | Evidence | Status |
| -- | -------- | ------- | -------- | ------ |
| F-01 | Critical | **Writes reported before they were committed.** `StorageAdapter.put()` resolved on the request's `success` event. IndexedDB can still abort the transaction after that (quota exhaustion is reported at commit), so `vfs.write()` could resolve, the application could show "saved", and the data could be gone after a reload. | Confirmed (code) | Fixed |
| F-02 | High | **Folder operations were not atomic.** Renaming, moving, deleting, or copying a folder wrote the folder and each descendant in separate transactions. An interruption part-way (tab closed, crash) left descendants whose stored path no longer matched their folder: they still listed under the folder (by parent id) but could not be opened by path. | Confirmed (code) | Fixed |
| F-03 | High | **Two tabs overwrote each other.** Settings are saved as one document, and nothing coordinated tabs; files were last-writer-wins. Tab A set the theme to light, tab B then changed an unrelated setting, and after reload the theme was dark again. | Confirmed (reproduced) | Fixed |
| F-04 | High | **Recycle Bin did nothing.** The application was a placeholder that always said "Recycle Bin is empty", even with items in `/Trash`. The VFS had no restore or permanent delete, deleting an item inside Trash failed with "already in Trash", and a settings page told users there was no permanent deletion. | Confirmed (reproduced) | Fixed |
| F-05 | High | **Code Studio could not edit large files.** Every line was rendered as a DOM row. With a 2 MB, 37,039-line JavaScript file: 6.3–6.7 s to open and 2.0–2.8 s per keystroke. Editor JavaScript accounted for about 20 ms per keystroke; the rest was browser layout of the row layer (with the layer hidden, 216 ms; Notes with the same text, 34 ms). | Confirmed (reproduced) | Fixed |
| F-06 | High | **No backup or restore.** All data lives in one browser profile; clearing site data or switching browsers lost everything, and there was no export. | Confirmed (code) | Fixed |
| F-07 | Medium | **Boot failure left a broken desktop.** If IndexedDB could not be opened (blocked, disabled, or failing), `boot()` rejected after the shell was half built, with nothing shown to the user. Database `blocked` and `versionchange` events were not handled. | Confirmed (code) | Fixed |
| F-08 | Medium | **File names were barely validated.** Names containing newlines or other control characters, and names of 300 characters, were accepted. | Confirmed (reproduced) | Fixed |
| F-09 | Low | **Simultaneous creates leaked a storage error.** Two concurrent `createFile()` calls for the same path produced a raw `ConstraintError` instead of the VFS's `ALREADY_EXISTS`. | Confirmed (reproduced) | Fixed |
| F-10 | Low | **Moving an item into Trash bypassed delete.** `mv file /Trash` or cut/paste into Trash created a Trash item without its original location, and moving an item out of Trash kept stale Trash metadata. | Confirmed (code) | Fixed |

---

## 6. Security weaknesses

The audit looked for injection, unsafe code execution, sandbox
escapes, unsafe URL schemes, and privileged message handling. Areas
that were checked and found sound:

- **No `eval`, `new Function`, or string timers** anywhere in `src/`.
  The calculator uses its own parser.
- **HTML sinks**: the only `innerHTML` uses are in the Notes
  sanitizer, which parses with `DOMParser` (no script execution) and
  rebuilds output from an element and attribute allowlist with
  `http:`, `https:`, and `mailto:` links only. Pasted rich text goes
  through the same sanitizer.
- **Code Studio preview**: `sandbox="allow-scripts allow-modals
  allow-forms"` without `allow-same-origin`, so preview code runs in an
  opaque origin and cannot reach BrowserOS's DOM, storage, VFS, or
  globals. The parent accepts preview messages only from its own frame
  and with the session token, and only for console output, errors,
  in-page navigation, scroll position, and readiness. The syntax
  checker frame is sandboxed the same way.
- **Browser**: `javascript:`, `data:`, `blob:`, `file:`, `about:`
  (except `about:blank`), and other non-web schemes are refused.
  VFS HTML pages render with an empty sandbox (no scripts). Pages
  from BrowserOS's own origin render without scripts.
- **Downloads**: names are stripped of path separators, reserved and
  control characters, leading dots, and are length-limited; a size
  cap applies; executables are not stored.
- **External links** open with `noopener,noreferrer`.

Findings:

| ID | Severity | Finding | Status |
| -- | -------- | ------- | ------ |
| F-15 | Low | **Web page sandbox, defense in depth.** Pages from other sites are framed with `allow-scripts allow-same-origin` so they work normally. A sandbox's flags persist across navigation, so a framed site that navigated its frame to BrowserOS's own origin would run there with scripts. The only executable page at that origin is BrowserOS's `index.html`; a nested copy of BrowserOS would share storage with the running one. Suspected, not demonstrated. | Mitigated: BrowserOS refuses to start inside a frame of its own origin |
| F-16 | Low | **Third-party font request.** `index.html` loads fonts from Google Fonts as a render-blocking stylesheet: every start contacts a third party, and a slow font host delays first paint (measured: 590 ms to the first window with the request, 291 ms with it blocked). | Fixed: fonts load after boot without blocking; documented in SECURITY.md |
| F-17 | Info | **Console globals.** Core services are exposed on `window` for the developer console. This is only a concern if untrusted script runs in BrowserOS's origin, which the sandboxing above prevents. | Accepted, documented |

The full security model is documented in [SECURITY.md](SECURITY.md).

---

## 7. Performance problems

| Measurement | Result | Assessment |
| ----------- | ------ | ---------- |
| Boot to first window (warm, local server) | 590 ms (291 ms without the font request) | Acceptable; F-16 |
| Listener / interval / event-bus / DOM growth after 4 open/close cycles of each of 14 applications | 0 for every application | No leaks found |
| Create 1,000 files in one folder | 5.6 s (5.6 ms each) | Acceptable for interactive use; each create lists the folder to check for duplicates, so cost grows with folder size (F-18) |
| List a 1,000-file folder | 56 ms | Good |
| Search the whole file system | 20 ms | Good |
| File Explorer: open a 1,000-item folder / re-render after a rename | 139 ms / 164 ms | Acceptable |
| Notes: open a 2 MB text file | 72 ms; 34 ms per keystroke | Good |
| Code Studio: open a 2 MB file | 6.3–6.7 s | F-05 |
| Code Studio: keystroke in a 2 MB file | 2.0–2.8 s | F-05 |

| ID | Severity | Finding | Status |
| -- | -------- | ------- | ------ |
| F-05 | High | See section 5. | Fixed |
| F-14 | Low | Terminal output kept every line in the DOM for the life of the window. | Fixed: scrollback limit |
| F-18 | Low | Creating a file lists all siblings to check for a duplicate name, so creating many files in one folder is quadratic. 1,000 files take 5.6 s. | Accepted (documented) |

Collections that could grow without bound were checked: browsing
history (2,000 pages), download list (200), notification history
(limit and seven-day expiry), terminal history (500 commands),
calculator history (50), recent files (25), Code Studio output (1,000
lines) and undo history (500 steps) are all bounded.

---

## 8. Persistence and recovery risks

| ID | Severity | Risk | Status |
| -- | -------- | ---- | ------ |
| F-01 | Critical | Lost writes on commit failure (section 5). | Fixed |
| F-02 | High | Interrupted folder operations (section 5). | Fixed |
| F-03 | High | Concurrent tabs (section 5). | Fixed |
| F-06 | High | No backup or restore (section 5). | Fixed |
| F-07 | Medium | Unhandled database failure at start (section 5). | Fixed |
| F-19 | Medium | A missing default folder (for example `/Trash` removed by an older build or a damaged database) made delete fail with "Trash is unavailable" until the database was reset. | Fixed: default folders are re-created at start |

Areas checked and found sound: every localStorage-backed service
validates what it loads and falls back to defaults; settings have a
versioned migration chain and repair invalid values; the calendar sets
aside an unreadable events file instead of overwriting it; storage
write failures raise `storage:writeFailed`, which the storage monitor
turns into a notification.

---

## 9. Accessibility issues and architectural debt

Accessibility:

| ID | Severity | Finding | Status |
| -- | -------- | ------- | ------ |
| F-11 | Medium | **Tertiary text contrast.** `--color-text-tertiary` (86 uses: hints, timestamps, secondary labels) measured 2.98:1 on the dark window background and 3.93:1 on the light desktop background, below the WCAG 2.1 AA minimum of 4.5:1. | Fixed: 4.84:1 and 4.83:1 minimum |
| F-12 | Low | **Modal dialogs.** The focus trap only wrapped at the first and last control, so focus that started on the dialog itself could leave it with Shift+Tab; content behind the dialog stayed in the accessibility tree; with two dialogs open, Escape closed both. Suspected: every existing dialog focuses a control on open. | Fixed |
| F-22 | Medium | **Text size.** Interface text uses fixed pixel sizes and there is no text-size preference; enlarging text is only possible with browser zoom, which scales the whole interface. | Open |

Windows have labelled controls (`Minimize …`, `Maximize …`, `Close …`),
dialogs use `role="dialog"`/`alertdialog` with `aria-modal` and a
label, the terminal output is a `log` region, and the editor exposes
a labelled multi-line text field.

Architectural debt:

| ID | Severity | Finding | Status |
| -- | -------- | ------- | ------ |
| F-13 | Low | Comments in several modules described development history (bug numbers, "this step's spec") instead of behavior. | Fixed |
| F-20 | Low | `core/vfs/vfsOpener.js` imports a dialog component, and Settings imports Code Studio's font list: small layering exceptions. | Accepted: both are one-way and isolated |
| F-21 | Low | Multi-entry VFS operations had no shared write path, so each operation implemented its own sequence of single-entry writes (root cause of F-02). | Fixed: `putMany()` |

---

## 10. Recommended remediation priorities

Ordered by risk to user data first, then broken functionality, then
quality. All items were addressed in this release unless marked
accepted; F-22 (text size) remains open.

1. **Data integrity (F-01, F-02, F-09, F-10, F-19, F-21):** resolve
   writes on transaction commit; write multi-entry operations in one
   transaction; translate storage errors into VFS errors; route moves
   into Trash through delete; re-create default folders at start.
2. **Concurrent tabs (F-03):** allow one active BrowserOS tab per
   browser profile, with a clear way to move the session to another
   tab.
3. **Trash (F-04):** add `restore()`, `deletePermanently()`, and
   `emptyTrash()` to the VFS and make Recycle Bin a working application;
   offer the same actions in File Explorer's Trash folder and Terminal.
4. **Backup and restore (F-06):** a documented, versioned backup
   format with validation before anything is changed, explicit
   confirmation before replacing data, and an all-or-nothing restore.
5. **Startup failures (F-07, F-15):** a recovery screen when storage
   can't be opened; refuse to start nested inside a frame.
6. **Large files in Code Studio (F-05):** render only the visible part
   of the document.
7. **Validation and accessibility (F-08, F-11, F-12, F-14):** name
   rules, contrast, modal focus behavior, terminal scrollback.
8. **Documentation and tests:** security notes, architecture and
   testing guides, a unit test page, and end-to-end suites in the
   repository.
