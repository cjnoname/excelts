import { BaseXform } from "../base-xform.js";

interface WorkbookViewModel {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  firstSheet?: number;
  activeTab?: number;
  visibility?: string;
}

class WorkbookViewXform extends BaseXform {
  render(xmlStream: any, model: WorkbookViewModel): void {
    const attributes: any = {
      xWindow: model.x || 0,
      yWindow: model.y || 0,
      windowWidth: model.width || 12000,
      windowHeight: model.height || 24000,
      firstSheet: model.firstSheet,
      activeTab: model.activeTab
    };
    if (model.visibility && model.visibility !== "visible") {
      attributes.visibility = model.visibility;
    }
    xmlStream.leafNode("workbookView", attributes);
  }

  parseOpen(node: any): boolean {
    if (node.name === "workbookView") {
      const model: any = (this.model = {});
      const addS = function (
        name: string,
        value: string | undefined,
        dflt: string | undefined
      ): void {
        const s = value !== undefined ? value : dflt;
        model[name] = s;
      };
      const addN = function (
        name: string,
        value: string | undefined,
        dflt: number | undefined
      ): void {
        const n = value !== undefined ? parseInt(value, 10) : dflt;
        if (n !== undefined) {
          model[name] = n;
        }
      };
      addN("x", node.attributes.xWindow, 0);
      addN("y", node.attributes.yWindow, 0);
      addN("width", node.attributes.windowWidth, 25000);
      addN("height", node.attributes.windowHeight, 10000);
      addS("visibility", node.attributes.visibility, "visible");
      addN("activeTab", node.attributes.activeTab, undefined);
      addN("firstSheet", node.attributes.firstSheet, undefined);
      return true;
    }
    return false;
  }

  parseText(): void {}

  parseClose(): boolean {
    return false;
  }
}

export { WorkbookViewXform };
