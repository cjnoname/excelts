/**
 * Markdown Table Formatter
 *
 * Formats data into well-formed Markdown table strings.
 *
 * Features:
 * - Auto column width calculation with padding
 * - Column alignment (left, center, right, none)
 * - Proper escaping of pipe characters and backslashes
 * - Compact mode (disable column-width alignment) for minimal output
 * - Configurable column definitions
 * - Multiline cell content (newlines converted to `<br>`)
 *
 * @example
 * ```ts
 * // Simple array data with headers
 * formatMarkdown(["Name", "Age"], [["Alice", "30"], ["Bob", "25"]]);
 * // | Name  | Age |
 * // | ----- | --- |
 * // | Alice | 30  |
 * // | Bob   | 25  |
 *
 * // With alignment
 * formatMarkdown(["Left", "Center", "Right"], data, {
 *   alignment: "left",
 *   columns: [
 *     { header: "Left", alignment: "left" },
 *     { header: "Center", alignment: "center" },
 *     { header: "Right", alignment: "right" }
 *   ]
 * });
 * ```
 */

import { ESCAPE_AND_NEWLINE, NEWLINE_IN_CELL } from "@markdown/constants";
import type { MarkdownAlignment, MarkdownFormatOptions } from "@markdown/types";
import { isFullWidthCodePoint } from "@utils/font-metrics";

// =============================================================================
// Unicode Display Width
// =============================================================================

/**
 * Calculate the display width of a string in a monospace terminal, which is what
 * makes a table's columns line up when its cells contain East Asian text or emoji.
 *
 * Width comes from {@link isFullWidthCodePoint} rather than a range list kept here.
 * The list this replaced was a near-copy of that table, and it was wrong in both
 * directions — measured, not assumed:
 *
 *   - Under by one: `⌚` `☔` `⭐` and the rest of the BMP emoji, plus the CJK
 *     compatibility squares such as `㏀`, all of which occupy two columns.
 *   - Over by one: it counted *every* surrogate pair as two columns, so
 *     `𝐀` (Mathematical Bold A) and `𐀀` (Linear B) were double-width when both are
 *     East Asian Width Narrow. Being a supplementary-plane character is not the same
 *     thing as being wide.
 *
 * Zero-width and combining code points stay here: those are a different question
 * (they advance nothing at all) and are not answered anywhere else.
 */
function displayWidth(str: string): number {
  let width = 0;
  // By code point, so a surrogate pair is one character and can be asked about
  // directly instead of assumed from its encoding.
  for (const char of str) {
    const code = char.codePointAt(0)!;

    // Zero-width characters
    if (
      code === 0x200b || // zero-width space
      code === 0x200c || // zero-width non-joiner
      code === 0x200d || // zero-width joiner
      code === 0xfeff // BOM / zero-width no-break space
    ) {
      continue;
    }

    // Combining marks (general categories Mn, Mc, Me)
    if (
      (code >= 0x0300 && code <= 0x036f) || // Combining Diacritical Marks
      (code >= 0x1ab0 && code <= 0x1aff) || // Combining Diacritical Marks Extended
      (code >= 0x1dc0 && code <= 0x1dff) || // Combining Diacritical Marks Supplement
      (code >= 0x20d0 && code <= 0x20ff) || // Combining Diacritical Marks for Symbols
      (code >= 0xfe20 && code <= 0xfe2f) // Combining Half Marks
    ) {
      continue;
    }

    width += isFullWidthCodePoint(code) ? 2 : 1;
  }
  return width;
}

// =============================================================================
// Internal Helpers
// =============================================================================

/**
 * Default value-to-string converter.
 */
function defaultStringify(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return "[object Object]";
    }
  }
  return String(value);
}

/**
 * Escape pipe characters, backslashes, and convert newlines to `<br>` in a single pass.
 * `|` → `\|`, `\` → `\\`, `\r\n`/`\r`/`\n` → `<br>`
 */
function escapeCell(value: string): string {
  return value.replace(ESCAPE_AND_NEWLINE, ch => (ch === "|" || ch === "\\" ? "\\" + ch : "<br>"));
}

/**
 * Convert literal newlines to `<br>` without escaping pipes/backslashes.
 */
function convertNewlines(value: string): string {
  if (value.indexOf("\n") !== -1 || value.indexOf("\r") !== -1) {
    return value.replace(NEWLINE_IN_CELL, "<br>");
  }
  return value;
}

/**
 * Build the separator cell for a column based on alignment and width.
 *
 * Examples (width=5):
 * - none:   `-----`
 * - left:   `:----`
 * - right:  `----:`
 * - center: `:---:`
 */
function buildSeparator(alignment: MarkdownAlignment, width: number): string {
  switch (alignment) {
    case "left":
      return ":" + "-".repeat(width - 1);
    case "right":
      return "-".repeat(width - 1) + ":";
    case "center":
      return ":" + "-".repeat(Math.max(width - 2, 1)) + ":";
    default: // "none"
      return "-".repeat(width);
  }
}

/**
 * Pad a cell value to the target display width with alignment.
 * Uses displayWidth() for proper CJK/emoji handling.
 */
function padCell(value: string, targetWidth: number, alignment: MarkdownAlignment): string {
  const len = displayWidth(value);
  if (len >= targetWidth) {
    return value;
  }

  const diff = targetWidth - len;

  switch (alignment) {
    case "right":
      return " ".repeat(diff) + value;
    case "center": {
      const left = Math.floor(diff / 2);
      const right = diff - left;
      return " ".repeat(left) + value + " ".repeat(right);
    }
    default: // "left" or "none"
      return value + " ".repeat(diff);
  }
}

/**
 * Resolve column configuration from options.
 */
function resolveColumns(
  headers: string[],
  options: MarkdownFormatOptions
): { displayHeaders: string[]; alignments: MarkdownAlignment[]; minWidths: number[] } {
  const columnCount = headers.length;
  const defaultAlignment: MarkdownAlignment = options.alignment ?? "left";
  const displayHeaders: string[] = new Array(columnCount);
  const alignments: MarkdownAlignment[] = new Array(columnCount);
  const minWidths: number[] = new Array(columnCount);

  if (options.columns && options.columns.length > 0) {
    for (let i = 0; i < columnCount; i++) {
      const col = i < options.columns.length ? options.columns[i] : undefined;
      if (typeof col === "string") {
        displayHeaders[i] = col;
        alignments[i] = defaultAlignment;
        minWidths[i] = 3;
      } else if (col) {
        displayHeaders[i] = col.header;
        alignments[i] = col.alignment ?? defaultAlignment;
        minWidths[i] = col.minWidth ?? 3;
      } else {
        displayHeaders[i] = headers[i] ?? "";
        alignments[i] = defaultAlignment;
        minWidths[i] = 3;
      }
    }
  } else {
    for (let i = 0; i < columnCount; i++) {
      displayHeaders[i] = headers[i] ?? "";
      alignments[i] = defaultAlignment;
      minWidths[i] = 3;
    }
  }

  return { displayHeaders, alignments, minWidths };
}

// =============================================================================
// Main Formatter
// =============================================================================

/**
 * Format data as a Markdown table string.
 *
 * @param headers - Column header strings
 * @param rows - Data rows (each row is an array of cell values)
 * @param options - Formatting options
 * @returns Formatted Markdown table string
 *
 * @example
 * ```ts
 * formatMarkdown(
 *   ["Name", "Age", "City"],
 *   [
 *     ["Alice", 30, "New York"],
 *     ["Bob", 25, "London"]
 *   ]
 * );
 * ```
 */
export function formatMarkdown(
  headers: string[],
  rows: unknown[][],
  options: MarkdownFormatOptions = {}
): string {
  const {
    padding = true,
    trailingNewline = true,
    escapeContent = true,
    stringify = defaultStringify
  } = options;

  const columnCount = headers.length;

  if (columnCount === 0) {
    return "";
  }

  // Resolve column configs
  const { displayHeaders, alignments, minWidths } = resolveColumns(headers, options);

  // Single-pass: convert all cell values to strings, apply escaping,
  // and compute column widths simultaneously.
  const headerStrings: string[] = new Array(columnCount);
  const widths: number[] = new Array(columnCount);

  // Initialize widths from headers
  for (let i = 0; i < columnCount; i++) {
    const h = escapeContent ? escapeCell(displayHeaders[i]) : convertNewlines(displayHeaders[i]);
    headerStrings[i] = h;
    widths[i] = padding ? Math.max(displayWidth(h), minWidths[i]) : Math.max(minWidths[i], 3);
  }

  // Convert rows and update widths in a single pass
  const rowStrings: string[][] = new Array(rows.length);
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    const cells: string[] = new Array(columnCount);
    for (let c = 0; c < columnCount; c++) {
      const raw = c < row.length ? stringify(row[c]) : "";
      const cell = escapeContent ? escapeCell(raw) : convertNewlines(raw);
      cells[c] = cell;
      if (padding) {
        const cellWidth = displayWidth(cell);
        if (cellWidth > widths[c]) {
          widths[c] = cellWidth;
        }
      }
    }
    rowStrings[r] = cells;
  }

  // Build the complete table output
  // Pre-calculate total line count: header + separator + data rows
  const totalLines = 2 + rowStrings.length;
  const lines: string[] = new Array(totalLines);

  // Header row
  const headerParts: string[] = new Array(columnCount);
  for (let c = 0; c < columnCount; c++) {
    headerParts[c] = padding
      ? " " + padCell(headerStrings[c], widths[c], alignments[c]) + " "
      : " " + headerStrings[c] + " ";
  }
  lines[0] = "|" + headerParts.join("|") + "|";

  // Separator row
  // In both modes, cell content has 1 space padding on each side (" value "),
  // so separator width must be widths[c] + 2 to match.
  const sepParts: string[] = new Array(columnCount);
  for (let c = 0; c < columnCount; c++) {
    sepParts[c] = buildSeparator(alignments[c], widths[c] + 2);
  }
  lines[1] = "|" + sepParts.join("|") + "|";

  // Data rows
  for (let r = 0; r < rowStrings.length; r++) {
    const rowParts: string[] = new Array(columnCount);
    for (let c = 0; c < columnCount; c++) {
      rowParts[c] = padding
        ? " " + padCell(rowStrings[r][c], widths[c], alignments[c]) + " "
        : " " + rowStrings[r][c] + " ";
    }
    lines[r + 2] = "|" + rowParts.join("|") + "|";
  }

  let result = lines.join("\n");
  if (trailingNewline) {
    result += "\n";
  }

  return result;
}
