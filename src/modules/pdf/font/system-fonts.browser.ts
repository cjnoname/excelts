/**
 * System font discovery — browser stub.
 *
 * There is no font directory to walk in a browser, so every function here is the
 * empty answer. The point is not the runtime behaviour — the Node module already
 * short-circuits on `typeof process === "undefined"` and returned the same
 * nothing — but the **bytes**. That module carries the curated filename tables and
 * the per-platform directory lists for macOS, Windows and Linux: 40 KB of
 * `/System/Library/Fonts/Supplemental`, `msyh.ttc`, `PingFang SC` and several
 * hundred more names that no browser can act on. A runtime guard cannot remove
 * them, because a bundler has to keep any string the module might reach; only a
 * separate module can. `scripts/link-platform-variants.ts` routes every import of the
 * sibling through `#platform/modules/pdf/font/system-fonts`, and the manifest's
 * `imports` map selects this file under the `browser` condition.
 *
 * A browser consumer therefore falls back exactly as it did before — Type1 for
 * WinAnsi text and Type3 for the rest, with `onWarning` reporting the code points
 * nothing covers — and the way to get real CJK glyphs in a browser is what it has
 * always been: `embedFont(bytes)` with a font you ship.
 *
 * @module
 */

import type { TtfFont } from "@pdf/font/ttf-parser";
import type { CjkLanguage } from "@utils/cjk";

/**
 * A face that could be embedded, kept structurally identical to the Node type so
 * the two module surfaces are interchangeable.
 */
export interface SystemFontCandidate {
  readonly data: Uint8Array;
  readonly collectionIndex: number;
  readonly preferred: boolean;
  readonly path?: string;
}

/**
 * Curated filenames, per language.
 *
 * Empty rather than absent: the shape is part of the surface, and a browser has no
 * filesystem for a filename to name.
 */
export const FONT_FILES_BY_LANGUAGE: Record<CjkLanguage, readonly string[]> = {
  "zh-Hans": [],
  "zh-Hant": [],
  ja: [],
  ko: []
};

/** Family preference order, per language. Empty in a browser — see above. */
export const FAMILIES_BY_LANGUAGE: Record<CjkLanguage, readonly string[]> = {
  "zh-Hans": [],
  "zh-Hant": [],
  ja: [],
  ko: []
};

export function preferredFontFiles(_language?: CjkLanguage): string[] {
  return [];
}

export const PREFERRED_FONTS: readonly string[] = [];

export function discoverSystemFontCandidates(): SystemFontCandidate[] {
  return [];
}

export function discoverSystemFont(): SystemFontCandidate | null {
  return null;
}

/**
 * Always `null`: no face can be discovered, so the caller keeps its Type1 + Type3
 * fallback. This is the only function the production code outside this module
 * calls.
 */
export function findSystemFontForCodePoints(
  _codePoints: ReadonlySet<number>,
  _preferredFamilies: readonly string[],
  _language?: CjkLanguage
): TtfFont | null {
  return null;
}

export function resetFontDiscoveryCache(): void {
  // No cache to clear.
}

export function _isReadBufferHeldForTest(): boolean {
  return false;
}

export function _setCandidatesForTest(
  _candidates: readonly (Uint8Array | SystemFontCandidate)[]
): void {
  // Injected candidates cannot be discovered in a browser, so this is a no-op —
  // and a browser test asserting a discovered face would be asserting a fiction.
}
