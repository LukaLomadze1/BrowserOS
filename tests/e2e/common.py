"""Shared helpers for BrowserOS end-to-end suites.

Every suite serves the site on a free local port and drives a fresh
Chromium profile through Playwright, so tests never see (or change)
anyone's real BrowserOS data.

The site is the repository itself, or the folder named by the
BROWSEROS_SITE_ROOT environment variable (for example the production
copy in dist/; `python tests/run_all.py --site dist` sets it). common.serve()
serves it the way static hosts do, with tools/serve.py: the headers from
_headers, strict content types, and 404.html for missing paths.
"""
import functools
import os
import socketserver
import sys
import threading
import traceback

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SITE_ROOT = os.path.abspath(os.path.join(REPO_ROOT, os.environ["BROWSEROS_SITE_ROOT"])) if os.environ.get("BROWSEROS_SITE_ROOT") else REPO_ROOT
OUTPUT_ROOT = os.path.join(REPO_ROOT, "tests", "e2e", "output")

sys.path.insert(0, os.path.join(REPO_ROOT, "tools"))
import serve as site_server  # noqa: E402  (tools/serve.py)


# The browser requests dozens of modules at once; the default listen
# backlog (5) makes Windows refuse some of those connections, which
# looks like a network failure inside BrowserOS.
socketserver.TCPServer.request_queue_size = 128


class QuietHandler(site_server.Handler):
    def log_message(self, *args):
        pass


def serve(root=SITE_ROOT):
    """Serve `root` like a static host on 127.0.0.1 at a free port; returns (server, base_url)."""
    socketserver.ThreadingTCPServer.allow_reuse_address = True
    handler = functools.partial(QuietHandler, directory=root, rules=site_server.read_headers(root))
    server = socketserver.ThreadingTCPServer(("127.0.0.1", 0), handler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_address[1]}"


def launch_options():
    """Browser launch options: bundled Chromium, or an installed channel via BROWSEROS_TEST_CHANNEL (e.g. "chrome")."""
    channel = os.environ.get("BROWSEROS_TEST_CHANNEL")
    return {"channel": channel} if channel else {}


def output_dir(name):
    path = os.path.join(OUTPUT_ROOT, name)
    os.makedirs(path, exist_ok=True)
    return path


class Report:
    """Collects check results and prints them as they happen."""

    def __init__(self):
        self.results = []
        self.errors = []

    def check(self, name, condition, detail=""):
        ok = bool(condition)
        self.results.append((name, ok))
        print(("PASS " if ok else "FAIL ") + name + (f"  [{detail}]" if not ok and detail != "" else ""), flush=True)
        return ok

    def section(self, fn, before=None):
        print(f"\n--- {fn.__name__}", flush=True)
        try:
            if before:
                before()
            fn()
        except Exception as exc:  # A crashed section is reported as a failure, not hidden.
            traceback.print_exc()
            self.check(f"{fn.__name__} completed without exception", False, str(exc)[:300])

    def watch_console(self, page, ignore=()):
        """Record BrowserOS console errors (sandboxed preview frames are the page under test, not BrowserOS)."""

        def on_console(message):
            if message.type != "error":
                return
            url = (message.location or {}).get("url", "")
            if url.startswith("about:srcdoc") or url.startswith("data:") or url.endswith("/favicon.ico"):
                return
            if any(fragment in message.text for fragment in ignore):
                return
            self.errors.append(f"{message.text} @ {url}")

        page.on("console", on_console)
        page.on("pageerror", lambda error: self.errors.append(f"pageerror: {error}"))

    def finish(self):
        passed = sum(1 for _, ok in self.results if ok)
        print(f"\n{passed}/{len(self.results)} passed")
        if self.errors:
            print("\n".join(self.errors[:30]))
        return 0 if passed == len(self.results) else 1


def boot(page, base_url, samples=False):
    """Open BrowserOS and wait for the desktop; on a first run, skip the Welcome tour."""
    page.goto(f"{base_url}/index.html")
    wait_desktop(page, samples=samples)


def wait_desktop(page, samples=False, timeout=20000):
    """Wait until start-up has finished, then skip the Welcome tour if it opened.

    The tour opens by itself only on a new installation (a fresh profile).
    `samples` decides whether its "Add sample files" box is checked when
    skipping; with True this waits until the sample files are written.
    """
    try:
        page.wait_for_selector("body[data-boot-state='ready']", timeout=timeout)
    except Exception:
        # Say where start-up stopped instead of only "timeout".
        state = page.evaluate(
            """() => ({ state: document.body?.dataset.bootState ?? null,
                        stage: document.querySelector('.boot-screen__status')?.textContent ?? null,
                        notice: document.querySelector('.system-screen')?.innerText ?? null })"""
        )
        raise AssertionError(f"BrowserOS did not start: {state}")
    dismiss_welcome(page, samples=samples)


def dismiss_welcome(page, samples=False):
    """Skip the Welcome tour if it is open, choosing whether to add the sample files."""
    welcome = page.locator(".window[data-window-id='app:welcome']")
    if not welcome.count():
        return
    box = welcome.locator("input[name='samples']")
    if box.count() and box.is_checked() != samples:
        box.set_checked(samples)
    welcome.locator(".welcome__skip").click()
    page.wait_for_selector(".window[data-window-id='app:welcome']", state="detached", timeout=5000)
    if samples:
        page.wait_for_function(
            "() => (JSON.parse(localStorage.getItem('browseros:sampleContent:manifest') || 'null')?.files?.length ?? 0) > 0",
            timeout=15000,
        )
    page.wait_for_timeout(150)


def close_all(page):
    """Dismiss dialogs and close every window, discarding unsaved Code Studio edits."""
    for _ in range(4):
        if not page.locator(".dialog--visible").count():
            break
        page.keyboard.press("Escape")
        page.wait_for_timeout(200)
    page.evaluate(
        """() => {
      for (const id of appManager.getWindowIds('code-studio')) {
        const app = appManager.getInstance(id);
        if (app && app._docs) for (const d of app._docs.values()) { d.savedText = d.editor.getValue(); d.dirty = false; }
      }
      for (const b of document.querySelectorAll('.window .window__control--close')) b.click();
    }"""
    )
    page.wait_for_timeout(600)
    for _ in range(3):
        if not page.locator(".dialog--visible").count():
            break
        page.keyboard.press("Escape")
        page.wait_for_timeout(200)


def dialog_button(page, label):
    """Click a button in the visible dialog by its exact accessible name."""
    page.locator(".dialog--visible").get_by_role("button", name=label, exact=True).first.click()
    page.wait_for_timeout(300)


def wait_for(page, expression, timeout=6000):
    try:
        page.wait_for_function(expression, timeout=timeout)
        return True
    except Exception:
        return False


def exit_with(report):
    sys.exit(report.finish())
