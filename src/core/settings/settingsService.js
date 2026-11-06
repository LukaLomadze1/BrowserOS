/**
 * @file SettingsService — the one authoritative store for every
 * BrowserOS setting.
 *
 * Responsibilities:
 *  - Hold the current value of every key declared in settingsSchema.js.
 *  - Validate every incoming and stored value against the schema.
 *  - Persist through StorageService as a versioned document.
 *  - Notify interested code through targeted subscriptions (one key,
 *    one category, or everything) and through EventBus.
 *
 * Non-responsibilities: SettingsService never touches the DOM and
 * never knows what a setting *does*. Each subsystem that acts on
 * settings subscribes to its own category and applies the values
 * itself (ThemeManager, DesktopManager, StartMenuManager, every
 * ExplorerManager, keyboardShortcuts), so the Settings UI only ever
 * talks to this service.
 *
 * Values: strings, numbers, booleans, and arrays of those. Array
 * values are stored and handed out frozen, so no consumer can mutate
 * shared state; to change one, pass a new array to set().
 *
 * Persistence model: only values that were explicitly set are stored
 * (a sparse document). A key that was never changed, or was reset,
 * has no stored entry and always reflects the schema's current
 * default. Writes are coalesced for a short interval so dragging a
 * slider doesn't write storage on every input event, and are flushed
 * synchronously on `pagehide` / when the page becomes hidden so a
 * change made just before a reload is never lost.
 *
 * Stored keys this build doesn't recognise (e.g. written by a newer
 * build) are carried through untouched on every write instead of
 * being deleted.
 *
 * Batches: every mutating call is one batch. Key subscribers hear about
 * each changed key; category subscribers hear once per batch per
 * affected category; global subscribers hear once per batch.
 *
 * Events (EventBus):
 *  - "settings:initialized"   { version, values }
 *  - "settings:changed"       { key, category, value, previousValue, reason }
 *        Once per key whose value changed through set(), setMany(), or
 *        reset(). Not emitted for keys changed by resetCategory() or
 *        resetAll(); those batches are reported once each instead.
 *  - "settings:reset"         { key, category, value, previousValue, changed }
 *        Once per reset() call, whether or not the value changed.
 *  - "settings:categoryReset" { category, changes }
 *  - "settings:allReset"      { changes }
 *  - "settings:<category>Changed" { category, reason, changes }
 *        e.g. "settings:desktopChanged". Once per batch for every
 *        category with at least one changed key, for every kind of
 *        mutation, including resets.
 *  - "settings:persistenceFailed"   { error }
 *  - "settings:persistenceRestored" {}
 *
 * Every payload and every change record is frozen; none of them
 * reference internal state.
 */

import { eventBus } from "../eventBus.js";
import { storage } from "../storage.js";
import { SETTINGS_SCHEMA, SETTINGS_VERSION, SETTINGS_CATEGORY_IDS } from "./settingsSchema.js";
import { migrateSettingsDocument } from "./settingsMigrations.js";

/**
 * StorageService key of the persisted settings document. The pre-boot
 * script in index.html reads the same key (namespaced as
 * "browseros:settings") to pick the first-paint theme; keep them in sync.
 */
export const SETTINGS_STORAGE_KEY = "settings";

/** Coalescing window for persistence writes. */
const PERSIST_DELAY_MS = 150;

const PERSISTENCE_ERROR_MESSAGE = "Settings could not be saved. Changes will apply until BrowserOS is reloaded.";

/**
 * @typedef {object} SettingChange
 * @property {string} key
 * @property {string} category
 * @property {*} value
 * @property {*} previousValue
 * @property {"set"|"reset"|"categoryReset"|"allReset"} reason
 */

/**
 * @typedef {object} SettingsBatch
 * @property {string|null} category - Category of the batch, or null when it spans several.
 * @property {"set"|"reset"|"categoryReset"|"allReset"} reason
 * @property {ReadonlyArray<SettingChange>} changes
 */

class SettingsService {
  constructor() {
    this._initialized = false;
    /** @type {Map<string, *>} Current value of every schema key. */
    this._values = new Map();
    /** @type {Set<string>} Keys with an explicitly chosen (persisted) value. */
    this._explicitKeys = new Set();
    /** @type {Record<string, *>} Stored entries for keys outside this build's schema. */
    this._foreignValues = {};
    this._documentVersion = SETTINGS_VERSION;

    /** @type {Map<string, Set<(change: SettingChange) => void>>} */
    this._keySubscribers = new Map();
    /** @type {Map<string, Set<(batch: SettingsBatch) => void>>} */
    this._categorySubscribers = new Map();
    /** @type {Set<(batch: SettingsBatch) => void>} */
    this._allSubscribers = new Set();

    this._persistTimerId = null;
    this._persistenceFailing = false;

    this._pageHideHandler = () => this.flush();
    this._visibilityHandler = () => {
      if (document.visibilityState === "hidden") this.flush();
    };
  }

  /**
   * Load, migrate, and validate stored settings. Call once during
   * boot, after StorageService is available and before anything that
   * renders preference-dependent UI. Safe to call more than once;
   * later calls are no-ops. Every read/write method also calls this
   * lazily, so code that runs before boot completes still sees valid
   * values instead of crashing.
   * @returns {void}
   */
  init() {
    if (this._initialized) return;
    this._initialized = true;

    for (const [key, descriptor] of Object.entries(SETTINGS_SCHEMA)) {
      this._values.set(key, descriptor.defaultValue);
    }

    const retiredLegacyKeys = [];
    const raw = storage.get(SETTINGS_STORAGE_KEY, null);
    const { document: storedDocument, changed } = migrateSettingsDocument(raw, {
      readLegacy: (key) => storage.get(key, null),
      retireLegacy: (key) => retiredLegacyKeys.push(key),
    });
    this._documentVersion = Math.max(storedDocument.version, SETTINGS_VERSION);

    let needsWrite = changed;
    for (const [key, storedValue] of Object.entries(storedDocument.values)) {
      const descriptor = SETTINGS_SCHEMA[key];
      if (!descriptor) {
        this._foreignValues[key] = storedValue;
        continue;
      }
      if (!descriptor.persist) {
        needsWrite = true;
        continue;
      }
      const accepted = this._acceptStoredValue(key, descriptor, storedValue);
      if (accepted.ok) {
        this._values.set(key, normalizeValue(descriptor, accepted.value));
        this._explicitKeys.add(key);
      }
      if (!accepted.ok || accepted.repaired) needsWrite = true;
    }

    if (needsWrite && this._writeNow()) {
      for (const key of retiredLegacyKeys) {
        try {
          storage.remove(key);
        } catch (error) {
          console.warn(`[Settings] could not remove legacy key "${key}":`, error);
        }
      }
    }

    window.addEventListener("pagehide", this._pageHideHandler);
    document.addEventListener("visibilitychange", this._visibilityHandler);

    eventBus.emit("settings:initialized", Object.freeze({ version: SETTINGS_VERSION, values: this.getAll() }));
  }

  /** @returns {boolean} */
  isInitialized() {
    return this._initialized;
  }

  /**
   * @returns {string|null} A user-facing message while the most recent
   *   write failed, otherwise null. Lets UI opened after a failure show
   *   it without having observed the "settings:persistenceFailed" event.
   */
  getPersistenceError() {
    return this._persistenceFailing ? PERSISTENCE_ERROR_MESSAGE : null;
  }

  // ---------------------------------------------------------------
  // Reading
  // ---------------------------------------------------------------

  /**
   * @param {string} key
   * @returns {*} The current value (arrays are frozen), or undefined for an unknown key.
   */
  get(key) {
    this.init();
    if (!this._requireDescriptor(key, "get")) return undefined;
    return this._values.get(key);
  }

  /**
   * @param {string} key
   * @returns {*} The schema default, or undefined for an unknown key.
   */
  getDefault(key) {
    return this._requireDescriptor(key, "getDefault")?.defaultValue;
  }

  /**
   * @param {string} key
   * @returns {boolean} Whether the current value equals the schema default.
   */
  isDefault(key) {
    return valuesEqual(this.get(key), this.getDefault(key));
  }

  /**
   * @param {string} key
   * @returns {import("./settingsSchema.js").SettingDescriptor|undefined} The frozen schema
   *   descriptor — used by UI code to read ranges and allowed values instead of duplicating them.
   */
  getDescriptor(key) {
    return SETTINGS_SCHEMA[key];
  }

  /**
   * @param {string} key
   * @returns {boolean} Whether the key exists in the schema.
   */
  has(key) {
    return Object.prototype.hasOwnProperty.call(SETTINGS_SCHEMA, key);
  }

  /**
   * @returns {ReadonlyArray<string>} Every category id, in schema order.
   */
  getCategoryIds() {
    return SETTINGS_CATEGORY_IDS;
  }

  /**
   * @param {string} category
   * @returns {string[]} Every key in the category, in schema order.
   */
  getKeys(category) {
    return this._keysInCategory(category);
  }

  /**
   * @param {string} category
   * @returns {Readonly<Record<string, *>>} Frozen snapshot of every key in the category, keyed by full setting key.
   */
  getCategory(category) {
    this.init();
    const snapshot = {};
    for (const key of this._keysInCategory(category)) {
      snapshot[key] = this._values.get(key);
    }
    return Object.freeze(snapshot);
  }

  /**
   * @returns {Readonly<Record<string, *>>} Frozen snapshot of every setting.
   */
  getAll() {
    this.init();
    return Object.freeze(Object.fromEntries(this._values));
  }

  /**
   * @param {string} [category] - Limit to one category.
   * @returns {string[]} Keys whose current value differs from the schema default.
   */
  getCustomizedKeys(category) {
    this.init();
    const keys = category ? this._keysInCategory(category) : Object.keys(SETTINGS_SCHEMA);
    return keys.filter((key) => !valuesEqual(this._values.get(key), SETTINGS_SCHEMA[key].defaultValue));
  }

  // ---------------------------------------------------------------
  // Writing
  // ---------------------------------------------------------------

  /**
   * Validate and apply one value. Subscribers are notified only if the
   * value actually changed; persistence is scheduled either way, since
   * choosing a value that happens to equal the default still records
   * an explicit choice.
   * @param {string} key
   * @param {*} value
   * @returns {boolean} Whether the value was valid and accepted.
   */
  set(key, value) {
    return this.setMany({ [key]: value });
  }

  /**
   * Validate and apply several values as one batch: one category
   * notification per affected category and one persistence write. If
   * any value is invalid, nothing is applied.
   * @param {Record<string, *>} entries - Full setting keys to values.
   * @returns {boolean} Whether every value was valid and the batch was applied.
   */
  setMany(entries) {
    this.init();
    const updates = [];
    for (const [key, value] of Object.entries(entries ?? {})) {
      const descriptor = this._requireDescriptor(key, "set");
      if (!descriptor) return false;
      const validation = validateValue(descriptor, value);
      if (!validation.ok) {
        console.warn(`[Settings] rejected ${safeStringify(value)} for "${key}": ${validation.reason}`);
        return false;
      }
      updates.push({ key, value: normalizeValue(descriptor, value) });
    }
    if (updates.length === 0) return true;

    const changes = this._commit(updates, "set");
    this._notify(changes, "set");
    for (const change of changes) {
      eventBus.emit("settings:changed", change);
    }
    return true;
  }

  /**
   * Restore one key to its schema default.
   * @param {string} key
   * @returns {boolean} Whether the key exists.
   */
  reset(key) {
    this.init();
    const descriptor = this._requireDescriptor(key, "reset");
    if (!descriptor) return false;

    const previousValue = this._values.get(key);
    const changes = this._commit([{ key, value: descriptor.defaultValue }], "reset");
    this._notify(changes, "reset");
    if (changes.length > 0) {
      eventBus.emit("settings:changed", changes[0]);
    }
    eventBus.emit(
      "settings:reset",
      Object.freeze({
        key,
        category: descriptor.category,
        value: descriptor.defaultValue,
        previousValue,
        changed: changes.length > 0,
      })
    );
    return true;
  }

  /**
   * Restore every key in a category to its default as one batch:
   * one persistence write, one category-subscriber notification, and
   * one "settings:categoryReset" event.
   * @param {string} category
   * @returns {boolean} Whether the category exists.
   */
  resetCategory(category) {
    this.init();
    const keys = this._keysInCategory(category);
    if (keys.length === 0) {
      console.warn(`[Settings] resetCategory: unknown category "${category}"`);
      return false;
    }

    const updates = keys.map((key) => ({ key, value: SETTINGS_SCHEMA[key].defaultValue }));
    const changes = this._commit(updates, "categoryReset");
    this._notify(changes, "categoryReset");
    eventBus.emit("settings:categoryReset", Object.freeze({ category, changes }));
    return true;
  }

  /**
   * Restore every setting in every category to its default as one
   * batch. Settings only: files, desktop layout, recent history, and
   * other application data are untouched.
   * @returns {void}
   */
  resetAll() {
    this.init();
    const updates = Object.keys(SETTINGS_SCHEMA).map((key) => ({ key, value: SETTINGS_SCHEMA[key].defaultValue }));
    const changes = this._commit(updates, "allReset");
    this._notify(changes, "allReset");
    eventBus.emit("settings:allReset", Object.freeze({ changes }));
  }

  /**
   * Write any pending change to storage immediately.
   * @returns {void}
   */
  flush() {
    if (this._persistTimerId === null) return;
    window.clearTimeout(this._persistTimerId);
    this._persistTimerId = null;
    this._writeNow();
  }

  // ---------------------------------------------------------------
  // Subscriptions
  // ---------------------------------------------------------------

  /**
   * Run `handler` whenever one key's value changes, including through
   * a category or global reset.
   * @param {string} key
   * @param {(change: SettingChange) => void} handler
   * @returns {() => void} Unsubscribe. Safe to call more than once.
   */
  subscribe(key, handler) {
    if (!this._requireDescriptor(key, "subscribe")) return () => {};
    return addToSetMap(this._keySubscribers, key, handler);
  }

  /**
   * Run `handler` once per batch that changes any key in a category.
   * The batch passed in contains only that category's changes.
   * @param {string} category
   * @param {(batch: SettingsBatch) => void} handler
   * @returns {() => void} Unsubscribe. Safe to call more than once.
   */
  subscribeCategory(category, handler) {
    if (this._keysInCategory(category).length === 0) {
      console.warn(`[Settings] subscribeCategory: unknown category "${category}"`);
      return () => {};
    }
    return addToSetMap(this._categorySubscribers, category, handler);
  }

  /**
   * Run `handler` once per batch that changes any setting.
   * @param {(batch: SettingsBatch) => void} handler
   * @returns {() => void} Unsubscribe. Safe to call more than once.
   */
  subscribeAll(handler) {
    this._allSubscribers.add(handler);
    return () => this._allSubscribers.delete(handler);
  }

  /**
   * Flush pending writes and detach every listener. Intended for
   * tests and teardown.
   * @returns {void}
   */
  destroy() {
    this.flush();
    window.removeEventListener("pagehide", this._pageHideHandler);
    document.removeEventListener("visibilitychange", this._visibilityHandler);
    this._keySubscribers.clear();
    this._categorySubscribers.clear();
    this._allSubscribers.clear();
  }

  // ---------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------

  /**
   * Apply already-validated, normalized updates to in-memory state and
   * schedule a write. Returns change records only for keys whose value
   * changed.
   * @param {Array<{key: string, value: *}>} updates
   * @param {SettingChange["reason"]} reason
   * @returns {ReadonlyArray<SettingChange>}
   */
  _commit(updates, reason) {
    const changes = [];
    let persistedStateChanged = false;

    for (const { key, value } of updates) {
      const descriptor = SETTINGS_SCHEMA[key];
      const previousValue = this._values.get(key);
      const unchanged = valuesEqual(previousValue, value);

      if (descriptor.persist) {
        const wasExplicit = this._explicitKeys.has(key);
        if (reason === "set") {
          this._explicitKeys.add(key);
        } else {
          this._explicitKeys.delete(key);
        }
        if (wasExplicit !== this._explicitKeys.has(key) || !unchanged) {
          persistedStateChanged = true;
        }
      }

      if (unchanged) continue;
      this._values.set(key, value);
      changes.push(Object.freeze({ key, category: descriptor.category, value, previousValue, reason }));
    }

    if (persistedStateChanged) this._schedulePersist();
    return Object.freeze(changes);
  }

  /**
   * Deliver one batch: key subscribers per change, then each affected
   * category's subscribers once (with only that category's changes),
   * then global subscribers once. Also emits the per-category bus
   * event. Each handler is isolated so one failure can't block the rest.
   * @param {ReadonlyArray<SettingChange>} changes
   * @param {SettingChange["reason"]} reason
   * @returns {void}
   */
  _notify(changes, reason) {
    if (changes.length === 0) return;

    for (const change of changes) {
      for (const handler of [...(this._keySubscribers.get(change.key) ?? [])]) {
        safeInvoke(handler, change, `key "${change.key}"`);
      }
    }

    const byCategory = new Map();
    for (const change of changes) {
      if (!byCategory.has(change.category)) byCategory.set(change.category, []);
      byCategory.get(change.category).push(change);
    }

    for (const [category, categoryChanges] of byCategory) {
      const batch = Object.freeze({ category, reason, changes: Object.freeze(categoryChanges) });
      for (const handler of [...(this._categorySubscribers.get(category) ?? [])]) {
        safeInvoke(handler, batch, `category "${category}"`);
      }
      eventBus.emit(`settings:${category}Changed`, batch);
    }

    const fullBatch = Object.freeze({
      category: byCategory.size === 1 ? [...byCategory.keys()][0] : null,
      reason,
      changes,
    });
    for (const handler of [...this._allSubscribers]) {
      safeInvoke(handler, fullBatch, "all settings");
    }
  }

  /** @returns {void} */
  _schedulePersist() {
    if (this._persistTimerId !== null) return;
    this._persistTimerId = window.setTimeout(() => {
      this._persistTimerId = null;
      this._writeNow();
    }, PERSIST_DELAY_MS);
  }

  /**
   * @returns {boolean} Whether the write succeeded.
   */
  _writeNow() {
    const values = { ...this._foreignValues };
    for (const key of this._explicitKeys) {
      const value = this._values.get(key);
      values[key] = Array.isArray(value) ? [...value] : value;
    }

    let succeeded = false;
    try {
      succeeded = storage.set(SETTINGS_STORAGE_KEY, { version: this._documentVersion, values });
    } catch (error) {
      console.error("[Settings] failed to persist settings:", error);
    }

    if (!succeeded && !this._persistenceFailing) {
      this._persistenceFailing = true;
      eventBus.emit("settings:persistenceFailed", Object.freeze({ error: PERSISTENCE_ERROR_MESSAGE }));
    } else if (succeeded && this._persistenceFailing) {
      this._persistenceFailing = false;
      eventBus.emit("settings:persistenceRestored", Object.freeze({}));
    }
    return succeeded;
  }

  /**
   * Validate a value read from storage, attempting the descriptor's
   * migrate hook once if the raw value is invalid.
   * @param {string} key
   * @param {import("./settingsSchema.js").SettingDescriptor} descriptor
   * @param {*} storedValue
   * @returns {{ok: boolean, value?: *, repaired?: boolean}}
   */
  _acceptStoredValue(key, descriptor, storedValue) {
    const direct = validateValue(descriptor, storedValue);
    if (direct.ok) return { ok: true, value: storedValue, repaired: false };

    if (typeof descriptor.migrate === "function") {
      try {
        const migrated = descriptor.migrate(storedValue);
        if (validateValue(descriptor, migrated).ok) {
          return { ok: true, value: migrated, repaired: true };
        }
      } catch (error) {
        console.warn(`[Settings] migrate() for "${key}" threw:`, error);
      }
    }

    console.warn(
      `[Settings] stored value ${safeStringify(storedValue)} for "${key}" is invalid (${direct.reason}); using default.`
    );
    return { ok: false };
  }

  /**
   * @param {string} key
   * @param {string} operation
   * @returns {import("./settingsSchema.js").SettingDescriptor|null}
   */
  _requireDescriptor(key, operation) {
    const descriptor = SETTINGS_SCHEMA[key];
    if (!descriptor) {
      console.warn(`[Settings] ${operation}: unknown setting "${key}"`);
      return null;
    }
    return descriptor;
  }

  /**
   * @param {string} category
   * @returns {string[]}
   */
  _keysInCategory(category) {
    return Object.keys(SETTINGS_SCHEMA).filter((key) => SETTINGS_SCHEMA[key].category === category);
  }
}

/**
 * @param {import("./settingsSchema.js").SettingDescriptor} descriptor
 * @param {*} value
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
function validateValue(descriptor, value) {
  if (descriptor.type === "array") {
    if (!Array.isArray(value)) {
      return { ok: false, reason: `expected array, got ${value === null ? "null" : typeof value}` };
    }
    if (typeof descriptor.maxItems === "number" && value.length > descriptor.maxItems) {
      return { ok: false, reason: `more than ${descriptor.maxItems} items` };
    }
    if (descriptor.itemType && value.some((item) => typeof item !== descriptor.itemType)) {
      return { ok: false, reason: `every item must be a ${descriptor.itemType}` };
    }
    if (descriptor.uniqueItems && new Set(value).size !== value.length) {
      return { ok: false, reason: "items must be unique" };
    }
  } else if (typeof value !== descriptor.type) {
    return { ok: false, reason: `expected ${descriptor.type}, got ${value === null ? "null" : typeof value}` };
  }

  if (descriptor.type === "number") {
    if (!Number.isFinite(value)) return { ok: false, reason: "not a finite number" };
    if (descriptor.integer && !Number.isInteger(value)) return { ok: false, reason: "not an integer" };
    if (typeof descriptor.min === "number" && value < descriptor.min) {
      return { ok: false, reason: `below minimum ${descriptor.min}` };
    }
    if (typeof descriptor.max === "number" && value > descriptor.max) {
      return { ok: false, reason: `above maximum ${descriptor.max}` };
    }
  }
  if (descriptor.allowedValues && !descriptor.allowedValues.includes(value)) {
    return { ok: false, reason: `not one of ${descriptor.allowedValues.join(", ")}` };
  }
  if (typeof descriptor.validate === "function") {
    try {
      if (!descriptor.validate(value)) return { ok: false, reason: "failed custom validation" };
    } catch (error) {
      return { ok: false, reason: `custom validation threw: ${error.message}` };
    }
  }
  return { ok: true };
}

/**
 * Arrays are copied and frozen so callers can never mutate stored
 * state through a reference they passed in or received.
 * @param {import("./settingsSchema.js").SettingDescriptor} descriptor
 * @param {*} value
 * @returns {*}
 */
function normalizeValue(descriptor, value) {
  if (descriptor.type === "array") return Object.freeze([...value]);
  return value;
}

/**
 * @param {*} a
 * @param {*} b
 * @returns {boolean} Strict equality for primitives; element-wise for arrays.
 */
function valuesEqual(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => item === b[index]);
  }
  return a === b;
}

/**
 * @param {*} value
 * @returns {string}
 */
function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * @template T
 * @param {Map<string, Set<T>>} map
 * @param {string} name
 * @param {T} handler
 * @returns {() => void}
 */
function addToSetMap(map, name, handler) {
  if (!map.has(name)) map.set(name, new Set());
  map.get(name).add(handler);
  return () => {
    const set = map.get(name);
    if (!set) return;
    set.delete(handler);
    if (set.size === 0) map.delete(name);
  };
}

/**
 * @param {Function} handler
 * @param {*} payload
 * @param {string} label
 * @returns {void}
 */
function safeInvoke(handler, payload, label) {
  try {
    handler(payload);
  } catch (error) {
    console.error(`[Settings] subscriber for ${label} threw:`, error);
  }
}

/**
 * Singleton settings service shared across the OS.
 * @type {SettingsService}
 */
export const settingsService = new SettingsService();
