/**
 * @file TrayManager — the system tray at the right end of the taskbar.
 *
 * Tray buttons, left to right:
 *   - Quick Settings (common preferences)
 *   - Notifications: bell with an unread count; shows a crossed-out bell
 *     while Do Not Disturb is on
 *   - Clock and date: opens the date panel
 *
 * Each button owns a ShellPanel. Only one panel is open at a time, and
 * opening one closes the Start Menu (and vice versa). The tray reflects
 * live state only through EventBus and SettingsService: notification
 * history changes, Do Not Disturb, system clock ticks, and the taskbar
 * settings (clock visibility, date, 12/24-hour format, seconds).
 *
 * Keyboard: Alt + Shift + N toggles the Notification Center, Alt + Shift
 * + A toggles Quick Settings (shortcut catalog ids shell.*), Escape
 * closes the open panel.
 *
 * Events (EventBus): "system:trayUpdated" { unread, dnd },
 * "shell:panelOpened" { panel }, "shell:panelClosed" { panel }.
 * Listens for "shell:togglePanel" { panel } and "shell:closePanels".
 */

import { createElement } from "../../utils/dom.js";
import { renderIcon } from "../../utils/icons.js";
import { eventBus } from "../eventBus.js";
import { settingsService } from "../settings/settingsService.js";
import { keyboardShortcuts } from "../keyboard/keyboardShortcuts.js";
import { notificationService } from "../notifications/notificationService.js";
import { systemClock, formatClockTime } from "./systemClock.js";
import { ShellPanel } from "../../components/shell/shellPanel.js";
import { NotificationCenter } from "../../components/shell/notificationCenter.js";
import { QuickSettings } from "../../components/shell/quickSettings.js";
import { DateFlyout } from "../../components/shell/dateFlyout.js";

const PANEL_IDS = Object.freeze(["quickSettings", "notifications", "date"]);

export class TrayManager {
  /**
   * @param {object} deps
   * @param {HTMLElement} deps.trayEl - Container provided by Desktop.
   * @param {import("../appManager.js").AppManager} deps.appManager
   * @param {object|null} [deps.calendarService] - For event dots in the date panel.
   */
  constructor({ trayEl, appManager, calendarService = null }) {
    this._trayEl = trayEl;
    this._appManager = appManager;
    this._calendarService = calendarService;
    /** @type {Record<string, {panel: ShellPanel, content: object, button: HTMLElement}>} */
    this._panels = {};
    this._cleanups = [];
    this._timeEl = null;
    this._dateEl = null;
    this._clockButton = null;
    this._bellButton = null;
    this._bellIconEl = null;
    this._badgeEl = null;
  }

  /** @returns {void} */
  init() {
    const openSettings = (page, anchor) => {
      this._appManager.launch("settings", anchor ? { page, anchor } : { page }).catch((error) => console.error("[TrayManager] couldn't open Settings:", error));
    };

    // ---- Buttons ----
    const quickButton = this._button("tray-button tray-button--icon", "Quick Settings", "icon:sliders");
    this._bellIconEl = createElement("span", { className: "tray-button__icon", attrs: { "aria-hidden": "true" } });
    this._badgeEl = createElement("span", { className: "tray-badge", attrs: { "aria-hidden": "true", hidden: "" } });
    this._bellButton = createElement("button", {
      className: "tray-button tray-button--icon tray-button--bell",
      attrs: { type: "button" },
      children: [this._bellIconEl, this._badgeEl],
    });
    this._timeEl = createElement("span", { className: "tray-clock__time" });
    this._dateEl = createElement("span", { className: "tray-clock__date" });
    this._clockButton = createElement("button", {
      className: "tray-button tray-clock",
      attrs: { type: "button" },
      children: [this._timeEl, this._dateEl],
    });
    this._trayEl.append(quickButton, this._bellButton, this._clockButton);

    // ---- Panels ----
    const center = new NotificationCenter({
      openSettings,
      getAppIcon: (id) => this._appManager.getApp(id),
      requestClose: () => this.closePanels(),
    });
    const quick = new QuickSettings({ openSettings, requestClose: () => this.closePanels() });
    const date = new DateFlyout({
      openCalendar: (dateKey) => {
        if (!this._appManager.isRegistered("calendar")) return;
        this._appManager.launch("calendar", { date: dateKey }).catch((error) => console.error("[TrayManager] couldn't open Calendar:", error));
      },
      requestClose: () => this.closePanels(),
      calendarService: this._calendarService,
    });
    this._addPanel("quickSettings", quickButton, quick, "Quick Settings", "shell-panel--quick");
    this._addPanel("notifications", this._bellButton, center, "Notification Center", "shell-panel--notifications");
    this._addPanel("date", this._clockButton, date, "Date and calendar", "shell-panel--date");

    for (const [name, { button }] of Object.entries(this._panels)) {
      button.addEventListener("click", () => this.togglePanel(name));
    }

    // ---- Live state ----
    this._cleanups.push(
      eventBus.on("notification:historyChanged", () => this._renderBell()),
      eventBus.on("system:dndChanged", () => this._renderBell()),
      eventBus.on("system:clockTick", ({ now }) => this._renderClock(new Date(now))),
      eventBus.on("startmenu:opened", () => this.closePanels()),
      eventBus.on("shell:togglePanel", ({ panel }) => this.togglePanel(panel)),
      eventBus.on("shell:closePanels", () => this.closePanels()),
      settingsService.subscribeCategory("taskbar", () => this._applyClockSettings()),
      settingsService.subscribe("notifications.doNotDisturb", () => this._renderBell()),
      keyboardShortcuts.bind("shell.notificationCenter", () => this.togglePanel("notifications")),
      keyboardShortcuts.bind("shell.quickSettings", () => this.togglePanel("quickSettings"))
    );
    this._applyClockSettings();
    this._renderBell();
  }

  /**
   * @param {string} name - "quickSettings" | "notifications" | "date"
   * @returns {void}
   */
  openPanel(name) {
    const entry = this._panels[name];
    if (!entry || entry.panel.isOpen()) return;
    for (const other of PANEL_IDS) {
      if (other !== name) this._panels[other]?.panel.close({ reason: "replaced" });
    }
    eventBus.emit("startmenu:close", Object.freeze({ restoreFocus: false }));
    entry.panel.open();
  }

  /**
   * @param {string} name
   * @returns {void}
   */
  togglePanel(name) {
    const entry = this._panels[name];
    if (!entry) return;
    if (entry.panel.isOpen()) entry.panel.close({ reason: "toggle", restoreFocus: true });
    else this.openPanel(name);
  }

  /** @returns {void} */
  closePanels() {
    for (const name of PANEL_IDS) this._panels[name]?.panel.close({ reason: "programmatic" });
  }

  /**
   * @returns {string|null} The open panel's name.
   */
  getOpenPanel() {
    return PANEL_IDS.find((name) => this._panels[name]?.panel.isOpen()) ?? null;
  }

  /** @returns {void} */
  destroy() {
    for (const cleanup of this._cleanups) cleanup();
    this._cleanups = [];
    for (const { panel, content } of Object.values(this._panels)) {
      panel.destroy();
      content.destroy();
    }
    this._panels = {};
    this._trayEl.replaceChildren();
  }

  // ---------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------

  /**
   * @param {string} className
   * @param {string} label
   * @param {string} icon
   * @returns {HTMLButtonElement}
   */
  _button(className, label, icon) {
    const iconEl = renderIcon(createElement("span", { className: "tray-button__icon", attrs: { "aria-hidden": "true" } }), icon);
    return createElement("button", {
      className,
      attrs: { type: "button", "aria-label": label, title: label },
      children: [iconEl],
    });
  }

  /**
   * @param {string} name
   * @param {HTMLElement} button
   * @param {{getElement: () => HTMLElement, getInitialFocus?: () => (HTMLElement|null), onOpen?: () => void, onClose?: () => void, destroy: () => void}} content
   * @param {string} label
   * @param {string} className
   * @returns {void}
   */
  _addPanel(name, button, content, label, className) {
    const panel = new ShellPanel({
      id: `shell-panel-${name}`,
      label,
      anchorEl: button,
      content: content.getElement(),
      className,
      initialFocus: () => content.getInitialFocus?.() ?? null,
      onOpen: () => {
        content.onOpen?.();
        this._setBannerInset(panel.getElement());
        eventBus.emit("shell:panelOpened", Object.freeze({ panel: name }));
      },
      onClose: () => {
        content.onClose?.();
        if (!this.getOpenPanel()) this._setBannerInset(null);
        eventBus.emit("shell:panelClosed", Object.freeze({ panel: name }));
      },
    });
    this._panels[name] = { panel, content, button };
  }

  /**
   * Notification banners move left of an open panel instead of covering
   * it (styles/notifications.css reads --shell-panel-inset).
   * @param {HTMLElement|null} panelEl
   * @returns {void}
   */
  _setBannerInset(panelEl) {
    const root = document.documentElement;
    if (!panelEl) {
      root.style.removeProperty("--shell-panel-inset");
      return;
    }
    const rect = panelEl.getBoundingClientRect();
    root.style.setProperty("--shell-panel-inset", `${Math.max(0, Math.round(window.innerWidth - rect.left))}px`);
  }

  /** @returns {void} */
  _renderBell() {
    const unread = notificationService.getUnreadCount();
    const dnd = notificationService.isDoNotDisturb();
    renderIcon(this._bellIconEl, dnd ? "icon:bell-off" : "icon:bell");
    this._badgeEl.hidden = unread === 0;
    this._badgeEl.textContent = unread > 99 ? "99+" : String(unread);
    this._bellButton.classList.toggle("tray-button--dnd", dnd);
    const parts = ["Notifications"];
    if (unread > 0) parts.push(`${unread} unread`);
    if (dnd) parts.push("Do Not Disturb on");
    const label = parts.join(", ");
    this._bellButton.setAttribute("aria-label", label);
    this._bellButton.title = label;
    eventBus.emit("system:trayUpdated", Object.freeze({ unread, dnd }));
  }

  /** @returns {void} */
  _applyClockSettings() {
    const showClock = settingsService.get("taskbar.showClock");
    const showDate = settingsService.get("taskbar.showDate");
    const seconds = settingsService.get("taskbar.showSeconds");
    systemClock.setPrecision(showClock && seconds ? "second" : "minute");
    this._timeEl.hidden = !showClock;
    this._dateEl.hidden = !showDate;
    this._clockButton.classList.toggle("tray-clock--compact", !showClock && !showDate);
    this._renderClock(new Date());
  }

  /**
   * @param {Date} now
   * @returns {void}
   */
  _renderClock(now) {
    const time = formatClockTime(now, {
      format: settingsService.get("taskbar.clockFormat"),
      seconds: settingsService.get("taskbar.showSeconds"),
    });
    const date = now.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    if (this._timeEl.textContent !== time) this._timeEl.textContent = time;
    if (this._dateEl.textContent !== date) this._dateEl.textContent = date;
    const full = `${now.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" })}, ${time}`;
    this._clockButton.setAttribute("aria-label", `Date and time: ${full}`);
    this._clockButton.title = full;
    // With both hidden, the button shows a calendar icon instead.
    const compact = this._clockButton.classList.contains("tray-clock--compact");
    let iconEl = this._clockButton.querySelector(".tray-button__icon");
    if (compact && !iconEl) {
      iconEl = renderIcon(createElement("span", { className: "tray-button__icon", attrs: { "aria-hidden": "true" } }), "icon:calendar");
      this._clockButton.prepend(iconEl);
    } else if (!compact && iconEl) {
      iconEl.remove();
    }
  }
}
