/**
 * Example discovery — the single definition of "what counts as an example".
 *
 * Used by `scripts/run-examples.ts`, both to run the whole set and to decide
 * which examples a commit affects. It is a separate module so that definition has
 * one home and can be tested directly: the pre-commit hook used to carry its own
 * shell pattern, which drifted from this in three ways at once. The rules are:
 *
 * - Any `.ts` file directly inside a `src/**\/examples/` directory.
 * - **Not** files under an `examples/utils/` subdirectory: those are helpers the
 *   examples import (`hr-stopwatch`, `self-signed-certificate`), not scripts.
 *   Running them does nothing and asserting nothing about them is correct.
 * - **Not** `.d.ts`.
 */
import fs from "node:fs/promises";
import path from "node:path";

import { relPosix } from "./paths.ts";

/** Directory names inside `examples/` that hold helpers rather than scripts. */
const HELPER_DIRS = new Set(["utils"]);

/**
 * `true` for "this directory is simply not there", which is expected — most
 * modules have no `examples/`.
 *
 * Anything else (a permission error, an I/O error, a path that is a file) must
 * propagate. Swallowing every error made an unreadable directory
 * indistinguishable from an empty one, so the gate would report success having
 * silently skipped a module's entire example set.
 */
function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

async function walk(dir: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) {
      return;
    }
    throw error;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!HELPER_DIRS.has(entry.name)) {
        await walk(full, out);
      }
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
}

/**
 * Every runnable example, as project-relative POSIX paths, sorted.
 *
 * @param root - Repository root.
 */
export async function collectExamples(root: string): Promise<string[]> {
  const modulesDir = path.join(root, "src", "modules");
  let moduleEntries;
  try {
    moduleEntries = await fs.readdir(modulesDir, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) {
      return [];
    }
    throw error;
  }

  const found: string[] = [];
  for (const entry of moduleEntries) {
    if (entry.isDirectory()) {
      await walk(path.join(modulesDir, entry.name, "examples"), found);
    }
  }
  // A top-level `src/examples/` is also honoured — `tsconfig.esm.json` excludes it,
  // so it is a legitimate place for one even though nothing uses it today.
  await walk(path.join(root, "src", "examples"), found);

  return found.map(file => relPosix(root, file)).sort();
}
