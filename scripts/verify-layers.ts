/**
 * Module dependency-layer verification.
 *
 * Encodes the layer rules documented in AGENTS.md and fails (exit 1) if any
 * production source file imports across a forbidden module boundary. This is
 * the machine-enforced counterpart to the prose rules — oxlint cannot express
 * path-based import boundaries (its `no-restricted-imports` is a no-op), so we
 * scan imports ourselves.
 *
 * Scope: production `.ts` under `src/modules/<m>/` and `src/utils/`. Test
 * (`__tests__/`) and example (`examples/`) files are exempt — they may reach
 * across layers freely.
 *
 * Usage: node scripts/verify-layers.ts
 */

import fs from "node:fs";
import path from "node:path";

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
const MODULES_DIR = path.join(ROOT, "src", "modules");
const UTILS_DIR = path.join(ROOT, "src", "utils");

const MODULES = [
  "draw",
  "excel",
  "word",
  "formula",
  "pdf",
  "csv",
  "markdown",
  "xml",
  "archive",
  "stream"
] as const;
type ModuleName = (typeof MODULES)[number] | "utils";

/**
 * For each module, the set of OTHER modules it is allowed to import from.
 * A module may always import from itself; that is handled separately. `utils`
 * may import nothing. The lists mirror the layer diagram in AGENTS.md.
 */
const ALLOWED: Record<ModuleName, ReadonlySet<ModuleName>> = {
  utils: new Set([]),
  // draw is the shared drawing engine: a display-list IR plus its walker and SVG
  // serialiser. It sits beside xml/markdown/stream so excel, word and pdf can all
  // consume it, and it depends on nothing but utils.
  draw: new Set(["utils"]),
  xml: new Set(["utils"]),
  markdown: new Set(["utils"]),
  stream: new Set(["utils"]),
  csv: new Set(["stream", "utils"]),
  archive: new Set(["stream", "utils"]),
  formula: new Set(["utils"]),
  excel: new Set(["draw", "formula", "archive", "xml", "csv", "markdown", "stream", "utils"]),
  word: new Set(["draw", "formula", "archive", "xml", "csv", "markdown", "stream", "utils"]),
  // pdf may reach excel/word ONLY via the bridge files (see EXCEPTIONS); the
  // base allow-set covers the unconditional dependencies.
  pdf: new Set(["draw", "archive", "utils"])
};

/**
 * Per-file exceptions: a bridge file may import from a module that its host
 * module's base allow-set forbids. Keyed by repo-relative POSIX path.
 */
const EXCEPTIONS: Record<string, ReadonlySet<ModuleName>> = {
  "src/modules/pdf/excel-bridge.ts": new Set(["excel"]),
  "src/modules/pdf/word-chart-bridge.ts": new Set(["excel", "word"]),
  "src/modules/pdf/word-bridge.ts": new Set(["word"]),
  "src/modules/pdf/word-layout-to-pdf.ts": new Set(["word"]),
  "src/modules/word/bridge/excel-bridge.ts": new Set(["excel"])
};

const ALIAS_RE = /@(draw|excel|word|formula|pdf|csv|markdown|xml|archive|stream|utils)\b/;

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

/** Recursively collect production `.ts` files (skip tests & examples). */
function collect(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "examples") {
        continue;
      }
      collect(full, out);
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
}

/**
 * Every module specifier a file imports, with the line it appears on.
 *
 * Matched across the WHOLE source rather than line by line, so a multi-line statement
 * like `import {\n  a,\n  b\n} from "@excel/…"` is caught on its closing `from`. The
 * `[^"\'`]` runs may span newlines, which is what lets the pattern cross them.
 * Specifiers are string literals — never template literals — so backticks are excluded
 * deliberately, to avoid matching an `@alias` mentioned in a doc comment such as "must
 * NOT import from `@excel/…`".
 *
 * A bare `import "x"` has no `from` clause and was therefore invisible: importing a
 * module purely for its side effects is still importing it, and it crosses a layer
 * boundary exactly as much as a named import does.
 */
function importSpecifiers(rawSource: string): Array<{ spec: string; line: number }> {
  const source = stripComments(rawSource);
  const out: Array<{ spec: string; line: number }> = [];
  const patterns = [
    // `import … from "x"` / `export … from "x"`
    /(?:^|[\s;])(?:import|export)[^"'`]*?\bfrom\s*["']([^"']+)["']/g,
    // `import("x")` — dynamic, optionally with import attributes as a second argument.
    /\bimport\s*\(\s*["']([^"']+)["']\s*[,)]/g,
    // `import "x"` — side effect only, no bindings and no `from`
    /(?:^|[\s;])import\s*["']([^"']+)["']/g,
    // `require("x")` — CommonJS, reachable through `createRequire`
    /\brequire\s*\(\s*["']([^"']+)["']\s*[,)]/g
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      const spec = match[1];
      if (spec) {
        out.push({ spec, line: source.slice(0, match.index + match[0].length).split("\n").length });
      }
    }
  }
  return out;
}

/**
 * Which module a specifier resolves to, or `undefined` if it stays inside the module
 * that wrote it.
 *
 * Aliases are the documented way to write a cross-module import, but they are not the
 * only way one compiles: `../../excel/index` reaches just as far. Checking aliases alone
 * left a relative path as an open door through the layer rules — the one architectural
 * constraint this script exists to hold — so a specifier that climbs out of its own
 * module is resolved against the filesystem and attributed to whatever it lands in.
 */
function targetModule(fromFile: string, spec: string): ModuleName | undefined {
  const alias = spec.startsWith("@") ? spec.match(ALIAS_RE) : null;
  if (alias) {
    return alias[1] as ModuleName;
  }
  if (!spec.startsWith(".")) {
    return undefined;
  }
  const resolved = path.resolve(path.dirname(fromFile), spec);
  const fromModulesDir = path.relative(MODULES_DIR, resolved).split(path.sep);
  if (!fromModulesDir[0].startsWith("..") && MODULES.includes(fromModulesDir[0] as ModuleName)) {
    return fromModulesDir[0] as ModuleName;
  }
  const fromUtilsDir = path.relative(UTILS_DIR, resolved).split(path.sep);
  if (!fromUtilsDir[0].startsWith("..")) {
    return "utils";
  }
  return undefined;
}

interface Violation {
  file: string;
  line: number;
  target: ModuleName;
  reason: string;
}

function checkFile(absPath: string, owner: ModuleName, violations: Violation[]): void {
  const rel = path.relative(ROOT, absPath).split(path.sep).join("/");
  const source = fs.readFileSync(absPath, "utf-8");
  const allowed = ALLOWED[owner];
  const extra = EXCEPTIONS[rel];

  const seen = new Set<ModuleName>();
  for (const { spec, line } of importSpecifiers(source)) {
    const target = targetModule(absPath, spec);
    if (target === undefined || target === owner) {
      continue; // unresolvable, external, or same-module — all fine
    }
    if (seen.has(target)) {
      continue; // one report per offending module is enough
    }
    seen.add(target);
    if (allowed.has(target)) {
      continue;
    }
    if (extra?.has(target)) {
      continue;
    }
    violations.push({
      file: rel,
      line,
      target,
      reason:
        owner === "utils"
          ? `utils must not import from any module (found @${target})`
          : `${owner} may not import from @${target} (layer/boundary rule)`
    });
  }
}

function main(): void {
  const violations: Violation[] = [];

  for (const mod of MODULES) {
    const dir = path.join(MODULES_DIR, mod);
    if (!fs.existsSync(dir)) {
      continue;
    }
    const files: string[] = [];
    collect(dir, files);
    for (const f of files) {
      checkFile(f, mod, violations);
    }
  }

  // utils (Layer 0): may import nothing from modules. Its internal files use relative
  // paths, so a cross-module reference here is always a violation.
  //
  // Guarded like the module directories above: the scan should report on the tree it was
  // given, not crash because part of it is absent.
  if (fs.existsSync(UTILS_DIR)) {
    const utilsFiles: string[] = [];
    collect(UTILS_DIR, utilsFiles);
    for (const f of utilsFiles) {
      checkFile(f, "utils", violations);
    }
  }

  if (violations.length === 0) {
    console.log(`✓ Module layer check passed — no forbidden cross-module imports.`);
    return;
  }

  console.error(`✗ Module layer check failed — ${violations.length} violation(s):\n`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}\n    → ${v.reason}`);
  }
  console.error(
    `\nSee the "Module Dependency Layers" section in AGENTS.md. If a new bridge` +
      ` file legitimately needs a cross-module import, register it in the` +
      ` EXCEPTIONS map of scripts/verify-layers.ts (and document it in AGENTS.md).`
  );
  process.exit(1);
}

main();
