/**
 * @file Curated accent palettes.
 *
 * An accent is never a single raw color. Each preset is a complete,
 * hand-tuned definition with one variant per effective theme, because
 * a color that reads well on a dark glass surface is usually too light
 * for text and borders on a light one (and vice versa).
 *
 * Every variant supplies the four base tokens ThemeManager writes to
 * <html>:
 *
 *   primary       → --color-accent-primary
 *   primaryStrong → --color-accent-primary-strong
 *   secondary     → --color-accent-secondary
 *   onAccent      → --color-text-on-accent
 *
 * The remaining accent tokens (gradient, focus ring, selection tint,
 * hover tint, wallpaper glows, terminal prompt) are derived from
 * those four in styles/variables.css, so a preset can never produce a
 * half-applied or mismatched combination.
 *
 * Presets are frozen; the settings schema derives its allowed values
 * from ACCENT_IDS, so adding a preset here is the only change needed
 * to offer a new accent.
 */

/**
 * @typedef {object} AccentVariant
 * @property {string} primary
 * @property {string} primaryStrong
 * @property {string} secondary
 * @property {string} onAccent - Text color placed on top of the accent gradient.
 */

/**
 * @typedef {object} AccentPreset
 * @property {string} id
 * @property {string} label
 * @property {AccentVariant} dark
 * @property {AccentVariant} light
 */

/** @type {ReadonlyArray<AccentPreset>} */
export const ACCENT_PRESETS = deepFreeze([
  {
    id: "violet",
    label: "Violet",
    dark: { primary: "#7c6cf6", primaryStrong: "#9d8bff", secondary: "#34e2c6", onAccent: "#0a0c12" },
    light: { primary: "#5b48d9", primaryStrong: "#4a37c2", secondary: "#0f8a78", onAccent: "#ffffff" },
  },
  {
    id: "blue",
    label: "Blue",
    dark: { primary: "#4f8ff7", primaryStrong: "#7aaeff", secondary: "#4fd1ff", onAccent: "#0a0c12" },
    light: { primary: "#2563eb", primaryStrong: "#1d4fc4", secondary: "#0e7490", onAccent: "#ffffff" },
  },
  {
    id: "cyan",
    label: "Cyan",
    dark: { primary: "#22c7e0", primaryStrong: "#5fdcef", secondary: "#8b9dff", onAccent: "#0a0c12" },
    light: { primary: "#0e7490", primaryStrong: "#155e75", secondary: "#4651c9", onAccent: "#ffffff" },
  },
  {
    id: "green",
    label: "Green",
    dark: { primary: "#34d399", primaryStrong: "#6ee7b7", secondary: "#a3e635", onAccent: "#0a0c12" },
    light: { primary: "#047857", primaryStrong: "#065f46", secondary: "#4d7c0f", onAccent: "#ffffff" },
  },
  {
    id: "orange",
    label: "Orange",
    dark: { primary: "#f59e42", primaryStrong: "#fbbf6c", secondary: "#f472b6", onAccent: "#0a0c12" },
    light: { primary: "#c2410c", primaryStrong: "#9a3412", secondary: "#be185d", onAccent: "#ffffff" },
  },
  {
    id: "rose",
    label: "Rose",
    dark: { primary: "#f2607e", primaryStrong: "#ff8aa2", secondary: "#c084fc", onAccent: "#0a0c12" },
    light: { primary: "#e11d48", primaryStrong: "#be123c", secondary: "#9333ea", onAccent: "#ffffff" },
  },
]);

/** @type {ReadonlyArray<string>} */
export const ACCENT_IDS = Object.freeze(ACCENT_PRESETS.map((preset) => preset.id));

/** Id of the accent BrowserOS ships with; also the fallback for unknown ids. */
export const DEFAULT_ACCENT_ID = "violet";

/**
 * @param {string} id
 * @returns {AccentPreset} The matching preset, or the default preset for an unknown id.
 */
export function getAccentPreset(id) {
  return (
    ACCENT_PRESETS.find((preset) => preset.id === id) ??
    ACCENT_PRESETS.find((preset) => preset.id === DEFAULT_ACCENT_ID)
  );
}

/**
 * @template T
 * @param {T} value
 * @returns {T}
 */
function deepFreeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}
