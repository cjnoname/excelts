#!/usr/bin/env node
// Post-build script for ESM:
// - rewrites TS path aliases (from tsconfig.json) to relative paths in dist/esm
// - adds .js extensions to relative imports for Node.js ESM compatibility
// - verifies all relative ESM specifiers have explicit extensions
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { relPosix, toPosixPath } from "./lib/paths.ts";

// ============================================================================
// Configuration
// ============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

// The two trees this runs on. It used to take `--dist` / `--esm` / `--types` so the same
// script could also process `dist/browser`; that target is gone — the browser variant is
// resolved through `#platform/*` now, not compiled a second time — and `build:esm` is the
// only caller left, passing nothing. The flags were also a trap: they resolved a relative
// value against the *repository* root, so `--dist dist/esm` from any other directory
// silently retargeted the real tree.
const esmDir = path.join(projectRoot, "dist/esm");
const typesDir = path.join(projectRoot, "dist/types");

let filesModified = 0;

// ============================================================================
// Shared Utilities
// ============================================================================

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Shared regex patterns for import/export statements
// Use functions to create fresh regex instances (avoid lastIndex issues with /g flag)
const createStaticImportRe = (): RegExp =>
  /((?:import|export)\s*(?:[^'"]*\s+from\s+)?['"])([^'"]+)(['"])/g;
const createDynamicImportRe = (): RegExp => /(import\s*\(\s*['"])([^'"]+)(['"]\s*\))/g;
const RELATIVE_PATH_RE = /^\.\.?\//;

function isRelativeSpecifier(specifier: string): boolean {
  return RELATIVE_PATH_RE.test(specifier);
}

// Known JS/TS extensions that indicate a complete specifier
const JS_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".tsx", ".jsx"]);

function hasExtension(specifier: string): boolean {
  const ext = path.posix.extname(specifier);
  // Only consider it "has extension" if it's a known JS extension
  // This prevents ".browser" from being treated as a complete extension
  return JS_EXTENSIONS.has(ext);
}

/**
 * Walk directory and collect files matching filter
 */
function walkDir(dir: string, filter: (name: string) => boolean): string[] {
  const results: string[] = [];
  const stack: string[] = [dir];
  while (stack.length) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(abs);
      } else if (entry.isFile() && filter(entry.name)) {
        results.push(abs);
      }
    }
  }
  return results;
}

/**
 * Transform file content with a transformer function
 * Returns true if file was modified
 */
function transformFile(
  filePath: string,
  transformer: (content: string, filePath: string) => string
): boolean {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    return false;
  }
  const newContent = transformer(content, filePath);
  if (newContent !== content) {
    fs.writeFileSync(filePath, newContent);
    filesModified++;
    return true;
  }
  return false;
}

/**
 * Replace all import/export specifiers in content using a rewriter function
 */
function rewriteSpecifiers(content: string, rewriter: (specifier: string) => string): string {
  // Static imports/exports
  content = content.replace(createStaticImportRe(), (match, prefix, specifier, suffix) => {
    const rewritten = rewriter(specifier);
    return rewritten !== specifier ? `${prefix}${rewritten}${suffix}` : match;
  });
  // Dynamic imports
  content = content.replace(createDynamicImportRe(), (match, prefix, specifier, suffix) => {
    const rewritten = rewriter(specifier);
    return rewritten !== specifier ? `${prefix}${rewritten}${suffix}` : match;
  });
  return content;
}

// ============================================================================
// Path Alias Resolution
// ============================================================================

interface TsconfigPaths {
  [key: string]: string[];
}

function loadTsconfigPaths(): TsconfigPaths {
  const tsconfigPath = path.join(projectRoot, "tsconfig.json");
  const tsconfig = JSON.parse(fs.readFileSync(tsconfigPath, "utf8"));
  return tsconfig?.compilerOptions?.paths ?? {};
}

const tsconfigPaths = loadTsconfigPaths();

function isSafeAliasCapture(value: unknown): boolean {
  if (typeof value !== "string" || value.includes("\0") || value.includes("\\")) {
    return false;
  }
  const normalized = path.posix.normalize(value);
  return (
    !path.posix.isAbsolute(normalized) &&
    !normalized.startsWith("..") &&
    !normalized.includes("../")
  );
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

interface ResolveAliasOptions {
  specifier: string;
  filePath: string;
  distRoot: string;
  outputExtension: string;
}

function resolveAliasToRelativeImport({
  specifier,
  filePath,
  distRoot,
  outputExtension
}: ResolveAliasOptions): string | null {
  if (!specifier.startsWith("@")) return null;

  const srcRoot = path.join(projectRoot, "src");

  for (const [aliasPattern, targetPatterns] of Object.entries(tsconfigPaths)) {
    const hasStar = aliasPattern.includes("*");
    let captured: string;

    if (hasStar) {
      const [prefix, suffix] = aliasPattern.split("*");
      if (specifier.startsWith(prefix) && specifier.endsWith(suffix)) {
        captured = specifier.slice(prefix.length, specifier.length - suffix.length);
        if (!isSafeAliasCapture(captured)) continue;
      } else {
        continue;
      }
    } else {
      if (specifier !== aliasPattern) continue;
      captured = "";
    }

    for (const targetPattern of targetPatterns) {
      const replaced = hasStar ? targetPattern.split("*").join(captured) : targetPattern;
      const absTarget = path.resolve(projectRoot, replaced);
      const absSrcFile = tryResolveFile(absTarget) ?? absTarget;

      const relFromSrcRoot = path.relative(srcRoot, absSrcFile);
      if (relFromSrcRoot.startsWith("..") || path.isAbsolute(relFromSrcRoot)) continue;

      let absDistFile = path
        .join(distRoot, relFromSrcRoot)
        .replace(/\.[cm]?tsx?$/i, outputExtension);

      if (!absDistFile.endsWith(outputExtension)) {
        absDistFile = `${absDistFile}${outputExtension}`;
      }
      if (!fs.existsSync(absDistFile)) {
        const outputExtRegex = new RegExp(`${escapeRegExp(outputExtension)}$`, "i");
        const indexCandidate = path.join(
          absDistFile.replace(outputExtRegex, ""),
          `index${outputExtension}`
        );
        if (fs.existsSync(indexCandidate)) {
          absDistFile = indexCandidate;
        }
      }

      let rel = relPosix(path.dirname(filePath), absDistFile);
      if (!rel.startsWith(".")) rel = `./${rel}`;
      return rel;
    }
  }
  return null;
}

// ============================================================================
// Transform Functions
// ============================================================================

interface RewritePathAliasesOptions {
  fileExtensions: string[];
  outputExtension: string;
}

/**
 * Rewrite path aliases to relative imports
 */
function rewritePathAliases(
  dir: string,
  distRoot: string,
  { fileExtensions, outputExtension }: RewritePathAliasesOptions
): void {
  const files = walkDir(dir, name => fileExtensions.some(ext => name.endsWith(ext)));
  for (const filePath of files) {
    transformFile(filePath, content =>
      rewriteSpecifiers(content, specifier => {
        const rewritten = resolveAliasToRelativeImport({
          specifier,
          filePath,
          distRoot,
          outputExtension
        });
        return rewritten ?? specifier;
      })
    );
  }
}

/**
 * Normalize .d.ts specifiers: add .js extensions, convert .d.ts -> .js
 */
function normalizeDeclarationSpecifiers(dir: string): void {
  const files = walkDir(dir, name => name.endsWith(".d.ts"));
  for (const filePath of files) {
    transformFile(filePath, content =>
      rewriteSpecifiers(content, specifier => {
        if (!isRelativeSpecifier(specifier)) return specifier;

        // Convert explicit .d.ts -> .js
        if (specifier.endsWith(".d.ts")) {
          return `${specifier.slice(0, -".d.ts".length)}.js`;
        }

        // Preserve existing extensions
        if (hasExtension(specifier)) return specifier;

        // Add .js, check for directory index
        const resolvedPath = path.resolve(path.dirname(filePath), specifier);
        if (fs.existsSync(path.join(resolvedPath, "index.d.ts"))) {
          return `${specifier}/index.js`;
        }
        return `${specifier}.js`;
      })
    );
  }
}

/**
 * Add .js extensions to relative imports in JS files
 */
function addJsExtensions(dir: string): void {
  const files = walkDir(dir, name => name.endsWith(".js"));
  for (const filePath of files) {
    transformFile(filePath, content =>
      rewriteSpecifiers(content, specifier => {
        if (!isRelativeSpecifier(specifier)) return specifier;
        // Skip if already has any extension (.js, .json, .mjs, etc.)
        if (hasExtension(specifier)) return specifier;

        // Check for directory index
        const resolvedPath = path.resolve(path.dirname(filePath), specifier);
        if (fs.existsSync(path.join(resolvedPath, "index.js"))) {
          return `${specifier}/index.js`;
        }
        return `${specifier}.js`;
      })
    );
  }
}

// ============================================================================
// Verification
// ============================================================================

function computeLineNumber(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i++) {
    if (source.charCodeAt(i) === 10) line++;
  }
  return line;
}

// More precise regex for verification to capture exact positions
// Use functions to create fresh regex instances
const createVerifyStaticRe = (): RegExp =>
  /\b(?:import|export)\b[\s\S]*?\bfrom\s*["'](?<spec1>[^"']+)["']|\bimport\s*["'](?<spec2>[^"']+)["']/g;
const createVerifyDynamicRe = (): RegExp => /\bimport\s*\(\s*["'](?<spec>[^"']+)["']\s*\)/g;

interface Issue {
  filePath: string;
  line: number;
  kind: string;
  specifier: string;
}

function scanFileForIssues(filePath: string): Issue[] {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    return [];
  }

  // Remove code blocks in comments to avoid false positives from example code
  const contentWithoutCodeBlocks = content.replace(/```[\s\S]*?```/g, match =>
    " ".repeat(match.length)
  );

  const issues: Issue[] = [];

  // Check static imports/exports
  for (const match of contentWithoutCodeBlocks.matchAll(createVerifyStaticRe())) {
    const specifier = match.groups?.spec1 ?? match.groups?.spec2;
    if (!specifier || !isRelativeSpecifier(specifier)) continue;
    // Must have .js, .json, or other valid extension
    if (!hasExtension(specifier)) {
      issues.push({
        filePath,
        line: computeLineNumber(content, match.index ?? 0),
        kind: "static",
        specifier
      });
    }
  }

  // Check dynamic imports
  for (const match of contentWithoutCodeBlocks.matchAll(createVerifyDynamicRe())) {
    const specifier = match.groups?.spec;
    if (!specifier || !isRelativeSpecifier(specifier)) continue;
    // Must have .js, .json, or other valid extension
    if (!hasExtension(specifier)) {
      issues.push({
        filePath,
        line: computeLineNumber(content, match.index ?? 0),
        kind: "dynamic",
        specifier
      });
    }
  }

  return issues;
}

function verifyEsmSpecifiers(dir: string): boolean {
  console.log(`Verifying ESM specifiers in ${toPosixPath(dir)}...`);
  const files = walkDir(dir, name => name.endsWith(".js") || name.endsWith(".d.ts"));

  let issues: Issue[] = [];
  for (const file of files) {
    issues = issues.concat(scanFileForIssues(file));
  }

  if (issues.length === 0) {
    console.log(
      `✅ OK: all relative ESM specifiers in ${toPosixPath(dir)} have explicit extensions.`
    );
    return true;
  }

  issues.sort((a, b) =>
    a.filePath === b.filePath ? a.line - b.line : a.filePath.localeCompare(b.filePath)
  );

  console.error(
    `❌ Found ${issues.length} extensionless relative specifier(s) in ${toPosixPath(dir)}:`
  );
  for (const issue of issues) {
    const relFile = relPosix(process.cwd(), issue.filePath);
    console.error(`${relFile}:${issue.line}  ${issue.kind}  ${issue.specifier}`);
  }
  return false;
}

// ============================================================================
// Main
// ============================================================================

console.log(`Rewriting tsconfig path aliases in ESM output (${toPosixPath(esmDir)})...`);
rewritePathAliases(esmDir, esmDir, { fileExtensions: [".js"], outputExtension: ".js" });
rewritePathAliases(esmDir, esmDir, { fileExtensions: [".d.ts"], outputExtension: ".js" });

console.log(`Rewriting tsconfig path aliases in declaration output (${toPosixPath(typesDir)})...`);
rewritePathAliases(typesDir, typesDir, { fileExtensions: [".d.ts"], outputExtension: ".d.ts" });

console.log(`Normalizing declaration specifiers for Node16/NodeNext (${toPosixPath(typesDir)})...`);
normalizeDeclarationSpecifiers(typesDir);

console.log(`Normalizing declaration specifiers in ESM output (${toPosixPath(esmDir)})...`);
normalizeDeclarationSpecifiers(esmDir);

console.log("Adding .js extensions to ESM imports for Node.js compatibility...");
addJsExtensions(esmDir);

console.log(`Done! Modified ${filesModified} files.`);

// Verify both ESM and types directories
const esmOk = verifyEsmSpecifiers(esmDir);
const typesOk = verifyEsmSpecifiers(typesDir);

if (!esmOk || !typesOk) {
  process.exit(1);
}
