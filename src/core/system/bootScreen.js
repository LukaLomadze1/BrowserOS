/**
 * @file The start-up screen.
 *
 * The screen itself is static markup in index.html, so it appears with
 * the very first paint, before any module has loaded. This module only
 * reports progress on it and removes it.
 *
 * Progress is counted in start-up stages that actually happen (code
 * loaded, settings read, file system opened, services started, desktop
 * built); the bar moves only when a stage has finished, never on a
 * timer. Nothing here waits: when the desktop is ready the screen fades
 * out over a desktop that already accepts input, and a click or key
 * press ends the fade at once. With reduced motion there is no fade.
 *
 * <body data-boot-state> tells styles and automated tests where
 * start-up is: "starting", "ready", "waiting" (another tab holds the
 * session), or "failed".
 */

const SCREEN_ID = "boot-screen";
/** Matches the opacity transition in styles/boot.css. */
const FADE_MS = 320;

class BootScreen {
  constructor() {
    this._stage = 0;
    this._total = 1;
    /** @type {(() => void)|null} */
    this._detachSkip = null;
  }

  /** @returns {HTMLElement|null} */
  _element() {
    return document.getElementById(SCREEN_ID);
  }

  /**
   * @param {number} total - How many stages start-up has, including the ones already finished.
   * @returns {void}
   */
  setStageCount(total) {
    this._total = Math.max(1, total);
    this._render();
  }

  /**
   * Mark the stages before `label` as finished and show `label` as the current one.
   * @param {number} finished - Stages finished so far.
   * @param {string} label - What is happening now.
   * @returns {void}
   */
  report(finished, label) {
    this._stage = Math.min(this._total, Math.max(this._stage, finished));
    const status = this._element()?.querySelector(".boot-screen__status");
    if (status) status.textContent = label;
    this._render();
  }

  /**
   * @param {"starting"|"ready"|"waiting"|"failed"} state
   * @returns {void}
   */
  setState(state) {
    document.body.dataset.bootState = state;
  }

  /**
   * Start-up finished: fill the bar and fade the screen out.
   * @returns {void}
   */
  finish() {
    this._stage = this._total;
    this._render();
    this.setState("ready");
    const element = this._element();
    if (!element) return;
    const reduced =
      document.documentElement.dataset.reducedMotion === "on" ||
      (typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    if (reduced) {
      element.remove();
      return;
    }
    element.setAttribute("aria-hidden", "true");
    element.classList.add("boot-screen--leaving");
    const removeNow = () => this.remove();
    const timer = window.setTimeout(removeNow, FADE_MS + 60);
    // A click or key press skips the rest of the fade.
    const skip = () => {
      window.clearTimeout(timer);
      removeNow();
    };
    window.addEventListener("pointerdown", skip, { once: true, capture: true });
    window.addEventListener("keydown", skip, { once: true, capture: true });
    this._detachSkip = () => {
      window.removeEventListener("pointerdown", skip, { capture: true });
      window.removeEventListener("keydown", skip, { capture: true });
    };
  }

  /**
   * Remove the screen immediately (start-up failed, or another screen
   * takes over).
   * @returns {void}
   */
  remove() {
    this._detachSkip?.();
    this._detachSkip = null;
    this._element()?.remove();
  }

  /** @returns {void} */
  _render() {
    const element = this._element();
    if (!element) return;
    const fraction = this._stage / this._total;
    element.style.setProperty("--boot-progress", String(fraction));
    const bar = element.querySelector(".boot-screen__track");
    bar?.setAttribute("aria-valuenow", String(Math.round(fraction * 100)));
  }
}

export const bootScreen = new BootScreen();
