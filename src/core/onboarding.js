/**
 * @file Whether the Welcome tour has been seen.
 *
 * The tour opens by itself only on a new installation (the start that
 * created the file system). It records its state here:
 *
 *   "pending"   shown, but neither finished nor skipped yet; it opens
 *               again at the next start
 *   "completed" finished
 *   "skipped"   skipped or closed
 *   "existing"  BrowserOS already had data when this version first
 *               started, so the tour was not opened by itself
 *
 * Settings › System and the Start Menu can open the tour at any time;
 * that never changes files or preferences unless the user chooses
 * something in it.
 */

import { storage } from "./storage.js";
import { BROWSEROS_VERSION } from "./version.js";

const STORAGE_KEY = "welcome:status";
const STATUSES = new Set(["pending", "completed", "skipped", "existing"]);

class Onboarding {
  /**
   * @returns {{status: string, version: string, changedAt: number}|null}
   */
  getRecord() {
    const record = storage.get(STORAGE_KEY, null);
    return record && STATUSES.has(record.status) ? record : null;
  }

  /** @returns {string|null} */
  getStatus() {
    return this.getRecord()?.status ?? null;
  }

  /**
   * Decide at start-up whether the tour opens by itself.
   * @param {{newInstallation: boolean}} context
   * @returns {boolean}
   */
  shouldShowAtStart({ newInstallation }) {
    const status = this.getStatus();
    if (status === "pending") return true;
    if (status) return false;
    if (!newInstallation) {
      this.setStatus("existing");
      return false;
    }
    this.setStatus("pending");
    return true;
  }

  /**
   * @param {"pending"|"completed"|"skipped"|"existing"} status
   * @returns {void}
   */
  setStatus(status) {
    if (!STATUSES.has(status)) throw new Error(`Unknown onboarding status "${status}"`);
    storage.set(STORAGE_KEY, { status, version: BROWSEROS_VERSION, changedAt: Date.now() });
  }
}

export const onboarding = new Onboarding();
