/**
 * @file About BrowserOS — logo, version, live theme/time, basic
 * browser info, and system status. Registered as singleInstance so
 * relaunching it from the Start Menu (later) just refocuses it.
 */

import { Application } from "../../core/application.js";
import { createElement } from "../../utils/dom.js";
import { themeManager } from "../../core/theme.js";
import { ensureStylesheet } from "../../utils/loadStylesheet.js";

ensureStylesheet("src/apps/about/about.css");

const CLOCK_TICK_MS = 1000;
const APP_VERSION = "0.1";

export default class AboutApp extends Application {
  constructor(meta) {
    super(meta);
    this._timeValueEl = null;
    this._viewportValueEl = null;
    this._clockIntervalId = null;
    this._resizeHandler = () => this._renderViewport();
  }

  /** @returns {ReturnType<Application["launch"]>} */
  launch() {
    const themeValueEl = createElement("span", {
      className: "about__value",
      text: capitalize(themeManager.getCurrent()),
    });
    const browserValueEl = createElement("span", { className: "about__value", text: detectBrowserName() });
    this._timeValueEl = createElement("span", { className: "about__value" });
    this._viewportValueEl = createElement("span", { className: "about__value" });

    const row = (label, valueEl) =>
      createElement("div", {
        className: "about__row",
        children: [createElement("span", { className: "about__label", text: label }), valueEl],
      });

    const element = createElement("div", {
      className: "about-app",
      children: [
        createElement("div", { className: "about__heading", text: "BrowserOS" }),
        createElement("div", { className: "about__version", text: `Version ${APP_VERSION}` }),
        createElement("p", {
          className: "about__description",
          text: "A desktop environment that runs entirely in the browser \u2014 windows, apps, and processes built from plain HTML, CSS, and JavaScript.",
        }),
        createElement("div", {
          className: "about__facts",
          children: [
            row("Theme", themeValueEl),
            row("Time", this._timeValueEl),
            row("Browser", browserValueEl),
            row("Viewport", this._viewportValueEl),
            row("Status", createElement("span", { className: "about__status", text: "Running" })),
          ],
        }),
      ],
    });

    this._renderTime();
    this._renderViewport();
    this._clockIntervalId = window.setInterval(() => this._renderTime(), CLOCK_TICK_MS);
    window.addEventListener("resize", this._resizeHandler);

    return {
      element,
      title: "About BrowserOS",
      icon: "\u2726",
      width: 460,
      height: 460,
      minWidth: 360,
      minHeight: 380,
      resizable: true,
      minimizable: true,
      maximizable: true,
      closable: true,
    };
  }

  /** @returns {void} */
  close() {
    if (this._clockIntervalId !== null) {
      window.clearInterval(this._clockIntervalId);
      this._clockIntervalId = null;
    }
    window.removeEventListener("resize", this._resizeHandler);
  }

  /** @returns {void} */
  _renderTime() {
    this._timeValueEl.textContent = new Intl.DateTimeFormat(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(new Date());
  }

  /** @returns {void} */
  _renderViewport() {
    this._viewportValueEl.textContent = `${window.innerWidth} \u00d7 ${window.innerHeight}`;
  }
}

/**
 * @param {string} value
 * @returns {string}
 */
function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * Small, honest heuristic — not a full UA parser, just enough to
 * show something meaningful in the "Browser" row.
 * @returns {string}
 */
function detectBrowserName() {
  const ua = navigator.userAgent;
  if (ua.includes("Edg/")) return "Microsoft Edge";
  if (ua.includes("Chrome/") && !ua.includes("Edg/")) return "Chrome";
  if (ua.includes("Firefox/")) return "Firefox";
  if (ua.includes("Safari/") && !ua.includes("Chrome/")) return "Safari";
  return "Unknown browser";
}
