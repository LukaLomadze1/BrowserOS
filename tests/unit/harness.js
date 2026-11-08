/**
 * @file A minimal test harness for BrowserOS's browser-side unit tests:
 * `test(name, fn)` registers a test, `assert` checks values, and
 * `run()` executes everything in order, renders a report, and exposes
 * the results as `window.__unitResults` for the automated runner
 * (tests/run_unit.py).
 */

const tests = [];
let currentGroup = "";

/**
 * @param {string} name
 * @param {() => void} body - Registers the group's tests.
 * @returns {void}
 */
export function group(name, body) {
  const previous = currentGroup;
  currentGroup = name;
  body();
  currentGroup = previous;
}

/**
 * @param {string} name
 * @param {() => (void|Promise<void>)} fn
 * @returns {void}
 */
export function test(name, fn) {
  tests.push({ name: currentGroup ? `${currentGroup} › ${name}` : name, fn });
}

class AssertionError extends Error {}

/**
 * @param {*} value
 * @returns {string}
 */
function show(value) {
  try {
    return typeof value === "string" ? JSON.stringify(value) : JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export const assert = {
  /**
   * @param {*} value
   * @param {string} [message]
   */
  ok(value, message = "expected a truthy value") {
    if (!value) throw new AssertionError(`${message} (got ${show(value)})`);
  },
  /**
   * @param {*} actual
   * @param {*} expected
   * @param {string} [message]
   */
  equal(actual, expected, message = "values differ") {
    if (!Object.is(actual, expected)) throw new AssertionError(`${message}: expected ${show(expected)}, got ${show(actual)}`);
  },
  /**
   * @param {*} actual
   * @param {*} expected
   * @param {string} [message]
   */
  deepEqual(actual, expected, message = "values differ") {
    if (show(actual) !== show(expected)) throw new AssertionError(`${message}: expected ${show(expected)}, got ${show(actual)}`);
  },
  /**
   * Expect `fn` to throw (or reject); optionally check `error.code`.
   * @param {() => *} fn
   * @param {string} [code]
   * @returns {Promise<Error>}
   */
  async rejects(fn, code) {
    try {
      await fn();
    } catch (error) {
      if (code && error?.code !== code) throw new AssertionError(`expected error code ${code}, got ${error?.code} (${error?.message})`);
      return error;
    }
    throw new AssertionError(`expected an error${code ? ` with code ${code}` : ""}, but nothing was thrown`);
  },
};

/**
 * Run every registered test and report.
 * @param {HTMLElement} output
 * @returns {Promise<{passed: number, failed: number, results: Array<{name: string, ok: boolean, error?: string, ms: number}>}>}
 */
export async function run(output) {
  const results = [];
  for (const { name, fn } of tests) {
    const started = performance.now();
    try {
      await fn();
      results.push({ name, ok: true, ms: Math.round(performance.now() - started) });
    } catch (error) {
      results.push({ name, ok: false, error: error?.stack || String(error), ms: Math.round(performance.now() - started) });
    }
  }
  const passed = results.filter((result) => result.ok).length;
  const summary = { passed, failed: results.length - passed, results };
  render(output, summary);
  window.__unitResults = summary;
  return summary;
}

/**
 * @param {HTMLElement} output
 * @param {{passed: number, failed: number, results: object[]}} summary
 * @returns {void}
 */
function render(output, summary) {
  const heading = document.createElement("h1");
  heading.textContent = `${summary.passed} passed, ${summary.failed} failed`;
  heading.className = summary.failed ? "fail" : "pass";
  const list = document.createElement("ol");
  for (const result of summary.results) {
    const item = document.createElement("li");
    item.className = result.ok ? "pass" : "fail";
    item.textContent = `${result.ok ? "PASS" : "FAIL"} ${result.name} (${result.ms} ms)`;
    if (!result.ok) {
      const detail = document.createElement("pre");
      detail.textContent = result.error;
      item.append(detail);
    }
    list.append(item);
  }
  output.replaceChildren(heading, list);
}
