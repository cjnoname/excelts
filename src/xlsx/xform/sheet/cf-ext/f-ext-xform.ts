import { BaseXform } from "../../base-xform.js";

class FExtXform extends BaseXform {
  get tag() {
    return "xm:f";
  }

  render(xmlStream, model) {
    xmlStream.leafNode(this.tag, null, model);
  }

  parseOpen() {
    this.model = "";
  }

  parseText(text) {
    this.model += text;
  }

  parseClose(name) {
    return name !== this.tag;
  }
}

export { FExtXform };
