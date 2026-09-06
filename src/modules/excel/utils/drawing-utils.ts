/**
 * Shared utilities for building drawing models (anchors + relationships)
 * used by both the streaming WorksheetWriter and the non-streaming WorkSheetXform.
 *
 * This eliminates the duplicated anchor/rel building logic and provides
 * a single, correct image-rel deduplication strategy.
 */

import { mediaRelTargetFromRels } from "@excel/utils/ooxml-paths";
import { RelType } from "@excel/xlsx/rel-type";

// =============================================================================
// Types
// =============================================================================

/** An anchor's placement: cell anchors (tl/br), absolute (pos/ext), or string ref. */
type DrawingRange =
  | string
  | {
      tl?: unknown;
      br?: unknown;
      pos?: { x: number; y: number };
      ext?: { cx: number; cy: number } | { width: number; height: number };
      editAs?: string;
    };

export interface DrawingAnchor {
  picture: {
    rId: string;
    hyperlinks?: { tooltip?: string; rId: string };
    /** Alpha modulation for transparency (OOXML percentage, e.g. 15000 = 15%). */
    alphaModFix?: number;
    /**
     * When true, the picture references an external linked image
     * (`<a:blip r:link>`) instead of an embedded one (`<a:blip r:embed>`).
     */
    external?: boolean;
    /**
     * Relationship id of an SVG companion. When set, the raster `a:blip`
     * (referenced by `rId`) carries an `asvg:svgBlip` extension pointing at
     * the SVG media via this id.
     */
    svgRId?: string;
    /**
     * Absolute position/size from the picture's `<xdr:spPr><a:xfrm>`, in EMU,
     * carried through from the source file so a round-trip preserves it.
     */
    xfrmOffX?: number;
    xfrmOffY?: number;
    xfrmExtCx?: number;
    xfrmExtCy?: number;
    rawSpPr?: unknown;
  };
  range: DrawingRange;
}

export interface DrawingRel {
  Id: string;
  Type: string;
  Target: string;
  TargetMode?: string;
}

export interface DrawingModel {
  anchors: DrawingAnchor[];
  rels: DrawingRel[];
}

/**
 * One placed picture, as {@link buildDrawingAnchorsAndRels} takes it.
 *
 * Exported because both container writers hand it this shape, and a caller that has to cast into an
 * unexported parameter type loses the only check that its own model still matches.
 */
export interface ImageMedium {
  imageId: string | number;
  range: DrawingRange;
  hyperlinks?: { hyperlink?: string; tooltip?: string };
  /** Opacity 0-1 for watermark overlay mode. */
  opacity?: number;
  /** Absolute geometry from the source `<xdr:spPr><a:xfrm>` (EMU), if any. */
  xfrmOffX?: number;
  xfrmOffY?: number;
  xfrmExtCx?: number;
  xfrmExtCy?: number;
  rawSpPr?: unknown;
}

/**
 * Minimal shape of a book-level media entry needed by the embed-vs-link
 * decision and image-rel construction. Carries the optional link target plus
 * the three mutually-exclusive embedded byte sources.
 */
export interface MediaLike {
  name?: string;
  extension?: string;
  link?: string;
  buffer?: unknown;
  base64?: unknown;
  filename?: unknown;
  /** Media index of an SVG companion (raster blip + svgBlip extension). */
  svgMediaId?: number;
}

/**
 * Resolves a media filename into the drawing-level relative target path.
 *
 * In the non-streaming path, media entries have separate `name` and `extension`
 * fields (e.g. name="image0", extension="png").
 * In the streaming path, `name` already includes the extension (e.g. "image0.png").
 *
 * This function accepts both forms and returns e.g. `"../media/image0.png"`.
 */
export function resolveMediaTarget(medium: { name?: string; extension?: string }): string {
  // When name already contains the extension (streaming path), use it directly.
  // Otherwise concatenate name + extension (non-streaming path).
  // Note: name may be undefined in the non-streaming path; we preserve the legacy
  // behavior of `${undefined}.${ext}` = "undefined.ext" to match addMedia().
  const filename =
    medium.name && medium.extension && medium.name.endsWith(`.${medium.extension}`)
      ? medium.name
      : `${medium.name}.${medium.extension}`;
  return mediaRelTargetFromRels(filename);
}

/**
 * Determine whether a media entry is an **external (linked) image** rather than
 * an embedded one. An external image carries a `link` target and supplies no
 * embedded bytes (`buffer`/`base64`/`filename`). Embedding always takes
 * precedence: if any byte source is present the image is embedded even if a
 * `link` was also provided.
 */
export function isExternalImage(medium: MediaLike): boolean {
  return !!medium.link && medium.buffer == null && medium.base64 == null && medium.filename == null;
}

/**
 * Best-effort image extension inference from an external link's path.
 *
 * Normalises to the extension vocabulary used by `ImageData`
 * (`"jpeg" | "png" | "gif"`); unknown extensions fall back to `"png"`.
 * The extension is advisory only for linked images — the relationship
 * Target carries the real reference — but keeping it within the documented
 * set avoids surprising consumers that branch on `medium.extension`.
 */
export function inferExternalImageExtension(link: string): "jpeg" | "png" | "gif" {
  const match = /\.([a-zA-Z0-9]{2,5})(?:[?#].*)?$/.exec(link);
  const ext = match ? match[1].toLowerCase() : "";
  switch (ext) {
    case "jpg":
    case "jpeg":
      return "jpeg";
    case "gif":
      return "gif";
    case "png":
    default:
      return "png";
  }
}

// =============================================================================
// Anchor / Rel Building
// =============================================================================

/**
 * Build an image relationship for the given rId, choosing between an embedded
 * package target (`../media/imageN.ext`) and an external link target
 * (`TargetMode="External"`) based on whether the image is external.
 *
 * Shared by the drawing, background, and watermark write paths so the
 * embed-vs-link decision lives in exactly one place.
 */
export function buildImageRel(rId: string, bookImage: MediaLike): DrawingRel {
  if (isExternalImage(bookImage)) {
    return {
      Id: rId,
      Type: RelType.Image,
      Target: bookImage.link as string,
      TargetMode: "External"
    };
  }
  return {
    Id: rId,
    Type: RelType.Image,
    Target: resolveMediaTarget(bookImage)
  };
}

/** Options for {@link buildDrawingAnchorsAndRels}. */
interface BuildDrawingOptions {
  /** Look up a book-level image by its id. Return `undefined` if not found. */
  getBookImage: (imageId: string | number) => MediaLike | undefined;

  /** Generate the next unique rId string for the drawing rels. */
  nextRId: (rels: DrawingRel[]) => string;
}

/**
 * Build the drawing anchors and relationships from a list of image media entries.
 *
 * This is the core logic shared between:
 * - `WorksheetWriter._writeDrawing()` (streaming)
 * - `WorkSheetXform.prepare()` (non-streaming)
 *
 * It correctly deduplicates image rels: if the same `imageId` is used for
 * multiple anchors, only one image relationship is created and shared.
 */
export function buildDrawingAnchorsAndRels(
  media: ImageMedium[],
  existingRels: DrawingRel[],
  options: BuildDrawingOptions
): DrawingModel {
  const anchors: DrawingAnchor[] = [];
  const rels: DrawingRel[] = [...existingRels];

  // Map imageId → rId for deduplication (handles non-consecutive duplicates correctly)
  const imageRIdMap: Record<string, string> = {};

  for (const medium of media) {
    const imageId = String(medium.imageId);
    const bookImage = options.getBookImage(medium.imageId);
    if (!bookImage) {
      continue;
    }

    // An external (linked) image has a `link` target and no embedded bytes.
    const isExternal = isExternalImage(bookImage);

    // Deduplicate: reuse rId if same imageId already has a drawing rel
    let rIdImage = imageRIdMap[imageId];
    if (!rIdImage) {
      rIdImage = options.nextRId(rels);
      imageRIdMap[imageId] = rIdImage;
      rels.push(buildImageRel(rIdImage, bookImage));
    }

    const anchor: DrawingAnchor = {
      picture: {
        rId: rIdImage,
        ...(isExternal ? { external: true } : {})
      },
      range: medium.range
    };

    // Carry the source picture's absolute geometry through the rebuild so a
    // plain round-trip doesn't zero an `editAs="oneCell"` picture's position
    // and size. Only set keys that are actually present to avoid littering the
    // anchor (and its rendered `<a:xfrm>`) with undefined values.
    if (medium.xfrmOffX !== undefined) {
      anchor.picture.xfrmOffX = medium.xfrmOffX;
    }
    if (medium.xfrmOffY !== undefined) {
      anchor.picture.xfrmOffY = medium.xfrmOffY;
    }
    if (medium.xfrmExtCx !== undefined) {
      anchor.picture.xfrmExtCx = medium.xfrmExtCx;
    }
    if (medium.xfrmExtCy !== undefined) {
      anchor.picture.xfrmExtCy = medium.xfrmExtCy;
    }
    if (medium.rawSpPr !== undefined) {
      anchor.picture.rawSpPr = structuredClone(medium.rawSpPr);
    }

    // SVG companion: allocate (and dedupe) a rel for the vector media, then
    // record its rId so the blip serializer emits the asvg:svgBlip extension.
    if (bookImage.svgMediaId !== undefined) {
      const svgKey = `svg:${bookImage.svgMediaId}`;
      let rIdSvg = imageRIdMap[svgKey];
      if (!rIdSvg) {
        const svgImage = options.getBookImage(bookImage.svgMediaId);
        if (svgImage) {
          rIdSvg = options.nextRId(rels);
          imageRIdMap[svgKey] = rIdSvg;
          rels.push(buildImageRel(rIdSvg, svgImage));
        }
      }
      if (rIdSvg) {
        anchor.picture.svgRId = rIdSvg;
      }
    }

    // Pass through watermark opacity as alphaModFix
    if (medium.opacity !== undefined) {
      const clamped = Math.max(0, Math.min(1, medium.opacity));
      anchor.picture.alphaModFix = Math.round(clamped * 100000);
    }

    // Handle image hyperlinks
    if (medium.hyperlinks && medium.hyperlinks.hyperlink) {
      const rIdHyperlink = options.nextRId(rels);
      anchor.picture.hyperlinks = {
        tooltip: medium.hyperlinks.tooltip,
        rId: rIdHyperlink
      };
      rels.push({
        Id: rIdHyperlink,
        Type: RelType.Hyperlink,
        Target: medium.hyperlinks.hyperlink,
        TargetMode: "External"
      });
    }

    anchors.push(anchor);
  }

  return { anchors, rels };
}

// =============================================================================
// Anchor Filtering
// =============================================================================

/**
 * Filter drawing anchors to remove invalid entries before XML generation.
 *
 * Shared between streaming `WorkbookWriterBase.addDrawings()` and
 * non-streaming `XLSX.addDrawings()`.
 */
export function filterDrawingAnchors<
  T extends {
    range?: string | { pos?: unknown; br?: unknown };
    picture?: unknown;
    graphicFrame?: unknown;
    shape?: unknown;
    group?: unknown;
  } | null
>(anchors: T[]): T[] {
  return anchors.filter(a => {
    if (a == null) {
      return false;
    }
    // A string range (named-cell ref) carries no pos/br; treat it as a
    // cell-anchor with neither, falling through to the validity checks below.
    const range = typeof a.range === "string" ? undefined : a.range;
    // Absolute anchors need either a picture (image with pos+ext) or a
    // graphicFrame (chart placed via `{ pos, ext }`). The previous
    // filter returned `!!a.picture` for every absolute anchor,
    // silently dropping every chart anchored via `{ pos: { x, y },
    // ext: { cx, cy } }` on write — the drawing XML came out empty
    // and the chart disappeared from the saved file.
    if (range?.pos !== undefined) {
      return !!a.picture || !!a.graphicFrame || !!a.shape || !!a.group;
    }
    // Form controls have range.br and shape properties
    if (range?.br && a.shape) {
      return true;
    }
    // Grouped shapes (`<xdr:grpSp>`, captured verbatim by GenericEchoXform)
    // carry neither picture/shape/graphicFrame — they are a valid anchor
    // payload in their own right and must survive the write filter.
    if (a.group) {
      return true;
    }
    // One-cell anchors need a valid picture, graphicFrame (charts) or shape.
    if (!range?.br && !a.picture && !a.graphicFrame && !a.shape) {
      return false;
    }
    // Two-cell anchors need either picture, shape, or graphicFrame (charts)
    if (range?.br && !a.picture && !a.shape && !a.graphicFrame) {
      return false;
    }
    return true;
  });
}

/**
 * Anchors for a sheet's user-drawn shapes.
 *
 * Extracted from the XLSX worksheet xform, where it was sixty inline lines. That was fine while one
 * caller existed; the XLSB writer is a second, and shape anchoring is exactly the kind of arithmetic
 * that two implementations get subtly differently — the three anchoring modes below are dispatched on
 * which fields are *present*, not on a discriminator, so a caller that forgot `ext` in the one-cell case
 * produces a shape with no size and no error.
 *
 * `startIndex` is the number of anchors already in the drawing. `cNvPrId` has to be unique across the
 * whole part, and image and chart ids derive from their anchor position — so a shape numbering itself
 * from 1 would collide with the first picture.
 */
export function buildShapeAnchors(
  shapes: readonly ShapeLike[],
  startIndex: number
): DrawingAnchor[] {
  const anchors: DrawingAnchor[] = [];
  for (const shape of shapes) {
    const anchorRange = shape.anchorRange;
    if (!anchorRange) {
      continue;
    }
    // The three modes `getAnchorType` dispatches on: absolute when `pos` is present, two-cell when `br`
    // is, one-cell otherwise — and one-cell needs `ext`, because there is no second corner to size it.
    const range =
      anchorRange.pos !== undefined
        ? { pos: anchorRange.pos, ext: anchorRange.ext, editAs: "absolute" as const }
        : anchorRange.br !== undefined
          ? { tl: anchorRange.tl, br: anchorRange.br, editAs: anchorRange.editAs ?? "oneCell" }
          : { tl: anchorRange.tl, ext: anchorRange.ext, editAs: anchorRange.editAs ?? "oneCell" };
    const cNvPrId = startIndex + anchors.length + 1;
    anchors.push({
      range,
      shape: {
        kind: "userShape",
        cNvPrId,
        name: shape.name ?? `Shape ${cNvPrId}`,
        shapeType: shape.shapeType,
        fill: shape.fillColor ? { color: shape.fillColor } : undefined,
        line:
          shape.lineColor !== undefined || shape.lineWidth !== undefined
            ? { color: shape.lineColor, width: shape.lineWidth }
            : undefined,
        text: shape.text
      }
    } as unknown as DrawingAnchor);
  }
  return anchors;
}

/** The shape fields an anchor is built from. */
export interface ShapeLike {
  readonly anchorRange?: {
    readonly pos?: unknown;
    readonly ext?: unknown;
    readonly tl?: unknown;
    readonly br?: unknown;
    readonly editAs?: string;
  };
  readonly name?: string;
  readonly shapeType?: string;
  readonly fillColor?: unknown;
  readonly lineColor?: unknown;
  readonly lineWidth?: unknown;
  readonly text?: unknown;
}

/**
 * Anchors for a sheet's legacy form controls.
 *
 * Extracted from the XLSX worksheet xform alongside {@link buildShapeAnchors}, and for the same reason:
 * the XLSB writer is a second caller, and two implementations of "where does this checkbox sit" diverge
 * quietly.
 *
 * **A form control is three things, not one.** The DrawingML anchor here is a *hidden bridge* to the VML
 * shape that actually draws it — Excel writes one when it repairs a sheet with legacy controls and no
 * `<drawing>` part, which is why it exists at all. The control's own properties live in a third part,
 * `xl/ctrlProps/ctrlPropN.xml`, reached by its own relationship. Omitting any of the three leaves a
 * control Excel offers to repair.
 *
 * `spid` is the link: the anchor names `_x0000_s{shapeId}` and the VML shape carries the same id.
 */
export function buildFormControlAnchors(
  controls: readonly FormControlLike[],
  startIndex: number
): DrawingAnchor[] {
  void startIndex;
  const anchors: DrawingAnchor[] = [];
  for (const control of controls) {
    if (control.tl === undefined || control.br === undefined) {
      continue;
    }
    // `shapeId` is the control's own, not derived from the anchor position — the VML shape shares it, so
    // renumbering here would break the bridge.
    const shapeId = control.shapeId ?? 1025;
    anchors.push({
      range: {
        editAs: "absolute",
        tl: toNativeAnchorPos(control.tl),
        br: toNativeAnchorPos(control.br)
      },
      alternateContent: { requires: "a14" },
      shape: {
        cNvPrId: shapeId,
        // Excel's own default, and the arithmetic is its: legacy shape ids start at 1025.
        name: control.name || `Check Box ${Math.max(1, shapeId - 1024)}`,
        hidden: true,
        spid: `_x0000_s${shapeId}`,
        text: control.text
      }
    } as unknown as DrawingAnchor);
  }
  return anchors;
}

/** A control's corner in the `native*` shape an anchor wants. */
function toNativeAnchorPos(position: {
  col: number;
  colOff: number;
  row: number;
  rowOff: number;
}): { nativeCol: number; nativeColOff: number; nativeRow: number; nativeRowOff: number } {
  return {
    nativeCol: position.col,
    nativeColOff: position.colOff,
    nativeRow: position.row,
    nativeRowOff: position.rowOff
  };
}

/** The form-control fields an anchor is built from. */
export interface FormControlLike {
  readonly shapeId?: number;
  readonly name?: string;
  readonly text?: unknown;
  readonly tl?: { col: number; colOff: number; row: number; rowOff: number };
  readonly br?: { col: number; colOff: number; row: number; rowOff: number };
}

/**
 * Anchors and drawing relationships for a sheet's charts.
 *
 * Extracted alongside {@link buildShapeAnchors} and {@link buildFormControlAnchors}, and this one carries
 * the detail most likely to be got wrong twice: **a chart anchor's absolute position is in EMU in the
 * model and in pixels in the anchor.** `PosXform`/`ExtXform` multiply by `EMU_PER_PIXEL_AT_96_DPI` on
 * render, so passing EMU straight through overshoots by 9525× — and `ext` carries `{ cx, cy }` in the
 * model where the xform reads `{ width, height }`, which renders as `NaN`.
 *
 * A chart also needs a relationship *from the drawing*, not from the sheet: the drawing's `graphicFrame`
 * names it. `nextRelationshipId` is supplied so the caller controls the id space it comes from.
 */
export function buildChartAnchors(
  charts: readonly ChartAnchorLike[],
  drawingRels: DrawingRel[]
): DrawingAnchor[] {
  const anchors: DrawingAnchor[] = [];
  for (const chart of charts) {
    const range: Record<string, unknown> = { ...chart.range };
    if (chart.range?.pos !== undefined) {
      range.pos = { x: emuToPixels(chart.range.pos.x), y: emuToPixels(chart.range.pos.y) };
    }
    if (chart.range?.ext?.cx !== undefined) {
      range.ext = {
        width: emuToPixels(chart.range.ext.cx),
        height: emuToPixels(chart.range.ext.cy)
      };
    }
    const relationshipId = `rId${drawingRels.length + 1}`;
    const isChartEx = (chart.chartExNumber ?? 0) > 0;
    const number = isChartEx ? chart.chartExNumber! : chart.chartNumber!;
    drawingRels.push({
      Id: relationshipId,
      // **`RelType.ChartEx`, not a literal.** This URI was written out by hand here and it was wrong twice over:
      // `…/office/drawing/2014/chartex` where the relationship type is `…/office/2014/relationships/chartEx` —
      // a different path *and* a different case. Relationship type URIs are case-sensitive (unlike part names),
      // so Excel did not recognise the relationship, could not resolve the `graphicFrame` that named it, and
      // answered `Removed Part: /xl/drawings/drawingN.xml (Drawing shape)`: a drawing pointing at a relationship
      // it cannot understand is not a drawing.
      //
      // `RelType` had the correct constant all along and this file already imports it for images. A hand-written
      // copy of a URI is a copy that can be wrong on its own, and this one was.
      Type: isChartEx ? RelType.ChartEx : RelType.Chart,
      Target: isChartEx ? `../charts/chartEx${number}.xml` : `../charts/chart${number}.xml`
    } as DrawingRel);
    anchors.push({
      range,
      ...(isChartEx ? { chartExNumber: number } : { chartNumber: number }),
      ...(isChartEx ? { alternateContent: { requires: "cx1" } } : {}),
      graphicFrame: {
        rId: relationshipId,
        ...(isChartEx ? { isChartEx: true } : {}),
        name: `Chart ${number}`
      }
    } as unknown as DrawingAnchor);
  }
  return anchors;
}

/** EMU to pixels at 96 dpi, the unit the drawing xforms expect. */
function emuToPixels(value: number): number {
  return Math.round(value / 9525);
}

/** The chart-anchor fields a drawing anchor is built from. */
export interface ChartAnchorLike {
  readonly chartNumber?: number;
  readonly chartExNumber?: number;
  readonly range?: {
    readonly pos?: { x: number; y: number };
    readonly ext?: { cx: number; cy: number };
    readonly tl?: unknown;
    readonly br?: unknown;
    readonly editAs?: string;
  };
}

/**
 * The anchors and relationships an *overlay* watermark needs — a picture stretched over the sheet's data
 * area with an alpha applied, which is how Excel expresses a watermark that sits behind the cells.
 *
 * Shared because the XLSB writer had no version of this at all and silently routed an overlay watermark
 * into the header/footer VML instead: the picture came back as a `headerImage` at the centre of the page
 * header, with its opacity dropped. That is not a lossy write, it is a *different document* — and it read
 * back cleanly, so nothing pointed at it.
 *
 * `alphaModFix` is a percentage in hundred-thousandths, and the default of 0.15 is Excel's own for a
 * watermark rather than a value chosen here.
 */
export function buildWatermarkOverlayAnchors(
  watermarks: readonly { readonly imageId: string | number; readonly opacity?: number }[],
  options: {
    readonly getBookImage: (imageId: string | number) => MediaLike | undefined;
    readonly nextRId: (rels: readonly DrawingRel[]) => string;
    /** The sheet's data extent, so the picture covers what the sheet actually uses. */
    readonly extent?: { readonly right?: number; readonly bottom?: number };
  },
  rels: DrawingRel[]
): DrawingAnchor[] {
  const anchors: DrawingAnchor[] = [];
  // A generous floor, because a watermark over a two-cell sheet should still look like a watermark.
  const right = Math.max(options.extent?.right ?? 100, 100);
  const bottom = Math.max(options.extent?.bottom ?? 200, 200);
  for (const watermark of watermarks) {
    const bookImage = options.getBookImage(watermark.imageId);
    if (bookImage === undefined) {
      continue;
    }
    const rIdImage = options.nextRId(rels);
    rels.push(buildImageRel(rIdImage, bookImage));
    const opacity = Math.max(0, Math.min(1, watermark.opacity ?? 0.15));
    anchors.push({
      picture: {
        rId: rIdImage,
        alphaModFix: Math.round(opacity * 100000),
        ...(isExternalImage(bookImage) ? { external: true } : {})
      },
      range: {
        editAs: "absolute",
        tl: { nativeCol: 0, nativeColOff: 0, nativeRow: 0, nativeRowOff: 0 },
        br: { nativeCol: right, nativeColOff: 0, nativeRow: bottom, nativeRowOff: 0 }
      }
    } as DrawingAnchor);
  }
  return anchors;
}
