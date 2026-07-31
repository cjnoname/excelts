import type { AnchorData, AnchorModel } from "@excel/core/anchor";
import { anchorClone, anchorCreate, anchorModel } from "@excel/core/anchor";
import type { Worksheet } from "@excel/core/worksheet";
import { ImageError } from "@excel/errors";
import { colCache } from "@excel/utils/col-cache";

interface ImageHyperlinks {
  hyperlink?: string;
  tooltip?: string;
}

interface ImageExt {
  width?: number;
  height?: number;
}

/** Absolute position in pixels (for absoluteAnchor). */
interface ImagePos {
  x: number;
  y: number;
}

interface ImageRange {
  tl: AnchorData;
  br?: AnchorData;
  ext?: ImageExt;
  editAs?: string;
  hyperlinks?: ImageHyperlinks;
  /** Absolute position — mutually exclusive with tl/br cell anchors. */
  pos?: ImagePos;
}

interface BackgroundModel {
  type: "background";
  imageId: string;
}

interface WatermarkModel {
  type: "watermark";
  imageId: string;
  /** Opacity 0-1 for overlay mode */
  opacity?: number;
}

interface HeaderImageModel {
  type: "headerImage";
  imageId: string;
  headerWidth?: number;
  headerHeight?: number;
  applyTo?: "all" | "odd" | "even" | "first";
  /** Excel header/footer image section. */
  position?: "LH" | "CH" | "RH" | "LF" | "CF" | "RF";
}

interface ImageRangeModel {
  tl: AnchorModel;
  br?: AnchorModel;
  ext?: ImageExt;
  editAs?: string;
  /** Absolute position — when present, tl/br are ignored. */
  pos?: ImagePos;
}

interface ImageModel {
  type: "image";
  imageId: string;
  hyperlinks?: ImageHyperlinks;
  range: ImageRangeModel;
  /** See `xfrmOffX` on {@link ModelInput}. */
  xfrmOffX?: number;
  xfrmOffY?: number;
  xfrmExtCx?: number;
  xfrmExtCy?: number;
  rawSpPr?: unknown;
}

type Model = BackgroundModel | ImageModel | WatermarkModel | HeaderImageModel;
type ImageModelInput = ModelInput;

interface RangeInput {
  tl?: AnchorModel | { col: number; row: number } | string;
  br?: AnchorModel | { col: number; row: number } | string;
  ext?: ImageExt;
  editAs?: string;
  hyperlinks?: ImageHyperlinks;
  /** Absolute position — when present, tl/br are ignored. */
  pos?: ImagePos;
}

interface ModelInput {
  type: string;
  imageId: string;
  range?: string | RangeInput | ImageRangeModel;
  hyperlinks?: ImageHyperlinks;
  opacity?: number;
  headerWidth?: number;
  headerHeight?: number;
  applyTo?: "all" | "odd" | "even" | "first";
  position?: "LH" | "CH" | "RH" | "LF" | "CF" | "RF";
  /**
   * Absolute position/size from the picture's original `<xdr:spPr><a:xfrm>`,
   * in EMU. For an `editAs="oneCell"` picture this is what Excel renders from —
   * `tl`/`br` are only a cache. Round-trip-only (no public setter): dropping it
   * on a plain re-save rendered the picture at (0,0) with zero size.
   */
  xfrmOffX?: number;
  xfrmOffY?: number;
  xfrmExtCx?: number;
  xfrmExtCy?: number;
  rawSpPr?: unknown;
}

/**
 * Plain-data worksheet image / background / watermark / header-image
 * (de-classed domain model). Carries the owning worksheet plus the decoded
 * fields; serialization (`imageModel`) and (re)hydration (`applyImageModel`)
 * are flat helpers, mirroring the former getter/setter + clone.
 */
export interface ImageData {
  readonly worksheet: Worksheet;
  type?: string;
  imageId?: string;
  range?: ImageRange;
  /** Opacity for watermark overlay mode (0-1). */
  opacity?: number;
  /** Header image width in points. */
  headerWidth?: number;
  /** Header image height in points. */
  headerHeight?: number;
  /** Header watermark applyTo setting. */
  applyTo?: "all" | "odd" | "even" | "first";
  /** Excel header/footer image section. */
  position?: "LH" | "CH" | "RH" | "LF" | "CF" | "RF";
  /** See `xfrmOffX` on {@link ModelInput}. */
  xfrmOffX?: number;
  xfrmOffY?: number;
  xfrmExtCx?: number;
  xfrmExtCy?: number;
  rawSpPr?: unknown;
}

/** Create an image record, optionally hydrating it from a model input. */
export function imageCreate(worksheet: Worksheet, model?: ModelInput): ImageData {
  const img: ImageData = { worksheet };
  if (model) {
    applyImageModel(img, model);
  }
  return img;
}

/** Serialize an image record to its persisted {@link Model}. */
export function imageModel(img: ImageData): Model {
  switch (img.type) {
    case "background":
      return {
        type: img.type,
        imageId: img.imageId ?? ""
      };
    case "watermark":
      return {
        type: img.type,
        imageId: img.imageId ?? "",
        opacity: img.opacity
      };
    case "headerImage":
      return {
        type: img.type,
        imageId: img.imageId ?? "",
        headerWidth: img.headerWidth,
        headerHeight: img.headerHeight,
        applyTo: img.applyTo,
        position: img.position
      };
    case "image": {
      const range = img.range;
      if (!range) {
        throw new ImageError("Image has no range");
      }
      // Absolute positioning — no cell anchors
      if (range.pos) {
        return {
          type: img.type,
          imageId: img.imageId ?? "",
          hyperlinks: range.hyperlinks,
          range: {
            tl: { nativeCol: 0, nativeColOff: 0, nativeRow: 0, nativeRowOff: 0 },
            ext: range.ext,
            pos: range.pos
          }
        };
      }
      return {
        type: img.type,
        imageId: img.imageId ?? "",
        hyperlinks: range.hyperlinks,
        range: {
          tl: anchorModel(range.tl),
          br: range.br ? anchorModel(range.br) : undefined,
          ext: range.ext,
          editAs: range.editAs
        },
        xfrmOffX: img.xfrmOffX,
        xfrmOffY: img.xfrmOffY,
        xfrmExtCx: img.xfrmExtCx,
        xfrmExtCy: img.xfrmExtCy,
        rawSpPr: img.rawSpPr
      };
    }
    default:
      throw new ImageError("Invalid Image Type");
  }
}

/** Hydrate an image record from a model input (mutates in place). */
export function applyImageModel(
  img: ImageData,
  {
    type,
    imageId,
    range,
    hyperlinks,
    opacity,
    headerWidth,
    headerHeight,
    applyTo,
    position,
    xfrmOffX,
    xfrmOffY,
    xfrmExtCx,
    xfrmExtCy,
    rawSpPr
  }: ModelInput
): void {
  img.type = type;
  img.imageId = imageId;
  img.opacity = opacity;
  img.headerWidth = headerWidth;
  img.headerHeight = headerHeight;
  img.applyTo = applyTo;
  img.position = position;
  img.xfrmOffX = xfrmOffX;
  img.xfrmOffY = xfrmOffY;
  img.xfrmExtCx = xfrmExtCx;
  img.xfrmExtCy = xfrmExtCy;
  img.rawSpPr = rawSpPr;

  if (type === "image") {
    if (typeof range === "string") {
      const decoded = colCache.decode(range);
      if ("top" in decoded) {
        // It's a Location (range like "A1:C3")
        img.range = {
          tl: anchorCreate(img.worksheet, { col: decoded.left, row: decoded.top }, -1),
          br: anchorCreate(img.worksheet, { col: decoded.right, row: decoded.bottom }, 0),
          editAs: "oneCell"
        };
      }
    } else if (range && "pos" in range && range.pos) {
      // Absolute positioning — preserve pos/ext, use dummy tl anchor
      img.range = {
        tl: anchorCreate(img.worksheet, null, 0),
        ext: range.ext,
        hyperlinks: hyperlinks || ("hyperlinks" in range ? range.hyperlinks : undefined),
        pos: range.pos
      };
    } else if (range) {
      // Anchor inputs:
      //   - string addresses ("A1") are 1-based; the internal anchor uses
      //     0-based nativeCol/nativeRow, so the top-left address is shifted
      //     by -1. The bottom-right address is intentionally NOT shifted —
      //     this matches the string-range path (e.g. "A1:B2") where br
      //     anchors the cell *past* the address (i.e. its right/bottom edge).
      //   - object inputs ({ col, row } / AnchorModel) already use the
      //     0-based convention and are passed through as-is.
      const tlInput = range.tl;
      const brInput = range.br;
      img.range = {
        tl: anchorCreate(img.worksheet, tlInput, typeof tlInput === "string" ? -1 : 0),
        br: brInput ? anchorCreate(img.worksheet, brInput, 0) : undefined,
        ext: range.ext,
        editAs: range.editAs,
        hyperlinks: hyperlinks || ("hyperlinks" in range ? range.hyperlinks : undefined)
      };
    }
  }
}

/** Clone an image record, optionally rebinding it to a different worksheet. */
export function imageClone(img: ImageData, worksheet?: Worksheet): ImageData {
  const target = worksheet ?? img.worksheet;
  const cloned: ImageData = { worksheet: target };
  cloned.type = img.type;
  cloned.imageId = img.imageId;
  cloned.opacity = img.opacity;
  cloned.headerWidth = img.headerWidth;
  cloned.headerHeight = img.headerHeight;
  cloned.applyTo = img.applyTo;
  cloned.xfrmOffX = img.xfrmOffX;
  cloned.xfrmOffY = img.xfrmOffY;
  cloned.xfrmExtCx = img.xfrmExtCx;
  cloned.xfrmExtCy = img.xfrmExtCy;
  cloned.rawSpPr = structuredClone(img.rawSpPr);

  if (img.range) {
    cloned.range = {
      tl: anchorClone(img.range.tl, target),
      br: img.range.br ? anchorClone(img.range.br, target) : undefined,
      ext: img.range.ext ? { ...img.range.ext } : undefined,
      editAs: img.range.editAs,
      hyperlinks: img.range.hyperlinks ? { ...img.range.hyperlinks } : undefined,
      pos: img.range.pos ? { ...img.range.pos } : undefined
    };
  }

  return cloned;
}

export { type Model as ImageModel, type ImageModelInput };
