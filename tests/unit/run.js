/**
 * @file Loads every unit test module, then runs them. The file-system
 * tests switch the storage adapter to a temporary database before
 * anything opens the real one, and delete it afterwards.
 */

import { storageAdapter } from "../../src/core/vfs/storageAdapter.js";
import { run } from "./harness.js";

const TEST_DATABASE = `browseros-vfs-unit-${Date.now()}`;
storageAdapter.useDatabase(TEST_DATABASE);

await import("./pure.test.js");
await import("./backup.test.js");
await import("./vfs.test.js");
await import("./browserInfo.test.js");

const summary = await run(document.getElementById("output"));

// Remove the temporary database.
try {
  (await storageAdapter.open()).close();
} catch {
  /* never opened */
}
indexedDB.deleteDatabase(TEST_DATABASE);
console.log(`[unit] ${summary.passed} passed, ${summary.failed} failed`);
