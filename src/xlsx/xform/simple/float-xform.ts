import { BaseXform } from "../base-xform.js";

interface FloatXformOptions {
  tag: string;
  attr?: string;
  attrs?: any;
}

class FloatXform extends BaseXform {
  declare private tag: string;
  declare private attr?: string;
  declare private attrs?: any;
  declare private text: string[];

  constructor(options: FloatXformOptions) {
    super();

    this.tag = options.tag;
    this.attr = options.attr;
    this.attrs = options.attrs;
    this.text = [];
  }

  render(xmlStream: any, model?: number): void {
    if (model !== undefined) {
      xmlStream.openNode(this.tag);
      if (this.attrs) {
        xmlStream.addAttributes(this.attrs);
      }
      if (this.attr) {
        xmlStream.addAttribute(this.attr, model);
      } else {
        xmlStream.writeText(model);
      }
      xmlStream.closeNode();
    }
  }

  parseOpen(node: any): void {
    if (node.name === this.tag) {
      if (this.attr) {
        this.model = parseFloat(node.attributes[this.attr]);
      } else {
        this.text = [];
      }
    }
  }

  parseText(text: string): void {
    if (!this.attr) {
      this.text.push(text);
    }
  }

  parseClose(): boolean {
    if (!this.attr) {
      this.model = parseFloat(this.text.join(""));
    }
    return false;
  }
}

export { FloatXform };
