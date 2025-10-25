import { CompositeXform } from "../../composite-xform.js";
import { ColorXform } from "../../style/color-xform.js";
import { CfvoXform } from "./cfvo-xform.js";

class DatabarXform extends CompositeXform {
  cfvoXform: CfvoXform;
  colorXform: ColorXform;

  constructor() {
    super();

    this.map = {
      cfvo: (this.cfvoXform = new CfvoXform()),
      color: (this.colorXform = new ColorXform())
    };
  }

  get tag(): string {
    return "dataBar";
  }

  render(xmlStream: any, model: any): void {
    xmlStream.openNode(this.tag);

    model.cfvo.forEach((cfvo: any) => {
      this.cfvoXform.render(xmlStream, cfvo);
    });
    this.colorXform.render(xmlStream, model.color);

    xmlStream.closeNode();
  }

  createNewModel(): any {
    return {
      cfvo: []
    };
  }

  onParserClose(name: string, parser: any): void {
    switch (name) {
      case "cfvo":
        this.model.cfvo.push(parser.model);
        break;
      case "color":
        this.model.color = parser.model;
        break;
    }
  }
}

export { DatabarXform };
