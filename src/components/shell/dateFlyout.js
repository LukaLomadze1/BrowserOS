/**
 * @file DateFlyout — the date panel opened from the taskbar clock.
 *
 * Shows the current time and date and a compact month calendar with
 * previous / next navigation and today highlighted. Days with Calendar
 * events carry a dot (read from CalendarService — this panel never
 * edits events). Choosing a day, or "Open Calendar", opens the full
 * Calendar application at that date.
 */

import { createElement } from "../../utils/dom.js";
import { createIconElement } from "../../utils/icons.js";
import { eventBus } from "../../core/eventBus.js";
import { settingsService } from "../../core/settings/settingsService.js";
import { formatClockTime } from "../../core/shell/systemClock.js";
import { addDays, addMonthsRaw, isSameDay, startOfMonth, startOfWeek, toDateKey } from "../../core/calendar/calendarTime.js";

const WEEK_LENGTH = 7;
const GRID_DAYS = 42;

export class DateFlyout {
  /**
   * @param {object} deps
   * @param {(date: string) => void} deps.openCalendar - Open the Calendar app at a "YYYY-MM-DD" date.
   * @param {() => void} deps.requestClose
   * @param {{getOccurrences: (from: Date, to: Date) => Array<{start: Date, dateKey: string}>}|null} [deps.calendarService]
   */
  constructor({ openCalendar, requestClose, calendarService = null }) {
    this._openCalendar = openCalendar;
    this._requestClose = requestClose;
    this._calendarService = calendarService;
    this._month = startOfMonth(new Date());
    this._visible = false;
    this._cleanups = [];

    this._timeEl = createElement("p", { className: "date-flyout__time" });
    this._dateEl = createElement("p", { className: "date-flyout__date" });
    this._monthEl = createElement("h3", { className: "date-flyout__month", attrs: { "aria-live": "polite" } });
    this._gridEl = createElement("div", { className: "date-flyout__grid", attrs: { role: "grid" } });
    this._summaryEl = createElement("p", { className: "date-flyout__summary" });

    const weekdays = createElement("div", {
      className: "date-flyout__weekdays",
      attrs: { role: "row" },
      children: Array.from({ length: WEEK_LENGTH }, (_, index) => {
        const day = addDays(startOfWeek(new Date()), index);
        return createElement("span", {
          className: "date-flyout__weekday",
          attrs: { role: "columnheader", "aria-label": day.toLocaleDateString(undefined, { weekday: "long" }) },
          text: day.toLocaleDateString(undefined, { weekday: "narrow" }),
        });
      }),
    });

    this._el = createElement("div", {
      className: "date-flyout",
      children: [
        createElement("header", { className: "date-flyout__header", children: [this._timeEl, this._dateEl] }),
        createElement("div", {
          className: "date-flyout__nav",
          children: [
            this._monthEl,
            createElement("button", {
              className: "shell-text-button",
              attrs: { type: "button" },
              text: "Today",
              on: { click: () => this._showMonth(new Date(), true) },
            }),
            createElement("button", {
              className: "shell-icon-button",
              attrs: { type: "button", "aria-label": "Previous month", title: "Previous month" },
              children: [createIconElement("icon:chevronLeft")],
              on: { click: () => this._step(-1) },
            }),
            createElement("button", {
              className: "shell-icon-button",
              attrs: { type: "button", "aria-label": "Next month", title: "Next month" },
              children: [createIconElement("icon:chevronRight")],
              on: { click: () => this._step(1) },
            }),
          ],
        }),
        weekdays,
        this._gridEl,
        this._summaryEl,
        createElement("footer", {
          className: "shell-panel__footer",
          children: [
            createElement("button", {
              className: "shell-text-button",
              attrs: { type: "button" },
              children: [createIconElement("icon:calendar"), createElement("span", { text: "Open Calendar" })],
              on: { click: () => this._open(toDateKey(new Date())) },
            }),
          ],
        }),
      ],
    });
    this._gridEl.setAttribute("aria-labelledby", this._monthEl.id = `date-flyout-month-${Math.random().toString(36).slice(2, 8)}`);

    this._cleanups.push(
      eventBus.on("system:clockTick", () => {
        if (!this._visible) return;
        this._renderClock();
        // Crossing midnight moves the "today" highlight.
        this._renderGrid();
      }),
      eventBus.on("calendar:changed", () => {
        if (this._visible) this._renderGrid();
      }),
      settingsService.subscribeCategory("taskbar", () => {
        if (this._visible) this._renderClock();
      })
    );
  }

  /** @returns {HTMLElement} */
  getElement() {
    return this._el;
  }

  /** @returns {HTMLElement|null} */
  getInitialFocus() {
    return this._gridEl.querySelector(".date-flyout__day--today") ?? this._gridEl.querySelector("button");
  }

  /** @returns {void} */
  onOpen() {
    this._visible = true;
    this._month = startOfMonth(new Date());
    this._renderClock();
    this._renderGrid();
  }

  /** @returns {void} */
  onClose() {
    this._visible = false;
  }

  /** @returns {void} */
  destroy() {
    for (const cleanup of this._cleanups) cleanup();
    this._cleanups = [];
  }

  // ---------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------

  /** @returns {void} */
  _renderClock() {
    const now = new Date();
    this._timeEl.textContent = formatClockTime(now, { format: settingsService.get("taskbar.clockFormat"), seconds: true });
    this._dateEl.textContent = now.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  }

  /**
   * @param {number} months
   * @returns {void}
   */
  _step(months) {
    this._month = startOfMonth(addMonthsRaw(this._month, months));
    this._renderGrid();
  }

  /**
   * @param {Date} date
   * @param {boolean} [focusToday]
   * @returns {void}
   */
  _showMonth(date, focusToday = false) {
    this._month = startOfMonth(date);
    this._renderGrid();
    if (focusToday) this._gridEl.querySelector(".date-flyout__day--today")?.focus();
  }

  /** @returns {void} */
  _renderGrid() {
    const today = new Date();
    const first = startOfWeek(this._month);
    const last = addDays(first, GRID_DAYS);
    this._monthEl.textContent = this._month.toLocaleDateString(undefined, { month: "long", year: "numeric" });

    const counts = new Map();
    try {
      for (const occurrence of this._calendarService?.getOccurrences(first, last) ?? []) {
        counts.set(occurrence.dateKey, (counts.get(occurrence.dateKey) ?? 0) + 1);
      }
    } catch {
      // Calendar data still loading or unavailable: show the month without dots.
    }

    const rows = [];
    for (let week = 0; week < GRID_DAYS / WEEK_LENGTH; week += 1) {
      const cells = [];
      for (let day = 0; day < WEEK_LENGTH; day += 1) {
        const date = addDays(first, week * WEEK_LENGTH + day);
        const key = toDateKey(date);
        const events = counts.get(key) ?? 0;
        const isToday = isSameDay(date, today);
        const outside = date.getMonth() !== this._month.getMonth();
        const label = `${date.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}${isToday ? ", today" : ""}${
          events ? `, ${events} event${events === 1 ? "" : "s"}` : ""
        }`;
        cells.push(
          createElement("button", {
            className: [
              "date-flyout__day",
              isToday ? "date-flyout__day--today" : "",
              outside ? "date-flyout__day--outside" : "",
              events ? "date-flyout__day--events" : "",
            ]
              .filter(Boolean)
              .join(" "),
            attrs: { type: "button", role: "gridcell", "aria-label": label, "aria-current": isToday ? "date" : null, "data-date": key },
            text: String(date.getDate()),
            on: {
              click: () => this._open(key),
              keydown: (e) => this._gridKeys(e, date),
            },
          })
        );
      }
      rows.push(createElement("div", { className: "date-flyout__row", attrs: { role: "row" }, children: cells }));
    }
    this._gridEl.replaceChildren(...rows);

    const todayCount = counts.get(toDateKey(today)) ?? 0;
    this._summaryEl.textContent = todayCount ? `${todayCount} event${todayCount === 1 ? "" : "s"} today` : "No events today";
    this._summaryEl.hidden = !this._calendarService;
  }

  /**
   * Arrow keys move by day / week; Page Up / Down by month.
   * @param {KeyboardEvent} e
   * @param {Date} date
   * @returns {void}
   */
  _gridKeys(e, date) {
    const deltas = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    let target = null;
    if (e.key in deltas && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) target = addDays(date, deltas[e.key]);
    else if (e.key === "PageUp") target = addMonthsRaw(date, -1);
    else if (e.key === "PageDown") target = addMonthsRaw(date, 1);
    if (!target) return;
    e.preventDefault();
    if (target.getMonth() !== this._month.getMonth() || target.getFullYear() !== this._month.getFullYear()) {
      this._month = startOfMonth(target);
      this._renderGrid();
    }
    this._gridEl.querySelector(`[data-date="${toDateKey(target)}"]`)?.focus();
  }

  /**
   * @param {string} dateKey
   * @returns {void}
   */
  _open(dateKey) {
    this._requestClose();
    this._openCalendar(dateKey);
  }
}
