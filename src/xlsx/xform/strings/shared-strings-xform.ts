import { XmlStream } from "../../../utils/xml-stream.js";
import { BaseXform } from "../base-xform.js";
import { SharedStringXform } from "./shared-string-xform.js";

interface SharedStringsModel {
  values: any[];
  count: number;
}

class SharedStringsXform extends BaseXform {
  declare private hash: { [key: string]: number };
  declare private rich: { [key: string]: number };
  declare public parser: any;
  declare private _sharedStringXform?: SharedStringXform;
  declare private _values?: SharedStringsModel;

  constructor(model?: SharedStringsModel) {
    super();

    this.model = model || {
      values: [],
      count: 0
    };
    this.hash = Object.create(null);
    this.rich = Object.create(null);
  }

  get sharedStringXform(): SharedStringXform {
    return this._sharedStringXform || (this._sharedStringXform = new SharedStringXform());
  }

  get values(): any[] {
    return this.model.values;
  }

  get uniqueCount(): number {
    return this.model.values.length;
  }

  get count(): number {
    return this.model.count;
  }

  getString(index: number): any {
    return this.model.values[index];
  }

  add(value: any): number {
    return value.richText ? this.addRichText(value) : this.addText(value);
  }

  addText(value: string): number {
    let index = this.hash[value];
    if (index === undefined) {
      index = this.hash[value] = this.model.values.length;
      this.model.values.push(value);
    }
    this.model.count++;
    return index;
  }

  addRichText(value: any): number {
    // TODO: add WeakMap here
    const xml = this.sharedStringXform.toXml(value);
    let index = this.rich[xml];
    if (index === undefined) {
      index = this.rich[xml] = this.model.values.length;
      this.model.values.push(value);
    }
    this.model.count++;
    return index;
  }

  // <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
  // <sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="<%=totalRefs%>" uniqueCount="<%=count%>">
  //   <si><t><%=text%></t></si>
  //   <si><r><rPr></rPr><t></t></r></si>
  // </sst>

  render(xmlStream: any, model?: SharedStringsModel): void {
    const renderModel = model || this._values;
    xmlStream.openXml(XmlStream.StdDocAttributes);

    xmlStream.openNode("sst", {
      xmlns: "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
      count: renderModel!.count,
      uniqueCount: renderModel!.values.length
    });

    const sx = this.sharedStringXform;
    renderModel!.values.forEach(sharedString => {
      sx.render(xmlStream, sharedString);
    });
    xmlStream.closeNode();
  }

  parseOpen(node: any): boolean {
    if (this.parser) {
      this.parser.parseOpen(node);
      return true;
    }
    switch (node.name) {
      case "sst":
        return true;
      case "si":
        this.parser = this.sharedStringXform;
        this.parser.parseOpen(node);
        return true;
      default:
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
        this.model.values.push(this.parser.model);
        this.model.count++;
        this.parser = undefined;
      }
      return true;
    }
    switch (name) {
      case "sst":
        return false;
      default:
        throw new Error(`Unexpected xml node in parseClose: ${name}`);
    }
  }
}

export { SharedStringsXform };
