/**
 * @file NotificationService — in-OS notifications (toasts) shared by
 * every application and service: calendar reminders, alarms, timers,
 * and anything else that needs the user's attention.
 *
 * `notify()` returns a handle immediately; the toast is rendered by
 * NotificationView in a stack above the taskbar. Notifications can
 * carry action buttons (e.g. "Snooze"), a sound (one-shot or looping
 * until dismissed), and either auto-dismiss after a timeout or stay
 * until dismissed (alarms).
 *
 * Notifications exist only while BrowserOS is open: there is no
 * background or service-worker delivery.
 *
 * Events (EventBus):
 *  - "notification:shown"     { id, title, source }
 *  - "notification:action"    { id, actionId, source }
 *  - "notification:dismissed" { id, source, reason }  reason: "user"|"timeout"|"action"|"programmatic"
 */

import { eventBus } from "../eventBus.js";
import { NotificationView } from "../../components/notification/notificationView.js";
import { playAlertSound, loopAlertSound } from "../../utils/alertSound.js";

const DEFAULT_TIMEOUT_MS = 8000;
const MAX_VISIBLE = 4;

/**
 * @typedef {object} NotificationOptions
 * @property {string} title
 * @property {string} [body]
 * @property {string} [icon] - Glyph.
 * @property {string} [source] - Originating app/service id, e.g. "calendar".
 * @property {"normal"|"alarm"} [urgency] - "alarm" is announced assertively and never auto-dismisses.
 * @property {number} [timeout] - Auto-dismiss after this many ms; 0 keeps it until dismissed.
 * @property {string|null} [sound] - An alertSound id, or null for silence.
 * @property {boolean} [loopSound] - Repeat the sound until the notification is dismissed.
 * @property {Array<{id: string, label: string, primary?: boolean}>} [actions]
 * @property {(actionId: string) => void} [onAction]
 * @property {(reason: string) => void} [onDismiss]
 */

class NotificationService {
  constructor() {
    this._view = null;
    this._counter = 0;
    /** @type {Map<string, {options: NotificationOptions, timerId: number|null, stopSound: (() => void)|null}>} */
    this._active = new Map();
  }

  /**
   * @param {NotificationOptions} options
   * @returns {{id: string, dismiss: () => void}}
   */
  notify(options) {
    this._ensureView();
    const id = `notification-${++this._counter}`;
    const urgency = options.urgency ?? "normal";
    const timeout = urgency === "alarm" ? 0 : options.timeout ?? DEFAULT_TIMEOUT_MS;

    let stopSound = null;
    if (options.sound) {
      if (options.loopSound) {
        stopSound = loopAlertSound(options.sound);
      } else {
        playAlertSound(options.sound);
      }
    }

    const record = { options: { ...options, urgency }, timerId: null, stopSound, timeout };
    this._active.set(id, record);
    this._view.add(id, {
      title: options.title,
      body: options.body ?? "",
      icon: options.icon ?? "\u25c9",
      urgency,
      actions: options.actions ?? [],
      onAction: (actionId) => this._handleAction(id, actionId),
      onDismiss: () => this.dismiss(id, "user"),
      onHoverChange: (hovering) => this._setPaused(id, hovering),
    });
    this._startTimer(id);
    this._enforceLimit();

    eventBus.emit("notification:shown", Object.freeze({ id, title: options.title, source: options.source ?? null }));
    return { id, dismiss: () => this.dismiss(id, "programmatic") };
  }

  /**
   * @param {string} id
   * @param {"user"|"timeout"|"action"|"programmatic"} [reason]
   * @returns {void}
   */
  dismiss(id, reason = "programmatic") {
    const record = this._active.get(id);
    if (!record) return;
    this._active.delete(id);
    if (record.timerId !== null) window.clearTimeout(record.timerId);
    record.stopSound?.();
    this._view.remove(id);
    try {
      record.options.onDismiss?.(reason);
    } catch (error) {
      console.error("[NotificationService] onDismiss threw:", error);
    }
    eventBus.emit("notification:dismissed", Object.freeze({ id, source: record.options.source ?? null, reason }));
  }

  /**
   * @returns {string[]} Ids of notifications currently on screen.
   */
  getActiveIds() {
    return [...this._active.keys()];
  }

  // ---------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------

  /** @returns {void} */
  _ensureView() {
    if (this._view) return;
    this._view = new NotificationView();
    document.body.append(this._view.getElement());
  }

  /**
   * @param {string} id
   * @param {string} actionId
   * @returns {void}
   */
  _handleAction(id, actionId) {
    const record = this._active.get(id);
    if (!record) return;
    eventBus.emit("notification:action", Object.freeze({ id, actionId, source: record.options.source ?? null }));
    try {
      record.options.onAction?.(actionId);
    } catch (error) {
      console.error("[NotificationService] onAction threw:", error);
    }
    this.dismiss(id, "action");
  }

  /**
   * @param {string} id
   * @returns {void}
   */
  _startTimer(id) {
    const record = this._active.get(id);
    if (!record || record.timeout <= 0) return;
    record.timerId = window.setTimeout(() => this.dismiss(id, "timeout"), record.timeout);
  }

  /**
   * Hovering a toast pauses its auto-dismiss so it can be read.
   * @param {string} id
   * @param {boolean} paused
   * @returns {void}
   */
  _setPaused(id, paused) {
    const record = this._active.get(id);
    if (!record || record.timeout <= 0) return;
    if (paused && record.timerId !== null) {
      window.clearTimeout(record.timerId);
      record.timerId = null;
    } else if (!paused && record.timerId === null) {
      this._startTimer(id);
    }
  }

  /** @returns {void} */
  _enforceLimit() {
    const dismissible = [...this._active.entries()].filter(([, record]) => record.options.urgency !== "alarm");
    while (this._active.size > MAX_VISIBLE && dismissible.length > 0) {
      const [oldestId] = dismissible.shift();
      this.dismiss(oldestId, "programmatic");
    }
  }
}

/**
 * Singleton notification service shared across the OS.
 * @type {NotificationService}
 */
export const notificationService = new NotificationService();
