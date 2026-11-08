"""First run and release features.

Start-up screen and its progress, the Welcome tour (appearance choices,
completion, not showing again), sample files (contents, running both web
projects in Code Studio, never replacing files, removing only unchanged
ones), existing installations, About BrowserOS, Restart and Shut down,
the 404 page and response headers, and that BrowserOS requests nothing
from other sites.
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from playwright.sync_api import sync_playwright  # noqa: E402
from common import SITE_ROOT, REPO_ROOT, Report, close_all, dialog_button, launch_options, serve, wait_desktop, wait_for, exit_with  # noqa: E402

server, BASE = serve()
report = Report()
check = report.check
WELCOME = ".window[data-window-id='app:welcome']"

# Records start-up states and progress values as they change.
BOOT_LOG = """(() => {
  window.__bootLog = { states: [], progress: [] };
  const record = () => {
    const state = document.body?.dataset.bootState;
    if (state && window.__bootLog.states.at(-1) !== state) window.__bootLog.states.push(state);
    const progress = document.getElementById('boot-screen')?.style.getPropertyValue('--boot-progress');
    if (progress && window.__bootLog.progress.at(-1) !== progress) window.__bootLog.progress.push(progress);
  };
  new MutationObserver(record).observe(document, { subtree: true, attributes: true, attributeFilter: ['style', 'data-boot-state'] });
})();"""


def status(page):
    return page.evaluate("JSON.parse(localStorage.getItem('browseros:welcome:status') || 'null')?.status ?? null")


def open_start_menu(page):
    page.click(".start-button")
    page.wait_for_function("() => document.querySelector('.start-menu')?.getAttribute('aria-hidden') === 'false'")


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(**launch_options())
    context = browser.new_context(viewport={"width": 1440, "height": 900})
    context.add_init_script(BOOT_LOG)
    page = context.new_page()
    report.watch_console(page)
    requests, failures = [], []
    page.on("request", lambda r: requests.append(r.url))
    page.on("requestfailed", lambda r: failures.append(f"failed {r.url}"))
    page.on("response", lambda r: failures.append(f"{r.status} {r.url}") if r.status >= 400 else None)

    # ------------------------------------------------------------------
    def start_up():
        page.goto(f"{BASE}/index.html")
        page.wait_for_selector("body[data-boot-state='ready']", timeout=20000)
        log = page.evaluate("window.__bootLog")
        values = [float(value) for value in log["progress"]]
        check("start-up screen shows progress in stages", len(values) >= 3 and values == sorted(values) and values[-1] == 1.0, log)
        check("start-up ends in the ready state", log["states"][-1:] == ["ready"], log["states"])
        check("start-up screen is removed afterwards", wait_for(page, "() => !document.getElementById('boot-screen')", 3000))
        foreign = [url for url in requests if not url.startswith(BASE) and not url.startswith(("data:", "blob:", "about:"))]
        check("nothing is requested from other sites", not foreign, foreign[:5])
        check("no failed requests while starting", not failures, failures[:5])
        fonts = page.evaluate("document.fonts.ready.then(() => [document.fonts.check('600 16px \"Space Grotesk\"'), document.fonts.check('16px Inter')])")
        check("interface fonts are served with BrowserOS", fonts == [True, True], fonts)
        icons = page.evaluate("[...document.querySelectorAll('link[rel~=icon], link[rel=apple-touch-icon]')].map(l => l.href)")
        for href in icons:
            check(f"icon file loads: {href.rsplit('/', 1)[-1]}", page.request.get(href).status == 200)
        check("Start button shows the BrowserOS mark", page.locator(".start-button svg[data-icon='browseros']").count() == 1)

    # ------------------------------------------------------------------
    def welcome_tour():
        check("Welcome opens on a new installation", page.locator(WELCOME).count() == 1)
        centered = page.evaluate(
            """() => { const w = document.querySelector(".window[data-window-id='app:welcome']").getBoundingClientRect();
               const d = document.querySelector('.desktop__window-layer').getBoundingClientRect();
               return Math.abs(w.left + w.width / 2 - (d.left + d.width / 2)) < 3 && Math.abs(w.top + w.height / 2 - (d.top + d.height / 2)) < 3; }"""
        )
        check("Welcome opens in the middle of the desktop", centered)
        check("first run is recorded as pending until finished", status(page) == "pending")
        check("sample files are offered, checked on a new installation", page.is_checked(f"{WELCOME} input[name='samples']"))
        check("no sample files exist before the user continues", not page.evaluate("vfs.exists('/Documents/Welcome.txt')"))
        page.click(f"{WELCOME} .welcome__next")
        check("continuing with the box checked adds the sample files", wait_for(page, "() => vfs.exists('/Projects/JavaScript-Demo/particles.js')", 15000))

        page.click(f"{WELCOME} .welcome__choice:has(input[value='light'])")
        check("theme choice applies immediately", wait_for(page, "() => document.documentElement.dataset.theme === 'light'") and page.evaluate("settingsService.get('appearance.theme')") == "light")
        page.click(f"{WELCOME} .welcome__choice:has(input[value='green'])")
        check("accent choice is saved", page.evaluate("settingsService.get('appearance.accentColor')") == "green")
        page.click(f"{WELCOME} .welcome__choice:has(input[value='ocean'])")
        check("wallpaper choice applies", page.evaluate("document.documentElement.dataset.wallpaper") == "ocean")
        page.focus(f"{WELCOME} input[value='ocean']")
        page.keyboard.press("ArrowRight")
        check("choices work with the keyboard", page.evaluate("settingsService.get('wallpaper.preset')") == "graphite")
        page.keyboard.press("ArrowLeft")

        page.click(f"{WELCOME} .welcome__next")
        keys = page.locator(f"{WELCOME} .os-kbd").all_inner_texts()
        check("basics step shows the real shortcuts", "Alt" in keys and "Shift" in keys and "W" in keys, keys)
        page.click(f"{WELCOME} .welcome__next")
        page.click(f"{WELCOME} .welcome__try-start")
        check("the tour can open the real Start menu", wait_for(page, "() => document.querySelector('.start-menu')?.getAttribute('aria-hidden') === 'false'"))
        page.keyboard.press("Escape")
        page.click(f"{WELCOME} .welcome__next")
        page.click(f"{WELCOME} .welcome__try-explorer")
        check("the tour can open File Explorer", wait_for(page, "() => !!document.querySelector('.window .explorer')"))
        page.locator(".window:has(.explorer) .window__control--close").click()
        page.click(f"{WELCOME} .welcome__next")
        names = page.locator(f"{WELCOME} .welcome__app-name").all_inner_texts()
        registered = page.evaluate("appManager.getRegisteredApps().filter(a => !a.dynamic).length")
        check("applications step lists every installed application", len(names) == registered and "Code Studio" in names, names)
        page.click(f"{WELCOME} .welcome__next")
        summary = page.locator(f"{WELCOME} .welcome__summary").inner_text()
        check("the last step summarizes the choices", all(word in summary for word in ["Light", "Green", "Ocean", "Added"]), summary)
        page.click(f"{WELCOME} .welcome__finish")
        page.wait_for_selector(WELCOME, state="detached")
        check("finishing records completion", status(page) == "completed")

        page.evaluate("vfs.delete('/Downloads/About-Downloads.txt')")
        page.reload()
        page.wait_for_selector("body[data-boot-state='ready']")
        page.wait_for_timeout(500)
        check("Welcome doesn't open again after a reload", page.locator(WELCOME).count() == 0)
        check("choices persist across reloads", page.evaluate("[document.documentElement.dataset.theme, document.documentElement.dataset.wallpaper]") == ["light", "ocean"])
        check("sample files are not re-created at start-up", not page.evaluate("vfs.exists('/Downloads/About-Downloads.txt')"))
        page.evaluate("settingsService.set('appearance.theme', 'dark'); settingsService.set('wallpaper.preset', 'aurora'); settingsService.set('appearance.accentColor', 'violet')")

    # ------------------------------------------------------------------
    def sample_files():
        manifest = page.evaluate("JSON.parse(localStorage.getItem('browseros:sampleContent:manifest'))")
        expected = page.evaluate("import('./src/core/demo/sampleContent.js').then(m => m.sampleContent.getSampleCount())")
        check("every sample file was written and recorded", len(manifest["files"]) == expected == 21, (len(manifest["files"]), expected))
        check("Welcome.txt is a real file in the VFS", "Welcome to BrowserOS" in page.evaluate("vfs.read('/Documents/Welcome.txt')"))
        note = page.evaluate("vfs.read('/Documents/Sample-Notes/Reading list.note').then(JSON.parse)")
        check("sample notes use the Notes format", note["format"] == "browseros-note" and "data-checklist" in note["html"])
        picture = page.evaluate("vfs.getInfo('/Pictures/Sample Pictures/Aurora.png').then(e => [e.size, e.mimeType ?? e.type])")
        check("sample pictures are real PNG files", picture[0] > 1000, picture)

        page.evaluate("appManager.launch('code-studio', { path: '/Projects/Portfolio-Website/index.html' })")
        page.wait_for_selector(".window[data-window-id='app:code-studio'] .cs-editor:not([hidden]) .cs-line", timeout=15000)
        page.evaluate("appManager.getInstance('app:code-studio')._run()")
        frame = page.frame_locator(".window[data-window-id='app:code-studio'] .cs-preview__frame")
        check("the sample website renders in the live preview", frame.locator("h1").inner_text(timeout=10000).startswith("I build fast"))
        check("its stylesheet is applied", frame.locator(".card").first.evaluate("e => getComputedStyle(e).borderRadius") == "14px")
        check("its logo image loads", frame.locator(".brand img").evaluate("img => img.complete && img.naturalWidth > 0"))
        frame.locator("button[data-filter='tools']").click()
        check("its JavaScript runs (project filter)", frame.locator(".card:not([hidden])").count() == 2)
        frame.locator(".contact-form button[type='submit']").click()
        check("its form validation runs", "Please fill in" in frame.locator(".form-status").inner_text())
        frame.locator("nav a", has_text="About").click()
        heading = ""
        for _ in range(30):
            heading = frame.locator("h1").inner_text(timeout=8000)
            if heading.startswith("Eight years"):
                break
            page.wait_for_timeout(200)
        check("links between its pages work in the preview", heading.startswith("Eight years"), heading)
        close_all(page)

        page.evaluate("appManager.launch('code-studio', { path: '/Projects/JavaScript-Demo/index.html' })")
        page.wait_for_selector(".window[data-window-id='app:code-studio'] .cs-editor:not([hidden]) .cs-line", timeout=15000)
        page.evaluate("appManager.getInstance('app:code-studio')._run()")
        frame = page.frame_locator(".window[data-window-id='app:code-studio'] .cs-preview__frame")
        fps = ""
        for _ in range(20):
            fps = frame.locator("#fps").inner_text(timeout=8000)
            if fps.isdigit():
                break
            page.wait_for_timeout(250)
        check("the JavaScript demo animates (its module import resolves)", fps.isdigit() and int(fps) > 0, fps)
        check("the demo's console output reaches the Output panel", wait_for(page, "() => document.querySelector(\".window[data-window-id='app:code-studio']\").textContent.includes('Orbits started with')", 6000))
        close_all(page)

    # ------------------------------------------------------------------
    def removing_samples():
        page.evaluate("vfs.write('/Documents/Welcome.txt', 'my own notes')")
        page.evaluate("appManager.launch('settings', { page: 'system', anchor: 'getting-started' })")
        page.wait_for_selector(".window[data-window-id='app:settings'] [data-settings-anchor='getting-started']")
        page.get_by_role("button", name="Remove sample files").click()
        page.wait_for_selector(".dialog--visible")
        dialog_button(page, "Move to Recycle Bin")
        status_text = ".window[data-window-id='app:settings'] [data-settings-anchor='getting-started'] .settings-section__status"
        check("removal reports what it did", wait_for(page, f"() => document.querySelector(\"{status_text}\")?.textContent.startsWith('Moved')", 10000), page.locator(status_text).inner_text())
        check("unchanged sample files are moved to Trash", not page.evaluate("vfs.exists('/Projects/Portfolio-Website')"))
        trash = page.evaluate("vfs.list('/Trash').then(list => list.map(e => e.name))")
        # /Projects was created for the samples and nothing in it changed, so it moves as one item.
        check("an untouched sample folder goes to Trash as one item", "Projects" in trash and "Sample-Notes" in trash and "index.html" not in trash, trash)
        check("a changed sample file is kept", page.evaluate("vfs.read('/Documents/Welcome.txt')") == "my own notes")
        check("the status names the kept file", "Welcome.txt" in page.locator(status_text).inner_text())
        check("folders created for the samples leave no trace", not page.evaluate("vfs.exists('/Projects')") and page.evaluate("vfs.exists('/Documents')"))
        page.get_by_role("button", name="Add sample files").click()
        page.wait_for_selector(".dialog--visible")
        dialog_button(page, "Add sample files")
        check("adding again reports skipped names", wait_for(page, f"() => document.querySelector(\"{status_text}\")?.textContent.includes('skipped')", 15000), page.locator(status_text).inner_text())
        check("adding never replaces an existing file", page.evaluate("vfs.read('/Documents/Welcome.txt')") == "my own notes")

        page.get_by_role("button", name="Open the welcome tour").click()
        page.wait_for_selector(WELCOME)
        check("the tour opens from Settings", page.locator(WELCOME).count() == 1)
        check("the reopened tour shows that samples are present", page.locator(f"{WELCOME} .welcome__samples--done").count() == 1)
        page.locator(f"{WELCOME} .window__control--close").click()
        page.wait_for_selector(WELCOME, state="detached")
        check("closing a reopened tour keeps it completed", status(page) == "completed")
        close_all(page)

    # ------------------------------------------------------------------
    def partial_removal():
        page.evaluate("vfs.write('/Projects/Portfolio-Website/assets/logo.svg', '<svg xmlns=\"http://www.w3.org/2000/svg\"/>')")
        result = page.evaluate("import('./src/core/demo/sampleContent.js').then(m => m.sampleContent.remove(vfs))")
        check("removal keeps a changed file inside a sample project", result["kept"] == ["/Projects/Portfolio-Website/assets/logo.svg"], result)
        check("...and its folders", page.evaluate("vfs.exists('/Projects/Portfolio-Website/assets/logo.svg')"))
        check("...while the unchanged files of that project go", not page.evaluate("vfs.exists('/Projects/Portfolio-Website/index.html')"))
        check("...and an untouched sample project goes as one item", not page.evaluate("vfs.exists('/Projects/JavaScript-Demo')"))
        page.evaluate("vfs.delete('/Projects')")

    # ------------------------------------------------------------------
    def existing_installation():
        other = browser.new_context(viewport={"width": 1280, "height": 800})
        tab = other.new_page()
        report.watch_console(tab)
        tab.goto(f"{BASE}/index.html")
        wait_desktop(tab, samples=False)
        check("skipping without samples adds none", not tab.evaluate("vfs.exists('/Documents/Welcome.txt')"))
        check("skipping is recorded", status(tab) == "skipped")
        tab.evaluate("localStorage.removeItem('browseros:welcome:status')")
        tab.reload()
        tab.wait_for_selector("body[data-boot-state='ready']")
        tab.wait_for_timeout(400)
        check("BrowserOS with existing files doesn't open the tour by itself", tab.locator(WELCOME).count() == 0)
        check("...and remembers that", status(tab) == "existing")
        check("...and adds no sample files", not tab.evaluate("vfs.exists('/Projects')"))
        tab.evaluate("localStorage.setItem('browseros:welcome:status', JSON.stringify({ status: 'pending', version: '16.0', changedAt: 0 }))")
        tab.reload()
        tab.wait_for_selector("body[data-boot-state='ready']")
        check("an unfinished tour opens again at the next start", tab.locator(WELCOME).count() == 1)
        check("on a later start the sample box isn't pre-checked", not tab.is_checked(f"{WELCOME} input[name='samples']"))
        other.close()

    # ------------------------------------------------------------------
    def about():
        page.evaluate("appManager.launch('about')")
        about_window = ".window[data-window-id='app:about']"
        page.wait_for_selector(about_window)
        check("About shows version 16.0", "Version 16.0" in page.locator(f"{about_window} .about__version").inner_text())
        page.locator(f"{about_window} .about__tab[data-tab='system']").click()
        check("System tab reports the storage estimate", wait_for(page, f"() => !document.querySelector(\"{about_window} [data-field='storage']\").textContent.startsWith('Checking')"))
        text = page.locator(f"{about_window} .about__panel").inner_text()
        check("browser-reported values are labelled as such", "reported by your browser" in text.lower() and "can't see your computer's hardware" in text)
        check("the browser is identified", bool(re.search(r"Browser\s+\S+", text)) and "Blink" in text, text[:300])
        registered = page.evaluate("appManager.getRegisteredApps().filter(a => !a.dynamic).length")
        check("the application count is the real one", f"{registered} installed" in text)
        built = "dist" in os.path.relpath(SITE_ROOT, REPO_ROOT)
        check("build information matches the copy being served", ("built" in text) if built else ("Running from the source files" in text))
        page.locator(f"{about_window} .about__tab[data-tab='system']").focus()
        page.keyboard.press("ArrowRight")
        check("tabs follow the arrow keys", page.locator(f"{about_window} .about__tab[aria-selected='true']").inner_text() == "Applications")
        check("Applications lists every application", page.locator(f"{about_window} .about__app").count() == registered)
        page.keyboard.press("End")
        check("Credits name the font license", "SIL Open Font License" in page.locator(f"{about_window} .about__panel").inner_text())
        close_all(page)

    # ------------------------------------------------------------------
    def first_launch_feedback():
        page.evaluate(
            """async () => { const { eventBus } = await import('./src/core/eventBus.js'); window.__loads = [];
               eventBus.on('app:loading', ({ appId }) => window.__loads.push(['loading', appId, document.body.dataset.appLoading ?? null]));
               eventBus.on('app:loaded', ({ appId }) => window.__loads.push(['loaded', appId])); }"""
        )
        page.evaluate("appManager.launch('clock')")
        page.wait_for_selector(".window[data-window-id='app:clock']")
        loads = page.evaluate("window.__loads")
        check("a first launch announces that the application is loading", loads[:1] == [["loading", "clock", "true"]] and ["loaded", "clock"] in loads, loads)
        check("the loading cursor is cleared afterwards", page.evaluate("document.body.dataset.appLoading") is None)
        close_all(page)
        page.evaluate("window.__loads = []; appManager.launch('clock')")
        page.wait_for_selector(".window[data-window-id='app:clock']")
        check("later launches load nothing", page.evaluate("window.__loads.length") == 0)
        close_all(page)

    # ------------------------------------------------------------------
    def power():
        page.evaluate("appManager.launch('notes')")
        page.wait_for_selector(".window[data-window-id='app:notes']")
        page.evaluate("() => { const app = appManager.getInstance('app:notes'); window.__warning = app.getCloseWarning; app.getCloseWarning = () => 'Unsaved note'; window.__marker = 1; }")
        open_start_menu(page)
        page.get_by_role("button", name="Restart BrowserOS").click()
        page.wait_for_selector(".dialog--visible")
        check("Restart asks about unsaved work", "Unsaved note" in page.locator(".dialog--visible").inner_text())
        dialog_button(page, "Cancel")
        check("cancelling keeps BrowserOS running", page.evaluate("window.__marker") == 1)
        page.evaluate("() => { const app = appManager.getInstance('app:notes'); app.getCloseWarning = window.__warning; }")
        close_all(page)
        open_start_menu(page)
        page.get_by_role("button", name="Restart BrowserOS").click()
        check("Restart starts BrowserOS again", wait_for(page, "() => window.__marker === undefined && document.body.dataset.bootState === 'ready'", 20000))
        open_start_menu(page)
        page.get_by_role("button", name="Shut down BrowserOS").click()
        page.wait_for_selector(".system-screen")
        check("Shut down shows its screen", "has shut down" in page.locator(".system-screen").inner_text())
        held = page.evaluate("navigator.locks.query().then(s => s.held.filter(l => l.name === 'browseros-session').length)")
        check("Shut down gives up the session for other tabs", held == 0, held)
        page.get_by_role("button", name="Start BrowserOS").click()
        check("Start BrowserOS starts it again", wait_for(page, "() => document.body.dataset.bootState === 'ready' && !document.querySelector('.system-screen')", 20000))

    # ------------------------------------------------------------------
    def code_download_failure():
        broken = browser.new_context()
        broken.route("**/src/core/eventBus.js", lambda route: route.abort())
        tab = broken.new_page()
        tab.goto(f"{BASE}/index.html")
        check("a failed code download is reported on the start-up screen", wait_for(tab, "() => document.body.dataset.bootState === 'failed'", 10000))
        check("...with an explanation", "couldn't be loaded" in tab.locator(".boot-screen__status").inner_text())
        check("...and a Reload button", tab.get_by_role("button", name="Reload").count() == 1)
        broken.close()

    # ------------------------------------------------------------------
    def hosting():
        response = page.request.get(f"{BASE}/no/such/page")
        check("unknown paths answer 404 with the BrowserOS page", response.status == 404 and "This page doesn't exist" in response.text())
        check("the 404 page links back to BrowserOS", 'href="/"' in response.text() or "Open BrowserOS" in response.text())
        index = page.request.get(f"{BASE}/index.html")
        check("headers from _headers are sent", index.headers.get("x-content-type-options") == "nosniff" and index.headers.get("x-frame-options") == "SAMEORIGIN", dict(index.headers))
        module = page.request.get(f"{BASE}/src/main.js")
        check("modules are served as JavaScript", module.headers.get("content-type", "").startswith("text/javascript"))
        font = page.request.get(f"{BASE}/assets/fonts/inter-latin.woff2")
        check("fonts are served as font/woff2", font.headers.get("content-type") == "font/woff2")

    for section in [start_up, welcome_tour, sample_files, removing_samples, partial_removal, existing_installation, about, first_launch_feedback, power, code_download_failure, hosting]:
        report.section(section)
    check("no console errors", not report.errors, report.errors[:5])
    browser.close()

server.shutdown()
exit_with(report)
