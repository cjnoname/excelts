import { BaseXform } from "../base-xform.js";

interface HyperlinkModel {
  address: string;
  rId: string;
  tooltip?: string;
  target?: string;
}

class HyperlinkXform extends BaseXform {
  get tag(): string {
    return "hyperlink";
  }

  render(xmlStream: any, model: HyperlinkModel): void {
    if (this.isInternalLink(model)) {
      xmlStream.leafNode("hyperlink", {
        ref: model.address,
        "r:id": model.rId,
        tooltip: model.tooltip,
        location: model.target
      });
    } else {
      xmlStream.leafNode("hyperlink", {
        ref: model.address,
        "r:id": model.rId,
        tooltip: model.tooltip
      });
    }
  }

  parseOpen(node: any): boolean {
    if (node.name === "hyperlink") {
      this.model = {
        address: node.attributes.ref,
        rId: node.attributes["r:id"],
        tooltip: node.attributes.tooltip
      };

      // This is an internal link
      if (node.attributes.location) {
        this.model.target = node.attributes.location;
      }
      return true;
    }
    return false;
  }

  parseText(): void {}

  parseClose(): boolean {
    return false;
  }

  isInternalLink(model: HyperlinkModel): boolean {
    // @example: Sheet2!D3, return true
    return !!(model.target && /^[^!]+![a-zA-Z]+[\d]+$/.test(model.target));
  }
}

export { HyperlinkXform };
