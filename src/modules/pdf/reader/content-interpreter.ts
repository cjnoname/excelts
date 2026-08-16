/**
 * PDF content stream interpreter for text extraction.
 *
 * Implements a full PDF graphics state machine that processes content stream
 * operators to extract positioned text fragments. These fragments are then
 * assembled into readable text by the text reconstruction module.
 *
 * Supported operator categories:
 * - Text state: Tf, Tc, Tw, Tz, TL, Ts, Tr
 * - Text positioning: Td, TD, Tm, T*
 * - Text showing: Tj, TJ, ', "
 * - Text objects: BT, ET
 * - Graphics state: q, Q, cm, gs, i, M, ri, W, W*
 * - Color: CS, cs, SC, sc, SCN, scn
 * - Marked content: BDC, BMC, EMC, MP, DP
 * - Type3 glyph: d0, d1
 * - Shading: sh
 * - Inline images: BI/ID/EI
 * - XObject invocation: Do (for form XObjects containing text)
 *
 * @see PDF Reference 1.7, Chapter 5 - Text
 * @see PDF Reference 1.7, Chapter 4 - Graphics
 */

import {
  resolveFont,
  decodeText,
  getCharWidth,
  splitCharacterCodes
} from "@pdf/reader/font-decoder";
import type { ResolvedFont } from "@pdf/reader/font-decoder";
import type { PdfDocument } from "@pdf/reader/pdf-document";
import type { PdfDictValue, PdfObject } from "@pdf/reader/pdf-parser";
import { isPdfRef, isPdfArray, dictGetName, dictGetArray } from "@pdf/reader/pdf-parser";
import { PdfTokenizer, TokenType } from "@pdf/reader/pdf-tokenizer";
import type { Token } from "@pdf/reader/pdf-tokenizer";

// =============================================================================
// Constants
// =============================================================================

/** Maximum Form XObject nesting depth to prevent infinite recursion */
const MAX_FORM_DEPTH = 10;

/** Cached TextEncoder instance */
const _textEncoder = new TextEncoder();

// =============================================================================
// Types
// =============================================================================

/**
 * A text fragment extracted from a PDF page.
 * Contains the text string and its position in page coordinates.
 */
export interface TextFragment {
  /** The extracted text */
  text: string;
  /** X position in page coordinates (points, origin = bottom-left) */
  x: number;
  /** Y position in page coordinates */
  y: number;
  /** Font size in points */
  fontSize: number;
  /** Font name */
  fontName: string;
  /** Width of the text in points */
  width: number;
  /** Character spacing */
  charSpacing: number;
  /** Word spacing */
  wordSpacing: number;
  /** Horizontal scaling factor (100 = normal) */
  horizontalScaling: number;
  /** Whether the text is vertical (WMode=1) */
  isVertical: boolean;
  /** Whether the text is right-to-left (Arabic, Hebrew, etc.) */
  isRtl: boolean;
}

/**
 * Graphics state stack entry.
 */
interface GraphicsState {
  /** Current transformation matrix [a, b, c, d, e, f] */
  ctm: number[];
  /** Text state */
  textState: TextState;
}

/**
 * Text state parameters.
 */
interface TextState {
  /** Character spacing (Tc) */
  charSpacing: number;
  /** Word spacing (Tw) */
  wordSpacing: number;
  /** Horizontal scaling in percent (Tz) */
  horizontalScaling: number;
  /** Text leading (TL) */
  leading: number;
  /** Current font */
  font: ResolvedFont | null;
  /** Current font size */
  fontSize: number;
  /** Text rendering mode (Tr) */
  renderMode: number;
  /** Text rise (Ts) */
  rise: number;
}

// =============================================================================
// RTL Detection
// =============================================================================

/**
 * Check if a character code point is in an RTL Unicode range.
 */
function isRtlChar(codePoint: number): boolean {
  return (
    // Arabic (0600–06FF)
    (codePoint >= 0x0600 && codePoint <= 0x06ff) ||
    // Arabic Supplement (0750–077F)
    (codePoint >= 0x0750 && codePoint <= 0x077f) ||
    // Arabic Extended-A (08A0–08FF)
    (codePoint >= 0x08a0 && codePoint <= 0x08ff) ||
    // Arabic Presentation Forms-A (FB50–FDFF)
    (codePoint >= 0xfb50 && codePoint <= 0xfdff) ||
    // Arabic Presentation Forms-B (FE70–FEFF)
    (codePoint >= 0xfe70 && codePoint <= 0xfeff) ||
    // Hebrew (0590–05FF)
    (codePoint >= 0x0590 && codePoint <= 0x05ff) ||
    // Hebrew Presentation Forms (FB1D–FB4F)
    (codePoint >= 0xfb1d && codePoint <= 0xfb4f) ||
    // Syriac (0700–074F)
    (codePoint >= 0x0700 && codePoint <= 0x074f) ||
    // Thaana (0780–07BF)
    (codePoint >= 0x0780 && codePoint <= 0x07bf) ||
    // NKo (07C0–07FF)
    (codePoint >= 0x07c0 && codePoint <= 0x07ff)
  );
}

/**
 * Check if the first character of a string is in an RTL Unicode range.
 */
function detectRtl(text: string): boolean {
  if (text.length === 0) {
    return false;
  }
  const codePoint = text.codePointAt(0);
  return codePoint !== undefined && isRtlChar(codePoint);
}

// =============================================================================
// Content Stream Interpreter
// =============================================================================

/**
 * Extract text fragments from a page's content stream(s).
 */
export function extractTextFromPage(pageDict: PdfDictValue, doc: PdfDocument): TextFragment[] {
  // Resolve page resources (centralized with cycle protection)
  const resources = doc.resolvePageResources(pageDict);
  const fonts = resolveFontResources(resources, doc);

  // Get content stream(s)
  const contentStreams = getContentStreams(pageDict, doc);
  if (contentStreams.length === 0) {
    return [];
  }

  const fragments: TextFragment[] = [];
  const interpreter = new ContentInterpreter(fonts, doc, resources);

  for (const streamData of contentStreams) {
    interpreter.process(streamData, fragments);
  }

  return fragments;
}

/**
 * Resolve all font resources for a page.
 */
function resolveFontResources(
  resources: PdfDictValue,
  doc: PdfDocument
): Map<string, ResolvedFont> {
  const fonts = new Map<string, ResolvedFont>();
  const fontDict = resources.get("Font");
  if (!fontDict) {
    return fonts;
  }

  const resolvedFontDict = doc.derefDict(fontDict);
  if (!resolvedFontDict) {
    return fonts;
  }

  for (const [name, ref] of resolvedFontDict) {
    const fd = doc.derefDict(ref);
    if (fd) {
      try {
        fonts.set(name, resolveFont(fd, doc));
      } catch {
        // Skip invalid fonts
      }
    }
  }

  return fonts;
}

/**
 * Get decoded content stream data for a page.
 * Handles both single stream and array of streams.
 */
function getContentStreams(pageDict: PdfDictValue, doc: PdfDocument): Uint8Array[] {
  const contents = pageDict.get("Contents");
  if (!contents) {
    return [];
  }

  if (isPdfRef(contents)) {
    const result = doc.derefStreamWithObjNum(contents);
    if (result) {
      return [doc.getStreamData(result.stream, result.objNum, result.gen)];
    }
    const resolved = doc.deref(contents);
    if (isPdfArray(resolved)) {
      return resolveStreamArray(resolved, doc);
    }
    return [];
  }

  if (isPdfArray(contents)) {
    return resolveStreamArray(contents, doc);
  }

  // Note: a direct PdfStream inside the page dict (not via ref) is technically
  // invalid per the spec — Contents must be an indirect reference or array of refs.
  // We don't handle it because we can't determine the correct objNum/gen for decryption.
  return [];
}

function resolveStreamArray(arr: PdfObject[], doc: PdfDocument): Uint8Array[] {
  const result: Uint8Array[] = [];
  for (const item of arr) {
    const r = doc.derefStreamWithObjNum(item);
    if (r) {
      result.push(doc.getStreamData(r.stream, r.objNum, r.gen));
    }
  }
  return result;
}

// =============================================================================
// Content Interpreter
// =============================================================================

class ContentInterpreter {
  private fonts: Map<string, ResolvedFont>;
  private doc: PdfDocument;
  private resources: PdfDictValue;

  // Graphics state
  private stateStack: GraphicsState[] = [];
  private ctm: number[] = [1, 0, 0, 1, 0, 0];

  // Text state
  private textState: TextState = {
    charSpacing: 0,
    wordSpacing: 0,
    horizontalScaling: 100,
    leading: 0,
    font: null,
    fontSize: 0,
    renderMode: 0,
    rise: 0
  };

  // Text object state
  private textMatrix: number[] = [1, 0, 0, 1, 0, 0];
  private lineMatrix: number[] = [1, 0, 0, 1, 0, 0];
  private inTextObject = false;
  // Form XObject recursion depth
  private formDepth = 0;

  constructor(fonts: Map<string, ResolvedFont>, doc: PdfDocument, resources: PdfDictValue) {
    this.fonts = fonts;
    this.doc = doc;
    this.resources = resources;
  }

  process(streamData: Uint8Array, fragments: TextFragment[]): void {
    const tokenizer = new PdfTokenizer(streamData);
    const operands: PdfOperand[] = [];

    while (true) {
      const token = tokenizer.next();
      if (token.type === TokenType.EOF) {
        break;
      }

      if (token.type === TokenType.Keyword) {
        const keyword = token.strValue!;

        // Handle inline image: BI ... ID <data> EI
        if (keyword === "BI") {
          this.skipInlineImage(tokenizer);
          operands.length = 0;
        } else {
          this.executeOperator(keyword, operands, fragments);
          operands.length = 0;
        }
      } else if (token.type === TokenType.ArrayBegin) {
        // Parse array inline (for TJ operator)
        operands.push(this.parseInlineArray(tokenizer));
      } else {
        operands.push(tokenToOperand(token));
      }
    }
  }

  /**
   * Skip an inline image in the content stream.
   *
   * Inline images have the form: BI <key-value pairs> ID <image data> EI
   * We need to parse past the key-value pairs (which the tokenizer handles),
   * skip the single whitespace byte after ID, then scan for the EI marker.
   */
  private skipInlineImage(tokenizer: PdfTokenizer): void {
    // Phase 1: Read key-value pairs until we encounter the ID keyword
    while (true) {
      const tok = tokenizer.next();
      if (tok.type === TokenType.EOF) {
        return;
      }
      if (tok.type === TokenType.Keyword && tok.strValue === "ID") {
        break;
      }
      // Just consume the token (key-value pairs) — we don't need them
    }

    // Phase 2: Skip one whitespace byte after ID (per PDF spec)
    const data = tokenizer.bytes;
    let pos = tokenizer.position;

    if (pos < data.length) {
      // The byte immediately after ID should be a single whitespace byte
      pos++;
    }

    // Phase 3: Scan forward for EI preceded by whitespace
    // EI is 0x45 0x49, and must be preceded by whitespace and followed by
    // whitespace or EOF to distinguish from image data containing "EI"
    while (pos + 1 < data.length) {
      if (
        data[pos] === 0x45 &&
        data[pos + 1] === 0x49 &&
        pos > 0 &&
        isWhitespaceByte(data[pos - 1]) &&
        (pos + 2 >= data.length ||
          isWhitespaceByte(data[pos + 2]) ||
          isDelimiterByte(data[pos + 2]))
      ) {
        // Found EI — advance past it
        tokenizer.position = pos + 2;
        return;
      }
      pos++;
    }

    // If we didn't find EI, just set position to end
    tokenizer.position = data.length;
  }

  private parseInlineArray(tokenizer: PdfTokenizer): PdfOperand[] {
    const arr: PdfOperand[] = [];
    while (true) {
      const tok = tokenizer.next();
      if (tok.type === TokenType.ArrayEnd || tok.type === TokenType.EOF) {
        break;
      }
      arr.push(tokenToOperand(tok));
    }
    return arr;
  }

  private executeOperator(op: string, operands: PdfOperand[], fragments: TextFragment[]): void {
    switch (op) {
      // ---- Graphics State ----
      case "q":
        this.saveState();
        break;
      case "Q":
        this.restoreState();
        break;
      case "cm":
        if (operands.length >= 6) {
          this.concatMatrix(nums(operands, 6));
        }
        break;

      // ---- Graphics State (no-op for text extraction) ----
      case "gs": // ExtGState
      case "i": // Flatness
      case "M": // Miter limit
      case "ri": // Rendering intent
      case "sh": // Shading
        // Consume operands, no action needed for text extraction
        break;

      // ---- Clipping (no-op) ----
      case "W": // Clipping (non-zero winding)
      case "W*": // Clipping (even-odd)
        break;

      // ---- Color Operators (no-op for text extraction) ----
      case "CS": // Set color space (stroking)
      case "cs": // Set color space (non-stroking)
      case "SC": // Set color (stroking)
      case "sc": // Set color (non-stroking)
      case "SCN": // Set color (stroking, extended)
      case "scn": // Set color (non-stroking, extended)
      case "G": // Set gray (stroking)
      case "g": // Set gray (non-stroking)
      case "RG": // Set RGB (stroking)
      case "rg": // Set RGB (non-stroking)
      case "K": // Set CMYK (stroking)
      case "k": // Set CMYK (non-stroking)
        // Consume operands, no action needed
        break;

      // ---- Marked Content (no-op for text extraction) ----
      case "BDC": // Begin marked content with properties
      case "BMC": // Begin marked content
      case "EMC": // End marked content
      case "MP": // Marked content point
      case "DP": // Marked content point with properties
        break;

      // ---- Type3 Font Glyph Operators (no-op) ----
      case "d0": // Set glyph width
      case "d1": // Set glyph width and bounding box
        break;

      // ---- Path Construction/Painting (no-op for text extraction) ----
      case "m": // moveto
      case "l": // lineto
      case "c": // curveto (cubic Bézier)
      case "v": // curveto (initial point replicated)
      case "y": // curveto (final point replicated)
      case "h": // closepath
      case "re": // rectangle
      case "S": // stroke
      case "s": // close and stroke
      case "f": // fill (non-zero winding)
      case "F": // fill (non-zero winding, obsolete)
      case "f*": // fill (even-odd)
      case "B": // fill and stroke (non-zero)
      case "B*": // fill and stroke (even-odd)
      case "b": // close, fill and stroke (non-zero)
      case "b*": // close, fill and stroke (even-odd)
      case "n": // end path without fill/stroke
      case "j": // line join style
      case "J": // line cap style
      case "d": // dash pattern
      case "w": // line width
        break;

      // ---- Text State ----
      case "Tc":
        this.textState.charSpacing = num(operands, 0);
        break;
      case "Tw":
        this.textState.wordSpacing = num(operands, 0);
        break;
      case "Tz":
        this.textState.horizontalScaling = num(operands, 0);
        break;
      case "TL":
        this.textState.leading = num(operands, 0);
        break;
      case "Tf":
        this.setFont(operands);
        break;
      case "Tr":
        this.textState.renderMode = num(operands, 0);
        break;
      case "Ts":
        this.textState.rise = num(operands, 0);
        break;

      // ---- Text Objects ----
      case "BT":
        this.beginText();
        break;
      case "ET":
        this.inTextObject = false;
        break;

      // ---- Text Positioning ----
      case "Td":
        this.moveText(num(operands, 0), num(operands, 1));
        break;
      case "TD":
        this.textState.leading = -num(operands, 1);
        this.moveText(num(operands, 0), num(operands, 1));
        break;
      case "Tm":
        if (operands.length >= 6) {
          this.setTextMatrix(nums(operands, 6));
        }
        break;
      case "T*":
        this.moveText(0, -this.textState.leading);
        break;

      // ---- Text Showing ----
      case "Tj":
        this.showText(operands[0], fragments);
        break;
      case "TJ":
        this.showTextArray(operands[0], fragments);
        break;
      case "'":
        this.moveText(0, -this.textState.leading);
        this.showText(operands[0], fragments);
        break;
      case '"':
        this.textState.wordSpacing = num(operands, 0);
        this.textState.charSpacing = num(operands, 1);
        this.moveText(0, -this.textState.leading);
        this.showText(operands[2], fragments);
        break;

      // ---- XObject ----
      case "Do":
        this.doXObject(operands, fragments);
        break;
    }
  }

  // ===========================================================================
  // Graphics State
  // ===========================================================================

  private saveState(): void {
    this.stateStack.push({
      ctm: [...this.ctm],
      textState: { ...this.textState }
    });
  }

  private restoreState(): void {
    const state = this.stateStack.pop();
    if (state) {
      this.ctm = state.ctm;
      this.textState = state.textState;
    }
  }

  private concatMatrix(m: number[]): void {
    this.ctm = multiplyMatrices(m, this.ctm);
  }

  // ===========================================================================
  // Text State
  // ===========================================================================

  private setFont(operands: PdfOperand[]): void {
    if (operands.length < 2) {
      return;
    }
    const fontName = typeof operands[0] === "string" ? operands[0] : String(operands[0]);
    const fontSize = typeof operands[1] === "number" ? operands[1] : 0;

    this.textState.font = this.fonts.get(fontName) ?? null;
    this.textState.fontSize = fontSize;
  }

  private beginText(): void {
    this.inTextObject = true;
    this.textMatrix = [1, 0, 0, 1, 0, 0];
    this.lineMatrix = [1, 0, 0, 1, 0, 0];
  }

  private moveText(tx: number, ty: number): void {
    const m = [1, 0, 0, 1, tx, ty];
    this.lineMatrix = multiplyMatrices(m, this.lineMatrix);
    this.textMatrix = [...this.lineMatrix];
  }

  private setTextMatrix(m: number[]): void {
    this.textMatrix = [...m];
    this.lineMatrix = [...m];
  }

  // ===========================================================================
  // Text Showing
  // ===========================================================================

  private showText(operand: PdfOperand | undefined, fragments: TextFragment[]): void {
    if (operand === undefined || !this.textState.font) {
      return;
    }

    let bytes: Uint8Array;
    if (operand instanceof Uint8Array) {
      bytes = operand;
    } else if (typeof operand === "string") {
      bytes = _textEncoder.encode(operand);
    } else {
      return;
    }

    const font = this.textState.font;
    const text = decodeText(bytes, font);

    if (text.length === 0) {
      return;
    }

    // Calculate position using text matrix and CTM
    const tm = multiplyMatrices(this.textMatrix, this.ctm);
    const x = tm[4];
    const y = tm[5];
    const fontSize = this.textState.fontSize * Math.sqrt(tm[0] * tm[0] + tm[1] * tm[1]);

    // Calculate text width
    const width = this.calculateTextWidth(bytes, font);

    // Determine vertical text: check if font has WMode=1
    const isVertical = (font as ResolvedFont & { wmode?: number }).wmode === 1;

    // Determine RTL: check the first character of the decoded text
    const isRtl = detectRtl(text);

    fragments.push({
      text,
      x,
      y,
      fontSize: Math.abs(fontSize),
      fontName: font.baseFontName,
      width,
      charSpacing: this.textState.charSpacing,
      wordSpacing: this.textState.wordSpacing,
      horizontalScaling: this.textState.horizontalScaling,
      isVertical,
      isRtl
    });

    // Advance text matrix
    this.advanceTextPosition(bytes, font);
  }

  private showTextArray(operand: PdfOperand | undefined, fragments: TextFragment[]): void {
    if (operand === undefined || !Array.isArray(operand)) {
      return;
    }

    for (const item of operand) {
      if (typeof item === "number") {
        // Negative number = move right, positive = move left (in thousandths of text space unit)
        const displacement =
          (-item / 1000) * this.textState.fontSize * (this.textState.horizontalScaling / 100);
        this.textMatrix[4] += displacement * this.textMatrix[0];
        this.textMatrix[5] += displacement * this.textMatrix[1];
      } else {
        this.showText(item, fragments);
      }
    }
  }

  private calculateTextWidth(bytes: Uint8Array, font: ResolvedFont): number {
    let width = 0;
    const scale = this.textState.fontSize * (this.textState.horizontalScaling / 100);

    // Same code splitting as text extraction, so widths and decoded characters
    // can never disagree about byte boundaries.
    for (const code of splitCharacterCodes(bytes, font)) {
      width += (getCharWidth(code, font) / 1000) * scale + this.textState.charSpacing;
      if (code === 0x0020) {
        width += this.textState.wordSpacing;
      }
    }

    return width;
  }

  private advanceTextPosition(bytes: Uint8Array, font: ResolvedFont): void {
    const width = this.calculateTextWidth(bytes, font);
    // Advance text matrix by the width of the rendered text
    this.textMatrix[4] += width * this.textMatrix[0];
    this.textMatrix[5] += width * this.textMatrix[1];
  }

  // ===========================================================================
  // XObject Handling (Form XObjects may contain text)
  // ===========================================================================

  private doXObject(operands: PdfOperand[], fragments: TextFragment[]): void {
    if (operands.length < 1) {
      return;
    }
    // Guard against infinite recursion from self-referencing Form XObjects
    if (this.formDepth >= MAX_FORM_DEPTH) {
      return;
    }
    const name = typeof operands[0] === "string" ? operands[0] : String(operands[0]);

    // Look up XObject in resources
    const xobjects = this.resources.get("XObject");
    if (!xobjects) {
      return;
    }
    const xobjDict = this.doc.derefDict(xobjects);
    if (!xobjDict) {
      return;
    }
    const xobj = xobjDict.get(name);
    if (!xobj) {
      return;
    }

    const streamResult = this.doc.derefStreamWithObjNum(xobj);
    if (!streamResult) {
      return;
    }

    const stream = streamResult.stream;
    const streamDict = stream.dict;
    const subtype = dictGetName(streamDict, "Subtype");
    if (subtype !== "Form") {
      return;
    }

    // Process form XObject — it has its own resources and content stream
    const formResources = streamDict.get("Resources");
    const resolvedResources = formResources
      ? (this.doc.derefDict(formResources) ?? this.resources)
      : this.resources;

    // Resolve fonts from form's resources
    const formFonts = resolveFontResources(resolvedResources, this.doc);

    // Merge with page fonts
    const mergedFonts = new Map(this.fonts);
    for (const [k, v] of formFonts) {
      mergedFonts.set(k, v);
    }

    // Process form content with saved state
    const savedFonts = this.fonts;
    this.fonts = mergedFonts;

    // Apply form matrix if present
    const matrix = dictGetArray(streamDict, "Matrix");
    if (matrix && matrix.length === 6) {
      this.saveState();
      this.concatMatrix(matrix as number[]);
    }

    const formData = this.doc.getStreamData(stream, streamResult.objNum, streamResult.gen);
    this.formDepth++;
    this.process(formData, fragments);
    this.formDepth--;

    if (matrix && matrix.length === 6) {
      this.restoreState();
    }

    this.fonts = savedFonts;
  }
}

// =============================================================================
// Inline Image Helpers
// =============================================================================

/** Check if a byte is PDF whitespace */
function isWhitespaceByte(b: number): boolean {
  return b === 0x00 || b === 0x09 || b === 0x0a || b === 0x0d || b === 0x0c || b === 0x20;
}

/** Check if a byte is a PDF delimiter */
function isDelimiterByte(b: number): boolean {
  return (
    b === 0x28 || // (
    b === 0x29 || // )
    b === 0x3c || // <
    b === 0x3e || // >
    b === 0x5b || // [
    b === 0x5d || // ]
    b === 0x7b || // {
    b === 0x7d || // }
    b === 0x2f || // /
    b === 0x25 // %
  );
}

// =============================================================================
// Operand Helpers
// =============================================================================

type PdfOperand = number | string | boolean | null | Uint8Array | PdfOperand[];

function tokenToOperand(token: Token): PdfOperand {
  switch (token.type) {
    case TokenType.Number:
      return token.numValue ?? 0;
    case TokenType.Name:
      return token.strValue ?? "";
    case TokenType.LiteralString:
    case TokenType.HexString:
      return token.rawBytes ?? new Uint8Array(0);
    case TokenType.Boolean:
      return token.boolValue ?? false;
    case TokenType.Null:
      return null;
    case TokenType.ArrayBegin:
      // This shouldn't happen — arrays should be parsed before reaching here
      return [];
    default:
      return token.strValue ?? null;
  }
}

function num(operands: PdfOperand[], index: number): number {
  const val = operands[index];
  return typeof val === "number" ? val : 0;
}

function nums(operands: PdfOperand[], count: number): number[] {
  const result: number[] = [];
  for (let i = 0; i < count; i++) {
    result.push(num(operands, i));
  }
  return result;
}

// =============================================================================
// Matrix Operations
// =============================================================================

/**
 * Multiply two 3x3 transformation matrices (stored as [a,b,c,d,e,f]).
 * Matrix format: [a b 0; c d 0; e f 1]
 */
function multiplyMatrices(m1: number[], m2: number[]): number[] {
  return [
    m1[0] * m2[0] + m1[1] * m2[2],
    m1[0] * m2[1] + m1[1] * m2[3],
    m1[2] * m2[0] + m1[3] * m2[2],
    m1[2] * m2[1] + m1[3] * m2[3],
    m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
    m1[4] * m2[1] + m1[5] * m2[3] + m2[5]
  ];
}
