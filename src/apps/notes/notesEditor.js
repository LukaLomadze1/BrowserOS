/**
 * @file NotesEditor — the editing surface Notes uses for both document
 * kinds:
 *
 *  - rich: a contenteditable element driven by `document.execCommand`.
 *    The command API is formally deprecated but still implemented by
 *    every browser, and it is the only way to apply formatting while
 *    keeping the browser's native undo/redo history intact. Checklists
 *    are `<ul data-checklist="true">` with `<li data-checked>`, drawn by
 *    CSS, so there are no form controls inside the editable region.
 *    Pasted HTML is sanitized before insertion.
 *  - plain: a textarea, so .txt and .md files are saved exactly as typed.
 *
 * The editor owns no persistence. It reports changes through `onInput`
 * and formatting-state changes through `onStateChange`; Notes decides
 * when to save.
 */

import { createElement } from "../../utils/dom.js";
import { sanitizeHtml, htmlToPlainText } from "./noteFormat.js";

const CHECKBOX_HIT_WIDTH = 26;

class NotesEditor {
  /**
   * @param {object} callbacks
   * @param {() => void} callbacks.onInput - Content changed.
   * @param {() => void} callbacks.onStateChange - Selection or formatting state may have changed.
   * @param {(currentHref: string|null) => Promise<string|null>} callbacks.onRequestLink - Ask for a URL; null cancels, "" removes the link.
   */
  constructor(callbacks) {
    this._callbacks = callbacks;
    this._kind = "rich";
    this._savedRange = null;
    this._selectionHandler = () => this._rememberSelection();

    this._rich = createElement("div", {
      className: "notes-editor__rich",
      attrs: { contenteditable: "true", role: "textbox", "aria-multiline": "true", "aria-label": "Note content", spellcheck: "true" },
      on: {
        input: (e) => this._handleRichInput(e),
        beforeinput: (e) => this._handleBeforeInput(e),
        paste: (e) => this._handlePaste(e),
        click: (e) => this._handleClick(e),
        keyup: () => this._callbacks.onStateChange(),
        mouseup: () => this._callbacks.onStateChange(),
      },
    });
    this._plain = createElement("textarea", {
      className: "notes-editor__plain",
      attrs: { "aria-label": "Note content", spellcheck: "true" },
      on: { input: () => this._callbacks.onInput() },
    });
    this._plain.hidden = true;

    this._el = createElement("div", { className: "notes-editor", children: [this._rich, this._plain] });
    document.addEventListener("selectionchange", this._selectionHandler);
  }

  /** @returns {HTMLElement} */
  getElement() {
    return this._el;
  }

  /** @returns {"rich"|"plain"} */
  getKind() {
    return this._kind;
  }

  /**
   * Load a document. Resets the undo history for the new document.
   * @param {"rich"|"plain"} kind
   * @param {string} content - Sanitized HTML for rich, raw text for plain.
   * @returns {void}
   */
  setDocument(kind, content) {
    this._kind = kind;
    this._rich.hidden = kind !== "rich";
    this._plain.hidden = kind !== "plain";
    this._savedRange = null;
    if (kind === "rich") {
      this._rich.innerHTML = sanitizeHtml(content);
      this._plain.value = "";
    } else {
      this._plain.value = content;
      this._rich.innerHTML = "";
    }
  }

  /**
   * @returns {string} Current content: sanitized HTML (rich) or text (plain).
   */
  getContent() {
    return this._kind === "rich" ? sanitizeHtml(this._rich.innerHTML) : this._plain.value;
  }

  /**
   * @returns {string} Plain text of the current content, for counts and search.
   */
  getPlainText() {
    return this._kind === "rich" ? htmlToPlainText(this._rich.innerHTML) : this._plain.value;
  }

  /**
   * @param {boolean} editable
   * @returns {void}
   */
  setEditable(editable) {
    this._rich.setAttribute("contenteditable", editable ? "true" : "false");
    this._plain.readOnly = !editable;
    this._el.classList.toggle("notes-editor--readonly", !editable);
  }

  /**
   * @param {string} placeholder
   * @returns {void}
   */
  setPlaceholder(placeholder) {
    this._rich.dataset.placeholder = placeholder;
    this._plain.placeholder = placeholder;
  }

  /** @returns {void} */
  focus() {
    (this._kind === "rich" ? this._rich : this._plain).focus({ preventScroll: true });
  }

  /**
   * @returns {{bold: boolean, italic: boolean, underline: boolean, strike: boolean, block: string, list: "ul"|"ol"|"checklist"|null, link: boolean}}
   */
  queryState() {
    const empty = { bold: false, italic: false, underline: false, strike: false, block: "p", list: null, link: false };
    if (this._kind !== "rich" || !this._selectionInsideRich()) return empty;
    const state = (command) => {
      try {
        return document.queryCommandState(command);
      } catch {
        return false;
      }
    };
    const list = this._closestAtSelection("ul, ol");
    let block = "p";
    const heading = this._closestAtSelection("h1, h2, h3");
    if (heading) block = heading.tagName.toLowerCase();
    return {
      bold: state("bold"),
      italic: state("italic"),
      underline: state("underline"),
      strike: state("strikeThrough"),
      block,
      list: list ? (list.dataset.checklist === "true" ? "checklist" : list.tagName.toLowerCase()) : null,
      link: Boolean(this._closestAtSelection("a")),
    };
  }

  /**
   * Run a formatting or history command against the current selection.
   * @param {"bold"|"italic"|"underline"|"strike"|"h1"|"h2"|"h3"|"p"|"ul"|"ol"|"checklist"|"link"|"undo"|"redo"} command
   * @returns {Promise<void>}
   */
  async exec(command) {
    if (command === "undo" || command === "redo") {
      this.focus();
      document.execCommand(command);
      this._afterCommand();
      return;
    }
    if (this._kind !== "rich") return;
    this._restoreSelection();

    switch (command) {
      case "bold":
      case "italic":
      case "underline":
        document.execCommand(command);
        break;
      case "strike":
        document.execCommand("strikeThrough");
        break;
      case "h1":
      case "h2":
      case "h3":
      case "p": {
        const current = this._closestAtSelection("h1, h2, h3");
        const target = current && current.tagName.toLowerCase() === command ? "p" : command;
        document.execCommand("formatBlock", false, `<${target}>`);
        break;
      }
      case "ul": {
        const checklist = this._closestAtSelection("ul[data-checklist]");
        if (checklist) {
          this._clearChecklist(checklist);
        } else {
          document.execCommand("insertUnorderedList");
        }
        break;
      }
      case "ol":
        document.execCommand("insertOrderedList");
        break;
      case "checklist":
        this._toggleChecklist();
        break;
      case "link":
        await this._editLink();
        return;
      default:
        return;
    }
    this._afterCommand();
  }

  /** @returns {void} */
  destroy() {
    document.removeEventListener("selectionchange", this._selectionHandler);
  }

  // ---------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------

  /** @returns {void} */
  _afterCommand() {
    this._callbacks.onInput();
    this._callbacks.onStateChange();
  }

  /**
   * @param {InputEvent} e
   * @returns {void}
   */
  _handleBeforeInput(e) {
    this._pendingParagraph = e.inputType === "insertParagraph";
  }

  /**
   * @param {InputEvent} e
   * @returns {void}
   */
  _handleRichInput(e) {
    // A new checklist item created with Enter copies its predecessor's
    // attributes, including a checked state; new items start unchecked.
    if (this._pendingParagraph || e.inputType === "insertParagraph") {
      const item = this._closestAtSelection("ul[data-checklist] > li");
      if (item) item.dataset.checked = "false";
    }
    this._pendingParagraph = false;
    this._callbacks.onInput();
  }

  /**
   * @param {ClipboardEvent} e
   * @returns {void}
   */
  _handlePaste(e) {
    const data = e.clipboardData;
    if (!data) return;
    e.preventDefault();
    const html = data.getData("text/html");
    if (html) {
      document.execCommand("insertHTML", false, sanitizeHtml(html));
    } else {
      document.execCommand("insertText", false, data.getData("text/plain"));
    }
  }

  /**
   * Checkbox clicks toggle items; Ctrl/⌘ + click opens links.
   * @param {MouseEvent} e
   * @returns {void}
   */
  _handleClick(e) {
    const link = e.target.closest?.("a[href]");
    if (link && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      window.open(link.getAttribute("href"), "_blank", "noopener,noreferrer");
      return;
    }
    const item = e.target.closest?.("li");
    if (!item || item.parentElement?.dataset.checklist !== "true" || this._rich.getAttribute("contenteditable") !== "true") return;
    if (e.clientX - item.getBoundingClientRect().left > CHECKBOX_HIT_WIDTH) return;
    e.preventDefault();
    item.dataset.checked = item.dataset.checked === "true" ? "false" : "true";
    this._callbacks.onInput();
  }

  /** @returns {void} */
  _toggleChecklist() {
    const existing = this._closestAtSelection("ul[data-checklist]");
    if (existing) {
      this._clearChecklist(existing);
      return;
    }
    if (!this._closestAtSelection("ul")) document.execCommand("insertUnorderedList");
    const list = this._closestAtSelection("ul");
    if (!list) return;
    list.dataset.checklist = "true";
    for (const item of list.querySelectorAll(":scope > li")) {
      if (item.dataset.checked !== "true") item.dataset.checked = "false";
    }
  }

  /**
   * @param {HTMLElement} list
   * @returns {void}
   */
  _clearChecklist(list) {
    list.removeAttribute("data-checklist");
    for (const item of list.querySelectorAll(":scope > li")) item.removeAttribute("data-checked");
  }

  /** @returns {Promise<void>} */
  async _editLink() {
    const existing = this._closestAtSelection("a");
    const range = this._savedRange?.cloneRange() ?? null;
    const url = await this._callbacks.onRequestLink(existing?.getAttribute("href") ?? null);
    if (url === null) return;

    this.focus();
    if (range) {
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }
    if (url === "") {
      if (existing) {
        const selection = window.getSelection();
        const linkRange = document.createRange();
        linkRange.selectNodeContents(existing);
        selection.removeAllRanges();
        selection.addRange(linkRange);
      }
      document.execCommand("unlink");
    } else if (window.getSelection()?.isCollapsed) {
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.textContent = url;
      document.execCommand("insertHTML", false, anchor.outerHTML);
    } else {
      document.execCommand("createLink", false, url);
    }
    this._afterCommand();
  }

  /** @returns {boolean} */
  _selectionInsideRich() {
    const selection = window.getSelection();
    return Boolean(selection && selection.rangeCount > 0 && this._rich.contains(selection.anchorNode));
  }

  /** @returns {void} */
  _rememberSelection() {
    if (this._kind !== "rich" || !this._selectionInsideRich()) return;
    this._savedRange = window.getSelection().getRangeAt(0).cloneRange();
    this._callbacks.onStateChange();
  }

  /**
   * Toolbar buttons take focus; put the caret back where it was before
   * running a command.
   * @returns {void}
   */
  _restoreSelection() {
    this._rich.focus({ preventScroll: true });
    if (this._savedRange && this._rich.contains(this._savedRange.startContainer)) {
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(this._savedRange);
    }
  }

  /**
   * @param {string} selector
   * @returns {HTMLElement|null} The closest matching ancestor of the selection, within the editor.
   */
  _closestAtSelection(selector) {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return null;
    let node = selection.anchorNode;
    if (node?.nodeType === Node.TEXT_NODE) node = node.parentElement;
    const match = node?.closest?.(selector) ?? null;
    return match && this._rich.contains(match) ? match : null;
  }
}

export { NotesEditor };
