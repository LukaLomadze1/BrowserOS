/**
 * @file Start page shortcuts — the user's own quick links on the
 * Browser start page (up to 12), in their chosen order. There are no
 * built-in defaults: suggestions on the start page come from real
 * browsing history.
 *
 * Persisted through StorageService ("browser:shortcuts").
 * Events: "browser:shortcutsChanged" {}.
 */

import { eventBus } from "../eventBus.js";
import { storage } from "../storage.js";
import { createId } from "../vfs/entry.js";
import { fallbackTitle, isWebUrl } from "./urlUtils.js";

const SHORTCUTS_KEY = "browser:shortcuts";
export const MAX_SHORTCUTS = 12;

class ShortcutService {
  constructor() {
    /** @type {Array<{id: string, title: string, url: string}>|null} */
    this._items = null;
  }

  /** @returns {Array<{id: string, title: string, url: string}>} */
  list() {
    return this._load().map((item) => ({ ...item }));
  }

  /**
   * @param {{title?: string, url: string}} data
   * @returns {{id: string, title: string, url: string}}
   */
  add({ title, url }) {
    const items = this._load();
    if (items.length >= MAX_SHORTCUTS) throw new Error(`You can add up to ${MAX_SHORTCUTS} shortcuts`);
    const clean = validateShortcut(title, url);
    if (items.some((item) => item.url === clean.url)) throw new Error("There's already a shortcut for this address");
    const item = { id: createId(), ...clean };
    items.push(item);
    this._save();
    return { ...item };
  }

  /**
   * @param {string} id
   * @param {{title?: string, url?: string}} changes
   * @returns {void}
   */
  update(id, changes) {
    const items = this._load();
    const item = items.find((candidate) => candidate.id === id);
    if (!item) throw new Error("This shortcut no longer exists");
    const clean = validateShortcut(changes.title ?? item.title, changes.url ?? item.url);
    if (items.some((other) => other.id !== id && other.url === clean.url)) throw new Error("There's already a shortcut for this address");
    Object.assign(item, clean);
    this._save();
  }

  /**
   * @param {string} id
   * @returns {void}
   */
  remove(id) {
    const items = this._load();
    const index = items.findIndex((item) => item.id === id);
    if (index === -1) return;
    items.splice(index, 1);
    this._save();
  }

  /**
   * @param {string} id
   * @param {number} index - New position.
   * @returns {void}
   */
  move(id, index) {
    const items = this._load();
    const from = items.findIndex((item) => item.id === id);
    if (from === -1) return;
    const to = Math.max(0, Math.min(items.length - 1, index));
    if (from === to) return;
    const [item] = items.splice(from, 1);
    items.splice(to, 0, item);
    this._save();
  }

  /** @returns {Array<{id: string, title: string, url: string}>} */
  _load() {
    if (this._items) return this._items;
    const stored = storage.get(SHORTCUTS_KEY, []);
    this._items = [];
    if (Array.isArray(stored)) {
      for (const item of stored) {
        try {
          if (!item || typeof item.id !== "string") continue;
          const clean = validateShortcut(item.title, item.url);
          if (!this._items.some((existing) => existing.url === clean.url)) this._items.push({ id: item.id, ...clean });
        } catch {
          /* skip invalid stored shortcut */
        }
        if (this._items.length >= MAX_SHORTCUTS) break;
      }
    }
    return this._items;
  }

  /** @returns {void} */
  _save() {
    storage.set(SHORTCUTS_KEY, this._items);
    eventBus.emit("browser:shortcutsChanged", Object.freeze({}));
  }
}

/**
 * @param {*} title
 * @param {*} url
 * @returns {{title: string, url: string}}
 */
function validateShortcut(title, url) {
  let text = typeof url === "string" ? url.trim() : "";
  if (text && !/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`;
  if (!isWebUrl(text)) throw new Error("Enter a web address, such as example.com");
  const href = new URL(text).href;
  const name = typeof title === "string" ? title.replace(/\s+/g, " ").trim().slice(0, 40) : "";
  return { title: name || fallbackTitle(href), url: href };
}

/**
 * Singleton start-page shortcut store.
 * @type {ShortcutService}
 */
export const shortcutService = new ShortcutService();
