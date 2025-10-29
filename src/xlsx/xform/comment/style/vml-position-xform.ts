import { BaseXform } from "../../base-xform.js";

class VmlPositionXform extends BaseXform {
  declare private _model: { tag?: string };
  declare public model: { [key: string]: boolean };

  constructor(model?: { tag?: string }) {
    super();
    this._model = model || {};
    this.model = {};
  }

  get tag(): string {
    return (this._model && this._model.tag) || "";
  }

  render(xmlStream: any, model: string, type?: string[]): void {
    if (type && model === type[2]) {
      xmlStream.leafNode(this.tag);
    } else if (type && this.tag === "x:SizeWithCells" && model === type[1]) {
      xmlStream.leafNode(this.tag);
    }
  }

  parseOpen(node: any): boolean {
    switch (node.name) {
      case this.tag:
        this.model = {};
        this.model[this.tag] = true;
        return true;
      default:
        return false;
    }
  }

  parseText(): void {}

  parseClose(): boolean {
    return false;
  }
}

export { VmlPositionXform };
