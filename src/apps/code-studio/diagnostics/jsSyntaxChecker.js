/**
 * @file JavaScript syntax checking without running the code.
 *
 * The browser's own parser does the work, inside a throwaway sandboxed
 * frame (`sandbox="allow-scripts"`, opaque origin: no access to
 * BrowserOS, its storage, or the VFS). The source is never evaluated:
 *
 *   - Classic scripts get `throw` as their first statement. A script is
 *     parsed completely before its first statement runs, so a syntax
 *     error is reported with its line, and valid code stops at that
 *     first `throw` before any of its own statements execute.
 *   - Modules get a first import of a module that throws. Imports are
 *     linked before any module code runs and evaluated in order, so
 *     the throwing import aborts evaluation of the whole graph before
 *     the module body (or any other import) runs.
 *
 * The prefix sits on its own line, so reported line numbers are offset
 * by exactly one. Every check uses a fresh frame, so declarations from
 * one file can never collide with another's.
 */

const CHECK_TIMEOUT_MS = 3000;
const SENTINEL = "__codeStudioParsed__";

/** Script that runs inside the checker frame. */
const HARNESS = `
(function () {
  var token = null;
  var done = false;
  function report(result) {
    if (done) return;
    done = true;
    parent.postMessage({ codeStudioCheck: token, result: result }, "*");
  }
  window.addEventListener("error", function (event) {
    var message = String(event.message || "");
    var error = event.error;
    var isSyntax = (error && error.name === "SyntaxError") || /SyntaxError/.test(message);
    var fromSource = !event.filename || event.filename === location.href || event.filename === "about:srcdoc";
    if (isSyntax && fromSource) {
      var clean = message.replace(/^Uncaught\\s+/, "").replace(/^SyntaxError:\\s*/, "").replace(/^Failed to execute '[^']*' on '[^']*':\\s*/, "");
      report({ ok: false, message: clean, line: event.lineno || 0, column: event.colno || 0 });
    } else {
      report({ ok: true });
    }
    event.preventDefault();
  });
  window.addEventListener("message", function (event) {
    if (event.source !== parent || token !== null) return;
    var data = event.data;
    if (!data || typeof data.token !== "string" || typeof data.code !== "string") return;
    token = data.token;
    var script = document.createElement("script");
    if (data.module) {
      script.type = "module";
      script.textContent = 'import "data:text/javascript,throw%20%22${SENTINEL}%22";\\n' + data.code;
    } else {
      script.textContent = 'throw "${SENTINEL}";\\n' + data.code;
    }
    document.head.appendChild(script);
    if (!data.module) setTimeout(function () { report({ ok: true }); }, 0);
  });
})();
`;

/**
 * @typedef {object} SyntaxProblem
 * @property {number} line - 1-based.
 * @property {number} column - 1-based (0 when unknown).
 * @property {string} message
 */

/**
 * Check JavaScript source for syntax errors.
 * @param {string} code
 * @param {{module?: boolean}} [options]
 * @returns {Promise<SyntaxProblem|null>} The first syntax error, or null when the code parses.
 */
export function checkJavaScriptSyntax(code, { module = false } = {}) {
  return new Promise((resolve) => {
    const token = createToken();
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("aria-hidden", "true");
    frame.setAttribute("tabindex", "-1");
    frame.className = "cs-syntax-frame";
    frame.style.cssText = "position:fixed;width:0;height:0;border:0;visibility:hidden;pointer-events:none;left:-10px;top:-10px;";
    let finished = false;
    const finish = (result) => {
      if (finished) return;
      finished = true;
      window.removeEventListener("message", onMessage);
      window.clearTimeout(timer);
      frame.remove();
      resolve(result);
    };
    const onMessage = (event) => {
      if (event.source !== frame.contentWindow) return;
      const data = event.data;
      if (!data || data.codeStudioCheck !== token || !data.result) return;
      const result = data.result;
      if (result.ok) {
        finish(null);
        return;
      }
      finish({
        line: Math.max(1, Number(result.line) - 1 || 1),
        column: Math.max(0, Number(result.column) || 0),
        message: String(result.message || "Syntax error").slice(0, 300),
      });
    };
    // No answer (for example, the frame couldn't run) means nothing is reported.
    const timer = window.setTimeout(() => finish(null), CHECK_TIMEOUT_MS);
    window.addEventListener("message", onMessage);
    frame.addEventListener("load", () => {
      frame.contentWindow?.postMessage({ token, code, module }, "*");
    }, { once: true });
    // The about:srcdoc base keeps relative imports in the checked code from being fetched.
    frame.srcdoc = `<!doctype html><meta charset="utf-8"><base href="about:srcdoc"><script>${HARNESS}</script>`;
    document.body.append(frame);
  });
}

/**
 * @param {string} code
 * @returns {boolean} Whether the source uses module syntax (static import/export at the start of a line).
 */
export function looksLikeModule(code) {
  return /^[ \t]*(?:import\s*(?:[\w${*]|["'])|export\s+(?:default\b|const\b|let\b|var\b|function\b|class\b|async\b|\{|\*))/m.test(code);
}

/** @returns {string} */
function createToken() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
