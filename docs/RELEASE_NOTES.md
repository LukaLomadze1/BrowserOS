# BrowserOS release notes

## 16.0 — 7 November 2026

BrowserOS 16.0 is the first release presented as a finished product: it
has its own identity, a start-up screen and first-run tour, sample
content to explore, a complete About page, and everything needed to
deploy it as a static site. It also includes Code Studio and the
reliability work listed under *Also in this release*.

### New

- **Visual identity.** A BrowserOS mark (a window whose corner gives
  way to an orb), used on the Start button, the start-up screen, About,
  the favicon, and the touch icon.
- **Start-up screen.** Appears with the first paint and shows each real
  start-up stage as it finishes. It fades into the desktop without
  delaying it; a click or key skips the fade, and reduced motion turns
  it off.
- **Welcome tour.** Opens on a new installation: theme, accent, and
  wallpaper (applied live), the basics of windows and the desktop, the
  Start menu, files, and every installed application. Skippable,
  shown once, and available again from the Start menu and Settings ›
  System.
- **Sample files.** 21 files to explore, added only on request: a
  welcome text and a guide, three notes, a two-page portfolio website
  and an animated JavaScript demo for Code Studio, pictures, and a
  download. Existing files are never replaced; *Remove sample files*
  moves only unchanged samples to the Recycle Bin.
- **About BrowserOS.** Version, release date, and build; how BrowserOS
  is built; what the browser reports about itself and the device
  (clearly labelled as browser-reported), the site's storage estimate
  and whether it is persistent; the installed applications; credits and
  license.
- **Restart and Shut down** in the Start menu now work: both let
  applications finish and ask about unsaved work; Shut down stops
  BrowserOS and releases it for another tab until it is started again.
- **Deployment.** `tools/build.py` makes the production copy, stamps it
  with its commit, and verifies every import and asset reference;
  `tools/serve.py` serves it like a static host; `404.html`, response
  headers for Netlify and Cloudflare Pages, and a GitHub Pages workflow
  are included. See [INSTALLATION.md](INSTALLATION.md).

### Improved

- **One icon set.** Applications, file types, window controls, File
  Explorer, Settings, and the Start menu use the same line icons; no
  emoji or text characters stand in for icons anymore.
- **Consistent controls.** Primary buttons everywhere use the solid
  accent color (no gradients); shared button and key-cap styles.
- **File Explorer and Terminal** fill their windows edge to edge like
  every other application.
- **Fonts are served with BrowserOS.** Inter, Space Grotesk, and
  JetBrains Mono load from the site itself, so BrowserOS makes no
  requests to other sites and looks the same offline.
- **Code Studio's preview** shows a themed placeholder instead of a grey
  block before a page is run, and the editor can use the bundled
  JetBrains Mono (Settings › Code Studio).
- Windows can open centered (used by the Welcome tour).
- While an application's code loads for its first launch, the pointer
  shows progress.
- If BrowserOS's code can't be downloaded, the start-up screen says so
  and offers **Reload**, instead of waiting forever.
- File Explorer, Task Manager, and Code Studio fit their smallest window
  sizes: Explorer's toolbar wraps and its columns narrow, and Code
  Studio's sidebar and docked preview become narrower in small windows
  so the editor keeps its room.

### Changed

- About BrowserOS no longer opens at every start; nothing opens by
  itself except the Welcome tour on a new installation.
- Sample pictures are part of the optional sample files instead of
  being created on every new installation.
- The Start menu's Lock button, which had no function, was removed.

### Also in this release

- **Code Studio**, a code editor for HTML, CSS, and JavaScript projects
  in the file system: syntax highlighting, find and replace, project
  search, Go to file, diagnostics, an integrated terminal, and a live
  preview that runs pages in an isolated frame (docked or in its own
  window).
- **Recycle Bin** with restore (to the original or another folder),
  permanent deletion, and Empty; the same in File Explorer's Trash and
  the Terminal (`restore`, `purge`, `emptytrash`).
- **Backup and restore** of everything or of one folder, validated
  completely before anything changes.
- **Reliability:** file-system writes are confirmed only once stored,
  folder operations are all-or-nothing, BrowserOS runs in one tab at a
  time, and start-up problems show a recovery screen.
- **Accessibility:** modal dialogs keep focus and make the desktop
  inert; text contrast meets WCAG AA.

### Upgrading

Existing data is kept. On a browser that already has BrowserOS data, the
Welcome tour does not open by itself and no sample files are added; both
are available in Settings › System. Settings and backups from earlier
versions are read as before.

### Known limitations

See [FINAL_RELEASE_REPORT.md](FINAL_RELEASE_REPORT.md#known-limitations).
