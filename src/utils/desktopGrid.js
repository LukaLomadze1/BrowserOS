/**
 * @file Desktop icon grid math. Pure functions only — DesktopManager
 * reasons about cell positions without touching layout directly.
 *
 * Grid dimensions are never duplicated as independent literals.
 * DesktopManager computes them from the desktop settings
 * (utils/desktopMetrics.js), writes them to the icon layer's CSS
 * custom properties, and hands the same numbers to configureGrid(), so
 * CSS sizing and JS positioning cannot drift apart. Until
 * configureGrid() is called, the values are read once from the
 * --icon-grid-inset / --icon-grid-cell tokens in styles/variables.css.
 * All coordinates may be fractional when free placement (align to
 * grid off) is in use; cell occupancy always uses rounded cells.
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
 * Set the grid geometry explicitly. Called by DesktopManager whenever
 * icon size or grid spacing changes.
 * @param {{inset: number, cellSize: number}} metrics
 * @returns {void}
 */
export function configureGrid({ inset, cellSize }) {
  if (Number.isFinite(inset) && inset >= 0) cachedGridInset = inset;
  if (Number.isFinite(cellSize) && cellSize > 0) cachedCellSize = cellSize;
}

/**
 * @returns {number} The grid's outer inset in pixels.
 */
export function getGridInset() {
  if (cachedGridInset === null) {
    cachedGridInset = readCssPixelVar("--icon-grid-inset", DEFAULT_GRID_INSET);
  }
  return cachedGridInset;
}

/**
 * @returns {number} The size of one grid cell in pixels.
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
 * @returns {string} Stable key for a Set/Map of occupied cells. Fractional positions are keyed by their nearest cell.
 */
export function cellKey(col, row) {
  return `${Math.round(col)}:${Math.round(row)}`;
}

/**
 * @param {number} x
 * @param {number} y
 * @returns {{col: number, row: number}} Fractional cell coordinates for a raw pixel position (free placement).
 */
export function pixelsToCell(x, y) {
  const inset = getGridInset();
  const cell = getCellSize();
  return { col: Math.max(0, (x - inset) / cell), row: Math.max(0, (y - inset) / cell) };
}

/**
 * The free cell inside the grid closest to a target cell (Euclidean
 * distance; ties prefer the same column, then lower rows). Used to
 * re-home icons that no longer fit after the desktop shrinks.
 * @param {{col: number, row: number}} target
 * @param {Set<string>} occupiedKeys
 * @param {number} columns
 * @param {number} rows
 * @returns {{col: number, row: number}|null} Null when every cell in the grid is taken.
 */
export function findNearestFreeCell(target, occupiedKeys, columns, rows) {
  let best = null;
  let bestScore = Infinity;
  for (let col = 0; col < columns; col += 1) {
    for (let row = 0; row < rows; row += 1) {
      if (occupiedKeys.has(cellKey(col, row))) continue;
      const dc = col - target.col;
      const dr = row - target.row;
      const score = (dc * dc + dr * dr) * 4 + (dc === 0 ? 0 : 1);
      if (score < bestScore) {
        bestScore = score;
        best = { col, row };
      }
    }
  }
  return best;
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
