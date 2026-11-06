/**
 * @file Taskbar settings page: the tray clock and date, and Task
 * Manager's refresh rate. Options are taskbar.* settings applied live by
 * TrayManager, and taskManager.refreshInterval applied by every open
 * Task Manager window.
 */

import { SettingsPage } from "./settingsPage.js";

export default class TaskbarPage extends SettingsPage {
  /** @param {object} [context] */
  constructor(context) {
    super(
      {
        category: "taskbar",
        title: "Taskbar",
        intro: "Choose what the taskbar clock shows, and how often Task Manager updates.",
        resetLabel: "taskbar settings",
        watchCategories: ["taskbar", "taskManager"],
      },
      context
    );
  }

  /** @returns {HTMLElement[]} */
  buildSections() {
    const secondsRow = this.toggleRow("taskbar.showSeconds", "Show seconds", "Update the taskbar clock every second.");
    this.addSyncer((values) => secondsRow.setMuted(!values["taskbar.showClock"]));

    return [
      this.section({
        anchor: "clock",
        title: "Clock and date",
        description: "Shown at the right end of the taskbar. Select it to open the date panel.",
        children: [
          this.toggleRow("taskbar.showClock", "Show the time", "When both the time and date are hidden, the tray shows a calendar button instead.").element,
          this.toggleRow("taskbar.showDate", "Show the date", "Display the date under the time.").element,
          this.segmentedRow("taskbar.clockFormat", "Clock format", "Applies to the taskbar clock and the date panel.", [
            { value: "auto", label: "Automatic" },
            { value: "12h", label: "12-hour" },
            { value: "24h", label: "24-hour" },
          ]).element,
          secondsRow.element,
        ],
      }),
      this.section({
        anchor: "task-manager",
        title: "Task Manager",
        description: "Window and application changes always appear immediately.",
        children: [
          this.selectRow(
            "taskManager.refreshInterval",
            "Update performance figures every",
            "Also sets how often running times refresh. Updates pause while Task Manager is minimized.",
            [
              { value: "1", label: "1 second" },
              { value: "2", label: "2 seconds" },
              { value: "5", label: "5 seconds" },
              { value: "10", label: "10 seconds" },
            ]
          ).element,
        ],
      }),
    ];
  }
}
