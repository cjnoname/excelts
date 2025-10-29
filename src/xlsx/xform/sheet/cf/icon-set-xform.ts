import { BaseXform } from "../../base-xform.js";
import { CompositeXform } from "../../composite-xform.js";
import { CfvoXform } from "./cfvo-xform.js";

class IconSetXform extends CompositeXform {
  cfvoXform: CfvoXform;

  constructor() {
    super();

    this.map = {
      cfvo: (this.cfvoXform = new CfvoXform())
    };
  }

  get tag(): string {
    return "iconSet";
  }

  render(xmlStream: any, model: any): void {
    xmlStream.openNode(this.tag, {
      iconSet: BaseXform.toStringAttribute(model.iconSet, "3TrafficLights"),
      reverse: BaseXform.toBoolAttribute(model.reverse, false),
      showValue: BaseXform.toBoolAttribute(model.showValue, true)
    });

    model.cfvo.forEach((cfvo: any) => {
      this.cfvoXform.render(xmlStream, cfvo);
    });

    xmlStream.closeNode();
  }

  createNewModel({ attributes }: any): any {
    return {
      iconSet: BaseXform.toStringValue(attributes.iconSet, "3TrafficLights"),
      reverse: BaseXform.toBoolValue(attributes.reverse),
      showValue: BaseXform.toBoolValue(attributes.showValue),
      cfvo: []
    };
  }

  onParserClose(name: string, parser: any): void {
    this.model[name].push(parser.model);
  }
}

export { IconSetXform };
