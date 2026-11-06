/**
 * @file First-paint theme hint.
 *
 * Loaded as a classic, render-blocking <script> in <head>, before any
 * stylesheet-dependent content paints. ES modules (src/main.js) are
 * deferred, so without this the page would paint once with the
 * default dark tokens and then switch, a visible flash for anyone
 * using the light or system theme.
 *
 * This script is deliberately not a second source of truth: it only
 * sets `data-theme` on <html> from the stored *selected* mode, and
 * stores nothing. Once boot runs, SettingsService validates the stored
 * document and ThemeManager re-applies the full appearance, replacing
 * whatever was set here.
 *
 * It must stay dependency-free and must never throw. The storage keys
 * mirror SETTINGS_STORAGE_KEY in settingsService.js and the legacy
 * ThemeManager key handled by settingsMigrations.js, both namespaced
 * by StorageService as "browseros:<key>".
 */
(function applyFirstPaintTheme() {
  var root = document.documentElement;
  try {
    var mode = null;
    var stored = window.localStorage.getItem("browseros:settings");
    if (stored) {
      var parsed = JSON.parse(stored);
      mode = parsed && parsed.values ? parsed.values["appearance.theme"] : null;
    } else {
      var legacy = window.localStorage.getItem("browseros:theme");
      mode = legacy ? JSON.parse(legacy) : null;
    }

    var effective = "dark";
    if (mode === "light") {
      effective = "light";
    } else if (mode === "system" && typeof window.matchMedia === "function") {
      effective = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
    root.setAttribute("data-theme", effective);
  } catch (error) {
    root.setAttribute("data-theme", "dark");
  }
})();
