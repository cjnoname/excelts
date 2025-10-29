import { XmlStream } from "../../../utils/xml-stream.js";
import { BaseXform } from "../base-xform.js";
import { VmlShapeXform } from "./vml-shape-xform.js";

interface VmlNotesModel {
  comments: any[];
}

// This class is (currently) single purposed to insert the triangle
// drawing icons on commented cells
class VmlNotesXform extends BaseXform {
  declare public map: { [key: string]: any };
  declare public parser: any;
  declare public model: VmlNotesModel;

  constructor() {
    super();
    this.map = {
      "v:shape": new VmlShapeXform()
    };
    this.model = { comments: [] };
  }

  get tag(): string {
    return "xml";
  }

  render(xmlStream: any, model?: VmlNotesModel): void {
    const renderModel = model || this.model;
    xmlStream.openXml(XmlStream.StdDocAttributes);
    xmlStream.openNode(this.tag, VmlNotesXform.DRAWING_ATTRIBUTES);

    xmlStream.openNode("o:shapelayout", { "v:ext": "edit" });
    xmlStream.leafNode("o:idmap", { "v:ext": "edit", data: 1 });
    xmlStream.closeNode();

    xmlStream.openNode("v:shapetype", {
      id: "_x0000_t202",
      coordsize: "21600,21600",
      "o:spt": 202,
      path: "m,l,21600r21600,l21600,xe"
    });
    xmlStream.leafNode("v:stroke", { joinstyle: "miter" });
    xmlStream.leafNode("v:path", { gradientshapeok: "t", "o:connecttype": "rect" });
    xmlStream.closeNode();

    renderModel.comments.forEach((item, index) => {
      this.map["v:shape"].render(xmlStream, item, index);
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
          comments: []
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
        this.model.comments.push(this.parser.model);
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

  reconcile(model: any, options: any): void {
    model.anchors.forEach((anchor: any) => {
      if (anchor.br) {
        this.map["xdr:twoCellAnchor"].reconcile(anchor, options);
      } else {
        this.map["xdr:oneCellAnchor"].reconcile(anchor, options);
      }
    });
  }

  static DRAWING_ATTRIBUTES = {
    "xmlns:v": "urn:schemas-microsoft-com:vml",
    "xmlns:o": "urn:schemas-microsoft-com:office:office",
    "xmlns:x": "urn:schemas-microsoft-com:office:excel"
  };
}

export { VmlNotesXform };
