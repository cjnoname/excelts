#!/usr/bin/env node
// Post-build script for CJS:
// - rewrites TS path aliases (from tsconfig.json) to relative paths in dist/cjs
// - creates package.json to mark directory as CommonJS
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { relPosix } from "./lib/paths.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const cjsDir = path.join(__dirname, "../dist/cjs");

function isSafeAliasCapture(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  if (value.includes("\0") || value.includes("\\")) {
    return false;
  }
  const normalized = path.posix.normalize(value);
  if (path.posix.isAbsolute(normalized)) {
    return false;
  }
  return !normalized.startsWith("..") && !normalized.includes("../");
}

function replaceStarLiteral(pattern: string, replacement: string): string {
  return pattern.split("*").join(replacement);
}

function tryResolveFile(filePathWithoutExt: string): string | null {
  const candidates = [
    filePathWithoutExt,
    `${filePathWithoutExt}.ts`,
    `${filePathWithoutExt}.tsx`,
    path.join(filePathWithoutExt, "index.ts"),
    path.join(filePathWithoutExt, "index.tsx")
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return null;
}

interface TsconfigPaths {
  [key: string]: string[];
}

function loadTsconfigPaths(): TsconfigPaths {
  const tsconfigPath = path.join(projectRoot, "tsconfig.json");
  const tsconfig = JSON.parse(fs.readFileSync(tsconfigPath, "utf8"));
  return tsconfig?.compilerOptions?.paths ?? {};
}

const tsconfigPaths = loadTsconfigPaths();

interface ResolveAliasOptions {
  specifier: string;
  filePath: string;
  distRoot: string;
}

function resolveAliasToRelativeImport({
  specifier,
  filePath,
  distRoot
}: ResolveAliasOptions): string | null {
  if (!specifier.startsWith("@")) {
    return null;
  }

  const srcRoot = path.join(projectRoot, "src");

  for (const [aliasPattern, targetPatterns] of Object.entries(tsconfigPaths)) {
    const hasStar = aliasPattern.includes("*");

    let captured: string;
    if (hasStar) {
      const [prefix, suffix] = aliasPattern.split("*");
      if (specifier.startsWith(prefix) && specifier.endsWith(suffix)) {
        captured = specifier.slice(prefix.length, specifier.length - suffix.length);
        if (!isSafeAliasCapture(captured)) {
          continue;
        }
      } else {
        continue;
      }
    } else {
      if (specifier !== aliasPattern) {
        continue;
      }
      captured = "";
    }

    for (const targetPattern of targetPatterns) {
      const replaced = hasStar ? replaceStarLiteral(targetPattern, captured) : targetPattern;
      const absTarget = path.resolve(projectRoot, replaced);
      const absSrcFile = tryResolveFile(absTarget) ?? absTarget;

      const relFromSrcRoot = path.relative(srcRoot, absSrcFile);
      if (relFromSrcRoot.startsWith("..") || (path.isAbsolute(relFromSrcRoot) && !relFromSrcRoot)) {
        continue;
      }

      let absDistFile = path.join(distRoot, relFromSrcRoot).replace(/\.[cm]?tsx?$/i, ".js");
      if (!absDistFile.endsWith(".js")) {
        absDistFile = `${absDistFile}.js`;
      }
      if (!fs.existsSync(absDistFile)) {
        const indexCandidate = path.join(absDistFile.replace(/\.js$/i, ""), "index.js");
        if (fs.existsSync(indexCandidate)) {
          absDistFile = indexCandidate;
        }
      }

      let rel = relPosix(path.dirname(filePath), absDistFile);
      if (!rel.startsWith(".")) {
        rel = `./${rel}`;
      }
      return rel;
    }
  }

  return null;
}

function rewritePathAliasesInFile(filePath: string, distRoot: string): void {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    return;
  }
  const originalContent = content;

  // require("x")
  content = content.replace(
    /(require\(\s*['\"])([^'\"]+)(['\"]\s*\))/g,
    (match, prefix, specifier, suffix) => {
      const rewritten = resolveAliasToRelativeImport({ specifier, filePath, distRoot });
      if (!rewritten) {
        return match;
      }
      return `${prefix}${rewritten}${suffix}`;
    }
  );

  // Dynamic import("x") (rare in CJS output but safe)
  content = content.replace(
    /(import\s*\(\s*['\"])([^'\"]+)(['\"]\s*\))/g,
    (match, prefix, specifier, suffix) => {
      const rewritten = resolveAliasToRelativeImport({ specifier, filePath, distRoot });
      if (!rewritten) {
        return match;
      }
      return `${prefix}${rewritten}${suffix}`;
    }
  );

  if (content !== originalContent) {
    fs.writeFileSync(filePath, content);
  }
}

function rewritePathAliases(dir: string, distRoot: string): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const filePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      rewritePathAliases(filePath, distRoot);
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      rewritePathAliasesInFile(filePath, distRoot);
    }
  }
}

console.log("Rewriting tsconfig path aliases in CJS output...");
rewritePathAliases(cjsDir, cjsDir);

fs.writeFileSync(path.join(cjsDir, "package.json"), JSON.stringify({ type: "commonjs" }, null, 2));

console.log("Created dist/cjs/package.json");
