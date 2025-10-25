import { BaseXform } from "../base-xform.js";

interface Margins {
  inset?: number[] | string;
}

interface NoteModel {
  margins?: Margins;
}

interface TextboxModel {
  note?: NoteModel;
  inset?: number[];
}

class VmlTextboxXform extends BaseXform {
  declare public model: TextboxModel;

  constructor() {
    super();
    this.model = {};
  }

  get tag(): string {
    return "v:textbox";
  }

  conversionUnit(value: string | number, multiple: number, unit: string): string {
    return `${(parseFloat(value.toString()) * multiple).toFixed(2)}${unit}`;
  }

  reverseConversionUnit(inset?: string): number[] {
    return (inset || "").split(",").map(margin => {
      return Number(parseFloat(this.conversionUnit(parseFloat(margin), 0.1, "")).toFixed(2));
    });
  }

  render(xmlStream: any, model: TextboxModel): void {
    const attributes: any = {
      style: "mso-direction-alt:auto"
    };
    if (model && model.note) {
      let { inset } = (model.note && model.note.margins) || {};
      if (Array.isArray(inset)) {
        inset = inset
          .map(margin => {
            return this.conversionUnit(margin, 10, "mm");
          })
          .join(",");
      }
      if (inset) {
        attributes.inset = inset;
      }
    }
    xmlStream.openNode("v:textbox", attributes);
    xmlStream.leafNode("div", { style: "text-align:left" });
    xmlStream.closeNode();
  }

  parseOpen(node: any): boolean {
    switch (node.name) {
      case this.tag:
        this.model = {
          inset: this.reverseConversionUnit(node.attributes.inset)
        };
        return true;
      default:
        return true;
    }
  }

  parseText(): void {}

  parseClose(name: string): boolean {
    switch (name) {
      case this.tag:
        return false;
      default:
        return true;
    }
  }
}

export { VmlTextboxXform };
