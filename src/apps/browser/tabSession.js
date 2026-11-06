/**
 * @file TabSession — the tabs and navigation state of one Browser
 * window. Pure data: no DOM, no rendering backend, so the same model
 * works with any renderer (an iframe today, a native web view later).
 *
 * Each tab keeps its own session history:
 *   { id, entries: [{ url, title, favicon }], index, loading, state }
 * `state` is how the current entry is displayed: "page" (rendered),
 * "blocked" (the site refuses embedding), "error" (with `error`), or
 * "discarded" (unloaded to save resources; restored on activation).
 *
 * Closed tabs (up to 10) can be reopened with their history.
 *
 * Changes are reported through the `onChange(type, tabId)` callback:
 * "tabs" (added, removed, reordered, activated) or "tab" (one tab's
 * state changed).
 */

const MAX_CLOSED = 10;
const MAX_ENTRIES = 50;
let tabCounter = 0;

/**
 * @typedef {object} TabEntry
 * @property {string} url
 * @property {string} title
 * @property {string|null} favicon
 */

/**
 * @typedef {object} Tab
 * @property {string} id
 * @property {TabEntry[]} entries
 * @property {number} index
 * @property {boolean} loading
 * @property {"page"|"blocked"|"error"|"discarded"} state
 * @property {string|null} error
 * @property {boolean} navigatedInPage - The embedded page navigated by itself; its address isn't known.
 * @property {number} lastActive
 */

export class TabSession {
  /**
   * @param {{onChange: (type: "tabs"|"tab", tabId: string|null) => void}} options
   */
  constructor({ onChange }) {
    /** @type {Tab[]} */
    this.tabs = [];
    this.activeId = null;
    /** @type {Array<{entries: TabEntry[], index: number, position: number}>} */
    this.closed = [];
    this._onChange = onChange;
  }

  /**
   * @param {{url: string, title?: string, active?: boolean, index?: number, entries?: TabEntry[], entryIndex?: number}} options
   * @returns {Tab}
   */
  createTab({ url, title = "", active = true, index, entries, entryIndex }) {
    const tab = {
      id: `tab-${++tabCounter}`,
      entries: entries ? entries.map((entry) => ({ ...entry })) : [{ url, title, favicon: null }],
      index: entries ? Math.max(0, Math.min(entries.length - 1, entryIndex ?? entries.length - 1)) : 0,
      loading: false,
      state: "page",
      error: null,
      navigatedInPage: false,
      lastActive: Date.now(),
    };
    const position = Number.isInteger(index) ? Math.max(0, Math.min(this.tabs.length, index)) : this.tabs.length;
    this.tabs.splice(position, 0, tab);
    if (active || !this.activeId) this.activeId = tab.id;
    this._onChange("tabs", tab.id);
    return tab;
  }

  /**
   * @param {string} id
   * @returns {Tab|null}
   */
  get(id) {
    return this.tabs.find((tab) => tab.id === id) ?? null;
  }

  /** @returns {Tab|null} */
  active() {
    return this.get(this.activeId);
  }

  /**
   * @param {Tab} tab
   * @returns {TabEntry}
   */
  current(tab) {
    return tab.entries[tab.index];
  }

  /**
   * @param {string} id
   * @returns {void}
   */
  activate(id) {
    const tab = this.get(id);
    if (!tab || this.activeId === id) return;
    this.activeId = id;
    tab.lastActive = Date.now();
    this._onChange("tabs", id);
  }

  /**
   * Close a tab; the neighbor to its right (else left) becomes active.
   * @param {string} id
   * @returns {Tab|null} The closed tab.
   */
  closeTab(id) {
    const position = this.tabs.findIndex((tab) => tab.id === id);
    if (position === -1) return null;
    const [tab] = this.tabs.splice(position, 1);
    this.closed.unshift({ entries: tab.entries.map((entry) => ({ ...entry })), index: tab.index, position });
    this.closed.length = Math.min(this.closed.length, MAX_CLOSED);
    if (this.activeId === id) {
      const next = this.tabs[position] ?? this.tabs[position - 1] ?? null;
      this.activeId = next?.id ?? null;
      if (next) next.lastActive = Date.now();
    }
    this._onChange("tabs", id);
    return tab;
  }

  /** @returns {Tab|null} The reopened tab, or null when none was closed. */
  reopenClosed() {
    const closed = this.closed.shift();
    if (!closed) return null;
    return this.createTab({ entries: closed.entries, entryIndex: closed.index, index: closed.position, url: closed.entries[closed.index].url });
  }

  /**
   * @param {string} id
   * @returns {Tab|null} The copy, placed right after the original.
   */
  duplicate(id) {
    const tab = this.get(id);
    if (!tab) return null;
    const position = this.tabs.indexOf(tab) + 1;
    return this.createTab({ entries: tab.entries, entryIndex: tab.index, index: position, url: this.current(tab).url });
  }

  /**
   * @param {number} direction - 1 for the next tab, -1 for the previous one (wraps).
   * @returns {void}
   */
  cycle(direction) {
    if (this.tabs.length < 2) return;
    const position = this.tabs.findIndex((tab) => tab.id === this.activeId);
    const next = this.tabs[(position + direction + this.tabs.length) % this.tabs.length];
    this.activate(next.id);
  }

  /**
   * @param {string} id
   * @param {number} index
   * @returns {void}
   */
  move(id, index) {
    const from = this.tabs.findIndex((tab) => tab.id === id);
    if (from === -1) return;
    const to = Math.max(0, Math.min(this.tabs.length - 1, index));
    if (from === to) return;
    const [tab] = this.tabs.splice(from, 1);
    this.tabs.splice(to, 0, tab);
    this._onChange("tabs", id);
  }

  /**
   * Start a new navigation: forward history is dropped.
   * @param {string} id
   * @param {string} url
   * @returns {TabEntry|null}
   */
  navigate(id, url) {
    const tab = this.get(id);
    if (!tab) return null;
    const current = this.current(tab);
    if (current && current.url === url && !tab.navigatedInPage) {
      this._reset(tab);
      this._onChange("tab", id);
      return current;
    }
    tab.entries = tab.entries.slice(0, tab.index + 1);
    tab.entries.push({ url, title: "", favicon: null });
    if (tab.entries.length > MAX_ENTRIES) tab.entries.splice(0, tab.entries.length - MAX_ENTRIES);
    tab.index = tab.entries.length - 1;
    this._reset(tab);
    this._onChange("tab", id);
    return this.current(tab);
  }

  /**
   * Record that the page moved to a new address by itself (only known for
   * pages BrowserOS can read, i.e. its own origin).
   * @param {string} id
   * @param {string} url
   * @returns {void}
   */
  recordInPageNavigation(id, url) {
    const tab = this.get(id);
    if (!tab || this.current(tab).url === url) return;
    tab.entries = tab.entries.slice(0, tab.index + 1);
    tab.entries.push({ url, title: "", favicon: null });
    tab.index = tab.entries.length - 1;
    tab.navigatedInPage = false;
    this._onChange("tab", id);
  }

  /**
   * @param {string} id
   * @param {number} delta - -1 back, 1 forward.
   * @returns {TabEntry|null} The entry to show, or null when there's nowhere to go.
   */
  go(id, delta) {
    const tab = this.get(id);
    if (!tab) return null;
    const target = tab.index + delta;
    if (target < 0 || target >= tab.entries.length) return null;
    tab.index = target;
    this._reset(tab);
    this._onChange("tab", id);
    return this.current(tab);
  }

  /**
   * @param {Tab} tab
   * @returns {{back: boolean, forward: boolean}}
   */
  canGo(tab) {
    return { back: tab.index > 0, forward: tab.index < tab.entries.length - 1 };
  }

  /**
   * @param {string} id
   * @param {Partial<Tab>} patch
   * @returns {void}
   */
  updateTab(id, patch) {
    const tab = this.get(id);
    if (!tab) return;
    Object.assign(tab, patch);
    this._onChange("tab", id);
  }

  /**
   * @param {string} id
   * @param {Partial<TabEntry>} patch
   * @returns {void}
   */
  updateEntry(id, patch) {
    const tab = this.get(id);
    if (!tab) return;
    Object.assign(this.current(tab), patch);
    this._onChange("tab", id);
  }

  /**
   * @param {Tab} tab
   * @returns {void}
   */
  _reset(tab) {
    tab.state = "page";
    tab.error = null;
    tab.navigatedInPage = false;
  }
}
