/**
 * Format-based Search for DOCX Documents
 *
 * Provides the ability to search for text runs that match specific formatting
 * criteria (bold, italic, font, color, style, etc.) and optionally match text patterns.
 *
 * @stability experimental
 *
 * @example
 * ```ts
 * import { Query, type FormatCriteria } from "documonster/word";
 *
 * // Find all bold red text
 * const results = Query.searchByFormat(doc, { bold: true, color: "FF0000" });
 *
 * // Find all text in "Heading1" style
 * const headings = Query.searchByFormat(doc, { paragraphStyle: "Heading1" });
 *
 * // Find specific text with specific formatting
 * const todos = Query.searchByFormat(doc, { bold: true, textMatch: /TODO/i });
 * ```
 */

import { extractRunText } from "@word/core/text-utils";
import { walkDocument } from "@word/core/walker";
import type { DocxVisitor, WalkPath } from "@word/core/walker";
import type { DocxDocument, Hyperlink, Paragraph, Run, RunProperties } from "@word/types";

// =============================================================================
// Public API
// =============================================================================

/** Criteria for matching text formatting. All fields are optional — they act as AND filters. */
export interface FormatCriteria {
  /** Match bold text. */
  readonly bold?: boolean;
  /** Match italic text. */
  readonly italic?: boolean;
  /** Match underlined text (any style). */
  readonly underline?: boolean;
  /** Match strikethrough text. */
  readonly strike?: boolean;
  /** Match text with this font (case-insensitive). */
  readonly font?: string;
  /** Match text with this font size in half-points. */
  readonly size?: number;
  /** Match text with this color (hex, case-insensitive, without '#'). */
  readonly color?: string;
  /** Match text with this highlight color. */
  readonly highlight?: string;
  /** Match text with superscript. */
  readonly superscript?: boolean;
  /** Match text with subscript. */
  readonly subscript?: boolean;
  /** Match text with all-caps. */
  readonly caps?: boolean;
  /** Match text with small-caps. */
  readonly smallCaps?: boolean;
  /** Match text with hidden attribute. */
  readonly hidden?: boolean;
  /** Match runs whose paragraph has this style name/id. */
  readonly paragraphStyle?: string;
  /** Match runs with this character style name/id. */
  readonly characterStyle?: string;
  /** Optional text pattern (string or regex) to additionally filter by content. */
  readonly textMatch?: string | RegExp;
}

/** A single format search result. */
export interface FormatSearchResult {
  /** Index in the document body (for BodyContent). */
  readonly bodyIndex: number;
  /** Paragraph index within the body content (for tables, the cell paragraph). */
  readonly paragraphIndex: number;
  /** Index of the matching run within the paragraph's children. */
  readonly runIndex: number;
  /** The matched text. */
  readonly text: string;
  /** The run's properties (formatting). */
  readonly properties: RunProperties | undefined;
  /** The paragraph style (if any). */
  readonly paragraphStyle: string | undefined;
  /** Location context for display. */
  readonly location: "body" | "header" | "footer" | "footnote" | "endnote";
}

/**
 * Search a document for text runs matching specific formatting criteria.
 *
 * @param doc - The document to search.
 * @param criteria - Formatting criteria (all specified fields must match).
 * @returns Array of matching results.
 */
export function searchByFormat(doc: DocxDocument, criteria: FormatCriteria): FormatSearchResult[] {
  const results: FormatSearchResult[] = [];
  let currentBodyIndex = 0;
  let currentParaIndex = 0;
  let currentParagraph: Paragraph | null = null;
  let currentLocation: FormatSearchResult["location"] = "body";
  let tableDepth = 0;

  const visitor: DocxVisitor = {
    enterTable(_table, path: WalkPath) {
      if (tableDepth === 0) {
        currentBodyIndex = path.index;
      }
      tableDepth++;
      currentParaIndex = 0;
      return "continue";
    },
    leaveTable() {
      tableDepth--;
    },
    enterParagraph(para: Paragraph, path: WalkPath) {
      currentParagraph = para;
      if (tableDepth === 0) {
        currentBodyIndex = path.index;
        currentParaIndex = 0;
      }
      if (path.inHeader) {
        currentLocation = "header";
      } else if (path.inFooter) {
        currentLocation = "footer";
      } else if (path.inFootnote) {
        currentLocation = "footnote";
      } else if (path.inEndnote) {
        currentLocation = "endnote";
      } else {
        currentLocation = "body";
      }

      // If criteria specifies paragraphStyle, check it first
      const paraStyle = para.properties?.style;
      if (criteria.paragraphStyle && paraStyle !== criteria.paragraphStyle) {
        return "skip";
      }
      return "continue";
    },
    leaveParagraph() {
      if (tableDepth > 0) {
        currentParaIndex++;
      }
    },
    enterRun(run: Run, path: WalkPath) {
      if (matchesFormat(run, criteria)) {
        const text = extractRunText(run);
        if (matchesTextPattern(text, criteria.textMatch)) {
          results.push({
            bodyIndex: currentBodyIndex,
            paragraphIndex: currentParaIndex,
            runIndex: path.index,
            text,
            properties: run.properties,
            paragraphStyle: currentParagraph?.properties?.style,
            location: currentLocation
          });
        }
      }
      return "skip";
    },
    enterHyperlink(hyperlink: Hyperlink, path: WalkPath) {
      // Search child runs of hyperlink
      for (let li = 0; li < hyperlink.children.length; li++) {
        const run = hyperlink.children[li];
        if (matchesFormat(run, criteria)) {
          const text = extractRunText(run);
          if (matchesTextPattern(text, criteria.textMatch)) {
            results.push({
              bodyIndex: currentBodyIndex,
              paragraphIndex: currentParaIndex,
              runIndex: path.index,
              text,
              properties: run.properties,
              paragraphStyle: currentParagraph?.properties?.style,
              location: currentLocation
            });
          }
        }
      }
      return "skip";
    }
  };

  walkDocument(doc, visitor, {
    includeHeaders: true,
    includeFooters: true,
    includeFootnotes: true,
    includeEndnotes: true,
    includeComments: false
  });

  return results;
}

/**
 * Count the number of runs matching specific formatting criteria.
 *
 * @param doc - The document to search.
 * @param criteria - Formatting criteria.
 * @returns The count of matching runs.
 */
export function countByFormat(doc: DocxDocument, criteria: FormatCriteria): number {
  return searchByFormat(doc, criteria).length;
}

/**
 * Get all unique formatting styles used in the document.
 * Useful for understanding what formats exist before searching.
 *
 * @param doc - The document to analyze.
 * @returns Array of unique RunProperties objects found.
 */
export function getUsedFormats(doc: DocxDocument): RunProperties[] {
  const formatSet = new Map<string, RunProperties>();

  const visitor: DocxVisitor = {
    enterRun(run: Run) {
      if (run.properties) {
        const key = formatKey(run.properties);
        if (!formatSet.has(key)) {
          formatSet.set(key, run.properties);
        }
      }
      return "skip";
    },
    enterHyperlink(hyperlink: Hyperlink) {
      for (const run of hyperlink.children) {
        if (run.properties) {
          const key = formatKey(run.properties);
          if (!formatSet.has(key)) {
            formatSet.set(key, run.properties);
          }
        }
      }
      return "skip";
    }
  };

  walkDocument(doc, visitor, {
    includeHeaders: false,
    includeFooters: false,
    includeFootnotes: false,
    includeEndnotes: false,
    includeComments: false
  });

  return Array.from(formatSet.values());
}

// =============================================================================
// Internal Implementation
// =============================================================================

function matchesFormat(run: Run, criteria: FormatCriteria): boolean {
  const props = run.properties;

  // Character style check
  if (criteria.characterStyle) {
    if (props?.style !== criteria.characterStyle) {
      return false;
    }
  }

  // Bold
  if (criteria.bold !== undefined) {
    if ((props?.bold ?? false) !== criteria.bold) {
      return false;
    }
  }

  // Italic
  if (criteria.italic !== undefined) {
    if ((props?.italic ?? false) !== criteria.italic) {
      return false;
    }
  }

  // Underline. Word emits an explicit `"none"` underline style when the
  // user clears underlining on a run (rather than removing the property
  // entirely), so treat that the same as "no underline".
  if (criteria.underline !== undefined) {
    const u = props?.underline;
    const hasUnderline = u !== undefined && u !== false && u !== "none";
    if (hasUnderline !== criteria.underline) {
      return false;
    }
  }

  // Strikethrough
  if (criteria.strike !== undefined) {
    if ((props?.strike ?? false) !== criteria.strike) {
      return false;
    }
  }

  // Font
  if (criteria.font) {
    const runFont = getRunFontString(props);
    if (!runFont || runFont.toLowerCase() !== criteria.font.toLowerCase()) {
      return false;
    }
  }

  // Size
  if (criteria.size !== undefined) {
    if (props?.size !== criteria.size) {
      return false;
    }
  }

  // Color
  if (criteria.color) {
    const runColor = getRunColor(props);
    if (!runColor || runColor.toLowerCase() !== criteria.color.toLowerCase()) {
      return false;
    }
  }

  // Highlight
  if (criteria.highlight) {
    if (props?.highlight !== criteria.highlight) {
      return false;
    }
  }

  // Superscript
  if (criteria.superscript !== undefined) {
    const isSuperscript = props?.vertAlign === "superscript";
    if (isSuperscript !== criteria.superscript) {
      return false;
    }
  }

  // Subscript
  if (criteria.subscript !== undefined) {
    const isSubscript = props?.vertAlign === "subscript";
    if (isSubscript !== criteria.subscript) {
      return false;
    }
  }

  // Caps
  if (criteria.caps !== undefined) {
    if ((props?.caps ?? false) !== criteria.caps) {
      return false;
    }
  }

  // Small caps
  if (criteria.smallCaps !== undefined) {
    if ((props?.smallCaps ?? false) !== criteria.smallCaps) {
      return false;
    }
  }

  // Hidden
  if (criteria.hidden !== undefined) {
    if ((props?.vanish ?? false) !== criteria.hidden) {
      return false;
    }
  }

  return true;
}

function matchesTextPattern(text: string, pattern: string | RegExp | undefined): boolean {
  if (!pattern) {
    return true;
  }
  if (typeof pattern === "string") {
    return text.includes(pattern);
  }
  // RegExp.test() advances `lastIndex` for /g and /y flags. Mutating the
  // caller's regex would surprise code that re-uses the same instance
  // afterwards, so we test against a fresh clone instead. The clone is
  // cheap (V8 caches the parsed source) and sidesteps the global-state
  // hazard entirely.
  const cloned = new RegExp(pattern.source, pattern.flags);
  return cloned.test(text);
}

function getRunFontString(props: RunProperties | undefined): string | undefined {
  if (!props?.font) {
    return undefined;
  }
  if (typeof props.font === "string") {
    return props.font;
  }
  return props.font.ascii ?? props.font.hAnsi;
}

function getRunColor(props: RunProperties | undefined): string | undefined {
  if (!props?.color) {
    return undefined;
  }
  if (typeof props.color === "string") {
    return props.color;
  }
  return props.color.val;
}

function formatKey(props: RunProperties): string {
  return JSON.stringify({
    bold: props.bold,
    italic: props.italic,
    underline: props.underline ? true : undefined,
    strike: props.strike,
    font: typeof props.font === "string" ? props.font : props.font?.ascii,
    size: props.size,
    color: typeof props.color === "string" ? props.color : (props.color as { val?: string })?.val,
    highlight: props.highlight,
    vertAlign: props.vertAlign,
    caps: props.caps,
    smallCaps: props.smallCaps,
    style: props.style
  });
}
