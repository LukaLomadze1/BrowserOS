"""Build the deployable copy of BrowserOS in dist/.

BrowserOS needs no compilation: the site is the files in the repository.
This script makes the production copy that is published to a static host:

  1. copies only what the site uses (index.html, 404.html, assets/, src/,
     styles/, and the host configuration files _headers and .nojekyll);
  2. writes src/core/buildInfo.js with the commit the copy was built from,
     so About BrowserOS can show it;
  3. adjusts 404.html for the path the site is served from (--base-path);
  4. checks that every module import, stylesheet, script, font, and image
     the site refers to exists in the copy, and stops with an error if not.

Usage:
    python tools/build.py                          # site served at the domain root
    python tools/build.py --base-path /BrowserOS/  # e.g. a GitHub Pages project site
    python tools/build.py --out public             # another output folder

Needs only Python 3.9+ (and Git for the commit information).
"""
import argparse
import datetime
import json
import os
import re
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE_FILES = ["index.html", "404.html", "_headers", ".nojekyll"]
SITE_FOLDERS = ["assets", "src", "styles"]
TEXT_EXTENSIONS = {".js", ".css", ".html"}

IMPORT_PATTERNS = [
    re.compile(r"""^\s*import\s+(?:[\w*{}\s,]+\s+from\s+)?["']([^"']+)["']""", re.M),
    re.compile(r"""^\s*export\s+[\w*{}\s,]+\s+from\s+["']([^"']+)["']""", re.M),
    re.compile(r"""\bimport\(\s*["']([^"']+)["']\s*\)"""),
]
TEMPLATE_LITERAL = re.compile(r"`(?:\\.|[^`\\])*`", re.S)
STYLESHEET_PATTERN = re.compile(r"""ensureStylesheet\(\s*["']([^"']+)["']\s*\)""")
CSS_URL_PATTERN = re.compile(r"""url\(\s*["']?([^"')]+)["']?\s*\)""")
HTML_REF_PATTERN = re.compile(r"""<(?:link|script|img)\b[^>]*?\b(?:href|src)=["']([^"']+)["']""", re.I)


def run_git(*args):
    try:
        return subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True, check=True).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return None


def build_info():
    commit = run_git("rev-parse", "HEAD")
    if not commit:
        return None
    return {
        "commit": commit,
        "commitDate": run_git("log", "-1", "--format=%cI") or "",
        "builtAt": datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat(),
        # Only changes to the files the site is built from count.
        "dirty": bool(run_git("status", "--porcelain", "--", *SITE_FILES, *SITE_FOLDERS)),
    }


def copy_site(out):
    if os.path.exists(out):
        shutil.rmtree(out)
    os.makedirs(out)
    for name in SITE_FILES:
        source = os.path.join(ROOT, name)
        if not os.path.exists(source):
            raise SystemExit(f"Missing site file: {name}")
        shutil.copy2(source, os.path.join(out, name))
    for folder in SITE_FOLDERS:
        shutil.copytree(os.path.join(ROOT, folder), os.path.join(out, folder), ignore=shutil.ignore_patterns("__pycache__", "*.py", ".DS_Store"))


def write_build_info(out, info):
    target = os.path.join(out, "src", "core", "buildInfo.js")
    body = "null" if info is None else json.dumps(info, indent=2)
    with open(target, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(
            "/**\n"
            " * @file Build information, written by tools/build.py for this copy of\n"
            " * BrowserOS (see the repository's src/core/buildInfo.js).\n"
            " * @type {{commit: string, commitDate: string, builtAt: string, dirty: boolean}|null}\n"
            " */\n"
            f"export const BUILD_INFO = {body};\n"
        )


def apply_base_path(out, base):
    """404.html is served for any missing path, so its own links must be absolute."""
    path = os.path.join(out, "404.html")
    with open(path, encoding="utf-8") as handle:
        text = handle.read()
    text = text.replace('data-base="/"', f'data-base="{base}"')
    text = re.sub(r'(href|src)="/(?!/)', lambda m: f'{m.group(1)}="{base}', text)
    with open(path, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(text)


def check_references(out):
    """Every local reference in the copied site must point at a file in it."""
    problems = []
    for folder, _, files in os.walk(out):
        for name in files:
            extension = os.path.splitext(name)[1]
            if extension not in TEXT_EXTENSIONS:
                continue
            path = os.path.join(folder, name)
            with open(path, encoding="utf-8") as handle:
                text = handle.read()
            references = []
            if extension == ".js":
                # Template literals are text (the sample projects contain whole files), not code.
                text = TEMPLATE_LITERAL.sub("``", text)
                for pattern in IMPORT_PATTERNS:
                    references += [(ref, os.path.dirname(path)) for ref in pattern.findall(text)]
                # ensureStylesheet() paths are relative to index.html.
                references += [(ref, out) for ref in STYLESHEET_PATTERN.findall(text)]
            elif extension == ".css":
                references += [(ref, os.path.dirname(path)) for ref in CSS_URL_PATTERN.findall(text)]
            elif name == "index.html":
                references += [(ref, out) for ref in HTML_REF_PATTERN.findall(text)]
            for reference, base in references:
                if re.match(r"^(?:[a-z]+:|//|#|/)", reference, re.I):
                    continue  # external, data:, fragment, or absolute (404.html)
                target = os.path.normpath(os.path.join(base, reference.split("?")[0].split("#")[0]))
                if not os.path.isfile(target):
                    problems.append(f"{os.path.relpath(path, out)}: {reference}")
    return problems


def folder_size(out):
    total, count = 0, 0
    for folder, _, files in os.walk(out):
        for name in files:
            total += os.path.getsize(os.path.join(folder, name))
            count += 1
    return total, count


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", default="dist", help="output folder, relative to the repository (default: dist)")
    parser.add_argument("--base-path", default="/", help="URL path the site is served from, e.g. /BrowserOS/ (default: /)")
    args = parser.parse_args()

    base = "/" + args.base_path.strip("/") + "/" if args.base_path.strip("/") else "/"
    out = os.path.join(ROOT, args.out)
    if os.path.abspath(out) == ROOT or not os.path.abspath(out).startswith(ROOT):
        raise SystemExit("The output folder must be inside the repository and not the repository itself.")

    copy_site(out)
    info = build_info()
    write_build_info(out, info)
    apply_base_path(out, base)

    problems = check_references(out)
    if problems:
        print("Missing files referenced by the site:")
        for problem in problems:
            print("  " + problem)
        return 1

    size, count = folder_size(out)
    commit = f"commit {info['commit'][:7]}{' (uncommitted changes)' if info['dirty'] else ''}" if info else "no Git information"
    print(f"Built {os.path.relpath(out, ROOT)}/: {count} files, {size / 1024 / 1024:.2f} MB, {commit}, base path {base}")
    print("All module imports, stylesheets, scripts, fonts, and images resolve.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
