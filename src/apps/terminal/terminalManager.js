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
import { storage } from "../../core/storage.js";
import { openVfsEntry } from "../../core/vfs/vfsOpener.js";
import { TerminalView } from "./terminalView.js";
import { tokenize, createCommandRegistry } from "./commands.js";

const HISTORY_STORAGE_KEY = "terminal:history";
const MAX_HISTORY = 500;

class TerminalManager {
  /**
   * @param {object} config
   * @param {import("../../core/vfs/virtualFileSystem.js").vfs} config.vfs
   * @param {import("../../core/appManager.js").AppManager} config.appManager
   * @param {import("../../core/recentFilesService.js").RecentFilesService} config.recentFilesService
   * @param {string} [config.initialPath] - Starting directory, if launched with one. Defaults to "/".
   */
  constructor(config) {
    this._vfs = config.vfs;
    this._appManager = config.appManager;
    this._recentFilesService = config.recentFilesService;
    this._cwd = config.initialPath ?? "/";

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
    this._print('BrowserOS Terminal \u2014 type "help" to see available commands.');
    this._view.focusInput();
  }

  /** @returns {void} */
  onFocus() {
    this._view.focusInput();
  }

  /** @returns {void} */
  onBlur() {}

  /**
   * No document/window-level listeners are registered anywhere in
   * this class — every listener lives on this window's own input
   * element, so closing the window (which removes that element from
   * the DOM) is enough for it to become garbage, with nothing here
   * needing to explicitly unsubscribe.
   * @returns {void}
   */
  destroy() {}

  // ---------------------------------------------------------------
  // Input handling
  // ---------------------------------------------------------------

  /**
   * @param {KeyboardEvent} e
   * @returns {void}
   */
  _handleInputKeyDown(e) {
    if (e.key !== "Tab") {
      this._tabState = null;
    }

    if (e.ctrlKey && e.key.toLowerCase() === "l") {
      e.preventDefault();
      this._clear();
      return;
    }
    if (e.ctrlKey && e.key.toLowerCase() === "c") {
      e.preventDefault();
      this._cancelCurrentLine();
      return;
    }

    switch (e.key) {
      case "Enter":
        e.preventDefault();
        this._handleSubmit();
        break;
      case "ArrowUp":
        e.preventDefault();
        this._recallHistory(-1);
        break;
      case "ArrowDown":
        e.preventDefault();
        this._recallHistory(1);
        break;
      case "Tab":
        e.preventDefault();
        this._handleTabCompletion();
        break;
      default:
        break;
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

    try {
      await command.run(args, this._buildContext());
      eventBus.emit("terminal:command", { command: name, args });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this._view.appendLine({ text: message, type: "error" });
      eventBus.emit("terminal:error", { command: name, message });
    }
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
      openEntry: (entry) => this._openEntry(entry),
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
   * @returns {Promise<void>}
   */
  async _openEntry(entry) {
    await openVfsEntry(entry, { appManager: this._appManager, recentFilesService: this._recentFilesService });
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
