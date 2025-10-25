import { BaseXform } from "../base-xform.js";
import { parseBoolean } from "../../../utils/utils.js";
import { ColorXform } from "./color-xform.js";

interface EdgeModel {
  style?: string;
  color?: any;
}

interface BorderModel {
  top?: EdgeModel;
  left?: EdgeModel;
  bottom?: EdgeModel;
  right?: EdgeModel;
  diagonal?: EdgeModel & { up?: boolean; down?: boolean };
  color?: any;
}

class EdgeXform extends BaseXform {
  declare private name: string;
  declare public map: { color: ColorXform };
  declare private defaultColor: any;
  declare public parser: any;

  constructor(name: string) {
    super();

    this.name = name;
    this.map = {
      color: new ColorXform()
    };
  }

  get tag(): string {
    return this.name;
  }

  render(xmlStream: any, model?: EdgeModel, defaultColor?: any): void {
    const color = (model && model.color) || defaultColor || this.defaultColor;
    xmlStream.openNode(this.name);
    if (model && model.style) {
      xmlStream.addAttribute("style", model.style);
      if (color) {
        this.map.color.render(xmlStream, color);
      }
    }
    xmlStream.closeNode();
  }

  parseOpen(node: any): boolean {
    if (this.parser) {
      this.parser.parseOpen(node);
      return true;
    }
    switch (node.name) {
      case this.name: {
        const { style } = node.attributes;
        if (style) {
          this.model = {
            style
          };
        } else {
          this.model = undefined;
        }
        return true;
      }
      case "color":
        this.parser = this.map.color;
        this.parser.parseOpen(node);
        return true;
      default:
        return false;
    }
  }

  parseText(text: string): void {
    if (this.parser) {
      this.parser.parseText(text);
    }
  }

  parseClose(name: string): boolean {
    if (this.parser) {
      if (!this.parser.parseClose(name)) {
        this.parser = undefined;
      }
      return true;
    }

    if (name === this.name) {
      if (this.map.color.model) {
        if (!this.model) {
          this.model = {};
        }
        this.model.color = this.map.color.model;
      }
    }

    return false;
  }

  validStyle(value: string): boolean {
    return EdgeXform.validStyleValues[value];
  }

  static validStyleValues: { [key: string]: boolean } = [
    "thin",
    "dashed",
    "dotted",
    "dashDot",
    "hair",
    "dashDotDot",
    "slantDashDot",
    "mediumDashed",
    "mediumDashDotDot",
    "mediumDashDot",
    "medium",
    "double",
    "thick"
  ].reduce((p: { [key: string]: boolean }, v: string) => {
    p[v] = true;
    return p;
  }, {});
}

// Border encapsulates translation from border model to/from xlsx
class BorderXform extends BaseXform {
  declare public map: { [key: string]: EdgeXform };
  declare public parser: any;
  declare private diagonalUp: boolean | undefined;
  declare private diagonalDown: boolean | undefined;

  constructor() {
    super();

    this.map = {
      top: new EdgeXform("top"),
      left: new EdgeXform("left"),
      bottom: new EdgeXform("bottom"),
      right: new EdgeXform("right"),
      diagonal: new EdgeXform("diagonal")
    };
  }

  render(xmlStream: any, model: BorderModel): void {
    const { color } = model;
    xmlStream.openNode("border");
    if (model.diagonal && model.diagonal.style) {
      if (model.diagonal.up) {
        xmlStream.addAttribute("diagonalUp", "1");
      }
      if (model.diagonal.down) {
        xmlStream.addAttribute("diagonalDown", "1");
      }
    }
    const add = (edgeModel: EdgeModel | undefined, edgeXform: EdgeXform): void => {
      let edge = edgeModel;
      if (edge && !edge.color && model.color) {
        // don't mess with incoming models
        edge = {
          ...edge,
          color: model.color
        };
      }
      edgeXform.render(xmlStream, edge, color);
    };
    add(model.left, this.map.left);
    add(model.right, this.map.right);
    add(model.top, this.map.top);
    add(model.bottom, this.map.bottom);
    add(model.diagonal, this.map.diagonal);

    xmlStream.closeNode();
  }

  parseOpen(node: any): boolean {
    if (this.parser) {
      this.parser.parseOpen(node);
      return true;
    }
    switch (node.name) {
      case "border":
        this.reset();
        this.diagonalUp = parseBoolean(node.attributes.diagonalUp);
        this.diagonalDown = parseBoolean(node.attributes.diagonalDown);
        return true;
      default:
        this.parser = this.map[node.name];
        if (this.parser) {
          this.parser.parseOpen(node);
          return true;
        }
        return false;
    }
  }

  parseText(text: string): void {
    if (this.parser) {
      this.parser.parseText(text);
    }
  }

  parseClose(name: string): boolean {
    if (this.parser) {
      if (!this.parser.parseClose(name)) {
        this.parser = undefined;
      }
      return true;
    }
    if (name === "border") {
      const model: any = (this.model = {});
      const add = (key: string, edgeModel: any, extensions?: any): void => {
        if (edgeModel) {
          if (extensions) {
            Object.assign(edgeModel, extensions);
          }
          model[key] = edgeModel;
        }
      };
      add("left", this.map.left.model);
      add("right", this.map.right.model);
      add("top", this.map.top.model);
      add("bottom", this.map.bottom.model);
      add("diagonal", this.map.diagonal.model, { up: this.diagonalUp, down: this.diagonalDown });
    }
    return false;
  }
}

export { BorderXform };
