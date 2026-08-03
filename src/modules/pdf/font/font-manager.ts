/**
 * Font manager for PDF generation.
 *
 * Manages three kinds of fonts:
 * 1. **Standard Type1 fonts** (Helvetica, Times, Courier) — always available,
 *    used for Latin text (WinAnsi repertoire) when no embedded font is provided.
 * 2. **Embedded TrueType fonts** — user-provided .ttf files for full
 *    Unicode support (CJK, Arabic, Hindi, etc.)
 * 3. **Type3 fallback fonts** — auto-generated vector-drawn glyphs for
 *    Unicode characters outside WinAnsi when no embedded font is provided.
 *
 * When an embedded font is registered, ALL text uses the embedded font.
 * When no embedded font is provided, the system uses Type1 for WinAnsi
 * characters and Type3 for everything else.
 *
 * The manager tracks which Unicode code points are used so the font embedder
 * and Type3 builder can create minimal subsets when writing the PDF.
 */

import { PdfDict, pdfName, pdfRef } from "@pdf/core/pdf-object";
import { hasNonWinAnsiChars, isWinAnsiCodePoint } from "@pdf/core/pdf-stream";
import type { PdfWriter } from "@pdf/core/pdf-writer";
import { PdfFontError } from "@pdf/errors";
import type { EmbeddedFont } from "@pdf/font/font-embedder";
import { embedTtfFont } from "@pdf/font/font-embedder";
import {
  measureText as measureType1Text,
  getFontAscent as getType1Ascent,
  getFontDescent as getType1Descent,
  getLineHeight as getType1LineHeight
} from "@pdf/font/metrics";
import type { TtfFont } from "@pdf/font/ttf-parser";
import type { Type3FontResult } from "@pdf/font/type3-font";

// =============================================================================
// Font Name Mapping (Type1 fallback)
// =============================================================================

const FONT_FAMILY_MAP: Record<string, string> = {
  helvetica: "Helvetica",
  arial: "Helvetica",
  calibri: "Helvetica",
  "segoe ui": "Helvetica",
  "trebuchet ms": "Helvetica",
  verdana: "Helvetica",
  tahoma: "Helvetica",
  "gill sans": "Helvetica",
  "franklin gothic": "Helvetica",
  "lucida sans": "Helvetica",
  aptos: "Helvetica",
  "times new roman": "Times",
  times: "Times",
  georgia: "Times",
  garamond: "Times",
  "book antiqua": "Times",
  palatino: "Times",
  "palatino linotype": "Times",
  cambria: "Times",
  "century schoolbook": "Times",
  "courier new": "Courier",
  courier: "Courier",
  consolas: "Courier",
  "lucida console": "Courier",
  monaco: "Courier",
  "andale mono": "Courier",
  "cascadia code": "Courier",
  "cascadia mono": "Courier",
  menlo: "Courier"
};

function resolveBaseFont(fontFamily: string): string {
  const lower = fontFamily.toLowerCase().trim();
  return FONT_FAMILY_MAP[lower] ?? "Helvetica";
}

/**
 * Get the full PDF standard font name with style variant.
 */
export function resolvePdfFontName(fontFamily: string, bold: boolean, italic: boolean): string {
  const base = resolveBaseFont(fontFamily);

  if (base === "Helvetica") {
    if (bold && italic) {
      return "Helvetica-BoldOblique";
    }
    if (bold) {
      return "Helvetica-Bold";
    }
    if (italic) {
      return "Helvetica-Oblique";
    }
    return "Helvetica";
  }

  if (base === "Times") {
    if (bold && italic) {
      return "Times-BoldItalic";
    }
    if (bold) {
      return "Times-Bold";
    }
    if (italic) {
      return "Times-Italic";
    }
    return "Times-Roman";
  }

  if (base === "Courier") {
    if (bold && italic) {
      return "Courier-BoldOblique";
    }
    if (bold) {
      return "Courier-Bold";
    }
    if (italic) {
      return "Courier-Oblique";
    }
    return "Courier";
  }

  return "Helvetica";
}

// =============================================================================
// Font Manager
// =============================================================================

/**
 * Manages PDF font resources for a document.
 * Supports standard Type1 fonts, embedded TrueType fonts, and auto-generated
 * Type3 fallback fonts for non-WinAnsi Unicode characters.
 */
export class FontManager {
  // --- Standard Type1 font tracking ---
  private type1Map = new Map<string, string>(); // pdfFontName → resourceName
  private resourceToType1 = new Map<string, string>(); // resourceName → pdfFontName
  private nextType1Id = 1;

  // --- Embedded TrueType font tracking ---
  private embeddedFont: TtfFont | null = null;
  private embeddedResourceName = "";
  private usedCodePoints = new Set<number>();
  private nextEmbeddedId = 1;

  // --- Type3 fallback font tracking ---
  private type3CodePoints = new Set<number>();
  private _type3Result: Type3FontResult | null = null;

  // --- Diagnostic tracking (consumed by writers that surface warnings) ---
  /**
   * Every distinct unknown font family passed to `resolveFont` since this
   * manager was constructed. A "family" counts as unknown when it isn't
   * in `FONT_FAMILY_MAP` and isn't the canonical "helvetica"/"times"/
   * "courier" identifier. Populated as a set so a document that repeats
   * the same missing family across hundreds of text runs still produces
   * a single diagnostic.
   */
  private _unknownFontFamilies = new Set<string>();

  // ==========================================================================
  // Embedded Font Registration
  // ==========================================================================

  /**
   * Register an embedded TrueType font for use.
   * When set, all text rendering uses this font instead of standard fonts.
   */
  registerEmbeddedFont(font: TtfFont): string {
    this.embeddedFont = font;
    this.embeddedResourceName = `EF${this.nextEmbeddedId++}`;
    return this.embeddedResourceName;
  }

  /**
   * Check if an embedded font is available.
   */
  hasEmbeddedFont(): boolean {
    return this.embeddedFont !== null;
  }

  /**
   * Read-only view of the non-WinAnsi code points encountered so far when
   * no font is embedded. Used by callers (`PdfDocumentBuilder.build()`)
   * to decide whether to auto-discover a system font before the Type3
   * fallback kicks in. Returns a defensive copy so consumers cannot
   * mutate the internal set.
   */
  getType3CodePoints(): Set<number> {
    return new Set(this.type3CodePoints);
  }

  /**
   * Read-only view of the font families `resolveFont` saw but could not
   * map to a standard Type1 (Helvetica/Times/Courier) base. Consumers
   * use this to emit one diagnostic per distinct missing family at
   * build time rather than one per text run. The set is deduplicated
   * and preserves the exact casing the caller supplied.
   */
  getUnknownFontFamilies(): Set<string> {
    return new Set(this._unknownFontFamilies);
  }

  /**
   * Get the embedded font's resource name (if registered).
   */
  getEmbeddedResourceName(): string {
    return this.embeddedResourceName;
  }

  /**
   * Resolve the resource name a draw-time-resolved Type1 resource should
   * actually render (and be measured) with, given the font manager's
   * *current* state. If an embedded font exists (possibly auto-discovered
   * at build time, after the text was drawn against a Type1 resource), the
   * embedded resource name is returned so both measurement and encoding go
   * through the CIDFont. Otherwise the original Type1 resource name is kept;
   * `measureText` handles Type3-fallback widths internally from that name.
   *
   * Centralises the routing rule shared by the deferred text renderer and
   * any deferred measurement (anchor alignment, word wrapping) so the two
   * never disagree.
   */
  resolveRenderResourceName(type1ResourceName: string): string {
    return this.embeddedFont ? this.embeddedResourceName : type1ResourceName;
  }

  /**
   * Record that a text string will be rendered, tracking its code points.
   * Must be called for every text string before writing the PDF.
   *
   * Two sets are maintained because font selection may be decided *after*
   * drawing (e.g. `PdfDocumentBuilder.build()` auto-discovers and embeds a
   * system font once it sees the accumulated non-WinAnsi code points):
   *
   *   - `usedCodePoints` — every code point seen, always. If an embedded
   *     font ends up being used (whether registered up front or
   *     auto-discovered at build time), the subset must cover all of these,
   *     including plain ASCII, so the CIDFont can encode the full run.
   *   - `type3CodePoints` — non-WinAnsi code points only. Drives the
   *     build-time decision to auto-embed a system font, and the Type3
   *     fallback when none is available.
   */
  trackText(text: string): void {
    for (let i = 0; i < text.length; i++) {
      const cp = text.codePointAt(i)!;
      if (cp > 0xffff) {
        i++; // skip low surrogate
      }
      this.usedCodePoints.add(cp);
      if (!isWinAnsiCodePoint(cp)) {
        this.type3CodePoints.add(cp);
      }
    }
  }

  // ==========================================================================
  // Standard Type1 Font Management
  // ==========================================================================

  /**
   * Ensure a standard Type1 font is registered and return its resource name.
   */
  ensureFont(pdfFontName: string): string {
    let resourceName = this.type1Map.get(pdfFontName);
    if (!resourceName) {
      resourceName = `F${this.nextType1Id++}`;
      this.type1Map.set(pdfFontName, resourceName);
      this.resourceToType1.set(resourceName, pdfFontName);
    }
    return resourceName;
  }

  /**
   * Resolve an Excel font specification to a resource name.
   * If an embedded font is registered, returns the embedded font's resource name.
   * Otherwise, falls back to standard Type1 fonts.
   */
  resolveFont(fontFamily: string, bold: boolean, italic: boolean): string {
    if (this.embeddedFont) {
      return this.embeddedResourceName;
    }
    // Record unknown families so writers can emit a single diagnostic
    // at build time instead of spamming one warning per text run.
    // The canonical base-name keys are kept in FONT_FAMILY_MAP; anything
    // not present will `?? "Helvetica"` in `resolveBaseFont` — that's the
    // trigger for a "family not recognised" diagnostic.
    const lowerKey = fontFamily.toLowerCase().trim();
    if (lowerKey && FONT_FAMILY_MAP[lowerKey] === undefined) {
      this._unknownFontFamilies.add(fontFamily);
    }
    const pdfFontName = resolvePdfFontName(fontFamily, bold, italic);
    return this.ensureFont(pdfFontName);
  }

  /**
   * Get the PDF font name for a given resource name.
   */
  getPdfFontName(resourceName: string): string {
    return this.resourceToType1.get(resourceName) ?? "Helvetica";
  }

  // ==========================================================================
  // Type3 Fallback Font
  // ==========================================================================

  /**
   * Check if Type3 fallback fonts are available (after writeFontResources).
   */
  hasType3Fonts(): boolean {
    return this._type3Result !== null && this._type3Result.fontObjects.size > 0;
  }

  /**
   * Resolve the Type3 font resource name and char code for a code point.
   * Returns null if the code point is not in the Type3 encoding.
   */
  resolveType3(codePoint: number): { resourceName: string; charCode: number } | null {
    if (!this._type3Result) {
      return null;
    }
    return this._type3Result.encoding.get(codePoint) ?? null;
  }

  /**
   * Check if a code point needs Type3 rendering (non-WinAnsi, no embedded font).
   */
  needsType3(codePoint: number): boolean {
    return !this.embeddedFont && !isWinAnsiCodePoint(codePoint);
  }

  // ==========================================================================
  // Text Measurement
  // ==========================================================================

  /**
   * Measure text width using the correct font metrics.
   * For mixed Type1/Type3 text, measures each character with the right font.
   */
  measureText(text: string, resourceName: string, fontSize: number): number {
    if (this.embeddedFont && resourceName === this.embeddedResourceName) {
      return measureEmbeddedText(text, this.embeddedFont, fontSize);
    }

    // If no Type3 fonts or text has no non-WinAnsi chars, use Type1 directly
    if (!this._type3Result || !hasNonWinAnsiChars(text)) {
      const pdfFontName = this.getPdfFontName(resourceName);
      return measureType1Text(text, pdfFontName, fontSize);
    }

    // Mixed text: measure char by char
    let totalWidth = 0;
    const pdfFontName = this.getPdfFontName(resourceName);
    for (let i = 0; i < text.length; i++) {
      const cp = text.codePointAt(i)!;
      if (cp > 0xffff) {
        i++;
      }
      if (isWinAnsiCodePoint(cp)) {
        totalWidth += measureType1Text(String.fromCodePoint(cp), pdfFontName, fontSize);
      } else {
        // Type3 character width
        const t3 = this._type3Result.encoding.get(cp);
        if (t3) {
          const widthMap = this._type3Result.widths.get(t3.resourceName);
          const glyphWidth = widthMap?.get(t3.charCode) ?? 600;
          totalWidth += (glyphWidth / 1000) * fontSize;
        } else {
          // Notdef width
          totalWidth += (600 / 1000) * fontSize;
        }
      }
    }
    return totalWidth;
  }

  /**
   * Get the font ascent in points.
   */
  getFontAscent(resourceName: string, fontSize: number): number {
    if (this.embeddedFont && resourceName === this.embeddedResourceName) {
      return (this.embeddedFont.ascent / this.embeddedFont.unitsPerEm) * fontSize;
    }
    // Type3 fonts use the same metrics as the base Type1 font
    const base = this.isType3Resource(resourceName)
      ? "Helvetica"
      : this.getPdfFontName(resourceName);
    return getType1Ascent(base, fontSize);
  }

  /**
   * Get the font descent in points (negative value).
   */
  getFontDescent(resourceName: string, fontSize: number): number {
    if (this.embeddedFont && resourceName === this.embeddedResourceName) {
      return (this.embeddedFont.descent / this.embeddedFont.unitsPerEm) * fontSize;
    }
    const base = this.isType3Resource(resourceName)
      ? "Helvetica"
      : this.getPdfFontName(resourceName);
    return getType1Descent(base, fontSize);
  }

  /**
   * Get the line height in points.
   */
  getLineHeight(resourceName: string, fontSize: number): number {
    if (this.embeddedFont && resourceName === this.embeddedResourceName) {
      const f = this.embeddedFont;
      return ((f.ascent - f.descent) / f.unitsPerEm) * fontSize;
    }
    const base = this.isType3Resource(resourceName)
      ? "Helvetica"
      : this.getPdfFontName(resourceName);
    return getType1LineHeight(base, fontSize);
  }

  // ==========================================================================
  // Text Encoding
  // ==========================================================================

  /**
   * Check if a resource name refers to an embedded font.
   */
  isEmbeddedFont(resourceName: string): boolean {
    return this.embeddedFont !== null && resourceName === this.embeddedResourceName;
  }

  /**
   * Check if a resource name refers to a Type3 fallback font.
   */
  isType3Resource(resourceName: string): boolean {
    return this._type3Result?.fontObjects.has(resourceName) ?? false;
  }

  /**
   * Encode text for the given font resource.
   * For embedded fonts, returns a hex string `<0012003A...>`.
   * For Type1 fonts, returns null (caller should use standard string encoding).
   *
   * IMPORTANT: Must be called AFTER writeFontResources(), which builds the
   * subset and produces the unicodeToCid mapping.
   */
  encodeText(text: string, resourceName: string): string | null {
    if (!this.embeddedFont || resourceName !== this.embeddedResourceName) {
      return null;
    }

    // After writeFontResources, use the subset's CID mapping
    // (maps Unicode code points → new sequential glyph IDs in the subset font)
    if (this._embeddedResult) {
      return encodeWithCidMap(text, this._embeddedResult.unicodeToCid);
    }

    // writeFontResources not called yet — this is a programming error
    throw new PdfFontError(
      "encodeText called before writeFontResources — subset mapping not available"
    );
  }

  /**
   * Encode a run of code points that all live in the same Type3 font.
   *
   * Type3 fallback fonts use single-byte encoding, so a run of consecutive
   * code points sharing one resource becomes a single multi-byte hex string
   * (`<XXYY…>`) that can be shown with one `Tj`. Emitting the whole run at
   * once keeps the text as one string in the content stream, which is what
   * PDF text extractors (and our own reader) need to recover the original
   * word instead of one fragment per glyph.
   *
   * Returns null when the Type3 fallback has not been built yet, the run is
   * empty, or any code point is missing from `resourceName`'s encoding —
   * callers then fall back to the Type1/WinAnsi path for that run.
   */
  encodeType3Run(codePoints: readonly number[], resourceName: string): string | null {
    if (!this._type3Result || codePoints.length === 0) {
      return null;
    }
    let hex = "";
    for (const cp of codePoints) {
      const entry = this._type3Result.encoding.get(cp);
      if (!entry || entry.resourceName !== resourceName) {
        return null;
      }
      hex += entry.charCode.toString(16).toUpperCase().padStart(2, "0");
    }
    return `<${hex}>`;
  }

  // ==========================================================================
  // PDF Object Writing
  // ==========================================================================

  /**
   * Write all font resource objects to the PDF.
   * Returns a map from resource name → object number.
   *
   * `async` because Type3 fallback fonts (the ~hundreds-of-KB Unicode glyph
   * tables) are loaded lazily via dynamic `import()` — only documents that
   * actually contain non-WinAnsi characters pay for them. A plain text PDF
   * never bundles the glyph tables (verified by scripts/treeshake-verify).
   */
  async writeFontResources(writer: PdfWriter): Promise<Map<string, number>> {
    const fontObjectMap = new Map<string, number>();

    // Write standard Type1 fonts
    for (const [pdfFontName, resourceName] of this.type1Map) {
      const objNum = writer.allocObject();
      const dict = new PdfDict()
        .set("Type", "/Font")
        .set("Subtype", "/Type1")
        .set("BaseFont", pdfName(pdfFontName))
        .set("Encoding", "/WinAnsiEncoding");
      writer.addObject(objNum, dict);
      fontObjectMap.set(resourceName, objNum);
    }

    // Write embedded TrueType font
    if (this.embeddedFont && this.embeddedResourceName) {
      const embedded = embedTtfFont(
        writer,
        this.embeddedFont,
        this.usedCodePoints,
        this.embeddedResourceName
      );
      fontObjectMap.set(this.embeddedResourceName, embedded.fontObjNum);
      // Store the embedding result for text re-encoding
      this._embeddedResult = embedded;
    }

    // Write Type3 fallback fonts (only when no embedded font). The Type3
    // implementation + Unicode glyph tables are loaded on demand so they stay
    // out of bundles that never render non-WinAnsi characters.
    if (!this.embeddedFont && this.type3CodePoints.size > 0) {
      const { writeType3Fonts } = await import("@pdf/font/type3-font");
      this._type3Result = writeType3Fonts(writer, this.type3CodePoints);
      for (const [resourceName, objNum] of this._type3Result.fontObjects) {
        fontObjectMap.set(resourceName, objNum);
      }
    }

    return fontObjectMap;
  }

  /** Stored after writeFontResources is called */
  private _embeddedResult: EmbeddedFont | null = null;

  /**
   * Get the embedded font result (available after writeFontResources).
   */
  getEmbeddedResult(): EmbeddedFont | null {
    return this._embeddedResult;
  }

  /**
   * Build the Font sub-dictionary for a page's Resources dictionary.
   */
  buildFontDictString(fontObjectMap: Map<string, number>): string {
    const parts: string[] = ["<<"];
    for (const [resourceName, objNum] of fontObjectMap) {
      parts.push(`${pdfName(resourceName)} ${pdfRef(objNum)}`);
    }
    parts.push(">>");
    return parts.join("\n");
  }

  /**
   * Get all registered fonts (Type1 only, for backward compat).
   */
  getRegisteredFonts(): Array<{ resourceName: string; pdfFontName: string }> {
    const result: Array<{ resourceName: string; pdfFontName: string }> = [];
    for (const [pdfFontName, resourceName] of this.type1Map) {
      result.push({ resourceName, pdfFontName });
    }
    return result;
  }
}

// =============================================================================
// Internal Helpers
// =============================================================================

/**
 * Encode text as hex string using the font's cmap (original glyph IDs).
 * This is used during content stream generation.
 */
function encodeWithCidMap(text: string, cidMap: Map<number, number>): string {
  let hex = "<";
  for (let i = 0; i < text.length; i++) {
    const cp = text.codePointAt(i)!;
    if (cp > 0xffff) {
      i++;
    }
    const gid = cidMap.get(cp) ?? 0;
    hex += gid.toString(16).toUpperCase().padStart(4, "0");
  }
  hex += ">";
  return hex;
}

/**
 * Measure text width using the embedded font's cmap + advanceWidths.
 */
function measureEmbeddedText(text: string, font: TtfFont, fontSize: number): number {
  let totalWidth = 0;
  for (let i = 0; i < text.length; i++) {
    const cp = text.codePointAt(i)!;
    if (cp > 0xffff) {
      i++;
    }
    const gid = font.cmap.get(cp) ?? 0;
    totalWidth += font.advanceWidths[gid] ?? 0;
  }
  return (totalWidth / font.unitsPerEm) * fontSize;
}
