/**
 * @file TerminalManager — owns one Terminal window's state: its
 * working directory, command history, and in-progress tab-completion
 * cycle. Builds a single TerminalView at construction and drives it
 * through direct method calls (the same Manager/View split File
 * Explorer and the Start Menu use) — the view makes no decisions of
 * its own, it only renders.
 *
 * Every filesystem operation goes through the public VFS API with
 * this window's own `cwd` passed as `currentDir`, so path resolution
 * (".", "..", nested relative/absolute paths, redundant separators)
 * is never reimplemented here — VirtualFileSystem's own PathResolver
 * already does exactly this, for every VFS method, for free.
 */

import { eventBus } from "../../core/eventBus.js";
import { notificationService } from "../../core/notifications/notificationService.js";
import { downloadService } from "../../core/downloads/downloadService.js";
import { storage } from "../../core/storage.js";
import { openVfsEntry } from "../../core/vfs/vfsOpener.js";
import { keyboardShortcuts } from "../../core/keyboard/keyboardShortcuts.js";
import { TerminalView } from "./terminalView.js";
import { tokenize, createCommandRegistry } from "./commands.js";

const HISTORY_STORAGE_KEY = "terminal:history";
const MAX_HISTORY = 500;
/** Commands running at least this long notify when they finish in the background. */
const LONG_COMMAND_MS = 5000;

class TerminalManager {
  /**
   * @param {object} config
   * @param {import("../../core/vfs/virtualFileSystem.js").vfs} config.vfs
   * @param {import("../../core/appManager.js").AppManager} config.appManager
   * @param {import("../../core/recentFilesService.js").RecentFilesService} config.recentFilesService
   * @param {string} [config.initialPath] - Starting directory, if launched with one. Defaults to "/".
   * @param {() => void} [config.focusWindow] - Bring this Terminal's window forward (used by its notifications).
   * @param {() => boolean} [config.isActive] - Whether this Terminal's window is the active window.
   * @param {string} [config.greeting] - First line printed by init() (a host such as Code Studio can describe its context).
   */
  constructor(config) {
    this._vfs = config.vfs;
    this._appManager = config.appManager;
    this._recentFilesService = config.recentFilesService;
    this._cwd = config.initialPath ?? "/";
    this._focusWindow = config.focusWindow ?? null;
    this._isActive = config.isActive ?? null;
    this._greeting = config.greeting ?? 'BrowserOS Terminal \u2014 type "help" to see available commands.';
    /** @type {Set<AbortController>} Commands still running (Ctrl + C interrupts them). */
    this._runningCommands = new Set();
    this._destroyed = false;

    this._commands = createCommandRegistry();

    /** @type {string[]} Persisted across windows and sessions via StorageService, like every other BrowserOS preference. */
    this._history = storage.get(HISTORY_STORAGE_KEY, []);
    this._historyIndex = this._history.length;
    this._draftInput = "";

    /** @type {{contextKey: string, matches: string[], index: number}|null} */
    this._tabState = null;

    this._view = new TerminalView({
      onInputKeyDown: (e) => this._handleInputKeyDown(e),
    });
    this._view.setPrompt(this._formatPrompt());
  }

  /** @returns {HTMLElement} */
  getElement() {
    return this._view.getElement();
  }

  /**
   * Print the welcome line and focus the input. Called once by
   * TerminalApp right after construction.
   * @returns {void}
   */
  init() {
    for (const line of this._greeting.split("\n")) this._print(line);
    this._view.focusInput();
  }

  /** @returns {string} The current working directory. */
  getCwd() {
    return this._cwd;
  }

  /**
   * Change the working directory from outside (for example, when the
   * host's project folder is renamed). The path must exist.
   * @param {string} path
   * @returns {void}
   */
  setCwd(path) {
    if (path && path !== this._cwd) this._setCwd(path);
  }

  /** @returns {void} */
  onFocus() {
    this._view.focusInput();
  }

  /** @returns {void} */
  onBlur() {}

  /**
   * Interrupt commands still running in this window. No document- or
   * window-level listeners are registered anywhere in this class —
   * every listener lives on this window's own input element, so
   * removing the window from the DOM releases them.
   * @returns {void}
   */
  destroy() {
    this._destroyed = true;
    // Closing the window interrupts anything still running in it.
    for (const controller of this._runningCommands) controller.abort();
    this._runningCommands.clear();
  }

  // ---------------------------------------------------------------
  // Input handling
  // ---------------------------------------------------------------

  /**
   * @param {KeyboardEvent} e
   * @returns {void}
   */
  _handleInputKeyDown(e) {
    // Key bindings come from the shared shortcut catalog, so the
    // Settings shortcut reference always describes what happens here.
    const shortcut = (id) => keyboardShortcuts.matches(e, id);

    if (!shortcut("terminal.complete")) {
      this._tabState = null;
    }

    if (shortcut("terminal.clear")) {
      e.preventDefault();
      this._clear();
    } else if (shortcut("terminal.cancel")) {
      e.preventDefault();
      this._cancelCurrentLine();
    } else if (shortcut("terminal.run")) {
      e.preventDefault();
      this._handleSubmit();
    } else if (shortcut("terminal.historyPrevious")) {
      e.preventDefault();
      this._recallHistory(-1);
    } else if (shortcut("terminal.historyNext")) {
      e.preventDefault();
      this._recallHistory(1);
    } else if (shortcut("terminal.complete")) {
      e.preventDefault();
      this._handleTabCompletion();
    }
  }

  /** @returns {Promise<void>} */
  async _handleSubmit() {
    const raw = this._view.getInputValue();
    const promptAtSubmit = this._formatPrompt();
    this._view.setInputValue("");
    this._view.appendLine({ text: `${promptAtSubmit} ${raw}`, type: "input" });

    const trimmed = raw.trim();
    if (trimmed.length > 0) {
      this._addHistory(trimmed);
    }
    this._historyIndex = this._history.length;
    this._draftInput = "";

    if (trimmed.length === 0) return;
    await this._execute(trimmed);
  }

  /**
   * @param {number} direction - -1 for older (ArrowUp), +1 for newer (ArrowDown).
   * @returns {void}
   */
  _recallHistory(direction) {
    if (this._history.length === 0) return;

    if (direction < 0) {
      if (this._historyIndex === this._history.length) {
        this._draftInput = this._view.getInputValue();
      }
      if (this._historyIndex > 0) {
        this._historyIndex -= 1;
        this._view.setInputValue(this._history[this._historyIndex]);
      }
      return;
    }

    if (this._historyIndex >= this._history.length) return;
    this._historyIndex += 1;
    this._view.setInputValue(this._historyIndex === this._history.length ? this._draftInput : this._history[this._historyIndex]);
  }

  /** @returns {void} */
  _cancelCurrentLine() {
    // Ctrl + C also interrupts commands that are still running.
    for (const controller of this._runningCommands) controller.abort();
    const current = this._view.getInputValue();
    this._view.appendLine({ text: `${this._formatPrompt()} ${current}^C`, type: "input" });
    this._view.setInputValue("");
    this._historyIndex = this._history.length;
    this._draftInput = "";
  }

  // ---------------------------------------------------------------
  // Tab completion
  // ---------------------------------------------------------------

  /** @returns {Promise<void>} */
  async _handleTabCompletion() {
    const value = this._view.getInputValue();
    const endsWithSpace = value.length === 0 || /\s$/.test(value);
    const tokens = tokenize(value);
    const completingCommandPosition = endsWithSpace ? tokens.length === 0 : tokens.length === 1;
    const partial = endsWithSpace ? "" : tokens[tokens.length - 1];
    const prefixTokens = endsWithSpace ? tokens : tokens.slice(0, -1);
    const contextKey = `${prefixTokens.join(" ")}\u0000${partial}`;

    if (this._tabState && this._tabState.contextKey === contextKey && this._tabState.matches.length > 0) {
      this._tabState.index = (this._tabState.index + 1) % this._tabState.matches.length;
    } else {
      const matches = completingCommandPosition
        ? this._getCommandMatches(partial)
        : await this._getPathMatches(partial);
      this._tabState = { contextKey, matches, index: 0 };
    }

    if (this._tabState.matches.length === 0) return;

    const completion = this._tabState.matches[this._tabState.index];
    const newTokens = [...prefixTokens, completion];
    this._view.setInputValue(this._joinTokens(newTokens));
  }

  /**
   * @param {string} partial
   * @returns {string[]}
   */
  _getCommandMatches(partial) {
    const lowerPartial = partial.toLowerCase();
    return [...this._commands.keys()].filter((name) => name.startsWith(lowerPartial)).sort();
  }

  /**
   * @param {string} partial
   * @returns {Promise<string[]>}
   */
  async _getPathMatches(partial) {
    const lastSlash = partial.lastIndexOf("/");
    const dirPart = lastSlash === -1 ? "" : partial.slice(0, lastSlash + 1);
    const namePart = lastSlash === -1 ? partial : partial.slice(lastSlash + 1);
    const lowerNamePart = namePart.toLowerCase();

    let children;
    try {
      children = await this._vfs.list(dirPart.length > 0 ? dirPart : ".", this._cwd);
    } catch {
      return [];
    }

    return children
      .filter((entry) => entry.name.toLowerCase().startsWith(lowerNamePart))
      .map((entry) => `${dirPart}${entry.name}${entry.type === "folder" ? "/" : ""}`)
      .sort();
  }

  /**
   * @param {string[]} tokens
   * @returns {string}
   */
  _joinTokens(tokens) {
    return tokens.map((token) => (/\s/.test(token) ? `"${token}"` : token)).join(" ");
  }

  // ---------------------------------------------------------------
  // Execution
  // ---------------------------------------------------------------

  /**
   * @param {string} line
   * @returns {Promise<void>}
   */
  async _execute(line) {
    const tokens = tokenize(line);
    if (tokens.length === 0) return;
    const [name, ...args] = tokens;
    const command = this._commands.get(name.toLowerCase());

    if (!command) {
      const message = `${name}: command not found (type "help" for a list of commands)`;
      this._view.appendLine({ text: message, type: "error" });
      eventBus.emit("terminal:error", { command: name, message });
      return;
    }

    const controller = new AbortController();
    this._runningCommands.add(controller);
    const startedAt = Date.now();
    let failure = null;
    try {
      await command.run(args, { ...this._buildContext(), signal: controller.signal });
      eventBus.emit("terminal:command", { command: name, args });
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      this._view.appendLine({ text: failure, type: "error" });
      eventBus.emit("terminal:error", { command: name, message: failure });
    } finally {
      this._runningCommands.delete(controller);
    }
    if (!this._destroyed && !controller.signal.aborted) this._notifyIfLongRunning(line, Date.now() - startedAt, failure);
  }

  /**
   * A command that ran for a while and finished while the Terminal was
   * in the background produces a notification; quick commands, and
   * commands finishing while the Terminal is in front, don't.
   * @param {string} line
   * @param {number} durationMs
   * @param {string|null} failure
   * @returns {void}
   */
  _notifyIfLongRunning(line, durationMs, failure) {
    if (durationMs < LONG_COMMAND_MS) return;
    const inFront = this._isActive ? this._isActive() : this._view.getElement().contains(document.activeElement);
    const focused = document.visibilityState === "visible" && inFront;
    if (focused) return;
    const seconds = Math.round(durationMs / 1000);
    notificationService.notify({
      type: failure ? "error" : "success",
      title: failure ? "A Terminal command failed" : "A Terminal command finished",
      message: failure ? `${line} \u2014 ${failure}` : `${line} \u00b7 ${seconds} s`,
      source: "terminal",
      groupKey: "terminal-commands",
      action: { type: "launch", appId: "terminal" },
      onClick: this._focusWindow ? () => this._focusWindow() : undefined,
    });
  }

  /**
   * @returns {object} The context object every command's run(args, ctx) receives.
   */
  _buildContext() {
    return {
      vfs: this._vfs,
      cwd: this._cwd,
      history: this._history,
      commandList: [...this._commands.values()],
      print: (text) => this._print(text),
      clear: () => this._clear(),
      setCwd: (path) => this._setCwd(path),
      openEntry: (entry, appId) => this._openEntry(entry, appId),
      download: (url) => downloadService.download(/^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`, { source: "terminal" }),
    };
  }

  /**
   * @param {string} text
   * @returns {void}
   */
  _print(text) {
    this._view.appendLine({ text, type: "success" });
  }

  /** @returns {void} */
  _clear() {
    this._view.clearOutput();
  }

  /**
   * @param {string} path - Already-resolved absolute path.
   * @returns {void}
   */
  _setCwd(path) {
    this._cwd = path;
    this._view.setPrompt(this._formatPrompt());
    eventBus.emit("terminal:directoryChanged", { path });
  }

  /**
   * @param {object} entry - A VFS entry (file or folder).
   * @param {string} [appId] - Open with this application instead of the default.
   * @returns {Promise<void>}
   */
  async _openEntry(entry, appId) {
    if (appId && !this._appManager.isRegistered(appId)) throw new Error(`open: no application "${appId}"`);
    await openVfsEntry(entry, { appManager: this._appManager, recentFilesService: this._recentFilesService, appId });
    eventBus.emit("terminal:fileOpened", { path: entry.path, kind: entry.type });
  }

  /** @returns {string} */
  _formatPrompt() {
    return `${this._cwd} $`;
  }

  // ---------------------------------------------------------------
  // History persistence
  // ---------------------------------------------------------------

  /**
   * @param {string} command
   * @returns {void}
   */
  _addHistory(command) {
    if (this._history[this._history.length - 1] === command) return; // Duplicate suppression: skip immediate repeats, like most shells.
    this._history.push(command);
    if (this._history.length > MAX_HISTORY) {
      this._history = this._history.slice(-MAX_HISTORY);
    }
    storage.set(HISTORY_STORAGE_KEY, this._history);
  }
}

export { TerminalManager };
