import { colCache } from "../../../utils/col-cache.js";
import { XmlStream } from "../../../utils/xml-stream.js";
import { BaseXform } from "../base-xform.js";
import { TwoCellAnchorXform } from "./two-cell-anchor-xform.js";
import { OneCellAnchorXform } from "./one-cell-anchor-xform.js";

function getAnchorType(model: any): string {
  const range = typeof model.range === "string" ? colCache.decode(model.range) : model.range;

  return range.br ? "xdr:twoCellAnchor" : "xdr:oneCellAnchor";
}

interface DrawingModel {
  anchors: any[];
}

class DrawingXform extends BaseXform {
  declare public map: { [key: string]: any };
  declare public parser: any;
  declare public model: DrawingModel;

  constructor() {
    super();

    this.map = {
      "xdr:twoCellAnchor": new TwoCellAnchorXform(),
      "xdr:oneCellAnchor": new OneCellAnchorXform()
    };
    this.model = { anchors: [] };
  }

  prepare(model: DrawingModel): void {
    model.anchors.forEach((item, index) => {
      item.anchorType = getAnchorType(item);
      const anchor = this.map[item.anchorType];
      anchor.prepare(item, { index });
    });
  }

  get tag(): string {
    return "xdr:wsDr";
  }

  render(xmlStream: any, model?: DrawingModel): void {
    const renderModel = model || this.model;
    xmlStream.openXml(XmlStream.StdDocAttributes);
    xmlStream.openNode(this.tag, DrawingXform.DRAWING_ATTRIBUTES);

    renderModel.anchors.forEach(item => {
      const anchor = this.map[item.anchorType];
      anchor.render(xmlStream, item);
    });

    xmlStream.closeNode();
  }

  parseOpen(node: any): boolean {
    if (this.parser) {
      this.parser.parseOpen(node);
      return true;
    }
    switch (node.name) {
      case this.tag:
        this.reset();
        this.model = {
          anchors: []
        };
        break;
      default:
        this.parser = this.map[node.name];
        if (this.parser) {
          this.parser.parseOpen(node);
        }
        break;
    }
    return true;
  }

  parseText(text: string): void {
    if (this.parser) {
      this.parser.parseText(text);
    }
  }

  parseClose(name: string): boolean {
    if (this.parser) {
      if (!this.parser.parseClose(name)) {
        this.model.anchors.push(this.parser.model);
        this.parser = undefined;
      }
      return true;
    }
    switch (name) {
      case this.tag:
        return false;
      default:
        // could be some unrecognised tags
        return true;
    }
  }

  reconcile(model: DrawingModel, options: any): void {
    model.anchors.forEach(anchor => {
      if (anchor.br) {
        this.map["xdr:twoCellAnchor"].reconcile(anchor, options);
      } else {
        this.map["xdr:oneCellAnchor"].reconcile(anchor, options);
      }
    });
  }

  static DRAWING_ATTRIBUTES = {
    "xmlns:xdr": "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing",
    "xmlns:a": "http://schemas.openxmlformats.org/drawingml/2006/main"
  };
}

export { DrawingXform };
