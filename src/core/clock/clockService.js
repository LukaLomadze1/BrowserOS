/**
 * @file ClockService — alarms, the countdown timer, the stopwatch, and
 * the world-clock list.
 *
 * It runs from boot, independently of the Clock window, so alarms and
 * the timer fire while BrowserOS is open even when Clock is closed, and
 * a running stopwatch or timer survives closing the window or
 * reloading BrowserOS.
 *
 * Accuracy: nothing here counts ticks. The timer stores the wall-clock
 * time it ends (`endAt`) and the stopwatch the time it started plus the
 * time accumulated before its last pause, so displayed values are
 * always computed from Date.now(). Background-tab timer throttling can
 * delay *when* an alert is shown, never what time is reported. The
 * next due alarm or timer end is scheduled with a timeout that
 * re-checks at least every 30 seconds and whenever the page becomes
 * visible.
 *
 * Alerts appear only while BrowserOS is running. A one-time alarm whose
 * time passed while BrowserOS was closed is switched off and reported
 * as missed; a timer that ended while closed is reported as finished.
 *
 * Persistence (StorageService): "clock:alarms", "clock:timer",
 * "clock:stopwatch", "clock:worldClocks". Every record is validated on
 * load and malformed entries are dropped.
 *
 * Events (EventBus): "clock:alarmsChanged", "clock:alarmTriggered"
 * { alarm }, "clock:timerChanged", "clock:timerCompleted" { durationMs },
 * "clock:stopwatchChanged", "clock:worldClocksChanged".
 */

import { eventBus } from "../eventBus.js";
import { storage } from "../storage.js";
import { createId } from "../vfs/entry.js";
import { notificationService } from "../notifications/notificationService.js";
import { ALERT_SOUNDS } from "../../utils/alertSound.js";

const KEYS = Object.freeze({
  alarms: "clock:alarms",
  timer: "clock:timer",
  stopwatch: "clock:stopwatch",
  worldClocks: "clock:worldClocks",
});
const MAX_CHECK_INTERVAL_MS = 30_000;
/** A one-time alarm more than this late at startup counts as missed. */
const MISSED_GRACE_MS = 60_000;
const SNOOZE_MS = 5 * 60_000;
const MAX_LAPS = 200;
const MAX_TIMER_MS = 100 * 3_600_000 - 1000;
const SOUND_IDS = ALERT_SOUNDS.map((sound) => sound.id);
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * @typedef {object} Alarm
 * @property {string} id
 * @property {string} time - "HH:MM", local time.
 * @property {string} label
 * @property {number[]} days - Weekdays it repeats on (0 = Sunday); empty = once.
 * @property {boolean} enabled
 * @property {string} sound - An alertSound id.
 * @property {number|null} scheduledFor - Next trigger for one-time alarms (ms).
 * @property {number|null} snoozedUntil
 */

class ClockService {
  constructor() {
    /** @type {Alarm[]} */
    this._alarms = [];
    this._timer = { status: "idle", durationMs: 5 * 60_000, endAt: null, remainingMs: 5 * 60_000 };
    this._stopwatch = { startedAt: null, accumulatedMs: 0, laps: [] };
    /** @type {Array<{id: string, timeZone: string, city: string}>} */
    this._worldClocks = [];
    this._timeoutId = null;
    this._initialized = false;
    this._activeAlerts = new Map();
    this._visibilityHandler = () => {
      if (document.visibilityState === "visible") this._check();
    };
  }

  /**
   * Load saved state, report anything missed while closed, and start scheduling. Call once during boot.
   * @returns {void}
   */
  init() {
    if (this._initialized) return;
    this._initialized = true;
    this._load();
    this._reportMissed();
    document.addEventListener("visibilitychange", this._visibilityHandler);
    this._schedule();
  }

  // ---------------------------------------------------------------
  // Alarms
  // ---------------------------------------------------------------

  /** @returns {Alarm[]} Copies, ordered by time. */
  getAlarms() {
    return this._alarms.map((alarm) => ({ ...alarm, days: [...alarm.days] })).sort((a, b) => a.time.localeCompare(b.time));
  }

  /**
   * @param {Alarm} alarm
   * @param {number} [now]
   * @returns {number|null} Next time the alarm will ring (ms), or null when disabled.
   */
  nextTrigger(alarm, now = Date.now()) {
    if (!alarm.enabled) return null;
    if (alarm.snoozedUntil && alarm.snoozedUntil > now) return alarm.snoozedUntil;
    if (alarm.days.length === 0) return alarm.scheduledFor;
    const [hours, minutes] = alarm.time.split(":").map(Number);
    const base = new Date(now);
    for (let offset = 0; offset <= 7; offset += 1) {
      const candidate = new Date(base.getFullYear(), base.getMonth(), base.getDate() + offset, hours, minutes);
      if (candidate.getTime() > now && alarm.days.includes(candidate.getDay())) return candidate.getTime();
    }
    return null;
  }

  /**
   * @param {{time: string, label?: string, days?: number[], sound?: string, enabled?: boolean}} data
   * @returns {Alarm}
   */
  addAlarm(data) {
    const alarm = normalizeAlarm({ ...data, id: createId(), enabled: data.enabled ?? true, scheduledFor: null, snoozedUntil: null });
    if (!alarm) throw new Error("Enter a valid alarm time");
    this._armOneTime(alarm);
    this._alarms.push(alarm);
    this._saveAlarms();
    return { ...alarm };
  }

  /**
   * @param {string} id
   * @param {Partial<Alarm>} changes
   * @returns {Alarm}
   */
  updateAlarm(id, changes) {
    const index = this._alarms.findIndex((alarm) => alarm.id === id);
    if (index === -1) throw new Error("This alarm no longer exists");
    const previous = this._alarms[index];
    const alarm = normalizeAlarm({ ...previous, ...changes, id, snoozedUntil: null });
    if (!alarm) throw new Error("Enter a valid alarm time");
    const timingChanged = alarm.time !== previous.time || alarm.enabled !== previous.enabled || alarm.days.join() !== previous.days.join();
    if (timingChanged || !alarm.scheduledFor) this._armOneTime(alarm);
    this._alarms[index] = alarm;
    this._saveAlarms();
    return { ...alarm };
  }

  /**
   * @param {string} id
   * @returns {void}
   */
  removeAlarm(id) {
    this._alarms = this._alarms.filter((alarm) => alarm.id !== id);
    this._activeAlerts.get(id)?.dismiss();
    this._saveAlarms();
  }

  /**
   * @param {string} id
   * @returns {void}
   */
  snoozeAlarm(id) {
    const alarm = this._alarms.find((a) => a.id === id);
    if (!alarm) return;
    alarm.enabled = true;
    alarm.snoozedUntil = Date.now() + SNOOZE_MS;
    this._saveAlarms();
  }

  // ---------------------------------------------------------------
  // Timer
  // ---------------------------------------------------------------

  /**
   * @returns {{status: "idle"|"running"|"paused"|"finished", durationMs: number, remainingMs: number, endAt: number|null}}
   */
  getTimer() {
    const remainingMs = this._timer.status === "running" ? Math.max(0, this._timer.endAt - Date.now()) : this._timer.remainingMs;
    return { ...this._timer, remainingMs };
  }

  /**
   * @param {number} durationMs
   * @returns {void}
   */
  startTimer(durationMs) {
    const duration = Math.round(durationMs);
    if (!Number.isFinite(duration) || duration < 1000 || duration > MAX_TIMER_MS) throw new Error("Set a time between 1 second and 99:59:59");
    this._timer = { status: "running", durationMs: duration, endAt: Date.now() + duration, remainingMs: duration };
    this._saveTimer();
  }

  /** @returns {void} */
  pauseTimer() {
    if (this._timer.status !== "running") return;
    this._timer = { ...this._timer, status: "paused", remainingMs: Math.max(0, this._timer.endAt - Date.now()), endAt: null };
    this._saveTimer();
  }

  /** @returns {void} */
  resumeTimer() {
    if (this._timer.status !== "paused") return;
    this._timer = { ...this._timer, status: "running", endAt: Date.now() + this._timer.remainingMs };
    this._saveTimer();
  }

  /** @returns {void} */
  resetTimer() {
    this._activeAlerts.get("timer")?.dismiss();
    this._timer = { status: "idle", durationMs: this._timer.durationMs, endAt: null, remainingMs: this._timer.durationMs };
    this._saveTimer();
  }

  // ---------------------------------------------------------------
  // Stopwatch
  // ---------------------------------------------------------------

  /**
   * @returns {{running: boolean, elapsedMs: number, laps: number[]}} Laps are cumulative times.
   */
  getStopwatch() {
    const { startedAt, accumulatedMs, laps } = this._stopwatch;
    return { running: startedAt !== null, elapsedMs: accumulatedMs + (startedAt !== null ? Date.now() - startedAt : 0), laps: [...laps] };
  }

  /** @returns {void} */
  startStopwatch() {
    if (this._stopwatch.startedAt !== null) return;
    this._stopwatch = { ...this._stopwatch, startedAt: Date.now() };
    this._saveStopwatch();
  }

  /** @returns {void} */
  pauseStopwatch() {
    if (this._stopwatch.startedAt === null) return;
    this._stopwatch = { ...this._stopwatch, accumulatedMs: this.getStopwatch().elapsedMs, startedAt: null };
    this._saveStopwatch();
  }

  /** @returns {void} */
  lapStopwatch() {
    if (this._stopwatch.startedAt === null) return;
    this._stopwatch = { ...this._stopwatch, laps: [...this._stopwatch.laps, this.getStopwatch().elapsedMs].slice(-MAX_LAPS) };
    this._saveStopwatch();
  }

  /** @returns {void} */
  resetStopwatch() {
    this._stopwatch = { startedAt: null, accumulatedMs: 0, laps: [] };
    this._saveStopwatch();
  }

  // ---------------------------------------------------------------
  // World clocks
  // ---------------------------------------------------------------

  /** @returns {Array<{id: string, timeZone: string, city: string}>} */
  getWorldClocks() {
    return this._worldClocks.map((clock) => ({ ...clock }));
  }

  /**
   * @param {string} city
   * @param {string} timeZone - IANA zone, validated with Intl.
   * @returns {void}
   */
  addWorldClock(city, timeZone) {
    if (!isValidTimeZone(timeZone)) throw new Error(`"${timeZone}" is not a recognized time zone`);
    if (this._worldClocks.some((clock) => clock.timeZone === timeZone && clock.city === city)) return;
    this._worldClocks.push({ id: createId(), city: city.slice(0, 80), timeZone });
    this._saveWorldClocks();
  }

  /**
   * @param {string} id
   * @returns {void}
   */
  removeWorldClock(id) {
    this._worldClocks = this._worldClocks.filter((clock) => clock.id !== id);
    this._saveWorldClocks();
  }

  // ---------------------------------------------------------------
  // Scheduling
  // ---------------------------------------------------------------

  /** @returns {void} */
  _schedule() {
    window.clearTimeout(this._timeoutId);
    const now = Date.now();
    const candidates = this._alarms.map((alarm) => this.nextTrigger(alarm, now)).filter((at) => at !== null);
    if (this._timer.status === "running") candidates.push(this._timer.endAt);
    const next = candidates.length ? Math.min(...candidates) : Infinity;
    const delay = Math.max(0, Math.min(next - now, MAX_CHECK_INTERVAL_MS));
    this._timeoutId = window.setTimeout(() => this._check(), delay);
  }

  /** @returns {void} */
  _check() {
    const now = Date.now();
    let alarmsChanged = false;

    for (const alarm of this._alarms) {
      if (!alarm.enabled) continue;
      const due = alarm.snoozedUntil ? alarm.snoozedUntil : alarm.days.length === 0 ? alarm.scheduledFor : null;
      if (due !== null && due <= now) {
        this._ring(alarm);
        alarm.snoozedUntil = null;
        if (alarm.days.length === 0) {
          alarm.enabled = false;
          alarm.scheduledFor = null;
        }
        alarmsChanged = true;
      } else if (alarm.days.length > 0 && !alarm.snoozedUntil) {
        const lastChecked = alarm._lastChecked ?? now;
        const ringAt = this.nextTrigger(alarm, lastChecked);
        if (ringAt !== null && ringAt <= now) this._ring(alarm);
      }
      alarm._lastChecked = now;
    }
    if (alarmsChanged) this._saveAlarms({ reschedule: false });

    if (this._timer.status === "running" && this._timer.endAt <= now) this._completeTimer(false);
    this._schedule();
  }

  /**
   * @param {Alarm} alarm
   * @returns {void}
   */
  _ring(alarm) {
    this._activeAlerts.get(alarm.id)?.dismiss();
    const handle = notificationService.notify({
      title: alarm.label || "Alarm",
      body: formatAlarmTime(alarm.time),
      icon: "\u23f0",
      source: "clock",
      urgency: "alarm",
      sound: alarm.sound === "none" ? null : alarm.sound,
      loopSound: true,
      actions: [
        { id: "snooze", label: "Snooze 5 min" },
        { id: "dismiss", label: "Dismiss", primary: true },
      ],
      onAction: (actionId) => {
        if (actionId === "snooze") this.snoozeAlarm(alarm.id);
      },
      onDismiss: () => this._activeAlerts.delete(alarm.id),
    });
    this._activeAlerts.set(alarm.id, handle);
    eventBus.emit("clock:alarmTriggered", Object.freeze({ alarm: { ...alarm, days: [...alarm.days] } }));
  }

  /**
   * @param {boolean} late - True when it ended while BrowserOS was closed.
   * @returns {void}
   */
  _completeTimer(late) {
    const durationMs = this._timer.durationMs;
    this._timer = { status: "finished", durationMs, endAt: null, remainingMs: 0 };
    this._saveTimer({ reschedule: false });
    this._activeAlerts.get("timer")?.dismiss();
    const handle = notificationService.notify({
      title: late ? "Timer finished while BrowserOS was closed" : "Timer finished",
      body: `${formatDuration(durationMs)} timer`,
      icon: "\u29d7",
      source: "clock",
      urgency: late ? "normal" : "alarm",
      sound: late ? null : "digital",
      loopSound: !late,
      actions: [
        { id: "restart", label: "Restart" },
        { id: "dismiss", label: "Dismiss", primary: true },
      ],
      onAction: (actionId) => {
        if (actionId === "restart") this.startTimer(durationMs);
      },
      onDismiss: () => this._activeAlerts.delete("timer"),
    });
    this._activeAlerts.set("timer", handle);
    eventBus.emit("clock:timerCompleted", Object.freeze({ durationMs }));
  }

  /** @returns {void} */
  _reportMissed() {
    const now = Date.now();
    let changed = false;
    for (const alarm of this._alarms) {
      if (!alarm.enabled) continue;
      if (alarm.snoozedUntil && alarm.snoozedUntil < now - MISSED_GRACE_MS) {
        alarm.snoozedUntil = null;
        changed = true;
      }
      if (alarm.days.length === 0 && alarm.scheduledFor !== null && alarm.scheduledFor < now - MISSED_GRACE_MS) {
        alarm.enabled = false;
        alarm.scheduledFor = null;
        changed = true;
        notificationService.notify({
          title: `Missed alarm: ${alarm.label || "Alarm"}`,
          body: `${formatAlarmTime(alarm.time)} \u2014 BrowserOS wasn't running`,
          icon: "\u23f0",
          source: "clock",
          timeout: 20000,
        });
      }
    }
    if (changed) this._saveAlarms({ reschedule: false });
    if (this._timer.status === "running" && this._timer.endAt < now - MISSED_GRACE_MS) this._completeTimer(true);
  }

  /**
   * One-time alarms ring at the next occurrence of their time after now.
   * @param {Alarm} alarm
   * @returns {void}
   */
  _armOneTime(alarm) {
    if (alarm.days.length > 0 || !alarm.enabled) {
      alarm.scheduledFor = null;
      return;
    }
    const [hours, minutes] = alarm.time.split(":").map(Number);
    const now = new Date();
    let candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes);
    if (candidate.getTime() <= now.getTime()) candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, hours, minutes);
    alarm.scheduledFor = candidate.getTime();
  }

  // ---------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------

  /** @returns {void} */
  _load() {
    const alarms = storage.get(KEYS.alarms, []);
    this._alarms = Array.isArray(alarms) ? alarms.map(normalizeAlarm).filter(Boolean) : [];

    const timer = storage.get(KEYS.timer, null);
    if (timer && ["idle", "running", "paused", "finished"].includes(timer.status) && Number.isFinite(timer.durationMs) && timer.durationMs >= 1000 && timer.durationMs <= MAX_TIMER_MS) {
      const running = timer.status === "running" && Number.isFinite(timer.endAt);
      this._timer = {
        status: timer.status === "running" && !running ? "idle" : timer.status,
        durationMs: timer.durationMs,
        endAt: running ? timer.endAt : null,
        remainingMs: Number.isFinite(timer.remainingMs) ? Math.min(Math.max(0, timer.remainingMs), timer.durationMs) : timer.durationMs,
      };
    }

    const stopwatch = storage.get(KEYS.stopwatch, null);
    if (stopwatch && Number.isFinite(stopwatch.accumulatedMs) && stopwatch.accumulatedMs >= 0) {
      this._stopwatch = {
        startedAt: Number.isFinite(stopwatch.startedAt) && stopwatch.startedAt <= Date.now() ? stopwatch.startedAt : null,
        accumulatedMs: stopwatch.accumulatedMs,
        laps: Array.isArray(stopwatch.laps) ? stopwatch.laps.filter((lap) => Number.isFinite(lap) && lap >= 0).slice(-MAX_LAPS) : [],
      };
    }

    const clocks = storage.get(KEYS.worldClocks, null);
    if (Array.isArray(clocks)) {
      this._worldClocks = clocks
        .filter((clock) => clock && typeof clock.city === "string" && isValidTimeZone(clock.timeZone))
        .map((clock) => ({ id: typeof clock.id === "string" ? clock.id : createId(), city: clock.city.slice(0, 80), timeZone: clock.timeZone }));
    } else {
      this._worldClocks = [
        { id: createId(), city: "London", timeZone: "Europe/London" },
        { id: createId(), city: "New York", timeZone: "America/New_York" },
        { id: createId(), city: "Tokyo", timeZone: "Asia/Tokyo" },
      ].filter((clock) => isValidTimeZone(clock.timeZone));
    }
  }

  /**
   * @param {{reschedule?: boolean}} [options]
   * @returns {void}
   */
  _saveAlarms({ reschedule = true } = {}) {
    storage.set(KEYS.alarms, this._alarms.map(({ _lastChecked, ...alarm }) => alarm));
    eventBus.emit("clock:alarmsChanged", Object.freeze({}));
    if (reschedule) this._schedule();
  }

  /**
   * @param {{reschedule?: boolean}} [options]
   * @returns {void}
   */
  _saveTimer({ reschedule = true } = {}) {
    storage.set(KEYS.timer, this._timer);
    eventBus.emit("clock:timerChanged", Object.freeze({}));
    if (reschedule) this._schedule();
  }

  /** @returns {void} */
  _saveStopwatch() {
    storage.set(KEYS.stopwatch, this._stopwatch);
    eventBus.emit("clock:stopwatchChanged", Object.freeze({}));
  }

  /** @returns {void} */
  _saveWorldClocks() {
    storage.set(KEYS.worldClocks, this._worldClocks);
    eventBus.emit("clock:worldClocksChanged", Object.freeze({}));
  }
}

/**
 * @param {object} input
 * @returns {Alarm|null}
 */
function normalizeAlarm(input) {
  if (!input || typeof input !== "object" || typeof input.id !== "string" || !TIME_PATTERN.test(input.time ?? "")) return null;
  const days = Array.isArray(input.days) ? [...new Set(input.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort() : [];
  return {
    id: input.id,
    time: input.time,
    label: typeof input.label === "string" ? input.label.trim().slice(0, 60) : "",
    days,
    enabled: input.enabled !== false,
    sound: SOUND_IDS.includes(input.sound) ? input.sound : "chime",
    scheduledFor: Number.isFinite(input.scheduledFor) ? input.scheduledFor : null,
    snoozedUntil: Number.isFinite(input.snoozedUntil) ? input.snoozedUntil : null,
  };
}

/**
 * @param {string} timeZone
 * @returns {boolean}
 */
export function isValidTimeZone(timeZone) {
  if (typeof timeZone !== "string" || !timeZone) return false;
  try {
    new Intl.DateTimeFormat(undefined, { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} time - "HH:MM"
 * @returns {string} Localized time.
 */
export function formatAlarmTime(time) {
  const [hours, minutes] = time.split(":").map(Number);
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(new Date(2000, 0, 1, hours, minutes));
}

/**
 * @param {number} ms
 * @param {{centiseconds?: boolean}} [options]
 * @returns {string} "H:MM:SS", "MM:SS", or with centiseconds "MM:SS.cc".
 */
export function formatDuration(ms, { centiseconds = false } = {}) {
  const totalCentis = Math.floor(Math.max(0, ms) / 10);
  const totalSeconds = centiseconds ? Math.floor(totalCentis / 100) : Math.ceil(Math.max(0, ms) / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (value) => String(value).padStart(2, "0");
  const base = hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
  return centiseconds ? `${base}.${pad(totalCentis % 100)}` : base;
}

/**
 * Singleton clock service shared across the OS.
 * @type {ClockService}
 */
export const clockService = new ClockService();
