# BrowserOS 16.0 — Final release report

Release 16.0 · 7 November 2026 · assessed on the release candidate in
this repository

## Summary

BrowserOS 16.0 adds a product identity, a start-up screen with real
progress, a first-run Welcome tour, optional sample content, a complete
About page, working Restart and Shut down, one consistent icon and
control system across every application, self-hosted fonts, and the
tooling and documentation to deploy it as a static site.

**Assessment: ready to publish as a portfolio release, pending two
decisions by the copyright holder** — choosing a license, and deploying
(no deployment has been made). Every automated check passes against the
repository and against the production build (see [Tests
executed](#tests-executed)); cross-browser and screen-reader testing
have not been done and are listed under [Not tested](#not-tested).

## Contents

- [What was implemented](#what-was-implemented)
- [What was improved](#what-was-improved)
- [Defects found and fixed](#defects-found-and-fixed)
- [Tests executed](#tests-executed)
- [Not tested](#not-tested)
- [Known limitations](#known-limitations)
- [Unresolved issues](#unresolved-issues)
- [Deployment readiness](#deployment-readiness)
- [Recommended release procedure](#recommended-release-procedure)

## What was implemented

| Area | What | Where |
| ---- | ---- | ----- |
| Identity | The BrowserOS mark (window frame broken by an orb) as an icon in the shared set, an app tile (SVG plus 32, 180, and 512 px PNG), favicon and touch icon, and the mark for light and dark backgrounds | `src/utils/icons.js`, `assets/brand/` |
| Start-up | A start-up screen painted with the first frame, showing five real start-up stages; fades into a desktop that is already usable; skippable and off with reduced motion; `body[data-boot-state]`. If the code can't be downloaded, the screen says so and offers Reload | `index.html`, `styles/boot.css`, `src/core/system/bootScreen.js`, `src/core/system/bootFallback.js` |
| First run | Welcome tour: welcome with the sample-files offer, theme/accent/wallpaper (live), windows and desktop basics with the real shortcuts, Start menu, files, application list, summary. Opens once on a new installation; reopenable from the Start menu and Settings | `src/apps/welcome/`, `src/core/onboarding.js` |
| Sample content | 21 real files written through the VFS on request: welcome text, guide, three notes, a two-page portfolio site, an animated JavaScript demo with an ES-module import, four pictures, a download. Never replaces files; never re-created; removal moves only unchanged samples to Trash | `src/core/demo/` |
| About | Version, release date, build commit; architecture overview; browser-reported system information (labelled as such) with the storage estimate and persistence; application inventory; credits and license; repository link | `src/apps/about/`, `src/core/system/browserInfo.js`, `src/core/buildInfo.js` |
| Power | Restart and Shut down in the Start menu, with unsaved-work confirmation; Shut down releases the session | `src/main.js`, Start menu |
| Settings | System › Getting started: open the tour, add or remove sample files; both in Settings search | `src/apps/settings/pages/systemPage.js` |
| Deployment | `tools/build.py` (production copy, build information, base path for 404, reference check), `tools/serve.py` (host-like local server), `404.html`, `_headers`, `.nojekyll`, GitHub Pages workflow (manual) | `tools/`, repository root, `.github/workflows/` |
| Documentation | README, Installation, User guide, Architecture (new sections), Security (headers, no third-party requests), Testing, Release notes, Contributing, Demo script, this report | `README.md`, `CONTRIBUTING.md`, `docs/` |
| Tests | `test_first_run.py`; every suite uses the host-like server and can run against `dist/` (`run_all.py --site dist`); `screenshots.py` regenerates all documentation images | `tests/` |

## What was improved

- **Iconography.** All application icons, file-type icons, window
  controls, File Explorer's sidebar and toolbar, Settings categories,
  the Start menu (search, power, brand), and Recycle Bin rows now use
  the one line-icon set; text glyphs and an emoji were used before.
- **Controls.** Primary buttons in every application and dialog use the
  solid accent color instead of a gradient, with a consistent hover
  state; shared `.os-button` and `.os-kbd` styles.
- **Layout consistency.** File Explorer and Terminal fill their windows
  edge to edge like every other application (they sat inside an inset
  panel).
- **Typography.** Inter, Space Grotesk, and JetBrains Mono are served
  from `assets/fonts/` (OFL), preloaded, and split by script; BrowserOS
  makes no requests to other sites.
- **Code Studio preview placeholder** is themed instead of a grey block.
- **Windows can open centered** (`center: true` in an application's
  window options).
- **Start-up behavior.** About BrowserOS no longer opens at every start.
- **Loading feedback.** The first launch of an application shows a
  progress pointer while its code is fetched.
- **Narrow windows.** File Explorer, Task Manager, and Code Studio fit
  their minimum window sizes in both themes (checked for all fifteen
  applications).
- **Code Studio** can use the bundled JetBrains Mono.

## Defects found and fixed

| Defect | Severity | How it was found | Fix |
| ------ | -------- | ---------------- | --- |
| Start menu showed Lock, Restart, and Shut down buttons that were permanently disabled (a visible control with no function) | Medium | Inspection | Restart and Shut down implemented; Lock removed |
| File Explorer and Terminal were inset in padded panels while all other applications were edge to edge | Low | Screenshot review | Edge-to-edge layout |
| Code Studio's empty preview showed a light grey block in the dark theme | Low | Screenshot review | Opaque themed placeholder |
| Text glyphs and a color emoji (lock) used as icons rendered inconsistently across fonts | Low | Screenshot review | Vector icons |
| Removing sample files tried to permanently delete empty folders that weren't in Trash, which the VFS refuses | Medium | `test_first_run.py` | Empty folders are moved to Trash and purged |
| If any module failed to download at start-up, BrowserOS stayed on its start-up screen with no explanation | Medium | Diagnosing an intermittent test failure | `bootFallback.js` reports it with a Reload button; tested by blocking a module |
| The test servers' listen backlog of 5 made Windows refuse some of the dozens of simultaneous module requests, causing intermittent start-up and application-load failures in the tests | Test infrastructure | Diagnosing the same failure | Backlog raised to 128 in the test servers and `tools/serve.py` |
| At their minimum window sizes, File Explorer's toolbar, Task Manager's filter, and Code Studio's docked preview overflowed the window | Low | A layout sweep of every application at minimum and maximized size, in both themes | Wrapping toolbar, proportional columns, and narrower Code Studio panes in small windows |
| The Welcome tour counted 14 applications while About and the documentation count 15 | Low | Review | The tour lists all 15 |

## Tests executed

Environment: Chromium 145.0.7632.6 driven by Playwright 1.58.0 (Python 3.10.11), Windows 11 Home 10.0.26200, viewports 1280 × 800 to 1440 × 900, run on 8 November 2026.

**Against the repository (`python tests/run_all.py`)**

| Suite | Passed | Failed | Time |
| ----- | -----: | -----: | ---: |
| `tests/run_unit.py` | 72/72 | 0 | 1 s |
| `tests/e2e/test_applications.py` | 135/135 | 0 | 88 s |
| `tests/e2e/test_browser.py` | 143/143 | 0 | 115 s |
| `tests/e2e/test_code_studio.py` | 215/215 | 0 | 100 s |
| `tests/e2e/test_first_run.py` | 90/90 | 0 | 15 s |
| `tests/e2e/test_preferences.py` | 118/118 | 0 | 68 s |
| `tests/e2e/test_regression.py` | 27/27 | 0 | 16 s |
| `tests/e2e/test_release.py` | 59/59 | 0 | 35 s |
| `tests/e2e/test_settings.py` | 63/63 | 0 | 17 s |
| `tests/e2e/test_system_shell.py` | 151/151 | 0 | 108 s |
| **Total** | **1073/1073** | **0** | 9 min |

**Against the production build (`python tools/build.py` then `python tests/run_all.py --site dist`; unit tests run from the repository)**

| Suite | Passed | Failed | Time |
| ----- | -----: | -----: | ---: |
| `tests/run_unit.py` | 72/72 | 0 | 1 s |
| `tests/e2e/test_applications.py` | 135/135 | 0 | 88 s |
| `tests/e2e/test_browser.py` | 143/143 | 0 | 114 s |
| `tests/e2e/test_code_studio.py` | 215/215 | 0 | 100 s |
| `tests/e2e/test_first_run.py` | 90/90 | 0 | 16 s |
| `tests/e2e/test_preferences.py` | 118/118 | 0 | 68 s |
| `tests/e2e/test_regression.py` | 27/27 | 0 | 16 s |
| `tests/e2e/test_release.py` | 59/59 | 0 | 35 s |
| `tests/e2e/test_settings.py` | 63/63 | 0 | 17 s |
| `tests/e2e/test_system_shell.py` | 151/151 | 0 | 101 s |
| **Total** | **1073/1073** | **0** | 9 min |

Also executed: `python tools/build.py` (every module import, stylesheet, script, font, and image reference resolves; 214 files, 2.37 MB), and `python tests/screenshots.py`, which drove BrowserOS through every screen in `docs/screenshots/` without errors.

## Not tested

- **Firefox and Safari.** All automated tests run in Chromium.
- **Screen readers.** Markup, roles, labels, and focus handling were
  reviewed and keyboard paths are tested; no session with NVDA,
  JAWS, or VoiceOver was made.
- **A real deployment.** No deployment was made. The production build
  was tested on a local server that applies the same headers and 404
  behavior as the hosts; the GitHub Pages workflow has not been run.
- **Mobile and touch devices**, and window sizes below 1280 × 800.
- **Real storage exhaustion** (the error path is tested by simulation).
- **Long-running sessions** beyond the length of the test suites.

## Known limitations

- BrowserOS is a web page: no access to the computer's files, hardware,
  or other programs, and nothing runs while its tab is closed (alarms,
  timers, and reminders included).
- Data is stored per browser profile and per site address, isn't
  synced, and isn't encrypted at rest; clearing site data erases it.
  Backups are manual.
- One tab at a time per browser profile.
- The Browser can show only sites that allow embedding; it can't read
  or script embedded pages from other sites; only CORS-enabled files can
  be downloaded into BrowserOS.
- Code Studio has no Node.js, package manager, build tools, or server.
  Word wrap pauses above 2,000 lines; files of several megabytes take
  about 0.2 s per keystroke.
- Creating thousands of files in one folder slows down gradually (about
  5.6 s for 1,000).
- No text-size preference; browser zoom scales everything.
- Task Manager measures responsiveness, not CPU or memory of individual
  applications (browsers don't expose them).
- Calendar has no time zones per event and no iCalendar import or
  export; Notes can't contain images or tables; Image Viewer doesn't
  save rotation.
- Wallpapers are generated presets; uploading images isn't supported.
- Tested in Chromium only.

[ARCHITECTURE.md](ARCHITECTURE.md#known-limitations) has the complete
technical list.

## Unresolved issues

| Issue | Severity | Status |
| ----- | -------- | ------ |
| No license file: the code can't be reused by others until the copyright holder chooses a license (then set `BROWSEROS_LICENSE` in `src/core/version.js`) | Release blocker for reuse, not for running | Needs the copyright holder's decision |
| No text-size preference (engineering audit finding F-22) | Medium | Open |
| Not tested in Firefox, Safari, or with a screen reader | — | Open |

## Deployment readiness

| Requirement | State |
| ----------- | ----- |
| Static hosting, no backend | Yes: no server code, secrets, or environment variables |
| Production build | `python tools/build.py` → `dist/` (214 files, 2.37 MB), all references verified |
| Production build tested | Yes: every end-to-end suite against `dist/` on a host-like server (see above) |
| Asset paths | All relative; works at a domain root or under a path (`--base-path` adjusts only `404.html`) |
| Refresh and routing | Single page at the root, no client-side routes; refresh tested; missing paths serve `404.html` |
| Caching | Host defaults (revalidation on Netlify and Cloudflare Pages, ten minutes on GitHub Pages); fonts cached for a year; no service worker |
| Persistence on the deployed origin | IndexedDB and localStorage per origin; tested on the local production server, including reloads, restart, and shut down |
| HTTPS | Required for the single-tab guard and backup checksums; provided by all three documented hosts |
| Deployed | **No.** Instructions: [INSTALLATION.md](INSTALLATION.md#deploying) |

## Recommended release procedure

1. **Choose a license** (for example MIT for a portfolio project that
   others may learn from), add `LICENSE`, and set `BROWSEROS_LICENSE`
   in `src/core/version.js`; update the README's License section.
2. Run `python tests/run_all.py` and, after `python tools/build.py`,
   `python tests/run_all.py --site dist`. Both must end with every check
   passing.
3. Commit and push to `main`.
4. Deploy: on GitHub, **Settings › Pages › Source: GitHub Actions**, then
   **Actions › Deploy to GitHub Pages › Run workflow** (or use Netlify or
   Cloudflare Pages as in [INSTALLATION.md](INSTALLATION.md)).
5. Check the deployed site in a fresh browser profile: the start-up
   screen and Welcome tour appear; sample files open; Code Studio runs
   `/Projects/Portfolio-Website`; About › System shows the build commit;
   a reload keeps everything; an unknown path shows the 404 page.
6. Tag the release (`v16.0`) and create a GitHub release with
   [RELEASE_NOTES.md](RELEASE_NOTES.md).
7. Add the deployed address to the repository's About box and the
   README, and set a social preview image (for example
   `docs/screenshots/desktop.png`).
8. Optionally record the demo with [DEMO_SCRIPT.md](DEMO_SCRIPT.md).
