/**
 * @file Browser history — visited pages shared by every Browser window
 * (and the start page's "frequently visited" and "recent" lists).
 *
 * One record per page (URL without fragment):
 *   { url, title, favicon, visitCount, firstVisit, lastVisit, visits: number[] }
 * `visits` keeps the most recent visit times (up to 30) for browsing by
 * date; `visitCount` keeps counting beyond that. A repeat visit within
 * 30 seconds (reload, back-and-forth) only refreshes the record.
 *
 * Not recorded: private windows, BrowserOS pages (browseros://), and
 * anything that isn't http(s) or a BrowserOS file (vfs://).
 *
 * Limits: records older than `browser.historyDays` (by last visit) are
 * dropped, and at most 2,000 records are kept (least recently visited
 * go first). Persisted through StorageService ("browser:history"),
 * validated on load, saved in batches.
 *
 * Events: "browser:historyChanged" { reason }.
 */

import { eventBus } from "../eventBus.js";
import { storage } from "../storage.js";
import { settingsService } from "../settings/settingsService.js";
import { comparableUrl, fallbackTitle, isWebUrl } from "./urlUtils.js";

const HISTORY_KEY = "browser:history";
const MAX_RECORDS = 2000;
const MAX_VISITS_PER_RECORD = 30;
const REPEAT_WINDOW_MS = 30_000;
const SAVE_DELAY_MS = 400;
const DAY_MS = 86_400_000;

/**
 * @typedef {object} HistoryRecord
 * @property {string} url
 * @property {string} title
 * @property {string|null} favicon
 * @property {number} visitCount
 * @property {number} firstVisit
 * @property {number} lastVisit
 * @property {number[]} visits - Newest first.
 */

class HistoryService {
  constructor() {
    /** @type {Map<string, HistoryRecord>|null} */
    this._records = null;
    this._saveTimer = null;
    window.addEventListener("pagehide", () => this.flush());
  }

  /**
   * Record a visit.
   * @param {string} url
   * @param {{title?: string, favicon?: string|null, private?: boolean}} [details]
   * @returns {boolean} Whether anything was recorded.
   */
  recordVisit(url, { title, favicon = null, private: isPrivate = false } = {}) {
    if (isPrivate || !isRecordable(url)) return false;
    const records = this._load();
    const key = comparableUrl(url);
    const now = Date.now();
    const existing = records.get(key);
    if (existing) {
      if (title) existing.title = cleanTitle(title, key);
      if (favicon) existing.favicon = favicon;
      if (now - existing.lastVisit >= REPEAT_WINDOW_MS) {
        existing.visitCount += 1;
        existing.visits = [now, ...existing.visits].slice(0, MAX_VISITS_PER_RECORD);
      }
      existing.lastVisit = now;
      // Most recent last in insertion order.
      records.delete(key);
      records.set(key, existing);
    } else {
      records.set(key, {
        url: key,
        title: cleanTitle(title, key),
        favicon: favicon || null,
        visitCount: 1,
        firstVisit: now,
        lastVisit: now,
        visits: [now],
      });
    }
    this._prune();
    this._changed("visit");
    return true;
  }

  /**
   * Update the title / favicon of a page once it is known.
   * @param {string} url
   * @param {{title?: string, favicon?: string|null}} details
   * @returns {void}
   */
  updatePage(url, { title, favicon } = {}) {
    const record = this._load().get(comparableUrl(url));
    if (!record) return;
    let changed = false;
    if (title && cleanTitle(title, record.url) !== record.title) {
      record.title = cleanTitle(title, record.url);
      changed = true;
    }
    if (favicon && favicon !== record.favicon) {
      record.favicon = favicon;
      changed = true;
    }
    if (changed) this._changed("update");
  }

  /**
   * @param {string} url
   * @returns {HistoryRecord|null}
   */
  get(url) {
    const record = this._load().get(comparableUrl(url));
    return record ? cloneRecord(record) : null;
  }

  /**
   * @param {number} [limit]
   * @returns {HistoryRecord[]} Most recently visited first.
   */
  getRecent(limit = 20) {
    return [...this._load().values()].reverse().slice(0, limit).map(cloneRecord);
  }

  /**
   * Pages visited most often, favoring recent visits.
   * @param {number} [limit]
   * @returns {HistoryRecord[]}
   */
  getFrequent(limit = 8) {
    const now = Date.now();
    return [...this._load().values()]
      .filter((record) => record.visitCount >= 1)
      .map((record) => ({ record, score: record.visits.reduce((sum, at) => sum + 1 / (1 + (now - at) / (7 * DAY_MS)), 0) + record.visitCount * 0.05 }))
      .sort((a, b) => b.score - a.score || b.record.lastVisit - a.record.lastVisit)
      .slice(0, limit)
      .map(({ record }) => cloneRecord(record));
  }

  /**
   * Individual visits, newest first, optionally filtered.
   * @param {{query?: string, from?: number, to?: number, limit?: number}} [options]
   * @returns {Array<{url: string, title: string, favicon: string|null, at: number}>}
   */
  getVisits({ query = "", from = 0, to = Infinity, limit = 500 } = {}) {
    const needle = query.trim().toLowerCase();
    const visits = [];
    for (const record of this._load().values()) {
      if (needle && !record.title.toLowerCase().includes(needle) && !record.url.toLowerCase().includes(needle)) continue;
      for (const at of record.visits) {
        if (at >= from && at <= to) visits.push({ url: record.url, title: record.title, favicon: record.favicon, at });
      }
    }
    return visits.sort((a, b) => b.at - a.at).slice(0, limit);
  }

  /**
   * @param {string} query
   * @param {number} [limit]
   * @returns {HistoryRecord[]} Pages whose title or URL contains the query, best matches first.
   */
  search(query, limit = 20) {
    const needle = query.trim().toLowerCase();
    if (!needle) return this.getRecent(limit);
    return [...this._load().values()]
      .map((record) => {
        const title = record.title.toLowerCase();
        const url = record.url.toLowerCase().replace(/^https?:\/\/(www\.)?/, "");
        let score = 0;
        if (url.startsWith(needle)) score += 4;
        else if (url.includes(needle)) score += 2;
        if (title.startsWith(needle)) score += 3;
        else if (title.includes(needle)) score += 1;
        return { record, score: score ? score + Math.log2(1 + record.visitCount) : 0 };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || b.record.lastVisit - a.record.lastVisit)
      .slice(0, limit)
      .map(({ record }) => cloneRecord(record));
  }

  /**
   * Remove one page (all of its visits).
   * @param {string} url
   * @returns {void}
   */
  remove(url) {
    if (this._load().delete(comparableUrl(url))) this._changed("remove");
  }

  /**
   * Remove one visit of a page; the page goes when it has no visits left.
   * @param {string} url
   * @param {number} at
   * @returns {void}
   */
  removeVisit(url, at) {
    const records = this._load();
    const key = comparableUrl(url);
    const record = records.get(key);
    if (!record) return;
    record.visits = record.visits.filter((visit) => visit !== at);
    record.visitCount = Math.max(0, record.visitCount - 1);
    if (record.visits.length === 0) records.delete(key);
    else record.lastVisit = record.visits[0];
    this._changed("remove");
  }

  /**
   * Remove visits made since a time (or everything).
   * @param {{since?: number}} [options] - Omit `since` to clear all history.
   * @returns {number} How many visits were removed.
   */
  clear({ since } = {}) {
    const records = this._load();
    let removed = 0;
    if (!Number.isFinite(since)) {
      for (const record of records.values()) removed += record.visits.length;
      records.clear();
    } else {
      for (const [key, record] of [...records]) {
        const kept = record.visits.filter((at) => at < since);
        removed += record.visits.length - kept.length;
        if (kept.length === 0) {
          records.delete(key);
        } else if (kept.length !== record.visits.length) {
          record.visitCount = Math.max(kept.length, record.visitCount - (record.visits.length - kept.length));
          record.visits = kept;
          record.lastVisit = kept[0];
        }
      }
    }
    this._changed("clear");
    return removed;
  }

  /** @returns {number} Number of pages in history. */
  size() {
    return this._load().size;
  }

  /** Write pending changes now. @returns {void} */
  flush() {
    if (this._saveTimer !== null) {
      window.clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    if (this._records) storage.set(HISTORY_KEY, [...this._records.values()]);
  }

  // ---------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------

  /** @returns {Map<string, HistoryRecord>} */
  _load() {
    if (this._records) return this._records;
    this._records = new Map();
    const stored = storage.get(HISTORY_KEY, []);
    if (Array.isArray(stored)) {
      const valid = stored.map(normalizeRecord).filter(Boolean).sort((a, b) => a.lastVisit - b.lastVisit);
      for (const record of valid) this._records.set(record.url, record);
    }
    this._prune();
    return this._records;
  }

  /** @returns {void} */
  _prune() {
    const days = settingsService.isInitialized() ? settingsService.get("browser.historyDays") : 90;
    const cutoff = Date.now() - days * DAY_MS;
    for (const [key, record] of this._records) {
      if (record.lastVisit < cutoff) {
        this._records.delete(key);
        continue;
      }
      if (record.visits.some((at) => at < cutoff)) record.visits = record.visits.filter((at) => at >= cutoff);
    }
    while (this._records.size > MAX_RECORDS) {
      this._records.delete(this._records.keys().next().value);
    }
  }

  /**
   * @param {string} reason
   * @returns {void}
   */
  _changed(reason) {
    if (this._saveTimer === null) this._saveTimer = window.setTimeout(() => this.flush(), SAVE_DELAY_MS);
    eventBus.emit("browser:historyChanged", Object.freeze({ reason }));
  }
}

/**
 * @param {string} url
 * @returns {boolean}
 */
function isRecordable(url) {
  return isWebUrl(url) || (typeof url === "string" && url.startsWith("vfs://"));
}

/**
 * @param {string|undefined} title
 * @param {string} url
 * @returns {string}
 */
function cleanTitle(title, url) {
  const text = typeof title === "string" ? title.replace(/\s+/g, " ").trim().slice(0, 300) : "";
  return text || fallbackTitle(url);
}

/**
 * @param {HistoryRecord} record
 * @returns {HistoryRecord}
 */
function cloneRecord(record) {
  return { ...record, visits: [...record.visits] };
}

/**
 * @param {*} input
 * @returns {HistoryRecord|null}
 */
function normalizeRecord(input) {
  if (!input || typeof input !== "object" || typeof input.url !== "string" || !isRecordable(input.url)) return null;
  const visits = Array.isArray(input.visits) ? input.visits.filter(Number.isFinite).sort((a, b) => b - a).slice(0, MAX_VISITS_PER_RECORD) : [];
  const lastVisit = Number.isFinite(input.lastVisit) ? input.lastVisit : visits[0];
  if (!Number.isFinite(lastVisit)) return null;
  const url = comparableUrl(input.url);
  return {
    url,
    title: cleanTitle(input.title, url),
    favicon: typeof input.favicon === "string" && /^https?:\/\//.test(input.favicon) ? input.favicon : null,
    visitCount: Number.isInteger(input.visitCount) && input.visitCount > 0 ? input.visitCount : Math.max(1, visits.length),
    firstVisit: Number.isFinite(input.firstVisit) ? input.firstVisit : lastVisit,
    lastVisit,
    visits: visits.length ? visits : [lastVisit],
  };
}

/**
 * Singleton browser history shared by every Browser window.
 * @type {HistoryService}
 */
export const historyService = new HistoryService();
