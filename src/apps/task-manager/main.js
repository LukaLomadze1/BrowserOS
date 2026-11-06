/**
 * @file Task Manager — running applications, performance figures, and
 * background services.
 *
 * Applications tab: one row per running application (an application
 * with three windows is one row with three windows), with status,
 * window count, start time, and recorded errors. A row expands to its
 * windows. Actions: switch to, minimize / restore, restart, and end
 * task. Ending runs every window's normal cleanup (AppManager
 * endApplication); it asks for confirmation only when the application
 * reports that something would be lost (`getCloseWarning()`).
 *
 * Performance tab: BrowserOS figures (applications, windows, services,
 * service timers, notifications, errors, uptime) and figures the browser
 * reports (main-thread delay measured by the application monitor, frame
 * rate measured while the tab is shown, JavaScript heap where the
 * browser exposes it, site storage, DOM size, logical processors,
 * approximate device memory). BrowserOS cannot read real CPU, memory, or
 * disk usage, and doesn't pretend to.
 *
 * Services tab: every registered background service with status,
 * dependencies, live details, and start / stop / restart.
 *
 * Updates are event-driven (application, window, and service events)
 * and coalesced into one render per frame; rows are keyed and only
 * changed cells are touched. Timed refreshes (running times,
 * performance samples) follow `taskManager.refreshInterval` and pause
 * while the window is minimized or the tab is hidden.
 *
 * Launch options: { tab: "applications"|"performance"|"services", select?: appId }
 */

import { Application } from "../../core/application.js";
import { eventBus } from "../../core/eventBus.js";
import { settingsService } from "../../core/settings/settingsService.js";
import { serviceManager } from "../../core/services/serviceManager.js";
import { notificationService } from "../../core/notifications/notificationService.js";
import { appMonitor } from "../../core/system/appMonitor.js";
import { storageMonitor } from "../../core/system/storageMonitor.js";
import { showConfirmDialog } from "../../components/dialog/confirmDialog.js";
import { showMessageDialog } from "../../components/dialog/messageDialog.js";
import { createElement, hasModifierKey } from "../../utils/dom.js";
import { createIconElement } from "../../utils/icons.js";
import { ensureStylesheet } from "../../utils/loadStylesheet.js";

ensureStylesheet("src/apps/task-manager/taskManager.css");

const TABS = Object.freeze([
  { id: "applications", label: "Applications" },
  { id: "performance", label: "Performance" },
  { id: "services", label: "Services" },
]);
const HISTORY_LENGTH = 60;
const SORTS = Object.freeze({
  name: (a, b) => a.name.localeCompare(b.name),
  status: (a, b) => a.status.localeCompare(b.status) || a.name.localeCompare(b.name),
  windows: (a, b) => a.windows.length - b.windows.length || a.name.localeCompare(b.name),
  started: (a, b) => a.startedAt - b.startedAt,
});
const SERVICE_STATUS_LABELS = Object.freeze({
  running: "Running",
  stopped: "Stopped",
  starting: "Starting\u2026",
  stopping: "Stopping\u2026",
  failed: "Failed",
});

export default class TaskManagerApp extends Application {
  constructor(meta) {
    super(meta);
    this._tab = "applications";
    this._sort = { key: "name", direction: 1 };
    this._filter = "";
    this._selectedAppId = null;
    this._expanded = new Set();
    /** @type {Map<string, object>} appId -> row parts */
    this._appRows = new Map();
    /** @type {Map<string, object>} serviceId -> row parts */
    this._serviceRows = new Map();
    this._metricEls = new Map();
    this._history = { lag: [], fps: [], heap: [] };
    this._cleanups = [];
    this._renderQueued = false;
    this._intervalId = null;
    this._fpsFrames = 0;
    this._fpsRaf = null;
    this._fpsStart = 0;
    this._lastFps = null;
    this._paused = false;
    this._closed = false;
  }

  /**
   * @param {{tab?: string, select?: string}} [options]
   * @returns {ReturnType<Application["launch"]>}
   */
  launch(options = {}) {
    if (TABS.some((tab) => tab.id === options.tab)) this._tab = options.tab;
    if (typeof options.select === "string") this._selectedAppId = options.select;
    this._buildDom();

    const on = (name, handler) => this._cleanups.push(eventBus.on(name, handler));
    for (const name of [
      "application:started",
      "application:stopped",
      "application:error",
      "app:launched",
      "app:closed",
      "window:focused",
      "window:minimized",
      "window:restored",
      "window:maximized",
      "window:titleChanged",
      "service:statusChanged",
    ]) {
      on(name, () => this._queueRender());
    }
    on("window:minimized", ({ id }) => {
      if (id === this.windowId) this._setPaused(true);
    });
    on("window:restored", ({ id }) => {
      if (id === this.windowId) this._setPaused(false);
    });
    this._cleanups.push(settingsService.subscribe("taskManager.refreshInterval", () => this._restartInterval()));
    this._visibilityHandler = () => this._setPaused(document.visibilityState === "hidden");
    document.addEventListener("visibilitychange", this._visibilityHandler);

    this._selectTab(this._tab, { focus: false });
    this._restartInterval();

    return {
      element: this._root,
      title: "Task Manager",
      icon: "icon:activity",
      width: 820,
      height: 560,
      minWidth: 520,
      minHeight: 380,
    };
  }

  /**
   * @param {{tab?: string, select?: string}} [options]
   * @returns {void}
   */
  onRelaunch(options = {}) {
    if (typeof options.select === "string") this._selectedAppId = options.select;
    if (TABS.some((tab) => tab.id === options.tab)) this._selectTab(options.tab, { focus: false });
    else this._queueRender();
  }

  /** @returns {void} */
  onFocus() {
    if (!this._root.contains(document.activeElement)) this._root.focus({ preventScroll: true });
  }

  /** @returns {void} */
  close() {
    this._closed = true;
    window.clearInterval(this._intervalId);
    this._intervalId = null;
    this._stopFps();
    document.removeEventListener("visibilitychange", this._visibilityHandler);
    for (const cleanup of this._cleanups) cleanup();
    this._cleanups = [];
  }

  // ---------------------------------------------------------------
  // Shell
  // ---------------------------------------------------------------

  /** @returns {void} */
  _buildDom() {
    this._tabButtons = new Map();
    const tablist = createElement("div", {
      className: "task-manager__tabs",
      attrs: { role: "tablist", "aria-label": "Task Manager sections" },
      children: TABS.map((tab) => {
        const button = createElement("button", {
          className: "task-manager__tab",
          attrs: { type: "button", role: "tab", id: `tm-tab-${tab.id}`, "aria-controls": `tm-panel-${tab.id}` },
          text: tab.label,
          on: {
            click: () => this._selectTab(tab.id),
            keydown: (e) => this._tabKeys(e),
          },
        });
        this._tabButtons.set(tab.id, button);
        return button;
      }),
    });

    this._searchInput = createElement("input", {
      className: "task-manager__search",
      attrs: { type: "search", placeholder: "Filter", "aria-label": "Filter applications and services", autocomplete: "off" },
      on: {
        input: () => {
          this._filter = this._searchInput.value.trim().toLowerCase();
          this._queueRender();
        },
      },
    });

    this._panels = {
      applications: this._buildApplicationsPanel(),
      performance: this._buildPerformancePanel(),
      services: this._buildServicesPanel(),
    };
    for (const [id, panel] of Object.entries(this._panels)) {
      panel.id = `tm-panel-${id}`;
      panel.setAttribute("role", "tabpanel");
      panel.setAttribute("aria-labelledby", `tm-tab-${id}`);
    }

    this._statusEl = createElement("p", { className: "task-manager__status", attrs: { role: "status", "aria-live": "polite" } });
    this._root = createElement("div", {
      className: "task-manager",
      attrs: { tabindex: "-1" },
      children: [
        createElement("div", { className: "task-manager__toolbar", children: [tablist, this._searchInput] }),
        ...Object.values(this._panels),
        createElement("footer", { className: "task-manager__footer", children: [this._statusEl] }),
      ],
    });
  }

  /**
   * @param {string} tabId
   * @param {{focus?: boolean}} [options]
   * @returns {void}
   */
  _selectTab(tabId, { focus = true } = {}) {
    this._tab = tabId;
    for (const [id, button] of this._tabButtons) {
      const active = id === tabId;
      button.setAttribute("aria-selected", String(active));
      button.tabIndex = active ? 0 : -1;
      button.classList.toggle("task-manager__tab--active", active);
      this._panels[id].hidden = !active;
    }
    this._searchInput.hidden = tabId === "performance";
    if (tabId === "performance") {
      this._sample();
      this._startFps();
    } else {
      this._stopFps();
    }
    this._render();
    if (focus) this._tabButtons.get(tabId).focus();
  }

  /**
   * @param {KeyboardEvent} e
   * @returns {void}
   */
  _tabKeys(e) {
    if ((e.key !== "ArrowLeft" && e.key !== "ArrowRight") || hasModifierKey(e)) return;
    e.preventDefault();
    const index = TABS.findIndex((tab) => tab.id === this._tab);
    this._selectTab(TABS[(index + (e.key === "ArrowRight" ? 1 : -1) + TABS.length) % TABS.length].id);
  }

  /** @returns {void} */
  _queueRender() {
    if (this._renderQueued || this._closed) return;
    this._renderQueued = true;
    requestAnimationFrame(() => {
      this._renderQueued = false;
      if (!this._closed) this._render();
    });
  }

  /** @returns {void} */
  _render() {
    if (this._tab === "applications") this._renderApplications();
    else if (this._tab === "performance") this._renderPerformance();
    else this._renderServices();
    this._renderStatus();
  }

  /** @returns {void} */
  _renderStatus() {
    const apps = this.appManager.getRunningApplications();
    const windows = apps.reduce((sum, app) => sum + app.windows.length, 0);
    const services = serviceManager.getServices();
    const running = services.filter((service) => service.status === "running").length;
    const interval = settingsService.get("taskManager.refreshInterval");
    const text = `${plural(apps.length, "application")} \u00b7 ${plural(windows, "window")} \u00b7 ${running} of ${plural(services.length, "service")} running \u00b7 ${
      this._paused ? "updates paused" : `updates every ${interval} s`
    }`;
    if (this._statusEl.textContent !== text) this._statusEl.textContent = text;
  }

  /** @returns {void} */
  _restartInterval() {
    window.clearInterval(this._intervalId);
    this._intervalId = null;
    if (this._paused || this._closed) return;
    const seconds = settingsService.get("taskManager.refreshInterval");
    this._intervalId = window.setInterval(() => {
      this._sample();
      this._render();
    }, seconds * 1000);
    this._renderStatus();
  }

  /**
   * @param {boolean} paused
   * @returns {void}
   */
  _setPaused(paused) {
    if (paused === this._paused) return;
    this._paused = paused;
    if (paused) {
      window.clearInterval(this._intervalId);
      this._intervalId = null;
      this._stopFps();
    } else {
      this._restartInterval();
      if (this._tab === "performance") this._startFps();
      this._render();
    }
    this._renderStatus();
  }

  // ---------------------------------------------------------------
  // Applications
  // ---------------------------------------------------------------

  /** @returns {HTMLElement} */
  _buildApplicationsPanel() {
    const header = (key, label, className) => {
      const button = createElement("button", {
        className: "task-manager__sort",
        attrs: { type: "button" },
        text: label,
        on: { click: () => this._setSort(key) },
      });
      const th = createElement("th", { className, attrs: { scope: "col", "data-sort": key }, children: [button] });
      return th;
    };
    this._appHeaders = [
      header("name", "Name", "tm-col-name"),
      header("status", "Status", "tm-col-status"),
      header("windows", "Windows", "tm-col-num"),
      header("started", "Running for", "tm-col-time"),
      createElement("th", { className: "tm-col-num", attrs: { scope: "col" }, text: "Errors" }),
    ];
    this._appBody = createElement("tbody", { on: { keydown: (e) => this._appKeys(e) } });
    this._appEmpty = createElement("p", { className: "task-manager__empty", text: "No applications are running." });

    this._switchButton = this._actionButton("Switch to", () => this._selectedAppId && this.appManager.focusApplication(this._selectedAppId));
    this._minimizeButton = this._actionButton("Minimize", () => {
      if (this._selectedAppId) this.appManager.toggleApplicationMinimized(this._selectedAppId);
    });
    this._restartButton = this._actionButton("Restart", () => this._restartSelected());
    this._endButton = this._actionButton("End task", () => this._endSelected(), "danger");

    return createElement("section", {
      className: "task-manager__panel",
      children: [
        createElement("div", {
          className: "task-manager__table-wrap",
          children: [
            createElement("table", {
              className: "task-manager__table",
              attrs: { "aria-label": "Running applications" },
              children: [createElement("thead", { children: [createElement("tr", { children: this._appHeaders })] }), this._appBody],
            }),
            this._appEmpty,
          ],
        }),
        createElement("div", {
          className: "task-manager__actions",
          children: [this._switchButton, this._minimizeButton, this._restartButton, this._endButton],
        }),
      ],
    });
  }

  /**
   * @param {string} label
   * @param {() => void} onClick
   * @param {"default"|"danger"} [variant]
   * @returns {HTMLButtonElement}
   */
  _actionButton(label, onClick, variant = "default") {
    return createElement("button", {
      className: `task-manager__button${variant === "danger" ? " task-manager__button--danger" : ""}`,
      attrs: { type: "button" },
      text: label,
      on: { click: onClick },
    });
  }

  /**
   * @param {string} key
   * @returns {void}
   */
  _setSort(key) {
    this._sort = this._sort.key === key ? { key, direction: -this._sort.direction } : { key, direction: 1 };
    this._renderApplications();
  }

  /** @returns {object[]} Running applications after filter and sort. */
  _visibleApps() {
    const sorter = SORTS[this._sort.key];
    return this.appManager
      .getRunningApplications()
      .filter((app) => !this._filter || app.name.toLowerCase().includes(this._filter) || app.windows.some((w) => w.title.toLowerCase().includes(this._filter)))
      .sort((a, b) => sorter(a, b) * this._sort.direction);
  }

  /** @returns {void} */
  _renderApplications() {
    const apps = this._visibleApps();
    const liveIds = new Set(apps.map((app) => app.appId));
    for (const [appId, row] of this._appRows) {
      if (!liveIds.has(appId)) {
        row.el.remove();
        for (const windowRow of row.windowRows.values()) windowRow.remove();
        this._appRows.delete(appId);
      }
    }
    if (this._selectedAppId && !liveIds.has(this._selectedAppId)) this._selectedAppId = null;

    const ordered = [];
    for (const app of apps) {
      const row = this._appRow(app);
      ordered.push(row.el);
      const expanded = this._expanded.has(app.appId);
      const liveWindows = new Set(app.windows.map((w) => w.windowId));
      for (const [windowId, windowRow] of row.windowRows) {
        if (!liveWindows.has(windowId) || !expanded) {
          windowRow.remove();
          if (!liveWindows.has(windowId)) row.windowRows.delete(windowId);
        }
      }
      if (expanded) {
        for (const info of app.windows) ordered.push(this._windowRow(row, app, info));
      }
    }
    // Reorder only when needed, so focus and hover aren't disturbed.
    const current = [...this._appBody.children];
    if (current.length !== ordered.length || current.some((el, index) => el !== ordered[index])) {
      this._appBody.replaceChildren(...ordered);
    }
    // One row is reachable with Tab: the selected one, else the first.
    const focusTarget = this._selectedAppId ?? apps[0]?.appId ?? null;
    for (const [appId, row] of this._appRows) row.el.tabIndex = appId === focusTarget ? 0 : -1;

    for (const th of this._appHeaders) {
      const key = th.dataset.sort;
      if (!key) continue;
      th.setAttribute("aria-sort", this._sort.key === key ? (this._sort.direction === 1 ? "ascending" : "descending") : "none");
    }
    this._appEmpty.hidden = apps.length > 0;
    this._appEmpty.textContent = this._filter ? "No running applications match the filter." : "No applications are running.";
    this._renderActions(apps);
  }

  /**
   * @param {object} app
   * @returns {object} Row parts (cached per application).
   */
  _appRow(app) {
    let row = this._appRows.get(app.appId);
    if (!row) {
      const expander = createElement("button", {
        className: "task-manager__expander",
        attrs: { type: "button", tabindex: "-1" },
        children: [createIconElement("icon:chevronRight")],
        on: {
          click: (e) => {
            e.stopPropagation();
            this._toggleExpanded(app.appId);
          },
        },
      });
      const nameEl = createElement("span", { className: "task-manager__name" });
      const detailEl = createElement("span", { className: "task-manager__detail" });
      const statusEl = createElement("span", { className: "task-manager__pill" });
      const windowsEl = createElement("td", { className: "tm-col-num" });
      const startedEl = createElement("td", { className: "tm-col-time" });
      const errorsEl = createElement("td", { className: "tm-col-num" });
      const el = createElement("tr", {
        className: "task-manager__row",
        attrs: { tabindex: "-1", "data-app-id": app.appId, "aria-selected": "false" },
        children: [
          createElement("td", {
            className: "tm-col-name",
            children: [
              createElement("div", {
                className: "task-manager__cell",
                children: [
                  expander,
                  createIconElement(app.icon, { className: "task-manager__icon" }),
                  createElement("span", { className: "task-manager__name-wrap", children: [nameEl, detailEl] }),
                ],
              }),
            ],
          }),
          createElement("td", { className: "tm-col-status", children: [statusEl] }),
          windowsEl,
          startedEl,
          errorsEl,
        ],
        on: {
          click: () => this._select(app.appId),
          dblclick: () => this.appManager.focusApplication(app.appId),
          focus: () => this._select(app.appId, { focus: false }),
        },
      });
      row = { el, expander, nameEl, detailEl, statusEl, windowsEl, startedEl, errorsEl, windowRows: new Map() };
      this._appRows.set(app.appId, row);
    }

    const expanded = this._expanded.has(app.appId);
    const statusText = app.errorCount > 0 ? "Errors reported" : app.status === "minimized" ? "Minimized" : "Running";
    setText(row.nameEl, app.name);
    setText(row.detailEl, app.description);
    setText(row.statusEl, statusText);
    row.statusEl.dataset.status = app.errorCount > 0 ? "error" : app.status;
    setText(row.windowsEl, String(app.windows.length));
    setText(row.startedEl, formatDuration(Date.now() - app.startedAt));
    row.startedEl.title = `Started ${new Date(app.startedAt).toLocaleString()}`;
    setText(row.errorsEl, app.errorCount ? String(app.errorCount) : "\u2014");
    row.errorsEl.title = app.lastError ? `Last error: ${app.lastError}` : "";
    row.el.classList.toggle("task-manager__row--error", app.errorCount > 0);
    row.el.setAttribute("aria-expanded", String(expanded));
    row.expander.setAttribute("aria-label", `${expanded ? "Hide" : "Show"} ${app.name} windows`);
    row.expander.classList.toggle("task-manager__expander--open", expanded);
    row.el.classList.toggle("task-manager__row--selected", app.appId === this._selectedAppId);
    row.el.setAttribute("aria-selected", String(app.appId === this._selectedAppId));
    return row;
  }

  /**
   * @param {object} row
   * @param {object} app
   * @param {object} info
   * @returns {HTMLElement}
   */
  _windowRow(row, app, info) {
    let el = row.windowRows.get(info.windowId);
    if (!el) {
      const focus = createElement("button", {
        className: "task-manager__link",
        attrs: { type: "button" },
        text: "Switch to",
        on: { click: () => this.appManager.focusWindow(info.windowId) },
      });
      const toggle = createElement("button", {
        className: "task-manager__link",
        attrs: { type: "button" },
        on: {
          click: () => {
            const minimized = toggle.dataset.minimized === "true";
            if (minimized) this.appManager.restoreWindow(info.windowId);
            else this.appManager.minimizeWindow(info.windowId);
          },
        },
      });
      const close = createElement("button", {
        className: "task-manager__link",
        attrs: { type: "button" },
        text: "Close",
        on: { click: () => this.appManager.closeWindow(info.windowId) },
      });
      el = createElement("tr", {
        className: "task-manager__row task-manager__row--window",
        attrs: { "data-window-id": info.windowId },
        children: [
          createElement("td", { className: "tm-col-name", children: [createElement("span", { className: "task-manager__window-title" })] }),
          createElement("td", { className: "tm-col-status", children: [createElement("span", { className: "task-manager__window-state" })] }),
          createElement("td", { className: "tm-col-actions", attrs: { colspan: "3" }, children: [focus, toggle, close] }),
        ],
      });
      el._parts = { focus, toggle, close };
      row.windowRows.set(info.windowId, el);
    }
    setText(el.querySelector(".task-manager__window-title"), info.title);
    const state = info.minimized ? "Minimized" : info.active ? "Active" : info.maximized ? "Maximized" : "Open";
    setText(el.querySelector(".task-manager__window-state"), state);
    el._parts.toggle.dataset.minimized = String(info.minimized);
    setText(el._parts.toggle, info.minimized ? "Restore" : "Minimize");
    el._parts.focus.setAttribute("aria-label", `Switch to ${info.title}`);
    el._parts.toggle.setAttribute("aria-label", `${info.minimized ? "Restore" : "Minimize"} ${info.title}`);
    el._parts.close.setAttribute("aria-label", `Close ${info.title}`);
    return el;
  }

  /**
   * @param {object[]} apps
   * @returns {void}
   */
  _renderActions(apps) {
    const app = apps.find((candidate) => candidate.appId === this._selectedAppId) ?? null;
    for (const button of [this._switchButton, this._minimizeButton, this._restartButton, this._endButton]) button.disabled = !app;
    if (!app) {
      setText(this._minimizeButton, "Minimize");
      return;
    }
    setText(this._minimizeButton, app.status === "minimized" ? "Restore" : "Minimize");
    this._restartButton.disabled = !app.restartable;
    this._restartButton.title = app.restartable ? `Close and reopen ${app.name}` : `${app.name} can't be restarted`;
    this._endButton.setAttribute("aria-label", `End ${app.name}`);
  }

  /**
   * @param {string} appId
   * @param {{focus?: boolean}} [options]
   * @returns {void}
   */
  _select(appId, { focus = true } = {}) {
    if (this._selectedAppId === appId) return;
    this._selectedAppId = appId;
    this._renderApplications();
    if (focus) this._appRows.get(appId)?.el.focus({ preventScroll: false });
  }

  /**
   * @param {string} appId
   * @returns {void}
   */
  _toggleExpanded(appId) {
    if (this._expanded.has(appId)) this._expanded.delete(appId);
    else this._expanded.add(appId);
    this._renderApplications();
  }

  /**
   * @param {KeyboardEvent} e
   * @returns {void}
   */
  _appKeys(e) {
    const rowEl = e.target.closest?.(".task-manager__row:not(.task-manager__row--window)");
    if (!rowEl || e.target !== rowEl || hasModifierKey(e)) return;
    const ids = [...this._appBody.querySelectorAll(".task-manager__row:not(.task-manager__row--window)")].map((el) => el.dataset.appId);
    const index = ids.indexOf(rowEl.dataset.appId);
    const appId = rowEl.dataset.appId;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = ids[Math.max(0, Math.min(ids.length - 1, index + (e.key === "ArrowDown" ? 1 : -1)))];
      this._select(next);
    } else if (e.key === "ArrowRight" && !this._expanded.has(appId)) {
      e.preventDefault();
      this._toggleExpanded(appId);
    } else if (e.key === "ArrowLeft" && this._expanded.has(appId)) {
      e.preventDefault();
      this._toggleExpanded(appId);
    } else if (e.key === "Enter") {
      e.preventDefault();
      this.appManager.focusApplication(appId);
    } else if (e.key === "Delete") {
      e.preventDefault();
      this._endSelected();
    }
  }

  /** @returns {Promise<void>} */
  async _endSelected() {
    const appId = this._selectedAppId;
    if (!appId) return;
    const app = this.appManager.getApp(appId);
    const name = app?.name ?? appId;
    const warnings = this.appManager.getCloseWarnings(appId);
    if (warnings.length > 0) {
      const confirmed = await showConfirmDialog({
        title: `End ${name}?`,
        message: warnings.join(" "),
        confirmLabel: "End task",
        destructive: true,
      });
      if (!confirmed || this._closed) return;
    }
    this.appManager.endApplication(appId);
  }

  /** @returns {Promise<void>} */
  async _restartSelected() {
    const appId = this._selectedAppId;
    if (!appId) return;
    const name = this.appManager.getApp(appId)?.name ?? appId;
    const warnings = this.appManager.getCloseWarnings(appId);
    if (warnings.length > 0) {
      const confirmed = await showConfirmDialog({
        title: `Restart ${name}?`,
        message: warnings.join(" "),
        confirmLabel: "Restart",
        destructive: true,
      });
      if (!confirmed || this._closed) return;
    }
    const restartingSelf = appId === "task-manager";
    const ok = await this.appManager.restartApplication(appId);
    if (!ok && !restartingSelf && !this._closed) {
      await showMessageDialog({ title: `${name} couldn't be restarted`, message: "Check the notification or the Errors column for details." });
    }
  }

  // ---------------------------------------------------------------
  // Performance
  // ---------------------------------------------------------------

  /** @returns {HTMLElement} */
  _buildPerformancePanel() {
    const metric = (id, label) => {
      const valueEl = createElement("span", { className: "task-manager__metric-value", text: "\u2014" });
      const noteEl = createElement("span", { className: "task-manager__metric-note" });
      this._metricEls.set(id, { valueEl, noteEl });
      return createElement("div", {
        className: "task-manager__metric",
        children: [createElement("span", { className: "task-manager__metric-label", text: label }), valueEl, noteEl],
      });
    };
    const chart = (id, label) => {
      const canvas = createElement("canvas", { className: "task-manager__chart", attrs: { width: "280", height: "64", role: "img", "aria-label": label } });
      this._metricEls.set(`chart:${id}`, { canvas, label });
      return canvas;
    };

    return createElement("section", {
      className: "task-manager__panel task-manager__panel--scroll",
      children: [
        createElement("h2", { className: "task-manager__heading", text: "BrowserOS" }),
        createElement("div", {
          className: "task-manager__metrics",
          children: [
            metric("apps", "Running applications"),
            metric("windows", "Open windows"),
            metric("services", "Background services"),
            metric("timers", "Timers scheduled by services"),
            metric("notifications", "Notifications"),
            metric("errors", "Errors since start"),
            metric("uptime", "Running since"),
            metric("dom", "Page elements"),
            metric("listeners", "Event subscriptions"),
          ],
        }),
        createElement("h2", { className: "task-manager__heading", text: "Reported by the browser" }),
        createElement("p", {
          className: "task-manager__note",
          text: "Measured inside this browser tab. BrowserOS can't read the device's real CPU, memory, or disk usage, so none is shown. Memory and storage figures are the browser's estimates.",
        }),
        createElement("div", {
          className: "task-manager__metrics",
          children: [
            createElement("div", {
              className: "task-manager__metric task-manager__metric--wide",
              children: [
                createElement("span", { className: "task-manager__metric-label", text: "Main-thread delay" }),
                this._metricValue("lag"),
                chart("lag", "Main-thread delay over the last two minutes"),
              ],
            }),
            createElement("div", {
              className: "task-manager__metric task-manager__metric--wide",
              children: [
                createElement("span", { className: "task-manager__metric-label", text: "Frame rate" }),
                this._metricValue("fps"),
                chart("fps", "Frame rate over the last two minutes"),
              ],
            }),
            createElement("div", {
              className: "task-manager__metric task-manager__metric--wide",
              children: [
                createElement("span", { className: "task-manager__metric-label", text: "JavaScript heap (estimate, whole tab)" }),
                this._metricValue("heap"),
                chart("heap", "JavaScript heap use over the last two minutes"),
              ],
            }),
            metric("storage", "Site storage (estimate)"),
            metric("cores", "Logical processors"),
            metric("memory", "Device memory (approximate)"),
          ],
        }),
      ],
    });
  }

  /**
   * @param {string} id
   * @returns {HTMLElement}
   */
  _metricValue(id) {
    const valueEl = createElement("span", { className: "task-manager__metric-value", text: "\u2014" });
    const noteEl = createElement("span", { className: "task-manager__metric-note" });
    this._metricEls.set(id, { valueEl, noteEl });
    return createElement("span", { className: "task-manager__metric-stack", children: [valueEl, noteEl] });
  }

  /** Collect one sample of the charted values. @returns {void} */
  _sample() {
    const { currentLagMs } = appMonitor.getResponsiveness();
    pushSample(this._history.lag, currentLagMs);
    if (this._lastFps !== null) pushSample(this._history.fps, this._lastFps);
    const memory = performance.memory;
    if (memory && Number.isFinite(memory.usedJSHeapSize)) pushSample(this._history.heap, memory.usedJSHeapSize / 1024 ** 2);
    if (this._tab === "performance") storageMonitor.checkQuota();
  }

  /** @returns {void} */
  _renderPerformance() {
    const apps = this.appManager.getRunningApplications();
    const services = serviceManager.getServices();
    const running = services.filter((service) => service.status === "running");
    const timers = running.reduce((sum, service) => sum + service.timers, 0);
    const errors = appMonitor.getErrorCounts();
    const responsiveness = appMonitor.getResponsiveness();
    const startedAt = performance.timeOrigin;

    this._setMetric("apps", String(apps.length));
    this._setMetric("windows", String(apps.reduce((sum, app) => sum + app.windows.length, 0)));
    this._setMetric("services", `${running.length} of ${services.length}`, services.some((s) => s.status === "failed") ? "Some services failed \u2014 see Services" : "running");
    this._setMetric("timers", String(timers), "Alarms, reminders, clock, monitors");
    this._setMetric("notifications", `${notificationService.getUnreadCount()} unread`, `${notificationService.getNotifications().length} in the Notification Center`);
    this._setMetric("errors", String(errors.attributed + errors.system), `${errors.attributed} from applications, ${errors.system} other`);
    this._setMetric("uptime", new Date(startedAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }), formatDuration(Date.now() - startedAt));
    this._setMetric("dom", document.getElementsByTagName("*").length.toLocaleString());
    this._setMetric("listeners", eventBus.getListenerCount().toLocaleString(), "EventBus listeners across BrowserOS");

    if (responsiveness.measuring) {
      const stall = responsiveness.lastStall;
      this._setMetric(
        "lag",
        `${responsiveness.averageLagMs} ms average`,
        stall && Date.now() - stall.at < 120_000
          ? `Unresponsive for ${(stall.durationMs / 1000).toFixed(1)} s at ${new Date(stall.at).toLocaleTimeString()}`
          : `Responsive \u00b7 longest ${responsiveness.maxLagMs} ms in the last minute`
      );
    } else {
      this._setMetric("lag", "Not measured", "The application monitor service is stopped");
    }
    this._setMetric("fps", this._lastFps === null ? "Measuring\u2026" : `${this._lastFps} fps`, "Measured while this tab is shown");

    const memory = performance.memory;
    if (memory && Number.isFinite(memory.usedJSHeapSize)) {
      this._setMetric("heap", `${(memory.usedJSHeapSize / 1024 ** 2).toFixed(1)} MB`, `of ${(memory.jsHeapSizeLimit / 1024 ** 2).toFixed(0)} MB limit`);
    } else {
      this._setMetric("heap", "Not available", "This browser doesn't report it");
    }
    const estimate = storageMonitor.getEstimate();
    this._setMetric("storage", estimate ? formatMegabytes(estimate.usage) : "Not available", estimate ? `of ${formatMegabytes(estimate.quota)} allowed for this site` : "");
    this._setMetric("cores", Number.isFinite(navigator.hardwareConcurrency) ? String(navigator.hardwareConcurrency) : "Not available");
    this._setMetric("memory", Number.isFinite(navigator.deviceMemory) ? `${navigator.deviceMemory} GB` : "Not available", Number.isFinite(navigator.deviceMemory) ? "Rounded by the browser" : "");

    this._drawChart("lag", this._history.lag, { min: 0, unit: "ms" });
    this._drawChart("fps", this._history.fps, { min: 0, max: 60, unit: "fps" });
    this._drawChart("heap", this._history.heap, { min: 0, unit: "MB" });
  }

  /**
   * @param {string} id
   * @param {string} value
   * @param {string} [note]
   * @returns {void}
   */
  _setMetric(id, value, note = "") {
    const parts = this._metricEls.get(id);
    if (!parts) return;
    setText(parts.valueEl, value);
    setText(parts.noteEl, note);
  }

  /**
   * @param {string} id
   * @param {number[]} samples
   * @param {{min: number, max?: number, unit: string}} scale
   * @returns {void}
   */
  _drawChart(id, samples, { min, max, unit }) {
    const parts = this._metricEls.get(`chart:${id}`);
    if (!parts) return;
    const { canvas } = parts;
    const ratio = window.devicePixelRatio || 1;
    const width = canvas.clientWidth || 280;
    const height = canvas.clientHeight || 64;
    if (canvas.width !== Math.round(width * ratio)) canvas.width = Math.round(width * ratio);
    if (canvas.height !== Math.round(height * ratio)) canvas.height = Math.round(height * ratio);
    const ctx = canvas.getContext("2d");
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const styles = getComputedStyle(this._root);
    const stroke = styles.getPropertyValue("--color-accent-primary").trim() || "#7c6cf6";
    const grid = styles.getPropertyValue("--color-surface-glass-border").trim() || "rgba(255,255,255,0.1)";
    ctx.strokeStyle = grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, height - 0.5);
    ctx.lineTo(width, height - 0.5);
    ctx.stroke();
    if (samples.length < 2) return;
    const top = Math.max(max ?? 0, ...samples, min + 1);
    const stepX = width / (HISTORY_LENGTH - 1);
    const offset = HISTORY_LENGTH - samples.length;
    const yFor = (value) => height - 4 - ((value - min) / (top - min)) * (height - 8);
    ctx.beginPath();
    samples.forEach((value, index) => {
      const x = (offset + index) * stepX;
      if (index === 0) ctx.moveTo(x, yFor(value));
      else ctx.lineTo(x, yFor(value));
    });
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1.75;
    ctx.lineJoin = "round";
    ctx.stroke();
    canvas.setAttribute("aria-label", `${parts.label}: latest ${Math.round(samples[samples.length - 1])} ${unit}, peak ${Math.round(Math.max(...samples))} ${unit}`);
  }

  /** @returns {void} */
  _startFps() {
    if (this._fpsRaf !== null || this._paused || this._closed) return;
    this._fpsFrames = 0;
    this._fpsStart = performance.now();
    const loop = (now) => {
      this._fpsFrames += 1;
      const elapsed = now - this._fpsStart;
      if (elapsed >= 1000) {
        this._lastFps = Math.round((this._fpsFrames * 1000) / elapsed);
        this._fpsFrames = 0;
        this._fpsStart = now;
      }
      this._fpsRaf = requestAnimationFrame(loop);
    };
    this._fpsRaf = requestAnimationFrame(loop);
  }

  /** @returns {void} */
  _stopFps() {
    if (this._fpsRaf !== null) cancelAnimationFrame(this._fpsRaf);
    this._fpsRaf = null;
  }

  // ---------------------------------------------------------------
  // Services
  // ---------------------------------------------------------------

  /** @returns {HTMLElement} */
  _buildServicesPanel() {
    this._serviceBody = createElement("tbody");
    this._serviceEmpty = createElement("p", { className: "task-manager__empty", text: "No services match the filter." });
    return createElement("section", {
      className: "task-manager__panel",
      children: [
        createElement("div", {
          className: "task-manager__table-wrap",
          children: [
            createElement("table", {
              className: "task-manager__table task-manager__table--services",
              attrs: { "aria-label": "Background services" },
              children: [
                createElement("thead", {
                  children: [
                    createElement("tr", {
                      children: [
                        createElement("th", { className: "tm-col-name", attrs: { scope: "col" }, text: "Service" }),
                        createElement("th", { className: "tm-col-status", attrs: { scope: "col" }, text: "Status" }),
                        createElement("th", { className: "tm-col-detail", attrs: { scope: "col" }, text: "Details" }),
                        createElement("th", { className: "tm-col-actions", attrs: { scope: "col" }, text: "Actions" }),
                      ],
                    }),
                  ],
                }),
                this._serviceBody,
              ],
            }),
            this._serviceEmpty,
          ],
        }),
        createElement("p", {
          className: "task-manager__note task-manager__note--footer",
          text: "Services run only while BrowserOS is open in this tab. Alarms and reminders that come due while it is closed are handled the next time it starts.",
        }),
      ],
    });
  }

  /** @returns {void} */
  _renderServices() {
    const services = serviceManager.getServices().filter(
      (service) => !this._filter || service.name.toLowerCase().includes(this._filter) || service.description.toLowerCase().includes(this._filter)
    );
    const liveIds = new Set(services.map((service) => service.id));
    for (const [id, row] of this._serviceRows) {
      if (!liveIds.has(id)) {
        row.el.remove();
        this._serviceRows.delete(id);
      }
    }
    const ordered = services.map((service) => this._serviceRow(service).el);
    const current = [...this._serviceBody.children];
    if (current.length !== ordered.length || current.some((el, index) => el !== ordered[index])) {
      this._serviceBody.replaceChildren(...ordered);
    }
    this._serviceEmpty.hidden = services.length > 0;
  }

  /**
   * @param {object} service
   * @returns {object}
   */
  _serviceRow(service) {
    let row = this._serviceRows.get(service.id);
    if (!row) {
      const nameEl = createElement("span", { className: "task-manager__name" });
      const descEl = createElement("span", { className: "task-manager__detail" });
      const statusEl = createElement("span", { className: "task-manager__pill" });
      const detailEl = createElement("td", { className: "tm-col-detail" });
      const start = this._serviceButton("Start", () => this._serviceAction(service.id, "start"));
      const stop = this._serviceButton("Stop", () => this._serviceAction(service.id, "stop"));
      const restart = this._serviceButton("Restart", () => this._serviceAction(service.id, "restart"));
      const el = createElement("tr", {
        className: "task-manager__row",
        attrs: { "data-service-id": service.id },
        children: [
          createElement("td", { className: "tm-col-name", children: [createElement("span", { className: "task-manager__name-wrap", children: [nameEl, descEl] })] }),
          createElement("td", { className: "tm-col-status", children: [statusEl] }),
          detailEl,
          createElement("td", { className: "tm-col-actions", children: [start, stop, restart] }),
        ],
      });
      row = { el, nameEl, descEl, statusEl, detailEl, start, stop, restart };
      this._serviceRows.set(service.id, row);
    }
    setText(row.nameEl, service.name);
    setText(row.descEl, service.description);
    setText(row.statusEl, SERVICE_STATUS_LABELS[service.status] ?? service.status);
    row.statusEl.dataset.status = service.status === "failed" ? "error" : service.status;

    const parts = [];
    if (service.status === "running" && service.summary) parts.push(service.summary);
    if (service.status === "failed" && service.error) parts.push(service.error);
    if (service.dependencies.length) parts.push(`Needs ${service.dependencies.map((id) => serviceManager.getService(id)?.name ?? id).join(", ")}`);
    if (service.startedAt) parts.push(`Running ${formatDuration(Date.now() - service.startedAt)}`);
    setText(row.detailEl, parts.join(" \u00b7 "));

    const busy = service.status === "starting" || service.status === "stopping";
    row.start.hidden = service.status === "running" || busy;
    row.stop.hidden = service.status !== "running";
    row.stop.disabled = service.essential;
    row.stop.title = service.essential ? "Required by BrowserOS \u2014 it can be restarted, not stopped" : "";
    row.restart.disabled = busy || service.status === "stopped";
    for (const [button, verb] of [
      [row.start, "Start"],
      [row.stop, "Stop"],
      [row.restart, "Restart"],
    ]) {
      button.setAttribute("aria-label", `${verb} ${service.name}`);
    }
    return row;
  }

  /**
   * @param {string} label
   * @param {() => void} onClick
   * @returns {HTMLButtonElement}
   */
  _serviceButton(label, onClick) {
    return createElement("button", { className: "task-manager__link", attrs: { type: "button" }, text: label, on: { click: onClick } });
  }

  /**
   * @param {string} id
   * @param {"start"|"stop"|"restart"} action
   * @returns {Promise<void>}
   */
  async _serviceAction(id, action) {
    const service = serviceManager.getService(id);
    if (!service) return;
    try {
      if (action === "stop") {
        const running = service.dependents.map((dependentId) => serviceManager.getService(dependentId)).filter((dependent) => dependent?.status === "running");
        if (running.length > 0) {
          const confirmed = await showConfirmDialog({
            title: `Stop ${service.name}?`,
            message: `${running.map((dependent) => dependent.name).join(", ")} ${running.length === 1 ? "depends" : "depend"} on it and will stop too.`,
            confirmLabel: "Stop",
            destructive: true,
          });
          if (!confirmed || this._closed) return;
        }
        await serviceManager.stop(id);
      } else if (action === "start") {
        await serviceManager.start(id);
      } else {
        await serviceManager.restart(id);
      }
    } catch (error) {
      await showMessageDialog({ title: `Couldn't ${action} ${service.name}`, message: error?.message ?? String(error) });
    }
    this._queueRender();
  }
}

/**
 * @param {HTMLElement} el
 * @param {string} text
 * @returns {void}
 */
function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

/**
 * @param {number[]} list
 * @param {number} value
 * @returns {void}
 */
function pushSample(list, value) {
  list.push(value);
  if (list.length > HISTORY_LENGTH) list.shift();
}

/**
 * @param {number} ms
 * @returns {string} "45 s", "12 min", "3 h 05 min", "2 d 4 h".
 */
function formatDuration(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ${String(minutes % 60).padStart(2, "0")} min`;
  return `${Math.floor(hours / 24)} d ${hours % 24} h`;
}

/**
 * @param {number} bytes
 * @returns {string}
 */
function formatMegabytes(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

/**
 * @param {number} count
 * @param {string} noun
 * @returns {string}
 */
function plural(count, noun) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
