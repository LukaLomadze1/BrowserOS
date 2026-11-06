/**
 * @file keyboardShortcuts — the central keyboard shortcut registry and
 * the only document-level shortcut listener in BrowserOS.
 *
 * Two kinds of shortcut (see shortcutCatalog.js):
 *
 *  - Global shortcuts are dispatched here. Their owners bind a handler
 *    with `bind(id, handler)`; one capture-free `keydown` listener on
 *    `document` matches each event against every bound definition.
 *    Events that a focused component already handled
 *    (`defaultPrevented`) are ignored, events inside text fields are
 *    ignored unless the definition opts in with `allowInEditable`, and
 *    a definition with a `settingKey` only fires while that setting is
 *    true. A handler may return `false` to decline an event (e.g.
 *    "clear selection" with nothing selected), leaving it unconsumed.
 *
 *  - Local shortcuts are handled by the component that owns the focus
 *    context (Desktop icons, an Explorer window, a Terminal input, the
 *    Start Menu). Those components still match through `matches()`, so
 *    the catalog stays the single source of truth for both behavior
 *    and the Settings reference.
 *
 * `register()` adds definitions at runtime (e.g. from an app module);
 * `subscribe()` notifies when the set of definitions, bindings, or
 * their enabled state changes, which is how the Settings reference
 * stays current. The same notification is published on EventBus as
 * "keyboard:shortcutsChanged".
 */

import { eventBus } from "../eventBus.js";
import { settingsService } from "../settings/settingsService.js";
import { SHORTCUT_CATEGORIES, SHORTCUT_DEFINITIONS } from "./shortcutCatalog.js";

const MODIFIER_KEYS = new Set(["Meta", "Control", "Alt", "Shift", "AltGraph"]);
const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform ?? "");

const KEY_LABELS = Object.freeze({
  Meta: IS_MAC ? "\u2318" : "Win",
  Escape: "Esc",
  ArrowUp: "\u2191",
  ArrowDown: "\u2193",
  ArrowLeft: "\u2190",
  ArrowRight: "\u2192",
  Delete: "Delete",
  Enter: "Enter",
  Tab: "Tab",
  " ": "Space",
  PageUp: "Page Up",
  PageDown: "Page Down",
  Backspace: "Backspace",
});

const CODE_LABELS = Object.freeze({ Backquote: "`" });

class KeyboardShortcuts {
  constructor() {
    /** @type {Map<string, import("./shortcutCatalog.js").ShortcutDefinition>} */
    this._definitions = new Map(SHORTCUT_DEFINITIONS.map((definition) => [definition.id, definition]));
    /** @type {Map<string, Set<(e: KeyboardEvent) => (boolean|void)>>} */
    this._bindings = new Map();
    /** @type {Set<() => void>} */
    this._subscribers = new Set();
    this._listening = false;
    this._unsubscribeSettings = null;
    this._keydownHandler = (e) => this._dispatch(e);
  }

  // ---------------------------------------------------------------
  // Definitions
  // ---------------------------------------------------------------

  /**
   * @param {string} id
   * @returns {import("./shortcutCatalog.js").ShortcutDefinition|undefined}
   */
  getDefinition(id) {
    return this._definitions.get(id);
  }

  /**
   * Add a definition at runtime.
   * @param {import("./shortcutCatalog.js").ShortcutDefinition} definition
   * @returns {() => void} Removes the definition (and any bindings to it).
   */
  register(definition) {
    if (!definition?.id || !Array.isArray(definition.combos) || definition.combos.length === 0) {
      throw new Error("[keyboardShortcuts] register() requires an id and at least one combo");
    }
    if (this._definitions.has(definition.id)) {
      throw new Error(`[keyboardShortcuts] shortcut "${definition.id}" is already registered`);
    }
    const frozen = Object.freeze({
      scope: "local",
      context: "",
      ...definition,
      combos: Object.freeze(definition.combos.map((combo) => Object.freeze({ ...combo }))),
    });
    this._definitions.set(frozen.id, frozen);
    this._notifyChanged();
    return () => {
      if (this._definitions.get(frozen.id) !== frozen) return;
      this._definitions.delete(frozen.id);
      this._bindings.delete(frozen.id);
      this._notifyChanged();
    };
  }

  /**
   * @returns {Array<{id: string, label: string, shortcuts: Array<object>}>} Every definition,
   *   grouped by category in display order, each annotated with `keys` (display strings),
   *   `enabled` (setting state for gated global shortcuts), and `bound` (a global handler exists).
   */
  getGroupedShortcuts() {
    const groups = SHORTCUT_CATEGORIES.map((category) => ({ id: category.id, label: category.label, shortcuts: [] }));
    const byId = new Map(groups.map((group) => [group.id, group]));
    for (const definition of this._definitions.values()) {
      let group = byId.get(definition.category);
      if (!group) {
        group = { id: definition.category, label: definition.category, shortcuts: [] };
        byId.set(definition.category, group);
        groups.push(group);
      }
      group.shortcuts.push(
        Object.freeze({
          id: definition.id,
          description: definition.description,
          context: definition.context,
          scope: definition.scope,
          settingKey: definition.settingKey ?? null,
          keys: definition.combos.map((combo) => formatCombo(combo)),
          enabled: this.isEnabled(definition.id),
          bound: definition.scope === "local" || (this._bindings.get(definition.id)?.size ?? 0) > 0,
        })
      );
    }
    return groups.filter((group) => group.shortcuts.length > 0);
  }

  /**
   * @param {string} id
   * @returns {boolean} False only for a gated global shortcut whose setting is off.
   */
  isEnabled(id) {
    const definition = this._definitions.get(id);
    if (!definition) return false;
    if (!definition.settingKey) return true;
    return settingsService.get(definition.settingKey) === true;
  }

  // ---------------------------------------------------------------
  // Matching
  // ---------------------------------------------------------------

  /**
   * Whether an event matches any combo of a definition. Used by local
   * handlers in place of comparing `e.key` directly.
   * @param {KeyboardEvent} event
   * @param {string} id
   * @returns {boolean}
   */
  matches(event, id) {
    const definition = this._definitions.get(id);
    if (!definition) {
      console.warn(`[keyboardShortcuts] matches(): unknown shortcut "${id}"`);
      return false;
    }
    return definition.combos.some((combo) => comboMatches(combo, event));
  }

  /**
   * @param {EventTarget|null} target
   * @returns {boolean} Whether the target is a text-entry context (input, textarea, contenteditable).
   */
  isEditableTarget(target) {
    return isEditable(target);
  }

  // ---------------------------------------------------------------
  // Global bindings
  // ---------------------------------------------------------------

  /**
   * Attach a handler to a global shortcut.
   * @param {string} id
   * @param {(e: KeyboardEvent) => (boolean|void)} handler - Return false to leave the event unhandled.
   * @returns {() => void} Unbind. Safe to call more than once.
   */
  bind(id, handler) {
    const definition = this._definitions.get(id);
    if (!definition) throw new Error(`[keyboardShortcuts] bind(): unknown shortcut "${id}"`);
    if (definition.scope !== "global") {
      throw new Error(`[keyboardShortcuts] "${id}" is a local shortcut; handle it with matches() in its owner`);
    }
    if (!this._bindings.has(id)) this._bindings.set(id, new Set());
    this._bindings.get(id).add(handler);
    this._ensureListening();
    this._notifyChanged();

    return () => {
      const set = this._bindings.get(id);
      if (!set || !set.delete(handler)) return;
      if (set.size === 0) this._bindings.delete(id);
      this._notifyChanged();
    };
  }

  /**
   * @param {() => void} handler - Called whenever definitions, bindings, or enabled state change.
   * @returns {() => void}
   */
  subscribe(handler) {
    this._subscribers.add(handler);
    this._ensureSettingsSubscription();
    return () => this._subscribers.delete(handler);
  }

  /**
   * Remove the document listener and every binding. Intended for tests and teardown.
   * @returns {void}
   */
  destroy() {
    document.removeEventListener("keydown", this._keydownHandler);
    this._listening = false;
    this._bindings.clear();
    this._unsubscribeSettings?.();
    this._unsubscribeSettings = null;
  }

  // ---------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------

  /** @returns {void} */
  _ensureListening() {
    if (this._listening) return;
    this._listening = true;
    document.addEventListener("keydown", this._keydownHandler);
    this._ensureSettingsSubscription();
  }

  /** @returns {void} */
  _ensureSettingsSubscription() {
    if (this._unsubscribeSettings) return;
    this._unsubscribeSettings = settingsService.subscribeCategory("keyboard", () => this._notifyChanged());
  }

  /**
   * @param {KeyboardEvent} e
   * @returns {void}
   */
  _dispatch(e) {
    if (e.defaultPrevented) return;
    const editable = isEditable(e.target);

    for (const [id, handlers] of this._bindings) {
      const definition = this._definitions.get(id);
      if (!definition || handlers.size === 0) continue;
      if (editable && !definition.allowInEditable) continue;
      if (!definition.combos.some((combo) => comboMatches(combo, e))) continue;
      if (!this.isEnabled(id)) continue;
      if (e.repeat && definition.combos.some((combo) => MODIFIER_KEYS.has(combo.key))) continue;

      for (const handler of [...handlers]) {
        let result;
        try {
          result = handler(e);
        } catch (error) {
          console.error(`[keyboardShortcuts] handler for "${id}" threw:`, error);
          continue;
        }
        if (result !== false) {
          e.preventDefault();
          return;
        }
      }
    }
  }

  /** @returns {void} */
  _notifyChanged() {
    for (const handler of [...this._subscribers]) {
      try {
        handler();
      } catch (error) {
        console.error("[keyboardShortcuts] subscriber threw:", error);
      }
    }
    eventBus.emit("keyboard:shortcutsChanged", Object.freeze({}));
  }
}

/**
 * @param {import("./shortcutCatalog.js").KeyCombo} combo
 * @param {KeyboardEvent} e
 * @returns {boolean}
 */
function comboMatches(combo, e) {
  if (combo.code) {
    if (e.code !== combo.code) return false;
  } else if (typeof e.key !== "string" || e.key.toLowerCase() !== combo.key.toLowerCase()) {
    return false;
  }
  if (combo.loose) return true;

  // A modifier key's own keydown reports its own flag as pressed.
  const selfModifier = combo.key && MODIFIER_KEYS.has(combo.key) ? combo.key : null;
  const metaPressed = e.metaKey && selfModifier !== "Meta";
  const ctrlPressed = e.ctrlKey && selfModifier !== "Control";
  const altPressed = e.altKey && selfModifier !== "Alt";
  const shiftPressed = e.shiftKey && selfModifier !== "Shift";

  // Ctrl+Alt is AltGr on many layouts: never steal typed characters.
  if (combo.ctrl && combo.alt && typeof e.getModifierState === "function" && e.getModifierState("AltGraph")) {
    return false;
  }

  if (combo.mod) {
    if (!(ctrlPressed || metaPressed)) return false;
  } else {
    if (Boolean(combo.ctrl) !== ctrlPressed) return false;
    if (metaPressed) return false;
  }
  if (Boolean(combo.alt) !== altPressed) return false;
  if (Boolean(combo.shift) !== shiftPressed) return false;
  return true;
}

/**
 * @param {import("./shortcutCatalog.js").KeyCombo} combo
 * @returns {string} e.g. "Ctrl + Alt + T"
 */
export function formatCombo(combo) {
  const parts = [];
  if (combo.mod) parts.push(IS_MAC ? "\u2318" : "Ctrl");
  if (combo.ctrl) parts.push("Ctrl");
  if (combo.alt) parts.push(IS_MAC ? "\u2325" : "Alt");
  if (combo.shift) parts.push("Shift");
  if (combo.code) {
    const generic = /^(?:Digit|Key)(.)$/.exec(combo.code);
    parts.push(CODE_LABELS[combo.code] ?? (generic ? generic[1] : combo.code));
  } else {
    parts.push(KEY_LABELS[combo.key] ?? (combo.key.length === 1 ? combo.key.toUpperCase() : combo.key));
  }
  return parts.join(" + ");
}

/**
 * @param {EventTarget|null} target
 * @returns {boolean}
 */
function isEditable(target) {
  if (!(target instanceof Element)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement) return !target.readOnly;
  if (target instanceof HTMLInputElement) {
    const nonText = ["checkbox", "radio", "range", "button", "submit", "reset", "color", "file", "image"];
    return !nonText.includes(target.type) && !target.readOnly;
  }
  return false;
}

/**
 * Singleton shortcut registry shared across the OS.
 * @type {KeyboardShortcuts}
 */
export const keyboardShortcuts = new KeyboardShortcuts();
