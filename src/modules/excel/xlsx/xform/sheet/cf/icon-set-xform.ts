import type { Cfvo, IconSetTypes } from "@excel/types";
import { BaseXform } from "@excel/xlsx/xform/base-xform";
import { CompositeXform } from "@excel/xlsx/xform/composite-xform";
import { CfvoXform } from "@excel/xlsx/xform/sheet/cf/cfvo-xform";
import type { ParseOpenTag, XmlSink } from "@xml/types";

interface IconSetModel {
  iconSet?: IconSetTypes;
  reverse?: boolean;
  showValue?: boolean;
  cfvo: Cfvo[];
}

class IconSetXform extends CompositeXform<IconSetModel> {
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

  render(xmlStream: XmlSink, model: IconSetModel): void {
    xmlStream.openNode(this.tag, {
      iconSet: BaseXform.toStringAttribute(model.iconSet, "3TrafficLights"),
      reverse: BaseXform.toBoolAttribute(model.reverse, false),
      showValue: BaseXform.toBoolAttribute(model.showValue, true)
    });

    model.cfvo.forEach(cfvo => {
      this.cfvoXform.render(xmlStream, cfvo);
    });

    xmlStream.closeNode();
  }

  createNewModel({ attributes }: ParseOpenTag): IconSetModel {
    return {
      iconSet: BaseXform.toStringValue(attributes.iconSet, "3TrafficLights") as IconSetTypes,
      reverse: BaseXform.toBoolValue(attributes.reverse),
      showValue: BaseXform.toBoolValue(attributes.showValue),
      cfvo: []
    };
  }

  onParserClose(_name: string, _parser: BaseXform): void {
    // The only child xform is `cfvo`; append its precisely-typed model.
    this.model!.cfvo.push(this.cfvoXform.model!);
  }
}

export { IconSetXform };
