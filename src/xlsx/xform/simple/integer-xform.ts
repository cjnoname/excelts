import { BaseXform } from "../base-xform.js";

interface IntegerXformOptions {
  tag: string;
  attr?: string;
  attrs?: any;
  zero?: boolean;
}

class IntegerXform extends BaseXform {
  declare private tag: string;
  declare private attr?: string;
  declare private attrs?: any;
  declare private zero?: boolean;
  declare private text: string[];

  constructor(options: IntegerXformOptions) {
    super();

    this.tag = options.tag;
    this.attr = options.attr;
    this.attrs = options.attrs;

    // option to render zero
    this.zero = options.zero;
    this.text = [];
  }

  render(xmlStream: any, model?: number): void {
    // int is different to float in that zero is not rendered
    if (model || this.zero) {
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

  parseOpen(node: any): boolean {
    if (node.name === this.tag) {
      if (this.attr) {
        this.model = parseInt(node.attributes[this.attr], 10);
      } else {
        this.text = [];
      }
      return true;
    }
    return false;
  }

  parseText(text: string): void {
    if (!this.attr) {
      this.text.push(text);
    }
  }

  parseClose(): boolean {
    if (!this.attr) {
      this.model = parseInt(this.text.join("") || "0", 10);
    }
    return false;
  }
}

export { IntegerXform };
