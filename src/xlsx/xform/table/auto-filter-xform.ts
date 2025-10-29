import { BaseXform } from "../base-xform.js";
import { FilterColumnXform } from "./filter-column-xform.js";

interface AutoFilterModel {
  autoFilterRef: string;
  columns: any[];
}

class AutoFilterXform extends BaseXform {
  declare public map: { [key: string]: FilterColumnXform };
  declare public parser: any;
  declare public model: AutoFilterModel;

  constructor() {
    super();

    this.map = {
      filterColumn: new FilterColumnXform()
    };
    this.model = { autoFilterRef: "", columns: [] };
  }

  get tag(): string {
    return "autoFilter";
  }

  prepare(model: any): void {
    model.columns.forEach((column: any, index: number) => {
      this.map.filterColumn.prepare(column, { index });
    });
  }

  render(xmlStream: any, model: any): void {
    xmlStream.openNode(this.tag, { ref: model.autoFilterRef });

    model.columns.forEach((column: any) => {
      this.map.filterColumn.render(xmlStream, column);
    });

    xmlStream.closeNode();
  }

  parseOpen(node: any): boolean {
    if (this.parser) {
      this.parser.parseOpen(node);
      return true;
    }
    switch (node.name) {
      case this.tag:
        this.model = {
          autoFilterRef: node.attributes.ref,
          columns: []
        };
        return true;

      default:
        this.parser = this.map[node.name];
        if (this.parser) {
          this.parseOpen(node);
          return true;
        }
        throw new Error(`Unexpected xml node in parseOpen: ${JSON.stringify(node)}`);
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
        this.model.columns.push(this.parser.model);
        this.parser = undefined;
      }
      return true;
    }
    switch (name) {
      case this.tag:
        return false;
      default:
        throw new Error(`Unexpected xml node in parseClose: ${name}`);
    }
  }
}

export { AutoFilterXform };
