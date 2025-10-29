import { BaseXform } from "../base-xform.js";

interface CustomFilterModel {
  val: string;
  operator?: string;
}

class CustomFilterXform extends BaseXform {
  declare public model: CustomFilterModel;

  constructor() {
    super();
    this.model = { val: "" };
  }

  get tag(): string {
    return "customFilter";
  }

  render(xmlStream: any, model: CustomFilterModel): void {
    xmlStream.leafNode(this.tag, {
      val: model.val,
      operator: model.operator
    });
  }

  parseOpen(node: any): boolean {
    if (node.name === this.tag) {
      this.model = {
        val: node.attributes.val,
        operator: node.attributes.operator
      };
      return true;
    }
    return false;
  }

  parseText(): void {}

  parseClose(): boolean {
    return false;
  }
}

export { CustomFilterXform };
