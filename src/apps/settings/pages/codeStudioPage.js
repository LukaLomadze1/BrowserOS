/**
 * @file Code Studio settings page: editor theme, font, indentation,
 * line numbers, wrapping, auto-closing brackets, and live preview.
 * Options are codeStudio.* settings applied live by every Code Studio
 * window.
 */

import { createElement } from "../../../utils/dom.js";
import { EDITOR_FONTS } from "../../code-studio/editorFonts.js";
import { createButton } from "../settingsControls.js";
import { SettingsPage } from "./settingsPage.js";

export default class CodeStudioPage extends SettingsPage {
  /** @param {object} [context] */
  constructor(context) {
    super(
      {
        category: "codeStudio",
        title: "Code Studio",
        intro: "Editor appearance, indentation, and live preview for Code Studio.",
        resetLabel: "Code Studio settings",
      },
      context
    );
  }

  /** @returns {HTMLElement[]} */
  buildSections() {
    return [
      this.section({
        anchor: "appearance",
        title: "Editor appearance",
        description: "System follows the BrowserOS light or dark theme.",
        children: [
          this.segmentedRow("codeStudio.theme", "Editor theme", "", [
            { value: "system", label: "System" },
            { value: "dark", label: "Dark" },
            { value: "light", label: "Light" },
          ]).element,
          this.sliderRow("codeStudio.fontSize", "Font size", "Text size in the editor.", { unit: "px", unitLabel: "pixels" }).element,
          this.selectRow(
            "codeStudio.fontFamily",
            "Font",
            "Fonts that aren't installed fall back to the system monospace font.",
            EDITOR_FONTS.map((font) => ({ value: font.id, label: font.label }))
          ).element,
          this.toggleRow("codeStudio.lineNumbers", "Show line numbers", "Numbers in the gutter beside each line.").element,
          this.toggleRow("codeStudio.wordWrap", "Word wrap", "Wrap long lines instead of scrolling sideways. Alt + Z toggles it in the editor.").element,
        ],
      }),
      this.section({
        anchor: "editing",
        title: "Editing",
        children: [
          this.selectRow("codeStudio.tabWidth", "Tab width", "Columns per indentation level.", [
            { value: "2", label: "2 spaces" },
            { value: "4", label: "4 spaces" },
            { value: "8", label: "8 spaces" },
          ]).element,
          this.toggleRow("codeStudio.insertSpaces", "Indent with spaces", "Tab inserts spaces; turn off to insert tab characters.").element,
          this.toggleRow("codeStudio.autoCloseBrackets", "Auto-close brackets and quotes", "Typing ( [ { \" ' or ` also inserts its closing pair.").element,
        ],
      }),
      this.section({
        anchor: "preview",
        title: "Live preview",
        description: "The preview runs project pages in an isolated sandbox.",
        children: [
          this.toggleRow("codeStudio.autoPreview", "Update preview while typing", "When off, the preview updates when you save or select Run.").element,
          createElement("div", {
            className: "settings-section__actions",
            children: [
              createButton({
                label: "Open Code Studio",
                onClick: () => this.context?.appManager?.launch("code-studio").catch(() => {}),
              }),
            ],
          }),
        ],
      }),
    ];
  }
}
