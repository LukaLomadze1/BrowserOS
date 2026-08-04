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
 * "window:focus", "process:spawned", "theme:changed".
 */

class EventBus {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this._listeners = new Map();
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
