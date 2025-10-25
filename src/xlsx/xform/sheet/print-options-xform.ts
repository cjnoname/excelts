import { BaseXform } from "../base-xform.js";

function booleanToXml(model: boolean): string | undefined {
  return model ? "1" : undefined;
}

interface PrintOptionsModel {
  showRowColHeaders: boolean;
  showGridLines: boolean;
  horizontalCentered: boolean;
  verticalCentered: boolean;
}

class PrintOptionsXform extends BaseXform {
  get tag(): string {
    return "printOptions";
  }

  render(xmlStream: any, model?: PrintOptionsModel): void {
    if (model) {
      const attributes = {
        headings: booleanToXml(model.showRowColHeaders),
        gridLines: booleanToXml(model.showGridLines),
        horizontalCentered: booleanToXml(model.horizontalCentered),
        verticalCentered: booleanToXml(model.verticalCentered)
      };
      if (Object.values(attributes).some((value: any) => value !== undefined)) {
        xmlStream.leafNode(this.tag, attributes);
      }
    }
  }

  parseOpen(node: any): boolean {
    switch (node.name) {
      case this.tag:
        this.model = {
          showRowColHeaders: node.attributes.headings === "1",
          showGridLines: node.attributes.gridLines === "1",
          horizontalCentered: node.attributes.horizontalCentered === "1",
          verticalCentered: node.attributes.verticalCentered === "1"
        };
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

export { PrintOptionsXform };
