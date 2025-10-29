import { CompositeXform } from "../../composite-xform.js";
import { ColorXform } from "../../style/color-xform.js";
import { CfvoXform } from "./cfvo-xform.js";

class ColorScaleXform extends CompositeXform {
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
    return "colorScale";
  }

  render(xmlStream: any, model: any): void {
    xmlStream.openNode(this.tag);

    model.cfvo.forEach((cfvo: any) => {
      this.cfvoXform.render(xmlStream, cfvo);
    });
    model.color.forEach((color: any) => {
      this.colorXform.render(xmlStream, color);
    });

    xmlStream.closeNode();
  }

  createNewModel(node: any): any {
    return {
      cfvo: [],
      color: []
    };
  }

  onParserClose(name: string, parser: any): void {
    this.model[name].push(parser.model);
  }
}

export { ColorScaleXform };
