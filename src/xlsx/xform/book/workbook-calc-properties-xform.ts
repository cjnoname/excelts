import { BaseXform } from "../base-xform.js";

interface CalcPropertiesModel {
  fullCalcOnLoad?: boolean;
}

class WorkbookCalcPropertiesXform extends BaseXform {
  render(xmlStream: any, model: CalcPropertiesModel): void {
    xmlStream.leafNode("calcPr", {
      calcId: 171027,
      fullCalcOnLoad: model.fullCalcOnLoad ? 1 : undefined
    });
  }

  parseOpen(node: any): boolean {
    if (node.name === "calcPr") {
      this.model = {};
      return true;
    }
    return false;
  }

  parseText(): void {}

  parseClose(): boolean {
    return false;
  }
}

export { WorkbookCalcPropertiesXform };
