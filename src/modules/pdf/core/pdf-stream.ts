/**
 * PDF content stream builder.
 *
 * Provides a high-level API for constructing PDF content streams using
 * PDF graphics operators. Content streams control what is drawn on a page:
 * text, lines, rectangles, colors, etc.
 *
 * @see PDF Reference 1.7, Chapter 4 - Graphics
 * @see PDF Reference 1.7, Chapter 5 - Text
 */

import { pdfNumber } from "@pdf/core/pdf-object";
import type { PdfColor } from "@pdf/types";

// =============================================================================
// Content Stream Builder
// =============================================================================

/**
 * Builds a PDF content stream using graphics and text operators.
 *
 * PDF uses a postfix notation where operands precede the operator.
 * For example: `100 200 m` means "move to point (100, 200)".
 *
 * Color model: PDF uses separate color state for stroking (lines/borders)
 * and non-stroking (fills/text). We provide methods for both.
 */
export class PdfContentStream {
  /**
   * Content stream fragments in draw order. Most entries are plain operator
   * strings produced eagerly. A function entry is a *deferred* fragment:
   * its body is only evaluated at serialization time. This is required for
   * text whose final byte encoding depends on font decisions (embedded
   * CIDFont vs. Type1/WinAnsi vs. Type3 fallback) that are not finalised
   * until `PdfDocumentBuilder.build()`. Deferring keeps the fragment at its
   * exact draw-order position (preserving z-order) while letting the actual
   * encoding run after the font manager's state is settled.
   */
  private parts: Array<
    | string
    | {
        readonly produce: () => string;
        readonly preflight?: () => void;
      }
  > = [];

  // ===========================================================================
  // Raw Operator
  // ===========================================================================

  /**
   * Append a raw PDF operator string to the content stream.
   * Use this for operators not covered by the typed API (e.g. `d1` for Type3 glyphs).
   */
  raw(operator: string): this {
    this.parts.push(operator);
    return this;
  }

  /**
   * Append a deferred fragment whose body is evaluated only at serialization
   * time. Used by text drawing so the final byte encoding can be chosen after
   * the document's fonts are resolved at build time. The fragment occupies its
   * draw-order slot immediately, so z-order relative to other operators is
   * preserved.
   */
  deferred(produce: () => string, preflight?: () => void): this {
    this.parts.push({ produce, preflight });
    return this;
  }

  /** Run data-only preparation for every deferred fragment without rendering it. */
  preflight(): void {
    for (const part of this.parts) {
      if (typeof part !== "string") {
        part.preflight?.();
      }
    }
  }

  /**
   * Freeze the current draw-order fragments for one build. Later writes to this
   * stream are intentionally absent from the returned snapshot.
   */
  snapshot(): PdfContentStream {
    const copy = new PdfContentStream();
    copy.parts = [...this.parts];
    return copy;
  }

  /**
   * Append another content stream without serialising it. Deferred fragments
   * stay deferred, so text encoding can still resolve after fonts are frozen.
   */
  append(other: PdfContentStream): this {
    this.parts.push(...other.parts);
    return this;
  }

  // ===========================================================================
  // Graphics State
  // ===========================================================================

  /**
   * Save the current graphics state (push onto state stack).
   * Must be balanced with a corresponding restore().
   */
  save(): this {
    this.parts.push("q");
    return this;
  }

  /**
   * Restore the previously saved graphics state (pop from state stack).
   */
  restore(): this {
    this.parts.push("Q");
    return this;
  }

  // ===========================================================================
  // Color Operators
  // ===========================================================================

  /**
   * Set the current graphics state from an ExtGState resource.
   * Used for transparency (alpha), blend modes, etc.
   */
  setGraphicsState(name: string): this {
    this.parts.push(`/${name} gs`);
    return this;
  }

  /**
   * Set the stroking color (used for lines, borders).
   */
  setStrokeColor(color: PdfColor): this {
    this.parts.push(`${pdfNumber(color.r)} ${pdfNumber(color.g)} ${pdfNumber(color.b)} RG`);
    return this;
  }

  /**
   * Set the non-stroking color (used for fills, text).
   */
  setFillColor(color: PdfColor): this {
    this.parts.push(`${pdfNumber(color.r)} ${pdfNumber(color.g)} ${pdfNumber(color.b)} rg`);
    return this;
  }

  // ===========================================================================
  // Line Style
  // ===========================================================================

  /**
   * Set the line width for stroking operations.
   */
  setLineWidth(width: number): this {
    this.parts.push(`${pdfNumber(width)} w`);
    return this;
  }

  /**
   * Set the line dash pattern.
   * @param dashArray - Array of dash/gap lengths. Empty = solid line.
   * @param phase - Starting phase offset.
   */
  setDashPattern(dashArray: number[], phase = 0): this {
    const arr = dashArray.map(pdfNumber).join(" ");
    this.parts.push(`[${arr}] ${pdfNumber(phase)} d`);
    return this;
  }

  /**
   * Set the line cap style.
   * 0 = butt cap, 1 = round cap, 2 = projecting square cap
   */
  setLineCap(style: 0 | 1 | 2): this {
    this.parts.push(`${style} J`);
    return this;
  }

  /**
   * Set the line join style.
   * 0 = miter join, 1 = round join, 2 = bevel join
   */
  setLineJoin(style: 0 | 1 | 2): this {
    this.parts.push(`${style} j`);
    return this;
  }

  // ===========================================================================
  // Path Construction
  // ===========================================================================

  /**
   * Begin a new subpath by moving to the given point.
   */
  moveTo(x: number, y: number): this {
    this.parts.push(`${pdfNumber(x)} ${pdfNumber(y)} m`);
    return this;
  }

  /**
   * Append a straight line segment from the current point to (x, y).
   */
  lineTo(x: number, y: number): this {
    this.parts.push(`${pdfNumber(x)} ${pdfNumber(y)} l`);
    return this;
  }

  /**
   * Append a rectangle to the current path.
   * PDF convention: (x, y) is the lower-left corner.
   */
  rect(x: number, y: number, width: number, height: number): this {
    this.parts.push(`${pdfNumber(x)} ${pdfNumber(y)} ${pdfNumber(width)} ${pdfNumber(height)} re`);
    return this;
  }

  /**
   * Append a cubic Bezier curve to the current path.
   * From current point to (x3, y3), with control points (x1, y1) and (x2, y2).
   */
  curveTo(x1: number, y1: number, x2: number, y2: number, x3: number, y3: number): this {
    this.parts.push(
      `${pdfNumber(x1)} ${pdfNumber(y1)} ${pdfNumber(x2)} ${pdfNumber(y2)} ${pdfNumber(x3)} ${pdfNumber(y3)} c`
    );
    return this;
  }

  /**
   * Append a cubic Bezier curve where the first control point is the current point.
   * From current point to (x3, y3), with control points (current, y1) and (x2, y2).
   */
  curveToV(x2: number, y2: number, x3: number, y3: number): this {
    this.parts.push(`${pdfNumber(x2)} ${pdfNumber(y2)} ${pdfNumber(x3)} ${pdfNumber(y3)} v`);
    return this;
  }

  /**
   * Append a cubic Bezier curve where the second control point equals (x3, y3).
   * From current point to (x3, y3), with control point (x1, y1).
   */
  curveToY(x1: number, y1: number, x3: number, y3: number): this {
    this.parts.push(`${pdfNumber(x1)} ${pdfNumber(y1)} ${pdfNumber(x3)} ${pdfNumber(y3)} y`);
    return this;
  }

  // ===========================================================================
  // Path Painting
  // ===========================================================================

  /**
   * Stroke the current path.
   */
  stroke(): this {
    this.parts.push("S");
    return this;
  }

  /**
   * Fill the current path using the nonzero winding number rule.
   */
  fill(): this {
    this.parts.push("f");
    return this;
  }

  /**
   * Fill using the even-odd rule (`f*`) rather than the default nonzero (`f`).
   *
   * The two differ wherever a path's subpaths overlap: nonzero counts edge directions,
   * even-odd counts crossings. A compound path built by a producer that asked for
   * even-odd is a different shape under nonzero, so the operator has to follow.
   */
  fillEvenOdd(): this {
    this.parts.push("f*");
    return this;
  }

  /** Fill and stroke using the even-odd rule (`B*`). */
  fillEvenOddAndStroke(): this {
    this.parts.push("B*");
    return this;
  }

  /**
   * Fill and then stroke the current path.
   */
  fillAndStroke(): this {
    this.parts.push("B");
    return this;
  }

  /**
   * Close the current subpath by appending a line from current point to start.
   */
  closePath(): this {
    this.parts.push("h");
    return this;
  }

  /**
   * End the path without filling or stroking (used for clipping).
   */
  endPath(): this {
    this.parts.push("n");
    return this;
  }

  // ===========================================================================
  // Clipping
  // ===========================================================================

  /**
   * Set the current path as the clipping boundary (nonzero winding rule).
   * Must be followed by endPath() or a painting operator.
   */
  clip(): this {
    this.parts.push("W");
    return this;
  }

  // ===========================================================================
  // Text Objects
  // ===========================================================================

  /**
   * Begin a text object.
   */
  beginText(): this {
    this.parts.push("BT");
    return this;
  }

  /**
   * End the current text object.
   */
  endText(): this {
    this.parts.push("ET");
    return this;
  }

  /**
   * Set the font and size for subsequent text operations.
   * @param fontName - The font resource name (e.g., "F1")
   * @param size - Font size in points
   */
  setFont(fontName: string, size: number): this {
    this.parts.push(`/${fontName} ${pdfNumber(size)} Tf`);
    return this;
  }

  /**
   * Set the text matrix (position and transform for text).
   * For simple positioning, use Td instead.
   * @param a - Horizontal scaling
   * @param b - Vertical skew
   * @param c - Horizontal skew
   * @param d - Vertical scaling
   * @param e - Horizontal translation
   * @param f - Vertical translation
   */
  setTextMatrix(a: number, b: number, c: number, d: number, e: number, f: number): this {
    this.parts.push(
      `${pdfNumber(a)} ${pdfNumber(b)} ${pdfNumber(c)} ${pdfNumber(d)} ${pdfNumber(e)} ${pdfNumber(f)} Tm`
    );
    return this;
  }

  /**
   * Move to the start of the next line, offset from the start of the current line.
   */
  moveText(tx: number, ty: number): this {
    this.parts.push(`${pdfNumber(tx)} ${pdfNumber(ty)} Td`);
    return this;
  }

  /**
   * Set the text leading (line spacing) for T* operator.
   */
  setTextLeading(leading: number): this {
    this.parts.push(`${pdfNumber(leading)} TL`);
    return this;
  }

  /**
   * Show a text string. The string is escaped for PDF.
   */
  showText(text: string): this {
    // Check if text contains non-ASCII characters that need WinAnsi encoding
    if (hasNonAscii(text)) {
      return this.showTextWinAnsi(text);
    }
    this.parts.push(`(${escapeTextForPdf(text)}) Tj`);
    return this;
  }

  /**
   * Show a text string encoded as WinAnsi hex string.
   * Used for Type1 fonts where non-ASCII characters need single-byte encoding.
   */
  showTextWinAnsi(text: string): this {
    let hex = "<";
    for (let i = 0; i < text.length; i++) {
      const cp = text.codePointAt(i)!;
      if (cp > 0xffff) {
        i++;
      }
      const byte = unicodeToWinAnsi(cp);
      hex += byte.toString(16).padStart(2, "0");
    }
    hex += ">";
    this.parts.push(`${hex} Tj`);
    return this;
  }

  /**
   * Show a text string using a pre-encoded hex string (for CIDFonts).
   * The hexString should be in the format `<0012003A...>`.
   */
  showTextHex(hexString: string): this {
    this.parts.push(`${hexString} Tj`);
    return this;
  }

  /**
   * Move to the next line and show a text string.
   */
  nextLineShowText(text: string): this {
    if (hasNonAscii(text)) {
      let hex = "<";
      for (let i = 0; i < text.length; i++) {
        const cp = text.codePointAt(i)!;
        if (cp > 0xffff) {
          i++;
        }
        const byte = unicodeToWinAnsi(cp);
        hex += byte.toString(16).padStart(2, "0");
      }
      hex += ">";
      this.parts.push(`${hex} '`);
      return this;
    }
    this.parts.push(`(${escapeTextForPdf(text)}) '`);
    return this;
  }

  /**
   * Set the text rise (baseline offset), used for superscript/subscript.
   */
  setTextRise(rise: number): this {
    this.parts.push(`${pdfNumber(rise)} Ts`);
    return this;
  }

  /** Set PDF text rendering mode (`Tr`): fill, stroke, or fill-and-stroke. */
  setTextRenderingMode(mode: 0 | 1 | 2): this {
    this.parts.push(`${mode} Tr`);
    return this;
  }

  /**
   * Set character spacing (extra space between characters).
   */
  setCharacterSpacing(spacing: number): this {
    this.parts.push(`${pdfNumber(spacing)} Tc`);
    return this;
  }

  /**
   * Set word spacing (extra space for space character).
   */
  setWordSpacing(spacing: number): this {
    this.parts.push(`${pdfNumber(spacing)} Tw`);
    return this;
  }

  // ===========================================================================
  // XObject / Image Drawing
  // ===========================================================================

  /**
   * Draw an XObject (image) at the given position and size.
   * The image must be registered as a resource with the given name.
   */
  drawImage(name: string, x: number, y: number, width: number, height: number): this {
    return this.save().concat(width, 0, 0, height, x, y).doXObject(name).restore();
  }

  /**
   * Apply a transformation matrix (cm operator).
   */
  concat(a: number, b: number, c: number, d: number, e: number, f: number): this {
    this.parts.push(
      `${pdfNumber(a)} ${pdfNumber(b)} ${pdfNumber(c)} ${pdfNumber(d)} ${pdfNumber(e)} ${pdfNumber(f)} cm`
    );
    return this;
  }

  /**
   * Invoke a named XObject (Do operator).
   */
  doXObject(name: string): this {
    this.parts.push(`/${name} Do`);
    return this;
  }

  // ===========================================================================
  // Convenience Methods
  // ===========================================================================

  /**
   * Draw a filled rectangle.
   */
  fillRect(x: number, y: number, width: number, height: number, color: PdfColor): this {
    return this.save().setFillColor(color).rect(x, y, width, height).fill().restore();
  }

  /**
   * Draw a stroked line.
   */
  drawLine(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    color: PdfColor,
    lineWidth: number,
    dashPattern: number[] = []
  ): this {
    this.save().setStrokeColor(color).setLineWidth(lineWidth);
    if (dashPattern.length > 0) {
      this.setDashPattern(dashPattern);
    }
    return this.moveTo(x1, y1).lineTo(x2, y2).stroke().restore();
  }

  /**
   * Append an ellipse to the current path using 4 cubic Bezier curves.
   * (cx, cy) is the center; rx, ry are the radii.
   *
   * Uses the standard kappa = 4 * (sqrt(2) - 1) / 3 ≈ 0.5522847 approximation.
   */
  ellipse(cx: number, cy: number, rx: number, ry: number): this {
    const k = 0.5522847;
    const kx = k * rx;
    const ky = k * ry;

    this.moveTo(cx + rx, cy);
    this.curveTo(cx + rx, cy + ky, cx + kx, cy + ry, cx, cy + ry);
    this.curveTo(cx - kx, cy + ry, cx - rx, cy + ky, cx - rx, cy);
    this.curveTo(cx - rx, cy - ky, cx - kx, cy - ry, cx, cy - ry);
    this.curveTo(cx + kx, cy - ry, cx + rx, cy - ky, cx + rx, cy);
    return this;
  }

  /**
   * Append a circle to the current path.
   * (cx, cy) is the center; r is the radius.
   */
  circle(cx: number, cy: number, r: number): this {
    return this.ellipse(cx, cy, r, r);
  }

  /**
   * Append a rounded rectangle to the current path.
   * (x, y) is the lower-left corner; r is the corner radius.
   */
  roundedRect(x: number, y: number, width: number, height: number, r: number): this {
    const k = 0.5522847;
    const kr = k * r;

    this.moveTo(x + r, y);
    this.lineTo(x + width - r, y);
    this.curveTo(x + width - r + kr, y, x + width, y + r - kr, x + width, y + r);
    this.lineTo(x + width, y + height - r);
    this.curveTo(
      x + width,
      y + height - r + kr,
      x + width - r + kr,
      y + height,
      x + width - r,
      y + height
    );
    this.lineTo(x + r, y + height);
    this.curveTo(x + r - kr, y + height, x, y + height - r + kr, x, y + height - r);
    this.lineTo(x, y + r);
    this.curveTo(x, y + r - kr, x + r - kr, y, x + r, y);
    return this;
  }

  // ===========================================================================
  // Serialization
  // ===========================================================================

  /**
   * Whether any fragment has been appended. Unlike `toString().length > 0`,
   * this does NOT evaluate deferred fragments, so it is safe to call before
   * fonts are resolved (e.g. when probing for overlay content during an
   * editor save, prior to `writeFontResources`). A deferred text fragment
   * counts as content even though its bytes are not produced yet.
   */
  hasContent(): boolean {
    return this.parts.length > 0;
  }

  /**
   * Get the content stream as a string. Deferred fragments (see `deferred`)
   * are evaluated here, after font resolution has completed at build time.
   */
  toString(): string {
    const out: string[] = [];
    for (const part of this.parts) {
      out.push(typeof part === "string" ? part : part.produce());
    }
    return out.join("\n");
  }

  /**
   * Get the content stream as a Uint8Array (UTF-8 encoded).
   */
  toUint8Array(): Uint8Array {
    return new TextEncoder().encode(this.toString());
  }
}

// =============================================================================
// Internal Helpers
// =============================================================================

/**
 * Escape a text string for use inside a PDF text operator.
 * PDF text strings are delimited by parentheses.
 */
function escapeTextForPdf(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)")
    .replace(/\r\n/g, "\\n")
    .replace(/\r/g, "\\n")
    .replace(/\n/g, "\\n");
}

/**
 * Check if a string contains any non-ASCII characters (code point > 127).
 */
function hasNonAscii(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) {
      return true;
    }
  }
  return false;
}

// =============================================================================
// WinAnsi Encoding
// =============================================================================

/**
 * Map from Unicode code point to WinAnsi (Windows-1252) byte value.
 * Only the 0x80-0x9F range differs from Latin-1; everything else maps 1:1
 * for code points 0x00-0xFF.
 */
const UNICODE_TO_WINANSI = new Map<number, number>([
  [0x20ac, 0x80], // €
  [0x201a, 0x82], // ‚
  [0x0192, 0x83], // ƒ
  [0x201e, 0x84], // „
  [0x2026, 0x85], // …
  [0x2020, 0x86], // †
  [0x2021, 0x87], // ‡
  [0x02c6, 0x88], // ˆ
  [0x2030, 0x89], // ‰
  [0x0160, 0x8a], // Š
  [0x2039, 0x8b], // ‹
  [0x0152, 0x8c], // Œ
  [0x017d, 0x8e], // Ž
  [0x2018, 0x91], // '
  [0x2019, 0x92], // '
  [0x201c, 0x93], // "
  [0x201d, 0x94], // "
  [0x2022, 0x95], // •
  [0x2013, 0x96], // –
  [0x2014, 0x97], // —
  [0x02dc, 0x98], // ˜
  [0x2122, 0x99], // ™
  [0x0161, 0x9a], // š
  [0x203a, 0x9b], // ›
  [0x0153, 0x9c], // œ
  [0x017e, 0x9e], // ž
  [0x0178, 0x9f] // Ÿ
]);

/**
 * Convert a Unicode code point to a WinAnsi byte value.
 * Returns 0x20 (space) for unmappable characters — standard Type1 fonts
 * do not contain glyphs outside the WinAnsi repertoire, so a space is
 * less misleading than a literal '?'.
 */
function unicodeToWinAnsi(cp: number): number {
  // Direct mapping for Latin-1 range (0x00-0xFF), excluding 0x80-0x9F
  if (cp < 0x80) {
    return cp;
  }
  if (cp >= 0xa0 && cp <= 0xff) {
    return cp;
  }
  // Check the special WinAnsi mapping for 0x80-0x9F range
  const mapped = UNICODE_TO_WINANSI.get(cp);
  if (mapped !== undefined) {
    return mapped;
  }
  // Unmappable — use space instead of '?' to avoid misleading output.
  // Full Unicode support requires an embedded TrueType font (the `font`
  // option in PdfExportOptions).
  return 0x20;
}

/**
 * Check whether a single code point is representable in WinAnsi encoding.
 */
export function isWinAnsiCodePoint(cp: number): boolean {
  if (cp < 0x80) {
    return true;
  }
  if (cp >= 0xa0 && cp <= 0xff) {
    return true;
  }
  return UNICODE_TO_WINANSI.has(cp);
}

/**
 * Check whether a string contains characters outside the WinAnsi repertoire.
 * When true, standard Type1 fonts cannot render those characters and an
 * embedded TrueType font is required for correct output.
 */
export function hasNonWinAnsiChars(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const cp = text.codePointAt(i)!;
    if (cp > 0xffff) {
      i++;
    }
    if (!isWinAnsiCodePoint(cp)) {
      return true;
    }
  }
  return false;
}
