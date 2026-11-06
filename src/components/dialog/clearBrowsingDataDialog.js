/**
 * @file "Clear browsing data" dialog — removes Browser history visits
 * for a chosen time range. Used by the Browser (menu, History page) and
 * Settings › Browser.
 */

import { historyService } from "../../core/browser/historyService.js";
import { showFormDialog } from "./formDialog.js";

export const CLEAR_RANGES = Object.freeze([
  { value: "hour", label: "Last hour", ms: 3_600_000 },
  { value: "day", label: "Last 24 hours", ms: 86_400_000 },
  { value: "week", label: "Last 7 days", ms: 7 * 86_400_000 },
  { value: "month", label: "Last 4 weeks", ms: 28 * 86_400_000 },
  { value: "all", label: "All time", ms: null },
]);

/**
 * Ask for a time range and clear history for it.
 * @returns {Promise<number|null>} Visits removed, or null when cancelled.
 */
export async function showClearBrowsingDataDialog() {
  let removed = null;
  await showFormDialog({
    title: "Clear browsing data",
    confirmLabel: "Clear history",
    fields: [{ id: "range", label: "Remove visits from", type: "select", value: "hour", options: CLEAR_RANGES.map(({ value, label }) => ({ value, label })) }],
    validate: ({ range }) => {
      const choice = CLEAR_RANGES.find((option) => option.value === range) ?? CLEAR_RANGES[0];
      removed = historyService.clear(choice.ms === null ? {} : { since: Date.now() - choice.ms });
      return null;
    },
  });
  return removed;
}
