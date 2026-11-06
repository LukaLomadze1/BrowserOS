/**
 * @file Minimal DOM creation helper.
 * Keeps element construction terse and consistent without pulling in
 * a templating library.
 */

/**
 * Create a DOM element with attributes, class names, and children in
 * one call.
 *
 * @param {string} tag - Tag name, e.g. "div".
 * @param {object} [options] - Configuration for the element.
 * @param {string} [options.className] - Space-separated class list.
 * @param {Object<string,string>} [options.attrs] - Attributes to set
 *   via setAttribute (use for aria-*, data-*, role, etc.). Attributes
 *   whose value is null or undefined are left out.
 * @param {string} [options.text] - Text content to set.
 * @param {Array<Node|string>} [options.children] - Child nodes or
 *   strings to append, in order.
 * @param {Object<string,Function>} [options.on] - Event listeners
 *   keyed by event name.
 * @returns {HTMLElement} The constructed element.
 */
export function createElement(tag, options = {}) {
  const el = document.createElement(tag);
  const { className, attrs, text, children, on } = options;

  if (className) {
    el.className = className;
  }

  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      // null / undefined mean "no attribute" (setAttribute would write "null").
      if (value !== null && value !== undefined) el.setAttribute(key, value);
    }
  }

  if (text !== undefined) {
    el.textContent = text;
  }

  if (children) {
    for (const child of children) {
      el.append(child);
    }
  }

  if (on) {
    for (const [eventName, handler] of Object.entries(on)) {
      if (typeof handler === "function") el.addEventListener(eventName, handler);
    }
  }

  return el;
}

/**
 * Remove every child node from an element.
 * @param {HTMLElement} el
 * @returns {void}
 */
export function clearElement(el) {
  while (el.firstChild) {
    el.removeChild(el.firstChild);
  }
}

/**
 * @param {KeyboardEvent} event
 * @returns {boolean} True while Ctrl, Alt, Meta or Shift is held: the key
 *   press belongs to a shortcut or a text selection, not to plain list or
 *   tab navigation, so components should let it through untouched.
 */
export function hasModifierKey(event) {
  return event.ctrlKey || event.altKey || event.metaKey || event.shiftKey;
}
