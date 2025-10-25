import { BaseXform } from "../base-xform.js";

type UnderlineType = boolean | "single" | "double" | "singleAccounting" | "doubleAccounting";

class UnderlineXform extends BaseXform {
  static Attributes: { [key: string]: any } = {
    single: {},
    double: { val: "double" },
    singleAccounting: { val: "singleAccounting" },
    doubleAccounting: { val: "doubleAccounting" }
  };

  constructor(model?: UnderlineType) {
    super();
    this.model = model;
  }

  get tag(): string {
    return "u";
  }

  render(xmlStream: any, model?: UnderlineType): void {
    model = model || this.model;

    if (model === true) {
      xmlStream.leafNode("u");
    } else {
      const attr = UnderlineXform.Attributes[model as string];
      if (attr) {
        xmlStream.leafNode("u", attr);
      }
    }
  }

  parseOpen(node: any): void {
    if (node.name === "u") {
      this.model = node.attributes.val || true;
    }
  }

  parseText(): void {}

  parseClose(): boolean {
    return false;
  }
}

export { UnderlineXform };
