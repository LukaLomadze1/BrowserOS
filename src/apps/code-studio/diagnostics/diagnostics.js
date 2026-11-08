/**
 * @file Diagnostics for Code Studio: syntax and structure problems of
 * a file, computed without running it.
 *
 *   HTML        structure (htmlChecker), inline <script> syntax, inline
 *               <style> rules, missing local files referenced by
 *               src/href.
 *   CSS         cssChecker.
 *   JavaScript  the browser's parser in a sandboxed frame (jsSyntaxChecker).
 *   JSON        jsonChecker (data only, never evaluated).
 *
 * Every diagnostic is a syntax/structure finding (`kind: "syntax"`).
 * Errors raised while a page runs come from the preview console
 * instead and are labelled as runtime errors there.
 */

import { checkHtml } from "./htmlChecker.js";
import { checkCss } from "./cssChecker.js";
import { checkJavaScriptSyntax, looksLikeModule } from "./jsSyntaxChecker.js";
import { checkJson } from "./jsonChecker.js";
import { resolveProjectPath, isExternalReference } from "../project/paths.js";

/**
 * @typedef {object} Diagnostic
 * @property {string} path
 * @property {number} line - 1-based.
 * @property {number} column - 1-based.
 * @property {"error"|"warning"|"info"} severity
 * @property {string} message
 * @property {string} source - "HTML", "CSS", "JavaScript", "JSON".
 * @property {"syntax"} kind
 */

/**
 * @param {object} input
 * @param {string} input.path - VFS path of the file.
 * @param {string} input.text - Current (possibly unsaved) contents.
 * @param {string} input.languageId
 * @param {string} [input.projectRoot] - Root used for "/"-relative references.
 * @param {(path: string) => Promise<boolean>} [input.fileExists] - For reference checks; omitted to skip them.
 * @returns {Promise<Diagnostic[]>}
 */
export async function diagnose({ path, text, languageId, projectRoot = "/", fileExists }) {
  const results = [];
  const add = (source, problem) =>
    results.push({
      path,
      line: problem.line,
      column: Math.max(1, problem.column || 1),
      severity: problem.severity,
      message: problem.message,
      source,
      kind: "syntax",
    });

  if (languageId === "html") {
    const { problems, blocks, references } = checkHtml(text);
    for (const problem of problems) add("HTML", problem);
    for (const block of blocks) {
      if (block.kind === "style") {
        for (const problem of checkCss(block.text, { lineOffset: block.line - 1 })) add("CSS", problem);
      } else if (block.text.trim() && !block.src) {
        const error = await checkJavaScriptSyntax(block.text, { module: block.module });
        if (error) {
          add("JavaScript", {
            line: block.line + error.line - 1,
            column: error.line === 1 ? block.column + Math.max(0, error.column - 1) : error.column,
            severity: "error",
            message: `Syntax error: ${error.message}`,
          });
        }
      }
    }
    if (fileExists) {
      const folder = path.slice(0, path.lastIndexOf("/")) || "/";
      const checks = references
        .filter((reference) => !isExternalReference(reference.value))
        .map(async (reference) => {
          const target = resolveProjectPath(reference.value, folder, projectRoot);
          if (!target) return;
          if (!(await fileExists(target))) {
            add("HTML", { line: reference.line, column: reference.column, severity: "warning", message: `${reference.attribute}="${reference.value}": no file at ${target}` });
          }
        });
      await Promise.all(checks);
    }
  } else if (languageId === "css") {
    for (const problem of checkCss(text)) add("CSS", problem);
  } else if (languageId === "javascript") {
    if (text.trim()) {
      const module = /\.mjs$/i.test(path) || looksLikeModule(text);
      const error = await checkJavaScriptSyntax(text, { module });
      if (error) add("JavaScript", { line: error.line, column: error.column, severity: "error", message: `Syntax error: ${error.message}` });
    }
  } else if (languageId === "json") {
    const problem = checkJson(text);
    if (problem) add("JSON", problem);
  }
  results.sort((a, b) => a.line - b.line || a.column - b.column);
  return results;
}

export { checkJson };
