import { BaseXform } from "../base-xform.js";
import { CellXform } from "./cell-xform.js";
import { parseBoolean } from "../../../utils/utils.js";

interface RowXformOptions {
  maxItems?: number;
}

interface RowModel {
  number: number;
  min?: number;
  max?: number;
  cells: any[];
  styleId?: number;
  hidden?: boolean;
  bestFit?: boolean;
  height?: number;
  outlineLevel?: number;
  collapsed?: boolean;
  style?: any;
}

class RowXform extends BaseXform {
  declare private maxItems?: number;
  declare public map: { [key: string]: any };
  declare public model: RowModel;
  declare public parser: any;
  declare private numRowsSeen: number;

  constructor(options?: RowXformOptions) {
    super();

    this.maxItems = options && options.maxItems;
    this.map = {
      c: new CellXform()
    };
  }

  get tag(): string {
    return "row";
  }

  prepare(model: RowModel, options: any): void {
    const styleId = options.styles.addStyleModel(model.style);
    if (styleId) {
      model.styleId = styleId;
    }
    const cellXform = this.map.c;
    model.cells.forEach((cellModel: any) => {
      cellXform.prepare(cellModel, options);
    });
  }

  render(xmlStream: any, model?: RowModel, options?: any): void {
    if (!model) {
      return;
    }
    xmlStream.openNode("row");
    xmlStream.addAttribute("r", model.number);
    if (model.height) {
      xmlStream.addAttribute("ht", model.height);
      xmlStream.addAttribute("customHeight", "1");
    }
    if (model.hidden) {
      xmlStream.addAttribute("hidden", "1");
    }
    if (model.min! > 0 && model.max! > 0 && model.min! <= model.max!) {
      xmlStream.addAttribute("spans", `${model.min}:${model.max}`);
    }
    if (model.styleId) {
      xmlStream.addAttribute("s", model.styleId);
      xmlStream.addAttribute("customFormat", "1");
    }
    xmlStream.addAttribute("x14ac:dyDescent", "0.25");
    if (model.outlineLevel) {
      xmlStream.addAttribute("outlineLevel", model.outlineLevel);
    }
    if (model.collapsed) {
      xmlStream.addAttribute("collapsed", "1");
    }

    const cellXform = this.map.c;
    model.cells.forEach((cellModel: any) => {
      cellXform.render(xmlStream, cellModel, options);
    });

    xmlStream.closeNode();
  }

  parseOpen(node: any): boolean {
    if (this.parser) {
      this.parser.parseOpen(node);
      return true;
    }
    if (node.name === "row") {
      this.numRowsSeen += 1;
      const spans = node.attributes.spans
        ? node.attributes.spans.split(":").map((span: string) => parseInt(span, 10))
        : [undefined, undefined];
      const model: RowModel = (this.model = {
        number: parseInt(node.attributes.r, 10),
        min: spans[0],
        max: spans[1],
        cells: []
      });
      if (node.attributes.s) {
        model.styleId = parseInt(node.attributes.s, 10);
      }
      if (parseBoolean(node.attributes.hidden)) {
        model.hidden = true;
      }
      if (parseBoolean(node.attributes.bestFit)) {
        model.bestFit = true;
      }
      if (node.attributes.ht) {
        model.height = parseFloat(node.attributes.ht);
      }
      if (node.attributes.outlineLevel) {
        model.outlineLevel = parseInt(node.attributes.outlineLevel, 10);
      }
      if (parseBoolean(node.attributes.collapsed)) {
        model.collapsed = true;
      }
      return true;
    }

    this.parser = this.map[node.name];
    if (this.parser) {
      this.parser.parseOpen(node);
      return true;
    }
    return false;
  }

  parseText(text: string): void {
    if (this.parser) {
      this.parser.parseText(text);
    }
  }

  parseClose(name: string): boolean {
    if (this.parser) {
      if (!this.parser.parseClose(name)) {
        this.model.cells.push(this.parser.model);
        if (this.maxItems && this.model.cells.length > this.maxItems) {
          throw new Error(`Max column count (${this.maxItems}) exceeded`);
        }
        this.parser = undefined;
      }
      return true;
    }
    return false;
  }

  reconcile(model: RowModel, options: any): void {
    model.style = model.styleId ? options.styles.getStyleModel(model.styleId) : {};
    if (model.styleId !== undefined) {
      model.styleId = undefined;
    }

    const cellXform = this.map.c;
    model.cells.forEach((cellModel: any) => {
      cellXform.reconcile(cellModel, options);
    });
  }
}

export { RowXform };
