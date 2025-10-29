import { BaseXform } from "../base-xform.js";

//   <t xml:space="preserve"> is </t>

class TextXform extends BaseXform {
  declare private _text: string[];

  get tag(): string {
    return "t";
  }

  render(xmlStream: any, model: string): void {
    xmlStream.openNode("t");
    if (/^\s|\n|\s$/.test(model)) {
      xmlStream.addAttribute("xml:space", "preserve");
    }
    xmlStream.writeText(model);
    xmlStream.closeNode();
  }

  parseOpen(node: any): boolean {
    switch (node.name) {
      case "t":
        this._text = [];
        this.model = ""; // Initialize model to empty string
        return true;
      default:
        return false;
    }
  }

  parseText(text: string): void {
    this._text.push(text);
    // Update model immediately after receiving text
    this.model = this._text
      .join("")
      .replace(/_x([0-9A-F]{4})_/g, ($0, $1) => String.fromCharCode(parseInt($1, 16)));
  }

  parseClose(): boolean {
    return false;
  }
}

export { TextXform };
