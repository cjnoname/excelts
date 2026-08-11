/**
 * Public type-surface verification.
 *
 * `build:verify` proves the emitted `.d.ts` files compile; it cannot prove that
 * a consumer can *name* the types those files talk about. A type that appears
 * in a public signature but is not reachable by name from any package entry is
 * a hole: object literals still work, but no one can declare a variable, build
 * a helper, or store a value of that type. (This is exactly how the whole
 * `excel/types.ts` vocabulary — `Style`, `PageSetup`, `ColumnDefn`, … — went
 * missing for a full release.)
 *
 * Four rules are enforced:
 *
 *   R1  Every declaration in `src/modules/excel/types.ts` — the excel module's
 *       domain vocabulary — is nameable from `documonster/excel`.
 *   R2  Every type used in a public function / class signature is nameable from
 *       an entry of the same platform group (a Node-only export does not
 *       satisfy a hole in the browser build).
 *   R3  The Node and browser excel entries expose the same top-level names AND
 *       the same members inside every shared namespace, so a type that exists
 *       in one build can never be missing from the other.
 *   R4  The vocabulary file is closed: every type referenced from a *member* of
 *       a public vocabulary type is itself nameable. `Style.font: Partial<Font>`
 *       is worthless if `Font` cannot be named.
 *
 * Deliberately NOT enforced: the full transitive closure over every public
 * type. Round-trip models (`WorksheetModel`, `ImageModel`, …) bottom out in
 * serialization internals that consumers receive and hand back but never build,
 * so demanding a public name for each one would only push implementation detail
 * into the API. R4 draws the line at the hand-authored vocabulary file.
 *
 * Matching is by declaration identity, not by name: `Worksheet.Handle` is a
 * legitimate public name for `WorksheetData`, and the `X.Handle` idiom is part
 * of the module's design.
 *
 * Deliberate exceptions live in `PRIVATE_MEMBER_TYPES`: types that only ever
 * appear on `private` class members. TypeScript emits them into the `.d.ts`,
 * but a consumer can never touch them, so exporting them would only widen the
 * public API with implementation detail.
 *
 * Usage: node scripts/verify-public-types.ts
 */

import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const SRC = path.join(ROOT, "src");

/**
 * Public entry points, keyed by the specifier a consumer writes.
 *
 * `platform` groups the entries a single build resolves to, so R2 never lets a
 * Node-only export cover a hole in the browser build. Entries that are shared
 * by both builds are listed as `both`.
 */
const ENTRIES: Record<string, { file: string; platform: "node" | "browser" | "both" }> = {
  "documonster/excel": { file: "src/modules/excel/index.ts", platform: "node" },
  "documonster/excel (browser)": {
    file: "src/modules/excel/index.browser.ts",
    platform: "browser"
  },
  "documonster/excel/formula": { file: "src/modules/excel/bridge/formula.ts", platform: "both" },
  "documonster/excel/csv": { file: "src/modules/excel/bridge/csv.node.ts", platform: "node" },
  "documonster/excel/csv (browser)": {
    file: "src/modules/excel/bridge/csv.ts",
    platform: "browser"
  },
  "documonster/excel/markdown": {
    file: "src/modules/excel/bridge/markdown.node.ts",
    platform: "node"
  },
  "documonster/excel/markdown (browser)": {
    file: "src/modules/excel/bridge/markdown.ts",
    platform: "browser"
  },
  "documonster/chart": { file: "src/modules/excel/chart/index.ts", platform: "both" },
  "documonster/word": { file: "src/modules/word/index.ts", platform: "both" },
  "documonster/word/html": { file: "src/modules/word/html.ts", platform: "both" },
  "documonster/word/markdown": { file: "src/modules/word/markdown.ts", platform: "both" },
  "documonster/word/excel": { file: "src/modules/word/excel.ts", platform: "both" },
  "documonster/word/crypto": { file: "src/modules/word/crypto.ts", platform: "both" },
  "documonster/pdf": { file: "src/modules/pdf/index.ts", platform: "both" },
  "documonster/formula": { file: "src/modules/formula/index.ts", platform: "both" },
  "documonster/csv": { file: "src/modules/csv/index.ts", platform: "both" },
  "documonster/markdown": { file: "src/modules/markdown/index.ts", platform: "both" },
  "documonster/xml": { file: "src/modules/xml/index.ts", platform: "both" },
  "documonster/archive": { file: "src/modules/archive/index.ts", platform: "node" },
  "documonster/archive (browser)": {
    file: "src/modules/archive/index.browser.ts",
    platform: "browser"
  },
  "documonster/stream": { file: "src/modules/stream/index.ts", platform: "node" },
  "documonster/stream (browser)": {
    file: "src/modules/stream/index.browser.ts",
    platform: "browser"
  }
};

/** The excel module's domain vocabulary — R1 applies to every declaration here. */
const VOCABULARY_FILE = "src/modules/excel/types.ts";

/**
 * Types that only ever appear on `private` class members. Emitted into the
 * `.d.ts` but unreachable by consumers, so they stay internal on purpose.
 * Format: `"TypeName @ src-relative/decl/file.ts"`.
 */
const PRIVATE_MEMBER_TYPES = new Set([
  // pdf — `PdfEditor.#copiedPages`
  "CopiedPage @ modules/pdf/builder/pdf-editor.ts",
  // csv — private parser/formatter state on CsvParserStream / CsvFormatterStream
  "ParseConfig @ modules/csv/parse/config.ts",
  "ParseState @ modules/csv/parse/state.ts",
  "Scanner @ modules/csv/parse/scanner/types.ts",
  "FormatConfig @ modules/csv/format/config.ts",
  "FormatRowOptions @ modules/csv/format/config.ts",
  // archive — private state on ArchiveFile / WorkerPool
  "ArchiveZipState @ modules/archive/fs/archive-file.ts",
  "PendingTask @ modules/archive/compression/worker-pool/pool.browser.ts",
  "PoolWorker @ modules/archive/compression/worker-pool/pool.browser.ts",
  // archive — private pending-entry queues on ArchiveFile / TarArchive
  "TarInput @ modules/archive/tar/tar-archive.ts",
  // archive — `UnzipEntry.#parseEntry`, the streaming parser's own entry stream
  // (the public read API hands out `UnzipEntry`, never this)
  "ZipEntry @ modules/archive/unzip/stream.base.ts",
  "TarPendingEntry @ modules/archive/fs/archive-file.ts",
  "ZipPendingEntry @ modules/archive/fs/archive-file.ts"
]);

/**
 * Namespace members that legitimately exist only in the Node build. The
 * `Workbook` namespace is assembled per platform: Node adds file-path IO, which
 * the browser cannot provide.
 */
const NODE_ONLY_NAMESPACE_MEMBERS = new Set(["Workbook.readFile", "Workbook.writeFile"]);

const ALIASES: Record<string, string> = {
  "@excel": "src/modules/excel",
  "@word": "src/modules/word",
  "@formula": "src/modules/formula",
  "@pdf": "src/modules/pdf",
  "@csv": "src/modules/csv",
  "@markdown": "src/modules/markdown",
  "@xml": "src/modules/xml",
  "@archive": "src/modules/archive",
  "@stream": "src/modules/stream",
  "@utils": "src/utils"
};

// =============================================================================
// Source scanning
// =============================================================================

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function resolveSpec(spec: string, fromFile: string): string | undefined {
  let p: string | undefined;
  if (spec.startsWith(".")) {
    p = path.resolve(path.dirname(fromFile), spec);
  } else {
    for (const [alias, target] of Object.entries(ALIASES)) {
      if (spec === alias) {
        p = path.join(ROOT, target, "index.ts");
        break;
      }
      if (spec.startsWith(alias + "/")) {
        p = path.join(ROOT, target, spec.slice(alias.length + 1));
        break;
      }
    }
  }
  if (!p) return undefined;
  for (const candidate of [p, p + ".ts", path.join(p, "index.ts")]) {
    if (isFile(candidate)) return candidate;
  }
  return undefined;
}

const sources = new Map<string, string>();

/** Read a file with comments stripped (so `{@link Foo}` never counts as a use). */
function read(file: string): string {
  let s = sources.get(file);
  if (s === undefined) {
    s = fs
      .readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
    sources.set(file, s);
  }
  return s;
}

interface NamedExport {
  /** Local (declared) name inside `from`, or inside this module when absent. */
  local: string;
  /** Module the name is re-exported from, when this is an `export … from` form. */
  from?: string;
}

interface Module {
  file: string;
  /** exported name -> where it comes from */
  named: Map<string, NamedExport>;
  /** `export * as NS from "…"` */
  namespaces: Map<string, string>;
  /** `export * from "…"` */
  stars: string[];
  /** every type/interface declared in this file, exported or not */
  localTypes: Set<string>;
  /** imported type name -> { file, declared name } */
  importedTypes: Map<string, { file: string; declared: string }>;
}

const modules = new Map<string, Module>();

function parse(file: string): Module {
  const cached = modules.get(file);
  if (cached) return cached;

  const mod: Module = {
    file,
    named: new Map(),
    namespaces: new Map(),
    stars: [],
    localTypes: new Set(),
    importedTypes: new Map()
  };
  modules.set(file, mod);
  const src = read(file);

  for (const m of src.matchAll(/export\s+\*\s+as\s+(\w+)\s+from\s+["']([^"']+)["']/g)) {
    const target = resolveSpec(m[2], file);
    if (target) mod.namespaces.set(m[1], target);
  }
  for (const m of src.matchAll(/export\s+\*\s+from\s+["']([^"']+)["']/g)) {
    const target = resolveSpec(m[1], file);
    if (target) mod.stars.push(target);
  }
  for (const m of src.matchAll(/export\s+(type\s+)?\{([^}]*)\}\s*(?:from\s*["']([^"']+)["'])?/g)) {
    const from = m[3] ? resolveSpec(m[3], file) : undefined;
    for (const raw of m[2].split(",")) {
      const spec = raw.trim();
      if (!spec) continue;
      const parts = spec.replace(/^type\s+/, "").split(/\s+as\s+/);
      const local = parts[0].trim();
      const exported = (parts[1] ?? parts[0]).trim();
      mod.named.set(exported, { local, from });
    }
  }
  for (const m of src.matchAll(
    /^export\s+(?:declare\s+)?(?:abstract\s+)?(?:type|interface|enum|class|const|let|var|async\s+function|function\*?)\s+(\w+)/gm
  )) {
    mod.named.set(m[1], { local: m[1] });
  }
  for (const m of src.matchAll(/^(?:export\s+)?(?:declare\s+)?(?:type|interface)\s+(\w+)/gm)) {
    mod.localTypes.add(m[1]);
  }
  for (const m of src.matchAll(/import\s+type\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)) {
    const target = resolveSpec(m[2], file);
    if (!target) continue;
    for (const raw of m[1].split(",")) {
      const parts = raw.trim().split(/\s+as\s+/);
      const declared = parts[0].trim();
      const localName = (parts[1] ?? parts[0]).trim();
      if (localName) mod.importedTypes.set(localName, { file: target, declared });
    }
  }
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)) {
    const target = resolveSpec(m[2], file);
    if (!target) continue;
    for (const raw of m[1].split(",")) {
      const spec = raw.trim();
      if (!spec.startsWith("type ")) continue;
      const parts = spec.replace(/^type\s+/, "").split(/\s+as\s+/);
      const declared = parts[0].trim();
      const localName = (parts[1] ?? parts[0]).trim();
      if (localName) mod.importedTypes.set(localName, { file: target, declared });
    }
  }
  return mod;
}

// =============================================================================
// Identity resolution
// =============================================================================

interface Identity {
  file: string;
  name: string;
}

const identityKey = (id: Identity) => `${id.file}|${id.name}`;

/** Follow `export … from` chains and single-identifier aliases to the declaration. */
function origin(file: string, name: string, depth = 0): Identity | undefined {
  if (depth > 10) return undefined;
  const mod = parse(file);
  const hit = mod.named.get(name);
  if (hit) {
    if (hit.from) return origin(hit.from, hit.local, depth + 1);
    // A bare `export { X }` / `export type { X }` re-exporting an imported name:
    // the declaration lives in the module it was imported from.
    const imported = mod.importedTypes.get(hit.local);
    if (imported && !mod.localTypes.has(hit.local)) {
      const found = origin(imported.file, imported.declared, depth + 1);
      if (found) return found;
    }
    return followAlias(file, hit.local, depth);
  }
  for (const star of mod.stars) {
    const found = origin(star, name, depth + 1);
    if (found) return found;
  }
  return undefined;
}

/** `type A = B;` (a pure rename) resolves to B's declaration. */
function followAlias(file: string, name: string, depth: number): Identity {
  const match = new RegExp(
    `^(?:export\\s+)?type\\s+${name}\\s*=\\s*([A-Za-z_$][\\w$]*)\\s*;`,
    "m"
  ).exec(read(file));
  if (match) {
    const target = match[1];
    const mod = parse(file);
    const imported = mod.importedTypes.get(target);
    if (imported) {
      const found = origin(imported.file, imported.declared, depth + 1);
      if (found) return found;
    } else if (target !== name && mod.localTypes.has(target)) {
      return followAlias(file, target, depth + 1);
    }
  }
  return { file, name };
}

/** Every type identity nameable from `entry`, mapped to the path that names it. */
function nameableFrom(entry: string): Map<string, string> {
  const found = new Map<string, string>();
  const seen = new Set<string>();
  const walk = (file: string, prefix: string, depth: number) => {
    const key = `${prefix}|${file}`;
    if (depth > 3 || seen.has(key)) return;
    seen.add(key);
    const mod = parse(file);
    for (const name of mod.named.keys()) {
      const id = origin(file, name);
      if (id && !found.has(identityKey(id))) found.set(identityKey(id), prefix + name);
    }
    for (const star of mod.stars) walk(star, prefix, depth + 1);
    for (const [ns, target] of mod.namespaces) walk(target, `${prefix}${ns}.`, depth + 1);
  };
  walk(entry, "", 0);
  return found;
}

// =============================================================================
// Signature scanning
// =============================================================================

/** The declaration text of a value export (function / const / class). */
function valueDeclText(file: string, name: string): string {
  const src = read(file);
  const match = new RegExp(
    `^export\\s+(?:declare\\s+)?(?:abstract\\s+)?(?:async\\s+)?(?:function\\*?|const|let|var|class)\\s+${name}\\b`,
    "m"
  ).exec(src);
  if (!match) return "";
  let depth = 0;
  let started = false;
  let out = "";
  for (let i = match.index; i < src.length; i++) {
    const ch = src[i];
    out += ch;
    if (ch === "(" || ch === "[" || ch === "{" || ch === "<") {
      depth++;
      started = true;
    } else if (ch === ")" || ch === "]" || ch === "}" || ch === ">") {
      depth--;
    }
    if (started && depth <= 0 && (ch === ")" || ch === "}")) {
      const rest = src.slice(i, i + 200);
      const nl = rest.indexOf("\n");
      out += rest.slice(0, nl < 0 ? rest.length : nl);
      break;
    }
    if (!started && ch === "\n") break;
  }
  return out;
}

/**
 * The member text of a `type` / `interface` declaration — the body only, with
 * any `extends` clause stripped. An inherited member is visible on the derived
 * type, so a base interface never needs a public name of its own.
 */
function typeMemberText(file: string, name: string): string {
  const src = read(file);
  const match = new RegExp(
    `(?:^|\\n)\\s*(?:export\\s+)?(?:declare\\s+)?(interface|type)\\s+${name}\\b([^{;=]*)`,
    ""
  ).exec(src);
  if (!match) return "";
  const isInterface = match[1] === "interface";
  let i = match.index + match[0].length;
  let depth = 0;
  let started = false;
  let out = "";
  for (; i < src.length; i++) {
    const ch = src[i];
    out += ch;
    if (ch === "{" || ch === "(" || ch === "[" || ch === "<") {
      depth++;
      started = true;
    } else if (ch === "}" || ch === ")" || ch === "]" || ch === ">") {
      depth--;
    }
    if (isInterface) {
      if (started && depth <= 0 && ch === "}") break;
    } else if (depth <= 0 && ch === ";") {
      break;
    }
  }
  return out;
}

/**
 * Types referenced from `text` that are not nameable. `text` is a signature or
 * a type body; `declFile` is the file it was lifted from (so local and imported
 * names resolve the same way TypeScript would).
 */
function unnameableIn(
  text: string,
  declFile: string,
  nameable: Map<string, string>
): Array<{ name: string; decl: string }> {
  if (!text) return [];
  const declaring = parse(declFile);
  const candidates = new Map<string, { file: string; declared: string }>();
  for (const [localName, ref] of declaring.importedTypes) candidates.set(localName, ref);
  for (const localName of declaring.localTypes) {
    candidates.set(localName, { file: declFile, declared: localName });
  }

  const out: Array<{ name: string; decl: string }> = [];
  for (const [localName, ref] of candidates) {
    if (!ref.file.startsWith(SRC)) continue;
    if (ref.file.includes(`${path.sep}src${path.sep}utils${path.sep}`)) continue;
    if (!new RegExp(`[^.\\w]${localName}\\b`).test(text)) continue;
    const id = origin(ref.file, ref.declared) ?? { file: ref.file, name: ref.declared };
    if (nameable.has(identityKey(id))) continue;
    const rel = path.relative(SRC, id.file);
    if (PRIVATE_MEMBER_TYPES.has(`${id.name} @ ${rel}`)) continue;
    out.push({ name: id.name, decl: rel });
  }
  return out;
}

interface Hole {
  name: string;
  decl: string;
  where: string;
}

/** Types referenced by the public signatures reachable from `entry`. */
function signatureHoles(entry: string, nameable: Map<string, string>): Hole[] {
  const holes = new Map<string, Hole>();
  const visited = new Set<string>();

  const inspect = (file: string, label: string) => {
    const key = `${file}|${label}`;
    if (visited.has(key)) return;
    visited.add(key);
    const mod = parse(file);
    for (const exported of mod.named.keys()) {
      const id = origin(file, exported);
      if (!id || !id.file.startsWith(SRC)) continue;
      for (const hole of unnameableIn(valueDeclText(id.file, id.name), id.file, nameable)) {
        const k = `${hole.decl}|${hole.name}`;
        if (!holes.has(k)) holes.set(k, { ...hole, where: `${label}.${exported}` });
      }
    }
    for (const star of mod.stars) inspect(star, label);
    for (const [ns, target] of mod.namespaces) inspect(target, ns);
  };

  inspect(entry, "<top>");
  return [...holes.values()];
}

/** Top-level exported names of an entry (types + values, namespaces included). */
function topLevelNames(entry: string): Set<string> {
  const names = new Set<string>();
  const walk = (file: string, depth: number) => {
    if (depth > 3) return;
    const mod = parse(file);
    for (const name of mod.named.keys()) names.add(name);
    for (const ns of mod.namespaces.keys()) names.add(ns);
    for (const star of mod.stars) walk(star, depth + 1);
  };
  walk(entry, 0);
  return names;
}

/** `namespace -> exported member names`, for every `export * as NS` on an entry. */
function namespaceMembers(entry: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const collect = (file: string, into: Set<string>, depth: number) => {
    if (depth > 3) return;
    const mod = parse(file);
    for (const name of mod.named.keys()) into.add(name);
    for (const star of mod.stars) collect(star, into, depth + 1);
  };
  const walk = (file: string, depth: number) => {
    if (depth > 3) return;
    const mod = parse(file);
    for (const [ns, target] of mod.namespaces) {
      const members = out.get(ns) ?? new Set<string>();
      collect(target, members, 0);
      out.set(ns, members);
    }
    for (const star of mod.stars) walk(star, depth + 1);
  };
  walk(entry, 0);
  return out;
}

// =============================================================================
// Main
// =============================================================================

function main(): void {
  const entryFiles = Object.entries(ENTRIES)
    .map(([label, { file, platform }]) => ({ label, file: path.join(ROOT, file), platform }))
    .filter(({ label, file }) => {
      if (isFile(file)) return true;
      console.error(`✗ ${label}: missing entry file ${path.relative(ROOT, file)}`);
      process.exitCode = 1;
      return false;
    });

  const perEntry = new Map<string, Map<string, string>>();
  for (const { label, file } of entryFiles) perEntry.set(label, nameableFrom(file));

  /** Everything nameable from the entries a single platform build can resolve. */
  const platformNameable = (platform: "node" | "browser"): Map<string, string> => {
    const merged = new Map<string, string>();
    for (const { label, platform: p } of entryFiles) {
      if (p !== platform && p !== "both") continue;
      for (const [k, v] of perEntry.get(label)!)
        if (!merged.has(k)) merged.set(k, `${label} → ${v}`);
    }
    return merged;
  };
  const nameableByPlatform = {
    node: platformNameable("node"),
    browser: platformNameable("browser")
  };

  const failures: string[] = [];

  // R1 — the excel domain vocabulary must be nameable from documonster/excel.
  const vocabularyFile = path.join(ROOT, VOCABULARY_FILE);
  const vocabulary = [
    ...read(vocabularyFile).matchAll(/^export\s+(?:type|interface|enum|const)\s+(\w+)/gm)
  ].map(m => m[1]);
  for (const entryLabel of ["documonster/excel", "documonster/excel (browser)"]) {
    const nameable = perEntry.get(entryLabel);
    if (!nameable) continue;
    for (const name of vocabulary) {
      const id = origin(vocabularyFile, name);
      if (!id) continue;
      if (!nameable.has(identityKey(id))) {
        failures.push(
          `R1  ${VOCABULARY_FILE} declares \`${name}\`, but it is not exported from ${entryLabel}`
        );
      }
    }
  }

  // R2 — no type in a public signature may be unnameable within its platform.
  for (const { label, file, platform } of entryFiles) {
    const groups: Array<"node" | "browser"> =
      platform === "both" ? ["node", "browser"] : [platform];
    for (const group of groups) {
      for (const hole of signatureHoles(file, nameableByPlatform[group])) {
        failures.push(
          `R2  ${label} exposes \`${hole.name}\` (declared in ${hole.decl}) via ${hole.where},` +
            ` but no ${group} entry exports it`
        );
      }
    }
  }

  // R3 — the two excel entries must expose the same names, top level and inside
  // every namespace they share.
  const nodeEntry = path.join(ROOT, ENTRIES["documonster/excel"].file);
  const browserEntry = path.join(ROOT, ENTRIES["documonster/excel (browser)"].file);
  const nodeNames = topLevelNames(nodeEntry);
  const browserNames = topLevelNames(browserEntry);
  for (const name of nodeNames) {
    if (!browserNames.has(name)) {
      failures.push(`R3  documonster/excel exports \`${name}\`, but the browser entry does not`);
    }
  }
  for (const name of browserNames) {
    if (!nodeNames.has(name)) {
      failures.push(`R3  the browser entry exports \`${name}\`, but documonster/excel does not`);
    }
  }
  const nodeNs = namespaceMembers(nodeEntry);
  const browserNs = namespaceMembers(browserEntry);
  for (const [ns, members] of nodeNs) {
    const other = browserNs.get(ns);
    if (!other) continue;
    for (const member of members) {
      if (!other.has(member) && !NODE_ONLY_NAMESPACE_MEMBERS.has(`${ns}.${member}`)) {
        failures.push(
          `R3  \`${ns}.${member}\` exists on documonster/excel but not in the browser entry`
        );
      }
    }
    for (const member of other) {
      if (!members.has(member)) {
        failures.push(
          `R3  \`${ns}.${member}\` exists on the browser entry but not on documonster/excel`
        );
      }
    }
  }

  // R4 — the vocabulary file is closed under member references.
  for (const name of vocabulary) {
    for (const hole of unnameableIn(
      typeMemberText(vocabularyFile, name),
      vocabularyFile,
      nameableByPlatform.node
    )) {
      failures.push(
        `R4  ${VOCABULARY_FILE}: \`${name}\` references \`${hole.name}\`` +
          ` (declared in ${hole.decl}), which no entry exports`
      );
    }
  }

  if (failures.length === 0) {
    console.log(
      `✓ Public type surface check passed — ${vocabulary.length} vocabulary types,` +
        ` ${entryFiles.length} entries: signatures nameable per platform (R2),` +
        ` excel node/browser surfaces identical (R3), vocabulary closed (R4).`
    );
    return;
  }

  console.error(`✗ Public type surface check failed — ${failures.length} issue(s):\n`);
  for (const f of [...new Set(failures)].sort()) console.error(`  ${f}`);
  console.error(
    `\nFix by exporting the type from the module entry. Prefer the DECLARED name —` +
      ` TypeScript prints that name in errors, so a fresh alias shows consumers a` +
      ` name they cannot import. Re-exporting under an established idiom (e.g.` +
      ` \`WorksheetData as Handle\` on the \`Worksheet\` namespace) is fine: this` +
      ` check matches declarations, not spellings.\n` +
      `If the type only ever appears on a \`private\` class member, add it to` +
      ` PRIVATE_MEMBER_TYPES in scripts/verify-public-types.ts instead.`
  );
  process.exit(1);
}

main();
