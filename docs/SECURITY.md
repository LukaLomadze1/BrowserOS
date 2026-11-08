# BrowserOS Security Notes

BrowserOS is a static web application: HTML, CSS, and JavaScript files
served as-is, with no server-side code, accounts, or sync. Everything it
stores stays in the visitor's browser profile. This document describes
what BrowserOS isolates, how, where the limits are, and which of them
belong to the host browser rather than to BrowserOS.

## Threat model

**In scope** — content BrowserOS handles that may be hostile:

- web pages opened in the Browser application;
- HTML, CSS, and JavaScript run in the Code Studio preview;
- files in the virtual file system, whatever their origin (imported from
  the computer, downloaded, created by an application, or restored from a
  backup);
- rich text pasted into Notes;
- backup files chosen for restoring;
- names and headers supplied by web servers during downloads;
- text typed into the address bar.

**Out of scope** — a compromised or malicious host browser or browser
extension, and anyone with access to the browser profile on the device.
BrowserOS data is **not encrypted at rest**: it is ordinary IndexedDB and
localStorage data of the site's origin, readable by anyone who can use
that browser profile.

## What BrowserOS controls and what the browser controls

| BrowserOS controls | The host browser controls |
| ------------------ | ------------------------- |
| Which `sandbox` flags each frame gets, and which URL schemes may be opened | Enforcing the sandbox, the same-origin policy, and CORS |
| Which messages from frames it listens to, and what it does with them | Whether a site may be framed at all (`X-Frame-Options`, `frame-ancestors`) |
| How file names, paths, and stored content are validated | Cookies, logins, and permissions of embedded sites |
| What is written to IndexedDB and localStorage, and when | Storage quotas, eviction, and private-mode behavior |
| Asking before destructive actions | Pop-ups that leave the sandbox, and downloads saved by the browser |

BrowserOS never tries to work around browser restrictions: pages that
refuse to be framed are opened in a host-browser tab instead, and files
that a server doesn't allow to be fetched (CORS) are downloaded by the
host browser instead of into BrowserOS.

## Isolation boundaries

### Code Studio preview

Project pages run in an iframe with `sandbox="allow-scripts allow-modals
allow-forms"` and **without** `allow-same-origin`, built from `srcdoc`.
The page therefore runs in an opaque origin:

- it can run its own JavaScript, show alerts, and submit forms;
- it **cannot** read or change BrowserOS's DOM, IndexedDB, localStorage,
  cookies, or JavaScript objects (the VFS and other services are not
  reachable);
- it cannot navigate BrowserOS itself (no `allow-top-navigation`) or
  open pop-ups (no `allow-popups`);
- it **can** make network requests (`fetch`, form submissions, images)
  to other sites, subject to CORS, like any web page. Project code can
  therefore send whatever it contains to the network; only run projects
  you trust with their own content.

Project files are inlined as `data:` URLs (with an import map for
modules) before the page loads; nothing from the VFS is served to the
frame afterwards. A one-line bridge script inside the frame reports
console output, errors, in-page navigation, and scroll position to the
parent with `postMessage`. The parent accepts a message only when
`event.source` is its own preview frame **and** the message carries the
session's random token, and it only displays the information — no
message can read or write files, launch applications, or call any
BrowserOS service. Every new build gets a new frame and token.

The JavaScript syntax checker parses code the same way: a sandboxed
`allow-scripts` frame with no other permissions, answering only its own
parent with a token. Code is never parsed or run in BrowserOS's own
window.

### Browser application

| Page | Frame sandbox | Effect |
| ---- | ------------- | ------ |
| Other sites (`http`, `https`) | `allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads` | Sites work normally **in their own origin**; they can't read BrowserOS, and BrowserOS can't read them. They can't navigate BrowserOS away. |
| Pages from BrowserOS's own address | the same, **without** `allow-scripts` and `allow-modals` | Readable (title, address, download links) but scripts don't run, so they can't reach BrowserOS. |
| HTML files from the VFS (`vfs://`) | `sandbox=""` | No scripts, forms, or pop-ups at all. |
| Images from the VFS | shown with `<img>` | SVG scripts never run in an image. |

Address bar input is parsed by `src/core/browser/urlUtils.js`:
`javascript:`, `data:`, `blob:`, `file:`, `about:` (except
`about:blank`), `chrome:`, `view-source:`, `filesystem:`, `ws:`, and
`wss:` are refused; `mailto:`, `tel:`, and `sms:` are handed to the
operating system; host names are validated.

**Residual risk.** A sandbox's flags stay with the frame when it
navigates. A site framed with scripts and same-origin access that
navigates its frame to BrowserOS's own address would run with
BrowserOS's privileges. The only executable page at that address is
BrowserOS's own `index.html`, which refuses to start inside a frame of
its own origin, so this does not give the site a way in on a host that
serves only BrowserOS. **Do not serve other, user-controlled HTML from
the same origin as BrowserOS.**

Embedded sites use the host browser's cookies for those sites (third-party
cookie rules apply). Private tabs keep history and downloads out of
BrowserOS's records; they do not create a separate cookie jar.

### Notes rich text

`.note` documents and pasted rich text go through `sanitizeHtml()`
(`src/apps/notes/noteFormat.js`): the HTML is parsed with `DOMParser`
(which never runs scripts) and rebuilt from an allowlist of elements and
attributes. Scripts, styles, frames, forms, media, event handlers, and
every link that isn't `http:`, `https:`, or `mailto:` are removed before
the content reaches the editor or storage. Links open in the host browser
with `noopener,noreferrer`.

### Other content

- **No dynamic code.** There is no `eval`, `new Function`, or string
  timer anywhere in `src/`. The calculator uses its own parser; JSON is
  only ever parsed with `JSON.parse`.
- **DOM construction.** Interface code builds elements with DOM APIs
  (`createElement`, `textContent`). The only `innerHTML` writes are in
  the Notes sanitizer and editor, after sanitizing.
- **Messages.** The preview and the syntax checker are the only
  `message` listeners, validated as described above.

## Files and storage

- **Paths** are normalized by `src/core/vfs/pathResolver.js`; `..` can't
  climb above `/`, and every entry is looked up by its normalized path.
  The VFS is a namespace inside IndexedDB, not the host file system: no
  path can reach files on the computer.
- **Names** may not contain `/ \ : * ? " < > |`, control characters, or be
  longer than 255 characters. `/Trash` and `/System` can't be renamed,
  moved, or deleted.
- **Imports** from the computer are limited to 25 MB per file.
- **Downloads** take their names from `Content-Disposition` or the URL,
  stripped of path separators, reserved and control characters, and
  leading dots, and limited to 120 characters. A size limit applies
  (Settings › Downloads, 250 MB by default). Windows executables
  (`.exe`, `.msi`) are never stored.
- **Backups** are validated completely before anything is restored
  (format, version, SHA-256 checksum, sizes, structure); a full restore
  replaces data only after an explicit confirmation, in one transaction.
  Files over 512 MB are not read. A backup file contains **everything**,
  including browsing history and the content of every file, unencrypted —
  keep it as private as the data itself.
- **Writes** are confirmed only once the browser has committed them;
  failures (including a full disk) are reported, not hidden.
- **Sample files are added only on request** (the Welcome tour's
  checkbox or Settings › System), never replace an existing file, and
  removing them moves only unchanged samples to Trash. The sample web
  projects run in Code Studio's sandboxed preview like any other project.
- **One tab at a time.** Only one tab runs BrowserOS per profile, so two
  copies can't overwrite each other's data (see
  [ARCHITECTURE.md](ARCHITECTURE.md#sessions-and-start-up)).

## Network requests BrowserOS makes

| Request | When |
| ------- | ---- |
| Pages and their resources | When the Browser opens a site. |
| Favicons (`/favicon.ico` or the page's icon) | For sites in tabs, history, bookmarks, and start-page shortcuts. |
| Search engine | When text typed in the address bar is searched. |
| Files being downloaded | When a download is started. |

Starting BrowserOS and using every application other than the Browser
and Downloads makes no requests to other sites: scripts, styles, fonts
(`assets/fonts/`), and images are all served with BrowserOS. The
automated tests check this at start-up. Nothing is sent to any
BrowserOS server; there is none. About BrowserOS reads what the browser
reports about itself (user agent, screen, language, storage estimate)
only to display it.

## Deployment recommendations

- **Serve over HTTPS** (or from `localhost`). The single-tab guard uses
  the Web Locks API and backups use Web Crypto for checksums; browsers
  offer both only in secure contexts. Over plain HTTP from another
  address, BrowserOS still runs, but without the single-tab guard, and
  new backups carry no checksum.
- Serve BrowserOS on an origin of its own (see the residual risk above).
- Use the response headers in `_headers` (below), or their equivalent on
  your host.

## Response headers

`_headers` (applied by Netlify, Cloudflare Pages, and `tools/serve.py`)
sends `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`
(other sites can't frame BrowserOS, which prevents clickjacking; the
same-origin case is handled by BrowserOS refusing to start inside
itself), `Referrer-Policy: strict-origin-when-cross-origin`, and a
`Permissions-Policy` that turns off the camera, microphone,
geolocation, payment, USB, serial, and Bluetooth APIs, none of which
BrowserOS uses. GitHub Pages doesn't support custom headers.

There is deliberately no `Content-Security-Policy`. Code Studio's
preview runs the user's own pages in sandboxed `srcdoc` frames, and such
frames inherit the policy of the page that creates them: a policy strict
enough to matter (no inline scripts) would stop ordinary HTML with inline
`<script>` blocks from running in the preview. A policy loose enough for
the preview would also have to allow frames from any site (the Browser),
`data:` and `blob:` URLs, and `fetch` to any site (downloads), which adds
little. BrowserOS instead relies on not executing untrusted content in
its own origin at all (see [Isolation boundaries](#isolation-boundaries)).
Anyone adding a policy should test every application, especially Code
Studio's preview and the Browser, before deploying it.

## Console access

Core services (`vfs`, `appManager`, `settingsService`, and others) are
available on `window` for the browser's developer console. That is only
a risk if untrusted script runs in BrowserOS's origin, which the
isolation above is designed to prevent. Anything typed into the console
runs with full access to BrowserOS data, like any site's console.

## Reporting a vulnerability

Please report suspected vulnerabilities privately to the repository
owner (for example through GitHub's private vulnerability reporting)
rather than in a public issue, with steps to reproduce and the browser
and version used.
