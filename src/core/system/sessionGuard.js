/**
 * @file SessionGuard — keeps BrowserOS active in one browser tab at a
 * time, and refuses to start inside a frame of its own origin.
 *
 * Why: every tab of the same site shares one IndexedDB database and one
 * localStorage. Two running copies would each keep their own in-memory
 * state and overwrite each other's settings, history, and files without
 * noticing. So the first tab holds the session (a Web Lock named
 * "browseros-session"); a tab opened later shows a notice instead of
 * the desktop.
 *
 * Moving the session: "Use BrowserOS here" in the waiting tab asks the
 * active tab (over a BroadcastChannel) to hand over. The active tab
 * saves pending settings and history, stops background services, asks
 * first if any application reports unsaved work, then releases the lock
 * and shows a notice of its own. The waiting tab starts as soon as it
 * holds the lock — also when the active tab is simply closed.
 *
 * Browsers without the Web Locks API run without the guard (every tab
 * starts, as before).
 *
 * Messages on the "browseros-session" channel:
 *   { type: "takeover", from }            a waiting tab asks for the session
 *   { type: "takeover-waiting", reason }  the active tab is asking its user first ("unsaved")
 *   { type: "takeover-denied" }           the active tab's user chose to keep it
 */

const LOCK_NAME = "browseros-session";
const CHANNEL_NAME = "browseros-session";

class SessionGuard {
  constructor() {
    this._tabId = typeof crypto?.randomUUID === "function" ? crypto.randomUUID() : String(Math.random()).slice(2);
    /** @type {(() => void)|null} Releases the held lock. */
    this._release = null;
    /** @type {BroadcastChannel|null} */
    this._channel = null;
    /** @type {((request: {respondWaiting: (reason: string) => void, deny: () => void}) => void)|null} */
    this._takeoverHandler = null;
  }

  /** @returns {boolean} Whether the Web Locks API is available (otherwise the guard is off). */
  isSupported() {
    return typeof navigator !== "undefined" && Boolean(navigator.locks?.request) && typeof BroadcastChannel === "function";
  }

  /**
   * @returns {boolean} Whether this document is framed by a page of the
   *   same origin — for example BrowserOS's own Browser showing BrowserOS.
   *   Embedding by another site is allowed.
   */
  isNestedInItself() {
    if (window.top === window.self) return false;
    try {
      return window.parent.location.origin === window.location.origin;
    } catch {
      return false; // A cross-origin parent can't be read: a different site embeds BrowserOS.
    }
  }

  /** @returns {boolean} Whether this tab currently holds the session. */
  isActive() {
    return this._release !== null || !this.isSupported();
  }

  /**
   * Resolve once this tab holds the session. If another tab holds it,
   * `onWaiting` is called with controls for a "use here" button, and
   * the promise resolves when the session arrives (after a takeover, or
   * when the other tab closes).
   * @param {object} [options]
   * @param {(controls: {requestTakeover: () => void, onStatus: (listener: (status: "requested"|"waiting-unsaved"|"denied") => void) => void}) => void} [options.onWaiting]
   * @returns {Promise<void>}
   */
  async claim({ onWaiting } = {}) {
    if (!this.isSupported() || this._release) return;
    this._openChannel();
    if (await this._tryAcquire()) return;

    const statusListeners = new Set();
    const onMessage = (event) => {
      const data = event.data;
      if (data?.type === "takeover-waiting") statusListeners.forEach((listener) => listener("waiting-unsaved"));
      if (data?.type === "takeover-denied") statusListeners.forEach((listener) => listener("denied"));
    };
    this._channel.addEventListener("message", onMessage);
    onWaiting?.({
      requestTakeover: () => {
        this._channel.postMessage({ type: "takeover", from: this._tabId });
        statusListeners.forEach((listener) => listener("requested"));
      },
      onStatus: (listener) => statusListeners.add(listener),
    });
    await this._acquire({ wait: true });
    this._channel.removeEventListener("message", onMessage);
  }

  /**
   * Called in the active tab when another tab asks for the session. The
   * handler decides (possibly after asking the user) and then calls
   * `release()`, or `deny()` through the request.
   * @param {(request: {respondWaiting: (reason: string) => void, deny: () => void}) => void} handler
   * @returns {void}
   */
  onTakeoverRequest(handler) {
    this._takeoverHandler = handler;
  }

  /**
   * Give up the session (after saving whatever needs saving).
   * @returns {void}
   */
  release() {
    const release = this._release;
    this._release = null;
    release?.();
  }

  // ---------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------

  /** @returns {void} */
  _openChannel() {
    if (this._channel) return;
    this._channel = new BroadcastChannel(CHANNEL_NAME);
    this._channel.addEventListener("message", (event) => {
      if (event.data?.type !== "takeover" || event.data.from === this._tabId || !this._release) return;
      const request = {
        respondWaiting: (reason) => this._channel.postMessage({ type: "takeover-waiting", reason }),
        deny: () => this._channel.postMessage({ type: "takeover-denied" }),
      };
      if (this._takeoverHandler) {
        this._takeoverHandler(request);
      } else {
        this.release();
      }
    });
  }

  /** @returns {Promise<boolean>} Whether the lock was free and is now held. */
  _tryAcquire() {
    return this._acquire({ wait: false });
  }

  /**
   * @param {{wait: boolean}} options
   * @returns {Promise<boolean>}
   */
  _acquire({ wait }) {
    return new Promise((resolve, reject) => {
      navigator.locks
        .request(LOCK_NAME, wait ? {} : { ifAvailable: true }, (lock) => {
          if (!lock) {
            resolve(false);
            return undefined;
          }
          // Hold the lock until release() (or until the tab closes).
          return new Promise((releaseLock) => {
            this._release = releaseLock;
            resolve(true);
          });
        })
        .catch(reject);
    });
  }
}

/**
 * Singleton guard for this tab.
 * @type {SessionGuard}
 */
export const sessionGuard = new SessionGuard();
