/**
 * DOCX Module - Document Comparison (Diff)
 *
 * Compares two DocxDocument models and returns a list of differences.
 * This is a text-level comparison — it compares paragraphs by their text content
 * and reports additions, deletions, and modifications.
 *
 * @example
 * ```ts
 * import { Diff } from "documonster/word";
 *
 * const changes = Diff.documents(oldDoc, newDoc);
 * console.log(changes.filter(c => c.type === "modified"));
 * ```
 */

import { extractParagraphText } from "@word/core/text-utils";
import { walkBlocks } from "@word/core/walker";
import type { DocxDocument, BodyContent } from "@word/types";

/** Type of change detected between two documents. */
export type DiffChangeType = "added" | "deleted" | "modified" | "unchanged";

/** A single diff entry representing a change between two documents. */
export interface DiffEntry {
  /** Type of change. */
  readonly type: DiffChangeType;
  /** Paragraph index in the old document (undefined for "added"). */
  readonly oldIndex?: number;
  /** Paragraph index in the new document (undefined for "deleted"). */
  readonly newIndex?: number;
  /** Text content from old document. */
  readonly oldText?: string;
  /** Text content from new document. */
  readonly newText?: string;
}

/** Summary statistics for a diff result. */
export interface DiffSummary {
  /** Total number of paragraphs compared. */
  readonly totalParagraphs: number;
  /** Number of unchanged paragraphs. */
  readonly unchanged: number;
  /** Number of added paragraphs. */
  readonly added: number;
  /** Number of deleted paragraphs. */
  readonly deleted: number;
  /** Number of modified paragraphs. */
  readonly modified: number;
}

/** Result of a document comparison. */
export interface DiffResult {
  /** Individual change entries. */
  readonly entries: readonly DiffEntry[];
  /** Summary statistics. */
  readonly summary: DiffSummary;
}

/**
 * Compare two DocxDocuments and return a diff of their text content.
 *
 * Uses the Myers diff algorithm (LCS-based) for optimal minimal edit sequence.
 *
 * @param oldDoc - The original document.
 * @param newDoc - The modified document.
 * @returns DiffResult with entries and summary.
 */
export function diffDocuments(oldDoc: DocxDocument, newDoc: DocxDocument): DiffResult {
  const oldTexts = extractParagraphTexts(oldDoc.body);
  const newTexts = extractParagraphTexts(newDoc.body);

  const entries = computeDiff(oldTexts, newTexts);

  let added = 0;
  let deleted = 0;
  let modified = 0;
  let unchanged = 0;
  for (const e of entries) {
    switch (e.type) {
      case "added":
        added++;
        break;
      case "deleted":
        deleted++;
        break;
      case "modified":
        modified++;
        break;
      case "unchanged":
        unchanged++;
        break;
    }
  }

  return {
    entries,
    summary: {
      totalParagraphs: Math.max(oldTexts.length, newTexts.length),
      unchanged,
      added,
      deleted,
      modified
    }
  };
}

/** Extract all paragraph texts from body content (flattens tables). */
function extractParagraphTexts(body: readonly BodyContent[]): string[] {
  const texts: string[] = [];
  walkBlocks(body, {
    enterParagraph(para) {
      texts.push(extractParagraphText(para));
      return "skip";
    }
  });
  return texts;
}

/**
 * Compute diff using LCS (Longest Common Subsequence) approach.
 * Produces an optimal edit sequence.
 *
 * Memory note: the LCS DP table is `(m+1) * (n+1)` cells, each a 32-bit
 * integer. We allocate it as a single `Uint32Array` so two 5000-paragraph
 * documents take ~100 MB instead of ~200 MB. We also reject pairs whose
 * product would exceed `MAX_LCS_CELLS` to avoid OOM-killing the host —
 * callers wanting to diff arbitrarily-large documents should pre-segment
 * by section.
 */
const MAX_LCS_CELLS = 32_000_000; // ~128 MB at 4 bytes/cell

function computeDiff(oldTexts: string[], newTexts: string[]): DiffEntry[] {
  const m = oldTexts.length;
  const n = newTexts.length;

  if ((m + 1) * (n + 1) > MAX_LCS_CELLS) {
    throw new Error(
      `diffDocuments: LCS table for ${m}x${n} paragraphs exceeds ` +
        `MAX_LCS_CELLS (${MAX_LCS_CELLS}). Diff was aborted to avoid ` +
        `excessive memory use; consider diffing sections individually.`
    );
  }

  // Single contiguous Uint32Array indexed as `i * (n+1) + j`. This keeps
  // memory at one allocation and lets the runtime use SIMD-friendly
  // contiguous reads in the hot loop below.
  const stride = n + 1;
  const dp = new Uint32Array((m + 1) * stride);
  for (let i = 1; i <= m; i++) {
    const rowBase = i * stride;
    const prevRowBase = (i - 1) * stride;
    for (let j = 1; j <= n; j++) {
      if (oldTexts[i - 1] === newTexts[j - 1]) {
        dp[rowBase + j] = dp[prevRowBase + (j - 1)] + 1;
      } else {
        const a = dp[prevRowBase + j];
        const b = dp[rowBase + (j - 1)];
        dp[rowBase + j] = a >= b ? a : b;
      }
    }
  }

  // Backtrack to produce diff entries
  const entries: DiffEntry[] = [];
  let i = m;
  let j = n;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldTexts[i - 1] === newTexts[j - 1]) {
      entries.push({
        type: "unchanged",
        oldIndex: i - 1,
        newIndex: j - 1,
        oldText: oldTexts[i - 1],
        newText: newTexts[j - 1]
      });
      i--;
      j--;
    } else if (i > 0 && (j === 0 || dp[(i - 1) * stride + j] >= dp[i * stride + (j - 1)])) {
      entries.push({
        type: "deleted",
        oldIndex: i - 1,
        oldText: oldTexts[i - 1]
      });
      i--;
    } else {
      entries.push({
        type: "added",
        newIndex: j - 1,
        newText: newTexts[j - 1]
      });
      j--;
    }
  }

  // Reverse since we built it backwards
  entries.reverse();

  return pairModifications(entries);
}

/**
 * Pair deletions with insertions that represent the *same* paragraph in a
 * modified form, based on text similarity.
 *
 * The LCS pass only matches paragraphs whose text is byte-identical, so when
 * every paragraph is lightly edited it produces all-deletions + all-insertions
 * with no "modified" at all. Within each contiguous change block (a run of
 * deletions/insertions bounded by unchanged entries), we greedily pair each
 * deletion with the most similar insertion whose similarity clears
 * {@link MODIFY_SIMILARITY_THRESHOLD}. Pairs become "modified"; anything left
 * unpaired stays a pure deletion or insertion. This yields, e.g., a recipe
 * whose steps were all tweaked → mostly "modified", with a removed step as a
 * pure deletion and a brand-new step as a pure insertion.
 */
function pairModifications(entries: DiffEntry[]): DiffEntry[] {
  const result: DiffEntry[] = [];
  let k = 0;
  while (k < entries.length) {
    const entry = entries[k];
    if (entry.type !== "deleted" && entry.type !== "added") {
      result.push(entry);
      k++;
      continue;
    }

    // Collect the maximal contiguous run of deleted/added entries.
    const dels: DiffEntry[] = [];
    const adds: DiffEntry[] = [];
    let j = k;
    while (j < entries.length && (entries[j].type === "deleted" || entries[j].type === "added")) {
      if (entries[j].type === "deleted") {
        dels.push(entries[j]);
      } else {
        adds.push(entries[j]);
      }
      j++;
    }

    result.push(...pairChangeBlock(dels, adds));
    k = j;
  }

  return result;
}

/**
 * Pair one change block's deletions and insertions by similarity. Greedy:
 * process deletions in order, each claiming the most similar still-unclaimed
 * insertion above the threshold. Emits entries in old-index / new-index order.
 */
function pairChangeBlock(dels: DiffEntry[], adds: DiffEntry[]): DiffEntry[] {
  const usedAdd = new Array<boolean>(adds.length).fill(false);
  const out: DiffEntry[] = [];
  const leftoverAdds: DiffEntry[] = [];

  for (const del of dels) {
    let bestIdx = -1;
    let bestScore = MODIFY_SIMILARITY_THRESHOLD;
    for (let a = 0; a < adds.length; a++) {
      if (usedAdd[a]) {
        continue;
      }
      const score = textSimilarity(del.oldText ?? "", adds[a].newText ?? "");
      if (score >= bestScore) {
        bestScore = score;
        bestIdx = a;
      }
    }
    if (bestIdx >= 0) {
      usedAdd[bestIdx] = true;
      out.push({
        type: "modified",
        oldIndex: del.oldIndex,
        newIndex: adds[bestIdx].newIndex,
        oldText: del.oldText,
        newText: adds[bestIdx].newText
      });
    } else {
      out.push(del); // pure deletion
    }
  }

  for (let a = 0; a < adds.length; a++) {
    if (!usedAdd[a]) {
      leftoverAdds.push(adds[a]); // pure insertion
    }
  }

  // Order the block by position: modifications and deletions (old order)
  // first, then the surviving pure insertions (new order). Both arrays are
  // already in their natural index order from the LCS walk.
  out.push(...leftoverAdds);
  return out;
}

/** Minimum similarity (0..1) for a delete+add to be treated as a modification. */
const MODIFY_SIMILARITY_THRESHOLD = 0.5;

/**
 * Similarity of two strings in [0, 1], combining word-set overlap (Jaccard)
 * with a shared-prefix bonus. Cheap and dependency-free — good enough to tell
 * "same paragraph, lightly edited" from "completely different paragraph".
 */
function textSimilarity(a: string, b: string): number {
  if (a === b) {
    return 1;
  }
  if (a.length === 0 || b.length === 0) {
    return 0;
  }
  const wordsA = a.toLowerCase().split(/\s+/).filter(Boolean);
  const wordsB = b.toLowerCase().split(/\s+/).filter(Boolean);
  if (wordsA.length === 0 || wordsB.length === 0) {
    return 0;
  }
  const setA = new Set(wordsA);
  const setB = new Set(wordsB);
  let intersection = 0;
  for (const w of setA) {
    if (setB.has(w)) {
      intersection++;
    }
  }
  const union = setA.size + setB.size - intersection;
  const jaccard = union === 0 ? 0 : intersection / union;

  // Shared-prefix bonus: paragraphs that begin the same ("Step 3: …") are very
  // likely the same item edited, even if many words changed.
  let prefix = 0;
  const max = Math.min(a.length, b.length);
  while (prefix < max && a[prefix] === b[prefix]) {
    prefix++;
  }
  const prefixRatio = prefix / Math.max(a.length, b.length);

  // Weight word overlap most, with shared prefix as a strong booster so
  // "Hello World" → "Hello Earth" (half the words, same prefix) reads as a
  // modification while unrelated text stays a delete+add.
  return Math.min(1, jaccard * 0.7 + prefixRatio * 0.5);
}
