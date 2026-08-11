#!/usr/bin/env node
// Post-build script:
// - rewrites relative imports/exports in a dist folder to prefer sibling `.browser.js` when present.
// This mirrors src/utils/browser.ts (preferBrowserFilesPlugin) but works on emitted files.
//
// Declaration files are rewritten as well as JS. Skipping them used to leave the
// browser build's `.d.ts` graph pointing at the Node variants (e.g. csv's parser
// typed `Transform` from `stream/index.d.ts`, the Node entry, while the JS loaded
// `stream/index.browser.js`) — so browser consumers got Node types and needed
// `@types/node`. `pnpm build:verify:browser` now guards this.
import fs from "node:fs";
import path from "node:path";

const projectRoot = process.cwd();

function readArg(name: string): string | null {
  const argv = process.argv;
  const idx = argv.indexOf(name);
  if (idx === -1) {
    return null;
  }
  return argv[idx + 1] ?? null;
}

function resolveDirArg(value: string | null): string | null {
  if (!value || typeof value !== "string") {
    return null;
  }
  return path.isAbsolute(value) ? value : path.resolve(projectRoot, value);
}

const distDir = resolveDirArg(readArg("--dir") ?? readArg("--dist"));
if (!distDir) {
  console.error("Usage: node scripts/fix-browser-imports.mjs --dir <distDir>");
  process.exitCode = 1;
  process.exit();
}

function toPosixPath(p: string): string {
  return p.split(path.sep).join("/");
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function walk(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (entry.isFile() && (entry.name.endsWith(".js") || entry.name.endsWith(".d.ts"))) {
      out.push(full);
    }
  }
  return out;
}

interface PreferBrowserSpecifierOptions {
  filePath: string;
  specifier: string;
}

/** Relative specifier for `candidateAbs`, POSIX-style and always `./`-prefixed. */
function relativeSpecifier(filePath: string, candidateAbs: string): string {
  let rel = toPosixPath(path.relative(path.dirname(filePath), candidateAbs));
  if (!rel.startsWith(".")) {
    rel = `./${rel}`;
  }
  return rel;
}

function preferBrowserSpecifier({
  filePath,
  specifier
}: PreferBrowserSpecifierOptions): string | null {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
    return null;
  }
  if (specifier.includes(".browser.")) {
    return null;
  }
  // Declaration files also spell their specifiers `.js` (NodeNext), so the
  // matching is identical; only the file we probe for differs.
  if (!specifier.endsWith(".js")) {
    return null;
  }
  const emitExt = filePath.endsWith(".d.ts") ? ".d.ts" : ".js";

  const absTarget = path.resolve(path.dirname(filePath), specifier);
  const base = absTarget.slice(0, -".js".length);
  if (isFile(`${base}.browser${emitExt}`)) {
    return relativeSpecifier(filePath, `${base}.browser.js`);
  }

  // Also support swapping `/index.js` to `/index.browser.js` if it exists.
  if (absTarget.endsWith(`${path.sep}index.js`)) {
    const indexBase = absTarget.slice(0, -"index.js".length);
    if (isFile(path.join(indexBase, `index.browser${emitExt}`))) {
      return relativeSpecifier(filePath, path.join(indexBase, "index.browser.js"));
    }
  }

  return null;
}

let filesModified = 0;
let specifiersRewritten = 0;

const files = walk(distDir);
for (const filePath of files) {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    continue;
  }
  const original = content;

  // Static imports/exports: import ... from "x"; export ... from "x";
  content = content.replace(
    /((?:import|export)\s*(?:[^'\"]*\s+from\s+)?['\"])(\.[^'\"]+)(['\"])/g,
    (match, prefix, specifier, suffix) => {
      const rewritten = preferBrowserSpecifier({ filePath, specifier });
      if (!rewritten) {
        return match;
      }
      specifiersRewritten++;
      return `${prefix}${rewritten}${suffix}`;
    }
  );

  // Dynamic imports: import("x")
  content = content.replace(
    /(import\s*\(\s*['\"])(\.[^'\"]+)(['\"]\s*\))/g,
    (match, prefix, specifier, suffix) => {
      const rewritten = preferBrowserSpecifier({ filePath, specifier });
      if (!rewritten) {
        return match;
      }
      specifiersRewritten++;
      return `${prefix}${rewritten}${suffix}`;
    }
  );

  if (content !== original) {
    try {
      fs.writeFileSync(filePath, content);
      filesModified++;
    } catch {
      // ignore
    }
  }
}

console.log(
  `Prefer browser imports in ${toPosixPath(distDir)}: modified ${filesModified} files; rewrote ${specifiersRewritten} specifiers.`
);
