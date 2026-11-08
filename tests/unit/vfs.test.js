/**
 * @file Unit tests for the virtual file system, run against a temporary
 * database (see run.js): CRUD, rename and move of folder trees, copy,
 * Trash (delete, restore, permanent delete, empty), name rules, storage
 * error translation, default-folder repair, and backup import/replace.
 */

import { group, test, assert } from "./harness.js";
import { vfs, TRASH_PATH, isTrashPath, assertConsistentTree } from "../../src/core/vfs/virtualFileSystem.js";
import { eventBus } from "../../src/core/eventBus.js";

/**
 * Collect the events emitted while `fn` runs.
 * @param {string[]} names
 * @param {() => Promise<*>} fn
 * @returns {Promise<Array<{name: string, payload: object}>>}
 */
async function capture(names, fn) {
  const seen = [];
  const offs = names.map((name) => eventBus.on(name, (payload) => seen.push({ name, payload })));
  try {
    await fn();
  } finally {
    offs.forEach((off) => off());
  }
  return seen;
}

group("vfs", () => {
  test("starts with the default folders", async () => {
    await vfs.init();
    for (const path of ["/Desktop", "/Documents", "/Downloads", "/Pictures", "/Trash", "/System"]) {
      assert.ok(await vfs.exists(path), path);
    }
  });

  test("create, read, write, and list", async () => {
    await vfs.createFolder("/Documents/T1");
    await vfs.createFile("/Documents/T1/a.txt", "one");
    await vfs.write("/Documents/T1/a.txt", "two ✓");
    assert.equal(await vfs.read("/Documents/T1/a.txt"), "two ✓");
    const info = await vfs.getInfo("/Documents/T1/a.txt");
    assert.equal(info.size, 7);
    assert.deepEqual((await vfs.list("/Documents/T1")).map((entry) => entry.name), ["a.txt"]);
  });

  test("duplicate names are refused, case-insensitively", async () => {
    await assert.rejects(() => vfs.createFile("/Documents/T1/A.TXT", ""), "ALREADY_EXISTS");
  });

  test("simultaneous creates of one path: one succeeds, one gets ALREADY_EXISTS", async () => {
    const results = await Promise.allSettled([vfs.createFile("/Documents/T1/race.txt", "1"), vfs.createFile("/Documents/T1/race.txt", "2")]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.find((result) => result.status === "rejected").reason.code, "ALREADY_EXISTS");
  });

  test("invalid names are refused", async () => {
    await assert.rejects(() => vfs.createFile("/Documents/T1/bad\nname.txt", ""), "INVALID_NAME");
    await assert.rejects(() => vfs.createFolder(`/Documents/${"x".repeat(300)}`), "INVALID_NAME");
  });

  test("renaming a folder moves every descendant's path", async () => {
    await vfs.createFolder("/Documents/T1/sub");
    await vfs.createFile("/Documents/T1/sub/deep.txt", "deep");
    await vfs.rename("/Documents/T1", "T2");
    assert.equal(await vfs.read("/Documents/T2/sub/deep.txt"), "deep");
    assert.ok(!(await vfs.exists("/Documents/T1/sub/deep.txt")));
  });

  test("moving a folder into itself is refused", async () => {
    await assert.rejects(() => vfs.move("/Documents/T2", "/Documents/T2/sub"), "CIRCULAR_REFERENCE");
  });

  test("copy duplicates a tree with new ids", async () => {
    const copy = await vfs.copy("/Documents/T2", "/Desktop");
    const original = await vfs.getInfo("/Documents/T2");
    assert.ok(copy.id !== original.id);
    assert.equal(await vfs.read("/Desktop/T2/sub/deep.txt"), "deep");
  });

  test("delete moves to Trash and remembers the original place", async () => {
    const events = await capture(["filesystem:fileDeleted"], () => vfs.delete("/Desktop/T2"));
    const trashed = await vfs.getInfo(`${TRASH_PATH}/T2`);
    assert.equal(trashed.originalPath, "/Desktop/T2");
    assert.ok(Number.isFinite(trashed.deletedAt));
    assert.ok(await vfs.exists(`${TRASH_PATH}/T2/sub/deep.txt`));
    // One event for the folder and one for each descendant (a.txt, race.txt, sub, sub/deep.txt).
    assert.equal(events.length, 5);
  });

  test("deleting something already in Trash is refused", async () => {
    await assert.rejects(() => vfs.delete(`${TRASH_PATH}/T2`), "ALREADY_EXISTS");
  });

  test("restore puts a tree back, re-creating missing folders", async () => {
    await vfs.createFolder("/Documents/Gone");
    await vfs.createFile("/Documents/Gone/x.txt", "x");
    await vfs.delete("/Documents/Gone/x.txt");
    await vfs.delete("/Documents/Gone");
    // Restore the file first: its folder is in Trash, so it is re-created.
    const file = await vfs.restore(`${TRASH_PATH}/x.txt`);
    assert.equal(file.path, "/Documents/Gone/x.txt");
    assert.equal(file.originalPath, undefined);
    const folder = await vfs.restore(`${TRASH_PATH}/Gone`);
    assert.equal(folder.path, "/Documents/Gone (1)", "the re-created folder keeps the name, so the restored one is numbered");
  });

  test("restore emits a move marked as restored", async () => {
    const events = await capture(["filesystem:fileMoved"], () => vfs.restore(`${TRASH_PATH}/T2`));
    assert.equal(events.length, 1);
    assert.equal(events[0].payload.restored, true);
    assert.equal(events[0].payload.entry.path, "/Desktop/T2");
  });

  test("items without an original location need a destination", async () => {
    await vfs.createFile(`${TRASH_PATH}/orphan.txt`, "o");
    await assert.rejects(() => vfs.restore(`${TRASH_PATH}/orphan.txt`), "NO_ORIGINAL_LOCATION");
    const restored = await vfs.restore(`${TRASH_PATH}/orphan.txt`, { destination: "/Documents" });
    assert.equal(restored.path, "/Documents/orphan.txt");
  });

  test("moving into Trash is the same as deleting", async () => {
    await vfs.move("/Documents/orphan.txt", TRASH_PATH);
    assert.equal((await vfs.getInfo(`${TRASH_PATH}/orphan.txt`)).originalPath, "/Documents/orphan.txt");
  });

  test("moving out of Trash clears the Trash details", async () => {
    const moved = await vfs.move(`${TRASH_PATH}/orphan.txt`, "/Downloads");
    assert.equal(moved.originalPath, undefined);
    assert.equal(moved.deletedAt, undefined);
  });

  test("permanent delete only works in Trash and removes the subtree", async () => {
    await assert.rejects(() => vfs.deletePermanently("/Downloads/orphan.txt"), "NOT_IN_TRASH");
    await assert.rejects(() => vfs.deletePermanently(TRASH_PATH), "NOT_IN_TRASH");
    await vfs.delete("/Desktop/T2");
    const events = await capture(["filesystem:fileDeleted"], () => vfs.deletePermanently(`${TRASH_PATH}/T2`));
    assert.ok(!(await vfs.exists(`${TRASH_PATH}/T2/sub/deep.txt`)));
    assert.ok(events.every((event) => event.payload.permanent === true && event.payload.entry.parentId === null));
  });

  test("emptyTrash removes everything in Trash", async () => {
    await vfs.delete("/Downloads/orphan.txt");
    await vfs.delete("/Documents/Gone (1)");
    const result = await vfs.emptyTrash();
    assert.ok(result.items >= 2);
    assert.equal((await vfs.list(TRASH_PATH)).length, 0);
  });

  test("protected folders can't be renamed, moved, or deleted", async () => {
    await assert.rejects(() => vfs.rename(TRASH_PATH, "Bin"), "PROTECTED");
    await assert.rejects(() => vfs.delete("/System"), "PROTECTED");
    await assert.rejects(() => vfs.move(TRASH_PATH, "/Documents"), "PROTECTED");
  });

  test("isTrashPath", () => {
    assert.ok(isTrashPath("/Trash"));
    assert.ok(isTrashPath("/Trash/a/b"));
    assert.ok(!isTrashPath("/Trashcan"));
  });

  test("importEntries adds a folder without replacing anything", async () => {
    const entries = [
      { id: "f", parentId: "x", name: "Imported", path: "/Old/Imported", type: "folder", content: null, size: 0, createdAt: 5, modifiedAt: 6 },
      { id: "g", parentId: "f", name: "n.txt", path: "/Old/Imported/n.txt", type: "file", content: "n", size: 1, createdAt: 5, modifiedAt: 6 },
    ];
    const first = await vfs.importEntries("/Documents", entries);
    const second = await vfs.importEntries("/Documents", entries);
    assert.equal(first.path, "/Documents/Imported");
    assert.equal(second.path, "/Documents/Imported (1)");
    assert.equal(await vfs.read("/Documents/Imported (1)/n.txt"), "n");
    assert.equal((await vfs.getInfo("/Documents/Imported/n.txt")).modifiedAt, 6);
  });

  test("replaceAll refuses inconsistent trees and keeps the current files", async () => {
    await assert.rejects(() => vfs.replaceAll([{ id: "x", parentId: null, name: "/", path: "/", type: "file" }]), "INVALID_BACKUP");
    await assert.rejects(() => assertConsistentTree([]), "INVALID_BACKUP");
    assert.ok(await vfs.exists("/Documents/Imported/n.txt"));
  });

  test("replaceAll swaps the whole tree and re-creates missing default folders", async () => {
    const snapshot = await vfs.exportEntries("/");
    const root = snapshot.find((entry) => entry.path === "/");
    const minimal = [root, { id: "only", parentId: "root", name: "only.txt", path: "/only.txt", type: "file", content: "1", size: 1, createdAt: 1, modifiedAt: 1, hidden: false, readOnly: false, system: false, favorite: false }];
    await vfs.replaceAll(minimal);
    assert.equal(await vfs.read("/only.txt"), "1");
    assert.ok(!(await vfs.exists("/Documents/Imported")));
    assert.ok(await vfs.exists(TRASH_PATH), "Trash re-created");
    assert.ok(await vfs.exists("/Documents"), "Documents re-created");
    await vfs.replaceAll(snapshot);
    assert.ok(await vfs.exists("/Documents/Imported/n.txt"), "snapshot restored");
  });
});
