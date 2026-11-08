/**
 * @file About BrowserOS: the release, what BrowserOS is made of, what
 * this browser reports about itself, the installed applications, and
 * credits.
 *
 * System information comes from src/core/system/browserInfo.js and is
 * labelled as browser-reported: a web page can't see the computer's
 * hardware, and BrowserOS doesn't pretend to. Theme, accent, wallpaper,
 * and the application list are read live from SettingsService,
 * ThemeManager, and AppManager. Registered as singleInstance, so
 * launching it again focuses the open window (optionally on a tab:
 * `appManager.launch("about", { tab: "system" })`).
 */

import { Application } from "../../core/application.js";
import { createElement, clearElement } from "../../utils/dom.js";
import { createIconElement } from "../../utils/icons.js";
import { formatBytes } from "../../utils/format.js";
import { ensureStylesheet } from "../../utils/loadStylesheet.js";
import { themeManager } from "../../core/theme.js";
import { settingsService } from "../../core/settings/settingsService.js";
import { ACCENT_PRESETS } from "../../core/settings/accentPresets.js";
import { WALLPAPER_PRESETS } from "../../core/settings/settingsSchema.js";
import { getBrowserInfo, getStorageInfo } from "../../core/system/browserInfo.js";
import { BUILD_INFO } from "../../core/buildInfo.js";
import { BROWSEROS_LICENSE, BROWSEROS_RELEASE_DATE, BROWSEROS_REPOSITORY, BROWSEROS_VERSION } from "../../core/version.js";

ensureStylesheet("src/apps/about/about.css");

const TABS = Object.freeze([
  { id: "overview", label: "Overview" },
  { id: "system", label: "System" },
  { id: "applications", label: "Applications" },
  { id: "credits", label: "Credits" },
]);

const ARCHITECTURE = Object.freeze([
  ["icon:layers", "Shell", "Desktop, windows, taskbar, Start menu, system tray, and notifications, with a window manager and an application manager that loads each application on first use."],
  ["icon:folder", "File system", "A virtual file system with folders, Trash, and atomic operations, stored in the browser's IndexedDB. Every application uses the same public API."],
  ["icon:sliders", "Settings and services", "Validated, versioned preferences saved in localStorage, and background services for reminders, alarms, downloads, and monitoring."],
  ["icon:shield", "Isolation", "Web pages and Code Studio previews run in sandboxed frames; user content is never inserted as markup."],
]);

const FONTS = Object.freeze([
  ["Inter", "The Inter Project Authors", "Interface text"],
  ["Space Grotesk", "The Space Grotesk Project Authors", "Headings and the wordmark"],
  ["JetBrains Mono", "The JetBrains Mono Project Authors", "Code and the Terminal"],
]);

let instanceCount = 0;

export default class AboutApp extends Application {
  constructor(meta) {
    super(meta);
    this._tab = "overview";
    this._panelEl = null;
    this._tabButtons = new Map();
    this._cleanups = [];
    this._resizeHandler = () => this._tab === "system" && this._render();
    this._idPrefix = `about-${++instanceCount}`;
  }

  /**
   * @param {{tab?: string}} [options]
   * @returns {ReturnType<Application["launch"]>}
   */
  launch(options = {}) {
    if (TABS.some((tab) => tab.id === options.tab)) this._tab = options.tab;

    const tabList = createElement("div", {
      className: "about__tabs",
      attrs: { role: "tablist", "aria-label": "About BrowserOS" },
      on: { keydown: (e) => this._onTabKey(e) },
    });
    for (const tab of TABS) {
      const button = createElement("button", {
        className: "about__tab",
        attrs: { type: "button", role: "tab", id: `${this._idPrefix}-tab-${tab.id}`, "aria-controls": `${this._idPrefix}-panel`, "data-tab": tab.id },
        text: tab.label,
        on: { click: () => this._select(tab.id) },
      });
      this._tabButtons.set(tab.id, button);
      tabList.append(button);
    }

    this._panelEl = createElement("div", {
      className: "about__panel",
      attrs: { role: "tabpanel", id: `${this._idPrefix}-panel`, tabindex: "0" },
    });

    const element = createElement("div", {
      className: "about-app",
      children: [
        createElement("header", {
          className: "about__header",
          children: [
            createIconElement("icon:browseros", { className: "about__mark brand-mark" }),
            createElement("div", {
              className: "about__identity",
              children: [
                createElement("h1", { className: "about__name", text: "BrowserOS" }),
                createElement("p", { className: "about__version", text: `Version ${BROWSEROS_VERSION} · Released ${formatReleaseDate(BROWSEROS_RELEASE_DATE)}` }),
              ],
            }),
          ],
        }),
        tabList,
        this._panelEl,
      ],
    });

    this._cleanups.push(
      settingsService.subscribe("appearance.theme", () => this._tab === "system" && this._render()),
      settingsService.subscribe("appearance.accentColor", () => this._tab === "system" && this._render()),
      settingsService.subscribe("wallpaper.preset", () => this._tab === "system" && this._render())
    );
    window.addEventListener("resize", this._resizeHandler);
    this._render();

    return {
      element,
      title: "About BrowserOS",
      icon: "icon:browseros",
      width: 720,
      height: Math.max(440, Math.min(620, window.innerHeight - 120)),
      minWidth: 440,
      minHeight: 400,
      resizable: true,
      minimizable: true,
      maximizable: true,
      closable: true,
    };
  }

  /** @param {{tab?: string}} [options] */
  onRelaunch(options = {}) {
    if (TABS.some((tab) => tab.id === options.tab)) this._select(options.tab);
  }

  /** @returns {void} */
  close() {
    for (const cleanup of this._cleanups) cleanup();
    this._cleanups = [];
    window.removeEventListener("resize", this._resizeHandler);
  }

  /**
   * @param {string} id
   * @param {{focus?: boolean}} [options]
   * @returns {void}
   */
  _select(id, { focus = false } = {}) {
    this._tab = id;
    this._render();
    if (focus) this._tabButtons.get(id)?.focus();
  }

  /** @param {KeyboardEvent} e */
  _onTabKey(e) {
    const index = TABS.findIndex((tab) => tab.id === this._tab);
    let next = null;
    if (e.key === "ArrowRight") next = (index + 1) % TABS.length;
    if (e.key === "ArrowLeft") next = (index - 1 + TABS.length) % TABS.length;
    if (e.key === "Home") next = 0;
    if (e.key === "End") next = TABS.length - 1;
    if (next === null) return;
    e.preventDefault();
    this._select(TABS[next].id, { focus: true });
  }

  /** @returns {void} */
  _render() {
    for (const [id, button] of this._tabButtons) {
      const selected = id === this._tab;
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
      button.classList.toggle("about__tab--selected", selected);
    }
    this._panelEl.setAttribute("aria-labelledby", `${this._idPrefix}-tab-${this._tab}`);
    clearElement(this._panelEl);
    const build = { overview: () => this._buildOverview(), system: () => this._buildSystem(), applications: () => this._buildApplications(), credits: () => this._buildCredits() };
    this._panelEl.append(build[this._tab]());
  }

  /** @returns {HTMLElement} */
  _buildOverview() {
    return createElement("div", {
      className: "about__section",
      children: [
        createElement("p", {
          className: "about__lead",
          text: "BrowserOS is a desktop environment that runs in a web browser: windows, a file system, and a set of applications, written in plain HTML, CSS, and JavaScript with no frameworks, no build step, and no server. It is not an operating system for your computer; it runs inside this browser tab, and everything it stores stays in this browser.",
        }),
        createElement("h2", { className: "about__heading", text: "How it is built" }),
        createElement("ul", {
          className: "about__architecture",
          children: ARCHITECTURE.map(([icon, title, text]) =>
            createElement("li", {
              children: [
                createIconElement(icon, { className: "about__architecture-icon" }),
                createElement("div", {
                  children: [createElement("p", { className: "about__item-title", text: title }), createElement("p", { className: "about__item-text", text })],
                }),
              ],
            })
          ),
        }),
        createElement("div", {
          className: "about__links",
          children: [
            link("Source code and documentation", BROWSEROS_REPOSITORY),
            link("Architecture", `${BROWSEROS_REPOSITORY}/blob/main/docs/ARCHITECTURE.md`),
          ],
        }),
      ],
    });
  }

  /** @returns {HTMLElement} */
  _buildSystem() {
    const info = getBrowserInfo();
    const notReported = "Not reported by this browser";
    const theme = themeManager.getCurrent();
    const mode = settingsService.get("appearance.theme");
    const accent = ACCENT_PRESETS.find((preset) => preset.id === settingsService.get("appearance.accentColor"))?.label ?? "";
    const wallpaper = WALLPAPER_PRESETS.find((preset) => preset.id === settingsService.get("wallpaper.preset"))?.label ?? "";
    const apps = this._listApps();

    const storageValue = createElement("dd", { className: "about__value", text: "Checking…", attrs: { "data-field": "storage" } });
    const persistValue = createElement("dd", { className: "about__value", text: "Checking…", attrs: { "data-field": "persisted" } });
    getStorageInfo().then(({ usage, quota, persisted }) => {
      storageValue.textContent = usage === null ? notReported : quota ? `${formatBytes(usage)} used of ${formatBytes(quota)} available` : `${formatBytes(usage)} used`;
      persistValue.textContent =
        persisted === null ? notReported : persisted ? "Yes: the browser won't clear it to free space" : "No: the browser may clear it when space runs low (keep backups)";
    });

    const build = BUILD_INFO
      ? `${BUILD_INFO.commit.slice(0, 7)}${BUILD_INFO.dirty ? " (with uncommitted changes)" : ""}, built ${formatDateTime(BUILD_INFO.builtAt)}`
      : "Running from the source files (no build information)";

    return createElement("div", {
      className: "about__section",
      children: [
        group("BrowserOS", [
          ["Version", BROWSEROS_VERSION],
          ["Build", build],
          ["Applications", `${apps.length} installed`],
          ["Theme", `${capitalize(theme)}${mode === "system" ? " (following the device)" : ""}`],
          ["Accent color", accent],
          ["Wallpaper", wallpaper],
        ]),
        group("Reported by your browser", [
          ["Browser", info.browser ?? notReported],
          ["Rendering engine", info.engine ?? notReported],
          ["Operating system", info.platform ? `${info.platform}${info.mobile ? " (mobile)" : ""}` : notReported],
          ["Language", info.language ?? notReported],
          ["Time zone", info.timeZone ?? notReported],
          ["Screen", info.screen ? `${info.screen.width} × ${info.screen.height} at ${round(info.screen.pixelRatio)}× pixel ratio` : notReported],
          ["Window", `${window.innerWidth} × ${window.innerHeight}`],
          ["Logical processors", info.logicalProcessors === null ? notReported : String(info.logicalProcessors)],
        ]),
        group("Storage for this site", [], [
          createElement("dt", { className: "about__label", text: "Used" }),
          storageValue,
          createElement("dt", { className: "about__label", text: "Persistent" }),
          persistValue,
        ]),
        createElement("p", {
          className: "about__footnote",
          text: "These values are what this browser tells web pages. BrowserOS can't see your computer's hardware or other programs, and browsers may round or hide some values for privacy. Storage figures are the browser's estimate for this site.",
        }),
      ],
    });
  }

  /** @returns {HTMLElement} */
  _buildApplications() {
    const apps = this._listApps();
    return createElement("div", {
      className: "about__section",
      children: [
        createElement("p", { className: "about__lead", text: `${apps.length} applications are installed. Each one loads the first time it is opened.` }),
        createElement("ul", {
          className: "about__apps",
          children: apps.map((app) =>
            createElement("li", {
              className: "about__app",
              children: [
                createIconElement(app.icon, { className: "about__app-icon" }),
                createElement("div", {
                  className: "about__app-text",
                  children: [
                    createElement("p", { className: "about__item-title", text: app.name }),
                    createElement("p", { className: "about__item-text", text: app.description }),
                  ],
                }),
                createElement("span", { className: "about__app-category", text: app.category }),
              ],
            })
          ),
        }),
      ],
    });
  }

  /** @returns {HTMLElement} */
  _buildCredits() {
    const license = BROWSEROS_LICENSE
      ? `BrowserOS's source code is published under the ${BROWSEROS_LICENSE} license; see the LICENSE file in the repository.`
      : "The repository doesn't include a license for BrowserOS's own source code yet, so all rights are reserved by its author.";
    return createElement("div", {
      className: "about__section",
      children: [
        createElement("p", {
          className: "about__lead",
          text: "BrowserOS is written from scratch in HTML, CSS, and JavaScript. It uses no frameworks, libraries, or third-party scripts; its only third-party files are the interface fonts.",
        }),
        createElement("h2", { className: "about__heading", text: "Fonts" }),
        createElement("ul", {
          className: "about__credits",
          children: FONTS.map(([name, authors, use]) =>
            createElement("li", {
              children: [
                createElement("p", { className: "about__item-title", text: name }),
                createElement("p", { className: "about__item-text", text: `${use}. © ${authors}. SIL Open Font License 1.1, included in assets/fonts.` }),
              ],
            })
          ),
        }),
        createElement("h2", { className: "about__heading", text: "License" }),
        createElement("p", { className: "about__item-text", text: license }),
        createElement("div", { className: "about__links", children: [link("Repository", BROWSEROS_REPOSITORY)] }),
      ],
    });
  }

  /** @returns {Array<{id: string, name: string, icon: string|null, description: string, category: string}>} */
  _listApps() {
    if (!this.appManager) return [];
    return this.appManager
      .getRegisteredApps()
      .filter((app) => !app.dynamic)
      .sort((a, b) => a.name.localeCompare(b.name));
  }
}

/**
 * @param {string} title
 * @param {Array<[string, string]>} rows
 * @param {HTMLElement[]} [extra] - Ready-made dt/dd elements appended after the rows.
 * @returns {HTMLElement}
 */
function group(title, rows, extra = []) {
  return createElement("section", {
    className: "about__group",
    children: [
      createElement("h2", { className: "about__heading", text: title }),
      createElement("dl", {
        className: "about__facts",
        children: [
          ...rows.flatMap(([label, value]) => [
            createElement("dt", { className: "about__label", text: label }),
            createElement("dd", { className: "about__value", text: value }),
          ]),
          ...extra,
        ],
      }),
    ],
  });
}

/**
 * A link that opens in a new tab of the browser BrowserOS runs in.
 * @param {string} label
 * @param {string} href
 * @returns {HTMLElement}
 */
function link(label, href) {
  return createElement("a", {
    className: "os-button about__link",
    attrs: { href, target: "_blank", rel: "noopener noreferrer" },
    children: [createElement("span", { text: label }), createIconElement("icon:external")],
  });
}

/**
 * @param {string} isoDate - "YYYY-MM-DD"
 * @returns {string}
 */
function formatReleaseDate(isoDate) {
  const [year, month, day] = isoDate.split("-").map(Number);
  return new Intl.DateTimeFormat(undefined, { dateStyle: "long" }).format(new Date(year, month - 1, day));
}

/**
 * @param {string} iso
 * @returns {string}
 */
function formatDateTime(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

/**
 * @param {number} value
 * @returns {string}
 */
function round(value) {
  return String(Math.round(value * 100) / 100);
}

/**
 * @param {string} value
 * @returns {string}
 */
function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
