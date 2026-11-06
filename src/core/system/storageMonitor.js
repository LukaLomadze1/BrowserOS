/**
 * @file StorageMonitor — the "storage-monitor" background service.
 *
 * Warns (as a critical notification, shown even during Do Not Disturb)
 * when BrowserOS can't save its data:
 *  - settings stopped being saved ("settings:persistenceFailed");
 *  - any other StorageService write failed ("storage:writeFailed");
 *  - the browser reports that this site's storage is more than 90% full
 *    (`navigator.storage.estimate()`, checked on start and every 15
 *    minutes).
 *
 * Each kind of warning is shown at most once every ten minutes, so a
 * persistent failure can't flood the Notification Center (or loop by
 * failing to save the warning itself).
 */

import { eventBus } from "../eventBus.js";
import { notificationService } from "../notifications/notificationService.js";

const CHECK_INTERVAL_MS = 15 * 60_000;
const WARN_INTERVAL_MS = 10 * 60_000;
const FULL_RATIO = 0.9;

class StorageMonitor {
  constructor() {
    this._running = false;
    this._intervalId = null;
    this._cleanups = [];
    this._lastWarned = new Map();
    /** @type {{usage: number, quota: number, checkedAt: number}|null} */
    this._estimate = null;
  }

  /** @returns {void} */
  start() {
    if (this._running) return;
    this._running = true;
    this._cleanups.push(
      eventBus.on("settings:persistenceFailed", () =>
        this._warn("settings", "Settings can't be saved", "Changes apply now but will be lost when BrowserOS reloads. Browser storage may be full or blocked.")
      ),
      eventBus.on("storage:writeFailed", ({ key }) => {
        if (key === "settings") return; // Reported by the settings warning above.
        this._warn("write", "BrowserOS couldn't save some data", "Browser storage may be full or blocked. Recent changes may not survive a reload.");
      })
    );
    this.checkQuota();
    this._intervalId = window.setInterval(() => this.checkQuota(), CHECK_INTERVAL_MS);
  }

  /** @returns {void} */
  stop() {
    if (!this._running) return;
    this._running = false;
    for (const cleanup of this._cleanups) cleanup();
    this._cleanups = [];
    window.clearInterval(this._intervalId);
    this._intervalId = null;
  }

  /** @returns {{summary: string, timers: number}} */
  getDetails() {
    const estimate = this._estimate;
    return {
      summary: estimate ? `Site storage ${formatMegabytes(estimate.usage)} of ${formatMegabytes(estimate.quota)} available to this site` : "Storage estimate unavailable in this browser",
      timers: this._intervalId !== null ? 1 : 0,
    };
  }

  /**
   * @returns {{usage: number, quota: number, checkedAt: number}|null} The most recent browser storage estimate for this site.
   */
  getEstimate() {
    return this._estimate ? { ...this._estimate } : null;
  }

  /**
   * Ask the browser how much storage this site uses.
   * @returns {Promise<void>}
   */
  async checkQuota() {
    if (!navigator.storage?.estimate) return;
    try {
      const { usage = 0, quota = 0 } = await navigator.storage.estimate();
      this._estimate = { usage, quota, checkedAt: Date.now() };
      if (quota > 0 && usage / quota >= FULL_RATIO) {
        this._warn(
          "quota",
          "Browser storage is almost full",
          `BrowserOS is using ${formatMegabytes(usage)} of the ${formatMegabytes(quota)} this browser allows. Delete files you no longer need, or empty the Recycle Bin.`
        );
      }
    } catch {
      this._estimate = null;
    }
  }

  /**
   * @param {string} kind
   * @param {string} title
   * @param {string} message
   * @returns {void}
   */
  _warn(kind, title, message) {
    const last = this._lastWarned.get(kind) ?? 0;
    if (Date.now() - last < WARN_INTERVAL_MS) return;
    this._lastWarned.set(kind, Date.now());
    notificationService.warning(title, {
      title,
      message,
      source: "system",
      critical: true,
      groupKey: `storage:${kind}`,
      action: { type: "launch", appId: "settings", options: { page: "system" } },
    });
  }
}

/**
 * @param {number} bytes
 * @returns {string}
 */
function formatMegabytes(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

/**
 * Singleton storage monitor.
 * @type {StorageMonitor}
 */
export const storageMonitor = new StorageMonitor();
