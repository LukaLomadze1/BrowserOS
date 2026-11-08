"""Run the browser unit tests (tests/unit/) headlessly and print the results.

Usage:  python tests/run_unit.py
Requires Python 3.9+ and Playwright (pip install playwright; playwright install chromium).
A static server for the repository root is started on a free local port.
Exit status is 0 when every test passes.
"""
import functools
import http.server
import os
import socketserver
import sys
import threading

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def main():
    socketserver.ThreadingTCPServer.allow_reuse_address = True
    server = socketserver.ThreadingTCPServer(("127.0.0.1", 0), functools.partial(QuietHandler, directory=ROOT))
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{server.server_address[1]}/tests/unit/index.html"
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        page = browser.new_page()
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.goto(url)
        page.wait_for_function("window.__unitResults !== undefined", timeout=60000)
        summary = page.evaluate("window.__unitResults")
        browser.close()
    server.shutdown()
    for result in summary["results"]:
        print(("PASS " if result["ok"] else "FAIL ") + result["name"])
        if not result["ok"]:
            print("     " + result["error"].splitlines()[0])
    for error in errors:
        print("PAGE ERROR " + error)
    print(f"{summary['passed']}/{summary['passed'] + summary['failed']} passed")
    return 0 if summary["failed"] == 0 and not errors else 1


if __name__ == "__main__":
    sys.exit(main())
