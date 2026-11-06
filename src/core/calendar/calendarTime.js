/**
 * @file Calendar date/time helpers.
 *
 * Calendar events use "floating" local times: timed events are stored
 * as "YYYY-MM-DDTHH:mm" and all-day events as "YYYY-MM-DD", both
 * interpreted in the viewer's current time zone. That keeps a 9:00
 * meeting at 9:00 regardless of daylight-saving changes, and avoids
 * the off-by-one-day errors that UTC conversion causes for all-day
 * events. Weeks start on Monday (ISO 8601).
 */

const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/** Monday. */
export const WEEK_START = 1;
export const MINUTES_PER_DAY = 24 * 60;

/**
 * @param {number} value
 * @returns {string}
 */
const pad = (value) => String(value).padStart(2, "0");

/**
 * @param {Date} date
 * @returns {string} "YYYY-MM-DD" in local time.
 */
export function toDateKey(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * @param {Date} date
 * @returns {string} "YYYY-MM-DDTHH:mm" in local time.
 */
export function toDateTimeString(date) {
  return `${toDateKey(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * @param {string} key
 * @returns {Date|null} Local midnight, or null when invalid.
 */
export function parseDateKey(key) {
  const match = DATE_KEY.exec(key ?? "");
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return toDateKey(date) === key ? date : null;
}

/**
 * @param {string} value
 * @returns {Date|null} Local date-time, or null when invalid.
 */
export function parseDateTime(value) {
  const match = DATE_TIME.exec(value ?? "");
  if (!match) return null;
  const [, y, mo, d, h, mi] = match.map(Number);
  if (h > 23 || mi > 59) return null;
  const date = new Date(y, mo - 1, d, h, mi);
  return date.getFullYear() === y && date.getMonth() === mo - 1 && date.getDate() === d ? date : null;
}

/**
 * @param {Date} date
 * @returns {Date} Local midnight of the same day.
 */
export function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/**
 * @param {Date} date
 * @param {number} days
 * @returns {Date} Calendar-day arithmetic (safe across DST changes).
 */
export function addDays(date, days) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days, date.getHours(), date.getMinutes());
}

/**
 * @param {Date} date
 * @param {number} months
 * @returns {Date} The same day-of-month, or null-equivalent overflow handled by the caller.
 */
export function addMonthsRaw(date, months) {
  return new Date(date.getFullYear(), date.getMonth() + months, date.getDate(), date.getHours(), date.getMinutes());
}

/**
 * @param {Date} date
 * @returns {Date} Local midnight of the week's first day.
 */
export function startOfWeek(date) {
  const day = startOfDay(date);
  const offset = (day.getDay() - WEEK_START + 7) % 7;
  return addDays(day, -offset);
}

/**
 * @param {Date} date
 * @returns {Date}
 */
export function startOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

/**
 * @param {Date} a
 * @param {Date} b
 * @returns {boolean}
 */
export function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/**
 * Whole calendar days from a to b (local), ignoring DST hour shifts.
 * @param {Date} a
 * @param {Date} b
 * @returns {number}
 */
export function daysBetween(a, b) {
  const utcA = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  const utcB = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((utcB - utcA) / 86400000);
}

/**
 * @param {Date} date
 * @returns {number} Minutes since local midnight.
 */
export function minutesOfDay(date) {
  return date.getHours() * 60 + date.getMinutes();
}

/**
 * @param {Date} date
 * @param {Intl.DateTimeFormatOptions} options
 * @returns {string}
 */
export function formatDate(date, options) {
  return new Intl.DateTimeFormat(undefined, options).format(date);
}

/**
 * @param {Date} date
 * @returns {string} Localized short time, e.g. "09:30" or "9:30 AM".
 */
export function formatTime(date) {
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(date);
}
