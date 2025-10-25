import { BaseXform } from "../../base-xform.js";
import { ConditionalFormattingXform } from "./conditional-formatting-xform.js";

class ConditionalFormattingsXform extends BaseXform {
  cfXform: ConditionalFormattingXform;
  parser: any;

  constructor() {
    super();

    this.cfXform = new ConditionalFormattingXform();
  }

  get tag(): string {
    return "conditionalFormatting";
  }

  reset(): void {
    this.model = [];
  }

  prepare(model: any, options: any): void {
    // ensure each rule has a priority value
    let nextPriority = model.reduce(
      (p: number, cf: any) => Math.max(p, ...cf.rules.map((rule: any) => rule.priority || 0)),
      1
    );
    model.forEach((cf: any) => {
      cf.rules.forEach((rule: any) => {
        if (!rule.priority) {
          rule.priority = nextPriority++;
        }

        if (rule.style) {
          rule.dxfId = options.styles.addDxfStyle(rule.style);
        }
      });
    });
  }

  render(xmlStream: any, model: any): void {
    model.forEach((cf: any) => {
      this.cfXform.render(xmlStream, cf);
    });
  }

  parseOpen(node: any): boolean {
    if (this.parser) {
      this.parser.parseOpen(node);
      return true;
    }

    switch (node.name) {
      case "conditionalFormatting":
        this.parser = this.cfXform;
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
        this.model.push(this.parser.model);
        this.parser = undefined;
        return false;
      }
      return true;
    }
    return false;
  }

  reconcile(model: any, options: any): void {
    model.forEach((cf: any) => {
      cf.rules.forEach((rule: any) => {
        if (rule.dxfId !== undefined) {
          rule.style = options.styles.getDxfStyle(rule.dxfId);
          delete rule.dxfId;
        }
      });
    });
  }
}

export { ConditionalFormattingsXform };
