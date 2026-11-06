/**
 * @file Built-in line icons, and the one helper every shell component
 * uses to render an application or system icon.
 *
 * Icons throughout BrowserOS are either a text glyph ("✎") or a
 * reference to a built-in vector icon ("icon:clock"). Built-in icons
 * are drawn with `currentColor` on a 24 × 24 grid and sized in `em`,
 * so they take the color and size of the surrounding glyph styles and
 * follow theme and accent changes exactly like text glyphs do.
 *
 * The SVG elements are created with DOM APIs from the constant shapes
 * below; no markup strings are parsed and no external files are
 * loaded.
 */

const SVG_NS = "http://www.w3.org/2000/svg";

/** Prefix that marks an icon value as a built-in vector icon. */
export const ICON_PREFIX = "icon:";

/**
 * Shapes per icon: [tagName, attributes]. Strokes inherit width,
 * caps, and joins from the root <svg>; `fill: "currentColor"` marks a
 * solid shape.
 * @type {Readonly<Record<string, ReadonlyArray<[string, Record<string, string>]>>>}
 */
const SHAPES = Object.freeze({
  clock: [
    ["circle", { cx: "12", cy: "12.6", r: "8.4" }],
    ["path", { d: "M12 8.2v4.6l3.1 1.9" }],
    ["path", { d: "M4.6 5.3l2.4-2" }],
    ["path", { d: "M19.4 5.3l-2.4-2" }],
    ["circle", { cx: "12", cy: "12.8", r: "1.15", fill: "currentColor", stroke: "none" }],
  ],
  stopwatch: [
    ["circle", { cx: "12", cy: "13.5", r: "7.5" }],
    ["path", { d: "M10 2.8h4" }],
    ["path", { d: "M12 2.8v3.2" }],
    ["path", { d: "M12 13.5l3.2-3.2" }],
    ["path", { d: "M18.4 6.9l1.3-1.3" }],
  ],
  bell: [
    ["path", { d: "M6.2 16.6V11a5.8 5.8 0 0 1 11.6 0v5.6l1.6 1.8H4.6z" }],
    ["path", { d: "M10.1 20.6a2.1 2.1 0 0 0 3.8 0" }],
  ],
  "bell-off": [
    ["path", { d: "M8.1 6.4A5.8 5.8 0 0 1 17.8 11v5.1" }],
    ["path", { d: "M6.2 9.9v6.7l-1.6 1.8h12.9" }],
    ["path", { d: "M10.1 20.6a2.1 2.1 0 0 0 3.8 0" }],
    ["path", { d: "M3.5 3.5l17 17" }],
  ],
  sliders: [
    ["path", { d: "M4 7h9" }],
    ["path", { d: "M17 7h3" }],
    ["circle", { cx: "15", cy: "7", r: "2" }],
    ["path", { d: "M4 17h3" }],
    ["path", { d: "M11 17h9" }],
    ["circle", { cx: "9", cy: "17", r: "2" }],
  ],
  activity: [
    ["rect", { x: "3", y: "4", width: "18", height: "16", rx: "3" }],
    ["path", { d: "M6.5 13h2.6l1.7-4.2 2.6 7 1.8-2.8h2.3" }],
  ],
  calendar: [
    ["rect", { x: "3.5", y: "5", width: "17", height: "15.5", rx: "2.5" }],
    ["path", { d: "M3.5 9.8h17" }],
    ["path", { d: "M8 3v4" }],
    ["path", { d: "M16 3v4" }],
  ],
  info: [
    ["circle", { cx: "12", cy: "12", r: "8.5" }],
    ["path", { d: "M12 11v5.2" }],
    ["circle", { cx: "12", cy: "7.9", r: "1.1", fill: "currentColor", stroke: "none" }],
  ],
  success: [
    ["circle", { cx: "12", cy: "12", r: "8.5" }],
    ["path", { d: "M8.2 12.3l2.6 2.6 5-5.4" }],
  ],
  warning: [
    ["path", { d: "M12 3.8l8.7 15.2H3.3z" }],
    ["path", { d: "M12 9.6v4.4" }],
    ["circle", { cx: "12", cy: "16.6", r: "1.05", fill: "currentColor", stroke: "none" }],
  ],
  error: [
    ["circle", { cx: "12", cy: "12", r: "8.5" }],
    ["path", { d: "M9.2 9.2l5.6 5.6" }],
    ["path", { d: "M14.8 9.2l-5.6 5.6" }],
  ],
  moon: [["path", { d: "M19.5 14.6A7.6 7.6 0 0 1 9.4 4.5a7.6 7.6 0 1 0 10.1 10.1z" }]],
  sun: [
    ["circle", { cx: "12", cy: "12", r: "3.8" }],
    ["path", { d: "M12 2.8v2.1M12 19.1v2.1M2.8 12h2.1M19.1 12h2.1M5.5 5.5l1.5 1.5M17 17l1.5 1.5M5.5 18.5L7 17M17 7l1.5-1.5" }],
  ],
  speaker: [
    ["path", { d: "M4.5 9.5h3.2L12 6v12l-4.3-3.5H4.5z" }],
    ["path", { d: "M15.5 9.2a4 4 0 0 1 0 5.6" }],
    ["path", { d: "M17.9 6.8a7.4 7.4 0 0 1 0 10.4" }],
  ],
  layers: [
    ["path", { d: "M12 4l8.5 4.5L12 13 3.5 8.5z" }],
    ["path", { d: "M4.6 12.3L12 16.3l7.4-4" }],
    ["path", { d: "M4.6 15.9L12 19.9l7.4-4" }],
  ],
  motion: [
    ["circle", { cx: "15", cy: "12", r: "5" }],
    ["path", { d: "M3 9h4M2 12h4M3 15h4" }],
  ],
  eye: [
    ["path", { d: "M2.8 12s3.4-6.2 9.2-6.2 9.2 6.2 9.2 6.2-3.4 6.2-9.2 6.2S2.8 12 2.8 12z" }],
    ["circle", { cx: "12", cy: "12", r: "2.8" }],
  ],
  image: [
    ["rect", { x: "3.5", y: "4.5", width: "17", height: "15", rx: "2.5" }],
    ["circle", { cx: "9", cy: "9.6", r: "1.6" }],
    ["path", { d: "M4 17.2l5-4.6 3.6 3.2 2.6-2.2 4.8 4.1" }],
  ],
  display: [
    ["rect", { x: "3", y: "4.5", width: "18", height: "12", rx: "2" }],
    ["path", { d: "M9 20h6M12 16.5V20" }],
  ],
  gear: [
    ["circle", { cx: "12", cy: "12", r: "3.1" }],
    [
      "path",
      {
        d: "M12 3.2l1.4 2.3 2.6-.6.6 2.6 2.3 1.4-1.2 2.3 1.2 2.3-2.3 1.4-.6 2.6-2.6-.6L12 20.8l-1.4-2.3-2.6.6-.6-2.6-2.3-1.4 1.2-2.3-1.2-2.3 2.3-1.4.6-2.6 2.6.6z",
      },
    ],
  ],
  globe: [
    ["circle", { cx: "12", cy: "12", r: "8.5" }],
    ["path", { d: "M3.5 12h17" }],
    ["path", { d: "M12 3.5c2.4 2.3 3.6 5.1 3.6 8.5s-1.2 6.2-3.6 8.5c-2.4-2.3-3.6-5.1-3.6-8.5s1.2-6.2 3.6-8.5z" }],
  ],
  lock: [
    ["rect", { x: "5.5", y: "10.5", width: "13", height: "9.5", rx: "2" }],
    ["path", { d: "M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" }],
  ],
  "lock-open": [
    ["rect", { x: "5.5", y: "10.5", width: "13", height: "9.5", rx: "2" }],
    ["path", { d: "M8.5 10.5V8a3.5 3.5 0 0 1 6.8-1.2" }],
  ],
  shield: [
    ["path", { d: "M12 3.5l7 2.8v5.2c0 4.3-2.9 7.6-7 9-4.1-1.4-7-4.7-7-9V6.3z" }],
    ["path", { d: "M9.3 12.2l1.9 1.9 3.6-3.8" }],
  ],
  star: [["path", { d: "M12 4l2.4 5 5.4.6-4 3.7 1.1 5.4L12 16l-4.9 2.7 1.1-5.4-4-3.7 5.4-.6z" }]],
  "star-filled": [["path", { d: "M12 4l2.4 5 5.4.6-4 3.7 1.1 5.4L12 16l-4.9 2.7 1.1-5.4-4-3.7 5.4-.6z", fill: "currentColor" }]],
  download: [
    ["path", { d: "M12 4v11" }],
    ["path", { d: "M7.5 10.8L12 15.3l4.5-4.5" }],
    ["path", { d: "M5 19.5h14" }],
  ],
  arrowLeft: [["path", { d: "M19 12H5.5M11 6l-6 6 6 6" }]],
  arrowRight: [["path", { d: "M5 12h13.5M13 6l6 6-6 6" }]],
  reload: [
    ["path", { d: "M19.2 12a7.2 7.2 0 1 1-2.1-5.1" }],
    ["path", { d: "M19.5 4.5v4.2h-4.2" }],
  ],
  home: [
    ["path", { d: "M4.5 11L12 4.5l7.5 6.5" }],
    ["path", { d: "M6.5 9.5v10h4v-5.5h3v5.5h4v-10" }],
  ],
  plus: [["path", { d: "M12 5v14M5 12h14" }]],
  more: [
    ["circle", { cx: "6", cy: "12", r: "1.3", fill: "currentColor", stroke: "none" }],
    ["circle", { cx: "12", cy: "12", r: "1.3", fill: "currentColor", stroke: "none" }],
    ["circle", { cx: "18", cy: "12", r: "1.3", fill: "currentColor", stroke: "none" }],
  ],
  sidebar: [
    ["rect", { x: "3.5", y: "4.5", width: "17", height: "15", rx: "2.5" }],
    ["path", { d: "M9.5 4.5v15" }],
  ],
  folder: [["path", { d: "M3.5 7.5a2 2 0 0 1 2-2h3.8l2 2.2h7.2a2 2 0 0 1 2 2v7.8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" }]],
  search: [
    ["circle", { cx: "10.5", cy: "10.5", r: "6" }],
    ["path", { d: "M15 15l5 5" }],
  ],
  external: [
    ["path", { d: "M13.5 4.5h6v6" }],
    ["path", { d: "M19.5 4.5L11 13" }],
    ["path", { d: "M17.5 14v4a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 18V8A1.5 1.5 0 0 1 6 6.5h4" }],
  ],
  history: [
    ["path", { d: "M4.8 12a7.2 7.2 0 1 0 2.1-5.1" }],
    ["path", { d: "M4.5 4.5v4.2h4.2" }],
    ["path", { d: "M12 8.2v4.1l2.8 1.7" }],
  ],
  bookmark: [["path", { d: "M7 4.5h10v15.5l-5-3.6-5 3.6z" }]],
  edit: [
    ["path", { d: "M5 19l1-4.2L15.6 5.2a1.8 1.8 0 0 1 2.6 0l.6.6a1.8 1.8 0 0 1 0 2.6L9.2 18z" }],
    ["path", { d: "M13.8 7l3.2 3.2" }],
  ],
  trash: [
    ["path", { d: "M4.5 7h15" }],
    ["path", { d: "M9.5 7V5h5v2" }],
    ["path", { d: "M6.5 7l1 12.5h9l1-12.5" }],
  ],
  file: [
    ["path", { d: "M6.5 3.5h7l4 4v13h-11z" }],
    ["path", { d: "M13.5 3.5v4h4" }],
  ],
  chevronDown: [["path", { d: "M6 9.5l6 6 6-6" }]],
  chevronUp: [["path", { d: "M6 14.5l6-6 6 6" }]],
  chevronLeft: [["path", { d: "M14.5 6l-6 6 6 6" }]],
  chevronRight: [["path", { d: "M9.5 6l6 6-6 6" }]],
  close: [["path", { d: "M6.5 6.5l11 11M17.5 6.5l-11 11" }]],
});

/**
 * @param {*} icon
 * @returns {boolean} Whether the value names a built-in vector icon that exists.
 */
export function isBuiltInIcon(icon) {
  return typeof icon === "string" && icon.startsWith(ICON_PREFIX) && Object.hasOwn(SHAPES, icon.slice(ICON_PREFIX.length));
}

/**
 * @returns {string[]} Names of every built-in icon (without the prefix).
 */
export function listBuiltInIcons() {
  return Object.keys(SHAPES);
}

/**
 * Build a built-in icon as an inline SVG element.
 * @param {string} name - Icon name, with or without the "icon:" prefix.
 * @returns {SVGSVGElement|null} Null when the icon doesn't exist.
 */
export function createSvgIcon(name) {
  const key = name.startsWith(ICON_PREFIX) ? name.slice(ICON_PREFIX.length) : name;
  const shapes = Object.hasOwn(SHAPES, key) ? SHAPES[key] : null;
  if (!shapes) return null;
  const svg = document.createElementNS(SVG_NS, "svg");
  for (const [attr, value] of Object.entries({
    class: "os-icon",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.9",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
    focusable: "false",
  })) {
    svg.setAttribute(attr, value);
  }
  svg.dataset.icon = key;
  for (const [tag, attrs] of shapes) {
    const shape = document.createElementNS(SVG_NS, tag);
    for (const [attr, value] of Object.entries(attrs)) shape.setAttribute(attr, value);
    svg.append(shape);
  }
  return svg;
}

/**
 * Put an icon into a container, replacing whatever it showed before.
 * Text glyphs are set as text; "icon:<name>" values become an inline
 * SVG; anything empty or unknown falls back to `fallback`.
 * @param {HTMLElement} container
 * @param {string|null|undefined} icon
 * @param {string} [fallback] - Glyph used when `icon` is empty or an unknown built-in name.
 * @returns {HTMLElement} The container.
 */
export function renderIcon(container, icon, fallback = "\u25a2") {
  container.replaceChildren();
  if (typeof icon === "string" && icon.startsWith(ICON_PREFIX)) {
    const svg = createSvgIcon(icon);
    if (svg) {
      container.append(svg);
      return container;
    }
    container.textContent = fallback;
    return container;
  }
  container.textContent = typeof icon === "string" && icon ? icon : fallback;
  return container;
}

/**
 * Create a `<span>` holding an icon.
 * @param {string|null|undefined} icon
 * @param {{className?: string, fallback?: string}} [options]
 * @returns {HTMLSpanElement}
 */
export function createIconElement(icon, { className = "", fallback = "\u25a2" } = {}) {
  const span = document.createElement("span");
  if (className) span.className = className;
  span.setAttribute("aria-hidden", "true");
  return renderIcon(span, icon, fallback);
}
