import { BaseXform } from "../base-xform.js";

class HLinkClickXform extends BaseXform {
  declare public model: any;

  constructor() {
    super();
    this.model = {};
  }

  get tag(): string {
    return "a:hlinkClick";
  }

  render(xmlStream: any, model: any): void {
    if (!(model.hyperlinks && model.hyperlinks.rId)) {
      return;
    }
    xmlStream.leafNode(this.tag, {
      "xmlns:r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
      "r:id": model.hyperlinks.rId,
      tooltip: model.hyperlinks.tooltip
    });
  }

  parseOpen(node: any): boolean {
    switch (node.name) {
      case this.tag:
        this.model = {
          hyperlinks: {
            rId: node.attributes["r:id"],
            tooltip: node.attributes.tooltip
          }
        };
        return true;
      default:
        return true;
    }
  }

  parseText(): void {}

  parseClose(): boolean {
    return false;
  }
}

export { HLinkClickXform };
