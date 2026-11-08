"""End-to-end checks for Notes, Calculator, Calendar, Clock, Image Viewer, file
associations, and the shared dialogs and services they use.

Usage:  python tests/e2e/test_applications.py
"""
import sys, threading, functools, http.server, socketserver, os, json, struct, zlib, traceback
from datetime import datetime
from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import SITE_ROOT, output_dir, launch_options, wait_desktop  # noqa: E402

ROOT, SHOTS = SITE_ROOT, output_dir("applications")
FIXTURES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")
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


def section(fn):
    print(f"\n--- {fn.__name__}", flush=True)
    try:
        fn()
    except Exception as exc:  # keep going: one broken section must not hide the others
        traceback.print_exc()
        check(f"{fn.__name__} completed without exception", False, str(exc)[:300])


def make_png(path, w=4, h=3):
    rows = b"".join(b"\x00" + b"".join(bytes([(x * 60) % 256, (y * 80) % 256, 160]) for x in range(w)) for y in range(h))
    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)


os.makedirs(FIXTURES, exist_ok=True)
make_png(os.path.join(FIXTURES, "imported-photo.png"), 40, 30)
with open(os.path.join(FIXTURES, "readme-import.txt"), "w", encoding="utf-8") as f:
    f.write("Imported from the host\nline two")
with open(os.path.join(FIXTURES, "program.exe"), "wb") as f:
    f.write(b"MZ\x00\x00")

errors, bad_requests = [], []


def attach(page, tag=""):
    page.on("console", lambda m: errors.append(f"{tag}{m.type}: {m.text}") if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(f"{tag}pageerror: {e}"))
    page.on("response", lambda r: bad_requests.append((r.status, r.url)) if r.status >= 400 else None)


def boot(page):
    page.goto(URL)
    wait_desktop(page, samples=True)


def close_all(page):
    page.evaluate("() => { for (const b of document.querySelectorAll('.window .window__control--close')) b.click(); }")
    page.wait_for_timeout(500)
    for _ in range(4):
        if not page.locator(".dialog--visible").count():
            break
        page.keyboard.press("Escape")
        page.wait_for_timeout(300)
    if page.locator(".window").count():
        page.evaluate("() => { for (const b of document.querySelectorAll('.window .window__control--close')) b.click(); }")
        page.wait_for_timeout(500)


def win(page, app_class):
    return page.locator(f".window:has(.{app_class})")


with sync_playwright() as p:
    browser = p.chromium.launch(**launch_options())
    ctx = browser.new_context(viewport={"width": 1400, "height": 900})
    ctx.grant_permissions(["clipboard-read", "clipboard-write"], origin=f"http://127.0.0.1:{PORT}")
    page = ctx.new_page()
    attach(page)
    boot(page)

    # =================================================================
    def core_and_shell():
        labels = page.evaluate("() => [...document.querySelectorAll('.desktop-icon')].map(e => e.textContent.trim())")
        for name in ("About BrowserOS", "Calculator", "Notes", "File Explorer", "Terminal", "Calendar", "Clock", "Recycle Bin"):
            check(f"desktop shortcut: {name}", any(name in l for l in labels), labels)
        apps = page.evaluate("() => appManager.getRegisteredApps().map(a => [a.id, a.category, !!a.description])")
        ids = [a[0] for a in apps]
        for app_id in ("notes", "calculator", "calendar", "clock", "image-viewer"):
            check(f"registered: {app_id}", app_id in ids, ids)
        check("new apps carry description + category", all(a[1] and a[2] for a in apps if a[0] in ("notes", "calculator", "calendar", "clock", "image-viewer")), apps)

        page.click(".start-button"); page.wait_for_selector(".start-menu--visible"); page.wait_for_timeout(300)
        body = page.inner_text(".start-menu")
        check("Start Menu pins Calendar, Clock, Notes, Calculator", all(n in body for n in ("Calendar", "Clock", "Notes", "Calculator")), body[:300])
        page.keyboard.type("image")
        page.wait_for_timeout(400)
        found = page.inner_text(".start-menu")
        check("Start Menu search finds Image Viewer", "Image Viewer" in found, found[:300])
        page.keyboard.press("Escape"); page.wait_for_timeout(300)
        if page.locator(".start-menu--visible").count():
            page.keyboard.press("Escape"); page.wait_for_timeout(300)

        samples = page.evaluate("async () => (await vfs.list('/Pictures/Sample Pictures')).map(e => e.name).sort()")
        check("sample pictures seeded", samples == ["Aurora.png", "BrowserOS.svg", "Horizon.png", "Lagoon.png"], samples)

    # =================================================================
    def notes():
        page.evaluate("() => appManager.launch('notes')")
        page.wait_for_selector(".notes__item")
        page.wait_for_timeout(400)
        names = page.evaluate("async () => (await vfs.list('/Documents/Notes')).map(e => e.name)")
        check("Notes library folder with welcome note", "Welcome to Notes.note" in names, names)

        page.locator(".notes__sidebar .notes__button--primary", has_text="New note").click()
        page.wait_for_timeout(500)
        page.keyboard.type("Groceries")
        page.keyboard.press("Enter")
        page.wait_for_timeout(600)
        page.keyboard.type("Milk and bread")
        page.wait_for_timeout(1600)
        exists = page.evaluate("async () => vfs.exists('/Documents/Notes/Groceries.note')")
        check("new note renamed from title field", exists, page.evaluate("async () => (await vfs.list('/Documents/Notes')).map(e => e.name)"))
        doc = page.evaluate("async () => JSON.parse(await vfs.read('/Documents/Notes/Groceries.note'))")
        check("autosave writes .note JSON", doc.get("format") == "browseros-note" and "Milk and bread" in doc.get("html", ""), doc)
        status = page.inner_text(".notes__status")
        check("status shows Saved", "Saved" in status, status)

        # rich formatting through the shortcut catalog
        page.keyboard.press("Enter")
        page.keyboard.press("Control+b")
        page.keyboard.type("bold words")
        page.wait_for_timeout(1500)
        html = page.evaluate("async () => JSON.parse(await vfs.read('/Documents/Notes/Groceries.note')).html")
        check("Ctrl+B produces bold text", "<b>bold words</b>" in html or "<strong>bold words</strong>" in html, html)

        # search
        page.fill(".notes__search-input", "bread")
        page.wait_for_timeout(400)
        items = page.evaluate("() => [...document.querySelectorAll('.notes__item .notes__item-title')].map(e => e.textContent)")
        check("search filters notes by content", items == ["Groceries"], items)
        page.fill(".notes__search-input", "")
        page.wait_for_timeout(300)

        # sanitizer: hostile .note content never executes
        page.evaluate("""async () => {
          const html = '<p>safe</p><img src=x onerror="window.__xss=1"><script>window.__xss=2</script><a href="javascript:window.__xss=3">x</a><p onclick="window.__xss=4">p</p>';
          await vfs.createFile('/Documents/Notes/Hostile.note', JSON.stringify({ format: 'browseros-note', version: 1, html }));
        }""")
        page.wait_for_timeout(500)
        page.evaluate("async () => { const e = await vfs.getInfo('/Documents/Notes/Hostile.note'); await (await import('./src/core/vfs/vfsOpener.js')).openVfsEntry(e, { appManager }); }")
        page.wait_for_timeout(700)
        dom = page.evaluate("""() => { const ed = document.querySelector('.notes-editor__rich');
          return { img: ed.querySelectorAll('img,script').length, js: [...ed.querySelectorAll('a')].filter(a => (a.getAttribute('href')||'').startsWith('javascript')).length,
                   handlers: [...ed.querySelectorAll('*')].filter(el => [...el.attributes].some(a => a.name.startsWith('on'))).length, xss: window.__xss ?? null, text: ed.textContent }; }""")
        check("hostile note sanitized (no img/script/js links/handlers)", dom["img"] == 0 and dom["js"] == 0 and dom["handlers"] == 0 and dom["xss"] is None and "safe" in dom["text"], dom)

        # .txt via File Explorer double-click
        page.evaluate("async () => vfs.createFile('/Documents/todo.txt', 'buy stamps')")
        page.evaluate("() => appManager.launch('file-explorer', { path: '/Documents' })")
        page.wait_for_selector(".explorer__row")
        page.wait_for_timeout(400)
        page.locator(".window:has(.explorer) .explorer__row", has_text="todo.txt").dblclick()
        page.wait_for_timeout(800)
        plain = page.evaluate("() => { const t = document.querySelector('.notes-editor__plain'); return t && !t.closest('[hidden]') ? t.value : null; }")
        check("Explorer double-click opens .txt in Notes (plain text)", plain == "buy stamps", plain)
        check("Notes stays single-instance", win(page, "notes").count() == 1)
        page.locator(".notes-editor__plain").click()
        page.keyboard.press("End")
        page.keyboard.type(" and envelopes")
        page.keyboard.press("Control+s")
        page.wait_for_timeout(700)
        txt = page.evaluate("async () => vfs.read('/Documents/todo.txt')")
        check("Ctrl+S saves .txt as plain text", txt == "buy stamps and envelopes", txt)

        # Terminal open
        page.evaluate("() => appManager.launch('terminal')")
        page.wait_for_selector(".terminal__input")
        term = page.locator(".terminal__input").last
        term.fill("open /Documents/Notes/Groceries.note"); term.press("Enter")
        page.wait_for_timeout(800)
        title = page.input_value(".notes__title-input")
        check("Terminal `open` routes to Notes", title == "Groceries", title)
        term.fill("open /Documents/missing.txt"); term.press("Enter")
        page.wait_for_timeout(300)
        out = page.locator(".terminal__output").last.inner_text()
        check("Terminal `open` reports missing file", "missing.txt" in out.splitlines()[-1] or "No such" in out or "not found" in out.lower(), out[-200:])

        # external change: Notes picks up a file modified elsewhere
        page.evaluate("async () => vfs.write('/Documents/todo.txt', 'changed elsewhere')")
        page.evaluate("async () => { const e = await vfs.getInfo('/Documents/todo.txt'); await (await import('./src/core/vfs/vfsOpener.js')).openVfsEntry(e, { appManager }); }")
        page.wait_for_timeout(600)
        check("Notes reflects external file change", page.input_value(".notes-editor__plain") == "changed elsewhere", page.input_value(".notes-editor__plain"))

        # draft recovery after an unexpected reload (before autosave)
        page.evaluate("async () => { const e = await vfs.getInfo('/Documents/Notes/Groceries.note'); await (await import('./src/core/vfs/vfsOpener.js')).openVfsEntry(e, { appManager }); }")
        page.wait_for_timeout(500)
        page.locator(".notes-editor__rich").click()
        page.keyboard.press("Control+End")
        page.keyboard.type(" DRAFTED")
        page.wait_for_timeout(450)
        boot(page)
        page.evaluate("async () => { const e = await vfs.getInfo('/Documents/Notes/Groceries.note'); await (await import('./src/core/vfs/vfsOpener.js')).openVfsEntry(e, { appManager }); }")
        page.wait_for_timeout(800)
        banner = page.evaluate("() => { const b = document.querySelector('.notes__banner'); return b && !b.hidden ? b.textContent : ''; }")
        editor_text = page.inner_text(".notes-editor__rich")
        check("unsaved draft offered after reload", "unsaved changes" in banner and "DRAFTED" not in editor_text, (banner, editor_text[-80:]))
        page.locator(".notes__banner button", has_text="Restore").click()
        page.wait_for_timeout(1500)
        editor_text = page.inner_text(".notes-editor__rich")
        saved = page.evaluate("async () => JSON.parse(await vfs.read('/Documents/Notes/Groceries.note')).html")
        check("Restore brings back and saves the draft", "DRAFTED" in editor_text and "DRAFTED" in saved, (editor_text[-60:], saved[-80:]))
        page.wait_for_timeout(1500)
        check("persistence: note survives reload", "Milk and bread" in editor_text)

        # delete with confirmation
        page.evaluate("async () => { const e = await vfs.getInfo('/Documents/Notes/Hostile.note'); await (await import('./src/core/vfs/vfsOpener.js')).openVfsEntry(e, { appManager }); }")
        page.wait_for_timeout(500)
        page.click(".notes [aria-label='Delete note']")
        page.wait_for_selector(".dialog--visible")
        page.click(".dialog--visible .dialog__button--danger, .dialog--visible .dialog__button--primary")
        page.wait_for_timeout(700)
        check("delete note removes file", not page.evaluate("async () => vfs.exists('/Documents/Notes/Hostile.note')"))
        items = page.evaluate("() => [...document.querySelectorAll('.notes__item .notes__item-title')].map(e => e.textContent)")
        check("deleted note gone from list", "Hostile" not in items, items)
        page.screenshot(path=os.path.join(SHOTS, "notes.png"))
        close_all(page)

    # =================================================================
    def calculator():
        page.evaluate("() => appManager.launch('calculator')")
        page.wait_for_selector(".calculator")
        page.wait_for_timeout(300)
        calc = page.locator(".calculator").last
        for label in ("7", "Multiply", "8", "Equals"):
            calc.locator(f".calculator__key[aria-label='{label}']").click()
        result = lambda: calc.locator(".calculator__result").inner_text().strip()
        check("button input: 7 × 8 = 56", result() == "56", result())

        calc.focus()
        def typed(expr):
            page.keyboard.press("Escape")
            page.keyboard.type(expr)
            page.keyboard.press("Enter")
            page.wait_for_timeout(120)
            return result()
        check("keyboard: 2+3*4 = 14 (precedence)", typed("2+3*4") == "14", result())
        check("percent: 200+10% = 220", typed("200+10%") == "220", result())
        check("decimal: 0.1+0.2 = 0.3", typed("0.1+0.2") == "0.3", result())
        check("parentheses: (2+3)*(4-1) = 15", typed("(2+3)*(4-1)") == "15", result())
        r = typed("1/0")
        check("division by zero shows an error, not Infinity", r and "Infinity" not in r and r != "0", r)
        r = typed("2**")
        check("malformed input reports an error", r and not r.replace(".", "").isdigit(), r)
        page.keyboard.press("Escape")
        page.keyboard.type("12+")
        page.keyboard.press("Backspace")
        expr = calc.locator(".calculator__expression").inner_text().strip()
        check("Backspace removes last character", expr == "12", expr)

        # copy
        typed("6*7")
        page.keyboard.press("Control+c")
        page.wait_for_timeout(200)
        clip = page.evaluate("() => navigator.clipboard.readText()")
        check("Ctrl+C copies the result", clip == "42", clip)

        # scientific
        calc.locator(".calculator__mode", has_text="Scientific").click()
        page.wait_for_timeout(200)
        check("scientific mode shows function keys", calc.locator(".calculator__grid--scientific").is_visible())
        calc.focus()
        check("typed sin(30) in degrees = 0.5", typed("sin(30)") == "0.5", result())
        check("typed sqrt(16)+2^3 = 12", typed("sqrt(16)+2^3") == "12", result())
        check("factorial: 5! = 120", typed("5!") == "120", result())
        check("typed exp(0)x3 = 3 (x multiplies, exp keeps its x)", typed("exp(0)x3") == "3", result())
        check("ans recalls the previous result", typed("ans+1") == "4", result())
        page.keyboard.press("Escape")
        for label in ("Square root", "Open parenthesis", "9", "Close parenthesis", "Equals"):
            calc.locator(f".calculator__key[aria-label='{label}']").click()
        check("√ key: √(9) = 3", result() == "3", result())
        calc.locator(".calculator__key[aria-label^='Angle unit']").click()
        calc.focus()
        r = typed("cos(pi)")
        check("radians: cos(pi) = -1", r in ("-1", "−1"), r)
        r = typed("foo(2)")
        check("unknown name reported", "foo" in r or "nknown" in r, r)

        history = page.evaluate("() => JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k => k.endsWith('calculator:history'))) || '[]')")
        check("history persisted", isinstance(history, list) and len(history) >= 5, history if not isinstance(history, list) else len(history))
        prefs_key = page.evaluate("() => Object.keys(localStorage).filter(k => k.includes('calculator'))")
        check("calculator storage keys namespaced", any(k.endswith("calculator:preferences") for k in prefs_key), prefs_key)

        page.evaluate("() => appManager.launch('calculator')")
        page.wait_for_timeout(400)
        check("calculator allows multiple instances", win(page, "calculator").count() == 2)
        page.screenshot(path=os.path.join(SHOTS, "calculator.png"))
        close_all(page)

    # =================================================================
    def calendar():
        page.evaluate("() => appManager.launch('calendar')")
        page.wait_for_selector(".calendar-month")
        page.wait_for_timeout(300)
        now = page.evaluate("() => new Date().toLocaleDateString(undefined, { month: 'long', year: 'numeric' })")
        title = page.inner_text(".calendar__title")
        check("month view shows current month", title.lower() == now.lower(), (title, now))

        page.locator(".calendar button", has_text="New event").click()
        page.wait_for_selector(".dialog--visible")
        dlg = page.locator(".dialog--visible")
        dlg.get_by_label("Title").fill("Team sync")
        dlg.get_by_label("Start time").fill("10:00")
        dlg.get_by_label("End time").fill("11:00")
        dlg.get_by_label("Location").fill("Room 4")
        dlg.locator(".dialog__button--primary").click()
        page.wait_for_timeout(800)
        check("event dialog closes after save", page.locator(".dialog--visible").count() == 0)
        chip = page.locator(".calendar-month", has_text="Team sync")
        check("new event shown in month grid", chip.count() == 1)
        stored = page.evaluate("async () => JSON.parse(await vfs.read('/Documents/Calendar/events.json'))")
        events = stored.get("events", stored) if isinstance(stored, dict) else stored
        check("event persisted to /Documents/Calendar/events.json", any(e.get("title") == "Team sync" for e in events), stored)

        # validation: end before start
        page.locator(".calendar button", has_text="New event").click()
        page.wait_for_selector(".dialog--visible")
        dlg = page.locator(".dialog--visible")
        dlg.get_by_label("Title").fill("Backwards")
        dlg.get_by_label("Start time").fill("15:00")
        dlg.get_by_label("End time").fill("14:00")
        dlg.locator(".dialog__button--primary").click()
        page.wait_for_timeout(300)
        err = dlg.locator(".dialog__error").inner_text() if dlg.locator(".dialog__error").count() else ""
        check("invalid time range rejected with message", page.locator(".dialog--visible").count() == 1 and err.strip() != "", err)
        page.keyboard.press("Escape"); page.wait_for_timeout(300)

        # navigation
        page.click(".calendar [aria-label='Next']"); page.wait_for_timeout(200)
        t2 = page.inner_text(".calendar__title")
        page.click(".calendar [aria-label='Previous']"); page.click(".calendar [aria-label='Previous']"); page.wait_for_timeout(200)
        t3 = page.inner_text(".calendar__title")
        page.locator(".calendar button", has_text="Today").click(); page.wait_for_timeout(200)
        check("prev/next/today navigation", t2 != title and t3 != title and t3 != t2 and page.inner_text(".calendar__title") == title, (title, t2, t3))

        for view in ("Week", "Day"):
            page.locator(".calendar__view-button", has_text=view).click()
            page.wait_for_timeout(300)
            check(f"{view.lower()} view shows the event", page.locator(".calendar .calendar-grid__body", has_text="Team sync").count() >= 1)
        page.screenshot(path=os.path.join(SHOTS, "calendar-week-or-day.png"))
        page.locator(".calendar__view-button", has_text="Month").click()
        page.wait_for_timeout(200)

        # recurrence + exceptions through the service API
        occ = page.evaluate("""async () => {
          const ev = await calendarService.create({ title: 'Standup', allDay: false, start: '2026-01-05T09:00', end: '2026-01-05T09:15', recurrence: { freq: 'weekly', interval: 1, count: 4 } });
          const all = calendarService.getOccurrences(new Date(2026,0,1), new Date(2026,2,1)).filter(o => o.event.id === ev.id).map(o => o.start.getDate() + '/' + (o.start.getMonth()+1));
          await calendarService.excludeOccurrence(ev.id, '2026-01-12');
          const after = calendarService.getOccurrences(new Date(2026,0,1), new Date(2026,2,1)).filter(o => o.event.id === ev.id).length;
          return { all, after };
        }""")
        check("weekly recurrence with count expands 4 occurrences", occ["all"] == ["5/1", "12/1", "19/1", "26/1"], occ)
        check("excluding one occurrence leaves 3", occ["after"] == 3, occ)
        monthly = page.evaluate("""async () => {
          const ev = await calendarService.create({ title: 'Rent', allDay: true, start: '2026-01-31', end: '2026-01-31', recurrence: { freq: 'monthly', interval: 1, count: 4 } });
          return calendarService.getOccurrences(new Date(2026,0,1), new Date(2026,7,1)).filter(o => o.event.id === ev.id).map(o => o.start.getMonth()+1 + '/' + o.start.getDate());
        }""")
        check("monthly recurrence on the 31st skips short months", monthly == ["1/31", "3/31", "5/31", "7/31"], monthly)

        # search
        page.fill(".calendar__search-input", "team")
        page.wait_for_timeout(400)
        res = page.evaluate("() => [...document.querySelectorAll('.calendar__search-result')].map(e => e.textContent)")
        check("search finds the event", len(res) == 1 and "Team sync" in res[0], res)
        page.locator(".calendar__search-result").first.click()
        page.wait_for_timeout(400)
        details = page.evaluate("() => { const d = document.querySelector('.calendar__details'); return d && !d.hidden ? d.textContent : ''; }")
        check("search result opens event details", "Team sync" in details and "Room 4" in details, details[:200])

        # edit through the service updates the open view
        page.evaluate("async () => { const ev = calendarService.search('Team sync')[0]; await calendarService.update((ev.event ?? ev).id, { title: 'Team sync (moved)' }); }")
        page.wait_for_timeout(400)
        check("service update re-renders the calendar", page.locator(".calendar-month", has_text="Team sync (moved)").count() == 1)

        # persistence across reload, then removal
        boot(page)
        page.evaluate("async () => { await calendarService.ready(); }")
        titles = page.evaluate("() => calendarService.getEvents().map(e => e.title)")
        check("events persist across reload", "Team sync (moved)" in titles and "Standup" in titles, titles)
        page.evaluate("async () => { for (const e of calendarService.getEvents()) if (e.title === 'Standup' || e.title === 'Rent') await calendarService.remove(e.id); }")
        titles = page.evaluate("async () => JSON.parse(await vfs.read('/Documents/Calendar/events.json'))")
        titles = [e["title"] for e in (titles.get("events", titles) if isinstance(titles, dict) else titles)]
        check("removed events deleted from file", "Standup" not in titles and "Rent" not in titles, titles)

        # deep link: launch to a date
        page.evaluate("() => appManager.launch('calendar', { date: '2027-03-15' })")
        page.wait_for_timeout(500)
        t = page.inner_text(".calendar__title")
        check("launch option {date} navigates", "2027" in t and ("March" in t or "Mar" in t), t)
        close_all(page)

        # corrupt file: quarantined, app still usable
        page.evaluate("async () => vfs.write('/Documents/Calendar/events.json', '{ not json')")
        boot(page)
        page.evaluate("async () => { await calendarService.ready(); }")
        err = page.evaluate("() => calendarService.getLoadError()")
        files = page.evaluate("async () => (await vfs.list('/Documents/Calendar')).map(e => e.name)")
        page.evaluate("() => appManager.launch('calendar')")
        page.wait_for_selector(".calendar-month"); page.wait_for_timeout(300)
        banner = page.evaluate("() => { const b = document.querySelector('.calendar__banner'); return b && !b.hidden ? b.textContent : ''; }")
        check("unreadable calendar file reported and kept aside", err is not None and any("unreadable" in f for f in files) and banner != "", (err, files, banner))
        page.evaluate("async () => calendarService.create({ title: 'After recovery', allDay: true, start: '2026-11-20', end: '2026-11-20' })")
        page.wait_for_timeout(300)
        recovered = page.evaluate("async () => JSON.parse(await vfs.read('/Documents/Calendar/events.json'))")
        recovered = recovered.get("events", recovered) if isinstance(recovered, dict) else recovered
        check("calendar writable again after quarantine", any(e["title"] == "After recovery" for e in recovered), recovered)
        close_all(page)

    # =================================================================
    def clock():
        page.evaluate("() => appManager.launch('clock')")
        page.wait_for_selector(".clock-app")
        page.wait_for_timeout(300)
        box = page.locator(".clock-app").bounding_box()
        body = page.locator(".window:has(.clock-app) .window__body").bounding_box()
        check("clock layout fills the window", abs(box["width"] - body["width"]) < 2 and abs(box["x"] - body["x"]) < 2, (box, body))
        page.fill(".clock-app__input", "Paris")
        page.wait_for_timeout(300)
        page.locator(".clock-app__suggestion", has_text="Paris").first.click()
        page.wait_for_timeout(300)
        rows = page.evaluate("() => [...document.querySelectorAll('.clock-app__row-title')].map(e => e.textContent)")
        check("world clock: add city", "Paris" in rows, rows)
        paris_time = page.locator(".clock-app__row", has_text="Paris").locator(".clock-app__row-time").inner_text()
        expected = page.evaluate("() => new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Europe/Paris' }).format(new Date())")
        check("world clock shows correct zone time", paris_time.strip() == expected, (paris_time, expected))

        # stopwatch
        page.locator(".clock-app__tab", has_text="Stopwatch").click()
        page.wait_for_timeout(200)
        page.locator(".clock-app button", has_text="Start").click()
        page.wait_for_timeout(1100)
        page.locator(".clock-app button", has_text="Lap").click()
        page.wait_for_timeout(400)
        page.locator(".clock-app button", has_text="Pause").click()
        sw = page.evaluate("() => clockService.getStopwatch()")
        check("stopwatch measures elapsed time", 1400 <= sw["elapsedMs"] <= 1900 and len(sw["laps"]) == 1 and not sw["running"], sw)
        page.locator(".clock-app button", has_text="Resume").click()
        page.wait_for_timeout(300)
        boot(page)
        page.wait_for_timeout(700)
        sw2 = page.evaluate("() => clockService.getStopwatch()")
        check("running stopwatch survives reload (timestamp based)", sw2["running"] and sw2["elapsedMs"] >= sw["elapsedMs"] + 1000, (sw, sw2))
        page.evaluate("() => clockService.resetStopwatch()")

        # timer (short, real time)
        page.evaluate("() => appManager.launch('clock', { tab: 'timer' })")
        page.wait_for_selector(".clock-app")
        page.evaluate("() => clockService.startTimer(2000)")
        page.wait_for_timeout(2900)
        toast = page.locator(".notification", has_text="Timer finished")
        check("timer completion raises a notification", toast.count() == 1)
        check("timer state finished", page.evaluate("() => clockService.getTimer().status") == "finished")
        if toast.count():
            toast.locator(".notification__action", has_text="Dismiss").click()
            page.wait_for_timeout(400)
        check("notification dismissed by action", page.locator(".notification", has_text="Timer finished").count() == 0)

        # timer pause keeps remaining time
        page.evaluate("() => clockService.startTimer(60000)")
        page.wait_for_timeout(500)
        page.evaluate("() => clockService.pauseTimer()")
        rem1 = page.evaluate("() => clockService.getTimer().remainingMs")
        page.wait_for_timeout(600)
        rem2 = page.evaluate("() => clockService.getTimer().remainingMs")
        check("paused timer does not count down", rem1 == rem2 and 58000 < rem1 < 60000, (rem1, rem2))
        page.evaluate("() => clockService.resetTimer()")

        # alarm via UI dialog
        page.locator(".clock-app__tab", has_text="Alarms").click()
        page.wait_for_timeout(200)
        page.locator(".clock-app button", has_text="Add alarm").click()
        page.wait_for_selector(".dialog--visible")
        page.locator(".dialog--visible input[type='time']").fill("07:30")
        page.locator(".dialog--visible").get_by_label("Label").fill("Gym")
        page.locator(".dialog--visible .dialog__button--primary").click()
        page.wait_for_timeout(400)
        alarms = page.evaluate("() => clockService.getAlarms().map(a => [a.time, a.label, a.enabled])")
        check("alarm created from dialog", ["07:30", "Gym", True] in alarms, alarms)
        page.locator(".clock-app__row", has_text="Gym").locator(".clock-app__switch").click()
        page.wait_for_timeout(200)
        check("alarm toggle disables", page.evaluate("() => clockService.getAlarms().find(a => a.label === 'Gym').enabled") is False)
        page.screenshot(path=os.path.join(SHOTS, "clock-alarms.png"))
        page.evaluate("() => { for (const a of clockService.getAlarms()) clockService.removeAlarm(a.id); }")
        close_all(page)

    # =================================================================
    def image_viewer():
        page.evaluate("() => appManager.launch('file-explorer', { path: '/Pictures/Sample Pictures' })")
        page.wait_for_selector(".explorer__row")
        page.wait_for_timeout(400)
        page.locator(".window:has(.explorer) .explorer__row", has_text="Aurora.png").dblclick()
        page.wait_for_selector(".viewer__image")
        page.wait_for_timeout(700)
        vw = page.locator(".viewer").last
        st = vw.locator(".viewer__status").inner_text()
        check("Explorer double-click opens PNG in Image Viewer", "Aurora.png" in st and "960" in st and "1 of 4" in st, st)
        natural = page.evaluate("() => document.querySelector('.viewer__image').naturalWidth")
        check("image decoded from VFS Blob", natural == 960, natural)

        zl = lambda: vw.locator(".viewer__zoom-label").inner_text().strip()
        fit = zl()
        vw.locator("[aria-label='Zoom in']").click(); page.wait_for_timeout(150)
        z_in = zl()
        vw.locator("[aria-label='Actual size']").click(); page.wait_for_timeout(150)
        actual = zl()
        vw.locator("[aria-label='Fit to window']").click(); page.wait_for_timeout(150)
        check("zoom in / actual size / fit", z_in != fit and actual == "100%" and zl() == fit, (fit, z_in, actual, zl()))
        before = page.evaluate("async () => { const b = await vfs.readBinary('/Pictures/Sample Pictures/Aurora.png'); return b.size; }")
        vw.focus()
        page.keyboard.press("r")
        page.wait_for_timeout(200)
        tr = page.evaluate("() => document.querySelector('.viewer__image').style.transform")
        after = page.evaluate("async () => { const b = await vfs.readBinary('/Pictures/Sample Pictures/Aurora.png'); return b.size; }")
        check("rotate via keyboard (R) is view-only", "rotate(90deg)" in tr and before == after, (tr, before, after))
        page.keyboard.press("Home"); page.wait_for_timeout(150)
        check("reset view", "rotate(0deg)" in page.evaluate("() => document.querySelector('.viewer__image').style.transform"))
        page.keyboard.press("ArrowRight"); page.wait_for_timeout(600)
        st2 = vw.locator(".viewer__status").inner_text()
        page.keyboard.press("ArrowLeft"); page.wait_for_timeout(600)
        st3 = vw.locator(".viewer__status").inner_text()
        check("next/previous in folder", "2 of 4" in st2 and "Aurora.png" in st3, (st2, st3))
        check("one viewer window per file opened", page.locator(".window:has(.viewer)").count() == 1)

        # SVG renders through <img>, scripts never run
        page.evaluate("""async () => vfs.createFile('/Pictures/evil.svg', '<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\" onload=\"parent.__svgxss=1\"><script>parent.__svgxss=2</script><rect width=\"20\" height=\"20\" fill=\"red\"/></svg>')""")
        page.evaluate("async () => { const e = await vfs.getInfo('/Pictures/evil.svg'); await (await import('./src/core/vfs/vfsOpener.js')).openVfsEntry(e, { appManager }); }")
        page.wait_for_timeout(800)
        svg = page.evaluate("() => ({ xss: window.__svgxss ?? null, inline: document.querySelectorAll('.viewer svg').length, w: [...document.querySelectorAll('.viewer__image')].map(i => i.naturalWidth) })")
        check("SVG displayed without executing scripts", svg["xss"] is None and svg["inline"] == 0 and 20 in svg["w"], svg)

        # other formats generated in the page, stored as binary
        fmts = page.evaluate("""async () => {
          const c = document.createElement('canvas'); c.width = 30; c.height = 20; const g = c.getContext('2d'); g.fillStyle = '#3a6'; g.fillRect(0,0,30,20);
          const out = {};
          for (const [ext, type] of [['jpg','image/jpeg'], ['webp','image/webp']]) {
            const blob = await new Promise(r => c.toBlob(r, type));
            await vfs.createFile('/Pictures/gen.' + ext, blob);
            const e = await vfs.getInfo('/Pictures/gen.' + ext);
            out[ext] = { stored: (await vfs.readBinary('/Pictures/gen.' + ext)).type, size: e.size };
          }
          const gif = Uint8Array.from(atob('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw=='), ch => ch.charCodeAt(0));
          await vfs.createFile('/Pictures/dot.gif', new Blob([gif], { type: 'image/gif' }));
          return out; }""")
        check("JPEG/WebP stored as typed blobs", fmts["jpg"]["stored"] == "image/jpeg" and fmts["webp"]["stored"] == "image/webp", fmts)
        for name, w in (("gen.jpg", 30), ("gen.webp", 30), ("dot.gif", 1)):
            page.evaluate(f"async () => {{ const e = await vfs.getInfo('/Pictures/{name}'); await (await import('./src/core/vfs/vfsOpener.js')).openVfsEntry(e, {{ appManager }}); }}")
            page.wait_for_timeout(700)
            ok = page.evaluate(f"() => [...document.querySelectorAll('.viewer')].some(v => v.querySelector('.viewer__name')?.textContent === '{name}' && v.querySelector('.viewer__image')?.naturalWidth === {w})")
            check(f"viewer decodes {name}", ok)

        # corrupt image
        page.evaluate("async () => vfs.createFile('/Pictures/broken.png', new Blob(['not an image'], { type: 'image/png' }))")
        page.evaluate("async () => { const e = await vfs.getInfo('/Pictures/broken.png'); await (await import('./src/core/vfs/vfsOpener.js')).openVfsEntry(e, { appManager }); }")
        page.wait_for_timeout(800)
        msg = page.evaluate("() => [...document.querySelectorAll('.viewer__message')].filter(m => !m.hidden && m.offsetParent).map(m => m.textContent)")
        check("corrupt image shows an error message", any(m.strip() for m in msg), msg)
        page.screenshot(path=os.path.join(SHOTS, "viewer-error.png"))
        close_all(page)

        # import host files through File Explorer
        page.evaluate("() => appManager.launch('file-explorer', { path: '/Pictures' })")
        page.wait_for_selector(".explorer__row")
        page.wait_for_timeout(300)
        page.locator(".window:has(.explorer) .explorer__import-input").set_input_files([
            os.path.join(FIXTURES, "imported-photo.png"), os.path.join(FIXTURES, "readme-import.txt"), os.path.join(FIXTURES, "program.exe")])
        page.wait_for_timeout(1200)
        imp = page.evaluate("""async () => { const out = {};
          for (const n of ['imported-photo.png','readme-import.txt','program.exe']) out[n] = await vfs.exists('/Pictures/' + n);
          out.blob = (await vfs.readBinary('/Pictures/imported-photo.png')).size; out.text = await vfs.read('/Pictures/readme-import.txt'); return out; }""")
        check("import copies supported files into the VFS", imp["imported-photo.png"] and imp["readme-import.txt"] and imp["text"].startswith("Imported"), imp)
        check("import skips unsupported types", not imp["program.exe"], imp)
        dlg = page.locator(".dialog--visible")
        check("skipped files reported in a dialog", dlg.count() == 1 and "program.exe" in dlg.inner_text(), dlg.inner_text() if dlg.count() else "")
        if dlg.count():
            dlg.locator(".dialog__button").first.click(); page.wait_for_timeout(300)
        page.locator(".window:has(.explorer) .explorer__row", has_text="imported-photo.png").dblclick()
        page.wait_for_timeout(800)
        check("imported PNG opens in viewer", page.evaluate("() => [...document.querySelectorAll('.viewer__image')].some(i => i.naturalWidth === 40)"))
        close_all(page)

    # =================================================================
    def associations():
        page.evaluate("async () => { await vfs.createFile('/Documents/plan.md', '# Plan'); await vfs.createFile('/Documents/data.xyz', 'raw'); }")
        page.evaluate("() => appManager.launch('file-explorer', { path: '/Documents' })")
        page.wait_for_selector(".explorer__row")
        page.wait_for_timeout(400)
        page.locator(".window:has(.explorer) .explorer__row", has_text="plan.md").click(button="right")
        page.wait_for_selector(".context-menu--visible")
        page.locator(".context-menu--visible .context-menu__item", has_text="Open with").click()
        page.wait_for_timeout(400)
        items = page.evaluate("() => [...document.querySelectorAll('.context-menu--visible .context-menu__item')].map(e => e.textContent.trim())")
        check("Explorer 'Open with' lists Notes (default)", any("Notes (default)" in i for i in items), items)
        page.keyboard.press("Escape"); page.keyboard.press("Escape"); page.wait_for_timeout(300)

        events = page.evaluate("""async () => { const { eventBus } = await import('./src/core/eventBus.js'); const seen = [];
          const off = eventBus.on('application:fileOpened', (e) => seen.push(e.appId + ':' + e.path));
          const e = await vfs.getInfo('/Documents/plan.md'); await (await import('./src/core/vfs/vfsOpener.js')).openVfsEntry(e, { appManager });
          if (typeof off === 'function') off(); return seen; }""")
        check("application:fileOpened emitted", events == ["notes:/Documents/plan.md"], events)
        page.wait_for_timeout(500)
        check(".md opens in Notes", page.input_value(".notes__title-input") == "plan.md" or "plan" in page.input_value(".notes__title-input"), page.input_value(".notes__title-input"))

        page.locator(".window:has(.notes) .window__control--close").click()
        page.wait_for_timeout(500)
        page.locator(".window:has(.explorer) .explorer__row", has_text="data.xyz").dblclick()
        page.wait_for_timeout(500)
        dlg = page.locator(".dialog--visible")
        check("unassociated file shows properties", dlg.count() == 1 and "No application" in dlg.inner_text(), dlg.inner_text() if dlg.count() else "")
        if dlg.count():
            page.keyboard.press("Escape"); page.wait_for_timeout(300)
        close_all(page)

        # Desktop: image file icon + double-click + Open with
        page.evaluate("async () => { const b = await vfs.readBinary('/Pictures/Sample Pictures/Lagoon.png'); await vfs.createFile('/Desktop/lagoon-copy.png', b); }")
        page.wait_for_timeout(500)
        ic = page.locator(".desktop-icon", has_text="lagoon-copy.png")
        check("image file appears on Desktop with image icon", ic.count() == 1 and ic.locator("svg[data-icon='image']").count() == 1, ic.inner_html() if ic.count() else "")
        ic.dblclick()
        page.wait_for_timeout(800)
        check("Desktop double-click opens image viewer", page.locator(".viewer__name", has_text="lagoon-copy.png").count() == 1)
        close_all(page)
        ic.click(button="right")
        page.wait_for_selector(".context-menu--visible")
        page.locator(".context-menu--visible .context-menu__item", has_text="Open with").click()
        page.wait_for_timeout(400)
        items = page.evaluate("() => [...document.querySelectorAll('.context-menu--visible .context-menu__item')].map(e => e.textContent.trim())")
        check("Desktop 'Open with' lists Image Viewer (default)", any("Image Viewer (default)" in i for i in items), items)
        page.keyboard.press("Escape"); page.keyboard.press("Escape"); page.wait_for_timeout(300)

        # Terminal open → image viewer; recent files
        page.evaluate("() => appManager.launch('terminal')")
        page.wait_for_selector(".terminal__input")
        term = page.locator(".terminal__input").last
        term.fill("cd '/Pictures/Sample Pictures'"); term.press("Enter"); page.wait_for_timeout(150)
        term.fill("open Horizon.png"); term.press("Enter")
        page.wait_for_timeout(900)
        check("Terminal `open` routes images to Image Viewer", page.locator(".viewer__name", has_text="Horizon.png").count() == 1, page.locator(".terminal__output").last.inner_text()[-200:])
        close_all(page)
        page.click(".start-button"); page.wait_for_selector(".start-menu--visible"); page.wait_for_timeout(300)
        recent = page.inner_text(".start-menu")
        check("opened files listed in Recent Files", "Horizon.png" in recent, recent[:400])
        page.keyboard.press("Escape"); page.wait_for_timeout(300)

        # runtime registration of a new association
        page.evaluate("() => fileAssociations.register({ appId: 'notes', label: 'Notes', extensions: ['nfo'] })")
        page.evaluate("async () => { await vfs.createFile('/Documents/app.nfo', 'line'); const e = await vfs.getInfo('/Documents/app.nfo'); await (await import('./src/core/vfs/vfsOpener.js')).openVfsEntry(e, { appManager }); }")
        page.wait_for_timeout(700)
        check("runtime-registered association opens", win(page, "notes").count() == 1)
        close_all(page)

    # =================================================================
    def notifications():
        page.evaluate("() => { for (let i = 1; i <= 6; i += 1) notificationService.notify({ title: 'N' + i, body: 'b', timeout: 0 }); }")
        page.wait_for_timeout(400)
        titles = page.evaluate("() => [...document.querySelectorAll('.notification__title')].map(e => e.textContent)")
        check("notification stack limited to 4 newest", titles and len(titles) == 4 and "N6" in titles and "N1" not in titles, titles)
        page.locator(".notification", has_text="N6").locator(".notification__close").click()
        page.wait_for_timeout(400)
        check("notification close button dismisses", page.locator(".notification", has_text="N6").count() == 0)
        page.evaluate("() => { for (const id of notificationService.getActiveIds()) notificationService.dismiss(id); }")
        page.mouse.move(700, 300)
        page.evaluate("() => notificationService.notify({ title: 'Short', timeout: 600 })")
        page.wait_for_timeout(1200)
        check("notification auto-dismisses after timeout", page.locator(".notification", has_text="Short").count() == 0)
        role = page.evaluate("() => { notificationService.notify({ title: 'Urgent', urgency: 'alarm' }); return document.querySelector('.notification--alarm').getAttribute('role'); }")
        check("alarm notifications announced assertively", role in ("alertdialog", "alert"), role)
        page.evaluate("() => { for (const id of notificationService.getActiveIds()) notificationService.dismiss(id); }")
        page.wait_for_timeout(300)

    # =================================================================
    def theming_and_lifecycle():
        for app in ("notes", "calculator", "calendar", "clock"):
            page.evaluate(f"() => appManager.launch('{app}')")
            page.wait_for_timeout(400)
        page.evaluate("async () => { const e = await vfs.getInfo('/Pictures/Sample Pictures/Aurora.png'); await (await import('./src/core/vfs/vfsOpener.js')).openVfsEntry(e, { appManager }); }")
        page.wait_for_timeout(600)
        sels = [".notes", ".calculator", ".calendar", ".clock-app", ".viewer"]
        probe = "(sels) => Object.fromEntries(sels.map(s => { const el = document.querySelector(s); return [s, el ? getComputedStyle(el).color + ' / ' + getComputedStyle(el).backgroundColor : null]; }))"
        dark = page.evaluate(probe, sels)
        page.evaluate("() => { settingsService.set('appearance.theme', 'light'); settingsService.set('appearance.accentColor', 'rose'); }")
        page.wait_for_timeout(500)
        light = page.evaluate(probe, sels)
        for s in sels:
            check(f"theme change restyles {s}", dark[s] is not None and dark[s] != light[s], (dark[s], light[s]))
        page.screenshot(path=os.path.join(SHOTS, "light-all-apps.png"))
        accent = page.evaluate("() => getComputedStyle(document.querySelector('.calculator__key--equals') || document.body).backgroundColor")
        check("accent color applied to app controls", "rgb" in accent, accent)
        page.evaluate("() => settingsService.resetCategory('appearance')")
        page.wait_for_timeout(300)

        before = page.evaluate("() => appManager.getRunningApps ? appManager.getRunningApps().length : document.querySelectorAll('.window').length")
        close_all(page)
        page.wait_for_timeout(400)
        check("all windows close cleanly", page.locator(".window").count() == 0, before)
        url_count = page.evaluate("() => performance.getEntriesByType('resource').filter(r => r.name.startsWith('blob:')).length")
        # object URLs are revoked on close: fetching one must fail (the expected
        # "Failed to load resource" console message from this probe is discarded)
        errors_before = len(errors)
        revoked = page.evaluate("""async () => { const e = await vfs.getInfo('/Pictures/Sample Pictures/Lagoon.png');
          await (await import('./src/core/vfs/vfsOpener.js')).openVfsEntry(e, { appManager });
          await new Promise(r => setTimeout(r, 600));
          const src = document.querySelector('.viewer__image').src;
          document.querySelector('.window:has(.viewer) .window__control--close').click();
          await new Promise(r => setTimeout(r, 600));
          try { await fetch(src); return false; } catch { return true; } }""")
        page.wait_for_timeout(200)
        del errors[errors_before:]
        check("viewer revokes object URL on close", revoked, url_count)

    for fn in (core_and_shell, notes, calculator, calendar, clock, image_viewer, associations, notifications, theming_and_lifecycle):
        section(fn)

    # =================================================================
    # Time-dependent behaviour with a controlled clock
    def timed_alarm_and_reminders():
        tctx = browser.new_context(viewport={"width": 1400, "height": 900})
        tp = tctx.new_page()
        attach(tp, "[timed] ")
        tp.clock.install(time=datetime(2026, 11, 6, 9, 59, 0))
        boot(tp)
        tp.evaluate("() => clockService.addAlarm({ time: '10:00', label: 'Wake up' })")
        tp.evaluate("async () => { await calendarService.ready(); await calendarService.create({ title: 'Design review', allDay: false, start: '2026-11-06T10:15', end: '2026-11-06T11:00', reminder: 10 }); }")
        tp.clock.run_for(70_000)
        tp.wait_for_timeout(300)
        alarm = tp.locator(".notification", has_text="Wake up")
        check("alarm rings at its time", alarm.count() == 1 and "notification--alarm" in (alarm.get_attribute("class") or ""))
        tp.screenshot(path=os.path.join(SHOTS, "timed-alarm.png"))
        alarm.locator(".notification__action", has_text="Snooze").click()
        tp.wait_for_timeout(300)
        check("snooze dismisses the alarm", tp.locator(".notification", has_text="Wake up").count() == 0)
        tp.clock.run_for(5 * 60_000 + 5_000)
        tp.wait_for_timeout(300)
        check("snoozed alarm rings again after 5 minutes", tp.locator(".notification", has_text="Wake up").count() == 1)
        rem = tp.locator(".notification", has_text="Design review")
        check("calendar reminder fires 10 minutes before", rem.count() == 1, tp.evaluate("() => [...document.querySelectorAll('.notification__title')].map(e => e.textContent)"))
        tp.locator(".notification", has_text="Wake up").locator(".notification__action", has_text="Dismiss").click()
        tp.wait_for_timeout(200)
        one_time = tp.evaluate("() => clockService.getAlarms().find(a => a.label === 'Wake up')")
        check("one-time alarm disables itself after ringing", one_time and one_time["enabled"] is False, one_time)

        # reminder fired once only, even after reload
        fired_before = tp.evaluate("() => Object.keys(JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k => k.endsWith('calendar:firedReminders'))) || '{}')).length")
        check("fired reminder remembered", fired_before >= 1, fired_before)

        # missed alarm: BrowserOS "closed" while it was due
        tp.evaluate("() => clockService.addAlarm({ time: '10:30', label: 'Missed one' })")
        state = tctx.storage_state(indexed_db=True)
        tctx.close()
        mctx = browser.new_context(viewport={"width": 1400, "height": 900}, storage_state=state)
        mp = mctx.new_page()
        attach(mp, "[missed] ")
        mp.clock.install(time=datetime(2026, 11, 6, 11, 30, 0))
        boot(mp)
        mp.wait_for_timeout(500)
        missed = mp.locator(".notification", has_text="Missed alarm: Missed one")
        check("missed alarm reported on next start", missed.count() == 1, mp.evaluate("() => [...document.querySelectorAll('.notification__title')].map(e => e.textContent)"))
        check("reminder not replayed after restart", mp.locator(".notification", has_text="Design review").count() == 0)
        mctx.close()

    section(timed_alarm_and_reminders)

    real_errors = [e for e in errors if "404" not in e and "favicon" not in e]
    check("no console errors", not real_errors, real_errors)
    non_favicon = [r for r in bad_requests if not r[1].endswith("/favicon.ico") and "fonts.g" not in r[1]]
    check("no failed requests (except favicon)", not non_favicon, non_favicon)
    browser.close()

httpd.shutdown()
failed = [r for r in results if not r[1]]
print(f"\n{len(results) - len(failed)}/{len(results)} passed")
for name, ok in results:
    if not ok:
        print("  FAILED:", name)
sys.exit(1 if failed else 0)
