"""End-to-end checks for the system shell: tray, Notification Center, Quick Settings, the
date panel, Task Manager, and background services.

Usage:  python tests/e2e/test_system_shell.py
"""
import sys, threading, functools, http.server, socketserver, os, traceback
from datetime import datetime
from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import SITE_ROOT, output_dir, launch_options, wait_desktop  # noqa: E402

ROOT, SHOTS = SITE_ROOT, output_dir("system-shell")
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
errors, bad_requests = [], []


def check(name, cond, detail=""):
    results.append((name, bool(cond)))
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if not cond and detail != "" else ""), flush=True)


def section(fn):
    print(f"\n--- {fn.__name__}", flush=True)
    try:
        fn()
    except Exception as exc:
        traceback.print_exc()
        check(f"{fn.__name__} completed without exception", False, str(exc)[:300])


def attach(page, tag=""):
    page.on("console", lambda m: errors.append(f"{tag}{m.type}: {m.text}") if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(f"{tag}pageerror: {e}"))
    page.on("response", lambda r: bad_requests.append((r.status, r.url)) if r.status >= 400 else None)


def boot(page):
    page.goto(URL)
    wait_desktop(page, samples=True)


def close_all(page):
    page.evaluate("() => trayManager.closePanels()")
    for _ in range(4):
        if not page.locator(".dialog--visible").count():
            break
        page.keyboard.press("Escape")
        page.wait_for_timeout(250)
    page.evaluate("() => { for (const b of document.querySelectorAll('.window .window__control--close')) b.click(); }")
    page.wait_for_timeout(600)


def clear_notifications(page):
    page.evaluate("() => { settingsService.set('notifications.doNotDisturb', false); notificationService.dismissAll(); notificationService.clearHistory(); }")
    page.wait_for_timeout(300)


with sync_playwright() as p:
    browser = p.chromium.launch(**launch_options())
    ctx = browser.new_context(viewport={"width": 1400, "height": 900})
    page = ctx.new_page()
    attach(page)
    boot(page)

    # =================================================================
    def icons():
        info = page.evaluate("""() => { const icon = [...document.querySelectorAll('.desktop-icon')].find(e => e.textContent.includes('Clock'));
          const svg = icon.querySelector('svg.os-icon'); return { svg: !!svg, name: svg?.dataset.icon, color: svg ? getComputedStyle(svg).stroke : null }; }""")
        check("Clock desktop icon is the built-in line icon", info["svg"] and info["name"] == "clock", info)
        page.evaluate("() => appManager.launch('clock')")
        page.wait_for_timeout(600)
        title_icon = page.evaluate("() => document.querySelector('.window:has(.clock-app) .window__icon svg')?.dataset.icon ?? null")
        check("Clock window titlebar uses the line icon", title_icon == "clock", title_icon)
        task_icon = page.evaluate("() => document.querySelector('.taskbar-window-button[data-app-id=\"clock\"] svg')?.dataset.icon ?? null")
        check("Clock taskbar button uses the line icon", task_icon == "clock", task_icon)
        page.click(".start-button"); page.wait_for_timeout(400)
        start_icon = page.evaluate("() => [...document.querySelectorAll('.start-menu__pinned-label')].find(e => e.textContent === 'Clock')?.parentElement.querySelector('svg')?.dataset.icon ?? null")
        check("Start Menu Clock tile uses the line icon", start_icon == "clock", start_icon)
        page.keyboard.press("Escape"); page.wait_for_timeout(300)
        emoji = page.evaluate("() => document.body.innerText.includes('\\u23f0')")
        check("no alarm-clock emoji anywhere in the shell", not emoji)
        sizes = page.evaluate("""() => [...document.querySelectorAll('.desktop-icon__glyph')].map(g => { const r = (g.querySelector('svg') ?? g).getBoundingClientRect(); return [g.textContent.trim() || 'svg', Math.round(r.height)]; })""")
        check("line icon height is in line with glyph icons", all(h > 0 for _, h in sizes), sizes)
        close_all(page)

    # =================================================================
    def services():
        svc = page.evaluate("() => serviceManager.getServices().map(s => [s.id, s.status, s.startCount])")
        ids = [s[0] for s in svc]
        check("seven services registered", ids == ["notifications", "system-clock", "calendar-reminders", "clock-alarms", "app-monitor", "storage-monitor", "downloads"], ids)
        check("all services running, started once", all(s[1] == "running" and s[2] == 1 for s in svc), svc)
        dup = page.evaluate("() => { try { serviceManager.register({ id: 'notifications', start(){}, stop(){} }); return 'no'; } catch (e) { return e.message; } }")
        check("duplicate service registration rejected", "already registered" in dup, dup)
        again = page.evaluate("async () => { await serviceManager.start('clock-alarms'); await serviceManager.start('clock-alarms'); return serviceManager.getService('clock-alarms').startCount; }")
        check("starting a running service doesn't re-initialize it", again == 1, again)
        essential = page.evaluate("async () => { try { await serviceManager.stop('notifications'); return 'stopped'; } catch (e) { return e.message; } }")
        check("essential service can't be stopped", "can't be stopped" in essential, essential)
        stopped = page.evaluate("""async () => { await serviceManager.stop('clock-alarms');
          const s = serviceManager.getService('clock-alarms'); return [s.status, s.timers, clockService._timeoutId === null]; }""")
        check("stopping clock-alarms clears its scheduler", stopped == ["stopped", 0, True], stopped)
        restarted = page.evaluate("async () => { await serviceManager.start('clock-alarms'); const s = serviceManager.getService('clock-alarms'); return [s.status, s.startCount, clockService._timeoutId !== null]; }")
        check("restarting re-arms the scheduler", restarted == ["running", 2, True], restarted)
        cascade = page.evaluate("""async () => { await serviceManager.stop('notifications', { force: true });
          const after = serviceManager.getServices().map(s => s.id + ':' + s.status);
          await serviceManager.startAll(); const back = serviceManager.getServices().every(s => s.status === 'running'); return { after, back }; }""")
        check("stopping a dependency stops dependents first", "calendar-reminders:stopped" in cascade["after"] and "clock-alarms:stopped" in cascade["after"] and "system-clock:running" in cascade["after"], cascade)
        check("startAll restores every service", cascade["back"], cascade)
        failing = page.evaluate("""async () => { const seen = []; const { eventBus } = await import('./src/core/eventBus.js');
          const off = eventBus.on('service:error', (e) => seen.push(e.id + ':' + e.message));
          serviceManager.register({ id: 'test-broken', name: 'Broken', start() { throw new Error('cannot bind'); }, stop() {} });
          const ok = await serviceManager.start('test-broken'); off();
          const s = serviceManager.getService('test-broken');
          return { ok, status: s.status, error: s.error, seen, others: serviceManager.getServices().filter(x => x.id !== 'test-broken').every(x => x.status === 'running') }; }""")
        check("failing service is marked failed with its error", failing["ok"] is False and failing["status"] == "failed" and failing["error"] == "cannot bind", failing)
        check("service:error emitted, other services unaffected", failing["seen"] == ["test-broken:cannot bind"] and failing["others"], failing)
        dep = page.evaluate("""async () => { serviceManager.register({ id: 'test-dependent', name: 'Dependent', dependencies: ['test-broken'], start() {}, stop() {} });
          const ok = await serviceManager.start('test-dependent'); return [ok, serviceManager.getService('test-dependent').status, serviceManager.getService('test-dependent').error]; }""")
        check("service with a failed dependency doesn't start", dep[0] is False and dep[1] == "failed" and "Broken" in (dep[2] or ""), dep)
        cycle = page.evaluate("() => { try { serviceManager.register({ id: 'cyc-a', dependencies: ['cyc-b'], start(){}, stop(){} }); serviceManager.register({ id: 'cyc-b', dependencies: ['cyc-a'], start(){}, stop(){} }); return 'no'; } catch (e) { return e.message; } }")
        check("dependency cycles rejected", "cycle" in cycle, cycle)

    # =================================================================
    def notification_api():
        clear_notifications(page)
        bad = page.evaluate("() => [notificationService.notify({}).id, notificationService.notify(null).id, notificationService.notify({ title: '   ' }).id]")
        check("malformed notifications rejected without breaking", bad == [None, None, None], bad)
        types = page.evaluate("""() => { notificationService.info('Info one', { source: 'notes' }); notificationService.success('Saved', { source: 'notes' });
          notificationService.warning('Careful', { title: 'Heads up', source: 'system' }); notificationService.error('Broke', { source: 'calculator' });
          return notificationService.getNotifications().map(n => [n.type, n.title, n.message, n.sourceName]); }""")
        check("typed helpers create typed notifications", [t[0] for t in types] == ["error", "warning", "success", "info"], types)
        check("helpers with title keep the message as body", ["warning", "Heads up", "Careful", "System"] in types, types)
        check("source app names resolved", ["error", "Broke", "", "Calculator"] in types, types)
        page.wait_for_timeout(300)
        badge = page.inner_text(".tray-badge")
        check("tray badge counts unread", badge == "4", badge)
        long_title = page.evaluate("() => { const r = notificationService.notify({ title: 'x'.repeat(500), message: 'y'.repeat(5000) }); const n = notificationService.getNotification(r.id); return [n.title.length, n.message.length]; }")
        check("oversized text is truncated", long_title[0] <= 120 and long_title[1] <= 600, long_title)
        page.evaluate("() => notificationService.dismissAll()")
        page.wait_for_timeout(400)
        check("dismissAll closes banners but keeps history", page.locator(".notification").count() == 0 and page.evaluate("() => notificationService.getNotifications().length") == 5)

        # persistent vs temporary
        page.mouse.move(600, 300)
        page.evaluate("() => { window.__p = notificationService.notify({ title: 'Stays', persistent: true }); notificationService.notify({ title: 'Goes', duration: 1000 }); }")
        page.wait_for_timeout(1700)
        check("temporary banner closes after its duration", page.locator(".notification", has_text="Goes").count() == 0)
        check("persistent banner remains", page.locator(".notification", has_text="Stays").count() == 1)
        page.locator(".notification", has_text="Stays").locator(".notification__close").click()
        page.wait_for_timeout(400)
        read = page.evaluate("() => notificationService.getNotification(window.__p.id).read")
        check("closing a banner marks it read, keeps it in history", page.locator(".notification", has_text="Stays").count() == 0 and read is True, read)

        # grouping
        page.evaluate("() => { for (let i = 0; i < 3; i += 1) notificationService.notify({ title: 'Copied files ' + i, groupKey: 'copy-batch', source: 'file-explorer', duration: 0 }); }")
        page.wait_for_timeout(400)
        grouped = page.evaluate("() => [...document.querySelectorAll('.notification')].filter(n => n.textContent.includes('Copied files')).map(n => n.querySelector('.notification__meta').textContent)")
        check("same groupKey shares one banner with a count", len(grouped) == 1 and "3 notifications" in grouped[0], grouped)
        page.evaluate("() => notificationService.dismissAll()")

        # click to open (action), stale target
        page.evaluate("() => notificationService.notify({ title: 'Open calc', action: { type: 'launch', appId: 'calculator' }, duration: 0 })")
        page.wait_for_timeout(300)
        page.locator(".notification", has_text="Open calc").locator(".notification__main").click()
        page.wait_for_timeout(700)
        check("clicking a banner runs its action", page.locator(".window:has(.calculator)").count() == 1)
        check("activated notification is read", page.evaluate("() => notificationService.getNotifications().find(n => n.title === 'Open calc').read"))
        page.evaluate("() => notificationService.notify({ title: 'Ghost file', action: { type: 'open', path: '/Documents/does-not-exist.txt' }, duration: 0 })")
        page.wait_for_timeout(300)
        page.locator(".notification", has_text="Ghost file").locator(".notification__main").click()
        page.wait_for_timeout(700)
        check("missing target handled with a notice", page.locator(".notification", has_text="no longer available").count() == 1)
        close_all(page)

        # history persistence + limit
        before = page.evaluate("() => notificationService.getNotifications().map(n => n.id)")
        page.wait_for_timeout(400)
        boot(page)
        after = page.evaluate("() => notificationService.getNotifications().map(n => n.id)")
        check("history persists across reload", set(before) <= set(after) and len(before) > 0, (len(before), len(after)))
        stored_ok = page.evaluate("() => JSON.parse(localStorage.getItem('browseros:notifications:history')).every(r => !('onClick' in r) && typeof r.id === 'string')")
        check("stored history has no runtime callbacks", stored_ok)
        page.evaluate("() => settingsService.set('notifications.historyLimit', 20)")
        page.evaluate("() => { for (let i = 0; i < 30; i += 1) notificationService.notify({ title: 'Bulk ' + i, history: true, duration: 1000 }); }")
        page.wait_for_timeout(200)
        count = page.evaluate("() => notificationService.getNotifications().length")
        check("history limit enforced", count == 20, count)
        newest = page.evaluate("() => notificationService.getNotifications()[0].title")
        check("newest notifications kept", newest == "Bulk 29", newest)
        page.evaluate("() => settingsService.reset('notifications.historyLimit')")
        banner_only = page.evaluate("() => { const r = notificationService.notify({ title: 'Banner only', history: false }); return notificationService.getNotification(r.id); }")
        check("history:false notifications aren't recorded", banner_only is None)
        page.evaluate("() => notificationService.dismissAll()")
        clear_notifications(page)

    # =================================================================
    def do_not_disturb():
        clear_notifications(page)
        page.evaluate("() => settingsService.set('notifications.doNotDisturb', true)")
        page.wait_for_timeout(200)
        bell = page.evaluate("() => document.querySelector('.tray-button--bell svg').dataset.icon")
        check("DND shows the crossed-out bell", bell == "bell-off", bell)
        page.evaluate("() => notificationService.info('Quiet please', { source: 'notes' })")
        page.wait_for_timeout(300)
        check("DND suppresses ordinary banners", page.locator(".notification", has_text="Quiet please").count() == 0)
        check("DND still records them", page.evaluate("() => notificationService.getNotifications().some(n => n.title === 'Quiet please')"))
        page.evaluate("() => { notificationService.notify({ title: 'Wake alarm', urgency: 'alarm' }); notificationService.warning('Storage failing', { critical: true }); }")
        page.wait_for_timeout(300)
        check("alarms and critical warnings still show during DND", page.locator(".notification", has_text="Wake alarm").count() == 1 and page.locator(".notification", has_text="Storage failing").count() == 1)
        page.evaluate("() => notificationService.dismissAll()")
        boot(page)
        check("DND persists across reload", page.evaluate("() => notificationService.isDoNotDisturb()") and page.evaluate("() => document.querySelector('.tray-button--bell svg').dataset.icon") == "bell-off")
        page.evaluate("() => trayManager.openPanel('notifications')")
        page.wait_for_timeout(300)
        page.click(".notification-center .shell-switch")
        page.wait_for_timeout(200)
        check("Notification Center switch turns DND off", page.evaluate("() => settingsService.get('notifications.doNotDisturb')") is False)
        close_all(page)
        clear_notifications(page)

    # =================================================================
    def notification_center():
        clear_notifications(page)
        page.evaluate("() => trayManager.openPanel('notifications')")
        page.wait_for_timeout(300)
        check("empty state shown", page.locator(".notification-center__empty").is_visible())
        page.evaluate("() => trayManager.closePanels()")
        page.evaluate("""() => { notificationService.info('Note A', { source: 'notes', duration: 1000 }); notificationService.info('Note B', { source: 'notes', duration: 1000 });
          notificationService.info('Alarm set', { source: 'clock', duration: 1000 });
          for (let i = 0; i < 3; i += 1) notificationService.success('Copied batch ' + i, { source: 'file-explorer', groupKey: 'copies', duration: 1000 }); }""")
        page.wait_for_timeout(300)
        page.click(".tray-button--bell")
        page.wait_for_timeout(400)
        groups = page.evaluate("() => [...document.querySelectorAll('.notification-group__title')].map(e => e.textContent)")
        check("grouped by application", len(groups) == 3 and any(g.startswith("Notes") for g in groups) and any(g.startswith("File Explorer") for g in groups), groups)
        explorer_items = page.evaluate("() => [...document.querySelectorAll('.notification-group')].find(g => g.textContent.includes('File Explorer')).querySelectorAll('.notification-item').length")
        check("related notifications collapse into one entry", explorer_items == 1, explorer_items)
        more = page.locator(".notification-item__more")
        check("collapsed entry offers '2 more'", more.count() == 1 and "2 more" in more.inner_text())
        more.click(); page.wait_for_timeout(200)
        explorer_items = page.evaluate("() => [...document.querySelectorAll('.notification-group')].find(g => g.textContent.includes('File Explorer')).querySelectorAll('.notification-item').length")
        check("expanding shows the whole group", explorer_items == 3, explorer_items)
        unread = page.evaluate("() => document.querySelectorAll('.notification-item--unread').length")
        check("unread indicators shown", unread == 6, unread)
        times = page.evaluate("() => [...document.querySelectorAll('.notification-item__time')].map(t => t.textContent)")
        check("timestamps shown", all(t == "Just now" for t in times) and len(times) == 6, times)
        page.screenshot(path=os.path.join(SHOTS, "center.png"))
        page.locator(".notification-item", has_text="Note A").locator(".notification-item__dismiss").click()
        page.wait_for_timeout(300)
        check("individual dismiss removes the entry", page.evaluate("() => !notificationService.getNotifications().some(n => n.title === 'Note A')"))
        page.keyboard.press("Escape")
        page.wait_for_timeout(300)
        check("Escape closes the panel", page.evaluate("() => trayManager.getOpenPanel()") is None)
        check("viewed notifications marked read on close", page.evaluate("() => notificationService.getUnreadCount()") == 0)
        check("badge clears when all read", page.locator(".tray-badge").is_hidden())
        page.click(".tray-button--bell"); page.wait_for_timeout(300)
        page.locator(".notification-item", has_text="Alarm set").locator(".notification-item__main").click()
        page.wait_for_timeout(700)
        check("clicking an entry opens its source app and closes the panel", page.locator(".window:has(.clock-app)").count() == 1 and page.evaluate("() => trayManager.getOpenPanel()") is None)
        page.click(".tray-button--bell"); page.wait_for_timeout(300)
        page.locator(".notification-center .shell-text-button", has_text="Clear all").click()
        page.wait_for_timeout(300)
        check("Clear all empties the center", page.evaluate("() => notificationService.getNotifications().length") == 0 and page.locator(".notification-center__empty").is_visible())
        close_all(page)

    # =================================================================
    def tray_and_panels():
        page.evaluate("() => settingsService.set('taskbar.clockFormat', '24h')")
        page.wait_for_timeout(200)
        t24 = page.inner_text(".tray-clock__time")
        expected = page.evaluate("() => new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date())")
        check("24-hour clock format", t24 == expected, (t24, expected))
        page.evaluate("() => settingsService.set('taskbar.clockFormat', '12h')")
        page.wait_for_timeout(200)
        t12 = page.inner_text(".tray-clock__time")
        check("12-hour clock format", any(x in t12.upper() for x in ("AM", "PM")), t12)
        page.evaluate("() => settingsService.set('taskbar.showSeconds', true)")
        page.wait_for_timeout(1300)
        s1 = page.inner_text(".tray-clock__time")
        page.wait_for_timeout(1100)
        s2 = page.inner_text(".tray-clock__time")
        check("seconds display ticks", s1 != s2 and s1.count(":") == 2, (s1, s2))
        page.evaluate("() => { settingsService.set('taskbar.showSeconds', false); settingsService.set('taskbar.showDate', false); }")
        page.wait_for_timeout(200)
        check("date can be hidden", page.locator(".tray-clock__date").is_hidden())
        page.evaluate("() => settingsService.set('taskbar.showClock', false)")
        page.wait_for_timeout(200)
        check("with time and date hidden a calendar icon remains", page.evaluate("() => document.querySelector('.tray-clock svg')?.dataset.icon") == "calendar")
        page.evaluate("() => settingsService.resetCategory('taskbar')")
        page.wait_for_timeout(200)
        check("taskbar settings reset restores clock and date", page.locator(".tray-clock__time").is_visible() and page.locator(".tray-clock__date").is_visible())

        # date panel
        page.click(".tray-clock"); page.wait_for_timeout(400)
        month = page.inner_text(".date-flyout__month")
        now_month = page.evaluate("() => new Date().toLocaleDateString(undefined, { month: 'long', year: 'numeric' })")
        today = page.evaluate("() => document.querySelector('.date-flyout__day--today')?.textContent")
        check("date panel shows the current month with today highlighted", month == now_month and today == str(datetime.now().day), (month, today))
        page.click(".date-flyout [aria-label='Next month']"); page.wait_for_timeout(150)
        nxt = page.inner_text(".date-flyout__month")
        page.click(".date-flyout [aria-label='Previous month']"); page.click(".date-flyout [aria-label='Previous month']"); page.wait_for_timeout(150)
        prv = page.inner_text(".date-flyout__month")
        page.click(".date-flyout .shell-text-button:has-text('Today')"); page.wait_for_timeout(150)
        check("month navigation and Today", nxt != month and prv != month and page.inner_text(".date-flyout__month") == month, (nxt, prv))
        page.screenshot(path=os.path.join(SHOTS, "date.png"))
        day15 = page.evaluate("() => document.querySelector('.date-flyout__day:not(.date-flyout__day--outside)[data-date$=\"-15\"]').dataset.date")
        page.click(f".date-flyout__day[data-date='{day15}']")
        page.wait_for_timeout(800)
        cal_title = page.inner_text(".calendar__title") if page.locator(".calendar__title").count() else ""
        check("choosing a day opens Calendar at that date", page.locator(".window:has(.calendar)").count() == 1 and page.evaluate("() => trayManager.getOpenPanel()") is None, cal_title)

        # exclusivity, outside click, start menu, layering
        page.click(".tray-button[aria-label='Quick Settings']"); page.wait_for_timeout(300)
        page.click(".tray-button--bell"); page.wait_for_timeout(300)
        check("only one panel open at a time", page.evaluate("() => trayManager.getOpenPanel()") == "notifications" and page.locator(".shell-panel--quick").is_hidden())
        top = page.evaluate("""() => { const r = document.querySelector('.shell-panel--notifications').getBoundingClientRect();
          const el = document.elementFromPoint(r.left + r.width / 2, r.top + 40); return !!el.closest('.shell-panel'); }""")
        check("panel stacks above application windows", top)
        page.mouse.click(500, 300)
        page.wait_for_timeout(400)
        check("outside click closes the panel", page.evaluate("() => trayManager.getOpenPanel()") is None)
        page.click(".tray-button[aria-label='Quick Settings']"); page.wait_for_timeout(300)
        page.click(".start-button"); page.wait_for_timeout(400)
        check("opening the Start Menu closes tray panels", page.evaluate("() => trayManager.getOpenPanel()") is None and page.locator(".start-menu--visible").count() == 1)
        page.evaluate("() => trayManager.openPanel('date')"); page.wait_for_timeout(400)
        check("opening a tray panel closes the Start Menu", page.locator(".start-menu--visible").count() == 0 and page.evaluate("() => trayManager.getOpenPanel()") == "date")
        aria = page.get_attribute(".tray-clock", "aria-expanded")
        check("tray button aria-expanded follows panel state", aria == "true", aria)
        page.keyboard.press("Escape"); page.wait_for_timeout(300)
        check("Escape returns focus to the tray button", page.evaluate("() => document.activeElement.classList.contains('tray-clock')"))

        # keyboard shortcuts
        page.mouse.click(700, 400)
        page.keyboard.press("Alt+Shift+N"); page.wait_for_timeout(300)
        n = page.evaluate("() => trayManager.getOpenPanel()")
        page.keyboard.press("Alt+Shift+A"); page.wait_for_timeout(300)
        a = page.evaluate("() => trayManager.getOpenPanel()")
        page.keyboard.press("Alt+Shift+A"); page.wait_for_timeout(300)
        closed = page.evaluate("() => trayManager.getOpenPanel()")
        check("Alt+Shift+N / Alt+Shift+A toggle panels", n == "notifications" and a == "quickSettings" and closed is None, (n, a, closed))
        page.keyboard.press("Control+Alt+Escape"); page.wait_for_timeout(800)
        check("Ctrl+Alt+Esc opens Task Manager", page.locator(".window:has(.task-manager)").count() == 1)
        close_all(page)
        page.evaluate("() => appManager.launch('notes')"); page.wait_for_timeout(700)
        page.fill(".notes__search-input", "")
        page.focus(".notes__search-input")
        page.keyboard.type("AN")
        check("shortcuts don't swallow typing in text fields", page.input_value(".notes__search-input") == "AN" and page.evaluate("() => trayManager.getOpenPanel()") is None)
        refs = page.evaluate("async () => (await import('./src/core/keyboard/keyboardShortcuts.js')).keyboardShortcuts.getGroupedShortcuts().flatMap(g => g.shortcuts).map(s => s.id)")
        check("new shortcuts in the Settings reference", all(i in refs for i in ("shell.notificationCenter", "shell.quickSettings", "general.openTaskManager")), [r for r in refs if r.startswith("shell") or "Task" in r])
        close_all(page)

    # =================================================================
    def quick_settings():
        page.evaluate("() => settingsService.resetCategory('appearance')")
        page.click(".tray-button[aria-label='Quick Settings']"); page.wait_for_timeout(400)
        page.click(".quick-segmented__option[data-value='light']"); page.wait_for_timeout(300)
        check("theme control applies immediately", page.evaluate("() => [settingsService.get('appearance.theme'), document.documentElement.dataset.theme]") == ["light", "light"])
        page.click(".quick-accent[data-value='green']"); page.wait_for_timeout(200)
        check("accent swatch applies", page.evaluate("() => document.documentElement.dataset.accent") == "green")
        page.click(".quick-tile:has-text('Do Not Disturb')"); page.wait_for_timeout(200)
        check("DND tile toggles the real setting", page.evaluate("() => settingsService.get('notifications.doNotDisturb')") is True and page.get_attribute(".quick-tile:has-text('Do Not Disturb')", "aria-pressed") == "true")
        page.click(".quick-tile:has-text('Transparency')"); page.wait_for_timeout(200)
        check("transparency tile toggles and disables blur", page.evaluate("() => settingsService.get('appearance.transparency')") is False and page.locator(".quick-range").is_disabled())
        page.evaluate("() => settingsService.set('appearance.theme', 'dark')"); page.wait_for_timeout(200)
        check("panel re-syncs when settings change elsewhere", page.get_attribute(".quick-segmented__option[data-value='dark']", "aria-checked") == "true")
        page.click(".quick-tile:has-text('Reduce motion')"); page.wait_for_timeout(200)
        check("reduce motion tile works and disables speed", page.evaluate("() => document.documentElement.dataset.reducedMotion") == "on" and page.locator(".quick-segmented__option[data-value='fast']").is_disabled())
        page.screenshot(path=os.path.join(SHOTS, "quick.png"))
        page.evaluate("() => trayManager.closePanels()"); page.wait_for_timeout(200)
        page.evaluate("() => appManager.launch('settings', { page: 'appearance' })"); page.wait_for_timeout(700)
        page.click(".tray-button[aria-label='Quick Settings']"); page.wait_for_timeout(300)
        page.click(".quick-segmented__option[data-value='system']"); page.wait_for_timeout(300)
        synced = page.evaluate("() => [...document.querySelectorAll('.settings-app input[type=radio]:checked, .settings-app [aria-checked=true]')].map(e => e.value || e.dataset.value || e.textContent).join('|')")
        check("open Settings window stays in sync", "system" in synced.lower(), synced)
        page.click(".quick-link:has-text('Notifications')"); page.wait_for_timeout(700)
        check("Settings shortcut opens the Notifications page", page.locator(".settings-page__title").first.inner_text() == "Notifications" and page.evaluate("() => trayManager.getOpenPanel()") is None)
        page.evaluate("() => { settingsService.resetCategory('appearance'); settingsService.resetCategory('notifications'); }")
        close_all(page)

    # =================================================================
    def taskbar_buttons():
        close_all(page)
        page.evaluate("async () => { await appManager.launch('calculator'); await appManager.launch('calculator'); await appManager.launch('notes'); }")
        page.wait_for_timeout(700)
        order = page.evaluate("() => [...document.querySelectorAll('.taskbar-window-button')].map(b => b.dataset.appId)")
        check("windows of the same app stay adjacent", order == ["calculator", "calculator", "notes"], order)
        labels = page.evaluate("() => [...document.querySelectorAll('.taskbar-window-button[data-app-id=calculator]')].map(b => b.getAttribute('aria-label'))")
        check("multi-window apps are identified", labels == ["Calculator — window 1 of 2", "Calculator — window 2 of 2"], labels)
        check("taskbar buttons show app icons", page.evaluate("() => [...document.querySelectorAll('.taskbar-window-button')].every(b => b.querySelector('.taskbar-window-button__icon').textContent || b.querySelector('svg'))"))
        page.evaluate("async () => { await vfs.createFile('/Documents/Notes/Taskbar test.note', JSON.stringify({ format: 'browseros-note', version: 1, html: '<p>x</p>' })); const e = await vfs.getInfo('/Documents/Notes/Taskbar test.note'); await (await import('./src/core/vfs/vfsOpener.js')).openVfsEntry(e, { appManager }); }")
        page.wait_for_timeout(700)
        notes_label = page.inner_text(".taskbar-window-button[data-app-id=notes] .taskbar-window-button__label")
        check("taskbar follows window title changes", "Taskbar test" in notes_label, notes_label)
        page.locator(".taskbar-window-button[data-app-id=calculator]").first.click(button="right")
        page.wait_for_selector(".context-menu--visible")
        items = page.evaluate("() => [...document.querySelectorAll('.context-menu--visible .context-menu__item')].map(i => i.textContent.trim())")
        check("taskbar context menu offers window and app actions", "Minimize" in items and "Close window" in items and "Close all 2 Calculator windows" in items and "Task Manager" in items, items)
        page.locator(".context-menu--visible .context-menu__item", has_text="Close all 2").click()
        page.wait_for_timeout(700)
        check("Close all closes every window of the app", page.locator(".window:has(.calculator)").count() == 0 and page.locator(".taskbar-window-button[data-app-id=calculator]").count() == 0)
        page.locator(".taskbar-window-button[data-app-id=notes]").click(); page.wait_for_timeout(300)
        check("taskbar click minimizes the active window", "taskbar-window-button--minimized" in page.get_attribute(".taskbar-window-button[data-app-id=notes]", "class"))
        page.locator(".taskbar-window-button[data-app-id=notes]").click(); page.wait_for_timeout(300)
        check("taskbar click restores it", "window--minimized" not in page.get_attribute(".window:has(.notes)", "class"))
        page.evaluate("async () => vfs.delete('/Documents/Notes/Taskbar test.note')")
        close_all(page)

    # =================================================================
    def task_manager():
        clear_notifications(page)
        baseline = page.evaluate("async () => (await import('./src/core/eventBus.js')).eventBus.getListenerCount()")
        page.evaluate("async () => { await appManager.launch('calculator'); await appManager.launch('calculator'); await appManager.launch('clock'); }")
        page.wait_for_timeout(500)
        page.evaluate("() => appManager.launch('task-manager')")
        page.wait_for_selector(".task-manager__row")
        page.wait_for_timeout(400)
        rows = lambda: page.evaluate("() => [...document.querySelectorAll('.task-manager__row[data-app-id]')].map(r => [r.dataset.appId, r.children[2].textContent])")
        r = rows()
        check("one row per application, not per window", ["calculator", "2"] in r and len([x for x in r if x[0] == "calculator"]) == 1, r)
        check("Task Manager lists itself", any(x[0] == "task-manager" for x in r), r)
        page.evaluate("() => appManager.launch('notes')"); page.wait_for_timeout(600)
        check("newly launched app appears live", any(x[0] == "notes" for x in rows()), rows())
        page.evaluate("() => appManager.close('clock')"); page.wait_for_timeout(700)
        check("closed app disappears live", not any(x[0] == "clock" for x in rows()), rows())
        page.evaluate("() => appManager.focusWindow('app:task-manager')"); page.wait_for_timeout(300)
        page.click(".task-manager__row[data-app-id=calculator] .task-manager__expander"); page.wait_for_timeout(300)
        win_rows = page.locator(".task-manager__row--window")
        check("expanding lists the app's windows", win_rows.count() == 2, win_rows.count())
        page.locator(".task-manager__row--window").first.locator("button", has_text="Minimize").click(); page.wait_for_timeout(300)
        mins = page.evaluate("() => appManager.getRunningApplications().find(a => a.appId === 'calculator').windows.map(w => w.minimized)")
        check("window-level minimize", mins.count(True) == 1, mins)
        page.click(".task-manager__row[data-app-id=calculator]"); page.wait_for_timeout(200)
        page.click(".task-manager__button:has-text('Switch to')"); page.wait_for_timeout(400)
        mins = page.evaluate("() => appManager.getRunningApplications().find(a => a.appId === 'calculator').windows.map(w => w.minimized)")
        check("Switch to restores and focuses the app", mins == [False, False] and page.evaluate("() => appManager.getFocusedApplication()") == "calculator", mins)
        page.evaluate("() => appManager.focusWindow('app:task-manager')"); page.wait_for_timeout(300)
        page.screenshot(path=os.path.join(SHOTS, "tm-apps.png"))
        closed_events = page.evaluate("""async () => { const { eventBus } = await import('./src/core/eventBus.js'); window.__closed = [];
          window.__offClosed = eventBus.on('application:stopped', (e) => window.__closed.push(e.appId)); return true; }""")
        page.click(".task-manager__row[data-app-id=calculator]"); page.wait_for_timeout(200)
        page.click(".task-manager__button--danger"); page.wait_for_timeout(500)
        check("End task closes every window immediately", page.locator(".window:has(.calculator)").count() == 0 and not any(x[0] == "calculator" for x in rows()))
        check("application:stopped emitted once", page.evaluate("() => window.__closed") == ["calculator"], page.evaluate("() => window.__closed"))
        page.evaluate("() => window.__offClosed()")

        # restart keeps launch options
        page.evaluate("async () => appManager.launch('clock', { tab: 'timer' })"); page.wait_for_timeout(600)
        page.evaluate("() => appManager.focusWindow('app:task-manager')"); page.wait_for_timeout(300)
        page.click(".task-manager__row[data-app-id=clock]"); page.wait_for_timeout(200)
        page.click(".task-manager__button:has-text('Restart')"); page.wait_for_timeout(900)
        tab = page.evaluate("() => document.querySelector('.clock-app__tab--active')?.textContent")
        check("Restart reopens the app with its launch options", page.locator(".window:has(.clock-app)").count() == 1 and tab == "Timer", tab)

        # errors: runtime attribution + crash
        page.evaluate("""() => { const e = new Error('Simulated failure'); e.stack = 'Error: Simulated failure\\n    at render (http://127.0.0.1/src/apps/clock/main.js:10:5)';
          window.dispatchEvent(new ErrorEvent('error', { error: e, message: e.message })); }""")
        page.wait_for_timeout(500)
        err = page.evaluate("() => appManager.getRunningApplications().find(a => a.appId === 'clock')")
        check("runtime errors attributed to the app", err["errorCount"] == 1 and err["lastError"] == "Simulated failure", err)
        check("app error produces a notification", page.locator(".notification", has_text="Clock ran into a problem").count() == 1)
        cell = page.evaluate("() => document.querySelector('.task-manager__row[data-app-id=clock]').children[4].textContent")
        check("Task Manager shows the error count", cell == "1", cell)
        page.evaluate("""async () => { const { eventBus } = await import('./src/core/eventBus.js'); const off = eventBus.on('test:boom', () => { const e = new Error('Listener failure'); e.stack = 'Error\\n at x (http://h/src/apps/clock/main.js:1:1)'; throw e; }); eventBus.emit('test:boom'); off(); }""")
        page.wait_for_timeout(300)
        check("errors thrown in event listeners are attributed too", page.evaluate("() => appManager.getErrors('clock').length") == 2)
        page.evaluate("() => appManager.register({ id: 'broken-app', name: 'Broken App', loader: () => Promise.reject(new Error('Module failed to load')) })")
        page.evaluate("() => appManager.launch('broken-app').catch(() => {})")
        page.wait_for_timeout(500)
        check("launch failure reported as a crash notification", page.locator(".notification", has_text="Broken App couldn't load").count() == 1)
        check("crash leaves no window behind", page.locator(".window[data-window-id^='app:broken-app']").count() == 0)
        page.evaluate("() => notificationService.dismissAll()")

        # end task with warning
        page.evaluate("() => appManager.launch('notes')"); page.wait_for_timeout(500)
        page.evaluate("() => { const inst = appManager.getInstance('app:notes'); inst._saveError = 'disk full'; inst._dirty = true; }")
        page.evaluate("() => appManager.focusWindow('app:task-manager')"); page.wait_for_timeout(300)
        page.click(".task-manager__row[data-app-id=notes]"); page.wait_for_timeout(200)
        page.click(".task-manager__button--danger"); page.wait_for_timeout(400)
        dlg = page.locator(".dialog--visible")
        check("End task asks first when the app reports unsaved work", dlg.count() == 1 and "couldn't be saved" in dlg.inner_text(), dlg.inner_text() if dlg.count() else "")
        page.keyboard.press("Escape"); page.wait_for_timeout(300)
        check("cancelling keeps the app running", page.locator(".window:has(.notes)").count() == 1)
        page.evaluate("() => { const inst = appManager.getInstance('app:notes'); inst._saveError = null; inst._dirty = false; }")

        # performance metrics are truthful
        page.click(".task-manager__tab:has-text('Performance')")
        page.wait_for_timeout(2600)
        metrics = page.evaluate("() => Object.fromEntries([...document.querySelectorAll('.task-manager__metric')].map(m => [m.querySelector('.task-manager__metric-label').textContent, m.querySelector('.task-manager__metric-value').textContent]))")
        actual = page.evaluate("() => { const apps = appManager.getRunningApplications(); return [String(apps.length), String(apps.reduce((s, a) => s + a.windows.length, 0)), String(document.querySelectorAll('.window').length)]; }")
        check("running applications metric matches AppManager", metrics.get("Running applications") == actual[0], (metrics.get("Running applications"), actual))
        check("open windows metric matches the DOM", metrics.get("Open windows") == actual[1] == actual[2], (metrics.get("Open windows"), actual))
        check("services metric matches ServiceManager", metrics.get("Background services") == page.evaluate("() => { const s = serviceManager.getServices(); return s.filter(x => x.status === 'running').length + ' of ' + s.length; }"), metrics.get("Background services"))
        text = page.inner_text(".task-manager__panel:not([hidden])")
        check("no fabricated CPU/RAM figures", "CPU" not in text.replace("can't read the device's real CPU", "") and "%" not in text, text[:200])
        check("browser figures labelled as estimates", "estimate" in text.lower())
        check("frame rate measured", "fps" in (metrics.get("Frame rate") or ""), metrics.get("Frame rate"))
        page.screenshot(path=os.path.join(SHOTS, "tm-perf.png"))

        # services tab
        page.click(".task-manager__tab:has-text('Services')"); page.wait_for_timeout(300)
        stop_disabled = page.evaluate("() => document.querySelector('[data-service-id=notifications] button[aria-label=\"Stop Notifications\"]').disabled")
        check("essential service's Stop is disabled", stop_disabled)
        page.click("[data-service-id=system-clock] button[aria-label='Stop System clock']"); page.wait_for_timeout(300)
        check("Stop from Task Manager stops the service", page.evaluate("() => serviceManager.getStatus('system-clock')") == "stopped")
        page.click("[data-service-id=system-clock] button[aria-label='Start System clock']"); page.wait_for_timeout(300)
        check("Start from Task Manager starts it", page.evaluate("() => serviceManager.getStatus('system-clock')") == "running")
        page.click("[data-service-id=notifications] button[aria-label='Stop Notifications']", force=True); page.wait_for_timeout(200)
        page.click("[data-service-id=app-monitor] button[aria-label='Restart Application monitor']"); page.wait_for_timeout(300)
        check("Restart from Task Manager", page.evaluate("() => serviceManager.getService('app-monitor').startCount") == 2)
        page.evaluate("() => settingsService.set('taskManager.refreshInterval', 5)"); page.wait_for_timeout(200)
        check("refresh interval setting applies", "every 5 s" in page.inner_text(".task-manager__status"))
        page.evaluate("() => settingsService.reset('taskManager.refreshInterval')")
        page.screenshot(path=os.path.join(SHOTS, "tm-services.png"))
        page.evaluate("() => appManager.minimizeWindow('app:task-manager')"); page.wait_for_timeout(300)
        check("updates pause while Task Manager is minimized", page.evaluate("() => appManager.getInstance('app:task-manager')._intervalId") is None)
        close_all(page)
        page.wait_for_timeout(300)
        after = page.evaluate("async () => (await import('./src/core/eventBus.js')).eventBus.getListenerCount()")
        check("no event listeners leaked after closing everything", after == baseline, (baseline, after))

    # =================================================================
    def lifecycle_leaks():
        close_all(page)
        count = lambda: page.evaluate("async () => (await import('./src/core/eventBus.js')).eventBus.getListenerCount()")
        baseline = count()
        apps = ["notes", "calculator", "calendar", "clock", "file-explorer", "terminal", "settings", "about", "recycle-bin", "task-manager"]
        for _ in range(3):
            for app in apps:
                page.evaluate(f"() => appManager.launch('{app}')")
                page.wait_for_timeout(120)
            page.wait_for_timeout(400)
            close_all(page)
        page.evaluate("async () => { const e = await vfs.getInfo('/Pictures/Sample Pictures/Aurora.png'); for (let i = 0; i < 3; i++) await (await import('./src/core/vfs/vfsOpener.js')).openVfsEntry(e, { appManager }); }")
        page.wait_for_timeout(700)
        close_all(page)
        after = count()
        check("opening and closing every app 3x leaks no listeners", after == baseline, (baseline, after))
        check("no windows or running apps left", page.evaluate("() => appManager.getRunningApplications().length") == 0 and page.locator(".window").count() == 0)
        dup = page.evaluate("async () => { await appManager.launch('settings'); await appManager.launch('settings'); return document.querySelectorAll('.window[data-window-id^=\"app:settings\"]').length; }")
        check("single-instance app focuses instead of duplicating", dup == 1, dup)
        rapid = page.evaluate("async () => { await Promise.all([appManager.launch('recycle-bin'), appManager.launch('recycle-bin'), appManager.launch('recycle-bin')]); return document.querySelectorAll('.window[data-window-id^=\"app:recycle-bin\"]').length; }")
        check("rapid concurrent launches of a single-instance app open one window", rapid == 1, rapid)
        close_all(page)

    # =================================================================
    def app_integrations():
        clear_notifications(page)
        # Notes save failure: notify once per failure streak
        page.evaluate("() => appManager.launch('notes')"); page.wait_for_selector(".notes__item"); page.wait_for_timeout(500)
        page.locator(".notes__sidebar .notes__button--primary", has_text="New note").click(); page.wait_for_timeout(500)
        page.keyboard.type("Failing"); page.keyboard.press("Enter"); page.wait_for_timeout(500)
        page.evaluate("() => { window.__write = vfs.write.bind(vfs); vfs.write = async () => { throw new Error('Storage is full'); }; }")
        page.keyboard.type("first edit"); page.wait_for_timeout(1500)
        page.keyboard.type(" second edit"); page.wait_for_timeout(1500)
        fails = page.evaluate("() => notificationService.getNotifications().filter(n => n.source === 'notes' && n.type === 'error').map(n => [n.title, n.action && n.action.path])")
        check("Notes save failure notifies once with a link to the note", len(fails) == 1 and fails[0][1] == "/Documents/Notes/Failing.note", fails)
        page.evaluate("() => { vfs.write = window.__write; }")
        page.keyboard.type("!"); page.wait_for_timeout(1500)
        check("save recovers", "Saved" in page.inner_text(".notes__status"))
        page.evaluate("async () => vfs.delete('/Documents/Notes/Failing.note')")
        close_all(page)

        # Explorer: bulk copy completion, single action quiet
        page.evaluate("async () => { await vfs.createFolder('/Documents/bulk-src'); await vfs.createFolder('/Documents/bulk-dst'); for (let i = 0; i < 12; i++) await vfs.createFile(`/Documents/bulk-src/f${i}.txt`, 'x'); }")
        page.evaluate("() => appManager.launch('file-explorer', { path: '/Documents/bulk-src' })")
        page.wait_for_selector(".explorer__row"); page.wait_for_timeout(400)
        page.click(".window:has(.explorer) .explorer__row >> nth=0")
        page.keyboard.press("Control+a"); page.keyboard.press("Control+c")
        page.evaluate("() => appManager.launch('file-explorer', { path: '/Documents/bulk-dst' })")
        page.wait_for_timeout(600)
        page.locator(".window:has(.explorer)").last.locator(".explorer__list").click(position={"x": 200, "y": 200})
        page.keyboard.press("Control+v"); page.wait_for_timeout(1200)
        copied = page.evaluate("() => notificationService.getNotifications().filter(n => n.source === 'file-explorer').map(n => [n.title, n.action && n.action.path])")
        check("bulk copy reports completion with the folder", ["Copied 12 items", "/Documents/bulk-dst"] in copied, copied)
        n_before = page.evaluate("() => notificationService.getNotifications().length")
        page.evaluate("async () => vfs.createFile('/Documents/bulk-dst/single.txt', '')")
        page.locator(".window:has(.explorer)").last.locator(".explorer__row", has_text="single.txt").click()
        page.keyboard.press("Delete"); page.wait_for_timeout(300)
        if page.locator(".dialog--visible").count():
            page.click(".dialog--visible .dialog__button--danger, .dialog--visible .dialog__button--primary"); page.wait_for_timeout(400)
        check("routine single-item actions don't notify", page.evaluate("() => notificationService.getNotifications().length") == n_before)
        page.evaluate("async () => { await vfs.delete('/Documents/bulk-src'); await vfs.delete('/Documents/bulk-dst'); }")
        close_all(page)

        # Terminal: long command in background notifies; Ctrl+C interrupts
        page.evaluate("() => appManager.launch('terminal')"); page.wait_for_selector(".terminal__input")
        term = page.locator(".terminal__input").last
        term.fill("sleep 5.2"); term.press("Enter")
        page.evaluate("() => appManager.launch('calculator')"); page.wait_for_timeout(5700)
        done = page.evaluate("() => notificationService.getNotifications().filter(n => n.source === 'terminal').map(n => n.title)")
        check("long command finishing in the background notifies", done == ["A Terminal command finished"], done)
        page.evaluate("() => appManager.focusWindow([...document.querySelectorAll('.window')].find(w => w.querySelector('.terminal-app')).dataset.windowId)")
        page.wait_for_timeout(300)
        term.fill("sleep 30"); term.press("Enter"); page.wait_for_timeout(300)
        term.press("Control+c"); page.wait_for_timeout(300)
        out = page.locator(".terminal__output").last.inner_text()
        check("Ctrl+C interrupts a running command", "sleep: interrupted" in out, out[-120:])
        term.fill("sleep 1"); term.press("Enter"); page.wait_for_timeout(1400)
        check("quick or focused commands don't notify", page.evaluate("() => notificationService.getNotifications().filter(n => n.source === 'terminal').length") == 1)
        close_all(page)
        clear_notifications(page)

    # =================================================================
    def settings_pages():
        clear_notifications(page)
        page.evaluate("() => appManager.launch('settings', { page: 'notifications' })"); page.wait_for_timeout(700)
        check("Notifications settings page", page.locator(".settings-page__title").first.inner_text() == "Notifications")
        page.select_option(".settings-app select", "100"); page.wait_for_timeout(200)
        check("numeric select stores a number", page.evaluate("() => settingsService.get('notifications.historyLimit')") == 100)
        page.locator(".settings-app [role=switch]").first.click(); page.wait_for_timeout(200)
        check("DND toggle on the page", page.evaluate("() => settingsService.get('notifications.doNotDisturb')") is True)
        check("tray reflects page changes", page.evaluate("() => document.querySelector('.tray-button--bell svg').dataset.icon") == "bell-off")
        page.evaluate("() => appManager.launch('settings', { page: 'taskbar' })"); page.wait_for_timeout(600)
        check("Taskbar settings page", page.locator(".settings-page__title").first.inner_text() == "Taskbar")
        page.locator(".settings-app label:has-text('24-hour'), .settings-app button:has-text('24-hour')").first.click(); page.wait_for_timeout(200)
        check("clock format from Settings applies to the tray", page.evaluate("() => settingsService.get('taskbar.clockFormat')") == "24h")
        page.evaluate("() => appManager.launch('settings', { page: 'system' })"); page.wait_for_timeout(600)
        sys_text = page.inner_text(".settings-app")
        check("System page lists the new categories for reset", all(x in sys_text for x in ("Notifications", "Taskbar", "Task Manager")))
        page.click(".start-button"); page.wait_for_timeout(300)
        page.fill(".start-menu__search-input", "do not disturb"); page.wait_for_timeout(500)
        check("Start Menu search finds the new settings", "Do Not Disturb" in page.inner_text(".start-menu"))
        page.fill(".start-menu__search-input", "task"); page.wait_for_timeout(500)
        check("Start Menu search finds Task Manager", "Task Manager" in page.inner_text(".start-menu"))
        page.keyboard.press("Escape"); page.wait_for_timeout(200)
        page.keyboard.press("Escape"); page.wait_for_timeout(200)
        page.evaluate("() => { settingsService.resetCategory('notifications'); settingsService.resetCategory('taskbar'); }")
        close_all(page)

    for fn in (icons, services, notification_api, do_not_disturb, notification_center, tray_and_panels, quick_settings, taskbar_buttons, task_manager, lifecycle_leaks, app_integrations, settings_pages):
        section(fn)

    # =================================================================
    def timed_integrations():
        tctx = browser.new_context(viewport={"width": 1400, "height": 900})
        tp = tctx.new_page()
        attach(tp, "[timed] ")
        tp.clock.install(time=datetime(2026, 11, 6, 9, 59, 0))
        boot(tp)
        tp.evaluate("() => clockService.addAlarm({ time: '10:00', label: 'Morning' })")
        tp.evaluate("async () => { await calendarService.ready(); await calendarService.create({ title: 'Planning', allDay: false, start: '2026-11-06T10:10', end: '2026-11-06T10:40', reminder: 5 }); }")
        tp.clock.run_for(70_000); tp.wait_for_timeout(300)
        alarm = tp.locator(".notification", has_text="Morning")
        check("alarm banner uses the clock line icon", alarm.count() == 1 and tp.evaluate("() => document.querySelector('.notification--alarm svg')?.dataset.icon") == "clock")
        alarm.locator(".notification__action", has_text="Dismiss").click(); tp.wait_for_timeout(300)
        tp.evaluate("() => settingsService.set('notifications.doNotDisturb', true)")
        tp.clock.run_for(5 * 60_000); tp.wait_for_timeout(300)
        check("reminder during DND is recorded but not shown", tp.locator(".notification", has_text="Planning").count() == 0 and tp.evaluate("() => notificationService.getNotifications().some(n => n.title === 'Planning')"))
        tp.evaluate("() => settingsService.set('notifications.doNotDisturb', false)")
        tp.evaluate("() => trayManager.openPanel('notifications')"); tp.wait_for_timeout(300)
        tp.locator(".notification-item", has_text="Planning").locator(".notification-item__main").click(); tp.wait_for_timeout(800)
        check("reminder in the Notification Center opens Calendar", tp.locator(".window:has(.calendar)").count() == 1)
        state = tctx.storage_state(indexed_db=True)
        tctx.close()
        rctx = browser.new_context(viewport={"width": 1400, "height": 900}, storage_state=state)
        rp = rctx.new_page()
        attach(rp, "[reload] ")
        rp.clock.install(time=datetime(2026, 11, 6, 12, 0, 0))
        boot(rp)
        rp.evaluate("() => trayManager.openPanel('notifications')"); rp.wait_for_timeout(300)
        rp.locator(".notification-item", has_text="Planning").locator(".notification-item__main").click(); rp.wait_for_timeout(900)
        check("after reload the stored action still opens Calendar", rp.locator(".window:has(.calendar)").count() == 1)
        check("services running after reload", rp.evaluate("() => serviceManager.getServices().every(s => s.status === 'running')"))
        rctx.close()

    section(timed_integrations)

    real_errors = [e for e in errors if "404" not in e and "favicon" not in e
                   and "Simulated failure" not in e and "Listener failure" not in e and "Module failed to load" not in e
                   and "failed to load" not in e and "Storage is full" not in e and "test-broken" not in e]
    check("no unexpected console errors", not real_errors, real_errors)
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
