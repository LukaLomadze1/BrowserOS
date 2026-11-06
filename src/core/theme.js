/**
 * @file ThemeManager — the bridge between appearance settings and the
 * document.
 *
 * Ownership:
 *  - SettingsService owns every *selected* appearance value
 *    ("appearance.theme" = "system", "appearance.accentColor" = "blue", …).
 *    ThemeManager stores none of them and persists nothing.
 *  - ThemeManager owns the *effective* appearance: it resolves "system"
 *    theme and reduced-motion preferences against the browser's media
 *    queries and writes the result to <html>. It is the only module that
 *    changes the attributes and custom properties below.
 *
 * Selected vs effective: with "appearance.theme" set to "system", the
 * selected mode stays "system" forever; the effective theme is "dark" or
 * "light" depending on `prefers-color-scheme` and changes live when the
 * OS preference changes. The same distinction applies to reduced motion.
 *
 * Written to <html>:
 *   data-theme          effective theme ("dark" | "light")
 *   data-theme-mode     selected mode   ("dark" | "light" | "system")
 *   data-accent         accent preset id
 *   data-transparency   "on" | "off"
 *   data-motion-speed   "fast" | "normal" | "slow"
 *   data-reduced-motion effective state ("on" | "off")
 *   data-wallpaper      wallpaper preset id (wallpaper.preset)
 *   --color-accent-primary / -primary-strong / -secondary, --color-text-on-accent
 *   --blur-glass-level, --window-radius, --wallpaper-dim
 *
 * Everything else (light-theme colors, opaque surfaces, motion-duration
 * scales, derived accent tokens, wallpaper visuals) is plain CSS in
 * styles/variables.css and styles/wallpapers.css,
 * keyed off those attributes, so components restyle themselves without
 * being touched individually.
 *
 * Events (EventBus), emitted only when the effective result changes,
 * and never for the initial application during boot:
 *  - "appearance:changed"      { state, previousState, changed }
 *  - "appearance:themeChanged" { mode, effectiveTheme, previousMode, previousEffectiveTheme }
 *  - "appearance:accentChanged"{ accentColor, previousAccentColor }
 *  - "appearance:motionChanged"{ animationSpeed, reducedMotion, reducedMotionEffective,
 *                                previousAnimationSpeed, previousReducedMotion,
 *                                previousReducedMotionEffective }
 *  - "appearance:wallpaperChanged" { wallpaper, dim, previousWallpaper, previousDim }
 *  - "theme:changed"           { theme }  — effective theme only; kept for
 *                                existing subscribers.
 */

import { eventBus } from "./eventBus.js";
import { settingsService } from "./settings/settingsService.js";
import { getAccentPreset } from "./settings/accentPresets.js";

/** Themes that have real variable blocks in styles/variables.css. */
const EFFECTIVE_THEMES = Object.freeze(["dark", "light"]);
const FALLBACK_THEME = "dark";

/**
 * @typedef {object} AppearanceState
 * @property {"dark"|"light"|"system"} themeMode - Selected mode.
 * @property {"dark"|"light"} effectiveTheme - Theme actually applied.
 * @property {"dark"|"light"|null} systemTheme - OS preference, or null if the browser can't report it.
 * @property {string} accentColor
 * @property {boolean} transparency
 * @property {number} blurIntensity
 * @property {number} windowRadius
 * @property {"fast"|"normal"|"slow"} animationSpeed
 * @property {"system"|"on"|"off"} reducedMotion - Selected preference.
 * @property {boolean} reducedMotionEffective - Whether reduced motion is actually applied.
 * @property {boolean|null} systemPrefersReducedMotion - OS preference, or null if unavailable.
 * @property {string} wallpaper - Wallpaper preset id.
 * @property {number} wallpaperDim - Wallpaper dimming percentage.
 */

class ThemeManager {
  constructor() {
    this._initialized = false;
    /** @type {AppearanceState|null} */
    this._state = null;
    /** @type {MediaQueryList|null} */
    this._colorSchemeQuery = null;
    /** @type {MediaQueryList|null} */
    this._reducedMotionQuery = null;
    this._listeningToColorScheme = false;
    this._listeningToReducedMotion = false;
    /** @type {Array<() => void>} */
    this._unsubscribeSettings = [];

    // Stable references so the same function can be removed later.
    this._handleSystemChange = () => this._apply();
  }

  /**
   * Apply the current appearance settings to the document and start
   * reacting to changes. Call once during boot, after
   * settingsService.init() and before the desktop renders.
   * @returns {void}
   */
  init() {
    if (this._initialized) return;
    this._initialized = true;

    settingsService.init();
    this._colorSchemeQuery = safeMatchMedia("(prefers-color-scheme: dark)");
    this._reducedMotionQuery = safeMatchMedia("(prefers-reduced-motion: reduce)");

    // One notification per batch, so a category reset re-applies once.
    this._unsubscribeSettings = [
      settingsService.subscribeCategory("appearance", () => this._apply()),
      settingsService.subscribeCategory("wallpaper", () => this._apply()),
    ];
    this._apply({ initial: true });
  }

  /**
   * @returns {"dark"|"light"} The effective (applied) theme.
   */
  getCurrent() {
    return this._state?.effectiveTheme ?? FALLBACK_THEME;
  }

  /**
   * @returns {"dark"|"light"|"system"} The selected theme mode.
   */
  getMode() {
    return settingsService.get("appearance.theme");
  }

  /**
   * @returns {ReadonlyArray<string>} Names of the concrete themes BrowserOS can apply.
   */
  getAvailable() {
    return EFFECTIVE_THEMES;
  }

  /**
   * Select a theme mode. Delegates to SettingsService, which validates,
   * persists, and notifies; this manager then re-applies through its
   * subscription like for any other appearance change.
   * @param {"dark"|"light"|"system"} mode
   * @returns {boolean} Whether the mode was accepted.
   */
  setTheme(mode) {
    return settingsService.set("appearance.theme", mode);
  }

  /**
   * @returns {Readonly<AppearanceState>} Snapshot of the currently applied appearance.
   */
  getAppearanceState() {
    if (!this._state) this.init();
    return this._state;
  }

  /**
   * @returns {boolean} Whether reduced motion is currently in effect.
   */
  isReducedMotion() {
    return this._state?.reducedMotionEffective ?? false;
  }

  /**
   * Stop reacting to settings and media-query changes. Intended for
   * tests and teardown; the last applied appearance stays on <html>.
   * @returns {void}
   */
  destroy() {
    for (const unsubscribe of this._unsubscribeSettings) unsubscribe();
    this._unsubscribeSettings = [];
    this._setMediaListener(this._colorSchemeQuery, false, "_listeningToColorScheme");
    this._setMediaListener(this._reducedMotionQuery, false, "_listeningToReducedMotion");
    this._initialized = false;
  }

  // ---------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------

  /**
   * Resolve, write, and announce the appearance.
   * @param {{initial?: boolean}} [options]
   * @returns {void}
   */
  _apply({ initial = false } = {}) {
    let next;
    try {
      next = this._resolveState({
        ...settingsService.getCategory("appearance"),
        ...settingsService.getCategory("wallpaper"),
      });
      this._writeToDocument(next);
    } catch (error) {
      console.error("[ThemeManager] failed to apply appearance; falling back to the default theme.", error);
      try {
        document.documentElement.setAttribute("data-theme", FALLBACK_THEME);
      } catch {
        // Nothing further can be done without a document.
      }
      return;
    }

    this._syncMediaListeners(next);

    const previous = this._state;
    this._state = next;
    if (!initial && previous) {
      this._emitChanges(previous, next);
    }
  }

  /**
   * @param {Readonly<Record<string, *>>} values - The appearance and wallpaper categories, merged.
   * @returns {Readonly<AppearanceState>}
   */
  _resolveState(values) {
    const themeMode = values["appearance.theme"];
    const systemTheme = this._colorSchemeQuery ? (this._colorSchemeQuery.matches ? "dark" : "light") : null;
    const effectiveTheme = themeMode === "system" ? systemTheme ?? FALLBACK_THEME : themeMode;

    const reducedMotion = values["appearance.reducedMotion"];
    const systemPrefersReducedMotion = this._reducedMotionQuery ? this._reducedMotionQuery.matches : null;
    const reducedMotionEffective =
      reducedMotion === "on" || (reducedMotion === "system" && systemPrefersReducedMotion === true);

    return Object.freeze({
      themeMode,
      effectiveTheme: EFFECTIVE_THEMES.includes(effectiveTheme) ? effectiveTheme : FALLBACK_THEME,
      systemTheme,
      accentColor: values["appearance.accentColor"],
      transparency: values["appearance.transparency"],
      blurIntensity: values["appearance.blurIntensity"],
      windowRadius: values["appearance.windowRadius"],
      animationSpeed: values["appearance.animationSpeed"],
      reducedMotion,
      reducedMotionEffective,
      systemPrefersReducedMotion,
      wallpaper: values["wallpaper.preset"],
      wallpaperDim: values["wallpaper.dim"],
    });
  }

  /**
   * @param {Readonly<AppearanceState>} state
   * @returns {void}
   */
  _writeToDocument(state) {
    const root = document.documentElement;
    const accent = getAccentPreset(state.accentColor)[state.effectiveTheme];

    root.setAttribute("data-theme", state.effectiveTheme);
    root.setAttribute("data-theme-mode", state.themeMode);
    root.setAttribute("data-accent", state.accentColor);
    root.setAttribute("data-transparency", state.transparency ? "on" : "off");
    root.setAttribute("data-motion-speed", state.animationSpeed);
    root.setAttribute("data-reduced-motion", state.reducedMotionEffective ? "on" : "off");
    root.setAttribute("data-wallpaper", state.wallpaper);

    root.style.setProperty("--color-accent-primary", accent.primary);
    root.style.setProperty("--color-accent-primary-strong", accent.primaryStrong);
    root.style.setProperty("--color-accent-secondary", accent.secondary);
    root.style.setProperty("--color-text-on-accent", accent.onAccent);
    // Values are schema-validated integers; clamping again here keeps
    // the CSS valid even if this method is ever fed unvalidated input.
    root.style.setProperty("--blur-glass-level", `${clampInt(state.blurIntensity, 0, 40)}px`);
    root.style.setProperty("--window-radius", `${clampInt(state.windowRadius, 0, 24)}px`);
    root.style.setProperty("--wallpaper-dim", String(clampInt(state.wallpaperDim, 0, 60) / 100));
  }

  /**
   * Listen to OS preference changes only while a "system" option is
   * selected, so switching to an explicit value stops the reactions.
   * Each listener is attached at most once.
   * @param {Readonly<AppearanceState>} state
   * @returns {void}
   */
  _syncMediaListeners(state) {
    this._setMediaListener(this._colorSchemeQuery, state.themeMode === "system", "_listeningToColorScheme");
    this._setMediaListener(this._reducedMotionQuery, state.reducedMotion === "system", "_listeningToReducedMotion");
  }

  /**
   * @param {MediaQueryList|null} query
   * @param {boolean} shouldListen
   * @param {"_listeningToColorScheme"|"_listeningToReducedMotion"} flag
   * @returns {void}
   */
  _setMediaListener(query, shouldListen, flag) {
    if (!query || this[flag] === shouldListen) return;
    const method = shouldListen ? "add" : "remove";
    if (typeof query[`${method}EventListener`] === "function") {
      query[`${method}EventListener`]("change", this._handleSystemChange);
    } else if (typeof query[`${method}Listener`] === "function") {
      // Safari < 14 only supports the deprecated MediaQueryList API.
      query[`${method}Listener`](this._handleSystemChange);
    }
    this[flag] = shouldListen;
  }

  /**
   * @param {Readonly<AppearanceState>} previous
   * @param {Readonly<AppearanceState>} next
   * @returns {void}
   */
  _emitChanges(previous, next) {
    const changed = Object.freeze(Object.keys(next).filter((key) => next[key] !== previous[key]));
    if (changed.length === 0) return;

    if (previous.themeMode !== next.themeMode || previous.effectiveTheme !== next.effectiveTheme) {
      eventBus.emit(
        "appearance:themeChanged",
        Object.freeze({
          mode: next.themeMode,
          effectiveTheme: next.effectiveTheme,
          previousMode: previous.themeMode,
          previousEffectiveTheme: previous.effectiveTheme,
        })
      );
      if (previous.effectiveTheme !== next.effectiveTheme) {
        eventBus.emit("theme:changed", Object.freeze({ theme: next.effectiveTheme }));
      }
    }

    if (previous.accentColor !== next.accentColor) {
      eventBus.emit(
        "appearance:accentChanged",
        Object.freeze({ accentColor: next.accentColor, previousAccentColor: previous.accentColor })
      );
    }

    if (
      previous.animationSpeed !== next.animationSpeed ||
      previous.reducedMotion !== next.reducedMotion ||
      previous.reducedMotionEffective !== next.reducedMotionEffective
    ) {
      eventBus.emit(
        "appearance:motionChanged",
        Object.freeze({
          animationSpeed: next.animationSpeed,
          reducedMotion: next.reducedMotion,
          reducedMotionEffective: next.reducedMotionEffective,
          previousAnimationSpeed: previous.animationSpeed,
          previousReducedMotion: previous.reducedMotion,
          previousReducedMotionEffective: previous.reducedMotionEffective,
        })
      );
    }

    if (previous.wallpaper !== next.wallpaper || previous.wallpaperDim !== next.wallpaperDim) {
      eventBus.emit(
        "appearance:wallpaperChanged",
        Object.freeze({
          wallpaper: next.wallpaper,
          dim: next.wallpaperDim,
          previousWallpaper: previous.wallpaper,
          previousDim: previous.wallpaperDim,
        })
      );
    }

    eventBus.emit("appearance:changed", Object.freeze({ state: next, previousState: previous, changed }));
  }
}

/**
 * @param {string} query
 * @returns {MediaQueryList|null} Null when matchMedia is unavailable or rejects the query.
 */
function safeMatchMedia(query) {
  try {
    return typeof window.matchMedia === "function" ? window.matchMedia(query) : null;
  } catch (error) {
    console.warn(`[ThemeManager] matchMedia("${query}") is unavailable:`, error);
    return null;
  }
}

/**
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clampInt(value, min, max) {
  const number = Number.isFinite(value) ? Math.round(value) : min;
  return Math.min(max, Math.max(min, number));
}

/**
 * Singleton theme manager shared across the OS.
 * @type {ThemeManager}
 */
export const themeManager = new ThemeManager();
