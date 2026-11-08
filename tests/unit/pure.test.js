/**
 * @file Unit tests for modules without side effects: path math, name
 * rules, address parsing, the calculator parser, JSON checking, the
 * Notes sanitizer, download names, and name generation.
 */

import { group, test, assert } from "./harness.js";
import { resolvePath, getParentPath, getBaseName, getExtension } from "../../src/core/vfs/pathResolver.js";
import { validateName, MAX_NAME_LENGTH } from "../../src/core/vfs/validationService.js";
import { parseAddressInput, normalizeVfsPath, isWebUrl } from "../../src/core/browser/urlUtils.js";
import { evaluate, formatResult } from "../../src/apps/calculator/expression.js";
import { checkJson } from "../../src/apps/code-studio/diagnostics/jsonChecker.js";
import { sanitizeHtml, parseNoteDocument, serializeNoteDocument } from "../../src/apps/notes/noteFormat.js";
import { sanitizeFilename, filenameFromDisposition } from "../../src/core/downloads/downloadService.js";
import { generateDefaultName } from "../../src/utils/nameGenerator.js";
import { formatBytes } from "../../src/utils/format.js";

group("pathResolver", () => {
  test("normalizes . and .. and duplicate slashes", () => {
    assert.equal(resolvePath("/Documents//./a/../b"), "/Documents/b");
    assert.equal(resolvePath("../../..", "/a/b"), "/");
  });
  test("resolves relative paths against the current folder", () => {
    assert.equal(resolvePath("notes.txt", "/Documents"), "/Documents/notes.txt");
  });
  test("cannot climb above the root", () => {
    assert.equal(resolvePath("/../../etc/passwd"), "/etc/passwd");
  });
  test("rejects empty and non-string paths", async () => {
    await assert.rejects(() => resolvePath(""), "INVALID_PATH");
    await assert.rejects(() => resolvePath(null), "INVALID_PATH");
  });
  test("decomposes paths", () => {
    assert.equal(getParentPath("/a/b/c.txt"), "/a/b");
    assert.equal(getParentPath("/"), null);
    assert.equal(getBaseName("/a/b/c.txt"), "c.txt");
    assert.equal(getExtension("archive.TAR.GZ"), "gz");
    assert.equal(getExtension(".bashrc"), null);
  });
});

group("validateName", () => {
  test("accepts ordinary names", () => {
    validateName("Report (final) – v2.txt");
  });
  for (const [label, name] of [
    ["empty", ""],
    ["whitespace", "   "],
    ["dot", "."],
    ["dot dot", ".."],
    ["slash", "a/b"],
    ["backslash", "a\\b"],
    ["colon", "a:b"],
    ["newline", "a\nb"],
    ["tab", "a\tb"],
    ["NUL", "a\u0000b"],
    ["too long", "x".repeat(MAX_NAME_LENGTH + 1)],
  ]) {
    test(`rejects ${label}`, async () => {
      await assert.rejects(() => validateName(name), "INVALID_NAME");
    });
  }
  test(`accepts exactly ${MAX_NAME_LENGTH} characters`, () => {
    validateName("x".repeat(MAX_NAME_LENGTH));
  });
});

group("parseAddressInput", () => {
  const parse = (text) => parseAddressInput(text, { searchEngine: "duckduckgo" });
  test("web addresses", () => {
    assert.deepEqual(parse("example.com"), { type: "url", url: "https://example.com/" });
    assert.equal(parse("localhost:3000").url, "http://localhost:3000/");
    assert.equal(parse("https://example.com/a?b=1").type, "url");
  });
  test("refuses unsafe schemes", () => {
    for (const text of ["javascript:alert(1)", "data:text/html,<script>x</script>", "file:///etc/passwd", "blob:https://x/1"]) {
      assert.equal(parse(text).type, "error", text);
    }
  });
  test("internal and file pages", () => {
    assert.deepEqual(parse("browseros://history"), { type: "internal", url: "browseros://history" });
    assert.equal(parse("browseros://nope").type, "error");
    assert.equal(parse("vfs:///Documents/a.html").url, "vfs:///Documents/a.html");
  });
  test("vfs paths can't climb out", () => {
    assert.equal(normalizeVfsPath("///Documents/../../x"), null);
    assert.equal(normalizeVfsPath("/a/b/"), "/a/b");
  });
  test("anything else is a search", () => {
    assert.equal(parse("cats and dogs").type, "search");
  });
  test("isWebUrl", () => {
    assert.ok(isWebUrl("https://example.com"));
    assert.ok(!isWebUrl("https://exa mple.com"));
    assert.ok(!isWebUrl("ftp://example.com"));
  });
});

group("calculator", () => {
  test("precedence and parentheses", () => {
    assert.equal(evaluate("2 + 3 * 4"), 14);
    assert.equal(evaluate("(2 + 3) * 4"), 20);
  });
  test("hides floating-point noise", () => {
    assert.equal(formatResult(evaluate("0.1 + 0.2")), "0.3");
  });
  test("rejects malformed input without evaluating code", async () => {
    await assert.rejects(() => evaluate("2 +"));
    await assert.rejects(() => evaluate("alert(1)"));
    await assert.rejects(() => evaluate("constructor.constructor('x')()"));
  });
});

group("checkJson", () => {
  test("valid JSON has no problem", () => {
    assert.equal(checkJson('{"a": [1, 2, {"b": null}]}'), null);
  });
  test("trailing comma is located", () => {
    const problem = checkJson('{\n  "a": [1, 2,]\n}');
    assert.equal(problem.line, 2);
    assert.ok(/Trailing comma/.test(problem.message), problem.message);
  });
  test("unterminated input", () => {
    assert.ok(/end of file/.test(checkJson('{"a": ').message));
  });
});

group("Notes sanitizer", () => {
  test("removes scripts, handlers, and unsafe links", () => {
    const html = sanitizeHtml('<p onclick="x()">Hi<script>alert(1)</script><img src=x onerror=alert(1)><a href="javascript:alert(1)">l</a><a href="https://example.com">ok</a></p>');
    assert.ok(!/script|onerror|onclick|javascript:|<img/i.test(html), html);
    assert.ok(html.includes('href="https://example.com"'), html);
  });
  test("keeps allowed formatting", () => {
    const html = sanitizeHtml('<h1>T</h1><ul data-checklist="true"><li data-checked="true">x</li></ul><b>b</b>');
    assert.equal(html, '<h1>T</h1><ul data-checklist="true"><li data-checked="true">x</li></ul><b>b</b>');
  });
  test("note documents round-trip and tolerate plain text", () => {
    assert.equal(parseNoteDocument(serializeNoteDocument("<p>Hello</p>")).html, "<p>Hello</p>");
    const recovered = parseNoteDocument("just text");
    assert.ok(recovered.recovered);
  });
});

group("download names", () => {
  test("strip path separators, reserved characters, and leading dots", () => {
    assert.equal(sanitizeFilename("../../etc/passwd"), "_.._etc_passwd");
    assert.equal(sanitizeFilename("a:b*c?.txt"), "a_b_c_.txt");
    assert.equal(sanitizeFilename(".hidden"), "hidden");
  });
  test("limit length but keep the extension", () => {
    const name = sanitizeFilename(`${"x".repeat(200)}.pdf`);
    assert.equal(name.length, 120);
    assert.ok(name.endsWith(".pdf"));
  });
  test("Content-Disposition forms", () => {
    assert.equal(filenameFromDisposition('attachment; filename="report.pdf"'), "report.pdf");
    assert.equal(filenameFromDisposition("attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf"), "résumé.pdf");
  });
});

group("helpers", () => {
  test("default names are numbered from (2)", () => {
    assert.equal(generateDefaultName("New Folder", null, []), "New Folder");
    assert.equal(generateDefaultName("New Folder", null, ["new folder"]), "New Folder (2)");
  });
  test("formatBytes", () => {
    assert.equal(formatBytes(0), "0 bytes");
    assert.equal(formatBytes(1), "1 byte");
    assert.equal(formatBytes(1536), "1.5 KB");
  });
});
