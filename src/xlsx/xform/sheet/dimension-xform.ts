import { BaseXform } from "../base-xform.js";

class DimensionXform extends BaseXform {
  declare public model: any;

  get tag(): string {
    return "dimension";
  }

  render(xmlStream: any, model: any): void {
    if (model) {
      xmlStream.leafNode("dimension", { ref: model });
    }
  }

  parseOpen(node: any): boolean {
    if (node.name === "dimension") {
      this.model = node.attributes.ref;
      return true;
    }
    return false;
  }

  parseText(): void {}

  parseClose(): boolean {
    return false;
  }
}

export { DimensionXform };
