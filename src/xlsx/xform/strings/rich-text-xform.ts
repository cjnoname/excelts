import { TextXform } from "./text-xform.js";
import { FontXform } from "../style/font-xform.js";
import { BaseXform } from "../base-xform.js";

// <r>
//   <rPr>
//     <sz val="11"/>
//     <color theme="1" tint="5"/>
//     <rFont val="Calibri"/>
//     <family val="2"/>
//     <scheme val="minor"/>
//   </rPr>
//   <t xml:space="preserve"> is </t>
// </r>

interface RichTextModel {
  font?: any;
  text: string;
}

class RichTextXform extends BaseXform {
  declare private _textXform?: TextXform;
  declare private _fontXform?: FontXform;
  declare public parser: any;

  constructor(model?: RichTextModel) {
    super();

    this.model = model;
  }

  get tag(): string {
    return "r";
  }

  get textXform(): TextXform {
    return this._textXform || (this._textXform = new TextXform());
  }

  get fontXform(): FontXform {
    return this._fontXform || (this._fontXform = new FontXform(RichTextXform.FONT_OPTIONS));
  }

  render(xmlStream: any, model?: RichTextModel): void {
    const renderModel = model || this.model;

    xmlStream.openNode("r");
    if (renderModel!.font) {
      this.fontXform.render(xmlStream, renderModel!.font);
    }
    this.textXform.render(xmlStream, renderModel!.text);
    xmlStream.closeNode();
  }

  parseOpen(node: any): boolean {
    if (this.parser) {
      this.parser.parseOpen(node);
      return true;
    }
    switch (node.name) {
      case "r":
        this.model = {};
        return true;
      case "t":
        this.parser = this.textXform;
        this.parser.parseOpen(node);
        return true;
      case "rPr":
        this.parser = this.fontXform;
        this.parser.parseOpen(node);
        return true;
      default:
        return false;
    }
  }

  parseText(text: string): void {
    if (this.parser) {
      this.parser.parseText(text);
    }
  }

  parseClose(name: string): boolean {
    switch (name) {
      case "r":
        return false;
      case "t":
        this.model.text = this.parser.model;
        this.parser = undefined;
        return true;
      case "rPr":
        this.model.font = this.parser.model;
        this.parser = undefined;
        return true;
      default:
        if (this.parser) {
          this.parser.parseClose(name);
        }
        return true;
    }
  }

  static FONT_OPTIONS = {
    tagName: "rPr",
    fontNameTag: "rFont"
  };
}

export { RichTextXform };
