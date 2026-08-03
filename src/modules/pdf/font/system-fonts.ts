/**
 * System font discovery for PDF generation.
 *
 * When no embedded font is provided and the document contains non-WinAnsi
 * characters, this module searches standard system font directories for a
 * TrueType font (.ttf or .ttc) with broad Unicode coverage.
 *
 * This is a Node.js-only feature — browser environments do not have
 * file system access and must always provide fonts explicitly.
 *
 * .ttc (TrueType Collection) files are supported — parseTtf() extracts
 * the first font from the collection automatically.
 *
 * Discovery is exposed both as a generator
 * ({@link iterateSystemFontCandidates}) for early-exit callers and as
 * an array snapshot ({@link discoverSystemFontCandidates}) for tests
 * and full enumeration. Once the full snapshot has been produced it is
 * cached and replayed on subsequent calls; partial iterations rely on
 * the OS page cache to make repeat reads of the same font files cheap.
 *
 * Auto-embed callers should not iterate themselves: use
 * {@link findSystemFontForCodePoints}, which owns the coverage rule so every
 * pipeline picks the same font for the same text.
 */

import { parseTtf } from "@pdf/font/ttf-parser";
import type { TtfFont } from "@pdf/font/ttf-parser";
import { fileExistsSync, readFileBytesSync, traverseDirectorySync } from "@utils/fs";
import type { FileEntry } from "@utils/fs";

// =============================================================================
// Platform Font Directories
// =============================================================================

function getSystemFontDirs(): string[] {
  const platform = typeof process !== "undefined" ? process.platform : "";
  const home =
    typeof process !== "undefined" ? (process.env.HOME ?? process.env.USERPROFILE ?? "") : "";

  const dirs: string[] = [];

  switch (platform) {
    case "darwin":
      dirs.push(
        "/System/Library/Fonts",
        "/System/Library/Fonts/Supplemental",
        "/Library/Fonts",
        `${home}/Library/Fonts`
      );
      break;
    case "win32": {
      const winDir = process.env.WINDIR ?? process.env.SystemRoot ?? "C:\\Windows";
      dirs.push(`${winDir}\\Fonts`, `${process.env.LOCALAPPDATA ?? ""}\\Microsoft\\Windows\\Fonts`);
      break;
    }
    case "linux":
    default:
      dirs.push(
        "/usr/share/fonts",
        "/usr/local/share/fonts",
        "/usr/share/fonts/truetype",
        "/usr/share/fonts/opentype",
        "/usr/share/fonts/TTF",
        "/usr/share/fonts/noto",
        "/usr/share/fonts/noto-cjk",
        "/usr/share/fonts/google-noto",
        "/usr/share/fonts/google-noto-cjk",
        "/usr/share/fonts/truetype/noto",
        "/usr/share/fonts/truetype/dejavu",
        "/usr/share/fonts/truetype/liberation",
        "/usr/share/fonts/truetype/droid",
        "/usr/share/fonts/wqy",
        `${home}/.local/share/fonts`,
        `${home}/.fonts`
      );
      break;
  }

  return dirs;
}

// =============================================================================
// Preferred Font Names (ordered by preference — first match wins)
// =============================================================================

const PREFERRED_FONTS = [
  // Noto Sans CJK — broadest open-source coverage
  "NotoSansCJKsc-Regular.ttf",
  "NotoSansCJK-Regular.ttc",
  "NotoSansCJKSC-Regular.otf",
  "NotoSansSC-Regular.ttf",
  "NotoSansTC-Regular.ttf",
  "NotoSansJP-Regular.ttf",
  "NotoSansKR-Regular.ttf",
  "NotoSans-Regular.ttf",
  // Arial Unicode MS
  "Arial Unicode.ttf",
  "Arial Unicode MS.ttf",
  "ArialUnicode.ttf",
  "arialuni.ttf",
  // macOS
  "PingFang.ttc",
  "Hiragino Sans GB.ttc",
  "STHeiti Light.ttc",
  "STHeiti Medium.ttc",
  "Songti.ttc",
  "AppleSDGothicNeo.ttc",
  // Windows
  "msyh.ttc",
  "msyhbd.ttc",
  "msjh.ttc",
  "simsun.ttc",
  "simhei.ttf",
  "malgun.ttf",
  "meiryo.ttc",
  "yugothic.ttf",
  "segoeui.ttf",
  "arial.ttf",
  // Linux
  "DejaVuSans.ttf",
  "LiberationSans-Regular.ttf",
  "FreeSans.ttf",
  "DroidSansFallbackFull.ttf",
  "DroidSansFallback.ttf",
  "wqy-microhei.ttc",
  "wqy-zenhei.ttc",
  "uming.ttc",
  "NanumGothic.ttf",
  "IPAexGothic.ttf"
];

// =============================================================================
// Font Discovery
// =============================================================================

// Cached, fully-populated candidate list. Set when the generator runs
// to completion via `discoverSystemFontCandidates()`, or when a test
// injects candidates via `_setCandidatesForTest`. Partial iterations
// (where the caller `break`s after a match) intentionally do not
// populate this cache — they rely on the OS page cache to keep repeat
// reads cheap.
let _cachedCandidates: Uint8Array[] | undefined;

/**
 * Lazily yield discoverable system font candidates, in preference order.
 *
 * Each entry is the raw font file bytes of a `.ttf` or `.ttc` file.
 * The caller decides which candidate to use (e.g. by checking cmap coverage).
 *
 * Iterating one candidate at a time lets callers `break` as soon as
 * they find a match, avoiding the cost of recursively reading every
 * font in every system font directory just to discard them.
 */
export function* iterateSystemFontCandidates(): Generator<Uint8Array, void, void> {
  // Fast path: a previous call already produced the full snapshot.
  if (_cachedCandidates !== undefined) {
    for (const c of _cachedCandidates) {
      yield c;
    }
    return;
  }

  if (typeof process === "undefined" || !process.platform) {
    return;
  }

  const seen = new Set<string>(); // dedupe by path within this iteration
  const dirs = getSystemFontDirs();

  // Strategy 1: Check preferred font filenames (in order). These stat
  // calls are cheap and run regardless — they are the only path most
  // callers need to traverse.
  for (const fontName of PREFERRED_FONTS) {
    for (const dir of dirs) {
      const fontPath = `${dir}/${fontName}`;
      if (seen.has(fontPath)) {
        continue;
      }
      seen.add(fontPath);
      if (fileExistsSync(fontPath)) {
        const data = tryReadFont(fontPath);
        if (data) {
          yield data;
        }
      }
    }
  }

  // Strategy 2: Recursively scan each directory for any other .ttf/.ttc.
  // This is the expensive step (hundreds of MB on macOS / Windows), so
  // it walks one directory at a time and yields candidates as it goes —
  // a caller that found a match in Strategy 1 (or in an earlier
  // directory here) never reaches further directories.
  const broadRe =
    /noto|unicode|cjk|yahei|heiti|gothic|sans|serif|ming|song|dejavu|liberation|droid|wqy/i;

  for (const dir of dirs) {
    let entries: FileEntry[];
    try {
      entries = traverseDirectorySync(dir, { recursive: true, filter: e => !e.isDirectory });
    } catch {
      // Directory doesn't exist or not readable
      continue;
    }

    const fonts = entries.filter(
      e => /\.tt[cf]$/i.test(e.absolutePath) && !seen.has(e.absolutePath)
    );

    // Broad-coverage names first, then large files
    const broad = fonts.filter(e => broadRe.test(e.absolutePath));
    const rest = fonts.filter(e => !broadRe.test(e.absolutePath) && e.size > 50000);

    for (const entry of [...broad, ...rest]) {
      if (seen.has(entry.absolutePath)) {
        continue;
      }
      seen.add(entry.absolutePath);
      const data = tryReadFont(entry.absolutePath);
      if (data) {
        yield data;
      }
    }
  }
}

/**
 * Return all discoverable system font candidates, ordered by preference.
 *
 * Each entry is the raw font file bytes of a `.ttf` or `.ttc` file.
 * The caller decides which candidate to use (e.g. by checking cmap coverage).
 *
 * The full snapshot is cached: once produced, repeated calls return the
 * same array without touching the filesystem.
 *
 * Prefer {@link iterateSystemFontCandidates} when you only need the
 * first candidate that satisfies a predicate: it avoids reading every
 * font in every system directory just to discard them.
 */
export function discoverSystemFontCandidates(): Uint8Array[] {
  if (_cachedCandidates !== undefined) {
    return _cachedCandidates;
  }
  const all: Uint8Array[] = [];
  for (const candidate of iterateSystemFontCandidates()) {
    all.push(candidate);
  }
  _cachedCandidates = all;
  return all;
}

/**
 * Search for a system font suitable for Unicode rendering.
 *
 * Returns the raw font file bytes of the highest-priority candidate,
 * or `null` if no font was found.
 */
export function discoverSystemFont(): Uint8Array | null {
  const candidates = discoverSystemFontCandidates();
  return candidates.length > 0 ? candidates[0] : null;
}

/**
 * Find the highest-priority system font whose `cmap` covers **every** one of
 * `codePoints`, and return it parsed.
 *
 * This is the single selection rule used by every auto-embed path (the
 * spreadsheet exporter and `PdfDocumentBuilder.build()`), so they all agree
 * on which font a document ends up with. Candidates that fail to parse are
 * skipped; iteration stops at the first full-coverage match, so a hit among
 * the preferred filenames never triggers a recursive scan of every system
 * font directory.
 *
 * Returns `null` when `codePoints` is empty or no candidate covers them — the
 * caller then falls back to Type3 glyphs (and should warn, since uncovered
 * code points render as NOTDEF boxes).
 */
export function findSystemFontForCodePoints(codePoints: ReadonlySet<number>): TtfFont | null {
  if (codePoints.size === 0) {
    return null;
  }
  const wanted = [...codePoints];
  for (const candidate of iterateSystemFontCandidates()) {
    try {
      const ttf = parseTtf(candidate);
      if (wanted.every(cp => ttf.cmap.has(cp))) {
        return ttf;
      }
    } catch {
      // Parse failed — try the next system font candidate.
    }
  }
  return null;
}

/**
 * Reset the cached font discovery result (for testing).
 */
export function resetFontDiscoveryCache(): void {
  _cachedCandidates = undefined;
}

/**
 * Override the cached candidates with a custom list (for testing).
 * Call {@link resetFontDiscoveryCache} to clear the override.
 */
export function _setCandidatesForTest(candidates: Uint8Array[]): void {
  _cachedCandidates = candidates;
}

// =============================================================================
// Internal
// =============================================================================

function tryReadFont(fontPath: string): Uint8Array | null {
  try {
    return readFileBytesSync(fontPath);
  } catch {
    return null;
  }
}
