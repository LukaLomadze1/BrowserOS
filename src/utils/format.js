/**
 * @file Small presentation-formatting helpers shared by anything that
 * displays VFS metadata (Properties dialog, File Explorer, Recycle
 * Bin) — kept in one place so "12 KB" and date
 * formatting never drift between them.
 */

const UNITS = ["bytes", "KB", "MB", "GB"];

/**
 * @param {number} bytes
 * @returns {string} e.g. "0 bytes", "512 bytes", "3.4 KB", "1.2 MB"
 */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 bytes";
  if (bytes === 1) return "1 byte";

  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < UNITS.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const rounded = unitIndex === 0 ? value : Math.round(value * 10) / 10;
  return `${rounded} ${UNITS[unitIndex]}`;
}

/**
 * @param {number} timestamp - Milliseconds since epoch.
 * @returns {string}
 */
export function formatDate(timestamp) {
  if (!Number.isFinite(timestamp)) return "\u2014";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(timestamp));
}
