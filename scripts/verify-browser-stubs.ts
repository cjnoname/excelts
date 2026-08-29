/**
 * The browser build must never reference a Node-only module that has a stub.
 *
 * A `*.browser.ts` file exists because its sibling cannot work — or should not
 * ship — in a browser, and `scripts/fix-browser-imports.ts` redirects every
 * relative import to it. This checks that the redirect actually happened
 * everywhere, which is the difference between a stub that works and a stub that is
 * merely present.
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
 * catches the tables that exist today. The invariant is structural — a browser file
 * importing a Node module that has a browser variant — so it is checked as such,
 * and covers `fs`, `crypto`, `stream` and every other pair as a side effect.
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const DIST = path.resolve(ROOT, "dist/browser");

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

if (!fs.existsSync(DIST)) {
  console.error("verify:browser-stubs — dist/browser is missing; run `pnpm build:browser` first.");
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

function walk(dir: string): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
      continue;
    }
    if (entry.name.endsWith(".browser.js")) {
      stubsFound++;
    }
    // `.d.ts` too: the browser build's type graph pointed at Node variants once,
    // which made browser consumers need `@types/node`.
    if (!entry.name.endsWith(".js") && !entry.name.endsWith(".d.ts")) {
      continue;
    }
    filesScanned++;
    const text = fs.readFileSync(full, "utf-8");
    SPECIFIER.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = SPECIFIER.exec(text)) !== null) {
      const specifier = match[1];
      if (!specifier.startsWith(".")) {
        continue; // a bare specifier is resolved by the consumer, not by us
      }
      const resolved = path.resolve(path.dirname(full), specifier);
      const stub = resolved.replace(/\.js$/u, ".browser.js");
      if (stub !== resolved && fs.existsSync(stub)) {
        violations.push({
          file: path.relative(DIST, full),
          specifier,
          shouldBe: specifier.replace(/\.js$/u, ".browser.js")
        });
      }
    }
  }
}

walk(DIST);

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
    `✗ verify:browser-stubs — ${violations.length} import(s) reach a Node-only module that has a browser stub:`
  );
  for (const { file, specifier, shouldBe } of [...new Set(violations.map(v => JSON.stringify(v)))]
    .map(v => JSON.parse(v) as Violation)
    .slice(0, 40)) {
    console.error(`  ${file}\n    ${specifier} → should resolve to ${shouldBe}`);
  }
  process.exit(1);
}

console.log(
  `✓ verify:browser-stubs — ${filesScanned} browser file(s) checked against ${stubsFound} stub(s); none reach a Node-only sibling.`
);
