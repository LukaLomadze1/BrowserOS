"""Capture the screenshots used in the documentation (docs/screenshots/).

Usage:
    python tests/screenshots.py            # serves the repository
    python tests/screenshots.py dist       # serves the production copy (python tools/build.py first)

Every image is taken from BrowserOS running in a fresh browser profile,
with the built-in sample files added through the Welcome tour, so the
images never contain anyone's own data. Windows are opened through
AppManager and arranged by setting their position, the same element the
user drags; notifications are posted through NotificationService, the
API applications use.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "e2e"))
from playwright.sync_api import sync_playwright  # noqa: E402
from common import REPO_ROOT, close_all, launch_options, serve  # noqa: E402

OUT = os.path.join(REPO_ROOT, "docs", "screenshots")
os.makedirs(OUT, exist_ok=True)
server, BASE = serve(os.path.join(REPO_ROOT, sys.argv[1]) if len(sys.argv) > 1 else REPO_ROOT)


def place(page, selector, x, y, width, height):
    """Move and size a window through the same element the user drags."""
    page.evaluate(
        """([selector, x, y, w, h]) => { const el = document.querySelector(selector);
           Object.assign(el.style, { left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' }); }""",
        [selector, x, y, width, height],
    )


def window(app_id):
    return f".window[data-window-id='app:{app_id}']"


def shot(page, name):
    page.wait_for_timeout(700)
    page.mouse.move(1435, 300)
    page.screenshot(path=os.path.join(OUT, name))
    print("saved", name)


def terminal(page, commands):
    page.evaluate("appManager.launch('terminal')")
    page.wait_for_selector(".window:has(.terminal-app) .terminal__input")
    field = page.locator(".window:has(.terminal-app) .terminal__input").last
    for command in commands:
        field.fill(command)
        field.press("Enter")
        page.wait_for_timeout(250)
    return page.locator(".window:has(.terminal-app)").last.get_attribute("data-window-id")


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(**launch_options())
    page = browser.new_page(viewport={"width": 1440, "height": 900})
    page.goto(f"{BASE}/index.html")
    page.wait_for_selector("body[data-boot-state='ready']", timeout=20000)

    # Welcome tour, as it appears on the first start.
    shot(page, "welcome.png")
    page.click(f"{window('welcome')} .welcome__next")
    page.wait_for_function("() => JSON.parse(localStorage.getItem('browseros:sampleContent:manifest') || 'null')?.files?.length > 20", timeout=20000)
    page.click(f"{window('welcome')} .welcome__skip")
    page.wait_for_timeout(500)

    # 1. Desktop with File Explorer, Notes, and Terminal.
    page.evaluate("appManager.launch('file-explorer', { path: '/Documents' })")
    page.wait_for_selector(".window:has(.explorer) .explorer__row")
    explorer = page.locator(".window:has(.explorer)").first.get_attribute("data-window-id")
    page.evaluate("appManager.launch('notes', { path: '/Documents/Sample-Notes/Project kickoff.note' })")
    page.wait_for_selector(".window:has(.notes)")
    notes = page.locator(".window:has(.notes)").first.get_attribute("data-window-id")
    term = terminal(page, ["cd /Projects", "tree", "version"])
    place(page, f".window[data-window-id='{explorer}']", 230, 40, 760, 440)
    place(page, f".window[data-window-id='{notes}']", 760, 150, 620, 480)
    place(page, f".window[data-window-id='{term}']", 400, 420, 600, 330)
    shot(page, "desktop.png")
    close_all(page)

    # 2. Start menu.
    page.click(".start-button")
    page.wait_for_function("() => document.querySelector('.start-menu')?.getAttribute('aria-hidden') === 'false'")
    shot(page, "start-menu.png")
    page.keyboard.press("Escape")

    # 3. File Explorer.
    page.evaluate("appManager.launch('file-explorer', { path: '/Projects/Portfolio-Website' })")
    page.wait_for_selector(".window:has(.explorer) .explorer__row")
    explorer = page.locator(".window:has(.explorer)").first.get_attribute("data-window-id")
    place(page, f".window[data-window-id='{explorer}']", 250, 70, 940, 600)
    shot(page, "file-explorer.png")
    close_all(page)

    # 4. Terminal.
    term = terminal(page, ["ls /Documents", "cat /Documents/Welcome.txt", "tree /Pictures"])
    place(page, f".window[data-window-id='{term}']", 260, 50, 900, 640)
    shot(page, "terminal.png")
    close_all(page)

    # 5. Settings.
    page.evaluate("appManager.launch('settings', { page: 'appearance' })")
    page.wait_for_selector(window("settings"))
    place(page, window("settings"), 220, 50, 1000, 720)
    shot(page, "settings.png")
    close_all(page)

    # 6. Code Studio with the sample website and its live preview.
    page.evaluate("appManager.launch('code-studio', { path: '/Projects/Portfolio-Website/index.html' })")
    page.wait_for_selector(f"{window('code-studio')} .cs-editor:not([hidden]) .cs-line", timeout=15000)
    page.click(f"{window('code-studio')} .window__control--maximize")
    page.evaluate("appManager.getInstance('app:code-studio')._run()")
    page.frame_locator(f"{window('code-studio')} .cs-preview__frame").locator("h1").wait_for(timeout=10000)
    shot(page, "code-studio.png")
    close_all(page)

    # 7. A running JavaScript project (the animated demo).
    page.evaluate("appManager.launch('code-studio', { path: '/Projects/JavaScript-Demo/app.js' })")
    page.wait_for_selector(f"{window('code-studio')} .cs-editor:not([hidden]) .cs-line", timeout=15000)
    page.click(f"{window('code-studio')} .window__control--maximize")
    page.evaluate("appManager.getInstance('app:code-studio')._runPage('/Projects/JavaScript-Demo/index.html')")
    page.frame_locator(f"{window('code-studio')} .cs-preview__frame").locator("canvas").wait_for(timeout=10000)
    page.wait_for_timeout(2500)
    shot(page, "running-project.png")
    close_all(page)

    # 8. Productivity: Notes and Calendar.
    page.evaluate("appManager.launch('notes', { path: '/Documents/Sample-Notes/Reading list.note' })")
    page.wait_for_selector(".window:has(.notes)")
    notes = page.locator(".window:has(.notes)").first.get_attribute("data-window-id")
    page.evaluate("appManager.launch('calendar')")
    page.wait_for_selector(window("calendar"))
    place(page, window("calendar"), 180, 40, 820, 600)
    place(page, f".window[data-window-id='{notes}']", 720, 220, 640, 500)
    shot(page, "productivity.png")
    close_all(page)

    # 9. Notification Center and system tray.
    page.evaluate(
        """() => {
      notificationService.notify({ source: 'calendar', title: 'Design review in 15 minutes', message: 'Room 2 · Bring the portfolio cards' });
      notificationService.notify({ source: 'downloads', type: 'success', title: 'Download complete', message: 'brand-guidelines.pdf was saved to /Downloads' });
      notificationService.notify({ source: 'clock', title: 'Timer finished', message: '25:00 focus session' });
    }"""
    )
    page.wait_for_timeout(500)
    page.keyboard.press("Alt+Shift+N")
    page.wait_for_timeout(500)
    shot(page, "notification-center.png")
    page.keyboard.press("Escape")

    # 10. Task Manager with several applications running.
    page.evaluate("appManager.launch('file-explorer', { path: '/Pictures/Sample Pictures' })")
    page.evaluate("appManager.launch('notes')")
    page.evaluate("appManager.launch('calculator')")
    page.evaluate("appManager.launch('code-studio', { path: '/Projects/Portfolio-Website/index.html' })")
    page.wait_for_timeout(1200)
    page.evaluate("appManager.launch('task-manager')")
    page.wait_for_selector(window("task-manager"))
    place(page, window("task-manager"), 260, 80, 900, 600)
    page.wait_for_timeout(2200)
    shot(page, "task-manager.png")
    close_all(page)

    # About BrowserOS.
    page.evaluate("appManager.launch('about', { tab: 'system' })")
    page.wait_for_selector(window("about"))
    page.wait_for_function("() => !document.querySelector(\"[data-field='storage']\")?.textContent.startsWith('Checking')")
    shot(page, "about.png")
    close_all(page)

    # Light theme.
    page.evaluate("settingsService.set('appearance.theme', 'light'); settingsService.set('wallpaper.preset', 'ocean')")
    page.evaluate("appManager.launch('calendar')")
    page.wait_for_selector(window("calendar"))
    page.evaluate("appManager.launch('calculator')")
    page.wait_for_timeout(600)
    calculator = page.locator(".window:has(.calculator)").last.get_attribute("data-window-id")
    place(page, window("calendar"), 240, 60, 780, 620)
    place(page, f".window[data-window-id='{calculator}']", 1040, 120, 340, 520)
    shot(page, "light-theme.png")
    browser.close()

server.shutdown()
