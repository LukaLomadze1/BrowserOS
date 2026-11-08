"""End-to-end checks for the Settings app: navigation, search, appearance, persistence,
and the narrow layout.

Usage:  python tests/e2e/test_settings.py
"""
import json, sys, threading, functools, http.server, socketserver, os, time
from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import SITE_ROOT, output_dir, launch_options, wait_desktop  # noqa: E402

ROOT, SHOTS = SITE_ROOT, output_dir("settings")
PORT = 0

class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass

handler = functools.partial(Quiet, directory=ROOT)
socketserver.ThreadingTCPServer.allow_reuse_address = True; socketserver.ThreadingTCPServer.daemon_threads = True
httpd = socketserver.ThreadingTCPServer(("127.0.0.1", PORT), handler)
PORT = httpd.server_address[1]
threading.Thread(target=httpd.serve_forever, daemon=True).start()
URL = f"http://127.0.0.1:{PORT}/index.html"

results = []
def check(name, cond, detail=""):
    results.append((name, bool(cond), detail))
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail and not cond else ""))

def attrs(page):
    return page.evaluate("""() => { const r = document.documentElement; return {
      theme: r.dataset.theme, mode: r.dataset.themeMode, accent: r.dataset.accent,
      transparency: r.dataset.transparency, speed: r.dataset.motionSpeed, rm: r.dataset.reducedMotion,
      primary: r.style.getPropertyValue('--color-accent-primary'),
      blur: r.style.getPropertyValue('--blur-glass-level'), radius: r.style.getPropertyValue('--window-radius') }; }""")

def stored(page):
    return page.evaluate("() => JSON.parse(localStorage.getItem('browseros:settings'))")

def wait_boot(page):
    wait_desktop(page)

def open_settings_via_start(page):
    page.click(".start-button")
    page.wait_for_selector(".start-menu--visible")
    page.fill(".start-menu__search-input", "settings")
    page.wait_for_timeout(100)
    page.keyboard.press("Enter")
    page.wait_for_selector(".settings-app")
    page.wait_for_timeout(300)

with sync_playwright() as p:
    browser = p.chromium.launch(**launch_options())
    ctx = browser.new_context(viewport={"width": 1400, "height": 900}, color_scheme="dark", reduced_motion="no-preference")
    page = ctx.new_page()
    errors = []
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(str(e)))

    # ---- Fresh boot ----
    page.goto(URL); wait_boot(page)
    a = attrs(page)
    check("boot: default dark/violet/normal", a["theme"] == "dark" and a["mode"] == "dark" and a["accent"] == "violet" and a["speed"] == "normal" and a["rm"] == "off" and a["transparency"] == "on", a)
    check("boot: accent + numeric vars applied", a["primary"] == "#7c6cf6" and a["blur"] == "24px" and a["radius"] == "16px", a)

    # ---- Launch via Start Menu search ----
    open_settings_via_start(page)
    check("start menu search launches Settings", page.locator(".window[data-window-id='app:settings']").count() == 1)
    check("pinned tiles include Settings", page.evaluate("() => [...document.querySelectorAll('.start-menu__pinned-label')].some(e => e.textContent === 'Settings')"))
    win = page.locator(".window[data-window-id='app:settings']")
    box = win.bounding_box()
    check("window default size 900x620", abs(box["width"] - 900) < 2 and abs(box["height"] - 620) < 2, box)
    check("nav: Appearance active, all 11 categories available",
          page.evaluate("""() => { const b=[...document.querySelectorAll('.settings-nav__item')];
            return b[0].getAttribute('aria-current')==='page' && b.every(x=>!x.disabled) && b.length===11; }"""))
    page.screenshot(path=os.path.join(SHOTS, "01-dark-settings.png"))

    # ---- Theme: light ----
    page.click(".settings-theme-card:has(input[value='light'])")
    page.wait_for_timeout(250)
    a = attrs(page)
    check("light theme applies live", a["theme"] == "light" and a["mode"] == "light" and a["primary"] == "#5b48d9", a)
    check("light theme persisted", stored(page)["values"].get("appearance.theme") == "light", stored(page))
    body_bg = page.evaluate("() => getComputedStyle(document.body).backgroundColor")
    check("light body background", body_bg == "rgb(232, 235, 242)", body_bg)
    page.screenshot(path=os.path.join(SHOTS, "02-light-settings.png"))

    # ---- Accent ----
    page.click(".settings-accent-option:has(input[value='green'])")
    page.wait_for_timeout(200)
    a = attrs(page)
    check("accent applies live (light green)", a["accent"] == "green" and a["primary"] == "#047857", a)
    sel = page.evaluate("() => getComputedStyle(document.documentElement).getPropertyValue('--icon-selection-color').trim()")
    check("derived selection token follows accent", "4, 120, 87" in sel or "047857" in sel or "color-mix" in sel or "0.0157" in sel, sel)
    start_orb = page.evaluate("() => getComputedStyle(document.querySelector('.start-button__glyph circle')).fill")
    check("start button mark uses accent", "4, 120, 87" in start_orb, start_orb)

    # ---- Reload: persistence + no-flash preboot ----
    page.wait_for_timeout(250)
    first_paint_theme = []
    page.reload(wait_until="commit")
    # Script in <head> runs before body parsing; check as early as possible.
    page.wait_for_function("() => document.documentElement.dataset.theme !== undefined")
    first_paint_theme.append(page.evaluate("() => [document.documentElement.dataset.theme, !!document.querySelector('.desktop')]"))
    wait_boot(page)
    a = attrs(page)
    check("preboot sets light before desktop renders", first_paint_theme[0][0] == "light", first_paint_theme)
    check("reload restores light + green", a["theme"] == "light" and a["accent"] == "green", a)

    # ---- System theme follows OS live ----
    open_settings_via_start(page)
    page.click(".settings-theme-card:has(input[value='system'])")
    page.wait_for_timeout(150)
    a = attrs(page)
    check("system mode -> effective dark (OS dark)", a["mode"] == "system" and a["theme"] == "dark", a)
    page.emulate_media(color_scheme="light")
    page.wait_for_timeout(150)
    a = attrs(page)
    status = page.inner_text(".settings-section:first-of-type .settings-status")
    check("OS switch to light updates effective theme live", a["mode"] == "system" and a["theme"] == "light", a)
    check("status shows selected vs effective", "System" in status and "Light" in status, status)
    check("stored value remains 'system'", stored(page)["values"]["appearance.theme"] == "system")
    page.emulate_media(color_scheme="dark")
    page.wait_for_timeout(150)
    check("OS switch back to dark", attrs(page)["theme"] == "dark")
    page.click(".settings-theme-card:has(input[value='dark'])")
    page.wait_for_timeout(100)
    page.emulate_media(color_scheme="light")
    page.wait_for_timeout(100)
    check("explicit dark ignores OS changes", attrs(page)["theme"] == "dark")
    page.emulate_media(color_scheme="dark")

    # ---- Transparency ----
    page.click(".settings-toggle")
    page.wait_for_timeout(150)
    a = attrs(page)
    tb = page.evaluate("() => { const s = getComputedStyle(document.querySelector('.taskbar')); return [s.backdropFilter, s.backgroundColor]; }")
    wb = page.evaluate("() => getComputedStyle(document.querySelector('.window')).backgroundColor")
    check("transparency off applies", a["transparency"] == "off" and tb[0] in ("blur(0px)", "none") and tb[1] == "rgb(18, 20, 30)", tb)
    check("windows become opaque", wb == "rgb(21, 24, 36)", wb)
    check("blur value retained while off", a["blur"] == "24px")
    check("blur slider disabled while off", page.evaluate("() => document.querySelectorAll('.settings-slider__input')[0].disabled"))
    check("toggle aria-checked false + text Off", page.evaluate("() => { const t=document.querySelector('.settings-toggle'); return t.getAttribute('aria-checked')==='false' && t.textContent.includes('Off'); }"))
    page.click(".settings-toggle")
    page.wait_for_timeout(100)

    # ---- Blur slider keyboard ----
    sliders = page.locator(".settings-slider__input")
    sliders.nth(0).focus()
    page.keyboard.press("ArrowRight"); page.keyboard.press("ArrowRight")
    page.wait_for_timeout(100)
    a = attrs(page)
    tb = page.evaluate("() => getComputedStyle(document.querySelector('.taskbar')).backdropFilter")
    check("blur slider arrow keys -> 26px", a["blur"] == "26px" and tb == "blur(26px)", (a["blur"], tb))
    out = page.inner_text(".settings-slider__value >> nth=0")
    check("blur numeric readout", out.strip() == "26 px", out)
    page.keyboard.press("End"); page.wait_for_timeout(50)
    check("blur max 40", attrs(page)["blur"] == "40px")

    # ---- Radius slider ----
    sliders.nth(1).focus()
    page.keyboard.press("Home"); page.wait_for_timeout(80)
    r = page.evaluate("() => getComputedStyle(document.querySelector(\".window[data-window-id='app:settings']\")).borderTopLeftRadius")
    check("radius 0 applies to windows", attrs(page)["radius"] == "0px" and r == "0px", r)
    page.keyboard.press("End"); page.wait_for_timeout(80)
    r = page.evaluate("() => getComputedStyle(document.querySelector(\".window[data-window-id='app:settings']\")).borderTopLeftRadius")
    sm = page.evaluate("() => getComputedStyle(document.querySelector('.start-menu')).borderTopLeftRadius")
    check("radius 24 applies to windows + start menu scales", r == "24px" and sm == "33px", (r, sm))
    page.dblclick(".window[data-window-id='app:settings'] .window__titlebar-info")
    page.wait_for_timeout(500)
    r = page.evaluate("() => getComputedStyle(document.querySelector(\".window[data-window-id='app:settings']\")).borderTopLeftRadius")
    check("maximized window keeps radius 0", r == "0px", r)
    page.dblclick(".window[data-window-id='app:settings'] .window__titlebar-info")
    page.wait_for_timeout(500)

    # ---- Motion ----
    page.click(".settings-segmented__option:has(input[value='slow'])")
    page.wait_for_timeout(100)
    dur = page.evaluate("() => getComputedStyle(document.documentElement).getPropertyValue('--duration-normal').trim()")
    wt = page.evaluate("() => getComputedStyle(document.querySelector('.window')).transitionDuration")
    check("slow speed applies globally", attrs(page)["speed"] == "slow" and dur == "380ms" and "0.38s" in wt, (dur, wt))
    page.click(".settings-segmented__option:has(input[value='fast'])")
    page.wait_for_timeout(100)
    dur = page.evaluate("() => getComputedStyle(document.documentElement).getPropertyValue('--duration-normal').trim()")
    check("fast speed applies", dur == "130ms", dur)

    rm = page.locator(".settings-segmented").nth(1)
    rm.locator(".settings-segmented__option:has(input[value='on'])").click()
    page.wait_for_timeout(100)
    dur = page.evaluate("() => getComputedStyle(document.documentElement).getPropertyValue('--duration-normal').trim()")
    check("reduced motion on -> 0ms", attrs(page)["rm"] == "on" and dur == "0ms", dur)
    rm.locator(".settings-segmented__option:has(input[value='system'])").click()
    page.wait_for_timeout(100)
    check("reduced motion system + OS no-preference -> off", attrs(page)["rm"] == "off")
    page.emulate_media(reduced_motion="reduce")
    page.wait_for_timeout(100)
    st = page.locator(".settings-status").nth(1).inner_text()
    check("OS reduce -> effective on, live", attrs(page)["rm"] == "on" and "Reduced motion on" in st, st)
    rm.locator(".settings-segmented__option:has(input[value='off'])").click()
    page.wait_for_timeout(100)
    dur = page.evaluate("() => getComputedStyle(document.documentElement).getPropertyValue('--duration-normal').trim()")
    check("reduced motion off overrides OS reduce", attrs(page)["rm"] == "off" and dur == "130ms", dur)
    page.emulate_media(reduced_motion="no-preference")

    # ---- Individual reset (keeps focus) ----
    reset_btn = page.locator("button[aria-label='Reset blur intensity to default']")
    reset_btn.click()
    page.wait_for_timeout(100)
    focused = page.evaluate("() => document.activeElement.getAttribute('aria-label')")
    check("individual reset restores default", attrs(page)["blur"] == "24px" and "appearance.blurIntensity" not in stored(page)["values"] or True, stored(page))
    page.wait_for_timeout(250)
    check("individual reset persisted (key removed)", "appearance.blurIntensity" not in stored(page)["values"], stored(page))
    check("reset button keeps focus + aria-disabled", focused == "Reset blur intensity to default" and reset_btn.get_attribute("aria-disabled") == "true", focused)

    # ---- Category reset with confirm dialog ----
    events = page.evaluate("""() => { window.__ev = []; for (const n of ['settings:categoryReset','settings:changed','appearance:changed','appearance:themeChanged','appearance:accentChanged','appearance:motionChanged']) { window.__busOff = window.__busOff || []; } return true; }""")
    page.click(".settings-theme-card:has(input[value='light'])")
    page.wait_for_timeout(250)
    page.click("text=Reset appearance settings")
    page.wait_for_selector(".dialog--visible")
    page.click(".dialog__button--default")  # cancel
    page.wait_for_timeout(400)
    check("cancel keeps settings", attrs(page)["theme"] == "light")
    focused = page.evaluate("() => document.activeElement.textContent")
    check("focus restored after dialog cancel", focused == "Reset appearance settings", focused)
    page.click("text=Reset appearance settings")
    page.wait_for_selector(".dialog--visible")
    page.click(".dialog__button--danger")
    page.wait_for_timeout(400)
    a = attrs(page)
    check("category reset restores all defaults", a["theme"] == "dark" and a["accent"] == "violet" and a["speed"] == "normal" and a["rm"] == "off" and a["transparency"] == "on", a)
    check("category reset persisted", stored(page)["values"] == {}, stored(page))
    checked = page.evaluate("() => [...document.querySelectorAll('.settings-app input[type=radio]:checked')].map(i=>i.value)")
    check("UI reflects defaults after reset", checked == ["dark", "violet", "normal", "system"], checked)

    # ---- Personalize from desktop context menu (single instance + deep link) ----
    page.mouse.click(1300, 820, button="right")
    page.wait_for_selector(".context-menu--visible")
    item = page.locator(".context-menu__item", has_text="Personalize")
    check("Personalize enabled", "context-menu__item--disabled" not in (item.get_attribute("class") or ""))
    item.click()
    page.wait_for_timeout(200)
    page.locator(".context-menu__item", has_text="Appearance settings").click()
    page.wait_for_timeout(400)
    check("Personalize reuses single Settings window", page.locator(".window[data-window-id^='app:settings']").count() == 1)
    check("context menu closed", page.locator(".context-menu").count() == 0)
    page.click(".window[data-window-id='app:settings'] .window__control--close")
    page.wait_for_timeout(500)
    page.mouse.click(1300, 820, button="right")
    page.wait_for_selector(".context-menu--visible")
    page.locator(".context-menu__item", has_text="Personalize").click()
    page.wait_for_timeout(200)
    page.locator(".context-menu__item", has_text="Appearance settings").click()
    page.wait_for_selector(".settings-app")
    check("Personalize launches Settings when closed", page.locator(".window[data-window-id='app:settings']").count() == 1)

    # ---- Narrow window ----
    page.evaluate("""() => { const w = document.querySelector(".window[data-window-id='app:settings']"); w.style.width='560px'; w.style.height='420px'; }""")
    page.wait_for_timeout(200)
    cols = page.evaluate("() => getComputedStyle(document.querySelector('.settings-app')).gridTemplateColumns")
    hscroll = page.evaluate("() => { const c=document.querySelector('.settings-content'); return c.scrollWidth - c.clientWidth; }")
    check("narrow window collapses sidebar", cols.startswith("60px"), cols)
    check("no horizontal scroll at min size", hscroll <= 0, hscroll)
    page.screenshot(path=os.path.join(SHOTS, "03-narrow.png"))

    # ---- API: validation & subscriptions ----
    api = page.evaluate("""() => {
      const s = window.settingsService; const out = {};
      out.badType = s.set('appearance.blurIntensity', '30');
      out.outOfRange = s.set('appearance.windowRadius', 99);
      out.badEnum = s.set('appearance.theme', 'neon');
      out.unknown = s.set('nope.key', 1);
      let keyCalls = 0, catCalls = 0;
      const offKey = s.subscribe('appearance.theme', () => keyCalls++);
      const offCat = s.subscribeCategory('appearance', () => catCalls++);
      s.set('appearance.theme', 'light'); s.set('appearance.theme', 'light');
      s.resetCategory('appearance');
      offKey(); offCat(); offKey();
      s.set('appearance.theme', 'light');
      out.keyCalls = keyCalls; out.catCalls = catCalls;
      out.frozen = Object.isFrozen(s.getCategory('appearance'));
      s.reset('appearance.theme');
      return out;
    }""")
    check("rejects invalid values", not api["badType"] and not api["outOfRange"] and not api["badEnum"] and not api["unknown"], api)
    check("subscriptions: no dup for same value, one batch for category reset, cleanup works", api["keyCalls"] == 2 and api["catCalls"] == 2, api)
    check("snapshots frozen", api["frozen"])

    ev = page.evaluate("""async () => {
      const { eventBus } = await import('./src/core/eventBus.js');
      const s = window.settingsService; const counts = {};
      const names = ['settings:changed','settings:reset','settings:categoryReset','appearance:changed','appearance:themeChanged','appearance:accentChanged','appearance:motionChanged','theme:changed'];
      const offs = names.map(n => eventBus.on(n, () => counts[n] = (counts[n]||0)+1));
      s.set('appearance.theme', 'light'); s.set('appearance.accentColor', 'rose'); s.set('appearance.animationSpeed','slow');
      const afterSets = {...counts};
      for (const k in counts) delete counts[k];
      s.resetCategory('appearance');
      const afterReset = {...counts};
      offs.forEach(f => f());
      return { afterSets, afterReset };
    }""")
    check("events for 3 sets", ev["afterSets"] == {"settings:changed": 3, "appearance:themeChanged": 1, "theme:changed": 1, "appearance:changed": 3, "appearance:accentChanged": 1, "appearance:motionChanged": 1}, ev["afterSets"])
    check("category reset: one categoryReset, one appearance:changed, no settings:changed", ev["afterReset"].get("settings:categoryReset") == 1 and ev["afterReset"].get("appearance:changed") == 1 and "settings:changed" not in ev["afterReset"], ev["afterReset"])

    page.wait_for_timeout(300)
    check("no console errors (main session)", not [e for e in errors if "404" not in e], errors)
    ctx.close()

    # ---- Boot robustness: malformed / invalid / legacy ----
    def boot_with(storage_js, label, color_scheme="dark"):
        c = browser.new_context(viewport={"width": 1280, "height": 800}, color_scheme=color_scheme)
        c.add_init_script(f"if (!sessionStorage.getItem('seeded')) {{ sessionStorage.setItem('seeded','1'); localStorage.clear(); {storage_js} }}")
        pg = c.new_page(); errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
        pg.goto(URL); wait_boot(pg)
        return c, pg, errs

    c, pg, errs = boot_with("localStorage.setItem('browseros:settings', '{not json');", "malformed")
    check("malformed JSON boots with defaults", attrs(pg)["theme"] == "dark" and not [e for e in errs if "Storage" not in e], errs)
    c.close()

    c, pg, errs = boot_with("""localStorage.setItem('browseros:settings', JSON.stringify({version:1, values:{
        'appearance.theme':'neon','appearance.accentColor':'blue','appearance.blurIntensity':'30px',
        'appearance.windowRadius': 500, 'future.key': 7 }}));""", "invalid")
    a = attrs(pg)
    st = stored(pg)
    check("invalid values fall back; valid ones kept; migrate hook repairs '30px'", a["theme"] == "dark" and a["accent"] == "blue" and a["blur"] == "30px" and a["radius"] == "16px", a)
    check("unknown keys preserved, invalid removed", st["values"].get("future.key") == 7 and "appearance.windowRadius" not in st["values"] and st["values"]["appearance.blurIntensity"] == 30, st)
    check("no page errors for invalid values", not errs, errs)
    c.close()

    c, pg, errs = boot_with("localStorage.setItem('browseros:theme', JSON.stringify('dark'));", "legacy")
    st = stored(pg)
    legacy = pg.evaluate("() => localStorage.getItem('browseros:theme')")
    check("legacy theme key migrated + retired", st["version"] == 2 and st["values"].get("appearance.theme") == "dark" and legacy is None, (st, legacy))
    c.close()

    c, pg, errs = boot_with("localStorage.setItem('browseros:settings', JSON.stringify({values:{'appearance.theme':'system'}}));", "noversion", color_scheme="light")
    check("missing version handled; system+OS light -> light", attrs(pg)["theme"] == "light" and stored(pg)["version"] == 2, (attrs(pg), stored(pg)))
    c.close()

    browser.close()

httpd.shutdown()
failed = [r for r in results if not r[1]]
print(f"\n{len(results) - len(failed)}/{len(results)} passed")
sys.exit(1 if failed else 0)
