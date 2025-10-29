import { BaseXform } from "../base-xform.js";
import { ColorXform } from "./color-xform.js";

interface StopModel {
  position: number;
  color: any;
}

interface PatternFillModel {
  type: "pattern";
  pattern: string;
  fgColor?: any;
  bgColor?: any;
}

interface GradientFillModel {
  type: "gradient";
  gradient: "angle" | "path";
  degree?: number;
  center?: {
    left: number;
    top: number;
    right?: number;
    bottom?: number;
  };
  stops: StopModel[];
}

type FillModel = PatternFillModel | GradientFillModel;

class StopXform extends BaseXform {
  declare public map: { color: ColorXform };
  declare public parser: any;

  constructor() {
    super();

    this.map = {
      color: new ColorXform()
    };
  }

  get tag(): string {
    return "stop";
  }

  render(xmlStream: any, model: StopModel): void {
    xmlStream.openNode("stop");
    xmlStream.addAttribute("position", model.position);
    this.map.color.render(xmlStream, model.color);
    xmlStream.closeNode();
  }

  parseOpen(node: any): boolean {
    if (this.parser) {
      this.parser.parseOpen(node);
      return true;
    }
    switch (node.name) {
      case "stop":
        this.model = {
          position: parseFloat(node.attributes.position)
        };
        return true;
      case "color":
        this.parser = this.map.color;
        this.parser.parseOpen(node);
        return true;
      default:
        return false;
    }
  }

  parseText(): void {}

  parseClose(name: string): boolean {
    if (this.parser) {
      if (!this.parser.parseClose(name)) {
        this.model.color = this.parser.model;
        this.parser = undefined;
      }
      return true;
    }
    return false;
  }
}

class PatternFillXform extends BaseXform {
  declare public map: { fgColor: ColorXform; bgColor: ColorXform };
  declare public parser: any;

  constructor() {
    super();

    this.map = {
      fgColor: new ColorXform("fgColor"),
      bgColor: new ColorXform("bgColor")
    };
  }

  get name(): string {
    return "pattern";
  }

  get tag(): string {
    return "patternFill";
  }

  render(xmlStream: any, model: PatternFillModel): void {
    xmlStream.openNode("patternFill");
    xmlStream.addAttribute("patternType", model.pattern);
    if (model.fgColor) {
      this.map.fgColor.render(xmlStream, model.fgColor);
    }
    if (model.bgColor) {
      this.map.bgColor.render(xmlStream, model.bgColor);
    }
    xmlStream.closeNode();
  }

  parseOpen(node: any): boolean {
    if (this.parser) {
      this.parser.parseOpen(node);
      return true;
    }
    switch (node.name) {
      case "patternFill":
        this.model = {
          type: "pattern",
          pattern: node.attributes.patternType
        };
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
        if (this.parser.model) {
          this.model[name] = this.parser.model;
        }
        this.parser = undefined;
      }
      return true;
    }
    return false;
  }
}

class GradientFillXform extends BaseXform {
  declare public map: { stop: StopXform };
  declare public parser: any;

  constructor() {
    super();

    this.map = {
      stop: new StopXform()
    };
  }

  get name(): string {
    return "gradient";
  }

  get tag(): string {
    return "gradientFill";
  }

  render(xmlStream: any, model: GradientFillModel): void {
    xmlStream.openNode("gradientFill");
    switch (model.gradient) {
      case "angle":
        xmlStream.addAttribute("degree", model.degree);
        break;
      case "path":
        xmlStream.addAttribute("type", "path");
        if (model.center!.left) {
          xmlStream.addAttribute("left", model.center!.left);
          if (model.center!.right === undefined) {
            xmlStream.addAttribute("right", model.center!.left);
          }
        }
        if (model.center!.right) {
          xmlStream.addAttribute("right", model.center!.right);
        }
        if (model.center!.top) {
          xmlStream.addAttribute("top", model.center!.top);
          if (model.center!.bottom === undefined) {
            xmlStream.addAttribute("bottom", model.center!.top);
          }
        }
        if (model.center!.bottom) {
          xmlStream.addAttribute("bottom", model.center!.bottom);
        }
        break;

      default:
        break;
    }

    const stopXform = this.map.stop;
    model.stops.forEach(stopModel => {
      stopXform.render(xmlStream, stopModel);
    });

    xmlStream.closeNode();
  }

  parseOpen(node: any): boolean {
    if (this.parser) {
      this.parser.parseOpen(node);
      return true;
    }
    switch (node.name) {
      case "gradientFill": {
        const model: any = (this.model = {
          stops: []
        });
        if (node.attributes.degree) {
          model.gradient = "angle";
          model.degree = parseInt(node.attributes.degree, 10);
        } else if (node.attributes.type === "path") {
          model.gradient = "path";
          model.center = {
            left: node.attributes.left ? parseFloat(node.attributes.left) : 0,
            top: node.attributes.top ? parseFloat(node.attributes.top) : 0
          };
          if (node.attributes.right !== node.attributes.left) {
            model.center.right = node.attributes.right ? parseFloat(node.attributes.right) : 0;
          }
          if (node.attributes.bottom !== node.attributes.top) {
            model.center.bottom = node.attributes.bottom ? parseFloat(node.attributes.bottom) : 0;
          }
        }
        return true;
      }

      case "stop":
        this.parser = this.map.stop;
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
        this.model.stops.push(this.parser.model);
        this.parser = undefined;
      }
      return true;
    }
    return false;
  }
}

// Fill encapsulates translation from fill model to/from xlsx
class FillXform extends BaseXform {
  declare public map: { patternFill: PatternFillXform; gradientFill: GradientFillXform };
  declare public parser: any;

  constructor() {
    super();

    this.map = {
      patternFill: new PatternFillXform(),
      gradientFill: new GradientFillXform()
    };
  }

  get tag(): string {
    return "fill";
  }

  render(xmlStream: any, model: FillModel): void {
    xmlStream.addRollback();
    xmlStream.openNode("fill");
    switch (model.type) {
      case "pattern":
        this.map.patternFill.render(xmlStream, model);
        break;
      case "gradient":
        this.map.gradientFill.render(xmlStream, model);
        break;
      default:
        xmlStream.rollback();
        return;
    }
    xmlStream.closeNode();
    xmlStream.commit();
  }

  parseOpen(node: any): boolean {
    if (this.parser) {
      this.parser.parseOpen(node);
      return true;
    }
    switch (node.name) {
      case "fill":
        this.model = {};
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
        this.model = this.parser.model;
        this.model.type = this.parser.name;
        this.parser = undefined;
      }
      return true;
    }
    return false;
  }

  validStyle(value: string): boolean {
    return FillXform.validPatternValues[value];
  }

  static validPatternValues: { [key: string]: boolean } = [
    "none",
    "solid",
    "darkVertical",
    "darkGray",
    "mediumGray",
    "lightGray",
    "gray125",
    "gray0625",
    "darkHorizontal",
    "darkVertical",
    "darkDown",
    "darkUp",
    "darkGrid",
    "darkTrellis",
    "lightHorizontal",
    "lightVertical",
    "lightDown",
    "lightUp",
    "lightGrid",
    "lightTrellis",
    "lightGrid"
  ].reduce((p: { [key: string]: boolean }, v: string) => {
    p[v] = true;
    return p;
  }, {});

  static StopXform = StopXform;
  static PatternFillXform = PatternFillXform;
  static GradientFillXform = GradientFillXform;
}

export { FillXform };
