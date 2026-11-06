/**
 * @file Wallpaper settings page: background preset and dimming.
 *
 * Previews reuse the real wallpaper styles (styles/wallpapers.css
 * matches `data-wallpaper-preview`), so they always reflect the active
 * theme and accent exactly as the desktop will.
 */

import { createElement } from "../../../utils/dom.js";
import { settingsService } from "../../../core/settings/settingsService.js";
import { WALLPAPER_PRESETS } from "../../../core/settings/settingsSchema.js";
import { createChoiceGroup, uniqueId } from "../settingsControls.js";
import { SettingsPage } from "./settingsPage.js";

export default class WallpaperPage extends SettingsPage {
  /** @param {object} [context] */
  constructor(context) {
    super(
      {
        category: "wallpaper",
        title: "Wallpaper",
        intro: "Choose the desktop background. Every wallpaper adapts to the light and dark themes.",
        resetLabel: "wallpaper settings",
      },
      context
    );
  }

  /** @returns {HTMLElement[]} */
  buildSections() {
    const labelId = uniqueId("settings-wallpaper-label");
    const group = createChoiceGroup({
      name: uniqueId("settings-wallpaper"),
      labelledBy: labelId,
      className: "settings-wallpaper-grid",
      optionClassName: "settings-wallpaper-card",
      options: WALLPAPER_PRESETS.map((preset) => ({
        value: preset.id,
        content: createElement("span", {
          className: "settings-wallpaper-card__content",
          children: [
            createElement("span", {
              className: "settings-wallpaper-card__preview",
              attrs: { "data-wallpaper-preview": preset.id, "aria-hidden": "true" },
            }),
            createElement("span", { className: "settings-wallpaper-card__name", text: preset.label }),
            createElement("span", { className: "settings-choice__check", attrs: { "aria-hidden": "true" }, text: "\u2713" }),
          ],
        }),
      })),
      onChange: (value) => settingsService.set("wallpaper.preset", value),
    });
    this.addSyncer((values) => group.setValue(values["wallpaper.preset"]));

    const dimRow = this.sliderRow(
      "wallpaper.dim",
      "Dimming",
      "Darkens the wallpaper in the dark theme and softens it in the light theme, for calmer contrast behind windows.",
      { unit: "%", unitLabel: "percent" }
    );

    return [
      this.section({
        anchor: "preset",
        title: "Background",
        description: "Aurora follows your accent color; the others use fixed palettes.",
        headerAction: this.resetButton("wallpaper.preset", "wallpaper"),
        children: [
          createElement("span", { className: "settings-visually-hidden", attrs: { id: labelId }, text: "Wallpaper" }),
          group.element,
        ],
      }),
      this.section({
        anchor: "dim",
        title: "Effects",
        children: [dimRow.element],
      }),
    ];
  }
}
