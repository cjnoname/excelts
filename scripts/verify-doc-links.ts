/**
 * Local Markdown link verification.
 *
 * A relative link is a claim the repository can settle without the network, so it should
 * never be left to a reader to discover. This gate checks authored Markdown for:
 *
 * - relative file and directory targets;
 * - same-file and cross-file heading fragments;
 * - inline links/images and reference-link definitions.
 *
 * External URLs, absolute site routes and non-file schemes are deliberately out of scope:
 * checking them is slow, flaky and usually says more about a network than the document.
 * Link-like text inside fenced code is ignored.
 *
 * Heading fragments follow GitHub's useful subset: inline markup is stripped, punctuation
 * is removed, spaces become hyphens, Unicode letters are preserved, and duplicate slugs get
 * `-1`, `-2`, … suffixes. The repository currently uses English and Chinese headings, both
 * covered by that rule.
 *
 * Usage: node scripts/verify-doc-links.ts [--root <dir>]
 */

import fs from "node:fs";
import path from "node:path";

import { relPosix } from "./lib/paths.ts";

function rootFromArgv(): string {
  const flag = process.argv.indexOf("--root");
  return flag === -1
    ? path.resolve(import.meta.dirname, "..")
    : path.resolve(process.argv[flag + 1]);
}

const ROOT = rootFromArgv();
const SKIP_DIRS = new Set([".git", "dist", "node_modules", "out", "tmp", "__screenshots__"]);
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

interface Link {
  readonly file: string;
  readonly line: number;
  readonly destination: string;
}

function markdownFiles(dir: string): string[] {
  const found: string[] = [];
  // Read the directory and let the read say whether it is there: an `existsSync` guard
  // in front of it is a check-then-use race, and the only caller that can miss is a
  // bogus `--root`, which the walk answers with an empty list either way.
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) found.push(...markdownFiles(full));
    } else if (entry.name.endsWith(".md")) {
      found.push(full);
    }
  }
  return found;
}

/** Lines outside fenced code, retaining physical line numbers. */
function proseLines(source: string): { line: number; text: string }[] {
  const result: { line: number; text: string }[] = [];
  let open: string | undefined;
  source.split("\n").forEach((line, index) => {
    const content = line.replace(/^ {0,3}> ?/, "");
    const fence = FENCE.exec(content);
    if (open === undefined) {
      if (fence) {
        open = fence[1];
      } else {
        result.push({ line: index + 1, text: line });
      }
    } else if (
      fence &&
      fence[1][0] === open[0] &&
      fence[1].length >= open.length &&
      content.trim() === fence[1]
    ) {
      open = undefined;
    }
  });
  return result;
}

/** Destination before an optional Markdown title. */
function destination(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("<")) {
    const end = trimmed.indexOf(">");
    return end === -1 ? trimmed : trimmed.slice(1, end);
  }
  return trimmed.split(/\s+(?=["'(])/)[0];
}

function linksIn(file: string, source: string): Link[] {
  const links: Link[] = [];
  for (const { line, text } of proseLines(source)) {
    // Inline links and images. Nested brackets in the label are allowed one level deep,
    // which covers badges and ordinary prose without pretending to be a Markdown parser.
    for (const match of text.matchAll(/!?\[(?:[^\[\]]|\[[^\]]*\])*\]\(([^)]+)\)/g)) {
      links.push({ file, line, destination: destination(match[1]) });
    }
    // Reference definitions: `[name]: target "optional title"`.
    const reference = /^\s{0,3}\[[^\]]+\]:\s*(\S.*)$/.exec(text);
    if (reference) {
      links.push({ file, line, destination: destination(reference[1]) });
    }
  }
  return links;
}

/**
 * Inline markup a Markdown renderer consumes before the anchor is computed.
 *
 * The slug is derived from a heading's *text content*, so anything the renderer turns into
 * an element rather than characters has to go first: tags, code-span backticks, link syntax
 * (label kept, destination dropped) and emphasis delimiters. Underscore emphasis is the one
 * that matters, because `_` survives the character filter in `slug` — `## _Draft_` is `draft`
 * on GitHub, while `## do_something` keeps its underscore, so only boundary underscores are
 * stripped rather than every one.
 *
 * Kept as data and applied in a loop by `stripInlineMarkup` rather than written as a
 * `.replace().replace()` chain. The repetition is what makes the strip correct, and it is
 * also the only shape `js/incomplete-multi-character-sanitization` accepts: it treats a
 * replacement as repeated when the result flows back into its own receiver, which a chain
 * hides — each result becomes the *next* call's receiver instead. Re-chaining these would
 * reintroduce both the bug and the alert.
 */
const INLINE_MARKUP: readonly (readonly [pattern: RegExp, replacement: string])[] = [
  [/<[^>]*>/g, ""],
  [/`+([^`]*)`+/g, "$1"],
  [/!?\[([^\]]*)\]\([^)]*\)/g, "$1"],
  [/!?\[([^\]]*)\]\[[^\]]*\]/g, "$1"],
  [/~~([^~]*)~~/g, "$1"],
  [/\*+([^*]*)\*+/g, "$1"],
  [/(^|[\s(])__?([^_]+)__?(?=[\s).,:;!?]|$)/g, "$1$2"]
];

/**
 * Apply every rule until the text stops changing, because one pass is not idempotent.
 *
 * Removing a construct splices what surrounded it together, and the halves can form a
 * construct that was not there before. A badge — a link whose label is an image, which is
 * what `linksIn` allows one level of nesting for — is the case that bites:
 * `[![](img.svg)](https://ci.example)` becomes `![](https://ci.example)` after one pass, so
 * the destination survives into the text and `httpsciexample` lands in the slug, characters
 * the heading does not contain. A second pass removes what is left.
 *
 * The loop terminates: every rewrite that changes the string deletes at least two delimiter
 * characters, so the length strictly decreases and the bound can never be the thing that
 * stops it.
 */
function stripInlineMarkup(text: string): string {
  let current = text;
  for (let pass = 0; pass <= text.length; pass += 1) {
    const before = current;
    for (const [pattern, replacement] of INLINE_MARKUP) {
      current = current.replace(pattern, replacement);
    }
    if (current === before) break;
  }
  return current;
}

/**
 * A heading's anchor, as GitHub computes it.
 *
 * Lower-case, drop every character that is not a word character, a space or a hyphen, then
 * translate spaces to hyphens **one for one**. That last detail is not cosmetic: this
 * repository writes `### Excel — XLSX/JSON Workbook Manager`, where deleting the em dash
 * leaves two adjacent spaces and the real anchor is `excel--xlsxjson-workbook-manager`.
 * Collapsing whitespace — which an earlier draft of this file did — produced a single
 * hyphen and would therefore have reported a *working* link as broken, in about forty
 * headings. A false positive in a gate is worse than a missing check, because it blocks
 * work that was correct.
 *
 * `\p{Word}` in the reference implementation is Ruby's: letters, marks, decimal digits and
 * connector punctuation (which is what keeps `_`). Everything else — emoji, `&`, `+`, `/`,
 * CJK punctuation — is removed, while CJK letters are kept.
 */
function slug(text: string): string {
  return stripInlineMarkup(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{Nd}\p{Pc}\- ]/gu, "")
    .replace(/ /g, "-");
}

/** GitHub-style heading IDs, including duplicate suffixes and explicit HTML anchors. */
function anchors(source: string): Set<string> {
  const result = new Set<string>();
  const seen = new Map<string, number>();
  const lines = proseLines(source);
  for (let index = 0; index < lines.length; index += 1) {
    // An explicit anchor wins as written: `<a id="x">` is how a document names a target
    // that is not a heading, and rejecting it would make this gate report a link that
    // works. Cheap to honour, and a false positive here blocks unrelated work.
    for (const explicit of lines[index].text.matchAll(
      /<a\s[^>]*\b(?:id|name)\s*=\s*["']([^"']+)["']/gi
    )) {
      result.add(explicit[1].toLowerCase());
    }
    const atx = /^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(lines[index].text);
    const setext =
      index + 1 < lines.length && lines[index + 1].line === lines[index].line + 1
        ? /^ {0,3}(?:=+|-+)\s*$/.test(lines[index + 1].text)
        : false;
    const heading = atx?.[1] ?? (setext ? lines[index].text.trim() : undefined);
    if (heading === undefined || heading === "") continue;
    const base = slug(heading);
    const duplicate = seen.get(base) ?? 0;
    seen.set(base, duplicate + 1);
    result.add(duplicate === 0 ? base : `${base}-${duplicate}`);
  }
  return result;
}

function decode(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

type ReadResult = { readonly source: string } | { readonly failure: string };

/**
 * Read a Markdown target, and let the read say what is wrong with it.
 *
 * Deliberately not preceded by an existence check: `existsSync` followed by `readFileSync`
 * is a time-of-check/time-of-use race — between the two calls the path can be replaced by
 * a directory or removed, and the gate then crashes with a raw `ENOENT` instead of
 * reporting a broken link. The error code carries everything the check did and more:
 * `EISDIR` is the `foo.md/` directory case that a separate `statSync(…).isFile()` was
 * there to catch.
 */
function readMarkdown(target: string): ReadResult {
  try {
    return { source: fs.readFileSync(target, "utf8") };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { failure: "does not exist" };
    if (code === "EISDIR") return { failure: "is a directory, not a Markdown file" };
    return { failure: `could not be read (${code ?? String(error)})` };
  }
}

function main(): void {
  const files = markdownFiles(ROOT);
  const sourceByFile = new Map(files.map(file => [file, fs.readFileSync(file, "utf8")]));
  const anchorCache = new Map<string, Set<string>>();
  const problems: string[] = [];
  let checked = 0;

  for (const [file, source] of sourceByFile) {
    for (const link of linksIn(relPosix(ROOT, file), source)) {
      const raw = link.destination;
      if (
        raw === "" ||
        raw.startsWith("/") ||
        raw.startsWith("//") ||
        /^[A-Za-z][A-Za-z0-9+.-]*:/.test(raw)
      ) {
        continue;
      }
      checked += 1;
      const hash = raw.indexOf("#");
      const beforeHash = hash === -1 ? raw : raw.slice(0, hash);
      const query = beforeHash.indexOf("?");
      const rawPath = query === -1 ? beforeHash : beforeHash.slice(0, query);
      const rawFragment = hash === -1 ? "" : raw.slice(hash + 1);
      const decodedPath = decode(rawPath);
      const decodedFragment = decode(rawFragment);
      if (decodedPath === undefined || decodedFragment === undefined) {
        problems.push(`${link.file}:${link.line} — malformed percent-encoding in "${raw}".`);
        continue;
      }
      const target = decodedPath === "" ? file : path.resolve(path.dirname(file), decodedPath);
      if (decodedFragment === "" || !target.endsWith(".md")) {
        // Existence is the whole question here — a directory, an image, a link with no
        // fragment — and nothing else touches the path afterwards, so this `statSync` is
        // the use rather than a check standing in front of one.
        if (fs.statSync(target, { throwIfNoEntry: false }) === undefined) {
          problems.push(`${link.file}:${link.line} — local target "${rawPath}" does not exist.`);
        } else if (decodedFragment !== "") {
          problems.push(
            `${link.file}:${link.line} — "${raw}" has a fragment on a non-Markdown target.`
          );
        }
        continue;
      }
      let targetAnchors = anchorCache.get(target);
      if (!targetAnchors) {
        const cached = sourceByFile.get(target);
        // A Markdown target outside the walk — a skipped directory, or a file added since
        // it ran. The read is the only file-system call on this path, so a target that
        // disappears is reported rather than thrown.
        const read: ReadResult = cached === undefined ? readMarkdown(target) : { source: cached };
        if (!("source" in read)) {
          problems.push(`${link.file}:${link.line} — local target "${rawPath}" ${read.failure}.`);
          continue;
        }
        targetAnchors = anchors(read.source);
        anchorCache.set(target, targetAnchors);
      }
      if (!targetAnchors.has(decodedFragment.toLowerCase())) {
        problems.push(
          `${link.file}:${link.line} — heading "#${rawFragment}" does not exist in ${relPosix(ROOT, target)}.`
        );
      }
    }
  }

  if (problems.length > 0) {
    console.error("Local Markdown links are broken:\n");
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log(
    `✓ verify:doc-links — ${checked} local link(s) across ${files.length} Markdown file(s) resolve.`
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main();
}
