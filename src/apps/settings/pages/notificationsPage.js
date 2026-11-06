/**
 * @file Notifications settings page: Do Not Disturb, banners, sounds,
 * and the Notification Center history. Every option is a
 * notifications.* setting that NotificationService applies live.
 */

import { createElement } from "../../../utils/dom.js";
import { eventBus } from "../../../core/eventBus.js";
import { notificationService } from "../../../core/notifications/notificationService.js";
import { showConfirmDialog } from "../../../components/dialog/confirmDialog.js";
import { createButton } from "../settingsControls.js";
import { SettingsPage } from "./settingsPage.js";

export default class NotificationsPage extends SettingsPage {
  /** @param {object} [context] */
  constructor(context) {
    super(
      {
        category: "notifications",
        title: "Notifications",
        intro: "Choose how notifications appear and how many are kept in the Notification Center.",
        resetLabel: "notification settings",
      },
      context
    );
  }

  /** @returns {HTMLElement[]} */
  buildSections() {
    const historyStatus = createElement("p", { className: "settings-section__status", attrs: { role: "status" } });
    const clearButton = createButton({
      label: "Clear notification history",
      variant: "danger",
      onClick: async () => {
        const confirmed = await showConfirmDialog({
          title: "Clear notification history?",
          message: "Every notification is removed from the Notification Center. Banners on screen stay until they close.",
          confirmLabel: "Clear",
          destructive: true,
        });
        if (!confirmed || this.isDestroyed()) return;
        notificationService.clearHistory();
      },
    });
    const renderHistory = () => {
      if (this.isDestroyed()) return;
      const total = notificationService.getNotifications().length;
      const unread = notificationService.getUnreadCount();
      historyStatus.textContent = total === 0 ? "The Notification Center is empty." : `${total} notification${total === 1 ? "" : "s"} stored, ${unread} unread.`;
      clearButton.disabled = total === 0;
    };
    this.addCleanup(eventBus.on("notification:historyChanged", renderHistory));
    renderHistory();

    return [
      this.section({
        anchor: "dnd",
        title: "Do Not Disturb",
        description: "Quiet hours without losing anything.",
        children: [
          this.toggleRow(
            "notifications.doNotDisturb",
            "Do Not Disturb",
            "Hide notification banners and mute their sounds. Notifications still collect in the Notification Center, and alarms and critical system warnings still appear."
          ).element,
        ],
      }),
      this.section({
        anchor: "banners",
        title: "Banners",
        description: "Notifications that appear above the taskbar.",
        children: [
          this.sliderRow(
            "notifications.duration",
            "Banner duration",
            "How long a banner stays on screen. Alarms and notifications that need attention stay until dismissed; hovering a banner pauses it.",
            { unit: " s", unitLabel: "seconds" }
          ).element,
          this.toggleRow("notifications.showPreviews", "Show message previews", "Show the message text in banners. The Notification Center always shows it.").element,
          this.toggleRow("notifications.sounds", "Notification sounds", "Play a sound for notifications that have one. Each alarm's own sound is chosen in Clock.").element,
        ],
      }),
      this.section({
        anchor: "history",
        title: "Notification Center",
        description: "Notifications are kept for up to seven days.",
        children: [
          this.selectRow("notifications.historyLimit", "Keep up to", "Older notifications are removed first once the limit is reached.", [
            { value: "20", label: "20 notifications" },
            { value: "50", label: "50 notifications" },
            { value: "100", label: "100 notifications" },
            { value: "200", label: "200 notifications" },
          ]).element,
          createElement("div", { className: "settings-section__actions", children: [clearButton] }),
          historyStatus,
        ],
      }),
    ];
  }
}
