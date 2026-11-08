/**
 * @file The BrowserOS release: its version, shown by About BrowserOS
 * and the Terminal's `version` command and recorded in backups, and the
 * project's public repository. The backup format has its own version
 * number (see src/core/backup/backupFormat.js), so restoring does not
 * depend on these values.
 *
 * Builds made with tools/build.py also write build-info.json (commit and
 * build time) next to index.html; About BrowserOS shows it when present.
 */

export const BROWSEROS_VERSION = "16.0";
export const BROWSEROS_RELEASE_DATE = "2026-11-07";
export const BROWSEROS_REPOSITORY = "https://github.com/LukaLomadze1/BrowserOS";
/**
 * SPDX identifier of the license BrowserOS's own source code is published
 * under, or null while the repository has no LICENSE file (then the
 * default applies: all rights reserved by the author). The bundled fonts
 * have their own license (SIL Open Font License 1.1, see assets/fonts/).
 * @type {string|null}
 */
export const BROWSEROS_LICENSE = null;
