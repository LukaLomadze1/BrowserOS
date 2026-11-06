/**
 * @file System settings page: reset preferences per category or all
 * at once, and a summary of the stored settings.
 *
 * Resets go through SettingsService only (resetCategory / resetAll),
 * so every affected subsystem updates through its normal subscription.
 * No files, desktop layout, recent history, or other application data
 * is touched.
 */

import { createElement, clearElement } from "../../../utils/dom.js";
import { settingsService } from "../../../core/settings/settingsService.js";
import { SETTINGS_VERSION } from "../../../core/settings/settingsSchema.js";
import { showConfirmDialog } from "../../../components/dialog/confirmDialog.js";
import { createButton, createSection } from "../settingsControls.js";

/** Display names for settings categories. */
const CATEGORY_LABELS = Object.freeze({
  appearance: "Appearance",
  wallpaper: "Wallpaper",
  desktop: "Desktop",
  startMenu: "Start Menu",
  fileExplorer: "File Explorer",
  keyboard: "Keyboard Shortcuts",
  notifications: "Notifications",
  taskbar: "Taskbar",
  taskManager: "Task Manager",
  browser: "Browser",
  downloads: "Downloads",
});

export default class SystemPage {
  constructor() {
    this._destroyed = false;
    this._cleanups = [];
    this._statusEl = createElement("p", { className: "settings-section__status", attrs: { role: "status" } });
    this._categoryListEl = createElement("ul", { className: "settings-category-list" });
    this._summaryEl = createElement("dl", { className: "settings-summary" });

    this._element = createElement("div", {
      className: "settings-page",
      children: [
        createElement("header", {
          className: "settings-page__header",
          children: [
            createElement("h1", { className: "settings-page__title", attrs: { tabindex: "-1" }, text: "System" }),
            createElement("p", {
              className: "settings-page__intro",
              text: "Restore preferences to their defaults. Resetting never deletes files, desktop icon positions, or recent history.",
            }),
          ],
        }),
        createSection({
          anchor: "reset",
          title: "Reset preferences",
          description: "Reset one area, or everything at once.",
          children: [
            this._categoryListEl,
            createElement("div", {
              className: "settings-section__actions",
              children: [createButton({ label: "Reset all preferences", variant: "danger", onClick: () => this._confirmResetAll() })],
            }),
            this._statusEl,
          ],
        }),
        createSection({
          anchor: "about",
          title: "Stored settings",
          description: "Settings are saved in this browser and restored every time BrowserOS starts.",
          children: [this._summaryEl],
        }),
      ],
    });

    this._render();
    this._cleanups.push(settingsService.subscribeAll(() => this._render()));
  }

  /** @returns {HTMLElement} */
  getElement() {
    return this._element;
  }

  /** @returns {void} */
  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    for (const cleanup of this._cleanups) cleanup();
    this._cleanups = [];
  }

  /** @returns {void} */
  _render() {
    if (this._destroyed) return;
    const active = document.activeElement;
    const focusedCategory = active?.dataset?.resetCategory ?? null;

    clearElement(this._categoryListEl);
    for (const category of settingsService.getCategoryIds()) {
      const label = CATEGORY_LABELS[category] ?? category;
      const customized = settingsService.getCustomizedKeys(category).length;
      const button = createButton({
        label: "Reset",
        ariaLabel: `Reset ${label} settings`,
        onClick: () => this._confirmResetCategory(category, label),
      });
      button.dataset.resetCategory = category;
      this._categoryListEl.append(
        createElement("li", {
          className: "settings-category-list__item",
          children: [
            createElement("span", { className: "settings-category-list__name", text: label }),
            createElement("span", {
              className: "settings-category-list__count",
              text: customized === 0 ? "Defaults" : `${customized} customized`,
            }),
            button,
          ],
        })
      );
      if (focusedCategory === category) button.focus();
    }

    const total = settingsService.getCustomizedKeys().length;
    const persistenceError = settingsService.getPersistenceError();
    clearElement(this._summaryEl);
    for (const [term, value] of [
      ["Customized settings", total === 0 ? "None \u2014 everything is at its default" : String(total)],
      ["Settings format", `Version ${SETTINGS_VERSION}`],
      ["Storage", persistenceError ? "Not saving \u2014 changes last until reload" : "Saved in this browser"],
    ]) {
      this._summaryEl.append(createElement("dt", { text: term }), createElement("dd", { text: value }));
    }
  }

  /**
   * @param {string} category
   * @param {string} label
   * @returns {Promise<void>}
   */
  async _confirmResetCategory(category, label) {
    const confirmed = await showConfirmDialog({
      title: `Reset ${label} settings?`,
      message: `Every ${label} preference returns to its default. Files and other data are not affected.`,
      confirmLabel: "Reset",
      destructive: true,
    });
    if (!confirmed || this._destroyed) return;
    settingsService.resetCategory(category);
    this._statusEl.textContent = `${label} settings were reset to their defaults.`;
  }

  /** @returns {Promise<void>} */
  async _confirmResetAll() {
    const confirmed = await showConfirmDialog({
      title: "Reset all preferences?",
      message:
        "Every BrowserOS preference \u2014 appearance, wallpaper, desktop, Start Menu, File Explorer, keyboard, notifications, taskbar, Task Manager, Browser, and downloads \u2014 returns to its default. Files, desktop icon positions, and recent history are kept.",
      confirmLabel: "Reset all",
      destructive: true,
    });
    if (!confirmed || this._destroyed) return;
    settingsService.resetAll();
    this._statusEl.textContent = "All preferences were reset to their defaults.";
  }
}
