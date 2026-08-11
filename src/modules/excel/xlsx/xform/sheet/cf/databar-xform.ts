import type { Color, Cfvo } from "@excel/types";
import type { BaseXform } from "@excel/xlsx/xform/base-xform";
import { CompositeXform } from "@excel/xlsx/xform/composite-xform";
import { CfvoXform } from "@excel/xlsx/xform/sheet/cf/cfvo-xform";
import { ColorXform } from "@excel/xlsx/xform/style/color-xform";
import type { XmlSink } from "@xml/types";

interface DatabarModel {
  cfvo: Cfvo[];
  color?: Partial<Color>;
}

class DatabarXform extends CompositeXform<DatabarModel> {
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

  render(xmlStream: XmlSink, model: DatabarModel): void {
    xmlStream.openNode(this.tag);

    model.cfvo.forEach(cfvo => {
      this.cfvoXform.render(xmlStream, cfvo);
    });
    this.colorXform.render(xmlStream, model.color);

    xmlStream.closeNode();
  }

  createNewModel(): DatabarModel {
    return {
      cfvo: []
    };
  }

  onParserClose(name: string, parser: BaseXform): void {
    switch (name) {
      case "cfvo":
        this.model!.cfvo.push(parser.model as Cfvo);
        break;
      case "color":
        this.model!.color = parser.model as Partial<Color>;
        break;
    }
  }
}

export { DatabarXform };
