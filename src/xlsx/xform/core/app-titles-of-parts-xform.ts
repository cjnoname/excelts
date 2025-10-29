import { BaseXform } from "../base-xform.js";

class AppTitlesOfPartsXform extends BaseXform {
  render(xmlStream: any, model: any[]): void {
    xmlStream.openNode("TitlesOfParts");
    xmlStream.openNode("vt:vector", { size: model.length, baseType: "lpstr" });

    model.forEach(sheet => {
      xmlStream.leafNode("vt:lpstr", undefined, sheet.name);
    });

    xmlStream.closeNode();
    xmlStream.closeNode();
  }

  parseOpen(node: any): boolean {
    // no parsing
    return node.name === "TitlesOfParts";
  }

  parseText(): void {}

  parseClose(name: string): boolean {
    return name !== "TitlesOfParts";
  }
}

export { AppTitlesOfPartsXform };
