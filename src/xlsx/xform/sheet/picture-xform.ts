import { BaseXform } from "../base-xform.js";

interface PictureModel {
  rId: string;
}

class PictureXform extends BaseXform {
  get tag(): string {
    return "picture";
  }

  render(xmlStream: any, model?: PictureModel): void {
    if (model) {
      xmlStream.leafNode(this.tag, { "r:id": model.rId });
    }
  }

  parseOpen(node: any): boolean {
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

export { PictureXform };
