/**
 * @file SystemClock — the background service that keeps the taskbar
 * clock (and anything else showing the current time) up to date.
 *
 * It never counts ticks: each tick reads `Date.now()` and schedules the
 * next one for the start of the following minute (or second, while
 * seconds are displayed), so the displayed time is correct even after
 * the browser throttled timers in a background tab. A tick is also
 * emitted as soon as the page becomes visible again and whenever the
 * precision changes.
 *
 * Events (EventBus): "system:clockTick" { now }
 */

import { eventBus } from "../eventBus.js";

class SystemClock {
  constructor() {
    this._running = false;
    this._timerId = null;
    this._precision = "minute";
    this._lastTick = null;
    this._visibilityHandler = () => {
      if (document.visibilityState === "visible" && this._running) this._tick();
    };
  }

  /** @returns {void} */
  start() {
    if (this._running) return;
    this._running = true;
    document.addEventListener("visibilitychange", this._visibilityHandler);
    this._tick();
  }

  /** @returns {void} */
  stop() {
    if (!this._running) return;
    this._running = false;
    window.clearTimeout(this._timerId);
    this._timerId = null;
    document.removeEventListener("visibilitychange", this._visibilityHandler);
  }

  /** @returns {boolean} */
  isRunning() {
    return this._running;
  }

  /**
   * @param {"minute"|"second"} precision
   * @returns {void}
   */
  setPrecision(precision) {
    const next = precision === "second" ? "second" : "minute";
    if (next === this._precision) return;
    this._precision = next;
    if (this._running) this._tick();
  }

  /** @returns {{summary: string, timers: number}} Status for Task Manager. */
  getDetails() {
    return {
      summary: `Updates every ${this._precision}${this._lastTick ? ` \u00b7 last update ${new Date(this._lastTick).toLocaleTimeString()}` : ""}`,
      timers: this._timerId !== null ? 1 : 0,
    };
  }

  /** @returns {void} */
  _tick() {
    window.clearTimeout(this._timerId);
    const now = Date.now();
    this._lastTick = now;
    eventBus.emit("system:clockTick", Object.freeze({ now }));
    const unit = this._precision === "second" ? 1000 : 60_000;
    // Aim just past the next boundary so the new minute/second has started.
    const delay = unit - (now % unit) + 20;
    this._timerId = window.setTimeout(() => this._tick(), delay);
  }
}

/**
 * @param {Date} date
 * @param {{format?: "auto"|"12h"|"24h", seconds?: boolean}} [options]
 * @returns {string} The time formatted for the taskbar and date panel.
 */
export function formatClockTime(date, { format = "auto", seconds = false } = {}) {
  const options = { hour: "numeric", minute: "2-digit" };
  if (seconds) options.second = "2-digit";
  if (format === "12h") options.hourCycle = "h12";
  if (format === "24h") {
    options.hourCycle = "h23";
    options.hour = "2-digit";
  }
  return new Intl.DateTimeFormat(undefined, options).format(date);
}

/**
 * Singleton system clock service.
 * @type {SystemClock}
 */
export const systemClock = new SystemClock();
