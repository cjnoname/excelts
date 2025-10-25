import { BaseXform } from "../../base-xform.js";
import { CompositeXform } from "../../composite-xform.js";

class X14IdXform extends BaseXform {
  get tag(): string {
    return "x14:id";
  }

  render(xmlStream: any, model: any): void {
    xmlStream.leafNode(this.tag, null, model);
  }

  parseOpen(): void {
    this.model = "";
  }

  parseText(text: string): void {
    this.model += text;
  }

  parseClose(name: string): boolean {
    return name !== this.tag;
  }
}

class ExtXform extends CompositeXform {
  idXform: X14IdXform;

  constructor() {
    super();

    this.map = {
      "x14:id": (this.idXform = new X14IdXform())
    };
  }

  get tag(): string {
    return "ext";
  }

  render(xmlStream: any, model: any): void {
    xmlStream.openNode(this.tag, {
      uri: "{B025F937-C7B1-47D3-B67F-A62EFF666E3E}",
      "xmlns:x14": "http://schemas.microsoft.com/office/spreadsheetml/2009/9/main"
    });

    this.idXform.render(xmlStream, model.x14Id);

    xmlStream.closeNode();
  }

  createNewModel(): any {
    return {};
  }

  onParserClose(name: string, parser: any): void {
    this.model.x14Id = parser.model;
  }
}

class ExtLstRefXform extends CompositeXform {
  constructor() {
    super();
    this.map = {
      ext: new ExtXform()
    };
  }

  get tag(): string {
    return "extLst";
  }

  render(xmlStream: any, model: any): void {
    xmlStream.openNode(this.tag);
    this.map.ext.render(xmlStream, model);
    xmlStream.closeNode();
  }

  createNewModel(): any {
    return {};
  }

  onParserClose(name: string, parser: any): void {
    Object.assign(this.model, parser.model);
  }
}

export { ExtLstRefXform };
