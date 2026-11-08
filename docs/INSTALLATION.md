# Installing and deploying BrowserOS

BrowserOS is a static website: HTML, CSS, JavaScript modules, fonts,
and images. It has no build step that it depends on, no server code, no
database server, and no configuration secrets. Anything that can serve
static files over HTTPS can host it.

## Contents

- [Requirements](#requirements)
- [Running it locally](#running-it-locally)
- [The production build](#the-production-build)
- [Deploying](#deploying)
- [Headers, caching, and errors](#headers-caching-and-errors)
- [Where user data lives](#where-user-data-lives)
- [Configuration](#configuration)
- [Troubleshooting](#troubleshooting)

## Requirements

To use BrowserOS:

- A current desktop browser. The automated tests run in Chromium
  (Chrome, Edge, and other Chromium-based browsers); Firefox and Safari
  support every web API BrowserOS uses but have not been tested.
- A secure context: HTTPS, or `http://localhost` / `http://127.0.0.1`
  for local use. On plain HTTP from another address, browsers withhold
  the Web Locks API (used to keep BrowserOS in one tab) and the Web
  Crypto API (used to checksum backups): BrowserOS still runs, but
  without the single-tab guard, and new backups carry no checksum.
- JavaScript and site storage (IndexedDB and localStorage) allowed for
  the site. Some private-browsing modes block or limit them; BrowserOS
  then shows a start-up notice instead of the desktop.

To run the tools and tests (optional): Python 3.9 or later. The tests
also need Playwright (see [TESTING.md](TESTING.md)).

## Running it locally

```sh
git clone https://github.com/LukaLomadze1/BrowserOS.git
cd BrowserOS
python tools/serve.py
```

Then open <http://127.0.0.1:8000/>. `tools/serve.py` serves the
repository like a static host would: correct content types for
modules and fonts, the headers in `_headers`, and `404.html` for
missing paths.

Any other static server works too (`python -m http.server`,
`npx serve`, a web server's document root), as long as it sends `.js`
files as `text/javascript`. Opening `index.html` directly from disk
(`file://`) does not work: browsers don't load JavaScript modules from
files.

There is nothing to install or compile while developing: edit a file
and reload the page.

## The production build

```sh
python tools/build.py                          # site served at the root of a domain
python tools/build.py --base-path /BrowserOS/  # site served under a path, e.g. a GitHub Pages project site
```

This writes `dist/`: only the files the site uses (`index.html`,
`404.html`, `assets/`, `src/`, `styles/`, `_headers`, `.nojekyll`),
with two changes:

- `src/core/buildInfo.js` records the Git commit and build time, which
  About BrowserOS › System shows;
- `404.html` gets absolute links for the given base path.

The build also checks every module import, stylesheet, script, font,
and image reference, and stops with a list of missing files if
anything doesn't resolve. The result is about 2.4 MB in 214 files.

Preview and test the build exactly as it will be published:

```sh
python tools/serve.py dist          # http://127.0.0.1:8000/
python tests/run_all.py --site dist # every end-to-end suite against dist/
```

## Deploying

### GitHub Pages

The repository includes a workflow that builds and publishes `dist/`:

1. In the repository on GitHub, open **Settings › Pages** and set
   **Source** to **GitHub Actions**.
2. Open **Actions › Deploy to GitHub Pages › Run workflow**.

The workflow (`.github/workflows/deploy-pages.yml`) runs
`tools/build.py` with the repository name as base path, so the site
works at `https://<user>.github.io/<repository>/`. It runs only when
started by hand; to publish on every push to `main`, add
`push: { branches: [main] }` under `on:`.

Alternatively, choose **Deploy from a branch** (`main`, `/ (root)`):
the repository itself is served. Everything works, except that About
shows no build information and the 404 page's link points at the
domain root rather than the project path. GitHub Pages ignores
`_headers`; see [Headers, caching, and errors](#headers-caching-and-errors).

### Netlify

Create a site from the repository with:

| Setting           | Value                     |
| ----------------- | ------------------------- |
| Build command     | `python3 tools/build.py`  |
| Publish directory | `dist`                    |

Or build locally and drag the `dist` folder onto Netlify's deploy page.
Netlify applies `_headers` from `dist/`.

### Cloudflare Pages

Create a project from the repository with:

| Setting                | Value                    |
| ---------------------- | ------------------------ |
| Framework preset       | None                     |
| Build command          | `python tools/build.py`  |
| Build output directory | `dist`                   |

Cloudflare Pages applies `_headers` from `dist/`.

### Any other static host

Run `python tools/build.py` (with `--base-path` if the site isn't at
the root of its domain) and upload the contents of `dist/`. Configure
the host to serve `404.html` for missing paths if it doesn't do so
already. No rewrites are needed: BrowserOS has no client-side routes.

## Headers, caching, and errors

`_headers` (used by Netlify and Cloudflare Pages, and by
`tools/serve.py`) sends:

| Header                   | Value                                   | Why |
| ------------------------ | --------------------------------------- | --- |
| `X-Content-Type-Options` | `nosniff`                               | Files are used only as the type they are served as. |
| `X-Frame-Options`        | `SAMEORIGIN`                            | Other sites can't show BrowserOS in a frame (clickjacking). |
| `Referrer-Policy`        | `strict-origin-when-cross-origin`       | Other sites see at most the origin. |
| `Permissions-Policy`     | camera, microphone, geolocation, payment, USB, serial, Bluetooth off | BrowserOS uses none of them. |
| `Cache-Control` (fonts)  | `public, max-age=31536000`              | Font files never change under the same name. |

Everything else uses the host's default caching, which for Netlify and
Cloudflare Pages means revalidating on every load, so a new deployment
is picked up by the next reload. GitHub Pages caches files for ten
minutes and ignores `_headers`. There is no service worker and no
offline cache.

Missing paths get `404.html`, a small standalone page with a link back
to BrowserOS. Refreshing BrowserOS itself always works, because the
desktop is a single page at the site's root.

Why there is no Content-Security-Policy header is explained in
[SECURITY.md](SECURITY.md#response-headers).

## Where user data lives

Each visitor's files, settings, and application data are stored in
their own browser, for the site's origin (scheme, host, and port). That
means:

- nothing is stored on the server, and visitors never see each other's
  data;
- moving BrowserOS to another address (another host, domain, or port)
  starts with empty storage there; use **Settings › System › Back up
  everything** at the old address and **Restore from a backup** at the
  new one;
- a deployment never changes or deletes anyone's data. Data formats are
  versioned: settings migrate forward, and backups record their format
  version.

## Configuration

BrowserOS needs no environment variables or keys. The only values to
adjust when forking:

| What                    | Where                                           |
| ----------------------- | ----------------------------------------------- |
| Repository link in About | `BROWSEROS_REPOSITORY` in `src/core/version.js` |
| License shown in About  | `BROWSEROS_LICENSE` in `src/core/version.js` (an SPDX id, or `null`) |
| Version and release date | `BROWSEROS_VERSION`, `BROWSEROS_RELEASE_DATE` in `src/core/version.js` |
| Base path of the 404 page | `--base-path` of `tools/build.py`             |

## Troubleshooting

| Symptom | Cause and fix |
| ------- | ------------- |
| Blank page; the console says a module was blocked because of its MIME type | The server sends `.js` as `text/plain`. Use `tools/serve.py`, or configure the server to send `text/javascript`. |
| *BrowserOS couldn't be loaded* on the start-up screen | A file of the site failed to download. Check that the deployment is complete (`tools/build.py` verifies it before upload) and the connection works, then reload. |
| *BrowserOS couldn't start* | Site storage is blocked or full (private mode, cookie settings, a full disk). The notice shows the browser's message. Allow storage for the site and select **Try again**. |
| *BrowserOS is open in another tab* | BrowserOS runs in one tab per browser profile. Close the other tab, or select **Use BrowserOS here**. |
| The 404 page's link leads to the wrong place | Build with `--base-path` set to the path the site is served from. |
| Changes don't appear after deploying to GitHub Pages | Its cache lasts up to ten minutes; reload after that. |
