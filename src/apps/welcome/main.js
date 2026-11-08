/**
 * @file Welcome — the first-run tour.
 *
 * Seven short steps: a welcome (with the offer to add sample files),
 * appearance (theme, accent, wallpaper, applied live through
 * SettingsService), the basics of windows and the desktop, the Start
 * menu, files and folders, the installed applications, and a summary.
 *
 * It opens by itself on a new installation (see src/core/onboarding.js)
 * and from the Start menu or Settings › System at any time. Finishing
 * records "completed"; Skip tour or closing the window records
 * "skipped". Nothing is changed unless the user chooses it: sample files
 * are added only when the box on the first step is checked when the
 * user continues or skips (it is checked by default only when this
 * start created the file system, so there are no user files yet), and
 * appearance changes only
 * when an option is picked.
 */

import { Application } from "../../core/application.js";
import { createElement, clearElement } from "../../utils/dom.js";
import { createIconElement } from "../../utils/icons.js";
import { ensureStylesheet } from "../../utils/loadStylesheet.js";
import { eventBus } from "../../core/eventBus.js";
import { settingsService } from "../../core/settings/settingsService.js";
import { themeManager } from "../../core/theme.js";
import { ACCENT_PRESETS } from "../../core/settings/accentPresets.js";
import { WALLPAPER_PRESETS } from "../../core/settings/settingsSchema.js";
import { keyboardShortcuts } from "../../core/keyboard/keyboardShortcuts.js";
import { vfs } from "../../core/vfs/virtualFileSystem.js";
import { openVfsEntry } from "../../core/vfs/vfsOpener.js";
import { onboarding } from "../../core/onboarding.js";
import { sampleContent } from "../../core/demo/sampleContent.js";
import { BROWSEROS_VERSION } from "../../core/version.js";

ensureStylesheet("src/apps/welcome/welcome.css");

const STEPS = Object.freeze(["welcome", "appearance", "basics", "start", "files", "apps", "done"]);
const GUIDE_PATH = "/Documents/BrowserOS-Guide.txt";

const THEME_OPTIONS = Object.freeze([
  { value: "dark", label: "Dark", detail: "Low-glare surfaces" },
  { value: "light", label: "Light", detail: "Bright, crisp surfaces" },
  { value: "system", label: "System", detail: "Follows your device" },
]);

let radioGroupCount = 0;

export default class WelcomeApp extends Application {
  constructor(meta) {
    super(meta);
    this._step = 0;
    this._firstRun = false;
    this._finished = false;
    /** "idle" | "installing" | "installed" | "failed" */
    this._sampleState = "idle";
    this._sampleMessage = "";
    this._wantSamples = false;
    this._cleanups = [];
    this._bodyEl = null;
    this._footerEl = null;
    this._element = null;
  }

  /**
   * @param {{firstRun?: boolean}} [options]
   * @returns {ReturnType<Application["launch"]>}
   */
  launch(options = {}) {
    this._firstRun = options.firstRun === true;
    const installed = sampleContent.getState().installed;
    this._sampleState = installed ? "installed" : "idle";
    // Consent: pre-checked only when this start created the file system,
    // so there are no user files the samples could mix with.
    this._wantSamples = this._firstRun && vfs.isNewInstallation() && !installed;

    this._bodyEl = createElement("div", { className: "welcome__body" });
    this._footerEl = createElement("div", { className: "welcome__footer" });
    this._element = createElement("div", {
      className: "welcome",
      children: [this._bodyEl, this._footerEl],
    });

    this._cleanups.push(
      settingsService.subscribe("appearance.theme", () => this._refreshAppearance()),
      settingsService.subscribe("appearance.accentColor", () => this._refreshAppearance()),
      settingsService.subscribe("wallpaper.preset", () => this._refreshAppearance())
    );

    this._render();

    return {
      element: this._element,
      title: "Welcome to BrowserOS",
      icon: "icon:compass",
      width: 800,
      // Fits above the taskbar on small screens too.
      height: Math.max(460, Math.min(660, window.innerHeight - 120)),
      minWidth: 520,
      minHeight: 460,
      center: true,
      resizable: true,
      minimizable: true,
      maximizable: true,
      closable: true,
    };
  }

  /** @param {{step?: string}} [options] */
  onRelaunch(options = {}) {
    const index = STEPS.indexOf(options.step ?? "");
    if (index >= 0) this._goTo(index);
  }

  /** @returns {void} */
  close() {
    for (const cleanup of this._cleanups) cleanup();
    this._cleanups = [];
    // Closing the window during the first run counts as skipping
    // (nothing else changes).
    if (!this._finished && onboarding.getStatus() === "pending") onboarding.setStatus("skipped");
  }

  // ---------------------------------------------------------------
  // Navigation
  // ---------------------------------------------------------------

  /** @returns {boolean} */
  _isLastStep() {
    return this._step === STEPS.length - 1;
  }

  /**
   * @param {number} index
   * @returns {void}
   */
  _goTo(index) {
    if (this._step === 0 && index > 0) this._applySampleChoice();
    this._step = Math.max(0, Math.min(STEPS.length - 1, index));
    this._render();
    this._bodyEl.scrollTop = 0;
    this._bodyEl.querySelector(".welcome__title")?.focus({ preventScroll: true });
  }

  /** @returns {void} */
  _skip() {
    if (this._step === 0) this._applySampleChoice();
    this._finished = true;
    if (onboarding.getStatus() === "pending") onboarding.setStatus("skipped");
    this.appManager?.closeWindow(this.windowId);
  }

  /** @returns {void} */
  _finish() {
    this._finished = true;
    onboarding.setStatus("completed");
    this.appManager?.closeWindow(this.windowId);
  }

  /**
   * Add the sample files when the box on the first step is checked.
   * Runs in the background; the outcome is shown in the tour (and, on
   * failure, logged with the error).
   * @returns {void}
   */
  _applySampleChoice() {
    if (!this._wantSamples || this._sampleState !== "idle") return;
    this._sampleState = "installing";
    this._renderFooter();
    sampleContent
      .install(vfs)
      .then(({ created }) => {
        this._sampleState = "installed";
        this._sampleMessage = `${created.length} sample files added`;
      })
      .catch((error) => {
        console.error("[Welcome] the sample files couldn't be added:", error);
        this._sampleState = "failed";
        this._sampleMessage = `Sample files couldn't be added: ${error?.message ?? error}`;
      })
      .finally(() => {
        if (!this._element?.isConnected) return;
        this._renderFooter();
        if (STEPS[this._step] === "done" || STEPS[this._step] === "files") this._renderStep();
      });
  }

  // ---------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------

  /** @returns {void} */
  _render() {
    this._renderStep();
    this._renderFooter();
  }

  /** @returns {void} */
  _renderStep() {
    clearElement(this._bodyEl);
    const id = STEPS[this._step];
    this._element.dataset.step = id;
    const builders = {
      welcome: () => this._buildWelcome(),
      appearance: () => this._buildAppearance(),
      basics: () => this._buildBasics(),
      start: () => this._buildStartMenu(),
      files: () => this._buildFiles(),
      apps: () => this._buildApps(),
      done: () => this._buildDone(),
    };
    this._bodyEl.append(builders[id]());
  }

  /** @returns {void} */
  _renderFooter() {
    clearElement(this._footerEl);
    const dots = createElement("div", {
      className: "welcome__dots",
      attrs: { "aria-hidden": "true" },
      children: STEPS.map((_, index) =>
        createElement("span", { className: `welcome__dot${index === this._step ? " welcome__dot--current" : index < this._step ? " welcome__dot--done" : ""}` })
      ),
    });
    const progress = createElement("div", {
      className: "welcome__progress",
      children: [dots, createElement("span", { className: "welcome__step-label", text: `Step ${this._step + 1} of ${STEPS.length}` })],
    });

    const status = createElement("p", { className: "welcome__sample-status", attrs: { role: "status" } });
    if (this._sampleState === "installing") status.textContent = "Adding sample files…";
    else if (this._sampleState === "failed") {
      status.textContent = this._sampleMessage;
      status.classList.add("welcome__sample-status--error");
    } else if (this._sampleMessage) status.textContent = this._sampleMessage;

    const actions = createElement("div", { className: "welcome__actions" });
    if (!this._isLastStep()) {
      actions.append(button("Skip tour", () => this._skip(), "quiet", "welcome__skip"));
    }
    if (this._step > 0) actions.append(button("Back", () => this._goTo(this._step - 1), "default", "welcome__back"));
    if (this._isLastStep()) {
      actions.append(button("Start using BrowserOS", () => this._finish(), "primary", "welcome__finish"));
    } else {
      actions.append(button(this._step === 0 ? "Get started" : "Next", () => this._goTo(this._step + 1), "primary", "welcome__next"));
    }
    this._footerEl.append(progress, status, actions);
  }

  /** @returns {HTMLElement} */
  _buildWelcome() {
    const apps = this._listApps();
    const samples = this._buildSampleChoice();
    return createElement("section", {
      className: "welcome__step welcome__step--hero",
      children: [
        createIconElement("icon:browseros", { className: "welcome__mark brand-mark" }),
        title("Welcome to BrowserOS"),
        createElement("p", {
          className: "welcome__lead",
          text: "A desktop environment that runs entirely in this browser tab: windows, a file system, and applications, built with plain HTML, CSS, and JavaScript. Nothing is installed on your computer.",
        }),
        createElement("ul", {
          className: "welcome__facts",
          children: [
            fact("icon:folder", "A real file system", "Folders and files that stay in this browser between visits."),
            fact("icon:apps", `${apps.length} applications`, "From File Explorer and Terminal to Code Studio and Calendar."),
            fact("icon:lock", "Private to this browser", "Nothing is uploaded. Back up to a file whenever you like."),
          ],
        }),
        samples,
        createElement("p", { className: "welcome__hint", text: `BrowserOS ${BROWSEROS_VERSION} · This tour takes about a minute.` }),
      ],
    });
  }

  /** @returns {HTMLElement} */
  _buildSampleChoice() {
    if (this._sampleState === "installed" || this._sampleState === "installing") {
      return createElement("div", {
        className: "welcome__samples welcome__samples--done",
        children: [
          createIconElement("icon:success", { className: "welcome__samples-icon" }),
          createElement("p", {
            text: this._sampleState === "installing" ? "Adding sample files…" : "Sample files are in Documents, Projects, Pictures, and Downloads.",
          }),
        ],
      });
    }
    const id = `welcome-samples-${radioGroupCount++}`;
    const checkbox = createElement("input", {
      className: "welcome__checkbox",
      attrs: { type: "checkbox", id, name: "samples" },
      on: { change: (e) => (this._wantSamples = e.target.checked) },
    });
    checkbox.checked = this._wantSamples;
    return createElement("div", {
      className: "welcome__samples",
      children: [
        checkbox,
        createElement("label", {
          attrs: { for: id },
          children: [
            createElement("span", { className: "welcome__samples-title", text: "Add sample files to explore" }),
            createElement("span", {
              className: "welcome__samples-detail",
              text: `${sampleContent.getSampleCount()} files: a guide and notes in Documents, two web projects for Code Studio, pictures, and a download. Existing files are never replaced, and you can remove the samples later in Settings › System.`,
            }),
          ],
        }),
      ],
    });
  }

  /** @returns {HTMLElement} */
  _buildAppearance() {
    const section = createElement("section", {
      className: "welcome__step",
      children: [
        title("Make it yours"),
        createElement("p", { className: "welcome__lead", text: "Changes apply right away. You can change them later in Settings › Appearance and Wallpaper." }),
      ],
    });
    const theme = settingsService.get("appearance.theme");
    section.append(
      choiceGroup({
        label: "Theme",
        name: "theme",
        value: theme,
        className: "welcome__themes",
        options: THEME_OPTIONS.map((option) => ({
          value: option.value,
          content: [
            createElement("span", { className: `welcome__theme-preview welcome__theme-preview--${option.value}`, attrs: { "aria-hidden": "true" } }),
            createElement("span", { className: "welcome__option-label", text: option.label }),
            createElement("span", { className: "welcome__option-detail", text: option.detail }),
          ],
        })),
        onChange: (value) => settingsService.set("appearance.theme", value),
      })
    );
    const effective = themeManager.getCurrent() === "light" ? "light" : "dark";
    section.append(
      choiceGroup({
        label: "Accent color",
        name: "accent",
        value: settingsService.get("appearance.accentColor"),
        className: "welcome__accents",
        options: ACCENT_PRESETS.map((preset) => ({
          value: preset.id,
          content: [
            createElement("span", { className: "welcome__swatch", attrs: { "aria-hidden": "true", style: `background: ${preset[effective].primary}` } }),
            createElement("span", { className: "welcome__option-label", text: preset.label }),
          ],
        })),
        onChange: (value) => settingsService.set("appearance.accentColor", value),
      })
    );
    section.append(
      choiceGroup({
        label: "Wallpaper",
        name: "wallpaper",
        value: settingsService.get("wallpaper.preset"),
        className: "welcome__wallpapers",
        options: WALLPAPER_PRESETS.map((preset) => ({
          value: preset.id,
          content: [
            createElement("span", { className: "welcome__wallpaper-preview", attrs: { "aria-hidden": "true", "data-wallpaper-preview": preset.id } }),
            createElement("span", { className: "welcome__option-label", text: preset.label }),
          ],
        })),
        onChange: (value) => settingsService.set("wallpaper.preset", value),
      })
    );
    return section;
  }

  /** Re-render the appearance step when its settings change elsewhere. */
  _refreshAppearance() {
    if (STEPS[this._step] === "appearance" && this._bodyEl) {
      const focusedValue = document.activeElement?.closest?.(".welcome") ? document.activeElement.value : null;
      const focusedName = document.activeElement?.name;
      this._renderStep();
      if (focusedValue && focusedName) this._bodyEl.querySelector(`input[name="${focusedName}"][value="${focusedValue}"]`)?.focus();
    }
  }

  /** @returns {HTMLElement} */
  _buildBasics() {
    return createElement("section", {
      className: "welcome__step",
      children: [
        title("Windows and the desktop"),
        createElement("p", { className: "welcome__lead", text: "BrowserOS works like the desktops you know. A few things worth trying:" }),
        createElement("ul", {
          className: "welcome__tips",
          children: [
            tip("icon:file", "Open anything", "Double-click an icon on the desktop or in File Explorer, or select it and press", ["Enter"]),
            tip("icon:maximize", "Move and resize windows", "Drag the title bar to move a window and its edges to resize it. Double-click the title bar to maximize, or press", this._keys("window.toggleMaximize")),
            tip("icon:layers", "Switch between windows", "Use the buttons on the taskbar, or press", this._keys("window.next")),
            tip("icon:more", "Find more options", "Right-click the desktop, icons, files, and taskbar buttons for menus such as New folder, Rename, and Open with.", []),
            tip("icon:close", "Close a window", "Use the × button in its title bar, or press", this._keys("window.close")),
          ],
        }),
      ],
    });
  }

  /** @returns {HTMLElement} */
  _buildStartMenu() {
    const key = this._keys("startMenu.toggle");
    return createElement("section", {
      className: "welcome__step",
      children: [
        title("The Start menu"),
        createElement("p", {
          className: "welcome__lead",
          children: [
            document.createTextNode("Everything starts here. Select the "),
            createElement("b", { text: "Start" }),
            document.createTextNode(" button in the lower-left corner"),
            ...(key.length ? [document.createTextNode(", or press "), ...keyCaps(key)] : []),
            document.createTextNode("."),
          ],
        }),
        createElement("ul", {
          className: "welcome__tips",
          children: [
            tip("icon:apps", "Pinned applications", "Your favorite applications, one click away. Pin and reorder them in Settings › Start Menu.", []),
            tip("icon:search", "Search", "Start typing to find applications, files, folders, and settings.", []),
            tip("icon:history", "Recent files and applications", "What you opened last, ready to open again.", []),
            tip("icon:power", "Restart and shut down", "Restart reloads BrowserOS; Shut down saves everything and stops it until you start it again.", []),
          ],
        }),
        createElement("div", {
          className: "welcome__try",
          children: [button("Open the Start menu", () => eventBus.emit("startmenu:toggle", {}), "default", "welcome__try-start")],
        }),
      ],
    });
  }

  /** @returns {HTMLElement} */
  _buildFiles() {
    const samples = this._sampleState === "installed";
    return createElement("section", {
      className: "welcome__step",
      children: [
        title("Files and folders"),
        createElement("p", {
          className: "welcome__lead",
          text: "Everything you save is kept in BrowserOS's own file system, stored in this browser. File Explorer, the desktop, the Terminal, and every application work with the same files.",
        }),
        createElement("ul", {
          className: "welcome__folders",
          children: [
            folder("icon:display", "Desktop", "Files here appear on the desktop"),
            folder("icon:file-text", "Documents", samples ? "Your documents, the guide, and sample notes" : "Your documents; Notes saves here"),
            folder("icon:code", "Projects", samples ? "Two sample web projects for Code Studio" : "Code Studio projects"),
            folder("icon:image", "Pictures", "Images for Image Viewer"),
            folder("icon:download", "Downloads", "Files saved by the Browser"),
            folder("icon:trash", "Recycle Bin", "Deleted items, until you restore or empty them"),
          ],
        }),
        createElement("p", {
          className: "welcome__note",
          text: "Your data lives only in this browser. Make a backup file from Settings › System to keep a copy or move it to another browser.",
        }),
        createElement("div", {
          className: "welcome__try",
          children: [
            button("Open File Explorer", () => this._launch("file-explorer", { path: "/Documents" }), "default", "welcome__try-explorer"),
          ],
        }),
      ],
    });
  }

  /** @returns {HTMLElement} */
  _buildApps() {
    return createElement("section", {
      className: "welcome__step",
      children: [
        title("Applications"),
        createElement("p", { className: "welcome__lead", text: "Every application that comes with BrowserOS. Select one to open it; this tour stays open." }),
        createElement("ul", {
          className: "welcome__apps",
          children: this._listApps().map((app) =>
            createElement("li", {
              children: [
                createElement("button", {
                  className: "welcome__app",
                  attrs: { type: "button", "data-app-id": app.id },
                  children: [
                    createIconElement(app.icon, { className: "welcome__app-icon" }),
                    createElement("span", {
                      className: "welcome__app-text",
                      children: [
                        createElement("span", { className: "welcome__app-name", text: app.name }),
                        createElement("span", { className: "welcome__app-description", text: app.description }),
                      ],
                    }),
                  ],
                  on: { click: () => this._launch(app.id) },
                }),
              ],
            })
          ),
        }),
      ],
    });
  }

  /** @returns {HTMLElement} */
  _buildDone() {
    const theme = THEME_OPTIONS.find((option) => option.value === settingsService.get("appearance.theme"))?.label ?? "";
    const accent = ACCENT_PRESETS.find((preset) => preset.id === settingsService.get("appearance.accentColor"))?.label ?? "";
    const wallpaper = WALLPAPER_PRESETS.find((preset) => preset.id === settingsService.get("wallpaper.preset"))?.label ?? "";
    let samples = "Not added (Settings › System can add them later)";
    if (this._sampleState === "installing") samples = "Being added…";
    if (this._sampleState === "installed") samples = "Added to Documents, Projects, Pictures, and Downloads";
    if (this._sampleState === "failed") samples = this._sampleMessage;

    const guideButton = button("Read the guide", () => this._openGuide(), "default", "welcome__guide");
    guideButton.hidden = this._sampleState !== "installed";

    return createElement("section", {
      className: "welcome__step welcome__step--hero",
      children: [
        createIconElement("icon:browseros", { className: "welcome__mark brand-mark" }),
        title("You're all set"),
        createElement("dl", {
          className: "welcome__summary",
          children: [
            ...summaryRow("Theme", theme),
            ...summaryRow("Accent color", accent),
            ...summaryRow("Wallpaper", wallpaper),
            ...summaryRow("Sample files", samples),
          ],
        }),
        createElement("p", {
          className: "welcome__note",
          text: "Open this tour again at any time: Start menu › Welcome, or Settings › System.",
        }),
        createElement("div", { className: "welcome__try", children: [guideButton] }),
      ],
    });
  }

  // ---------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------

  /** @returns {Array<{id: string, name: string, icon: string|null, description: string}>} */
  _listApps() {
    if (!this.appManager) return [];
    return this.appManager
      .getRegisteredApps()
      .filter((app) => !app.dynamic)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * @param {string} shortcutId
   * @returns {string[]} The shortcut's first key combination, as display parts; empty when it is turned off.
   */
  _keys(shortcutId) {
    for (const group of keyboardShortcuts.getGroupedShortcuts()) {
      const shortcut = group.shortcuts.find((entry) => entry.id === shortcutId);
      if (shortcut) return shortcut.enabled && shortcut.keys.length ? shortcut.keys[0].split(" + ") : [];
    }
    return [];
  }

  /**
   * @param {string} appId
   * @param {object} [options]
   * @returns {void}
   */
  _launch(appId, options) {
    this.appManager?.launch(appId, options).catch((error) => console.error(`[Welcome] couldn't open "${appId}":`, error));
  }

  /** @returns {Promise<void>} */
  async _openGuide() {
    try {
      if (!(await vfs.exists(GUIDE_PATH))) return;
      await openVfsEntry(await vfs.getInfo(GUIDE_PATH), { appManager: this.appManager, recentFilesService: this.recentFilesService });
    } catch (error) {
      console.error("[Welcome] couldn't open the guide:", error);
    }
  }
}

/**
 * @param {string} text
 * @returns {HTMLElement}
 */
function title(text) {
  return createElement("h1", { className: "welcome__title", attrs: { tabindex: "-1" }, text });
}

/**
 * @param {string} label
 * @param {() => void} onClick
 * @param {"default"|"primary"|"quiet"} variant
 * @param {string} className
 * @returns {HTMLButtonElement}
 */
function button(label, onClick, variant, className) {
  return createElement("button", {
    className: `os-button${variant === "default" ? "" : ` os-button--${variant}`} ${className}`,
    attrs: { type: "button" },
    text: label,
    on: { click: onClick },
  });
}

/**
 * @param {string} icon
 * @param {string} heading
 * @param {string} text
 * @returns {HTMLElement}
 */
function fact(icon, heading, text) {
  return createElement("li", {
    className: "welcome__fact",
    children: [
      createIconElement(icon, { className: "welcome__fact-icon" }),
      createElement("span", { className: "welcome__fact-title", text: heading }),
      createElement("span", { className: "welcome__fact-text", text }),
    ],
  });
}

/**
 * @param {string} icon
 * @param {string} heading
 * @param {string} text
 * @param {string[]} keys - Shown as key caps after the text.
 * @returns {HTMLElement}
 */
function tip(icon, heading, text, keys) {
  const body = createElement("span", { className: "welcome__tip-text", children: [document.createTextNode(text)] });
  if (keys.length) body.append(document.createTextNode(" "), ...keyCaps(keys), document.createTextNode("."));
  return createElement("li", {
    className: "welcome__tip",
    children: [
      createIconElement(icon, { className: "welcome__tip-icon" }),
      createElement("span", {
        className: "welcome__tip-body",
        children: [createElement("span", { className: "welcome__tip-title", text: heading }), body],
      }),
    ],
  });
}

/**
 * @param {string[]} keys
 * @returns {Node[]} Key caps joined by "+".
 */
function keyCaps(keys) {
  const nodes = [];
  keys.forEach((key, index) => {
    if (index > 0) nodes.push(document.createTextNode(" + "));
    nodes.push(createElement("kbd", { className: "os-kbd", text: key }));
  });
  return nodes;
}

/**
 * @param {string} icon
 * @param {string} name
 * @param {string} text
 * @returns {HTMLElement}
 */
function folder(icon, name, text) {
  return createElement("li", {
    className: "welcome__folder",
    children: [
      createIconElement(icon, { className: "welcome__folder-icon" }),
      createElement("span", { className: "welcome__folder-name", text: name }),
      createElement("span", { className: "welcome__folder-text", text }),
    ],
  });
}

/**
 * @param {string} label
 * @param {string} value
 * @returns {HTMLElement[]}
 */
function summaryRow(label, value) {
  return [createElement("dt", { text: label }), createElement("dd", { text: value })];
}

/**
 * A labelled group of radio options rendered as cards.
 * @param {{label: string, name: string, value: string, className: string,
 *   options: Array<{value: string, content: Node[]}>, onChange: (value: string) => void}} config
 * @returns {HTMLElement}
 */
function choiceGroup({ label, name, value, className, options, onChange }) {
  const labelId = `welcome-${name}-label`;
  const groupName = `welcome-${name}`;
  return createElement("div", {
    className: "welcome__group",
    children: [
      createElement("h2", { className: "welcome__group-label", attrs: { id: labelId }, text: label }),
      createElement("div", {
        className: `welcome__choices ${className}`,
        attrs: { role: "radiogroup", "aria-labelledby": labelId },
        children: options.map((option) => {
          const input = createElement("input", {
            className: "welcome__radio",
            attrs: { type: "radio", name: groupName, value: option.value },
            on: { change: (e) => e.target.checked && onChange(option.value) },
          });
          input.checked = option.value === value;
          return createElement("label", {
            className: "welcome__choice",
            children: [input, ...option.content],
          });
        }),
      }),
    ],
  });
}
