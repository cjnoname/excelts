import { BaseXform } from "../../base-xform.js";

class FormulaXform extends BaseXform {
  get tag(): string {
    return "formula";
  }

  render(xmlStream: any, model: any): void {
    xmlStream.leafNode(this.tag, null, model);
  }

  parseOpen(): void {
    this.model = "";
  }

  parseText(text: string): void {
    this.model += text;
  }

  parseClose(name: string): boolean {
    return name !== this.tag;
  }
}

export { FormulaXform };
