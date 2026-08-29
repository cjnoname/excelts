/**
 * The published tree must never reach a Node-only module that has a browser variant
 * except through a `#platform/*` specifier.
 *
 * A `*.browser.ts` file exists because its sibling cannot work — or should not ship —
 * in a browser. Selecting between them is a *resolution* concern: `link-platform-variants.ts`
 * rewrites every such import to `#platform/<path>`, and the manifest's `imports` field maps
 * that to the Node or browser file per condition. A relative specifier left behind is a
 * silent hole: the browser condition cannot fire for it, so a browser consumer receives the
 * Node module and nothing fails.
 *
 * That is what this checks, and why it checks the artifact rather than the source: the source
 * deliberately imports the Node name (`@utils/fs`), and the rewrite happens on the way out.
 *
 * The concrete failure that prompted it: `pdf/font/system-fonts.ts` and
 * `draw/raster/system-raster-font.ts` exist only to read font files off a disk, and
 * each carries a table of per-platform paths — the curated CJK families
 * (`/System/Library/Fonts/Supplemental`, `msyh.ttc`, `PingFang SC`, several hundred
 * more) and the Arial / Helvetica / DejaVu fallbacks. Both shipped to browsers. A
 * `typeof process === "undefined"` guard makes such a module *inert*, not absent: a
 * bundler has to keep every string a reachable module might use. Adding the two
 * stubs took 13.7 kB (minified) off the pdf bundle and 5.2 kB off excel.
 *
 * Why not assert on the module graph in `treeshake-verify`: those scenarios inspect
 * the entry chunk, so a module that lands in a lazily-split chunk passes while
 * still shipping. Why not grep the output for `/System/Library/Fonts`: that only
 * catches the tables that exist today. The invariant is structural — a shipped file
 * importing a Node module that has a browser variant — so it is checked as such,
 * and covers `fs`, `crypto`, `stream` and every other pair as a side effect.
 *
 * Declarations are checked alongside the JavaScript. Skipping them once left the
 * browser type graph pointing at Node variants (csv's parser typed `Transform` from
 * the Node `stream` entry while the JS loaded the browser one), so browser consumers
 * needed `@types/node`. `pnpm build:verify:browser` guards the same property from the
 * other direction, by type-checking the browser declarations with `--customConditions
 * browser` and no Node types available.
 */
import fs from "node:fs";
import path from "node:path";

/**
 * `--root <dir>` retargets the whole check — both trees and the policy list's source
 * paths. It exists for `src/test/__tests__/platform-variants.test.ts`, following
 * `verify-doc-links.ts` and `verify-layers.ts`: a gate that cannot be pointed at a tree
 * built to break it on purpose has never been shown to fire.
 */
function rootFromArgv(): string {
  const flag = process.argv.indexOf("--root");
  return flag === -1 ? process.cwd() : path.resolve(process.argv[flag + 1]);
}

const ROOT = rootFromArgv();

/**
 * The published trees. Both must be free of un-linked platform imports: the JavaScript
 * because it is what runs, the declarations because they are what a consumer's compiler
 * follows.
 */
const TREES = [path.resolve(ROOT, "dist/esm"), path.resolve(ROOT, "dist/types")];

/**
 * Modules that **must** keep a browser stub, and why.
 *
 * The structural check below cannot notice a stub that has been *deleted*: with no
 * sibling to redirect to there is nothing for it to call a violation, so it would
 * report success while the Node module shipped again. These entries are the policy
 * statement that the check alone cannot express — a module whose whole content is
 * platform-specific data that a browser can never act on.
 *
 * Keep the list short. It is for modules where shipping the Node variant is a
 * *correctness or size* defect, not for every pair that happens to exist.
 */
const REQUIRE_BROWSER_STUB: readonly { readonly module: string; readonly why: string }[] = [
  {
    module: "src/modules/pdf/font/system-fonts.ts",
    why: "curated CJK font filenames and per-platform font directories — 38 kB of paths a browser cannot open"
  },
  {
    module: "src/modules/draw/raster/system-raster-font.ts",
    why: "Arial / Helvetica / DejaVu fallback paths for the rasteriser"
  }
];

const missingTrees = TREES.filter(tree => !fs.existsSync(tree));
if (missingTrees.length > 0) {
  console.error(
    `verify:browser-stubs — ${missingTrees.map(t => path.relative(ROOT, t)).join(", ")} ` +
      "is missing; run `pnpm build:esm` first."
  );
  process.exit(1);
}

/** Every relative specifier in a file, from static imports, re-exports and `import()`. */
const SPECIFIER = /(?:\bfrom|\bimport\s*\(?|\brequire\s*\()\s*["']([^"']+)["']/g;

interface Violation {
  readonly file: string;
  readonly specifier: string;
  readonly shouldBe: string;
}

const violations: Violation[] = [];
let filesScanned = 0;
let stubsFound = 0;

function walk(tree: string, dir: string): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(tree, full);
      continue;
    }
    if (entry.name.endsWith(".browser.js") || entry.name.endsWith(".browser.d.ts")) {
      stubsFound++;
    }
    if (!entry.name.endsWith(".js") && !entry.name.endsWith(".d.ts")) {
      continue;
    }
    const siblingExtension = entry.name.endsWith(".d.ts") ? ".d.ts" : ".js";
    filesScanned++;
    const text = fs.readFileSync(full, "utf-8");
    SPECIFIER.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = SPECIFIER.exec(text)) !== null) {
      const specifier = match[1];
      if (!specifier.startsWith(".")) {
        // A `#platform/*` specifier is the linked form and the whole point; any other
        // bare specifier is resolved by the consumer, not by us.
        continue;
      }
      const resolved = path.resolve(path.dirname(full), specifier);
      const base = resolved.replace(/\.js$/u, "");
      if (base === resolved) {
        continue;
      }
      if (fs.existsSync(`${base}.browser${siblingExtension}`)) {
        violations.push({
          file: path.relative(ROOT, full),
          specifier,
          shouldBe: `#platform/${path.relative(tree, base).split(path.sep).join("/")}`
        });
      }
    }
  }
}

for (const tree of TREES) {
  walk(tree, tree);
}

// Policy: the stub has to exist in the first place.
const missingStubs = REQUIRE_BROWSER_STUB.filter(
  entry => !fs.existsSync(path.resolve(ROOT, entry.module.replace(/\.ts$/u, ".browser.ts")))
);
if (missingStubs.length > 0) {
  console.error(
    `✗ verify:browser-stubs — ${missingStubs.length} module(s) that must not ship to browsers have no stub:`
  );
  for (const { module, why } of missingStubs) {
    console.error(`  ${module}\n    needs ${module.replace(/\.ts$/u, ".browser.ts")} — ${why}`);
  }
  process.exit(1);
}

if (violations.length > 0) {
  console.error(
    `✗ verify:browser-stubs — ${violations.length} import(s) reach a Node-only module that ` +
      "has a browser variant without going through `#platform/*`, so the browser condition " +
      "cannot select the variant:"
  );
  for (const { file, specifier, shouldBe } of [...new Set(violations.map(v => JSON.stringify(v)))]
    .map(v => JSON.parse(v) as Violation)
    .slice(0, 40)) {
    console.error(`  ${file}\n    ${specifier} → should be ${shouldBe}`);
  }
  console.error("\nDid `scripts/link-platform-variants.ts` run after `fix-esm-imports.ts`?");
  process.exit(1);
}

console.log(
  `✓ verify:browser-stubs — ${filesScanned} published file(s) checked against ${stubsFound} ` +
    "variant(s); every platform import is linked through `#platform/*`."
);
