/**
 * @file Event editor dialog for Calendar: title, all-day, start/end,
 * repeat rule, reminder, color, location, and description. Built on the
 * shared Dialog shell; validation runs on Save and keeps the dialog
 * open with an inline message until the input is valid.
 */

import { openDialog } from "../../components/dialog/dialog.js";
import { createElement } from "../../utils/dom.js";
import { getAccentPreset } from "../../core/settings/accentPresets.js";
import { themeManager } from "../../core/theme.js";
import { EVENT_COLORS } from "../../core/calendar/calendarService.js";
import { parseDateKey, parseDateTime, toDateKey, addDays } from "../../core/calendar/calendarTime.js";

const REMINDER_LABELS = [
  ["", "No reminder"],
  ["0", "At start time"],
  ["5", "5 minutes before"],
  ["10", "10 minutes before"],
  ["15", "15 minutes before"],
  ["30", "30 minutes before"],
  ["60", "1 hour before"],
  ["1440", "1 day before"],
];

let fieldCounter = 0;

/**
 * @typedef {object} EventFormValue
 * @property {string} title
 * @property {boolean} allDay
 * @property {string} start - "YYYY-MM-DD" (all-day) or "YYYY-MM-DDTHH:mm".
 * @property {string} end
 * @property {object|null} recurrence
 * @property {number|null} reminder
 * @property {string} color
 * @property {string} location
 * @property {string} description
 */

/**
 * @param {object} config
 * @param {string} config.title - Dialog title.
 * @param {EventFormValue} config.initial
 * @param {string} [config.confirmLabel]
 * @returns {Promise<EventFormValue|null>}
 */
export async function showEventDialog({ title, initial, confirmLabel = "Save" }) {
  const id = (name) => `event-${name}-${++fieldCounter}`;
  const field = (label, control, extraClass = "") => {
    const controlId = control.id || id("field");
    control.id = controlId;
    return createElement("div", {
      className: `dialog__field ${extraClass}`.trim(),
      children: [createElement("label", { className: "dialog__label", attrs: { for: controlId }, text: label }), control],
    });
  };
  const input = (type, value, attrs = {}) => {
    const el = createElement("input", { className: "dialog__input", attrs: { type, ...attrs } });
    el.value = value;
    return el;
  };

  const startDateValue = initial.start.slice(0, 10);
  const endDateValue = initial.end.slice(0, 10);
  const startTimeValue = initial.allDay ? "09:00" : initial.start.slice(11, 16);
  const endTimeValue = initial.allDay ? "10:00" : initial.end.slice(11, 16);

  const titleInput = input("text", initial.title, { maxlength: "200", autocomplete: "off", placeholder: "Event title" });
  const allDayInput = createElement("input", { attrs: { type: "checkbox", id: id("allday") } });
  allDayInput.checked = initial.allDay;
  const startDate = input("date", startDateValue);
  const startTime = input("time", startTimeValue);
  const endDate = input("date", endDateValue);
  const endTime = input("time", endTimeValue);

  const repeatSelect = createElement("select", {
    className: "dialog__select",
    children: [
      ["", "Does not repeat"],
      ["daily", "Daily"],
      ["weekly", "Weekly"],
      ["monthly", "Monthly"],
      ["yearly", "Yearly"],
    ].map(([value, label]) => createElement("option", { attrs: { value }, text: label })),
  });
  repeatSelect.value = initial.recurrence?.freq ?? "";
  const intervalInput = input("number", String(initial.recurrence?.interval ?? 1), { min: "1", max: "99", step: "1" });
  const endsSelect = createElement("select", {
    className: "dialog__select",
    children: [
      ["never", "Never"],
      ["until", "On date"],
      ["count", "After a number of times"],
    ].map(([value, label]) => createElement("option", { attrs: { value }, text: label })),
  });
  endsSelect.value = initial.recurrence?.until ? "until" : initial.recurrence?.count ? "count" : "never";
  const untilInput = input("date", initial.recurrence?.until ?? toDateKey(addDays(parseDateKey(startDateValue) ?? new Date(), 30)));
  const countInput = input("number", String(initial.recurrence?.count ?? 10), { min: "1", max: "999", step: "1" });

  const reminderSelect = createElement("select", {
    className: "dialog__select",
    children: REMINDER_LABELS.map(([value, label]) => createElement("option", { attrs: { value }, text: label })),
  });
  reminderSelect.value = initial.reminder === null || initial.reminder === undefined ? "" : String(initial.reminder);

  const colorName = `event-color-${++fieldCounter}`;
  const theme = themeManager.getCurrent();
  const colorGroup = createElement("div", {
    className: "calendar-colors",
    attrs: { role: "radiogroup", "aria-label": "Color" },
    children: EVENT_COLORS.map((color) => {
      const preset = getAccentPreset(color);
      const radio = createElement("input", { className: "calendar-colors__input", attrs: { type: "radio", name: colorName, value: color } });
      radio.checked = color === initial.color;
      const swatch = createElement("span", { className: "calendar-colors__swatch", attrs: { "aria-hidden": "true" } });
      swatch.style.setProperty("--swatch", preset[theme].primary);
      return createElement("label", {
        className: "calendar-colors__option",
        attrs: { title: preset.label },
        children: [radio, swatch, createElement("span", { className: "calendar-colors__label", text: preset.label })],
      });
    }),
  });

  const locationInput = input("text", initial.location, { maxlength: "200", autocomplete: "off", placeholder: "Add a location" });
  const descriptionInput = createElement("textarea", { className: "dialog__textarea", attrs: { maxlength: "5000", placeholder: "Add a description", rows: "3" } });
  descriptionInput.value = initial.description;

  const errorEl = createElement("p", { className: "dialog__error", attrs: { role: "alert" } });

  const timeFields = [startTime, endTime];
  const repeatFields = createElement("div", {
    className: "dialog__form-row",
    children: [field("Every", intervalInput), field("Ends", endsSelect), field("End date", untilInput, "calendar-until"), field("Occurrences", countInput, "calendar-count")],
  });

  const syncVisibility = () => {
    for (const el of timeFields) el.closest(".dialog__field").hidden = allDayInput.checked;
    repeatFields.hidden = !repeatSelect.value;
    untilInput.closest(".dialog__field").hidden = endsSelect.value !== "until";
    countInput.closest(".dialog__field").hidden = endsSelect.value !== "count";
  };

  // Moving the start keeps the event's duration.
  let durationMs = (combine(endDateValue, endTimeValue) ?? 0) - (combine(startDateValue, startTimeValue) ?? 0);
  const rememberDuration = () => {
    const start = combine(startDate.value, allDayInput.checked ? "00:00" : startTime.value);
    const end = combine(endDate.value, allDayInput.checked ? "00:00" : endTime.value);
    if (start !== null && end !== null && end >= start) durationMs = end - start;
  };
  const shiftEnd = () => {
    const start = combine(startDate.value, allDayInput.checked ? "00:00" : startTime.value);
    if (start === null) return;
    const end = new Date(start + Math.max(0, durationMs));
    endDate.value = toDateKey(end);
    if (!allDayInput.checked) endTime.value = `${String(end.getHours()).padStart(2, "0")}:${String(end.getMinutes()).padStart(2, "0")}`;
  };
  startDate.addEventListener("change", shiftEnd);
  startTime.addEventListener("change", shiftEnd);
  endDate.addEventListener("change", rememberDuration);
  endTime.addEventListener("change", rememberDuration);
  for (const el of [allDayInput, repeatSelect, endsSelect]) el.addEventListener("change", syncVisibility);

  const body = createElement("div", {
    className: "dialog__form calendar-event-form",
    children: [
      field("Title", titleInput),
      createElement("label", { className: "dialog__field dialog__field--inline", attrs: { for: allDayInput.id }, children: [allDayInput, createElement("span", { text: "All day" })] }),
      createElement("div", { className: "dialog__form-row", children: [field("Starts", startDate), field("Start time", startTime)] }),
      createElement("div", { className: "dialog__form-row", children: [field("Ends", endDate), field("End time", endTime)] }),
      createElement("div", { className: "dialog__form-row", children: [field("Repeat", repeatSelect), field("Reminder", reminderSelect)] }),
      repeatFields,
      field("Color", colorGroup),
      field("Location", locationInput),
      field("Description", descriptionInput),
      errorEl,
    ],
  });
  syncVisibility();

  /** @type {EventFormValue|null} */
  let value = null;
  const result = await openDialog({
    title,
    role: "dialog",
    className: "dialog--wide",
    bodyElement: body,
    initialFocus: titleInput,
    submitValue: "save",
    buttons: [
      { label: "Cancel", value: null, variant: "default" },
      { label: confirmLabel, value: "save", variant: "primary" },
    ],
    onBeforeClose: () => {
      const { data, error } = readForm();
      errorEl.textContent = error ?? "";
      if (error) return false;
      value = data;
      return true;
    },
  });
  return result === "save" ? value : null;

  /**
   * @returns {{data?: EventFormValue, error?: string}}
   */
  function readForm() {
    const titleValue = titleInput.value.trim();
    if (!titleValue) {
      titleInput.focus();
      return { error: "Give the event a title." };
    }
    const allDay = allDayInput.checked;
    if (!parseDateKey(startDate.value) || !parseDateKey(endDate.value)) return { error: "Choose valid start and end dates." };

    let start;
    let end;
    if (allDay) {
      start = startDate.value;
      end = endDate.value;
      if (end < start) return { error: "The event can't end before it starts." };
    } else {
      start = `${startDate.value}T${startTime.value}`;
      end = `${endDate.value}T${endTime.value}`;
      const startAt = parseDateTime(start);
      const endAt = parseDateTime(end);
      if (!startAt || !endAt) return { error: "Choose valid start and end times." };
      if (endAt <= startAt) return { error: "The event must end after it starts." };
    }

    let recurrence = null;
    if (repeatSelect.value) {
      const interval = Number.parseInt(intervalInput.value, 10);
      if (!Number.isInteger(interval) || interval < 1 || interval > 99) return { error: "Repeat every 1 to 99 periods." };
      recurrence = { freq: repeatSelect.value, interval, until: null, count: null };
      if (endsSelect.value === "until") {
        if (!parseDateKey(untilInput.value) || untilInput.value < startDate.value) return { error: "The repeat end date must be on or after the start date." };
        recurrence.until = untilInput.value;
      } else if (endsSelect.value === "count") {
        const count = Number.parseInt(countInput.value, 10);
        if (!Number.isInteger(count) || count < 1 || count > 999) return { error: "Choose between 1 and 999 occurrences." };
        recurrence.count = count;
      }
    }

    const color = body.querySelector(`input[name="${colorName}"]:checked`)?.value ?? EVENT_COLORS[0];
    return {
      data: {
        title: titleValue,
        allDay,
        start,
        end,
        recurrence,
        reminder: reminderSelect.value === "" ? null : Number(reminderSelect.value),
        color,
        location: locationInput.value.trim(),
        description: descriptionInput.value,
      },
    };
  }
}

/**
 * @param {string} dateValue
 * @param {string} timeValue
 * @returns {number|null}
 */
function combine(dateValue, timeValue) {
  const date = parseDateTime(`${dateValue}T${timeValue || "00:00"}`);
  return date ? date.getTime() : null;
}
