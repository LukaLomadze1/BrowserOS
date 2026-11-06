/**
 * @file File Explorer settings page: view, display, sorting, startup
 * location, and navigation. Every option is a fileExplorer.* setting
 * that every open Explorer window applies live.
 *
 * The custom startup folder is chosen with the folder picker and
 * checked against the VFS whenever it is shown, so a folder that has
 * since been deleted is reported here (Explorer itself falls back to
 * Home in that case).
 */

import { createElement } from "../../../utils/dom.js";
import { settingsService } from "../../../core/settings/settingsService.js";
import { vfs } from "../../../core/vfs/virtualFileSystem.js";
import { showFolderPickerDialog } from "../../../components/dialog/folderPickerDialog.js";
import { createButton, createRowIds, createSettingRow } from "../settingsControls.js";
import { SettingsPage } from "./settingsPage.js";

const CONFIRM_OPTIONS = Object.freeze([
  { value: "always", label: "Always" },
  { value: "smart", label: "For several items or non-empty folders" },
  { value: "never", label: "Never" },
]);

export default class FileExplorerPage extends SettingsPage {
  /** @param {object} [context] */
  constructor(context) {
    super(
      {
        category: "fileExplorer",
        title: "File Explorer",
        intro: "Choose how Explorer windows display, sort, and open folders. Open windows update immediately.",
        resetLabel: "File Explorer settings",
      },
      context
    );
  }

  /** @returns {HTMLElement[]} */
  buildSections() {
    return [
      this.section({
        anchor: "view",
        title: "View",
        children: [
          this.segmentedRow(
            "fileExplorer.defaultView",
            "Layout",
            "Used by every Explorer window. The view buttons in an Explorer toolbar change this too.",
            [
              { value: "grid", label: "Grid" },
              { value: "list", label: "List" },
              { value: "details", label: "Details" },
            ]
          ).element,
        ],
      }),
      this.section({
        anchor: "display",
        title: "File display",
        description: "Display only \u2014 file names and contents are never changed.",
        children: [
          this.toggleRow("fileExplorer.showExtensions", "Show file extensions", "Show \u201cnotes.txt\u201d rather than \u201cnotes\u201d. Renaming always shows the full name.").element,
          this.toggleRow("fileExplorer.showHiddenFiles", "Show hidden files", "List files and folders marked as hidden.").element,
          this.toggleRow("fileExplorer.showSize", "Show sizes", "Size column in Details view and size in List view.").element,
          this.toggleRow("fileExplorer.showModified", "Show modification dates", "Date column in Details view and date in List view.").element,
          this.toggleRow("fileExplorer.showType", "Show file types", "Type column in Details view and type in List view.").element,
        ],
      }),
      this.section({
        anchor: "sorting",
        title: "Sorting",
        description: "Clicking a column header in Details view changes these settings for every window.",
        children: [
          this.selectRow("fileExplorer.sortField", "Sort by", "Field used to order items.", [
            { value: "name", label: "Name" },
            { value: "modified", label: "Date modified" },
            { value: "created", label: "Date created" },
            { value: "size", label: "Size" },
            { value: "type", label: "Type" },
          ]).element,
          this.segmentedRow("fileExplorer.sortDirection", "Order", "Ascending or descending.", [
            { value: "asc", label: "Ascending" },
            { value: "desc", label: "Descending" },
          ]).element,
          this.toggleRow("fileExplorer.foldersFirst", "Folders first", "Keep folders above files regardless of the sort field.").element,
        ],
      }),
      this._buildStartupSection(),
      this.section({
        anchor: "navigation",
        title: "Navigation",
        children: [
          this.segmentedRow(
            "fileExplorer.openFoldersIn",
            "Open folders in",
            "Applies when opening a folder from the file list. Sidebar, address bar, and Back / Up always stay in the same window.",
            [
              { value: "sameWindow", label: "Same window" },
              { value: "newWindow", label: "New window" },
            ]
          ).element,
          this.selectRow(
            "fileExplorer.confirmTrash",
            "Confirm before moving to Trash",
            "Deleting always moves items to the Trash folder. BrowserOS has no permanent deletion, so there is nothing further to confirm.",
            CONFIRM_OPTIONS
          ).element,
        ],
      }),
    ];
  }

  /** @returns {HTMLElement} */
  _buildStartupSection() {
    const locationRow = this.selectRow(
      "fileExplorer.startupLocation",
      "Open new windows at",
      "Used when Explorer is opened without a specific folder, such as from the Start Menu.",
      [
        { value: "home", label: "Home" },
        { value: "desktop", label: "Desktop" },
        { value: "documents", label: "Documents" },
        { value: "downloads", label: "Downloads" },
        { value: "custom", label: "Custom folder\u2026" },
      ]
    );

    const ids = createRowIds("fileExplorer-customStartupPath");
    const pathValueEl = createElement("code", { className: "settings-path" });
    const statusEl = createElement("span", { className: "settings-path-status", attrs: { "aria-live": "polite" } });
    const chooseButton = createButton({
      label: "Choose folder\u2026",
      ariaLabel: "Choose custom startup folder",
      onClick: async () => {
        const chosen = await showFolderPickerDialog({
          vfs,
          title: "Choose the startup folder",
          initialPath: settingsService.get("fileExplorer.customStartupPath"),
        });
        if (chosen === null || this.isDestroyed()) return;
        settingsService.setMany({ "fileExplorer.customStartupPath": chosen, "fileExplorer.startupLocation": "custom" });
      },
    });
    const customRow = createSettingRow({
      ids,
      label: "Custom folder",
      description: "If this folder no longer exists, Explorer opens Home instead.",
      control: createElement("div", { className: "settings-path-control", children: [pathValueEl, chooseButton] }),
      reset: this.resetButton("fileExplorer.customStartupPath", "custom folder"),
      layout: "stacked",
    });
    customRow.element.append(statusEl);

    let validationToken = 0;
    this.addSyncer(async (values) => {
      const path = values["fileExplorer.customStartupPath"];
      const isCustom = values["fileExplorer.startupLocation"] === "custom";
      pathValueEl.textContent = path;
      customRow.setMuted(!isCustom);

      const token = ++validationToken;
      let exists = false;
      try {
        const info = await vfs.getInfo(path);
        exists = info.type === "folder" && !info.path.startsWith("/Trash");
      } catch {
        exists = false;
      }
      if (token !== validationToken || this.isDestroyed()) return;
      statusEl.textContent = exists ? "\u2713 Folder found" : "Folder not found \u2014 Explorer will open Home";
      statusEl.classList.toggle("settings-path-status--error", !exists);
    });

    return this.section({
      anchor: "startup",
      title: "Startup location",
      children: [
        locationRow.element,
        customRow.element,
        this.toggleRow(
          "fileExplorer.restoreLastLocation",
          "Reopen last location",
          "Start where the most recently used Explorer window last was, when that folder still exists."
        ).element,
      ],
    });
  }
}
