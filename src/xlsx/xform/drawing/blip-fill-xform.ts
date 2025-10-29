import { BaseXform } from "../base-xform.js";
import { BlipXform } from "./blip-xform.js";

class BlipFillXform extends BaseXform {
  declare public map: { [key: string]: BlipXform };
  declare public parser: any;
  declare public model: any;

  constructor() {
    super();

    this.map = {
      "a:blip": new BlipXform()
    };
  }

  get tag(): string {
    return "xdr:blipFill";
  }

  render(xmlStream: any, model: any): void {
    xmlStream.openNode(this.tag);

    this.map["a:blip"].render(xmlStream, model);

    // TODO: options for this + parsing
    xmlStream.openNode("a:stretch");
    xmlStream.leafNode("a:fillRect");
    xmlStream.closeNode();

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

  parseText(): void {}

  parseClose(name: string): boolean {
    if (this.parser) {
      if (!this.parser.parseClose(name)) {
        this.parser = undefined;
      }
      return true;
    }
    switch (name) {
      case this.tag:
        this.model = this.map["a:blip"].model;
        return false;

      default:
        return true;
    }
  }
}

export { BlipFillXform };
