/**
 * @file Keyboard Shortcuts settings page: which global shortcut groups
 * are active, and a reference of every shortcut BrowserOS handles.
 *
 * The reference is rendered from keyboardShortcuts — the same registry
 * the handlers match against — and re-rendered whenever it reports a
 * change (a definition registered at runtime, a binding added, or a
 * keyboard setting toggled), so it can never list a shortcut that
 * doesn't work or miss one that does.
 */

import { createElement, clearElement } from "../../../utils/dom.js";
import { keyboardShortcuts } from "../../../core/keyboard/keyboardShortcuts.js";
import { SettingsPage } from "./settingsPage.js";

export default class KeyboardPage extends SettingsPage {
  /** @param {object} [context] */
  constructor(context) {
    super(
      {
        category: "keyboard",
        title: "Keyboard Shortcuts",
        intro: "Turn groups of global shortcuts on or off, and look up every shortcut BrowserOS supports.",
        resetLabel: "keyboard settings",
      },
      context
    );
  }

  /** @returns {HTMLElement[]} */
  buildSections() {
    const referenceEl = createElement("div", { className: "settings-shortcuts" });
    const render = () => this._renderReference(referenceEl);
    // keyboardShortcuts also notifies on keyboard.* setting changes.
    this.addCleanup(keyboardShortcuts.subscribe(render));
    render();

    return [
      this.section({
        anchor: "global",
        title: "Global shortcuts",
        description:
          "These work anywhere in BrowserOS. Shortcuts that are typing-safe also work while a text field is focused.",
        children: [
          this.toggleRow("keyboard.startMenuKey", "Windows / Meta key opens Start", "Press and release the key to toggle the Start Menu.").element,
          this.toggleRow(
            "keyboard.windowShortcuts",
            "Window management shortcuts",
            "Maximize, minimize, close, and switch windows from the keyboard."
          ).element,
          this.toggleRow(
            "keyboard.appShortcuts",
            "Application shortcuts",
            "Open Terminal, File Explorer, Settings, Task Manager, the Notification Center, and Quick Settings from anywhere."
          ).element,
        ],
      }),
      this.section({
        anchor: "reference",
        title: "Shortcut reference",
        description:
          "Shortcuts marked with a context apply only while that part of BrowserOS has keyboard focus. Text fields keep their normal editing keys, such as Ctrl + A to select text.",
        children: [referenceEl],
      }),
    ];
  }

  /**
   * @param {HTMLElement} container
   * @returns {void}
   */
  _renderReference(container) {
    if (this.isDestroyed()) return;
    clearElement(container);

    for (const group of keyboardShortcuts.getGroupedShortcuts()) {
      const headingId = `settings-shortcuts-${group.id}`;
      const rows = group.shortcuts.map((shortcut) =>
        createElement("tr", {
          className: shortcut.enabled ? "" : "settings-shortcuts__row--disabled",
          children: [
            createElement("td", {
              className: "settings-shortcuts__keys",
              children: shortcut.keys.flatMap((combo, index) => {
                const parts = combo.split(" + ").flatMap((part, partIndex) =>
                  partIndex === 0
                    ? [createElement("kbd", { className: "settings-kbd", text: part })]
                    : [createElement("span", { className: "settings-kbd-plus", attrs: { "aria-hidden": "true" }, text: "+" }), createElement("kbd", { className: "settings-kbd", text: part })]
                );
                return index === 0 ? parts : [createElement("span", { className: "settings-kbd-or", text: "or" }), ...parts];
              }),
            }),
            createElement("td", {
              className: "settings-shortcuts__description",
              children: [
                createElement("span", { text: shortcut.description }),
                ...(shortcut.enabled
                  ? []
                  : [createElement("span", { className: "settings-shortcuts__badge", text: "Off" })]),
              ],
            }),
            createElement("td", { className: "settings-shortcuts__context", text: shortcut.context }),
          ],
        })
      );

      container.append(
        createElement("div", {
          className: "settings-shortcuts__group",
          children: [
            createElement("h3", { className: "settings-subheading", attrs: { id: headingId }, text: group.label }),
            createElement("table", {
              className: "settings-shortcuts__table",
              attrs: { "aria-labelledby": headingId },
              children: [
                createElement("thead", {
                  className: "settings-visually-hidden",
                  children: [
                    createElement("tr", {
                      children: [
                        createElement("th", { attrs: { scope: "col" }, text: "Keys" }),
                        createElement("th", { attrs: { scope: "col" }, text: "Action" }),
                        createElement("th", { attrs: { scope: "col" }, text: "Where" }),
                      ],
                    }),
                  ],
                }),
                createElement("tbody", { children: rows }),
              ],
            }),
          ],
        })
      );
    }
  }
}
