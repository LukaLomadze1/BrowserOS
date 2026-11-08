"""Run every BrowserOS test: the browser unit tests, then each end-to-end suite.

Usage:
    python tests/run_all.py                      # everything, against the repository
    python tests/run_all.py release vfs          # only suites whose file name contains one of the words
    python tests/run_all.py --site dist          # the end-to-end suites against the production copy
                                                 # (run python tools/build.py first)

Each suite starts its own static server on a free port and a fresh browser
profile, so suites are independent and never touch real BrowserOS data.
Screenshots go to tests/e2e/output/. Exit status is 0 only if everything passed.
"""
import os
import re
import subprocess
import sys
import time

TESTS = os.path.dirname(os.path.abspath(__file__))
SUITES = [os.path.join(TESTS, "run_unit.py")] + sorted(
    os.path.join(TESTS, "e2e", name) for name in os.listdir(os.path.join(TESTS, "e2e")) if name.startswith("test_") and name.endswith(".py")
)


def main(arguments):
    environment = dict(os.environ, PYTHONIOENCODING="utf-8")
    filters = list(arguments)
    if "--site" in filters:
        index = filters.index("--site")
        site = filters[index + 1] if index + 1 < len(filters) else ""
        del filters[index:index + 2]
        root = os.path.abspath(os.path.join(os.path.dirname(TESTS), site))
        if not site or not os.path.isfile(os.path.join(root, "index.html")):
            print(f"No site at {root}: build it first with python tools/build.py")
            return 2
        environment["BROWSEROS_SITE_ROOT"] = root
        print(f"Testing the site in {os.path.relpath(root, os.path.dirname(TESTS))}")
    selected = [suite for suite in SUITES if not filters or any(word in os.path.basename(suite) for word in filters)]
    summary = []
    for suite in selected:
        name = os.path.relpath(suite, os.path.dirname(TESTS))
        print(f"\n=== {name}", flush=True)
        started = time.time()
        process = subprocess.run([sys.executable, suite], env=environment, capture_output=True, text=True, encoding="utf-8")
        output = process.stdout + process.stderr
        failures = [line for line in output.splitlines() if line.startswith("FAIL ")]
        match = re.findall(r"^(\d+)/(\d+) passed$", output, flags=re.M)
        passed, total = (int(match[-1][0]), int(match[-1][1])) if match else (0, 0)
        for line in failures:
            print("  " + line)
        if not match:
            print(output[-2000:])
        seconds = round(time.time() - started)
        print(f"  {passed}/{total} passed in {seconds} s (exit {process.returncode})", flush=True)
        summary.append((name, passed, total, process.returncode, seconds))
    print("\n=== Summary")
    for name, passed, total, code, seconds in summary:
        print(f"{'ok  ' if code == 0 else 'FAIL'}  {passed:>4}/{total:<4} {name}  ({seconds} s)")
    all_passed = sum(row[1] for row in summary)
    all_total = sum(row[2] for row in summary)
    failed_suites = [row[0] for row in summary if row[3] != 0]
    print(f"\n{all_passed}/{all_total} checks passed in {len(summary)} suites")
    if failed_suites:
        # A suite that crashes before reporting contributes no checks, so name it explicitly.
        print(f"{len(failed_suites)} suite(s) failed: {', '.join(failed_suites)}")
    return 0 if not failed_suites else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
