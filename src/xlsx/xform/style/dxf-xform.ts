import { BaseXform } from "../base-xform.js";
import { AlignmentXform } from "./alignment-xform.js";
import { BorderXform } from "./border-xform.js";
import { FillXform } from "./fill-xform.js";
import { FontXform } from "./font-xform.js";
import { NumFmtXform } from "./numfmt-xform.js";
import { ProtectionXform } from "./protection-xform.js";

// <xf numFmtId="[numFmtId]" fontId="[fontId]" fillId="[fillId]" borderId="[xf.borderId]" xfId="[xfId]">
//   Optional <alignment>
//   Optional <protection>
// </xf>

interface DxfModel {
  alignment?: any;
  border?: any;
  fill?: any;
  font?: any;
  numFmt?: string;
  numFmtId?: number;
  protection?: any;
}

// Style assists translation from style model to/from xlsx
class DxfXform extends BaseXform {
  declare public map: { [key: string]: any };
  declare public parser: any;

  constructor() {
    super();

    this.map = {
      alignment: new AlignmentXform(),
      border: new BorderXform(),
      fill: new FillXform(),
      font: new FontXform(),
      numFmt: new NumFmtXform(),
      protection: new ProtectionXform()
    };
  }

  get tag(): string {
    return "dxf";
  }

  // how do we generate dxfid?

  render(xmlStream: any, model: DxfModel): void {
    xmlStream.openNode(this.tag);

    if (model.font) {
      this.map.font.render(xmlStream, model.font);
    }
    if (model.numFmt && model.numFmtId) {
      const numFmtModel = { id: model.numFmtId, formatCode: model.numFmt };
      this.map.numFmt.render(xmlStream, numFmtModel);
    }
    if (model.fill) {
      this.map.fill.render(xmlStream, model.fill);
    }
    if (model.alignment) {
      this.map.alignment.render(xmlStream, model.alignment);
    }
    if (model.border) {
      this.map.border.render(xmlStream, model.border);
    }
    if (model.protection) {
      this.map.protection.render(xmlStream, model.protection);
    }

    xmlStream.closeNode();
  }

  parseOpen(node: any): boolean {
    if (this.parser) {
      this.parser.parseOpen(node);
      return true;
    }

    switch (node.name) {
      case this.tag:
        // this node is often repeated. Need to reset children
        this.reset();
        return true;
      default:
        this.parser = this.map[node.name];
        if (this.parser) {
          this.parser.parseOpen(node);
        }
        return true;
    }
  }

  parseText(text: string): void {
    if (this.parser) {
      this.parser.parseText(text);
    }
  }

  parseClose(name: string): boolean {
    if (this.parser) {
      if (!this.parser.parseClose(name)) {
        this.parser = undefined;
      }
      return true;
    }
    if (name === this.tag) {
      this.model = {
        alignment: this.map.alignment.model,
        border: this.map.border.model,
        fill: this.map.fill.model,
        font: this.map.font.model,
        numFmt: this.map.numFmt.model,
        protection: this.map.protection.model
      };
      return false;
    }

    return true;
  }
}

export { DxfXform };
