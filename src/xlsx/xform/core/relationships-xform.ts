import { XmlStream } from "../../../utils/xml-stream.js";
import { BaseXform } from "../base-xform.js";
import { RelationshipXform } from "./relationship-xform.js";

class RelationshipsXform extends BaseXform {
  declare public parser: any;
  declare private _values?: any[];

  constructor() {
    super();

    this.map = {
      Relationship: new RelationshipXform()
    };
  }

  render(xmlStream: any, model?: any[]): void {
    const renderModel = model || this._values;
    xmlStream.openXml(XmlStream.StdDocAttributes);
    xmlStream.openNode("Relationships", RelationshipsXform.RELATIONSHIPS_ATTRIBUTES);

    renderModel!.forEach(relationship => {
      this.map.Relationship.render(xmlStream, relationship);
    });

    xmlStream.closeNode();
  }

  parseOpen(node: any): boolean {
    if (this.parser) {
      this.parser.parseOpen(node);
      return true;
    }
    switch (node.name) {
      case "Relationships":
        this.model = [];
        return true;
      default:
        this.parser = this.map[node.name];
        if (this.parser) {
          this.parser.parseOpen(node);
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
        this.model.push(this.parser.model);
        this.parser = undefined;
      }
      return true;
    }
    switch (name) {
      case "Relationships":
        return false;
      default:
        throw new Error(`Unexpected xml node in parseClose: ${name}`);
    }
  }

  static RELATIONSHIPS_ATTRIBUTES = {
    xmlns: "http://schemas.openxmlformats.org/package/2006/relationships"
  };
}

export { RelationshipsXform };
