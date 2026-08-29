#!/usr/bin/env node
/**
 * Redirect every import of a platform-swappable module to a `#platform/*` specifier,
 * so the package resolves the variant instead of shipping a second copy of the tree.
 *
 * ## What this replaces
 *
 * A module with a `*.browser.ts` sibling exists because its Node twin cannot work — or
 * must not ship — in a browser. Selecting between them used to be a *build target*:
 * `tsconfig.browser.json` compiled the whole of `src` a second time into `dist/browser`,
 * then `scripts/fix-browser-imports.ts` walked that copy and rewrote relative specifiers
 * to prefer the `.browser` sibling. Its own log line said what that cost:
 *
 *     Prefer browser imports in dist/browser: modified 112 files; rewrote 158 specifiers.
 *
 * 12.6 MB of published artifact to change 158 strings. Comparing the two trees
 * file-by-file, 705 of 784 `.js` were byte-identical to `dist/esm` and 751 of 784
 * `.d.ts` to `dist/types`; nothing existed in `dist/browser` that was not already in
 * `dist/esm`, because `tsc` compiles the `.browser.ts` files into both.
 *
 * So the variant is not built, it is *resolved*. This rewrites those same 158
 * specifiers to `#platform/<path>`, and one wildcard entry in the manifest's `imports`
 * field expresses the choice:
 *
 *     "#platform/*": {
 *       "browser": { "types": "./dist/types/*.browser.d.ts", "default": "./dist/esm/*.browser.js" },
 *       "default": { "types": "./dist/types/*.d.ts",         "default": "./dist/esm/*.js" }
 *     }
 *
 * A wildcard rather than 27 explicit entries: a new `*.browser.ts` then needs no
 * manifest edit, so the list cannot drift from the tree it describes.
 *
 * ## Why the importer stops differing
 *
 * The 79 files that differed between the trees were mostly not platform code — they
 * were *importers* whose specifier had been rewritten. A file that imports
 * `#platform/utils/fs` is byte-identical in both worlds, so the difference collapses
 * to the 27 variant files themselves, which `dist/esm` already carries.
 *
 * ## Ordering
 *
 * Runs after `fix-esm-imports.ts`, which has by then turned tsconfig path aliases into
 * relative specifiers and given them explicit extensions. That is what lets this work
 * on one uniform shape — a relative `./x.js` — instead of knowing about aliases.
 * Declaration files spell their specifiers `.js` too (NodeNext), so the match is the
 * same in both trees; only the sibling probed for differs (`.browser.d.ts`).
 *
 * A specifier that already names a `.browser` file is left alone. Those are deliberate:
 * `surface/workbook.browser.ts` imports `core/workbook.browser` because it is only ever
 * reachable from the browser entry, and routing it through a condition would be a lie.
 *
 * Usage: node scripts/link-platform-variants.ts [--dist dist/esm] [--types dist/types]
 */
import fs from "node:fs";
import path from "node:path";

import { relPosix, toPosixPath } from "./lib/paths.ts";

const projectRoot = path.resolve(import.meta.dirname, "..");

/** The `imports` prefix the manifest maps. Keep in sync with `package.json#imports`. */
const PLATFORM_PREFIX = "#platform/";

function readArg(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
}

/**
 * A default relative to the repository (so `pnpm build:esm` works from anywhere), but an
 * explicit argument relative to the **cwd**, which is what a CLI is expected to do and what
 * lets `src/test/__tests__/platform-variants.test.ts` point this at a fixture tree.
 *
 * Resolving an explicit argument against the repository root instead — as `fix-esm-imports.ts`
 * used to — silently retargets `--dist dist/esm` at the real tree from any other directory.
 * That is how the first version of that test passed while doing nothing at all.
 */
function resolveDirArg(value: string | null, fallback: string): string {
  return value === null ? path.join(projectRoot, fallback) : path.resolve(value);
}

const esmDir = resolveDirArg(readArg("--dist"), "dist/esm");
const typesDir = resolveDirArg(readArg("--types"), "dist/types");

const STATIC_IMPORT_RE = /((?:import|export)\s*(?:[^'"]*\s+from\s+)?['"])(\.[^'"]+)(['"])/g;
const DYNAMIC_IMPORT_RE = /(import\s*\(\s*['"])(\.[^'"]+)(['"]\s*\))/g;

function isFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function walk(dir: string, extensions: readonly string[]): string[] {
  const found: string[] = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && extensions.some(ext => entry.name.endsWith(ext))) {
        found.push(full);
      }
    }
  }
  return found;
}

interface Tree {
  /** Root the `#platform/*` key is measured from. */
  readonly root: string;
  /** Files to rewrite. */
  readonly extensions: readonly string[];
  /** Extension of the sibling that proves a variant exists. */
  readonly siblingExtension: string;
}

/**
 * The `#platform/*` specifier for a relative import, or `null` when the target has no
 * browser variant and should stay relative.
 */
function platformSpecifier(tree: Tree, filePath: string, specifier: string): string | null {
  if (specifier.includes(".browser.") || !specifier.endsWith(".js")) {
    return null;
  }
  const target = path.resolve(path.dirname(filePath), specifier);
  const base = target.slice(0, -".js".length);
  if (!isFile(`${base}.browser${tree.siblingExtension}`)) {
    return null;
  }
  const key = relPosix(tree.root, base);
  // A target outside the tree cannot be named by the wildcard, and silently leaving it
  // relative would ship Node code to browsers. Nothing produces one today.
  if (key.startsWith("..")) {
    throw new Error(`${filePath}: "${specifier}" resolves outside ${toPosixPath(tree.root)}`);
  }
  return `${PLATFORM_PREFIX}${key}`;
}

interface Result {
  readonly filesModified: number;
  readonly specifiersRewritten: number;
  /** Specifiers already in linked form, left by an earlier run over the same tree. */
  readonly alreadyLinked: number;
}

function linkTree(tree: Tree): Result {
  let filesModified = 0;
  let specifiersRewritten = 0;
  let alreadyLinked = 0;

  for (const filePath of walk(tree.root, tree.extensions)) {
    const original = fs.readFileSync(filePath, "utf8");
    alreadyLinked += original.split(PLATFORM_PREFIX).length - 1;
    const rewrite = (match: string, prefix: string, specifier: string, suffix: string): string => {
      const replacement = platformSpecifier(tree, filePath, specifier);
      if (replacement === null) {
        return match;
      }
      specifiersRewritten++;
      return `${prefix}${replacement}${suffix}`;
    };
    const updated = original.replace(STATIC_IMPORT_RE, rewrite).replace(DYNAMIC_IMPORT_RE, rewrite);
    if (updated !== original) {
      fs.writeFileSync(filePath, updated);
      filesModified++;
    }
  }

  return { filesModified, specifiersRewritten, alreadyLinked };
}

const trees: readonly Tree[] = [
  { root: esmDir, extensions: [".js"], siblingExtension: ".js" },
  // The ESM tree also carries co-located declarations in some builds, and the types
  // tree carries only declarations. Probing for `.d.ts` in both is harmless: a `.js`
  // sibling has already been matched by the pass above.
  { root: esmDir, extensions: [".d.ts"], siblingExtension: ".d.ts" },
  { root: typesDir, extensions: [".d.ts"], siblingExtension: ".d.ts" }
];

let rewritten = 0;
let linked = 0;
for (const tree of trees) {
  if (!fs.existsSync(tree.root)) {
    continue;
  }
  const { filesModified, specifiersRewritten, alreadyLinked } = linkTree(tree);
  rewritten += specifiersRewritten;
  linked += alreadyLinked;
  console.log(
    `Platform variants in ${toPosixPath(tree.root)} (${tree.extensions.join(", ")}): ` +
      `modified ${filesModified} file(s); rewrote ${specifiersRewritten} specifier(s).`
  );
}

// A silent no-op is the dangerous outcome: every `#platform/*` specifier would be absent,
// the browser condition would never fire, and browser consumers would receive the Node
// variants — a correctness failure that no type check or Node test can see.
//
// "Nothing to rewrite" is only that failure when nothing is linked *either*. A second run
// over an already-linked tree rewrites nothing and is correct, so it must not fail: a build
// step that cannot be run twice is a build step that breaks the moment `tsc` emits
// incrementally.
if (rewritten === 0 && linked === 0) {
  console.error(
    "❌ No platform specifiers rewritten. Either the trees are missing, or " +
      "`fix-esm-imports.ts` no longer emits relative specifiers for aliased imports."
  );
  process.exit(1);
}
