import { BaseXform } from "../base-xform.js";

interface DateXformOptions {
  tag: string;
  attr?: string;
  attrs?: any;
  format?: (dt: Date) => string;
  parse?: (str: string) => Date;
}

class DateXform extends BaseXform {
  declare private tag: string;
  declare private attr?: string;
  declare private attrs?: any;
  declare private text: string[];
  declare private _format: (dt: Date) => string;
  declare private _parse: (str: string) => Date;

  constructor(options: DateXformOptions) {
    super();

    this.tag = options.tag;
    this.attr = options.attr;
    this.attrs = options.attrs;
    this.text = [];
    this._format =
      options.format ||
      function (dt: Date): string {
        try {
          if (Number.isNaN(dt.getTime())) {
            return "";
          }
          return dt.toISOString();
        } catch {
          return "";
        }
      };
    this._parse =
      options.parse ||
      function (str: string): Date {
        return new Date(str);
      };
  }

  render(xmlStream: any, model?: Date): void {
    if (model) {
      xmlStream.openNode(this.tag);
      if (this.attrs) {
        xmlStream.addAttributes(this.attrs);
      }
      if (this.attr) {
        xmlStream.addAttribute(this.attr, this._format(model));
      } else {
        xmlStream.writeText(this._format(model));
      }
      xmlStream.closeNode();
    }
  }

  parseOpen(node: any): void {
    if (node.name === this.tag) {
      if (this.attr) {
        this.model = this._parse(node.attributes[this.attr]);
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
      this.model = this._parse(this.text.join(""));
    }
    return false;
  }
}

export { DateXform };
