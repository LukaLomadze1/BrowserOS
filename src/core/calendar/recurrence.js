/**
 * @file Recurrence expansion.
 *
 * A recurring event is stored once, with a rule:
 *   { freq: "daily"|"weekly"|"monthly"|"yearly", interval, until, count }
 * plus a list of excluded occurrence dates. Occurrences are generated
 * on demand for the range being displayed or checked for reminders,
 * so a daily event never produces thousands of stored records.
 *
 * Daily and weekly rules jump straight to the first occurrence in the
 * range. Monthly and yearly rules step from the series start (at most
 * twelve steps per year of history). A monthly event on the 31st, or a
 * yearly event on 29 February, is skipped in months/years that don't
 * contain that date, as in RFC 5545; skipped dates do not count
 * towards `count`.
 */

import { parseDateKey, parseDateTime, addDays, addMonthsRaw, toDateKey, daysBetween, startOfDay } from "./calendarTime.js";

/** Safety bound on generated occurrences per expansion. */
const MAX_OCCURRENCES = 2000;

/**
 * @typedef {object} Occurrence
 * @property {object} event - The stored event.
 * @property {string} id - "<eventId>:<dateKey>" — stable per occurrence.
 * @property {string} dateKey - Start date of this occurrence.
 * @property {Date} start
 * @property {Date} end - Exclusive for timed events; local midnight after the last day for all-day events.
 * @property {boolean} recurring
 */

/**
 * @param {object} event
 * @returns {{start: Date, end: Date}|null} The first occurrence's bounds (end exclusive).
 */
export function eventBounds(event) {
  if (event.allDay) {
    const start = parseDateKey(event.start);
    const lastDay = parseDateKey(event.end);
    if (!start || !lastDay) return null;
    return { start, end: addDays(lastDay, 1) };
  }
  const start = parseDateTime(event.start);
  const end = parseDateTime(event.end);
  if (!start || !end) return null;
  return { start, end };
}

/**
 * All occurrences of an event that overlap [rangeStart, rangeEnd).
 * @param {object} event
 * @param {Date} rangeStart
 * @param {Date} rangeEnd
 * @returns {Occurrence[]}
 */
export function expandEvent(event, rangeStart, rangeEnd) {
  const bounds = eventBounds(event);
  if (!bounds) return [];
  const durationMs = bounds.end.getTime() - bounds.start.getTime();
  const durationDays = daysBetween(bounds.start, bounds.end);
  const exceptions = new Set(event.exceptions ?? []);

  const make = (start) => {
    const end = event.allDay ? addDays(start, durationDays) : new Date(start.getTime() + durationMs);
    const dateKey = toDateKey(start);
    return { event, id: `${event.id}:${dateKey}`, dateKey, start, end, recurring: Boolean(event.recurrence) };
  };
  const overlaps = (occurrence) => occurrence.start < rangeEnd && occurrence.end > rangeStart;

  const rule = event.recurrence;
  if (!rule) {
    const single = make(bounds.start);
    return overlaps(single) ? [single] : [];
  }

  const interval = Math.max(1, rule.interval ?? 1);
  const until = rule.until ? addDays(parseDateKey(rule.until) ?? bounds.start, 1) : null;
  const count = Number.isInteger(rule.count) && rule.count > 0 ? rule.count : Infinity;
  const results = [];
  const accept = (index, start) => {
    if (index >= count) return false;
    if (until && start >= until) return false;
    const occurrence = make(start);
    if (!exceptions.has(occurrence.dateKey) && overlaps(occurrence)) results.push(occurrence);
    return true;
  };

  if (rule.freq === "daily" || rule.freq === "weekly") {
    const stepDays = rule.freq === "daily" ? interval : interval * 7;
    // First index whose occurrence could still overlap the range.
    const earliest = addDays(startOfDay(rangeStart), -Math.max(0, durationDays));
    let index = Math.max(0, Math.floor(daysBetween(bounds.start, earliest) / stepDays));
    for (let guard = 0; guard < MAX_OCCURRENCES; guard += 1, index += 1) {
      const start = addDays(bounds.start, index * stepDays);
      if (start >= rangeEnd) break;
      if (!accept(index, start)) break;
    }
    return results;
  }

  const monthsPerStep = rule.freq === "monthly" ? interval : interval * 12;
  let index = 0;
  for (let step = 0; step < MAX_OCCURRENCES * 4; step += 1) {
    const candidate = addMonthsRaw(bounds.start, step * monthsPerStep);
    if (candidate.getDate() !== bounds.start.getDate()) continue; // Month/year without that date.
    if (candidate >= rangeEnd) break;
    if (!accept(index, candidate)) break;
    index += 1;
  }
  return results;
}

/**
 * @param {object[]} events
 * @param {Date} rangeStart
 * @param {Date} rangeEnd
 * @returns {Occurrence[]} Every occurrence overlapping the range, ordered by start.
 */
export function expandEvents(events, rangeStart, rangeEnd) {
  return events
    .flatMap((event) => expandEvent(event, rangeStart, rangeEnd))
    .sort((a, b) => a.start - b.start || Number(b.event.allDay) - Number(a.event.allDay) || a.event.title.localeCompare(b.event.title));
}

/**
 * @param {object} rule
 * @param {Date} start
 * @returns {string} A human description, e.g. "Every 2 weeks, 10 times".
 */
export function describeRecurrence(rule, start) {
  if (!rule) return "Does not repeat";
  const unit = { daily: "day", weekly: "week", monthly: "month", yearly: "year" }[rule.freq];
  const interval = rule.interval ?? 1;
  let text = interval === 1 ? `Every ${unit}` : `Every ${interval} ${unit}s`;
  if (rule.freq === "weekly") text += ` on ${new Intl.DateTimeFormat(undefined, { weekday: "long" }).format(start)}`;
  if (rule.freq === "monthly") text += ` on day ${start.getDate()}`;
  if (rule.count) text += `, ${rule.count} time${rule.count === 1 ? "" : "s"}`;
  if (rule.until) {
    const until = parseDateKey(rule.until);
    if (until) text += `, until ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(until)}`;
  }
  return text;
}
