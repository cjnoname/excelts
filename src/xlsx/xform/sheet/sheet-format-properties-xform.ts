import { BaseXform } from "../base-xform.js";

interface SheetFormatPropertiesModel {
  defaultRowHeight: number;
  dyDescent: number;
  outlineLevelRow: number;
  outlineLevelCol: number;
  defaultColWidth?: number;
}

class SheetFormatPropertiesXform extends BaseXform {
  get tag(): string {
    return "sheetFormatPr";
  }

  render(xmlStream: any, model?: SheetFormatPropertiesModel): void {
    if (model) {
      const attributes: any = {
        defaultRowHeight: model.defaultRowHeight,
        outlineLevelRow: model.outlineLevelRow,
        outlineLevelCol: model.outlineLevelCol,
        "x14ac:dyDescent": model.dyDescent
      };
      if (model.defaultColWidth) {
        attributes.defaultColWidth = model.defaultColWidth;
      }

      // default value for 'defaultRowHeight' is 15, this should not be 'custom'
      if (!model.defaultRowHeight || model.defaultRowHeight !== 15) {
        attributes.customHeight = "1";
      }

      if (Object.values(attributes).some((value: any) => value !== undefined)) {
        xmlStream.leafNode("sheetFormatPr", attributes);
      }
    }
  }

  parseOpen(node: any): boolean {
    if (node.name === "sheetFormatPr") {
      this.model = {
        defaultRowHeight: parseFloat(node.attributes.defaultRowHeight || "0"),
        dyDescent: parseFloat(node.attributes["x14ac:dyDescent"] || "0"),
        outlineLevelRow: parseInt(node.attributes.outlineLevelRow || "0", 10),
        outlineLevelCol: parseInt(node.attributes.outlineLevelCol || "0", 10)
      };
      if (node.attributes.defaultColWidth) {
        this.model.defaultColWidth = parseFloat(node.attributes.defaultColWidth);
      }
      return true;
    }
    return false;
  }

  parseText(): void {}

  parseClose(): boolean {
    return false;
  }
}

export { SheetFormatPropertiesXform };
