/**
 * @file NotificationService — the one notification system every
 * application and system component uses: banners (toasts), the
 * Notification Center history, unread state, Do Not Disturb, and
 * notification actions.
 *
 * Lifecycle: the service is managed by ServiceManager ("notifications",
 * essential). `notify()` always works: while the service isn't running
 * (during early boot, or after a failure) notifications are still
 * recorded in the history, but no banner is shown for them later —
 * banners belong to the moment a notification happens.
 *
 * A notification is recorded in the history (unless `history: false`)
 * and, unless Do Not Disturb suppresses it, shown as a banner:
 *
 *   - banners close on their own after `duration` ms (default: the
 *     `notifications.duration` setting), or stay until dismissed when
 *     `persistent: true`, `duration: 0`, or `urgency: "alarm"`;
 *   - hovering or focusing a banner pauses its timer;
 *   - a new notification with the same `groupKey` as a banner on
 *     screen replaces it and shows how many it stands for;
 *   - at most four banners are visible; the oldest non-alarm banner
 *     makes room.
 *
 * Clicking a notification (banner or Notification Center) marks it read
 * and runs, in order of preference: its `onClick` callback (current
 * session only), its serializable `action` (survives reloads), or opens
 * its source application.
 *
 * Do Not Disturb (`notifications.doNotDisturb`) suppresses banners and
 * sounds but still records every notification. Alarms
 * (`urgency: "alarm"`) and `critical: true` notifications always show.
 *
 * History is persisted through StorageService ("notifications:history"),
 * validated on load, limited to `notifications.historyLimit` entries and
 * seven days, and never includes runtime callbacks.
 *
 * Events (EventBus):
 *  - "notification:created"        { id, notification, toast }
 *  - "notification:shown"          { id, title, source }
 *  - "notification:dismissed"      { id, source, reason }  banner closed; reason: "user"|"timeout"|"action"|"programmatic"|"replaced"
 *  - "notification:action"         { id, actionId, source }
 *  - "notification:activated"      { id, source }
 *  - "notification:read"           { ids }
 *  - "notification:removed"        { id }
 *  - "notification:cleared"        {}
 *  - "notification:historyChanged" { total, unread }
 *  - "system:dndChanged"           { enabled }
 */

import { eventBus } from "../eventBus.js";
import { storage } from "../storage.js";
import { settingsService } from "../settings/settingsService.js";
import { NotificationView } from "../../components/notification/notificationView.js";
import { playAlertSound, loopAlertSound } from "../../utils/alertSound.js";

export const NOTIFICATION_TYPES = Object.freeze(["info", "success", "warning", "error"]);

const HISTORY_KEY = "notifications:history";
const MAX_AGE_MS = 7 * 86_400_000;
const MAX_VISIBLE = 4;
const SAVE_DELAY_MS = 250;
const LIMITS = Object.freeze({ title: 120, message: 600, icon: 40, source: 60, groupKey: 80, actionLabel: 40 });
const TYPE_ICONS = Object.freeze({ info: "icon:info", success: "icon:success", warning: "icon:warning", error: "icon:error" });
const TYPE_TITLES = Object.freeze({ info: "Information", success: "Done", warning: "Warning", error: "Error" });

/**
 * @typedef {object} NotificationAction
 * Serializable click action, kept in the history across reloads.
 * @property {"launch"|"open"} type - "launch" an application, or "open" a VFS path with its default application.
 * @property {string} [appId] - For "launch".
 * @property {object} [options] - For "launch": options passed to `appManager.launch()`.
 * @property {string} [path] - For "open".
 */

/**
 * @typedef {object} NotificationOptions
 * @property {string} [title] - Required unless `message` is given.
 * @property {string} [message] - Body text (`body` is accepted as an alias).
 * @property {"info"|"success"|"warning"|"error"} [type]
 * @property {string} [source] - Application id ("calendar") or "system".
 * @property {string} [icon] - Glyph or "icon:<name>"; defaults to the source app's icon or the type's icon.
 * @property {number} [duration] - Banner time in ms (`timeout` is accepted as an alias); 0 = until dismissed.
 * @property {boolean} [persistent] - Keep the banner until dismissed.
 * @property {"normal"|"alarm"} [urgency] - "alarm": announced assertively, never auto-closes, shown during Do Not Disturb.
 * @property {boolean} [critical] - Shown during Do Not Disturb.
 * @property {string} [groupKey] - Related notifications share a banner and a Notification Center group.
 * @property {NotificationAction} [action] - What clicking the notification does.
 * @property {() => void} [onClick] - Click handler for this session (takes precedence over `action`).
 * @property {Array<{id: string, label: string, primary?: boolean}>} [actions] - Banner buttons.
 * @property {(actionId: string) => void} [onAction]
 * @property {(reason: string) => void} [onDismiss] - Called when the banner closes.
 * @property {string|null} [sound] - An alertSound id.
 * @property {boolean} [loopSound]
 * @property {boolean} [history] - false: banner only, not recorded in the Notification Center.
 */

/**
 * @typedef {object} NotificationRecord
 * @property {string} id
 * @property {string} title
 * @property {string} message
 * @property {"info"|"success"|"warning"|"error"} type
 * @property {string} source
 * @property {string} sourceName
 * @property {string} icon
 * @property {number} timestamp
 * @property {boolean} read
 * @property {string|null} groupKey
 * @property {NotificationAction|null} action
 * @property {boolean} persistent
 * @property {"normal"|"alarm"} urgency
 */

class NotificationService {
  constructor() {
    this._view = null;
    this._counter = 0;
    this._running = false;
    this._loaded = false;
    /** @type {NotificationRecord[]} Newest first. */
    this._history = [];
    /** @type {Map<string, {record: NotificationRecord, handlers: object, timerId: number|null, remaining: number, startedAt: number, stopSound: (() => void)|null, count: number}>} */
    this._toasts = new Map();
    /** @type {Map<string, {onClick?: Function, onAction?: Function, onDismiss?: Function}>} Runtime callbacks, this session only. */
    this._handlers = new Map();
    this._saveTimer = null;
    this._cleanups = [];
    this._resolveSource = (source) => (source === "system" ? { name: "System", icon: "icon:info" } : null);
    this._performAction = async () => false;
  }

  // ---------------------------------------------------------------
  // Configuration and lifecycle
  // ---------------------------------------------------------------

  /**
   * Connect the service to the shell. Called once during boot.
   * @param {object} hooks
   * @param {(source: string) => ({name: string, icon?: string}|null)} [hooks.resolveSource] - Display name and icon for a source id.
   * @param {(action: NotificationAction|{type: "launch", appId: string}) => Promise<boolean>} [hooks.performAction] - Runs a click action; resolves false when it couldn't (e.g. the file is gone).
   * @returns {void}
   */
  configure({ resolveSource, performAction } = {}) {
    if (typeof resolveSource === "function") {
      const fallback = this._resolveSource;
      this._resolveSource = (source) => resolveSource(source) ?? fallback(source);
    }
    if (typeof performAction === "function") this._performAction = performAction;
  }

  /**
   * Start showing banners. Called by ServiceManager.
   * @returns {void}
   */
  start() {
    if (this._running) return;
    this._loadHistory();
    this._ensureView();
    this._running = true;
    this._cleanups.push(
      settingsService.subscribe("notifications.doNotDisturb", ({ value }) => {
        eventBus.emit("system:dndChanged", Object.freeze({ enabled: value }));
      }),
      settingsService.subscribe("notifications.historyLimit", () => {
        if (this._prune()) this._historyChanged();
      })
    );
  }

  /**
   * Stop showing banners: open banners close and sounds stop. History
   * is saved. Called by ServiceManager (and on shutdown).
   * @returns {void}
   */
  stop() {
    if (!this._running) return;
    this._running = false;
    for (const id of [...this._toasts.keys()]) this._closeToast(id, "programmatic");
    for (const cleanup of this._cleanups) cleanup();
    this._cleanups = [];
    this._flushSave();
  }

  /** @returns {boolean} */
  isRunning() {
    return this._running;
  }

  /** @returns {{summary: string, timers: number}} Status for Task Manager. */
  getDetails() {
    const timers = [...this._toasts.values()].filter((toast) => toast.timerId !== null).length;
    const dnd = this.isDoNotDisturb() ? " \u00b7 Do Not Disturb on" : "";
    return {
      summary: `${this._toasts.size} on screen \u00b7 ${this.getUnreadCount()} unread of ${this._history.length}${dnd}`,
      timers,
    };
  }

  // ---------------------------------------------------------------
  // Creating notifications
  // ---------------------------------------------------------------

  /**
   * @param {NotificationOptions} options
   * @returns {{id: string|null, dismiss: () => void}} A handle; `id` is null when the options were rejected.
   */
  notify(options) {
    const record = this._buildRecord(options);
    if (!record) return { id: null, dismiss() {} };
    this._loadHistory();

    const handlers = {
      onClick: typeof options.onClick === "function" ? options.onClick : null,
      onAction: typeof options.onAction === "function" ? options.onAction : null,
      onDismiss: typeof options.onDismiss === "function" ? options.onDismiss : null,
    };
    this._handlers.set(record.id, handlers);

    const recorded = options.history !== false;
    if (recorded) {
      this._history.unshift(record);
      this._prune();
    }

    const bypassesDnd = record.urgency === "alarm" || options.critical === true;
    const showToast = this._running && (bypassesDnd || !this.isDoNotDisturb());
    eventBus.emit("notification:created", Object.freeze({ id: record.id, notification: Object.freeze({ ...record }), toast: showToast }));
    if (recorded) this._historyChanged();

    if (showToast) {
      this._showToast(record, handlers, options);
    } else if (!recorded) {
      this._handlers.delete(record.id);
    }
    return { id: record.id, dismiss: () => this.dismiss(record.id) };
  }

  /**
   * @param {string} message
   * @param {NotificationOptions} [options]
   * @returns {{id: string|null, dismiss: () => void}}
   */
  info(message, options = {}) {
    return this._typed("info", message, options);
  }

  /** @see info */
  success(message, options = {}) {
    return this._typed("success", message, options);
  }

  /** @see info */
  warning(message, options = {}) {
    return this._typed("warning", message, options);
  }

  /** @see info */
  error(message, options = {}) {
    return this._typed("error", message, options);
  }

  // ---------------------------------------------------------------
  // Managing notifications
  // ---------------------------------------------------------------

  /**
   * Remove a notification completely: its banner closes and it leaves
   * the Notification Center.
   * @param {string} id
   * @returns {void}
   */
  dismiss(id) {
    this._closeToast(id, "programmatic");
    const index = this._history.findIndex((record) => record.id === id);
    if (index !== -1) {
      this._history.splice(index, 1);
      this._handlers.delete(id);
      eventBus.emit("notification:removed", Object.freeze({ id }));
      this._historyChanged();
    }
  }

  /**
   * Close every banner on screen. The notifications stay in the Notification Center.
   * @returns {void}
   */
  dismissAll() {
    for (const id of [...this._toasts.keys()]) this._closeToast(id, "programmatic");
  }

  /**
   * Empty the Notification Center. Banners currently on screen stay.
   * @returns {void}
   */
  clearHistory() {
    this._loadHistory();
    if (this._history.length === 0) return;
    for (const record of this._history) {
      if (!this._toasts.has(record.id)) this._handlers.delete(record.id);
    }
    this._history = [];
    eventBus.emit("notification:cleared", Object.freeze({}));
    this._historyChanged();
  }

  /**
   * @param {string} id
   * @returns {void}
   */
  markAsRead(id) {
    const record = this._history.find((entry) => entry.id === id);
    if (!record || record.read) return;
    record.read = true;
    eventBus.emit("notification:read", Object.freeze({ ids: Object.freeze([id]) }));
    this._historyChanged();
  }

  /**
   * @param {string[]} [ids] - Defaults to every notification.
   * @returns {void}
   */
  markAllAsRead(ids) {
    this._loadHistory();
    const wanted = ids ? new Set(ids) : null;
    const changed = [];
    for (const record of this._history) {
      if (!record.read && (!wanted || wanted.has(record.id))) {
        record.read = true;
        changed.push(record.id);
      }
    }
    if (changed.length === 0) return;
    eventBus.emit("notification:read", Object.freeze({ ids: Object.freeze(changed) }));
    this._historyChanged();
  }

  /**
   * Perform a notification's click behavior (see file header).
   * @param {string} id
   * @returns {Promise<boolean>} False when there was nothing to open, or its target no longer exists.
   */
  async activate(id) {
    const record = this._history.find((entry) => entry.id === id) ?? this._toasts.get(id)?.record;
    if (!record) return false;
    this.markAsRead(id);
    this._closeToast(id, "action");
    eventBus.emit("notification:activated", Object.freeze({ id, source: record.source }));

    const handlers = this._handlers.get(id);
    if (handlers?.onClick) {
      try {
        handlers.onClick();
        return true;
      } catch (error) {
        console.error("[NotificationService] onClick threw:", error);
        return false;
      }
    }
    const action = record.action ?? (record.source && record.source !== "system" ? { type: "launch", appId: record.source } : null);
    if (!action) return false;
    try {
      const ok = await this._performAction(action);
      if (!ok) {
        this.notify({
          title: "This item is no longer available",
          message: action.type === "open" ? `${action.path} was moved or deleted.` : "The application that sent this notification isn't available.",
          type: "warning",
          source: "system",
          history: false,
        });
      }
      return ok;
    } catch (error) {
      console.error("[NotificationService] notification action failed:", error);
      return false;
    }
  }

  /**
   * @param {{unreadOnly?: boolean}} [options]
   * @returns {NotificationRecord[]} Copies, newest first.
   */
  getNotifications({ unreadOnly = false } = {}) {
    this._loadHistory();
    return this._history.filter((record) => !unreadOnly || !record.read).map((record) => ({ ...record, action: record.action ? { ...record.action } : null }));
  }

  /**
   * @param {string} id
   * @returns {NotificationRecord|null}
   */
  getNotification(id) {
    const record = this._history.find((entry) => entry.id === id);
    return record ? { ...record } : null;
  }

  /** @returns {number} */
  getUnreadCount() {
    this._loadHistory();
    return this._history.reduce((count, record) => count + (record.read ? 0 : 1), 0);
  }

  /** @returns {string[]} Ids of notifications whose banners are on screen. */
  getActiveIds() {
    return [...this._toasts.keys()];
  }

  /** @returns {boolean} */
  isDoNotDisturb() {
    return settingsService.isInitialized() ? settingsService.get("notifications.doNotDisturb") === true : false;
  }

  /**
   * @param {boolean} enabled
   * @returns {void}
   */
  setDoNotDisturb(enabled) {
    settingsService.set("notifications.doNotDisturb", Boolean(enabled));
  }

  // ---------------------------------------------------------------
  // Internal: records
  // ---------------------------------------------------------------

  /**
   * @param {string} type
   * @param {string} message
   * @param {NotificationOptions} options
   * @returns {{id: string|null, dismiss: () => void}}
   */
  _typed(type, message, options) {
    const extra = options && typeof options === "object" ? options : {};
    // With a separate title, `message` is the body (unless options.message
    // is also given); otherwise it is the headline.
    return extra.title
      ? this.notify({ ...extra, type, message: extra.message ?? message })
      : this.notify({ ...extra, type, title: message, message: extra.message ?? "" });
  }

  /**
   * Validate options into a clean record.
   * @param {NotificationOptions} options
   * @returns {NotificationRecord|null}
   */
  _buildRecord(options) {
    if (!options || typeof options !== "object") {
      console.warn("[NotificationService] notify() requires an options object");
      return null;
    }
    let title = cleanText(options.title, LIMITS.title);
    let message = cleanText(options.message ?? options.body, LIMITS.message);
    if (!title && !message) {
      console.warn("[NotificationService] notify() requires a title or a message");
      return null;
    }
    const type = NOTIFICATION_TYPES.includes(options.type) ? options.type : "info";
    if (!title) {
      title = message.length <= LIMITS.title ? message : TYPE_TITLES[type];
      message = message.length <= LIMITS.title ? "" : message;
    }
    const source = cleanText(options.source, LIMITS.source) || "system";
    const sourceInfo = safeCall(() => this._resolveSource(source)) ?? null;
    const urgency = options.urgency === "alarm" ? "alarm" : "normal";
    const iconOption = cleanText(options.icon, LIMITS.icon);
    const durationOption = Number.isFinite(options.duration) ? options.duration : Number.isFinite(options.timeout) ? options.timeout : null;
    const persistent = options.persistent === true || urgency === "alarm" || durationOption === 0;

    this._counter += 1;
    return {
      id: `n-${Date.now().toString(36)}-${this._counter}`,
      title,
      message,
      type,
      source,
      sourceName: cleanText(sourceInfo?.name, LIMITS.source) || source,
      icon: iconOption || sourceInfo?.icon || TYPE_ICONS[type],
      timestamp: Date.now(),
      read: false,
      groupKey: cleanText(options.groupKey, LIMITS.groupKey) || null,
      action: normalizeAction(options.action),
      persistent,
      urgency,
      duration: persistent ? 0 : durationOption !== null && durationOption > 0 ? durationOption : null,
    };
  }

  /**
   * Remove expired and over-limit entries.
   * @returns {boolean} Whether anything was removed.
   */
  _prune() {
    const limit = settingsService.isInitialized() ? settingsService.get("notifications.historyLimit") : 50;
    const cutoff = Date.now() - MAX_AGE_MS;
    const before = this._history.length;
    const kept = this._history.filter((record) => record.timestamp >= cutoff).slice(0, limit);
    if (kept.length === before) return false;
    const keptIds = new Set(kept.map((record) => record.id));
    for (const record of this._history) {
      if (!keptIds.has(record.id) && !this._toasts.has(record.id)) this._handlers.delete(record.id);
    }
    this._history = kept;
    return true;
  }

  /** @returns {void} */
  _historyChanged() {
    this._scheduleSave();
    eventBus.emit("notification:historyChanged", Object.freeze({ total: this._history.length, unread: this.getUnreadCount() }));
  }

  /** @returns {void} */
  _loadHistory() {
    if (this._loaded) return;
    this._loaded = true;
    const stored = storage.get(HISTORY_KEY, []);
    const records = Array.isArray(stored) ? stored.map(normalizeStoredRecord).filter(Boolean) : [];
    const ids = new Set(this._history.map((record) => record.id));
    // Notifications created before the history was loaded stay on top.
    this._history = [...this._history, ...records.filter((record) => !ids.has(record.id))].sort((a, b) => b.timestamp - a.timestamp);
    this._prune();
  }

  /** @returns {void} */
  _scheduleSave() {
    if (this._saveTimer !== null) return;
    this._saveTimer = window.setTimeout(() => this._flushSave(), SAVE_DELAY_MS);
  }

  /** @returns {void} */
  _flushSave() {
    if (this._saveTimer !== null) {
      window.clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    if (!this._loaded) return;
    storage.set(
      HISTORY_KEY,
      this._history.map(({ duration, ...record }) => record)
    );
  }

  // ---------------------------------------------------------------
  // Internal: banners
  // ---------------------------------------------------------------

  /** @returns {void} */
  _ensureView() {
    if (this._view) return;
    this._view = new NotificationView();
    document.body.append(this._view.getElement());
  }

  /**
   * @param {NotificationRecord} record
   * @param {object} handlers
   * @param {NotificationOptions} options
   * @returns {void}
   */
  _showToast(record, handlers, options) {
    let count = 1;
    if (record.groupKey) {
      for (const [otherId, toast] of this._toasts) {
        if (toast.record.groupKey === record.groupKey) {
          count += toast.count;
          this._closeToast(otherId, "replaced");
        }
      }
    }

    let stopSound = null;
    const soundsOn = settingsService.isInitialized() ? settingsService.get("notifications.sounds") : true;
    if (options.sound && (soundsOn || record.urgency === "alarm")) {
      if (options.loopSound) stopSound = loopAlertSound(options.sound);
      else playAlertSound(options.sound);
    }

    const duration = record.persistent ? 0 : record.duration ?? settingsService.get("notifications.duration") * 1000;
    const actions = Array.isArray(options.actions)
      ? options.actions
          .filter((action) => action && typeof action.id === "string" && cleanText(action.label, LIMITS.actionLabel))
          .slice(0, 3)
          .map((action) => ({ id: action.id, label: cleanText(action.label, LIMITS.actionLabel), primary: Boolean(action.primary) }))
      : [];

    const toast = { record, handlers, timerId: null, remaining: duration, startedAt: 0, stopSound, count };
    this._toasts.set(record.id, toast);
    this._view.add(record.id, {
      title: record.title,
      message: settingsService.get("notifications.showPreviews") ? record.message : "",
      icon: record.icon,
      type: record.type,
      urgency: record.urgency,
      sourceName: record.sourceName,
      count,
      actions,
      onActivate: () => this.activate(record.id),
      onAction: (actionId) => this._handleAction(record.id, actionId),
      onDismiss: () => this._userCloseToast(record.id),
      onHoverChange: (hovering) => this._setPaused(record.id, hovering),
    });
    this._startTimer(record.id);
    this._enforceLimit();
    eventBus.emit("notification:shown", Object.freeze({ id: record.id, title: record.title, source: record.source }));
  }

  /**
   * @param {string} id
   * @returns {void}
   */
  _userCloseToast(id) {
    this.markAsRead(id);
    this._closeToast(id, "user");
  }

  /**
   * @param {string} id
   * @param {"user"|"timeout"|"action"|"programmatic"|"replaced"} reason
   * @returns {void}
   */
  _closeToast(id, reason) {
    const toast = this._toasts.get(id);
    if (!toast) return;
    this._toasts.delete(id);
    if (toast.timerId !== null) window.clearTimeout(toast.timerId);
    toast.stopSound?.();
    this._view?.remove(id);
    if (reason !== "replaced") {
      try {
        toast.handlers.onDismiss?.(reason);
      } catch (error) {
        console.error("[NotificationService] onDismiss threw:", error);
      }
    }
    // Banner-only notifications have nothing left to refer to.
    if (!this._history.some((record) => record.id === id)) this._handlers.delete(id);
    eventBus.emit("notification:dismissed", Object.freeze({ id, source: toast.record.source, reason }));
  }

  /**
   * @param {string} id
   * @param {string} actionId
   * @returns {void}
   */
  _handleAction(id, actionId) {
    const toast = this._toasts.get(id);
    if (!toast) return;
    eventBus.emit("notification:action", Object.freeze({ id, actionId, source: toast.record.source }));
    try {
      toast.handlers.onAction?.(actionId);
    } catch (error) {
      console.error("[NotificationService] onAction threw:", error);
    }
    this.markAsRead(id);
    this._closeToast(id, "action");
  }

  /**
   * @param {string} id
   * @returns {void}
   */
  _startTimer(id) {
    const toast = this._toasts.get(id);
    if (!toast || toast.remaining <= 0) return;
    toast.startedAt = Date.now();
    toast.timerId = window.setTimeout(() => this._closeToast(id, "timeout"), toast.remaining);
  }

  /**
   * Hovering or focusing a banner pauses its timer; the remaining time
   * is kept, so it closes that much later once released.
   * @param {string} id
   * @param {boolean} paused
   * @returns {void}
   */
  _setPaused(id, paused) {
    const toast = this._toasts.get(id);
    if (!toast || toast.record.persistent) return;
    if (paused && toast.timerId !== null) {
      window.clearTimeout(toast.timerId);
      toast.timerId = null;
      toast.remaining = Math.max(1000, toast.remaining - (Date.now() - toast.startedAt));
    } else if (!paused && toast.timerId === null) {
      this._startTimer(id);
    }
  }

  /** @returns {void} */
  _enforceLimit() {
    const closable = [...this._toasts.entries()].filter(([, toast]) => toast.record.urgency !== "alarm");
    while (this._toasts.size > MAX_VISIBLE && closable.length > 0) {
      const [oldestId] = closable.shift();
      this._closeToast(oldestId, "programmatic");
    }
  }
}

/**
 * @param {*} value
 * @param {number} max
 * @returns {string} Trimmed, single-spaced text, cut to `max` characters ("" for non-strings).
 */
function cleanText(value, max) {
  if (typeof value !== "string") return "";
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}\u2026` : text;
}

/**
 * @param {*} action
 * @returns {NotificationAction|null}
 */
function normalizeAction(action) {
  if (!action || typeof action !== "object") return null;
  if (action.type === "launch" && typeof action.appId === "string" && action.appId) {
    let options = {};
    if (action.options && typeof action.options === "object") {
      try {
        options = JSON.parse(JSON.stringify(action.options));
      } catch {
        options = {};
      }
    }
    return { type: "launch", appId: action.appId, options };
  }
  if (action.type === "open" && typeof action.path === "string" && action.path.startsWith("/")) {
    return { type: "open", path: action.path };
  }
  return null;
}

/**
 * @param {*} stored
 * @returns {NotificationRecord|null}
 */
function normalizeStoredRecord(stored) {
  if (!stored || typeof stored !== "object" || typeof stored.id !== "string" || !stored.id) return null;
  const title = cleanText(stored.title, LIMITS.title);
  if (!title || !Number.isFinite(stored.timestamp)) return null;
  return {
    id: stored.id,
    title,
    message: cleanText(stored.message, LIMITS.message),
    type: NOTIFICATION_TYPES.includes(stored.type) ? stored.type : "info",
    source: cleanText(stored.source, LIMITS.source) || "system",
    sourceName: cleanText(stored.sourceName, LIMITS.source) || "System",
    icon: cleanText(stored.icon, LIMITS.icon) || TYPE_ICONS.info,
    timestamp: stored.timestamp,
    read: stored.read === true,
    groupKey: cleanText(stored.groupKey, LIMITS.groupKey) || null,
    action: normalizeAction(stored.action),
    persistent: stored.persistent === true,
    urgency: stored.urgency === "alarm" ? "alarm" : "normal",
    duration: null,
  };
}

/**
 * @template T
 * @param {() => T} fn
 * @returns {T|null}
 */
function safeCall(fn) {
  try {
    return fn();
  } catch {
    return null;
  }
}

/**
 * Singleton notification service shared across the OS.
 * @type {NotificationService}
 */
export const notificationService = new NotificationService();
