/**
 * @file Desktop icon metrics — the single table that turns the
 * `desktop.iconSize` and `desktop.gridSpacing` settings into concrete
 * pixel values.
 *
 * DesktopManager writes every value here to CSS custom properties on
 * the icon layer (for appearance) and passes the resulting cell size to
 * desktopGrid.configureGrid() (for positioning), so the size an icon is
 * drawn at and the grid it snaps to always come from the same numbers.
 *
 * An icon's height is derived from its contents — vertical padding,
 * glyph, gap, and two full label lines — rather than chosen by hand, so
 * a two-line name such as "About BrowserOS" is never clipped. The cell
 * size uses that labelled height, so toggling label visibility never
 * moves icons.
 */

/** Vertical padding inside an icon box, top and bottom. */
const PADDING_Y = 6;
/** Horizontal padding inside an icon box, left and right. */
const PADDING_X = 4;
/** Space between glyph and label. */
const GLYPH_LABEL_GAP = 3;
/** Label line height, as a multiple of the label font size. */
const LABEL_LINE_HEIGHT = 1.3;
/** Labels wrap to at most this many lines, then truncate with an ellipsis. */
const LABEL_LINES = 2;

const ICON_SIZES = Object.freeze({
  small: Object.freeze({ glyph: 40, glyphFont: 22, width: 76, labelFont: 10 }),
  medium: Object.freeze({ glyph: 48, glyphFont: 26, width: 84, labelFont: 11 }),
  large: Object.freeze({ glyph: 64, glyphFont: 34, width: 104, labelFont: 12 }),
});

const GRID_GAPS = Object.freeze({ compact: 0, normal: 8, spacious: 24 });

/** Outer margin between the desktop edge and the first grid cell. */
export const DESKTOP_GRID_INSET = 24;

/**
 * @typedef {object} DesktopMetrics
 * @property {number} glyph - Glyph box size in px.
 * @property {number} glyphFont - Glyph font size in px.
 * @property {number} width - Icon box width in px.
 * @property {number} height - Icon box height in px (with a two-line label).
 * @property {number} labelFont - Label font size in px.
 * @property {number} labelLineHeight - Label line-height multiplier.
 * @property {number} paddingX - Horizontal padding in px.
 * @property {number} paddingY - Vertical padding in px.
 * @property {number} glyphGap - Glyph-to-label gap in px.
 * @property {number} gap - Extra spacing per cell in px.
 * @property {number} cell - Grid cell size in px.
 * @property {number} inset - Grid inset in px.
 */

/**
 * @param {"small"|"medium"|"large"} iconSize
 * @param {"compact"|"normal"|"spacious"} gridSpacing
 * @returns {DesktopMetrics}
 */
export function computeDesktopMetrics(iconSize, gridSpacing) {
  const size = ICON_SIZES[iconSize] ?? ICON_SIZES.medium;
  const gap = GRID_GAPS[gridSpacing] ?? GRID_GAPS.normal;
  const labelHeight = Math.ceil(size.labelFont * LABEL_LINE_HEIGHT * LABEL_LINES);
  const height = PADDING_Y * 2 + size.glyph + GLYPH_LABEL_GAP + labelHeight;
  return Object.freeze({
    ...size,
    height,
    labelLineHeight: LABEL_LINE_HEIGHT,
    paddingX: PADDING_X,
    paddingY: PADDING_Y,
    glyphGap: GLYPH_LABEL_GAP,
    gap,
    cell: Math.max(size.width, height) + gap,
    inset: DESKTOP_GRID_INSET,
  });
}
