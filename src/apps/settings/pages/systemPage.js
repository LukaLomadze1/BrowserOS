/**
 * @file System settings page: the welcome tour and sample files, backup
 * and restore, resetting preferences per category or all at once, and a
 * summary of the stored settings.
 *
 * Sample files go through SampleContent (src/core/demo/), which never
 * replaces an existing file and, when removing, moves only files that
 * are still unchanged to Trash. Both actions ask first.
 *
 * Backups go through BackupService (src/core/backup/), which validates
 * a backup completely before anything changes. Restoring a full backup
 * replaces everything only after an explicit confirmation that also
 * offers to save the current data first; a folder backup is added
 * without replacing anything.
 *
 * Resets go through SettingsService only (resetCategory / resetAll),
 * so every affected subsystem updates through its normal subscription.
 * No files, desktop layout, recent history, or other application data
 * is touched.
 */

import { createElement, clearElement } from "../../../utils/dom.js";
import { formatBytes, formatDate } from "../../../utils/format.js";
import { settingsService } from "../../../core/settings/settingsService.js";
import { SETTINGS_VERSION } from "../../../core/settings/settingsSchema.js";
import { vfs } from "../../../core/vfs/virtualFileSystem.js";
import { getParentPath } from "../../../core/vfs/pathResolver.js";
import { serviceManager } from "../../../core/services/serviceManager.js";
import { backupService } from "../../../core/backup/backupService.js";
import { BACKUP_FORMAT_VERSION } from "../../../core/backup/backupFormat.js";
import { sampleContent } from "../../../core/demo/sampleContent.js";
import { openDialog } from "../../../components/dialog/dialog.js";
import { showConfirmDialog } from "../../../components/dialog/confirmDialog.js";
import { showMessageDialog } from "../../../components/dialog/messageDialog.js";
import { showFolderPickerDialog } from "../../../components/dialog/folderPickerDialog.js";
import { showSystemScreen } from "../../../components/system-screen/systemScreen.js";
import { createButton, createSection } from "../settingsControls.js";

/** Display names for settings categories. */
const CATEGORY_LABELS = Object.freeze({
  appearance: "Appearance",
  wallpaper: "Wallpaper",
  desktop: "Desktop",
  startMenu: "Start Menu",
  fileExplorer: "File Explorer",
  keyboard: "Keyboard Shortcuts",
  notifications: "Notifications",
  taskbar: "Taskbar",
  taskManager: "Task Manager",
  browser: "Browser",
  downloads: "Downloads",
  codeStudio: "Code Studio",
});

/** Time given to closing applications to finish saving before a full restore. */
const SETTLE_MS = 300;

export default class SystemPage {
  /**
   * @param {import("../settingsCategories.js").SettingsPageContext} [context]
   */
  constructor(context = {}) {
    this._appManager = context.appManager ?? null;
    this._destroyed = false;
    this._busy = false;
    this._cleanups = [];
    this._statusEl = createElement("p", { className: "settings-section__status", attrs: { role: "status" } });
    this._backupStatusEl = createElement("p", { className: "settings-section__status", attrs: { role: "status", "aria-live": "polite" } });
    this._categoryListEl = createElement("ul", { className: "settings-category-list" });
    this._summaryEl = createElement("dl", { className: "settings-summary" });
    this._fileInput = createElement("input", {
      className: "settings-file-input",
      attrs: { type: "file", accept: ".json,application/json", hidden: "", "aria-hidden": "true", tabindex: "-1" },
      on: { change: () => this._onFileChosen() },
    });
    this._samplesStatusEl = createElement("p", { className: "settings-section__status", attrs: { role: "status", "aria-live": "polite" } });
    this._addSamplesButton = createButton({ label: "Add sample files", onClick: () => this._addSamples() });
    this._removeSamplesButton = createButton({ label: "Remove sample files", onClick: () => this._removeSamples() });
    this._samplesBusy = false;
    this._backupButtons = [
      createButton({ label: "Back up everything", onClick: () => this._backUpEverything() }),
      createButton({ label: "Back up a folder…", onClick: () => this._backUpFolder() }),
      createButton({ label: "Restore from a backup…", onClick: () => this._fileInput.click() }),
    ];

    this._element = createElement("div", {
      className: "settings-page",
      children: [
        createElement("header", {
          className: "settings-page__header",
          children: [
            createElement("h1", { className: "settings-page__title", attrs: { tabindex: "-1" }, text: "System" }),
            createElement("p", {
              className: "settings-page__intro",
              text: "Get started, back up and restore your BrowserOS data, or return preferences to their defaults.",
            }),
          ],
        }),
        createSection({
          anchor: "getting-started",
          title: "Getting started",
          description:
            "The welcome tour shows the basics and lets you pick a theme, accent, and wallpaper. Sample files are a guide, notes, two web projects for Code Studio, pictures, and a download; existing files are never replaced.",
          children: [
            createElement("div", {
              className: "settings-section__actions",
              children: [
                createButton({ label: "Open the welcome tour", onClick: () => this._openTour() }),
                this._addSamplesButton,
                this._removeSamplesButton,
              ],
            }),
            this._samplesStatusEl,
          ],
        }),
        createSection({
          anchor: "backup",
          title: "Backup and restore",
          description:
            "BrowserOS keeps everything in this browser. A backup saves it to a file on your computer: everything (files, settings, and application data such as bookmarks and history), or a single folder.",
          children: [
            createElement("div", { className: "settings-section__actions", children: [...this._backupButtons, this._fileInput] }),
            this._backupStatusEl,
          ],
        }),
        createSection({
          anchor: "reset",
          title: "Reset preferences",
          description: "Reset one area, or everything at once. Resetting never deletes files, desktop icon positions, or recent history.",
          children: [
            this._categoryListEl,
            createElement("div", {
              className: "settings-section__actions",
              children: [createButton({ label: "Reset all preferences", variant: "danger", onClick: () => this._confirmResetAll() })],
            }),
            this._statusEl,
          ],
        }),
        createSection({
          anchor: "about",
          title: "Stored settings",
          description: "Settings are saved in this browser and restored every time BrowserOS starts.",
          children: [this._summaryEl],
        }),
      ],
    });

    this._render();
    this._renderSamples();
    this._cleanups.push(settingsService.subscribeAll(() => this._render()));
  }

  /** @returns {HTMLElement} */
  getElement() {
    return this._element;
  }

  /** @returns {void} */
  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    for (const cleanup of this._cleanups) cleanup();
    this._cleanups = [];
  }

  /** @returns {void} */
  _render() {
    if (this._destroyed) return;
    const active = document.activeElement;
    const focusedCategory = active?.dataset?.resetCategory ?? null;

    clearElement(this._categoryListEl);
    for (const category of settingsService.getCategoryIds()) {
      const label = CATEGORY_LABELS[category] ?? category;
      const customized = settingsService.getCustomizedKeys(category).length;
      const button = createButton({
        label: "Reset",
        ariaLabel: `Reset ${label} settings`,
        onClick: () => this._confirmResetCategory(category, label),
      });
      button.dataset.resetCategory = category;
      this._categoryListEl.append(
        createElement("li", {
          className: "settings-category-list__item",
          children: [
            createElement("span", { className: "settings-category-list__name", text: label }),
            createElement("span", {
              className: "settings-category-list__count",
              text: customized === 0 ? "Defaults" : `${customized} customized`,
            }),
            button,
          ],
        })
      );
      if (focusedCategory === category) button.focus();
    }

    const total = settingsService.getCustomizedKeys().length;
    const persistenceError = settingsService.getPersistenceError();
    clearElement(this._summaryEl);
    for (const [term, value] of [
      ["Customized settings", total === 0 ? "None — everything is at its default" : String(total)],
      ["Settings format", `Version ${SETTINGS_VERSION}`],
      ["Backup format", `Version ${BACKUP_FORMAT_VERSION}`],
      ["Storage", persistenceError ? "Not saving — changes last until reload" : "Saved in this browser"],
    ]) {
      this._summaryEl.append(createElement("dt", { text: term }), createElement("dd", { text: value }));
    }
  }

  // ---------------------------------------------------------------
  // Getting started
  // ---------------------------------------------------------------

  /** @returns {void} */
  _openTour() {
    this._appManager?.launch("welcome").catch((error) => console.error("[Settings] the welcome tour couldn't open:", error));
  }

  /**
   * @param {string} [message] - Result of the last action, shown instead of the summary.
   * @returns {void}
   */
  _renderSamples(message) {
    if (this._destroyed) return;
    const state = sampleContent.getState();
    this._addSamplesButton.hidden = state.installed;
    this._removeSamplesButton.hidden = !state.installed;
    if (message) {
      this._samplesStatusEl.textContent = message;
    } else if (state.installed) {
      this._samplesStatusEl.textContent = `${state.fileCount} sample files were added${state.installedAt ? ` on ${formatDate(state.installedAt)}` : ""}.`;
    } else {
      this._samplesStatusEl.textContent = "No sample files are installed.";
    }
  }

  /** @returns {Promise<void>} */
  async _addSamples() {
    if (this._samplesBusy) return;
    const proceed = await showConfirmDialog({
      title: "Add sample files?",
      message: `${sampleContent.getSampleCount()} files are added to Documents, Projects, Pictures, and Downloads. A sample whose name is already taken is skipped, so none of your files are replaced.`,
      confirmLabel: "Add sample files",
    });
    if (!proceed || this._destroyed) return;
    this._samplesBusy = true;
    this._addSamplesButton.disabled = true;
    this._renderSamples("Adding sample files\u2026");
    try {
      const { created, skipped } = await sampleContent.install(vfs);
      const skippedText = skipped.length ? ` ${skipped.length} skipped because a file with the same name exists.` : "";
      this._renderSamples(`Added ${created.length} sample files.${skippedText}`);
    } catch (error) {
      console.error("[Settings] the sample files couldn't be added:", error);
      this._renderSamples("");
      await showMessageDialog({ title: "Couldn't add the sample files", message: "Files added before the problem are kept and can be removed here.", detail: error.message });
      this._renderSamples();
    } finally {
      this._samplesBusy = false;
      this._addSamplesButton.disabled = false;
    }
  }

  /** @returns {Promise<void>} */
  async _removeSamples() {
    if (this._samplesBusy) return;
    const proceed = await showConfirmDialog({
      title: "Remove the sample files?",
      message: "Sample files you haven't changed are moved to the Recycle Bin, where you can restore them. Files you changed, renamed, or moved are kept, and so is everything you added.",
      confirmLabel: "Move to Recycle Bin",
      destructive: true,
    });
    if (!proceed || this._destroyed) return;
    this._samplesBusy = true;
    this._removeSamplesButton.disabled = true;
    this._renderSamples("Removing sample files\u2026");
    try {
      const { removed, kept } = await sampleContent.remove(vfs);
      const keptText = kept.length ? ` Kept ${kept.length} changed ${kept.length === 1 ? "file" : "files"}: ${kept.slice(0, 3).join(", ")}${kept.length > 3 ? ", \u2026" : ""}.` : "";
      this._renderSamples(`Moved ${removed} ${removed === 1 ? "item" : "items"} to the Recycle Bin.${keptText}`);
    } catch (error) {
      console.error("[Settings] the sample files couldn't be removed:", error);
      await showMessageDialog({ title: "Couldn't remove all sample files", message: "Some sample files may still be in place.", detail: error.message });
      this._renderSamples();
    } finally {
      this._samplesBusy = false;
      this._removeSamplesButton.disabled = false;
    }
  }

  // ---------------------------------------------------------------
  // Backup and restore
  // ---------------------------------------------------------------

  /**
   * @param {() => Promise<void>} work
   * @returns {Promise<void>}
   */
  async _withBusy(work) {
    if (this._busy) return;
    this._busy = true;
    for (const button of this._backupButtons) button.disabled = true;
    try {
      await work();
    } finally {
      this._busy = false;
      for (const button of this._backupButtons) button.disabled = false;
    }
  }

  /** @returns {Promise<void>} */
  _backUpEverything() {
    return this._withBusy(() => this._saveFullBackup());
  }

  /** @returns {Promise<boolean>} Whether a backup was saved. */
  async _saveFullBackup() {
    this._setBackupStatus("Preparing the backup…");
    try {
      const { blob, filename, counts } = await backupService.createFullBackup();
      backupService.saveToComputer(blob, filename);
      this._setBackupStatus(`Saved ${filename}: ${describeCounts(counts)}, ${formatBytes(blob.size)}.`);
      return true;
    } catch (error) {
      this._setBackupStatus("");
      await showMessageDialog({ title: "Couldn't create the backup", message: "Nothing was saved.", detail: error.message });
      return false;
    }
  }

  /** @returns {Promise<void>} */
  _backUpFolder() {
    return this._withBusy(async () => {
      const path = await showFolderPickerDialog({ vfs, title: "Back up a folder", initialPath: "/Documents" });
      if (!path) return;
      this._setBackupStatus("Preparing the backup…");
      try {
        const { blob, filename, counts } = await backupService.createFolderBackup(path);
        backupService.saveToComputer(blob, filename);
        this._setBackupStatus(`Saved ${filename}: ${describeCounts(counts)} from ${path}, ${formatBytes(blob.size)}.`);
      } catch (error) {
        this._setBackupStatus("");
        await showMessageDialog({ title: "Couldn't create the backup", message: "Nothing was saved.", detail: error.message });
      }
    });
  }

  /** @returns {Promise<void>} */
  _onFileChosen() {
    const file = this._fileInput.files?.[0] ?? null;
    this._fileInput.value = "";
    if (!file) return Promise.resolve();
    return this._withBusy(async () => {
      this._setBackupStatus(`Checking ${file.name}…`);
      let backup;
      try {
        backup = await backupService.inspect(file);
      } catch (error) {
        this._setBackupStatus("");
        await showMessageDialog({ title: "This backup can't be restored", message: error.message, detail: "Nothing was changed." });
        return;
      }
      this._setBackupStatus("");
      if (backup.scope === "full") await this._restoreFull(backup, file.name);
      else await this._restoreFolder(backup, file.name);
    });
  }

  /**
   * @param {import("../../../core/backup/backupFormat.js").ParsedBackup} backup
   * @param {string} filename
   * @returns {Promise<void>}
   */
  async _restoreFull(backup, filename) {
    for (;;) {
      const choice = await openDialog({
        title: "Replace all BrowserOS data?",
        role: "alertdialog",
        className: "dialog--wide",
        bodyElement: createElement("div", {
          children: [
            createElement("p", { className: "dialog__message", text: `${filename} is a full backup from ${describeDate(backup.createdAt)} (BrowserOS ${backup.browserOS}).` }),
            createElement("p", { className: "dialog__message", text: `It contains ${describeCounts(backup.counts)} and ${backup.counts.storageKeys} settings and application data entries.` }),
            createElement("p", {
              className: "dialog__message",
              text: "Restoring replaces every current file, setting, and piece of application data with the backup's. Open applications close and BrowserOS restarts. This can't be undone.",
            }),
            ...(backup.checksumVerified ? [] : [createElement("p", { className: "dialog__message dialog__message--detail", text: "This backup has no checksum this browser can verify; its structure was checked." })]),
          ],
        }),
        buttons: [
          { label: "Cancel", value: null },
          { label: "Back up current data first", value: "backup" },
          { label: "Replace everything", value: "restore", variant: "danger", autofocus: true },
        ],
      });
      if (choice === "backup") {
        await this._saveFullBackup();
        continue;
      }
      if (choice !== "restore") return;
      break;
    }

    this._setBackupStatus("Restoring…");
    try {
      await backupService.restoreFull(backup, { closeApplications: () => this._closeEverything() });
    } catch (error) {
      this._setBackupStatus("");
      await showMessageDialog({
        title: "The backup couldn't be restored",
        message: "The restore was stopped before anything was replaced, or the previous data was put back. BrowserOS restarts to make sure everything is consistent.",
        detail: error.message,
      });
      window.location.reload();
      return;
    }
    showSystemScreen({ title: "Backup restored", message: "BrowserOS is restarting with the restored data.", icon: "icon:success" });
    window.setTimeout(() => window.location.reload(), 900);
  }

  /**
   * @param {import("../../../core/backup/backupFormat.js").ParsedBackup} backup
   * @param {string} filename
   * @returns {Promise<void>}
   */
  async _restoreFolder(backup, filename) {
    const name = backup.root === "/" ? "Restored files" : backup.root.split("/").pop();
    const proceed = await showConfirmDialog({
      title: "Restore a folder backup",
      message: `${filename} contains the folder “${name}” (${describeCounts(backup.counts)}) from ${describeDate(backup.createdAt)}. Choose where to put it; nothing that exists is replaced.`,
      confirmLabel: "Choose a folder…",
    });
    if (!proceed) return;
    const original = getParentPath(backup.root) ?? "/";
    const initialPath = (await vfs.exists(original)) ? original : "/Documents";
    const destination = await showFolderPickerDialog({ vfs, title: "Restore into", initialPath });
    if (!destination) return;
    try {
      const restored = await backupService.restoreFolder(backup, destination);
      this._setBackupStatus(`Restored to ${restored.path}.`);
    } catch (error) {
      await showMessageDialog({ title: "The folder couldn't be restored", message: "Nothing was added.", detail: error.message });
    }
  }

  /**
   * End every application and background service so nothing writes
   * while a full backup is restored.
   * @returns {Promise<void>}
   */
  async _closeEverything() {
    if (this._appManager) {
      for (const app of this._appManager.getRunningApplications()) {
        try {
          this._appManager.endApplication(app.appId);
        } catch (error) {
          console.error(`[Settings] couldn't end "${app.appId}" before restoring:`, error);
        }
      }
    }
    serviceManager.stopAll();
    settingsService.flush();
    await new Promise((resolve) => window.setTimeout(resolve, SETTLE_MS));
  }

  /**
   * @param {string} text
   * @returns {void}
   */
  _setBackupStatus(text) {
    if (!this._destroyed) this._backupStatusEl.textContent = text;
  }

  // ---------------------------------------------------------------
  // Reset
  // ---------------------------------------------------------------

  /**
   * @param {string} category
   * @param {string} label
   * @returns {Promise<void>}
   */
  async _confirmResetCategory(category, label) {
    const confirmed = await showConfirmDialog({
      title: `Reset ${label} settings?`,
      message: `Every ${label} preference returns to its default. Files and other data are not affected.`,
      confirmLabel: "Reset",
      destructive: true,
    });
    if (!confirmed || this._destroyed) return;
    settingsService.resetCategory(category);
    this._statusEl.textContent = `${label} settings were reset to their defaults.`;
  }

  /** @returns {Promise<void>} */
  async _confirmResetAll() {
    const confirmed = await showConfirmDialog({
      title: "Reset all preferences?",
      message:
        "Every BrowserOS preference — appearance, wallpaper, desktop, Start Menu, File Explorer, keyboard, notifications, taskbar, Task Manager, Browser, downloads, and Code Studio — returns to its default. Files, desktop icon positions, and recent history are kept.",
      confirmLabel: "Reset all",
      destructive: true,
    });
    if (!confirmed || this._destroyed) return;
    settingsService.resetAll();
    this._statusEl.textContent = "All preferences were reset to their defaults.";
  }
}

/**
 * @param {{files: number, folders: number}} counts
 * @returns {string}
 */
function describeCounts(counts) {
  if (!counts) return "";
  const files = `${counts.files} ${counts.files === 1 ? "file" : "files"}`;
  const folders = `${counts.folders} ${counts.folders === 1 ? "folder" : "folders"}`;
  return `${files} in ${folders}`;
}

/**
 * @param {string} iso
 * @returns {string}
 */
function describeDate(iso) {
  const time = Date.parse(iso);
  return Number.isFinite(time) ? formatDate(time) : "an unknown date";
}
