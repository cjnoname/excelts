#!/usr/bin/env node
/**
 * Every published entry point must be loadable by `require()`.
 *
 * The package is ESM-only: each `exports` subpath is `{ browser, types, default }`, and
 * `default` names a file in `dist/esm`. A CommonJS consumer therefore reaches it through
 * `require(esm)`, unflagged since Node 22.12 and quiet since 22.13, which is what `engines.node` names.
 * This is the check that the route works — and since the transpiled `dist/cjs` tree it
 * replaced is gone, it is the only one.
 *
 * ## What it catches
 *
 * **Top-level await.** `require(esm)` throws `ERR_REQUIRE_ASYNC_MODULE` on a graph
 * containing one, so an `await` at module scope fails here rather than silently breaking
 * every CommonJS consumer at once. That makes this the gate on a standing rule — *do not
 * introduce top-level await* — and the rule is what keeps the package requirable at all.
 * Verified by appending one to `markdown/index.ts`: `1 of 19 entry point(s) failed`.
 *
 * **A subpath whose artifact is missing or does not execute.** Type-checking the emitted
 * `.d.ts` files says nothing about whether the JavaScript beside them runs.
 *
 * **Anything printed to stderr.** `engines.node` names 22.13 rather than 22.12 — where
 * `require(esm)` first works — precisely because 22.12 prints an `ExperimentalWarning` on
 * every load, and a library has no business adding a line to its consumers' logs. That was
 * a measured decision with nothing enforcing it, so a clean stderr is now part of the check;
 * CI runs the floor version explicitly for the same reason.
 *
 * Note the warning is emitted through `process.emitWarning`, which defers to the next tick,
 * so a harness that calls `process.exit()` never sees it. This waits for the child to end.
 *
 * The predecessor of this script had a third job that no longer applies: `tsc`'s CommonJS
 * emit preserved statement order where ESM hoists its bindings, so an import placed at the
 * end of a file landed below its consumer and threw
 * `ReferenceError: Cannot access 'grapheme_1' before initialization` at load. That shipped
 * once, breaking 12 of the 19 CJS entries while the whole suite stayed green. Deleting the
 * CommonJS transpile removed that entire class of failure along with its 10.7 MB.
 *
 * There is a Vitest test for this too, but it can only skip when `dist/esm` is absent — and
 * `pnpm test` runs Vitest before any build, so in a clean checkout it skips. This runs
 * inside `build:verify`, where the artifact is guaranteed to exist.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// `fileURLToPath`, not `.pathname`: the latter yields `/C:/…` on Windows and does
// not percent-decode, so a path with a space in it fails.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface PackageManifest {
  readonly exports?: Record<string, unknown>;
}

/** The file each export subpath resolves to for a Node consumer. */
function entries(): { subpath: string; file: string }[] {
  const manifest = JSON.parse(
    readFileSync(join(repoRoot, "package.json"), "utf8")
  ) as PackageManifest;
  const out: { subpath: string; file: string }[] = [];

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

const found = entries();
if (found.length === 0) {
  console.error("verify:cjs — no entry points found in package.json exports");
  process.exit(1);
}

const failures: string[] = [];
for (const { subpath, file } of found) {
  const absolute = join(repoRoot, file);
  if (!existsSync(absolute)) {
    failures.push(`${subpath} — missing artifact ${file}`);
    continue;
  }
  // A child process per entry: a module registry is per-process, so loading them
  // together would let one entry mask another's failure. `spawnSync` rather than
  // `execFileSync` because stderr has to be readable on success as well as on failure.
  const child = spawnSync(process.execPath, ["-e", `require(${JSON.stringify(absolute)})`], {
    encoding: "utf8",
    stdio: "pipe"
  });
  if (child.status !== 0) {
    const stderr = child.stderr || String(child.error ?? "unknown failure");
    failures.push(`${subpath} — ${stderr.trim().split("\n")[0]}`);
    continue;
  }
  if (child.stderr.trim() !== "") {
    failures.push(`${subpath} — loaded but wrote to stderr: ${child.stderr.trim().split("\n")[0]}`);
  }
}

if (failures.length > 0) {
  console.error(
    `✗ verify:cjs — ${failures.length} of ${found.length} entry point(s) failed to require():`
  );
  for (const failure of failures) {
    console.error(`  ${failure}`);
  }
  console.error(
    "\nERR_REQUIRE_ASYNC_MODULE means a top-level await entered the graph; the package " +
      "must stay free of one to remain requirable from CommonJS. An ExperimentalWarning " +
      "means this Node is below the floor `engines.node` names."
  );
  process.exit(1);
}

console.log(
  `✓ verify:cjs — all ${found.length} entry point(s) load through require(esm), silently.`
);
