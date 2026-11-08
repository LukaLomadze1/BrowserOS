"""End-to-end checks for system preferences: Desktop, Start Menu, File Explorer,
Keyboard, and System pages, and their effect on the shell.

Usage:  python tests/e2e/test_preferences.py
"""
import sys, threading, functools, http.server, socketserver, os, json, time
from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import SITE_ROOT, output_dir, launch_options, wait_desktop  # noqa: E402

ROOT, SHOTS = SITE_ROOT, output_dir("preferences")
PORT = 0


class Q(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


socketserver.ThreadingTCPServer.allow_reuse_address = True
socketserver.ThreadingTCPServer.daemon_threads = True
httpd = socketserver.ThreadingTCPServer(("127.0.0.1", PORT), functools.partial(Q, directory=ROOT))
PORT = httpd.server_address[1]
threading.Thread(target=httpd.serve_forever, daemon=True).start()
URL = f"http://127.0.0.1:{PORT}/index.html"

results = []


def check(name, cond, detail=""):
    results.append((name, bool(cond)))
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if not cond and detail != "" else ""), flush=True)


ALL_ERRORS = []


def new_page(browser, init_js=None, **ctx_kwargs):
    ctx = browser.new_context(viewport={"width": 1400, "height": 900}, **ctx_kwargs)
    if init_js:
        ctx.add_init_script(f"if (!sessionStorage.getItem('seeded')) {{ sessionStorage.setItem('seeded','1'); localStorage.clear(); {init_js} }}")
    page = ctx.new_page()
    errors = []

    def on_console(m):
        if m.type == "error" and "404" not in m.text:
            errors.append(m.text)
        if m.type == "warning" and "[Settings]" not in m.text:
            errors.append("warning: " + m.text)

    page.on("console", on_console)
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(URL)
    wait_desktop(page)
    ALL_ERRORS.append(errors)
    return ctx, page, errors


def setv(page, key, value):
    return page.evaluate(f"() => settingsService.set({json.dumps(key)}, {json.dumps(value)})")


def icon(page, name):
    return page.locator(".desktop-icon", has_text=name)


def icon_pos(page, name):
    return page.evaluate(f"""() => {{ const el = [...document.querySelectorAll('.desktop-icon')].find(e => e.textContent.includes({json.dumps(name)}));
      return el ? {{ left: parseFloat(el.style.left), top: parseFloat(el.style.top), w: el.offsetWidth, hidden: el.hidden }} : null; }}""")


def window_count(page, selector=".window"):
    return page.locator(selector).count()


def open_start(page):
    page.click(".start-button")
    page.wait_for_selector(".start-menu--visible")
    page.wait_for_timeout(250)


def close_start(page):
    page.keyboard.press("Escape")
    page.wait_for_timeout(300)


with sync_playwright() as p:
    browser = p.chromium.launch(**launch_options())

    # =====================================================================
    # DESKTOP
    # =====================================================================
    ctx, page, errors = new_page(browser)
    base = icon_pos(page, "Calculator")
    check("desktop: medium default layout", base["top"] == 124 and base["w"] == 84, base)

    setv(page, "desktop.iconSize", "large")
    page.wait_for_timeout(450)
    large = icon_pos(page, "Calculator")
    check("1 icon size large updates existing icons + grid", large["w"] == 104 and large["top"] == 24 + 119, large)
    glyph = page.evaluate("() => getComputedStyle(document.querySelector('.desktop-icon__glyph')).width")
    check("1 icon glyph grows", glyph == "64px", glyph)
    setv(page, "desktop.iconSize", "small")
    page.wait_for_timeout(450)
    small = icon_pos(page, "Calculator")
    check("1 icon size small", small["w"] == 76 and small["top"] == 24 + 89, small)
    setv(page, "desktop.iconSize", "medium")

    setv(page, "desktop.gridSpacing", "spacious")
    page.wait_for_timeout(450)
    sp = icon_pos(page, "Calculator")
    check("3 grid spacing changes real positions", sp["top"] == 24 + 116, sp)
    setv(page, "desktop.gridSpacing", "compact")
    page.wait_for_timeout(450)
    check("3 grid spacing compact", icon_pos(page, "Calculator")["top"] == 24 + 92)
    setv(page, "desktop.gridSpacing", "normal")
    page.wait_for_timeout(450)

    setv(page, "desktop.showLabels", False)
    page.wait_for_timeout(100)
    lbl = page.evaluate("() => getComputedStyle(document.querySelector('.desktop-icon__label')).display")
    aria = page.evaluate("() => document.querySelector('.desktop-icon').getAttribute('aria-label')")
    check("labels hidden visually, aria-label kept", lbl == "none" and aria, (lbl, aria))
    check("labels hidden does not move icons", icon_pos(page, "Calculator")["top"] == 124)
    setv(page, "desktop.showLabels", True)

    icon(page, "Notes").click()
    page.wait_for_timeout(100)
    setv(page, "desktop.showIcons", False)
    page.wait_for_timeout(100)
    vis = page.evaluate("() => [...document.querySelectorAll('.desktop-icon')].filter(e => getComputedStyle(e).display !== 'none').length")
    sel = page.evaluate("() => document.querySelectorAll('.desktop-icon--selected').length")
    check("2 hide desktop icons (and drop selection)", vis == 0 and sel == 0, (vis, sel))
    page.mouse.click(1200, 400, button="right")
    page.wait_for_selector(".context-menu--visible")
    page.locator(".context-menu__item", has_text="View").click()
    page.wait_for_timeout(200)
    page.locator(".context-menu__item", has_text="Show desktop icons").click()
    page.wait_for_timeout(200)
    vis = page.evaluate("() => [...document.querySelectorAll('.desktop-icon')].filter(e => getComputedStyle(e).display !== 'none').length")
    check("2 show icons again via context menu View", vis == 10 and page.evaluate("() => settingsService.get('desktop.showIcons')"), vis)

    setv(page, "desktop.showSystemShortcuts", False)
    page.wait_for_timeout(100)
    check("system shortcut (Recycle Bin) hidden", icon_pos(page, "Recycle Bin")["hidden"] is True and icon_pos(page, "Terminal")["hidden"] is False)
    setv(page, "desktop.showSystemShortcuts", True)

    for size in ("small", "medium", "large"):
        setv(page, "desktop.iconSize", size)
        page.wait_for_timeout(450)
        clipped = page.evaluate("""() => [...document.querySelectorAll('.desktop-icon')].filter(i => {
          const l = i.querySelector('.desktop-icon__label'); return l.scrollHeight > l.clientHeight + 1 || l.getBoundingClientRect().bottom > i.getBoundingClientRect().bottom + 0.5; }).map(i => i.textContent)""")
        check(f"two-line labels not clipped ({size})", clipped == [], clipped)
    setv(page, "desktop.iconSize", "medium")
    page.wait_for_timeout(450)

    # 4 single-click open
    setv(page, "desktop.openItemsWith", "singleClick")
    icon(page, "Calculator").click()
    page.wait_for_timeout(500)
    check("4 single click opens", window_count(page, ".window:has(.calculator)") == 1)
    icon(page, "Notes").dblclick()
    page.wait_for_timeout(600)
    check("4 single-click mode: double click opens only once", window_count(page, ".window:has(.notes)") == 1, window_count(page, ".window:has(.notes)"))
    setv(page, "desktop.openItemsWith", "doubleClick")
    icon(page, "Terminal").click()
    page.wait_for_timeout(400)
    check("4 double-click mode: single click does not open", window_count(page, ".window:has(.terminal-app)") == 0)
    icon(page, "Terminal").dblclick()
    page.wait_for_timeout(400)
    check("4 double-click opens", window_count(page, ".window:has(.terminal-app)") == 1)
    page.evaluate("() => { for (const w of document.querySelectorAll('.window .window__control--close')) w.click(); }")
    page.wait_for_timeout(500)

    # rectangle selection off
    setv(page, "desktop.rectangleSelection", False)
    page.mouse.move(400, 60); page.mouse.down(); page.mouse.move(30, 500, steps=8); page.mouse.up()
    page.wait_for_timeout(150)
    check("rectangle selection disabled", page.locator(".desktop-icon--selected").count() == 0 and page.locator(".desktop-marquee").count() == 0)
    setv(page, "desktop.rectangleSelection", True)
    page.mouse.move(400, 60); page.mouse.down(); page.mouse.move(30, 300, steps=8); page.mouse.up()
    page.wait_for_timeout(150)
    check("rectangle selection enabled", page.locator(".desktop-icon--selected").count() >= 2)
    page.keyboard.press("Escape")

    # files for delete/arrange
    page.evaluate("async () => { for (const n of ['b.txt','a.txt','c.txt']) await vfs.createFile('/Desktop/' + n, 'x'); }")
    page.wait_for_timeout(300)

    # align to grid off -> free placement
    setv(page, "desktop.alignToGrid", False)
    b = icon(page, "a.txt").bounding_box()
    page.mouse.move(b["x"] + 30, b["y"] + 20); page.mouse.down(); page.mouse.move(b["x"] + 300, b["y"] + 150, steps=10); page.mouse.move(b["x"] + 437, b["y"] + 253, steps=5); page.mouse.up()
    page.wait_for_timeout(400)
    free = icon_pos(page, "a.txt")
    stored = page.evaluate("() => JSON.parse(localStorage.getItem('browseros:desktop:iconLayout')).positions")
    frac = [v for v in stored.values() if v["col"] != round(v["col"]) or v["row"] != round(v["row"])]
    check("align off: dropped icon keeps exact position (not snapped)", (free["left"] - 24) % 100 != 0 and len(frac) >= 1, (free, frac))
    setv(page, "desktop.alignToGrid", True)
    page.wait_for_timeout(450)
    snapped = icon_pos(page, "a.txt")
    check("align on: icons snap back to grid", (snapped["left"] - 24) % 100 == 0 and (snapped["top"] - 24) % 100 == 0, snapped)

    # auto arrange
    setv(page, "desktop.autoArrange", True)
    page.wait_for_timeout(450)
    pos = page.evaluate("""() => [...document.querySelectorAll('.desktop-icon')].map(e => [parseFloat(e.style.left), parseFloat(e.style.top)])""")
    keys = sorted(pos)
    rows = page.evaluate("() => Math.floor((document.querySelector('.desktop__icon-grid').getBoundingClientRect().height - 24) / 100)")
    expected = sorted([[24 + 100 * (i // rows), 24 + 100 * (i % rows)] for i in range(len(pos))])
    check("auto arrange packs icons into columns", keys == expected, (keys, expected))
    page.evaluate("() => vfs.createFile('/Desktop/aaa-new.txt', '')")
    page.wait_for_timeout(450)
    pos2 = sorted(page.evaluate("""() => [...document.querySelectorAll('.desktop-icon')].map(e => [parseFloat(e.style.left), parseFloat(e.style.top)])"""))
    expected2 = sorted([[24 + 100 * (i // rows), 24 + 100 * (i % rows)] for i in range(len(pos2))])
    check("auto arrange keeps new items packed", pos2 == expected2)
    setv(page, "desktop.autoArrange", False)

    # context menu sort + arrange
    page.mouse.click(1200, 400, button="right")
    page.wait_for_selector(".context-menu--visible")
    names = page.evaluate("() => [...document.querySelectorAll('.context-menu--visible .context-menu__item')].map(e => e.textContent)")
    check("desktop context menu has View/Sort/Arrange/Refresh/Personalize", all(any(n.startswith(x) for n in names) for x in ["View", "Sort by", "Arrange icons", "Refresh", "Personalize"]), names)
    page.locator(".context-menu__item", has_text="Personalize").click()
    page.wait_for_timeout(200)
    page.locator(".context-menu__item", has_text="Change wallpaper").click()
    page.wait_for_selector(".settings-app")
    page.wait_for_timeout(300)
    check("Personalize > Change wallpaper opens Wallpaper settings", page.inner_text(".settings-page__title") == "Wallpaper")
    page.click(".settings-wallpaper-card:has(input[value='ocean'])")
    page.wait_for_timeout(150)
    check("wallpaper preset applies to desktop", page.evaluate("() => document.documentElement.dataset.wallpaper") == "ocean"
          and "14, 165, 233" in page.evaluate("() => getComputedStyle(document.querySelector('.desktop__wallpaper')).backgroundImage"))
    setv(page, "wallpaper.dim", 40)
    page.wait_for_timeout(400)
    check("wallpaper dim applies", page.evaluate("() => getComputedStyle(document.querySelector('.desktop__wallpaper'), '::after').opacity") == "0.4")
    page.mouse.click(1200, 820, button="right")
    page.wait_for_selector(".context-menu--visible")
    page.locator(".context-menu__item", has_text="Personalize").click()
    page.wait_for_timeout(200)
    page.locator(".context-menu__item", has_text="Desktop settings").click()
    page.wait_for_timeout(300)
    check("Personalize > Desktop settings navigates the single Settings window", page.inner_text(".settings-page__title") == "Desktop" and window_count(page, ".window[data-window-id^='app:settings']") == 1)
    page.screenshot(path=os.path.join(SHOTS, "q-desktop-page.png"))
    page.click(".window[data-window-id='app:settings'] .window__control--close")
    page.wait_for_timeout(450)

    # 9 confirmations
    setv(page, "desktop.confirmTrash", "always")
    icon(page, "c.txt").click()
    page.keyboard.press("Delete")
    page.wait_for_timeout(300)
    check("confirm always: single file asks", page.locator(".dialog--visible").count() == 1)
    page.click(".dialog--visible .dialog__button--default")
    page.wait_for_timeout(300)
    check("cancel keeps file", icon(page, "c.txt").count() == 1)
    setv(page, "desktop.confirmTrash", "never")
    icon(page, "a.txt").click()
    page.keyboard.down("Control"); icon(page, "b.txt").click(); page.keyboard.up("Control")
    page.keyboard.press("Delete")
    page.wait_for_timeout(500)
    check("confirm never: multi delete without dialog, to Trash", page.locator(".dialog--visible").count() == 0 and icon(page, "a.txt").count() == 0
          and page.evaluate("async () => (await vfs.list('/Trash')).some(e => e.name === 'a.txt')"))
    check("selection cleaned after deletion", page.evaluate("() => document.querySelectorAll('.desktop-icon--selected').length") == 0)
    setv(page, "desktop.confirmTrash", "smart")

    # keyboard: Ctrl+A on desktop vs text input
    icon(page, "Notes").click()
    page.keyboard.press("Control+a")
    page.wait_for_timeout(100)
    total_visible = page.evaluate("() => [...document.querySelectorAll('.desktop-icon')].filter(e => !e.hidden).length")
    check("16 Ctrl+A on focused desktop selects all icons", page.locator(".desktop-icon--selected").count() == total_visible, total_visible)
    page.keyboard.press("Escape")
    page.wait_for_timeout(100)
    check("Escape clears desktop selection", page.locator(".desktop-icon--selected").count() == 0)
    page.evaluate("() => appManager.launch('notes')")
    page.wait_for_selector(".notes__search-input")
    page.fill(".notes__search-input", "hello world")
    page.focus(".notes__search-input")
    page.keyboard.press("Control+a")
    sel_text = page.evaluate("() => { const t = document.querySelector('.notes__search-input'); return t.value.slice(t.selectionStart, t.selectionEnd); }")
    check("17 Ctrl+A in text input selects text, not icons", sel_text == "hello world" and page.locator(".desktop-icon--selected").count() == 0, sel_text)
    page.keyboard.press("Alt+Shift+ArrowDown")
    page.wait_for_timeout(200)
    check("16 Alt+Shift+Down minimizes the active window", "window--minimized" in page.locator(".window:has(.notes)").get_attribute("class"))
    page.keyboard.press("Alt+Backquote")
    page.wait_for_timeout(300)
    check("16 Alt+` switches to (restores) a window", "window--minimized" not in page.locator(".window:has(.notes)").get_attribute("class"))
    page.keyboard.press("Alt+Shift+ArrowUp")
    page.wait_for_timeout(400)
    check("16 Alt+Shift+Up maximizes", "window--maximized" in page.locator(".window:has(.notes)").get_attribute("class"))
    page.keyboard.press("Alt+Shift+W")
    page.wait_for_timeout(500)
    check("16 Alt+Shift+W closes active window", window_count(page, ".window:has(.notes)") == 0)
    page.keyboard.press("Control+Alt+t")
    page.wait_for_timeout(500)
    check("Ctrl+Alt+T opens Terminal", window_count(page, ".window:has(.terminal-app)") == 1)
    setv(page, "keyboard.appShortcuts", False)
    page.keyboard.press("Control+Alt+t")
    page.wait_for_timeout(400)
    check("app shortcuts disabled by setting", window_count(page, ".window:has(.terminal-app)") == 1)
    setv(page, "keyboard.appShortcuts", True)
    term = page.locator(".terminal__input").last
    term.fill("echo hi")
    term.press("Control+l")
    page.wait_for_timeout(100)
    check("Terminal Ctrl+L still clears", page.locator(".terminal__line").count() == 0)
    for cmd in ("mkdir /Documents/kbtest", "ls /Documents"):
        term.fill(cmd); term.press("Enter"); page.wait_for_timeout(150)
    term.press("ArrowUp")
    check("Terminal history ArrowUp works", page.input_value(".terminal__input") == "ls /Documents")
    page.keyboard.press("Meta")
    page.wait_for_timeout(300)
    check("Meta key toggles Start Menu", page.locator(".start-menu--visible").count() == 1)
    page.keyboard.press("Meta")
    page.wait_for_timeout(300)
    setv(page, "keyboard.startMenuKey", False)
    page.keyboard.press("Meta")
    page.wait_for_timeout(300)
    check("Meta key disabled by setting", page.locator(".start-menu--visible").count() == 0)
    setv(page, "keyboard.startMenuKey", True)
    page.evaluate("() => { for (const w of document.querySelectorAll('.window .window__control--close')) w.click(); }")
    page.wait_for_timeout(500)
    check("desktop session: no console errors", not errors, errors)
    ctx.close()

    # =====================================================================
    # START MENU
    # =====================================================================
    ctx, page, errors = new_page(browser)
    for app in ("calculator", "notes", "terminal"):
        page.evaluate(f"() => appManager.launch('{app}')")
        page.wait_for_timeout(250)
    setv(page, "startMenu.recentAppsLimit", 2)
    open_start(page)
    recent_apps = page.evaluate("() => [...document.querySelectorAll('.start-menu__section')][1].querySelectorAll('.start-menu__row').length")
    check("5 recent apps limit applies immediately", recent_apps == 2, recent_apps)
    close_start(page)
    setv(page, "startMenu.recentAppsLimit", 6)
    open_start(page)
    check("5 raising limit reveals stored history", page.evaluate("() => [...document.querySelectorAll('.start-menu__section')][1].querySelectorAll('.start-menu__row').length") >= 4)
    close_start(page)

    page.evaluate("async () => { await vfs.createFile('/Documents/report.txt', 'r'); await vfs.createFile('/Documents/todo.txt', 't'); }")
    for f in ("report.txt", "todo.txt"):
        page.evaluate(f"async () => {{ const e = await vfs.getInfo('/Documents/{f}'); const m = await import('./src/core/vfs/vfsOpener.js'); await m.openVfsEntry(e, {{ appManager, recentFilesService: (await appManager.launch('about')).recentFilesService }}); }}")
        page.wait_for_timeout(250)
    open_start(page)
    body = page.inner_text(".start-menu__body")
    check("recent files recorded", "report.txt" in body and "todo.txt" in body, body)
    close_start(page)
    page.evaluate("() => vfs.delete('/Documents/todo.txt')")
    page.wait_for_timeout(200)
    open_start(page)
    check("7 deleted recent file disappears", "todo.txt" not in page.inner_text(".start-menu__body"))
    close_start(page)
    page.reload(); wait_desktop(page)
    open_start(page)
    check("7 deleted recent file stays removed after reload", "todo.txt" not in page.inner_text(".start-menu__body") and "report.txt" in page.inner_text(".start-menu__body"))
    close_start(page)

    page.evaluate("() => appManager.launch('settings', { page: 'startMenu' })")
    page.wait_for_selector(".settings-app"); page.wait_for_timeout(300)
    page.screenshot(path=os.path.join(SHOTS, "q-startmenu-page.png"))
    # 8 pinned management
    page.click("button[aria-label='Unpin Calculator']")
    page.wait_for_timeout(150)
    check("8 unpin focus moves to a remaining control", page.evaluate("() => document.activeElement?.tagName") == "BUTTON")
    page.click("button[aria-label='Move up Settings']")
    page.wait_for_timeout(150)
    focused = page.evaluate("() => document.activeElement?.getAttribute('aria-label')")
    pinned = page.evaluate("() => settingsService.get('startMenu.pinnedApps')")
    check("8 reorder pinned + focus restored to same action", pinned == ["browser", "code-studio", "notes", "calendar", "clock", "settings", "file-explorer", "about", "recycle-bin"] and focused == "Move up Settings", (pinned, focused))
    page.click("button[aria-label='Pin Terminal']")
    page.wait_for_timeout(150)
    open_start(page)
    tiles = page.evaluate("() => [...document.querySelectorAll('.start-menu__pinned-label')].map(e => e.textContent)")
    check("8 Start Menu pinned tiles follow settings", tiles == ["Browser", "Code Studio", "Notes", "Calendar", "Clock", "Settings", "File Explorer", "About BrowserOS", "Recycle Bin", "Terminal"], tiles)
    close_start(page)
    page.click("button[aria-label='Reset pinned applications to default']")
    page.wait_for_timeout(150)
    check("8 reset pinned to defaults", page.evaluate("() => settingsService.get('startMenu.pinnedApps')") == ["browser", "code-studio", "notes", "calendar", "calculator", "clock", "file-explorer", "settings", "about", "recycle-bin"])
    setv(page, "startMenu.showPinned", False)
    open_start(page)
    check("8 hide pinned section", page.evaluate("() => [...document.querySelectorAll('.start-menu__section')][0].hidden"))
    close_start(page)
    setv(page, "startMenu.showPinned", True)

    # 6 clear recent activity + reload
    page.locator(".settings-button", has_text="Clear recent applications").click()
    page.locator(".settings-button", has_text="Clear recent files").click()
    page.wait_for_timeout(200)
    open_start(page)
    body = page.inner_text(".start-menu__body")
    check("6 clear recent activity updates Start Menu", "No recent apps yet" in body and "No recent files" in body, body)
    close_start(page)
    page.reload(); wait_desktop(page)
    open_start(page)
    body = page.inner_text(".start-menu__body")
    # About auto-launches on boot, so it legitimately re-enters recent apps.
    check("6 cleared activity persists after reload", "No recent files" in body and "Calculator" not in page.evaluate("() => [...document.querySelectorAll('.start-menu__section')][1].innerText"), body)
    close_start(page)

    # 9 search
    page.evaluate("async () => { await vfs.createFolder('/Documents/Settings Backup'); await vfs.createFile('/Documents/notes-archive.txt', ''); }")
    open_start(page)
    page.fill(".start-menu__search-input", "notes")
    page.wait_for_timeout(500)
    rows = page.evaluate("() => [...document.querySelectorAll('.start-menu__results-list .start-menu__row')].map(r => r.getAttribute('aria-label'))")
    check("9 search finds apps and files; apps first", rows and rows[0] == "Notes, Rich-text notes and plain-text documents" and any("notes-archive.txt" in r for r in rows), rows)
    page.fill(".start-menu__search-input", "wallpaper")
    page.wait_for_timeout(400)
    rows = page.evaluate("() => [...document.querySelectorAll('.start-menu__results-list .start-menu__row')].map(r => r.getAttribute('aria-label'))")
    check("9 search finds settings", any("Settings" in r and "Wallpaper" in r for r in rows), rows)
    page.keyboard.press("Enter")
    page.wait_for_timeout(500)
    check("9 Enter opens setting result in Settings", page.locator(".settings-app").count() == 1 and page.inner_text(".settings-page__title") == "Wallpaper")
    setv(page, "startMenu.searchFiles", False)
    setv(page, "startMenu.searchSettings", False)
    open_start(page)
    page.fill(".start-menu__search-input", "notes")
    page.wait_for_timeout(500)
    rows = page.evaluate("() => [...document.querySelectorAll('.start-menu__results-list .start-menu__row')].map(r => r.getAttribute('aria-label'))")
    check("9 files excluded when searchFiles off", not any("archive" in r for r in rows), rows)
    check("placeholder reflects sources", page.get_attribute(".start-menu__search-input", "placeholder") == "Search apps and folders")
    page.fill(".start-menu__search-input", "settings")
    page.wait_for_timeout(500)
    rows = page.evaluate("() => [...document.querySelectorAll('.start-menu__results-list .start-menu__row')].map(r => r.getAttribute('aria-label'))")
    check("9 folders searchable", any("Settings Backup" in r for r in rows), rows)
    setv(page, "startMenu.caseInsensitiveSearch", False)
    page.fill(".start-menu__search-input", "NOTES")
    page.wait_for_timeout(500)
    rows = page.evaluate("() => [...document.querySelectorAll('.start-menu__results-list .start-menu__row')].length")
    check("9 case-sensitive search", rows == 0, rows)
    setv(page, "startMenu.caseInsensitiveSearch", True)
    setv(page, "startMenu.searchFiles", True)
    setv(page, "startMenu.searchSettings", True)
    setv(page, "startMenu.searchResultLimit", 5)
    page.evaluate("async () => { for (let i = 0; i < 12; i++) await vfs.createFile(`/Documents/bulk-${i}.txt`, ''); }")
    page.fill(".start-menu__search-input", "bulk")
    page.wait_for_timeout(500)
    rows = page.evaluate("() => document.querySelectorAll('.start-menu__results-list .start-menu__row').length")
    check("9 result limit applies", rows == 5, rows)
    # stale results never overwrite newer query
    page.fill(".start-menu__search-input", "bulk")
    page.fill(".start-menu__search-input", "calc")
    page.wait_for_timeout(600)
    rows = page.evaluate("() => [...document.querySelectorAll('.start-menu__results-list .start-menu__row')].map(r => r.getAttribute('aria-label'))")
    check("9 debounced search shows only latest query", rows == ["Calculator, Standard and scientific calculator with history"], rows)
    close_start(page)
    check("start menu session: no console errors", not errors, errors)
    ctx.close()

    # =====================================================================
    # FILE EXPLORER
    # =====================================================================
    ctx, page, errors = new_page(browser)
    page.evaluate("""async () => {
      await vfs.createFile('/Documents/alpha.txt', 'aaaaaaaaaa');
      await vfs.createFile('/Documents/beta.txt', 'b');
      await vfs.createFile('/Documents/gamma.md', 'gggggggggggggggggggg');
      await vfs.createFile('/Documents/.secret', 's', { hidden: true });
      await vfs.createFolder('/Documents/Sub');
    }""")
    page.evaluate("() => appManager.launch('file-explorer', { path: '/Documents' })")
    page.wait_for_selector(".explorer__row")
    page.wait_for_timeout(300)
    names = lambda: page.evaluate("() => [...document.querySelectorAll('.window:last-of-type .explorer__row-name')].map(e => e.textContent)")
    first_names = names()
    check("hidden file not listed by default", ".secret" not in first_names and "alpha.txt" in first_names, first_names)
    setv(page, "fileExplorer.showHiddenFiles", True)
    page.wait_for_timeout(400)
    check("12 toggle hidden files shows them live", ".secret" in names(), names())
    setv(page, "fileExplorer.showHiddenFiles", False)
    page.wait_for_timeout(400)
    check("12 hidden again", ".secret" not in names())

    setv(page, "fileExplorer.showExtensions", False)
    page.wait_for_timeout(200)
    n = names()
    check("11 extensions hidden in display", "alpha" in n and "alpha.txt" not in n, n)
    check("11 underlying name unchanged", page.evaluate("async () => vfs.exists('/Documents/alpha.txt')"))
    page.locator(".explorer__row", has_text="alpha").first.click()
    page.keyboard.press("F2")
    page.wait_for_timeout(200)
    check("11 rename field shows full name", page.input_value(".explorer__rename-input") == "alpha.txt")
    page.keyboard.press("Escape")
    setv(page, "fileExplorer.showExtensions", True)

    page.evaluate("() => appManager.launch('file-explorer', { path: '/Documents' })")
    page.wait_for_timeout(500)
    check("two Explorer windows open", window_count(page, ".window:has(.explorer)") == 2)
    setv(page, "fileExplorer.defaultView", "details")
    page.wait_for_timeout(300)
    modes = page.evaluate("() => [...document.querySelectorAll('.explorer__list')].map(l => l.className)")
    crumbs = page.evaluate("() => [...document.querySelectorAll('.explorer__breadcrumbs')].map(b => b.innerText)")
    check("10/15 view change applies to every open window, path kept", all("details" in m for m in modes) and all("Documents" in c for c in crumbs), (modes, crumbs))
    page.locator(".window:has(.explorer)").last.locator(".explorer__view-button[aria-label='List view']").click()
    page.wait_for_timeout(300)
    modes = page.evaluate("() => [...document.querySelectorAll('.explorer__list')].map(l => l.className)")
    check("15 toolbar view button syncs all windows via settings", all("list" in m for m in modes) and page.evaluate("() => settingsService.get('fileExplorer.defaultView')") == "list", modes)
    setv(page, "fileExplorer.defaultView", "details")
    page.wait_for_timeout(300)
    setv(page, "fileExplorer.showSize", False)
    page.wait_for_timeout(200)
    cols = page.evaluate("() => document.querySelector('.explorer__row').querySelectorAll('.explorer__row-cell').length")
    hdr = page.evaluate("() => document.querySelector('.explorer__list-header-button--size').hidden")
    check("size column hidden", cols == 3 and hdr, (cols, hdr))
    setv(page, "fileExplorer.showSize", True)

    page.evaluate("() => settingsService.setMany({ 'fileExplorer.sortField': 'size', 'fileExplorer.sortDirection': 'desc' })")
    page.wait_for_timeout(300)
    order = page.evaluate("() => [...document.querySelector('.explorer__list').querySelectorAll('.explorer__row-name')].map(e => e.textContent)")
    check("13 sort by size desc (folders first)", order[:4] == ["Sub", "gamma.md", "alpha.txt", "beta.txt"], order)
    setv(page, "fileExplorer.foldersFirst", False)
    page.wait_for_timeout(300)
    order = page.evaluate("() => [...document.querySelector('.explorer__list').querySelectorAll('.explorer__row-name')].map(e => e.textContent)")
    check("13 folders-first off", order[0] == "gamma.md", order)
    page.locator(".window:has(.explorer)").last.locator(".explorer__list-header-button--name").click()
    page.wait_for_timeout(300)
    check("13 column header click updates shared sort setting", page.evaluate("() => [settingsService.get('fileExplorer.sortField'), settingsService.get('fileExplorer.sortDirection')]") == ["name", "asc"])
    setv(page, "fileExplorer.foldersFirst", True)
    page.screenshot(path=os.path.join(SHOTS, "q-explorer-details.png"))

    # keyboard shortcuts in explorer
    page.locator(".window:has(.explorer)").last.locator(".explorer__row").first.click()
    page.keyboard.press("Control+l")
    page.wait_for_timeout(200)
    check("Ctrl+L focuses Explorer address bar", page.evaluate("() => document.activeElement.classList.contains('explorer__address-input')"))
    page.keyboard.press("Escape")
    page.locator(".window:has(.explorer)").last.locator(".explorer__row").first.click()
    page.keyboard.press("F5")
    page.wait_for_timeout(300)
    check("F5 refreshes Explorer (no page reload)", page.evaluate("() => !!window.appManager") and window_count(page, ".window:has(.explorer)") == 2)
    page.locator(".window:has(.explorer)").last.locator(".explorer__row").first.click()
    page.keyboard.press("Control+Alt+n")
    page.wait_for_timeout(400)
    check("Ctrl+Alt+N creates a new folder", page.evaluate("async () => vfs.exists('/Documents/New Folder')"))
    page.keyboard.press("Escape")
    page.wait_for_timeout(200)
    page.locator(".window:has(.explorer)").last.locator(".explorer__row").first.click()
    page.keyboard.press("Alt+ArrowUp")
    page.wait_for_timeout(300)
    check("Alt+Up goes to parent folder", "Documents" not in page.locator(".window:has(.explorer)").last.locator(".explorer__breadcrumbs").inner_text())

    # 14 startup location
    page.evaluate("() => { for (const w of document.querySelectorAll('.window .window__control--close')) w.click(); }")
    page.wait_for_timeout(500)
    setv(page, "fileExplorer.startupLocation", "documents")
    page.evaluate("() => appManager.launch('file-explorer')")
    page.wait_for_selector(".explorer__breadcrumbs"); page.wait_for_timeout(400)
    check("14 startup location Documents", "Documents" in page.inner_text(".explorer__breadcrumbs"))
    page.evaluate("() => settingsService.setMany({ 'fileExplorer.startupLocation': 'custom', 'fileExplorer.customStartupPath': '/Documents/Sub' })")
    page.evaluate("() => appManager.launch('file-explorer')")
    page.wait_for_timeout(500)
    check("14 custom startup folder", "Sub" in page.locator(".explorer__breadcrumbs").last.inner_text())
    page.evaluate("() => settingsService.set('fileExplorer.customStartupPath', '/Nope/Missing')")
    page.evaluate("() => appManager.launch('file-explorer')")
    page.wait_for_timeout(500)
    check("14 missing custom folder falls back to Home", page.locator(".explorer__breadcrumbs").last.inner_text().strip() == "Home")
    page.evaluate("() => appManager.launch('settings', { page: 'fileExplorer', anchor: 'startup' })")
    page.wait_for_selector(".settings-path-status"); page.wait_for_timeout(400)
    check("14 settings page reports missing folder", "not found" in page.inner_text(".settings-path-status"))
    page.locator(".settings-button", has_text="Choose folder").click()
    page.wait_for_selector(".folder-picker")
    page.locator(".folder-picker__item", has_text="Documents").click()
    page.wait_for_timeout(250)
    page.click(".dialog__button--primary")
    page.wait_for_timeout(400)
    check("14 folder picker selects folder + validates", page.evaluate("() => settingsService.get('fileExplorer.customStartupPath')") == "/Documents"
          and "Folder found" in page.inner_text(".settings-path-status"))
    page.screenshot(path=os.path.join(SHOTS, "q-explorer-page.png"))
    page.evaluate("() => { for (const w of document.querySelectorAll('.window .window__control--close')) w.click(); }")
    page.wait_for_timeout(500)

    setv(page, "fileExplorer.restoreLastLocation", True)
    page.evaluate("() => appManager.launch('file-explorer', { path: '/Pictures' })")
    page.wait_for_timeout(400)
    page.evaluate("() => { for (const w of document.querySelectorAll('.window .window__control--close')) w.click(); }")
    page.wait_for_timeout(500)
    page.evaluate("() => appManager.launch('file-explorer')")
    page.wait_for_timeout(500)
    check("restore last location", "Pictures" in page.inner_text(".explorer__breadcrumbs"))
    setv(page, "fileExplorer.restoreLastLocation", False)

    setv(page, "fileExplorer.openFoldersIn", "newWindow")
    page.evaluate("() => appManager.launch('file-explorer', { path: '/Documents' })")
    page.wait_for_timeout(500)
    before = window_count(page, ".window:has(.explorer)")
    page.locator(".window:has(.explorer)").last.locator(".explorer__row", has_text="Sub").dblclick()
    page.wait_for_timeout(500)
    check("open folders in new window", window_count(page, ".window:has(.explorer)") == before + 1, (before, window_count(page, ".window:has(.explorer)")))
    setv(page, "fileExplorer.openFoldersIn", "sameWindow")

    setv(page, "fileExplorer.confirmTrash", "always")
    page.evaluate("() => vfs.createFile('/Documents/Sub/inside.txt', 'x')")
    page.wait_for_timeout(300)
    check("new Sub window live-syncs VFS changes", page.locator(".window:has(.explorer)").last.locator(".explorer__row", has_text="inside.txt").count() == 1)
    page.locator(".window:has(.explorer)").last.locator(".explorer__row").first.click()
    page.keyboard.press("Delete")
    page.wait_for_timeout(300)
    check("explorer confirm always", page.locator(".dialog--visible").count() == 1)
    page.click(".dialog--visible .dialog__button--default")
    page.wait_for_timeout(300)
    check("explorer session: no console errors", not errors, errors)
    ctx.close()

    # =====================================================================
    # SETTINGS: reset, persistence, recovery, migration, search, keyboard page
    # =====================================================================
    ctx, page, errors = new_page(browser)
    page.evaluate("""() => settingsService.setMany({
      'desktop.iconSize': 'large', 'desktop.gridSpacing': 'spacious', 'startMenu.recentAppsLimit': 3,
      'fileExplorer.defaultView': 'details', 'wallpaper.preset': 'sunset', 'appearance.theme': 'light', 'keyboard.windowShortcuts': false })""")
    page.wait_for_timeout(300)
    page.reload(); wait_desktop(page)
    persisted = page.evaluate("() => [settingsService.get('desktop.iconSize'), settingsService.get('fileExplorer.defaultView'), document.documentElement.dataset.wallpaper, document.documentElement.dataset.theme]")
    check("20 settings persist across reload", persisted == ["large", "details", "sunset", "light"], persisted)
    check("20 desktop applies persisted icon size at boot", icon_pos(page, "Calculator")["w"] == 104)

    page.evaluate("() => appManager.launch('settings', { page: 'keyboard' })")
    page.wait_for_selector(".settings-shortcuts__table"); page.wait_for_timeout(300)
    off = page.evaluate("() => [...document.querySelectorAll('.settings-shortcuts__row--disabled')].length")
    check("shortcut reference marks disabled group", off == 5, off)
    page.click("[role=switch][aria-labelledby*='keyboard-windowShortcuts']")
    page.wait_for_timeout(200)
    check("shortcut reference updates live", page.evaluate("() => document.querySelectorAll('.settings-shortcuts__row--disabled').length") == 0)
    page.evaluate("""() => keyboardShortcuts.register({ id: 'test.dynamic', category: 'general', description: 'Dynamic test shortcut', context: 'Test', combos: [{ key: 'F9' }] })""")
    page.wait_for_timeout(100)
    check("reference updates on dynamic registration", "Dynamic test shortcut" in page.inner_text(".settings-shortcuts"))
    page.screenshot(path=os.path.join(SHOTS, "q-keyboard-page.png"))

    # 18 reset category via page
    page.evaluate("() => appManager.launch('settings', { page: 'desktop' })")
    page.wait_for_timeout(300)
    page.locator(".settings-button", has_text="Reset desktop settings").click()
    page.wait_for_selector(".dialog--visible")
    page.click(".dialog--visible .dialog__button--danger")
    page.wait_for_timeout(500)
    check("18 reset desktop category applies to desktop", icon_pos(page, "Calculator")["w"] == 84 and icon_pos(page, "Calculator")["top"] == 124
          and page.evaluate("() => settingsService.get('startMenu.recentAppsLimit')") == 3)

    # sidebar search deep link
    page.fill(".settings-sidebar__search-input", "hidden")
    page.wait_for_timeout(150)
    page.locator(".settings-search__result").first.click()
    page.wait_for_timeout(400)
    check("settings search navigates to section", page.inner_text(".settings-page__title") == "File Explorer"
          and page.locator(".settings-section--highlighted[data-settings-anchor='display']").count() == 1)

    # 19 reset all
    page.evaluate("() => appManager.launch('settings', { page: 'system' })")
    page.wait_for_timeout(300)
    page.screenshot(path=os.path.join(SHOTS, "q-system-page.png"))
    page.locator(".settings-button", has_text="Reset all preferences").click()
    page.wait_for_selector(".dialog--visible")
    page.click(".dialog--visible .dialog__button--danger")
    page.wait_for_timeout(500)
    state = page.evaluate("() => [settingsService.getCustomizedKeys().length, document.documentElement.dataset.theme, document.documentElement.dataset.wallpaper]")
    check("19 reset all restores every default + applies", state == [0, "dark", "aurora"], state)
    check("19 reset all keeps files", page.evaluate("async () => vfs.exists('/Documents')"))
    page.wait_for_timeout(300)
    page.reload(); wait_desktop(page)
    check("19 reset persisted", page.evaluate("() => JSON.parse(localStorage.getItem('browseros:settings')).values") == {})
    check("settings session: no console errors", not errors, errors)
    ctx.close()

    # 21 invalid stored settings + legacy explorer keys
    ctx, page, errors = new_page(browser, init_js="""
      localStorage.setItem('browseros:settings', JSON.stringify({ version: 2, values: {
        'startMenu.pinnedApps': 'calculator', 'desktop.iconSize': 'huge', 'fileExplorer.sortField': 5,
        'startMenu.recentFilesLimit': 999, 'desktop.showIcons': 'yes', 'keyboard.appShortcuts': null,
        'startMenu.searchResultLimit': 7 } }));""")
    state = page.evaluate("""() => [settingsService.get('startMenu.pinnedApps'), settingsService.get('desktop.iconSize'),
      settingsService.get('fileExplorer.sortField'), settingsService.get('startMenu.recentFilesLimit'), settingsService.get('desktop.showIcons'),
      settingsService.get('startMenu.searchResultLimit')]""")
    check("21 invalid stored values fall back, valid kept", state == [["browser", "code-studio", "notes", "calendar", "calculator", "clock", "file-explorer", "settings", "about", "recycle-bin"], "medium", "name", 10, True, 7], state)
    check("21 OS boots normally with invalid settings", page.locator(".desktop-icon").count() == 10 and not errors, errors)
    ctx.close()

    ctx, page, errors = new_page(browser, init_js="""
      localStorage.setItem('browseros:settings', JSON.stringify({ version: 1, values: { 'appearance.theme': 'light' } }));
      localStorage.setItem('browseros:explorer:viewMode', JSON.stringify('list'));
      localStorage.setItem('browseros:explorer:sort', JSON.stringify({ field: 'modified', direction: 'desc' }));""")
    st = page.evaluate("() => [JSON.parse(localStorage.getItem('browseros:settings')), localStorage.getItem('browseros:explorer:viewMode'), localStorage.getItem('browseros:explorer:sort')]")
    check("legacy Explorer preferences migrated into settings (v1 -> v2)", st[0]["version"] == 2 and st[0]["values"].get("fileExplorer.defaultView") == "list"
          and st[0]["values"].get("fileExplorer.sortField") == "modified" and st[0]["values"].get("appearance.theme") == "light" and st[1] is None and st[2] is None, st)
    ctx.close()

    # 24 many icons
    ctx, page, errors = new_page(browser)
    t0 = time.time()
    page.evaluate("async () => { for (let i = 0; i < 80; i++) await vfs.createFile(`/Desktop/file-${String(i).padStart(2,'0')}.txt`, ''); }")
    page.wait_for_timeout(500)
    created = time.time() - t0
    count = page.locator(".desktop-icon").count()
    overlap = page.evaluate("""() => { const seen = new Set(); for (const e of document.querySelectorAll('.desktop-icon')) { const k = e.style.left + ',' + e.style.top; if (seen.has(k)) return true; seen.add(k); } return false; }""")
    check("24 80 desktop files render without overlap", count == 90 and not overlap, (count, overlap))
    t1 = time.time()
    setv(page, "desktop.iconSize", "small")
    setv(page, "desktop.autoArrange", True)
    page.wait_for_timeout(500)
    overlap = page.evaluate("""() => { const seen = new Set(); for (const e of document.querySelectorAll('.desktop-icon')) { const k = e.style.left + ',' + e.style.top; if (seen.has(k)) return true; seen.add(k); } return false; }""")
    check("24 re-arranging 90 icons stays consistent", not overlap)
    page.mouse.move(1350, 40); page.mouse.down(); page.mouse.move(20, 840, steps=10); page.mouse.up()
    page.wait_for_timeout(200)
    sel = page.locator(".desktop-icon--selected").count()
    check("24 rectangle selection over many icons", sel == 90, sel)
    page.keyboard.press("Delete")
    page.wait_for_selector(".dialog--visible")
    check("24 delete many: one confirmation for multiple", "80 items" in page.inner_text(".dialog--visible"))
    page.click(".dialog--visible .dialog__button--danger")
    page.wait_for_timeout(2500)
    check("24 all 80 files moved to Trash, shortcuts protected", page.locator(".desktop-icon").count() == 10)
    page.evaluate("() => settingsService.set('desktop.autoArrange', false)")
    page.evaluate("async () => { for (let i = 0; i < 20; i++) await vfs.createFile(`/Desktop/zoom-${i}.txt`, ''); }")
    page.wait_for_timeout(400)
    stacked = """() => { const m = {}; for (const e of document.querySelectorAll('.desktop-icon')) { const k = e.style.left + ',' + e.style.top; m[k] = (m[k] || 0) + 1; } return Object.entries(m).filter(([, n]) => n > 1); }"""
    page.set_viewport_size({"width": 700, "height": 450})  # what zooming in to ~200% does to the CSS viewport
    page.wait_for_timeout(700)
    check("zoom in / shrink: no two icons share a grid cell", page.evaluate(stacked) == [], page.evaluate(stacked))
    page.set_viewport_size({"width": 1400, "height": 900})
    page.wait_for_timeout(700)
    check("zoom back out: still no stacked icons", page.evaluate(stacked) == [], page.evaluate(stacked))
    check("many-icons session: no console errors", not errors, errors)
    ctx.close()

    browser.close()

httpd.shutdown()
failed = [r for r in results if not r[1]]
print(f"\n{len(results) - len(failed)}/{len(results)} passed")
sys.exit(1 if failed else 0)
