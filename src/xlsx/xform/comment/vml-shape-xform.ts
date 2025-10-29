import { BaseXform } from "../base-xform.js";
import { VmlTextboxXform } from "./vml-textbox-xform.js";
import { VmlClientDataXform } from "./vml-client-data-xform.js";

interface ShapeModel {
  note: {
    margins?: {
      insetmode?: string;
      inset?: number[];
    };
  };
  refAddress?: any;
}

class VmlShapeXform extends BaseXform {
  declare public map: { [key: string]: any };
  declare public parser: any;
  declare public model: any;

  constructor() {
    super();
    this.map = {
      "v:textbox": new VmlTextboxXform(),
      "x:ClientData": new VmlClientDataXform()
    };
  }

  get tag(): string {
    return "v:shape";
  }

  render(xmlStream: any, model: ShapeModel, index?: number): void {
    xmlStream.openNode("v:shape", VmlShapeXform.V_SHAPE_ATTRIBUTES(model, index || 0));

    xmlStream.leafNode("v:fill", { color2: "infoBackground [80]" });
    xmlStream.leafNode("v:shadow", { color: "none [81]", obscured: "t" });
    xmlStream.leafNode("v:path", { "o:connecttype": "none" });
    this.map["v:textbox"].render(xmlStream, model);
    this.map["x:ClientData"].render(xmlStream, model);

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
          margins: {
            insetmode: node.attributes["o:insetmode"]
          },
          anchor: "",
          editAs: "",
          protection: {}
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
        this.parser = undefined;
      }
      return true;
    }
    switch (name) {
      case this.tag:
        this.model.margins.inset = this.map["v:textbox"].model && this.map["v:textbox"].model.inset;
        this.model.protection =
          this.map["x:ClientData"].model && this.map["x:ClientData"].model.protection;
        this.model.anchor = this.map["x:ClientData"].model && this.map["x:ClientData"].model.anchor;
        this.model.editAs = this.map["x:ClientData"].model && this.map["x:ClientData"].model.editAs;
        return false;
      default:
        return true;
    }
  }

  static V_SHAPE_ATTRIBUTES = (model: ShapeModel, index: number): any => ({
    id: `_x0000_s${1025 + index}`,
    type: "#_x0000_t202",
    style:
      "position:absolute; margin-left:105.3pt;margin-top:10.5pt;width:97.8pt;height:59.1pt;z-index:1;visibility:hidden",
    fillcolor: "infoBackground [80]",
    strokecolor: "none [81]",
    "o:insetmode": model.note.margins && model.note.margins.insetmode
  });
}

export { VmlShapeXform };
