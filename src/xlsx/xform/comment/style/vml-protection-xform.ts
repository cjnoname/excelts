import { BaseXform } from "../../base-xform.js";

class VmlProtectionXform extends BaseXform {
  declare private _model: { tag?: string };
  declare private text: string;

  constructor(model?: { tag?: string }) {
    super();
    this._model = model || {};
    this.text = "";
  }

  get tag(): string {
    return (this._model && this._model.tag) || "";
  }

  render(xmlStream: any, model: any): void {
    xmlStream.leafNode(this.tag, null, model);
  }

  parseOpen(node: any): boolean {
    switch (node.name) {
      case this.tag:
        this.text = "";
        return true;
      default:
        return false;
    }
  }

  parseText(text: string): void {
    this.text = text;
  }

  parseClose(): boolean {
    return false;
  }
}

export { VmlProtectionXform };
