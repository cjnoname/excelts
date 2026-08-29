/**
 * Report exported symbols that nothing uses.
 *
 * Two kinds, distinguished because they call for different fixes:
 *
 * - **dead**: the name appears exactly once in the whole repository — its own
 *   declaration. Nothing imports it, no test touches it, no document mentions it.
 * - **file-local**: used only inside the file that exports it, so the `export`
 *   keyword is the only thing keeping it in the module graph.
 *
 * Publicly reachable symbols are excluded by walking the re-export closure from
 * every module entry point, so a name that reaches `documonster/excel` through three
 * hops of `export *` is never reported. Symbols marked `@internal`, or whose comment
 * says they exist for a test, are excluded too — those are deliberate.
 *
 * Read-only: prints a report and exits 0. Deleting is a judgement call per symbol.
 */
import fs from "node:fs";
import path from "node:path";

const SRC = path.resolve(process.cwd(), "src");

interface Decl {
  readonly name: string;
  readonly file: string;
  readonly line: number;
  readonly internal: boolean;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

const files = walk(SRC);
const isTest = (f: string): boolean => f.includes("__tests__") || f.endsWith(".test.ts");

/**
 * Files whose exports are entry points in their own right.
 *
 * `examples/` is run by `pnpm example` through `scripts/run-examples.ts`, and
 * `src/test/` holds helpers the suites import. Neither is reachable from a module
 * `index.ts`, so the re-export closure cannot see them.
 */
const isEntryPointFile = (f: string): boolean =>
  f.includes(`${path.sep}examples${path.sep}`) || f.includes(`${path.sep}test${path.sep}`);

/** Exported declarations, with the `@internal` / "for testing" marker resolved. */
const declarations: Decl[] = [];
const DECL =
  /^export\s+(?:declare\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/;

for (const file of files) {
  if (isTest(file) || isEntryPointFile(file)) {
    continue;
  }
  const lines = fs.readFileSync(file, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = DECL.exec(lines[i]);
    if (!m) {
      continue;
    }
    // Look back over the attached comment for a deliberate-export marker.
    let internal = false;
    for (let j = i - 1; j >= 0 && j >= i - 25; j--) {
      const text = lines[j];
      if (/@internal|for testing|for the .*test|Exported for/i.test(text)) {
        internal = true;
        break;
      }
      if (!/^\s*(\/\*\*|\*|\/\/|$)/.test(text)) {
        break; // ran out of comment
      }
    }
    declarations.push({ name: m[1], file, line: i + 1, internal });
  }
}

/**
 * Names reachable from a module entry point.
 *
 * `export *` is followed transitively; a named re-export marks just that name.
 */
const publiclyReachable = new Set<string>();
const visited = new Set<string>();

function resolveSpecifier(from: string, spec: string): string | null {
  if (!spec.startsWith(".")) {
    const aliased = spec.replace(/^@(\w+)\//, (_m, mod: string) =>
      mod === "utils" || mod === "test" ? `${mod}/` : `modules/${mod}/`
    );
    const guess = path.join(SRC, aliased);
    for (const cand of [`${guess}.ts`, path.join(guess, "index.ts")]) {
      if (fs.existsSync(cand)) {
        return cand;
      }
    }
    return null;
  }
  const base = path.resolve(path.dirname(from), spec.replace(/\.js$/, ""));
  for (const cand of [`${base}.ts`, path.join(base, "index.ts")]) {
    if (fs.existsSync(cand)) {
      return cand;
    }
  }
  return null;
}

function collectPublic(file: string): void {
  if (visited.has(file)) {
    return;
  }
  visited.add(file);
  const text = fs.readFileSync(file, "utf8");

  for (const m of text.matchAll(/export\s+\*(?:\s+as\s+\w+)?\s+from\s+["']([^"']+)["']/g)) {
    const target = resolveSpecifier(file, m[1]);
    if (target) {
      collectPublic(target);
    }
  }
  for (const m of text.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)) {
    for (const part of m[1].split(",")) {
      const name = part
        .trim()
        .split(/\s+as\s+/)[0]
        .replace(/^type\s+/, "")
        .trim();
      if (name) {
        publiclyReachable.add(name);
      }
    }
  }
  for (const m of text.matchAll(DECL_GLOBAL)) {
    publiclyReachable.add(m[1]);
  }
}

const DECL_GLOBAL = new RegExp(DECL.source, "gm");

for (const file of files) {
  if (/(?:^|\/)index(?:\.base|\.browser|\.node)?\.ts$/.test(file) && !isTest(file)) {
    collectPublic(file);
  }
}

/** Occurrence counts per name, split by where they appear. */
const counts = new Map<string, { prod: number; test: number; self: Map<string, number> }>();
for (const { name } of declarations) {
  if (!counts.has(name)) {
    counts.set(name, { prod: 0, test: 0, self: new Map() });
  }
}
/**
 * A whole-word matcher for a declared name.
 *
 * The name comes from source, so it is escaped in full rather than for the one
 * metacharacter an identifier may contain: escaping only `$` leaves the pattern
 * correct by accident, and stops being correct the moment `DECL` is widened to
 * match a quoted or computed export name.
 */
const escapeRegExp = (source: string): string => source.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
const WORD = (n: string): RegExp => new RegExp(`\\b${escapeRegExp(n)}\\b`, "g");

for (const file of files) {
  const text = fs.readFileSync(file, "utf8");
  for (const [name, tally] of counts) {
    const n = (text.match(WORD(name)) ?? []).length;
    if (n === 0) {
      continue;
    }
    if (isTest(file)) {
      tally.test += n;
    } else {
      tally.prod += n;
      tally.self.set(file, n);
    }
  }
}

const dead: Decl[] = [];
const fileLocal: Decl[] = [];

for (const decl of declarations) {
  if (decl.internal || publiclyReachable.has(decl.name)) {
    continue;
  }
  const tally = counts.get(decl.name)!;
  const elsewhere = [...tally.self].filter(([f]) => f !== decl.file);
  if (tally.prod === 1 && tally.test === 0) {
    dead.push(decl);
  } else if (elsewhere.length === 0 && tally.test === 0) {
    fileLocal.push(decl);
  }
}

const rel = (f: string): string => path.relative(process.cwd(), f);
const byModule = (list: Decl[]): Map<string, Decl[]> => {
  const out = new Map<string, Decl[]>();
  for (const d of list) {
    const m = /src\/modules\/([^/]+)\//.exec(d.file)?.[1] ?? "utils";
    out.set(m, [...(out.get(m) ?? []), d]);
  }
  return out;
};

console.log(`Dead exports (declared once, referenced nowhere): ${dead.length}`);
for (const [mod, list] of [...byModule(dead)].sort()) {
  console.log(`  ${mod} (${list.length})`);
  for (const d of list) {
    console.log(`    ${rel(d.file)}:${d.line}  ${d.name}`);
  }
}

console.log(`\nFile-local exports (the \`export\` is unnecessary): ${fileLocal.length}`);
for (const [mod, list] of [...byModule(fileLocal)].sort()) {
  console.log(`  ${mod} (${list.length})`);
}
