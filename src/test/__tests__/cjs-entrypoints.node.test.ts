/**
 * Every published entry point must be loadable by `require()`.
 *
 * The package is ESM-only — each `exports` subpath is `{ browser, types, default }` and
 * `default` names a file in `dist/esm` — so a CommonJS consumer reaches it through
 * `require(esm)`, unflagged since Node 22.12 and quiet since 22.13, which is what `engines.node`
 * names. With the transpiled `dist/cjs` tree gone, this is the only proof that route
 * works.
 *
 * ## Why it is worth executing rather than type-checking
 *
 * `build:verify:node` type-checks the emitted `.d.ts` files, which says nothing about
 * whether the JavaScript beside them runs. The cheapest guard for that is to actually load
 * it. The predecessor of this test existed for a failure of exactly that shape: `tsc`'s
 * CommonJS emit preserved statement order where ESM hoists its bindings, so an import at
 * the end of `src/utils/cjk.ts` landed below its consumer and threw
 * `ReferenceError: Cannot access 'grapheme_1' before initialization` at load — breaking 12
 * of the 19 CJS entries while the whole suite stayed green, because the tests run against
 * source through ESM. Deleting the CommonJS transpile removed that class of failure
 * entirely; what remains is this.
 *
 * ## The top-level await rule
 *
 * `require(esm)` throws `ERR_REQUIRE_ASYNC_MODULE` on a graph containing top-level await.
 * So this is the gate on a standing rule — **do not introduce top-level await** — and that
 * rule is what keeps the package requirable from CommonJS at all. The first case below
 * pins the mechanism, so the rest cannot pass because Node stopped caring.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

/** The file each export subpath resolves to for a Node consumer. */
function entries(): Array<{ subpath: string; file: string }> {
  const manifest = JSON.parse(
    readFileSync(join(repoRoot, "package.json"), "utf8")
  ) as PackageManifest;
  const out: Array<{ subpath: string; file: string }> = [];

  for (const [subpath, value] of Object.entries(manifest.exports ?? {})) {
    if (typeof value !== "object" || value === null) {
      continue;
    }
    const target = (value as { default?: unknown }).default;
    if (typeof target === "string") {
      out.push({ subpath, file: target });
    }
  }
  return out;
}

describe("the mechanism the require(esm) check depends on", () => {
  it("throws ERR_REQUIRE_ASYNC_MODULE on top-level await", () => {
    // Without this, the check below could be passing because Node tolerates a top-level
    // `await` rather than because the tree has none — and the rule it enforces would be
    // unenforced. Proved against a fixture rather than by hand against a real module.
    const dir = mkdtempSync(join(tmpdir(), "require-esm-tla-"));
    try {
      const file = join(dir, "tla.mjs");
      writeFileSync(file, "await Promise.resolve();\nexport const v = 1;\n");
      let message = "";
      try {
        execFileSync(process.execPath, ["-e", `require(${JSON.stringify(file)})`], {
          stdio: "pipe"
        });
      } catch (error) {
        message = (error as { stderr?: Buffer }).stderr?.toString() ?? String(error);
      }
      expect(message).toContain("ERR_REQUIRE_ASYNC_MODULE");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loads a plain ESM module through require() at all", () => {
    // The other half: if `require(esm)` were unavailable, every entry below would fail and
    // the failure would look like a problem with this package rather than with the runtime.
    const dir = mkdtempSync(join(tmpdir(), "require-esm-ok-"));
    try {
      const file = join(dir, "plain.mjs");
      writeFileSync(file, "export const v = 1;\n");
      const out = execFileSync(
        process.execPath,
        ["-e", `console.log(require(${JSON.stringify(file)}).v)`],
        { encoding: "utf8", stdio: "pipe" }
      );
      expect(out.trim()).toBe("1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("a CommonJS consumer requiring the published artifact", () => {
  const found = entries();

  it("declares entry points", () => {
    expect(found.length).toBeGreaterThan(0);
  });

  // Skipped rather than failed when `dist/` is absent: the suite runs from source
  // and must not require a build, while CI builds before running it.
  const built = found.length > 0 && existsSync(join(repoRoot, found[0].file));

  it.skipIf(!built)("loads every published entry", () => {
    const failures: string[] = [];
    for (const { subpath, file } of found) {
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
    expect(failures, `entries failed to require():\n${failures.join("\n")}`).toEqual([]);
  });
});
