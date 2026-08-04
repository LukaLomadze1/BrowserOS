/**
 * @file Desktop icon grid math. Pure functions only — DesktopManager
 * reasons about cell positions without touching layout directly.
 *
 * Grid dimensions are NOT duplicated as JS literals. They are read
 * once from the CSS custom properties (--icon-grid-inset,
 * --icon-grid-cell) defined in styles/variables.css, which is the
 * single source of truth both CSS and JS draw from. This is what
 * fixed Bug 1: two independently-maintained copies of the same
 * numbers could silently drift; reading the CSS value directly
 * makes drift impossible.
 */

const DEFAULT_GRID_INSET = 24;
const DEFAULT_CELL_SIZE = 96;

let cachedGridInset = null;
let cachedCellSize = null;

/**
 * @param {string} varName
 * @param {number} fallback
 * @returns {number}
 */
function readCssPixelVar(varName, fallback) {
  if (typeof document === "undefined") return fallback;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  const parsed = parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * @returns {number} The grid's outer inset in pixels, from --icon-grid-inset.
 */
export function getGridInset() {
  if (cachedGridInset === null) {
    cachedGridInset = readCssPixelVar("--icon-grid-inset", DEFAULT_GRID_INSET);
  }
  return cachedGridInset;
}

/**
 * @returns {number} The size of one grid cell in pixels, from --icon-grid-cell.
 */
export function getCellSize() {
  if (cachedCellSize === null) {
    cachedCellSize = readCssPixelVar("--icon-grid-cell", DEFAULT_CELL_SIZE);
  }
  return cachedCellSize;
}

/**
 * @param {number} col
 * @param {number} row
 * @returns {{x: number, y: number}} Top-left pixel position for a cell, always an integer.
 */
export function cellToPixels(col, row) {
  const inset = getGridInset();
  const cell = getCellSize();
  // Math.round guards against any future non-integer CSS values (e.g.
  // a rem-based token) ever reintroducing fractional-pixel drift.
  return { x: Math.round(inset + col * cell), y: Math.round(inset + row * cell) };
}

/**
 * @param {number} x
 * @param {number} y
 * @returns {{col: number, row: number}} Nearest cell to a raw pixel position.
 */
export function pixelsToNearestCell(x, y) {
  const inset = getGridInset();
  const cell = getCellSize();
  const col = Math.round((x - inset) / cell);
  const row = Math.round((y - inset) / cell);
  return { col: Math.max(0, col), row: Math.max(0, row) };
}

/**
 * @param {number} containerWidth
 * @returns {number} How many columns fit in the given width.
 */
export function getColumnCount(containerWidth) {
  const inset = getGridInset();
  const cell = getCellSize();
  return Math.max(1, Math.floor((containerWidth - inset) / cell));
}

/**
 * @param {number} containerHeight
 * @returns {number} How many rows fit in the given height.
 */
export function getRowCount(containerHeight) {
  const inset = getGridInset();
  const cell = getCellSize();
  return Math.max(1, Math.floor((containerHeight - inset) / cell));
}

/**
 * @param {number} col
 * @param {number} row
 * @param {number} columns
 * @param {number} rows
 * @returns {{col: number, row: number}} Cell clamped inside the grid bounds.
 */
export function clampCell(col, row, columns, rows) {
  return {
    col: Math.min(Math.max(col, 0), Math.max(0, columns - 1)),
    row: Math.min(Math.max(row, 0), Math.max(0, rows - 1)),
  };
}

/**
 * @param {number} col
 * @param {number} row
 * @returns {string} Stable key for a Set/Map of occupied cells.
 */
export function cellKey(col, row) {
  return `${col}:${row}`;
}

/**
 * Find the first free cell, filling top-to-bottom then wrapping to
 * the next column — the same order Windows fills desktop icons in.
 * @param {Set<string>} occupiedKeys
 * @param {number} rowsPerColumn
 * @returns {{col: number, row: number}}
 */
export function findNextFreeCell(occupiedKeys, rowsPerColumn) {
  const rows = Math.max(1, rowsPerColumn);
  let col = 0;
  let row = 0;
  while (occupiedKeys.has(cellKey(col, row))) {
    row += 1;
    if (row >= rows) {
      row = 0;
      col += 1;
    }
  }
  return { col, row };
}
