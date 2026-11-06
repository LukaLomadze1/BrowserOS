/**
 * @file Appearance settings page: theme, accent, effects, motion, and
 * reset.
 *
 * The page writes only to SettingsService and reads the *effective*
 * appearance (resolved system theme, effective reduced motion) from
 * ThemeManager's public API. It never touches <html>, CSS variables,
 * or any other component; every visual change happens because
 * ThemeManager reacts to the setting.
 *
 * All controls are built once and then kept in sync by `_sync()`,
 * which runs whenever an appearance setting changes (from this page,
 * a category reset, or anywhere else) and whenever the effective
 * appearance changes (e.g. the OS switches to dark mode while
 * "System" is selected). Nothing is re-rendered, so keyboard focus
 * survives every update.
 *
 * Page contract (see settingsCategories.js): constructor(context),
 * getElement(), destroy().
 */

import { createElement } from "../../../utils/dom.js";
import { eventBus } from "../../../core/eventBus.js";
import { settingsService } from "../../../core/settings/settingsService.js";
import { ACCENT_PRESETS, getAccentPreset } from "../../../core/settings/accentPresets.js";
import { themeManager } from "../../../core/theme.js";
import { showConfirmDialog } from "../../../components/dialog/confirmDialog.js";
import {
  uniqueId,
  createSection,
  createRowIds,
  createSettingRow,
  createChoiceGroup,
  createSegmentedControl,
  createToggle,
  createSlider,
  createResetButton,
} from "../settingsControls.js";

const KEYS = Object.freeze({
  theme: "appearance.theme",
  accent: "appearance.accentColor",
  transparency: "appearance.transparency",
  blur: "appearance.blurIntensity",
  radius: "appearance.windowRadius",
  speed: "appearance.animationSpeed",
  reducedMotion: "appearance.reducedMotion",
});

const THEME_OPTIONS = Object.freeze([
  { value: "dark", label: "Dark", hint: "Low-glare surfaces" },
  { value: "light", label: "Light", hint: "Bright, crisp surfaces" },
  { value: "system", label: "System", hint: "Matches your device" },
]);

const SPEED_OPTIONS = Object.freeze([
  { value: "fast", label: "Fast" },
  { value: "normal", label: "Normal" },
  { value: "slow", label: "Slow" },
]);

const REDUCED_MOTION_OPTIONS = Object.freeze([
  { value: "system", label: "System" },
  { value: "on", label: "On" },
  { value: "off", label: "Off" },
]);

const BLUR_DESCRIPTION = "How strongly glass surfaces blur what is behind them.";
const BLUR_DESCRIPTION_INACTIVE = "Applies while transparency is on. Your chosen value is kept.";

export default class AppearancePage {
  constructor() {
    this._destroyed = false;
    this._cleanups = [];
    /** @type {Array<{key: string, control: {setAvailable: (available: boolean) => void}}>} */
    this._resetButtons = [];
    /** @type {Array<{element: HTMLElement, theme: "dark"|"light"}>} */
    this._themePreviews = [];

    this._element = this._build();
    this._sync();

    // Values: any change to an appearance setting, including resets.
    this._cleanups.push(settingsService.subscribeCategory("appearance", () => this._sync()));
    // Effective state: changes that don't touch a setting at all, such
    // as the OS color scheme flipping while "System" is selected.
    this._cleanups.push(eventBus.on("appearance:changed", () => this._sync()));
  }

  /** @returns {HTMLElement} */
  getElement() {
    return this._element;
  }

  /**
   * Remove every subscription. Must be called when the page is
   * replaced or its window closes.
   * @returns {void}
   */
  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    for (const cleanup of this._cleanups) cleanup();
    this._cleanups = [];
  }

  // ---------------------------------------------------------------
  // Construction
  // ---------------------------------------------------------------

  /** @returns {HTMLElement} */
  _build() {
    return createElement("div", {
      className: "settings-page",
      children: [
        createElement("header", {
          className: "settings-page__header",
          children: [
            createElement("h1", { className: "settings-page__title", attrs: { tabindex: "-1" }, text: "Appearance" }),
            createElement("p", {
              className: "settings-page__intro",
              text: "Choose how BrowserOS looks and moves. Changes apply immediately and are saved automatically.",
            }),
          ],
        }),
        this._buildThemeSection(),
        this._buildAccentSection(),
        this._buildEffectsSection(),
        this._buildMotionSection(),
        this._buildResetSection(),
      ],
    });
  }

  /** @returns {HTMLElement} */
  _buildThemeSection() {
    const labelId = uniqueId("settings-theme-label");
    const statusId = uniqueId("settings-theme-status");

    this._themeGroup = createChoiceGroup({
      name: uniqueId("settings-theme"),
      labelledBy: labelId,
      describedBy: statusId,
      className: "settings-theme-grid",
      optionClassName: "settings-theme-card",
      options: THEME_OPTIONS.map((option) => ({
        value: option.value,
        content: createElement("span", {
          className: "settings-theme-card__content",
          children: [
            this._buildThemePreview(option.value),
            createElement("span", {
              className: "settings-theme-card__text",
              children: [
                createElement("span", { className: "settings-theme-card__name", text: option.label }),
                createElement("span", { className: "settings-theme-card__hint", text: option.hint }),
              ],
            }),
            createElement("span", { className: "settings-choice__check", attrs: { "aria-hidden": "true" }, text: "\u2713" }),
          ],
        }),
      })),
      onChange: (value) => settingsService.set(KEYS.theme, value),
    });

    this._themeModeValueEl = createElement("span", { className: "settings-status__value" });
    this._themeEffectiveValueEl = createElement("span", { className: "settings-status__value" });

    const reset = this._registerReset(KEYS.theme, "theme");

    return createSection({
      anchor: "theme",
      title: "Theme",
      description: "Pick a color scheme for the whole desktop.",
      headerAction: reset.element,
      children: [
        createElement("span", { className: "settings-visually-hidden", attrs: { id: labelId }, text: "Theme mode" }),
        this._themeGroup.element,
        createElement("p", {
          className: "settings-status",
          attrs: { id: statusId, "aria-live": "polite" },
          children: [
            createElement("span", { className: "settings-status__item", children: ["Selected mode: ", this._themeModeValueEl] }),
            createElement("span", { className: "settings-status__item", children: ["Effective theme: ", this._themeEffectiveValueEl] }),
          ],
        }),
      ],
    });
  }

  /**
   * A miniature desktop rendered with the real theme tokens: setting
   * data-theme on the preview re-scopes every variable inside it.
   * "System" shows both themes split diagonally.
   * @param {"dark"|"light"|"system"} mode
   * @returns {HTMLElement}
   */
  _buildThemePreview(mode) {
    const themes = mode === "system" ? ["dark", "light"] : [mode];
    const panes = themes.map((theme) => {
      const pane = createElement("span", {
        className: `settings-theme-preview__pane settings-theme-preview__pane--${theme}`,
        attrs: { "data-theme": theme },
        children: [
          createElement("span", {
            className: "settings-theme-preview__window",
            children: [
              createElement("span", { className: "settings-theme-preview__titlebar" }),
              createElement("span", { className: "settings-theme-preview__line settings-theme-preview__line--accent" }),
              createElement("span", { className: "settings-theme-preview__line" }),
              createElement("span", { className: "settings-theme-preview__line settings-theme-preview__line--short" }),
            ],
          }),
          createElement("span", { className: "settings-theme-preview__taskbar" }),
        ],
      });
      this._themePreviews.push({ element: pane, theme });
      return pane;
    });

    return createElement("span", {
      className: `settings-theme-preview settings-theme-preview--${mode}`,
      attrs: { "aria-hidden": "true" },
      children: panes,
    });
  }

  /** @returns {HTMLElement} */
  _buildAccentSection() {
    const labelId = uniqueId("settings-accent-label");

    this._accentGroup = createChoiceGroup({
      name: uniqueId("settings-accent"),
      labelledBy: labelId,
      className: "settings-accent-grid",
      optionClassName: "settings-accent-option",
      options: ACCENT_PRESETS.map((preset) => {
        const swatch = createElement("span", {
          className: "settings-accent-option__swatch",
          attrs: { "aria-hidden": "true" },
          children: [createElement("span", { className: "settings-choice__check", text: "\u2713" })],
        });
        // Both variants are attached so the swatch matches the active
        // theme purely through CSS, with no re-render on theme change.
        swatch.style.setProperty("--swatch-dark-primary", preset.dark.primary);
        swatch.style.setProperty("--swatch-dark-secondary", preset.dark.secondary);
        swatch.style.setProperty("--swatch-light-primary", preset.light.primary);
        swatch.style.setProperty("--swatch-light-secondary", preset.light.secondary);
        swatch.style.setProperty("--swatch-dark-on", preset.dark.onAccent);
        swatch.style.setProperty("--swatch-light-on", preset.light.onAccent);

        return {
          value: preset.id,
          content: createElement("span", {
            className: "settings-accent-option__content",
            children: [swatch, createElement("span", { className: "settings-accent-option__name", text: preset.label })],
          }),
        };
      }),
      onChange: (value) => settingsService.set(KEYS.accent, value),
    });

    const reset = this._registerReset(KEYS.accent, "accent color");

    return createSection({
      anchor: "accent",
      title: "Accent",
      description: "Used for buttons, focus rings, selections, the Start button, and active window outlines.",
      headerAction: reset.element,
      children: [
        createElement("span", { className: "settings-visually-hidden", attrs: { id: labelId }, text: "Accent color" }),
        this._accentGroup.element,
      ],
    });
  }

  /** @returns {HTMLElement} */
  _buildEffectsSection() {
    // Transparency
    const transparencyIds = createRowIds("transparency");
    this._transparencyToggle = createToggle({
      id: transparencyIds.controlId,
      labelledBy: transparencyIds.labelId,
      describedBy: transparencyIds.descriptionId,
      onChange: (checked) => settingsService.set(KEYS.transparency, checked),
    });
    const transparencyRow = createSettingRow({
      ids: transparencyIds,
      label: "Transparency",
      description: "Translucent glass for windows, the taskbar, menus, and dialogs. Turn off for solid surfaces.",
      control: this._transparencyToggle.element,
      reset: this._registerReset(KEYS.transparency, "transparency").element,
    });

    // Blur
    const blurIds = createRowIds("blur");
    const blurDescriptor = settingsService.getDescriptor(KEYS.blur);
    this._blurSlider = createSlider({
      id: blurIds.controlId,
      min: blurDescriptor.min,
      max: blurDescriptor.max,
      unit: "px",
      unitLabel: "pixels",
      labelledBy: blurIds.labelId,
      describedBy: blurIds.descriptionId,
      onInput: (value) => settingsService.set(KEYS.blur, value),
    });
    this._blurRow = createSettingRow({
      ids: blurIds,
      label: "Blur intensity",
      description: BLUR_DESCRIPTION,
      control: this._blurSlider.element,
      reset: this._registerReset(KEYS.blur, "blur intensity").element,
      layout: "stacked",
    });

    // Corner radius
    const radiusIds = createRowIds("radius");
    const radiusDescriptor = settingsService.getDescriptor(KEYS.radius);
    this._radiusSlider = createSlider({
      id: radiusIds.controlId,
      min: radiusDescriptor.min,
      max: radiusDescriptor.max,
      unit: "px",
      unitLabel: "pixels",
      labelledBy: radiusIds.labelId,
      describedBy: radiusIds.descriptionId,
      onInput: (value) => settingsService.set(KEYS.radius, value),
    });
    const radiusRow = createSettingRow({
      ids: radiusIds,
      label: "Window corner radius",
      description: "Rounding for window corners. The Start Menu and dialogs scale with it; maximized windows stay square.",
      control: this._radiusSlider.element,
      reset: this._registerReset(KEYS.radius, "window corner radius").element,
      layout: "stacked",
    });

    return createSection({
      anchor: "effects",
      title: "Effects",
      description: "Glass, blur, and window shape.",
      children: [transparencyRow.element, this._blurRow.element, radiusRow.element],
    });
  }

  /** @returns {HTMLElement} */
  _buildMotionSection() {
    // Animation speed + live preview
    const speedIds = createRowIds("speed");
    this._speedGroup = createSegmentedControl({
      name: uniqueId("settings-speed"),
      labelledBy: speedIds.labelId,
      describedBy: speedIds.descriptionId,
      options: SPEED_OPTIONS,
      onChange: (value) => {
        settingsService.set(KEYS.speed, value);
        this._playMotionPreview();
      },
    });
    const speedRow = createSettingRow({
      ids: speedIds,
      label: "Animation speed",
      description: "Timing for window, Start Menu, menu, and dialog transitions.",
      control: this._speedGroup.element,
      reset: this._registerReset(KEYS.speed, "animation speed").element,
    });

    this._previewKnobEl = createElement("span", { className: "settings-motion-preview__knob" });
    this._previewNoteEl = createElement("span", { className: "settings-motion-preview__note" });
    const preview = createElement("div", {
      className: "settings-motion-preview",
      children: [
        createElement("span", {
          className: "settings-motion-preview__track",
          attrs: { "aria-hidden": "true" },
          children: [this._previewKnobEl],
        }),
        createElement("button", {
          className: "settings-button",
          attrs: { type: "button" },
          text: "Play preview",
          on: { click: () => this._playMotionPreview() },
        }),
        this._previewNoteEl,
      ],
    });

    // Reduced motion
    const reducedIds = createRowIds("reduced-motion");
    const reducedStatusId = uniqueId("settings-reduced-motion-status");
    this._reducedMotionGroup = createSegmentedControl({
      name: uniqueId("settings-reduced-motion"),
      labelledBy: reducedIds.labelId,
      describedBy: `${reducedIds.descriptionId} ${reducedStatusId}`,
      options: REDUCED_MOTION_OPTIONS,
      onChange: (value) => settingsService.set(KEYS.reducedMotion, value),
    });
    const reducedRow = createSettingRow({
      ids: reducedIds,
      label: "Reduced motion",
      description:
        "Makes transitions instant instead of animated. System follows your device's accessibility setting; On and Off override it.",
      control: this._reducedMotionGroup.element,
      reset: this._registerReset(KEYS.reducedMotion, "reduced motion").element,
    });

    this._reducedPreferenceValueEl = createElement("span", { className: "settings-status__value" });
    this._reducedEffectiveValueEl = createElement("span", { className: "settings-status__value" });
    const reducedStatus = createElement("p", {
      className: "settings-status",
      attrs: { id: reducedStatusId, "aria-live": "polite" },
      children: [
        createElement("span", { className: "settings-status__item", children: ["Preference: ", this._reducedPreferenceValueEl] }),
        createElement("span", {
          className: "settings-status__item",
          children: ["Effective behavior: ", this._reducedEffectiveValueEl],
        }),
      ],
    });

    return createSection({
      anchor: "motion",
      title: "Motion",
      description: "How quickly things animate, or whether they animate at all.",
      children: [speedRow.element, preview, reducedRow.element, reducedStatus],
    });
  }

  /** @returns {HTMLElement} */
  _buildResetSection() {
    const button = createElement("button", {
      className: "settings-button settings-button--danger",
      attrs: { type: "button" },
      text: "Reset appearance settings",
      on: { click: () => this._confirmCategoryReset() },
    });

    return createSection({
      anchor: "reset",
      title: "Reset",
      description: "Restore every appearance setting on this page to its default value.",
      children: [createElement("div", { className: "settings-section__actions", children: [button] })],
    });
  }

  /**
   * @param {string} key
   * @param {string} settingLabel
   * @returns {{element: HTMLElement, setAvailable: (available: boolean) => void}}
   */
  _registerReset(key, settingLabel) {
    const control = createResetButton({ settingLabel, onReset: () => settingsService.reset(key) });
    this._resetButtons.push({ key, control });
    return control;
  }

  // ---------------------------------------------------------------
  // Behavior
  // ---------------------------------------------------------------

  /**
   * Push current settings and effective appearance into every control.
   * @returns {void}
   */
  _sync() {
    if (this._destroyed) return;
    const values = settingsService.getCategory("appearance");
    const state = themeManager.getAppearanceState();

    this._themeGroup.setValue(values[KEYS.theme]);
    this._themeModeValueEl.textContent = capitalize(values[KEYS.theme]);
    this._themeEffectiveValueEl.textContent =
      values[KEYS.theme] === "system"
        ? `${capitalize(state.effectiveTheme)} (following your device)`
        : capitalize(state.effectiveTheme);

    this._accentGroup.setValue(values[KEYS.accent]);
    const accent = getAccentPreset(values[KEYS.accent]);
    for (const { element, theme } of this._themePreviews) {
      element.style.setProperty("--color-accent-primary", accent[theme].primary);
      element.style.setProperty("--color-accent-secondary", accent[theme].secondary);
    }

    const transparency = values[KEYS.transparency];
    this._transparencyToggle.setChecked(transparency);
    this._blurSlider.setValue(values[KEYS.blur]);
    this._blurSlider.setDisabled(!transparency);
    this._blurRow.setMuted(!transparency);
    this._blurRow.setDescription(transparency ? BLUR_DESCRIPTION : BLUR_DESCRIPTION_INACTIVE);
    this._radiusSlider.setValue(values[KEYS.radius]);

    this._speedGroup.setValue(values[KEYS.speed]);
    this._reducedMotionGroup.setValue(values[KEYS.reducedMotion]);
    this._reducedPreferenceValueEl.textContent = describeReducedMotionPreference(state);
    this._reducedEffectiveValueEl.textContent = state.reducedMotionEffective ? "Reduced motion on" : "Reduced motion off";
    this._previewNoteEl.textContent = state.reducedMotionEffective
      ? "Reduced motion is on, so the preview moves instantly."
      : `Showing the ${values[KEYS.speed]} speed.`;

    for (const { key, control } of this._resetButtons) {
      control.setAvailable(!settingsService.isDefault(key));
    }
  }

  /**
   * Slide the preview knob to the other end of its track using the
   * shared --duration-slow token, so it demonstrates the current speed
   * and becomes instant under reduced motion.
   * @returns {void}
   */
  _playMotionPreview() {
    this._previewKnobEl.classList.toggle("settings-motion-preview__knob--end");
  }

  /** @returns {Promise<void>} */
  async _confirmCategoryReset() {
    const confirmed = await showConfirmDialog({
      title: "Reset appearance settings?",
      message:
        "Theme, accent, transparency, blur, corner radius, animation speed, and reduced motion will return to their defaults.",
      confirmLabel: "Reset",
      cancelLabel: "Cancel",
      destructive: true,
    });
    if (!confirmed || this._destroyed) return;
    settingsService.resetCategory("appearance");
  }
}

/**
 * @param {import("../../../core/theme.js").AppearanceState} state
 * @returns {string}
 */
function describeReducedMotionPreference(state) {
  if (state.reducedMotion !== "system") return capitalize(state.reducedMotion);
  if (state.systemPrefersReducedMotion === null) return "System (device setting unavailable)";
  return `System (device ${state.systemPrefersReducedMotion ? "requests reduced motion" : "has no preference"})`;
}

/**
 * @param {string} value
 * @returns {string}
 */
function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
