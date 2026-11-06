/**
 * @file AppMonitor — the "app-monitor" background service: application
 * error reporting and main-thread responsiveness.
 *
 * Errors: uncaught exceptions, unhandled promise rejections, and
 * exceptions thrown by EventBus listeners are attributed to an application when their stack trace points into that
 * application's folder (`src/apps/<id>/`). Attributed errors are
 * recorded on the application (AppManager.recordError — shown in Task
 * Manager) and produce at most one notification per application per
 * minute. Applications that fail to load or launch
 * ("application:crashed") always produce a notification. Errors that
 * can't be attributed are counted as system errors.
 *
 * Responsiveness: a heartbeat measures how late the main thread runs a
 * short timer. Every application shares the page's one main thread, so
 * a stall can be detected but not attributed to a particular
 * application; Task Manager reports it for BrowserOS as a whole. Time
 * spent in a hidden tab is ignored, because browsers deliberately delay
 * timers there.
 */

import { eventBus } from "../eventBus.js";
import { notificationService } from "../notifications/notificationService.js";

const HEARTBEAT_MS = 500;
const SAMPLE_WINDOW = 120; // 60 seconds of samples
const STALL_THRESHOLD_MS = 1000;
const NOTIFY_INTERVAL_MS = 60_000;
const APP_PATH = /\/src\/apps\/([a-z0-9-]+)\//i;

class AppMonitor {
  constructor() {
    /** @type {import("../appManager.js").AppManager|null} */
    this._appManager = null;
    this._running = false;
    this._heartbeatId = null;
    this._expected = 0;
    this._lags = [];
    this._lastStall = null;
    this._stallCount = 0;
    this._systemErrors = 0;
    this._attributedErrors = 0;
    /** @type {Map<string, number>} appId -> last notification time */
    this._lastNotified = new Map();
    this._cleanups = [];
    this._onError = (event) => this._handleError(event.error ?? event.message, event.filename);
    this._onRejection = (event) => this._handleError(event.reason, null);
    this._onVisibility = () => {
      // Restart measurement: time in a hidden tab is not a stall.
      this._expected = performance.now() + HEARTBEAT_MS;
    };
  }

  /**
   * @param {{appManager: import("../appManager.js").AppManager}} deps
   * @returns {void}
   */
  configure({ appManager }) {
    this._appManager = appManager;
  }

  /** @returns {void} */
  start() {
    if (this._running) return;
    this._running = true;
    window.addEventListener("error", this._onError);
    window.addEventListener("unhandledrejection", this._onRejection);
    document.addEventListener("visibilitychange", this._onVisibility);
    eventBus.setListenerErrorHandler((error) => this._handleError(error, null));
    this._cleanups.push(eventBus.on("application:crashed", (payload) => this._notifyCrash(payload)));
    this._expected = performance.now() + HEARTBEAT_MS;
    this._heartbeatId = window.setInterval(() => this._beat(), HEARTBEAT_MS);
  }

  /** @returns {void} */
  stop() {
    if (!this._running) return;
    this._running = false;
    window.removeEventListener("error", this._onError);
    window.removeEventListener("unhandledrejection", this._onRejection);
    document.removeEventListener("visibilitychange", this._onVisibility);
    eventBus.setListenerErrorHandler(null);
    for (const cleanup of this._cleanups) cleanup();
    this._cleanups = [];
    window.clearInterval(this._heartbeatId);
    this._heartbeatId = null;
    this._lags = [];
  }

  /** @returns {{summary: string, timers: number}} */
  getDetails() {
    const { maxLagMs } = this.getResponsiveness();
    const errors = this._attributedErrors + this._systemErrors;
    return {
      summary: `${errors} error${errors === 1 ? "" : "s"} recorded \u00b7 longest delay in the last minute ${maxLagMs} ms`,
      timers: this._heartbeatId !== null ? 1 : 0,
    };
  }

  /**
   * @returns {{measuring: boolean, currentLagMs: number, maxLagMs: number, averageLagMs: number, stallCount: number, lastStall: {at: number, durationMs: number}|null}}
   *   Main-thread timer delays measured over the last minute while BrowserOS was visible.
   */
  getResponsiveness() {
    const lags = this._lags;
    return {
      measuring: this._running,
      currentLagMs: lags.length ? lags[lags.length - 1] : 0,
      maxLagMs: lags.length ? Math.max(...lags) : 0,
      averageLagMs: lags.length ? Math.round(lags.reduce((sum, lag) => sum + lag, 0) / lags.length) : 0,
      stallCount: this._stallCount,
      lastStall: this._lastStall ? { ...this._lastStall } : null,
    };
  }

  /** @returns {{attributed: number, system: number}} Errors seen since BrowserOS started. */
  getErrorCounts() {
    return { attributed: this._attributedErrors, system: this._systemErrors };
  }

  // ---------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------

  /** @returns {void} */
  _beat() {
    const now = performance.now();
    if (document.visibilityState === "hidden") {
      this._expected = now + HEARTBEAT_MS;
      return;
    }
    const lag = Math.max(0, Math.round(now - this._expected));
    this._expected = now + HEARTBEAT_MS;
    this._lags.push(lag);
    if (this._lags.length > SAMPLE_WINDOW) this._lags.shift();
    if (lag >= STALL_THRESHOLD_MS) {
      this._stallCount += 1;
      this._lastStall = { at: Date.now(), durationMs: lag };
    }
  }

  /**
   * @param {*} error
   * @param {string|null} filename
   * @returns {void}
   */
  _handleError(error, filename) {
    if (error && typeof error === "object" && error.browserosReported) return;
    const appId = this._attribute(error, filename);
    if (!appId) {
      this._systemErrors += 1;
      return;
    }
    this._attributedErrors += 1;
    this._appManager.recordError(appId, error ?? "Unknown error", "runtime");
    const last = this._lastNotified.get(appId) ?? 0;
    if (Date.now() - last < NOTIFY_INTERVAL_MS) return;
    this._lastNotified.set(appId, Date.now());
    const name = this._appManager.getApp(appId)?.name ?? appId;
    notificationService.error(`${name} ran into a problem`, {
      title: `${name} ran into a problem`,
      message: `${describe(error)} \u2014 details are in Task Manager.`,
      source: appId,
      groupKey: `app-error:${appId}`,
      action: { type: "launch", appId: "task-manager", options: { tab: "applications", select: appId } },
    });
  }

  /**
   * @param {{appId: string, phase: string, message: string}} payload
   * @returns {void}
   */
  _notifyCrash({ appId, phase, message }) {
    const name = this._appManager?.getApp(appId)?.name ?? appId;
    notificationService.error(`${name} couldn't ${phase === "load" ? "load" : "start"}`, {
      title: `${name} couldn't ${phase === "load" ? "load" : "start"}`,
      message,
      source: appId,
      groupKey: `app-error:${appId}`,
      action: { type: "launch", appId: "task-manager", options: { tab: "applications" } },
    });
  }

  /**
   * @param {*} error
   * @param {string|null} filename
   * @returns {string|null} The registered application the error came from.
   */
  _attribute(error, filename) {
    if (!this._appManager) return null;
    const stack = error && typeof error === "object" && typeof error.stack === "string" ? error.stack : "";
    for (const text of [stack, filename ?? ""]) {
      const match = APP_PATH.exec(text);
      if (match && this._appManager.isRegistered(match[1])) return match[1];
    }
    return null;
  }
}

/**
 * @param {*} error
 * @returns {string}
 */
function describe(error) {
  const text = error && typeof error === "object" && "message" in error ? String(error.message) : String(error ?? "Unknown error");
  return text.length > 140 ? `${text.slice(0, 139)}\u2026` : text;
}

/**
 * Singleton application monitor.
 * @type {AppMonitor}
 */
export const appMonitor = new AppMonitor();
