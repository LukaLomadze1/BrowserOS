/**
 * @file QuickSettings — the tray panel with the most-used system
 * preferences.
 *
 * Every control reads and writes SettingsService directly — Quick
 * Settings stores nothing itself — and re-syncs whenever those settings
 * change anywhere (Settings windows, keyboard shortcuts, resets), so all
 * views of a preference always agree.
 *
 * Controls: Do Not Disturb, notification sounds, notification previews,
 * transparency, reduced motion, theme, accent color, blur, and
 * animation speed, plus links to the related Settings pages.
 */

import { createElement } from "../../utils/dom.js";
import { createIconElement } from "../../utils/icons.js";
import { settingsService } from "../../core/settings/settingsService.js";
import { ACCENT_PRESETS } from "../../core/settings/accentPresets.js";
import { eventBus } from "../../core/eventBus.js";

const THEME_OPTIONS = Object.freeze([
  { value: "dark", label: "Dark", icon: "icon:moon" },
  { value: "light", label: "Light", icon: "icon:sun" },
  { value: "system", label: "System", icon: "icon:display" },
]);
const SPEED_OPTIONS = Object.freeze([
  { value: "fast", label: "Fast" },
  { value: "normal", label: "Normal" },
  { value: "slow", label: "Slow" },
]);

let instanceCounter = 0;

export class QuickSettings {
  /**
   * @param {object} deps
   * @param {(page: string, anchor?: string) => void} deps.openSettings
   * @param {() => void} deps.requestClose
   */
  constructor({ openSettings, requestClose }) {
    this._openSettings = openSettings;
    this._requestClose = requestClose;
    this._uid = `qs-${++instanceCounter}`;
    this._cleanups = [];
    this._syncers = [];

    const tiles = createElement("div", {
      className: "quick-settings__tiles",
      children: [
        this._tile({
          icon: "icon:bell-off",
          label: "Do Not Disturb",
          isOn: () => settingsService.get("notifications.doNotDisturb"),
          detail: (on) => (on ? "On \u2014 banners hidden" : "Off"),
          toggle: (on) => settingsService.set("notifications.doNotDisturb", !on),
        }),
        this._tile({
          icon: "icon:speaker",
          label: "Sounds",
          isOn: () => settingsService.get("notifications.sounds"),
          detail: (on) => (on ? "Notification sounds on" : "Muted"),
          toggle: (on) => settingsService.set("notifications.sounds", !on),
        }),
        this._tile({
          icon: "icon:eye",
          label: "Previews",
          isOn: () => settingsService.get("notifications.showPreviews"),
          detail: (on) => (on ? "Message text in banners" : "Titles only"),
          toggle: (on) => settingsService.set("notifications.showPreviews", !on),
        }),
        this._tile({
          icon: "icon:layers",
          label: "Transparency",
          isOn: () => settingsService.get("appearance.transparency"),
          detail: (on) => (on ? "Glass effects on" : "Solid surfaces"),
          toggle: (on) => settingsService.set("appearance.transparency", !on),
        }),
        this._tile({
          icon: "icon:motion",
          label: "Reduce motion",
          isOn: () => document.documentElement.dataset.reducedMotion === "on",
          detail: (on) => {
            const selected = settingsService.get("appearance.reducedMotion");
            if (selected === "system") return on ? "On (system)" : "Off (system)";
            return on ? "On" : "Off";
          },
          toggle: (on) => settingsService.set("appearance.reducedMotion", on ? "off" : "on"),
        }),
      ],
    });

    this._el = createElement("div", {
      className: "quick-settings",
      children: [
        createElement("header", {
          className: "shell-panel__header",
          children: [
            createElement("h2", { className: "shell-panel__title", text: "Quick Settings" }),
            createElement("button", {
              className: "shell-icon-button",
              attrs: { type: "button", "aria-label": "Open Settings", title: "All settings" },
              children: [createIconElement("icon:gear")],
              on: { click: () => this._goToSettings("appearance") },
            }),
          ],
        }),
        tiles,
        this._section("Theme", this._themeControl()),
        this._section("Accent color", this._accentControl()),
        this._blurControl(),
        this._section("Animation speed", this._speedControl()),
        createElement("nav", {
          className: "quick-settings__links",
          attrs: { "aria-label": "Settings pages" },
          children: [
            this._link("icon:image", "Wallpaper", "wallpaper"),
            this._link("icon:display", "Display & desktop", "desktop"),
            this._link("icon:bell", "Notifications", "notifications"),
            this._link("icon:gear", "All settings", "appearance"),
          ],
        }),
      ],
    });

    this._cleanups.push(
      settingsService.subscribeCategory("appearance", () => this._sync()),
      settingsService.subscribeCategory("notifications", () => this._sync()),
      // The effective reduced-motion state also follows the OS preference.
      eventBus.on("appearance:changed", () => this._sync())
    );
    this._sync();
  }

  /** @returns {HTMLElement} */
  getElement() {
    return this._el;
  }

  /** @returns {HTMLElement|null} */
  getInitialFocus() {
    return this._el.querySelector(".quick-tile");
  }

  /** @returns {void} */
  onOpen() {
    this._sync();
  }

  /** @returns {void} */
  destroy() {
    for (const cleanup of this._cleanups) cleanup();
    this._cleanups = [];
  }

  // ---------------------------------------------------------------
  // Controls
  // ---------------------------------------------------------------

  /** @returns {void} */
  _sync() {
    for (const syncer of this._syncers) syncer();
  }

  /**
   * @param {object} config
   * @param {string} config.icon
   * @param {string} config.label
   * @param {() => boolean} config.isOn
   * @param {(on: boolean) => string} config.detail
   * @param {(on: boolean) => void} config.toggle
   * @returns {HTMLButtonElement}
   */
  _tile({ icon, label, isOn, detail, toggle }) {
    const detailEl = createElement("span", { className: "quick-tile__detail" });
    const button = createElement("button", {
      className: "quick-tile",
      attrs: { type: "button", "aria-pressed": "false" },
      children: [
        createIconElement(icon, { className: "quick-tile__icon" }),
        createElement("span", { className: "quick-tile__label", text: label }),
        detailEl,
      ],
      on: { click: () => toggle(isOn()) },
    });
    this._syncers.push(() => {
      const on = Boolean(isOn());
      button.setAttribute("aria-pressed", String(on));
      button.classList.toggle("quick-tile--on", on);
      detailEl.textContent = detail(on);
    });
    return button;
  }

  /**
   * @param {string} title
   * @param {HTMLElement} control
   * @returns {HTMLElement}
   */
  _section(title, control) {
    const id = `${this._uid}-${title.toLowerCase().replace(/\W+/g, "-")}`;
    control.setAttribute("aria-labelledby", id);
    return createElement("div", {
      className: "quick-settings__section",
      children: [createElement("h3", { className: "quick-settings__label", attrs: { id }, text: title }), control],
    });
  }

  /** @returns {HTMLElement} */
  _themeControl() {
    const group = createElement("div", { className: "quick-segmented", attrs: { role: "radiogroup" } });
    const buttons = THEME_OPTIONS.map((option) => {
      const button = createElement("button", {
        className: "quick-segmented__option",
        attrs: { type: "button", role: "radio", "aria-checked": "false", "data-value": option.value },
        children: [createIconElement(option.icon), createElement("span", { text: option.label })],
        on: {
          click: () => settingsService.set("appearance.theme", option.value),
          keydown: (e) => this._radioKeys(e, buttons, (next) => settingsService.set("appearance.theme", next.dataset.value)),
        },
      });
      return button;
    });
    group.append(...buttons);
    this._syncers.push(() => syncRadios(buttons, settingsService.get("appearance.theme")));
    return group;
  }

  /** @returns {HTMLElement} */
  _speedControl() {
    const group = createElement("div", { className: "quick-segmented", attrs: { role: "radiogroup" } });
    const buttons = SPEED_OPTIONS.map((option) =>
      createElement("button", {
        className: "quick-segmented__option",
        attrs: { type: "button", role: "radio", "aria-checked": "false", "data-value": option.value },
        text: option.label,
        on: {
          click: () => settingsService.set("appearance.animationSpeed", option.value),
          keydown: (e) => this._radioKeys(e, buttons, (next) => settingsService.set("appearance.animationSpeed", next.dataset.value)),
        },
      })
    );
    group.append(...buttons);
    this._syncers.push(() => {
      syncRadios(buttons, settingsService.get("appearance.animationSpeed"));
      const reduced = document.documentElement.dataset.reducedMotion === "on";
      for (const button of buttons) button.disabled = reduced;
      group.title = reduced ? "Animations are off while Reduce motion is on" : "";
    });
    return group;
  }

  /** @returns {HTMLElement} */
  _accentControl() {
    const group = createElement("div", { className: "quick-accents", attrs: { role: "radiogroup" } });
    const buttons = ACCENT_PRESETS.map((preset) =>
      createElement("button", {
        className: "quick-accent",
        attrs: { type: "button", role: "radio", "aria-checked": "false", "aria-label": preset.label, title: preset.label, "data-value": preset.id },
        on: {
          click: () => settingsService.set("appearance.accentColor", preset.id),
          keydown: (e) => this._radioKeys(e, buttons, (next) => settingsService.set("appearance.accentColor", next.dataset.value)),
        },
      })
    );
    group.append(...buttons);
    this._syncers.push(() => {
      const mode = document.documentElement.dataset.theme === "light" ? "light" : "dark";
      ACCENT_PRESETS.forEach((preset, index) => {
        buttons[index].style.setProperty("--swatch", preset[mode].primary);
      });
      syncRadios(buttons, settingsService.get("appearance.accentColor"));
    });
    return group;
  }

  /** @returns {HTMLElement} */
  _blurControl() {
    const descriptor = settingsService.getDescriptor("appearance.blurIntensity");
    const labelId = `${this._uid}-blur`;
    const valueEl = createElement("span", { className: "quick-settings__value" });
    const input = createElement("input", {
      className: "quick-range",
      attrs: { type: "range", min: String(descriptor.min), max: String(descriptor.max), step: "1", "aria-labelledby": labelId },
      on: {
        input: () => settingsService.set("appearance.blurIntensity", Number(input.value)),
      },
    });
    this._syncers.push(() => {
      const value = settingsService.get("appearance.blurIntensity");
      if (document.activeElement !== input) input.value = String(value);
      valueEl.textContent = `${value} px`;
      const enabled = settingsService.get("appearance.transparency");
      input.disabled = !enabled;
      input.setAttribute("aria-valuetext", enabled ? `${value} pixels` : "Unavailable while transparency is off");
    });
    return createElement("div", {
      className: "quick-settings__section",
      children: [
        createElement("div", {
          className: "quick-settings__row",
          children: [createElement("h3", { className: "quick-settings__label", attrs: { id: labelId }, text: "Blur" }), valueEl],
        }),
        input,
      ],
    });
  }

  /**
   * @param {string} icon
   * @param {string} label
   * @param {string} page
   * @returns {HTMLButtonElement}
   */
  _link(icon, label, page) {
    return createElement("button", {
      className: "quick-link",
      attrs: { type: "button" },
      children: [createIconElement(icon), createElement("span", { text: label })],
      on: { click: () => this._goToSettings(page) },
    });
  }

  /**
   * @param {string} page
   * @returns {void}
   */
  _goToSettings(page) {
    this._requestClose();
    this._openSettings(page);
  }

  /**
   * Arrow keys move between radio options (roving selection).
   * @param {KeyboardEvent} e
   * @param {HTMLButtonElement[]} buttons
   * @param {(next: HTMLButtonElement) => void} select
   * @returns {void}
   */
  _radioKeys(e, buttons, select) {
    const forward = e.key === "ArrowRight" || e.key === "ArrowDown";
    const backward = e.key === "ArrowLeft" || e.key === "ArrowUp";
    if ((!forward && !backward) || e.altKey || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    const enabled = buttons.filter((button) => !button.disabled);
    const index = enabled.indexOf(e.currentTarget);
    const next = enabled[(index + (forward ? 1 : -1) + enabled.length) % enabled.length];
    select(next);
    next.focus();
  }
}

/**
 * @param {HTMLButtonElement[]} buttons
 * @param {string} value
 * @returns {void}
 */
function syncRadios(buttons, value) {
  for (const button of buttons) {
    const checked = button.dataset.value === value;
    button.setAttribute("aria-checked", String(checked));
    button.tabIndex = checked ? 0 : -1;
  }
}
