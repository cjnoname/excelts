import { BaseXform } from "../base-xform.js";

class MergeCellXform extends BaseXform {
  get tag(): string {
    return "mergeCell";
  }

  render(xmlStream: any, model: string): void {
    xmlStream.leafNode("mergeCell", { ref: model });
  }

  parseOpen(node: any): boolean {
    if (node.name === "mergeCell") {
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

export { MergeCellXform };
