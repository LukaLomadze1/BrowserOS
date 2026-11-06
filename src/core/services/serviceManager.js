/**
 * @file ServiceManager — lifecycle registry for BrowserOS background
 * services: long-lived system components (schedulers, monitors, the
 * taskbar clock, notifications) that run independently of any window.
 *
 * Every service is registered once with a `start()` and a `stop()`
 * function. ServiceManager guarantees that:
 *
 *  - a service is never started twice without being stopped first
 *    (concurrent start requests share one in-flight start);
 *  - dependencies start before the services that need them, and
 *    dependents stop before the services they rely on;
 *  - a failing `start()` leaves the service in the "failed" state with
 *    its error recorded, and never takes other services down with it;
 *  - every running service is stopped when the page is being unloaded.
 *
 * Services run only while BrowserOS is open in a browser tab. Anything
 * that must survive a reload persists its own state and recovers it in
 * `start()`.
 *
 * Statuses: "stopped" | "starting" | "running" | "stopping" | "failed".
 *
 * Events (EventBus):
 *  - "service:registered" { id }
 *  - "service:started"    { id }
 *  - "service:stopped"    { id }
 *  - "service:error"      { id, message, phase: "start"|"stop" }
 *  - "service:statusChanged" { id, status }
 */

import { eventBus } from "../eventBus.js";

/**
 * @typedef {object} ServiceDefinition
 * @property {string} id - Unique, stable identifier, e.g. "calendar-reminders".
 * @property {string} name - Display name.
 * @property {string} [description]
 * @property {string[]} [dependencies] - Ids of services that must be running first.
 * @property {boolean} [essential] - BrowserOS depends on it; it can be restarted but not stopped by the user.
 * @property {() => (void|Promise<void>)} start
 * @property {() => (void|Promise<void>)} stop
 * @property {() => {summary?: string, timers?: number}} [getDetails] - Live status for Task Manager.
 */

/**
 * @typedef {object} ServiceInfo
 * @property {string} id
 * @property {string} name
 * @property {string} description
 * @property {"stopped"|"starting"|"running"|"stopping"|"failed"} status
 * @property {string[]} dependencies
 * @property {string[]} dependents
 * @property {boolean} essential
 * @property {number|null} startedAt
 * @property {string|null} error
 * @property {number} startCount
 * @property {string} summary
 * @property {number} timers
 */

class ServiceManager {
  constructor() {
    /** @type {Map<string, {definition: ServiceDefinition, status: string, startedAt: number|null, error: string|null, startCount: number, pending: Promise<void>|null}>} */
    this._services = new Map();
    this._unloadHandler = () => this.stopAll();
    this._unloadBound = false;
  }

  /**
   * @param {ServiceDefinition} definition
   * @returns {void}
   */
  register(definition) {
    if (!definition || typeof definition.id !== "string" || !definition.id.trim()) {
      throw new Error("[ServiceManager] register() requires an id");
    }
    if (typeof definition.start !== "function" || typeof definition.stop !== "function") {
      throw new Error(`[ServiceManager] service "${definition.id}" needs start() and stop() functions`);
    }
    if (this._services.has(definition.id)) {
      throw new Error(`[ServiceManager] a service with id "${definition.id}" is already registered`);
    }
    const dependencies = Array.isArray(definition.dependencies) ? [...new Set(definition.dependencies)] : [];
    if (dependencies.includes(definition.id)) {
      throw new Error(`[ServiceManager] service "${definition.id}" cannot depend on itself`);
    }
    this._services.set(definition.id, {
      definition: Object.freeze({
        ...definition,
        name: definition.name || definition.id,
        description: definition.description ?? "",
        dependencies: Object.freeze(dependencies),
        essential: Boolean(definition.essential),
      }),
      status: "stopped",
      startedAt: null,
      error: null,
      startCount: 0,
      pending: null,
    });
    this._assertNoCycle(definition.id);
    if (!this._unloadBound) {
      window.addEventListener("pagehide", this._unloadHandler);
      this._unloadBound = true;
    }
    eventBus.emit("service:registered", Object.freeze({ id: definition.id }));
  }

  /**
   * @param {string} id
   * @returns {boolean}
   */
  has(id) {
    return this._services.has(id);
  }

  /**
   * @param {string} id
   * @returns {string|null} The service's status, or null when it isn't registered.
   */
  getStatus(id) {
    return this._services.get(id)?.status ?? null;
  }

  /**
   * @param {string} id
   * @returns {boolean}
   */
  isRunning(id) {
    return this.getStatus(id) === "running";
  }

  /**
   * Start a service and, first, everything it depends on.
   * @param {string} id
   * @returns {Promise<boolean>} True when the service is running afterwards.
   */
  async start(id) {
    const record = this._require(id);
    if (record.status === "running") return true;
    if (record.status === "starting" && record.pending) {
      await record.pending;
      return record.status === "running";
    }
    if (record.status === "stopping" && record.pending) await record.pending;

    for (const dependency of record.definition.dependencies) {
      if (!this._services.has(dependency)) {
        this._fail(record, `Missing dependency "${dependency}"`, "start");
        return false;
      }
      const started = await this.start(dependency);
      if (!started) {
        this._fail(record, `Dependency "${this._services.get(dependency).definition.name}" isn't running`, "start");
        return false;
      }
    }

    this._setStatus(record, "starting");
    record.error = null;
    record.pending = (async () => {
      try {
        await record.definition.start();
        record.startedAt = Date.now();
        record.startCount += 1;
        this._setStatus(record, "running");
        eventBus.emit("service:started", Object.freeze({ id }));
      } catch (error) {
        console.error(`[ServiceManager] "${id}" failed to start:`, error);
        this._fail(record, error?.message || String(error), "start");
      } finally {
        record.pending = null;
      }
    })();
    await record.pending;
    return record.status === "running";
  }

  /**
   * Stop a service, stopping every running service that depends on it first.
   * @param {string} id
   * @param {{force?: boolean}} [options] - `force` allows stopping an essential service (shutdown).
   * @returns {Promise<boolean>} True when the service is stopped afterwards.
   */
  async stop(id, { force = false } = {}) {
    const record = this._require(id);
    if (record.definition.essential && !force) {
      throw new Error(`"${record.definition.name}" is required by BrowserOS and can't be stopped`);
    }
    if (record.status === "stopped" || record.status === "failed") {
      if (record.status === "failed") this._setStatus(record, "stopped");
      return true;
    }
    if (record.pending) await record.pending;
    if (record.status !== "running") return record.status === "stopped";

    for (const dependentId of this._dependentsOf(id)) {
      if (this.isRunning(dependentId)) await this.stop(dependentId, { force: true });
    }

    this._setStatus(record, "stopping");
    record.pending = (async () => {
      try {
        await record.definition.stop();
      } catch (error) {
        console.error(`[ServiceManager] "${id}" failed to stop cleanly:`, error);
        eventBus.emit("service:error", Object.freeze({ id, message: error?.message || String(error), phase: "stop" }));
      } finally {
        record.startedAt = null;
        record.pending = null;
        this._setStatus(record, "stopped");
        eventBus.emit("service:stopped", Object.freeze({ id }));
      }
    })();
    await record.pending;
    return true;
  }

  /**
   * Stop and start a service again. Dependents that were running are restarted too.
   * @param {string} id
   * @returns {Promise<boolean>}
   */
  async restart(id) {
    const record = this._require(id);
    const runningDependents = this._dependentsOf(id).filter((dependentId) => this.isRunning(dependentId));
    await this.stop(id, { force: true });
    const started = await this.start(id);
    for (const dependentId of runningDependents) await this.start(dependentId);
    return started && record.status === "running";
  }

  /**
   * Start every registered service in dependency order. Failures are
   * recorded per service and don't stop the others from starting.
   * @returns {Promise<void>}
   */
  async startAll() {
    for (const id of this._startOrder()) {
      await this.start(id);
    }
  }

  /**
   * Stop every running service, dependents first. Used on page unload.
   * @returns {void}
   */
  stopAll() {
    for (const id of this._startOrder().reverse()) {
      const record = this._services.get(id);
      if (record.status !== "running") continue;
      try {
        // Synchronous best effort: during unload there is no time to await.
        record.definition.stop();
      } catch (error) {
        console.error(`[ServiceManager] "${id}" failed to stop during shutdown:`, error);
      }
      record.startedAt = null;
      this._setStatus(record, "stopped");
    }
  }

  /**
   * @returns {ServiceInfo[]} Every service, in dependency order.
   */
  getServices() {
    return this._startOrder().map((id) => this.getService(id));
  }

  /**
   * @param {string} id
   * @returns {ServiceInfo|null}
   */
  getService(id) {
    const record = this._services.get(id);
    if (!record) return null;
    let details = {};
    if (record.status === "running" && typeof record.definition.getDetails === "function") {
      try {
        details = record.definition.getDetails() ?? {};
      } catch (error) {
        details = { summary: "Status unavailable" };
      }
    }
    return Object.freeze({
      id,
      name: record.definition.name,
      description: record.definition.description,
      status: record.status,
      dependencies: [...record.definition.dependencies],
      dependents: this._dependentsOf(id),
      essential: record.definition.essential,
      startedAt: record.startedAt,
      error: record.error,
      startCount: record.startCount,
      summary: typeof details.summary === "string" ? details.summary : "",
      timers: Number.isFinite(details.timers) ? details.timers : 0,
    });
  }

  // ---------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------

  /**
   * @param {string} id
   * @returns {object}
   */
  _require(id) {
    const record = this._services.get(id);
    if (!record) throw new Error(`[ServiceManager] no service registered with id "${id}"`);
    return record;
  }

  /**
   * @param {object} record
   * @param {string} status
   * @returns {void}
   */
  _setStatus(record, status) {
    if (record.status === status) return;
    record.status = status;
    eventBus.emit("service:statusChanged", Object.freeze({ id: record.definition.id, status }));
  }

  /**
   * @param {object} record
   * @param {string} message
   * @param {"start"|"stop"} phase
   * @returns {void}
   */
  _fail(record, message, phase) {
    record.error = message;
    record.startedAt = null;
    this._setStatus(record, "failed");
    eventBus.emit("service:error", Object.freeze({ id: record.definition.id, message, phase }));
  }

  /**
   * @param {string} id
   * @returns {string[]} Ids of services that list `id` as a dependency.
   */
  _dependentsOf(id) {
    return [...this._services.values()].filter((record) => record.definition.dependencies.includes(id)).map((record) => record.definition.id);
  }

  /**
   * @returns {string[]} Every service id, each after all of its (registered) dependencies.
   */
  _startOrder() {
    const order = [];
    const visited = new Set();
    const visit = (id) => {
      if (visited.has(id) || !this._services.has(id)) return;
      visited.add(id);
      for (const dependency of this._services.get(id).definition.dependencies) visit(dependency);
      order.push(id);
    };
    for (const id of this._services.keys()) visit(id);
    return order;
  }

  /**
   * Reject a registration that would create a dependency cycle.
   * @param {string} id
   * @returns {void}
   */
  _assertNoCycle(id) {
    const stack = new Set();
    const walk = (current) => {
      if (stack.has(current)) {
        this._services.delete(id);
        throw new Error(`[ServiceManager] registering "${id}" would create a dependency cycle`);
      }
      const record = this._services.get(current);
      if (!record) return;
      stack.add(current);
      for (const dependency of record.definition.dependencies) walk(dependency);
      stack.delete(current);
    };
    walk(id);
    // A service registered earlier may already depend on this one.
    for (const [otherId, record] of this._services) {
      if (otherId !== id && record.definition.dependencies.includes(id)) walk(otherId);
    }
  }
}

/**
 * Singleton service registry shared across the OS.
 * @type {ServiceManager}
 */
export const serviceManager = new ServiceManager();
