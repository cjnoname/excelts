import { TextXform } from "./text-xform.js";
import { RichTextXform } from "./rich-text-xform.js";
import { BaseXform } from "../base-xform.js";

// <rPh sb="0" eb="1">
//   <t>(its pronounciation in KATAKANA)</t>
// </rPh>

interface PhoneticTextModel {
  sb: number;
  eb: number;
  text?: string;
  richText?: any[];
}

class PhoneticTextXform extends BaseXform {
  declare public map: { [key: string]: any };
  declare public parser: any;

  constructor() {
    super();

    this.map = {
      r: new RichTextXform(),
      t: new TextXform()
    };
  }

  get tag(): string {
    return "rPh";
  }

  render(xmlStream: any, model: PhoneticTextModel): void {
    xmlStream.openNode(this.tag, {
      sb: model.sb || 0,
      eb: model.eb || 0
    });
    if (model && Object.prototype.hasOwnProperty.call(model, "richText") && model.richText) {
      const { r } = this.map;
      model.richText.forEach(text => {
        r.render(xmlStream, text);
      });
    } else if (model) {
      this.map.t.render(xmlStream, model.text);
    }
    xmlStream.closeNode();
  }

  parseOpen(node: any): boolean {
    const { name } = node;
    if (this.parser) {
      this.parser.parseOpen(node);
      return true;
    }
    if (name === this.tag) {
      this.model = {
        sb: parseInt(node.attributes.sb, 10),
        eb: parseInt(node.attributes.eb, 10)
      };
      return true;
    }
    this.parser = this.map[name];
    if (this.parser) {
      this.parser.parseOpen(node);
      return true;
    }
    return false;
  }

  parseText(text: string): void {
    if (this.parser) {
      this.parser.parseText(text);
    }
  }

  parseClose(name: string): boolean {
    if (this.parser) {
      if (!this.parser.parseClose(name)) {
        switch (name) {
          case "r": {
            let rt = this.model.richText;
            if (!rt) {
              rt = this.model.richText = [];
            }
            rt.push(this.parser.model);
            break;
          }
          case "t":
            this.model.text = this.parser.model;
            break;
          default:
            break;
        }
        this.parser = undefined;
      }
      return true;
    }
    switch (name) {
      case this.tag:
        return false;
      default:
        return true;
    }
  }
}

export { PhoneticTextXform };
