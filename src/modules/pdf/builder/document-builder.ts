/**
 * PDF document builder — high-level API for creating PDFs with free-form content.
 *
 * Unlike the table-oriented `pdf()` function, this builder gives direct control
 * over text positioning, vector drawing, images, and page management.
 *
 * @example Basic usage:
 * ```typescript
 * import { Pdf } from "documonster/pdf";
 *
 * const doc = new Pdf.Builder();
 * const page = doc.addPage({ width: 595, height: 842 }); // A4
 *
 * page.drawText("Hello, World!", { x: 72, y: 750, fontSize: 24 });
 * page.drawRect({ x: 72, y: 700, width: 200, height: 30 });
 * page.drawCircle({ cx: 300, cy: 400, r: 50, fill: { r: 1, g: 0, b: 0 } });
 *
 * const bytes = await doc.build();
 * ```
 */

import { writeImageXObject } from "@pdf/builder/image-utils";
import { initEncryption } from "@pdf/core/encryption";
import { PdfDict, pdfRef, pdfString, pdfNumber } from "@pdf/core/pdf-object";
import { PdfContentStream } from "@pdf/core/pdf-stream";
import { PdfWriter } from "@pdf/core/pdf-writer";
import { writePdfAMetadata, writePdfAOutputIntent } from "@pdf/core/pdfa";
import { PdfError } from "@pdf/errors";
import { compilePdfFontConfig } from "@pdf/font/font-config";
import type { PdfFontConfig } from "@pdf/font/font-config";
import { FontManager } from "@pdf/font/font-manager";
import { findSystemFontForCodePoints } from "@pdf/font/system-fonts";
import { parseTtf } from "@pdf/font/ttf-parser";
import { emitTextBlock, alphaGsName } from "@pdf/render/page-renderer";
import type { PdfColor, PdfExportOptions } from "@pdf/types";
import {
  parseCssColor,
  parseSvgAttributes,
  parseSvgNumberList,
  parseSvgRotate,
  parseSvgTextRuns
} from "@utils/svg-lex";

// =============================================================================
// Types
// =============================================================================

/** Page size configuration. */
export interface PageOptions {
  /** Page width in points (72pt = 1 inch). Default: 595.28 (A4). */
  width?: number;
  /** Page height in points (72pt = 1 inch). Default: 841.89 (A4). */
  height?: number;
}

/** Text drawing options. */
export interface DrawTextOptions {
  /** X position in points (from left edge). */
  x: number;
  /** Y position in points (from bottom edge — PDF coordinate system). */
  y: number;
  /** Font size in points. Default: 12. */
  fontSize?: number;
  /** Font family name. Default: "Helvetica". */
  fontFamily?: string;
  /** Bold. Default: false. */
  bold?: boolean;
  /** Italic. Default: false. */
  italic?: boolean;
  /** Text color. Default: black. */
  color?: PdfColor;
  /** Maximum width before word-wrap. Omit for no wrap. */
  maxWidth?: number;
  /** Line height multiplier. Default: 1.2. */
  lineHeight?: number;
  /**
   * Rotation in degrees, counter-clockwise in the PDF coordinate system
   * (which has +Y pointing up, so visually clockwise on a page viewer).
   * The rotation pivot is `(x, y)`. Default: `0` (no rotation).
   *
   * Incompatible with `maxWidth` (word-wrapping + rotation requires per-
   * line matrix transforms that the current implementation does not
   * support — supplying both leaves the wrap ignoring rotation so the
   * text remains readable). If you need rotated wrapped text, break it
   * into lines yourself and call `drawText` per line.
   */
  rotation?: number;
  /**
   * Horizontal alignment of the text around `x`. Default: `"start"`
   * (the conventional PDF behaviour where `x` is the baseline left
   * edge). Implemented by pre-shifting `x` using the chosen font's
   * measured width — no deferred layout, so the computed position is
   * stable across font subsetting.
   */
  anchor?: "start" | "middle" | "end";
}

/** Rectangle drawing options. */
export interface DrawRectOptions {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Fill color. Omit for no fill. */
  fill?: PdfColor;
  /** Stroke color. Omit for no stroke. */
  stroke?: PdfColor;
  /** Line width for stroke. Default: 1. */
  lineWidth?: number;
  /** Corner radius for rounded rectangles. Default: 0. */
  borderRadius?: number;
}

/** Circle drawing options. */
export interface DrawCircleOptions {
  /** Center X. */
  cx: number;
  /** Center Y. */
  cy: number;
  /** Radius. */
  r: number;
  /** Fill color. Omit for no fill. */
  fill?: PdfColor;
  /** Stroke color. Omit for no stroke. */
  stroke?: PdfColor;
  /** Line width for stroke. Default: 1. */
  lineWidth?: number;
}

/** Ellipse drawing options. */
export interface DrawEllipseOptions {
  /** Center X. */
  cx: number;
  /** Center Y. */
  cy: number;
  /** Horizontal radius. */
  rx: number;
  /** Vertical radius. */
  ry: number;
  /** Fill color. Omit for no fill. */
  fill?: PdfColor;
  /** Stroke color. Omit for no stroke. */
  stroke?: PdfColor;
  /** Line width for stroke. Default: 1. */
  lineWidth?: number;
}

/** Line drawing options. */
export interface DrawLineOptions extends StrokeShapeOptions {
  /** Start X. */
  x1: number;
  /** Start Y. */
  y1: number;
  /** End X. */
  x2: number;
  /** End Y. */
  y2: number;
  /** Stroke color. Default: black. */
  color?: PdfColor;
  /** Line width. Default: 1. */
  lineWidth?: number;
  /** Dash pattern. Default: solid. */
  dashPattern?: number[];
}

/**
 * How a stroke's corners and ends are shaped.
 *
 * `j` and `J` have always been available in the content stream; these were simply
 * not reachable from the builder, so a caller who wanted a rounded polyline — a
 * smoothed line chart, for instance — got mitred corners and flat ends.
 */
export interface StrokeShapeOptions {
  /** Corner shape where two segments meet. Default: `"miter"`. */
  lineJoin?: "miter" | "round" | "bevel";
  /** End shape of an open stroke. Default: `"butt"`. */
  lineCap?: "butt" | "round" | "square";
}

/** Path drawing options. */
export interface DrawPathOptions extends StrokeShapeOptions {
  /**
   * Winding rule for the fill. Defaults to `"nonzero"`, as PDF and SVG both do.
   *
   * It matters for a compound path — a ring, a shape with a hole, a self-intersecting
   * outline — where the two rules describe different regions.
   */
  fillRule?: "nonzero" | "evenodd";
  /**
   * Dash pattern for the stroke. Solid when omitted.
   *
   * `drawLine` has always carried one, but a path had no way to express it, so a dashed
   * polyline of three or more points — a chart's connector lines, a leader — came out
   * solid in a PDF while SVG and the rasteriser dashed it.
   */
  dashPattern?: number[];
  /** Fill color. Omit for no fill. */
  fill?: PdfColor;
  /** Stroke color. Omit for no stroke. */
  stroke?: PdfColor;
  /** Line width. Default: 1. */
  lineWidth?: number;
  /** Close the path before painting. Default: false. */
  closePath?: boolean;
}

/** A point in a path. */
export type PathOp =
  | { op: "move"; x: number; y: number }
  | { op: "line"; x: number; y: number }
  | {
      op: "curve";
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      x3: number;
      y3: number;
    }
  | { op: "close" };

/** Image drawing options. */
export interface DrawImageOptions {
  /** Raw image bytes. */
  data: Uint8Array;
  /** Image format. */
  format: "jpeg" | "png";
  /** X position. */
  x: number;
  /** Y position (bottom edge of image in PDF coordinates). */
  y: number;
  /** Display width in points. */
  width: number;
  /** Display height in points. */
  height: number;
}

/** Options for drawing a simple SVG document onto a PDF page. */
export interface DrawSvgOptions {
  /** Raw SVG markup. */
  svg: string;
  /** Destination X position in points. */
  x: number;
  /** Destination Y position in points. */
  y: number;
  /** Destination width in points. If omitted, uses the SVG width/viewBox width. */
  width?: number;
  /** Destination height in points. If omitted, uses the SVG height/viewBox height. */
  height?: number;
}

/**
 * How much of the SVG feature set `drawSvg` understands.
 *
 * Supported: `rect` (incl. percentage sizes), `line`, `circle`, `ellipse`,
 * `polyline`, `polygon`, `path` (all commands), `text` with `tspan`,
 * `text-anchor`, `font-family` / `font-weight` / `font-style` and a
 * `rotate()` transform; `fill` / `stroke` with CSS colours including
 * `#RRGGBBAA` and `rgb()` / `rgba()`; `fill-opacity`, `stroke-opacity`,
 * `opacity`, `stroke-width`; `viewBox` with `preserveAspectRatio`.
 *
 * Not supported, and silently ignored: `<g>` and element `transform` other
 * than `rotate()`, `style` / CSS, `clipPath`, `mask`, `filter`, gradients and
 * patterns, `stroke-dasharray`, `stroke-linecap` / `stroke-linejoin`,
 * `fill-rule`, `use`, `image`, and nested `<svg>`. Input is expected to be the
 * chart engine's own output or comparably simple markup.
 */

/** Document metadata. */
export interface DocumentMetadata {
  title?: string;
  author?: string;
  subject?: string;
  creator?: string;
}

/** Document-wide options. Fonts are compiled before any page text is drawn. */
export interface PdfDocumentBuilderOptions {
  /**
   * Font families available to all pages. This is equivalent to calling
   * `embedFonts()` before the first text command.
   */
  readonly fonts?: PdfFontConfig;
}

/** Options for table of contents generation. */
export interface TocOptions {
  /** Title displayed at the top of the TOC page. Default: "Table of Contents". */
  title?: string;
  /** Font size for TOC entries in points. Default: 12. */
  fontSize?: number;
  /** Indentation in points per nesting level. Default: 20. */
  indent?: number;
}

/** @internal Bookmark node stored during document construction. */
interface BookmarkNode {
  /** Bookmark display title. */
  title: string;
  /** Zero-based page index this bookmark points to. */
  pageIndex: number;
  /** Child bookmarks. */
  children: BookmarkNode[];
}

/** @internal Link annotation recorded on a page for build-time serialization. */
interface PageAnnotation {
  /** Rectangle [x1, y1, x2, y2] in PDF coordinates. */
  rect: [number, number, number, number];
  /** Zero-based page index to link to. */
  destPageIndex: number;
}

// =============================================================================
// Annotation Types (for builder-created annotations)
// =============================================================================

/** Annotation types that can be created via the builder API. */
export type AnnotationType =
  | "Highlight"
  | "Underline"
  | "StrikeOut"
  | "Squiggly"
  | "Text"
  | "FreeText"
  | "Stamp";

/** Options for text markup annotations (Highlight, Underline, StrikeOut, Squiggly). */
export interface TextMarkupAnnotationOptions {
  /** Annotation subtype. */
  type: "Highlight" | "Underline" | "StrikeOut" | "Squiggly";
  /** Bounding rectangle [x1, y1, x2, y2]. */
  rect: [number, number, number, number];
  /**
   * QuadPoints — four pairs of (x,y) defining the marked text region.
   * Must be groups of 8 numbers (4 corners per quad). Order per PDF spec:
   * bottom-left, bottom-right, top-left, top-right (some viewers use
   * top-left, top-right, bottom-left, bottom-right — the spec is ambiguous).
   * If omitted, defaults to the corners of `rect`.
   */
  quadPoints?: number[];
  /** Annotation color (RGB, 0–1). Default: yellow for highlight, red for others. */
  color?: PdfColor;
  /** Text contents (e.g., comment text). */
  contents?: string;
  /** Author / title. */
  author?: string;
}

/** Options for a sticky note (Text) annotation. */
export interface TextAnnotationOptions {
  type: "Text";
  /** Position — the icon appears at this point. */
  rect: [number, number, number, number];
  /** Comment text. */
  contents?: string;
  /** Author. */
  author?: string;
  /** Icon name. Default: "Note". */
  iconName?: "Comment" | "Key" | "Note" | "Help" | "NewParagraph" | "Paragraph" | "Insert";
  /** Annotation color. Default: yellow. */
  color?: PdfColor;
  /** Whether the popup is initially open. Default: false. */
  open?: boolean;
}

/** Options for a free-text annotation (in-line text). */
export interface FreeTextAnnotationOptions {
  type: "FreeText";
  /** Bounding rectangle [x1, y1, x2, y2]. */
  rect: [number, number, number, number];
  /** The displayed text. */
  contents: string;
  /** Font size. Default: 12. */
  fontSize?: number;
  /** Text color. Default: black. */
  color?: PdfColor;
  /** Border color. Omit for no border. */
  borderColor?: PdfColor;
  /** Author. */
  author?: string;
}

/** Options for a rubber stamp annotation. */
export interface StampAnnotationOptions {
  type: "Stamp";
  /** Bounding rectangle [x1, y1, x2, y2]. */
  rect: [number, number, number, number];
  /** Standard stamp name. */
  stampName?:
    | "Approved"
    | "Experimental"
    | "NotApproved"
    | "AsIs"
    | "Expired"
    | "NotForPublicRelease"
    | "Confidential"
    | "Final"
    | "Sold"
    | "Departmental"
    | "ForComment"
    | "TopSecret"
    | "Draft"
    | "ForPublicRelease";
  /** Annotation color. */
  color?: PdfColor;
  /** Comment text. */
  contents?: string;
  /** Author. */
  author?: string;
}

/** Union of all annotation option types. */
export type AnnotationOptions =
  | TextMarkupAnnotationOptions
  | TextAnnotationOptions
  | FreeTextAnnotationOptions
  | StampAnnotationOptions;

/** @internal Stored annotation for build-time serialization. */
interface BuilderAnnotation {
  subtype: string;
  rect: [number, number, number, number];
  entries: Array<[string, string]>;
}

// =============================================================================
// Form Field Types (for builder-created forms)
// =============================================================================

/** Common options shared by all form field types. */
interface FormFieldBaseOptions {
  /** Fully qualified field name (e.g., "form.name"). */
  name: string;
  /** Bounding rectangle [x1, y1, x2, y2]. */
  rect: [number, number, number, number];
  /** Default value. */
  value?: string;
  /** Read-only. Default: false. */
  readOnly?: boolean;
  /** Required. Default: false. */
  required?: boolean;
}

/** Options for creating a text input field. */
export interface TextFieldOptions extends FormFieldBaseOptions {
  type: "text";
  /** Maximum character count. Omit for unlimited. */
  maxLength?: number;
  /** Multiline. Default: false. */
  multiline?: boolean;
  /** Password field (masked input). Default: false. */
  password?: boolean;
}

/** Options for creating a checkbox. */
export interface CheckboxOptions extends FormFieldBaseOptions {
  type: "checkbox";
  /** Whether initially checked. Default: false. */
  checked?: boolean;
}

/** Options for creating a dropdown (combo box). */
export interface DropdownOptions extends FormFieldBaseOptions {
  type: "dropdown";
  /** Available options. */
  options: string[];
  /** Allow typing a custom value. Default: false. */
  editable?: boolean;
}

/** Options for creating a radio button group. */
export interface RadioGroupOptions {
  type: "radio";
  /** Fully qualified field name for the group. */
  name: string;
  /** Individual radio buttons. */
  buttons: Array<{
    /** Bounding rectangle. */
    rect: [number, number, number, number];
    /** Export value for this button. */
    value: string;
  }>;
  /** Initially selected value. */
  selected?: string;
  /** Read-only. Default: false. */
  readOnly?: boolean;
  /** Required. Default: false. */
  required?: boolean;
}

/** Union of all form field creation options. */
export type FormFieldOptions =
  | TextFieldOptions
  | CheckboxOptions
  | DropdownOptions
  | RadioGroupOptions;

/** @internal Stored form field for build-time serialization. */
interface BuilderFormField {
  options: FormFieldOptions;
}

// =============================================================================
// Signature Options
// =============================================================================

/** Options for digitally signing a PDF. */
export interface PdfSignatureOptions {
  /** DER-encoded X.509 certificate. */
  certificate: Uint8Array;
  /** DER-encoded PKCS#8 private key. */
  privateKey: Uint8Array;
  /** Signer name (displayed in PDF viewers). */
  name?: string;
  /** Reason for signing. */
  reason?: string;
  /** Location of signing. */
  location?: string;
  /** Contact info. */
  contactInfo?: string;
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_PAGE_WIDTH = 595.28; // A4
const DEFAULT_PAGE_HEIGHT = 841.89; // A4
const DEFAULT_FONT_SIZE = 12;
const DEFAULT_LINE_HEIGHT = 1.2;
const BLACK: PdfColor = { r: 0, g: 0, b: 0 };

// =============================================================================
// PdfPageBuilder
// =============================================================================

/**
 * Builder for a single PDF page.
 *
 * Provides methods for drawing text, shapes, and images at arbitrary positions.
 * All coordinates use PDF's coordinate system: origin at bottom-left, Y increases upward.
 */
export class PdfPageBuilder {
  /** @internal */
  readonly _stream = new PdfContentStream();
  /** @internal */
  readonly _width: number;
  /** @internal */
  readonly _height: number;
  /** @internal */
  readonly _images: DrawImageOptions[] = [];
  /** @internal */
  readonly _annotations: PageAnnotation[] = [];
  /** @internal */
  readonly _builderAnnotations: BuilderAnnotation[] = [];
  /** @internal */
  readonly _formFields: BuilderFormField[] = [];
  /** @internal */
  _fontManager: FontManager;
  /** @internal — once text exists its request resources belong to this manager. */
  _hasText = false;
  /**
   * Alpha values < 1 encountered during painting; each is materialised as
   * one `/ExtGState` object in the page resource dictionary and applied
   * via `setGraphicsState` before the corresponding colour draw. Empty
   * set = no ExtGState entry needed in Resources (keeps the common
   * opacity-1 case byte-identical with the pre-alpha implementation).
   * @internal
   */
  readonly _alphaValues = new Set<number>();
  /** @internal — isolates resources when this page is overlaid onto another PDF. */
  readonly _resourcePrefix: string;

  /** @internal */
  constructor(width: number, height: number, fontManager: FontManager, resourcePrefix = "") {
    this._width = width;
    this._height = height;
    this._fontManager = fontManager;
    this._resourcePrefix = resourcePrefix;
  }

  /** Page width in points. */
  get width(): number {
    return this._width;
  }

  /** Page height in points. */
  get height(): number {
    return this._height;
  }

  // ===========================================================================
  // Text
  // ===========================================================================

  /**
   * Draw text at a specific position.
   *
   * @param text - The text string to draw
   * @param options - Position, font, color, etc.
   */
  drawText(text: string, options: DrawTextOptions): this {
    if (text.length === 0) {
      return this;
    }
    this._hasText = true;
    const fontSize = options.fontSize ?? DEFAULT_FONT_SIZE;
    const color = options.color ?? BLACK;
    const lineHeightFactor = options.lineHeight ?? DEFAULT_LINE_HEIGHT;
    const bold = options.bold ?? false;
    const italic = options.italic ?? false;
    const fontFamily = options.fontFamily ?? "Helvetica";

    // The text fragment owns its unresolved font request and preflight intent,
    // so build snapshots can collect every glyph without draw-time mutation of
    // the font manager. The block stays deferred so alignment,
    // word wrapping, and glyph encoding are all computed at build time —
    // after fonts are finalised (a non-WinAnsi run may trigger a build-time
    // auto-embed of a system CIDFont). Measuring against the provisional
    // metrics here would misplace anchored text and break lines wrongly.
    this._stream.save();
    this._applyAlpha(color.a);
    this._stream.setFillColor(color);
    emitTextBlock(
      this._stream,
      {
        text,
        x: options.x,
        y: options.y,
        fontFamily,
        bold,
        italic,
        fontSize,
        anchor: options.anchor ?? "start",
        maxWidth: options.maxWidth,
        lineHeightFactor,
        rotation: options.rotation ?? 0
      },
      this._fontManager
    );
    this._stream.restore();

    return this;
  }

  /**
   * Measure text width in points.
   */
  measureText(
    text: string,
    options?: {
      fontSize?: number;
      fontFamily?: string;
      bold?: boolean;
      italic?: boolean;
    }
  ): number {
    const fontSize = options?.fontSize ?? DEFAULT_FONT_SIZE;
    const fontFamily = options?.fontFamily ?? "Helvetica";
    const bold = options?.bold ?? false;
    const italic = options?.italic ?? false;
    return this._fontManager.measureTextRequest(text, fontFamily, bold, italic, fontSize);
  }

  // ===========================================================================
  // Shapes
  // ===========================================================================

  /**
   * Draw a rectangle (filled and/or stroked).
   */
  drawRect(options: DrawRectOptions): this {
    this._stream.save();
    const buildPath = (): void => {
      if (options.borderRadius && options.borderRadius > 0) {
        this._stream.roundedRect(
          options.x,
          options.y,
          options.width,
          options.height,
          options.borderRadius
        );
      } else {
        this._stream.rect(options.x, options.y, options.width, options.height);
      }
    };
    buildPath();
    this._paintPath(options.fill, options.stroke, options.lineWidth, "nonzero", buildPath);
    this._stream.restore();
    return this;
  }

  /**
   * Draw a circle (filled and/or stroked).
   */
  drawCircle(options: DrawCircleOptions): this {
    this._stream.save();
    const buildCircle = (): void => {
      this._stream.circle(options.cx, options.cy, options.r);
    };
    buildCircle();
    this._paintPath(options.fill, options.stroke, options.lineWidth, "nonzero", buildCircle);
    this._stream.restore();
    return this;
  }

  /**
   * Draw an ellipse (filled and/or stroked).
   */
  drawEllipse(options: DrawEllipseOptions): this {
    this._stream.save();
    const buildEllipse = (): void => {
      this._stream.ellipse(options.cx, options.cy, options.rx, options.ry);
    };
    buildEllipse();
    this._paintPath(options.fill, options.stroke, options.lineWidth, "nonzero", buildEllipse);
    this._stream.restore();
    return this;
  }

  /**
   * Draw a straight line.
   */
  drawLine(options: DrawLineOptions): this {
    const color = options.color ?? BLACK;
    const lineWidth = options.lineWidth ?? 1;

    this._stream.save();
    this._applyAlpha(color.a);
    this._stream.setStrokeColor(color);
    this._stream.setLineWidth(lineWidth);
    this._applyStrokeShape(options);
    if (options.dashPattern && options.dashPattern.length > 0) {
      this._stream.setDashPattern(options.dashPattern);
    }
    this._stream.moveTo(options.x1, options.y1);
    this._stream.lineTo(options.x2, options.y2);
    this._stream.stroke();
    this._stream.restore();
    return this;
  }

  /**
   * Draw a complex path from a list of path operations.
   */
  drawPath(ops: PathOp[], options?: DrawPathOptions): this {
    this._stream.save();

    const applyPathState = (): void => {
      if (!options) {
        return;
      }
      this._applyStrokeShape(options);
      if (options.dashPattern && options.dashPattern.length > 0) {
        this._stream.setDashPattern(options.dashPattern);
      }
    };
    const emitOps = (): void => {
      for (const op of ops) {
        switch (op.op) {
          case "move":
            this._stream.moveTo(op.x, op.y);
            break;
          case "line":
            this._stream.lineTo(op.x, op.y);
            break;
          case "curve":
            this._stream.curveTo(op.x1, op.y1, op.x2, op.y2, op.x3, op.y3);
            break;
          case "close":
            this._stream.closePath();
            break;
        }
      }
    };
    applyPathState();
    emitOps();

    if (options?.closePath) {
      this._stream.closePath();
    }

    const rebuild = (): void => {
      applyPathState();
      emitOps();
      if (options?.closePath) {
        this._stream.closePath();
      }
    };
    this._paintPath(
      options?.fill,
      options?.stroke,
      options?.lineWidth,
      options?.fillRule ?? "nonzero",
      rebuild
    );
    this._stream.restore();
    return this;
  }

  // ===========================================================================
  // Images
  // ===========================================================================

  /**
   * Draw an image at a specific position.
   */
  drawImage(options: DrawImageOptions): this {
    this._images.push(options);
    // Image drawing is deferred to build time (needs object allocation)
    // We record a placeholder name based on index
    const imgName = `${this._resourcePrefix}Im${this._images.length}`;
    this._stream.drawImage(imgName, options.x, options.y, options.width, options.height);
    return this;
  }

  // ===========================================================================
  // Annotations
  // ===========================================================================

  /**
   * Add an annotation to this page.
   *
   * Supports: Highlight, Underline, StrikeOut, Squiggly, Text (sticky note),
   * FreeText (inline text), and Stamp.
   */
  addAnnotation(options: AnnotationOptions): this {
    const entries: Array<[string, string]> = [];

    switch (options.type) {
      case "Highlight":
      case "Underline":
      case "StrikeOut":
      case "Squiggly": {
        const color =
          options.color ??
          (options.type === "Highlight" ? { r: 1, g: 1, b: 0 } : { r: 1, g: 0, b: 0 });
        entries.push(["C", `[${pdfNumber(color.r)} ${pdfNumber(color.g)} ${pdfNumber(color.b)}]`]);
        if (options.contents) {
          entries.push(["Contents", pdfString(options.contents)]);
        }
        if (options.author) {
          entries.push(["T", pdfString(options.author)]);
        }
        // QuadPoints
        const qp = options.quadPoints ?? [
          options.rect[0],
          options.rect[1],
          options.rect[2],
          options.rect[1],
          options.rect[0],
          options.rect[3],
          options.rect[2],
          options.rect[3]
        ];
        entries.push(["QuadPoints", `[${qp.map(v => pdfNumber(v)).join(" ")}]`]);
        break;
      }
      case "Text": {
        const color = options.color ?? { r: 1, g: 1, b: 0 };
        entries.push(["C", `[${pdfNumber(color.r)} ${pdfNumber(color.g)} ${pdfNumber(color.b)}]`]);
        if (options.contents) {
          entries.push(["Contents", pdfString(options.contents)]);
        }
        if (options.author) {
          entries.push(["T", pdfString(options.author)]);
        }
        entries.push(["Name", `/${options.iconName ?? "Note"}`]);
        if (options.open) {
          entries.push(["Open", "true"]);
        }
        break;
      }
      case "FreeText": {
        const fontSize = options.fontSize ?? 12;
        const color = options.color ?? BLACK;
        entries.push(["Contents", pdfString(options.contents)]);
        entries.push([
          "DA",
          pdfString(
            `/Helv ${pdfNumber(fontSize)} Tf ${pdfNumber(color.r)} ${pdfNumber(color.g)} ${pdfNumber(color.b)} rg`
          )
        ]);
        if (options.borderColor) {
          const bc = options.borderColor;
          entries.push(["C", `[${pdfNumber(bc.r)} ${pdfNumber(bc.g)} ${pdfNumber(bc.b)}]`]);
        }
        if (options.author) {
          entries.push(["T", pdfString(options.author)]);
        }
        break;
      }
      case "Stamp": {
        entries.push(["Name", `/${options.stampName ?? "Draft"}`]);
        if (options.color) {
          const c = options.color;
          entries.push(["C", `[${pdfNumber(c.r)} ${pdfNumber(c.g)} ${pdfNumber(c.b)}]`]);
        }
        if (options.contents) {
          entries.push(["Contents", pdfString(options.contents)]);
        }
        if (options.author) {
          entries.push(["T", pdfString(options.author)]);
        }
        break;
      }
    }

    this._builderAnnotations.push({
      subtype: options.type,
      rect: options.rect,
      entries
    });
    return this;
  }

  // ===========================================================================
  // Form Fields
  // ===========================================================================

  /**
   * Add a form field to this page.
   *
   * Supports: text input, checkbox, dropdown (combo box), and radio button groups.
   */
  addFormField(options: FormFieldOptions): this {
    this._formFields.push({ options });
    return this;
  }

  // ===========================================================================
  // SVG Path
  // ===========================================================================

  /**
   * Draw an SVG path from a `d` attribute string.
   *
   * Supports all SVG path commands: M, L, H, V, C, S, Q, T, A, Z
   * (both absolute and relative).
   *
   * @param d - The SVG path data string (e.g., "M10 10 L90 90 Z")
   * @param options - Fill/stroke options
   */
  drawSvgPath(d: string, options?: DrawPathOptions): this {
    const ops = parseSvgPath(d);
    return this.drawPath(ops, options);
  }

  /**
   * Draw a simple SVG document onto this page.
   *
   * Supports the SVG primitives emitted by Documonster chart rendering:
   * `rect`, `line`, `circle`, `polyline`, `polygon`, `path`, and `text`.
   */
  drawSvg(options: DrawSvgOptions): this {
    const parsed = parseSimpleSvg(options.svg);
    const destWidth = options.width ?? parsed.width;
    const destHeight = options.height ?? parsed.height;
    // Element coordinates live in the user space the `viewBox` declares, so the
    // scale is destination-over-*user*, not destination-over-root, and the user
    // origin has to be subtracted. Aspect ratio is not preserved: this API takes
    // an explicit destination box and stretches to fill it (equivalent to
    // `preserveAspectRatio="none"`), which is the predictable contract for a
    // caller that just asked for a rectangle.
    const view = resolveSvgViewport(parsed, destWidth, destHeight);
    const { scaleX, scaleY } = view;
    const mapX = (x: number) => options.x + view.offsetX + (x - parsed.userMinX) * scaleX;
    const mapY = (y: number) =>
      options.y + destHeight - view.offsetY - (y - parsed.userMinY) * scaleY;
    // `opacity` applies to both fill and stroke per SVG spec; multiply it
    // in alongside the channel-specific `fill-opacity` / `stroke-opacity`
    // so every SVG form authors emit (inline rgba, channel opacity, or
    // element-wide opacity) ends up driving `/ExtGState` consistently.
    // SVG's initial values are `fill: black` and `stroke: none`, and a missing
    // attribute is *not* the same as an explicit `none`. Treating both as
    // "undefined" and letting the PDF primitives pick their own defaults got it
    // wrong in both directions: a bare `<rect/>` came out as a black *outline*
    // (and a bare `<path/>` vanished entirely) instead of a black fill, while
    // `<line stroke="none"/>` and `<text fill="none">` were drawn in black
    // because `drawLine` / `drawText` fall back to black for a missing colour.
    const fillColor = (attrs: Record<string, string>): PdfColor | undefined => {
      const base = attrs.fill === undefined ? BLACK : svgColorToPdf(attrs.fill);
      return withSvgOpacity(withSvgOpacity(base, attrs["fill-opacity"]), attrs.opacity);
    };
    const strokeColor = (attrs: Record<string, string>): PdfColor | undefined => {
      const base = attrs.stroke === undefined ? undefined : svgColorToPdf(attrs.stroke);
      return withSvgOpacity(withSvgOpacity(base, attrs["stroke-opacity"]), attrs.opacity);
    };
    // `stroke-width` is authored in user units and has to follow the same scale
    // as the geometry. A PDF line width is one scalar, so a non-uniform scale
    // uses the geometric mean — the uniform-equivalent factor. This was ignored
    // entirely, so every stroked element came out at the PDF default width
    // while the raster backend honoured the attribute: the same chart SVG had
    // visibly different stroke weights in a PNG and in a PDF.
    const uniformScale = Math.sqrt(Math.abs(scaleX * scaleY)) || 1;
    const strokeWidth = (attrs: Record<string, string>): number | undefined => {
      const raw = attrs["stroke-width"];
      if (raw === undefined) {
        return undefined;
      }
      const value = Number.parseFloat(raw);
      return Number.isFinite(value) && value >= 0 ? value * uniformScale : undefined;
    };

    for (const element of parsed.elements) {
      if (element.name === "rect") {
        const rectWidth = lengthAttr(element, "width", parsed.userWidth, 0);
        const rectHeight = lengthAttr(element, "height", parsed.userHeight, 0);
        this.drawRect({
          x: mapX(lengthAttr(element, "x", parsed.userWidth, 0)),
          y: mapY(lengthAttr(element, "y", parsed.userHeight, 0) + rectHeight),
          width: rectWidth * scaleX,
          height: rectHeight * scaleY,
          fill: fillColor(element.attrs),
          stroke: strokeColor(element.attrs),
          lineWidth: strokeWidth(element.attrs)
        });
      } else if (element.name === "line") {
        // `stroke` is the only paint a line has, and its initial value is
        // `none` — so an unstroked line draws nothing rather than falling back
        // to `drawLine`'s black default.
        const color = strokeColor(element.attrs);
        if (!color) {
          continue;
        }
        this.drawLine({
          x1: mapX(numAttr(element, "x1", 0)),
          y1: mapY(numAttr(element, "y1", 0)),
          x2: mapX(numAttr(element, "x2", 0)),
          y2: mapY(numAttr(element, "y2", 0)),
          color,
          lineWidth: strokeWidth(element.attrs)
        });
      } else if (element.name === "circle" || element.name === "ellipse") {
        // A circle under a non-uniform scale is an ellipse. The old code drew a
        // circle of `r * max(scaleX, scaleY)`, which both distorted the shape
        // and overflowed the destination box on the narrow axis.
        const rx = element.name === "circle" ? numAttr(element, "r", 0) : numAttr(element, "rx", 0);
        const ry = element.name === "circle" ? numAttr(element, "r", 0) : numAttr(element, "ry", 0);
        this.drawEllipse({
          cx: mapX(numAttr(element, "cx", 0)),
          cy: mapY(numAttr(element, "cy", 0)),
          rx: rx * scaleX,
          ry: ry * scaleY,
          fill: fillColor(element.attrs),
          stroke: strokeColor(element.attrs),
          lineWidth: strokeWidth(element.attrs)
        });
      } else if (element.name === "polyline" || element.name === "polygon") {
        const ops = svgPointsToPath(element.attrs.points ?? "", element.name === "polygon").map(
          op => transformPathOp(op, mapX, mapY)
        );
        const stroke = strokeColor(element.attrs);
        // A `polyline` is filled too under SVG's initial `fill: black`; the
        // chart emitters always set an explicit `fill` (often `none`) plus a
        // stroke, so this only changes behaviour for unpainted input.
        const fill = fillColor(element.attrs);
        if (!fill && !stroke) {
          continue;
        }
        this.drawPath(ops, {
          fill,
          stroke,
          lineWidth: strokeWidth(element.attrs),
          closePath: element.name === "polygon"
        });
      } else if (element.name === "path" && element.attrs.d) {
        const ops = parseSvgPath(element.attrs.d).map(op => transformPathOp(op, mapX, mapY));
        const fill = fillColor(element.attrs);
        const stroke = strokeColor(element.attrs);
        if (!fill && !stroke) {
          continue;
        }
        this.drawPath(ops, {
          fill,
          stroke,
          lineWidth: strokeWidth(element.attrs)
        });
      } else if (element.name === "text") {
        this._drawSvgText(element, mapX, mapY, scaleX, scaleY, fillColor);
      }
    }
    return this;
  }

  /**
   * Draw one SVG `<text>` element, including its `<tspan>` paragraphs.
   *
   * Everything here used to be dropped: the element's inner markup was handed
   * to `drawText` verbatim, so a multi-paragraph chart title rendered its own
   * `<tspan …>` tags as literal glyphs, and `text-anchor`, `transform`,
   * `font-family`, `font-weight` and `font-style` were all ignored. Chart SVG is
   * the documented input for `drawSvg`, and chart SVG uses every one of those.
   */
  private _drawSvgText(
    element: SimpleSvgElement,
    mapX: (x: number) => number,
    mapY: (y: number) => number,
    scaleX: number,
    scaleY: number,
    fillColor: (attrs: Record<string, string>) => PdfColor | undefined
  ): void {
    const originX = numAttr(element, "x", 0);
    const originY = numAttr(element, "y", 0);
    const fontSize = numAttr(element, "font-size", 12) * Math.max(scaleX, scaleY);
    const anchorAttr = element.attrs["text-anchor"];
    const anchor =
      anchorAttr === "middle" ? "middle" : anchorAttr === "end" ? "end" : ("start" as const);
    const family = element.attrs["font-family"]
      ?.split(",")[0]
      ?.trim()
      .replace(/^['"]|['"]$/g, "");
    const bold =
      element.attrs["font-weight"] === "bold" || Number(element.attrs["font-weight"]) >= 600;
    const italic =
      element.attrs["font-style"] === "italic" || element.attrs["font-style"] === "oblique";
    const rotate = parseSvgRotate(element.attrs.transform);
    // Baseline offsets resolve against the element's own font size, in user
    // units, before the destination scale is applied.
    const userFontSize = numAttr(element, "font-size", 12);
    const paint = fillColor(element.attrs);

    for (const run of parseSvgTextRuns(element.text, userFontSize)) {
      if (run.text === "") {
        continue;
      }
      // Unrotated baseline in user space, then rotate about the transform's
      // centre. Doing it in this order is what makes a rotated *multi-line*
      // label stack along its own down axis, the way nested `<tspan dy>` does
      // inside an SVG `transform="rotate(...)"`.
      const baseX = run.x ?? originX;
      const baseY = originY + run.dy;
      const placed = rotate ? rotatePointSvg(baseX, baseY, rotate) : { x: baseX, y: baseY };
      if (!paint) {
        // `fill="none"` hides the glyphs; `drawText` would otherwise fall back
        // to black and make hidden text visible.
        continue;
      }
      this.drawText(run.text, {
        x: mapX(placed.x),
        y: mapY(placed.y),
        fontSize,
        color: paint,
        anchor,
        ...(family ? { fontFamily: family } : {}),
        ...(bold ? { bold } : {}),
        ...(italic ? { italic } : {}),
        // `mapY` flips the Y axis, and a reflection reverses the sense of a
        // rotation: an SVG `rotate(-90)` reads bottom-to-top, so in PDF's Y-up
        // space that is `+90`. Passing the SVG angle through unchanged mirrored
        // every rotated label.
        ...(rotate ? { rotation: -rotate.angle } : {})
      });
    }
  }

  // ===========================================================================
  // Raw content stream access
  // ===========================================================================

  /**
   * Get the raw content stream for advanced operations.
   * Use this when the high-level API doesn't cover your use case.
   */
  getContentStream(): PdfContentStream {
    return this._stream;
  }

  // ===========================================================================
  // Internal Helpers
  // ===========================================================================

  /** @internal */
  /**
   * Set the stroke's corner and end shapes, when they are not the PDF defaults.
   *
   * Emitting nothing for `miter` / `butt` keeps the content stream unchanged for the
   * overwhelming majority of strokes.
   */
  private _applyStrokeShape(options: StrokeShapeOptions): void {
    if (options.lineJoin !== undefined && options.lineJoin !== "miter") {
      this._stream.setLineJoin(options.lineJoin === "round" ? 1 : 2);
    }
    if (options.lineCap !== undefined && options.lineCap !== "butt") {
      this._stream.setLineCap(options.lineCap === "round" ? 1 : 2);
    }
  }

  private _paintPath(
    fill: PdfColor | undefined,
    stroke: PdfColor | undefined,
    lineWidth: number | undefined,
    fillRule: "nonzero" | "evenodd" = "nonzero",
    rebuildPath?: () => void
  ): void {
    const hasFill = fill !== undefined;
    const hasStroke = stroke !== undefined;

    if (!hasFill && !hasStroke) {
      // Default: stroke with black, 1pt.
      this._stream.setStrokeColor(BLACK);
      this._stream.setLineWidth(1);
      this._stream.stroke();
      return;
    }

    const paintFill = (): void => {
      this._applyAlpha(fill!.a);
      this._stream.setFillColor(fill!);
      if (fillRule === "evenodd") {
        this._stream.fillEvenOdd();
      } else {
        this._stream.fill();
      }
    };
    const paintStroke = (): void => {
      this._applyAlpha(stroke!.a);
      this._stream.setStrokeColor(stroke!);
      this._stream.setLineWidth(lineWidth ?? 1);
      this._stream.stroke();
    };

    // `ca` and `CA` live in one graphics state, so a shape whose fill and stroke carry
    // different alphas cannot be painted in one pass — the second `setGraphicsState`
    // overwrote the first and both came out at one transparency. Painting consumes the
    // current path, so the second pass needs it rebuilt; when a caller cannot rebuild
    // it, one pass at the fill's alpha is still better than none.
    if (hasFill && hasStroke && (fill.a ?? 1) !== (stroke.a ?? 1) && rebuildPath !== undefined) {
      paintFill();
      this._stream.restore();
      this._stream.save();
      rebuildPath();
      paintStroke();
      return;
    }

    if (hasFill) {
      this._applyAlpha(fill.a);
    }
    if (hasStroke) {
      this._applyAlpha(stroke.a);
    }
    if (hasFill && hasStroke) {
      this._stream.setFillColor(fill);
      this._stream.setStrokeColor(stroke);
      this._stream.setLineWidth(lineWidth ?? 1);
      if (fillRule === "evenodd") {
        this._stream.fillEvenOddAndStroke();
      } else {
        this._stream.fillAndStroke();
      }
    } else if (hasFill) {
      paintFill();
    } else {
      paintStroke();
    }
  }

  /**
   * Register a colour alpha on this page so `build()` can emit the
   * matching `<< /Type /ExtGState /ca n /CA n >>` resource, and issue
   * the content-stream `gs` operator pointing at that resource. `alpha
   * === undefined` or `alpha >= 1` is a no-op, so opaque draws produce
   * byte-identical output to the pre-alpha implementation.
   *
   * Callers must already have issued `save()` so `restore()` scopes the
   * ExtGState change to the current draw — mirroring the pattern used by
   * `page-renderer.drawCellFill` (see `render/page-renderer.ts:178-194`).
   *
   * @internal
   */
  private _applyAlpha(alpha: number | undefined): void {
    if (alpha === undefined || alpha >= 1) {
      return;
    }
    const clamped = Math.max(0, Math.min(1, alpha));
    this._alphaValues.add(clamped);
    this._stream.setGraphicsState(alphaGsName(clamped, this._resourcePrefix));
  }
}

// =============================================================================
// PdfDocumentBuilder
// =============================================================================

interface BuilderPageSnapshot {
  readonly _stream: PdfContentStream;
  readonly _width: number;
  readonly _height: number;
  readonly _images: readonly DrawImageOptions[];
  readonly _annotations: readonly PageAnnotation[];
  readonly _builderAnnotations: readonly BuilderAnnotation[];
  readonly _formFields: readonly BuilderFormField[];
  readonly _alphaValues: ReadonlySet<number>;
  readonly _resourcePrefix: string;
}

interface BuilderSnapshot {
  readonly pages: readonly BuilderPageSnapshot[];
  readonly bookmarks: readonly BookmarkNode[];
  readonly metadata: DocumentMetadata;
  readonly encryption: PdfExportOptions["encryption"];
  readonly pdfA: boolean;
  readonly signatureOptions: PdfSignatureOptions | null;
  readonly disableFontAutoDiscovery: boolean;
  readonly onWarning: ((message: string) => void) | undefined;
}

/**
 * Builder for constructing multi-page PDF documents with free-form content.
 *
 * Provides fine-grained control over text positioning, vector graphics,
 * and page management — complementing the table-oriented `pdf()` function.
 */
export class PdfDocumentBuilder {
  private _pages: PdfPageBuilder[] = [];
  private _bookmarks: BookmarkNode[] = [];
  private _fontManager: FontManager;
  private _metadata: DocumentMetadata = {};
  private _encryption: PdfExportOptions["encryption"];
  private _pdfA = false;
  private _signatureOptions: PdfSignatureOptions | null = null;
  /**
   * Sink for non-fatal diagnostics produced during `build()`. Populated by
   * {@link onWarning}; defaults to undefined so unaware consumers see
   * pre-diagnostic behaviour unchanged. Fires for every warning in a
   * single build, not just the first.
   */
  private _onWarning: ((message: string) => void) | undefined;
  /**
   * Set via {@link disableFontAutoDiscovery} — opts out of the system-font
   * auto-embed path in `build()`. Authors who need byte-stable output
   * across machines (golden tests, reproducible build pipelines) should
   * enable this so a host-only CJK font doesn't sneak into one run but
   * not another.
   */
  private _disableFontAutoDiscovery = false;
  private _buildQueue: Promise<void> = Promise.resolve();

  constructor(options: PdfDocumentBuilderOptions = {}) {
    this._fontManager = options.fonts
      ? new FontManager(compilePdfFontConfig(options.fonts))
      : new FontManager();
  }

  /**
   * Add a new blank page to the document.
   *
   * @param options - Page dimensions. Default: A4 (595.28 x 841.89 points).
   * @returns A PdfPageBuilder for the new page.
   */
  addPage(options?: PageOptions): PdfPageBuilder {
    const width = options?.width ?? DEFAULT_PAGE_WIDTH;
    const height = options?.height ?? DEFAULT_PAGE_HEIGHT;
    const page = new PdfPageBuilder(width, height, this._fontManager);
    this._pages.push(page);
    return page;
  }

  /**
   * Set document metadata (title, author, etc.).
   */
  setMetadata(metadata: DocumentMetadata): this {
    this._metadata = metadata;
    return this;
  }

  /**
   * Set encryption options (AES-256).
   */
  setEncryption(encryption: PdfExportOptions["encryption"]): this {
    this._encryption = encryption;
    return this;
  }

  /**
   * Embed one TrueType font as the document-wide default.
   *
   * This legacy compatibility method is equivalent to a font configuration
   * with only `default.regular`. It replaces any previous font configuration
   * and must be called before the first `drawText()` command. Pages may already
   * have been added if no text has been drawn yet.
   *
   * @param fontBytes - Raw .ttf file bytes
   */
  embedFont(fontBytes: Uint8Array): this {
    this._assertFontsMutable();
    const manager = new FontManager();
    manager.registerEmbeddedFont(parseTtf(fontBytes));
    this._replaceFontManager(manager);
    return this;
  }

  /**
   * Compile and register a complete font-family configuration.
   *
   * This replaces any previous `embedFont()` or `embedFonts()` configuration
   * and must be called before the first `drawText()` command. Pages may already
   * have been added if no text has been drawn yet.
   */
  embedFonts(config: PdfFontConfig): this {
    this._assertFontsMutable();
    this._replaceFontManager(new FontManager(compilePdfFontConfig(config)));
    return this;
  }

  /**
   * Register a callback invoked once per non-fatal diagnostic during
   * `build()`. Currently raised for:
   *
   * - auto-embedded system fonts (`'Auto-embedded system font ...'`)
   * - non-WinAnsi characters with no covering font (`'...non-WinAnsi character(s) present...'`)
   *
   * The callback is synchronous and runs inside `build()`; throwing
   * from it will abort the build. Return value is ignored.
   */
  onWarning(handler: (message: string) => void): this {
    this._onWarning = handler;
    return this;
  }

  /**
   * Opt out of the best-effort system-font auto-discovery that `build()`
   * performs when the document contains non-WinAnsi characters and no
   * font was explicitly embedded. Use this to keep output byte-stable
   * across hosts: one machine may have SimSun installed while another
   * does not.
   */
  disableFontAutoDiscovery(): this {
    this._disableFontAutoDiscovery = true;
    return this;
  }

  /** @internal */
  private _warn(message: string): void {
    this._onWarning?.(message);
  }

  /**
   * Enable PDF/A compliance output.
   *
   * Currently supports PDF/A-1b (ISO 19005-1, Level B — visual appearance
   * preservation). When enabled, `build()` will:
   *
   * - Set PDF version to 1.4
   * - Write XMP metadata with `pdfaid:part=1` and `pdfaid:conformance=B`
   * - Write OutputIntents with an embedded sRGB ICC profile
   * - Add `/MarkInfo << /Marked true >>` to the catalog
   *
   * **Limitation:** Type1 base fonts (Helvetica, Times-Roman, Courier, etc.)
   * are not embedded. For strict PDF/A-1b font compliance, use `embedFont()`
   * to embed a TrueType font.
   *
   * @param _level - Conformance level. Currently only "1b" is supported.
   */
  setPdfACompliance(_level?: "1b"): this {
    this._pdfA = true;
    return this;
  }

  /**
   * Digitally sign the PDF during `build()`.
   *
   * When set, `build()` will:
   * 1. Embed a signature dictionary with placeholder in the PDF
   * 2. Compute the byte ranges and sign with RSA PKCS#1 v1.5 + SHA-256
   * 3. Return the fully signed PDF bytes
   *
   * @param options - Certificate, private key, and optional signer metadata
   *
   * @example
   * ```typescript
   * doc.sign({
   *   certificate: certDerBytes,
   *   privateKey: pkcs8DerBytes,
   *   name: "John Doe",
   *   reason: "Document approval"
   * });
   * const signedPdf = await doc.build();
   * ```
   */
  sign(options: PdfSignatureOptions): this {
    this._signatureOptions = options;
    return this;
  }

  // ===========================================================================
  // Bookmarks & Table of Contents
  // ===========================================================================

  /**
   * Add a bookmark (PDF outline entry) pointing to a specific page.
   *
   * @param title - Bookmark display title
   * @param pageIndex - Zero-based page index
   * @param parent - Index of a previously added top-level bookmark to nest under (zero-based in insertion order). Omit for top-level.
   * @returns this for chaining
   */
  addBookmark(title: string, pageIndex: number, parent?: number): this {
    const node: BookmarkNode = { title, pageIndex, children: [] };
    if (parent !== undefined) {
      if (parent < 0 || parent >= this._bookmarks.length) {
        throw new RangeError(
          `Bookmark parent index ${parent} is out of range (0..${this._bookmarks.length - 1})`
        );
      }
      this._bookmarks[parent].children.push(node);
    } else {
      this._bookmarks.push(node);
    }
    return this;
  }

  /**
   * Generate a table of contents page with clickable entries.
   *
   * Each entry displays the bookmark title and a right-aligned page number,
   * connected by a dotted leader. Entries link to their target pages.
   *
   * @param options - TOC formatting options
   * @returns The created PdfPageBuilder for further customization
   */
  generateTableOfContents(options?: TocOptions): PdfPageBuilder {
    const tocTitle = options?.title ?? "Table of Contents";
    const fontSize = options?.fontSize ?? DEFAULT_FONT_SIZE;
    const indent = options?.indent ?? 20;

    let page = this.addPage();
    const firstPage = page;

    const titleFontSize = fontSize + 6;
    const marginLeft = 72;
    const marginRight = 72;
    const marginBottom = 72;
    const usableWidth = page._width - marginLeft - marginRight;
    let cursorY = page._height - 72;

    // Draw TOC title
    page.drawText(tocTitle, {
      x: marginLeft,
      y: cursorY,
      fontSize: titleFontSize,
      bold: true
    });
    cursorY -= titleFontSize * 1.8;

    // Draw a separator line under the title
    page.drawLine({
      x1: marginLeft,
      y1: cursorY + fontSize * 0.4,
      x2: page._width - marginRight,
      y2: cursorY + fontSize * 0.4,
      color: { r: 0.6, g: 0.6, b: 0.6 },
      lineWidth: 0.5
    });
    cursorY -= fontSize * 0.6;

    // Flatten bookmarks with depth info for rendering
    const entries: Array<{ title: string; pageIndex: number; depth: number }> = [];
    const flattenBookmarks = (nodes: BookmarkNode[], depth: number): void => {
      for (const node of nodes) {
        entries.push({ title: node.title, pageIndex: node.pageIndex, depth });
        flattenBookmarks(node.children, depth + 1);
      }
    };
    flattenBookmarks(this._bookmarks, 0);

    const lineHeight = fontSize * 1.6;

    for (const entry of entries) {
      if (cursorY < marginBottom) {
        // Overflow — create a continuation page
        page = this.addPage();
        cursorY = page._height - 72;
      }

      const entryX = marginLeft + entry.depth * indent;
      // Measure title and page number
      const pageNumStr = String(entry.pageIndex + 1);
      const titleWidth = page.measureText(entry.title, { fontSize });
      const pageNumWidth = page.measureText(pageNumStr, { fontSize });
      const dotWidth = page.measureText(".", { fontSize });

      // Draw title text
      page.drawText(entry.title, {
        x: entryX,
        y: cursorY,
        fontSize
      });

      // Draw page number (right-aligned)
      const pageNumX = marginLeft + usableWidth - pageNumWidth;
      page.drawText(pageNumStr, {
        x: pageNumX,
        y: cursorY,
        fontSize
      });

      // Draw dot leaders between title and page number
      const dotsStartX = entryX + titleWidth + dotWidth;
      const dotsEndX = pageNumX - dotWidth;
      if (dotsEndX > dotsStartX && dotWidth > 0) {
        const dotSpacing = dotWidth * 2;
        let dotX = dotsStartX;
        const dots: string[] = [];
        while (dotX + dotWidth <= dotsEndX) {
          dots.push(".");
          dotX += dotSpacing;
        }
        if (dots.length > 0) {
          page.drawText(dots.join(" "), {
            x: dotsStartX,
            y: cursorY,
            fontSize,
            color: { r: 0.6, g: 0.6, b: 0.6 }
          });
        }
      }

      // Record a link annotation for this entry
      const annotY = cursorY - fontSize * 0.3;
      page._annotations.push({
        rect: [entryX, annotY, marginLeft + usableWidth, annotY + fontSize * 1.2],
        destPageIndex: entry.pageIndex
      });

      cursorY -= lineHeight;
    }

    return firstPage;
  }

  /** Get all pages. */
  get pages(): readonly PdfPageBuilder[] {
    return this._pages;
  }

  /**
   * Build the final PDF document.
   *
   * @returns The PDF file as Uint8Array.
   */
  async build(): Promise<Uint8Array> {
    // Capture synchronously: modifications made after build() returns belong to
    // the next build even when this build is queued behind another one.
    const snapshot = this._snapshot();
    let release!: () => void;
    const previous = this._buildQueue;
    this._buildQueue = new Promise<void>(resolve => {
      release = resolve;
    });
    await previous;
    try {
      return await this._build(snapshot);
    } finally {
      release();
    }
  }

  private async _build(snapshot: BuilderSnapshot): Promise<Uint8Array> {
    for (const page of snapshot.pages) {
      page._stream.preflight();
    }
    const hadEmbeddedFont = this._fontManager.hasEmbeddedFont();
    this._fontManager.beginBuild();
    try {
      return await this._buildWithFontSession(snapshot);
    } finally {
      // Auto-discovery is a decision for this immutable build snapshot, not a
      // mutation of the authoring model. A later build may contain characters
      // that require a different (broader) system font.
      if (!hadEmbeddedFont && this._fontManager.hasEmbeddedFont()) {
        this._fontManager.clearAutoDiscoveredFont();
      }
      this._fontManager.endBuild();
    }
  }

  private async _buildWithFontSession(snapshot: BuilderSnapshot): Promise<Uint8Array> {
    const writer = new PdfWriter();

    // PDF/A-1b requires PDF 1.4
    if (snapshot.pdfA) {
      writer.setVersion("1.4");
    }

    if (!this._fontManager.hasEmbeddedFont()) {
      // Auto-discover a system font when the document contains non-WinAnsi
      // characters (CJK, accented code points beyond WinAnsi, etc.) and
      // the caller did not supply one via `embedFont`. Mirrors the
      // `pdf-exporter` pipeline so `drawChartPdf`-style overlays, ad-hoc
      // `drawText` usage, and the spreadsheet exporter all reach for the
      // same system fonts before falling back to Type3 NOTDEF glyphs.
      // Failures are non-fatal: discovery is best-effort and users who
      // need guaranteed rendering should still call `embedFont` with a
      // font they control.
      //
      // It is registered as a *fallback*, not as the document font: it only
      // lends glyphs for the code points WinAnsi cannot encode. Registering it
      // as the document font would route every run through one regular face,
      // so a single `→` would strip bold, italic and monospace from the whole
      // document and desynchronise the widths already measured during layout.
      const nonWinAnsi = this._fontManager.getType3CodePoints();
      if (nonWinAnsi.size > 0) {
        // Try auto-discovery unless the caller opted out.
        if (!snapshot.disableFontAutoDiscovery) {
          const discovered = findSystemFontForCodePoints(nonWinAnsi);
          if (discovered) {
            this._fontManager.registerFallbackFont(discovered);
            snapshot.onWarning?.(
              `Auto-embedded system font '${discovered.familyName}' to render ${nonWinAnsi.size} non-WinAnsi character(s). ` +
                `Call embedFont(bytes) explicitly for deterministic output.`
            );
          }
        }
        if (!this._fontManager.hasEmbeddedFont()) {
          // Either discovery was disabled, every candidate failed to
          // parse, or no candidate covered these code points. Type3
          // NOTDEF glyphs (tofu boxes) will appear for any cp
          // `type3-glyphs.ts` does not map. Surface a warning so the
          // author knows rendering will degrade, and list up to 5
          // sample code points to help them debug.
          const sample = [...nonWinAnsi]
            .slice(0, 5)
            .map(cp => `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`)
            .join(", ");
          snapshot.onWarning?.(
            `${nonWinAnsi.size} non-WinAnsi character(s) present but no TrueType font is embedded and no system font candidate covered them ` +
              `(e.g. ${sample}). Call embedFont(bytes) with a font that covers these code points; otherwise Type3 NOTDEF boxes will render.`
          );
        }
      }
    }

    if (snapshot.onWarning) {
      this._fontManager.reportDiagnostics(snapshot.onWarning);
    }

    // Surface any unknown font families the FontManager saw during
    // resolveFont (one diagnostic per distinct family, independent of
    // how many text runs used it). An embedded font shadows everything
    // anyway, so skip the warning in that case to avoid noise.
    if (!this._fontManager.hasEmbeddedFont()) {
      const unknown = this._fontManager.getUnknownFontFamilies();
      if (unknown.size > 0) {
        const list = [...unknown].slice(0, 5).join(", ");
        const more = unknown.size > 5 ? ` (and ${unknown.size - 5} more)` : "";
        snapshot.onWarning?.(
          `Font family ${unknown.size > 1 ? "names" : "name"} '${list}'${more} not recognised; ` +
            `falling back to Helvetica metrics. Add the typeface to the font-family map or call embedFont(bytes).`
        );
      }
    }

    // Write font resources
    const fontObjectMap = await this._fontManager.writeFontResources(writer);
    const fontDictStr = this._fontManager.buildFontDictString(fontObjectMap);

    // Build each page
    const pageObjNums: number[] = [];
    const pagesTreeObjNum = writer.allocObject();

    // Pre-allocate page object numbers so annotations can reference them
    for (let i = 0; i < snapshot.pages.length; i++) {
      pageObjNums.push(writer.allocObject());
    }

    // Track content and resource refs per page for page dict construction
    const pageContentRefs: number[] = [];
    const pageResourceRefs: number[] = [];
    const allFormFieldRefs: number[] = [];

    // Write pages with their content, resources, and annotations
    for (let i = 0; i < snapshot.pages.length; i++) {
      const page = snapshot.pages[i];

      // Write image XObjects for this page
      const imageXObjectMap = new Map<string, number>();
      for (let j = 0; j < page._images.length; j++) {
        const img = page._images[j];
        const imgName = `${page._resourcePrefix}Im${j + 1}`;
        const imgObjNum = this._writeImageXObject(writer, img);
        imageXObjectMap.set(imgName, imgObjNum);
      }

      // Build XObject dict string
      let xobjDictStr = "";
      if (imageXObjectMap.size > 0) {
        const entries = [...imageXObjectMap.entries()]
          .map(([name, objNum]) => `/${name} ${pdfRef(objNum)}`)
          .join(" ");
        xobjDictStr = `<< ${entries} >>`;
      }

      // Write content stream
      const contentObjNum = writer.allocObject();
      const contentDict = new PdfDict();
      writer.addStreamObject(contentObjNum, contentDict, page._stream);
      pageContentRefs.push(contentObjNum);

      // Write resources
      const resourcesObjNum = writer.allocObject();
      let resourcesStr = "<< ";
      if (fontDictStr) {
        resourcesStr += `/Font ${fontDictStr} `;
      }
      if (xobjDictStr) {
        resourcesStr += `/XObject ${xobjDictStr} `;
      }
      // Emit an /ExtGState entry for every distinct page-level alpha. Mirrors
      // the scheme used by `pdf-exporter.ts:377-390` so viewers see the
      // same construct regardless of which rendering path produced the
      // PDF. Empty set → no entry (and byte-identical with the old
      // implementation for fully-opaque documents).
      if (page._alphaValues.size > 0) {
        const gsParts = ["<<"];
        for (const alpha of page._alphaValues) {
          const gsObjNum = writer.allocObject();
          const gsDict = new PdfDict()
            .set("Type", "/ExtGState")
            .set("ca", pdfNumber(alpha))
            .set("CA", pdfNumber(alpha));
          writer.addObject(gsObjNum, gsDict);
          gsParts.push(`/${alphaGsName(alpha, page._resourcePrefix)} ${pdfRef(gsObjNum)}`);
        }
        gsParts.push(">>");
        resourcesStr += `/ExtGState ${gsParts.join("\n")} `;
      }
      resourcesStr += ">>";
      writer.addObject(resourcesObjNum, resourcesStr);
      pageResourceRefs.push(resourcesObjNum);

      // Write link annotations
      const annotRefs: number[] = [];
      for (const annot of page._annotations) {
        const destPageObj = pageObjNums[annot.destPageIndex];
        if (destPageObj === undefined) {
          continue;
        }

        const annotObjNum = writer.allocObject();
        const rect = `[${pdfNumber(annot.rect[0])} ${pdfNumber(annot.rect[1])} ${pdfNumber(annot.rect[2])} ${pdfNumber(annot.rect[3])}]`;
        const annotDict = new PdfDict()
          .set("Type", "/Annot")
          .set("Subtype", "/Link")
          .set("Rect", rect)
          .set("Border", "[0 0 0]")
          .set("Dest", `[${pdfRef(destPageObj)} /Fit]`);
        writer.addObject(annotObjNum, annotDict);
        annotRefs.push(annotObjNum);
      }

      // Write builder-created annotations (Highlight, Text, FreeText, Stamp, etc.)
      for (const annot of page._builderAnnotations) {
        const annotObjNum = writer.allocObject();
        const rect = `[${pdfNumber(annot.rect[0])} ${pdfNumber(annot.rect[1])} ${pdfNumber(annot.rect[2])} ${pdfNumber(annot.rect[3])}]`;
        const annotDict = new PdfDict()
          .set("Type", "/Annot")
          .set("Subtype", `/${annot.subtype}`)
          .set("Rect", rect)
          .set("F", "4"); // Print flag — annotation is printable
        for (const [key, value] of annot.entries) {
          annotDict.set(key, value);
        }
        writer.addObject(annotObjNum, annotDict);
        annotRefs.push(annotObjNum);
      }

      // Write form field widget annotations
      for (const field of page._formFields) {
        const { fieldRefs, annotRefs: fieldAnnotRefs } = this._writeFormFieldAnnotation(
          writer,
          field.options,
          pageObjNums[i]
        );
        annotRefs.push(...fieldAnnotRefs);
        allFormFieldRefs.push(...fieldRefs);
      }

      // Write page object (using pre-allocated obj num)
      const pageObjNum = pageObjNums[i];
      const mediaBox = `[0 0 ${pdfNumber(page._width)} ${pdfNumber(page._height)}]`;
      const pageDict = new PdfDict()
        .set("Type", "/Page")
        .set("Parent", pdfRef(pagesTreeObjNum))
        .set("MediaBox", mediaBox)
        .set("Contents", pdfRef(contentObjNum))
        .set("Resources", pdfRef(resourcesObjNum));
      if (annotRefs.length > 0) {
        pageDict.set("Annots", "[" + annotRefs.map(r => pdfRef(r)).join(" ") + "]");
      }
      writer.addObject(pageObjNum, pageDict);
    }

    // Ensure at least one page
    if (pageObjNums.length === 0) {
      const emptyContentObjNum = writer.allocObject();
      writer.addStreamObject(emptyContentObjNum, new PdfDict(), new Uint8Array(0));
      const emptyResourcesObjNum = writer.allocObject();
      writer.addObject(emptyResourcesObjNum, "<< >>");
      const pageObjNum = writer.allocObject();
      const emptyPageDict = new PdfDict()
        .set("Type", "/Page")
        .set("Parent", pdfRef(pagesTreeObjNum))
        .set("MediaBox", `[0 0 ${pdfNumber(DEFAULT_PAGE_WIDTH)} ${pdfNumber(DEFAULT_PAGE_HEIGHT)}]`)
        .set("Contents", pdfRef(emptyContentObjNum))
        .set("Resources", pdfRef(emptyResourcesObjNum));
      writer.addObject(pageObjNum, emptyPageDict);
      pageObjNums.push(pageObjNum);
    }

    // Pages tree
    const kidsStr = pageObjNums.map(n => pdfRef(n)).join(" ");
    writer.addObject(
      pagesTreeObjNum,
      new PdfDict()
        .set("Type", "/Pages")
        .set("Kids", `[${kidsStr}]`)
        .set("Count", String(pageObjNums.length))
    );

    // Build outline tree from bookmarks
    let outlinesRef: number | undefined;
    if (snapshot.bookmarks.length > 0) {
      outlinesRef = this._buildOutlines(writer, pageObjNums, snapshot.bookmarks);
    }

    // Catalog — with optional PDF/A entries
    const catalogExtras: Array<[string, string]> = [];

    if (snapshot.pdfA) {
      // Write XMP metadata stream
      const xmpObjNum = writePdfAMetadata(writer, snapshot.metadata);
      catalogExtras.push(["Metadata", pdfRef(xmpObjNum)]);

      // Write OutputIntents with sRGB ICC profile
      const intentObjNum = writePdfAOutputIntent(writer);
      catalogExtras.push(["OutputIntents", `[${pdfRef(intentObjNum)}]`]);

      // Mark as tagged (minimal structural compliance)
      catalogExtras.push(["MarkInfo", "<< /Marked true >>"]);
    }

    // Build catalog — handle three cases:
    // 1. Simple: no form fields, no signing → addCatalog()
    // 2. Form fields only → rebuild catalog with AcroForm
    // 3. Signing (with or without form fields) → signing path builds the catalog
    const needsCustomCatalog = allFormFieldRefs.length > 0 || snapshot.signatureOptions;

    if (!needsCustomCatalog) {
      writer.addCatalog(pagesTreeObjNum, {
        outlinesRef,
        extraEntries: catalogExtras.length > 0 ? catalogExtras : undefined
      });
    }

    // AcroForm — if any pages have form fields (and not signing — signing path builds its own catalog)
    if (allFormFieldRefs.length > 0 && !snapshot.signatureOptions) {
      const catalogObjNum = writer.allocObject();
      const catalogDict = new PdfDict()
        .set("Type", "/Catalog")
        .set("Pages", pdfRef(pagesTreeObjNum));
      if (outlinesRef) {
        catalogDict.set("Outlines", pdfRef(outlinesRef));
        catalogDict.set("PageMode", "/UseOutlines");
      }
      for (const [key, value] of catalogExtras) {
        catalogDict.set(key, value);
      }
      const fieldsStr = allFormFieldRefs.map(r => pdfRef(r)).join(" ");
      const acroFormStr = `<< /Fields [${fieldsStr}] /NeedAppearances true /DR << /Font << /Helv << /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >> >> >> /DA (/Helv 0 Tf 0 g) >>`;
      catalogDict.set("AcroForm", acroFormStr);
      writer.addObject(catalogObjNum, catalogDict);
      writer.setCatalog(catalogObjNum);
    }

    // Info dict
    if (
      snapshot.metadata.title ||
      snapshot.metadata.author ||
      snapshot.metadata.subject ||
      snapshot.metadata.creator
    ) {
      writer.addInfoDict(snapshot.metadata);
    }

    // Encryption
    if (snapshot.encryption) {
      const encState = initEncryption(snapshot.encryption);
      writer.setEncryption(encState);
    }

    // If signing is requested, we need to:
    // 1. Add the signature dict placeholder + widget to the PDF
    // 2. Build the PDF bytes
    // 3. Call signPdf() to fill in the real signature
    if (snapshot.signatureOptions) {
      const { buildSignatureDictPlaceholder, signPdf } =
        await import("@pdf/core/digital-signature");

      const { dictString } = buildSignatureDictPlaceholder({
        name: snapshot.signatureOptions.name,
        reason: snapshot.signatureOptions.reason,
        location: snapshot.signatureOptions.location,
        contactInfo: snapshot.signatureOptions.contactInfo
      });

      // Write signature dict as indirect object
      const sigDictObjNum = writer.allocObject();
      writer.addObject(sigDictObjNum, dictString);

      // Write signature widget annotation
      const sigWidgetObjNum = writer.allocObject();
      const sigWidgetDict = new PdfDict()
        .set("Type", "/Annot")
        .set("Subtype", "/Widget")
        .set("FT", "/Sig")
        .set("Rect", "[0 0 0 0]")
        .set("T", pdfString("Signature1"))
        .set("V", pdfRef(sigDictObjNum))
        .set("F", "4");
      writer.addObject(sigWidgetObjNum, sigWidgetDict);

      // Patch catalog to include AcroForm with SigFlags
      // We need to rebuild the catalog with AcroForm
      const sigCatalogObjNum = writer.allocObject();
      const sigCatalogDict = new PdfDict()
        .set("Type", "/Catalog")
        .set("Pages", pdfRef(pagesTreeObjNum));
      if (outlinesRef) {
        sigCatalogDict.set("Outlines", pdfRef(outlinesRef));
        sigCatalogDict.set("PageMode", "/UseOutlines");
      }
      for (const [key, value] of catalogExtras) {
        sigCatalogDict.set(key, value);
      }

      // Merge existing form field refs with signature widget
      const allFields = [...allFormFieldRefs, sigWidgetObjNum];
      const fieldsStr = allFields.map(r => pdfRef(r)).join(" ");
      // Include form field resources (NeedAppearances, DR, DA) when form fields exist
      const hasFormFields = allFormFieldRefs.length > 0;
      const acroFormEntries = [`/Fields [${fieldsStr}]`, "/SigFlags 3"];
      if (hasFormFields) {
        acroFormEntries.push("/NeedAppearances true");
        acroFormEntries.push(
          "/DR << /Font << /Helv << /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >> >> >>"
        );
        acroFormEntries.push("/DA (/Helv 0 Tf 0 g)");
      }
      sigCatalogDict.set("AcroForm", `<< ${acroFormEntries.join(" ")} >>`);

      // Add signature widget to first page's annotations
      // (We need to patch the first page dict to include the widget in /Annots)
      // For simplicity, add it as a document-level field (already in AcroForm /Fields)
      writer.addObject(sigCatalogObjNum, sigCatalogDict);
      writer.setCatalog(sigCatalogObjNum);

      const pdfWithPlaceholder = writer.build();

      // Sign the PDF
      return signPdf(
        pdfWithPlaceholder,
        snapshot.signatureOptions.certificate,
        snapshot.signatureOptions.privateKey
      );
    }

    return writer.build();
  }

  // ===========================================================================
  // Internal Helpers
  // ===========================================================================

  private _assertFontsMutable(): void {
    if (this._pages.some(page => page._hasText)) {
      throw new PdfError("Fonts must be configured before drawing the first PDF text command");
    }
  }

  private _replaceFontManager(manager: FontManager): void {
    this._fontManager = manager;
    for (const page of this._pages) {
      page._fontManager = manager;
    }
  }

  private _snapshot(): BuilderSnapshot {
    return {
      pages: this._pages.map(page => ({
        _stream: page._stream.snapshot(),
        _width: page._width,
        _height: page._height,
        _images: [...page._images],
        _annotations: [...page._annotations],
        _builderAnnotations: [...page._builderAnnotations],
        _formFields: [...page._formFields],
        _alphaValues: new Set(page._alphaValues),
        _resourcePrefix: page._resourcePrefix
      })),
      bookmarks: [...this._bookmarks],
      metadata: { ...this._metadata },
      encryption: this._encryption,
      pdfA: this._pdfA,
      signatureOptions: this._signatureOptions ? { ...this._signatureOptions } : null,
      disableFontAutoDiscovery: this._disableFontAutoDiscovery,
      onWarning: this._onWarning
    };
  }

  /** @internal */
  private _writeImageXObject(writer: PdfWriter, img: DrawImageOptions): number {
    return writeImageXObject(writer, img.data, img.format);
  }

  /**
   * Build a nested PDF outline (bookmark) tree.
   * @internal
   */
  private _buildOutlines(
    writer: PdfWriter,
    pageObjNums: number[],
    bookmarks: readonly BookmarkNode[]
  ): number {
    const outlinesObjNum = writer.allocObject();

    // Allocate object numbers for all nodes (pre-order traversal)
    const allNodes: Array<{
      node: BookmarkNode;
      objNum: number;
      parentObjNum: number;
      depth: number;
    }> = [];

    const allocNodes = (
      nodes: readonly BookmarkNode[],
      parentObjNum: number,
      depth: number
    ): void => {
      for (const node of nodes) {
        const objNum = writer.allocObject();
        allNodes.push({ node, objNum, parentObjNum, depth });
        allocNodes(node.children, objNum, depth + 1);
      }
    };
    allocNodes(bookmarks, outlinesObjNum, 0);

    // Group children by parent for sibling linkage
    const childrenByParent = new Map<number, typeof allNodes>();
    for (const entry of allNodes) {
      const siblings = childrenByParent.get(entry.parentObjNum);
      if (siblings) {
        siblings.push(entry);
      } else {
        childrenByParent.set(entry.parentObjNum, [entry]);
      }
    }

    // Count all descendants (including self) for each node
    const countDescendants = (node: BookmarkNode): number => {
      let count = 1;
      for (const child of node.children) {
        count += countDescendants(child);
      }
      return count;
    };

    // Write each outline item
    for (const entry of allNodes) {
      const { node, objNum, parentObjNum } = entry;
      const pageObjNum = pageObjNums[node.pageIndex];
      if (pageObjNum === undefined) {
        continue;
      }

      const dict = new PdfDict()
        .set("Title", pdfString(node.title))
        .set("Parent", pdfRef(parentObjNum))
        .set("Dest", `[${pdfRef(pageObjNum)} /Fit]`);

      // Sibling linkage
      const siblings = childrenByParent.get(parentObjNum) ?? [];
      const idx = siblings.indexOf(entry);
      if (idx > 0) {
        dict.set("Prev", pdfRef(siblings[idx - 1].objNum));
      }
      if (idx < siblings.length - 1) {
        dict.set("Next", pdfRef(siblings[idx + 1].objNum));
      }

      // Children linkage
      const children = childrenByParent.get(objNum);
      if (children && children.length > 0) {
        dict.set("First", pdfRef(children[0].objNum));
        dict.set("Last", pdfRef(children[children.length - 1].objNum));
        // Negative count = initially closed, positive = initially open
        const totalChildren = node.children.reduce((sum, c) => sum + countDescendants(c), 0);
        dict.set("Count", String(-totalChildren));
      }

      writer.addObject(objNum, dict);
    }

    // Write outlines root
    const topLevel = childrenByParent.get(outlinesObjNum) ?? [];
    const totalCount = this._bookmarks.length;
    const outlinesDict = new PdfDict().set("Type", "/Outlines").set("Count", String(totalCount));
    if (topLevel.length > 0) {
      outlinesDict.set("First", pdfRef(topLevel[0].objNum));
      outlinesDict.set("Last", pdfRef(topLevel[topLevel.length - 1].objNum));
    }
    writer.addObject(outlinesObjNum, outlinesDict);

    return outlinesObjNum;
  }

  /**
   * Write form field annotation(s) as indirect objects.
   * @internal
   */
  private _writeFormFieldAnnotation(
    writer: PdfWriter,
    options: FormFieldOptions,
    pageObjNum: number
  ): { fieldRefs: number[]; annotRefs: number[] } {
    const fieldRefs: number[] = [];
    const annotRefs: number[] = [];

    if (options.type === "radio") {
      // Radio group: one parent field + one widget per button
      const parentObjNum = writer.allocObject();
      const childRefs: number[] = [];
      let ff = 1 << 15; // /Ff bit 16 = Radio
      ff |= 1 << 14; // /Ff bit 15 = NoToggleToOff
      if (options.readOnly) {
        ff |= 1;
      }
      if (options.required) {
        ff |= 1 << 1;
      }

      for (const btn of options.buttons) {
        const childObjNum = writer.allocObject();
        const rect = `[${btn.rect.map(v => pdfNumber(v)).join(" ")}]`;
        const isSelected = options.selected === btn.value;
        const apState = isSelected ? `/${btn.value}` : "/Off";

        const childDict = new PdfDict()
          .set("Type", "/Annot")
          .set("Subtype", "/Widget")
          .set("Rect", rect)
          .set("Parent", pdfRef(parentObjNum))
          .set("AS", apState)
          .set("AP", `<< /N << /${btn.value} null /Off null >> >>`);
        writer.addObject(childObjNum, childDict);
        childRefs.push(childObjNum);
      }

      const parentDict = new PdfDict()
        .set("FT", "/Btn")
        .set("T", pdfString(options.name))
        .set("Ff", String(ff))
        .set("Kids", `[${childRefs.map(r => pdfRef(r)).join(" ")}]`);
      if (options.selected) {
        parentDict.set("V", `/${options.selected}`);
      }
      writer.addObject(parentObjNum, parentDict);
      // Parent goes into AcroForm /Fields; children go into page /Annots
      fieldRefs.push(parentObjNum);
      annotRefs.push(...childRefs);
      return { fieldRefs, annotRefs };
    }

    // Single-widget fields: text, checkbox, dropdown
    const objNum = writer.allocObject();
    const r = options.rect;
    const rect = `[${pdfNumber(r[0])} ${pdfNumber(r[1])} ${pdfNumber(r[2])} ${pdfNumber(r[3])}]`;

    const dict = new PdfDict()
      .set("Type", "/Annot")
      .set("Subtype", "/Widget")
      .set("Rect", rect)
      .set("T", pdfString(options.name))
      .set("P", pdfRef(pageObjNum));

    let ff = 0;
    if (options.readOnly) {
      ff |= 1;
    }
    if (options.required) {
      ff |= 1 << 1;
    }

    switch (options.type) {
      case "text": {
        dict.set("FT", "/Tx");
        if (options.multiline) {
          ff |= 1 << 12;
        }
        if (options.password) {
          ff |= 1 << 13;
        }
        if (options.maxLength !== undefined) {
          dict.set("MaxLen", String(options.maxLength));
        }
        if (options.value) {
          dict.set("V", pdfString(options.value));
        }
        // Default appearance
        dict.set("DA", pdfString("/Helv 12 Tf 0 g"));
        break;
      }
      case "checkbox": {
        dict.set("FT", "/Btn");
        const checked = options.checked ?? false;
        dict.set("V", checked ? "/Yes" : "/Off");
        dict.set("AS", checked ? "/Yes" : "/Off");
        break;
      }
      case "dropdown": {
        dict.set("FT", "/Ch");
        ff |= 1 << 17; // Combo flag
        if (options.editable) {
          ff |= 1 << 18;
        }
        const optStr = options.options.map(o => pdfString(o)).join(" ");
        dict.set("Opt", `[${optStr}]`);
        if (options.value) {
          dict.set("V", pdfString(options.value));
        }
        dict.set("DA", pdfString("/Helv 12 Tf 0 g"));
        break;
      }
    }

    if (ff !== 0) {
      dict.set("Ff", String(ff));
    }

    writer.addObject(objNum, dict);
    // Single-widget fields go into both /Annots and /Fields
    fieldRefs.push(objNum);
    annotRefs.push(objNum);
    return { fieldRefs, annotRefs };
  }
}

// =============================================================================
// SVG Path Parser
// =============================================================================

/**
 * Parse an SVG path `d` attribute into PathOp array.
 *
 * Supports all SVG path commands:
 * - M/m (moveTo), L/l (lineTo), H/h (horizontal), V/v (vertical)
 * - C/c (cubic Bézier), S/s (smooth cubic)
 * - Q/q (quadratic Bézier), T/t (smooth quadratic)
 * - A/a (elliptical arc), Z/z (close)
 *
 * Arc commands are approximated with cubic Bézier curves.
 */
export function parseSvgPath(d: string): PathOp[] {
  const ops: PathOp[] = [];
  // Tokenize: split into commands + numbers
  const tokens = d.match(/[a-zA-Z]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g);
  if (!tokens) {
    return ops;
  }

  let i = 0;
  let cx = 0; // current x
  let cy = 0; // current y
  let sx = 0; // subpath start x
  let sy = 0; // subpath start y
  let lastCmd = "";
  // For smooth curves: last control point
  let lastCpX = 0;
  let lastCpY = 0;

  const num = (): number => {
    if (i >= tokens.length) {
      return 0;
    }
    return parseFloat(tokens[i++]);
  };

  const isNum = (): boolean => {
    if (i >= tokens.length) {
      return false;
    }
    const c = tokens[i].charCodeAt(0);
    return c === 0x2d || c === 0x2b || c === 0x2e || (c >= 0x30 && c <= 0x39);
  };

  while (i < tokens.length) {
    let cmd = tokens[i];
    if (/[a-zA-Z]/.test(cmd)) {
      i++;
    } else {
      // Implicit repeat of last command (except M becomes L, m becomes l)
      cmd = lastCmd === "M" ? "L" : lastCmd === "m" ? "l" : lastCmd;
    }

    switch (cmd) {
      case "M":
        cx = num();
        cy = num();
        ops.push({ op: "move", x: cx, y: cy });
        sx = cx;
        sy = cy;
        lastCmd = "M";
        while (isNum()) {
          cx = num();
          cy = num();
          ops.push({ op: "line", x: cx, y: cy });
        }
        break;
      case "m":
        cx += num();
        cy += num();
        ops.push({ op: "move", x: cx, y: cy });
        sx = cx;
        sy = cy;
        lastCmd = "m";
        while (isNum()) {
          cx += num();
          cy += num();
          ops.push({ op: "line", x: cx, y: cy });
        }
        break;
      case "L":
        do {
          cx = num();
          cy = num();
          ops.push({ op: "line", x: cx, y: cy });
        } while (isNum());
        lastCmd = "L";
        break;
      case "l":
        do {
          const dx = num();
          const dy = num();
          cx += dx;
          cy += dy;
          ops.push({ op: "line", x: cx, y: cy });
        } while (isNum());
        lastCmd = "l";
        break;
      case "H":
        do {
          cx = num();
          ops.push({ op: "line", x: cx, y: cy });
        } while (isNum());
        lastCmd = "H";
        break;
      case "h":
        do {
          cx += num();
          ops.push({ op: "line", x: cx, y: cy });
        } while (isNum());
        lastCmd = "h";
        break;
      case "V":
        do {
          cy = num();
          ops.push({ op: "line", x: cx, y: cy });
        } while (isNum());
        lastCmd = "V";
        break;
      case "v":
        do {
          cy += num();
          ops.push({ op: "line", x: cx, y: cy });
        } while (isNum());
        lastCmd = "v";
        break;
      case "C":
        do {
          const x1 = num(),
            y1 = num(),
            x2 = num(),
            y2 = num(),
            x = num(),
            y = num();
          ops.push({ op: "curve", x1, y1, x2, y2, x3: x, y3: y });
          lastCpX = x2;
          lastCpY = y2;
          cx = x;
          cy = y;
        } while (isNum());
        lastCmd = "C";
        break;
      case "c":
        do {
          const x1 = cx + num(),
            y1 = cy + num(),
            x2 = cx + num(),
            y2 = cy + num();
          const x = cx + num(),
            y = cy + num();
          ops.push({ op: "curve", x1, y1, x2, y2, x3: x, y3: y });
          lastCpX = x2;
          lastCpY = y2;
          cx = x;
          cy = y;
        } while (isNum());
        lastCmd = "c";
        break;
      case "S":
        do {
          const rx =
            lastCmd === "S" || lastCmd === "s" || lastCmd === "C" || lastCmd === "c"
              ? 2 * cx - lastCpX
              : cx;
          const ry =
            lastCmd === "S" || lastCmd === "s" || lastCmd === "C" || lastCmd === "c"
              ? 2 * cy - lastCpY
              : cy;
          const x2 = num(),
            y2 = num(),
            x = num(),
            y = num();
          ops.push({ op: "curve", x1: rx, y1: ry, x2, y2, x3: x, y3: y });
          lastCpX = x2;
          lastCpY = y2;
          cx = x;
          cy = y;
          lastCmd = "S";
        } while (isNum());
        break;
      case "s":
        do {
          const rx =
            lastCmd === "S" || lastCmd === "s" || lastCmd === "C" || lastCmd === "c"
              ? 2 * cx - lastCpX
              : cx;
          const ry =
            lastCmd === "S" || lastCmd === "s" || lastCmd === "C" || lastCmd === "c"
              ? 2 * cy - lastCpY
              : cy;
          const x2 = cx + num(),
            y2 = cy + num(),
            x = cx + num(),
            y = cy + num();
          ops.push({ op: "curve", x1: rx, y1: ry, x2, y2, x3: x, y3: y });
          lastCpX = x2;
          lastCpY = y2;
          cx = x;
          cy = y;
          lastCmd = "s";
        } while (isNum());
        break;
      case "Q":
        do {
          const qx = num(),
            qy = num(),
            x = num(),
            y = num();
          // Convert quadratic to cubic: CP1 = P0 + 2/3*(QP-P0), CP2 = P1 + 2/3*(QP-P1)
          const c1x = cx + (2 / 3) * (qx - cx),
            c1y = cy + (2 / 3) * (qy - cy);
          const c2x = x + (2 / 3) * (qx - x),
            c2y = y + (2 / 3) * (qy - y);
          ops.push({
            op: "curve",
            x1: c1x,
            y1: c1y,
            x2: c2x,
            y2: c2y,
            x3: x,
            y3: y
          });
          lastCpX = qx;
          lastCpY = qy;
          cx = x;
          cy = y;
        } while (isNum());
        lastCmd = "Q";
        break;
      case "q":
        do {
          const qx = cx + num(),
            qy = cy + num(),
            x = cx + num(),
            y = cy + num();
          const c1x = cx + (2 / 3) * (qx - cx),
            c1y = cy + (2 / 3) * (qy - cy);
          const c2x = x + (2 / 3) * (qx - x),
            c2y = y + (2 / 3) * (qy - y);
          ops.push({
            op: "curve",
            x1: c1x,
            y1: c1y,
            x2: c2x,
            y2: c2y,
            x3: x,
            y3: y
          });
          lastCpX = qx;
          lastCpY = qy;
          cx = x;
          cy = y;
        } while (isNum());
        lastCmd = "q";
        break;
      case "T":
        do {
          const qx =
            lastCmd === "Q" || lastCmd === "q" || lastCmd === "T" || lastCmd === "t"
              ? 2 * cx - lastCpX
              : cx;
          const qy =
            lastCmd === "Q" || lastCmd === "q" || lastCmd === "T" || lastCmd === "t"
              ? 2 * cy - lastCpY
              : cy;
          const x = num(),
            y = num();
          const c1x = cx + (2 / 3) * (qx - cx),
            c1y = cy + (2 / 3) * (qy - cy);
          const c2x = x + (2 / 3) * (qx - x),
            c2y = y + (2 / 3) * (qy - y);
          ops.push({
            op: "curve",
            x1: c1x,
            y1: c1y,
            x2: c2x,
            y2: c2y,
            x3: x,
            y3: y
          });
          lastCpX = qx;
          lastCpY = qy;
          cx = x;
          cy = y;
          lastCmd = "T";
        } while (isNum());
        break;
      case "t":
        do {
          const qx =
            lastCmd === "Q" || lastCmd === "q" || lastCmd === "T" || lastCmd === "t"
              ? 2 * cx - lastCpX
              : cx;
          const qy =
            lastCmd === "Q" || lastCmd === "q" || lastCmd === "T" || lastCmd === "t"
              ? 2 * cy - lastCpY
              : cy;
          const x = cx + num(),
            y = cy + num();
          const c1x = cx + (2 / 3) * (qx - cx),
            c1y = cy + (2 / 3) * (qy - cy);
          const c2x = x + (2 / 3) * (qx - x),
            c2y = y + (2 / 3) * (qy - y);
          ops.push({
            op: "curve",
            x1: c1x,
            y1: c1y,
            x2: c2x,
            y2: c2y,
            x3: x,
            y3: y
          });
          lastCpX = qx;
          lastCpY = qy;
          cx = x;
          cy = y;
          lastCmd = "t";
        } while (isNum());
        break;
      case "A":
      case "a": {
        const isRel = cmd === "a";
        do {
          const rx = Math.abs(num()),
            ry = Math.abs(num());
          const rotation = (num() * Math.PI) / 180;
          const largeArc = num() !== 0;
          const sweep = num() !== 0;
          const ex = isRel ? cx + num() : num();
          const ey = isRel ? cy + num() : num();
          arcToCurves(ops, cx, cy, rx, ry, rotation, largeArc, sweep, ex, ey);
          cx = ex;
          cy = ey;
        } while (isNum());
        lastCmd = cmd;
        break;
      }
      case "Z":
      case "z":
        ops.push({ op: "close" });
        cx = sx;
        cy = sy;
        lastCmd = cmd;
        break;
      default:
        // Unknown command — skip
        i++;
        break;
    }
  }

  return ops;
}

interface SimpleSvgElement {
  name: string;
  attrs: Record<string, string>;
  text: string;
}

interface SimpleSvgDocument {
  /** Root width in the *parent* coordinate system. */
  width: number;
  /** Root height in the parent coordinate system. */
  height: number;
  /**
   * The user coordinate system the elements are authored in.
   *
   * With a `viewBox` this is the viewBox rectangle; without one it is the root
   * width/height at the origin. Element coordinates are always relative to
   * this, which is what the previous code missed: it read `viewBox` only to
   * back-fill a missing width/height and then treated element coordinates as
   * if they were already in the destination box. A `viewBox="0 0 100 50"` on a
   * `width="200"` root therefore drew at half scale, and a non-zero
   * `viewBox` origin shifted everything by that origin.
   */
  userMinX: number;
  userMinY: number;
  userWidth: number;
  userHeight: number;
  /** Raw `preserveAspectRatio`; absent means the spec default. */
  preserveAspectRatio: string | undefined;
  elements: SimpleSvgElement[];
}

/**
 * Resolve the viewBox → viewport transform, honouring `preserveAspectRatio`.
 *
 * SVG's initial value is `xMidYMid meet`: scale uniformly so the whole viewBox
 * fits, then centre the result. This used to scale each axis independently,
 * which is `preserveAspectRatio="none"` — so a square chart drawn into a wide
 * box came out stretched instead of centred, disagreeing with every browser and
 * with the SVG the chart engine itself emits.
 *
 * `slice` scales to *cover* the viewport instead of fitting inside it. Alignment
 * keywords `xMin|xMid|xMax` and `YMin|YMid|YMax` are honoured; the `defer`
 * prefix is accepted and ignored, as it only applies to referenced images.
 */
function resolveSvgViewport(
  parsed: SimpleSvgDocument,
  destWidth: number,
  destHeight: number
): { scaleX: number; scaleY: number; offsetX: number; offsetY: number } {
  const rawScaleX = parsed.userWidth > 0 ? destWidth / parsed.userWidth : 1;
  const rawScaleY = parsed.userHeight > 0 ? destHeight / parsed.userHeight : 1;
  const spec = (parsed.preserveAspectRatio ?? "")
    .trim()
    .replace(/^defer\s+/i, "")
    .split(/\s+/)
    .filter(token => token !== "");
  const align = spec[0] ?? "xMidYMid";
  if (align === "none") {
    return { scaleX: rawScaleX, scaleY: rawScaleY, offsetX: 0, offsetY: 0 };
  }
  const uniform =
    spec[1] === "slice" ? Math.max(rawScaleX, rawScaleY) : Math.min(rawScaleX, rawScaleY);
  const spare = (dest: number, used: number, mid: string, max: string): number => {
    const slack = dest - used;
    if (align.includes(max)) {
      return slack;
    }
    return align.includes(mid) ? slack / 2 : 0;
  };
  return {
    scaleX: uniform,
    scaleY: uniform,
    offsetX: spare(destWidth, parsed.userWidth * uniform, "xMid", "xMax"),
    offsetY: spare(destHeight, parsed.userHeight * uniform, "YMid", "YMax")
  };
}

function parseSimpleSvg(svg: string): SimpleSvgDocument {
  const svgTag = /<svg\b([^>]*)>/i.exec(svg);
  const svgAttrs = parseSvgAttributes(svgTag?.[1] ?? "");
  const viewBox = parseSvgNumberList(svgAttrs.viewBox);
  const hasViewBox = viewBox.length >= 4 && viewBox[2] > 0 && viewBox[3] > 0;
  const width = svgRootLength(svgAttrs.width, hasViewBox ? viewBox[2] : undefined, 300);
  const height = svgRootLength(svgAttrs.height, hasViewBox ? viewBox[3] : undefined, 150);
  const userMinX = hasViewBox ? viewBox[0] : 0;
  const userMinY = hasViewBox ? viewBox[1] : 0;
  const userWidth = hasViewBox ? viewBox[2] : width;
  const userHeight = hasViewBox ? viewBox[3] : height;
  const elements: SimpleSvgElement[] = [];
  const elementRe =
    /<(rect|line|circle|ellipse|polyline|polygon|path)\b([^>]*)\/?>|<text\b([^>]*)>([\s\S]*?)<\/text>/gi;
  let match: RegExpExecArray | null;
  while ((match = elementRe.exec(svg)) !== null) {
    if (match[1]) {
      elements.push({ name: match[1], attrs: parseSvgAttributes(match[2] ?? ""), text: "" });
    } else {
      elements.push({
        name: "text",
        attrs: parseSvgAttributes(match[3] ?? ""),
        text: match[4] ?? ""
      });
    }
  }
  return {
    width,
    height,
    userMinX,
    userMinY,
    userWidth,
    userHeight,
    preserveAspectRatio: svgAttrs.preserveAspectRatio,
    elements
  };
}

function numAttr(element: SimpleSvgElement, name: string, fallback: number): number {
  const value = parseFloat(element.attrs[name] ?? "");
  return Number.isFinite(value) ? value : fallback;
}

function lengthAttr(
  element: SimpleSvgElement,
  name: string,
  axisLength: number,
  fallback: number
): number {
  const raw = element.attrs[name];
  if (!raw) {
    return fallback;
  }
  if (raw.trim().endsWith("%")) {
    const pct = parseFloat(raw);
    return Number.isFinite(pct) ? (axisLength * pct) / 100 : fallback;
  }
  const value = parseFloat(raw);
  return Number.isFinite(value) ? value : fallback;
}

function svgRootLength(
  raw: string | undefined,
  viewBoxLength: number | undefined,
  fallback: number
): number {
  if (!raw || raw.trim().endsWith("%")) {
    return viewBoxLength || fallback;
  }
  const value = parseFloat(raw);
  return Number.isFinite(value) && value > 0 ? value : viewBoxLength || fallback;
}

/**
 * Parse an SVG color token (`#rgb` / `#rrggbb` / `rgb(...)` / `rgba(...)`)
 * into a {@link PdfColor}. Named colours and functional forms beyond
 * `rgb`/`rgba` are deliberately out of scope — chart SVG output sticks
 * to these forms, and the `drawSvg` consumer should pass-through
 * `undefined` (i.e. "no fill") rather than silently guess.
 *
 * `rgba(r, g, b, a)` populates `.a` so the caller can thread the alpha
 * through `PdfPageBuilder._applyAlpha` → `/ExtGState`. Percentage values
 * are accepted (e.g. `rgb(100%, 0%, 0%)` ≡ red).
 */
function svgColorToPdf(value: string): PdfColor | undefined {
  // CSS/SVG semantics — notably `#RRGGBBAA`, alpha last. This used to delegate
  // its hex branch to the OOXML reader, which is `#AARRGGBB`, so `#FF000080`
  // arrived as opaque dark blue instead of translucent red.
  const parsed = parseCssColor(value);
  if (!parsed) {
    return undefined;
  }
  const color: PdfColor = { r: parsed.r, g: parsed.g, b: parsed.b };
  return parsed.a >= 1 ? color : { ...color, a: parsed.a };
}

/**
 * Apply an `*-opacity` attribute to an already-parsed {@link PdfColor}.
 *
 * SVG lets authors specify opacity either inline on the colour (`rgba`)
 * or as a separate `fill-opacity`/`stroke-opacity` attribute. When both
 * are present the W3C spec multiplies them — `rgba(…,0.5)` with
 * `fill-opacity="0.4"` yields effective alpha 0.2. We preserve that
 * here so chart SVG output whose authors use either form surfaces the
 * same alpha through to `/ExtGState`.
 */
function withSvgOpacity(
  color: PdfColor | undefined,
  opacityAttr: string | undefined
): PdfColor | undefined {
  if (!color) {
    return color;
  }
  if (!opacityAttr) {
    return color;
  }
  const parsed = Number.parseFloat(opacityAttr);
  if (!Number.isFinite(parsed)) {
    return color;
  }
  const clamped = Math.max(0, Math.min(1, parsed));
  const combined = (color.a ?? 1) * clamped;
  if (combined >= 1) {
    return color;
  }
  return { ...color, a: combined };
}

function svgPointsToPath(points: string, close: boolean): PathOp[] {
  const nums = parseSvgNumberList(points);
  const ops: PathOp[] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) {
    ops.push(
      i === 0
        ? { op: "move", x: nums[i], y: nums[i + 1] }
        : { op: "line", x: nums[i], y: nums[i + 1] }
    );
  }
  if (close && ops.length > 0) {
    ops.push({ op: "close" });
  }
  return ops;
}

/**
 * Rotate a point about a centre using SVG's `rotate()` convention: positive
 * angles turn clockwise, because the user coordinate system has +Y downwards.
 */
function rotatePointSvg(
  x: number,
  y: number,
  rotate: { angle: number; cx: number; cy: number }
): { x: number; y: number } {
  const radians = (rotate.angle * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const dx = x - rotate.cx;
  const dy = y - rotate.cy;
  return {
    x: rotate.cx + dx * cos - dy * sin,
    y: rotate.cy + dx * sin + dy * cos
  };
}

function transformPathOp(
  op: PathOp,
  mapX: (x: number) => number,
  mapY: (y: number) => number
): PathOp {
  if (op.op === "move" || op.op === "line") {
    return { ...op, x: mapX(op.x), y: mapY(op.y) };
  }
  if (op.op === "curve") {
    return {
      op: "curve",
      x1: mapX(op.x1),
      y1: mapY(op.y1),
      x2: mapX(op.x2),
      y2: mapY(op.y2),
      x3: mapX(op.x3),
      y3: mapY(op.y3)
    };
  }
  return op;
}

/**
 * Convert an SVG elliptical arc to cubic Bézier curves.
 * Follows the SVG spec's endpoint-to-center arc parameterization.
 * @internal
 */
function arcToCurves(
  ops: PathOp[],
  x1: number,
  y1: number,
  rx: number,
  ry: number,
  phi: number,
  largeArc: boolean,
  sweep: boolean,
  x2: number,
  y2: number
): void {
  if (rx === 0 || ry === 0) {
    ops.push({ op: "line", x: x2, y: y2 });
    return;
  }
  if (x1 === x2 && y1 === y2) {
    return;
  }

  const cosPhi = Math.cos(phi),
    sinPhi = Math.sin(phi);
  const dx = (x1 - x2) / 2,
    dy = (y1 - y2) / 2;
  const x1p = cosPhi * dx + sinPhi * dy;
  const y1p = -sinPhi * dx + cosPhi * dy;

  // Correct radii
  let rxSq = rx * rx,
    rySq = ry * ry;
  const x1pSq = x1p * x1p,
    y1pSq = y1p * y1p;
  const lambda = x1pSq / rxSq + y1pSq / rySq;
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
    rxSq = rx * rx;
    rySq = ry * ry;
  }

  // Center parameterization
  let sq = (rxSq * rySq - rxSq * y1pSq - rySq * x1pSq) / (rxSq * y1pSq + rySq * x1pSq);
  if (sq < 0) {
    sq = 0;
  }
  let root = Math.sqrt(sq);
  if (largeArc === sweep) {
    root = -root;
  }
  const cxp = (root * rx * y1p) / ry;
  const cyp = (-root * ry * x1p) / rx;

  const cxr = cosPhi * cxp - sinPhi * cyp + (x1 + x2) / 2;
  const cyr = sinPhi * cxp + cosPhi * cyp + (y1 + y2) / 2;

  const angle = (ux: number, uy: number, vx: number, vy: number): number => {
    const dot = ux * vx + uy * vy;
    const len = Math.sqrt(ux * ux + uy * uy) * Math.sqrt(vx * vx + vy * vy);
    let a = Math.acos(Math.max(-1, Math.min(1, dot / len)));
    if (ux * vy - uy * vx < 0) {
      a = -a;
    }
    return a;
  };

  const theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dTheta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);

  if (!sweep && dTheta > 0) {
    dTheta -= 2 * Math.PI;
  }
  if (sweep && dTheta < 0) {
    dTheta += 2 * Math.PI;
  }

  // Split into segments of at most π/2
  const segments = Math.ceil(Math.abs(dTheta) / (Math.PI / 2));
  const segAngle = dTheta / segments;

  for (let s = 0; s < segments; s++) {
    const t1 = theta1 + s * segAngle;
    const t2 = theta1 + (s + 1) * segAngle;
    const alpha = (4 * Math.tan((t2 - t1) / 4)) / 3;

    const cos1 = Math.cos(t1),
      sin1 = Math.sin(t1);
    const cos2 = Math.cos(t2),
      sin2 = Math.sin(t2);

    const ep1x = rx * cos1,
      ep1y = ry * sin1;
    const ep2x = rx * cos2,
      ep2y = ry * sin2;

    const cp1x = ep1x - alpha * rx * sin1;
    const cp1y = ep1y + alpha * ry * cos1;
    const cp2x = ep2x + alpha * rx * sin2;
    const cp2y = ep2y - alpha * ry * cos2;

    ops.push({
      op: "curve",
      x1: cosPhi * cp1x - sinPhi * cp1y + cxr,
      y1: sinPhi * cp1x + cosPhi * cp1y + cyr,
      x2: cosPhi * cp2x - sinPhi * cp2y + cxr,
      y2: sinPhi * cp2x + cosPhi * cp2y + cyr,
      x3: cosPhi * ep2x - sinPhi * ep2y + cxr,
      y3: sinPhi * ep2x + cosPhi * ep2y + cyr
    });
  }
}
