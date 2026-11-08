# Testing BrowserOS

BrowserOS has two kinds of automated tests:

- **Unit tests** (`tests/unit/`) run in a browser page and cover modules
  that can be tested directly: path handling, name rules, address
  parsing, the calculator parser, JSON diagnostics, the Notes sanitizer,
  download names, the backup format, the virtual file system, and
  user-agent parsing.
- **End-to-end suites** (`tests/e2e/`) drive BrowserOS in Chromium with
  Playwright, the way a person would: clicking, typing, dragging, using
  keyboard shortcuts, and checking what appears on screen and what ends
  up in storage.

## Requirements

- Python 3.9 or later
- Playwright for Python and its Chromium build:

```sh
pip install playwright
python -m playwright install chromium
```

BrowserOS itself needs nothing installed.

## Running the tests

```sh
python tests/run_all.py                 # everything (about 10 minutes)
python tests/run_all.py release browser # only suites whose file name contains a word
python tests/run_all.py --site dist     # the end-to-end suites against the production copy
python tests/run_unit.py                # unit tests only (seconds)
python tests/e2e/test_first_run.py      # one end-to-end suite
```

Each command prints one `PASS`/`FAIL` line per check and ends with
`N/M passed`; the exit status is 0 only if everything passed.
Screenshots and files downloaded by the suites are written to
`tests/e2e/output/` (ignored by Git).

`--site dist` tests the production copy made by `python tools/build.py`
(build it first). The end-to-end suites then serve `dist/` instead of
the repository; the unit tests always run from the repository, because
`tests/` isn't part of the published site. The variable behind it,
`BROWSEROS_SITE_ROOT`, can point a single suite at any folder.

To use an installed browser instead of Playwright's Chromium, set
`BROWSEROS_TEST_CHANNEL` (for example `chrome` or `msedge`).

The unit tests can also be opened directly: run `python tools/serve.py`
and visit <http://127.0.0.1:8000/tests/unit/>.

### How the suites run BrowserOS

- Every suite starts its own server on a free port and uses a fresh
  browser profile, so its storage is empty at the start and discarded
  at the end. Tests never read or change anyone's BrowserOS data; the
  unit tests use a temporary IndexedDB database
  (`storageAdapter.useDatabase()`) and never touch localStorage.
- The server is `tools/serve.py`'s handler: strict content types, the
  headers from `_headers`, and `404.html` for missing paths, as on a
  static host.
- A fresh profile is a new installation, so the Welcome tour opens.
  `common.wait_desktop()` waits until `<body data-boot-state="ready">`
  and skips the tour, with or without sample files
  (`wait_desktop(page, samples=True)` for suites that use the sample
  pictures). `test_first_run.py` tests the tour itself.

## What is covered

| Suite | Checks | Covers |
| ----- | -----: | ------ |
| `tests/run_unit.py` (`tests/unit/`) | 72 | Paths and name rules; address parsing and refused schemes; calculator parsing; JSON error positions; Notes sanitizer; download file names; backup format (round trip, damage, truncation, newer versions, structure); file system CRUD, folder rename/move/copy, Trash (delete, restore, permanent delete, empty), storage error codes, default-folder repair, backup import and replace; browser and platform detection for About BrowserOS |
| `e2e/test_first_run.py` | 90 | Start-up screen and its staged progress; no requests to other sites and no failed requests; self-hosted fonts and icons; the Welcome tour (centered, live theme/accent/wallpaper, keyboard, real shortcuts, Start menu and File Explorer from the tour, application list, completion, not shown again); sample files (contents, both sample projects running in Code Studio's preview, never re-created, never replacing files, removal of unchanged files only, whole-folder and file-by-file removal); existing installations; About BrowserOS (version, browser-reported values, application count, build information, keyboard tabs); loading feedback on an application's first launch; Restart and Shut down; a failed code download at start-up; 404 page, response headers, and content types |
| `e2e/test_release.py` | 59 | Recycle Bin and File Explorer's Trash; Terminal `restore`/`purge`/`emptytrash` and scrollback; backup and restore through Settings (including refusal of a damaged backup); one active tab per profile, takeover, and unsaved-work prompts; start-up failure screen; nested copies; modal dialogs; editing a 20,000-line file; a cross-application workflow |
| `e2e/test_code_studio.py` | 215 | Projects and templates, file operations, editing, find and replace, saving, live preview and its sandbox, pop-out preview, integrated terminal, file associations, project search, diagnostics, unsaved-work guards, layout |
| `e2e/test_browser.py` | 143 | Address parsing, tabs, embedding policy and fallbacks, bookmarks, history, private tabs, downloads into the file system |
| `e2e/test_system_shell.py` | 151 | Tray, Notification Center, Quick Settings, date panel, Task Manager, background services, resource cleanup when applications close |
| `e2e/test_applications.py` | 135 | Notes, Calculator, Calendar, Clock, Image Viewer, file associations, shared dialogs |
| `e2e/test_preferences.py` | 118 | Desktop, Start Menu, File Explorer, Keyboard, and System preferences and their effects; desktop selection and drag and drop |
| `e2e/test_settings.py` | 63 | Settings navigation, search, appearance, persistence across reloads, narrow layout |
| `e2e/test_regression.py` | 27 | Windows, desktop, File Explorer, and Terminal keep their state through appearance and motion changes |

Every end-to-end suite also fails if BrowserOS logs a console error.

`python tools/build.py` is itself a check: it fails if any module
import, stylesheet, script, font, or image referenced by the site is
missing from the build.

## Writing tests

- **Unit tests**: add a `*.test.js` module to `tests/unit/` and import it
  from `tests/unit/run.js`. Use `group()`, `test()`, and `assert`
  (`ok`, `equal`, `deepEqual`, `rejects(fn, code)`) from `harness.js`.
  Tests run in order, so file-system tests may build on earlier ones.
- **End-to-end suites**: start from `tests/e2e/test_first_run.py` or
  `test_release.py`. `common.py` provides `serve()` (a host-like server
  on a free port), `boot()`, `wait_desktop()`, `dismiss_welcome()`,
  `close_all()`, `dialog_button()`, `wait_for()`, and a `Report` with
  `check()`, `section()`, and `watch_console()`. Prefer user-level
  actions (clicks, keys, visible text); use `page.evaluate()` for setup
  and for reading state that has no visible representation.
- Name a check after the behavior it proves ("Delete in Trash asks to
  delete permanently"), so a failure reads as a bug report.

## Screenshots

`python tests/screenshots.py` (or `python tests/screenshots.py dist`)
regenerates every image in `docs/screenshots/` from BrowserOS running in
a fresh profile with the sample files.

## Manual checks

Some behavior isn't covered automatically and should be checked by hand
before a release:

- Firefox and Safari (the automated tests use Chromium only).
- A screen reader (NVDA, VoiceOver) on the desktop, dialogs, the Welcome
  tour, Recycle Bin, and Settings.
- A real deployment on each host in [INSTALLATION.md](INSTALLATION.md)
  (the tests use a local server that mimics them).
- Behavior when the browser's storage is actually full (the tests cover
  the error path, not a real full disk).
- Very large files and folders beyond the sizes in `test_release.py`.

## Latest results

See [FINAL_RELEASE_REPORT.md](FINAL_RELEASE_REPORT.md#tests-executed)
for the most recent full runs and the environment they ran in.
