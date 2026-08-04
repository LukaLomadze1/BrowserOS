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
  (Desktop, File Explorer, Start Menu, Terminal): a `*View` renders
  what it's told and forwards raw DOM facts upward; a `*Manager` owns
  state and decides what those facts mean.
- **EventBus** (`src/core/eventBus.js`) — the only channel core
  services, apps, and components use to talk to each other.
- **Application → AppManager → WindowManager** — apps never touch
  WindowManager directly.
- **Virtual File System** (`src/core/vfs/`) — the single source of
  truth for every file and folder, backed by IndexedDB, exposed
  through one public API (`vfs`) that Desktop, File Explorer, and
  Terminal all share.

## Apps

About, Calculator, Notes, File Explorer, Terminal, Recycle Bin.
