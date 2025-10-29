import { BaseXform } from "../base-xform.js";
import { StaticXform } from "../static-xform.js";
import { BlipFillXform } from "./blip-fill-xform.js";
import { NvPicPrXform } from "./nv-pic-pr-xform.js";
import { spPrJSON } from "./sp-pr.js";

interface PicModel {
  index?: number;
  [key: string]: any;
}

class PicXform extends BaseXform {
  declare public map: { [key: string]: any };
  declare public parser: any;
  declare public model: any;

  constructor() {
    super();

    this.map = {
      "xdr:nvPicPr": new NvPicPrXform(),
      "xdr:blipFill": new BlipFillXform(),
      "xdr:spPr": new StaticXform(spPrJSON)
    };
  }

  get tag(): string {
    return "xdr:pic";
  }

  prepare(model: PicModel, options: { index: number }): void {
    model.index = options.index + 1;
  }

  render(xmlStream: any, model: PicModel): void {
    xmlStream.openNode(this.tag);

    this.map["xdr:nvPicPr"].render(xmlStream, model);
    this.map["xdr:blipFill"].render(xmlStream, model);
    this.map["xdr:spPr"].render(xmlStream, model);

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
        this.mergeModel(this.parser.model);
        this.parser = undefined;
      }
      return true;
    }
    switch (name) {
      case this.tag:
        return false;
      default:
        // not quite sure how we get here!
        return true;
    }
  }
}

export { PicXform };
