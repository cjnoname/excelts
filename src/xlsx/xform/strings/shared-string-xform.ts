import { TextXform } from "./text-xform.js";
import { RichTextXform } from "./rich-text-xform.js";
import { PhoneticTextXform } from "./phonetic-text-xform.js";
import { BaseXform } from "../base-xform.js";

// <si>
//   <r></r><r></r>...
// </si>
// <si>
//   <t></t>
// </si>

type SharedStringModel = string | { richText: any[] };

class SharedStringXform extends BaseXform {
  declare public map: { [key: string]: any };
  declare public parser: any;

  constructor(model?: SharedStringModel) {
    super();

    this.model = model;

    this.map = {
      r: new RichTextXform(),
      t: new TextXform(),
      rPh: new PhoneticTextXform()
    };
  }

  get tag(): string {
    return "si";
  }

  render(xmlStream: any, model?: SharedStringModel): void {
    xmlStream.openNode(this.tag);
    if (
      model &&
      typeof model === "object" &&
      Object.prototype.hasOwnProperty.call(model, "richText") &&
      model.richText
    ) {
      if (model.richText.length) {
        model.richText.forEach(text => {
          this.map.r.render(xmlStream, text);
        });
      } else {
        this.map.t.render(xmlStream, "");
      }
    } else if (model !== undefined && model !== null) {
      this.map.t.render(xmlStream, model as string);
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
      this.model = {};
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
            let rt = (this.model as any).richText;
            if (!rt) {
              rt = (this.model as any).richText = [];
            }
            rt.push(this.parser.model);
            break;
          }
          case "t":
            this.model = this.parser.model;
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

export { SharedStringXform };
