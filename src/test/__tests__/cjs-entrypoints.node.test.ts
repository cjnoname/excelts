/**
 * Load every published CommonJS entry point.
 *
 * A `require()` that ends up *after* the code using it is valid TypeScript and
 * valid ESM — import bindings are hoisted — but `tsc`'s CommonJS emit keeps
 * statement order, so the `require` call lands below the consumer and the
 * temporal dead zone throws at load:
 *
 * ```
 * ReferenceError: Cannot access 'grapheme_1' before initialization
 * ```
 *
 * That shipped once: an import placed at the end of `src/utils/cjk.ts` broke 12 of
 * the 19 CJS entries while the whole test suite stayed green, because tests run
 * against source through ESM. `build:verify:node` only type-checks the emitted
 * `.d.ts` files, so nothing executed the artifact.
 *
 * This is the cheapest possible guard for that class of failure: actually load it.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// `fileURLToPath`, not `.pathname`: on Windows the latter yields `/C:/…`, which
// `join` then turns into `\C:\…` and every read fails — and because the manifest
// is read while the suite is being collected, that is a file-level error rather
// than a skipped test. It also percent-decodes, so a path containing a space or
// a non-ASCII character works.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

interface PackageManifest {
  readonly exports?: Record<string, unknown>;
}

/** The CommonJS file each export subpath resolves to, when it has one. */
function commonJsEntries(): Array<{ subpath: string; file: string }> {
  const manifest = JSON.parse(
    readFileSync(join(repoRoot, "package.json"), "utf8")
  ) as PackageManifest;
  const out: Array<{ subpath: string; file: string }> = [];

  const pickRequire = (value: unknown): string | undefined => {
    if (typeof value !== "object" || value === null) {
      return undefined;
    }
    const record = value as Record<string, unknown>;
    const candidate =
      record.require ?? (record.node as Record<string, unknown> | undefined)?.require;
    if (typeof candidate === "string") {
      return candidate;
    }
    if (typeof candidate === "object" && candidate !== null) {
      const nested = (candidate as Record<string, unknown>).default;
      return typeof nested === "string" ? nested : undefined;
    }
    return undefined;
  };

  for (const [subpath, value] of Object.entries(manifest.exports ?? {})) {
    const file = pickRequire(value);
    if (file) {
      out.push({ subpath, file });
    }
  }
  return out;
}

describe("CommonJS artifact", () => {
  const entries = commonJsEntries();

  it("declares CommonJS entry points", () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  // Skipped rather than failed when `dist/` is absent: the suite runs from source
  // and must not require a build, while CI builds before running it.
  const built = entries.length > 0 && existsSync(join(repoRoot, entries[0].file));

  it.skipIf(!built)("should load every published CommonJS entry", () => {
    const failures: string[] = [];
    for (const { subpath, file } of entries) {
      try {
        // A child process per entry: a module registry is per-process, so loading
        // them together would let one entry mask another's failure.
        execFileSync(process.execPath, ["-e", `require(${JSON.stringify(join(repoRoot, file))})`], {
          stdio: "pipe"
        });
      } catch (error) {
        const stderr = (error as { stderr?: Buffer }).stderr?.toString() ?? String(error);
        failures.push(
          `${subpath} (${file}): ${stderr.split("\n").find(l => l.includes("Error")) ?? stderr.slice(0, 120)}`
        );
      }
    }
    expect(failures, `CommonJS entries failed to load:\n${failures.join("\n")}`).toEqual([]);
  });
});
