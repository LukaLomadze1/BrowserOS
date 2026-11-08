/**
 * @file Editor font stacks for Code Studio, keyed by the values of the
 * `codeStudio.fontFamily` setting. Every stack ends in the generic
 * `monospace` family, so a missing font still gives a fixed-width face.
 * JetBrains Mono is served with BrowserOS (assets/fonts/), so it looks
 * the same on every system; the others depend on installed fonts.
 */

export const EDITOR_FONTS = Object.freeze([
  Object.freeze({ id: "system-mono", label: "System monospace", stack: 'ui-monospace, "SFMono-Regular", "Cascadia Code", "Segoe UI Mono", "Roboto Mono", Menlo, Consolas, monospace' }),
  Object.freeze({ id: "jetbrains-mono", label: "JetBrains Mono (included)", stack: '"JetBrains Mono", ui-monospace, Consolas, monospace' }),
  Object.freeze({ id: "consolas", label: "Consolas", stack: 'Consolas, "Cascadia Mono", "Lucida Console", monospace' }),
  Object.freeze({ id: "courier", label: "Courier New", stack: '"Courier New", Courier, monospace' }),
  Object.freeze({ id: "menlo", label: "Menlo / Monaco", stack: 'Menlo, Monaco, "DejaVu Sans Mono", monospace' }),
]);

/**
 * @param {string} id
 * @returns {string} The CSS font-family stack for a setting value.
 */
export function fontStackFor(id) {
  return (EDITOR_FONTS.find((font) => font.id === id) ?? EDITOR_FONTS[0]).stack;
}
