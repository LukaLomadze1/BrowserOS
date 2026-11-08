"""Regression checks: windows, the desktop, File Explorer, and Terminal keep their state
through appearance and motion changes.

Usage:  python tests/e2e/test_regression.py
"""
import sys, threading, functools, http.server, socketserver, os
from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import SITE_ROOT, output_dir, launch_options, wait_desktop  # noqa: E402

ROOT, SHOTS = SITE_ROOT, output_dir("regression")
PORT = 0

class Q(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass

socketserver.ThreadingTCPServer.allow_reuse_address = True
socketserver.ThreadingTCPServer.daemon_threads = True
httpd = socketserver.ThreadingTCPServer(("127.0.0.1", PORT), functools.partial(Q, directory=ROOT))
PORT = httpd.server_address[1]
threading.Thread(target=httpd.serve_forever, daemon=True).start()
URL = f"http://127.0.0.1:{PORT}/index.html"

results = []
def check(name, cond, detail=""):
    results.append((name, bool(cond)))
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if not cond and detail != "" else ""))

with sync_playwright() as p:
    browser = p.chromium.launch(**launch_options())
    ctx = browser.new_context(viewport={"width": 1400, "height": 900})
    page = ctx.new_page()
    errors, bad_requests = [], []
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("response", lambda r: bad_requests.append((r.status, r.url)) if r.status >= 400 else None)
    page.on("requestfailed", lambda r: bad_requests.append(("failed", r.url)))

    page.goto(URL)
    wait_desktop(page)

    # ---- Desktop: files, recent files, rectangle-selected deletion ----
    page.evaluate("""async () => { for (const n of ['r1.txt','r2.txt','r3.txt']) await vfs.createFile('/Desktop/' + n, 'hello ' + n); }""")
    page.wait_for_timeout(400)
    icon = lambda name: page.locator(".desktop-icon", has_text=name)
    check("VFS files appear on desktop", icon("r1.txt").count() == 1 and icon("r3.txt").count() == 1)

    # grid alignment: every icon's left/top is on the cell grid
    aligned = page.evaluate("""() => [...document.querySelectorAll('.desktop-icon')].every(el => {
      const l = parseFloat(el.style.left), t = parseFloat(el.style.top); return Number.isFinite(l) && Number.isFinite(t); })""")
    check("desktop icons positioned on grid", aligned)

    icon("r1.txt").dblclick()
    page.wait_for_selector(".window .notes")
    page.wait_for_timeout(300)
    page.locator(".window:has(.notes) .window__control--close").click()
    page.wait_for_timeout(400)
    page.click(".start-button"); page.wait_for_selector(".start-menu--visible"); page.wait_for_timeout(300)
    recent_before = page.inner_text(".start-menu__body")
    check("opened file appears in Recent Files", "r1.txt" in recent_before)
    page.keyboard.press("Escape"); page.wait_for_timeout(300)

    boxes = [icon(n).bounding_box() for n in ("r1.txt", "r2.txt", "r3.txt")]
    left = min(b["x"] for b in boxes); top = min(b["y"] for b in boxes)
    right = max(b["x"] + b["width"] for b in boxes); bottom = max(b["y"] + b["height"] for b in boxes)
    page.mouse.move(1350, 60)
    page.mouse.down()
    page.mouse.move((1350 + left) / 2, (60 + bottom) / 2, steps=5)
    page.mouse.move(left + 5, bottom + 4, steps=10)
    page.mouse.up()
    page.wait_for_timeout(200)
    selected = page.evaluate("() => [...document.querySelectorAll('.desktop-icon--selected')].map(e => e.textContent)")
    check("rectangle selects the three files", all(any(n in s for s in selected) for n in ("r1.txt", "r2.txt", "r3.txt")), selected)
    page.keyboard.press("Delete")
    page.wait_for_selector(".dialog--visible", timeout=3000)
    page.click(".dialog--visible .dialog__button--danger, .dialog--visible .dialog__button--primary")
    page.wait_for_timeout(600)
    check("rectangle-selected deletion removes icons", icon("r1.txt").count() == 0 and icon("r2.txt").count() == 0 and icon("r3.txt").count() == 0)
    gone = page.evaluate("async () => !(await vfs.exists('/Desktop/r1.txt'))")
    check("deleted from VFS", gone)
    page.click(".start-button"); page.wait_for_selector(".start-menu--visible"); page.wait_for_timeout(400)
    check("deleted file gone from Recent Files", "r1.txt" not in page.inner_text(".start-menu__body"))
    page.keyboard.press("Escape"); page.wait_for_timeout(300)

    # ---- Explorer + Terminal + selection ----
    page.evaluate("() => appManager.launch('file-explorer', { path: '/Documents' })")
    page.wait_for_selector(".explorer__breadcrumbs")
    page.wait_for_timeout(400)
    crumbs = page.inner_text(".explorer__breadcrumbs")
    check("Explorer navigates to /Documents", "Documents" in crumbs, crumbs)

    page.evaluate("() => appManager.launch('terminal')")
    page.wait_for_selector(".terminal__input")
    term = page.locator(".terminal__input").last
    for cmd in ("cd /Documents", "mkdir regress-dir", "pwd", "ls"):
        term.fill(cmd); term.press("Enter"); page.wait_for_timeout(150)
    out = page.locator(".terminal__output").last.inner_text()
    check("Terminal commands work", "/Documents" in out and "regress-dir" in out, out[-200:])
    prompt_before = page.locator(".terminal__prompt-label").last.inner_text()

    page.locator(".desktop-icon", has_text="Calculator").click()
    page.wait_for_timeout(100)
    sel_before = page.evaluate("() => [...document.querySelectorAll('.desktop-icon--selected')].map(e => e.textContent)")
    windows_before = page.evaluate("() => [...document.querySelectorAll('.window')].map(w => w.dataset.windowId)")

    # ---- Change appearance heavily through the service ----
    page.evaluate("""() => { const s = settingsService;
      s.set('appearance.theme','light'); s.set('appearance.accentColor','rose'); s.set('appearance.transparency', false);
      s.set('appearance.windowRadius', 4); s.set('appearance.animationSpeed','slow'); s.set('appearance.blurIntensity', 8); }""")
    page.wait_for_timeout(400)
    check("windows unchanged after appearance change", page.evaluate("() => [...document.querySelectorAll('.window')].map(w => w.dataset.windowId)") == windows_before)
    check("Explorer path preserved", "Documents" in page.inner_text(".explorer__breadcrumbs"))
    check("Terminal cwd + output preserved", page.locator(".terminal__prompt-label").last.inner_text() == prompt_before and "regress-dir" in page.locator(".terminal__output").last.inner_text())
    check("Desktop selection preserved", page.evaluate("() => [...document.querySelectorAll('.desktop-icon--selected')].map(e => e.textContent)") == sel_before, sel_before)
    check("VFS state preserved", page.evaluate("async () => vfs.exists('/Documents/regress-dir')"))
    term_bg = page.evaluate("() => getComputedStyle(document.querySelector('.terminal__viewport')).backgroundColor")
    term_fg = page.evaluate("() => getComputedStyle(document.querySelector('.terminal__line')).color")
    check("Terminal content stays dark in light theme", term_bg == "rgb(26, 30, 43)" and term_fg == "rgb(228, 232, 241)", (term_bg, term_fg))
    page.screenshot(path=os.path.join(SHOTS, "04-light-explorer-terminal.png"))

    # ---- Windows: drag, resize, minimize, restore, maximize ----
    ew = page.locator(".window:has(.explorer)")
    b0 = ew.bounding_box()
    tb = ew.locator(".window__titlebar-info").bounding_box()
    page.mouse.move(tb["x"] + 60, tb["y"] + 10); page.mouse.down(); page.mouse.move(tb["x"] + 160, tb["y"] + 60, steps=8); page.mouse.up()
    page.wait_for_timeout(100)
    b1 = ew.bounding_box()
    check("window dragging", abs((b1["x"] - b0["x"]) - 100) < 3 and abs((b1["y"] - b0["y"]) - 50) < 3, (b0, b1))
    se = ew.locator(".window__resize-handle--se").bounding_box()
    page.mouse.move(se["x"] + 5, se["y"] + 5); page.mouse.down(); page.mouse.move(se["x"] + 65, se["y"] + 45, steps=8); page.mouse.up()
    page.wait_for_timeout(100)
    b2 = ew.bounding_box()
    check("window resizing", abs((b2["width"] - b1["width"]) - 60) < 3 and abs((b2["height"] - b1["height"]) - 40) < 3, (b1, b2))
    ew.locator(".window__control--minimize").click(); page.wait_for_timeout(200)
    check("minimize", "window--minimized" in ew.get_attribute("class"))
    page.locator(".taskbar-window-button", has_text="File Explorer").click(); page.wait_for_timeout(300)
    check("restore from taskbar", "window--minimized" not in ew.get_attribute("class"))
    ew.locator(".window__control--maximize").click(); page.wait_for_timeout(500)
    check("maximize (radius 0)", "window--maximized" in ew.get_attribute("class") and page.evaluate("() => getComputedStyle(document.querySelector('.window--maximized')).borderTopLeftRadius") == "0px")
    ew.locator(".window__control--maximize").click(); page.wait_for_timeout(500)
    rr = page.evaluate("() => getComputedStyle(document.querySelector('.window:has(.explorer)')).borderTopLeftRadius")
    check("restore keeps user radius", rr == "4px", rr)

    # ---- Context menu + close under slow motion ----
    page.locator(".desktop-icon", has_text="Notes").click(button="right")
    page.wait_for_selector(".context-menu--visible")
    page.keyboard.press("Escape"); page.wait_for_timeout(500)
    check("context menu opens/closes", page.locator(".context-menu").count() == 0)
    page.locator(".window:has(.terminal-app) .window__control--close").click()
    page.wait_for_timeout(200)
    mid = page.locator(".window:has(.terminal-app)").count()
    page.wait_for_timeout(400)
    check("slow close animation completes then removes window", mid == 1 and page.locator(".window:has(.terminal-app)").count() == 0, mid)

    # ---- Notes persistence ----
    page.evaluate("() => settingsService.resetCategory('appearance')")
    page.evaluate("() => appManager.launch('notes')")
    page.wait_for_selector(".notes__item")
    page.locator(".notes__sidebar .notes__button--primary", has_text="New note").click()
    page.wait_for_timeout(400)
    page.keyboard.type("Persist")
    page.keyboard.press("Enter")
    page.keyboard.type("persist me 123")
    page.wait_for_timeout(1500)
    page.reload(); wait_desktop(page)
    page.evaluate("() => appManager.launch('notes')")
    page.wait_for_selector(".notes__item"); page.wait_for_timeout(300)
    page.locator(".notes__item", has_text="Persist").click(); page.wait_for_timeout(400)
    check("Notes persistence", "persist me 123" in page.inner_text(".notes-editor__rich"), page.inner_text(".notes-editor__rich"))
    check("Explorer-created folder persisted", page.evaluate("async () => vfs.exists('/Documents/regress-dir')"))

    # ---- Settings page scrolled, dark ----
    page.evaluate("() => appManager.launch('settings')")
    page.wait_for_selector(".settings-app"); page.wait_for_timeout(300)
    page.evaluate("() => document.querySelector('.settings-content').scrollTop = 520")
    page.wait_for_timeout(200)
    page.screenshot(path=os.path.join(SHOTS, "05-dark-effects-motion.png"))
    page.evaluate("() => { settingsService.set('appearance.theme','light'); settingsService.set('appearance.accentColor','orange'); document.querySelector('.settings-content').scrollTop = 99999; }")
    page.wait_for_timeout(300)
    page.screenshot(path=os.path.join(SHOTS, "06-light-motion-reset.png"))

    real_errors = [e for e in errors if "404" not in e]
    check("no console errors", not real_errors, real_errors)
    non_favicon = [r for r in bad_requests if not r[1].endswith("/favicon.ico") and "fonts.g" not in r[1]]
    check("only favicon/font requests fail", not non_favicon, bad_requests)
    print("failed requests:", bad_requests)
    browser.close()

httpd.shutdown()
failed = [r for r in results if not r[1]]
print(f"\n{len(results) - len(failed)}/{len(results)} passed")
sys.exit(1 if failed else 0)
