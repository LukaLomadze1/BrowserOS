"""Serve BrowserOS locally, the way a static host would.

Usage:
    python tools/serve.py            # the repository (development), port 8000
    python tools/serve.py dist       # the production copy made by tools/build.py
    python tools/serve.py dist 9000  # another port

Compared with `python -m http.server`, it always sends the right content
types for modules, fonts, and SVG (some systems map .js to text/plain,
which browsers refuse for ES modules), answers missing paths with
404.html like GitHub Pages, Netlify, and Cloudflare Pages do, and applies
the headers from the served folder's _headers file. It listens on
127.0.0.1 only.
"""
import functools
import http.server
import os
import socketserver
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TYPES = {
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".css": "text/css",
    ".html": "text/html",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".woff2": "font/woff2",
    ".txt": "text/plain",
    ".md": "text/markdown",
}


def read_headers(folder):
    """Parse the /* block of a Netlify/Cloudflare Pages _headers file."""
    path = os.path.join(folder, "_headers")
    headers, current = {}, None
    if not os.path.exists(path):
        return headers
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            if not line.strip() or line.lstrip().startswith("#"):
                continue
            if not line.startswith((" ", "\t")):
                current = line.strip()
                headers.setdefault(current, [])
            elif current and ":" in line:
                name, value = line.strip().split(":", 1)
                headers[current].append((name.strip(), value.strip()))
    return headers


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, **TYPES}

    def __init__(self, *args, rules=None, **kwargs):
        self._rules = rules or {}
        super().__init__(*args, **kwargs)

    def end_headers(self):
        path = self.path.split("?")[0]
        for pattern, values in self._rules.items():
            if pattern == "/*" or (pattern.endswith("/*") and path.startswith(pattern[:-1])) or pattern == path:
                for name, value in values:
                    self.send_header(name, value)
        super().end_headers()

    def send_error(self, code, message=None, explain=None):
        page = os.path.join(self.directory, "404.html")
        if code == 404 and os.path.exists(page):
            with open(page, "rb") as handle:
                body = handle.read()
            self.send_response(404)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)
            return
        super().send_error(code, message, explain)

    def log_message(self, format, *args):
        sys.stderr.write("%s %s\n" % (self.log_date_time_string(), format % args))


def main():
    folder = os.path.join(ROOT, sys.argv[1]) if len(sys.argv) > 1 else ROOT
    port = int(sys.argv[2]) if len(sys.argv) > 2 else 8000
    if not os.path.exists(os.path.join(folder, "index.html")):
        raise SystemExit(f"No index.html in {folder}. Run python tools/build.py first?")
    handler = functools.partial(Handler, directory=folder, rules=read_headers(folder))
    socketserver.ThreadingTCPServer.allow_reuse_address = True
    # Browsers request dozens of modules at once; the default backlog of 5 refuses some.
    socketserver.ThreadingTCPServer.request_queue_size = 128
    with socketserver.ThreadingTCPServer(("127.0.0.1", port), handler) as server:
        print(f"Serving {os.path.relpath(folder, ROOT) if folder != ROOT else 'the repository'} at http://127.0.0.1:{port}/ (Ctrl+C to stop)")
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
