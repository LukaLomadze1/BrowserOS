/**
 * @file fileAssociations — the single registry that maps file
 * extensions to the applications that open them.
 *
 * vfsOpener consults it whenever any part of BrowserOS opens a file
 * (Desktop, File Explorer, Start Menu recent files and search, Terminal
 * `open`), and the "Open with" context menus list its handlers, so no
 * application or shell component keeps its own extension table.
 *
 * Applications are referenced by AppManager id; an association whose
 * app isn't registered is simply skipped by vfsOpener. Additional
 * associations can be registered at runtime with `register()`.
 */

import { eventBus } from "./eventBus.js";

/**
 * @typedef {object} FileAssociation
 * @property {string} appId - AppManager id of the handling application.
 * @property {string} label - Display name for "Open with" menus.
 * @property {ReadonlyArray<string>} extensions - Lower-case, without the dot.
 * @property {string} [description] - Human description of the file type.
 */

const FOLDER_ICON = "icon:folder";
const GENERIC_FILE_ICON = "icon:file";
const TYPE_ICONS = Object.freeze({
  note: "icon:notes",
  txt: "icon:file-text",
  md: "icon:file-text",
  log: "icon:file-text",
  csv: "icon:file-text",
  png: "icon:image",
  jpg: "icon:image",
  jpeg: "icon:image",
  webp: "icon:image",
  gif: "icon:image",
  svg: "icon:image",
  html: "icon:file-code",
  htm: "icon:file-code",
  css: "icon:file-code",
  js: "icon:file-code",
  mjs: "icon:file-code",
  json: "icon:file-code",
});

/** @type {ReadonlyArray<FileAssociation>} */
const BUILT_IN_ASSOCIATIONS = Object.freeze([
  Object.freeze({ appId: "notes", label: "Notes", extensions: Object.freeze(["note", "txt", "md"]), description: "Document" }),
  Object.freeze({ appId: "browser", label: "Browser", extensions: Object.freeze(["html", "htm"]), description: "Web page" }),
  Object.freeze({
    appId: "image-viewer",
    label: "Image Viewer",
    extensions: Object.freeze(["png", "jpg", "jpeg", "webp", "gif", "svg"]),
    description: "Image",
  }),
]);

class FileAssociations {
  constructor() {
    /** @type {FileAssociation[]} Earlier registrations are the default handler for an extension. */
    this._associations = [...BUILT_IN_ASSOCIATIONS];
  }

  /**
   * Add an association. Existing defaults are kept; a new handler for an
   * already-associated extension becomes an "Open with" alternative.
   * @param {FileAssociation} association
   * @returns {() => void} Removes the association.
   */
  register(association) {
    if (!association?.appId || !Array.isArray(association.extensions)) {
      throw new Error("[fileAssociations] register() requires appId and extensions");
    }
    const frozen = Object.freeze({
      ...association,
      extensions: Object.freeze(association.extensions.map((ext) => ext.toLowerCase().replace(/^\./, ""))),
    });
    this._associations.push(frozen);
    eventBus.emit("fileAssociations:changed", Object.freeze({ appId: frozen.appId }));
    return () => {
      const index = this._associations.indexOf(frozen);
      if (index === -1) return;
      this._associations.splice(index, 1);
      eventBus.emit("fileAssociations:changed", Object.freeze({ appId: frozen.appId }));
    };
  }

  /**
   * @param {object|string|null} entryOrExtension - A VFS entry, or an extension.
   * @returns {FileAssociation|null} The default handler, if any.
   */
  getDefault(entryOrExtension) {
    return this.getHandlers(entryOrExtension)[0] ?? null;
  }

  /**
   * @param {object|string|null} entryOrExtension
   * @returns {FileAssociation[]} Every handler, default first.
   */
  getHandlers(entryOrExtension) {
    const extension = toExtension(entryOrExtension);
    if (!extension) return [];
    return this._associations.filter((association) => association.extensions.includes(extension));
  }

  /**
   * @param {string} appId
   * @returns {string[]} Extensions an application is registered for.
   */
  getExtensionsFor(appId) {
    return [...new Set(this._associations.filter((a) => a.appId === appId).flatMap((a) => a.extensions))];
  }

  /**
   * @param {object} entry - A VFS entry.
   * @returns {string} The built-in icon for the entry's type ("icon:<name>", see utils/icons.js), shared by Desktop, File Explorer, and Start Menu.
   */
  getIcon(entry) {
    if (entry.type === "folder") return FOLDER_ICON;
    return TYPE_ICONS[(entry.extension ?? "").toLowerCase()] ?? GENERIC_FILE_ICON;
  }
}

/**
 * @param {object|string|null} entryOrExtension
 * @returns {string|null}
 */
function toExtension(entryOrExtension) {
  if (!entryOrExtension) return null;
  if (typeof entryOrExtension === "string") return entryOrExtension.toLowerCase().replace(/^\./, "");
  if (entryOrExtension.type === "folder") return null;
  return entryOrExtension.extension ? entryOrExtension.extension.toLowerCase() : null;
}

/**
 * Singleton association registry shared across the OS.
 * @type {FileAssociations}
 */
export const fileAssociations = new FileAssociations();
