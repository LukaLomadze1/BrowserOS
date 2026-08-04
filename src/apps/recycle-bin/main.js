/**
 * @file Recycle Bin — a placeholder window for now. The Virtual File
 * System step is what will give this app something real to hold and
 * restore; until then it just proves the "open through AppManager"
 * path works for every desktop icon, including this one.
 */

import { Application } from "../../core/application.js";
import { createElement } from "../../utils/dom.js";
import { ensureStylesheet } from "../../utils/loadStylesheet.js";

ensureStylesheet("src/apps/recycle-bin/recycle-bin.css");

export default class RecycleBinApp extends Application {
  /** @returns {ReturnType<Application["launch"]>} */
  launch() {
    const element = createElement("div", {
      className: "recycle-bin",
      children: [
        createElement("div", { className: "recycle-bin__glyph", attrs: { "aria-hidden": "true" }, text: "\u267b" }),
        createElement("div", { className: "recycle-bin__message", text: "Recycle Bin is empty" }),
        createElement("p", {
          className: "recycle-bin__hint",
          text: "Deleted files will appear here once the file system is in place.",
        }),
      ],
    });

    return {
      element,
      title: "Recycle Bin",
      icon: "\u267b",
      width: 420,
      height: 340,
      minWidth: 320,
      minHeight: 260,
      resizable: true,
      minimizable: true,
      maximizable: true,
      closable: true,
    };
  }
}
