import { BaseXform } from "../base-xform.js";

interface WorkbookPropertiesModel {
  date1904?: boolean;
}

class WorkbookPropertiesXform extends BaseXform {
  render(xmlStream: any, model: WorkbookPropertiesModel): void {
    xmlStream.leafNode("workbookPr", {
      date1904: model.date1904 ? 1 : undefined,
      defaultThemeVersion: 164011,
      filterPrivacy: 1
    });
  }

  parseOpen(node: any): boolean {
    if (node.name === "workbookPr") {
      this.model = {
        date1904: node.attributes.date1904 === "1"
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

export { WorkbookPropertiesXform };
