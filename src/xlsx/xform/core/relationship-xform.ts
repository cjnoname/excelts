import { BaseXform } from "../base-xform.js";

interface RelationshipModel {
  Id?: string;
  Type?: string;
  Target?: string;
  TargetMode?: string;
}

class RelationshipXform extends BaseXform {
  render(xmlStream: any, model: RelationshipModel): void {
    xmlStream.leafNode("Relationship", model);
  }

  parseOpen(node: any): boolean {
    switch (node.name) {
      case "Relationship":
        this.model = node.attributes;
        return true;
      default:
        return false;
    }
  }

  parseText(): void {}

  parseClose(): boolean {
    return false;
  }
}

export { RelationshipXform };
