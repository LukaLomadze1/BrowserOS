/**
 * @file DesktopManager — the desktop as a live view onto the Virtual
 * File System's `/Desktop` folder, plus a small fixed set of
 * application shortcuts. Owns icon layout (persisted via the
 * existing StorageService, keyed by stable ids — shortcut ids or
 * `vfs:<entryId>`, never filenames), delegates selection bookkeeping
 * to SelectionManager, reuses ContextMenu (now with submenu support)
 * for right-click menus, and opens apps exclusively through
 * AppManager — it never touches WindowManager.
 *
 * Two kinds of desktop item share one rendering/selection/drag code
 * path (both are just a DesktopIconView at some composite id), but
 * their data and capabilities stay distinct: application shortcuts
 * are a static list handed in at construction and are never
 * renamed/deleted; VFS entries come from `vfs.list("/Desktop")` and
 * every mutation (create/rename/delete/move) goes through the VFS.
 * The desktop never keeps its own record of what files exist —
 * `this._vfsEntries` is a cache of the VFS's own data, kept in sync
 * by `filesystem:*` events, not a second source of truth.
 *
 * Selection state lives in exactly one place: SelectionManager,
 * mutated only from the handlers below. DesktopIconView makes no
 * selection decisions of its own — it only reports pointer/focus
 * facts (see desktopIcon.js).
 *
 * Focus: DOM focus and SelectionManager's selection set are two
 * different things, and only selection is updated by every way of
 * selecting icons. A marquee (rectangle) selection never
 * makes any icon the pointerdown target, so nothing about it
 * triggers the browser's native "click focuses this element"
 * behavior — and Delete/F2 rely on a keydown listener attached to
 * the icon-grid container, which only fires for events bubbling up
 * *from inside it*. Native click-focus is also not a safe thing to
 * rely on cross-browser regardless (Safari doesn't apply it to plain
 * divs at all). `_handleIconClick` and the marquee's pointerup
 * handler both now call `.focus()` explicitly, rather than depending
 * on any browser default.
 *
 * Preferences: every `desktop.*` setting is read from SettingsService
 * and applied live through one category subscription
 * (_applyDesktopPreferences). Icon size and grid spacing produce
 * concrete metrics (utils/desktopMetrics.js) that are written to the
 * icon layer's CSS custom properties *and* passed to
 * desktopGrid.configureGrid(), so they change real positions, not just
 * visuals. Visibility preferences (show icons, system shortcuts) only
 * hide views — the layout and the VFS are never touched — and any
 * hidden item is dropped from the selection, so SelectionManager stays
 * the single source of truth for what an action like Delete affects.
 * With "align to grid" off, layout cells may be fractional (free
 * placement); with "auto arrange" on, icons are re-packed in sort
 * order after every change.
 */

import { createElement } from "../utils/dom.js";
import { settingsService } from "./settings/settingsService.js";
import { keyboardShortcuts } from "./keyboard/keyboardShortcuts.js";
import { computeDesktopMetrics } from "../utils/desktopMetrics.js";
import { eventBus } from "./eventBus.js";
import { storage } from "./storage.js";
import { SelectionManager } from "./selectionManager.js";
import { ContextMenu } from "../components/context-menu/contextMenu.js";
import { DesktopIconView } from "../components/desktop-icon/desktopIcon.js";
import {
  cellToPixels,
  pixelsToNearestCell,
  getColumnCount,
  getRowCount,
  getCellSize,
  clampCell,
  cellKey,
  findNextFreeCell,
  findNearestFreeCell,
  configureGrid,
  pixelsToCell,
} from "../utils/desktopGrid.js";
import { openVfsEntry, buildOpenWithItems } from "./vfs/vfsOpener.js";
import { importHostFiles } from "./vfs/fileImport.js";
import { fileAssociations } from "./fileAssociations.js";
import { showConfirmDialog } from "../components/dialog/confirmDialog.js";
import { showPropertiesDialog } from "../components/dialog/propertiesDialog.js";
import { generateDefaultName, splitNameForRename } from "../utils/nameGenerator.js";
import { formatBytes, formatDate } from "../utils/format.js";
import { pasteClipboard } from "./vfs/clipboardPaste.js";

const STORAGE_KEY = "desktop:iconLayout";
const RESIZE_DEBOUNCE_MS = 150;
const DESKTOP_VFS_PATH = "/Desktop";
const VFS_ID_PREFIX = "vfs:";

// A "slow second click" on an already-selected item starts a rename.
// The window starts well above typical native dblclick thresholds so
// the two gestures don't fight for the same click — a real dblclick
// still opens the item; only a deliberately paced second click renames.
const SLOW_CLICK_MIN_MS = 450;
const SLOW_CLICK_MAX_MS = 1000;

/** Fractional layout positions are persisted with this many decimals. */
const LAYOUT_PRECISION = 100;

/** In single-click mode, a repeat click on the same icon within this window is the tail of a double-click, not a second open. */
const SINGLE_CLICK_REPEAT_GUARD_MS = 500;

class DesktopManager {
  /**
   * @param {object} config
   * @param {HTMLElement} config.container - The desktop's icon layer (from Desktop.getIconLayer()).
   * @param {Array<{id: string, label: string, icon: string, appId: string, type: string}>} config.shortcuts - Static application-shortcut definitions; composition root's job to decide these. Never touched by VFS operations.
   * @param {import("./appManager.js").AppManager} config.appManager - Used only to call launch(appId)/isRegistered/register; DesktopManager never touches WindowManager.
   * @param {import("./vfs/virtualFileSystem.js").vfs} config.vfs - The single source of truth for every file/folder shown on the desktop.
   * @param {import("./recentFilesService.js").RecentFilesService} [config.recentFilesService] - Forwarded to vfsOpener so opening a desktop file also records it as "recent".
   */
  constructor(config) {
    this._container = config.container;
    this._shortcuts = config.shortcuts;
    this._appManager = config.appManager;
    this._vfs = config.vfs;
    this._recentFilesService = config.recentFilesService ?? null;
    this._clipboardService = config.clipboardService ?? null;

    /** @type {Map<string, DesktopIconView>} keyed by composite id */
    this._views = new Map();
    /** @type {Map<string, {col: number, row: number}>} keyed by composite id */
    this._layout = new Map();
    this._sortMode = "custom";

    /** @type {Map<string, object>} VFS entry id -> entry; a cache of /Desktop's children, not a separate source of truth. */
    this._vfsEntries = new Map();
    this._desktopFolderId = null;

    this._selection = new SelectionManager();
    this._contextMenu = new ContextMenu();

    this._focusedId = null;
    /** Icon id whose selection should collapse to just itself if the
     * current pointer interaction turns out to be a plain click
     * rather than a drag (see _handleIconPointerDown). */
    this._pendingCollapseId = null;
    this._lastClickId = null;
    this._lastClickTime = 0;
    this._lastOpenedId = null;
    this._lastOpenedTime = 0;

    this._marqueeEl = null;
    this._dragRafId = null;
    this._marqueeRafId = null;
    this._resizeTimeoutId = null;

    /** @type {string[]} Ids currently being dragged together. */
    this._dragGroup = [];
    /** @type {Map<string, {col: number, row: number, pixelX: number, pixelY: number}>} */
    this._dragOrigins = new Map();

    this._resizeHandler = () => this._onWindowResize();

    /** @type {Readonly<Record<string, *>>} Snapshot of the desktop.* settings currently applied. */
    this._prefs = settingsService.getCategory("desktop");
    /** @type {Array<() => void>} */
    this._unsubscribers = [];

    // One shared callbacks object for every icon view — none of these
    // close over anything item-specific, they just forward the id.
    this._iconCallbacks = {
      onPointerDown: (id, options) => this._handleIconPointerDown(id, options),
      onClick: (id, options) => this._handleIconClick(id, options),
      onOpen: (id) => this._handleIconDoubleClick(id),
      onContextMenu: (id, x, y) => this._showIconContextMenu(id, x, y),
      onDragStart: (id) => this._handleDragStart(id),
      onDragMove: (id, dx, dy) => this._handleDragMove(id, dx, dy),
      onDragEnd: (id, dx, dy) => this._handleDragEnd(id, dx, dy),
      onFocusIn: (id) => this._handleFocusIn(id),
    };
  }

  /**
   * Load `/Desktop` from the VFS, load/derive icon positions, render
   * every icon, and wire up all interaction. Call once during boot,
   * after `vfs.init()` has resolved.
   * @returns {Promise<void>}
   */
  async init() {
    try {
      await this._loadDesktopFolder();
    } catch (error) {
      // Degrade gracefully: shortcuts still work even if /Desktop
      // couldn't be read for some reason.
      console.error("[DesktopManager] failed to load /Desktop from the VFS:", error);
      this._vfsEntries = new Map();
      this._desktopFolderId = null;
    }

    // Metrics must be in place before the layout is computed, since
    // the grid's column/row counts depend on the cell size.
    this._applyMetrics();
    this._loadLayout();
    this._renderAllIcons();
    this._applyVisibility();
    if (this._prefs["desktop.autoArrange"]) this._arrangeIcons();
    this._wireSelectionEvents();
    this._wireContainerEvents();
    this._wireVfsEvents();
    this._wireClipboardEvents();
    window.addEventListener("resize", this._resizeHandler);
    this._unsubscribers.push(
      settingsService.subscribeCategory("desktop", (batch) => this._applyDesktopPreferences(batch)),
      // Escape must work regardless of what currently has DOM focus —
      // a container-scoped listener only fires when focus is inside
      // the icon grid, which isn't reliably true after clicking empty
      // desktop space. It's a global shortcut for that reason.
      keyboardShortcuts.bind("desktop.clearSelection", () => this._clearSelectionFromKeyboard())
    );
  }

  /**
   * Detach every global listener and subscription. Intended for tests
   * and teardown.
   * @returns {void}
   */
  destroy() {
    window.removeEventListener("resize", this._resizeHandler);
    for (const unsubscribe of this._unsubscribers) unsubscribe();
    this._unsubscribers = [];
  }

  // ---------------------------------------------------------------
  // Preferences
  // ---------------------------------------------------------------

  /**
   * React to one batch of desktop.* changes.
   * @param {import("./settings/settingsService.js").SettingsBatch} batch
   * @returns {void}
   */
  _applyDesktopPreferences(batch) {
    const changed = new Set(batch.changes.map((change) => change.key));
    this._prefs = settingsService.getCategory("desktop");

    if (changed.has("desktop.iconSize") || changed.has("desktop.gridSpacing") || changed.has("desktop.showLabels")) {
      this._applyMetrics();
      this._reclampAllPositions();
      for (const id of this._layout.keys()) this._repositionView(id);
    }

    if (changed.has("desktop.showIcons") || changed.has("desktop.showSystemShortcuts")) {
      this._applyVisibility();
    }

    if (changed.has("desktop.alignToGrid") && this._prefs["desktop.alignToGrid"]) {
      this._snapAllToGrid();
    }

    if (this._prefs["desktop.autoArrange"]) {
      this._arrangeIcons();
    } else {
      this._saveLayout();
    }

    eventBus.emit("desktop:preferencesApplied", Object.freeze({ keys: Object.freeze([...changed]) }));
  }

  /**
   * Write icon/grid metrics to the icon layer and the grid math.
   * @returns {void}
   */
  _applyMetrics() {
    const metrics = computeDesktopMetrics(this._prefs["desktop.iconSize"], this._prefs["desktop.gridSpacing"]);
    const style = this._container.style;
    style.setProperty("--icon-size", `${metrics.glyph}px`);
    style.setProperty("--desktop-icon-glyph-font", `${metrics.glyphFont}px`);
    style.setProperty("--desktop-icon-width", `${metrics.width}px`);
    style.setProperty("--desktop-icon-height", `${metrics.height}px`);
    style.setProperty("--desktop-icon-label-font", `${metrics.labelFont}px`);
    style.setProperty("--desktop-icon-label-line-height", String(metrics.labelLineHeight));
    style.setProperty("--desktop-icon-padding", `${metrics.paddingY}px ${metrics.paddingX}px`);
    style.setProperty("--desktop-icon-gap", `${metrics.glyphGap}px`);
    style.setProperty("--icon-grid-cell", `${metrics.cell}px`);
    style.setProperty("--icon-grid-inset", `${metrics.inset}px`);
    this._container.dataset.iconSize = this._prefs["desktop.iconSize"];
    this._container.dataset.showLabels = this._prefs["desktop.showLabels"] ? "on" : "off";
    configureGrid({ inset: metrics.inset, cellSize: metrics.cell });
  }

  /**
   * Show or hide views according to the visibility preferences, and
   * drop anything now hidden from the selection.
   * @returns {void}
   */
  _applyVisibility() {
    this._container.dataset.iconsHidden = this._prefs["desktop.showIcons"] ? "false" : "true";
    for (const [id, view] of this._views) {
      view.getElement().hidden = !this._isVisible(id);
    }
    const visibleSelection = this._selection.getSelectedIds().filter((id) => this._isVisible(id));
    if (visibleSelection.length !== this._selection.getSelectedIds().length) {
      this._selection.setSelection(visibleSelection);
    }
  }

  /**
   * @param {string} id
   * @returns {boolean} Whether the item is currently displayed.
   */
  _isVisible(id) {
    if (!this._prefs["desktop.showIcons"]) return false;
    const shortcut = this._getShortcut(id);
    if (shortcut && shortcut.type === "system" && !this._prefs["desktop.showSystemShortcuts"]) return false;
    return true;
  }

  /**
   * Change one desktop setting on behalf of a desktop context-menu
   * action. The setting's subscription applies it, exactly as if it
   * had been changed in Settings.
   * @param {string} key
   * @param {*} value
   * @returns {void}
   */
  _setPreference(key, value) {
    settingsService.set(key, value);
  }

  // ---------------------------------------------------------------
  // Item identity helpers (shortcut vs VFS entry, sharing one id space)
  // ---------------------------------------------------------------

  /**
   * @param {string} entryId
   * @returns {string}
   */
  _vfsCompositeId(entryId) {
    return `${VFS_ID_PREFIX}${entryId}`;
  }

  /**
   * @param {string} compositeId
   * @returns {object|null}
   */
  _getShortcut(compositeId) {
    return this._shortcuts.find((s) => s.id === compositeId) ?? null;
  }

  /**
   * @param {string} compositeId
   * @returns {object|null} The cached VFS entry, or null if this id isn't a VFS item (or isn't tracked).
   */
  _getVfsEntry(compositeId) {
    if (!compositeId.startsWith(VFS_ID_PREFIX)) return null;
    return this._vfsEntries.get(compositeId.slice(VFS_ID_PREFIX.length)) ?? null;
  }

  /**
   * @returns {string[]} Every composite id currently on the desktop (shortcuts + VFS entries).
   */
  _getAllCompositeIds() {
    const shortcutIds = this._shortcuts.map((s) => s.id);
    const vfsIds = [...this._vfsEntries.keys()].map((entryId) => this._vfsCompositeId(entryId));
    return [...shortcutIds, ...vfsIds];
  }

  // ---------------------------------------------------------------
  // Loading /Desktop from the VFS
  // ---------------------------------------------------------------

  /** @returns {Promise<void>} */
  async _loadDesktopFolder() {
    const folderInfo = await this._vfs.getInfo(DESKTOP_VFS_PATH);
    this._desktopFolderId = folderInfo.id;
    const children = await this._vfs.list(DESKTOP_VFS_PATH);
    this._vfsEntries = new Map(children.map((entry) => [entry.id, entry]));
  }

  // ---------------------------------------------------------------
  // Layout persistence
  // ---------------------------------------------------------------

  /** @returns {void} */
  _loadLayout() {
    const saved = storage.get(STORAGE_KEY, null);
    const savedPositions = saved?.positions ?? {};
    this._sortMode = saved?.sortMode ?? "custom";

    const bounds = this._container.getBoundingClientRect();
    const rows = getRowCount(bounds.height || window.innerHeight);
    const columns = getColumnCount(bounds.width || window.innerWidth);

    const aligned = this._prefs["desktop.alignToGrid"];
    const occupied = new Set();
    for (const compositeId of this._getAllCompositeIds()) {
      const savedPos = savedPositions[compositeId];
      let col, row;
      if (savedPos && Number.isFinite(savedPos.col) && Number.isFinite(savedPos.row)) {
        const base = aligned ? { col: Math.round(savedPos.col), row: Math.round(savedPos.row) } : savedPos;
        ({ col, row } = clampCell(base.col, base.row, columns, rows));
      } else {
        ({ col, row } = findNextFreeCell(occupied, rows));
      }
      // With grid alignment, two icons may never share a cell: bump a
      // collision forward to the next free one. Free placement allows
      // overlap, exactly like dropping one icon onto another.
      if (aligned) {
        while (occupied.has(cellKey(col, row))) {
          ({ col, row } = findNextFreeCell(occupied, rows));
        }
      }
      occupied.add(cellKey(col, row));
      this._layout.set(compositeId, { col, row });
    }
  }

  /** @returns {void} */
  _saveLayout() {
    const positions = {};
    for (const [id, pos] of this._layout) {
      positions[id] = {
        col: Math.round(pos.col * LAYOUT_PRECISION) / LAYOUT_PRECISION,
        row: Math.round(pos.row * LAYOUT_PRECISION) / LAYOUT_PRECISION,
      };
    }
    storage.set(STORAGE_KEY, { positions, sortMode: this._sortMode });
  }

  /**
   * Give a newly-appeared item a grid cell if it doesn't already have
   * one (e.g. from a stale saved position that no longer applies).
   * @param {string} compositeId
   * @returns {void}
   */
  _assignPositionIfMissing(compositeId) {
    if (this._layout.has(compositeId)) return;
    const bounds = this._container.getBoundingClientRect();
    const rows = getRowCount(bounds.height);
    const occupied = new Set([...this._layout.values()].map((pos) => cellKey(pos.col, pos.row)));
    const { col, row } = findNextFreeCell(occupied, rows);
    this._layout.set(compositeId, { col, row });
    this._repositionView(compositeId);
    if (this._prefs["desktop.autoArrange"]) this._arrangeIcons();
  }

  // ---------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------

  /** @returns {void} */
  _renderAllIcons() {
    for (const shortcut of this._shortcuts) {
      this._renderShortcutIcon(shortcut);
    }
    for (const entry of this._vfsEntries.values()) {
      this._renderVfsIcon(entry);
    }
  }

  /**
   * @param {object} shortcut
   * @returns {void}
   */
  _renderShortcutIcon(shortcut) {
    const view = new DesktopIconView({ id: shortcut.id, label: shortcut.label, icon: shortcut.icon }, this._iconCallbacks);
    this._views.set(shortcut.id, view);
    view.getElement().hidden = !this._isVisible(shortcut.id);
    this._container.append(view.getElement());
    this._repositionView(shortcut.id);
  }

  /**
   * @param {object} entry
   * @returns {void}
   */
  _renderVfsIcon(entry) {
    const compositeId = this._vfsCompositeId(entry.id);
    const icon = fileAssociations.getIcon(entry);
    const view = new DesktopIconView({ id: compositeId, label: entry.name, icon }, this._iconCallbacks);
    this._views.set(compositeId, view);
    view.getElement().hidden = !this._isVisible(compositeId);
    this._container.append(view.getElement());
    this._repositionView(compositeId);
    if (this._clipboardService?.isCut(entry.id)) view.setCut(true);
  }

  /**
   * Reposition a single icon's view to match its current layout
   * entry (with a CSS transition, since this is never called mid-drag).
   * @param {string} id
   * @returns {void}
   */
  _repositionView(id) {
    const view = this._views.get(id);
    const pos = this._layout.get(id);
    if (!view || !pos) return;
    const pixels = cellToPixels(pos.col, pos.row);
    view.setPixelPosition(pixels.x, pixels.y);
  }

  // ---------------------------------------------------------------
  // Selection
  // ---------------------------------------------------------------

  /** @returns {void} */
  _wireSelectionEvents() {
    eventBus.on("desktop:iconSelected", ({ id }) => this._views.get(id)?.setSelected(true));
    eventBus.on("desktop:iconDeselected", ({ id }) => this._views.get(id)?.setSelected(false));
  }

  /**
   * Runs immediately on pointerdown, before it's known whether this
   * gesture becomes a click or a drag.
   * @param {string} id
   * @param {{additive: boolean}} options
   * @returns {void}
   */
  _handleIconPointerDown(id, options) {
    if (options.additive) {
      this._selection.toggle(id);
      this._pendingCollapseId = null;
      return;
    }

    if (this._selection.isSelected(id) && this._selection.getSelectedIds().length > 1) {
      this._pendingCollapseId = id;
    } else {
      this._selection.select(id, { additive: false });
      this._pendingCollapseId = null;
    }
  }

  /**
   * Runs on pointerup only when no drag occurred — i.e. a genuine
   * click. Finishes the deferred collapse from _handleIconPointerDown,
   * then checks whether this click completes a "slow second click"
   * rename gesture.
   * @param {string} id
   * @param {{additive: boolean}} options
   * @returns {void}
   */
  _handleIconClick(id, options) {
    // Explicit focus call, not a reliance on the browser's native
    // "click focuses this element" behavior — Safari doesn't apply
    // that to plain divs at all, and even where it does apply,
    // relying on it silently ties keyboard shortcuts (Delete, F2) to
    // browser-specific default actions instead of to what actually
    // happened. Calling it directly means Delete/F2 work identically
    // everywhere, immediately after any click.
    this._views.get(id)?.focus();

    if (options.additive) {
      this._lastClickId = null;
      return;
    }

    if (this._pendingCollapseId === id) {
      this._selection.select(id, { additive: false });
    }
    this._pendingCollapseId = null;

    if (this._prefs["desktop.openItemsWith"] === "singleClick") {
      // A plain click opens; the slow-second-click rename gesture would
      // be indistinguishable from opening twice, so F2 renames instead.
      // The second click of a habitual double-click must not open the
      // item again (multi-instance apps would get a second window).
      const now = Date.now();
      const isRepeat = this._lastOpenedId === id && now - this._lastOpenedTime < SINGLE_CLICK_REPEAT_GUARD_MS;
      this._lastClickId = null;
      this._lastOpenedId = id;
      this._lastOpenedTime = now;
      if (!isRepeat) this._openIcon(id);
      return;
    }

    this._maybeStartSlowClickRename(id);

    this._lastClickId = id;
    this._lastClickTime = Date.now();
  }

  /**
   * @param {string} id
   * @returns {void}
   */
  _handleIconDoubleClick(id) {
    // In single-click mode the first click of the pair already opened
    // the item; opening again would duplicate windows.
    if (this._prefs["desktop.openItemsWith"] === "singleClick") return;
    this._openIcon(id);
  }

  /**
   * @param {string} id
   * @returns {void}
   */
  _maybeStartSlowClickRename(id) {
    if (this._lastClickId !== id) return;
    const elapsed = Date.now() - this._lastClickTime;
    if (elapsed < SLOW_CLICK_MIN_MS || elapsed > SLOW_CLICK_MAX_MS) return;
    if (!this._getVfsEntry(id)) return; // shortcuts are never renameable
    const isSoleSelection = this._selection.getSelectedIds().length === 1 && this._selection.isSelected(id);
    if (!isSoleSelection) return;

    this._startRename(id);
    this._lastClickId = null;
  }

  /**
   * Pure focus tracking — deliberately does NOT touch selection.
   * Selection changes from keyboard navigation are applied explicitly
   * by _moveFocus() instead, so DOM focus events (including the ones
   * the browser fires as a side effect of clicking) can never
   * override click/Ctrl+click/drag selection decisions.
   * @param {string} id
   * @returns {void}
   */
  _handleFocusIn(id) {
    this._focusedId = id;
  }

  // ---------------------------------------------------------------
  // Opening icons
  // ---------------------------------------------------------------

  /**
   * @param {string} id
   * @returns {Promise<void>}
   */
  async _openIcon(id) {
    const shortcut = this._getShortcut(id);
    if (shortcut) {
      eventBus.emit("desktop:itemOpened", { id, kind: "shortcut" });
      this._appManager.launch(shortcut.appId).catch((error) => {
        console.error(`[DesktopManager] failed to launch "${shortcut.appId}":`, error);
      });
      return;
    }

    const entry = this._getVfsEntry(id);
    if (!entry) return;

    eventBus.emit("desktop:itemOpened", {
      id,
      kind: entry.type === "folder" ? "vfs-folder" : "vfs-file",
      path: entry.path,
    });

    try {
      await openVfsEntry(entry, { appManager: this._appManager, recentFilesService: this._recentFilesService });
    } catch (error) {
      await this._showErrorDialog("Couldn't open item", error.message);
    }
  }

  // ---------------------------------------------------------------
  // Dragging (single or multi)
  // ---------------------------------------------------------------

  /**
   * Fired once, when the leader icon's drag crosses the threshold.
   * If that icon is part of a multi-selection, the whole selection
   * drags together; otherwise only the leader moves.
   * @param {string} leaderId
   * @returns {void}
   */
  _handleDragStart(leaderId) {
    const selected = this._selection.getSelectedIds();
    const group = selected.includes(leaderId) && selected.length > 1 ? selected : [leaderId];

    this._dragGroup = group;
    this._dragOrigins.clear();

    for (const id of group) {
      const pos = this._layout.get(id);
      if (!pos) continue;
      const pixels = cellToPixels(pos.col, pos.row);
      this._dragOrigins.set(id, { col: pos.col, row: pos.row, pixelX: pixels.x, pixelY: pixels.y });
      this._views.get(id)?.setDragging(true);
    }
  }

  /**
   * @param {string} leaderId
   * @param {number} dx
   * @param {number} dy
   * @returns {void}
   */
  _handleDragMove(leaderId, dx, dy) {
    if (this._dragRafId !== null) cancelAnimationFrame(this._dragRafId);

    this._dragRafId = requestAnimationFrame(() => {
      this._dragRafId = null;

      const bounds = this._container.getBoundingClientRect();
      const cellSize = getCellSize();
      const maxX = Math.max(0, bounds.width - cellSize);
      const maxY = Math.max(0, bounds.height - cellSize);

      for (const id of this._dragGroup) {
        const origin = this._dragOrigins.get(id);
        const view = this._views.get(id);
        if (!origin || !view) continue;
        const x = Math.min(Math.max(origin.pixelX + dx, 0), maxX);
        const y = Math.min(Math.max(origin.pixelY + dy, 0), maxY);
        view.setPixelPosition(x, y);
      }
    });
  }

  /**
   * Snaps every dragged icon individually to its own nearest grid
   * cell, preserving relative spacing during the drag but resolving
   * collisions per icon on release. Any in-flight _handleDragMove
   * animation frame is cancelled first, so it can never overwrite the
   * snapped position with a stale, unsnapped one.
   * @param {string} leaderId
   * @param {number} dx
   * @param {number} dy
   * @returns {void}
   */
  _handleDragEnd(leaderId, dx, dy) {
    if (this._dragRafId !== null) {
      cancelAnimationFrame(this._dragRafId);
      this._dragRafId = null;
    }

    const group = this._dragGroup;
    if (group.length === 0) return;

    const bounds = this._container.getBoundingClientRect();
    const columns = getColumnCount(bounds.width);
    const rows = getRowCount(bounds.height);

    if (this._prefs["desktop.autoArrange"]) {
      this._finishAutoArrangeDrag(group, dx, dy, columns, rows);
      return;
    }

    const aligned = this._prefs["desktop.alignToGrid"];
    const occupiedByOthers = new Set();
    for (const [id, pos] of this._layout) {
      if (!group.includes(id)) occupiedByOthers.add(cellKey(pos.col, pos.row));
    }

    const claimed = new Set(occupiedByOthers);

    for (const id of group) {
      const origin = this._dragOrigins.get(id);
      const view = this._views.get(id);
      if (!origin || !view) continue;

      let finalCell;
      if (aligned) {
        const nearest = pixelsToNearestCell(origin.pixelX + dx, origin.pixelY + dy);
        const desired = clampCell(nearest.col, nearest.row, columns, rows);
        const desiredKey = cellKey(desired.col, desired.row);
        finalCell = claimed.has(desiredKey) ? { col: origin.col, row: origin.row } : desired;
        claimed.add(cellKey(finalCell.col, finalCell.row));
      } else {
        // Free placement: keep the exact drop point (clamped on screen).
        const exact = pixelsToCell(origin.pixelX + dx, origin.pixelY + dy);
        finalCell = clampCell(exact.col, exact.row, columns, rows);
      }

      this._layout.set(id, finalCell);
      view.setDragging(false);
      this._repositionView(id);

      eventBus.emit("desktop:iconMoved", { id, col: finalCell.col, row: finalCell.row });
    }

    // Manual dragging always switches the desktop to "custom" layout
    // mode — a subsequent Sort by Name/Type is still available on
    // demand, but new items no longer imply a sorted insertion point.
    this._sortMode = "custom";
    this._saveLayout();

    this._dragGroup = [];
    this._dragOrigins.clear();
  }

  /**
   * Auto arrange keeps icons packed, so a drop reorders instead of
   * placing: each dragged icon takes the packing slot under its drop
   * point and everything else keeps its relative order.
   * @param {string[]} group
   * @param {number} dx
   * @param {number} dy
   * @param {number} columns
   * @param {number} rows
   * @returns {void}
   */
  _finishAutoArrangeDrag(group, dx, dy, columns, rows) {
    const slotOf = (pos) => Math.round(pos.col) * rows + Math.round(pos.row);
    const ranked = [];
    for (const id of this._arrangeOrder()) {
      if (group.includes(id)) continue;
      ranked.push({ id, slot: slotOf(this._layout.get(id) ?? { col: 0, row: 0 }), dragged: 0 });
    }
    for (const id of group) {
      const origin = this._dragOrigins.get(id);
      this._views.get(id)?.setDragging(false);
      if (!origin) continue;
      const nearest = pixelsToNearestCell(origin.pixelX + dx, origin.pixelY + dy);
      const drop = clampCell(nearest.col, nearest.row, columns, rows);
      // Dragged icons sort just before the icon currently in that slot.
      ranked.push({ id, slot: slotOf(drop), dragged: -1 });
    }
    ranked.sort((a, b) => a.slot - b.slot || a.dragged - b.dragged);

    this._sortMode = "custom";
    this._arrangeIcons(ranked.map((entry) => entry.id));
    this._dragGroup = [];
    this._dragOrigins.clear();
  }

  // ---------------------------------------------------------------
  // Marquee (rectangle) selection + click-empty-to-deselect
  // ---------------------------------------------------------------

  /** @returns {void} */
  _wireContainerEvents() {
    this._container.addEventListener("pointerdown", (e) => this._onContainerPointerDown(e));
    this._container.addEventListener("contextmenu", (e) => this._onContainerContextMenu(e));
    this._container.addEventListener("keydown", (e) => this._onContainerKeyDown(e));
    // Files dragged in from the host computer are imported into /Desktop.
    this._container.addEventListener("dragover", (e) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    });
    this._container.addEventListener("drop", (e) => this._onHostFilesDropped(e));
  }

  /**
   * @param {DragEvent} e
   * @returns {Promise<void>}
   */
  async _onHostFilesDropped(e) {
    const files = [...(e.dataTransfer?.files ?? [])];
    if (files.length === 0) return;
    e.preventDefault();
    try {
      const { imported, skipped } = await importHostFiles(this._vfs, DESKTOP_VFS_PATH, files);
      // filesystem:fileCreated has already rendered the new icons.
      this._selection.setSelection(imported.map((entry) => this._vfsCompositeId(entry.id)));
      if (skipped.length > 0) {
        await this._showErrorDialog(
          "Some files weren't imported",
          skipped.map((item) => `${item.name}: ${item.reason}`).join("\n")
        );
      }
    } catch (error) {
      await this._showErrorDialog("Import failed", error.message);
    }
  }

  /**
   * @param {object} entry
   * @param {string} appId
   * @returns {Promise<void>}
   */
  async _openWith(entry, appId) {
    try {
      await openVfsEntry(entry, { appManager: this._appManager, recentFilesService: this._recentFilesService, appId });
    } catch (error) {
      await this._showErrorDialog("Couldn't open item", error.message);
    }
  }

  /**
   * @param {PointerEvent} e
   * @returns {void}
   */
  _onContainerPointerDown(e) {
    if (e.target !== this._container) return;
    if (e.button !== 0) return;

    const containerRect = this._container.getBoundingClientRect();
    const startX = e.clientX - containerRect.left;
    const startY = e.clientY - containerRect.top;
    const additive = e.ctrlKey || e.metaKey;
    const preDragSelection = new Set(this._selection.getSelectedIds());

    if (!this._prefs["desktop.rectangleSelection"]) {
      // Clicking empty space still clears the selection (unless Ctrl is
      // held); only the drag-to-select rectangle is disabled.
      if (!additive) this._selection.clear();
      return;
    }

    this._marqueeEl = createElement("div", { className: "desktop-marquee" });
    this._container.append(this._marqueeEl);

    /**
     * @param {number} currentX
     * @param {number} currentY
     * @returns {void}
     */
    const applySelectionForPoint = (currentX, currentY) => {
      const rectLeft = Math.min(startX, currentX);
      const rectTop = Math.min(startY, currentY);
      const rectWidth = Math.abs(currentX - startX);
      const rectHeight = Math.abs(currentY - startY);

      if (this._marqueeEl) {
        this._marqueeEl.style.left = `${rectLeft}px`;
        this._marqueeEl.style.top = `${rectTop}px`;
        this._marqueeEl.style.width = `${rectWidth}px`;
        this._marqueeEl.style.height = `${rectHeight}px`;
      }

      const intersecting = this._getIconsIntersecting(rectLeft, rectTop, rectWidth, rectHeight, containerRect);
      const finalSet = additive ? new Set([...preDragSelection, ...intersecting]) : new Set(intersecting);
      this._selection.setSelection(finalSet);
    };

    // Apply once immediately, with a zero-size rect at the click
    // point. A plain stationary click never fires pointermove, so
    // without this, empty-desktop clicks would never reach the code
    // that clears selection.
    applySelectionForPoint(startX, startY);

    const onMove = (moveEvent) => {
      const currentX = Math.min(Math.max(moveEvent.clientX - containerRect.left, 0), containerRect.width);
      const currentY = Math.min(Math.max(moveEvent.clientY - containerRect.top, 0), containerRect.height);

      if (this._marqueeRafId !== null) cancelAnimationFrame(this._marqueeRafId);
      this._marqueeRafId = requestAnimationFrame(() => {
        this._marqueeRafId = null;
        applySelectionForPoint(currentX, currentY);
      });
    };

    const onUp = () => {
      if (this._marqueeRafId !== null) {
        cancelAnimationFrame(this._marqueeRafId);
        this._marqueeRafId = null;
      }
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      if (this._marqueeEl) {
        this._marqueeEl.remove();
        this._marqueeEl = null;
      }
      // Bug #1 fix: a rectangle selection never makes any icon the
      // pointerdown target, so DOM focus is left wherever it already
      // was — often nowhere inside the icon grid at all. Delete's
      // keydown listener is attached to the icon-grid container and
      // only fires for events that bubble up *from inside it*, so
      // without this, pressing Delete right after a marquee selection
      // silently did nothing, even though the selection itself
      // (SelectionManager) was completely correct.
      this._focusAfterMarquee();
    };

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }

  /**
   * @returns {void}
   */
  _focusAfterMarquee() {
    const selectedIds = this._selection.getSelectedIds();
    if (selectedIds.length === 0) return;
    const anchorId = selectedIds[selectedIds.length - 1];
    this._views.get(anchorId)?.focus();
  }

  /**
   * @param {number} rectLeft
   * @param {number} rectTop
   * @param {number} rectWidth
   * @param {number} rectHeight
   * @param {DOMRect} containerRect
   * @returns {string[]}
   */
  _getIconsIntersecting(rectLeft, rectTop, rectWidth, rectHeight, containerRect) {
    const ids = [];
    for (const [id, view] of this._views) {
      if (!this._isVisible(id)) continue;
      const elRect = view.getElement().getBoundingClientRect();
      const left = elRect.left - containerRect.left;
      const top = elRect.top - containerRect.top;
      const overlaps =
        left < rectLeft + rectWidth &&
        left + elRect.width > rectLeft &&
        top < rectTop + rectHeight &&
        top + elRect.height > rectTop;
      if (overlaps) ids.push(id);
    }
    return ids;
  }

  // ---------------------------------------------------------------
  // Context menus
  // ---------------------------------------------------------------

  /**
   * @param {MouseEvent} e
   * @returns {void}
   */
  _onContainerContextMenu(e) {
    if (e.target !== this._container) return;
    e.preventDefault();
    this._showDesktopContextMenu(e.clientX, e.clientY);
  }

  /**
   * @param {number} x
   * @param {number} y
   * @returns {void}
   */
  _showDesktopContextMenu(x, y) {
    const prefs = this._prefs;
    const iconSizeItem = (label, value) => ({
      label,
      checked: prefs["desktop.iconSize"] === value,
      radio: true,
      action: () => this._setPreference("desktop.iconSize", value),
    });
    const toggleItem = (label, key) => ({
      label,
      checked: Boolean(prefs[key]),
      action: () => this._setPreference(key, !prefs[key]),
    });

    const items = [
      {
        label: "View",
        submenu: [
          iconSizeItem("Large icons", "large"),
          iconSizeItem("Medium icons", "medium"),
          iconSizeItem("Small icons", "small"),
          { separator: true },
          toggleItem("Auto arrange icons", "desktop.autoArrange"),
          toggleItem("Align icons to grid", "desktop.alignToGrid"),
          { separator: true },
          toggleItem("Show icon labels", "desktop.showLabels"),
          toggleItem("Show desktop icons", "desktop.showIcons"),
        ],
      },
      {
        label: "Sort by",
        submenu: [
          { label: "Name", action: () => this._sortBy("name") },
          { label: "Type", action: () => this._sortBy("type") },
        ],
      },
      { label: "Arrange icons", action: () => this._arrangeIcons() },
      { label: "Refresh", action: () => this._refresh() },
      { separator: true },
      { label: "Paste", disabled: !this._clipboardService?.hasContent(), action: () => this._pasteIntoDesktop() },
      {
        label: "New",
        submenu: [
          { label: "Folder", action: () => this._createNewFolder() },
          { label: "Text Document", action: () => this._createNewTextDocument() },
        ],
      },
      { separator: true },
      {
        label: "Personalize",
        submenu: [
          { label: "Change wallpaper\u2026", action: () => this._openSettings("wallpaper") },
          { label: "Appearance settings\u2026", action: () => this._openSettings("appearance") },
          { label: "Desktop settings\u2026", action: () => this._openSettings("desktop") },
        ],
      },
    ];
    this._contextMenu.show(items, { x, y }, {
      onClose: () => eventBus.emit("desktop:contextMenuClosed", { target: "desktop" }),
    });
    eventBus.emit("desktop:contextMenuOpened", { target: "desktop", x, y });
  }

  /**
   * Open Settings on a specific page. Goes through AppManager like
   * every other launch, so the single-instance Settings window is
   * focused and navigated rather than duplicated.
   * @param {string} page
   * @returns {void}
   */
  _openSettings(page) {
    this._appManager.launch("settings", { page }).catch((error) => {
      console.error("[DesktopManager] failed to open Settings:", error);
    });
  }

  /**
   * @param {string} id
   * @param {number} x
   * @param {number} y
   * @returns {void}
   */
  _showIconContextMenu(id, x, y) {
    if (!this._selection.isSelected(id)) {
      this._selection.select(id, { additive: false });
    }

    const selectedIds = this._selection.getSelectedIds();
    const vfsEntries = selectedIds.map((sid) => this._getVfsEntry(sid)).filter(Boolean);
    const canRename = selectedIds.length === 1 && vfsEntries.length === 1;
    const canDelete = vfsEntries.length > 0;
    const canShowProperties = selectedIds.length === 1;

    const singleEntry = selectedIds.length === 1 ? vfsEntries[0] ?? null : null;
    const openWith = singleEntry ? buildOpenWithItems(singleEntry, (appId) => this._openWith(singleEntry, appId)) : [];
    const items = [
      { label: "Open", action: () => { for (const sid of selectedIds) this._openIcon(sid); } },
      ...(openWith.length > 0 ? [{ label: "Open with", submenu: openWith }] : []),
      { separator: true },
      { label: "Rename", disabled: !canRename, action: () => this._startRename(selectedIds[0]) },
      { label: "Delete", disabled: !canDelete, action: () => this._deleteSelection() },
      { separator: true },
      { label: "Copy", disabled: vfsEntries.length === 0, action: () => this._copySelection() },
      { label: "Cut", disabled: vfsEntries.length === 0, action: () => this._cutSelection() },
      { separator: true },
      { label: "Properties", disabled: !canShowProperties, action: () => this._showProperties(id) },
    ];

    this._contextMenu.show(items, { x, y }, {
      onClose: () => eventBus.emit("desktop:contextMenuClosed", { target: "icon", id }),
    });
    eventBus.emit("desktop:contextMenuOpened", { target: "icon", id, x, y });
  }

  /**
   * @param {string} id
   * @returns {Promise<void>}
   */
  async _showProperties(id) {
    const shortcut = this._getShortcut(id);
    if (shortcut) {
      await showPropertiesDialog({
        title: shortcut.label,
        rows: [
          { label: "Application", value: shortcut.label },
          { label: "App ID", value: shortcut.appId },
          { label: "Type", value: "Application Shortcut" },
        ],
      });
      eventBus.emit("desktop:propertiesOpened", { id, kind: "shortcut" });
      return;
    }

    const entry = this._getVfsEntry(id);
    if (!entry) return;

    await showPropertiesDialog({
      title: entry.name,
      rows: [
        { label: "Name", value: entry.name },
        {
          label: "Type",
          value: entry.type === "folder" ? "Folder" : entry.extension ? `${entry.extension.toUpperCase()} File` : "File",
        },
        { label: "Location", value: DESKTOP_VFS_PATH },
        { label: "Size", value: formatBytes(entry.size) },
        { label: "Created", value: formatDate(entry.createdAt) },
        { label: "Modified", value: formatDate(entry.modifiedAt) },
        { label: "Read-only", value: entry.readOnly ? "Yes" : "No" },
        { label: "Hidden", value: entry.hidden ? "Yes" : "No" },
      ],
    });
    eventBus.emit("desktop:propertiesOpened", { id, kind: entry.type === "folder" ? "vfs-folder" : "vfs-file" });
  }

  /**
   * Shared error surface for anything that fails outside of inline
   * rename (which has its own inline error display). Reuses
   * PropertiesDialog rather than inventing a third dialog variant —
   * a titled message with a Details row is all an error needs.
   * @param {string} title
   * @param {string} message
   * @returns {Promise<void>}
   */
  async _showErrorDialog(title, message) {
    await showPropertiesDialog({ title, rows: [{ label: "Details", value: message }] });
  }

  // ---------------------------------------------------------------
  // Create new folder / text document
  // ---------------------------------------------------------------

  /** @returns {Promise<void>} */
  async _createNewFolder() {
    const existingNames = [...this._vfsEntries.values()].map((entry) => entry.name);
    const name = generateDefaultName("New Folder", null, existingNames);

    try {
      const folder = await this._vfs.createFolder(`${DESKTOP_VFS_PATH}/${name}`);
      // The filesystem:folderCreated listener (_handleMembershipEvent)
      // has already rendered and positioned the icon by the time this
      // await resolves — selecting/renaming here never duplicates it.
      const compositeId = this._vfsCompositeId(folder.id);
      this._selection.select(compositeId, { additive: false });
      this._startRename(compositeId);
    } catch (error) {
      await this._showErrorDialog("Couldn't create folder", error.message);
    }
  }

  /** @returns {Promise<void>} */
  async _createNewTextDocument() {
    const existingNames = [...this._vfsEntries.values()].map((entry) => entry.name);
    const name = generateDefaultName("New Text Document", "txt", existingNames);

    try {
      const file = await this._vfs.createFile(`${DESKTOP_VFS_PATH}/${name}`, "");
      const compositeId = this._vfsCompositeId(file.id);
      this._selection.select(compositeId, { additive: false });
      this._startRename(compositeId);
    } catch (error) {
      await this._showErrorDialog("Couldn't create document", error.message);
    }
  }

  // ---------------------------------------------------------------
  // Rename
  // ---------------------------------------------------------------

  /**
   * @param {string} compositeId
   * @returns {void}
   */
  _startRename(compositeId) {
    const entry = this._getVfsEntry(compositeId);
    if (!entry) return; // shortcuts are never renameable
    const view = this._views.get(compositeId);
    if (!view || view.isRenaming()) return;

    const { stem, extension } = splitNameForRename(entry.name);
    view.startRename({
      stem,
      extension,
      onConfirm: (newName) => this._confirmRename(compositeId, newName),
      onCancel: () => {},
    });
  }

  /**
   * @param {string} compositeId
   * @param {string} newName
   * @returns {Promise<boolean>} true to exit rename mode, false to stay (an error is already shown).
   */
  async _confirmRename(compositeId, newName) {
    const view = this._views.get(compositeId);
    const entry = this._getVfsEntry(compositeId);
    if (!entry || !view) return true;

    const trimmed = newName.trim();
    if (trimmed.length === 0) {
      view.showRenameError("Name cannot be empty");
      return false;
    }
    if (trimmed === entry.name) {
      return true; // No-op rename \u2014 just exit rename mode cleanly.
    }

    try {
      await this._vfs.rename(entry.path, trimmed);
      // filesystem:fileRenamed's listener (_handleRenameEvent) updates
      // the label and our cache — nothing else to do here.
      return true;
    } catch (error) {
      view.showRenameError(error.message);
      return false;
    }
  }

  // ---------------------------------------------------------------
  // Delete
  // ---------------------------------------------------------------

  /** @returns {Promise<void>} */
  async _deleteSelection() {
    const selected = this._selection.getSelectedIds();
    const deletableEntries = selected.map((id) => this._getVfsEntry(id)).filter(Boolean);
    if (deletableEntries.length === 0) return; // Only shortcuts (or nothing) selected \u2014 nothing to delete.

    const confirmMode = this._prefs["desktop.confirmTrash"];
    const isNonEmptyFolder = deletableEntries.length === 1 && (await this._anyNonEmptyFolder(deletableEntries));
    const needsConfirmation =
      confirmMode === "always" || (confirmMode === "smart" && (deletableEntries.length > 1 || isNonEmptyFolder));

    if (needsConfirmation) {
      let message;
      if (deletableEntries.length > 1) {
        message = `Move ${deletableEntries.length} items to Trash?`;
      } else if (isNonEmptyFolder) {
        message = `"${deletableEntries[0].name}" is not empty. Move it and everything inside to Trash?`;
      } else {
        message = `Move "${deletableEntries[0].name}" to Trash?`;
      }
      const confirmed = await showConfirmDialog({
        title: "Delete",
        message,
        confirmLabel: "Move to Trash",
        destructive: true,
      });
      if (!confirmed) return;
    }

    for (const entry of deletableEntries) {
      try {
        await this._vfs.delete(entry.path);
        // filesystem:fileDeleted's listener (_handleMembershipEvent)
        // removes the icon — nothing else to do here.
      } catch (error) {
        await this._showErrorDialog(`Couldn't delete "${entry.name}"`, error.message);
      }
    }
  }

  /**
   * @param {object[]} entries
   * @returns {Promise<boolean>}
   */
  async _anyNonEmptyFolder(entries) {
    for (const entry of entries) {
      if (entry.type === "folder") {
        const children = await this._vfs.list(entry.path);
        if (children.length > 0) return true;
      }
    }
    return false;
  }

  // ---------------------------------------------------------------
  // Copy / cut / paste (shared ClipboardService with File Explorer)
  // ---------------------------------------------------------------

  /** @returns {void} */
  _copySelection() {
    if (!this._clipboardService) return;
    const entries = this._selection.getSelectedIds().map((id) => this._getVfsEntry(id)).filter(Boolean);
    if (entries.length === 0) return;
    this._clipboardService.setCopy(entries);
  }

  /** @returns {void} */
  _cutSelection() {
    if (!this._clipboardService) return;
    const entries = this._selection.getSelectedIds().map((id) => this._getVfsEntry(id)).filter(Boolean);
    if (entries.length === 0) return;
    this._clipboardService.setCut(entries);
  }

  /** @returns {Promise<void>} */
  async _pasteIntoDesktop() {
    if (!this._clipboardService?.hasContent()) return;
    const { errors } = await pasteClipboard(this._vfs, this._clipboardService, DESKTOP_VFS_PATH);
    if (errors.length > 0) {
      await this._showErrorDialog(
        "Some items couldn't be pasted",
        errors.map((error) => `${error.path}: ${error.message}`).join("\n")
      );
    }
    // filesystem:fileCreated/fileCopied/fileMoved listeners
    // (_handleMembershipEvent) render the pasted icons — nothing
    // else to do here.
  }

  // ---------------------------------------------------------------
  // VFS event integration
  // ---------------------------------------------------------------

  /** @returns {void} */
  _wireVfsEvents() {
    eventBus.on("filesystem:fileCreated", ({ entry }) => this._handleMembershipEvent(entry));
    eventBus.on("filesystem:folderCreated", ({ entry }) => this._handleMembershipEvent(entry));
    eventBus.on("filesystem:fileCopied", ({ entry }) => this._handleMembershipEvent(entry));
    eventBus.on("filesystem:fileMoved", ({ entry }) => this._handleMembershipEvent(entry));
    eventBus.on("filesystem:fileDeleted", ({ entry }) => this._handleMembershipEvent(entry));
    eventBus.on("filesystem:fileRenamed", ({ entry }) => this._handleRenameEvent(entry));
    eventBus.on("filesystem:fileModified", ({ entry }) => this._handleModifiedEvent(entry));
  }

  /** @returns {void} */
  _wireClipboardEvents() {
    eventBus.on("clipboard:changed", () => this._refreshCutVisuals());
  }

  /** @returns {void} */
  _refreshCutVisuals() {
    if (!this._clipboardService) return;
    for (const [compositeId, view] of this._views) {
      const entry = this._getVfsEntry(compositeId);
      view.setCut(entry ? this._clipboardService.isCut(entry.id) : false);
    }
  }

  /**
   * Handles any event that could change /Desktop's membership:
   * created, copied, moved, or (soft) deleted — deleting is
   * implemented as a move into /Trash, so it naturally flows through
   * the same "does this entry's parent match /Desktop?" check.
   * @param {object} entry
   * @returns {void}
   */
  _handleMembershipEvent(entry) {
    const isTrackedNow = this._vfsEntries.has(entry.id);
    const belongsToDesktopNow = this._desktopFolderId !== null && entry.parentId === this._desktopFolderId;

    if (belongsToDesktopNow && !isTrackedNow) {
      this._addVfsIcon(entry);
    } else if (!belongsToDesktopNow && isTrackedNow) {
      this._removeVfsIcon(entry.id);
    } else if (belongsToDesktopNow && isTrackedNow) {
      this._vfsEntries.set(entry.id, entry);
    }
  }

  /**
   * @param {object} entry
   * @returns {void}
   */
  _handleRenameEvent(entry) {
    if (!this._vfsEntries.has(entry.id)) return;
    const previous = this._vfsEntries.get(entry.id);
    this._vfsEntries.set(entry.id, entry);

    const compositeId = this._vfsCompositeId(entry.id);
    this._views.get(compositeId)?.setLabel(entry.name);
    // Position is deliberately untouched — renaming must not move the
    // icon — unless auto arrange is keeping the desktop sorted.
    if (this._prefs["desktop.autoArrange"] && this._sortMode !== "custom") this._arrangeIcons();

    eventBus.emit("desktop:itemRenamed", { id: compositeId, name: entry.name, previousName: previous?.name ?? null });
  }

  /**
   * Content-only change: keep the cached metadata fresh (so a later
   * Properties view shows the right size/modified time) without any
   * visible desktop change.
   * @param {object} entry
   * @returns {void}
   */
  _handleModifiedEvent(entry) {
    if (!this._vfsEntries.has(entry.id)) return;
    this._vfsEntries.set(entry.id, entry);
  }

  /**
   * @param {object} entry
   * @returns {void}
   */
  _addVfsIcon(entry) {
    this._vfsEntries.set(entry.id, entry);
    const compositeId = this._vfsCompositeId(entry.id);
    if (this._views.has(compositeId)) return; // Defensive: never render the same icon twice.

    this._renderVfsIcon(entry);
    this._assignPositionIfMissing(compositeId);
    if (!this._prefs["desktop.autoArrange"]) this._saveLayout();

    eventBus.emit("desktop:itemCreated", {
      id: compositeId,
      name: entry.name,
      path: entry.path,
      kind: entry.type === "folder" ? "vfs-folder" : "vfs-file",
    });
  }

  /**
   * @param {string} entryId
   * @returns {void}
   */
  _removeVfsIcon(entryId) {
    const compositeId = this._vfsCompositeId(entryId);
    const removedEntry = this._vfsEntries.get(entryId) ?? null;
    this._vfsEntries.delete(entryId);

    const view = this._views.get(compositeId);
    if (view) {
      view.destroy();
      this._views.delete(compositeId);
    }
    this._layout.delete(compositeId); // Releases the grid cell for reuse.
    this._selection.setSelection(new Set(this._selection.getSelectedIds().filter((id) => id !== compositeId)));
    if (this._prefs["desktop.autoArrange"]) {
      this._arrangeIcons();
    } else {
      this._saveLayout();
    }

    eventBus.emit("desktop:itemDeleted", { id: compositeId, name: removedEntry?.name ?? null });
  }

  // ---------------------------------------------------------------
  // Keyboard navigation
  // ---------------------------------------------------------------

  /**
   * Container-scoped: arrow/enter/F2/delete only make sense when an
   * icon actually has focus, so it's correct for these to rely on
   * event bubbling from a focused icon. Escape is handled separately
   * at the document level (see _onGlobalKeyDown) because it must
   * work even when no icon is focused.
   * @param {KeyboardEvent} e
   * @returns {void}
   */
  _onContainerKeyDown(e) {
    // Inline rename inputs live inside the icon layer; their keys are
    // text editing, never desktop shortcuts.
    if (keyboardShortcuts.isEditableTarget(e.target)) return;
    const shortcut = (id) => keyboardShortcuts.matches(e, id);

    if (shortcut("desktop.selectAll")) {
      e.preventDefault();
      this._selection.setSelection(this._getAllCompositeIds().filter((id) => this._isVisible(id)));
    } else if (shortcut("desktop.copy")) {
      e.preventDefault();
      this._copySelection();
    } else if (shortcut("desktop.cut")) {
      e.preventDefault();
      this._cutSelection();
    } else if (shortcut("desktop.paste")) {
      e.preventDefault();
      this._pasteIntoDesktop();
    } else if (shortcut("desktop.refresh")) {
      e.preventDefault();
      this._refresh();
    } else if (shortcut("desktop.navigate")) {
      e.preventDefault();
      this._moveFocus(e.key);
    } else if (shortcut("desktop.open")) {
      if (this._focusedId) {
        e.preventDefault();
        this._openIcon(this._focusedId);
      }
    } else if (shortcut("desktop.rename")) {
      e.preventDefault();
      this._tryStartRenameFromSelection();
    } else if (shortcut("desktop.delete")) {
      e.preventDefault();
      this._deleteSelection();
    }
  }

  /**
   * F2 renames only when exactly one renameable VFS entry is
   * selected — a mixed or multi-item selection is a no-op, not an
   * error.
   * @returns {void}
   */
  _tryStartRenameFromSelection() {
    const renameableIds = this._selection.getSelectedIds().filter((id) => this._getVfsEntry(id) !== null);
    if (renameableIds.length !== 1) return;
    this._startRename(renameableIds[0]);
  }

  /**
   * Bound to the global "desktop.clearSelection" shortcut (Escape).
   * Clears selection reliably regardless of what currently has focus.
   * Returning false when nothing is selected leaves the key unhandled
   * for anything else that wants it.
   * @returns {boolean}
   */
  _clearSelectionFromKeyboard() {
    if (this._selection.getSelectedIds().length === 0) return false;
    this._selection.clear();
    return true;
  }

  /**
   * @param {string} direction
   * @returns {void}
   */
  _moveFocus(direction) {
    const firstVisible = this._getAllCompositeIds().find((id) => this._isVisible(id));
    const currentId = this._focusedId && this._isVisible(this._focusedId) ? this._focusedId : firstVisible;
    if (!currentId) return;
    const nextId = this._findNextIconInDirection(currentId, direction) ?? currentId;
    const view = this._views.get(nextId);
    if (!view) return;
    view.focus();
    // Keyboard navigation is the one place selection intentionally
    // follows focus — applied explicitly here, not as a side effect
    // of the focusin event (see _handleFocusIn).
    this._selection.select(nextId, { additive: false });
  }

  /**
   * @param {string} currentId
   * @param {string} direction
   * @returns {string|null}
   */
  _findNextIconInDirection(currentId, direction) {
    const current = this._layout.get(currentId);
    if (!current) return null;

    let bestId = null;
    let bestScore = Infinity;

    for (const [id, pos] of this._layout) {
      if (id === currentId || !this._isVisible(id)) continue;
      let primary;
      let secondary;

      if (direction === "ArrowRight" && pos.col > current.col) {
        primary = pos.col - current.col;
        secondary = Math.abs(pos.row - current.row);
      } else if (direction === "ArrowLeft" && pos.col < current.col) {
        primary = current.col - pos.col;
        secondary = Math.abs(pos.row - current.row);
      } else if (direction === "ArrowDown" && pos.row > current.row) {
        primary = pos.row - current.row;
        secondary = Math.abs(pos.col - current.col);
      } else if (direction === "ArrowUp" && pos.row < current.row) {
        primary = current.row - pos.row;
        secondary = Math.abs(pos.col - current.col);
      } else {
        continue;
      }

      const score = primary * 1000 + secondary;
      if (score < bestScore) {
        bestScore = score;
        bestId = id;
      }
    }

    return bestId;
  }

  // ---------------------------------------------------------------
  // Refresh / Sort
  // ---------------------------------------------------------------

  /**
   * Re-reads /Desktop from the VFS and reconciles: removes stale
   * icons, adds newly discovered ones, updates renamed-in-place
   * metadata, and reclamps everything into the current viewport —
   * all without touching the desktop's own layout/selection any more
   * than necessary.
   * @returns {Promise<void>}
   */
  async _refresh() {
    try {
      const latestChildren = await this._vfs.list(DESKTOP_VFS_PATH);
      const latestIds = new Set(latestChildren.map((entry) => entry.id));

      for (const existingId of [...this._vfsEntries.keys()]) {
        if (!latestIds.has(existingId)) {
          this._removeVfsIcon(existingId);
        }
      }

      for (const entry of latestChildren) {
        if (this._vfsEntries.has(entry.id)) {
          this._vfsEntries.set(entry.id, entry);
          this._views.get(this._vfsCompositeId(entry.id))?.setLabel(entry.name);
        } else {
          this._addVfsIcon(entry);
        }
      }

      const changed = this._reclampAllPositions();
      if (changed) this._saveLayout();

      eventBus.emit("desktop:itemRefreshed", {});
    } catch (error) {
      await this._showErrorDialog("Couldn't refresh the desktop", error.message);
    }
  }

  /**
   * Fit every icon into the current grid bounds, without touching the
   * VFS at all. Used after a window resize or browser zoom (both shrink
   * or grow the desktop in CSS pixels) and after icon metrics change —
   * recomputing layout is cheap and purely local; it must never
   * trigger a VFS read (that's what "Refresh" is for).
   *
   * Icons that still fit keep their cells. With grid alignment, icons
   * that no longer fit — or that collide — move to the nearest free
   * cell, so shrinking the desktop never stacks icons on one cell.
   * Earlier icons (in column-major reading order) keep priority. Only
   * when every visible cell is taken do the remaining icons continue
   * past the edge, as a desktop with more icons than cells must. With
   * free placement, out-of-bounds icons are simply clamped on screen.
   * @returns {boolean} Whether anything actually moved.
   */
  _reclampAllPositions() {
    const bounds = this._container.getBoundingClientRect();
    const columns = getColumnCount(bounds.width);
    const rows = getRowCount(bounds.height);
    const aligned = this._prefs["desktop.alignToGrid"];
    let changed = false;

    const move = (compositeId, cell) => {
      this._layout.set(compositeId, cell);
      this._repositionView(compositeId);
      changed = true;
    };

    const ordered = [...this._layout.entries()].sort(
      ([, a], [, b]) => Math.round(a.col) - Math.round(b.col) || a.row - b.row
    );

    if (!aligned) {
      for (const [compositeId, pos] of ordered) {
        const clamped = clampCell(pos.col, pos.row, columns, rows);
        if (clamped.col !== pos.col || clamped.row !== pos.row) move(compositeId, clamped);
      }
      return changed;
    }

    const occupied = new Set();
    const displaced = [];
    for (const [compositeId, pos] of ordered) {
      const inBounds = pos.col >= 0 && pos.col < columns && pos.row >= 0 && pos.row < rows;
      const key = cellKey(pos.col, pos.row);
      if (inBounds && Number.isInteger(pos.col) && Number.isInteger(pos.row) && !occupied.has(key)) {
        occupied.add(key);
      } else {
        displaced.push([compositeId, clampCell(Math.round(pos.col), Math.round(pos.row), columns, rows)]);
      }
    }

    for (const [compositeId, target] of displaced) {
      const cell = findNearestFreeCell(target, occupied, columns, rows) ?? findNextFreeCell(occupied, rows);
      occupied.add(cellKey(cell.col, cell.row));
      const current = this._layout.get(compositeId);
      if (current.col !== cell.col || current.row !== cell.row) move(compositeId, cell);
    }
    return changed;
  }

  /**
   * @param {"name"|"type"} mode
   * @returns {void}
   */
  _sortBy(mode) {
    this._sortMode = mode;
    this._arrangeIcons();
  }

  /**
   * @returns {string[]} Every composite id in arrangement order: sorted by
   *   the current sort mode, or (in custom mode) in column-major reading
   *   order of the current layout.
   */
  _arrangeOrder() {
    const ids = this._getAllCompositeIds();
    if (this._sortMode === "name" || this._sortMode === "type") {
      const items = ids.map((compositeId) => {
        const shortcut = this._getShortcut(compositeId);
        if (shortcut) return { compositeId, name: shortcut.label, type: "application" };
        const entry = this._getVfsEntry(compositeId);
        return { compositeId, name: entry.name, type: entry.type === "folder" ? "folder" : entry.extension ?? "file" };
      });
      items.sort((a, b) => {
        if (this._sortMode === "type") {
          const typeCompare = a.type.localeCompare(b.type);
          if (typeCompare !== 0) return typeCompare;
        }
        return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
      });
      return items.map((item) => item.compositeId);
    }
    const positionOf = (id) => this._layout.get(id) ?? { col: Infinity, row: Infinity };
    return [...ids].sort((a, b) => {
      const pa = positionOf(a);
      const pb = positionOf(b);
      return Math.round(pa.col) - Math.round(pb.col) || pa.row - pb.row || pa.col - pb.col;
    });
  }

  /**
   * Pack icons into columns (top to bottom, then left to right).
   * Visible icons are packed first so hidden ones never leave gaps;
   * hidden icons keep cells after them, so showing them again never
   * collides.
   * @param {string[]} [order] - Explicit order; defaults to _arrangeOrder().
   * @returns {void}
   */
  _arrangeIcons(order = this._arrangeOrder()) {
    const bounds = this._container.getBoundingClientRect();
    const rows = getRowCount(bounds.height || window.innerHeight);
    const visible = order.filter((id) => this._isVisible(id));
    const hidden = order.filter((id) => !this._isVisible(id));

    [...visible, ...hidden].forEach((compositeId, index) => {
      this._layout.set(compositeId, { col: Math.floor(index / rows), row: index % rows });
      this._repositionView(compositeId);
    });

    this._saveLayout();
    eventBus.emit("desktop:iconsArranged", Object.freeze({ sortMode: this._sortMode }));
  }

  /**
   * Snap every icon to its nearest free cell, in reading order. Used
   * when "align to grid" is switched back on after free placement.
   * @returns {void}
   */
  _snapAllToGrid() {
    const bounds = this._container.getBoundingClientRect();
    const columns = getColumnCount(bounds.width);
    const rows = getRowCount(bounds.height);
    const occupied = new Set();

    for (const id of this._arrangeOrder()) {
      const pos = this._layout.get(id);
      if (!pos) continue;
      let cell = clampCell(Math.round(pos.col), Math.round(pos.row), columns, rows);
      if (occupied.has(cellKey(cell.col, cell.row))) cell = findNextFreeCell(occupied, rows);
      occupied.add(cellKey(cell.col, cell.row));
      this._layout.set(id, cell);
      this._repositionView(id);
    }
  }

  // ---------------------------------------------------------------
  // Resize handling
  // ---------------------------------------------------------------

  /** @returns {void} */
  _onWindowResize() {
    if (this._resizeTimeoutId !== null) window.clearTimeout(this._resizeTimeoutId);
    this._resizeTimeoutId = window.setTimeout(() => {
      if (this._prefs["desktop.autoArrange"]) {
        this._arrangeIcons();
      } else if (this._reclampAllPositions()) {
        this._saveLayout();
      }
    }, RESIZE_DEBOUNCE_MS);
  }
}

export { DesktopManager };
