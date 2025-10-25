import { BaseXform } from "../../base-xform.js";

class CfvoXform extends BaseXform {
  get tag(): string {
    return "cfvo";
  }

  render(xmlStream: any, model: any): void {
    xmlStream.leafNode(this.tag, {
      type: model.type,
      val: model.value
    });
  }

  parseOpen(node: any): void {
    this.model = {
      type: node.attributes.type,
      value: BaseXform.toFloatValue(node.attributes.val)
    };
  }

  parseClose(name: string): boolean {
    return name !== this.tag;
  }
}

export { CfvoXform };
