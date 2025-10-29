import { BaseXform } from "./base-xform.js";

/* 'virtual' methods used as a form of documentation */

// base class for xforms that are composed of other xforms
// offers some default implementations
class CompositeXform extends BaseXform {
  declare public parser?: any;

  createNewModel(_node?: any): any {
    return {};
  }

  parseOpen(node: any): boolean {
    // Typical pattern for composite xform
    this.parser = this.parser || this.map![node.name];
    if (this.parser) {
      this.parser.parseOpen(node);
      return true;
    }

    if (node.name === this.tag) {
      this.model = this.createNewModel(node);
      return true;
    }

    return false;
  }

  parseText(text: string): void {
    // Default implementation. Send text to child parser
    if (this.parser) {
      this.parser.parseText(text);
    }
  }

  onParserClose(name: string, parser: any): void {
    // parseClose has seen a child parser close
    // now need to incorporate into this.model somehow
    this.model[name] = parser.model;
  }

  parseClose(name: string): boolean {
    // Default implementation
    if (this.parser) {
      if (!this.parser.parseClose(name)) {
        this.onParserClose(name, this.parser);
        this.parser = undefined;
      }
      return true;
    }

    return name !== this.tag;
  }

  get tag(): string {
    return "";
  }
}

export { CompositeXform };
