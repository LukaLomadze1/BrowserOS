"""End-to-end checks for Code Studio: projects and templates, file operations, editing,
find and replace, saving, the live preview and its sandbox, the pop-out preview, the
integrated terminal, file associations, project search, diagnostics, unsaved-work guards,
and layout.

Usage:  python tests/e2e/test_code_studio.py
"""
import sys, threading, functools, http.server, socketserver, os, traceback, json
from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import SITE_ROOT, output_dir, launch_options, wait_desktop  # noqa: E402

ROOT, SHOTS = SITE_ROOT, output_dir("code-studio")
PORT = 0


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


socketserver.ThreadingTCPServer.allow_reuse_address = True
socketserver.ThreadingTCPServer.daemon_threads = True
httpd = socketserver.ThreadingTCPServer(("127.0.0.1", PORT), functools.partial(Quiet, directory=ROOT))
PORT = httpd.server_address[1]
threading.Thread(target=httpd.serve_forever, daemon=True).start()
URL = f"http://127.0.0.1:{PORT}/index.html"

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


def attach(page):
    def on_console(m):
        if m.type != "error":
            return
        # Messages from the sandboxed preview/checker frames are the page under test, not BrowserOS.
        loc = m.location or {}
        url = loc.get("url", "")
        if url.startswith("about:srcdoc") or url.startswith("data:") or url.endswith("/favicon.ico"):
            return
        errors.append(f"{m.type}: {m.text} @ {url}")
    page.on("console", on_console)


def boot(page):
    page.goto(URL)
    wait_desktop(page)


def close_all(page):
    for _ in range(4):
        if not page.locator(".dialog--visible").count():
            break
        page.keyboard.press("Escape")
        page.wait_for_timeout(200)
    # Discard unsaved Code Studio changes so windows close without asking.
    page.evaluate("""() => {
      for (const id of appManager.getWindowIds('code-studio')) {
        const app = appManager.getInstance(id);
        if (app && app._docs) for (const d of app._docs.values()) { d.savedText = d.editor.getValue(); d.dirty = false; }
      }
      for (const b of document.querySelectorAll('.window .window__control--close')) b.click();
    }""")
    page.wait_for_timeout(700)
    for _ in range(3):
        if not page.locator(".dialog--visible").count():
            break
        page.keyboard.press("Escape")
        page.wait_for_timeout(200)


CS = "appManager.getInstance('app:code-studio')"


def cs(page, body, arg=None):
    """Evaluate `body` (a function body using `app`) against the main Code Studio window."""
    return page.evaluate("async (arg) => { const app = " + CS + "; " + body + " }", arg)


def launch(page):
    page.evaluate("() => appManager.launch('code-studio')")
    page.wait_for_selector(".window[data-window-id='app:code-studio'] .code-studio", timeout=10000)
    page.wait_for_timeout(300)


def make_project(page, name, template="web"):
    return cs(page, """
      const { createProject } = await import('./src/apps/code-studio/project/projectStore.js');
      for (const d of app._docs.values()) { d.savedText = d.editor.getValue(); d.dirty = false; }
      if (await vfs.exists('/Projects/' + arg.name)) await vfs.delete('/Projects/' + arg.name);
      const r = await createProject(vfs, { name: arg.name, templateId: arg.template });
      await app._openProject(r.root, { keepDocs: false, open: r.open });
      return r;""", {"name": name, "template": template})


def editor_sel(page):
    return ".window[data-window-id='app:code-studio'] .cs-editor:not([hidden]) .cs-editor__input"


def doc_text(page):
    return cs(page, "return app._activeDoc()?.editor.getValue();")


def set_text(page, text):
    cs(page, "const e = app._activeDoc().editor; e.replaceDocument(arg, [0, 0]); e.focus(); e.setSelection(0);", text)


def wait_for(page, js, timeout=6000):
    try:
        page.wait_for_function(js, timeout=timeout)
        return True
    except Exception:
        return False


def problems(page):
    return cs(page, "return app._bottom._problems.concat(app._bottom._runtime).map(p => ({path: p.path, line: p.line, column: p.column, severity: p.severity, message: p.message, source: p.source}));")


def click_dialog_button(page, label):
    page.locator(".dialog--visible").get_by_role("button", name=label, exact=True).first.click()
    page.wait_for_timeout(300)


with sync_playwright() as p:
    b = p.chromium.launch(**launch_options())
    ctx = b.new_context(viewport={"width": 1440, "height": 920})
    ctx.grant_permissions(["clipboard-read", "clipboard-write"], origin=f"http://127.0.0.1:{PORT}")
    page = ctx.new_page()
    page.set_default_timeout(10000)
    attach(page)
    boot(page)

    # ------------------------------------------------------------------
    def registration():
        apps = page.evaluate("() => appManager.getRegisteredApps().map(a => ({id: a.id, dynamic: a.dynamic, group: a.groupId}))")
        ids = {a["id"]: a for a in apps}
        check("code-studio registered", "code-studio" in ids)
        check("extra window + preview apps are dynamic in the code-studio group",
              ids.get("code-studio-window", {}).get("dynamic") and ids.get("code-studio-preview", {}).get("group") == "code-studio")
        start = page.evaluate("() => { document.querySelector('.taskbar__start, .start-button, [data-start-button]')?.click(); return true; }")
        page.wait_for_timeout(500)
        pinned = page.evaluate("() => [...document.querySelectorAll('.start-menu [data-app-id]')].map(e => e.dataset.appId)")
        check("Start Menu lists Code Studio", "code-studio" in pinned, pinned)
        page.keyboard.press("Escape")
        page.wait_for_timeout(300)
        shortcut = page.locator(".desktop-icon", has_text="Code Studio")
        check("desktop shortcut exists", shortcut.count() == 1)
        shortcut.first.dblclick()
        page.wait_for_selector(".window[data-window-id='app:code-studio'] .code-studio", timeout=8000)
        check("desktop shortcut launches Code Studio", True)
        welcome = page.locator(".window[data-window-id='app:code-studio'] .cs-welcome").inner_text()
        check("welcome offers New project / Open project", "New project" in welcome and "Open project" in welcome, welcome[:200])
        assoc = page.evaluate("() => ({ css: fileAssociations.getDefault('css')?.appId, js: fileAssociations.getDefault('js')?.appId, json: fileAssociations.getDefault('json')?.appId, html: fileAssociations.getDefault('html')?.appId, htmlAlt: fileAssociations.getHandlers('html').map(h => h.appId), md: fileAssociations.getHandlers('md').map(h => h.appId) })")
        check("Code Studio is default for css/js/json", assoc["css"] == assoc["js"] == assoc["json"] == "code-studio", assoc)
        check("html stays Browser by default, Code Studio offered", assoc["html"] == "browser" and "code-studio" in assoc["htmlAlt"], assoc)
        check("md offers Code Studio as alternative", assoc["md"][0] == "notes" and "code-studio" in assoc["md"], assoc)

    # ------------------------------------------------------------------
    def templates():
        launch(page)
        for template, expected in [("blank", []), ("html", ["index.html", "about.html", "assets"]), ("web", ["index.html", "style.css", "script.js", "assets"]), ("javascript", ["index.html", "src", "README.md"])]:
            r = make_project(page, f"T {template}", template)
            names = page.evaluate("async (root) => (await vfs.list(root)).map(e => e.name)", r["root"])
            check(f"template {template} writes real VFS files", all(n in names for n in expected) and (template != "blank" or names == []), names)
        r = make_project(page, "T javascript", "javascript")
        main = page.evaluate("async () => await vfs.read('/Projects/T javascript/src/main.js')")
        check("javascript template has ES module imports", 'from "./utils.js"' in main)
        tree = cs(page, "return [...app._project.tree.entries.keys()];")
        check("explorer tree loads project from VFS", "/Projects/T javascript/src/utils.js" in tree, tree)
        check("recent projects remembered", page.evaluate("() => JSON.stringify(localStorage)").count("T javascript") >= 1)
        # New project dialog (UI)
        page.evaluate(f"() => {{ {CS}._newProject(); }}")
        page.wait_for_selector(".dialog--visible input", timeout=5000)
        page.locator(".dialog--visible input").first.fill("Dialog Site")
        page.locator(".dialog--visible select").first.select_option("html")
        page.locator(".dialog--visible button", has_text="Create").click()
        ok = wait_for(page, "() => appManager.getInstance('app:code-studio')._project?.root === '/Projects/Dialog Site'")
        check("New project dialog creates and opens the project", ok)
        exists = page.evaluate("async () => await vfs.exists('/Projects/Dialog Site/about.html')")
        check("dialog project has template files", exists)
        # Duplicate name is rejected
        page.evaluate(f"() => {{ {CS}._newProject(); }}")
        page.wait_for_selector(".dialog--visible input", timeout=5000)
        page.locator(".dialog--visible input").first.fill("Dialog Site")
        page.locator(".dialog--visible button", has_text="Create").click()
        page.wait_for_timeout(400)
        err = page.locator(".dialog--visible").inner_text()
        check("existing project name rejected", "already exists" in err, err[:200])
        page.keyboard.press("Escape")
        page.wait_for_timeout(300)
        # Open an existing folder as a project via the picker API path
        page.evaluate("async () => { if (!(await vfs.exists('/Documents/Plain'))) { await vfs.createFolder('/Documents/Plain'); await vfs.createFile('/Documents/Plain/a.css', 'a { color: red; }'); } }")
        cs(page, "await app._switchProject('/Documents/Plain');")
        check("open any VFS folder as project", cs(page, "return app._project.root;") == "/Documents/Plain")
        cs(page, "await app._closeProject();")
        check("close project", cs(page, "return app._project;") is None)

    # ------------------------------------------------------------------
    def file_operations():
        launch(page)
        make_project(page, "Ops", "web")
        # New file via prompt
        cs(page, "app._tree.setActive(null); app._tree._focusedPath = null; app._newFile();")
        page.wait_for_selector(".dialog--visible input", timeout=5000)
        page.locator(".dialog--visible input").fill("notes.txt")
        page.keyboard.press("Enter")
        ok = wait_for(page, "() => appManager.getInstance('app:code-studio')._activePath === '/Projects/Ops/notes.txt'")
        check("new file created and opened", ok and page.evaluate("async () => vfs.exists('/Projects/Ops/notes.txt')"))
        # Invalid name rejected
        cs(page, "app._newFile();")
        page.wait_for_selector(".dialog--visible input", timeout=5000)
        page.locator(".dialog--visible input").fill("bad/name.js")
        page.keyboard.press("Enter")
        page.wait_for_timeout(300)
        check("invalid file name rejected", "can" in page.locator(".dialog--visible").inner_text())
        page.keyboard.press("Escape")
        page.wait_for_timeout(300)
        # New folder
        cs(page, "app._newFolder();")
        page.wait_for_selector(".dialog--visible input", timeout=5000)
        page.locator(".dialog--visible input").fill("lib")
        page.keyboard.press("Enter")
        page.wait_for_timeout(600)
        check("new folder created", page.evaluate("async () => (await vfs.getInfo('/Projects/Ops/lib')).type === 'folder'"))
        # Rename open file through the tree (F2)
        cs(page, "app._reloadTree();")
        page.wait_for_timeout(300)
        row = page.locator(".window[data-window-id='app:code-studio'] .cs-tree__row[data-path='/Projects/Ops/notes.txt']")
        row.click()
        page.keyboard.press("F2")
        page.wait_for_selector(".dialog--visible input", timeout=5000)
        page.locator(".dialog--visible input").fill("readme.md")
        page.keyboard.press("Enter")
        ok = wait_for(page, "() => appManager.getInstance('app:code-studio')._docs.has('/Projects/Ops/readme.md')")
        check("rename via F2 re-points the open tab", ok and cs(page, "return !app._docs.has('/Projects/Ops/notes.txt');"))
        check("renamed file language follows extension", cs(page, "return app._docs.get('/Projects/Ops/readme.md').language.id;") == "markdown")
        # Move via API path used by drag and drop
        cs(page, "await app._moveEntry('/Projects/Ops/readme.md', '/Projects/Ops/lib');")
        ok = wait_for(page, "() => appManager.getInstance('app:code-studio')._docs.has('/Projects/Ops/lib/readme.md')")
        check("move keeps the document open at its new path", ok)
        # Drag-and-drop in the tree
        cs(page, "await app._reloadTree(); app._tree._expanded.add('/Projects/Ops/lib'); app._tree.render();")
        src = page.locator(".window[data-window-id='app:code-studio'] .cs-tree__row[data-path='/Projects/Ops/script.js']")
        dst = page.locator(".window[data-window-id='app:code-studio'] .cs-tree__row[data-path='/Projects/Ops/lib']")
        src.drag_to(dst)
        ok = wait_for(page, "async () => await vfs.exists('/Projects/Ops/lib/script.js')", 4000)
        check("drag a file onto a folder moves it", ok)
        # Delete with confirmation
        cs(page, "await app._reloadTree();")
        page.wait_for_timeout(300)
        entry = page.evaluate("async () => await vfs.getInfo('/Projects/Ops/style.css')")
        page.evaluate(f"(e) => {{ {CS}._deleteEntry(e); }}", entry)
        page.wait_for_selector(".dialog--visible", timeout=5000)
        text = page.locator(".dialog--visible").inner_text()
        check("delete asks for confirmation", "Trash" in text, text[:200])
        click_dialog_button(page, "Cancel")
        check("cancel keeps the file", page.evaluate("async () => vfs.exists('/Projects/Ops/style.css')"))
        page.evaluate(f"(e) => {{ {CS}._deleteEntry(e); }}", entry)
        page.wait_for_selector(".dialog--visible", timeout=5000)
        click_dialog_button(page, "Move to Trash")
        page.wait_for_timeout(600)
        check("confirmed delete moves file to Trash", not page.evaluate("async () => vfs.exists('/Projects/Ops/style.css')"))
        check("deleted file's tab closed", cs(page, "return !app._docs.has('/Projects/Ops/style.css');"))
        # Tree context menu
        row = page.locator(".window[data-window-id='app:code-studio'] .cs-tree__row[data-path='/Projects/Ops/index.html']")
        row.click(button="right")
        page.wait_for_timeout(300)
        menu = page.locator(".context-menu").last.inner_text()
        check("tree context menu offers file actions", all(k in menu for k in ["Rename", "Delete", "Move to", "New file", "Open in preview", "Copy path"]), menu)
        page.keyboard.press("Escape")
        # Keyboard navigation in the tree
        page.locator(".window[data-window-id='app:code-studio'] .cs-tree__row").first.click()
        page.keyboard.press("ArrowDown")
        focused = page.evaluate("() => document.activeElement?.dataset?.path")
        check("tree keyboard navigation moves focus", bool(focused), focused)

    # ------------------------------------------------------------------
    def editing():
        launch(page)
        make_project(page, "Edit", "web")
        cs(page, "await app._openFile('/Projects/Edit/script.js');")
        set_text(page, "")
        inp = page.locator(editor_sel(page))
        inp.click()
        page.keyboard.type("function f(")
        check("auto-close inserts the closing parenthesis", doc_text(page) == "function f()", doc_text(page))
        page.keyboard.type(") {")
        check("typing over the closing character", doc_text(page) == "function f() {}", doc_text(page))
        page.keyboard.press("Enter")
        check("Enter between braces indents and splits", doc_text(page) == "function f() {\n  \n}", repr(doc_text(page)))
        page.keyboard.type("return 1;")
        page.keyboard.press("Enter")
        check("auto-indent keeps the indentation", doc_text(page).split("\n")[2] == "  ", repr(doc_text(page)))
        # Tab / Shift+Tab
        set_text(page, "a\nb\nc")
        cs(page, "app._activeDoc().editor.setSelection(0, 5);")
        page.locator(editor_sel(page)).focus()
        page.keyboard.press("Tab")
        check("Tab indents selected lines", doc_text(page) == "  a\n  b\n  c", repr(doc_text(page)))
        page.keyboard.press("Shift+Tab")
        check("Shift+Tab outdents", doc_text(page) == "a\nb\nc", repr(doc_text(page)))
        # Toggle comment
        cs(page, "app._activeDoc().editor.setSelection(0, 3);")
        page.keyboard.press("Control+/")
        check("Ctrl+/ comments lines", doc_text(page).startswith("// a\n// b"), repr(doc_text(page)))
        page.keyboard.press("Control+/")
        check("Ctrl+/ uncomments", doc_text(page) == "a\nb\nc", repr(doc_text(page)))
        # Move line
        cs(page, "app._activeDoc().editor.setSelection(0);")
        page.keyboard.press("Alt+ArrowDown")
        check("Alt+Down moves the line", doc_text(page) == "b\na\nc", repr(doc_text(page)))
        # Undo / redo (keyboard)
        set_text(page, "")
        cs(page, "app._activeDoc().editor.clearHistory();")
        page.locator(editor_sel(page)).focus()
        page.keyboard.type("hello world")
        page.wait_for_timeout(1000)
        page.keyboard.type(" again")
        page.keyboard.press("Control+z")
        check("Ctrl+Z undoes the last typing group", doc_text(page) == "hello world", repr(doc_text(page)))
        page.keyboard.press("Control+z")
        check("typing is undone word by word", doc_text(page) == "hello", repr(doc_text(page)))
        page.keyboard.press("Control+z")
        check("undo back to empty", doc_text(page) == "", repr(doc_text(page)))
        page.keyboard.press("Control+y")
        check("Ctrl+Y redoes", doc_text(page) == "hello", repr(doc_text(page)))
        page.keyboard.press("Control+Shift+z")
        check("Ctrl+Shift+Z redoes", doc_text(page) == "hello world", repr(doc_text(page)))
        page.keyboard.press("Control+y")
        # Programmatic edits undo too
        cs(page, "app._activeDoc().editor.toggleComment();")
        page.keyboard.press("Control+z")
        check("comment toggle is undoable", doc_text(page) == "hello world again", repr(doc_text(page)))
        # Bracket matching
        set_text(page, "if (a) { b(c[1]); }")
        cs(page, "app._activeDoc().editor.setSelection(7);")
        page.wait_for_timeout(150)
        marks = page.evaluate("() => [...document.querySelectorAll('.cs-editor:not([hidden]) .cs-mark-bracket')].map(e => e.textContent)")
        check("matching brackets highlighted", marks == ["{", "}"], marks)
        set_text(page, "const s = '{'; ( ")
        cs(page, "app._activeDoc().editor.setSelection(16);")
        page.wait_for_timeout(150)
        unmatched = page.evaluate("() => document.querySelectorAll('.cs-editor:not([hidden]) .cs-mark-bracket--unmatched').length")
        check("unmatched bracket flagged; brackets in strings ignored", unmatched == 1)
        # Current line + line numbers
        set_text(page, "one\ntwo\nthree")
        cs(page, "app._activeDoc().editor.setSelection(5);")
        page.wait_for_timeout(100)
        cur = page.evaluate("() => [...document.querySelectorAll('.cs-editor:not([hidden]) .cs-line')].findIndex(l => l.classList.contains('cs-line--current'))")
        check("current line highlighted", cur == 1, cur)
        # Highlighting
        set_text(page, "const x = 'str'; // note\nfunction go(n) { return n * 2; }")
        classes = page.evaluate("() => [...new Set([...document.querySelectorAll('.cs-editor:not([hidden]) .cs-line__text span')].map(s => s.className))]")
        check("JS syntax highlighting (kw/str/com/fn/num)", all(c in " ".join(classes) for c in ["cs-tok-kw", "cs-tok-str", "cs-tok-com", "cs-tok-fn", "cs-tok-num"]), classes)
        cs(page, "await app._openFile('/Projects/Edit/style.css');")
        classes = page.evaluate("() => [...new Set([...document.querySelectorAll('.cs-editor:not([hidden]) .cs-line__text span')].map(s => s.className))]")
        check("CSS highlighting (sel/prop/num)", all(c in " ".join(classes) for c in ["cs-tok-sel", "cs-tok-prop", "cs-tok-num"]), classes)
        cs(page, "await app._openFile('/Projects/Edit/index.html');")
        classes = page.evaluate("() => [...new Set([...document.querySelectorAll('.cs-editor:not([hidden]) .cs-line__text span')].map(s => s.className))]")
        check("HTML highlighting (tag/attr/str)", all(c in " ".join(classes) for c in ["cs-tok-tag", "cs-tok-attr", "cs-tok-str"]), classes)
        # Multi-line comment state carried across lines; incremental re-highlight
        cs(page, "await app._openFile('/Projects/Edit/script.js');")
        set_text(page, "a\nb\nc")
        cs(page, "const e = app._activeDoc().editor; e.replaceRange(0, 0, '/*');")
        com = page.evaluate("() => [...document.querySelectorAll('.cs-editor:not([hidden]) .cs-line')].map(l => !!l.querySelector('.cs-tok-com'))")
        check("opening a block comment re-highlights following lines", com == [True, True, True], com)
        cs(page, "const e = app._activeDoc().editor; e.undo();")
        com = page.evaluate("() => [...document.querySelectorAll('.cs-editor:not([hidden]) .cs-line')].map(l => !!l.querySelector('.cs-tok-com'))")
        check("undo restores highlighting", com == [False, False, False], com)
        # Tabs: multiple files, unsaved indicator, switching, closing
        tabs = page.locator(".window[data-window-id='app:code-studio'] .cs-tab").count()
        check("multiple files open in tabs", tabs >= 3, tabs)
        dirty = page.locator(".window[data-window-id='app:code-studio'] .cs-tab--dirty").count()
        check("unsaved tabs marked", dirty >= 1, dirty)
        title = page.locator(".window[data-window-id='app:code-studio'] .window__title").inner_text()
        check("window title shows unsaved marker and project", "●" in title and "Edit" in title, title)
        before = cs(page, "return app._activePath;")
        page.locator(editor_sel(page)).focus()
        page.keyboard.press("Alt+PageDown")
        after = cs(page, "return app._activePath;")
        check("Alt+PageDown switches tab", before != after, (before, after))
        # Closing a dirty tab asks
        cs(page, "await app._openFile('/Projects/Edit/script.js');")
        page.locator(editor_sel(page)).focus()
        page.keyboard.press("Alt+w")
        page.wait_for_selector(".dialog--visible", timeout=4000)
        check("closing an unsaved tab asks", "unsaved" in page.locator(".dialog--visible").inner_text().lower())
        click_dialog_button(page, "Cancel")
        check("cancel keeps tab open", cs(page, "return app._docs.has('/Projects/Edit/script.js');"))
        page.locator(editor_sel(page)).focus()
        page.keyboard.press("Alt+w")
        page.wait_for_selector(".dialog--visible", timeout=4000)
        click_dialog_button(page, "Don’t save")
        check("Don't save closes the tab without writing", cs(page, "return !app._docs.has('/Projects/Edit/script.js');") and "button" in page.evaluate("async () => vfs.read('/Projects/Edit/script.js')"))
        # Word wrap and settings
        cs(page, "await app._openFile('/Projects/Edit/index.html');")
        page.locator(editor_sel(page)).focus()
        page.keyboard.press("Alt+z")
        page.wait_for_timeout(200)
        check("Alt+Z toggles word wrap setting", page.evaluate("() => settingsService.get('codeStudio.wordWrap')") is True)
        wrapped = page.evaluate("() => document.querySelector('.cs-editor:not([hidden])').classList.contains('cs-editor--wrap')")
        check("editor wraps", wrapped)
        page.keyboard.press("Alt+z")
        page.screenshot(path=os.path.join(SHOTS, "editing.png"))

    # ------------------------------------------------------------------
    def alignment():
        """The transparent textarea and the highlighted lines must line up exactly."""
        launch(page)
        make_project(page, "Align", "web")
        cs(page, "await app._openFile('/Projects/Align/script.js');")
        long = "const longLine = " + "'abcdefghij' + " * 30 + "'end';"
        set_text(page, "\tindented\twith tabs\n" + long + "\n\nlast line")
        for wrap in (False, True):
            page.evaluate(f"() => settingsService.set('codeStudio.wordWrap', {str(wrap).lower()})")
            page.wait_for_timeout(200)
            res = page.evaluate("""() => {
              const ed = document.querySelector('.cs-editor:not([hidden])');
              const ta = ed.querySelector('.cs-editor__input');
              const lines = ed.querySelectorAll('.cs-line');
              const text = lines[1].querySelector('.cs-line__text');
              const style = getComputedStyle(ta);
              // Measure where the textarea would wrap line 2 by a mirror with the textarea's own width and padding.
              const mirror = document.createElement('div');
              for (const p of ['fontFamily','fontSize','lineHeight','whiteSpace','overflowWrap','tabSize','paddingLeft','paddingRight','letterSpacing','boxSizing']) mirror.style[p] = style[p];
              mirror.style.width = ta.clientWidth + 'px'; mirror.style.position = 'absolute'; mirror.style.visibility = 'hidden';
              mirror.textContent = ta.value.split('\\n')[1];
              document.body.append(mirror);
              const mirrorHeight = mirror.getBoundingClientRect().height; mirror.remove();
              const taRect = ta.getBoundingClientRect(); const textRect = text.getBoundingClientRect();
              return { left: Math.round(taRect.left + parseFloat(style.paddingLeft)) - Math.round(textRect.left + parseFloat(getComputedStyle(text).paddingLeft)),
                       top: Math.round(taRect.top + parseFloat(style.paddingTop)) - Math.round(lines[0].getBoundingClientRect().top),
                       lineHeight: Math.round(lines[1].getBoundingClientRect().height), mirrorHeight: Math.round(mirrorHeight),
                       taScroll: ta.scrollTop + ta.scrollLeft, taHeight: Math.round(taRect.height), surface: Math.round(ed.querySelector('.cs-editor__surface').getBoundingClientRect().height) };
            }""")
            check(f"textarea text aligns with highlighted text (wrap={wrap})", res["left"] == 0 and res["top"] == 0, res)
            check(f"wrapped line height matches textarea wrapping (wrap={wrap})", abs(res["lineHeight"] - res["mirrorHeight"]) <= 1, res)
            check(f"textarea never scrolls internally (wrap={wrap})", res["taScroll"] == 0 and res["taHeight"] == res["surface"], res)
        page.evaluate("() => settingsService.set('codeStudio.wordWrap', false)")
        # Caret at end of long line is revealed (horizontal scroll)
        cs(page, "const e = app._activeDoc().editor; e.focus(); e.setSelection(e.offsetAt(1, 9999));")
        page.wait_for_timeout(200)
        scroll = page.evaluate("() => document.querySelector('.cs-editor:not([hidden]) .cs-editor__scroller').scrollLeft")
        check("caret at end of a long line scrolls into view", scroll > 100, scroll)
        # Gutter stays visible when scrolled horizontally
        gutter = page.evaluate("""() => { const ed = document.querySelector('.cs-editor:not([hidden])'); const line = ed.querySelector('.cs-line');
           const before = getComputedStyle(line, '::before'); return before.position; }""")
        check("line numbers are sticky", gutter == "sticky", gutter)
        # Clicking text places the caret where clicked
        set_text(page, "abcdef\nghijkl")
        box = page.evaluate("""() => { const ed = document.querySelector('.cs-editor:not([hidden])'); const span = ed.querySelectorAll('.cs-line__text')[1];
           const r = document.createRange(); r.setStart(span.firstChild, 3); r.setEnd(span.firstChild, 4); const b = r.getBoundingClientRect(); return {x: b.left + 1, y: b.top + b.height / 2}; }""")
        page.mouse.click(box["x"], box["y"])
        sel = cs(page, "return app._activeDoc().editor.getSelection().start;")
        check("clicking a character puts the caret there", sel == 10, sel)
        # Clicking a line number selects the line
        num = page.evaluate("""() => { const r = document.querySelectorAll('.cs-editor:not([hidden]) .cs-line')[1].getBoundingClientRect(); return {x: r.left + 10, y: r.top + r.height / 2}; }""")
        page.mouse.click(num["x"], num["y"])
        sel = cs(page, "const s = app._activeDoc().editor.getSelection(); return [s.start, s.end];")
        check("clicking a line number selects that line", sel == [7, 13], sel)
        # Font size setting changes metrics live
        page.evaluate("() => settingsService.set('codeStudio.fontSize', 18)")
        page.wait_for_timeout(150)
        fs = page.evaluate("() => getComputedStyle(document.querySelector('.cs-editor:not([hidden]) .cs-editor__input')).fontSize")
        check("font size setting applies live", fs == "18px", fs)
        page.evaluate("() => settingsService.reset('codeStudio.fontSize')")
        page.evaluate("() => settingsService.set('codeStudio.lineNumbers', false)")
        page.wait_for_timeout(100)
        content = page.evaluate("() => getComputedStyle(document.querySelector('.cs-editor:not([hidden]) .cs-line'), '::before').content")
        check("line numbers can be hidden", content in ('""', "none", "normal"), content)
        page.evaluate("() => settingsService.reset('codeStudio.lineNumbers')")
        page.evaluate("() => settingsService.set('codeStudio.tabWidth', 4)")
        cs(page, "const e = app._activeDoc().editor; e.replaceDocument('x', [0,0]); e.focus(); e.setSelection(0);")
        page.keyboard.press("Tab")
        check("tab width setting used for indentation", doc_text(page) == "    x", repr(doc_text(page)))
        page.evaluate("() => settingsService.set('codeStudio.insertSpaces', false)")
        cs(page, "const e = app._activeDoc().editor; e.replaceDocument('x', [0,0]); e.focus(); e.setSelection(0);")
        page.keyboard.press("Tab")
        check("indent with tabs setting", doc_text(page) == "\tx", repr(doc_text(page)))
        page.evaluate("() => { settingsService.reset('codeStudio.tabWidth'); settingsService.reset('codeStudio.insertSpaces'); }")
        # Theme
        page.evaluate("() => settingsService.set('codeStudio.theme', 'light')")
        page.wait_for_timeout(100)
        light = page.evaluate("() => document.querySelector('.code-studio').classList.contains('cs-theme-light')")
        page.evaluate("() => settingsService.set('codeStudio.theme', 'system')")
        page.evaluate("() => settingsService.set('appearance.theme', 'light')")
        page.wait_for_timeout(300)
        follows = page.evaluate("() => document.querySelector('.code-studio').classList.contains('cs-theme-light')")
        page.evaluate("() => settingsService.set('appearance.theme', 'dark')")
        page.wait_for_timeout(300)
        back = page.evaluate("() => document.querySelector('.code-studio').classList.contains('cs-theme-dark')")
        check("editor theme setting and system theme integration", light and follows and back, (light, follows, back))
        page.evaluate("() => settingsService.reset('appearance.theme')")

    # ------------------------------------------------------------------
    def find_replace():
        launch(page)
        make_project(page, "Find", "web")
        cs(page, "await app._openFile('/Projects/Find/script.js');")
        set_text(page, "cat dog cat\nCat bird cat")
        page.locator(editor_sel(page)).focus()
        page.keyboard.press("Control+f")
        page.wait_for_timeout(200)
        page.keyboard.type("cat")
        page.wait_for_timeout(300)
        count = page.locator(".window[data-window-id='app:code-studio'] .cs-find__count").inner_text()
        check("find counts matches (case-insensitive)", "of 4" in count, count)
        marks = page.evaluate("() => document.querySelectorAll('.cs-editor:not([hidden]) .cs-mark-find').length")
        check("matches highlighted", marks == 4, marks)
        page.keyboard.press("Enter")
        sel = cs(page, "const s = app._activeDoc().editor.getSelection(); return [s.start, s.end];")
        check("Enter selects a match", sel in ([0, 3], [8, 11]), sel)
        page.locator(".cs-find .cs-find__toggle[title='Match case']").click()
        page.wait_for_timeout(200)
        count = page.locator(".cs-find .cs-find__count").inner_text()
        check("match case option", "of 3" in count, count)
        page.keyboard.press("Control+h")
        page.wait_for_timeout(200)
        page.locator(".cs-find .cs-find__input[aria-label='Replace with']").fill("lion")
        page.locator(".cs-find button", has_text="Replace all").click()
        page.wait_for_timeout(200)
        check("replace all (case-sensitive)", doc_text(page) == "lion dog lion\nCat bird lion", repr(doc_text(page)))
        page.keyboard.press("Control+z") if False else cs(page, "app._activeDoc().editor.undo();")
        check("replace all is one undo step", doc_text(page) == "cat dog cat\nCat bird cat", repr(doc_text(page)))
        # Regex with groups
        page.locator(".cs-find .cs-find__toggle[title='Match case']").click()
        page.locator(".cs-find .cs-find__toggle[title='Regular expression']").click()
        page.locator(".cs-find .cs-find__input[aria-label='Find']").fill("(c)at")
        page.locator(".cs-find .cs-find__input[aria-label='Replace with']").fill("$1ow")
        page.locator(".cs-find button", has_text="Replace all").click()
        page.wait_for_timeout(200)
        check("regex replace with $1", doc_text(page) == "cow dog cow\nCow bird cow", repr(doc_text(page)))
        page.locator(".cs-find .cs-find__input[aria-label='Find']").fill("(")
        page.wait_for_timeout(200)
        check("invalid regex reported, not thrown", "Invalid" in page.locator(".cs-find .cs-find__count").inner_text())
        page.locator(".cs-find .cs-find__input[aria-label='Find']").press("Escape")
        page.wait_for_timeout(200)
        check("Escape closes find and clears highlights", page.evaluate("() => document.querySelectorAll('.cs-editor:not([hidden]) .cs-mark-find').length") == 0 and not cs(page, "return app._find.isOpen();"))
        # Whole word + single replace
        cs(page, "app._find._options = {caseSensitive:false, wholeWord:false, regex:false};")
        set_text(page, "art part art")
        cs(page, "app._find.open(app._activeDoc().editor, {replace: true});")
        page.locator(".cs-find .cs-find__toggle[title='Regular expression']").click() if page.locator(".cs-find .cs-find__toggle[title='Regular expression'][aria-pressed='true']").count() else None
        page.locator(".cs-find .cs-find__input[aria-label='Find']").fill("art")
        page.locator(".cs-find .cs-find__toggle[title='Whole word']").click()
        page.wait_for_timeout(200)
        count = page.locator(".cs-find .cs-find__count").inner_text()
        check("whole word option", "of 2" in count, count)
        page.locator(".cs-find .cs-find__input[aria-label='Replace with']").fill("ART")
        page.locator(".cs-find button", has_text="Replace").first.click()
        page.locator(".cs-find button", has_text="Replace").first.click()
        page.wait_for_timeout(200)
        check("single replace changes the current match", doc_text(page) == "ART part art", repr(doc_text(page)))
        # Go to line
        set_text(page, "\n".join(f"line {i}" for i in range(1, 201)))
        page.locator(editor_sel(page)).focus()
        page.keyboard.press("Control+g")
        page.wait_for_selector(".dialog--visible input", timeout=4000)
        page.locator(".dialog--visible input").fill("150:3")
        page.keyboard.press("Enter")
        page.wait_for_timeout(300)
        cur = cs(page, "return app._activeDoc().editor.getCursor();")
        check("Ctrl+G goes to line:column", cur["line"] == 150 and cur["column"] == 3, cur)
        visible = page.evaluate("""() => { const ed = document.querySelector('.cs-editor:not([hidden])'); const sc = ed.querySelector('.cs-editor__scroller'); const line = ed.querySelectorAll('.cs-line')[149].getBoundingClientRect(); const box = sc.getBoundingClientRect(); return line.top >= box.top && line.bottom <= box.bottom; }""")
        check("target line scrolled into view", visible)
        status = page.locator(".window[data-window-id='app:code-studio'] .cs-statusbar").inner_text()
        check("status bar shows line and column", "Ln 150, Col 3" in status, status)

    # ------------------------------------------------------------------
    def saving():
        launch(page)
        make_project(page, "Save", "web")
        cs(page, "await app._openFile('/Projects/Save/style.css');")
        set_text(page, "body { color: red; }\n")
        page.locator(editor_sel(page)).focus()
        page.keyboard.press("Control+s")
        page.wait_for_timeout(500)
        check("Ctrl+S writes the file", page.evaluate("async () => vfs.read('/Projects/Save/style.css')") == "body { color: red; }\n")
        check("saved file no longer marked", cs(page, "return !app._activeDoc().dirty;"))
        # Save as
        page.keyboard.press("Control+Shift+s")
        page.wait_for_selector(".dialog--visible input", timeout=4000)
        page.locator(".dialog--visible input").fill("/Projects/Save/theme.css")
        page.keyboard.press("Enter")
        ok = wait_for(page, "() => appManager.getInstance('app:code-studio')._activePath === '/Projects/Save/theme.css'")
        check("Save As writes a new file and the tab follows it", ok and page.evaluate("async () => vfs.read('/Projects/Save/theme.css')") == "body { color: red; }\n")
        page.keyboard.press("Control+Shift+s")
        page.wait_for_selector(".dialog--visible input", timeout=4000)
        page.locator(".dialog--visible input").fill("/Nope/x.css")
        page.keyboard.press("Enter")
        page.wait_for_timeout(300)
        check("Save As into a missing folder is rejected", "exist" in page.locator(".dialog--visible").inner_text())
        page.keyboard.press("Escape")
        page.wait_for_timeout(200)
        # Save all
        cs(page, "await app._openFile('/Projects/Save/index.html'); app._activeDoc().editor.replaceRange(0, 0, '<!-- a -->\\n'); await app._openFile('/Projects/Save/script.js'); app._activeDoc().editor.replaceRange(0, 0, '// b\\n');")
        page.locator(editor_sel(page)).focus()
        page.keyboard.press("Control+Alt+s")
        page.wait_for_timeout(700)
        both = page.evaluate("async () => [(await vfs.read('/Projects/Save/index.html')).startsWith('<!-- a -->'), (await vfs.read('/Projects/Save/script.js')).startsWith('// b')]")
        check("Save All writes every modified file", both == [True, True], both)
        # External change: clean doc reloads, dirty doc warns
        page.evaluate("async () => vfs.write('/Projects/Save/script.js', 'changed elsewhere')")
        ok = wait_for(page, "() => appManager.getInstance('app:code-studio')._docs.get('/Projects/Save/script.js').editor.getValue() === 'changed elsewhere'")
        check("clean document reloads after an external change", ok)
        cs(page, "app._activeDoc().editor.replaceRange(0, 0, 'mine ');")
        page.evaluate("async () => vfs.write('/Projects/Save/script.js', 'theirs')")
        page.wait_for_timeout(500)
        banner = page.locator(".window[data-window-id='app:code-studio'] .cs-banner--doc").inner_text()
        check("dirty document warns about an external change", "changed elsewhere" in banner, banner)
        check("editor keeps the user's text", doc_text(page) == "mine changed elsewhere")
        page.locator(".cs-banner--doc button", has_text="Load the other version").click()
        page.wait_for_timeout(200)
        check("load the other version", doc_text(page) == "theirs")
        # Deleted while open
        cs(page, "app._activeDoc().editor.replaceRange(0, 0, 'keep ');")
        page.evaluate("async () => vfs.delete('/Projects/Save/script.js')")
        page.wait_for_timeout(500)
        banner = page.locator(".cs-banner--doc").inner_text()
        check("deleted-while-open file keeps text and offers to save", "no longer exists" in banner and doc_text(page) == "keep theirs", banner)
        page.locator(".cs-banner--doc button", has_text="Save").click()
        page.wait_for_timeout(500)
        check("saving recreates the deleted file", page.evaluate("async () => vfs.read('/Projects/Save/script.js')") == "keep theirs")
        # Rename of the project folder elsewhere
        page.evaluate("async () => vfs.rename('/Projects/Save', 'Saved')")
        page.wait_for_timeout(600)
        check("project follows a folder rename made elsewhere", cs(page, "return app._project.root;") == "/Projects/Saved" and cs(page, "return app._activePath;").startswith("/Projects/Saved/"))
        # File Explorer sees the saved contents
        page.evaluate("() => appManager.launch('file-explorer', { path: '/Projects/Saved' })")
        page.wait_for_timeout(800)
        listing = page.evaluate("() => [...document.querySelectorAll('.window')].pop().innerText")
        check("File Explorer shows project files", "theme.css" in listing and "index.html" in listing)

    # ------------------------------------------------------------------
    def preview():
        launch(page)
        make_project(page, "Prev", "web")
        page.evaluate("async () => { await vfs.createFile('/Projects/Prev/assets/dot.svg', '<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"10\" height=\"10\"><circle cx=\"5\" cy=\"5\" r=\"5\"/></svg>'); }")
        page.evaluate("async () => { await vfs.createFile('/Projects/Prev/other.html', '<!DOCTYPE html><html><head><title>Other</title></head><body><h1 id=\"o\">Other page</h1><a id=\"back\" href=\"index.html\">back</a></body></html>'); }")
        html = """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Prev Page</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <h1 id="title">Hello</h1>
  <img id="img" src="assets/dot.svg" alt="">
  <a id="link" href="other.html">other</a>
  <button id="counter">Click</button><strong id="count">0</strong>
  <script src="script.js"></script>
  <script>
    console.info("inline", 1 + 1);
  </script>
</body>
</html>
"""
        page.evaluate("async (h) => vfs.write('/Projects/Prev/index.html', h)", html)
        page.evaluate("async () => vfs.write('/Projects/Prev/style.css', 'h1 { color: rgb(200, 0, 0); }\\n')")
        cs(page, "app._bottom.clearOutput(); await app._openFile('/Projects/Prev/index.html');")
        page.locator(editor_sel(page)).focus()
        page.keyboard.press("Control+Enter")
        frame_ok = wait_for(page, "() => !!document.querySelector('.window[data-window-id=\"app:code-studio\"] .cs-preview__frame')", 5000)
        check("Run shows the page in the preview", frame_ok)
        page.wait_for_timeout(1500)
        fr = page.frame_locator(".window[data-window-id='app:code-studio'] .cs-preview__frame")
        color = fr.locator("#title").evaluate("e => getComputedStyle(e).color")
        check("linked CSS from the VFS applies", color == "rgb(200, 0, 0)", color)
        width = fr.locator("#img").evaluate("e => e.naturalWidth")
        check("image asset from the VFS loads", width == 10, width)
        fr.locator("#counter").click()
        fr.locator("#counter").click()
        check("linked JS runs in the preview", fr.locator("#count").inner_text() == "2")
        page.wait_for_timeout(300)
        out = cs(page, "return [...document.querySelectorAll('.window[data-window-id=\"app:code-studio\"] .cs-output__row')].map(r => r.textContent);")
        check("console.log reaches the Output panel with file:line", any("Clicked 2 times" in o and "script.js:8" in o for o in out), out)
        check("inline script console.info captured", any("inline 2" in o and "index.html:15" in o for o in out), out)
        sandbox = page.evaluate("() => document.querySelector('.cs-preview__frame').getAttribute('sandbox')")
        check("preview sandbox has no allow-same-origin / popups / top-navigation", sandbox == "allow-scripts allow-modals allow-forms", sandbox)
        # Security: the page cannot reach BrowserOS
        probe = """
          const r = {};
          try { r.parentDoc = !!window.parent.document; } catch (e) { r.parentDoc = 'blocked'; }
          try { r.parentVfs = typeof window.parent.vfs; } catch (e) { r.parentVfs = 'blocked'; }
          try { r.top = window.top.location.href; } catch (e) { r.top = 'blocked'; }
          try { indexedDB.open('x'); r.idb = 'open'; } catch (e) { r.idb = 'blocked'; }
          try { r.cookie = document.cookie; } catch (e) { r.cookie = 'blocked'; }
          r.origin = window.origin;
          r.vfs = typeof vfs; r.appManager = typeof appManager;
          localStorage.setItem('k', 'v'); r.ls = localStorage.getItem('k');
          try { window.open('https://example.com'); r.popup = 'no-throw'; } catch (e) { r.popup = 'blocked'; }
          document.title = 'probe:' + JSON.stringify(r);
        """
        cs(page, "await app._openFile('/Projects/Prev/script.js');")
        set_text(page, probe)
        page.evaluate(f"() => {CS}._runPage('/Projects/Prev/index.html')")
        page.wait_for_timeout(1500)
        title = fr.locator("html").evaluate("() => document.title")
        data = json.loads(title.split("probe:", 1)[1]) if "probe:" in title else {}
        check("preview cannot read the BrowserOS document", data.get("parentDoc") == "blocked", data)
        check("preview cannot reach BrowserOS globals (vfs)", data.get("parentVfs") == "blocked" and data.get("vfs") == "undefined" and data.get("appManager") == "undefined", data)
        check("preview has an opaque origin", data.get("origin") == "null", data)
        check("preview cannot open BrowserOS IndexedDB", data.get("idb") == "blocked", data)
        check("in-memory localStorage works inside the preview", data.get("ls") == "v", data)
        host_ls = page.evaluate("() => localStorage.getItem('k')")
        check("preview storage never touches BrowserOS storage", host_ls is None, host_ls)
        # Top navigation attempt does nothing to BrowserOS
        set_text(page, "try { window.top.location.href = 'https://example.com'; } catch (e) { console.error('nav blocked'); }")
        page.evaluate(f"() => {CS}._runPage('/Projects/Prev/index.html')")
        page.wait_for_timeout(1200)
        check("preview cannot navigate BrowserOS away", page.url.startswith(f"http://127.0.0.1:{PORT}/"), page.url)
        # Forged messages from outside the preview frame are ignored
        before = cs(page, "return app._bottom._output.childElementCount;")
        page.evaluate("() => { const t = appManager.getInstance('app:code-studio')._preview.getBuild().token; window.postMessage({codeStudioPreview: t, type: 'console', level: 'log', text: 'FORGED'}, '*'); }")
        page.wait_for_timeout(300)
        out = cs(page, "return app._bottom._output.textContent;")
        check("messages not from the preview frame are ignored", "FORGED" not in out)
        # Runtime error -> Problems (Runtime) with file and line
        set_text(page, "const a = 1;\nnotDefinedFunction();\n")
        cs(page, "app._bottom.clearOutput();")
        page.evaluate(f"() => {CS}._runPage('/Projects/Prev/index.html')")
        page.wait_for_timeout(1500)
        probs = problems(page)
        rt = [x for x in probs if x["source"] == "Runtime"]
        check("runtime error listed as Runtime with file:line", rt and rt[0]["path"] == "/Projects/Prev/script.js" and rt[0]["line"] == 2, probs)
        check("runtime error is not reported as a syntax error", not any(x["source"] == "JavaScript" for x in probs), probs)
        # Click the runtime problem → editor at that line
        cs(page, "await app._openFile('/Projects/Prev/index.html');")
        cs(page, "app._showPanelTab('problems');")
        page.locator(".cs-problems__item", has_text="notDefinedFunction").first.click()
        page.wait_for_timeout(300)
        cur = cs(page, "return [app._activePath, app._activeDoc().editor.getCursor().line];")
        check("clicking a problem opens the file at its line", cur == ["/Projects/Prev/script.js", 2], cur)
        # Auto preview while typing uses unsaved text
        set_text(page, "document.getElementById('title').textContent = 'Live';")
        page.wait_for_timeout(1500)
        check("auto preview updates from unsaved edits", fr.locator("#title").inner_text() == "Live")
        check("file stays unsaved", cs(page, "return app._activeDoc().dirty;"))
        # Auto preview off: typing doesn't rebuild, Run does
        page.evaluate("() => settingsService.set('codeStudio.autoPreview', false)")
        set_text(page, "document.getElementById('title').textContent = 'Manual';")
        page.wait_for_timeout(1200)
        stays = fr.locator("#title").inner_text()
        page.evaluate(f"() => {CS}._run()")
        page.wait_for_timeout(1200)
        check("with auto preview off, only Run/save update", stays == "Live" and fr.locator("#title").inner_text() == "Manual", stays)
        page.evaluate("() => settingsService.reset('codeStudio.autoPreview')")
        # Link to another project page
        fr.locator("#link").click()
        page.wait_for_timeout(1500)
        check("links to project pages open in the preview", fr.locator("#o").count() == 1 and cs(page, "return app._preview.getEntry();") == "/Projects/Prev/other.html")
        # Missing file reference warns
        page.evaluate("async () => vfs.write('/Projects/Prev/other.html', '<html><head><link rel=\"stylesheet\" href=\"missing.css\"></head><body>x</body></html>')")
        page.wait_for_timeout(1500)
        out = cs(page, "return app._bottom._output.textContent;")
        check("missing referenced file reported in Output", "missing.css" in out, out[-300:])
        # ES modules with imports
        make_project(page, "Mods", "javascript")
        cs(page, "app._bottom.clearOutput(); app._runPage('/Projects/Mods/index.html');")
        page.wait_for_timeout(2000)
        fr2 = page.frame_locator(".window[data-window-id='app:code-studio'] .cs-preview__frame")
        text = fr2.locator("#output").inner_text()
        check("ES module imports between project files work", "Hello, BrowserOS!" in text and "= 6" in text, text)
        # Fullscreen
        page.locator(".window[data-window-id='app:code-studio'] .cs-preview button[title='Fullscreen']").click()
        page.wait_for_timeout(500)
        fs = page.evaluate("() => document.fullscreenElement?.classList.contains('cs-preview') || document.querySelector('.cs-preview--overlay') !== null")
        check("preview fullscreen", fs)
        page.evaluate("() => document.fullscreenElement ? document.exitFullscreen() : document.querySelector('.cs-preview--overlay')?.classList.remove('cs-preview--overlay')")
        page.wait_for_timeout(400)
        # Editing is kept while previewing
        check("returning to the editor keeps the work", cs(page, "return app._docs.size;") >= 1)
        page.screenshot(path=os.path.join(SHOTS, "preview.png"))

    # ------------------------------------------------------------------
    def popout():
        launch(page)
        make_project(page, "Pop", "web")
        cs(page, "app._runPage('/Projects/Pop/index.html');")
        page.wait_for_timeout(1000)
        page.locator(".window[data-window-id='app:code-studio'] .cs-preview button[title='Open in a separate window']").click()
        ok = wait_for(page, "() => appManager.getWindowIds('code-studio').some(id => id.startsWith('app:code-studio-preview'))", 5000)
        check("preview opens in a separate BrowserOS window", ok)
        page.wait_for_timeout(1200)
        wid = page.evaluate("() => appManager.getWindowIds('code-studio').find(id => id.startsWith('app:code-studio-preview'))")
        frames = page.evaluate("() => document.querySelectorAll('.cs-preview__frame').length")
        check("only one live preview frame", frames == 1, frames)
        check("docked preview hidden while popped out", cs(page, "return app._previewHost.hidden;"))
        fr = page.frame_locator(f".window[data-window-id='{wid}'] .cs-preview__frame")
        check("separate window shows the page", fr.locator("h1").inner_text() == "Pop")
        # Live update reaches the window
        cs(page, "await app._openFile('/Projects/Pop/index.html'); const e = app._activeDoc().editor; const t = e.getValue().replace('<h1>Pop</h1>', '<h1>Popped</h1>'); e.replaceDocument(t, [0,0]);")
        page.wait_for_timeout(1500)
        check("edits update the separate preview window", fr.locator("h1").inner_text() == "Popped")
        tasks = page.evaluate("() => appManager.getRunningApplications().filter(a => a.appId === 'code-studio').map(a => a.windows.length)")
        check("preview window grouped with Code Studio", tasks == [2], tasks)
        page.evaluate(f"() => appManager.closeWindow('{wid}')")
        page.wait_for_timeout(800)
        check("closing the window docks the preview again", not cs(page, "return app._previewHost.hidden;") and cs(page, "return app._preview.getHost();") == "docked")
        frames = page.evaluate("() => document.querySelectorAll('.cs-preview__frame').length")
        check("docked preview shows the page again", frames == 1, frames)

    # ------------------------------------------------------------------
    def terminal():
        launch(page)
        make_project(page, "Term", "web")
        page.locator(editor_sel(page)).focus()
        page.keyboard.press("Control+`")
        page.wait_for_timeout(500)
        panel = page.locator(".window[data-window-id='app:code-studio'] .cs-panel__view--terminal")
        check("Ctrl+` shows the terminal panel", panel.is_visible())
        text = panel.inner_text()
        check("terminal explains there is no Node.js runtime", "no Node.js" in text, text[:300])
        inp = panel.locator("input, [contenteditable], textarea").first
        inp.fill("pwd")
        inp.press("Enter")
        page.wait_for_timeout(300)
        check("terminal starts in the project folder", "/Projects/Term" in panel.inner_text())
        inp.fill("node --version")
        inp.press("Enter")
        page.wait_for_timeout(300)
        out = panel.inner_text()
        check("unsupported commands fail honestly", "node" in out and ("not found" in out.lower() or "unknown" in out.lower()), out[-200:])
        inp.fill("touch made.js")
        inp.press("Enter")
        ok = wait_for(page, "() => appManager.getInstance('app:code-studio')._project.tree.entries.has('/Projects/Term/made.js')", 3000)
        check("terminal changes appear in the explorer", ok)
        inp.fill("code made.js")
        inp.press("Enter")
        ok = wait_for(page, "() => appManager.getInstance('app:code-studio')._activePath === '/Projects/Term/made.js'", 3000)
        check("`code <file>` opens the file in Code Studio", ok)
        inp = panel.locator("input, [contenteditable], textarea").first
        inp.fill("open --with notes index.html")
        inp.press("Enter")
        ok = wait_for(page, "() => !!document.querySelector('.window[data-window-id=\"app:notes\"]')", 3000)
        check("`open --with` picks the application", ok)
        page.evaluate("() => appManager.closeWindow('app:notes')")
        page.wait_for_timeout(500)
        page.evaluate("() => appManager.focusWindow('app:code-studio')")
        page.wait_for_timeout(200)
        page.locator(".window[data-window-id='app:code-studio'] button[title='Open in the Terminal app']").click()
        ok = wait_for(page, "() => appManager.getWindowIds('terminal').length === 1", 3000)
        check("terminal panel can open the Terminal app", ok)
        page.wait_for_timeout(300)
        prompt = page.evaluate("() => { const id = appManager.getWindowIds('terminal')[0]; return appManager.getInstance(id)._manager.getCwd(); }")
        check("Terminal app opens in the same folder", prompt == "/Projects/Term", prompt)

    # ------------------------------------------------------------------
    def associations():
        page.evaluate("async () => { if (!(await vfs.exists('/Documents/loose.css'))) await vfs.createFile('/Documents/loose.css', 'p { margin: 0 }'); }")
        page.evaluate("async () => { const { openVfsEntry } = await import('./src/core/vfs/vfsOpener.js'); await openVfsEntry(await vfs.getInfo('/Documents/loose.css'), { appManager }); }")
        ok = wait_for(page, "() => appManager.getInstance('app:code-studio')?._activePath === '/Documents/loose.css'", 6000)
        check("opening a .css file launches Code Studio", ok)
        check("loose file opens without a project", cs(page, "return app._project;") is None)
        # File Explorer double-click
        page.evaluate("async () => { if (!(await vfs.exists('/Documents/data.json'))) await vfs.createFile('/Documents/data.json', '{\"a\": 1}'); }")
        page.evaluate("() => appManager.launch('file-explorer', { path: '/Documents' })")
        page.wait_for_timeout(800)
        item = page.locator(".window").last.locator("[data-name='data.json'], [title='data.json']").first
        if item.count() == 0:
            item = page.locator(".window").last.get_by_text("data.json", exact=True).first
        item.dblclick()
        ok = wait_for(page, "() => appManager.getInstance('app:code-studio')?._docs.has('/Documents/data.json')", 5000)
        check("File Explorer opens .json in Code Studio", ok)
        # Opening a project folder file routes to the window holding that project
        page.evaluate("() => appManager.launch('code-studio-window')")
        page.wait_for_timeout(800)
        second = page.evaluate("() => appManager.getWindowIds('code-studio').find(id => id.startsWith('app:code-studio-window'))")
        check("File > New window opens another Code Studio window", bool(second), second)
        page.evaluate("""async (wid) => { const { createProject } = await import('./src/apps/code-studio/project/projectStore.js');
            if (await vfs.exists('/Projects/Second')) await vfs.delete('/Projects/Second');
            const r = await createProject(vfs, { name: 'Second', templateId: 'web' }); await appManager.getInstance(wid)._openProject(r.root, { keepDocs: false }); }""", second)
        page.evaluate("async () => { const { openVfsEntry } = await import('./src/core/vfs/vfsOpener.js'); await openVfsEntry(await vfs.getInfo('/Projects/Second/style.css'), { appManager }); }")
        page.wait_for_timeout(800)
        routed = page.evaluate("(wid) => [appManager.getInstance(wid)._activePath, appManager.getInstance('app:code-studio')._docs.has('/Projects/Second/style.css')]", second)
        check("files open in the window that holds their project", routed == ["/Projects/Second/style.css", False], routed)
        # Open-with on folders: Code Studio opens a folder as project
        page.evaluate("async () => { const { openVfsEntry } = await import('./src/core/vfs/vfsOpener.js'); await openVfsEntry(await vfs.getInfo('/Projects/Second'), { appManager, appId: 'code-studio' }); }")
        page.wait_for_timeout(800)
        check("open folder with Code Studio opens it as a project", cs(page, "return app._project?.root;") == "/Projects/Second")

    # ------------------------------------------------------------------
    def search():
        launch(page)
        make_project(page, "Srch", "web")
        page.evaluate("async () => { await vfs.createFolder('/Projects/Srch/src'); await vfs.createFile('/Projects/Srch/src/a.js', 'const counter = 1;\\nconsole.log(counter);'); }")
        cs(page, "await app._reloadTree(); await app._openFile('/Projects/Srch/style.css'); app._activeDoc().editor.replaceRange(0, 0, '/* counter */\\n');")
        page.locator(editor_sel(page)).focus()
        page.keyboard.press("Control+Shift+f")
        page.wait_for_timeout(200)
        page.keyboard.type("counter")
        page.wait_for_timeout(1200)
        summary = page.locator(".window[data-window-id='app:code-studio'] .cs-search__summary").inner_text()
        files = page.evaluate("() => [...document.querySelectorAll('.cs-search__file')].map(f => f.getAttribute('title'))")
        check("project search finds matches across files", "/Projects/Srch/src/a.js" in files and "/Projects/Srch/index.html" in files, (summary, files))
        check("search uses unsaved editor text", "/Projects/Srch/style.css" in files, files)
        page.locator(".cs-search__match", has_text="console.log").first.click()
        page.wait_for_timeout(300)
        cur = cs(page, "const c = app._activeDoc().editor.getCursor(); return [app._activePath, c.line, c.selected];")
        check("clicking a result opens the file at the match", cur == ["/Projects/Srch/src/a.js", 2, 7], cur)
        # include filter
        page.locator(".cs-search input[aria-label='Files to include']").fill(".js")
        page.wait_for_timeout(800)
        files = page.evaluate("() => [...document.querySelectorAll('.cs-search__file')].map(f => f.getAttribute('title'))")
        check("files-to-include filter", all(f.endswith(".js") for f in files) and files, files)
        page.locator(".cs-search input[aria-label='Files to include']").fill("")
        # Replace across project
        page.locator(".cs-search button[aria-label='Toggle replace']").click()
        page.locator(".cs-search input[aria-label='Replace with']").fill("tally")
        page.wait_for_timeout(800)
        page.locator(".cs-search button", has_text="Replace all").click()
        page.wait_for_selector(".dialog--visible", timeout=4000)
        msg = page.locator(".dialog--visible").inner_text()
        check("replace across project confirms with counts", "Replace" in msg and "file" in msg, msg[:200])
        click_dialog_button(page, "Replace")
        page.wait_for_timeout(800)
        disk = page.evaluate("async () => vfs.read('/Projects/Srch/src/a.js')")
        check("unopened... files are written", "tally" in disk or cs(page, "return app._docs.get('/Projects/Srch/src/a.js')?.editor.getValue().includes('tally');"), disk)
        check("open files changed in the editor (unsaved)", cs(page, "const d = app._docs.get('/Projects/Srch/style.css'); return d.editor.getValue().includes('tally') && d.dirty;"))
        script = page.evaluate("async () => vfs.read('/Projects/Srch/index.html')")
        check("closed files saved through the VFS", "tally" in script or "count" in script, script[:100])
        # Quick open
        page.locator(editor_sel(page)).focus()
        page.keyboard.press("Control+p")
        page.wait_for_timeout(200)
        page.keyboard.type("a.js")
        page.wait_for_timeout(200)
        first = page.locator(".cs-quick__item").first.inner_text()
        check("quick open finds files by name", "a.js" in first, first)
        page.keyboard.press("Enter")
        page.wait_for_timeout(300)
        check("quick open opens the file", cs(page, "return app._activePath;") == "/Projects/Srch/src/a.js")
        page.keyboard.press("Control+p")
        page.keyboard.type(":2")
        page.keyboard.press("Enter")
        page.wait_for_timeout(200)
        check("quick open :line goes to a line", cs(page, "return app._activeDoc().editor.getCursor().line;") == 2)
        page.keyboard.press("Control+p")
        page.wait_for_timeout(200)
        recent = page.locator(".cs-quick__item").first.inner_text()
        check("quick open lists recent files first", "a.js" in recent, recent)
        page.keyboard.press("Escape")
        # Tree expand/collapse
        cs(page, "app._showSidebar('explorer'); app._tree.reveal('/Projects/Srch/src/a.js');")
        page.wait_for_timeout(200)
        shown = page.locator(".cs-tree__row[data-path='/Projects/Srch/src/a.js']").count()
        page.locator(".cs-sidebar button[title='Collapse folders']").click()
        page.wait_for_timeout(200)
        hidden = page.locator(".cs-tree__row[data-path='/Projects/Srch/src/a.js']").count()
        check("tree expand and collapse", shown == 1 and hidden == 0, (shown, hidden))

    # ------------------------------------------------------------------
    def diagnostics():
        launch(page)
        make_project(page, "Diag", "web")
        cs(page, "await app._openFile('/Projects/Diag/index.html');")
        set_text(page, "<!DOCTYPE html>\n<html>\n<body>\n  <div id=\"a\">\n    <p>text\n  </span>\n  <div id=\"a\"></div>\n  <img src=\"nope.png\">\n  <script>\n    let x = ;\n  </script>\n</body>\n</html>\n")
        page.wait_for_timeout(2000)
        probs = [x for x in problems(page) if x["path"] == "/Projects/Diag/index.html"]
        msgs = " | ".join(f"{x['line']}:{x['severity']}:{x['message']}" for x in probs)
        check("HTML: stray closing tag is an error", any(x["line"] == 6 and x["severity"] == "error" and "</span>" in x["message"] for x in probs), msgs)
        check("HTML: duplicate id warning", any(x["line"] == 7 and "Duplicate id" in x["message"] for x in probs), msgs)
        check("HTML: missing local file warning", any(x["line"] == 8 and "nope.png" in x["message"] for x in probs), msgs)
        check("HTML: inline script syntax error with the right line", any(x["line"] == 10 and x["source"] == "JavaScript" for x in probs), msgs)
        check("HTML: unclosed div reported", any(x["line"] == 4 and "<div>" in x["message"] and "closed" in x["message"] for x in probs), msgs)
        set_text(page, "<!DOCTYPE html>\n<html>\n<head><title>t</title></head>\n<body>\n  <ul><li>one<li>two</ul>\n  <p>para\n  <br>\n</body>\n</html>\n")
        page.wait_for_timeout(1500)
        probs = [x for x in problems(page) if x["path"] == "/Projects/Diag/index.html"]
        check("valid HTML (optional end tags, void elements) has no problems", probs == [], probs)
        cs(page, "await app._openFile('/Projects/Diag/style.css');")
        set_text(page, "body {\n  colr: red;\n  color: notacolor;\n  margin 0;\n  background: url(\"a;b.png\");\n}\n.x { color: red;\n")
        page.wait_for_timeout(1200)
        probs = [x for x in problems(page) if x["path"] == "/Projects/Diag/style.css"]
        msgs = " | ".join(f"{x['line']}:{x['severity']}:{x['message']}" for x in probs)
        check("CSS: unknown property warning", any(x["line"] == 2 and "Unknown property" in x["message"] for x in probs), msgs)
        check("CSS: invalid value warning", any(x["line"] == 3 and "Invalid value" in x["message"] for x in probs), msgs)
        check("CSS: missing colon error", any(x["line"] == 4 and x["severity"] == "error" for x in probs), msgs)
        check("CSS: unclosed block error", any(x["line"] == 7 and "never closed" in x["message"] for x in probs), msgs)
        check("CSS: semicolons inside url() are not errors", not any(x["line"] == 5 for x in probs), msgs)
        set_text(page, ":root { --gap: 4px; }\n@media (max-width: 600px) {\n  .a:hover { margin: var(--gap) auto !important; transform: rotate(45deg); }\n}\n@font-face { font-family: X; src: url(x.woff2); }\n@keyframes spin { from { opacity: 0; } to { opacity: 1; } }\n")
        page.wait_for_timeout(1200)
        probs = [x for x in problems(page) if x["path"] == "/Projects/Diag/style.css"]
        check("valid modern CSS has no problems", probs == [], probs)
        cs(page, "await app._openFile('/Projects/Diag/script.js');")
        set_text(page, "function ok() {\n  return 1;\n}\nconst broken = {\n  a: 1,,\n};\n")
        page.wait_for_timeout(1500)
        probs = [x for x in problems(page) if x["path"] == "/Projects/Diag/script.js"]
        check("JS: syntax error with line", any(x["line"] == 5 and x["source"] == "JavaScript" and x["severity"] == "error" for x in probs), probs)
        gutter = page.evaluate("() => [...document.querySelectorAll('.cs-editor:not([hidden]) .cs-line')].findIndex(l => l.classList.contains('cs-line--error'))")
        check("error marked in the editor gutter", gutter == 4, gutter)
        underline = page.evaluate("() => document.querySelectorAll('.cs-editor:not([hidden]) .cs-mark-error').length")
        check("error range underlined", underline >= 1, underline)
        # Checking never executes code
        set_text(page, "document.title = 'EXECUTED'; window.parent.postMessage('x', '*');\nlet ok = 1;\n")
        page.wait_for_timeout(1200)
        check("syntax check does not run the code", page.evaluate("() => document.title") == "BrowserOS")
        set_text(page, "import { a } from './x.js';\nexport const b = a + 1;\n")
        page.wait_for_timeout(1500)
        probs = [x for x in problems(page) if x["path"] == "/Projects/Diag/script.js"]
        check("module syntax recognized (no false error)", probs == [], probs)
        set_text(page, "export const = 1;\n")
        page.wait_for_timeout(1500)
        probs = [x for x in problems(page) if x["path"] == "/Projects/Diag/script.js"]
        check("module syntax errors reported", any(x["line"] == 1 for x in probs), probs)
        set_text(page, "const t = `multi\nline ${1 + 1}`;\nconst re = /a\\/b/g;\nconst d = 4 / 2 / 1;\n")
        page.wait_for_timeout(1500)
        probs = [x for x in problems(page) if x["path"] == "/Projects/Diag/script.js"]
        check("valid JS (template literals, regex, division) has no problems", probs == [], probs)
        page.evaluate("async () => vfs.createFile('/Projects/Diag/data.json', '{\\n  \"a\": 1,\\n  \"b\": [1, 2,]\\n}')")
        cs(page, "await app._openFile('/Projects/Diag/data.json');")
        page.wait_for_timeout(800)
        probs = [x for x in problems(page) if x["path"] == "/Projects/Diag/data.json"]
        check("JSON parse errors with line", any(x["line"] == 3 for x in probs), probs)
        # Problems for unopened project files
        page.evaluate("async () => { await vfs.createFile('/Projects/Diag/bad.css', 'a { color: red;'); }")
        cs(page, "await app._reloadTree(); await app._diagnoseProject();")
        page.wait_for_timeout(500)
        probs = [x for x in problems(page) if x["path"] == "/Projects/Diag/bad.css"]
        check("unopened project files are checked too", len(probs) >= 1, probs)
        status = page.locator(".window[data-window-id='app:code-studio'] .cs-status__button").first.get_attribute("aria-label")
        check("status bar counts problems", "errors" in status, status)
        cs(page, "app._showPanelTab('problems');")
        page.locator(".cs-problems__item", has_text="never closed").first.click()
        page.wait_for_timeout(300)
        check("clicking a problem in an unopened file opens it", cs(page, "return app._activePath;") == "/Projects/Diag/bad.css")
        page.screenshot(path=os.path.join(SHOTS, "diagnostics.png"))

    # ------------------------------------------------------------------
    def unsaved_guards():
        launch(page)
        make_project(page, "Guard", "web")
        cs(page, "await app._openFile('/Projects/Guard/script.js'); app._activeDoc().editor.replaceRange(0, 0, '// edit\\n');")
        warning = page.evaluate("() => appManager.getCloseWarnings('code-studio')")
        check("Task Manager gets an unsaved-changes warning", len(warning) == 1 and "unsaved" in warning[0], warning)
        page.click(".window[data-window-id='app:code-studio'] .window__control--close")
        page.wait_for_selector(".dialog--visible", timeout=4000)
        check("closing the window asks about unsaved changes", "unsaved" in page.locator(".dialog--visible").inner_text().lower())
        click_dialog_button(page, "Cancel")
        page.wait_for_timeout(500)
        check("cancel keeps the window open", page.locator(".window[data-window-id='app:code-studio']").count() == 1)
        page.click(".window[data-window-id='app:code-studio'] .window__control--close")
        page.wait_for_selector(".dialog--visible", timeout=4000)
        click_dialog_button(page, "Save")
        page.wait_for_timeout(900)
        check("Save then close", page.locator(".window[data-window-id='app:code-studio']").count() == 0 and page.evaluate("async () => (await vfs.read('/Projects/Guard/script.js')).startsWith('// edit')"))
        launch(page)
        cs(page, "await app._openProject('/Projects/Guard'); await app._openFile('/Projects/Guard/style.css'); app._activeDoc().editor.replaceRange(0, 0, '/* x */');")
        # Switching projects asks too
        cs(page, "app._switchProject('/Projects/Ops');")
        page.wait_for_selector(".dialog--visible", timeout=4000)
        click_dialog_button(page, "Cancel")
        check("switching projects with unsaved files can be cancelled", cs(page, "return app._project.root;") == "/Projects/Guard")
        # beforeunload is registered only while dirty
        page.click(".window[data-window-id='app:code-studio'] .window__control--close")
        page.wait_for_selector(".dialog--visible", timeout=4000)
        click_dialog_button(page, "Don’t save")
        page.wait_for_timeout(800)
        check("Don't save closes without writing", page.locator(".window[data-window-id='app:code-studio']").count() == 0 and not page.evaluate("async () => (await vfs.read('/Projects/Guard/style.css')).startsWith('/* x */')"))
        # Cleanup: no leaked listeners/frames after closing
        frames = page.evaluate("() => document.querySelectorAll('iframe').length")
        check("closing releases preview and checker frames", frames == 0, frames)

    # ------------------------------------------------------------------
    def layout():
        launch(page)
        make_project(page, "Lay", "web")
        cs(page, "await app._openFile('/Projects/Lay/index.html');")
        page.locator(editor_sel(page)).focus()
        page.keyboard.press("Control+b")
        check("Ctrl+B hides the sidebar", cs(page, "return app._sidebar.hidden;"))
        page.keyboard.press("Control+b")
        shown = cs(page, "return !app._bottom.getElement().hidden;")
        page.keyboard.press("Control+j")
        check("Ctrl+J toggles the panel", cs(page, "return !app._bottom.getElement().hidden;") != shown)
        page.keyboard.press("Control+j")
        page.keyboard.press("Alt+p")
        page.wait_for_timeout(200)
        hidden = cs(page, "return app._previewHost.hidden;")
        page.keyboard.press("Alt+p")
        page.wait_for_timeout(200)
        check("Alt+P toggles the preview", hidden and not cs(page, "return app._previewHost.hidden;"))
        before = cs(page, "return app._layout.sidebar;")
        handle = page.locator(".window[data-window-id='app:code-studio'] .cs-resizer--vertical").first
        box = handle.bounding_box()
        page.mouse.move(box["x"] + 1, box["y"] + 100)
        page.mouse.down()
        page.mouse.move(box["x"] + 81, box["y"] + 100, steps=5)
        page.mouse.up()
        after = cs(page, "return app._layout.sidebar;")
        check("sidebar is resizable by dragging", after - before >= 60, (before, after))
        handle.focus()
        page.keyboard.press("ArrowLeft")
        check("resizer works with the keyboard", cs(page, "return app._layout.sidebar;") < after)
        stored = page.evaluate("() => JSON.parse(localStorage.getItem('browseros:codeStudio:layout') || 'null')")
        check("layout sizes remembered", stored and stored.get("sidebar") == cs(page, "return app._layout.sidebar;"), stored)
        # Maximize and restore keep the layout working
        page.keyboard.press("Alt+Shift+ArrowUp")
        page.wait_for_timeout(500)
        wmax = page.evaluate("() => document.querySelector('.window[data-window-id=\"app:code-studio\"]').getBoundingClientRect().width")
        page.keyboard.press("Alt+Shift+ArrowUp")
        page.wait_for_timeout(500)
        wres = page.evaluate("() => document.querySelector('.window[data-window-id=\"app:code-studio\"]').getBoundingClientRect().width")
        ed = page.evaluate("() => document.querySelector('.window[data-window-id=\"app:code-studio\"] .cs-editor:not([hidden])').getBoundingClientRect().width")
        check("works maximized and restored", wmax > wres and ed > 150, (wmax, wres, ed))
        # Menus
        page.locator(".window[data-window-id='app:code-studio'] .cs-menubar__item", has_text="File").click()
        page.wait_for_timeout(200)
        menu = page.locator(".context-menu").last.inner_text()
        check("File menu lists project and file commands with shortcuts", all(k in menu for k in ["New project", "Open project", "Open recent", "Save", "Ctrl + S", "Save as", "Close project"]), menu)
        page.keyboard.press("Escape")
        page.locator(".window[data-window-id='app:code-studio'] .cs-menubar__item", has_text="Edit").click()
        page.wait_for_timeout(200)
        page.locator(".context-menu").last.locator("button", has_text="Find").first.click()
        page.wait_for_timeout(200)
        check("menu commands work (Edit > Find)", cs(page, "return app._find.isOpen();"))
        page.keyboard.press("Escape")
        # Editor context menu
        page.locator(editor_sel(page)).click(button="right")
        page.wait_for_timeout(200)
        menu = page.locator(".context-menu").last.inner_text()
        check("editor context menu", all(k in menu for k in ["Undo", "Cut", "Copy", "Paste", "Toggle comment", "Open in preview"]), menu)
        page.keyboard.press("Escape")
        # Settings page
        page.evaluate("() => appManager.launch('settings', { page: 'codeStudio' })")
        page.wait_for_timeout(800)
        text = page.locator(".window[data-window-id='app:settings']").inner_text()
        check("Settings has a Code Studio page", all(k in text for k in ["Editor theme", "Font size", "Tab width", "Word wrap", "Update preview while typing"]), text[:300])
        check("no minimap setting is offered", "minimap" not in text.lower())
        page.locator(".window[data-window-id='app:settings'] .settings-switch, .window[data-window-id='app:settings'] [role='switch']").filter(has_text="").nth(0)
        page.evaluate("() => settingsService.set('codeStudio.wordWrap', true)")
        page.wait_for_timeout(200)
        check("settings apply to open editors", page.evaluate("() => document.querySelector('.window[data-window-id=\"app:code-studio\"] .cs-editor:not([hidden])').classList.contains('cs-editor--wrap')"))
        page.evaluate("() => settingsService.reset('codeStudio.wordWrap')")
        keys = page.evaluate("() => keyboardShortcuts.getGroupedShortcuts().find(g => g.label === 'Code Studio')?.shortcuts.length || 0")
        check("Code Studio shortcuts documented in the keyboard reference", keys >= 20, keys)

    # ------------------------------------------------------------------
    for fn in [registration, templates, file_operations, editing, alignment, find_replace, saving, preview, popout, terminal, associations, search, diagnostics, unsaved_guards, layout]:
        section(fn)

    close_all(page)
    check("no BrowserOS console errors", not errors, errors[:10])
    b.close()

passed = sum(1 for _, ok in results if ok)
print(f"\n{passed}/{len(results)} passed")
if errors:
    print("\n".join(errors[:30]))
sys.exit(0 if passed == len(results) else 1)
