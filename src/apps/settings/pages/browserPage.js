/**
 * @file Browser settings page: search engine, homepage, bookmarks bar,
 * start page, history retention, downloads, and the sites the user chose
 * to open in the host browser (or to show inside BrowserOS anyway).
 * Options are browser.* and downloads.* settings applied live by every
 * Browser window, the history service, and the download service.
 */

import { createElement, clearElement } from "../../../utils/dom.js";
import { eventBus } from "../../../core/eventBus.js";
import { settingsService } from "../../../core/settings/settingsService.js";
import { SEARCH_ENGINES } from "../../../core/browser/searchEngines.js";
import { framePolicy } from "../../../core/browser/framePolicy.js";
import { isWebUrl } from "../../../core/browser/urlUtils.js";
import { historyService } from "../../../core/browser/historyService.js";
import { showClearBrowsingDataDialog } from "../../../components/dialog/clearBrowsingDataDialog.js";
import { createButton } from "../settingsControls.js";
import { SettingsPage } from "./settingsPage.js";

export default class BrowserPage extends SettingsPage {
  /** @param {object} [context] */
  constructor(context) {
    super(
      {
        category: "browser",
        title: "Browser",
        intro: "Search, homepage, history, and downloads for the Browser.",
        resetLabel: "Browser settings",
        watchCategories: ["browser", "downloads"],
      },
      context
    );
  }

  /** @returns {HTMLElement[]} */
  buildSections() {
    return [
      this.section({
        anchor: "search",
        title: "Search and homepage",
        description: "What the address bar searches with, and where Home goes.",
        children: [
          this.selectRow(
            "browser.searchEngine",
            "Search engine",
            "Used when you type words instead of an address.",
            SEARCH_ENGINES.map((engine) => ({ value: engine.id, label: engine.name }))
          ).element,
          this._homepageControl(),
        ],
      }),
      this.section({
        anchor: "appearance",
        title: "Bookmarks bar and start page",
        children: [
          this.toggleRow("browser.showBookmarksBar", "Show bookmarks bar", "Bookmarks in the \u201cBookmarks bar\u201d folder appear under the toolbar.").element,
          this.toggleRow("browser.startPageClock", "Show clock on the start page", "The time and date above the search box.").element,
          this.segmentedRow("browser.startPageBackground", "Start page background", "", [
            { value: "accent", label: "Accent" },
            { value: "wallpaper", label: "Wallpaper" },
            { value: "plain", label: "Plain" },
          ]).element,
        ],
      }),
      this.section({
        anchor: "history",
        title: "History",
        description: "Private windows never add to history.",
        children: [
          this.selectRow("browser.historyDays", "Keep history for", "Older visits are removed automatically.", [
            { value: "7", label: "7 days" },
            { value: "30", label: "30 days" },
            { value: "90", label: "90 days" },
            { value: "365", label: "1 year" },
          ]).element,
          this._historySummary(),
        ],
      }),
      this.section({
        anchor: "downloads",
        title: "Downloads",
        description: "Downloads are saved to /Downloads in the BrowserOS file system.",
        children: [
          this.selectRow("downloads.maxSizeMb", "Largest download", "Bigger files are refused before they're saved.", [
            { value: "25", label: "25 MB" },
            { value: "100", label: "100 MB" },
            { value: "250", label: "250 MB" },
            { value: "500", label: "500 MB" },
          ]).element,
          this.toggleRow("downloads.notifyOnComplete", "Notify when a download finishes", "Failed downloads are always reported.").element,
          createElement("div", {
            className: "settings-section__actions",
            children: [
              createButton({
                label: "Open Download Manager",
                onClick: () => this.context?.appManager?.launch("downloads").catch(() => {}),
              }),
            ],
          }),
        ],
      }),
      this.section({
        anchor: "sites",
        title: "Sites",
        description: "Sites you chose to always open in your web browser, or to show inside BrowserOS even though they usually refuse.",
        children: [this._sitesList()],
      }),
    ];
  }

  /** @returns {HTMLElement} */
  _homepageControl() {
    const input = createElement("input", {
      className: "settings-text-input",
      attrs: { type: "url", placeholder: "Start page", "aria-label": "Homepage address", autocomplete: "off", spellcheck: "false" },
    });
    const status = createElement("p", { className: "settings-section__status", attrs: { role: "status" } });
    const save = () => {
      let value = input.value.trim();
      if (value && !/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `https://${value}`;
      if (value && !isWebUrl(value)) {
        status.textContent = "Enter a web address such as https://example.com, or leave it empty for the start page.";
        return;
      }
      if (value) value = new URL(value).href;
      if (settingsService.set("browser.homepage", value)) {
        status.textContent = value ? `Home opens ${value}.` : "Home opens the start page.";
      } else {
        status.textContent = "Enter a web address that starts with http:// or https://.";
      }
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        save();
      }
    });
    this.addSyncer((values) => {
      if (document.activeElement !== input) input.value = values["browser.homepage"];
    });
    return createElement("div", {
      className: "settings-row settings-row--stacked",
      attrs: { "data-settings-key": "browser.homepage" },
      children: [
        createElement("div", {
          className: "settings-row__text",
          children: [
            createElement("span", { className: "settings-row__label", text: "Homepage" }),
            createElement("span", { className: "settings-row__description", text: "Opened by the Home button. Leave empty to use the start page." }),
          ],
        }),
        createElement("div", {
          className: "settings-inline-form",
          children: [
            input,
            createButton({ label: "Save", onClick: save }),
            createButton({
              label: "Use start page",
              onClick: () => {
                settingsService.reset("browser.homepage");
                input.value = "";
                status.textContent = "Home opens the start page.";
              },
            }),
          ],
        }),
        status,
      ],
    });
  }

  /** @returns {HTMLElement} */
  _historySummary() {
    const text = createElement("p", { className: "settings-section__status" });
    const render = () => {
      if (this.isDestroyed()) return;
      const count = historyService.size();
      text.textContent = count === 0 ? "History is empty." : `${count} page${count === 1 ? "" : "s"} in history.`;
    };
    this.addCleanup(eventBus.on("browser:historyChanged", render));
    render();
    return createElement("div", {
      className: "settings-section__actions",
      children: [createButton({ label: "Clear browsing data\u2026", variant: "danger", onClick: () => showClearBrowsingDataDialog() }), text],
    });
  }

  /** @returns {HTMLElement} */
  _sitesList() {
    const list = createElement("ul", { className: "settings-category-list" });
    const render = () => {
      if (this.isDestroyed()) return;
      clearElement(list);
      const sites = framePolicy.listSiteChoices();
      if (sites.length === 0) {
        list.append(createElement("li", { className: "settings-category-list__item", children: [createElement("span", { className: "settings-category-list__count", text: "No site choices yet." })] }));
        return;
      }
      for (const site of sites) {
        list.append(
          createElement("li", {
            className: "settings-category-list__item",
            children: [
              createElement("span", { className: "settings-category-list__name", text: site.host }),
              createElement("span", { className: "settings-category-list__count", text: site.choice === "external" ? "Opens in your browser" : "Shown in BrowserOS" }),
              createButton({ label: "Remove", ariaLabel: `Forget the choice for ${site.host}`, onClick: () => framePolicy.setSiteChoice(`https://${site.host}/`, null) }),
            ],
          })
        );
      }
    };
    this.addCleanup(eventBus.on("browser:sitePoliciesChanged", render));
    render();
    return list;
  }
}
