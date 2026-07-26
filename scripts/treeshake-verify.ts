/**
 * Tree-shaking verification script.
 *
 * Verifies tree-shaking correctness across three bundlers (esbuild, rolldown,
 * rspack) and two platforms (node + browser) by:
 * 1. Creating a temporary consumer project that depends on documonster via symlink
 * 2. Bundling minimal import scenarios
 * 3. Inspecting output to verify unused modules are eliminated
 *
 * Usage: npx tsx scripts/treeshake-verify.ts
 */

import fs from "node:fs";
import path from "node:path";

import { rspack } from "@rspack/core";
import { buildSync } from "esbuild";
import { build as rolldownBuild } from "rolldown";

// =============================================================================
// Configuration
// =============================================================================

const ROOT = path.resolve(import.meta.dirname, "..");
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8"));
const PKG_NAME: string = PKG.name;
const TMP_DIR = path.join(ROOT, "tmp");

// Common mustNotInclude patterns
const ALL_MODULES = [
  "modules/excel/",
  "modules/formula/",
  "modules/pdf/",
  "modules/csv/",
  "modules/archive/",
  "modules/stream/",
  "modules/xml/",
  "modules/markdown/"
];
const NOT_EXCEL_PDF_CSV = ["modules/excel/", "modules/formula/", "modules/pdf/", "modules/csv/"];

/**
 * The formula-engine module trees that must never be dragged in by a
 * `documonster/excel` consumer — the evaluator, the built-in function library,
 * the calc integration layer, and the excel→engine adapter. Reaching them is
 * what `documonster/excel/formula` is for.
 * (`modules/formula/syntax/` is excluded from this list on purpose: the
 * defined-name syntax probe legitimately pulls the tokenizer + parser.)
 */
const FORMULA_ENGINE_MODULES = [
  "modules/formula/compile/",
  "modules/formula/runtime/",
  "modules/formula/functions/",
  "modules/formula/integration/",
  "modules/formula/materialize/",
  "modules/excel/core/formula-adapter.js"
];

/** Exclude all modules except the listed ones */
function allModulesExcept(...keep: string[]): string[] {
  return ALL_MODULES.filter(m => !keep.some(k => m.includes(k)));
}

// =============================================================================
// Scenarios
// =============================================================================

interface Scenario {
  name: string;
  importFrom: string;
  imports: string[];
  mustNotInclude: string[];
  platform?: "browser" | "node";
  /** Bundlers to skip for this scenario (known tool limitations). */
  excludeBundlers?: string[];
  /**
   * When true, bundle with code-splitting and assert only against the ENTRY
   * chunk. Use for namespaces with lazy `import()` boundaries (e.g. `Pdf`'s
   * cross-module converters): the heavy dependency must live in a separate
   * on-demand chunk, not the entry a consumer pays for upfront.
   */
  lazySplit?: boolean;
  /**
   * Optional expression that *uses* the imports, overriding the default
   * `console.log(<imports>)`. Use to assert member-level tree-shaking — e.g.
   * `console.log(Formula.tokenize)` must not retain the evaluator/functions
   * that other `Formula` members reach.
   */
  useExpr?: string;
}

/** Shorthand for creating a scenario */
function s(
  name: string,
  importFrom: string,
  imports: string[],
  mustNotInclude: string[],
  platform?: "browser" | "node",
  excludeBundlers?: string[]
): Scenario {
  return { name, importFrom, imports, mustNotInclude, platform, excludeBundlers };
}

// =============================================================================
// Full-coverage namespace matrix
//
// Every public domain namespace on every subpath is verified individually,
// using code-splitting + ENTRY-CHUNK isolation (lazySplit) so the assertion
// reflects what a consumer eagerly pays for under the real target bundlers
// (rolldown / rspack). For each namespace we declare the set of LOWER-LAYER
// modules it is legitimately allowed to reach (per AGENTS.md layer rules);
// every other module tree must be absent from the entry chunk.
//
// `allowed` lists module-path fragments that may legitimately appear. The
// resulting `mustNotInclude` is "all module trees except self + allowed".
// =============================================================================

const ALL_MODULE_TREES = [
  "modules/excel/",
  "modules/word/",
  "modules/pdf/",
  "modules/formula/",
  "modules/csv/",
  "modules/markdown/",
  "modules/xml/",
  "modules/archive/",
  "modules/stream/"
];

/** Build a mustNotInclude list = every module tree except `self` and `allowed`. */
function exclude(self: string, allowed: string[]): string[] {
  const keep = new Set([`modules/${self}/`, ...allowed]);
  return ALL_MODULE_TREES.filter(m => !keep.has(m));
}

/**
 * Generate a full-coverage, entry-chunk-isolated scenario for one namespace.
 * `allowed` = lower-layer module trees this namespace may legitimately pull.
 */
function ns(
  mod: string,
  nsName: string,
  allowed: string[],
  platform?: "browser" | "node",
  excludeBundlers?: string[]
): Scenario {
  const tag = platform === "browser" ? "browser " : "";
  const allowedNote = allowed.length
    ? `allows ${allowed.map(a => a.replace("modules/", "").replace(/\/$/, "")).join("+")}`
    : "isolated";
  return {
    name: `${tag}/${mod}: ${nsName} (${allowedNote})`,
    importFrom: `${PKG_NAME}/${mod}`,
    imports: [nsName],
    mustNotInclude: exclude(mod, allowed),
    platform,
    lazySplit: true,
    excludeBundlers
  };
}

const scenarios: Scenario[] = [
  // ===========================================================================
  // /excel subpath — ALL 20 namespaces. Per the layer rules, excel may reach
  // formula / archive / xml / csv / markdown / stream, but NEVER pdf or word.
  // Measured legitimate lower-layer reach is encoded per-namespace below.
  // ===========================================================================
  ns("excel", "Address", []),
  ns("excel", "Anchor", []),
  ns("excel", "Cell", []),
  ns("excel", "Chart", ["modules/xml/"]), // xml/encode for chart XML
  ns("excel", "Chartsheet", []),
  ns("excel", "Column", []),
  ns("excel", "DataValidation", []),
  ns("excel", "DefinedNames", ["modules/formula/"]), // named ranges may hold formulas
  ns("excel", "Form", []),
  ns("excel", "Image", []),
  ns("excel", "Note", []),
  ns("excel", "Pivot", []),
  ns("excel", "Range", []),
  ns("excel", "Row", []),
  ns("excel", "Sparkline", []),
  // xlsx streaming = zip + xml writer/sax + stream primitives
  ns("excel", "Stream", ["modules/archive/", "modules/xml/", "modules/stream/"]),
  ns("excel", "Table", []),
  ns("excel", "Watermark", []),
  // save xlsx = zip + xml + stream; defined-names pull the formula syntax probe
  ns("excel", "Workbook", [
    "modules/archive/",
    "modules/xml/",
    "modules/stream/",
    "modules/formula/"
  ]),
  ns("excel", "Worksheet", []),

  // ===========================================================================
  // /word subpath — ALL 19 namespaces. word may reach formula / archive / xml /
  // csv / markdown / stream, but NEVER pdf or excel (excel-bridge is lazy).
  // ===========================================================================
  ns("word", "Build", ["modules/xml/"]), // xml/encode for content XML
  ns("word", "Convert", ["modules/archive/", "modules/xml/", "modules/stream/"]), // ODT/docx IO
  ns("word", "Diff", []),
  ns("word", "Document", []),
  ns("word", "Font", []),
  ns("word", "Glossary", []),
  ns("word", "Io", ["modules/archive/", "modules/xml/", "modules/stream/"]), // docx read/write
  ns("word", "Layout", ["modules/xml/"]), // xml/encode
  ns("word", "Ole", ["modules/xml/"]), // xml/encode
  ns("word", "Query", ["modules/xml/"]), // parses docx content (dom/sax)
  ns("word", "RenderContext", []),
  ns("word", "Security", []),
  ns("word", "Streaming", ["modules/archive/", "modules/xml/", "modules/stream/"]),
  ns("word", "Styles", []),
  ns("word", "Template", ["modules/xml/"]), // parses template content (dom/sax)
  ns("word", "Theme", []),
  ns("word", "Units", []),
  ns("word", "Validation", []),
  ns("word", "Vba", []),

  // ===========================================================================
  // Small modules — single namespace each.
  // ===========================================================================
  ns("csv", "Csv", ["modules/stream/"]), // streaming CSV
  ns("xml", "Xml", []),
  ns("markdown", "Markdown", []),
  ns("formula", "Formula", []),
  ns("pdf", "Pdf", ["modules/archive/", "modules/xml/"]), // zlib + PDF metadata XML

  // ===========================================================================
  // /excel member-level — chart CREATE path must NOT pull the SVG/PNG renderers
  // (chart-renderer.js / chart-ex-renderer.js, ~550 KB combined). Guards the
  // chart-handle → chart-render-ops split: `Chart.add` (create) and
  // `Workbook.create` must render-free; only `Chart.toSVG`/`toPNG` pull the
  // renderers. Verified on rspack (file-level DCE) — without the split, rspack
  // dragged the renderers into every `Chart.add` consumer via the shared
  // chart-handle module.
  // ===========================================================================
  {
    name: "/excel: Chart.add (create path, no renderers)",
    importFrom: `${PKG_NAME}/excel`,
    imports: ["Chart"],
    useExpr: "console.log(Chart.add)",
    mustNotInclude: ["chart/chart-renderer.js", "chart/chart-ex-renderer.js"],
    lazySplit: true,
    excludeBundlers: ["esbuild"]
  },
  {
    name: "/excel: Workbook.create (no renderers)",
    importFrom: `${PKG_NAME}/excel`,
    imports: ["Workbook"],
    useExpr: "console.log(Workbook.create())",
    mustNotInclude: ["chart/chart-renderer.js", "chart/chart-ex-renderer.js"],
    lazySplit: true,
    excludeBundlers: ["esbuild"]
  },

  // ===========================================================================
  // /excel member-level — formula recalculation is published as its own subpath
  // (`documonster/excel/formula`, issue #193) precisely so it stays strictly
  // opt-in: a consumer of `documonster/excel` must NOT pay for the evaluator,
  // the 433 built-in functions, the calc integration layer, or the excel→engine
  // adapter.
  //
  // `modules/formula/syntax/` is deliberately NOT excluded: `DefinedNames`
  // classification pulls the tokenizer + parser regardless (already encoded in
  // the `Workbook` namespace scenario above).
  // ===========================================================================
  {
    name: "/excel: Workbook.create (no formula engine)",
    importFrom: `${PKG_NAME}/excel`,
    imports: ["Workbook"],
    useExpr: "console.log(Workbook.create())",
    mustNotInclude: FORMULA_ENGINE_MODULES,
    lazySplit: true,
    excludeBundlers: ["esbuild"]
  },
  {
    name: "/excel: Workbook.toBuffer (no formula engine)",
    importFrom: `${PKG_NAME}/excel`,
    imports: ["Workbook"],
    useExpr: "console.log(Workbook.toBuffer)",
    mustNotInclude: FORMULA_ENGINE_MODULES,
    lazySplit: true,
    excludeBundlers: ["esbuild"]
  },
  {
    name: "browser /excel: Workbook.create (no formula engine)",
    importFrom: `${PKG_NAME}/excel`,
    imports: ["Workbook"],
    useExpr: "console.log(Workbook.create())",
    mustNotInclude: FORMULA_ENGINE_MODULES,
    platform: "browser",
    lazySplit: true,
    excludeBundlers: ["esbuild"]
  },

  // The recalculation subpath itself: pulls excel + the engine (that is the
  // whole point) but must stay clear of every unrelated module tree.
  s(
    "/excel/formula: calculateFormulas",
    `${PKG_NAME}/excel/formula`,
    ["calculateFormulas"],
    exclude("excel", ["modules/formula/", "modules/archive/", "modules/xml/", "modules/stream/"])
  ),
  s(
    "browser /excel/formula: calculateFormulas",
    `${PKG_NAME}/excel/formula`,
    ["calculateFormulas"],
    exclude("excel", ["modules/formula/", "modules/archive/", "modules/xml/", "modules/stream/"]),
    "browser"
  ),

  // ===========================================================================
  // /pdf member-level — `Pdf.create` must NOT bundle the Type3 Unicode glyph
  // tables (~700 KB of math/arrow/dingbat vector glyphs). They are loaded
  // lazily via dynamic import() inside FontManager, only when a document
  // actually contains non-WinAnsi characters. A plain-text PDF never pays.
  // ===========================================================================
  {
    name: "/pdf: Pdf.create (no Type3 glyph tables)",
    importFrom: `${PKG_NAME}/pdf`,
    imports: ["Pdf"],
    useExpr: "console.log(Pdf.create)",
    mustNotInclude: [
      "pdf/font/type3-glyphs-quality.js",
      "pdf/font/type3-glyphs-fill.js",
      "pdf/font/type3-glyphs-extended.js",
      "pdf/font/type3-glyphs.js",
      "pdf/font/type3-font.js"
    ],
    lazySplit: true,
    excludeBundlers: ["esbuild"]
  },

  // ===========================================================================
  // /formula member-level — the 433-function evaluator must NOT be pulled by
  // the light syntax-only members. Guards the `function-registry` lazy-init
  // fix (no top-level `ensureRegistryInitialized()` side effect): a consumer
  // who only tokenizes/parses must never bundle the evaluator or functions.
  //
  // esbuild is excluded: it does not tree-shake individual members off a
  // re-exported `* as Namespace` object as aggressively as the target bundlers
  // (rolldown / rspack), so it retains the whole `Formula` member graph. The
  // contract that matters — proven green on rolldown AND rspack — is that the
  // SOURCE has no eager coupling forcing the evaluator into a tokenize-only
  // consumer.
  // ===========================================================================
  {
    name: "/formula: Formula.tokenize (no evaluator/functions)",
    importFrom: `${PKG_NAME}/formula`,
    imports: ["Formula"],
    useExpr: "console.log(Formula.tokenize)",
    mustNotInclude: ["modules/formula/runtime/", "modules/formula/functions/"],
    lazySplit: true,
    excludeBundlers: ["esbuild"]
  },
  {
    name: "/formula: Formula.parse (no evaluator/functions)",
    importFrom: `${PKG_NAME}/formula`,
    imports: ["Formula"],
    useExpr: "console.log(Formula.parse)",
    mustNotInclude: ["modules/formula/runtime/", "modules/formula/functions/"],
    lazySplit: true,
    excludeBundlers: ["esbuild"]
  },

  // ===========================================================================
  // Browser platform — ALL namespaces re-verified on the browser entries.
  // ===========================================================================
  ns("excel", "Address", [], "browser"),
  ns("excel", "Anchor", [], "browser"),
  ns("excel", "Cell", [], "browser"),
  ns("excel", "Chart", ["modules/xml/"], "browser"),
  ns("excel", "Chartsheet", [], "browser"),
  ns("excel", "Column", [], "browser"),
  ns("excel", "DataValidation", [], "browser"),
  ns("excel", "DefinedNames", ["modules/formula/"], "browser"),
  ns("excel", "Form", [], "browser"),
  ns("excel", "Image", [], "browser"),
  ns("excel", "Note", [], "browser"),
  ns("excel", "Pivot", [], "browser"),
  ns("excel", "Range", [], "browser"),
  ns("excel", "Row", [], "browser"),
  ns("excel", "Sparkline", [], "browser"),
  ns("excel", "Stream", ["modules/archive/", "modules/xml/", "modules/stream/"], "browser"),
  ns("excel", "Table", [], "browser"),
  ns("excel", "Watermark", [], "browser"),
  ns(
    "excel",
    "Workbook",
    ["modules/archive/", "modules/xml/", "modules/stream/", "modules/formula/"],
    "browser"
  ),
  ns("excel", "Worksheet", [], "browser"),

  ns("word", "Build", ["modules/xml/"], "browser"),
  ns("word", "Convert", ["modules/archive/", "modules/xml/", "modules/stream/"], "browser"),
  ns("word", "Diff", [], "browser"),
  ns("word", "Document", [], "browser"),
  ns("word", "Font", [], "browser"),
  ns("word", "Glossary", [], "browser"),
  ns("word", "Io", ["modules/archive/", "modules/xml/", "modules/stream/"], "browser"),
  ns("word", "Layout", ["modules/xml/"], "browser"),
  ns("word", "Ole", ["modules/xml/"], "browser"),
  ns("word", "Query", ["modules/xml/"], "browser"),
  ns("word", "RenderContext", [], "browser"),
  ns("word", "Security", [], "browser"),
  ns("word", "Streaming", ["modules/archive/", "modules/xml/", "modules/stream/"], "browser"),
  ns("word", "Styles", [], "browser"),
  ns("word", "Template", ["modules/xml/"], "browser"),
  ns("word", "Theme", [], "browser"),
  ns("word", "Units", [], "browser"),
  ns("word", "Validation", [], "browser"),
  ns("word", "Vba", [], "browser"),

  ns("csv", "Csv", ["modules/stream/"], "browser"),
  ns("xml", "Xml", [], "browser"),
  ns("markdown", "Markdown", [], "browser"),
  ns("formula", "Formula", [], "browser"),
  ns("pdf", "Pdf", ["modules/archive/", "modules/xml/"], "browser"),

  // ===========================================================================
  // Infrastructure modules — intentionally flat exports (not namespaced).
  // ===========================================================================
  s(
    "/archive: crc32 (minimal)",
    `${PKG_NAME}/archive`,
    ["crc32"],
    [...NOT_EXCEL_PDF_CSV, "modules/archive/zip/", "modules/archive/unzip/", "modules/archive/tar/"]
  ),
  s("/stream: pipeline", `${PKG_NAME}/stream`, ["pipeline"], allModulesExcept("stream"))
];

// =============================================================================
// Setup
// =============================================================================

function setupTmpProject(): void {
  if (fs.existsSync(TMP_DIR)) {
    fs.rmSync(TMP_DIR, { recursive: true });
  }
  fs.mkdirSync(TMP_DIR, { recursive: true });

  fs.writeFileSync(
    path.join(TMP_DIR, "package.json"),
    JSON.stringify({ name: "treeshake-test", type: "module", private: true }, null, 2)
  );

  // Symlink documonster into node_modules (handles scoped packages)
  const nmDir = path.join(TMP_DIR, "node_modules");
  const scope = PKG_NAME.startsWith("@") ? PKG_NAME.split("/")[0] : null;
  const parentDir = scope ? path.join(nmDir, scope) : nmDir;
  fs.mkdirSync(parentDir, { recursive: true });
  fs.symlinkSync(ROOT, path.join(nmDir, PKG_NAME), "dir");
}

// =============================================================================
// Shared types & helpers
// =============================================================================

interface ModuleEntry {
  path: string;
  bytes: number;
}

interface ScenarioResult {
  name: string;
  bundler: string;
  bundleSize: number;
  contributingModules: ModuleEntry[];
  parsedModuleCount: number;
  violations: { pattern: string; matchedModules: ModuleEntry[] }[];
  passed: boolean;
}

function makeEntryCode(scenario: Scenario): string {
  const names = scenario.imports.join(", ");
  const use = scenario.useExpr ?? `console.log(${names})`;
  return `import { ${names} } from "${scenario.importFrom}";\n${use};`;
}

function normalizePath(filePath: string): string {
  const idx = filePath.indexOf("dist/");
  return idx >= 0 ? filePath.substring(idx) : filePath;
}

/**
 * Extract the dist modules whose code actually survives into an emitted
 * bundle, by scanning the per-module path markers every supported bundler
 * leaves in **un-minified** output:
 *
 *   esbuild   `// dist/esm/modules/excel/cell.js`
 *   rolldown  `//#region dist/browser/modules/excel/cell.js`
 *   rspack    `// CONCATENATED MODULE: ./dist/esm/modules/excel/cell.js`
 *
 * This is the ground-truth tree-shaking signal: a module that the bundler
 * eliminated via DCE leaves NO marker. (Parsed-module stats / metafile inputs
 * list modules that entered the graph but may have been dropped from output —
 * using them as the contract produces false positives. Verified: a marker
 * appears iff the module's function bodies appear in the bundle.)
 *
 * `bytes` is the rendered length of that module's slice (best-effort, for
 * reporting only); presence/absence is what the contract checks.
 */
const MODULE_MARKER_RE =
  /(?:\/\/#region\s+|\/\/\s+CONCATENATED MODULE:\s+\.?\/?|\/\/\s+)(dist\/(?:esm|browser)\/[^\s*]+\.js)/g;

function extractContributingFromBundle(bundleText: string): ModuleEntry[] {
  const seen = new Map<string, number>();
  let m: RegExpExecArray | null;
  MODULE_MARKER_RE.lastIndex = 0;
  while ((m = MODULE_MARKER_RE.exec(bundleText)) !== null) {
    const p = normalizePath(m[1]);
    // Approximate the module slice length: distance to the next marker.
    const start = m.index;
    MODULE_MARKER_RE.lastIndex = start + m[0].length;
    const next = MODULE_MARKER_RE.exec(bundleText);
    const end = next ? next.index : bundleText.length;
    MODULE_MARKER_RE.lastIndex = next ? next.index : bundleText.length;
    seen.set(p, (seen.get(p) ?? 0) + (end - start));
  }
  return [...seen].map(([p, bytes]) => ({ path: p, bytes }));
}

/** Read every emitted JS/MJS file in a directory and concatenate. */
function readEmittedBundle(dir: string, onlyFile?: string): string {
  if (onlyFile) {
    const fp = path.join(dir, onlyFile);
    return fs.existsSync(fp) ? fs.readFileSync(fp, "utf-8") : "";
  }
  let text = "";
  for (const name of fs.readdirSync(dir)) {
    if (name.endsWith(".mjs") || name.endsWith(".js")) {
      text += fs.readFileSync(path.join(dir, name), "utf-8") + "\n";
    }
  }
  return text;
}

function checkViolations(
  contributing: ModuleEntry[],
  mustNotInclude: string[]
): ScenarioResult["violations"] {
  const violations: ScenarioResult["violations"] = [];
  for (const pattern of mustNotInclude) {
    const matched = contributing.filter(m => m.path.includes(pattern));
    if (matched.length > 0) {
      violations.push({ pattern, matchedModules: matched });
    }
  }
  return violations;
}

function makeResult(
  scenario: Scenario,
  bundler: string,
  bundleSize: number,
  contributing: ModuleEntry[],
  parsedCount: number
): ScenarioResult {
  const violations = checkViolations(contributing, scenario.mustNotInclude);
  if (bundleSize > 0 && contributing.length === 0) {
    violations.push({
      pattern: "NO_MODULE_MARKERS",
      matchedModules: [
        { path: "non-empty bundle contained no recognised dist module markers", bytes: 0 }
      ]
    });
  }
  return {
    name: scenario.name,
    bundler,
    bundleSize,
    contributingModules: contributing.sort((a, b) => b.bytes - a.bytes),
    parsedModuleCount: parsedCount,
    violations,
    passed: violations.length === 0
  };
}

function makeError(name: string, bundler: string, message: string): ScenarioResult {
  return {
    name,
    bundler,
    bundleSize: 0,
    contributingModules: [],
    parsedModuleCount: 0,
    violations: [{ pattern: "BUILD_FAILED", matchedModules: [{ path: message, bytes: 0 }] }],
    passed: false
  };
}

function writeEntry(bundler: string, scenario: Scenario): { entryFile: string; slug: string } {
  const slug = scenario.name.replace(/\W+/g, "-");
  const entryFile = path.join(TMP_DIR, `${bundler}-${slug}.mjs`);
  fs.writeFileSync(entryFile, makeEntryCode(scenario), "utf-8");
  return { entryFile, slug };
}

// =============================================================================
// Bundler runners
// =============================================================================

function runEsbuild(scenario: Scenario): ScenarioResult {
  const { entryFile, slug } = writeEntry("esbuild", scenario);

  try {
    if (scenario.lazySplit) {
      // Code-split build: the ENTRY chunk must be free of the excluded modules;
      // lazy `import()` targets land in separate on-demand chunks.
      const outDir = path.join(TMP_DIR, `esbuild-${slug}-split`);
      const result = buildSync({
        entryPoints: [entryFile],
        bundle: true,
        format: "esm",
        platform: scenario.platform === "browser" ? "browser" : "node",
        outdir: outDir,
        metafile: true,
        treeShaking: true,
        splitting: true,
        minify: false,
        write: true,
        external: ["node:*"]
      });
      const meta = result.metafile!;
      const entryOut = Object.entries(meta.outputs).find(([, o]) =>
        (o.entryPoint ?? "").includes(path.basename(entryFile))
      );
      if (!entryOut) {
        return makeError(scenario.name, "esbuild", "entry chunk not found");
      }
      const [entryKey] = entryOut;
      const bundleText = readEmittedBundle(outDir, path.basename(entryKey));
      const contributing = extractContributingFromBundle(bundleText);
      return makeResult(
        scenario,
        "esbuild",
        fs.statSync(entryKey).size,
        contributing,
        contributing.length
      );
    }

    const outFile = path.join(TMP_DIR, `esbuild-${slug}.out.mjs`);
    buildSync({
      entryPoints: [entryFile],
      bundle: true,
      format: "esm",
      platform: scenario.platform === "browser" ? "browser" : "node",
      outfile: outFile,
      treeShaking: true,
      minify: false,
      write: true,
      external: ["node:*"]
    });

    const bundleText = fs.readFileSync(outFile, "utf-8");
    const contributing = extractContributingFromBundle(bundleText);
    return makeResult(
      scenario,
      "esbuild",
      fs.statSync(outFile).size,
      contributing,
      contributing.length
    );
  } catch (err: any) {
    return makeError(scenario.name, "esbuild", err.message);
  }
}

async function runRolldown(scenario: Scenario): Promise<ScenarioResult> {
  const { entryFile, slug } = writeEntry("rolldown", scenario);
  const outDir = path.join(TMP_DIR, `rolldown-${slug}-out`);

  try {
    await rolldownBuild({
      input: entryFile,
      platform: scenario.platform === "browser" ? "browser" : "node",
      resolve: {
        conditionNames:
          scenario.platform === "browser" ? ["browser", "import", "default"] : ["import", "default"]
      },
      treeshake: true,
      external: [/^node:/],
      output: { dir: outDir, format: "esm", entryFileNames: "out.mjs", minify: false }
    });

    // Only inspect the ENTRY chunk (out.mjs). Lazy `import()` targets are
    // emitted as separate on-demand chunks, so a dynamic cross-module boundary
    // must NOT appear in the entry a consumer pays for upfront.
    const outFile = path.join(outDir, "out.mjs");
    const bundleSize = fs.existsSync(outFile) ? fs.statSync(outFile).size : 0;
    const bundleText = readEmittedBundle(outDir, "out.mjs");
    const contributing = extractContributingFromBundle(bundleText);

    return makeResult(scenario, "rolldown", bundleSize, contributing, contributing.length);
  } catch (err: any) {
    return makeError(scenario.name, "rolldown", err.message);
  }
}

function runRspack(scenario: Scenario): Promise<ScenarioResult> {
  const { entryFile, slug } = writeEntry("rspack", scenario);
  const outDir = path.join(TMP_DIR, `rspack-${slug}-out`);

  return new Promise(resolve => {
    const compiler = rspack({
      mode: "production",
      entry: entryFile,
      output: {
        path: outDir,
        filename: "out.mjs",
        chunkFilename: "[name].chunk.mjs",
        module: true,
        library: { type: "module" }
      },
      target: scenario.platform === "browser" ? "web" : "node",
      externals: [/^node:/],
      resolve: {
        conditionNames:
          scenario.platform === "browser"
            ? ["browser", "import", "default"]
            : ["import", "default"],
        symlinks: true
      },
      optimization: { usedExports: true, sideEffects: true, minimize: false, innerGraph: true },
      stats: {
        all: false,
        modules: true,
        chunks: true,
        chunkModules: true,
        ids: true,
        modulesSpace: Infinity
      }
    });

    compiler.run((err, stats) => {
      const close = () => new Promise<void>(r => compiler.close(() => r()));

      if (err || !stats) {
        close().then(() => resolve(makeError(scenario.name, "rspack", err?.message ?? "no stats")));
        return;
      }
      if (stats.hasErrors()) {
        const errors = stats.toJson({ errors: true }).errors ?? [];
        close().then(() =>
          resolve(makeError(scenario.name, "rspack", errors.map((e: any) => e.message).join("\n")))
        );
        return;
      }

      // The emitted entry chunk is `out.mjs`. Lazy `import()` targets are
      // emitted as separate `*.chunk.mjs` files (rspack splits async deps), so
      // reading only `out.mjs` reflects what the consumer eagerly pays for.
      // Module-path markers in the un-minified output are the ground truth for
      // what survived DCE (stats.modules lists graph members, which over-counts
      // modules rspack later eliminated from the bundle).
      const outFile = path.join(outDir, "out.mjs");
      const bundleSize = fs.existsSync(outFile) ? fs.statSync(outFile).size : 0;
      const bundleText = readEmittedBundle(outDir, "out.mjs");
      const contributing = extractContributingFromBundle(bundleText);

      close().then(() =>
        resolve(makeResult(scenario, "rspack", bundleSize, contributing, contributing.length))
      );
    });
  });
}

// =============================================================================
// Report
// =============================================================================

function report(results: ScenarioResult[]): boolean {
  let allPassed = true;

  const byBundler = new Map<string, ScenarioResult[]>();
  for (const r of results) {
    const list = byBundler.get(r.bundler) ?? [];
    list.push(r);
    byBundler.set(r.bundler, list);
  }

  for (const [bundler, bundlerResults] of byBundler) {
    console.log("\n" + "=".repeat(80));
    console.log(`  TREE-SHAKING VERIFICATION — ${bundler.toUpperCase()}`);
    console.log("=".repeat(80) + "\n");

    for (const r of bundlerResults) {
      const status = r.passed ? "PASS" : "FAIL";
      console.log(`  [${status}] ${r.name}`);
      console.log(
        `         Bundle: ${(r.bundleSize / 1024).toFixed(1)} KB | ` +
          `Contributing: ${r.contributingModules.length} / ${r.parsedModuleCount} parsed`
      );

      if (r.violations.length > 0) {
        allPassed = false;
        for (const v of r.violations) {
          const totalBytes = v.matchedModules.reduce((s, m) => s + m.bytes, 0);
          console.log(
            `         VIOLATION: "${v.pattern}" — ${v.matchedModules.length} files, ` +
              `${(totalBytes / 1024).toFixed(1)} KB leaked:`
          );
          for (const m of v.matchedModules.slice(0, 5)) {
            console.log(`           - ${m.path} (${m.bytes} B)`);
          }
          if (v.matchedModules.length > 5) {
            console.log(`           ... and ${v.matchedModules.length - 5} more`);
          }
        }
      }
      console.log();
    }

    const passed = bundlerResults.filter(r => r.passed).length;
    console.log(`  ${bundler}: ${passed}/${bundlerResults.length} passed`);
  }

  console.log("\n" + "=".repeat(80));
  console.log(
    allPassed
      ? "  ALL SCENARIOS PASSED across all bundlers"
      : "  SOME SCENARIOS FAILED — tree-shaking issues detected"
  );
  console.log("=".repeat(80) + "\n");

  return allPassed;
}

// =============================================================================
// Main
// =============================================================================

async function main(): Promise<void> {
  setupTmpProject();

  const results: ScenarioResult[] = [];
  for (const s of scenarios) {
    if (!s.excludeBundlers?.includes("esbuild")) {
      results.push(runEsbuild(s));
    }
  }
  for (const s of scenarios) {
    if (!s.excludeBundlers?.includes("rolldown")) {
      results.push(await runRolldown(s));
    }
  }
  for (const s of scenarios) {
    if (!s.excludeBundlers?.includes("rspack")) {
      results.push(await runRspack(s));
    }
  }

  const allPassed = report(results);
  fs.rmSync(TMP_DIR, { recursive: true });

  if (!allPassed) {
    process.exit(1);
  }
}

main();
