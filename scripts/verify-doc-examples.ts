/**
 * Documented-import verification.
 *
 * An example is the first thing a consumer copies, and it is the one artefact in this
 * repository that nothing in the toolchain reads. Code in a comment or a Markdown fence is
 * not compiled, not linted and not tree-shaken, so an example keeps claiming an API long
 * after that API has moved — and it claims it with the authority of sitting next to the
 * implementation.
 *
 * That is not hypothetical. Two separate rounds of drift were found by this script:
 *
 * - When the PDF and Word modules moved their flat exports onto namespace surfaces
 *   (`Pdf.create`, `Pdf.read`, `Io.read`, `Query.searchByFormat`, …), **seventeen**
 *   `@example` blocks were left telling readers to write
 *   `import { readPdf } from "documonster/pdf"`, which has never resolved. One comment in
 *   `pdf/index.ts` disagreed with itself: its second example used `Pdf.fromExcel` while its
 *   first and third still used the old flat names.
 * - The READMEs — five times the volume of the comment corpus, and the most-read
 *   documentation there is — taught `import type { WorkbookData }` from `documonster/excel`
 *   (handles are published only as `Worksheet.Handle` / `Workbook.Handle`, deliberately),
 *   and pointed at three binary helpers in `documonster/archive` that live in the internal
 *   `utils/` layer and are exported nowhere. That second one had even been half-noticed:
 *   a note explained they were not in `documonster/stream` and then named the wrong module.
 *
 * `verify-public-types.ts` cannot catch any of this: its subject is whether a type reachable
 * from a public signature can be *named*, not whether a documented import *exists*.
 *
 * ## What is checked
 *
 * **Imports.** Every `import { … } from "documonster/…"` in the documentation must resolve
 * against the declarations the `exports` map publishes.
 *
 * **Members.** Every `Namespace.member` reference must exist, where `Namespace` was imported
 * from a public specifier in the same stretch of documentation. This half was added second,
 * and it earns its keep: an import-only check passes `import { Pdf }` and says nothing about
 * `Pdf.read`, so a namespace refactor can rewrite every member name in the library while the
 * examples keep naming the old ones. Two of its first findings were invisible to the import
 * check by construction:
 *
 * - `Document.addBodyContent` — the member is `addContent`. This sat in a comment that had
 *   just been hand-edited for the drift above, which is the argument for the check in one
 *   line: reading carefully is not a substitute for compiling.
 * - `StyleMap.parse` / `.create` / `.match` / `.DEFAULT` — `documonster/word` does export
 *   `StyleMap`, but as the mapping *type*; the namespace is published as `Styles`. So the
 *   import resolved, to a different thing of the same name, and only a member probe could
 *   see it.
 *
 * Scoping member references to the region that imported the namespace is what keeps the
 * false-positive rate near zero — `image.format` and `ws.pageSetup.paperSize` never match,
 * because neither `image` nor `ws` was imported there. Across nearly 900 references in this
 * repository there was exactly one, `Workbook.calculate`, named by a comment explaining why
 * it deliberately does not exist; see {@link DELIBERATELY_ABSENT}.
 *
 * ## Where it looks
 *
 * Two corpora, one rule:
 *
 * - **`.ts` files** — comment lines only. Real import statements are the compiler's job.
 * - **`.md` files** — fenced code blocks only.
 *
 * Both rules select the same thing: text that claims to be runnable code. Inline code in a
 * Markdown sentence is a *reference* to a symbol, not a claim that it can be pasted, which is
 * why Markdown prose is out of scope — and why a document discussing a broken import (this
 * repository has one) needs no exception. A TSDoc comment is different in kind: its prose
 * routinely instructs (`Styles.parse(dsl)`, …), so it is read in full.
 *
 * Resolution is done by generating throwaway modules and letting `tsc` answer. Following
 * `export *` barrels and namespace re-exports is exactly what a compiler is for, and the
 * alternative — matching names against `.d.ts` text — is the kind of hand-rolled resolution
 * that is wrong in precisely the cases that matter.
 *
 * Names are imported with `import type`, which accepts values and types alike, so the check
 * is about existence and not about which of the two a name is. A member is probed in both
 * forms for the same reason.
 *
 * The Node (`import`) condition is the one resolved. The browser condition deliberately
 * omits Node-only surfaces (file-path IO), so an example demonstrating one of those is
 * correct rather than broken, and checking both conditions would report a lie nobody told.
 *
 * An import in a shape this parser cannot read — a namespace import, a default import — is
 * **reported rather than skipped**. A gate with a silent hole is worse than no gate: the
 * hole is where the next drift lands.
 *
 * Needs `dist/types` and fails closed when they are absent. `pnpm check` builds ESM/types
 * first; a direct caller gets an actionable instruction rather than a green result from a
 * gate that skipped the part carrying its value.
 *
 * Usage: node scripts/verify-doc-examples.ts [--root <dir>]
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { relPosix } from "./lib/paths.ts";

/**
 * `--root <dir>` points the scan at a different tree. Used by the tests: a check that
 * never fires is worse than no check, and the only way to know this one fires is to hand
 * it a tree whose documentation is wrong on purpose.
 */
function rootFromArgv(): string {
  const flag = process.argv.indexOf("--root");
  return flag === -1
    ? path.resolve(import.meta.dirname, "..")
    : path.resolve(process.argv[flag + 1]);
}

const ROOT = rootFromArgv();

/**
 * The compiler comes from this repository's devDependencies, not from the tree being
 * scanned: `--root` points at a fixture with no `node_modules`, and the tool used to
 * answer the question is a property of the checker, not of its subject.
 */
const tscFlag = process.argv.indexOf("--tsc");
const TSC =
  tscFlag === -1
    ? path.resolve(import.meta.dirname, "..", "node_modules/typescript/bin/tsc")
    : path.resolve(process.argv[tscFlag + 1]);

/** Directories that hold no authored documentation. */
const SKIP_DIRS = new Set(["node_modules", "dist", "out", "tmp", ".git", "__screenshots__"]);

/** One `import { … } from "documonster/…"` found in documentation. */
interface DocImport {
  /** Repository-relative path of the file. */
  readonly file: string;
  /** 1-based line number where the import starts. */
  readonly line: number;
  /** The public specifier the example tells the reader to import from. */
  readonly specifier: string;
  /** The bindings inside the braces, preserving aliases for the generated probe. */
  readonly bindings: readonly ImportBinding[];
}

interface ImportBinding {
  readonly imported: string;
  readonly local: string;
}

/** A documented import in a shape the parser cannot read. */
interface Unparsed {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

/** A `Namespace.member` reference in documentation, resolved against a region's imports. */
interface MemberRef {
  readonly file: string;
  readonly line: number;
  readonly specifier: string;
  readonly imported: string;
  readonly namespace: string;
  readonly member: string;
}

/**
 * Members a comment names in order to say they are *absent*.
 *
 * `excel/bridge/formula.ts` explains at length why recalculation is a separate subpath
 * "rather than a `Workbook.calculate` member" — naming the member is the point of the
 * sentence. Suppressing it here is narrower than not checking prose at all, which would
 * have cost the `StyleMap.parse` catch: that comment told readers to call four members on
 * a name that resolves to a *type*, so the import check passed and only the member check
 * could see it.
 *
 * Keyed by file as well as member, so the same name in a code example is still checked.
 * Same shape as `verify-public-types.ts`'s `PRIVATE_MEMBER_TYPES`.
 */
const DELIBERATELY_ABSENT = new Set(["Workbook.calculate @ src/modules/excel/bridge/formula.ts"]);

/** A stretch of documentation, remembered with its offset so lines can be reported. */
interface Region {
  readonly text: string;
  /** 1-based line number of the region's first line. */
  readonly startLine: number;
  /** Markdown fence language, absent for TypeScript comments. */
  readonly language?: string;
}

/**
 * A braced import.
 *
 * The capture excludes `{`, `}` and `;` so it cannot run past the end of one statement and
 * swallow whatever follows. It still spans newlines, because a Markdown example listing a
 * dozen names over a dozen lines is normal — and an earlier draft that rejected those as
 * unparseable would have reported thirty false problems in the READMEs alone.
 */
const BRACED_IMPORT =
  /import\s+(type\s+)?\{([^{};]*)\}\s*from\s*(["'])(documonster(?:\/[A-Za-z0-9._/-]+)?)\3/g;

/** An import naming a public specifier without the braces this parser needs. */
const EXOTIC_IMPORT = /import\s[^"'{}]*from\s+["']documonster(?:\/[A-Za-z0-9._/-]+)?["']/;

/** A Markdown fence, capturing its run of backticks or tildes so the close can match it. */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** Every file under `dir` whose name ends in one of `extensions`. */
function filesUnder(dir: string, extensions: readonly string[]): string[] {
  const found: string[] = [];
  if (!fs.existsSync(dir)) {
    return found;
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) {
        found.push(...filesUnder(full, extensions));
      }
    } else if (extensions.some(extension => entry.name.endsWith(extension))) {
      found.push(full);
    }
  }
  return found;
}

/**
 * TypeScript comments, including one-line blocks and block bodies without leading `*`.
 *
 * Split at each `@example`, because two examples in one TSDoc are separate scopes: an
 * import in the second must not change what a member in the first resolves against.
 */
function commentRegions(source: string): Region[] {
  const lines = source.split("\n");
  const regions: Region[] = [];
  let current: string[] = [];
  let start = 0;
  let inBlock = false;
  const flush = (): void => {
    if (current.length > 0) {
      regions.push({ text: current.join("\n"), startLine: start });
      current = [];
    }
  };
  lines.forEach((line, index) => {
    const lineComment = /^\s*\/\/(.*)$/.exec(line);
    const blockStart = !inBlock ? /^\s*\/\*(\*?)(.*)$/.exec(line) : undefined;
    let text: string | undefined;
    if (lineComment) {
      text = lineComment[1];
    } else if (blockStart) {
      inBlock = true;
      text = blockStart[2];
    } else if (inBlock) {
      text = line.replace(/^\s*\*? ?/, "");
    }

    if (text !== undefined) {
      if (current.length === 0) {
        start = index + 1;
      }
      text = text.replace(/\*\/\s*$/, "");
      if (/^\s*@example\b/.test(text) && current.length > 0) {
        flush();
        start = index + 1;
      }
      current.push(text);
      if (/\*\//.test(line)) {
        inBlock = false;
        flush();
      }
    } else {
      flush();
    }
  });
  flush();
  return regions;
}

/**
 * Fenced code blocks.
 *
 * Only fences, deliberately: see the header. The closing fence must be at least as long as
 * the opening one, which is how Markdown lets a block contain a shorter fence.
 */
function fencedRegions(source: string): Region[] {
  const lines = source.split("\n");
  const regions: Region[] = [];
  let open: string | undefined;
  let body: string[] = [];
  let start = 0;
  let language = "";
  lines.forEach((line, index) => {
    // CommonMark permits fenced blocks inside blockquotes. Remove one quote marker for
    // recognition and from the body while preserving physical line numbers.
    const content = line.replace(/^ {0,3}> ?/, "");
    const fence = FENCE.exec(content);
    if (open === undefined) {
      if (fence) {
        open = fence[1];
        body = [];
        start = index + 2;
        language = content.slice(fence[0].length).trim().split(/\s+/)[0].toLowerCase();
      }
      return;
    }
    if (
      fence &&
      fence[1][0] === open[0] &&
      fence[1].length >= open.length &&
      content.trim() === fence[1]
    ) {
      regions.push({ text: body.join("\n"), startLine: start, language });
      open = undefined;
      return;
    }
    body.push(content);
  });
  // An unterminated fence still holds examples worth checking.
  if (open !== undefined) {
    regions.push({ text: body.join("\n"), startLine: start, language });
  }
  return regions;
}

/** Strip `//` and `/* … *\/` comments, then split a brace body into identifiers. */
function importedBindings(braceBody: string): ImportBinding[] {
  return braceBody
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map(line => line.replace(/\/\/.*$/, ""))
    .join(" ")
    .split(",")
    .map(binding => {
      const trimmed = binding.trim();
      const names = trimmed.replace(/^type\s+/, "").split(/\s+as\s+/);
      return { imported: names[0], local: names[1] ?? names[0] };
    })
    .filter(
      binding =>
        /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(binding.imported) &&
        /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(binding.local)
    );
}

/** Read one region, collecting its imports, member references, and anything unparsed. */
function scanRegion(
  file: string,
  region: Region,
  into: { imports: DocImport[]; members: MemberRef[]; unparsed: Unparsed[] }
): void {
  const lineOf = (offset: number): number =>
    region.startLine + region.text.slice(0, offset).split("\n").length - 1;

  let remaining = region.text;
  /** Local name → original name + specifier, within this region. */
  const imported = new Map<string, { imported: string; specifier: string }>();
  for (const match of region.text.matchAll(BRACED_IMPORT)) {
    const bindings = importedBindings(match[2]);
    into.imports.push({
      file,
      line: lineOf(match.index),
      specifier: match[4],
      bindings
    });
    for (const binding of bindings) {
      imported.set(binding.local, { imported: binding.imported, specifier: match[4] });
    }
    remaining = remaining.replace(match[0], " ");
  }

  // Member references, resolved against what this region imported. Scoping to the region
  // is what keeps the false-positive rate near zero: `image.format` and
  // `ws.pageSetup.paperSize` are local variables and never match, because `image` and `ws`
  // were not imported here.
  for (const [name, source] of imported) {
    const reference = new RegExp(`(?<![A-Za-z0-9_$.])${name}\\.([A-Za-z_$][A-Za-z0-9_$]*)`, "g");
    for (const match of region.text.matchAll(reference)) {
      into.members.push({
        file,
        line: lineOf(match.index),
        specifier: source.specifier,
        imported: source.imported,
        namespace: name,
        member: match[1]
      });
    }
  }

  // Whatever is left cannot have been parsed. Only `import` statements count — an error
  // message that says "call `decryptDocx()` from `documonster/word/crypto`" is a sentence.
  remaining.split("\n").forEach((line, index) => {
    if (EXOTIC_IMPORT.test(line)) {
      into.unparsed.push({
        file,
        line: region.startLine + index,
        text: line.trim()
      });
    }
  });
}

/** Scan a tree's documentation for public-specifier imports. */
export function collectDocImports(root: string): {
  imports: DocImport[];
  members: MemberRef[];
  unparsed: Unparsed[];
} {
  const into = {
    imports: [] as DocImport[],
    members: [] as MemberRef[],
    unparsed: [] as Unparsed[]
  };

  for (const file of filesUnder(path.join(root, "src"), [".ts"])) {
    const source = fs.readFileSync(file, "utf8");
    for (const region of commentRegions(source)) {
      scanRegion(relPosix(root, file), region, into);
    }
  }
  for (const file of filesUnder(root, [".md"])) {
    const source = fs.readFileSync(file, "utf8");
    for (const region of fencedRegions(source)) {
      scanRegion(relPosix(root, file), region, into);
    }
  }

  return into;
}

/**
 * The declaration file each public specifier resolves to, as a `paths` mapping.
 *
 * Read from the manifest rather than hard-coded: the exports map is the definition of the
 * public surface, so a new subpath is covered by this check the moment it is published.
 */
export function entryPaths(root: string): Record<string, string[]> {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
    exports?: Record<string, { import?: { types?: string } }>;
  };
  const paths: Record<string, string[]> = {};
  for (const [key, entry] of Object.entries(manifest.exports ?? {})) {
    if (key === "./package.json") {
      continue;
    }
    const types = entry?.import?.types;
    if (typeof types !== "string") {
      continue;
    }
    // `paths` targets carry no extension, and must be absolute because the generated
    // project lives outside the repository.
    paths[`documonster${key.slice(1)}`] = [
      path
        .resolve(root, types)
        .replace(/\.d\.ts$/, "")
        .split(path.sep)
        .join("/")
    ];
  }
  return paths;
}

interface TypeCheckResult {
  readonly succeeded: boolean;
  readonly diagnostics: string;
}

/** `tsc` diagnostics for a generated project, one entry per throwaway module. */
function typeCheck(dir: string, files: string[], paths: Record<string, string[]>): TypeCheckResult {
  if (files.length === 0) {
    return { succeeded: true, diagnostics: "" };
  }
  fs.writeFileSync(
    path.join(dir, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          noEmit: true,
          // The declarations are the subject, not the object: an error inside a shipped
          // `.d.ts` is `build:verify`'s business, and reporting it here would bury the
          // one thing this check is looking for.
          skipLibCheck: true,
          strict: false,
          module: "ESNext",
          moduleResolution: "bundler",
          moduleDetection: "force",
          target: "es2022",
          lib: ["ESNext", "DOM"],
          types: [],
          paths
        },
        files
      },
      null,
      2
    )
  );
  try {
    execFileSync("node", [TSC, "-p", dir], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    return { succeeded: true, diagnostics: "" };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };
    return {
      succeeded: false,
      diagnostics: `${failure.stdout ?? ""}${failure.stderr ?? ""}`
    };
  }
}

/** Report every documented import or member the public surface does not have. */
function main(): void {
  const { imports, members, unparsed } = collectDocImports(ROOT);
  const problems: string[] = [];

  for (const hole of unparsed) {
    problems.push(
      `${hole.file}:${hole.line} — writes an import this check cannot parse, so it ` +
        `would go unverified. Use a braced import.\n      ${hole.text}`
    );
  }

  const paths = entryPaths(ROOT);
  for (const entry of imports.filter(entry => paths[entry.specifier] === undefined)) {
    problems.push(
      `${entry.file}:${entry.line} — imports from "${entry.specifier}", which the ` +
        `exports map does not publish.`
    );
  }

  const resolvable = imports.filter(
    entry => paths[entry.specifier] !== undefined && entry.bindings.length > 0
  );
  // One probe per distinct (entry, namespace, member): the same `Workbook.create` appears in
  // dozens of examples and checking it once is enough. The first site is kept for blame.
  const distinctMembers = new Map<string, MemberRef>();
  for (const reference of members) {
    if (paths[reference.specifier] === undefined) {
      continue;
    }
    if (DELIBERATELY_ABSENT.has(`${reference.namespace}.${reference.member} @ ${reference.file}`)) {
      continue;
    }
    const key = `${reference.specifier}|${reference.imported}|${reference.namespace}|${reference.member}`;
    if (!distinctMembers.has(key)) {
      distinctMembers.set(key, reference);
    }
  }
  const memberProbes = [...distinctMembers.values()];
  const built = Object.values(paths).some(([target]) => fs.existsSync(`${target}.d.ts`));

  if (!built) {
    problems.push(
      `dist/types is absent, so documented imports cannot be resolved. Run ` +
        `\`pnpm build:esm\` before \`pnpm verify:doc-examples\`.`
    );
    report(problems);
  }

  const dir = fs.mkdtempSync(path.join(tmpdir(), "verify-doc-examples-"));
  try {
    const files: string[] = [];
    const syntaxRegions: { file: string; startLine: number }[] = [];
    for (const file of filesUnder(ROOT, [".md"])) {
      for (const region of fencedRegions(fs.readFileSync(file, "utf8"))) {
        if (region.language !== "ts" && region.language !== "typescript") {
          continue;
        }
        const name = `doc-syntax-${syntaxRegions.length}.ts`;
        fs.writeFileSync(path.join(dir, name), region.text);
        files.push(name);
        syntaxRegions.push({ file: relPosix(ROOT, file), startLine: region.startLine });
      }
    }
    resolvable.forEach((entry, index) => {
      const name = `doc-import-${index}.ts`;
      fs.writeFileSync(
        path.join(dir, name),
        `import type { ${entry.bindings
          .map(binding =>
            binding.imported === binding.local
              ? binding.imported
              : `${binding.imported} as ${binding.local}`
          )
          .join(", ")} } from "${entry.specifier}";\nexport {};\n`
      );
      files.push(name);
    });
    // A member is probed twice, because a namespace member may be a value or a type and
    // neither form accepts both: `typeof Pdf.read` is how a function is named,
    // `Stream.WorkbookWriterOptions` is how a type is named, and each is an error for the
    // other kind. Requiring *both* to fail before reporting keeps the check agnostic about
    // which one a member is — the question asked here is only whether it exists.
    memberProbes.forEach((reference, index) => {
      const binding =
        reference.imported === reference.namespace
          ? reference.imported
          : `${reference.imported} as ${reference.namespace}`;
      const header = `import { ${binding} } from "${reference.specifier}";\n`;
      const access = `${reference.namespace}.${reference.member}`;
      fs.writeFileSync(
        path.join(dir, `member-value-${index}.ts`),
        `${header}type T = typeof ${access};\nexport type { T };\n`
      );
      fs.writeFileSync(
        path.join(dir, `member-type-${index}.ts`),
        `${header}type T = ${access};\nexport type { T };\n`
      );
      files.push(`member-value-${index}.ts`, `member-type-${index}.ts`);
    });

    const checked = typeCheck(dir, files, paths);
    const seen = new Set<string>();
    const missingAsValue = new Set<number>();
    const missingAsType = new Set<number>();
    let recognizedDiagnostics = 0;

    for (const line of checked.diagnostics.split("\n")) {
      const syntaxFailure = /doc-syntax-(\d+)\.ts\((\d+),\d+\): error TS(\d+): (.*)$/.exec(line);
      if (syntaxFailure) {
        recognizedDiagnostics += 1;
        const source = syntaxRegions[Number(syntaxFailure[1])];
        // `noResolve` is not used because these files share the import paths needed by the
        // other probes. Only parser diagnostics are relevant here; semantic diagnostics
        // (undeclared placeholders in concise examples) are deliberately ignored.
        const code = Number(syntaxFailure[3]);
        if (code >= 1000 && code < 2000) {
          problems.push(
            `${source.file}:${source.startLine + Number(syntaxFailure[2]) - 1} — ` +
              `TypeScript syntax error TS${code}: ${syntaxFailure[4]}`
          );
        }
        continue;
      }
      const importFailure = /doc-import-(\d+)\.ts\(\d+,\d+\): error TS\d+: (.*)$/.exec(line);
      if (importFailure) {
        recognizedDiagnostics += 1;
        const entry = resolvable[Number(importFailure[1])];
        const problem = `${entry.file}:${entry.line} — ${importFailure[2]}`;
        // The same names appear in an English and a Chinese README; one report is enough
        // per file and line, but both files are still reported.
        if (!seen.has(problem)) {
          seen.add(problem);
          problems.push(problem);
        }
        continue;
      }
      const memberFailure = /member-(value|type)-(\d+)\.ts\(\d+,\d+\): error TS(\d+):/.exec(line);
      if (memberFailure) {
        recognizedDiagnostics += 1;
        const code = Number(memberFailure[3]);
        // TS2314 (generic type requires arguments) proves the member exists. Only the
        // diagnostics that specifically mean "member absent" count as absence.
        if (memberFailure[1] === "value" && code === 2339) {
          missingAsValue.add(Number(memberFailure[2]));
        } else if (memberFailure[1] === "type" && (code === 2694 || code === 2503)) {
          missingAsType.add(Number(memberFailure[2]));
        }
      }
    }

    if (!checked.succeeded && recognizedDiagnostics === 0) {
      problems.push(
        `the TypeScript probe failed without a recognized diagnostic:\n${checked.diagnostics.trim()}`
      );
    }

    for (const index of missingAsValue) {
      if (!missingAsType.has(index)) {
        continue;
      }
      const reference = memberProbes[index];
      problems.push(
        `${reference.file}:${reference.line} — \`${reference.namespace}.${reference.member}\`` +
          ` is not a member of \`${reference.namespace}\` from "${reference.specifier}".`
      );
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  if (problems.length > 0) {
    report(problems);
  }
  const files = new Set(imports.map(entry => entry.file)).size;
  console.log(
    `✓ verify:doc-examples — ${imports.length} documented import(s) and ${members.length} ` +
      `member reference(s) (${memberProbes.length} distinct) across ${files} file(s) resolve.`
  );
}

/** Print every problem and exit non-zero. */
function report(problems: string[]): never {
  console.error("Documented imports do not match the public exports map:\n");
  for (const problem of problems) {
    console.error(`  - ${problem}`);
  }
  console.error(
    "\nAn example is the first thing a consumer copies. Name the public form — " +
      "`Pdf.read`, `Io.toBuffer`, `Worksheet.Handle` — not the internal declaration " +
      "it forwards to.\n"
  );
  process.exit(1);
}

// Only run when invoked directly, so importing it for tests does not exit the process.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main();
}
