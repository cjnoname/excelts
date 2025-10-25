import { BaseXform } from "../base-xform.js";

interface TableColumnModel {
  id?: number;
  name: string;
  totalsRowLabel?: string;
  totalsRowFunction?: string;
  dxfId?: string;
}

class TableColumnXform extends BaseXform {
  declare public model: TableColumnModel;

  constructor() {
    super();
    this.model = { name: "" };
  }

  get tag(): string {
    return "tableColumn";
  }

  prepare(model: TableColumnModel, options: { index: number }): void {
    model.id = options.index + 1;
  }

  render(xmlStream: any, model: TableColumnModel): void {
    xmlStream.leafNode(this.tag, {
      id: model.id!.toString(),
      name: model.name,
      totalsRowLabel: model.totalsRowLabel,
      totalsRowFunction: model.totalsRowFunction,
      dxfId: model.dxfId
    });
  }

  parseOpen(node: any): boolean {
    if (node.name === this.tag) {
      const { attributes } = node;
      this.model = {
        name: attributes.name,
        totalsRowLabel: attributes.totalsRowLabel,
        totalsRowFunction: attributes.totalsRowFunction,
        dxfId: attributes.dxfId
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

export { TableColumnXform };
