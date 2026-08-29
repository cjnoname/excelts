/**
 * Text reconstruction from positioned text fragments.
 *
 * Assembles raw text fragments extracted from PDF content streams into
 * coherent, human-readable text with proper reading order, line breaks,
 * and paragraph detection.
 *
 * Challenges addressed:
 * - PDF text has no semantic structure (only "draw char at (x,y)")
 * - Text fragments may be out of order
 * - Word and line boundaries must be inferred from positions
 * - Columns and tables need proper handling
 * - Different fonts/sizes affect spacing thresholds
 * - Multi-column layouts need column detection
 * - RTL (Arabic, Hebrew) text needs right-to-left sorting
 * - Vertical CJK text needs column-based grouping
 *
 * @see PDF Reference 1.7, Chapter 5 - Text
 */

import type { TextFragment } from "@pdf/reader/content-interpreter";

// =============================================================================
// Public API
// =============================================================================

/**
 * Reconstruct readable text from positioned text fragments.
 *
 * @param fragments - Raw text fragments with positions from content stream
 * @returns Reconstructed text with proper line breaks and spacing
 */
export function reconstructText(fragments: TextFragment[]): string {
  if (fragments.length === 0) {
    return "";
  }

  // Separate vertical text from horizontal text
  const verticalFragments = fragments.filter(f => f.isVertical);
  const horizontalFragments = fragments.filter(f => !f.isVertical);

  const parts: string[] = [];

  // Process horizontal text (possibly multi-column)
  if (horizontalFragments.length > 0) {
    parts.push(reconstructHorizontalText(horizontalFragments));
  }

  // Process vertical text
  if (verticalFragments.length > 0) {
    parts.push(reconstructVerticalText(verticalFragments));
  }

  return parts.join("\n\n");
}

/**
 * Detailed text extraction result preserving position information.
 */
export interface TextLine {
  /** The text content of this line */
  text: string;
  /** Y position (PDF coordinate, origin = bottom-left) */
  y: number;
  /** X position of the start of the line */
  x: number;
  /** Font size of the first fragment */
  fontSize: number;
}

/**
 * Extract text as structured lines.
 */
export function reconstructTextLines(fragments: TextFragment[]): TextLine[] {
  if (fragments.length === 0) {
    return [];
  }

  // Separate vertical from horizontal
  const verticalFragments = fragments.filter(f => f.isVertical);
  const horizontalFragments = fragments.filter(f => !f.isVertical);

  const lines: TextLine[] = [];

  // Process horizontal text
  if (horizontalFragments.length > 0) {
    const columns = detectColumns(horizontalFragments);
    for (const column of columns) {
      const sorted = sortFragments(column);
      const grouped = groupIntoLines(sorted);
      for (const line of grouped) {
        lines.push({
          text: buildLineText(line),
          y: line[0].y,
          x: line[0].x,
          fontSize: line[0].fontSize
        });
      }
    }
  }

  // Process vertical text
  if (verticalFragments.length > 0) {
    const verticalLines = groupVerticalIntoColumns(verticalFragments);
    for (const col of verticalLines) {
      lines.push({
        text: buildVerticalColumnText(col),
        y: col[0].y,
        x: col[0].x,
        fontSize: col[0].fontSize
      });
    }
  }

  return lines;
}

// =============================================================================
// Horizontal Text Reconstruction (with multi-column detection)
// =============================================================================

/**
 * Reconstruct horizontal text, detecting multi-column layouts.
 */
function reconstructHorizontalText(fragments: TextFragment[]): string {
  const columns = detectColumns(fragments);

  if (columns.length <= 1) {
    // Single column — standard processing
    const sorted = sortFragments(fragments);
    const lines = groupIntoLines(sorted);
    return buildText(lines);
  }

  // Multi-column: process each column independently, join with double newlines
  const columnTexts: string[] = [];

  for (const column of columns) {
    const sorted = sortFragments(column);
    const lines = groupIntoLines(sorted);
    const text = buildText(lines);
    if (text.length > 0) {
      columnTexts.push(text);
    }
  }

  return columnTexts.join("\n\n");
}

// =============================================================================
// Multi-Column Detection
// =============================================================================

/**
 * Detect columns by clustering fragments by their X ranges.
 *
 * Builds a histogram of fragment X positions and looks for clear gaps
 * that divide the page into 2+ columns.
 *
 * Distinguishes true multi-column layouts (e.g. newspaper columns) from
 * tabular data by checking whether most Y-lines span across the gap.
 * In a table, the same Y-line has fragments on both sides of the gap;
 * in a true multi-column layout, each column has its own independent lines.
 *
 * @returns Array of fragment groups, one per detected column, sorted left-to-right
 */
function detectColumns(fragments: TextFragment[]): TextFragment[][] {
  if (fragments.length < 4) {
    // Too few fragments to reliably detect columns
    return [fragments];
  }

  // A column starts somewhere. Wrapped prose does not: every line of a paragraph
  // begins at the same left edge, and only the *last* line of each paragraph is
  // short. Grouping on midpoints alone read that short line as a left-hand column
  // and the full-width lines as a right-hand one, so a paragraph came back with its
  // closing line hoisted above its opening line — the text was all there, in the
  // wrong order.
  //
  // Requiring two distinct left edges is what a genuine multi-column layout always
  // has and wrapped prose never does. The table heuristic below cannot stand in for
  // it: that only inspects lines carrying two or more fragments, and single-column
  // prose has exactly one per line, so it had nothing to look at and abstained.
  const leftEdges = new Set(fragments.map(f => Math.round(f.x)));
  if (leftEdges.size < 2) {
    return [fragments];
  }

  // Collect the X midpoints for each fragment
  const xMidpoints: number[] = [];
  for (const f of fragments) {
    xMidpoints.push(f.x + f.width / 2);
  }

  // Sort midpoints
  const sorted = [...xMidpoints].sort((a, b) => a - b);

  // Find the median font size for gap threshold calculation
  const fontSizes = fragments.map(f => f.fontSize).sort((a, b) => a - b);
  const medianFontSize = fontSizes[Math.floor(fontSizes.length / 2)];

  // Minimum gap to consider as a column separator:
  // Must be significantly larger than a word space (at least 4x font size)
  const minColumnGap = medianFontSize * 4;

  // Find gaps between consecutive sorted midpoints
  const gaps: Array<{ start: number; end: number; size: number }> = [];
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i] - sorted[i - 1];
    if (gap > minColumnGap) {
      gaps.push({ start: sorted[i - 1], end: sorted[i], size: gap });
    }
  }

  if (gaps.length === 0) {
    return [fragments];
  }

  // Merge nearby gaps (within minColumnGap of each other)
  const mergedGaps: Array<{ start: number; end: number }> = [gaps[0]];
  for (let i = 1; i < gaps.length; i++) {
    const last = mergedGaps[mergedGaps.length - 1];
    if (gaps[i].start - last.end < minColumnGap) {
      last.end = gaps[i].end;
    } else {
      mergedGaps.push({ start: gaps[i].start, end: gaps[i].end });
    }
  }

  // Use the largest gap(s) as column dividers
  // Only keep gaps that are at least 50% of the largest gap
  const maxGapSize = Math.max(...mergedGaps.map(g => g.end - g.start));
  const significantGaps = mergedGaps.filter(g => g.end - g.start >= maxGapSize * 0.5);

  if (significantGaps.length === 0) {
    return [fragments];
  }

  // --------------------------------------------------------------------------
  // Table vs. multi-column heuristic:
  // Group fragments by Y-line. For each candidate gap, check how many Y-lines
  // have fragments on BOTH sides of the gap. If most do, this is tabular data
  // (same row spans multiple "columns"), not a true multi-column layout.
  // --------------------------------------------------------------------------
  const lineThreshold = medianFontSize * 0.3;
  const yLines: number[][] = []; // each entry: array of x-midpoints on that line
  const yValues: number[] = [];

  for (const f of fragments) {
    const mid = f.x + f.width / 2;
    let found = false;
    for (let li = 0; li < yValues.length; li++) {
      if (Math.abs(f.y - yValues[li]) <= lineThreshold) {
        yLines[li].push(mid);
        found = true;
        break;
      }
    }
    if (!found) {
      yValues.push(f.y);
      yLines.push([mid]);
    }
  }

  // For each significant gap, count how many Y-lines span both sides
  for (const gap of significantGaps) {
    const divider = (gap.start + gap.end) / 2;
    let spanning = 0;
    let total = 0;
    for (const line of yLines) {
      if (line.length < 2) {
        continue;
      }
      total++;
      const hasLeft = line.some(x => x < divider);
      const hasRight = line.some(x => x > divider);
      if (hasLeft && hasRight) {
        spanning++;
      }
    }
    // If more than 50% of multi-fragment lines span the gap, it's a table
    if (total > 0 && spanning / total > 0.5) {
      return [fragments]; // Not a true multi-column layout
    }
  }

  // Build column boundaries from the gaps
  const dividers = significantGaps.map(g => (g.start + g.end) / 2).sort((a, b) => a - b);

  // Assign fragments to columns
  const columnCount = dividers.length + 1;
  const columns: TextFragment[][] = Array.from({ length: columnCount }, () => []);

  for (const f of fragments) {
    const mid = f.x + f.width / 2;
    let colIndex = 0;
    for (let d = 0; d < dividers.length; d++) {
      if (mid > dividers[d]) {
        colIndex = d + 1;
      }
    }
    columns[colIndex].push(f);
  }

  // Filter out empty columns and return
  return columns.filter(c => c.length > 0);
}

// =============================================================================
// Fragment Sorting
// =============================================================================

/**
 * Sort fragments into reading order.
 * Primary sort: top-to-bottom (descending Y in PDF coords).
 * Secondary sort: left-to-right (ascending X) for LTR, right-to-left for RTL.
 */
function sortFragments(fragments: TextFragment[]): TextFragment[] {
  return [...fragments].sort((a, b) => {
    // Compare Y positions — higher Y = earlier in reading order (PDF coords)
    const dy = b.y - a.y;
    if (Math.abs(dy) > 1) {
      return dy;
    }
    // Same line — sort by X position
    return a.x - b.x;
  });
}

// =============================================================================
// Line Grouping
// =============================================================================

/**
 * Group fragments into lines based on their Y position.
 * Fragments within a threshold of each other's Y position are on the same line.
 */
function groupIntoLines(fragments: TextFragment[]): TextFragment[][] {
  if (fragments.length === 0) {
    return [];
  }

  const lines: TextFragment[][] = [];
  let currentLine: TextFragment[] = [fragments[0]];

  for (let i = 1; i < fragments.length; i++) {
    const fragment = fragments[i];
    const prevFragment = currentLine[0];

    // Calculate line threshold — use average font size as the baseline
    const avgFontSize = (prevFragment.fontSize + fragment.fontSize) / 2;
    const lineThreshold = Math.max(avgFontSize * 0.4, 2);

    // Check if this fragment is on the same line
    if (Math.abs(fragment.y - prevFragment.y) <= lineThreshold) {
      currentLine.push(fragment);
    } else {
      // New line
      lines.push(currentLine);
      currentLine = [fragment];
    }
  }

  if (currentLine.length > 0) {
    lines.push(currentLine);
  }

  // Sort fragments within each line
  for (const line of lines) {
    sortLineFragments(line);
  }

  return lines;
}

/**
 * Sort fragments within a line, respecting RTL text direction.
 *
 * If the majority of fragments in the line are RTL, sort right-to-left.
 * Otherwise sort left-to-right (standard LTR).
 *
 * Note: RTL fragments from the content stream should already be in visual order,
 * so we sort by position to preserve that visual order. RTL lines sort by
 * descending X (rightmost first), LTR lines sort by ascending X (leftmost first).
 */
function sortLineFragments(line: TextFragment[]): void {
  const rtlCount = line.filter(f => f.isRtl).length;
  const isRtlLine = rtlCount > line.length / 2;

  if (isRtlLine) {
    // RTL line: sort right-to-left (descending X)
    line.sort((a, b) => b.x - a.x);
  } else {
    // LTR line: sort left-to-right (ascending X)
    line.sort((a, b) => a.x - b.x);
  }
}

// =============================================================================
// Vertical Text Support
// =============================================================================

/**
 * Reconstruct vertical text (WMode=1, typically CJK).
 *
 * Vertical text flows top-to-bottom within columns, and columns go right-to-left.
 * Each vertical column is grouped by X position and output as a "line" of text.
 */
function reconstructVerticalText(fragments: TextFragment[]): string {
  const columns = groupVerticalIntoColumns(fragments);
  const result: string[] = [];

  for (const col of columns) {
    result.push(buildVerticalColumnText(col));
  }

  return result.join("\n");
}

/**
 * Group vertical text fragments by X position into columns.
 * Sorted by X descending (rightmost column first for CJK vertical text).
 */
function groupVerticalIntoColumns(fragments: TextFragment[]): TextFragment[][] {
  if (fragments.length === 0) {
    return [];
  }

  // Sort by X descending (rightmost first), then Y descending (top first in PDF coords)
  const sorted = [...fragments].sort((a, b) => {
    const dx = b.x - a.x;
    if (Math.abs(dx) > 1) {
      return dx;
    }
    return b.y - a.y;
  });

  const columns: TextFragment[][] = [];
  let currentCol: TextFragment[] = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const fragment = sorted[i];
    const prevFragment = currentCol[0];

    // Group by X position — use font size as threshold
    const avgFontSize = (prevFragment.fontSize + fragment.fontSize) / 2;
    const xThreshold = Math.max(avgFontSize * 0.6, 2);

    if (Math.abs(fragment.x - prevFragment.x) <= xThreshold) {
      currentCol.push(fragment);
    } else {
      columns.push(currentCol);
      currentCol = [fragment];
    }
  }

  if (currentCol.length > 0) {
    columns.push(currentCol);
  }

  // Within each column, sort by Y descending (top to bottom in PDF coords)
  for (const col of columns) {
    col.sort((a, b) => b.y - a.y);
  }

  return columns;
}

/**
 * Build text for a vertical column (fragments running top to bottom).
 */
function buildVerticalColumnText(fragments: TextFragment[]): string {
  return fragments.map(f => f.text).join("");
}

// =============================================================================
// Text Building
// =============================================================================

/**
 * Build final text from grouped lines.
 */
function buildText(lines: TextFragment[][]): string {
  const result: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    result.push(buildLineText(lines[i]));

    // Detect paragraph breaks (extra vertical spacing between lines)
    if (i + 1 < lines.length) {
      const currentLine = lines[i];
      const nextLine = lines[i + 1];
      const lineGap = currentLine[0].y - nextLine[0].y;
      const avgFontSize = (currentLine[0].fontSize + nextLine[0].fontSize) / 2;

      // If gap is significantly larger than normal line height, add extra newline
      if (lineGap > avgFontSize * 1.8) {
        result.push("");
      }
    }
  }

  return result.join("\n");
}

/**
 * Build text for a single line from fragments.
 * Inserts spaces between fragments that have gaps.
 */
function buildLineText(fragments: TextFragment[]): string {
  if (fragments.length === 0) {
    return "";
  }

  let text = fragments[0].text;

  for (let i = 1; i < fragments.length; i++) {
    const prev = fragments[i - 1];
    const curr = fragments[i];

    // Calculate expected position after previous fragment
    const expectedX = prev.x + prev.width;
    const gap = curr.x - expectedX;

    // Raw distance between fragment start positions — independent of width estimate.
    // This is reliable even when font widths are slightly off.
    const rawGap = curr.x - prev.x;

    // Determine space threshold
    const avgFontSize = (prev.fontSize + curr.fontSize) / 2;
    const spaceThreshold = avgFontSize * 0.15; // ~15% of font size
    const tabThreshold = avgFontSize * 2; // Large gap = tab/column

    // Tab: either the width-based gap is large, or the raw x-distance between
    // fragment starts is much larger than expected for adjacent characters.
    // The raw check uses the previous fragment's text length as a proxy for
    // expected width, avoiding dependence on potentially inaccurate font widths.
    const expectedCharWidth = avgFontSize * 0.5; // approximate avg char width
    const expectedTextWidth = prev.text.length * expectedCharWidth;
    const rawExcess = rawGap - expectedTextWidth;

    if (gap > tabThreshold || rawExcess > tabThreshold) {
      text += "\t";
    } else if (gap > spaceThreshold || rawExcess > spaceThreshold) {
      text += " ";
    } else if (gap < -spaceThreshold && rawGap > 0) {
      // Width overestimate: fragments don't actually overlap in raw X space
      // but the calculated gap is negative. Insert a space if the raw distance
      // suggests they are separate fragments.
      if (rawGap > avgFontSize * 0.5) {
        text += " ";
      }
      text += curr.text;
      continue;
    } else if (gap < -spaceThreshold) {
      // Truly overlapping text — might be overprint or correction
      // Only add if the text is different
      if (!text.endsWith(curr.text.charAt(0))) {
        text += curr.text;
        continue;
      }
    }

    text += curr.text;
  }

  return text;
}
