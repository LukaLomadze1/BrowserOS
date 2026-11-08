/**
 * @file Unit tests for the backup format: a backup round-trips, and
 * damaged, newer, foreign, and inconsistent files are refused before
 * anything could be restored.
 */

import { group, test, assert } from "./harness.js";
import { buildBackup, parseBackup, BACKUP_FORMAT_VERSION } from "../../src/core/backup/backupFormat.js";

const now = Date.UTC(2026, 0, 31, 12);

/** @returns {object[]} A small, consistent full tree. */
function sampleEntries() {
  const folder = (id, parentId, path) => ({ id, parentId, path, name: path === "/" ? "/" : path.split("/").pop(), type: "folder", content: null, size: 0, createdAt: now, modifiedAt: now, hidden: false, readOnly: false, system: false, favorite: false });
  const file = (id, parentId, path, content) => ({ ...folder(id, parentId, path), type: "file", content, size: content instanceof Blob ? content.size : new TextEncoder().encode(content).length });
  return [
    { ...folder("root", null, "/"), readOnly: true, system: true },
    folder("docs", "root", "/Documents"),
    file("a", "docs", "/Documents/a.txt", "héllo ✓"),
    file("b", "docs", "/Documents/b.png", new Blob([new Uint8Array([137, 80, 78, 71, 0, 255])], { type: "image/png" })),
  ];
}

/**
 * @param {string} text
 * @param {(doc: object) => void} change
 * @returns {string}
 */
function edit(text, change) {
  const doc = JSON.parse(text);
  change(doc);
  return JSON.stringify(doc);
}

group("backup format", () => {
  test("a full backup round-trips text and binary content", async () => {
    const { text, counts } = await buildBackup({ scope: "full", root: "/", entries: sampleEntries(), storage: { settings: '{"version":1}' }, appVersion: "test" });
    assert.deepEqual(counts, { folders: 2, files: 2, bytes: 16, storageKeys: 1 });
    const backup = await parseBackup(text);
    assert.equal(backup.scope, "full");
    assert.equal(backup.formatVersion, BACKUP_FORMAT_VERSION);
    assert.ok(backup.checksumVerified, "checksum verified");
    assert.equal(backup.entries.find((entry) => entry.id === "a").content, "héllo ✓");
    const png = backup.entries.find((entry) => entry.id === "b").content;
    assert.ok(png instanceof Blob);
    assert.deepEqual([...new Uint8Array(await png.arrayBuffer())], [137, 80, 78, 71, 0, 255]);
    assert.equal(backup.storage.settings, '{"version":1}');
  });

  test("an edited backup is reported as damaged", async () => {
    const { text } = await buildBackup({ scope: "full", root: "/", entries: sampleEntries(), storage: {}, appVersion: "test" });
    const tampered = edit(text, (doc) => {
      doc.entries[2].content.data = "changed";
    });
    await assert.rejects(() => parseBackup(tampered), "DAMAGED");
  });

  test("a cut-off file is not a backup", async () => {
    const { text } = await buildBackup({ scope: "full", root: "/", entries: sampleEntries(), storage: {}, appVersion: "test" });
    await assert.rejects(() => parseBackup(text.slice(0, text.length - 40)), "NOT_A_BACKUP");
  });

  test("other JSON and newer formats are refused", async () => {
    await assert.rejects(() => parseBackup('{"hello": "world"}'), "NOT_A_BACKUP");
    const { text } = await buildBackup({ scope: "full", root: "/", entries: sampleEntries(), storage: {}, appVersion: "test" });
    await assert.rejects(() => parseBackup(edit(text, (doc) => { doc.formatVersion = BACKUP_FORMAT_VERSION + 1; })), "NEWER_VERSION");
  });

  test("a wrong size is caught even without a checksum", async () => {
    const { text } = await buildBackup({ scope: "full", root: "/", entries: sampleEntries(), storage: {}, appVersion: "test" });
    const unchecked = edit(text, (doc) => {
      doc.checksum = null;
      doc.entries[2].size = 999;
    });
    await assert.rejects(() => parseBackup(unchecked), "DAMAGED");
  });

  test("inconsistent trees are refused", async () => {
    const { text } = await buildBackup({ scope: "full", root: "/", entries: sampleEntries(), storage: {}, appVersion: "test" });
    const orphan = edit(text, (doc) => {
      doc.checksum = null;
      doc.entries[2].parentId = "missing";
    });
    await assert.rejects(() => parseBackup(orphan), "INVALID");
    const wrongPath = edit(text, (doc) => {
      doc.checksum = null;
      doc.entries[2].path = "/Elsewhere/a.txt";
    });
    await assert.rejects(() => parseBackup(wrongPath), "INVALID");
  });

  test("a folder backup starts at its folder", async () => {
    const entries = sampleEntries().slice(1);
    const { text } = await buildBackup({ scope: "folder", root: "/Documents", entries, appVersion: "test" });
    const backup = await parseBackup(text);
    assert.equal(backup.root, "/Documents");
    assert.equal(backup.entries.length, 3);
    assert.deepEqual(backup.storage, {});
  });
});
