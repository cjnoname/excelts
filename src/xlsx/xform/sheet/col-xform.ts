import { BaseXform } from "../base-xform.js";
import { parseBoolean } from "../../../utils/utils.js";

interface ColModel {
  min: number;
  max: number;
  width?: number;
  styleId?: number;
  hidden?: boolean;
  bestFit?: boolean;
  outlineLevel?: number;
  collapsed?: boolean;
  style?: any;
}

class ColXform extends BaseXform {
  get tag(): string {
    return "col";
  }

  prepare(model: ColModel, options: any): void {
    const styleId = options.styles.addStyleModel(model.style || {});
    if (styleId) {
      model.styleId = styleId;
    }
  }

  render(xmlStream: any, model: ColModel): void {
    xmlStream.openNode("col");
    xmlStream.addAttribute("min", model.min);
    xmlStream.addAttribute("max", model.max);
    if (model.width) {
      xmlStream.addAttribute("width", model.width);
    }
    if (model.styleId) {
      xmlStream.addAttribute("style", model.styleId);
    }
    if (model.hidden) {
      xmlStream.addAttribute("hidden", "1");
    }
    if (model.bestFit) {
      xmlStream.addAttribute("bestFit", "1");
    }
    if (model.outlineLevel) {
      xmlStream.addAttribute("outlineLevel", model.outlineLevel);
    }
    if (model.collapsed) {
      xmlStream.addAttribute("collapsed", "1");
    }
    xmlStream.addAttribute("customWidth", "1");
    xmlStream.closeNode();
  }

  parseOpen(node: any): boolean {
    if (node.name === "col") {
      const model: ColModel = (this.model = {
        min: parseInt(node.attributes.min || "0", 10),
        max: parseInt(node.attributes.max || "0", 10),
        width:
          node.attributes.width === undefined ? undefined : parseFloat(node.attributes.width || "0")
      });
      if (node.attributes.style) {
        model.styleId = parseInt(node.attributes.style, 10);
      }
      if (parseBoolean(node.attributes.hidden)) {
        model.hidden = true;
      }
      if (parseBoolean(node.attributes.bestFit)) {
        model.bestFit = true;
      }
      if (node.attributes.outlineLevel) {
        model.outlineLevel = parseInt(node.attributes.outlineLevel, 10);
      }
      if (parseBoolean(node.attributes.collapsed)) {
        model.collapsed = true;
      }
      return true;
    }
    return false;
  }

  parseText(): void {}

  parseClose(): boolean {
    return false;
  }

  reconcile(model: ColModel, options: any): void {
    // reconcile column styles
    if (model.styleId) {
      model.style = options.styles.getStyleModel(model.styleId);
    }
  }
}

export { ColXform };
