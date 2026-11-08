"""End-to-end checks for data safety and recovery: Trash and Recycle Bin,
backup and restore, one active tab per profile, start-up failures,
nested copies, modal dialogs, large files in Code Studio, Terminal
scrollback, and a complete cross-application workflow.

Usage:  python tests/e2e/test_release.py
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from playwright.sync_api import sync_playwright  # noqa: E402
from common import Report, boot, close_all, dialog_button, output_dir, serve, wait_desktop, wait_for, exit_with  # noqa: E402

OUT = output_dir("release")
server, BASE = serve()
report = Report()
check = report.check

EXPLORER = ".window:has(.explorer)"
RECYCLE = ".window[data-window-id='app:recycle-bin']"
CS = "appManager.getInstance('app:code-studio')"


def terminal_run(page, command):
    """Type a command into the open Terminal window and return the text of the output."""
    field = page.locator(".window:has(.terminal-app) .terminal__input").last
    field.fill(command)
    field.press("Enter")
    page.wait_for_timeout(350)
    return page.locator(".window:has(.terminal-app) .terminal__output").last.inner_text()


with sync_playwright() as playwright:
    browser = playwright.chromium.launch()
    context = browser.new_context(viewport={"width": 1440, "height": 900}, accept_downloads=True)
    page = context.new_page()
    page.set_default_timeout(10000)
    report.watch_console(page)
    boot(page, BASE)

    # ------------------------------------------------------------------
    def recycle_bin():
        page.evaluate("""async () => {
          if (await vfs.exists('/Documents/Keep')) await vfs.delete('/Documents/Keep');
          await vfs.emptyTrash();
          await vfs.createFolder('/Documents/Keep');
          await vfs.createFile('/Documents/Keep/plan.txt', 'plan');
          await vfs.createFile('/Desktop/old.txt', 'old');
        }""")
        page.evaluate("appManager.launch('recycle-bin')")
        page.wait_for_selector(f"{RECYCLE} .recycle-bin__empty:not([hidden])")
        check("Recycle Bin shows its empty state when Trash is empty", page.locator(f"{RECYCLE} .recycle-bin__message").inner_text() == "Recycle Bin is empty")
        page.evaluate("async () => { await vfs.delete('/Documents/Keep/plan.txt'); await vfs.delete('/Desktop/old.txt'); }")
        check("deleted items appear without reopening", wait_for(page, f"() => document.querySelectorAll(\"{RECYCLE} .recycle-bin__row\").length === 2"))
        rows = page.locator(f"{RECYCLE} .recycle-bin__row").all_inner_texts()
        check("rows show the original location", any("/Documents/Keep" in row for row in rows) and any("/Desktop" in row for row in rows), rows)
        page.locator(f"{RECYCLE} .recycle-bin__row", has_text="plan.txt").click()
        page.locator(RECYCLE).get_by_role("button", name="Restore", exact=True).click()
        check("Restore puts the file back", wait_for(page, "async () => await vfs.exists('/Documents/Keep/plan.txt')"))
        check("restored item leaves the list", wait_for(page, f"() => document.querySelectorAll(\"{RECYCLE} .recycle-bin__row\").length === 1"))
        # Keyboard: focus the list, Delete asks, confirm deletes permanently.
        page.locator(f"{RECYCLE} .recycle-bin__list").focus()
        page.keyboard.press("ArrowDown")
        page.keyboard.press("Delete")
        page.wait_for_selector(".dialog--visible")
        check("permanent delete asks first", "can't be undone" in page.locator(".dialog--visible").inner_text())
        dialog_button(page, "Delete permanently")
        check("Delete removes the item for good", wait_for(page, "async () => !(await vfs.exists('/Trash/old.txt'))"))
        # Empty Recycle Bin
        page.evaluate("async () => { await vfs.createFile('/Desktop/a1.txt', '1'); await vfs.createFile('/Desktop/a2.txt', '2'); await vfs.delete('/Desktop/a1.txt'); await vfs.delete('/Desktop/a2.txt'); }")
        wait_for(page, f"() => document.querySelectorAll(\"{RECYCLE} .recycle-bin__row\").length === 2")
        page.locator(RECYCLE).get_by_role("button", name="Empty Recycle Bin").click()
        dialog_button(page, "Empty Recycle Bin")
        check("Empty Recycle Bin clears Trash", wait_for(page, "async () => (await vfs.list('/Trash')).length === 0"))
        page.screenshot(path=os.path.join(OUT, "recycle-bin.png"))

    # ------------------------------------------------------------------
    def explorer_trash():
        page.evaluate("async () => { await vfs.createFile('/Documents/trash-me.txt', 't'); await vfs.delete('/Documents/trash-me.txt'); }")
        page.evaluate("appManager.launch('file-explorer', { path: '/Trash' })")
        page.wait_for_selector(f"{EXPLORER} .explorer__row")
        page.locator(f"{EXPLORER} .explorer__row", has_text="trash-me.txt").click(button="right")
        menu = page.locator(".context-menu").last.inner_text()
        check("Trash item menu offers Restore and Delete permanently", "Restore" in menu and "Delete permanently" in menu, menu)
        check("Trash item menu has no Rename or Cut", "Rename" not in menu and "Cut" not in menu, menu)
        page.locator(".context-menu").last.get_by_text("Restore", exact=True).click()
        check("Explorer restores from Trash", wait_for(page, "async () => await vfs.exists('/Documents/trash-me.txt')"))
        page.evaluate("async () => { await vfs.delete('/Documents/trash-me.txt'); }")
        page.wait_for_timeout(300)
        page.locator(f"{EXPLORER} .explorer__row", has_text="trash-me.txt").click()
        page.keyboard.press("Delete")
        page.wait_for_selector(".dialog--visible")
        check("Delete in Trash asks to delete permanently", "Delete permanently" in page.locator(".dialog--visible").inner_text())
        dialog_button(page, "Delete permanently")
        check("Delete in Trash removes the file", wait_for(page, "async () => !(await vfs.exists('/Trash/trash-me.txt'))"))

    # ------------------------------------------------------------------
    def terminal_trash():
        page.evaluate("appManager.launch('terminal')")
        page.wait_for_selector(".window:has(.terminal-app) .terminal__input")
        terminal_run(page, "touch /Documents/t1.txt")
        terminal_run(page, "rm /Documents/t1.txt")
        out = terminal_run(page, "rm /Trash/t1.txt")
        check("rm refuses items already in Trash", "already in Trash" in out)
        out = terminal_run(page, "restore t1.txt")
        check("restore brings an item back", "Restored /Documents/t1.txt" in out and page.evaluate("vfs.exists('/Documents/t1.txt')"))
        terminal_run(page, "rm /Documents/t1.txt")
        out = terminal_run(page, "emptytrash")
        check("emptytrash asks for --yes", "emptytrash --yes" in out and page.evaluate("vfs.exists('/Trash/t1.txt')"))
        out = terminal_run(page, "emptytrash --yes")
        check("emptytrash --yes empties Trash", "Permanently deleted 1 item" in out and not page.evaluate("vfs.exists('/Trash/t1.txt')"))
        out = terminal_run(page, "version")
        check("version prints the release version", "BrowserOS 16.0" in out, out[-80:])
        # Scrollback stays bounded.
        count = page.evaluate("""() => { const id = appManager.getWindowIds('terminal').at(-1); const view = appManager.getInstance(id)._manager._view;
            for (let i = 0; i < 2300; i++) view.appendLine({ text: 'line ' + i, type: 'success' });
            return document.querySelectorAll('.window:has(.terminal-app) .terminal__output')[0].childElementCount; }""")
        check("terminal keeps at most 2000 output blocks", count == 2000, count)

    # ------------------------------------------------------------------
    def backup_and_restore():
        page.evaluate("""async () => {
          if (await vfs.exists('/Documents/Backup Test')) { await vfs.delete('/Documents/Backup Test'); }
          await vfs.createFolder('/Documents/Backup Test');
          await vfs.createFile('/Documents/Backup Test/note.txt', 'before ✓');
          const png = await (await fetch('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==')).blob();
          await vfs.createFile('/Documents/Backup Test/pixel.png', png);
          settingsService.set('appearance.theme', 'light'); settingsService.flush();
        }""")
        page.evaluate("appManager.launch('settings', { page: 'system', anchor: 'backup' })")
        page.wait_for_selector(".settings-file-input", state="attached")
        with page.expect_download() as download:
            page.get_by_role("button", name="Back up everything").click()
        full = os.path.join(OUT, "full-backup.json")
        download.value.save_as(full)
        document = json.load(open(full, encoding="utf-8"))
        check("full backup has format, version, and checksum", document["format"] == "browseros-backup" and document["formatVersion"] == 1 and document["checksum"]["algorithm"] == "SHA-256")
        check("full backup includes settings", "settings" in document["storage"])
        # Change data after the backup.
        page.evaluate("async () => { await vfs.write('/Documents/Backup Test/note.txt', 'after'); await vfs.createFile('/Documents/Backup Test/new.txt', 'n'); settingsService.set('appearance.theme', 'dark'); settingsService.flush(); }")
        # A damaged copy is refused and changes nothing.
        damaged = dict(document)
        damaged["entries"] = json.loads(json.dumps(document["entries"]))
        for entry in damaged["entries"]:
            if entry["name"] == "note.txt":
                entry["content"]["data"] = "tampered"
        damaged_path = os.path.join(OUT, "damaged-backup.json")
        open(damaged_path, "w", encoding="utf-8").write(json.dumps(damaged))
        page.locator(".settings-file-input").set_input_files(damaged_path)
        page.wait_for_selector(".dialog--visible")
        check("damaged backup is refused", "damaged" in page.locator(".dialog--visible").inner_text())
        dialog_button(page, "OK")
        check("refused backup changed nothing", page.evaluate("vfs.read('/Documents/Backup Test/note.txt')") == "after")
        # Cancel leaves everything as is.
        page.locator(".settings-file-input").set_input_files(full)
        page.wait_for_selector(".dialog--visible")
        check("full restore asks for confirmation", "Replace all BrowserOS data?" in page.locator(".dialog--visible .dialog__title").inner_text())
        dialog_button(page, "Cancel")
        check("cancelled restore changed nothing", page.evaluate("vfs.exists('/Documents/Backup Test/new.txt')"))
        # Replace everything: BrowserOS restarts with the backup's data.
        page.locator(".settings-file-input").set_input_files(full)
        page.wait_for_selector(".dialog--visible")
        dialog_button(page, "Replace everything")
        page.wait_for_timeout(1500)
        wait_desktop(page)
        check("restored text file", page.evaluate("vfs.read('/Documents/Backup Test/note.txt')") == "before ✓")
        check("files created after the backup are gone", not page.evaluate("vfs.exists('/Documents/Backup Test/new.txt')"))
        check("restored binary file", page.evaluate("vfs.getInfo('/Documents/Backup Test/pixel.png').then(e => e.size)") == 70)
        check("restored settings", page.evaluate("settingsService.get('appearance.theme')") == "light")
        # Folder backup restores into a chosen folder without replacing.
        page.evaluate("appManager.launch('settings', { page: 'system', anchor: 'backup' })")
        page.wait_for_selector(".settings-file-input", state="attached")
        page.get_by_role("button", name="Back up a folder…").click()
        page.wait_for_selector(".dialog--visible .folder-picker__list")
        page.locator(".dialog--visible").get_by_role("listitem", name="Open Documents", exact=True).click() if page.locator(".dialog--visible").get_by_role("listitem", name="Open Documents", exact=True).count() else None
        page.locator(".dialog--visible").get_by_role("listitem", name="Open Backup Test", exact=True).click()
        page.wait_for_timeout(300)
        with page.expect_download() as download:
            dialog_button(page, "Select folder")
        folder = os.path.join(OUT, "folder-backup.json")
        download.value.save_as(folder)
        check("folder backup scope", json.load(open(folder, encoding="utf-8"))["scope"] == "folder")
        page.locator(".settings-file-input").set_input_files(folder)
        page.wait_for_selector(".dialog--visible")
        dialog_button(page, "Choose a folder…")
        page.wait_for_selector(".dialog--visible .folder-picker__list")
        page.wait_for_timeout(300)
        dialog_button(page, "Select folder")
        check("folder restore adds a numbered copy", wait_for(page, "async () => await vfs.exists('/Documents/Backup Test (1)/note.txt')"))
        check("folder restore kept the original", page.evaluate("vfs.read('/Documents/Backup Test/note.txt')") == "before ✓")
        close_all(page)

    # ------------------------------------------------------------------
    def one_active_tab():
        page.evaluate("settingsService.set('desktop.showLabels', true); settingsService.flush()")
        second = context.new_page()
        second.goto(f"{BASE}/index.html")
        second.wait_for_selector(".system-screen", timeout=10000)
        check("a second tab waits instead of starting", second.locator(".window").count() == 0 and "open in another tab" in second.locator(".system-screen__title").inner_text())
        # Unsaved work in the active tab: it asks, and keeping it denies the takeover.
        page.evaluate("appManager.launch('notes')")
        page.wait_for_selector(".window[data-window-id='app:notes']")
        page.evaluate("""() => { const app = appManager.getInstance('app:notes'); window.__warning = app.getCloseWarning; app.getCloseWarning = () => 'Unsaved note'; }""")
        second.get_by_role("button", name="Use BrowserOS here").click()
        page.wait_for_selector(".dialog--visible")
        check("active tab asks before handing over unsaved work", "Unsaved note" in page.locator(".dialog--visible").inner_text())
        check("waiting tab explains it is waiting", wait_for(second, "() => document.querySelector('.system-screen__status')?.textContent.includes('unsaved changes')"))
        dialog_button(page, "Keep using this tab")
        check("declining keeps the session", wait_for(second, "() => document.querySelector('.system-screen__status')?.textContent.includes('still being used')"))
        page.evaluate("() => { const app = appManager.getInstance('app:notes'); app.getCloseWarning = window.__warning; }")
        close_all(page)
        # Takeover moves the session, and data written in the first tab is visible.
        page.evaluate("settingsService.set('desktop.showLabels', false)")
        second.get_by_role("button", name="Use BrowserOS here").click()
        second.wait_for_selector("body[data-boot-state='ready']", timeout=15000)
        page.wait_for_selector(".system-screen", timeout=5000)
        check("the first tab pauses", "open in another tab" in page.locator(".system-screen__title").inner_text())
        check("the new tab sees the first tab's last change", second.evaluate("settingsService.get('desktop.showLabels')") is False)
        check("the paused tab is inert", page.evaluate("document.getElementById('app-root').inert"))
        # And back again with one click.
        page.get_by_role("button", name="Use BrowserOS here").click()
        page.wait_for_selector("body[data-boot-state='ready']", timeout=15000)
        second.wait_for_selector(".system-screen", timeout=5000)
        check("the session can move back", page.locator(".system-screen").count() == 0)
        second.close()
        page.evaluate("settingsService.set('desktop.showLabels', true)")

    # ------------------------------------------------------------------
    def startup_failures():
        failing = browser.new_context()
        failing.add_init_script("Object.defineProperty(window, 'indexedDB', { value: { open() { throw new Error('IndexedDB is disabled for this test'); } } });")
        broken = failing.new_page()
        broken.goto(f"{BASE}/index.html")
        broken.wait_for_selector(".system-screen", timeout=10000)
        text = broken.locator(".system-screen").inner_text()
        check("storage failure shows a recovery screen", "couldn't start" in text and "IndexedDB" in text, text[:200])
        check("recovery screen offers Try again", broken.get_by_role("button", name="Try again").count() == 1)
        failing.close()
        # BrowserOS inside its own Browser (same origin) refuses to start.
        page.evaluate("""() => { const f = document.createElement('iframe'); f.id = 'nested'; f.src = 'index.html'; f.style.cssText = 'position:fixed;left:0;top:0;width:400px;height:300px'; document.body.append(f); }""")
        frame = page.frame_locator("#nested")
        frame.locator(".system-screen").wait_for(timeout=10000)
        check("a nested copy does not start", "already running" in frame.locator(".system-screen__title").inner_text())
        check("the outer copy keeps the session", page.locator(".system-screen").count() == 0)
        page.evaluate("document.getElementById('nested').remove()")

    # ------------------------------------------------------------------
    def modal_dialogs():
        page.evaluate("appManager.launch('file-explorer', { path: '/Documents' })")
        page.wait_for_selector(f"{EXPLORER} .explorer__row")
        page.evaluate("""async () => { const m = await import('./src/components/dialog/confirmDialog.js'); window.__result = m.showConfirmDialog({ title: 'Probe', message: 'Modal?' }); }""")
        page.wait_for_selector(".dialog--visible")
        check("desktop is inert while a dialog is open", page.evaluate("document.getElementById('app-root').inert"))
        inside = True
        for _ in range(5):
            page.keyboard.press("Tab")
            inside = inside and page.evaluate("!!document.activeElement.closest('.dialog')")
        page.keyboard.press("Shift+Tab")
        inside = inside and page.evaluate("!!document.activeElement.closest('.dialog')")
        check("Tab and Shift+Tab stay inside the dialog", inside)
        page.keyboard.press("Escape")
        page.wait_for_timeout(300)
        check("closing the dialog restores the desktop", not page.evaluate("document.getElementById('app-root').inert"))
        close_all(page)

    # ------------------------------------------------------------------
    def large_file_editing():
        page.evaluate("""async () => { const lines = []; for (let i = 1; i <= 20000; i++) lines.push('const value' + i + ' = [1, 2, 3].map((x) => x * ' + i + ');');
            const text = lines.join(String.fromCharCode(10)); const p = '/Documents/large.js'; if (await vfs.exists(p)) await vfs.write(p, text); else await vfs.createFile(p, text); }""")
        page.evaluate("settingsService.set('codeStudio.wordWrap', true)")
        started = page.evaluate("performance.now()")
        page.evaluate("appManager.launch('code-studio', { path: '/Documents/large.js' })")
        page.wait_for_selector(".window[data-window-id='app:code-studio'] .cs-editor:not([hidden]) .cs-line", timeout=15000)
        opened = page.evaluate("performance.now()") - started
        editor = ".window[data-window-id='app:code-studio'] .cs-editor:not([hidden])"
        rows = page.evaluate(f"document.querySelectorAll(\"{editor} .cs-line:not(.cs-line--probe)\").length")
        check("a 20,000-line file renders only rows near the viewport", rows < 200, rows)
        check("a 20,000-line file opens in under 3 seconds", opened < 3000, round(opened))
        check("word wrap is paused for large files", "Wrap: off (large file)" in page.locator(".window[data-window-id='app:code-studio'] .cs-statusbar").inner_text())
        page.keyboard.press("Control+g")
        page.keyboard.type("15000")
        page.keyboard.press("Enter")
        page.wait_for_timeout(400)
        current = page.evaluate(f"""() => {{ const lines = document.querySelector("{editor} .cs-editor__lines"); const rows = [...lines.querySelectorAll('.cs-line:not(.cs-line--probe)')];
            const start = +getComputedStyle(lines).counterReset.split(' ')[1]; const cur = lines.querySelector('.cs-line--current'); return [start + rows.indexOf(cur) + 1, cur.textContent]; }}""")
        check("go to line 15000 renders and highlights it", current[0] == 15000 and current[1].startswith("const value15000"), current)
        page.keyboard.press("End")
        page.keyboard.type(" // edited")
        timing = page.evaluate("""async () => { const t0 = performance.now(); for (let i = 0; i < 5; i++) { document.execCommand('insertText', false, 'x'); await new Promise(r => requestAnimationFrame(() => r())); } return (performance.now() - t0) / 5; }""")
        check("typing in a large file stays responsive (< 150 ms per keystroke)", timing < 150, round(timing))
        page.keyboard.press("Control+s")
        check("saving a large file writes the edit", wait_for(page, "async () => (await vfs.read('/Documents/large.js')).split(String.fromCharCode(10))[14999].endsWith('// editedxxxxx')"))
        page.evaluate("settingsService.set('codeStudio.wordWrap', false)")
        close_all(page)

    # ------------------------------------------------------------------
    def cross_application_workflow():
        """Create a project, find it in File Explorer, edit and save a file, and read it from Terminal."""
        page.evaluate("async () => { if (await vfs.exists('/Projects/Workflow Site')) await vfs.delete('/Projects/Workflow Site'); }")
        page.evaluate("appManager.launch('code-studio')")
        page.wait_for_selector(".window[data-window-id='app:code-studio'] .code-studio")
        page.evaluate(f"() => {{ {CS}._newProject(); }}")
        page.wait_for_selector(".dialog--visible input")
        page.locator(".dialog--visible input").first.fill("Workflow Site")
        page.locator(".dialog--visible select").first.select_option("html")
        dialog_button(page, "Create")
        check("Code Studio creates the project in the file system", wait_for(page, "async () => await vfs.exists('/Projects/Workflow Site/index.html')"))
        close_all(page)
        page.evaluate("appManager.launch('file-explorer', { path: '/Projects' })")
        page.wait_for_selector(f"{EXPLORER} .explorer__row")
        page.locator(f"{EXPLORER} .explorer__row", has_text="Workflow Site").dblclick()
        page.wait_for_selector(f"{EXPLORER} .explorer__row:has-text('index.html')")
        check("File Explorer shows the project files", page.locator(f"{EXPLORER} .explorer__row", has_text="index.html").count() == 1)
        page.locator(f"{EXPLORER} .explorer__row", has_text="index.html").click(button="right")
        page.locator(".context-menu--visible .context-menu__item", has_text="Open with").click()
        page.locator(".context-menu--visible").last.locator(".context-menu__item", has_text="Code Studio").click()
        page.wait_for_selector(".window[data-window-id='app:code-studio'] .cs-editor:not([hidden]) .cs-editor__input")
        page.wait_for_timeout(400)
        page.locator(".window[data-window-id='app:code-studio'] .cs-editor:not([hidden]) .cs-editor__input").focus()
        page.keyboard.press("Control+End")
        page.keyboard.type("<!-- edited in Code Studio -->")
        page.keyboard.press("Control+s")
        check("the edit is saved to the file system", wait_for(page, "async () => (await vfs.read('/Projects/Workflow Site/index.html')).includes('edited in Code Studio')"))
        page.evaluate("appManager.launch('terminal')")
        page.wait_for_selector(".window:has(.terminal-app) .terminal__input")
        terminal_run(page, 'cd "/Projects/Workflow Site"')
        out = terminal_run(page, "pwd")
        check("Terminal navigates to the project", "/Projects/Workflow Site" in out)
        out = terminal_run(page, "cat index.html")
        check("Terminal reads the saved edit", "edited in Code Studio" in out)
        close_all(page)

    for section in [recycle_bin, explorer_trash, terminal_trash, backup_and_restore, one_active_tab, startup_failures, modal_dialogs, large_file_editing, cross_application_workflow]:
        report.section(section, before=lambda: close_all(page))

    check("no BrowserOS console errors", not report.errors, report.errors[:10])
    browser.close()

server.shutdown()
exit_with(report)
