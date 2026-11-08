/**
 * @file Build information, shown by About BrowserOS.
 *
 * In the repository this is null: BrowserOS runs straight from its
 * source files and has no build step. `python tools/build.py` copies the
 * site into dist/ and replaces this file there with the commit it was
 * built from and the build time, so a deployed copy can say exactly
 * which version of the code it is.
 *
 * @type {{commit: string, commitDate: string, builtAt: string, dirty: boolean}|null}
 */
export const BUILD_INFO = null;
