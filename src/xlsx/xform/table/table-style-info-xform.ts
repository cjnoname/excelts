import { BaseXform } from "../base-xform.js";

interface TableStyleModel {
  theme?: string | null;
  showFirstColumn: boolean;
  showLastColumn: boolean;
  showRowStripes: boolean;
  showColumnStripes: boolean;
}

class TableStyleInfoXform extends BaseXform {
  declare public model: TableStyleModel;

  constructor() {
    super();
    this.model = {
      theme: null,
      showFirstColumn: false,
      showLastColumn: false,
      showRowStripes: false,
      showColumnStripes: false
    };
  }

  get tag(): string {
    return "tableStyleInfo";
  }

  render(xmlStream: any, model: TableStyleModel): void {
    xmlStream.leafNode(this.tag, {
      name: model.theme ? model.theme : undefined,
      showFirstColumn: model.showFirstColumn ? "1" : "0",
      showLastColumn: model.showLastColumn ? "1" : "0",
      showRowStripes: model.showRowStripes ? "1" : "0",
      showColumnStripes: model.showColumnStripes ? "1" : "0"
    });
  }

  parseOpen(node: any): boolean {
    if (node.name === this.tag) {
      const { attributes } = node;
      this.model = {
        theme: attributes.name ? attributes.name : null,
        showFirstColumn: attributes.showFirstColumn === "1",
        showLastColumn: attributes.showLastColumn === "1",
        showRowStripes: attributes.showRowStripes === "1",
        showColumnStripes: attributes.showColumnStripes === "1"
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

export { TableStyleInfoXform };
