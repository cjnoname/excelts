import { CompositeXform } from "../composite-xform.js";
import { ConditionalFormattingsExtXform } from "./cf-ext/conditional-formattings-ext-xform.js";

class ExtXform extends CompositeXform {
  declare public map: { [key: string]: any };
  declare public model: any;
  declare private conditionalFormattings: ConditionalFormattingsExtXform;

  constructor() {
    super();
    this.map = {
      "x14:conditionalFormattings": (this.conditionalFormattings =
        new ConditionalFormattingsExtXform())
    };
  }

  get tag(): string {
    return "ext";
  }

  hasContent(model: any): boolean {
    return this.conditionalFormattings.hasContent(model.conditionalFormattings);
  }

  prepare(model: any): void {
    this.conditionalFormattings.prepare(model.conditionalFormattings);
  }

  render(xmlStream: any, model: any): void {
    xmlStream.openNode("ext", {
      uri: "{78C0D931-6437-407d-A8EE-F0AAD7539E65}",
      "xmlns:x14": "http://schemas.microsoft.com/office/spreadsheetml/2009/9/main"
    });

    this.conditionalFormattings.render(xmlStream, model.conditionalFormattings);

    xmlStream.closeNode();
  }

  createNewModel(): any {
    return {};
  }

  onParserClose(name: string, parser: any): void {
    this.model[name] = parser.model;
  }
}

class ExtLstXform extends CompositeXform {
  declare public map: { [key: string]: any };
  declare public model: any;
  declare private ext: ExtXform;

  constructor() {
    super();

    this.map = {
      ext: (this.ext = new ExtXform())
    };
  }

  get tag(): string {
    return "extLst";
  }

  prepare(model: any, _options?: any): void {
    this.ext.prepare(model);
  }

  hasContent(model: any): boolean {
    return this.ext.hasContent(model);
  }

  render(xmlStream: any, model: any): void {
    if (!this.hasContent(model)) {
      return;
    }

    xmlStream.openNode("extLst");
    this.ext.render(xmlStream, model);
    xmlStream.closeNode();
  }

  createNewModel(): any {
    return {};
  }

  onParserClose(name: string, parser: any): void {
    this.model[name] = parser.model;
  }
}

export { ExtLstXform };
