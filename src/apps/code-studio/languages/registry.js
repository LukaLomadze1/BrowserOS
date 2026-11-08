/**
 * @file Language registry for Code Studio — the extension point for
 * language support.
 *
 * A language describes how the editor highlights and edits a file type:
 *
 *   {
 *     id: "css",
 *     name: "CSS",
 *     extensions: ["css"],
 *     initialState: () => ({ ... }),            // tokenizer state at the start of a file
 *     tokenize: (lineText, state) => ({ tokens: [[type|null, text], ...], state }),
 *     comment: { line?: "//", block?: ["/*", "*\/"] },   // for Toggle comment
 *     indentAfter?: RegExp,                     // a line ending like this indents the next line
 *     diagnose?: (text, context) => Promise<Diagnostic[]>  // optional syntax checks
 *   }
 *
 * `tokenize` is called per line with the state the previous line ended
 * in, and must not mutate the state it receives. Token types map to CSS
 * classes `cs-tok-<type>` (kw, str, num, com, fn, prop, punc, op, tag,
 * attr, val, sel, at, re, lit, ent, var, head, link, del).
 */

/** @type {Map<string, object>} */
const LANGUAGES = new Map();

/** Plain text: no tokens. */
export const PLAIN_TEXT = Object.freeze({
  id: "plaintext",
  name: "Plain Text",
  extensions: [],
  initialState: () => ({}),
  tokenize: (text, state) => ({ tokens: text ? [[null, text]] : [], state }),
  comment: {},
});

/**
 * @param {object} language
 * @returns {void}
 */
export function registerLanguage(language) {
  if (!language?.id || typeof language.tokenize !== "function" || typeof language.initialState !== "function") {
    throw new Error("[CodeStudio] a language needs id, tokenize(), and initialState()");
  }
  LANGUAGES.set(language.id, Object.freeze({ comment: {}, extensions: [], ...language }));
}

/**
 * @param {string} id
 * @returns {object}
 */
export function getLanguage(id) {
  return LANGUAGES.get(id) ?? PLAIN_TEXT;
}

/**
 * @param {string} path - File path or name.
 * @returns {object} The language for a file, plain text when unknown.
 */
export function languageForPath(path) {
  const name = String(path).split("/").pop().toLowerCase();
  const extension = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
  for (const language of LANGUAGES.values()) {
    if (language.extensions.includes(extension)) return language;
  }
  return PLAIN_TEXT;
}

/** @returns {object[]} Every registered language. */
export function listLanguages() {
  return [...LANGUAGES.values()];
}
