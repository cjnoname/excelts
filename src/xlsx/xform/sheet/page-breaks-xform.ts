import { BaseXform } from "../base-xform.js";

class PageBreaksXform extends BaseXform {
  declare public model: any;

  get tag(): string {
    return "brk";
  }

  render(xmlStream: any, model: any): void {
    xmlStream.leafNode("brk", model);
  }

  parseOpen(node: any): boolean {
    if (node.name === "brk") {
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

export { PageBreaksXform };
