#!/usr/bin/env node
/**
 * Load every published subpath from a **real installation** of the packed tarball.
 *
 * `verify-cjs-entrypoints.ts` requires the entries out of this repository's own `dist/`.
 * That is not what a consumer does: they get a tarball extracted into `node_modules`, and
 * resolution then runs against the installed manifest — `exports` conditions, the
 * `#platform/*` `imports` map, and the real directory layout. A symlinked `node_modules`
 * does not exercise that either. This does.
 *
 * It exists to test one promise in particular: `engines.node`. The floor is 22.13 because
 * `require(esm)` is unflagged from 22.12 but prints an `ExperimentalWarning` until 22.13,
 * and a library has no business adding a line to its consumers' logs. A floor nothing runs
 * is a floor nobody has checked, so CI runs this on that exact version.
 *
 * ## Why this file is `.cjs` and not `.ts`
 *
 * Every other script here is TypeScript, executed by Node's type stripping — which is
 * unflagged only from **22.18** (measured: 22.17.1 still throws `ERR_UNKNOWN_FILE_EXTENSION`).
 * So the repository's toolchain needs a newer Node than the package does, and a check that
 * must run *at the consumer floor* cannot be written in the same language as the rest.
 *
 * That gap is the whole reason this file exists. Pinning the CI matrix at the consumer floor
 * instead — which is what the first attempt did — makes every `node scripts/*.ts` in the
 * build and the gate tests fail on the floor version, for a reason that has nothing to do
 * with the package.
 *
 * ## Usage
 *
 *   node scripts/verify-installed-package.cjs [consumer-dir]
 *
 * `consumer-dir` defaults to the cwd and must already have `documonster` installed. It is
 * deliberately a plain CommonJS file so that the project it runs in is a CommonJS project,
 * which is the case being tested.
 */
"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const consumerDir = path.resolve(process.argv[2] ?? process.cwd());
const manifestPath = path.join(consumerDir, "node_modules", "documonster", "package.json");

if (!fs.existsSync(manifestPath)) {
  console.error(
    `✗ verify:install — documonster is not installed in ${consumerDir}.\n` +
      "  Pack and install it first:\n" +
      "    npm pack --ignore-scripts\n" +
      "    npm install ./documonster-<version>.tgz"
  );
  process.exitCode = 1;
  return;
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const subpaths = Object.keys(manifest.exports ?? {}).filter(key => key !== "./package.json");

if (subpaths.length === 0) {
  console.error("✗ verify:install — the installed manifest publishes no subpaths.");
  process.exitCode = 1;
  return;
}

/** `require()` one specifier in its own process, from the consumer's directory. */
function load(specifier) {
  // A child per subpath: a module registry is per-process, so one entry would otherwise
  // mask another's failure — and stderr has to be attributed to the entry that wrote it.
  const child = spawnSync(
    process.execPath,
    ["-e", `const ns = require(${JSON.stringify(specifier)}); if (!ns) throw new Error("empty");`],
    { cwd: consumerDir, encoding: "utf8", stdio: "pipe" }
  );
  if (child.status !== 0) {
    return String(child.stderr || child.error || "unknown failure")
      .trim()
      .split("\n")[0];
  }
  if (child.stderr.trim() !== "") {
    // An `ExperimentalWarning` lands here. It is a failure, not a curiosity: it is the
    // reason `engines.node` names 22.13 rather than 22.12.
    return `loaded but wrote to stderr: ${child.stderr.trim().split("\n")[0]}`;
  }
  return null;
}

const failures = [];
for (const subpath of subpaths) {
  const specifier = `documonster${subpath.slice(1)}`;
  const problem = load(specifier);
  if (problem !== null) {
    failures.push(`${specifier} — ${problem}`);
  }
}

const engines = manifest.engines?.node ?? "unspecified";
if (failures.length > 0) {
  console.error(
    `✗ verify:install — ${failures.length} of ${subpaths.length} subpath(s) failed to ` +
      `require() on ${process.version} (package declares engines.node ${engines}):`
  );
  for (const failure of failures) {
    console.error(`  ${failure}`);
  }
  process.exitCode = 1;
  return;
}

console.log(
  `✓ verify:install — all ${subpaths.length} subpath(s) require() silently from a real ` +
    `install on ${process.version} (engines.node ${engines}).`
);
