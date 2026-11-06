/**
 * @file Settings document migrations.
 *
 * The persisted settings document has the shape:
 *
 *   { version: number, values: { [settingKey]: value } }
 *
 * `migrateSettingsDocument()` normalizes whatever was found in storage
 * (nothing, malformed JSON-compatible data, an unversioned object, an
 * older version, or a newer version written by a later build) into a
 * document at SETTINGS_VERSION. It never throws: anything it cannot
 * interpret is logged and treated as empty, so SettingsService falls
 * back to schema defaults.
 *
 * Adding a migration: when SETTINGS_VERSION goes from N to N + 1, add
 * an entry `N: (document, context) => nextDocument` to MIGRATION_STEPS.
 * Steps receive a shallow copy and must return a document whose
 * `version` is N + 1. Per-value repairs (a wrong type for one key)
 * belong in that key's `migrate` hook in settingsSchema.js instead.
 *
 * Version 0 is the implicit "no settings document yet" state. Before
 * SettingsService existed, ThemeManager persisted the theme name under
 * its own storage key ("theme"); the 0 → 1 step carries that value
 * over and retires the old key so there is only one stored theme.
 *
 * The 1 → 2 step does the same for File Explorer, which used to keep
 * its view mode ("explorer:viewMode") and sort order ("explorer:sort")
 * under private storage keys. Those values become fileExplorer.*
 * settings and the private keys are retired.
 */

import { SETTINGS_VERSION } from "./settingsSchema.js";

/** Storage key ThemeManager used before the settings document existed. */
const LEGACY_THEME_KEY = "theme";
/** Storage keys File Explorer used before its preferences became settings. */
const LEGACY_EXPLORER_VIEW_KEY = "explorer:viewMode";
const LEGACY_EXPLORER_SORT_KEY = "explorer:sort";

/**
 * @typedef {object} SettingsDocument
 * @property {number} version
 * @property {Record<string, *>} values
 */

/**
 * @typedef {object} MigrationContext
 * @property {(key: string) => *} readLegacy - Read a legacy storage key (namespaced by StorageService).
 * @property {(key: string) => void} retireLegacy - Mark a legacy key for removal once the migrated document is saved.
 */

/** @type {Readonly<Record<number, (document: SettingsDocument, context: MigrationContext) => SettingsDocument>>} */
const MIGRATION_STEPS = Object.freeze({
  0: (document, context) => {
    const values = { ...document.values };
    const legacyTheme = context.readLegacy(LEGACY_THEME_KEY);
    if (legacyTheme !== null && legacyTheme !== undefined) {
      if (!("appearance.theme" in values)) {
        values["appearance.theme"] = legacyTheme;
      }
      context.retireLegacy(LEGACY_THEME_KEY);
    }
    return { version: 1, values };
  },
  1: (document, context) => {
    const values = { ...document.values };

    const legacyView = context.readLegacy(LEGACY_EXPLORER_VIEW_KEY);
    if (legacyView !== null && legacyView !== undefined) {
      if (!("fileExplorer.defaultView" in values)) values["fileExplorer.defaultView"] = legacyView;
      context.retireLegacy(LEGACY_EXPLORER_VIEW_KEY);
    }

    const legacySort = context.readLegacy(LEGACY_EXPLORER_SORT_KEY);
    if (legacySort !== null && legacySort !== undefined) {
      // Values are copied as-is; SettingsService validates them against
      // the schema afterwards and falls back to defaults if invalid.
      if (legacySort && typeof legacySort === "object") {
        if (!("fileExplorer.sortField" in values) && "field" in legacySort) {
          values["fileExplorer.sortField"] = legacySort.field;
        }
        if (!("fileExplorer.sortDirection" in values) && "direction" in legacySort) {
          values["fileExplorer.sortDirection"] = legacySort.direction;
        }
      }
      context.retireLegacy(LEGACY_EXPLORER_SORT_KEY);
    }

    return { version: 2, values };
  },
});

/**
 * @param {*} raw - Whatever StorageService returned for the settings key.
 * @param {MigrationContext} context
 * @returns {{document: SettingsDocument, changed: boolean}} `changed` is true when the
 *   result differs from what is stored, meaning it should be written back.
 */
export function migrateSettingsDocument(raw, context) {
  let document = normalize(raw);
  let changed = raw === null || raw === undefined || document.version !== raw.version;

  if (document.version > SETTINGS_VERSION) {
    // Written by a newer build. Keep the values (each one is still
    // validated against the current schema), but don't downgrade the
    // stored version or rewrite the document on load.
    console.info(
      `[Settings] stored settings are version ${document.version}; this build understands version ${SETTINGS_VERSION}.`
    );
    return { document, changed: false };
  }

  while (document.version < SETTINGS_VERSION) {
    const step = MIGRATION_STEPS[document.version];
    if (!step) {
      console.warn(`[Settings] no migration from version ${document.version}; using defaults for missing values.`);
      document = { version: SETTINGS_VERSION, values: document.values };
      changed = true;
      break;
    }
    try {
      const next = step({ version: document.version, values: { ...document.values } }, context);
      document = normalize(next);
      changed = true;
    } catch (error) {
      console.error(`[Settings] migration from version ${document.version} failed; using defaults.`, error);
      document = { version: SETTINGS_VERSION, values: {} };
      changed = true;
      break;
    }
  }

  return { document, changed };
}

/**
 * Coerce stored data into a SettingsDocument. Missing version → 0.
 * Anything that isn't a plain object (or whose `values` isn't one) is
 * treated as an empty version-0 document.
 * @param {*} raw
 * @returns {SettingsDocument}
 */
function normalize(raw) {
  if (raw === null || raw === undefined) {
    return { version: 0, values: {} };
  }
  if (!isPlainObject(raw)) {
    console.warn("[Settings] stored settings are malformed; using defaults.", raw);
    return { version: 0, values: {} };
  }

  const version = Number.isInteger(raw.version) && raw.version >= 0 ? raw.version : 0;
  if (!isPlainObject(raw.values)) {
    if (raw.values !== undefined) {
      console.warn("[Settings] stored settings values are malformed; using defaults.", raw.values);
    }
    return { version, values: {} };
  }
  return { version, values: { ...raw.values } };
}

/**
 * @param {*} value
 * @returns {boolean}
 */
function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
