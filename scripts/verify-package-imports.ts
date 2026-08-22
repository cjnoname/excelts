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

import { relPosix } from "./lib/paths.ts";

/**
 * `--root <dir>` points the scan at a different tree. Used by the tests: a check that
 * never fires is worse than no check, and the only way to know this one fires is to
 * hand it a tree that breaks the rules on purpose.
 */
function rootFromArgv(): string {
  const flag = process.argv.indexOf("--root");
  return flag === -1
    ? path.resolve(import.meta.dirname, "..")
    : path.resolve(process.argv[flag + 1]);
}

const ROOT = rootFromArgv();
const PACKAGES_DIR = path.join(ROOT, "packages");

/** Internal path aliases declared in the root tsconfig. */
const INTERNAL_ALIASES = [
  "@draw",
  "@mermaid",
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

/**
 * Every form a module specifier can take.
 *
 * The bare `import "x"` is easy to forget and was: it has no bindings and no `from`
 * clause, so a pattern anchored on `from` never saw it — yet importing a module for its
 * side effects reaches into it exactly as much as a named import does, and would have
 * pulled the core's internals into a satellite unnoticed.
 */
const IMPORT_PATTERNS = [
  /(?:import|export)\s[^;]*?from\s*["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*[,)]/g,
  /(?:^|[\s;])import\s*["']([^"']+)["']/g,
  /\brequire\s*\(\s*["']([^"']+)["']\s*[,)]/g
];

interface Violation {
  readonly file: string;
  readonly specifier: string;
  readonly reason: string;
}

/**
 * Source with comments blanked out, so a specifier mentioned in prose is not read as an
 * import.
 *
 * The doc comments in this repository discuss `@excel/…` constantly — including to say
 * that a given file must *not* import it — and a commented-out import is ordinary while
 * refactoring. Both were being reported as violations.
 *
 * Replaced with spaces rather than removed, so every byte offset still lines up and the
 * reported line numbers stay true.
 */
function stripComments(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (two === "//") {
      const end = source.indexOf("\n", i);
      const stop = end === -1 ? source.length : end;
      out += " ".repeat(stop - i);
      i = stop;
      continue;
    }
    if (two === "/*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      // Keep newlines so line numbers survive.
      out += source.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop;
      continue;
    }
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      // Copy the literal whole, so a `//` inside a specifier is not mistaken for a comment.
      let j = i + 1;
      while (j < source.length && source[j] !== ch) {
        j += source[j] === "\\" ? 2 : 1;
      }
      out += source.slice(i, Math.min(j + 1, source.length));
      i = j + 1;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
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

function specifiersOf(rawSource: string): string[] {
  const source = stripComments(rawSource);
  const specifiers: string[] = [];
  for (const pattern of IMPORT_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      if (match[1] !== undefined) {
        specifiers.push(match[1]);
      }
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
      const relative = relPosix(ROOT, file);
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
