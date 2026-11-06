/**
 * @file CalendarService — owns calendar events and their reminders.
 *
 * It runs from boot, independently of the Calendar window, so
 * reminders fire while BrowserOS is open even when Calendar is closed.
 * The Calendar app is a view onto this service.
 *
 * Persistence: one JSON document in the VFS,
 *   /Documents/Calendar/events.json
 *   { format: "browseros-calendar", version: 1, events: [...] }
 * read and written only through the public VFS API. Every event is
 * validated on load; invalid events are dropped with a warning. A file
 * that cannot be parsed is renamed to "events (unreadable <date>).json"
 * instead of being overwritten, so data is never destroyed
 * automatically. Writes are serialized through a queue so overlapping
 * edits can't interleave.
 *
 * Reminders: an event may carry `reminder` = minutes before start.
 * The next due reminder is scheduled with a timer that re-checks at
 * least once a minute and whenever the page becomes visible again, so
 * throttled background timers only delay a reminder, never lose it.
 * Reminders fire only while BrowserOS is running; ones that came due
 * while it was closed are not replayed. Fired reminders are remembered
 * (per occurrence) so a reload never repeats them.
 *
 * Events (EventBus):
 *  - "calendar:ready"         {}
 *  - "calendar:eventCreated"  { event }
 *  - "calendar:eventUpdated"  { event, previous }
 *  - "calendar:eventDeleted"  { event }
 *  - "calendar:changed"       { reason }  — after any of the above
 *  - "calendar:reminder"      { event, occurrenceId, start }
 */

import { eventBus } from "../eventBus.js";
import { storage } from "../storage.js";
import { createId } from "../vfs/entry.js";
import { notificationService } from "../notifications/notificationService.js";
import { expandEvents, eventBounds } from "./recurrence.js";
import { parseDateKey, parseDateTime, formatTime, formatDate } from "./calendarTime.js";
import { ACCENT_IDS } from "../settings/accentPresets.js";

export const CALENDAR_FOLDER = "/Documents/Calendar";
export const CALENDAR_FILE = `${CALENDAR_FOLDER}/events.json`;
const FORMAT_ID = "browseros-calendar";
const FORMAT_VERSION = 1;

const FIRED_REMINDERS_KEY = "calendar:firedReminders";
const MAX_CHECK_INTERVAL_MS = 60_000;
/** Reminders are looked up this far ahead of now. */
const LOOKAHEAD_DAYS = 8;
const FIRED_RETENTION_MS = 3 * 86_400_000;

export const EVENT_COLORS = ACCENT_IDS;
export const REMINDER_OPTIONS = Object.freeze([null, 0, 5, 10, 15, 30, 60, 1440]);
const FREQUENCIES = ["daily", "weekly", "monthly", "yearly"];

class CalendarService {
  constructor() {
    this._vfs = null;
    this._appManager = null;
    /** @type {Map<string, object>} */
    this._events = new Map();
    this._ready = null;
    this._writeQueue = Promise.resolve();
    this._timerId = null;
    this._lastCheck = Date.now();
    this._loadError = null;
    this._visibilityHandler = () => {
      if (document.visibilityState === "visible") this._checkReminders();
    };
  }

  /**
   * Load events and start reminders. Call once during boot, after the VFS is ready.
   * @param {{vfs: object, appManager?: object}} deps
   * @returns {Promise<void>}
   */
  init({ vfs, appManager }) {
    if (this._ready) return this._ready;
    this._vfs = vfs;
    this._appManager = appManager ?? null;
    this._ready = this._load().then(() => {
      this._lastCheck = Date.now();
      this._scheduleReminders();
      document.addEventListener("visibilitychange", this._visibilityHandler);
      eventBus.emit("calendar:ready", Object.freeze({}));
    });
    return this._ready;
  }

  /** @returns {Promise<void>} Resolves once events are loaded. */
  ready() {
    return this._ready ?? Promise.reject(new Error("CalendarService.init() has not been called"));
  }

  /** @returns {string|null} A message when the stored file could not be read. */
  getLoadError() {
    return this._loadError;
  }

  // ---------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------

  /** @returns {object[]} Copies of every stored event. */
  getEvents() {
    return [...this._events.values()].map(cloneEvent);
  }

  /**
   * @param {string} id
   * @returns {object|null}
   */
  getEvent(id) {
    const event = this._events.get(id);
    return event ? cloneEvent(event) : null;
  }

  /**
   * @param {Date} rangeStart
   * @param {Date} rangeEnd
   * @returns {import("./recurrence.js").Occurrence[]}
   */
  getOccurrences(rangeStart, rangeEnd) {
    return expandEvents([...this._events.values()].map(cloneEvent), rangeStart, rangeEnd);
  }

  /**
   * Text search over title, description, and location.
   * @param {string} query
   * @returns {object[]} Matching events, ordered by first start.
   */
  search(query) {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    return this.getEvents()
      .filter((event) => [event.title, event.description, event.location].some((field) => field.toLowerCase().includes(needle)))
      .sort((a, b) => (eventBounds(a)?.start ?? 0) - (eventBounds(b)?.start ?? 0));
  }

  // ---------------------------------------------------------------
  // Mutations
  // ---------------------------------------------------------------

  /**
   * @param {object} data - Event fields (see normalizeEvent).
   * @returns {Promise<object>} The created event.
   */
  async create(data) {
    await this.ready();
    const now = Date.now();
    const event = normalizeEvent({ ...data, id: createId(), createdAt: now, updatedAt: now });
    if (!event) throw new Error("The event is incomplete or its dates are invalid");
    await this._commit(() => this._events.set(event.id, event), () => this._events.delete(event.id));
    this._afterChange("calendar:eventCreated", { event: cloneEvent(event) }, "created");
    return cloneEvent(event);
  }

  /**
   * Update an event, keeping its identity (id and creation time).
   * @param {string} id
   * @param {object} changes
   * @returns {Promise<object>}
   */
  async update(id, changes) {
    await this.ready();
    const previous = this._events.get(id);
    if (!previous) throw new Error("This event no longer exists");
    const event = normalizeEvent({ ...previous, ...changes, id, createdAt: previous.createdAt, updatedAt: Date.now() });
    if (!event) throw new Error("The event is incomplete or its dates are invalid");
    await this._commit(() => this._events.set(id, event), () => this._events.set(id, previous));
    this._afterChange("calendar:eventUpdated", { event: cloneEvent(event), previous: cloneEvent(previous) }, "updated");
    return cloneEvent(event);
  }

  /**
   * @param {string} id
   * @returns {Promise<void>}
   */
  async remove(id) {
    await this.ready();
    const event = this._events.get(id);
    if (!event) return;
    await this._commit(() => this._events.delete(id), () => this._events.set(id, event));
    this._afterChange("calendar:eventDeleted", { event: cloneEvent(event) }, "deleted");
  }

  /**
   * Remove one occurrence of a recurring event.
   * @param {string} id
   * @param {string} dateKey
   * @returns {Promise<object>}
   */
  async excludeOccurrence(id, dateKey) {
    const event = this._events.get(id);
    if (!event) throw new Error("This event no longer exists");
    return this.update(id, { exceptions: [...new Set([...event.exceptions, dateKey])] });
  }

  /**
   * Edit only one occurrence of a recurring event: it becomes a separate,
   * non-recurring event and the series skips that date.
   * @param {string} id
   * @param {string} dateKey
   * @param {object} data - Fields for the detached occurrence.
   * @returns {Promise<object>} The new single event.
   */
  async detachOccurrence(id, dateKey, data) {
    await this.excludeOccurrence(id, dateKey);
    return this.create({ ...data, recurrence: null, exceptions: [] });
  }

  // ---------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------

  /**
   * Apply an in-memory change and persist it; if the write fails, undo
   * the change so memory never disagrees with the stored file.
   * @param {() => void} apply
   * @param {() => void} revert
   * @returns {Promise<void>}
   */
  async _commit(apply, revert) {
    apply();
    try {
      await this._persist();
    } catch (error) {
      revert();
      throw new Error(`The calendar couldn't be saved: ${error.message}`);
    }
  }

  /** @returns {Promise<void>} */
  async _load() {
    this._events.clear();
    this._loadError = null;
    let raw;
    try {
      if (!(await this._vfs.exists(CALENDAR_FILE))) return;
      raw = await this._vfs.read(CALENDAR_FILE);
    } catch (error) {
      this._loadError = `Calendar data couldn't be read: ${error.message}`;
      console.error("[CalendarService]", this._loadError);
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
      if (!parsed || parsed.format !== FORMAT_ID || !Array.isArray(parsed.events)) throw new Error("not a calendar document");
    } catch (error) {
      await this._quarantineUnreadableFile(error);
      return;
    }

    for (const stored of parsed.events) {
      const event = normalizeEvent(stored);
      if (event && !this._events.has(event.id)) {
        this._events.set(event.id, event);
      } else {
        console.warn("[CalendarService] skipped an invalid or duplicate stored event:", stored);
      }
    }
  }

  /**
   * @param {Error} error
   * @returns {Promise<void>}
   */
  async _quarantineUnreadableFile(error) {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    const name = `events (unreadable ${stamp}).json`;
    try {
      await this._vfs.rename(CALENDAR_FILE, name);
      this._loadError = `The calendar file couldn't be read and was kept as "${name}". A new calendar was started.`;
    } catch (renameError) {
      this._loadError = `The calendar file couldn't be read (${error.message}).`;
      console.error("[CalendarService] could not set aside the unreadable calendar file:", renameError);
    }
    console.warn("[CalendarService]", this._loadError);
  }

  /** @returns {Promise<void>} */
  _persist() {
    const snapshot = JSON.stringify({ format: FORMAT_ID, version: FORMAT_VERSION, events: [...this._events.values()] }, null, 1);
    const write = async () => {
      if (!(await this._vfs.exists("/Documents"))) await this._vfs.createFolder("/Documents");
      if (!(await this._vfs.exists(CALENDAR_FOLDER))) await this._vfs.createFolder(CALENDAR_FOLDER);
      if (await this._vfs.exists(CALENDAR_FILE)) {
        await this._vfs.write(CALENDAR_FILE, snapshot);
      } else {
        await this._vfs.createFile(CALENDAR_FILE, snapshot);
      }
    };
    this._writeQueue = this._writeQueue.then(write, write);
    return this._writeQueue;
  }

  /**
   * @param {string} name
   * @param {object} payload
   * @param {string} reason
   * @returns {void}
   */
  _afterChange(name, payload, reason) {
    eventBus.emit(name, Object.freeze(payload));
    eventBus.emit("calendar:changed", Object.freeze({ reason }));
    this._scheduleReminders();
  }

  // ---------------------------------------------------------------
  // Reminders
  // ---------------------------------------------------------------

  /** @returns {void} */
  _scheduleReminders() {
    window.clearTimeout(this._timerId);
    const now = Date.now();
    const next = this._dueReminders(now, now + LOOKAHEAD_DAYS * 86_400_000)[0];
    const delay = next ? Math.max(0, Math.min(next.at - now, MAX_CHECK_INTERVAL_MS)) : MAX_CHECK_INTERVAL_MS;
    this._timerId = window.setTimeout(() => this._checkReminders(), delay);
  }

  /** @returns {void} */
  _checkReminders() {
    const now = Date.now();
    const fired = loadFired(now);
    for (const reminder of this._dueReminders(this._lastCheck - 1000, now)) {
      if (fired[reminder.occurrence.id]) continue;
      fired[reminder.occurrence.id] = now;
      this._notify(reminder.occurrence);
    }
    storage.set(FIRED_REMINDERS_KEY, fired);
    this._lastCheck = now;
    this._scheduleReminders();
  }

  /**
   * @param {number} fromMs
   * @param {number} toMs
   * @returns {Array<{at: number, occurrence: object}>} Reminders due in (fromMs, toMs], soonest first.
   */
  _dueReminders(fromMs, toMs) {
    const events = [...this._events.values()].filter((event) => event.reminder !== null);
    if (events.length === 0) return [];
    // An occurrence starting up to a day after `toMs` can have a reminder due inside the window.
    const occurrences = expandEvents(events, new Date(fromMs), new Date(toMs + 86_400_000 + 1));
    return occurrences
      .map((occurrence) => ({ at: occurrence.start.getTime() - occurrence.event.reminder * 60_000, occurrence }))
      .filter((reminder) => reminder.at > fromMs && reminder.at <= toMs)
      .sort((a, b) => a.at - b.at);
  }

  /**
   * @param {object} occurrence
   * @returns {void}
   */
  _notify(occurrence) {
    const { event, start } = occurrence;
    const minutes = Math.round((start.getTime() - Date.now()) / 60_000);
    const when = event.allDay
      ? `All day, ${formatDate(start, { weekday: "short", day: "numeric", month: "short" })}`
      : minutes <= 0
        ? `Now \u00b7 ${formatTime(start)}`
        : `In ${formatLead(minutes)} \u00b7 ${formatTime(start)}`;
    const body = [when, event.location].filter(Boolean).join(" \u00b7 ");

    notificationService.notify({
      title: event.title,
      body,
      icon: "\u25a3",
      source: "calendar",
      sound: "chime",
      timeout: 15000,
      actions: [{ id: "open", label: "Open in Calendar", primary: true }],
      onAction: () => this._appManager?.launch("calendar", { date: occurrence.dateKey, eventId: event.id }),
    });
    eventBus.emit("calendar:reminder", Object.freeze({ event: cloneEvent(event), occurrenceId: occurrence.id, start: start.getTime() }));
  }
}

/**
 * Validate and normalize an event record.
 * @param {object} input
 * @returns {object|null} A clean event, or null when it can't be valid.
 */
export function normalizeEvent(input) {
  if (!input || typeof input !== "object" || typeof input.id !== "string" || !input.id) return null;
  const title = typeof input.title === "string" ? input.title.trim().slice(0, 200) : "";
  if (!title) return null;
  const allDay = Boolean(input.allDay);

  let start;
  let end;
  if (allDay) {
    const startDate = parseDateKey(input.start);
    const endDate = parseDateKey(input.end ?? input.start);
    if (!startDate || !endDate || endDate < startDate) return null;
    start = input.start;
    end = input.end ?? input.start;
  } else {
    const startTime = parseDateTime(input.start);
    const endTime = parseDateTime(input.end);
    if (!startTime || !endTime || endTime <= startTime) return null;
    start = input.start;
    end = input.end;
  }

  let recurrence = null;
  if (input.recurrence && FREQUENCIES.includes(input.recurrence.freq)) {
    const interval = Number.isInteger(input.recurrence.interval) && input.recurrence.interval > 0 ? Math.min(input.recurrence.interval, 99) : 1;
    const until = parseDateKey(input.recurrence.until) ? input.recurrence.until : null;
    const count = Number.isInteger(input.recurrence.count) && input.recurrence.count > 0 ? Math.min(input.recurrence.count, 999) : null;
    recurrence = { freq: input.recurrence.freq, interval, until, count };
  }

  return {
    id: input.id,
    title,
    description: typeof input.description === "string" ? input.description.slice(0, 5000) : "",
    location: typeof input.location === "string" ? input.location.trim().slice(0, 200) : "",
    color: EVENT_COLORS.includes(input.color) ? input.color : EVENT_COLORS[0],
    allDay,
    start,
    end,
    recurrence,
    exceptions: Array.isArray(input.exceptions) ? [...new Set(input.exceptions.filter((key) => parseDateKey(key)))] : [],
    reminder: REMINDER_OPTIONS.includes(input.reminder) ? input.reminder : null,
    createdAt: Number.isFinite(input.createdAt) ? input.createdAt : Date.now(),
    updatedAt: Number.isFinite(input.updatedAt) ? input.updatedAt : Date.now(),
  };
}

/**
 * @param {object} event
 * @returns {object}
 */
function cloneEvent(event) {
  return { ...event, recurrence: event.recurrence ? { ...event.recurrence } : null, exceptions: [...event.exceptions] };
}

/**
 * @param {number} now
 * @returns {Record<string, number>} Fired reminder ids, pruned of old entries.
 */
function loadFired(now) {
  const stored = storage.get(FIRED_REMINDERS_KEY, {});
  const fired = {};
  if (stored && typeof stored === "object") {
    for (const [id, at] of Object.entries(stored)) {
      if (Number.isFinite(at) && now - at < FIRED_RETENTION_MS) fired[id] = at;
    }
  }
  return fired;
}

/**
 * @param {number} minutes
 * @returns {string}
 */
function formatLead(minutes) {
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 1440) return `${Math.round(minutes / 60)} h`;
  const days = Math.round(minutes / 1440);
  return `${days} day${days === 1 ? "" : "s"}`;
}

/**
 * Singleton calendar service shared across the OS.
 * @type {CalendarService}
 */
export const calendarService = new CalendarService();
