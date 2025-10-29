import { BaseXform } from "../base-xform.js";

class CNvPicPrXform extends BaseXform {
  get tag(): string {
    return "xdr:cNvPicPr";
  }

  render(xmlStream: any): void {
    xmlStream.openNode(this.tag);
    xmlStream.leafNode("a:picLocks", {
      noChangeAspect: "1"
    });
    xmlStream.closeNode();
  }

  parseOpen(node: any): boolean {
    switch (node.name) {
      case this.tag:
        return true;
      default:
        return true;
    }
  }

  parseText(): void {}

  parseClose(name: string): boolean {
    switch (name) {
      case this.tag:
        return false;
      default:
        // unprocessed internal nodes
        return true;
    }
  }
}

export { CNvPicPrXform };
