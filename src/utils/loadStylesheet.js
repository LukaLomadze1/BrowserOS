/**
 * @file Injects a <link rel="stylesheet"> once per href.
 *
 * Lets each app own its stylesheet and load it the first time it's
 * launched, instead of every app's CSS having to be hand-wired into
 * index.html ahead of time. Combined with dynamic import() in
 * AppManager, this is what keeps app loading lazy end to end.
 */

const injectedHrefs = new Set();

/**
 * @param {string} href - Path relative to index.html.
 * @returns {void}
 */
export function ensureStylesheet(href) {
  if (injectedHrefs.has(href)) return;
  injectedHrefs.add(href);

  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  document.head.append(link);
}
