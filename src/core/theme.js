/**
 * @file Theme engine.
 *
 * Themes are applied by setting `data-theme` on <html>; the actual
 * color values live in styles/variables.css as `[data-theme="..."]`
 * blocks, so ThemeManager only ever deals with a theme's name, never
 * its colors directly.
 *
 * Only "dark" ships in this step. Light / Midnight / Glass /
 * Cyberpunk — and user-authored JSON themes — arrive with the
 * Themes step described in the project spec; declaring their names
 * here now without real variable blocks to back them would just be
 * a theme picker that lies about what it can do.
 */

import { eventBus } from "./eventBus.js";
import { storage } from "./storage.js";

const STORAGE_KEY = "theme";
const DEFAULT_THEME = "dark";
const AVAILABLE_THEMES = Object.freeze(["dark"]);

class ThemeManager {
  constructor() {
    this._current = storage.get(STORAGE_KEY, DEFAULT_THEME);
    if (!AVAILABLE_THEMES.includes(this._current)) {
      this._current = DEFAULT_THEME;
    }
  }

  /**
   * Apply the persisted (or default) theme to the document. Call
   * once during boot, before the desktop renders, to avoid a flash
   * of unstyled content.
   * @returns {void}
   */
  init() {
    this._applyToDocument(this._current);
  }

  /**
   * @returns {string} The active theme's name.
   */
  getCurrent() {
    return this._current;
  }

  /**
   * @returns {ReadonlyArray<string>} Names of installable themes.
   */
  getAvailable() {
    return AVAILABLE_THEMES;
  }

  /**
   * Switch the active theme, persist the choice, and notify
   * subscribers via "theme:changed".
   * @param {string} name
   * @returns {boolean} Whether the theme was found and applied.
   */
  setTheme(name) {
    if (!AVAILABLE_THEMES.includes(name)) {
      console.warn(`[ThemeManager] unknown theme "${name}"`);
      return false;
    }
    this._current = name;
    storage.set(STORAGE_KEY, name);
    this._applyToDocument(name);
    eventBus.emit("theme:changed", { theme: name });
    return true;
  }

  /**
   * @param {string} name
   * @returns {void}
   */
  _applyToDocument(name) {
    document.documentElement.setAttribute("data-theme", name);
  }
}

/**
 * Singleton theme manager shared across the OS.
 * @type {ThemeManager}
 */
export const themeManager = new ThemeManager();
