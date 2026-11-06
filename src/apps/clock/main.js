/**
 * @file Clock — world clock, alarms, stopwatch, and timer.
 *
 * All state and scheduling belong to ClockService (src/core/clock/),
 * which runs from boot; this window only renders it and sends commands.
 * Closing the window therefore never stops a running timer, stopwatch,
 * or alarm.
 *
 * Displays are refreshed by one requestAnimationFrame loop that runs
 * only while the window is open (and pauses with the page when it's
 * hidden); the stopwatch repaints every frame while it is visible and
 * running, everything else four times a second. Values are always
 * computed from timestamps by ClockService, never by counting frames.
 */

import { Application } from "../../core/application.js";
import { eventBus } from "../../core/eventBus.js";
import { storage } from "../../core/storage.js";
import { keyboardShortcuts } from "../../core/keyboard/keyboardShortcuts.js";
import { clockService, formatAlarmTime, formatDuration } from "../../core/clock/clockService.js";
import { ALERT_SOUNDS, playAlertSound } from "../../utils/alertSound.js";
import { openDialog } from "../../components/dialog/dialog.js";
import { showConfirmDialog } from "../../components/dialog/confirmDialog.js";
import { showMessageDialog } from "../../components/dialog/messageDialog.js";
import { createElement, clearElement, hasModifierKey } from "../../utils/dom.js";
import { ensureStylesheet } from "../../utils/loadStylesheet.js";
import { searchCities } from "./cities.js";

ensureStylesheet("src/apps/clock/clock.css");

const TABS = Object.freeze([
  { id: "world", label: "World Clock" },
  { id: "alarms", label: "Alarms" },
  { id: "stopwatch", label: "Stopwatch" },
  { id: "timer", label: "Timer" },
]);
const LAST_TAB_KEY = "clock:lastTab";
const SLOW_REFRESH_MS = 250;
const TIMER_PRESETS = [1, 5, 10, 15, 25, 60];
/** Monday-first display order of weekday numbers (0 = Sunday). */
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

export default class ClockApp extends Application {
  constructor(meta) {
    super(meta);
    const saved = storage.get(LAST_TAB_KEY, "world");
    this._tab = TABS.some((tab) => tab.id === saved) ? saved : "world";
    this._cleanups = [];
    this._rafId = null;
    this._lastSlowRefresh = 0;
    this._closed = false;
  }

  /**
   * @param {{tab?: string}} [options]
   * @returns {ReturnType<Application["launch"]>}
   */
  launch(options = {}) {
    if (TABS.some((tab) => tab.id === options.tab)) this._tab = options.tab;
    this._buildDom();
    this._renderTab();

    const on = (name, handler) => this._cleanups.push(eventBus.on(name, handler));
    on("clock:alarmsChanged", () => this._tab === "alarms" && this._renderAlarms());
    on("clock:timerChanged", () => this._tab === "timer" && this._renderTimer());
    on("clock:stopwatchChanged", () => this._tab === "stopwatch" && this._renderStopwatch());
    on("clock:worldClocksChanged", () => this._tab === "world" && this._renderWorld());
    this._loop = (timestamp) => this._tick(timestamp);
    this._rafId = requestAnimationFrame(this._loop);

    return {
      element: this._root,
      title: "Clock",
      icon: "\u23f0",
      width: 560,
      height: 600,
      minWidth: 380,
      minHeight: 440,
      resizable: true,
      minimizable: true,
      maximizable: true,
      closable: true,
    };
  }

  /**
   * @param {{tab?: string}} [options]
   * @returns {void}
   */
  onRelaunch(options = {}) {
    if (TABS.some((tab) => tab.id === options.tab)) this._selectTab(options.tab);
  }

  /** @returns {void} */
  close() {
    this._closed = true;
    cancelAnimationFrame(this._rafId);
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
      className: "clock-app__tabs",
      attrs: { role: "tablist", "aria-label": "Clock sections" },
      children: TABS.map((tab) => {
        const button = createElement("button", {
          className: "clock-app__tab",
          attrs: { type: "button", role: "tab", id: `clock-tab-${tab.id}-${this._instanceKey()}`, "aria-controls": `clock-panel-${this._instanceKey()}` },
          text: tab.label,
          on: {
            click: () => this._selectTab(tab.id),
            keydown: (e) => this._handleTabKeydown(e),
          },
        });
        this._tabButtons.set(tab.id, button);
        return button;
      }),
    });

    this._panel = createElement("div", { className: "clock-app__panel", attrs: { role: "tabpanel", id: `clock-panel-${this._instanceKey()}` } });
    this._root = createElement("div", {
      className: "clock-app",
      children: [tablist, this._panel],
      on: { keydown: (e) => this._handleKeydown(e) },
    });
  }

  /** @returns {string} */
  _instanceKey() {
    if (!this._key) this._key = Math.random().toString(36).slice(2, 8);
    return this._key;
  }

  /**
   * @param {string} tabId
   * @returns {void}
   */
  _selectTab(tabId) {
    this._tab = tabId;
    storage.set(LAST_TAB_KEY, tabId);
    this._renderTab();
    this._tabButtons.get(tabId)?.focus();
  }

  /**
   * @param {KeyboardEvent} e
   * @returns {void}
   */
  _handleTabKeydown(e) {
    if ((e.key !== "ArrowLeft" && e.key !== "ArrowRight") || hasModifierKey(e)) return;
    e.preventDefault();
    const index = TABS.findIndex((tab) => tab.id === this._tab);
    const next = TABS[(index + (e.key === "ArrowRight" ? 1 : -1) + TABS.length) % TABS.length];
    this._selectTab(next.id);
  }

  /** @returns {void} */
  _renderTab() {
    for (const [id, button] of this._tabButtons) {
      const active = id === this._tab;
      button.setAttribute("aria-selected", String(active));
      button.tabIndex = active ? 0 : -1;
      button.classList.toggle("clock-app__tab--active", active);
    }
    this._panel.setAttribute("aria-labelledby", this._tabButtons.get(this._tab).id);
    clearElement(this._panel);
    ({ world: () => this._renderWorld(), alarms: () => this._renderAlarms(), stopwatch: () => this._renderStopwatch(), timer: () => this._renderTimer() })[this._tab]();
  }

  /**
   * @param {number} timestamp
   * @returns {void}
   */
  _tick(timestamp) {
    if (this._closed) return;
    const stopwatchLive = this._tab === "stopwatch" && clockService.getStopwatch().running;
    if (stopwatchLive) this._updateStopwatchDisplay();
    if (timestamp - this._lastSlowRefresh >= SLOW_REFRESH_MS) {
      this._lastSlowRefresh = timestamp;
      if (this._tab === "world") this._updateWorldTimes();
      if (this._tab === "timer") this._updateTimerDisplay();
      if (this._tab === "alarms") this._updateAlarmCountdowns();
    }
    this._rafId = requestAnimationFrame(this._loop);
  }

  /**
   * @param {KeyboardEvent} e
   * @returns {void}
   */
  _handleKeydown(e) {
    if (keyboardShortcuts.isEditableTarget(e.target) || e.target.closest?.("button")) return;
    if (this._tab === "stopwatch") {
      if (keyboardShortcuts.matches(e, "clock.startStop")) {
        e.preventDefault();
        const { running } = clockService.getStopwatch();
        if (running) clockService.pauseStopwatch();
        else clockService.startStopwatch();
      } else if (keyboardShortcuts.matches(e, "clock.lap")) {
        e.preventDefault();
        clockService.lapStopwatch();
      }
    } else if (this._tab === "timer" && keyboardShortcuts.matches(e, "clock.startStop")) {
      e.preventDefault();
      const timer = clockService.getTimer();
      if (timer.status === "running") clockService.pauseTimer();
      else if (timer.status === "paused") clockService.resumeTimer();
    }
  }

  // ---------------------------------------------------------------
  // World clock
  // ---------------------------------------------------------------

  /** @returns {void} */
  _renderWorld() {
    clearElement(this._panel);
    const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    this._localTimeEl = createElement("p", { className: "clock-app__big-time" });
    this._localDateEl = createElement("p", { className: "clock-app__big-date" });
    const local = createElement("section", {
      className: "clock-app__hero",
      attrs: { "aria-label": "Local time" },
      children: [this._localTimeEl, this._localDateEl, createElement("p", { className: "clock-app__zone", text: localZone.replace(/_/g, " ") })],
    });

    const suggestions = createElement("div", { className: "clock-app__suggestions", attrs: { role: "listbox", "aria-label": "Matching cities" } });
    suggestions.hidden = true;
    const search = createElement("input", {
      className: "clock-app__input",
      attrs: { type: "search", placeholder: "Add a city or time zone", "aria-label": "Search for a city to add", autocomplete: "off" },
      on: {
        input: () => this._renderSuggestions(search, suggestions),
        keydown: (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            suggestions.querySelector("button")?.click();
          } else if (e.key === "ArrowDown" && !hasModifierKey(e)) {
            e.preventDefault();
            suggestions.querySelector("button")?.focus();
          }
        },
      },
    });

    this._worldListEl = createElement("ul", { className: "clock-app__list", attrs: { "aria-label": "World clocks" } });
    this._panel.append(
      local,
      createElement("div", { className: "clock-app__search", children: [search, suggestions] }),
      this._worldListEl
    );
    this._renderWorldList();
    this._updateWorldTimes();
  }

  /**
   * @param {HTMLInputElement} input
   * @param {HTMLElement} container
   * @returns {void}
   */
  _renderSuggestions(input, container) {
    clearElement(container);
    const matches = searchCities(input.value);
    container.hidden = matches.length === 0 && !input.value.trim();
    if (!input.value.trim()) return;
    if (matches.length === 0) {
      container.append(createElement("p", { className: "clock-app__empty", attrs: { role: "status" }, text: "No matching cities or time zones" }));
      return;
    }
    for (const match of matches) {
      container.append(
        createElement("button", {
          className: "clock-app__suggestion",
          attrs: { type: "button", role: "option" },
          children: [
            createElement("span", { className: "clock-app__suggestion-city", text: match.city }),
            createElement("span", { className: "clock-app__suggestion-zone", text: `${match.country} \u00b7 ${zoneTime(match.timeZone)}` }),
          ],
          on: {
            click: () => {
              try {
                clockService.addWorldClock(match.city, match.timeZone);
              } catch (error) {
                showMessageDialog({ title: "Couldn't add city", message: error.message });
              }
              input.value = "";
              this._renderSuggestions(input, container);
              input.focus();
            },
            keydown: (e) => {
              if (hasModifierKey(e)) return;
              if (e.key === "ArrowDown") {
                e.preventDefault();
                e.currentTarget.nextElementSibling?.focus();
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                (e.currentTarget.previousElementSibling ?? input).focus();
              }
            },
          },
        })
      );
    }
  }

  /** @returns {void} */
  _renderWorldList() {
    clearElement(this._worldListEl);
    this._worldRows = [];
    const clocks = clockService.getWorldClocks();
    if (clocks.length === 0) {
      this._worldListEl.append(createElement("li", { className: "clock-app__empty", text: "No cities yet. Search above to add one." }));
      return;
    }
    for (const clock of clocks) {
      const timeEl = createElement("span", { className: "clock-app__row-time" });
      const detailEl = createElement("span", { className: "clock-app__row-detail" });
      const iconEl = createElement("span", { className: "clock-app__row-icon", attrs: { "aria-hidden": "true" } });
      this._worldRows.push({ clock, timeEl, detailEl, iconEl });
      this._worldListEl.append(
        createElement("li", {
          className: "clock-app__row",
          children: [
            iconEl,
            createElement("div", {
              className: "clock-app__row-text",
              children: [createElement("span", { className: "clock-app__row-title", text: clock.city }), detailEl],
            }),
            timeEl,
            createElement("button", {
              className: "clock-app__icon-button",
              attrs: { type: "button", "aria-label": `Remove ${clock.city}` },
              text: "\u2715",
              on: { click: () => clockService.removeWorldClock(clock.id) },
            }),
          ],
        })
      );
    }
  }

  /** @returns {void} */
  _updateWorldTimes() {
    if (!this._localTimeEl?.isConnected) return;
    const now = new Date();
    this._localTimeEl.textContent = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(now);
    this._localDateEl.textContent = new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(now);
    for (const row of this._worldRows ?? []) {
      const { timeZone } = row.clock;
      row.timeEl.textContent = zoneTime(timeZone, now);
      const hour = Number(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone }).format(now));
      row.iconEl.textContent = hour >= 6 && hour < 18 ? "\u2600" : "\u263e";
      row.detailEl.textContent = `${relativeDay(now, timeZone)} \u00b7 ${offsetLabel(now, timeZone)}`;
    }
  }

  // ---------------------------------------------------------------
  // Alarms
  // ---------------------------------------------------------------

  /** @returns {void} */
  _renderAlarms() {
    clearElement(this._panel);
    const header = createElement("div", {
      className: "clock-app__section-header",
      children: [
        createElement("h2", { className: "clock-app__section-title", text: "Alarms" }),
        createElement("button", { className: "clock-app__button clock-app__button--primary", attrs: { type: "button" }, text: "+ Add alarm", on: { click: () => this._editAlarm(null) } }),
      ],
    });
    const list = createElement("ul", { className: "clock-app__list", attrs: { "aria-label": "Alarms" } });
    this._alarmCountdowns = [];
    const alarms = clockService.getAlarms();
    if (alarms.length === 0) list.append(createElement("li", { className: "clock-app__empty", text: "No alarms. Add one to get started." }));

    for (const alarm of alarms) {
      const countdown = createElement("span", { className: "clock-app__row-detail" });
      this._alarmCountdowns.push({ alarm, el: countdown });
      const toggle = createElement("button", {
        className: "clock-app__switch",
        attrs: { type: "button", role: "switch", "aria-checked": String(alarm.enabled), "aria-label": `${alarm.label || "Alarm"} at ${formatAlarmTime(alarm.time)}` },
        children: [createElement("span", { className: "clock-app__switch-thumb" })],
        on: { click: () => clockService.updateAlarm(alarm.id, { enabled: !alarm.enabled }) },
      });
      list.append(
        createElement("li", {
          className: `clock-app__row clock-app__alarm${alarm.enabled ? "" : " clock-app__alarm--off"}`,
          children: [
            createElement("div", {
              className: "clock-app__row-text",
              children: [
                createElement("span", { className: "clock-app__alarm-time", text: formatAlarmTime(alarm.time) }),
                createElement("span", { className: "clock-app__row-title", text: `${alarm.label || "Alarm"} \u00b7 ${describeDays(alarm.days)}` }),
                countdown,
              ],
            }),
            toggle,
            createElement("button", { className: "clock-app__icon-button", attrs: { type: "button", "aria-label": `Edit ${alarm.label || "alarm"}` }, text: "\u270e", on: { click: () => this._editAlarm(alarm) } }),
            createElement("button", { className: "clock-app__icon-button", attrs: { type: "button", "aria-label": `Delete ${alarm.label || "alarm"}` }, text: "\u2715", on: { click: () => this._deleteAlarm(alarm) } }),
          ],
        })
      );
    }
    this._panel.append(
      header,
      list,
      createElement("p", { className: "clock-app__note", text: "Alarms ring while BrowserOS is open, even when Clock is closed." })
    );
    this._updateAlarmCountdowns();
  }

  /** @returns {void} */
  _updateAlarmCountdowns() {
    const now = Date.now();
    for (const { alarm, el } of this._alarmCountdowns ?? []) {
      const next = clockService.nextTrigger(alarm, now);
      el.textContent = next === null ? "Off" : `Rings in ${humanizeDelay(next - now)}`;
    }
  }

  /**
   * @param {object|null} alarm
   * @returns {Promise<void>}
   */
  async _editAlarm(alarm) {
    const timeInput = createElement("input", { className: "dialog__input", attrs: { type: "time", id: `alarm-time-${this._instanceKey()}`, required: "" } });
    timeInput.value = alarm?.time ?? nextRoundTime();
    const labelInput = createElement("input", { className: "dialog__input", attrs: { type: "text", id: `alarm-label-${this._instanceKey()}`, maxlength: "60", placeholder: "Alarm" } });
    labelInput.value = alarm?.label ?? "";
    const soundSelect = createElement("select", {
      className: "dialog__select",
      attrs: { id: `alarm-sound-${this._instanceKey()}` },
      children: ALERT_SOUNDS.map((sound) => createElement("option", { attrs: { value: sound.id }, text: sound.label })),
    });
    soundSelect.value = alarm?.sound ?? "chime";
    const days = new Set(alarm?.days ?? []);
    const dayToggles = createElement("div", {
      className: "clock-app__days",
      attrs: { role: "group", "aria-label": "Repeat on" },
      children: WEEK_ORDER.map((day) => {
        const input = createElement("input", { className: "clock-app__day-input", attrs: { type: "checkbox", value: String(day) } });
        input.checked = days.has(day);
        return createElement("label", {
          className: "clock-app__day",
          children: [input, createElement("span", { text: new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(new Date(2024, 0, 7 + day)) })],
        });
      }),
    });
    const errorEl = createElement("p", { className: "dialog__error", attrs: { role: "alert" } });
    const field = (label, control) =>
      createElement("div", { className: "dialog__field", children: [createElement("label", { className: "dialog__label", attrs: { for: control.id }, text: label }), control] });

    const body = createElement("div", {
      className: "dialog__form",
      children: [
        field("Time", timeInput),
        field("Label", labelInput),
        createElement("div", { className: "dialog__field", children: [createElement("span", { className: "dialog__label", text: "Repeat" }), dayToggles] }),
        createElement("div", {
          className: "dialog__form-row",
          children: [
            field("Sound", soundSelect),
            createElement("div", {
              className: "dialog__field clock-app__preview-field",
              children: [
                createElement("button", {
                  className: "dialog__button dialog__button--default",
                  attrs: { type: "button" },
                  text: "\u25b6 Preview",
                  on: { click: () => playAlertSound(soundSelect.value) },
                }),
              ],
            }),
          ],
        }),
        errorEl,
      ],
    });

    let data = null;
    const result = await openDialog({
      title: alarm ? "Edit alarm" : "New alarm",
      bodyElement: body,
      initialFocus: timeInput,
      submitValue: "save",
      buttons: [
        { label: "Cancel", value: null, variant: "default" },
        { label: "Save", value: "save", variant: "primary" },
      ],
      onBeforeClose: () => {
        if (!/^\d{2}:\d{2}$/.test(timeInput.value)) {
          errorEl.textContent = "Choose a time.";
          return false;
        }
        data = {
          time: timeInput.value,
          label: labelInput.value,
          sound: soundSelect.value,
          days: [...dayToggles.querySelectorAll("input:checked")].map((input) => Number(input.value)),
          enabled: true,
        };
        return true;
      },
    });
    if (result !== "save" || !data) return;
    try {
      if (alarm) clockService.updateAlarm(alarm.id, data);
      else clockService.addAlarm(data);
    } catch (error) {
      await showMessageDialog({ title: "Couldn't save alarm", message: error.message });
    }
  }

  /**
   * @param {object} alarm
   * @returns {Promise<void>}
   */
  async _deleteAlarm(alarm) {
    const confirmed = await showConfirmDialog({
      title: "Delete alarm?",
      message: `The ${formatAlarmTime(alarm.time)} alarm${alarm.label ? ` "${alarm.label}"` : ""} will be removed.`,
      confirmLabel: "Delete",
      destructive: true,
    });
    if (confirmed) clockService.removeAlarm(alarm.id);
  }

  // ---------------------------------------------------------------
  // Stopwatch
  // ---------------------------------------------------------------

  /** @returns {void} */
  _renderStopwatch() {
    clearElement(this._panel);
    const state = clockService.getStopwatch();
    this._stopwatchEl = createElement("p", { className: "clock-app__big-time clock-app__big-time--mono", attrs: { role: "timer", "aria-live": "off" } });
    const primary = createElement("button", {
      className: "clock-app__button clock-app__button--primary clock-app__button--large",
      attrs: { type: "button" },
      text: state.running ? "Pause" : state.elapsedMs > 0 ? "Resume" : "Start",
      on: { click: () => (clockService.getStopwatch().running ? clockService.pauseStopwatch() : clockService.startStopwatch()) },
    });
    const lap = createElement("button", {
      className: "clock-app__button clock-app__button--large",
      attrs: { type: "button" },
      text: "Lap",
      on: { click: () => clockService.lapStopwatch() },
    });
    lap.disabled = !state.running;
    const reset = createElement("button", {
      className: "clock-app__button clock-app__button--large",
      attrs: { type: "button" },
      text: "Reset",
      on: { click: () => clockService.resetStopwatch() },
    });
    reset.disabled = state.running || state.elapsedMs === 0;

    this._panel.append(
      createElement("section", { className: "clock-app__hero", attrs: { "aria-label": "Stopwatch" }, children: [this._stopwatchEl] }),
      createElement("div", { className: "clock-app__controls", children: [reset, primary, lap] }),
      this._buildLaps(state.laps)
    );
    this._updateStopwatchDisplay();
  }

  /**
   * @param {number[]} laps - Cumulative lap times.
   * @returns {HTMLElement}
   */
  _buildLaps(laps) {
    const splits = laps.map((total, index) => total - (laps[index - 1] ?? 0));
    const fastest = splits.length >= 2 ? Math.min(...splits) : null;
    const slowest = splits.length >= 2 ? Math.max(...splits) : null;
    const rows = splits
      .map((split, index) => {
        const marker = split === fastest ? " clock-app__lap--fastest" : split === slowest ? " clock-app__lap--slowest" : "";
        return createElement("tr", {
          className: `clock-app__lap${marker}`,
          children: [
            createElement("td", { text: `Lap ${index + 1}` }),
            createElement("td", { text: formatDuration(split, { centiseconds: true }) }),
            createElement("td", { text: formatDuration(laps[index], { centiseconds: true }) }),
          ],
        });
      })
      .reverse();
    if (rows.length === 0) return createElement("p", { className: "clock-app__note", text: "Press Lap while running to record split times." });
    return createElement("table", {
      className: "clock-app__laps",
      children: [
        createElement("thead", { children: [createElement("tr", { children: ["Lap", "Split", "Total"].map((text) => createElement("th", { attrs: { scope: "col" }, text })) })] }),
        createElement("tbody", { children: rows }),
      ],
    });
  }

  /** @returns {void} */
  _updateStopwatchDisplay() {
    if (!this._stopwatchEl?.isConnected) return;
    this._stopwatchEl.textContent = formatDuration(clockService.getStopwatch().elapsedMs, { centiseconds: true });
  }

  // ---------------------------------------------------------------
  // Timer
  // ---------------------------------------------------------------

  /** @returns {void} */
  _renderTimer() {
    clearElement(this._panel);
    const timer = clockService.getTimer();
    if (timer.status === "idle") {
      this._renderTimerSetup(timer);
      return;
    }

    this._timerEl = createElement("p", { className: "clock-app__big-time clock-app__big-time--mono", attrs: { role: "timer", "aria-live": "off" } });
    this._timerBar = createElement("div", { className: "clock-app__progress-fill" });
    this._timerProgress = createElement("div", {
      className: "clock-app__progress",
      attrs: { role: "progressbar", "aria-label": "Time remaining", "aria-valuemin": "0", "aria-valuemax": String(Math.round(timer.durationMs / 1000)) },
      children: [this._timerBar],
    });
    const finished = timer.status === "finished";
    const primary = createElement("button", {
      className: "clock-app__button clock-app__button--primary clock-app__button--large",
      attrs: { type: "button" },
      text: finished ? "Restart" : timer.status === "running" ? "Pause" : "Resume",
      on: {
        click: () => {
          const current = clockService.getTimer();
          if (current.status === "running") clockService.pauseTimer();
          else if (current.status === "paused") clockService.resumeTimer();
          else clockService.startTimer(current.durationMs);
        },
      },
    });
    const reset = createElement("button", { className: "clock-app__button clock-app__button--large", attrs: { type: "button" }, text: "Reset", on: { click: () => clockService.resetTimer() } });

    this._panel.append(
      createElement("section", {
        className: "clock-app__hero",
        attrs: { "aria-label": "Timer" },
        children: [
          createElement("p", { className: "clock-app__zone", text: finished ? "Time's up" : `${formatDuration(timer.durationMs)} timer${timer.status === "paused" ? " \u00b7 paused" : ""}` }),
          this._timerEl,
          this._timerProgress,
        ],
      }),
      createElement("div", { className: "clock-app__controls", children: [reset, primary] }),
      createElement("p", { className: "clock-app__note", text: "The timer keeps running if you close Clock, and alerts you when it ends." })
    );
    this._updateTimerDisplay();
  }

  /**
   * @param {object} timer
   * @returns {void}
   */
  _renderTimerSetup(timer) {
    const total = Math.round(timer.durationMs / 1000);
    const numberField = (label, value, max) => {
      const input = createElement("input", {
        className: "clock-app__time-input",
        attrs: { type: "number", min: "0", max: String(max), step: "1", "aria-label": label, inputmode: "numeric" },
      });
      input.value = String(value);
      return { input, el: createElement("label", { className: "clock-app__time-field", children: [input, createElement("span", { text: label })] }) };
    };
    const hours = numberField("Hours", Math.floor(total / 3600), 99);
    const minutes = numberField("Minutes", Math.floor((total % 3600) / 60), 59);
    const seconds = numberField("Seconds", total % 60, 59);
    const errorEl = createElement("p", { className: "dialog__error", attrs: { role: "alert" } });

    const start = () => {
      const values = [hours, minutes, seconds].map(({ input }) => Number.parseInt(input.value || "0", 10));
      if (values.some((value) => !Number.isInteger(value) || value < 0) || values[1] > 59 || values[2] > 59) {
        errorEl.textContent = "Enter whole numbers: minutes and seconds go up to 59.";
        return;
      }
      try {
        clockService.startTimer((values[0] * 3600 + values[1] * 60 + values[2]) * 1000);
      } catch (error) {
        errorEl.textContent = error.message;
      }
    };
    for (const { input } of [hours, minutes, seconds]) {
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          start();
        }
      });
    }

    this._panel.append(
      createElement("section", {
        className: "clock-app__hero",
        attrs: { "aria-label": "Set timer" },
        children: [createElement("div", { className: "clock-app__time-fields", children: [hours.el, minutes.el, seconds.el] }), errorEl],
      }),
      createElement("div", {
        className: "clock-app__presets",
        attrs: { role: "group", "aria-label": "Presets" },
        children: TIMER_PRESETS.map((value) =>
          createElement("button", {
            className: "clock-app__chip",
            attrs: { type: "button" },
            text: value === 60 ? "1 h" : `${value} min`,
            on: { click: () => clockService.startTimer(value * 60_000) },
          })
        ),
      }),
      createElement("div", {
        className: "clock-app__controls",
        children: [createElement("button", { className: "clock-app__button clock-app__button--primary clock-app__button--large", attrs: { type: "button" }, text: "Start", on: { click: start } })],
      })
    );
  }

  /** @returns {void} */
  _updateTimerDisplay() {
    if (!this._timerEl?.isConnected) return;
    const timer = clockService.getTimer();
    this._timerEl.textContent = formatDuration(timer.remainingMs);
    const fraction = timer.durationMs > 0 ? timer.remainingMs / timer.durationMs : 0;
    this._timerBar.style.transform = `scaleX(${Math.max(0, Math.min(1, fraction))})`;
    this._timerProgress.setAttribute("aria-valuenow", String(Math.ceil(timer.remainingMs / 1000)));
    this._timerProgress.setAttribute("aria-valuetext", `${formatDuration(timer.remainingMs)} remaining`);
  }
}

/**
 * @param {string} timeZone
 * @param {Date} [date]
 * @returns {string}
 */
function zoneTime(timeZone, date = new Date()) {
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", timeZone }).format(date);
}

/**
 * @param {Date} now
 * @param {string} timeZone
 * @returns {string} "Today", "Tomorrow", or "Yesterday" relative to local time.
 */
function relativeDay(now, timeZone) {
  const key = (zone) => new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: zone }).format(now);
  const there = key(timeZone);
  const here = key(undefined);
  if (there === here) return "Today";
  return there > here ? "Tomorrow" : "Yesterday";
}

/**
 * Offset of a zone relative to local time, from the browser's time-zone
 * data, so daylight-saving changes are reflected automatically.
 * @param {Date} now
 * @param {string} timeZone
 * @returns {string} e.g. "+3 h", "−5 h 30 min", "Same time".
 */
function offsetLabel(now, timeZone) {
  const zoneOffset = (zone) => {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" }).formatToParts(now);
    const get = (type) => Number(parts.find((part) => part.type === type).value);
    return (Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute")) - Math.floor(now.getTime() / 60000) * 60000) / 60000;
  };
  const difference = zoneOffset(timeZone) + now.getTimezoneOffset();
  if (difference === 0) return "Same time";
  const sign = difference > 0 ? "+" : "\u2212";
  const absolute = Math.abs(difference);
  const hours = Math.floor(absolute / 60);
  const minutes = absolute % 60;
  return `${sign}${hours} h${minutes ? ` ${minutes} min` : ""}`;
}

/**
 * @param {number[]} days
 * @returns {string}
 */
function describeDays(days) {
  if (days.length === 0) return "Once";
  if (days.length === 7) return "Every day";
  const sorted = WEEK_ORDER.filter((day) => days.includes(day));
  if (sorted.join() === "1,2,3,4,5") return "Weekdays";
  if (sorted.join() === "6,0") return "Weekends";
  return sorted.map((day) => new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(new Date(2024, 0, 7 + day))).join(", ");
}

/**
 * @param {number} ms
 * @returns {string}
 */
function humanizeDelay(ms) {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return `${hours} h${rest ? ` ${rest} min` : ""}`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ${hours % 24} h`;
}

/**
 * @returns {string} "HH:MM" for the next whole quarter hour.
 */
function nextRoundTime() {
  const date = new Date(Date.now() + 15 * 60_000);
  date.setMinutes(Math.floor(date.getMinutes() / 15) * 15);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}
