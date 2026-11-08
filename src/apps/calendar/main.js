/**
 * @file Calendar — month, week, and day views over CalendarService.
 *
 * The app stores nothing itself: events, recurrence, persistence, and
 * reminders belong to CalendarService (src/core/calendar/), which runs
 * from boot. The window re-renders whenever the service reports a
 * change ("calendar:changed") or the theme changes (event colors are
 * per-theme accent presets).
 *
 * Interaction:
 *  - Month view: click a day to select it, double-click (or its "+"
 *    button, or Enter) to add an event; arrow keys move between days.
 *  - Week/day views: click an empty time slot to add an event there.
 *  - Click an event to see its details; edit or delete from the panel.
 *    For recurring events, edits and deletions apply to one occurrence
 *    or the whole series.
 *
 * Launch options: { date: "YYYY-MM-DD", eventId } (used by reminder
 * notifications) open the calendar on that date with the event shown.
 */

import { Application } from "../../core/application.js";
import { eventBus } from "../../core/eventBus.js";
import { themeManager } from "../../core/theme.js";
import { keyboardShortcuts } from "../../core/keyboard/keyboardShortcuts.js";
import { calendarService } from "../../core/calendar/calendarService.js";
import { describeRecurrence, eventBounds, expandEvent } from "../../core/calendar/recurrence.js";
import {
  toDateKey,
  parseDateKey,
  toDateTimeString,
  addDays,
  startOfWeek,
  startOfMonth,
  startOfDay,
  isSameDay,
  minutesOfDay,
  formatDate,
  formatTime,
  MINUTES_PER_DAY,
} from "../../core/calendar/calendarTime.js";
import { getAccentPreset } from "../../core/settings/accentPresets.js";
import { openDialog } from "../../components/dialog/dialog.js";
import { showConfirmDialog } from "../../components/dialog/confirmDialog.js";
import { showMessageDialog } from "../../components/dialog/messageDialog.js";
import { createElement, clearElement, hasModifierKey } from "../../utils/dom.js";
import { ensureStylesheet } from "../../utils/loadStylesheet.js";
import { showEventDialog } from "./eventDialog.js";

ensureStylesheet("src/apps/calendar/calendar.css");

const HOUR_HEIGHT = 48;
const MAX_MONTH_CHIPS = 3;
const SLOT_MINUTES = 30;
const DEFAULT_SCROLL_HOUR = 8;
const REMINDER_TEXT = { 0: "At start time", 5: "5 minutes before", 10: "10 minutes before", 15: "15 minutes before", 30: "30 minutes before", 60: "1 hour before", 1440: "1 day before" };

export default class CalendarApp extends Application {
  constructor(meta) {
    super(meta);
    this._view = "month";
    this._cursor = startOfDay(new Date());
    this._selectedDate = toDateKey(this._cursor);
    /** @type {{eventId: string, dateKey: string}|null} */
    this._selected = null;
    this._cleanups = [];
    this._nowTimerId = null;
    this._scrollHour = DEFAULT_SCROLL_HOUR;
  }

  /**
   * @param {{date?: string, eventId?: string}} [options]
   * @returns {ReturnType<Application["launch"]>}
   */
  launch(options = {}) {
    this._buildDom();
    this._applyLaunchOptions(options);
    this._renderLoading();

    calendarService.ready().then(
      () => {
        if (!this._root.isConnected && !this._root.parentElement) return;
        const loadError = calendarService.getLoadError();
        if (loadError) this._showBanner(loadError);
        this._render();
      },
      (error) => this._showBanner(`Calendar data is unavailable: ${error.message}`)
    );

    const on = (name, handler) => this._cleanups.push(eventBus.on(name, handler));
    on("calendar:changed", () => this._render());
    on("appearance:themeChanged", () => this._render());
    // Keep "today" and the current-time line correct while open.
    this._nowTimerId = window.setInterval(() => this._render(), 60_000);

    return {
      element: this._root,
      title: "Calendar",
      icon: "icon:calendar",
      width: 1000,
      height: 680,
      minWidth: 520,
      minHeight: 440,
      resizable: true,
      minimizable: true,
      maximizable: true,
      closable: true,
    };
  }

  /**
   * @param {{date?: string, eventId?: string}} [options]
   * @returns {void}
   */
  onRelaunch(options = {}) {
    this._applyLaunchOptions(options);
    this._render();
  }

  /** @returns {void} */
  close() {
    window.clearInterval(this._nowTimerId);
    for (const cleanup of this._cleanups) cleanup();
    this._cleanups = [];
  }

  /**
   * @param {{date?: string, eventId?: string}} options
   * @returns {void}
   */
  _applyLaunchOptions(options) {
    const date = parseDateKey(options.date);
    if (date) {
      this._cursor = date;
      this._selectedDate = options.date;
    }
    if (options.eventId) this._selected = { eventId: options.eventId, dateKey: options.date ?? this._selectedDate };
  }

  // ---------------------------------------------------------------
  // DOM
  // ---------------------------------------------------------------

  /** @returns {void} */
  _buildDom() {
    const navButton = (label, glyph, onClick) =>
      createElement("button", { className: "calendar__nav-button", attrs: { type: "button", "aria-label": label, title: label }, text: glyph, on: { click: onClick } });

    this._titleEl = createElement("h2", { className: "calendar__title", attrs: { "aria-live": "polite" } });
    this._viewButtons = Object.fromEntries(
      [
        ["month", "Month"],
        ["week", "Week"],
        ["day", "Day"],
      ].map(([view, label]) => [
        view,
        createElement("button", {
          className: "calendar__view-button",
          attrs: { type: "button", "aria-pressed": "false" },
          text: label,
          on: { click: () => this._setView(view) },
        }),
      ])
    );

    this._searchInput = createElement("input", {
      className: "calendar__search-input",
      attrs: { type: "search", placeholder: "Search events", "aria-label": "Search events", autocomplete: "off" },
      on: {
        input: () => this._renderSearch(),
        keydown: (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            this._searchResultsEl.querySelector("button")?.click();
          } else if (e.key === "Escape" && this._searchInput.value) {
            e.preventDefault();
            e.stopPropagation();
            this._searchInput.value = "";
            this._renderSearch();
          } else if (e.key === "ArrowDown" && !hasModifierKey(e)) {
            e.preventDefault();
            this._searchResultsEl.querySelector("button")?.focus();
          }
        },
      },
    });
    this._searchResultsEl = createElement("div", { className: "calendar__search-results", attrs: { role: "listbox", "aria-label": "Matching events" } });
    this._searchResultsEl.hidden = true;

    const toolbar = createElement("div", {
      className: "calendar__toolbar",
      children: [
        createElement("div", {
          className: "calendar__nav",
          children: [
            createElement("button", { className: "calendar__button", attrs: { type: "button", title: "Go to today (T)" }, text: "Today", on: { click: () => this._goToday() } }),
            navButton("Previous", "\u2039", () => this._step(-1)),
            navButton("Next", "\u203a", () => this._step(1)),
            this._titleEl,
          ],
        }),
        createElement("div", {
          className: "calendar__actions",
          children: [
            createElement("div", { className: "calendar__search", children: [this._searchInput, this._searchResultsEl] }),
            createElement("div", { className: "calendar__views", attrs: { role: "group", "aria-label": "View" }, children: Object.values(this._viewButtons) }),
            createElement("button", {
              className: "calendar__button calendar__button--primary",
              attrs: { type: "button", title: "New event (N)" },
              text: "+ New event",
              on: { click: () => this._createEvent() },
            }),
          ],
        }),
      ],
    });

    this._bannerEl = createElement("div", { className: "calendar__banner", attrs: { role: "status" } });
    this._bannerEl.hidden = true;
    this._viewEl = createElement("div", { className: "calendar__view" });
    this._detailsEl = createElement("aside", { className: "calendar__details", attrs: { "aria-label": "Event details" } });
    this._detailsEl.hidden = true;

    this._root = createElement("div", {
      className: "calendar",
      attrs: { tabindex: "-1" },
      children: [toolbar, this._bannerEl, createElement("div", { className: "calendar__body", children: [this._viewEl, this._detailsEl] })],
      on: { keydown: (e) => this._handleKeydown(e) },
    });
  }

  // ---------------------------------------------------------------
  // Navigation
  // ---------------------------------------------------------------

  /**
   * @param {"month"|"week"|"day"} view
   * @returns {void}
   */
  _setView(view) {
    this._view = view;
    this._cursor = parseDateKey(this._selectedDate) ?? this._cursor;
    this._render();
  }

  /**
   * @param {-1|1} direction
   * @returns {void}
   */
  _step(direction) {
    if (this._view === "month") {
      this._cursor = new Date(this._cursor.getFullYear(), this._cursor.getMonth() + direction, 1);
    } else {
      this._cursor = addDays(this._cursor, direction * (this._view === "week" ? 7 : 1));
    }
    if (this._view !== "month") this._selectedDate = toDateKey(this._cursor);
    this._render();
  }

  /** @returns {void} */
  _goToday() {
    this._cursor = startOfDay(new Date());
    this._selectedDate = toDateKey(this._cursor);
    this._render();
  }

  /**
   * @param {string} dateKey
   * @param {{focus?: boolean}} [options]
   * @returns {void}
   */
  _selectDate(dateKey, { focus = false } = {}) {
    const date = parseDateKey(dateKey);
    if (!date) return;
    this._selectedDate = dateKey;
    const inView = this._view === "month" ? date.getMonth() === this._cursor.getMonth() && date.getFullYear() === this._cursor.getFullYear() : false;
    if (!inView) this._cursor = date;
    this._render();
    if (focus) this._viewEl.querySelector(`[data-date="${dateKey}"]`)?.focus();
  }

  // ---------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------

  /** @returns {void} */
  _renderLoading() {
    clearElement(this._viewEl);
    this._viewEl.append(createElement("p", { className: "calendar__loading", text: "Loading calendar\u2026" }));
  }

  /** @returns {void} */
  _render() {
    for (const [view, button] of Object.entries(this._viewButtons)) {
      button.setAttribute("aria-pressed", String(view === this._view));
      button.classList.toggle("calendar__view-button--active", view === this._view);
    }
    this._titleEl.textContent = this._formatTitle();
    const scrollTop = this._viewEl.querySelector(".calendar-grid__scroll")?.scrollTop ?? null;
    clearElement(this._viewEl);
    if (this._view === "month") {
      this._renderMonth();
    } else {
      const days = this._view === "week" ? Array.from({ length: 7 }, (_, i) => addDays(startOfWeek(this._cursor), i)) : [startOfDay(this._cursor)];
      this._renderTimeGrid(days, scrollTop);
    }
    this._renderDetails();
    if (this._searchInput.value.trim()) this._renderSearch();
  }

  /** @returns {string} */
  _formatTitle() {
    if (this._view === "month") return formatDate(this._cursor, { month: "long", year: "numeric" });
    if (this._view === "day") return formatDate(this._cursor, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
    const start = startOfWeek(this._cursor);
    const end = addDays(start, 6);
    const sameMonth = start.getMonth() === end.getMonth();
    return `${formatDate(start, sameMonth ? { day: "numeric" } : { day: "numeric", month: "short" })} \u2013 ${formatDate(end, { day: "numeric", month: "short", year: "numeric" })}`;
  }

  /** @returns {void} */
  _renderMonth() {
    const gridStart = startOfWeek(startOfMonth(this._cursor));
    const gridEnd = addDays(gridStart, 42);
    const byDay = groupByDay(calendarService.getOccurrences(gridStart, gridEnd), gridStart, gridEnd);
    const today = new Date();

    const header = createElement("div", {
      className: "calendar-month__weekdays",
      attrs: { role: "row" },
      children: Array.from({ length: 7 }, (_, i) =>
        createElement("div", { className: "calendar-month__weekday", attrs: { role: "columnheader" }, text: formatDate(addDays(gridStart, i), { weekday: "short" }) })
      ),
    });

    const rows = [];
    for (let week = 0; week < 6; week += 1) {
      const cells = [];
      for (let weekday = 0; weekday < 7; weekday += 1) {
        const date = addDays(gridStart, week * 7 + weekday);
        cells.push(this._monthCell(date, byDay.get(toDateKey(date)) ?? [], today));
      }
      rows.push(createElement("div", { className: "calendar-month__row", attrs: { role: "row" }, children: cells }));
    }

    this._viewEl.append(
      createElement("div", {
        className: "calendar-month",
        attrs: { role: "grid", "aria-label": formatDate(this._cursor, { month: "long", year: "numeric" }) },
        children: [header, ...rows],
      })
    );
  }

  /**
   * @param {Date} date
   * @param {object[]} occurrences
   * @param {Date} today
   * @returns {HTMLElement}
   */
  _monthCell(date, occurrences, today) {
    const dateKey = toDateKey(date);
    const selected = dateKey === this._selectedDate;
    const outside = date.getMonth() !== this._cursor.getMonth();
    const isToday = isSameDay(date, today);

    const chips = occurrences.slice(0, MAX_MONTH_CHIPS).map((occurrence) => this._eventChip(occurrence, date));
    const extra = occurrences.length - chips.length;
    if (extra > 0) {
      chips.push(
        createElement("button", {
          className: "calendar-month__more",
          attrs: { type: "button", tabindex: "-1" },
          text: `+${extra} more`,
          on: {
            click: (e) => {
              e.stopPropagation();
              this._selectedDate = dateKey;
              this._setView("day");
            },
          },
        })
      );
    }

    const label = `${formatDate(date, { weekday: "long", day: "numeric", month: "long" })}${occurrences.length ? `, ${occurrences.length} event${occurrences.length === 1 ? "" : "s"}` : ""}`;
    return createElement("div", {
      className: ["calendar-month__cell", selected ? "calendar-month__cell--selected" : "", outside ? "calendar-month__cell--outside" : "", isToday ? "calendar-month__cell--today" : ""]
        .filter(Boolean)
        .join(" "),
      attrs: { role: "gridcell", tabindex: selected ? "0" : "-1", "aria-selected": String(selected), "aria-label": label, "data-date": dateKey },
      children: [
        createElement("div", {
          className: "calendar-month__cell-top",
          children: [
            createElement("span", { className: "calendar-month__date", attrs: { "aria-hidden": "true" }, text: String(date.getDate()) }),
            createElement("button", {
              className: "calendar-month__add",
              attrs: { type: "button", tabindex: "-1", "aria-label": `Add event on ${formatDate(date, { day: "numeric", month: "long" })}` },
              text: "+",
              on: {
                click: (e) => {
                  e.stopPropagation();
                  this._createEvent({ dateKey });
                },
              },
            }),
          ],
        }),
        createElement("div", { className: "calendar-month__events", children: chips }),
      ],
      on: {
        click: () => {
          if (this._selectedDate !== dateKey) this._selectDate(dateKey, { focus: true });
        },
        dblclick: (e) => {
          if (e.target.closest("button")) return;
          this._createEvent({ dateKey });
        },
        keydown: (e) => this._handleMonthKeydown(e, date),
      },
    });
  }

  /**
   * @param {object} occurrence
   * @param {Date} day - The cell the chip is drawn in.
   * @returns {HTMLElement}
   */
  _eventChip(occurrence, day) {
    const { event } = occurrence;
    const continued = !isSameDay(occurrence.start, day);
    const time = event.allDay || continued ? "" : formatTime(occurrence.start);
    const chip = createElement("button", {
      className: `calendar-chip${event.allDay || continued ? " calendar-chip--block" : ""}${this._isSelected(occurrence) ? " calendar-chip--selected" : ""}`,
      attrs: {
        type: "button",
        tabindex: "-1",
        "aria-label": `${event.title}, ${describeWhen(occurrence)}`,
        title: `${event.title} \u2014 ${describeWhen(occurrence)}`,
      },
      children: [
        ...(time ? [createElement("span", { className: "calendar-chip__time", text: time })] : []),
        createElement("span", { className: "calendar-chip__title", text: `${continued ? "\u21aa " : ""}${event.title}` }),
      ],
      on: {
        click: (e) => {
          e.stopPropagation();
          this._selectOccurrence(occurrence);
        },
        dblclick: (e) => e.stopPropagation(),
      },
    });
    this._applyColor(chip, event.color);
    return chip;
  }

  /**
   * @param {Date[]} days
   * @param {number|null} previousScrollTop
   * @returns {void}
   */
  _renderTimeGrid(days, previousScrollTop) {
    const rangeStart = days[0];
    const rangeEnd = addDays(days.at(-1), 1);
    const occurrences = calendarService.getOccurrences(rangeStart, rangeEnd);
    const allDay = occurrences.filter((o) => o.event.allDay || !isSameDay(o.start, addDays(o.end, 0)) && o.end - o.start >= 86_400_000);
    const timed = occurrences.filter((o) => !allDay.includes(o));
    const today = new Date();
    const columns = `56px repeat(${days.length}, minmax(0, 1fr))`;

    const header = createElement("div", {
      className: "calendar-grid__header",
      attrs: { style: `grid-template-columns: ${columns}` },
      children: [
        createElement("div", { className: "calendar-grid__corner" }),
        ...days.map((day) =>
          createElement("button", {
            className: `calendar-grid__day-label${isSameDay(day, today) ? " calendar-grid__day-label--today" : ""}${toDateKey(day) === this._selectedDate ? " calendar-grid__day-label--selected" : ""}`,
            attrs: { type: "button", "aria-label": formatDate(day, { weekday: "long", day: "numeric", month: "long" }) },
            children: [
              createElement("span", { className: "calendar-grid__weekday", text: formatDate(day, { weekday: "short" }) }),
              createElement("span", { className: "calendar-grid__date", text: String(day.getDate()) }),
            ],
            on: {
              click: () => {
                this._selectedDate = toDateKey(day);
                this._cursor = day;
                this._setView("day");
              },
            },
          })
        ),
      ],
    });

    const allDayRow = createElement("div", {
      className: "calendar-grid__allday",
      attrs: { style: `grid-template-columns: ${columns}` },
      children: [
        createElement("div", { className: "calendar-grid__allday-label", text: "All day" }),
        ...days.map((day) =>
          createElement("div", {
            className: "calendar-grid__allday-cell",
            children: allDay.filter((o) => o.start < addDays(day, 1) && o.end > day).map((o) => this._eventChip(o, day)),
          })
        ),
      ],
    });

    const hours = createElement("div", {
      className: "calendar-grid__hours",
      children: Array.from({ length: 24 }, (_, hour) =>
        createElement("div", { className: "calendar-grid__hour", text: hour === 0 ? "" : formatTime(new Date(2000, 0, 1, hour)) })
      ),
    });

    const dayColumns = days.map((day) => this._dayColumn(day, timed, today));
    const body = createElement("div", {
      className: "calendar-grid__body",
      attrs: { style: `grid-template-columns: ${columns}; height: ${24 * HOUR_HEIGHT}px` },
      children: [hours, ...dayColumns],
    });
    const scroll = createElement("div", { className: "calendar-grid__scroll", children: [body] });

    this._viewEl.append(createElement("div", { className: `calendar-grid calendar-grid--${days.length === 1 ? "day" : "week"}`, children: [header, allDayRow, scroll] }));
    // A little headroom above the first hour keeps its label fully visible.
    scroll.scrollTop = previousScrollTop ?? Math.max(0, this._scrollHour * HOUR_HEIGHT - 12);
  }

  /**
   * @param {Date} day
   * @param {object[]} timed
   * @param {Date} today
   * @returns {HTMLElement}
   */
  _dayColumn(day, timed, today) {
    const dayStart = day;
    const dayEnd = addDays(day, 1);
    const segments = timed
      .filter((o) => o.start < dayEnd && o.end > dayStart)
      .map((o) => {
        const top = o.start < dayStart ? 0 : minutesOfDay(o.start);
        const bottom = o.end > dayEnd ? MINUTES_PER_DAY : Math.max(top + 15, o.end <= dayStart ? 0 : minutesOfDay(o.end) || MINUTES_PER_DAY);
        return { occurrence: o, top, bottom };
      });
    layoutColumns(segments);

    const column = createElement("div", {
      className: `calendar-grid__column${isSameDay(day, today) ? " calendar-grid__column--today" : ""}`,
      attrs: { "data-date": toDateKey(day), "aria-label": formatDate(day, { weekday: "long", day: "numeric", month: "long" }) },
      on: {
        click: (e) => {
          if (e.target !== column) return;
          const minutes = Math.floor(e.offsetY / HOUR_HEIGHT * 60 / SLOT_MINUTES) * SLOT_MINUTES;
          this._createEvent({ dateKey: toDateKey(day), startMinutes: Math.min(minutes, MINUTES_PER_DAY - 60) });
        },
      },
    });

    for (const segment of segments) {
      const { occurrence, top, bottom, column: index, columns } = segment;
      const block = createElement("button", {
        className: `calendar-block${this._isSelected(occurrence) ? " calendar-block--selected" : ""}`,
        attrs: {
          type: "button",
          "aria-label": `${occurrence.event.title}, ${describeWhen(occurrence)}`,
          style: `top: ${(top / 60) * HOUR_HEIGHT}px; height: ${Math.max(18, ((bottom - top) / 60) * HOUR_HEIGHT - 2)}px; left: calc(${(index / columns) * 100}% + 2px); width: calc(${100 / columns}% - 4px)`,
        },
        children: [
          createElement("span", { className: "calendar-block__title", text: occurrence.event.title }),
          createElement("span", { className: "calendar-block__time", text: `${formatTime(occurrence.start)} \u2013 ${formatTime(occurrence.end)}` }),
        ],
        on: { click: () => this._selectOccurrence(occurrence) },
      });
      this._applyColor(block, occurrence.event.color);
      column.append(block);
    }

    if (isSameDay(day, today)) {
      column.append(createElement("div", { className: "calendar-grid__now", attrs: { style: `top: ${(minutesOfDay(today) / 60) * HOUR_HEIGHT}px`, "aria-hidden": "true" } }));
    }
    return column;
  }

  /**
   * @param {HTMLElement} element
   * @param {string} color - Accent preset id.
   * @returns {void}
   */
  _applyColor(element, color) {
    element.style.setProperty("--event-color", getAccentPreset(color)[themeManager.getCurrent()].primary);
  }

  // ---------------------------------------------------------------
  // Details panel
  // ---------------------------------------------------------------

  /**
   * @param {object} occurrence
   * @returns {boolean}
   */
  _isSelected(occurrence) {
    return Boolean(this._selected && this._selected.eventId === occurrence.event.id && this._selected.dateKey === occurrence.dateKey);
  }

  /**
   * @param {object} occurrence
   * @returns {void}
   */
  _selectOccurrence(occurrence) {
    this._selected = { eventId: occurrence.event.id, dateKey: occurrence.dateKey };
    this._render();
    this._detailsEl.querySelector(".calendar-details__title")?.focus();
  }

  /**
   * @returns {object|null} The selected occurrence, re-derived from the service.
   */
  _currentOccurrence() {
    if (!this._selected) return null;
    const event = calendarService.getEvent(this._selected.eventId);
    if (!event) return null;
    const day = parseDateKey(this._selected.dateKey);
    if (!day) return null;
    return expandEvent(event, day, addDays(day, 1)).find((o) => o.dateKey === this._selected.dateKey) ?? null;
  }

  /** @returns {void} */
  _renderDetails() {
    const occurrence = this._currentOccurrence();
    clearElement(this._detailsEl);
    this._detailsEl.hidden = !occurrence;
    if (!occurrence) {
      this._selected = null;
      return;
    }
    const { event } = occurrence;
    const rows = [["When", describeWhen(occurrence, { long: true })]];
    if (event.recurrence) rows.push(["Repeats", describeRecurrence(event.recurrence, eventBounds(event).start)]);
    if (event.reminder !== null) rows.push(["Reminder", REMINDER_TEXT[event.reminder]]);
    if (event.location) rows.push(["Location", event.location]);

    const colorBar = createElement("span", { className: "calendar-details__color", attrs: { "aria-hidden": "true" } });
    this._applyColor(colorBar, event.color);

    this._detailsEl.append(
      createElement("div", {
        className: "calendar-details__header",
        children: [
          colorBar,
          createElement("h3", { className: "calendar-details__title", attrs: { tabindex: "-1" }, text: event.title }),
          createElement("button", {
            className: "calendar__nav-button",
            attrs: { type: "button", "aria-label": "Close details" },
            text: "\u2715",
            on: {
              click: () => {
                this._selected = null;
                this._render();
              },
            },
          }),
        ],
      }),
      createElement("dl", {
        className: "calendar-details__list",
        children: rows.flatMap(([term, value]) => [createElement("dt", { text: term }), createElement("dd", { text: value })]),
      }),
      ...(event.description ? [createElement("p", { className: "calendar-details__description", text: event.description })] : []),
      createElement("div", {
        className: "calendar-details__actions",
        children: [
          createElement("button", { className: "calendar__button", attrs: { type: "button" }, text: "Edit", on: { click: () => this._editOccurrence(occurrence) } }),
          createElement("button", { className: "calendar__button calendar__button--danger", attrs: { type: "button" }, text: "Delete", on: { click: () => this._deleteOccurrence(occurrence) } }),
        ],
      })
    );
  }

  // ---------------------------------------------------------------
  // Create / edit / delete
  // ---------------------------------------------------------------

  /**
   * @param {{dateKey?: string, startMinutes?: number}} [at]
   * @returns {Promise<void>}
   */
  async _createEvent({ dateKey = this._selectedDate, startMinutes = 9 * 60 } = {}) {
    const day = parseDateKey(dateKey) ?? startOfDay(new Date());
    const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(startMinutes / 60), startMinutes % 60);
    const end = new Date(start.getTime() + 60 * 60_000);
    const data = await showEventDialog({
      title: "New event",
      confirmLabel: "Create",
      initial: {
        title: "",
        allDay: false,
        start: toDateTimeString(start),
        end: toDateTimeString(end),
        recurrence: null,
        reminder: 10,
        color: "blue",
        location: "",
        description: "",
      },
    });
    if (!data) return;
    try {
      const event = await calendarService.create(data);
      const first = eventBounds(event).start;
      this._selectedDate = toDateKey(first);
      this._selected = { eventId: event.id, dateKey: toDateKey(first) };
      if (this._view === "month" && (first.getMonth() !== this._cursor.getMonth() || first.getFullYear() !== this._cursor.getFullYear())) this._cursor = first;
      this._render();
    } catch (error) {
      await showMessageDialog({ title: "Couldn't create event", message: "The event could not be saved.", detail: error.message });
    }
  }

  /**
   * @param {object} occurrence
   * @returns {Promise<void>}
   */
  async _editOccurrence(occurrence) {
    const { event } = occurrence;
    let scope = "all";
    if (event.recurrence) {
      scope = await askScope("Edit recurring event", "Change only this occurrence, or every event in the series?");
      if (!scope) return;
    }
    const base = scope === "one" ? { ...event, start: occurrenceStart(occurrence), end: occurrenceEnd(occurrence), recurrence: null } : event;
    const data = await showEventDialog({ title: "Edit event", initial: base });
    if (!data) return;
    try {
      const saved =
        scope === "one" ? await calendarService.detachOccurrence(event.id, occurrence.dateKey, data) : await calendarService.update(event.id, data);
      const first = scope === "one" ? eventBounds(saved).start : occurrence.start;
      this._selected = { eventId: saved.id, dateKey: scope === "one" ? toDateKey(first) : this._nearestDateKey(saved, occurrence.dateKey) };
      this._render();
    } catch (error) {
      await showMessageDialog({ title: "Couldn't save event", message: "Your changes could not be saved.", detail: error.message });
    }
  }

  /**
   * After editing a series, keep showing the occurrence nearest the one
   * that was selected (its date may have moved).
   * @param {object} event
   * @param {string} dateKey
   * @returns {string}
   */
  _nearestDateKey(event, dateKey) {
    const day = parseDateKey(dateKey);
    const nearby = expandEvent(event, addDays(day, -31), addDays(day, 32));
    if (nearby.length === 0) return toDateKey(eventBounds(event).start);
    nearby.sort((a, b) => Math.abs(a.start - day) - Math.abs(b.start - day));
    return nearby[0].dateKey;
  }

  /**
   * @param {object} occurrence
   * @returns {Promise<void>}
   */
  async _deleteOccurrence(occurrence) {
    const { event } = occurrence;
    try {
      if (event.recurrence) {
        const scope = await askScope("Delete recurring event", "Delete only this occurrence, or every event in the series?");
        if (!scope) return;
        if (scope === "one") {
          await calendarService.excludeOccurrence(event.id, occurrence.dateKey);
        } else {
          await calendarService.remove(event.id);
        }
      } else {
        const confirmed = await showConfirmDialog({ title: "Delete event?", message: `"${event.title}" will be removed from your calendar.`, confirmLabel: "Delete", destructive: true });
        if (!confirmed) return;
        await calendarService.remove(event.id);
      }
      this._selected = null;
      this._render();
    } catch (error) {
      await showMessageDialog({ title: "Couldn't delete event", message: "The event could not be deleted.", detail: error.message });
    }
  }

  // ---------------------------------------------------------------
  // Search
  // ---------------------------------------------------------------

  /** @returns {void} */
  _renderSearch() {
    const query = this._searchInput.value;
    clearElement(this._searchResultsEl);
    if (!query.trim()) {
      this._searchResultsEl.hidden = true;
      return;
    }
    const matches = calendarService.search(query);
    this._searchResultsEl.hidden = false;
    if (matches.length === 0) {
      this._searchResultsEl.append(createElement("p", { className: "calendar__search-empty", attrs: { role: "status" }, text: "No matching events" }));
      return;
    }
    for (const event of matches.slice(0, 20)) {
      const occurrence = nextOccurrence(event);
      if (!occurrence) continue;
      const button = createElement("button", {
        className: "calendar__search-result",
        attrs: { type: "button", role: "option" },
        children: [
          createElement("span", { className: "calendar__search-title", text: event.title }),
          createElement("span", { className: "calendar__search-date", text: describeWhen(occurrence) }),
        ],
        on: {
          click: () => {
            this._searchInput.value = "";
            this._searchResultsEl.hidden = true;
            this._selectedDate = occurrence.dateKey;
            this._cursor = parseDateKey(occurrence.dateKey);
            this._selectOccurrence(occurrence);
          },
          keydown: (e) => {
            if (hasModifierKey(e)) return;
            if (e.key === "ArrowDown") {
              e.preventDefault();
              button.nextElementSibling?.focus();
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              (button.previousElementSibling ?? this._searchInput).focus();
            }
          },
        },
      });
      this._applyColor(button, event.color);
      this._searchResultsEl.append(button);
    }
  }

  // ---------------------------------------------------------------
  // Keyboard
  // ---------------------------------------------------------------

  /**
   * @param {KeyboardEvent} e
   * @returns {void}
   */
  _handleKeydown(e) {
    if (keyboardShortcuts.isEditableTarget(e.target)) return;
    const match = (id) => keyboardShortcuts.matches(e, id);
    if (match("calendar.today")) {
      e.preventDefault();
      this._goToday();
    } else if (match("calendar.previous")) {
      e.preventDefault();
      this._step(-1);
    } else if (match("calendar.next")) {
      e.preventDefault();
      this._step(1);
    } else if (match("calendar.newEvent")) {
      e.preventDefault();
      this._createEvent();
    } else if (match("calendar.monthView")) {
      e.preventDefault();
      this._setView("month");
    } else if (match("calendar.weekView")) {
      e.preventDefault();
      this._setView("week");
    } else if (match("calendar.dayView")) {
      e.preventDefault();
      this._setView("day");
    }
  }

  /**
   * Arrow keys move the selected day; Enter adds an event on it.
   * @param {KeyboardEvent} e
   * @param {Date} date
   * @returns {void}
   */
  _handleMonthKeydown(e, date) {
    const moves = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    if (e.target !== e.currentTarget) return;
    if (moves[e.key] !== undefined) {
      e.preventDefault();
      this._selectDate(toDateKey(addDays(date, moves[e.key])), { focus: true });
    } else if (e.key === "Enter") {
      e.preventDefault();
      this._createEvent({ dateKey: toDateKey(date) });
    }
  }

  /**
   * @param {string} message
   * @returns {void}
   */
  _showBanner(message) {
    this._bannerEl.textContent = message;
    this._bannerEl.hidden = false;
  }
}

/**
 * @param {object[]} occurrences
 * @param {Date} gridStart
 * @param {Date} gridEnd
 * @returns {Map<string, object[]>} Occurrences per day they cover (multi-day events appear on each day).
 */
function groupByDay(occurrences, gridStart, gridEnd) {
  const byDay = new Map();
  for (const occurrence of occurrences) {
    let day = occurrence.start < gridStart ? gridStart : startOfDay(occurrence.start);
    while (day < occurrence.end && day < gridEnd) {
      const key = toDateKey(day);
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key).push(occurrence);
      day = addDays(day, 1);
    }
  }
  return byDay;
}

/**
 * Side-by-side columns for overlapping timed events.
 * @param {Array<{top: number, bottom: number, column?: number, columns?: number}>} segments
 * @returns {void}
 */
function layoutColumns(segments) {
  segments.sort((a, b) => a.top - b.top || b.bottom - a.bottom);
  let cluster = [];
  let clusterEnd = -1;
  const finish = () => {
    const width = Math.max(1, ...cluster.map((s) => s.column + 1));
    for (const segment of cluster) segment.columns = width;
    cluster = [];
  };
  for (const segment of segments) {
    if (segment.top >= clusterEnd && cluster.length) finish();
    const used = new Set(cluster.filter((s) => s.bottom > segment.top).map((s) => s.column));
    let column = 0;
    while (used.has(column)) column += 1;
    segment.column = column;
    cluster.push(segment);
    clusterEnd = Math.max(clusterEnd, segment.bottom);
  }
  if (cluster.length) finish();
}

/**
 * @param {object} occurrence
 * @param {{long?: boolean}} [options]
 * @returns {string}
 */
function describeWhen(occurrence, { long = false } = {}) {
  const { event, start, end } = occurrence;
  const dateOptions = long ? { weekday: "long", day: "numeric", month: "long", year: "numeric" } : { weekday: "short", day: "numeric", month: "short" };
  if (event.allDay) {
    const lastDay = addDays(end, -1);
    return isSameDay(start, lastDay) ? `${formatDate(start, dateOptions)} \u00b7 All day` : `${formatDate(start, dateOptions)} \u2013 ${formatDate(lastDay, dateOptions)} \u00b7 All day`;
  }
  if (isSameDay(start, end) || (end - start <= 86_400_000 && minutesOfDay(end) === 0 && isSameDay(start, addDays(end, -1)))) {
    return `${formatDate(start, dateOptions)} \u00b7 ${formatTime(start)} \u2013 ${formatTime(end)}`;
  }
  return `${formatDate(start, dateOptions)} ${formatTime(start)} \u2013 ${formatDate(end, dateOptions)} ${formatTime(end)}`;
}

/**
 * @param {object} occurrence
 * @returns {string}
 */
function occurrenceStart(occurrence) {
  return occurrence.event.allDay ? toDateKey(occurrence.start) : toDateTimeString(occurrence.start);
}

/**
 * @param {object} occurrence
 * @returns {string}
 */
function occurrenceEnd(occurrence) {
  return occurrence.event.allDay ? toDateKey(addDays(occurrence.end, -1)) : toDateTimeString(occurrence.end);
}

/**
 * @param {object} event
 * @returns {object|null} The next occurrence from today, or the first one.
 */
function nextOccurrence(event) {
  const today = startOfDay(new Date());
  const upcoming = expandEvent(event, today, addDays(today, 3 * 366));
  if (upcoming.length > 0) return upcoming[0];
  const bounds = eventBounds(event);
  return bounds ? expandEvent(event, bounds.start, addDays(bounds.start, 1))[0] ?? null : null;
}

/**
 * @param {string} title
 * @param {string} message
 * @returns {Promise<"one"|"all"|null>}
 */
async function askScope(title, message) {
  return openDialog({
    title,
    role: "alertdialog",
    bodyElement: createElement("p", { className: "dialog__message", text: message }),
    buttons: [
      { label: "Cancel", value: null, variant: "default" },
      { label: "This event", value: "one", variant: "default" },
      { label: "All events", value: "all", variant: "primary", autofocus: true },
    ],
  });
}
