import { BaseXform } from "../base-xform.js";

interface BlipModel {
  rId: string;
}

class BlipXform extends BaseXform {
  declare public model: BlipModel;

  constructor() {
    super();
    this.model = { rId: "" };
  }

  get tag(): string {
    return "a:blip";
  }

  render(xmlStream: any, model: BlipModel): void {
    xmlStream.leafNode(this.tag, {
      "xmlns:r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
      "r:embed": model.rId,
      cstate: "print"
    });
    // TODO: handle children (e.g. a:extLst=>a:ext=>a14:useLocalDpi
  }

  parseOpen(node: any): boolean {
    switch (node.name) {
      case this.tag:
        this.model = {
          rId: node.attributes["r:embed"]
        };
        return true;
      default:
        return true;
    }
  }

  parseText(): void {}

  parseClose(name: string): boolean {
    switch (name) {
      case this.tag:
        return false;
      default:
        // unprocessed internal nodes
        return true;
    }
  }
}

export { BlipXform };
