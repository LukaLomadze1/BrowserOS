/**
 * @file System-wide event bus.
 *
 * BrowserOS modules never call each other's internals directly — they
 * publish and subscribe to named events through this bus. This keeps
 * core services, apps, and components decoupled: a module only needs
 * to know an event's name and payload shape, never who else is
 * listening or emitting.
 *
 * Naming convention for events: "<domain>:<action>", e.g.
 * "window:focused", "application:started", "settings:changed".
 *
 * A listener that throws is logged and skipped so the others still run;
 * a handler set with `setListenerErrorHandler()` (the application
 * monitor) also receives the error, so it can be attributed to the
 * application that caused it.
 */

class EventBus {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this._listeners = new Map();
    /** @type {((error: *, eventName: string) => void)|null} */
    this._errorHandler = null;
  }

  /**
   * @param {((error: *, eventName: string) => void)|null} handler - Receives errors thrown by listeners.
   * @returns {void}
   */
  setListenerErrorHandler(handler) {
    this._errorHandler = typeof handler === "function" ? handler : null;
  }

  /**
   * @returns {number} Total subscriptions across all events (diagnostics: a
   *   count that keeps growing as windows open and close points to a leak).
   */
  getListenerCount() {
    let total = 0;
    for (const set of this._listeners.values()) total += set.size;
    return total;
  }

  /**
   * Subscribe to an event.
   * @param {string} eventName
   * @param {Function} handler - Receives the event payload.
   * @returns {Function} Unsubscribe function.
   */
  on(eventName, handler) {
    if (!this._listeners.has(eventName)) {
      this._listeners.set(eventName, new Set());
    }
    this._listeners.get(eventName).add(handler);
    return () => this.off(eventName, handler);
  }

  /**
   * Subscribe to an event for exactly one emission.
   * @param {string} eventName
   * @param {Function} handler
   * @returns {void}
   */
  once(eventName, handler) {
    const wrapped = (payload) => {
      this.off(eventName, wrapped);
      handler(payload);
    };
    this.on(eventName, wrapped);
  }

  /**
   * Remove a previously registered handler.
   * @param {string} eventName
   * @param {Function} handler
   * @returns {void}
   */
  off(eventName, handler) {
    const set = this._listeners.get(eventName);
    if (!set) return;
    set.delete(handler);
    if (set.size === 0) {
      this._listeners.delete(eventName);
    }
  }

  /**
   * Publish an event to every subscriber. Handler errors are caught
   * and logged individually so one broken listener can't stop the
   * others from running.
   * @param {string} eventName
   * @param {*} [payload]
   * @returns {void}
   */
  emit(eventName, payload) {
    const set = this._listeners.get(eventName);
    if (!set) return;
    for (const handler of set) {
      try {
        handler(payload);
      } catch (error) {
        console.error(`[EventBus] listener for "${eventName}" threw:`, error);
        try {
          this._errorHandler?.(error, eventName);
        } catch {
          /* the error handler itself must never break emission */
        }
      }
    }
  }

  /**
   * Remove every listener for an event, or every listener entirely
   * if no event name is given. Intended for tests/teardown.
   * @param {string} [eventName]
   * @returns {void}
   */
  clear(eventName) {
    if (eventName) {
      this._listeners.delete(eventName);
    } else {
      this._listeners.clear();
    }
  }
}

/**
 * Singleton instance shared by every module in the OS.
 * @type {EventBus}
 */
export const eventBus = new EventBus();
