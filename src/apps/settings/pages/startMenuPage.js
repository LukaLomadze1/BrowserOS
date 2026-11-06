/**
 * @file Start Menu settings page: sections, recent items, pinned
 * applications, and search.
 *
 * Pinned applications are edited through the `startMenu.pinnedApps`
 * setting (an ordered array of app ids), which is the Start Menu's only
 * pinned-apps storage. Clearing recent activity goes to the services
 * that own that data: RecentFilesService (handed to the page by the
 * Settings app) for files, and a "startmenu:clearRecentApps" request
 * for applications, which StartMenuManager owns.
 */

import { createElement, clearElement } from "../../../utils/dom.js";
import { createIconElement } from "../../../utils/icons.js";
import { eventBus } from "../../../core/eventBus.js";
import { settingsService } from "../../../core/settings/settingsService.js";
import { showConfirmDialog } from "../../../components/dialog/confirmDialog.js";
import { createButton } from "../settingsControls.js";
import { SettingsPage } from "./settingsPage.js";

const PINNED_KEY = "startMenu.pinnedApps";

export default class StartMenuPage extends SettingsPage {
  /**
   * @param {{appManager?: import("../../../core/appManager.js").AppManager, recentFilesService?: import("../../../core/recentFilesService.js").RecentFilesService}} [context]
   */
  constructor(context) {
    super(
      {
        category: "startMenu",
        title: "Start Menu",
        intro: "Choose what the Start Menu shows and what its search box finds.",
        resetLabel: "Start Menu settings",
      },
      context
    );
  }

  /** @returns {HTMLElement[]} */
  buildSections() {
    return [
      this.section({
        anchor: "sections",
        title: "Sections",
        description: "Parts of the Start Menu shown when the search box is empty.",
        children: [
          this.toggleRow("startMenu.showPinned", "Show pinned applications", "The grid of pinned apps at the top.").element,
          this.toggleRow("startMenu.showRecentApps", "Show recent applications", "Apps you opened recently.").element,
          this.toggleRow("startMenu.showRecentFiles", "Show recent files", "Files you opened recently.").element,
        ],
      }),
      this._buildRecentSection(),
      this._buildPinnedSection(),
      this.section({
        anchor: "search",
        title: "Search",
        description: "What Start Menu search looks through, and how results are ordered.",
        children: [
          this.toggleRow("startMenu.searchApps", "Search applications", "Match installed app names.").element,
          this.toggleRow("startMenu.searchFiles", "Search files", "Match file names anywhere outside Trash.").element,
          this.toggleRow("startMenu.searchFolders", "Search folders", "Match folder names anywhere outside Trash.").element,
          this.toggleRow("startMenu.searchSettings", "Search settings", "Match Settings pages and options.").element,
          this.toggleRow(
            "startMenu.prioritizeApps",
            "Show applications first",
            "List app matches before settings, folders, and files. When off, the closest matches come first."
          ).element,
          this.toggleRow(
            "startMenu.caseInsensitiveSearch",
            "Ignore letter case",
            "When off, \u201cnotes\u201d no longer matches \u201cNotes\u201d."
          ).element,
          this.sliderRow("startMenu.searchResultLimit", "Maximum results", "How many results the list shows at most.", {
            unit: "",
            unitLabel: "results",
          }).element,
        ],
      }),
    ];
  }

  // ---------------------------------------------------------------
  // Recent items
  // ---------------------------------------------------------------

  /** @returns {HTMLElement} */
  _buildRecentSection() {
    const statusEl = createElement("p", { className: "settings-section__status", attrs: { role: "status" } });
    const report = (message) => {
      statusEl.textContent = message;
    };
    const recentFiles = this.context.recentFilesService ?? null;

    const clearApps = () => {
      eventBus.emit("startmenu:clearRecentApps", {});
      report("Recent applications cleared.");
    };
    const clearFiles = () => {
      if (!recentFiles) return;
      recentFiles.clear();
      report("Recent files cleared.");
    };
    const clearAll = async () => {
      const confirmed = await showConfirmDialog({
        title: "Clear all recent activity?",
        message: "Recent applications and recent files will be forgotten. No apps or files are removed.",
        confirmLabel: "Clear",
        destructive: true,
      });
      if (!confirmed || this.isDestroyed()) return;
      eventBus.emit("startmenu:clearRecentApps", {});
      recentFiles?.clear();
      report("All recent activity cleared.");
    };

    const actions = [
      createButton({ label: "Clear recent applications", onClick: clearApps }),
      createButton({ label: "Clear recent files", onClick: clearFiles }),
      createButton({ label: "Clear all recent activity", onClick: clearAll, variant: "danger" }),
    ];
    if (!recentFiles) actions[1].disabled = true;

    return this.section({
      anchor: "recent",
      title: "Recent items",
      description: "History is kept separately from these limits, so raising a limit shows older entries again.",
      children: [
        this.sliderRow("startMenu.recentAppsLimit", "Recent applications shown", "Maximum number of recent apps listed.", {
          unit: "",
          unitLabel: "applications",
        }).element,
        this.sliderRow("startMenu.recentFilesLimit", "Recent files shown", "Maximum number of recent files listed.", {
          unit: "",
          unitLabel: "files",
        }).element,
        createElement("div", { className: "settings-section__actions", children: actions }),
        statusEl,
      ],
    });
  }

  // ---------------------------------------------------------------
  // Pinned applications
  // ---------------------------------------------------------------

  /** @returns {HTMLElement} */
  _buildPinnedSection() {
    const pinnedListEl = createElement("ol", { className: "settings-app-list", attrs: { "aria-label": "Pinned applications" } });
    const availableListEl = createElement("ul", { className: "settings-app-list", attrs: { "aria-label": "Other applications" } });

    this.addSyncer((values) => this._renderPinnedLists(values[PINNED_KEY], pinnedListEl, availableListEl));

    return this.section({
      anchor: "pinned",
      title: "Pinned applications",
      description: "Pin, unpin, and reorder the apps at the top of the Start Menu.",
      headerAction: this.resetButton(PINNED_KEY, "pinned applications"),
      children: [
        createElement("h3", { className: "settings-subheading", text: "Pinned" }),
        pinnedListEl,
        createElement("h3", { className: "settings-subheading", text: "Not pinned" }),
        availableListEl,
      ],
    });
  }

  /**
   * @returns {Array<{id: string, name: string, icon: string|null}>} User-facing apps (no per-path windows).
   */
  _installedApps() {
    const appManager = this.context.appManager;
    if (!appManager) return [];
    return appManager.getRegisteredApps().filter((app) => !appManager.isDynamic(app.id));
  }

  /**
   * Re-render both lists, restoring keyboard focus to the same action
   * on the same app when it still exists (e.g. after "Move up").
   * @param {ReadonlyArray<string>} pinnedIds
   * @param {HTMLElement} pinnedListEl
   * @param {HTMLElement} availableListEl
   * @returns {void}
   */
  _renderPinnedLists(pinnedIds, pinnedListEl, availableListEl) {
    const active = document.activeElement;
    const focusKey = active?.dataset?.pinAction ? `${active.dataset.pinAction}:${active.dataset.appId}` : null;
    const listHadFocus = pinnedListEl.contains(active) || availableListEl.contains(active);

    const apps = this._installedApps();
    const byId = new Map(apps.map((app) => [app.id, app]));
    const pinned = pinnedIds.map((id) => byId.get(id)).filter(Boolean);
    const unpinned = apps.filter((app) => !pinnedIds.includes(app.id));

    clearElement(pinnedListEl);
    clearElement(availableListEl);

    if (pinned.length === 0) {
      pinnedListEl.append(createElement("li", { className: "settings-app-list__empty", text: "No pinned applications." }));
    }
    pinned.forEach((app, index) => {
      pinnedListEl.append(
        this._appRow(app, [
          { action: "up", label: "Move up", glyph: "\u2191", disabled: index === 0, run: () => this._movePinned(app.id, -1) },
          { action: "down", label: "Move down", glyph: "\u2193", disabled: index === pinned.length - 1, run: () => this._movePinned(app.id, 1) },
          { action: "unpin", label: "Unpin", run: () => this._setPinned(pinnedIds.filter((id) => id !== app.id)) },
        ])
      );
    });

    if (unpinned.length === 0) {
      availableListEl.append(createElement("li", { className: "settings-app-list__empty", text: "Every application is pinned." }));
    }
    for (const app of unpinned) {
      availableListEl.append(this._appRow(app, [{ action: "pin", label: "Pin", run: () => this._setPinned([...pinnedIds, app.id]) }]));
    }

    if (!listHadFocus) return;
    const restore =
      (focusKey && [...pinnedListEl.querySelectorAll("button"), ...availableListEl.querySelectorAll("button")].find(
        (button) => `${button.dataset.pinAction}:${button.dataset.appId}` === focusKey && !button.disabled
      )) ||
      pinnedListEl.querySelector("button:not([disabled])") ||
      availableListEl.querySelector("button:not([disabled])");
    restore?.focus();
  }

  /**
   * @param {{id: string, name: string, icon: string|null}} app
   * @param {Array<{action: string, label: string, glyph?: string, disabled?: boolean, run: () => void}>} actions
   * @returns {HTMLElement}
   */
  _appRow(app, actions) {
    return createElement("li", {
      className: "settings-app-list__item",
      children: [
        createIconElement(app.icon, { className: "settings-app-list__icon" }),
        createElement("span", { className: "settings-app-list__name", text: app.name }),
        createElement("span", {
          className: "settings-app-list__actions",
          children: actions.map((action) => {
            const button = createElement("button", {
              className: `settings-reset-button settings-app-list__action${action.glyph ? " settings-app-list__action--icon" : ""}`,
              attrs: {
                type: "button",
                "aria-label": `${action.label} ${app.name}`,
                title: action.label,
                "data-pin-action": action.action,
                "data-app-id": app.id,
              },
              text: action.glyph ?? action.label,
              on: { click: () => action.run() },
            });
            if (action.disabled) button.disabled = true;
            return button;
          }),
        }),
      ],
    });
  }

  /**
   * @param {string[]} ids
   * @returns {void}
   */
  _setPinned(ids) {
    settingsService.set(PINNED_KEY, ids);
  }

  /**
   * @param {string} appId
   * @param {-1|1} delta
   * @returns {void}
   */
  _movePinned(appId, delta) {
    const ids = [...settingsService.get(PINNED_KEY)];
    const index = ids.indexOf(appId);
    const target = index + delta;
    if (index === -1 || target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    this._setPinned(ids);
  }
}
