import { BaseCellAnchorXform } from "@excel/xlsx/xform/drawing/base-cell-anchor-xform";
import { CellPositionXform } from "@excel/xlsx/xform/drawing/cell-position-xform";
import type { PositionModel } from "@excel/xlsx/xform/drawing/cell-position-xform";
import { ExtXform } from "@excel/xlsx/xform/drawing/ext-xform";
import type { ExtModel } from "@excel/xlsx/xform/drawing/ext-xform";
import { GraphicFrameXform } from "@excel/xlsx/xform/drawing/graphic-frame-xform";
import type { GraphicFrameModel } from "@excel/xlsx/xform/drawing/graphic-frame-xform";
import { PicXform } from "@excel/xlsx/xform/drawing/pic-xform";
import type { PicModel } from "@excel/xlsx/xform/drawing/pic-xform";
import { ShapeXform } from "@excel/xlsx/xform/drawing/shape-xform";
import type { ShapeRenderModel } from "@excel/xlsx/xform/drawing/shape-xform";
import { StaticXform } from "@excel/xlsx/xform/static-xform";
import type { XmlSink } from "@xml/types";

interface OneCellModel {
  range: {
    editAs?: string;
    tl: PositionModel;
    ext: ExtModel;
  };
  picture?: PicModel;
  shape?: ShapeRenderModel;
  /** Graphic frame model (for charts and other embedded objects) */
  graphicFrame?: GraphicFrameModel;
  medium?: unknown;
}

class OneCellAnchorXform extends BaseCellAnchorXform {
  constructor() {
    super();

    this.map = {
      "xdr:from": new CellPositionXform({ tag: "xdr:from" }),
      "xdr:ext": new ExtXform({ tag: "xdr:ext" }),
      "xdr:pic": new PicXform(),
      "xdr:userShape": new ShapeXform(),
      "xdr:graphicFrame": new GraphicFrameXform(),
      "xdr:clientData": new StaticXform({ tag: "xdr:clientData" })
    };
  }

  get tag(): string {
    return "xdr:oneCellAnchor";
  }

  prepare(model: OneCellModel, options: { index: number }): void {
    if (model.picture) {
      this.map["xdr:pic"].prepare(model.picture, options);
    } else if (model.graphicFrame) {
      this.map["xdr:graphicFrame"].prepare(model.graphicFrame, options);
    }
  }

  render(xmlStream: XmlSink, model: OneCellModel): void {
    // **No attributes.** `editAs` belongs to `CT_TwoCellAnchor` alone — it is the choice between resizing with
    // the cells and keeping a fixed size, which only a two-cell anchor can make. `CT_OneCellAnchor` declares no
    // attributes at all, so `editAs="oneCell"` here was schema-invalid and Excel answered
    // `Repaired Records: Drawing from /xl/drawings/drawingN.xml part (Drawing shape)` for every drawing that
    // contained one. `AbsoluteAnchorXform` had it right; `TwoCellAnchorXform` is where the attribute lives.
    //
    // Nothing is lost by dropping it. Which anchor element gets written is decided by `getAnchorType` from the
    // *shape* of the range — `pos` means absolute, `br` means two-cell, neither means one-cell — so the anchor
    // tag already carries everything `editAs` would have said here. The parser still reads the attribute if a
    // foreign file supplies one, which is deliberate: being strict on write and tolerant on read is the rule.
    xmlStream.openNode(this.tag);

    this.map["xdr:from"].render(xmlStream, model.range.tl);
    this.map["xdr:ext"].render(xmlStream, model.range.ext);
    if (model.picture) {
      this.map["xdr:pic"].render(xmlStream, model.picture);
    } else if (model.graphicFrame) {
      this.map["xdr:graphicFrame"].render(xmlStream, model.graphicFrame);
    } else if (model.shape?.kind === "userShape") {
      this.map["xdr:userShape"].render(xmlStream, model.shape);
    }
    this.map["xdr:clientData"].render(xmlStream, {});

    xmlStream.closeNode();
  }

  parseClose(name: string): boolean {
    if (this.parser) {
      if (!this.parser.parseClose(name)) {
        this.parser = undefined;
      }
      return true;
    }
    switch (name) {
      case this.tag:
        this.model.range.tl = this.map["xdr:from"].model;
        this.model.range.ext = this.map["xdr:ext"].model;
        this.model.picture = this.map["xdr:pic"].model;
        this.model.graphicFrame = this.map["xdr:graphicFrame"].model;
        // **Derived from the element, not read from an attribute.** A one-cell anchor *is* `editAs="oneCell"`
        // — move with the cells, keep a fixed size — so the tag already states it and `CT_OneCellAnchor`
        // rightly has nowhere to repeat it. `AbsoluteAnchorXform`'s consumers do the same thing for
        // `"absolute"` (`drawing-utils.ts` hard-codes it from the shape of the range).
        //
        // The base class fills this in from `node.attributes.editAs`, which is kept as the first choice so a
        // file that carries the invalid attribute anyway still round-trips its value verbatim. Only the
        // default changed, and it is what stops the public `range.editAs` from going undefined now that this
        // writer no longer emits an attribute the schema forbids.
        this.model.range.editAs ??= "oneCell";
        return false;
      default:
        // could be some unrecognised tags
        return true;
    }
  }

  reconcile(
    model: OneCellModel,
    options: Parameters<BaseCellAnchorXform["reconcilePicture"]>[1]
  ): void {
    if (model.picture) {
      model.medium = this.reconcilePicture(model.picture, options);
    }
  }
}

export { OneCellAnchorXform };
