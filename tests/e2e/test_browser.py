"""End-to-end checks for the Browser: address parsing, tabs, embedding policy, bookmarks,
history, private tabs, and downloads into the file system (a second local server plays
the part of another site).

Usage:  python tests/e2e/test_browser.py
"""
import sys, threading, functools, http.server, socketserver, os, time, traceback, io, zipfile
from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import SITE_ROOT, output_dir, launch_options, wait_desktop  # noqa: E402

ROOT, SHOTS = SITE_ROOT, output_dir("browser")
PORT, XPORT = 0, 0
FIXTURES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures13")
os.makedirs(FIXTURES, exist_ok=True)

ZIP_BYTES = io.BytesIO()
with zipfile.ZipFile(ZIP_BYTES, "w") as archive:
    archive.writestr("hello.txt", "hello from the archive")
ZIP_BYTES = ZIP_BYTES.getvalue()
SLOW_CHUNKS, SLOW_CHUNK = 24, 16 * 1024

PAGE_A = """<!doctype html><html><head><title>Fixture Page A</title><link rel="icon" href="/__fx/icon.png"></head>
<body><h1>Page A</h1><a id="next" href="/__fx/b.html">to B</a>
<a id="dl" href="/__fx/report" download>report</a>
<a id="zip" href="/__fx/archive.zip">zip</a></body></html>"""
PAGE_B = "<!doctype html><html><head><title>Fixture Page B</title></head><body><h1>Page B</h1></body></html>"


class Fixtures(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, status, body, headers):
        self.send_response(status)
        for key, value in headers.items():
            self.send_header(key, value)
        if "Content-Length" not in headers and body is not None:
            self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?")[0]
        if not path.startswith("/__fx/"):
            return super().do_GET()
        name = path[len("/__fx/"):]
        if name == "a.html":
            return self._send(200, PAGE_A.encode(), {"Content-Type": "text/html; charset=utf-8"})
        if name == "b.html":
            return self._send(200, PAGE_B.encode(), {"Content-Type": "text/html; charset=utf-8"})
        if name == "report":
            return self._send(200, b"Quarterly numbers\n1,2,3\n", {"Content-Type": "text/plain", "Content-Disposition": 'attachment; filename="Quarterly Report.txt"'})
        if name == "utf8name":
            return self._send(200, b"data", {"Content-Type": "text/plain", "Content-Disposition": "attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.txt"})
        if name == "archive.zip":
            return self._send(200, ZIP_BYTES, {"Content-Type": "application/zip"})
        if name == "noext":
            return self._send(200, b"%PDF-1.4 fake", {"Content-Type": "application/pdf"})
        if name == "slow.bin":
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(SLOW_CHUNKS * SLOW_CHUNK))
            self.end_headers()
            try:
                for _ in range(SLOW_CHUNKS):
                    self.wfile.write(b"x" * SLOW_CHUNK)
                    self.wfile.flush()
                    time.sleep(0.12)
            except (ConnectionError, OSError):
                pass
            return
        if name == "chunked.txt":
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Connection", "close")
            self.end_headers()
            for i in range(5):
                self.wfile.write(f"line {i}\n".encode())
                self.wfile.flush()
                time.sleep(0.05)
            return
        if name == "huge.bin":
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(30 * 1024 * 1024))
            self.end_headers()
            try:
                self.wfile.write(b"x" * 1024)
            except (ConnectionError, OSError):
                pass
            return
        if name == "tool.exe":
            return self._send(200, b"MZ....", {"Content-Type": "application/octet-stream"})
        if name == "icon.png":
            return self._send(404, b"", {})
        return self._send(404, b"not found", {"Content-Type": "text/plain"})


class CrossOrigin(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/page.html":
            body, headers = b"<!doctype html><title>Other Site</title><h1>Other site</h1>", {"Content-Type": "text/html"}
        elif path == "/deny.html":
            body, headers = b"<!doctype html><title>Denied</title><h1>denied</h1>", {"Content-Type": "text/html", "X-Frame-Options": "DENY"}
        elif path == "/cors.txt":
            body, headers = b"cross origin text", {"Content-Type": "text/plain", "Access-Control-Allow-Origin": "*", "Access-Control-Expose-Headers": "Content-Disposition", "Content-Disposition": 'attachment; filename="from-cors.txt"'}
        elif path == "/nocors.txt":
            body, headers = b"no cors", {"Content-Type": "text/plain"}
        else:
            body, headers = b"nope", {"Content-Type": "text/plain"}
            self.send_response(404)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_response(200)
        for key, value in headers.items():
            self.send_header(key, value)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


socketserver.ThreadingTCPServer.allow_reuse_address = True
socketserver.ThreadingTCPServer.daemon_threads = True
httpd = socketserver.ThreadingTCPServer(("127.0.0.1", PORT), functools.partial(Fixtures, directory=ROOT))
PORT = httpd.server_address[1]
xhttpd = socketserver.ThreadingTCPServer(("127.0.0.1", XPORT), CrossOrigin)
XPORT = xhttpd.server_address[1]
threading.Thread(target=httpd.serve_forever, daemon=True).start()
threading.Thread(target=xhttpd.serve_forever, daemon=True).start()
URL = f"http://127.0.0.1:{PORT}/index.html"
FX = f"http://127.0.0.1:{PORT}/__fx"
XO = f"http://localhost:{XPORT}"

with open(os.path.join(FIXTURES, "bookmarks.html"), "w", encoding="utf-8") as f:
    f.write("""<!DOCTYPE NETSCAPE-Bookmark-file-1>
<TITLE>Bookmarks</TITLE><H1>Bookmarks</H1>
<DL><p>
  <DT><H3>Reading</H3>
  <DL><p>
    <DT><A HREF="https://developer.mozilla.org/" ADD_DATE="1700000000">MDN</A>
    <DT><A HREF="javascript:alert(1)">Bad</A>
  </DL><p>
  <DT><A HREF="https://example.org/">Example Org</A>
</DL><p>""")

results, errors = [], []


def check(name, cond, detail=""):
    results.append((name, bool(cond)))
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if not cond and detail != "" else ""), flush=True)


def section(fn):
    print(f"\n--- {fn.__name__}", flush=True)
    try:
        close_all(page)
        fn()
    except Exception as exc:
        traceback.print_exc()
        check(f"{fn.__name__} completed without exception", False, str(exc)[:300])


def attach(page, tag=""):
    page.on("console", lambda m: errors.append(f"{tag}{m.type}: {m.text}") if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(f"{tag}pageerror: {e}"))


def boot(page):
    page.goto(URL)
    wait_desktop(page)
    # Capture "open in your browser" requests instead of opening host tabs.
    page.evaluate("() => { window.__opened = []; window.open = (url) => { window.__opened.push(url); return null; }; }")


def close_all(page):
    for _ in range(4):
        if not page.locator(".dialog--visible").count():
            break
        page.keyboard.press("Escape")
        page.wait_for_timeout(200)
    page.evaluate("() => { for (const b of document.querySelectorAll('.window .window__control--close')) b.click(); }")
    page.wait_for_timeout(600)


def browser(page, options="{}"):
    page.evaluate(f"() => appManager.launch('browser', {options})")
    page.wait_for_selector(".browser__address")
    page.wait_for_timeout(400)
    return page.locator(".browser").last


def go(page, text):
    page.locator(".browser__address").last.fill(text)
    page.locator(".browser__address").last.press("Enter")
    page.wait_for_timeout(700)


def active_url(page):
    return page.evaluate("() => { const app = appManager.getInstance([...document.querySelectorAll('.window')].reverse().find(w => w.querySelector('.browser')).dataset.windowId); const t = app._session.active(); return app._session.current(t).url; }")


def app_eval(page, body):
    return page.evaluate("() => { const app = appManager.getInstance([...document.querySelectorAll('.window')].reverse().find(w => w.querySelector('.browser')).dataset.windowId); " + body + " }")


with sync_playwright() as p:
    b = p.chromium.launch(**launch_options())
    ctx = b.new_context(viewport={"width": 1400, "height": 900})
    ctx.grant_permissions(["clipboard-read", "clipboard-write"], origin=f"http://127.0.0.1:{PORT}")
    page = ctx.new_page()
    attach(page)
    boot(page)

    def registration():
        apps = page.evaluate("() => appManager.getRegisteredApps().map(a => a.id)")
        check("Browser and Downloads registered", "browser" in apps and "downloads" in apps)
        check("Browser desktop shortcut", page.evaluate("() => [...document.querySelectorAll('.desktop-icon')].filter(e => e.textContent.trim() === 'Browser').length") == 1)
        check("Browser pinned first by default", page.evaluate("() => settingsService.get('startMenu.pinnedApps')[0]") == "browser")
        page.click(".start-button"); page.wait_for_timeout(300)
        page.keyboard.type("download"); page.wait_for_timeout(400)
        check("Start Menu search finds Downloads", "Downloads" in page.inner_text(".start-menu"))
        page.keyboard.press("Escape"); page.wait_for_timeout(200)
        page.keyboard.press("Escape"); page.wait_for_timeout(200)
        check("downloads service running", page.evaluate("() => serviceManager.getStatus('downloads')") == "running")
        check("html files associated with Browser", page.evaluate("() => fileAssociations.getDefault('html')?.appId") == "browser")

    def url_parsing():
        r = page.evaluate("""async () => { const u = await import('./src/core/browser/urlUtils.js'); const p = (t, e = 'google') => u.parseAddressInput(t, { searchEngine: e });
          return { host: p('example.com'), full: p('https://example.com/a?b=1'), search: p('cats and dogs'), ddg: p('cats', 'duckduckgo'), bad: p('http://'),
                   js: p('javascript:alert(1)'), data: p('data:text/html,hi'), local: p('localhost:8080/x'), ip: p('192.168.1.5'), internal: p('browseros://history'),
                   unknownInternal: p('browseros://nope'), vfs: p('vfs:///Documents/a.html'), mail: p('mailto:a@b.com'), word: p('hello') }; }""")
        check("bare host becomes https", r["host"] == {"type": "url", "url": "https://example.com/"}, r["host"])
        check("full URL kept", r["full"]["url"] == "https://example.com/a?b=1")
        check("text becomes a search", r["search"]["type"] == "search" and r["search"]["url"] == "https://www.google.com/search?q=cats%20and%20dogs", r["search"])
        check("search engine is configurable", r["ddg"]["url"].startswith("https://duckduckgo.com/?q=cats"))
        check("invalid URL produces an error", r["bad"]["type"] == "error" and "valid" in r["bad"]["message"], r["bad"])
        check("javascript: and data: refused", r["js"]["type"] == "error" and r["data"]["type"] == "error")
        check("localhost and IPs use http", r["local"]["url"] == "http://localhost:8080/x" and r["ip"]["url"] == "http://192.168.1.5/", (r["local"], r["ip"]))
        check("browseros:// pages", r["internal"]["type"] == "internal" and r["unknownInternal"]["type"] == "error")
        check("vfs: addresses", r["vfs"] == {"type": "vfs", "url": "vfs:///Documents/a.html"}, r["vfs"])
        check("mailto handed to the host", r["mail"]["type"] == "external")
        check("single word is a search", r["word"]["type"] == "search")

    def navigation():
        browser(page)
        check("new window opens the start page", page.locator(".browser-start").count() == 1 and page.input_value(".browser__address") == "")
        go(page, f"{FX}/a.html")
        page.wait_for_selector(".browser-tab--active:not(.browser-tab--loading)")
        page.wait_for_timeout(500)
        check("same-origin page loads with its title", page.inner_text(".browser-tab--active .browser-tab__title") == "Fixture Page A", page.inner_text(".browser-tab--active .browser-tab__title"))
        check("window title follows the page", "Fixture Page A — Browser" in page.inner_text(".window:has(.browser) .window__title"))
        check("http page marked not secure", page.get_attribute(".browser__security", "data-security") == "insecure")
        frame = page.frame_locator(".browser__view:not([hidden]) iframe")
        frame.locator("#next").click()
        page.wait_for_timeout(900)
        check("in-page navigation on readable pages updates the address", active_url(page) == f"{FX}/b.html" and page.input_value(".browser__address") == f"{FX}/b.html", active_url(page))
        page.click(".browser [aria-label^='Back']"); page.wait_for_timeout(800)
        check("Back", active_url(page) == f"{FX}/a.html")
        page.click(".browser [aria-label^='Forward']"); page.wait_for_timeout(800)
        check("Forward", active_url(page) == f"{FX}/b.html")
        loads = page.evaluate("() => performance.getEntriesByType('resource').filter(r => r.name.includes('/__fx/b.html')).length")
        page.click(".browser [aria-label^='Reload']"); page.wait_for_timeout(800)
        loads2 = page.evaluate("() => performance.getEntriesByType('resource').filter(r => r.name.includes('/__fx/b.html')).length")
        check("Reload loads the page again", loads2 > loads, (loads, loads2))
        page.click(".browser [aria-label^='Home']"); page.wait_for_timeout(500)
        check("Home opens the start page by default", active_url(page) == "browseros://start")
        page.evaluate(f"() => settingsService.set('browser.homepage', '{FX}/b.html')")
        page.click(".browser [aria-label^='Home']"); page.wait_for_timeout(800)
        check("custom homepage", active_url(page) == f"{FX}/b.html")
        page.evaluate("() => settingsService.reset('browser.homepage')")
        go(page, "http://")
        check("invalid address shows an error page keeping the text", page.locator(".browser-notice__title", has_text="Can't open").count() == 1 and page.locator(".browser-notice__url", has_text="http://").count() == 1)
        go(page, "cats and dogs")
        check("search uses the configured engine", active_url(page).startswith("https://www.google.com/search?q=cats"), active_url(page))
        check("refusing site gets a notice, not a blank frame", page.locator(".browser-notice__title", has_text="google.com").count() == 1)
        page.evaluate("() => settingsService.set('browser.searchEngine', 'duckduckgo')")
        go(page, "weather")
        check("changing the engine changes searches", active_url(page).startswith("https://duckduckgo.com/?q=weather"))
        page.evaluate("() => settingsService.reset('browser.searchEngine')")
        page.screenshot(path=os.path.join(SHOTS, "blocked.png"))
        page.click(".browser-notice .browser-button--primary"); page.wait_for_timeout(200)
        check("Open in your browser hands the URL to the host", page.evaluate("() => window.__opened").pop().startswith("https://duckduckgo.com/"))
        close_all(page)

    def embedding():
        browser(page)
        go(page, f"{XO}/page.html")
        page.wait_for_timeout(1200)
        check("cross-origin page embedded in a sandboxed frame", page.locator(".browser__view:not([hidden]) iframe").count() == 1)
        sandbox = page.get_attribute(".browser__view:not([hidden]) iframe", "sandbox")
        check("sandbox forbids top navigation", "allow-top-navigation" not in sandbox and "allow-scripts" in sandbox, sandbox)
        check("unreadable page explains a possible blank result", page.locator(".browser__infobar:not([hidden])", has_text="stays blank").count() == 1)
        check("cross-origin title falls back to the host", page.inner_text(".browser-tab--active .browser-tab__title") == "localhost")
        page.click(".browser__security"); page.wait_for_timeout(300)
        check("page info explains sandboxing", "can't see the page's contents" in page.inner_text(".browser__popover"))
        page.locator(".browser__popover .browser-button", has_text="Always open this site in your browser").click(); page.wait_for_timeout(500)
        check("site choice: always open externally", page.locator(".browser-notice__title", has_text="opens in your browser").count() == 1)
        check("choice persisted", page.evaluate("async () => (await import('./src/core/browser/framePolicy.js')).framePolicy.getSiteChoice('http://localhost/')") == "external")
        page.locator(".browser-notice .browser-button", has_text="Show it here instead").click(); page.wait_for_timeout(1000)
        check("choice can be undone", page.locator(".browser__view:not([hidden]) iframe").count() == 1)
        go(page, "github.com")
        page.locator(".browser-notice .browser-button", has_text="Show here anyway").click(); page.wait_for_timeout(400)
        check("Show here anyway embeds a known-refusing site", page.locator(".browser__view:not([hidden]) iframe").count() == 1 and page.evaluate("async () => (await import('./src/core/browser/framePolicy.js')).framePolicy.getSiteChoice('https://github.com/')") == "embed")
        page.evaluate("async () => { const { framePolicy } = await import('./src/core/browser/framePolicy.js'); framePolicy.setSiteChoice('https://github.com/', null); }")
        page.evaluate("async () => { await vfs.createFile('/Documents/page.html', '<title>Local Page</title><h1>hi</h1><script>parent.__vfsxss = 1</script>'); const e = await vfs.getInfo('/Documents/page.html'); await (await import('./src/core/vfs/vfsOpener.js')).openVfsEntry(e, { appManager }); }")
        page.wait_for_timeout(900)
        check("HTML file from the VFS opens in the Browser", page.locator(".browser-tab--active", has_text="Local Page").count() >= 1)
        check("VFS HTML runs no scripts", page.evaluate("() => window.__vfsxss === undefined") and page.locator(".browser").last.locator(".browser__view:not([hidden]) iframe").get_attribute("sandbox") == "")
        close_all(page)

    def tabs():
        browser(page)
        page.locator(".browser__address").focus()
        page.keyboard.press("Alt+t"); page.wait_for_timeout(300)
        page.keyboard.press("Alt+t"); page.wait_for_timeout(300)
        check("Alt+T opens tabs", page.locator(".browser-tab").count() == 3)
        go(page, f"{FX}/a.html")
        page.keyboard.press("Control+l")
        check("Ctrl+L focuses the address bar", page.evaluate("() => document.activeElement.classList.contains('browser__address')"))
        page.keyboard.press("Alt+w"); page.wait_for_timeout(300)
        check("Alt+W closes the tab", page.locator(".browser-tab").count() == 2)
        page.locator(".browser__address").focus()
        page.keyboard.press("Alt+Shift+t"); page.wait_for_timeout(800)
        check("Alt+Shift+T reopens with its history", page.locator(".browser-tab").count() == 3 and active_url(page) == f"{FX}/a.html" and not page.locator(".browser [aria-label^='Back']").is_disabled())
        before = app_eval(page, "return app._session.activeId;")
        page.locator(".browser__address").focus()
        page.keyboard.press("Alt+PageDown"); page.wait_for_timeout(300)
        check("Alt+PageDown switches tab", app_eval(page, "return app._session.activeId;") != before)
        page.locator(".browser-tab").first.click(button="right"); page.wait_for_selector(".context-menu--visible")
        page.locator(".context-menu--visible .context-menu__item", has_text="Duplicate").click(); page.wait_for_timeout(400)
        check("duplicate tab", page.locator(".browser-tab").count() == 4)
        page.locator(".browser-tab").first.click(button="middle"); page.wait_for_timeout(300)
        check("middle-click closes a tab", page.locator(".browser-tab").count() == 3)
        for i in range(8):
            app_eval(page, f"app._openInNewTab('{FX}/b.html?{i}'); return true;")
            page.wait_for_timeout(250)
        page.wait_for_timeout(600)
        live = app_eval(page, "return app._views.size;")
        discarded = app_eval(page, "return app._session.tabs.filter(t => t.state === 'discarded').length;")
        check("background tabs beyond the limit are unloaded", live <= 6 and discarded >= 5, (live, discarded))
        check("many tabs overflow into a scrollable strip", page.evaluate("() => { const s = document.querySelector('.browser__tabs'); return s.scrollWidth > s.clientWidth; }"))
        page.locator(".browser-tab--discarded", has_text="Fixture Page B").first.click(); page.wait_for_timeout(800)
        check("an unloaded tab reloads when shown", app_eval(page, "return app._session.active().state;") == "page" and page.locator(".browser__view:not([hidden]) iframe").count() == 1)
        page.screenshot(path=os.path.join(SHOTS, "tabs.png"))
        n = page.locator(".browser-tab").count()
        for _ in range(n):
            page.locator(".browser-tab__close").first.click(); page.wait_for_timeout(120)
        page.wait_for_timeout(600)
        check("closing the last tab closes the window", page.locator(".window:has(.browser)").count() == 0)

    def bookmarks():
        page.evaluate("async () => { await bookmarkService.ready(); for (const b of bookmarkService.getBarItems()) await bookmarkService.remove(b.id); }")
        browser(page)
        go(page, f"{FX}/a.html")
        page.wait_for_timeout(500)
        page.locator(".browser__address").focus()
        page.keyboard.press("Control+d"); page.wait_for_timeout(500)
        check("Ctrl+D bookmarks the page", page.locator(".browser__popover", has_text="Bookmark added").count() == 1)
        page.fill(".browser__popover input", "My Fixture")
        page.click(".browser__popover .browser-button--primary"); page.wait_for_timeout(500)
        check("star shows bookmarked state", page.get_attribute(".browser__star", "aria-pressed") == "true")
        check("bookmarks bar shows it", page.locator(".browser__bar-item", has_text="My Fixture").count() == 1)
        stored = page.evaluate("async () => JSON.parse(await vfs.read('/Documents/Browser/bookmarks.json'))")
        check("bookmarks stored in the VFS", stored["format"] == "browseros-bookmarks" and "My Fixture" in str(stored))
        dup = page.evaluate(f"async () => (await bookmarkService.add({{ url: '{FX}/a.html', title: 'again' }})).duplicate")
        check("duplicate bookmark detected", dup is True)
        bad = page.evaluate("async () => { try { await bookmarkService.add({ url: 'javascript:alert(1)' }); return 'added'; } catch (e) { return e.message; } }")
        check("malformed URLs rejected", "can be bookmarked" in bad, bad)
        go(page, "browseros://bookmarks")
        page.locator(".browser-page .browser-button", has_text="New folder").click()
        page.fill(".dialog--visible input", "Work"); page.click(".dialog--visible .dialog__button--primary"); page.wait_for_timeout(500)
        check("create folder", page.evaluate("() => bookmarkService.getFolders().some(f => f.title === 'Work')"))
        page.locator(".browser-page .browser-button", has_text="Add bookmark").click()
        page.fill(".dialog--visible input >> nth=1", "not a url at all")
        page.click(".dialog--visible .dialog__button--primary"); page.wait_for_timeout(300)
        check("invalid address explained in the dialog", page.locator(".dialog--visible .dialog__error").inner_text() != "")
        page.fill(".dialog--visible input >> nth=0", "Second")
        page.fill(".dialog--visible input >> nth=1", "example.net")
        page.click(".dialog--visible .dialog__button--primary"); page.wait_for_timeout(500)
        work_id = page.evaluate("() => bookmarkService.getFolders().find(f => f.title === 'Work').id")
        bar = lambda: page.evaluate("() => bookmarkService.getBarItems().map(i => i.title)")
        check("bookmark added to the folder that is open", page.evaluate(f"() => bookmarkService.getChildren('{work_id}').map(i => i.title)") == ["Second"], bar())
        page.evaluate(f"async () => bookmarkService.move('{work_id}', {{ parentId: 'bar', index: 0 }})")
        check("reorder", bar() == ["Work", "My Fixture"], bar())
        page.evaluate(f"async () => {{ const s = bookmarkService.getChildren('{work_id}')[0]; await bookmarkService.move(s.id, {{ parentId: 'other' }}); }}")
        check("move between folders", page.evaluate(f"() => bookmarkService.getChildren('{work_id}').length") == 0 and "Second" in page.evaluate("() => bookmarkService.getChildren('other').map(i => i.title)"))
        page.evaluate(f"async () => {{ const s = bookmarkService.getChildren('other').find(i => i.title === 'Second'); await bookmarkService.move(s.id, {{ parentId: '{work_id}' }}); }}")
        cyc = page.evaluate(f"async () => {{ try {{ await bookmarkService.move('{work_id}', {{ parentId: '{work_id}' }}); return 'moved'; }} catch (e) {{ return e.message; }} }}")
        check("folder can't move into itself", "itself" in cyc, cyc)
        page.fill(".browser-page__search", "second"); page.wait_for_timeout(300)
        check("search bookmarks", page.locator(".browser-page .browser-row", has_text="Second").count() == 1)
        page.fill(".browser-page__search", "")
        page.locator(".browser-page .browser-button", has_text="Export").click(); page.wait_for_timeout(700)
        exported = page.evaluate("async () => (await vfs.list('/Downloads')).map(e => e.name).filter(n => n.startsWith('bookmarks-'))")
        check("export writes a bookmarks HTML file to /Downloads", len(exported) == 1, exported)
        html = page.evaluate(f"async () => vfs.read('/Downloads/{exported[0]}')") if exported else ""
        check("export uses the standard bookmarks format", html.startswith("<!DOCTYPE NETSCAPE-Bookmark-file-1>") and "My Fixture" in html)
        page.locator(".browser-page .browser-hidden-input").set_input_files(os.path.join(FIXTURES, "bookmarks.html"))
        page.wait_for_timeout(800)
        check("import standard bookmarks file, skipping invalid entries", "Imported 2 bookmarks; 1 invalid entry was skipped" in page.inner_text(".browser-page"), page.inner_text(".browser-page__note"))
        check("imported folders kept", page.evaluate("() => bookmarkService.getFolders().some(f => f.title === 'Reading')"))
        page.screenshot(path=os.path.join(SHOTS, "bookmarks.png"))
        page.evaluate(f"async () => {{ const w = bookmarkService.getFolders().find(f => f.title === 'Work'); }}")
        page.locator(".browser-bookmarks__folder", has_text="Bookmarks bar").click(); page.wait_for_timeout(200)
        page.locator(".browser-page .browser-row", has_text="Work").locator(".browser-icon-button").click()
        page.locator(".context-menu--visible .context-menu__item", has_text="Delete").click(); page.wait_for_timeout(300)
        check("deleting a non-empty folder asks first", page.locator(".dialog--visible", has_text="Delete").count() == 1)
        page.click(".dialog--visible .dialog__button--danger, .dialog--visible .dialog__button--primary"); page.wait_for_timeout(500)
        check("folder deleted", not page.evaluate("() => bookmarkService.getFolders().some(f => f.title === 'Work')"))
        close_all(page)
        boot(page)
        page.evaluate("async () => bookmarkService.ready()")
        check("bookmarks survive reload", page.evaluate("() => bookmarkService.getBarItems().some(i => i.title === 'My Fixture')"))
        page.evaluate("async () => vfs.write('/Documents/Browser/bookmarks.json', '{ broken')")
        page.wait_for_timeout(600)
        err = page.evaluate("() => bookmarkService.getLoadError()")
        files = page.evaluate("async () => (await vfs.list('/Documents/Browser')).map(e => e.name)")
        check("unreadable bookmarks file kept aside", err and any("unreadable" in f for f in files), (err, files))

    def history():
        page.evaluate("() => historyService.clear()")
        browser(page)
        go(page, f"{FX}/a.html"); page.wait_for_timeout(600)
        go(page, f"{FX}/b.html"); page.wait_for_timeout(600)
        go(page, f"{FX}/a.html"); page.wait_for_timeout(600)
        rec = page.evaluate(f"() => historyService.get('{FX}/a.html')")
        check("visits recorded with the page title", rec and rec["title"] == "Fixture Page A", rec)
        check("repeat visits within 30 s don't multiply records", rec and rec["visitCount"] == 1 and len(rec["visits"]) == 1, rec)
        go(page, "browseros://history")
        check("history page groups by day", page.locator(".browser-page__group-title", has_text="Today").count() == 1)
        check("history lists visits", page.locator(".browser-page .browser-row").count() == 2)
        page.fill(".browser-page__search", "Page B"); page.wait_for_timeout(300)
        check("search history", page.locator(".browser-page .browser-row").count() == 1)
        page.fill(".browser-page__search", "")
        page.locator(".browser-page .browser-row", has_text="Page B").locator(".browser-icon-button").click(); page.wait_for_timeout(300)
        check("remove an entry", page.evaluate(f"() => historyService.get('{FX}/b.html')") is None)
        check("internal pages aren't recorded", page.evaluate("() => historyService.get('browseros://history')") is None)
        page.locator(".browser-page .browser-button", has_text="Clear browsing data").click()
        page.select_option(".dialog--visible select", "hour"); page.click(".dialog--visible .dialog__button--primary"); page.wait_for_timeout(400)
        check("clear the last hour", page.evaluate("() => historyService.size()") == 0)
        close_all(page)
        browser(page, "{ private: true }")
        check("private window clearly marked", page.locator(".browser--private .browser__private-badge").count() == 1 and "Private" in page.inner_text(".window:has(.browser) .window__title"))
        check("private start page explains the limits", "isn't anonymity" in page.inner_text(".browser-start__private"))
        go(page, f"{FX}/a.html"); page.wait_for_timeout(700)
        check("private browsing writes no history", page.evaluate("() => historyService.size()") == 0)
        close_all(page)
        # A separate context: the running page saves its own history on unload.
        hctx = b.new_context(viewport={"width": 1400, "height": 900})
        hp = hctx.new_page()
        attach(hp, "[history] ")
        hp.add_init_script("""(() => { const day = 86400000; localStorage.setItem('browseros:browser:history', JSON.stringify([
            { url: 'https://old.example/', title: 'Old', visitCount: 3, firstVisit: Date.now() - 400 * day, lastVisit: Date.now() - 200 * day, visits: [Date.now() - 200 * day] },
            { url: 'https://new.example/', title: 'New', visitCount: 1, firstVisit: Date.now(), lastVisit: Date.now(), visits: [Date.now()] },
            { url: 'javascript:bad', title: 'x', lastVisit: Date.now() }, 'garbage'])); })()""")
        boot(hp)
        urls = hp.evaluate("() => historyService.getRecent(10).map(r => r.url)")
        check("history retention and validation on load", urls == ["https://new.example/"], urls)
        hctx.close()

    def start_page():
        page.evaluate("() => historyService.clear()")
        page.evaluate("async () => { await bookmarkService.ready(); await bookmarkService.add({ url: 'https://example.com/fixture', title: 'My Fixture' }); }")
        browser(page)
        check("empty sections explain themselves", "Pages you visit often appear here." in page.inner_text(".browser-start"))
        page.locator(".browser-start__tile--add").click()
        page.fill(".dialog--visible input >> nth=0", "Site One")
        page.fill(".dialog--visible input >> nth=1", "one.example")
        page.click(".dialog--visible .dialog__button--primary"); page.wait_for_timeout(300)
        page.locator(".browser-start__tile--add").click()
        page.fill(".dialog--visible input >> nth=1", "two.example")
        page.click(".dialog--visible .dialog__button--primary"); page.wait_for_timeout(300)
        titles = lambda: page.evaluate("() => [...document.querySelectorAll('.browser-start__tiles')][0].innerText")
        check("add shortcuts", "Site One" in titles() and "two.example" in titles(), titles())
        page.locator(".browser-start__tile-wrap", has_text="two.example").locator(".browser-start__tile-menu").click()
        page.locator(".context-menu--visible .context-menu__item", has_text="Move left").click(); page.wait_for_timeout(300)
        check("reorder shortcuts", page.evaluate("async () => (await import('./src/core/browser/shortcutService.js')).shortcutService.list().map(s => s.title)") == ["two.example", "Site One"])
        page.locator(".browser-start__tile-wrap", has_text="Site One").locator(".browser-start__tile-menu").click()
        page.locator(".context-menu--visible .context-menu__item", has_text="Edit").click()
        page.fill(".dialog--visible input >> nth=0", "Renamed"); page.click(".dialog--visible .dialog__button--primary"); page.wait_for_timeout(300)
        check("rename shortcut", "Renamed" in titles())
        page.locator(".browser-start__tile-wrap", has_text="Renamed").locator(".browser-start__tile-menu").click()
        page.locator(".context-menu--visible .context-menu__item", has_text="Remove").click(); page.wait_for_timeout(300)
        check("remove shortcut", "Renamed" not in titles())
        go(page, f"{FX}/a.html"); page.wait_for_timeout(600)
        page.click(".browser [aria-label^='Home']"); page.wait_for_timeout(500)
        check("frequently visited comes from real history", page.locator(".browser-start__section", has_text="Frequently visited").locator(".browser-start__tile", has_text="Fixture Page A").count() == 1)
        check("bookmarks shown", page.locator(".browser-start__section", has_text="Bookmarks").locator(".browser-start__tile", has_text="My Fixture").count() == 1)
        page.evaluate("() => settingsService.set('browser.startPageClock', false)"); page.wait_for_timeout(200)
        check("clock can be hidden", page.locator(".browser-start__clock").is_hidden())
        page.evaluate("() => settingsService.set('browser.startPageBackground', 'wallpaper')"); page.wait_for_timeout(200)
        check("wallpaper background uses the desktop preset", page.get_attribute(".browser-start__wallpaper", "data-wallpaper-preview") == page.evaluate("() => settingsService.get('wallpaper.preset')") and page.locator(".browser-start__wallpaper").is_visible())
        page.evaluate("() => settingsService.resetCategory('browser')")
        page.fill(".browser-start__search-input", "browseros://bookmarks"); page.keyboard.press("Enter"); page.wait_for_timeout(500)
        check("start page search box navigates", active_url(page) == "browseros://bookmarks")
        close_all(page)

    def downloads():
        page.evaluate("() => { downloadService.clearFinished(); notificationService.clearHistory(); }")
        page.evaluate("async () => { for (const e of await vfs.list('/Downloads')) await vfs.delete(e.path); }")
        browser(page)
        go(page, f"{FX}/a.html"); page.wait_for_timeout(700)
        page.frame_locator(".browser__view:not([hidden]) iframe").locator("#dl").click()
        page.wait_for_timeout(1200)
        d = page.evaluate("() => downloadService.getDownloads()[0]")
        check("download link in a page goes to the Download Manager", d and d["status"] == "completed", d)
        check("Content-Disposition filename used", d and d["path"] == "/Downloads/Quarterly Report.txt", d and d["path"])
        check("file content written to the VFS", page.evaluate("async () => vfs.read('/Downloads/Quarterly Report.txt')") == "Quarterly numbers\n1,2,3\n")
        check("downloads panel opens in the Browser", page.locator(".browser__popover", has_text="Recent downloads").count() == 1)
        check("completion notification", page.evaluate("() => notificationService.getNotifications().some(n => n.title.includes('Quarterly Report.txt') && n.action?.path === '/Downloads/Quarterly Report.txt')"))
        page.frame_locator(".browser__view:not([hidden]) iframe").locator("#dl").click(); page.wait_for_timeout(1200)
        check("duplicate names get a number", page.evaluate("async () => vfs.exists('/Downloads/Quarterly Report (2).txt')"))
        page.frame_locator(".browser__view:not([hidden]) iframe").locator("#zip").click(); page.wait_for_timeout(1200)
        z = page.evaluate("async () => { const b = await vfs.readBinary('/Downloads/archive.zip'); return [b.size, b.type]; }")
        check("archive links download as binary files", z[0] > 50 and z[1] == "application/zip", z)
        go(page, f"{FX}/archive.zip"); page.wait_for_timeout(1200)
        check("navigating to an archive downloads it instead", page.evaluate("async () => vfs.exists('/Downloads/archive (2).zip')") and active_url(page) == f"{FX}/a.html")
        run = lambda url: page.evaluate(f"() => downloadService.download('{url}')")
        state = lambda i: page.evaluate(f"() => downloadService.getDownload('{i}')")
        slow = run(f"{FX}/slow.bin"); page.wait_for_timeout(1300)
        s = state(slow)
        check("progress tracked from real bytes", s["status"] == "downloading" and s["totalBytes"] == SLOW_CHUNKS * SLOW_CHUNK and 0 < s["receivedBytes"] < s["totalBytes"], s)
        check("speed measured", s["speed"] and s["speed"] > 0, s["speed"])
        page.evaluate("() => appManager.launch('downloads')"); page.wait_for_timeout(500)
        row = page.locator(f".downloads-app [data-download-id='{slow}']")
        check("determinate progress bar when size is known", row.locator(".download-item__progress[aria-valuenow]").count() == 1 and " of " in row.locator(".download-item__status").inner_text())
        page.screenshot(path=os.path.join(SHOTS, "downloading.png"))
        row.locator("button", has_text="Cancel").click(); page.wait_for_timeout(400)
        check("cancel", state(slow)["status"] == "cancelled")
        row.locator("button", has_text="Retry").click(); page.wait_for_timeout(4200)
        check("retry completes", state(slow)["status"] == "completed" and page.evaluate("async () => (await vfs.readBinary('/Downloads/slow.bin')).size") == SLOW_CHUNKS * SLOW_CHUNK)
        ch = run(f"{FX}/chunked.txt"); page.wait_for_timeout(1200)
        c = state(ch)
        check("missing Content-Length handled", c["status"] == "completed" and c["totalBytes"] == c["receivedBytes"] > 0, c)
        nx = run(f"{FX}/noext"); page.wait_for_timeout(800)
        check("missing extension derived from the content type", state(nx)["path"] == "/Downloads/noext.pdf", state(nx)["path"])
        u8 = run(f"{FX}/utf8name"); page.wait_for_timeout(800)
        check("RFC 5987 filename*= decoded", state(u8)["path"] == "/Downloads/résumé.txt", state(u8)["path"])
        nf = run(f"{FX}/missing.bin"); page.wait_for_timeout(800)
        check("HTTP errors reported", state(nf)["status"] == "failed" and state(nf)["errorKind"] == "http" and "404" in state(nf)["error"], state(nf))
        nc = run(f"{XO}/nocors.txt"); page.wait_for_timeout(800)
        check("CORS-blocked downloads fail with an explanation", state(nc)["status"] == "failed" and "cross-origin" in state(nc)["error"], state(nc))
        check("blocked downloads offer the host browser", page.locator(f".downloads-app [data-download-id='{nc}'] button", has_text="Download with your browser").count() == 1)
        co = run(f"{XO}/cors.txt"); page.wait_for_timeout(800)
        check("CORS-enabled cross-origin download, exposed filename", state(co)["path"] == "/Downloads/from-cors.txt", state(co))
        page.evaluate("() => settingsService.set('downloads.maxSizeMb', 25)")
        hg = run(f"{FX}/huge.bin"); page.wait_for_timeout(800)
        check("too-large files refused before saving", state(hg)["errorKind"] == "too-large", state(hg))
        page.evaluate("() => settingsService.reset('downloads.maxSizeMb')")
        ex = run(f"{FX}/tool.exe"); page.wait_for_timeout(800)
        check("unsupported types refused clearly", state(ex)["errorKind"] == "unsupported-type", state(ex))
        check("failure notifications", page.evaluate("() => notificationService.getNotifications().filter(n => n.source === 'downloads' && n.type === 'error').length") >= 4)
        page.click(".downloads-app__filter[data-filter='failed']"); page.wait_for_timeout(200)
        check("filter failed", page.locator(".downloads-app .download-item").count() == 4)
        page.click(".downloads-app__filter[data-filter='all']"); page.wait_for_timeout(200)
        page.fill(".downloads-app__url", f"{FX}/report")
        page.click(".downloads-app__button--primary"); page.wait_for_timeout(900)
        check("download from an address in the Download Manager", page.evaluate("async () => vfs.exists('/Downloads/Quarterly Report (3).txt')"))
        page.locator(".downloads-app [data-download-id]", has_text="from-cors.txt").locator("button", has_text="Open").click(); page.wait_for_timeout(800)
        check("Open uses the file's default app", page.locator(".window:has(.notes)").count() == 1)
        total = len(page.evaluate("() => downloadService.getDownloads()"))
        page.evaluate("() => appManager.focusWindow('app:downloads')"); page.wait_for_timeout(300)
        page.click(".downloads-app__button:has-text('Clear finished')"); page.wait_for_timeout(300)
        check("clear finished", len(page.evaluate("() => downloadService.getDownloads()")) == 0 and total > 0)
        close_all(page)
        page.evaluate(f"() => downloadService.download('{FX}/report')"); page.wait_for_timeout(800)
        app_ids = page.evaluate(f"() => downloadService.download('{FX}/slow.bin')")
        page.wait_for_timeout(300)
        boot(page)
        hist = page.evaluate("() => downloadService.getDownloads().map(d => d.status)")
        check("download list survives reload; unfinished marked interrupted", "completed" in hist and "interrupted" in hist, hist)
        browser(page, "{ private: true }")
        page.evaluate(f"() => {{ const app = appManager.getInstance([...document.querySelectorAll('.window')].reverse().find(w => w.querySelector('.browser')).dataset.windowId); app._startDownload('{FX}/utf8name', null); }}")
        page.wait_for_timeout(900)
        check("private download saved but flagged", page.evaluate("() => downloadService.getDownloads()[0].private") is True)
        close_all(page)
        boot(page)
        check("private downloads aren't remembered", not any(d for d in page.evaluate("() => downloadService.getDownloads().map(d => d.private)")))
        page.evaluate("() => appManager.launch('file-explorer', { path: '/Downloads' })"); page.wait_for_timeout(700)
        check("File Explorer shows the downloaded files", page.locator(".explorer__row", has_text="Quarterly Report.txt").count() == 1)
        page.locator(".explorer__folder-banner-button").click(); page.wait_for_timeout(600)
        check("/Downloads links to the Download Manager", page.locator(".window:has(.downloads-app)").count() == 1)
        close_all(page)
        page.evaluate("() => appManager.launch('terminal')"); page.wait_for_selector(".terminal__input")
        page.locator(".terminal__input").last.fill(f"download {XO}/cors.txt"); page.locator(".terminal__input").last.press("Enter"); page.wait_for_timeout(900)
        check("Terminal download command", page.evaluate("async () => vfs.exists('/Downloads/from-cors (2).txt')"))
        close_all(page)

    def settings_page():
        page.evaluate("() => appManager.launch('settings', { page: 'browser' })"); page.wait_for_timeout(800)
        check("Browser settings page", page.locator(".settings-page__title").first.inner_text() == "Browser")
        page.select_option(".settings-app select >> nth=0", "bing"); page.wait_for_timeout(200)
        check("search engine setting", page.evaluate("() => settingsService.get('browser.searchEngine')") == "bing")
        page.fill(".settings-text-input", "not a url with spaces"); page.locator(".settings-inline-form button", has_text="Save").click(); page.wait_for_timeout(200)
        check("homepage validation", page.evaluate("() => settingsService.get('browser.homepage')") == "")
        page.fill(".settings-text-input", "example.com/home"); page.locator(".settings-inline-form button", has_text="Save").click(); page.wait_for_timeout(200)
        check("homepage saved", page.evaluate("() => settingsService.get('browser.homepage')") == "https://example.com/home")
        page.locator(".settings-inline-form button", has_text="Use start page").click(); page.wait_for_timeout(200)
        check("restore default homepage", page.evaluate("() => settingsService.get('browser.homepage')") == "")
        page.evaluate("async () => { const { framePolicy } = await import('./src/core/browser/framePolicy.js'); framePolicy.setSiteChoice('https://news.example/', 'external'); }")
        page.wait_for_timeout(200)
        check("site choices listed", "news.example" in page.inner_text(".settings-app"))
        page.locator(".settings-app button[aria-label='Forget the choice for news.example']").click(); page.wait_for_timeout(200)
        check("site choice removable", "news.example" not in page.inner_text(".settings-app"))
        page.evaluate("() => settingsService.set('browser.showBookmarksBar', false)")
        browser(page)
        check("bookmarks bar setting applies", page.locator(".browser__bookmarks-bar").last.is_hidden())
        page.evaluate("() => settingsService.resetCategory('browser')")
        refs = page.evaluate("async () => (await import('./src/core/keyboard/keyboardShortcuts.js')).keyboardShortcuts.getGroupedShortcuts().flatMap(g => g.shortcuts).map(s => s.id)")
        check("Browser shortcuts in the Settings reference", all(i in refs for i in ("browser.newTab", "browser.closeTab", "browser.focusAddress", "browser.reload", "browser.downloads")))
        close_all(page)

    def lifecycle():
        count = lambda: page.evaluate("async () => (await import('./src/core/eventBus.js')).eventBus.getListenerCount()")
        close_all(page)
        base = count()
        for _ in range(3):
            browser(page)
            go(page, f"{FX}/a.html")
            go(page, "browseros://history")
            app_eval(page, "app._toggleSidebar(); return true;")
            browser(page, "{ private: true }")
            page.evaluate("() => appManager.launch('downloads')"); page.wait_for_timeout(300)
            close_all(page)
        check("no listener leaks across Browser and Downloads windows", count() == base, (base, count()))
        browser(page); browser(page)
        apps = page.evaluate("() => appManager.getRunningApplications().filter(a => a.appId === 'browser').map(a => a.windows.length)")
        check("two Browser windows are one application", apps == [2], apps)
        a1 = page.evaluate("() => [...document.querySelectorAll('.window')].filter(w => w.querySelector('.browser')).length")
        check("each window has its own tabs", a1 == 2 and page.locator(".browser").first.locator(".browser-tab").count() == 1)
        close_all(page)

    for fn in (registration, url_parsing, navigation, embedding, tabs, bookmarks, history, start_page, downloads, settings_page, lifecycle):
        section(fn)

    real = [e for e in errors if "404" not in e and "favicon" not in e and "ERR_FAILED" not in e and "CORS" not in e and "Access-Control" not in e and "Failed to fetch" not in e and "net::" not in e
            # Expected: a site refusing to be framed, and the sandbox blocking scripts in a VFS page.
            and "Content Security Policy" not in e and "X-Frame-Options" not in e and "Blocked script execution in 'about:srcdoc'" not in e]
    check("no unexpected console errors", not real, real[:6])
    b.close()

httpd.shutdown()
xhttpd.shutdown()
failed = [r for r in results if not r[1]]
print(f"\n{len(results) - len(failed)}/{len(results)} passed")
for name, ok in results:
    if not ok:
        print("  FAILED:", name)
sys.exit(1 if failed else 0)
