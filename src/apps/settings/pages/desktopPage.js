/**
 * @file Desktop settings page: icon appearance, layout, and
 * interaction. Every option is a desktop.* setting that DesktopManager
 * applies live.
 */

import { SettingsPage } from "./settingsPage.js";

const CONFIRM_OPTIONS = Object.freeze([
  { value: "always", label: "Always" },
  { value: "smart", label: "For several items or non-empty folders" },
  { value: "never", label: "Never" },
]);

export default class DesktopPage extends SettingsPage {
  /** @param {object} [context] */
  constructor(context) {
    super(
      {
        category: "desktop",
        title: "Desktop",
        intro: "Control how desktop icons look, where they sit, and how they respond to clicks.",
        resetLabel: "desktop settings",
      },
      context
    );
  }

  /** @returns {HTMLElement[]} */
  buildSections() {
    const alignRow = this.toggleRow(
      "desktop.alignToGrid",
      "Align icons to grid",
      "Snap dropped icons to the nearest grid cell. When off, icons stay exactly where you drop them."
    );
    this.addSyncer((values) => {
      const autoArrange = values["desktop.autoArrange"];
      alignRow.setMuted(autoArrange);
      alignRow.setDescription(
        autoArrange
          ? "Auto arrange keeps icons on the grid, so this applies when auto arrange is off."
          : "Snap dropped icons to the nearest grid cell. When off, icons stay exactly where you drop them."
      );
    });

    return [
      this.section({
        anchor: "icons",
        title: "Icons",
        description: "Size and visibility of desktop items.",
        children: [
          this.segmentedRow("desktop.iconSize", "Icon size", "Changes icons, labels, and the grid they snap to.", [
            { value: "small", label: "Small" },
            { value: "medium", label: "Medium" },
            { value: "large", label: "Large" },
          ]).element,
          this.toggleRow("desktop.showLabels", "Show icon labels", "Display item names under icons.").element,
          this.toggleRow(
            "desktop.showIcons",
            "Show desktop icons",
            "Hide every icon for a clean desktop. Files are not affected, and the desktop context menu can show them again."
          ).element,
          this.toggleRow(
            "desktop.showSystemShortcuts",
            "Show system shortcuts",
            "Show the Recycle Bin shortcut on the desktop."
          ).element,
        ],
      }),
      this.section({
        anchor: "layout",
        title: "Layout",
        description: "How icons are positioned.",
        children: [
          this.segmentedRow("desktop.gridSpacing", "Grid spacing", "Space between grid cells. Icons move to the new grid immediately.", [
            { value: "compact", label: "Compact" },
            { value: "normal", label: "Normal" },
            { value: "spacious", label: "Spacious" },
          ]).element,
          this.toggleRow(
            "desktop.autoArrange",
            "Auto arrange icons",
            "Keep icons packed in columns. Dragging an icon reorders it instead of placing it freely."
          ).element,
          alignRow.element,
        ],
      }),
      this.section({
        anchor: "interaction",
        title: "Interaction",
        description: "Opening, selecting, and deleting items.",
        children: [
          this.segmentedRow("desktop.openItemsWith", "Open items with", "With a single click, press F2 to rename the selected item.", [
            { value: "doubleClick", label: "Double click" },
            { value: "singleClick", label: "Single click" },
          ]).element,
          this.toggleRow(
            "desktop.rectangleSelection",
            "Rectangle selection",
            "Drag across empty desktop space to select several icons. Ctrl + click always adds to the selection."
          ).element,
          this.selectRow(
            "desktop.confirmTrash",
            "Confirm before moving to Trash",
            "Deleted desktop items always move to the Trash folder; they are never erased.",
            CONFIRM_OPTIONS
          ).element,
        ],
      }),
    ];
  }
}
