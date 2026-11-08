# Contributing to BrowserOS

Thanks for your interest. BrowserOS is deliberately small in its
dependencies and strict in its structure; these notes explain what that
means in practice.

## Ground rules

- **Plain HTML, CSS, and JavaScript.** No frameworks, libraries, build
  steps, or package managers. ES modules are loaded by the browser as
  they are.
- **One file system.** Every file and folder goes through the public
  `vfs` API (`src/core/vfs/virtualFileSystem.js`). Only
  `src/core/vfs/storageAdapter.js` talks to IndexedDB, and only
  `src/core/storage.js` to localStorage.
- **No `eval`, `new Function`, or HTML built from strings of user
  content.** Build DOM with `createElement()` from `src/utils/dom.js`;
  sanitize anything rich (see the Notes sanitizer).
- **Design tokens only.** Colors, spacing, radii, type sizes, and
  durations come from `styles/variables.css`. Icons come from
  `src/utils/icons.js`; shared buttons from `styles/controls.css`.
- **Applications talk to the system through AppManager, EventBus,
  SettingsService, and the other services** — never to WindowManager or
  another application's internals. See
  [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#building-an-application).
- **No fake features.** A control either works or isn't shown.

## Getting started

```sh
python tools/serve.py   # http://127.0.0.1:8000/
```

Edit a file and reload. A fresh browser profile (or a private window
that allows site storage) shows the first-run experience.

## Project layout

| Path | Contents |
| ---- | -------- |
| `index.html`, `404.html` | The page and the not-found page |
| `src/main.js` | Start-up: services, application registration, the desktop |
| `src/core/` | System services: VFS, settings, windows, applications, notifications, backup, sessions |
| `src/apps/<app>/` | One folder per application (`main.js` exports the Application class) |
| `src/components/` | Shared UI: windows, dialogs, menus, Start menu, tray panels |
| `src/utils/` | DOM helpers, icons, formatting |
| `styles/` | Global stylesheets and design tokens |
| `assets/` | Fonts (with their licenses) and brand images |
| `tests/` | Unit tests (in the browser) and end-to-end suites (Playwright) |
| `tools/` | `build.py` (production copy) and `serve.py` (local server) |
| `docs/` | Architecture, installation, user guide, security, testing, release notes |

## Tests

Every change needs a test that would have failed without it:

- logic without the DOM or the file system: a unit test in
  `tests/unit/`;
- behavior: a check in the end-to-end suite of the area, written from the
  user's point of view.

Run everything before opening a pull request:

```sh
python tests/run_all.py
```

The suite must end with all checks passed and no console errors. See
[docs/TESTING.md](docs/TESTING.md).

## Style

- Modules start with a `@file` comment explaining what the module is
  for and how it fits in; public functions and methods have JSDoc.
- Names say what things are (`restoreSelection`, not `doIt2`); comments
  explain why, not what.
- Keep files focused: a view renders, a manager decides, a service
  stores.
- User-facing text is short, specific, and in sentence case; error
  messages say what happened and what to do.

## Documentation

If a change affects behavior that is documented (the user guide,
architecture, security notes, keyboard shortcuts, persistence keys),
update the documentation in the same change.

## Reporting problems

Open an issue with the steps to reproduce, what you expected, what
happened, and the browser and version (About BrowserOS › System shows
it). For security problems, see [docs/SECURITY.md](docs/SECURITY.md#reporting-a-vulnerability).
