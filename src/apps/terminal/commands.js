/**
 * @file Terminal command registry — every built-in command's
 * implementation, plus the small tokenizing helper they share.
 * Commands never touch IndexedDB or any other storage primitive
 * directly; every filesystem operation goes through the public VFS
 * API handed to them via `ctx.vfs`, exactly like every other app in
 * BrowserOS.
 *
 * Each command is `{ name, description, run(args, ctx) }`. `run` may
 * be async and may throw — TerminalManager catches whatever a command
 * throws and prints it as an error line, so commands don't need their
 * own try/catch for VFS errors.
 */

import { getBaseName, getParentPath } from "../../core/vfs/pathResolver.js";

/**
 * Split a raw command line into tokens, honoring single- and
 * double-quoted segments so names containing spaces work
 * (`mkdir "My Folder"`).
 * @param {string} line
 * @returns {string[]}
 */
export function tokenize(line) {
  const tokens = [];
  let current = "";
  let quoteChar = null;

  for (const char of line) {
    if (quoteChar) {
      if (char === quoteChar) {
        quoteChar = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quoteChar = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

/**
 * Write to a path, creating the file first if it doesn't exist yet —
 * `vfs.write()` alone requires the file to already exist.
 * @param {import("../../core/vfs/virtualFileSystem.js").vfs} vfs
 * @param {string} path
 * @param {string} content
 * @param {string} cwd
 * @returns {Promise<void>}
 */
async function writeFileEnsuring(vfs, path, content, cwd) {
  try {
    await vfs.write(path, content, cwd);
  } catch (error) {
    if (error.code === "NOT_FOUND") {
      await vfs.createFile(path, content, {}, cwd);
    } else {
      throw error;
    }
  }
}

/**
 * @param {object|null} destInfo
 * @returns {boolean}
 */
function looksLikeExistingFolderTarget(destInfo) {
  return Boolean(destInfo) && destInfo.type === "folder";
}

/**
 * Recursively print a directory tree, depth-first, using only
 * `vfs.list()` — the same call File Explorer itself uses to render a
 * folder's contents.
 * @param {import("../../core/vfs/virtualFileSystem.js").vfs} vfs
 * @param {string} path
 * @param {string} prefix
 * @param {string[]} lines
 * @returns {Promise<void>}
 */
async function walkTree(vfs, path, prefix, lines) {
  const children = await vfs.list(path);
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    const isLast = i === children.length - 1;
    lines.push(`${prefix}${isLast ? "\u2514\u2500\u2500 " : "\u251c\u2500\u2500 "}${child.name}${child.type === "folder" ? "/" : ""}`);
    if (child.type === "folder") {
      await walkTree(vfs, child.path, `${prefix}${isLast ? "    " : "\u2502   "}`, lines);
    }
  }
}

/**
 * @returns {Map<string, {name: string, description: string, run: Function}>}
 */
export function createCommandRegistry() {
  const commands = new Map();
  const register = (name, description, run) => commands.set(name, { name, description, run });

  register("help", "List available commands", (args, ctx) => {
    const width = Math.max(...ctx.commandList.map((cmd) => cmd.name.length)) + 2;
    const lines = ctx.commandList
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((cmd) => `${cmd.name.padEnd(width)}${cmd.description}`);
    ctx.print(lines.join("\n"));
  });

  register("clear", "Clear the terminal output", (args, ctx) => {
    ctx.clear();
  });

  register("pwd", "Print the current directory", (args, ctx) => {
    ctx.print(ctx.cwd);
  });

  register("ls", "List a directory's contents", async (args, ctx) => {
    const target = args[0] ?? ".";
    const entries = await ctx.vfs.list(target, ctx.cwd);
    if (entries.length === 0) {
      ctx.print("(empty)");
      return;
    }
    ctx.print(entries.map((entry) => (entry.type === "folder" ? `${entry.name}/` : entry.name)).join("  "));
  });

  register("cd", "Change the current directory", async (args, ctx) => {
    const target = args[0] ?? "/";
    const resolved = await ctx.vfs.resolvePath(target, ctx.cwd);
    const info = await ctx.vfs.getInfo(resolved);
    if (info.type !== "folder") {
      throw new Error(`cd: ${target}: not a directory`);
    }
    ctx.setCwd(info.path);
  });

  register("mkdir", "Create a new folder", async (args, ctx) => {
    if (args.length === 0) throw new Error("mkdir: missing operand");
    for (const path of args) {
      await ctx.vfs.createFolder(path, {}, ctx.cwd);
    }
  });

  register("touch", "Create an empty file (no-op if it already exists)", async (args, ctx) => {
    if (args.length === 0) throw new Error("touch: missing operand");
    for (const path of args) {
      try {
        await ctx.vfs.createFile(path, "", {}, ctx.cwd);
      } catch (error) {
        if (error.code !== "ALREADY_EXISTS") throw error;
      }
    }
  });

  register("cat", "Print a file's contents", async (args, ctx) => {
    if (args.length === 0) throw new Error("cat: missing operand");
    for (const path of args) {
      const content = await ctx.vfs.read(path, ctx.cwd);
      ctx.print(content.length > 0 ? content : "(empty file)");
    }
  });

  register("echo", "Print text, or write it to a file with > / >>", async (args, ctx) => {
    const redirectIndex = args.findIndex((arg) => arg === ">" || arg === ">>");
    if (redirectIndex === -1) {
      ctx.print(args.join(" "));
      return;
    }
    const operator = args[redirectIndex];
    const targetPath = args[redirectIndex + 1];
    if (!targetPath) throw new Error("echo: missing file operand after redirection");
    const text = args.slice(0, redirectIndex).join(" ");

    if (operator === ">>") {
      let existing = "";
      try {
        existing = await ctx.vfs.read(targetPath, ctx.cwd);
      } catch {
        // File doesn't exist yet — append behaves like a fresh write.
      }
      const combined = existing.length > 0 ? `${existing}\n${text}` : text;
      await writeFileEnsuring(ctx.vfs, targetPath, combined, ctx.cwd);
    } else {
      await writeFileEnsuring(ctx.vfs, targetPath, text, ctx.cwd);
    }
  });

  register("mv", "Move or rename a file or folder", async (args, ctx) => {
    if (args.length < 2) throw new Error("mv: missing file operand");
    const [source, dest] = args;
    const destResolved = await ctx.vfs.resolvePath(dest, ctx.cwd);

    let destInfo = null;
    try {
      destInfo = await ctx.vfs.getInfo(destResolved);
    } catch {
      // Destination doesn't exist yet — treat it as a rename target.
    }

    if (looksLikeExistingFolderTarget(destInfo)) {
      await ctx.vfs.move(source, destResolved, ctx.cwd);
    } else {
      await ctx.vfs.rename(source, getBaseName(destResolved), ctx.cwd);
    }
  });

  register("cp", "Copy a file or folder", async (args, ctx) => {
    if (args.length < 2) throw new Error("cp: missing file operand");
    const [source, dest] = args;
    const destResolved = await ctx.vfs.resolvePath(dest, ctx.cwd);

    let destInfo = null;
    try {
      destInfo = await ctx.vfs.getInfo(destResolved);
    } catch {
      // Destination doesn't exist yet — copy-with-a-new-name.
    }

    if (looksLikeExistingFolderTarget(destInfo)) {
      await ctx.vfs.copy(source, destResolved, { currentDir: ctx.cwd });
    } else {
      const parent = getParentPath(destResolved) ?? "/";
      await ctx.vfs.copy(source, parent, { currentDir: ctx.cwd, newName: getBaseName(destResolved) });
    }
  });

  register("rm", "Move a file or folder to Trash", async (args, ctx) => {
    if (args.length === 0) throw new Error("rm: missing operand");
    for (const path of args) {
      await ctx.vfs.delete(path, ctx.cwd);
    }
  });

  register("tree", "Recursively print a directory tree", async (args, ctx) => {
    const target = args[0] ?? ".";
    const rootInfo = await ctx.vfs.getInfo(target, ctx.cwd);
    if (rootInfo.type !== "folder") throw new Error(`tree: ${target}: not a directory`);
    const lines = [rootInfo.path === "/" ? "/" : rootInfo.name];
    await walkTree(ctx.vfs, rootInfo.path, "", lines);
    ctx.print(lines.join("\n"));
  });

  register("date", "Print the current date and time", (args, ctx) => {
    ctx.print(new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "medium" }).format(new Date()));
  });

  register("history", "Print command history", (args, ctx) => {
    if (ctx.history.length === 0) {
      ctx.print("(no history)");
      return;
    }
    ctx.print(ctx.history.map((entry, index) => `${index + 1}  ${entry}`).join("\n"));
  });

  register("whoami", "Print the current user", (args, ctx) => {
    ctx.print("guest");
  });

  register("sleep", "Wait for a number of seconds (Ctrl + C interrupts)", (args, ctx) => {
    const seconds = Number(args[0]);
    if (args.length === 0) throw new Error("sleep: missing operand");
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > 3600) throw new Error(`sleep: invalid time interval "${args[0]}" (0 to 3600 seconds)`);
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(resolve, seconds * 1000);
      ctx.signal?.addEventListener(
        "abort",
        () => {
          window.clearTimeout(timer);
          reject(new Error("sleep: interrupted"));
        },
        { once: true }
      );
    });
  });

  register("version", "Print the BrowserOS version", (args, ctx) => {
    ctx.print("BrowserOS 0.1 \u2014 Terminal 1.0");
  });

  register("explorer", "Open File Explorer at a path (defaults to the current directory)", async (args, ctx) => {
    const target = args[0] ?? ctx.cwd;
    const info = await ctx.vfs.getInfo(target, ctx.cwd);
    await ctx.openEntry(info);
  });

  register("open", "Open a file in its registered application", async (args, ctx) => {
    if (args.length === 0) throw new Error("open: missing operand");
    const info = await ctx.vfs.getInfo(args[0], ctx.cwd);
    await ctx.openEntry(info);
  });

  return commands;
}
