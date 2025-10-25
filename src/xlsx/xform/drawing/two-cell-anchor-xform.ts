import { BaseCellAnchorXform } from "./base-cell-anchor-xform.js";
import { StaticXform } from "../static-xform.js";
import { CellPositionXform } from "./cell-position-xform.js";
import { PicXform } from "./pic-xform.js";

interface TwoCellModel {
  range: {
    editAs?: string;
    tl: any;
    br: any;
  };
  picture: any;
}

class TwoCellAnchorXform extends BaseCellAnchorXform {
  constructor() {
    super();

    this.map = {
      "xdr:from": new CellPositionXform({ tag: "xdr:from" }),
      "xdr:to": new CellPositionXform({ tag: "xdr:to" }),
      "xdr:pic": new PicXform(),
      "xdr:clientData": new StaticXform({ tag: "xdr:clientData" })
    };
  }

  get tag(): string {
    return "xdr:twoCellAnchor";
  }

  prepare(model: TwoCellModel, options: { index: number }): void {
    this.map["xdr:pic"].prepare(model.picture, options);
  }

  render(xmlStream: any, model: TwoCellModel): void {
    xmlStream.openNode(this.tag, { editAs: model.range.editAs || "oneCell" });

    this.map["xdr:from"].render(xmlStream, model.range.tl);
    this.map["xdr:to"].render(xmlStream, model.range.br);
    this.map["xdr:pic"].render(xmlStream, model.picture);
    this.map["xdr:clientData"].render(xmlStream, {});

    xmlStream.closeNode();
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
        this.model.range.tl = this.map["xdr:from"].model;
        this.model.range.br = this.map["xdr:to"].model;
        this.model.picture = this.map["xdr:pic"].model;
        return false;
      default:
        // could be some unrecognised tags
        return true;
    }
  }

  reconcile(model: any, options: any): void {
    model.medium = this.reconcilePicture(model.picture, options);
  }
}

export { TwoCellAnchorXform };
