import { BaseXform } from "../base-xform.js";
import { ColorXform } from "../style/color-xform.js";
import { PageSetupPropertiesXform } from "./page-setup-properties-xform.js";
import { OutlinePropertiesXform } from "./outline-properties-xform.js";

interface SheetPropertiesModel {
  tabColor?: any;
  pageSetup?: any;
  outlineProperties?: any;
}

class SheetPropertiesXform extends BaseXform {
  declare public map: { [key: string]: any };
  declare public parser?: any;

  constructor() {
    super();

    this.map = {
      tabColor: new ColorXform("tabColor"),
      pageSetUpPr: new PageSetupPropertiesXform(),
      outlinePr: new OutlinePropertiesXform()
    };
  }

  get tag(): string {
    return "sheetPr";
  }

  render(xmlStream: any, model?: SheetPropertiesModel): void {
    if (model) {
      xmlStream.addRollback();
      xmlStream.openNode("sheetPr");

      let inner = false;
      inner = this.map.tabColor.render(xmlStream, model.tabColor) || inner;
      inner = this.map.pageSetUpPr.render(xmlStream, model.pageSetup) || inner;
      inner = this.map.outlinePr.render(xmlStream, model.outlineProperties) || inner;

      if (inner) {
        xmlStream.closeNode();
        xmlStream.commit();
      } else {
        xmlStream.rollback();
      }
    }
  }

  parseOpen(node: any): boolean {
    if (this.parser) {
      this.parser.parseOpen(node);
      return true;
    }
    if (node.name === this.tag) {
      this.reset();
      return true;
    }
    if (this.map[node.name]) {
      this.parser = this.map[node.name];
      this.parser.parseOpen(node);
      return true;
    }
    return false;
  }

  parseText(text: string): boolean {
    if (this.parser) {
      this.parser.parseText(text);
      return true;
    }
    return false;
  }

  parseClose(_name: string): boolean {
    if (this.parser) {
      if (!this.parser.parseClose(_name)) {
        this.parser = undefined;
      }
      return true;
    }
    if (this.map.tabColor.model || this.map.pageSetUpPr.model || this.map.outlinePr.model) {
      this.model = {};
      if (this.map.tabColor.model) {
        this.model.tabColor = this.map.tabColor.model;
      }
      if (this.map.pageSetUpPr.model) {
        this.model.pageSetup = this.map.pageSetUpPr.model;
      }
      if (this.map.outlinePr.model) {
        this.model.outlineProperties = this.map.outlinePr.model;
      }
    } else {
      this.model = null;
    }
    return false;
  }
}

export { SheetPropertiesXform };
