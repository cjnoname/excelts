/**
 * Font manager for PDF generation.
 *
 * Manages three kinds of fonts:
 * 1. **Standard Type1 fonts** (Helvetica, Times, Courier) — always available,
 *    used for Latin text (WinAnsi repertoire) when no embedded font is provided.
 * 2. **Embedded TrueType fonts** — user-provided .ttf files for broader
 *    Unicode glyph coverage (for example CJK and Cyrillic). This does not add
 *    OpenType shaping, bidi reordering, or color-emoji rendering.
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
import type { CompiledPdfFontConfig, CompiledPdfFontFace } from "@pdf/font/font-config";
import type { EmbeddedFont, EmbeddedGlyphUse } from "@pdf/font/font-embedder";
import { collectEmbeddedGlyphUses, embedTtfFont } from "@pdf/font/font-embedder";
import { buildFontPlan } from "@pdf/font/font-plan";
import {
  measureText as measureType1Text,
  getFontAscent as getType1Ascent,
  getFontDescent as getType1Descent,
  getLineHeight as getType1LineHeight
} from "@pdf/font/metrics";
import { TextFeatureReport } from "@pdf/font/text-features";
import type { TtfFont } from "@pdf/font/ttf-parser";
import type { Type3FontResult } from "@pdf/font/type3-font";

export interface RoutedFontSegment {
  readonly text: string;
  readonly resourceName: string;
  readonly codepoints: readonly number[];
  readonly width: number;
  readonly ascent: number;
  readonly descent: number;
}

export interface RoutedTextMetrics {
  readonly width: number;
  readonly ascent: number;
  readonly descent: number;
  readonly lineHeight: number;
}

interface FontRequest {
  readonly family: string;
  readonly bold: boolean;
  readonly italic: boolean;
}

interface ConfiguredFaceState {
  readonly source: CompiledPdfFontFace;
  readonly resourceName: string;
  readonly codepoints: Set<number>;
  readonly glyphUses: Map<string, EmbeddedGlyphUse>;
  embedded: EmbeddedFont | null;
}

// =============================================================================
// Font Name Mapping (Type1 fallback)
// =============================================================================

/**
 * Upper bound on cached text-routing results, to keep a large export from
 * retaining every distinct string it ever measured.
 */
const ROUTE_CACHE_LIMIT = 4096;
const ROUTE_CACHE_MAX_TEXT_LENGTH = 4096;

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
  private readonly config: CompiledPdfFontConfig | null;
  /** Prefix isolates resource names when content is merged into an existing PDF. */
  private readonly resourcePrefix: string;
  private configuredRequests = new Map<string, FontRequest>();
  private configuredRequestKeys = new Map<string, string>();
  private configuredFaces = new Map<CompiledPdfFontFace, ConfiguredFaceState>();
  private configuredResourceFaces = new Map<string, ConfiguredFaceState>();
  private configuredRouteCache = new Map<string, readonly RoutedFontSegment[]>();
  private nextConfiguredRequestId = 1;
  private nextConfiguredFaceId = 1;
  private resourcesWritten = false;
  private missingCodePoints = new Set<number>();
  private readonly textFeatures = new TextFeatureReport();
  /**
   * Set while reserving renderer-generated characters (see `trackText`). Those
   * reservations must not be reported as caller-visible coverage gaps.
   */
  private suppressCoverageDiagnostics = false;

  // --- Standard Type1 font tracking ---
  private type1Map = new Map<string, string>(); // pdfFontName → resourceName
  private resourceToType1 = new Map<string, string>(); // resourceName → pdfFontName
  private nextType1Id = 1;

  // --- Embedded TrueType font tracking ---
  private embeddedFont: TtfFont | null = null;
  private embeddedResourceName = "";
  /**
   * True when `embeddedFont` is a *fallback* face rather than the document's
   * font.
   *
   * `embedFont(bytes)` states "render this document with this font", and every
   * run is routed to it. Build-time system-font auto-discovery means something
   * entirely different: "the standard-14 faces cannot draw these few code
   * points, borrow glyphs for them". Treating the second like the first
   * collapsed every run onto one regular face, so a single `→` in a document
   * silently stripped bold, italic and monospace from all of its text — and
   * mismatched the widths layout had already measured with the Type1 metrics.
   */
  private embeddedFontIsFallback = false;
  private usedCodePoints = new Set<number>();
  private usedGlyphUses = new Map<string, EmbeddedGlyphUse>();
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

  constructor(config?: CompiledPdfFontConfig, resourcePrefix = "") {
    if (resourcePrefix && !/^[A-Za-z][A-Za-z0-9_]*$/.test(resourcePrefix)) {
      throw new PdfFontError(`Invalid PDF font resource prefix '${resourcePrefix}'`);
    }
    this.config = config ?? null;
    this.resourcePrefix = resourcePrefix;
  }

  // ==========================================================================
  // Embedded Font Registration
  // ==========================================================================

  /**
   * Register an embedded TrueType font for use.
   * When set, all text rendering uses this font instead of standard fonts.
   */
  registerEmbeddedFont(font: TtfFont): string {
    return this.registerTtfFont(font, false);
  }

  /**
   * Register an embedded TrueType font as a *per-code-point fallback*.
   *
   * The standard-14 faces keep drawing everything they can represent, so
   * bold / italic / monospace requests still resolve to `Helvetica-Bold`,
   * `Times-Italic`, `Courier`, … and only the code points WinAnsi cannot encode
   * are routed to this face. Use it for fonts the library found on its own;
   * `registerEmbeddedFont` remains the "this is the document's font" contract.
   */
  registerFallbackFont(font: TtfFont): string {
    return this.registerTtfFont(font, true);
  }

  private registerTtfFont(font: TtfFont, fallbackOnly: boolean): string {
    if (this.config) {
      throw new PdfFontError("Cannot register a legacy embedded font on a configured FontManager");
    }
    this.embeddedFont = font;
    this.embeddedFontIsFallback = fallbackOnly;
    this.embeddedResourceName = `${this.resourcePrefix}EF${this.nextEmbeddedId++}`;
    this.textFeatures.noteFontTables(font.familyName, font.tables);
    return this.embeddedResourceName;
  }

  /**
   * Drop a build-local auto-discovered font while retaining collected text.
   *
   * Explicitly configured fonts live for the document's authoring lifetime;
   * system discovery does not. Keeping a discovered face after one build would
   * prevent a later build from choosing a broader face after new text is added.
   */
  clearAutoDiscoveredFont(): void {
    if (this.config) {
      throw new PdfFontError("Configured fonts cannot be cleared as auto-discovered fonts");
    }
    this.embeddedFont = null;
    this.embeddedFontIsFallback = false;
    this.embeddedResourceName = "";
    this._embeddedResult = null;
    this.nextEmbeddedId = 1;
  }

  /**
   * Check if an embedded font is available.
   */
  hasEmbeddedFont(): boolean {
    return this.config !== null || this.embeddedFont !== null;
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

  /** Code points rendered as .notdef because no configured face covered them. */
  getMissingCodePoints(): Set<number> {
    return new Set(this.missingCodePoints);
  }

  /**
   * Report font problems that degrade the output but must not fail the export.
   *
   * Shared by every entry point so the wording is identical whether the document
   * came from Excel, Word, a chart or the free-form builder. Two kinds are
   * reported: coverage gaps (a configured typeface set that misses a character
   * still produces a readable, extractable PDF, but the page shows `.notdef`,
   * and only the caller can decide which fallback family to add) and text
   * features this writer does not implement — shaping, bidi and color glyphs
   * (see `text-features.ts`).
   */
  reportDiagnostics(warn: (message: string) => void): void {
    this.textFeatures.report(warn);
    const missing = this.missingCodePoints;
    if (missing.size === 0) {
      return;
    }
    const sample = [...missing]
      .slice(0, 5)
      .map(cp => `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`)
      .join(", ");
    warn(
      `${missing.size} character(s) are not covered by the configured PDF font families ` +
        `and will render with the .notdef glyph (e.g. ${sample}). ` +
        `Add a named fallback family through fallbackFamilies.`
    );
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
    if (this.config) {
      // Return the concrete default face directly. Going through `resolveFont`
      // would register a font *request* as a side effect, and every request is
      // materialised at write time — so an incidental call here would embed an
      // otherwise unused face with an empty subset.
      return this.ensureConfiguredFace(
        selectConfiguredRequestFace(this.config, { family: "", bold: false, italic: false })
      ).resourceName;
    }
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
    if (this.config) {
      return type1ResourceName;
    }
    // A fallback face never replaces the requested family: the Type1 resource
    // that carries the caller's bold / italic / family choice stays in charge
    // and `fallbackResourceFor` lends glyphs per code point.
    if (this.embeddedFont && !this.embeddedFontIsFallback) {
      return this.embeddedResourceName;
    }
    return type1ResourceName;
  }

  /**
   * The resource that must draw `codePoint` instead of the requested Type1
   * face, or null when the Type1 face handles it.
   *
   * Only ever non-null in fallback mode, for a code point WinAnsi cannot encode
   * that the fallback face actually has a glyph for. Code points the fallback
   * cannot draw either are left to the Type3 path.
   */
  fallbackResourceFor(codePoint: number): string | null {
    if (this.config || !this.embeddedFont || !this.embeddedFontIsFallback) {
      return null;
    }
    if (isWinAnsiCodePoint(codePoint)) {
      return null;
    }
    return (this.embeddedFont.cmap.get(codePoint) ?? 0) === 0 ? null : this.embeddedResourceName;
  }

  /** Whether an embedded face is lending glyphs per code point rather than replacing the document font. */
  hasFallbackFont(): boolean {
    return this.embeddedFont !== null && this.embeddedFontIsFallback;
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
  trackText(text: string, resourceName?: string): void {
    if (this.config) {
      if (!resourceName) {
        throw new PdfFontError(
          "Configured font tracking requires the resource returned by resolveFont"
        );
      }
      this.routeText(text, resourceName);
      // Wrapping normalizes tabs/runs of whitespace to U+0020 when it builds
      // output lines. Reserve that renderer-generated character up front so a
      // wrapped run cannot introduce a glyph after resources are frozen.
      // The reservation is ours, not the caller's text, so it must not surface
      // as a coverage gap the caller is asked to fix.
      if (!text.includes(" ")) {
        this.suppressCoverageDiagnostics = true;
        try {
          this.routeText(" ", resourceName);
        } finally {
          this.suppressCoverageDiagnostics = false;
        }
      }
      return;
    }
    // The configured branch above reaches `noteText` through `routeText`. The
    // legacy branch never calls `routeText` during layout — it only does so at
    // encoding time, which is after diagnostics are reported — so text features
    // must be recorded here or this path would stay silent.
    this.textFeatures.noteText(text);
    collectGlyphUsesInto(this.usedGlyphUses, text);
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
      resourceName = `${this.resourcePrefix}F${this.nextType1Id++}`;
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
    if (this.config) {
      const family = normalizeFamilyName(fontFamily);
      const key = `${family}\u0000${bold ? 1 : 0}${italic ? 1 : 0}`;
      let resourceName = this.configuredRequestKeys.get(key);
      if (!resourceName) {
        resourceName = `${this.resourcePrefix}FR${this.nextConfiguredRequestId++}`;
        this.configuredRequestKeys.set(key, resourceName);
        this.configuredRequests.set(resourceName, { family: fontFamily, bold, italic });
      }
      return resourceName;
    }
    if (this.embeddedFont && !this.embeddedFontIsFallback) {
      return this.embeddedResourceName;
    }
    // A fallback face does not answer font *requests*: the request keeps
    // resolving to the standard-14 face that carries the caller's family,
    // bold and italic choice, and `fallbackResourceFor` lends glyphs per code
    // point at render time. The spreadsheet exporter registers its discovered
    // font before drawing, so short-circuiting here erased bold and italic
    // from every cell in a workbook containing one CJK character.
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
    const resourceName = this.ensureFont(pdfFontName);
    return resourceName;
  }

  /**
   * Route text to concrete font faces without splitting Unicode grapheme clusters.
   * Width and vertical metrics are normalized to em units.
   */
  routeText(text: string, resourceName: string): readonly RoutedFontSegment[] {
    if (!this.suppressCoverageDiagnostics) {
      // Every rendered run passes through here, so this is the one place that
      // sees all of the document's text. Renderer-generated reservations (the
      // wrapping space) are suppressed along with coverage diagnostics.
      this.textFeatures.noteText(text);
    }
    if (!this.config) {
      return this.routeLegacyText(text, resourceName);
    }
    const request = this.configuredRequests.get(resourceName);
    if (!request) {
      const face = this.configuredResourceFaces.get(resourceName);
      if (!face) {
        throw new PdfFontError(`Unknown configured font resource '${resourceName}'`);
      }
      const codepoints = codePointsOf(text);
      for (const codePoint of codepoints) {
        face.codepoints.add(codePoint);
      }
      collectGlyphUsesInto(face.glyphUses, text);
      return [configuredSegment(text, codepoints, face)];
    }

    // Long strings carry their full text plus segment/codepoint arrays in a
    // cache entry. Skip them entirely; caching a few thousand multi-megabyte
    // cells would defeat the entry-count bound below.
    const cacheable = text.length <= ROUTE_CACHE_MAX_TEXT_LENGTH;
    const cacheKey = cacheable ? `${resourceName}\u0000${text}` : "";
    const cached = cacheable ? this.configuredRouteCache.get(cacheKey) : undefined;
    if (cached) {
      return cached;
    }

    const planner = buildFontPlan(this.config);
    planner.collect({ text, ...request });
    const plan = planner.finalize();
    const plannedFaces = new Map(plan.faces.map(face => [face.id, face]));
    const routed = Object.freeze(
      plan.segments.map(segment => {
        const plannedFace = plannedFaces.get(segment.faceId)!;
        if (plannedFace.source.kind !== "ttf" || !plannedFace.source.source) {
          throw new PdfFontError("Configured font planning produced a non-TTF face");
        }
        const state = this.ensureConfiguredFace(plannedFace.source.source);
        if (this.resourcesWritten) {
          const missingSequence = state.embedded?.encodeText(segment.text).includes(0) ?? true;
          if (missingSequence) {
            throw new PdfFontError(
              "Text introduced a Unicode sequence after PDF font resources were written. " +
                "Track every rendered text run during layout."
            );
          }
        }
        for (const codePoint of plannedFace.codepoints) {
          if (this.resourcesWritten && !state.codepoints.has(codePoint)) {
            throw new PdfFontError(
              `Text introduced U+${codePoint.toString(16).toUpperCase().padStart(4, "0")} ` +
                "after PDF font resources were written. Track every rendered text run during layout."
            );
          }
          state.codepoints.add(codePoint);
          if (
            !this.suppressCoverageDiagnostics &&
            (state.source.font.cmap.get(codePoint) ?? 0) === 0 &&
            !isSemanticControl(codePoint)
          ) {
            this.missingCodePoints.add(codePoint);
          }
        }
        collectGlyphUsesInto(state.glyphUses, segment.text);
        return Object.freeze({
          text: segment.text,
          resourceName: state.resourceName,
          codepoints: segment.codepoints,
          width: segment.width,
          ascent: segment.ascent,
          descent: segment.descent
        });
      })
    );
    // Routing the same string repeatedly is the norm: auto row height, wrapping,
    // overflow and rendering all measure the same cell text. Cache it, but keep
    // the cache bounded — a large sheet has millions of distinct strings, and an
    // unbounded map would hold every one of them for the whole export. Repeats
    // are consecutive, so dropping the cache wholesale when it grows past the
    // cap keeps the hot path fast without tracking eviction order.
    if (cacheable) {
      if (this.configuredRouteCache.size >= ROUTE_CACHE_LIMIT) {
        this.configuredRouteCache.clear();
      }
      this.configuredRouteCache.set(cacheKey, routed);
    }
    return routed;
  }

  /** Load lazy Type3 metrics before synchronous layout starts. */
  async prepare(): Promise<void> {
    if (!this.config && !this.embeddedFont && this.type3CodePoints.size > 0) {
      const { lookupGlyph } = await import("@pdf/font/type3-glyphs");
      this.type3PlanningWidths = new Map(
        [...this.type3CodePoints].map(codePoint => [
          codePoint,
          lookupGlyph(codePoint)?.width ?? 600
        ])
      );
    }
  }

  /** Alias for build contexts that name the pre-layout step finalize. */
  async finalize(): Promise<void> {
    await this.prepare();
  }

  /**
   * Start one writer-local font materialization session.
   *
   * Collected requests and code points belong to the document model and are
   * retained. Embedded CID maps and Type3 object references belong to one
   * PdfWriter and are discarded, so repeated builds cannot reuse artifacts
   * from a previous PDF.
   */
  beginBuild(): void {
    this.resourcesWritten = false;
    this._embeddedResult = null;
    this._type3Result = null;
    for (const state of this.configuredFaces.values()) {
      state.embedded = null;
    }
  }

  /** End the writer-local session and allow the authoring model to grow again. */
  endBuild(): void {
    this.resourcesWritten = false;
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
    if (this.config) {
      // Configured fonts are deterministic by contract: text is drawn only by
      // the faces the caller supplied, and anything they do not cover renders
      // as .notdef (with its Unicode still recoverable through ToUnicode).
      // `writeFontResources` emits no Type3 font in this mode, so claiming a
      // code point needs one would describe a fallback that never exists.
      return false;
    }
    if (isWinAnsiCodePoint(codePoint)) {
      return false;
    }
    if (!this.embeddedFont) {
      return true;
    }
    // A document font covers everything itself. A fallback face only covers the
    // code points it has glyphs for; the rest still need a Type3 glyph.
    return this.embeddedFontIsFallback && this.fallbackResourceFor(codePoint) === null;
  }

  // ==========================================================================
  // Text Measurement
  // ==========================================================================

  /**
   * Measure an unresolved font request without adding it to the document plan.
   *
   * The free-form Builder exposes measurement as a query. Calling it must not
   * embed a face, enlarge a subset, or report missing glyphs for text that was
   * never drawn. Configured fonts can be planned directly and purely; legacy
   * Type1/embedded mode retains the historical resource-based path.
   */
  measureTextRequest(
    text: string,
    family: string,
    bold: boolean,
    italic: boolean,
    fontSize: number
  ): number {
    if (!this.config) {
      return this.measureText(text, this.resolveFont(family, bold, italic), fontSize);
    }
    const planner = buildFontPlan(this.config);
    planner.collect({ text, family, bold, italic });
    return planner.finalize().segments.reduce((sum, segment) => sum + segment.width, 0) * fontSize;
  }

  /**
   * Measure text width using the correct font metrics.
   *
   * Mixed text is measured character by character so every code point is sized
   * by the face that will actually draw it: the requested Type1 face, an
   * embedded fallback face, or a Type3 glyph. Measuring with one face and
   * drawing with another is what produced the stray gaps after non-WinAnsi
   * runs.
   */
  measureText(text: string, resourceName: string, fontSize: number): number {
    if (this.config) {
      return (
        this.routeText(text, resourceName).reduce((width, segment) => width + segment.width, 0) *
        fontSize
      );
    }
    if (this.embeddedFont && resourceName === this.embeddedResourceName) {
      return measureEmbeddedText(text, this.embeddedFont, fontSize);
    }

    // Type1 only when nothing else can be involved: no Type3 glyphs planned or
    // written, no fallback face, or the text is entirely WinAnsi.
    const mayNeedFallback =
      this._type3Result !== null || this.type3PlanningWidths !== null || this.hasFallbackFont();
    if (!mayNeedFallback || !hasNonWinAnsiChars(text)) {
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
      const char = String.fromCodePoint(cp);
      const fallback = this.fallbackResourceFor(cp);
      if (fallback !== null) {
        // Drawn by the embedded fallback face — use its advance width.
        totalWidth += measureEmbeddedText(char, this.embeddedFont!, fontSize);
        continue;
      }
      if (isWinAnsiCodePoint(cp)) {
        totalWidth += measureType1Text(String.fromCodePoint(cp), pdfFontName, fontSize);
      } else {
        // Type3 character width
        const t3 = this._type3Result?.encoding.get(cp);
        if (t3) {
          const widthMap = this._type3Result!.widths.get(t3.resourceName);
          const glyphWidth = widthMap?.get(t3.charCode) ?? 600;
          totalWidth += (glyphWidth / 1000) * fontSize;
        } else {
          // Notdef width
          const glyphWidth = this.type3PlanningWidths?.get(cp) ?? 600;
          totalWidth += (glyphWidth / 1000) * fontSize;
        }
      }
    }
    return totalWidth;
  }

  /**
   * Measure horizontal and vertical extents using every face that actually
   * draws the text. Width-only measurement is insufficient for mixed-family
   * runs: a CJK fallback face can have a taller ascent than the requested Latin
   * face and would otherwise be clipped by top/center alignment.
   */
  measureTextMetrics(text: string, resourceName: string, fontSize: number): RoutedTextMetrics {
    // A fallback face lends glyphs per code point, and `routeLegacyText` reports
    // one segment for the requested face — so its ascent and descent would be
    // the Latin face's even for text a CJK fallback actually draws. Measure
    // those extents from the faces that do the drawing.
    if (!this.config && this.hasFallbackFont() && hasNonWinAnsiChars(text)) {
      const width = this.measureText(text, resourceName, fontSize);
      let ascent = 0;
      let descent = 0;
      let sawLatin = false;
      for (const cp of codePointsOf(text)) {
        if (this.fallbackResourceFor(cp) !== null) {
          const font = this.embeddedFont!;
          ascent = Math.max(ascent, (font.ascent / font.unitsPerEm) * fontSize);
          descent = Math.min(descent, (font.descent / font.unitsPerEm) * fontSize);
        } else {
          sawLatin = true;
        }
      }
      if (sawLatin) {
        ascent = Math.max(ascent, this.getFontAscent(resourceName, fontSize));
        descent = Math.min(descent, this.getFontDescent(resourceName, fontSize));
      }
      return { width, ascent, descent, lineHeight: ascent - descent };
    }
    const segments = this.routeText(text, resourceName);
    if (segments.length === 0) {
      const ascent = this.getFontAscent(resourceName, fontSize);
      const descent = this.getFontDescent(resourceName, fontSize);
      return { width: 0, ascent, descent, lineHeight: ascent - descent };
    }
    let width = 0;
    let ascent = 0;
    let descent = 0;
    for (const segment of segments) {
      width += segment.width * fontSize;
      ascent = Math.max(ascent, segment.ascent * fontSize);
      descent = Math.min(descent, segment.descent * fontSize);
    }
    return { width, ascent, descent, lineHeight: ascent - descent };
  }

  /**
   * Get the font ascent in points.
   */
  getFontAscent(resourceName: string, fontSize: number): number {
    const configured = this.resolveConfiguredMetricFace(resourceName);
    if (configured) {
      return (configured.source.font.ascent / configured.source.font.unitsPerEm) * fontSize;
    }
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
    const configured = this.resolveConfiguredMetricFace(resourceName);
    if (configured) {
      return (configured.source.font.descent / configured.source.font.unitsPerEm) * fontSize;
    }
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
    const configured = this.resolveConfiguredMetricFace(resourceName);
    if (configured) {
      const font = configured.source.font;
      return ((font.ascent - font.descent) / font.unitsPerEm) * fontSize;
    }
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
  private isEmbeddedFont(resourceName: string): boolean {
    if (this.config) {
      return (
        this.configuredRequests.has(resourceName) || this.configuredResourceFaces.has(resourceName)
      );
    }
    return this.embeddedFont !== null && resourceName === this.embeddedResourceName;
  }

  /**
   * Check if a resource name refers to a Type3 fallback font.
   */
  private isType3Resource(resourceName: string): boolean {
    return this._type3Result?.fontObjects.has(resourceName) ?? false;
  }

  /**
   * Encode text for the given font resource.
   * For embedded fonts, returns a hex string `<0012003A...>`.
   * For Type1 fonts, returns null (caller should use standard string encoding).
   *
   * IMPORTANT: Must be called AFTER writeFontResources(), which builds the
   * subset and produces the Unicode-sequence mapping.
   */
  encodeText(text: string, resourceName: string): string | null {
    if (text.length === 0) {
      return this.config || this.isEmbeddedFont(resourceName) ? "<>" : null;
    }
    if (this.config) {
      let state: ConfiguredFaceState | undefined;
      if (this.configuredRequests.has(resourceName)) {
        const segments = this.routeText(text, resourceName);
        if (segments.length !== 1) {
          throw new PdfFontError("Text spans multiple font faces; encode each routeText segment");
        }
        state = this.configuredResourceFaces.get(segments[0].resourceName);
      } else {
        state = this.configuredResourceFaces.get(resourceName);
      }
      if (!state?.embedded) {
        throw new PdfFontError(
          "encodeText called before writeFontResources — subset mapping not available"
        );
      }
      return encodeWithEmbeddedFont(text, state.embedded);
    }
    if (!this.embeddedFont || resourceName !== this.embeddedResourceName) {
      return null;
    }

    // After writeFontResources, use the subset's CID mapping
    // (maps Unicode sequences → CIDs, independently from subset glyph IDs)
    if (this._embeddedResult) {
      return encodeWithEmbeddedFont(text, this._embeddedResult);
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

    if (this.config) {
      for (const [resourceName] of this.configuredRequests) {
        const request = this.configuredRequests.get(resourceName)!;
        const segments = this.routeText("", resourceName);
        if (segments.length === 0) {
          const source = selectConfiguredRequestFace(this.config, request);
          const state = this.ensureConfiguredFace(source);
          this.configuredResourceFaces.set(resourceName, state);
        }
      }
      for (const state of this.configuredFaces.values()) {
        state.embedded = embedTtfFont(
          writer,
          state.source.font,
          state.glyphUses.values(),
          state.resourceName
        );
        fontObjectMap.set(state.resourceName, state.embedded.fontObjNum);
      }
      for (const [requestName, request] of this.configuredRequests) {
        const source = selectConfiguredRequestFace(this.config, request);
        const state = this.ensureConfiguredFace(source);
        fontObjectMap.set(requestName, state.embedded!.fontObjNum);
      }
      this.resourcesWritten = true;
      return fontObjectMap;
    }

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
        this.usedGlyphUses.values(),
        this.embeddedResourceName
      );
      fontObjectMap.set(this.embeddedResourceName, embedded.fontObjNum);
      // Store the embedding result for text re-encoding
      this._embeddedResult = embedded;
    }

    // Write Type3 fallback fonts for the code points nothing else can draw.
    // A *document* font (explicit `embedFont`) covers all of them by contract,
    // so none are needed; without any embedded font every non-WinAnsi code
    // point needs one; with a fallback face only the code points it lacks a
    // glyph for do. The Type3 implementation + Unicode glyph tables are loaded
    // on demand so they stay out of bundles that never render such text.
    const type3Needed = new Set<number>();
    if (!this.embeddedFont || this.embeddedFontIsFallback) {
      for (const cp of this.type3CodePoints) {
        if (this.needsType3(cp)) {
          type3Needed.add(cp);
        }
      }
    }
    if (type3Needed.size > 0) {
      const { writeType3Fonts } = await import("@pdf/font/type3-font");
      this._type3Result = writeType3Fonts(writer, type3Needed, `${this.resourcePrefix}T3F`);
      for (const [resourceName, objNum] of this._type3Result.fontObjects) {
        fontObjectMap.set(resourceName, objNum);
      }
    }

    this.resourcesWritten = true;
    return fontObjectMap;
  }

  /** Stored after writeFontResources is called */
  private _embeddedResult: EmbeddedFont | null = null;
  private type3PlanningWidths: Map<number, number> | null = null;

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

  private ensureConfiguredFace(source: CompiledPdfFontFace): ConfiguredFaceState {
    let state = this.configuredFaces.get(source);
    if (!state) {
      state = {
        source,
        resourceName: `${this.resourcePrefix}EF${this.nextConfiguredFaceId++}`,
        codepoints: new Set<number>(),
        glyphUses: new Map<string, EmbeddedGlyphUse>(),
        embedded: null
      };
      this.configuredFaces.set(source, state);
      this.configuredResourceFaces.set(state.resourceName, state);
      this.textFeatures.noteFontTables(source.font.familyName, source.font.tables);
    }
    return state;
  }

  private resolveConfiguredMetricFace(resourceName: string): ConfiguredFaceState | null {
    if (!this.config) {
      return null;
    }
    const concrete = this.configuredResourceFaces.get(resourceName);
    if (concrete) {
      return concrete;
    }
    const request = this.configuredRequests.get(resourceName);
    return request
      ? this.ensureConfiguredFace(selectConfiguredRequestFace(this.config, request))
      : null;
  }

  private routeLegacyText(text: string, resourceName: string): readonly RoutedFontSegment[] {
    const codepoints = codePointsOf(text);
    const width = this.measureText(text, resourceName, 1);
    return Object.freeze([
      Object.freeze({
        text,
        resourceName,
        codepoints: Object.freeze(codepoints),
        width,
        ascent: this.getFontAscent(resourceName, 1),
        descent: this.getFontDescent(resourceName, 1)
      })
    ]);
  }
}

// =============================================================================
// Internal Helpers
// =============================================================================

/**
 * Encode text as hex string using the font's cmap (original glyph IDs).
 * This is used during content stream generation.
 */
function encodeWithEmbeddedFont(text: string, embedded: EmbeddedFont): string {
  let hex = "<";
  for (const cid of embedded.encodeText(text)) {
    hex += cid.toString(16).toUpperCase().padStart(4, "0");
  }
  hex += ">";
  return hex;
}

/**
 * Measure text width using the embedded font's cmap + advanceWidths.
 */
function measureEmbeddedText(text: string, font: TtfFont, fontSize: number): number {
  let totalEm = 0;
  for (let i = 0; i < text.length; i++) {
    const cp = text.codePointAt(i)!;
    if (cp > 0xffff) {
      i++;
    }
    // Semantic controls are attached to the neighbouring visible CID by the
    // embedder and have zero advance of their own.
    if (isSemanticControl(cp)) {
      continue;
    }
    const gid = font.cmap.get(cp) ?? 0;
    // Match the integer 1/1000-em width written to PDF /W exactly, otherwise a
    // long run can drift from the viewer's placement and cross a wrap boundary.
    totalEm += Math.round(((font.advanceWidths[gid] ?? 0) * 1000) / font.unitsPerEm) / 1000;
  }
  return totalEm * fontSize;
}

function collectGlyphUsesInto(target: Map<string, EmbeddedGlyphUse>, text: string): void {
  for (const use of collectEmbeddedGlyphUses(text)) {
    target.set(use.sequence, use);
  }
}

function normalizeFamilyName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

function codePointsOf(text: string): number[] {
  return Array.from(text, char => char.codePointAt(0)!);
}

function isSemanticControl(codePoint: number): boolean {
  return (
    codePoint === 0x200c ||
    codePoint === 0x200d ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    (codePoint >= 0xe0100 && codePoint <= 0xe01ef)
  );
}

function configuredSegment(
  text: string,
  codepoints: readonly number[],
  state: ConfiguredFaceState
): RoutedFontSegment {
  const font = state.source.font;
  const width = codepoints.reduce((sum, codePoint) => {
    if (isSemanticControl(codePoint)) {
      return sum;
    }
    const glyphId = font.cmap.get(codePoint) ?? 0;
    return sum + Math.round(((font.advanceWidths[glyphId] ?? 0) * 1000) / font.unitsPerEm) / 1000;
  }, 0);
  return Object.freeze({
    text,
    resourceName: state.resourceName,
    codepoints: Object.freeze([...codepoints]),
    width,
    ascent: font.ascent / font.unitsPerEm,
    descent: font.descent / font.unitsPerEm
  });
}

function selectConfiguredRequestFace(
  config: CompiledPdfFontConfig,
  request: FontRequest
): CompiledPdfFontFace {
  const normalized = normalizeFamilyName(request.family);
  const family = config.families.find(
    candidate =>
      candidate.normalizedName === normalized || candidate.normalizedAliases.includes(normalized)
  );
  const faces = family?.faces ?? config.default;
  return request.bold && request.italic
    ? (faces.boldItalic ?? faces.bold ?? faces.italic ?? faces.regular)
    : request.bold
      ? (faces.bold ?? faces.regular)
      : request.italic
        ? (faces.italic ?? faces.regular)
        : faces.regular;
}
