/**
 * Workspace-package import verification.
 *
 * Satellite packages under `packages/*` exist so that code needing runtime
 * dependencies can live in this repository without ever putting one in the
 * zero-dependency core. That only holds if the boundary is real, so this script
 * enforces two rules by scanning every production import in every satellite:
 *
 * 1. **No internal path aliases.** `@excel/*`, `@utils/*` &c. resolve only
 *    inside the core's own tsconfig. A satellite must consume `documonster`
 *    through its published `exports` map, exactly as an external package does.
 *    That keeps satellites honest consumers of the public API — and makes them
 *    an extra check on whether that API is actually sufficient.
 *
 * 2. **No relative reach into the core.** `../../src/...` would bypass the
 *    exports map, the layer rules and `verify:public-types` in one step.
 *
 * Test files are exempt from neither rule: a test that imports internals would
 * be testing something a published consumer cannot reach.
 *
 * Usage: node scripts/verify-package-imports.ts
 */

import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const PACKAGES_DIR = path.join(ROOT, "packages");

/** Internal path aliases declared in the root tsconfig. */
const INTERNAL_ALIASES = [
  "@excel",
  "@word",
  "@formula",
  "@pdf",
  "@csv",
  "@markdown",
  "@xml",
  "@archive",
  "@stream",
  "@utils",
  "@test"
] as const;

const ALIAS_RE = new RegExp(`^(?:${INTERNAL_ALIASES.join("|")})(?:/|$)`);

/** Matches `import ... from "x"`, `export ... from "x"`, `import("x")`, `require("x")`. */
const IMPORT_RE =
  /(?:import|export)\s[^;]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|require\s*\(\s*["']([^"']+)["']\s*\)/g;

interface Violation {
  readonly file: string;
  readonly specifier: string;
  readonly reason: string;
}

function collectTsFiles(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") {
        continue;
      }
      collectTsFiles(full, out);
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
}

function specifiersOf(source: string): string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(IMPORT_RE)) {
    const specifier = match[1] ?? match[2] ?? match[3];
    if (specifier !== undefined) {
      specifiers.push(specifier);
    }
  }
  return specifiers;
}

function main(): void {
  if (!fs.existsSync(PACKAGES_DIR)) {
    console.log("verify:packages — no packages/ directory, nothing to check");
    return;
  }

  const packageDirs = fs
    .readdirSync(PACKAGES_DIR, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => path.join(PACKAGES_DIR, entry.name));

  const violations: Violation[] = [];
  let fileCount = 0;

  for (const packageDir of packageDirs) {
    const srcDir = path.join(packageDir, "src");
    if (!fs.existsSync(srcDir)) {
      continue;
    }

    const files: string[] = [];
    collectTsFiles(srcDir, files);
    fileCount += files.length;

    for (const file of files) {
      const relative = path.relative(ROOT, file).split(path.sep).join("/");
      const source = fs.readFileSync(file, "utf8");

      for (const specifier of specifiersOf(source)) {
        if (ALIAS_RE.test(specifier)) {
          violations.push({
            file: relative,
            specifier,
            reason:
              "internal path alias — import from the public entry instead, e.g. `documonster/excel`"
          });
          continue;
        }

        // A relative specifier that climbs out of the package directory can
        // only be reaching into the core's source tree.
        if (specifier.startsWith(".")) {
          const resolved = path.resolve(path.dirname(file), specifier);
          if (!resolved.startsWith(packageDir + path.sep)) {
            violations.push({
              file: relative,
              specifier,
              reason: "relative import escapes the package — use the `documonster` package entry"
            });
          }
        }
      }
    }
  }

  if (violations.length > 0) {
    console.error("verify:packages — forbidden imports found:\n");
    for (const violation of violations) {
      console.error(`  ${violation.file}`);
      console.error(`    "${violation.specifier}"`);
      console.error(`    ${violation.reason}\n`);
    }
    console.error(
      "Satellite packages must consume documonster through its public exports map.\n" +
        "See the workspace section of AGENTS.md."
    );
    process.exit(1);
  }

  console.log(
    `verify:packages — ${fileCount} file(s) across ${packageDirs.length} package(s) OK: public API only`
  );
}

main();
