import { BaseXform } from "@excel/xlsx/xform/base-xform";
import type { ParseOpenTag, XmlSink } from "@xml/types";

interface DrawingModel {
  rId: string;
}

class DrawingXform extends BaseXform {
  constructor(private readonly drawingTag = "drawing") {
    super();
  }

  get tag(): string {
    return this.drawingTag;
  }

  render(xmlStream: XmlSink, model?: DrawingModel): void {
    if (model) {
      xmlStream.leafNode(this.tag, { "r:id": model.rId });
    }
  }

  parseOpen(node: ParseOpenTag): boolean {
    switch (node.name) {
      case this.tag:
        this.model = {
          rId: node.attributes["r:id"]
        };
        return true;
      default:
        return false;
    }
  }

  parseText(): void {}

  parseClose(): boolean {
    return false;
  }
}

export { DrawingXform };
