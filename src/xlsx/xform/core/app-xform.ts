import { XmlStream } from "../../../utils/xml-stream.js";
import { BaseXform } from "../base-xform.js";
import { StringXform } from "../simple/string-xform.js";
import { AppHeadingPairsXform } from "./app-heading-pairs-xform.js";
import { AppTitlesOfPartsXform } from "./app-titles-of-parts-xform.js";

interface AppModel {
  worksheets: any[];
  company?: string;
  manager?: string;
}

class AppXform extends BaseXform {
  declare public map: { [key: string]: any };
  declare public parser: any;

  constructor() {
    super();

    this.map = {
      Company: new StringXform({ tag: "Company" }),
      Manager: new StringXform({ tag: "Manager" }),
      HeadingPairs: new AppHeadingPairsXform(),
      TitleOfParts: new AppTitlesOfPartsXform()
    };
  }

  render(xmlStream: any, model: AppModel): void {
    xmlStream.openXml(XmlStream.StdDocAttributes);

    xmlStream.openNode("Properties", AppXform.PROPERTY_ATTRIBUTES);

    xmlStream.leafNode("Application", undefined, "Microsoft Excel");
    xmlStream.leafNode("DocSecurity", undefined, "0");
    xmlStream.leafNode("ScaleCrop", undefined, "false");

    this.map.HeadingPairs.render(xmlStream, model.worksheets);
    this.map.TitleOfParts.render(xmlStream, model.worksheets);
    this.map.Company.render(xmlStream, model.company || "");
    this.map.Manager.render(xmlStream, model.manager);

    xmlStream.leafNode("LinksUpToDate", undefined, "false");
    xmlStream.leafNode("SharedDoc", undefined, "false");
    xmlStream.leafNode("HyperlinksChanged", undefined, "false");
    xmlStream.leafNode("AppVersion", undefined, "16.0300");

    xmlStream.closeNode();
  }

  parseOpen(node: any): boolean {
    if (this.parser) {
      this.parser.parseOpen(node);
      return true;
    }
    switch (node.name) {
      case "Properties":
        return true;
      default:
        this.parser = this.map[node.name];
        if (this.parser) {
          this.parser.parseOpen(node);
          return true;
        }

        // there's a lot we don't bother to parse
        return false;
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
        this.parser = undefined;
      }
      return true;
    }
    switch (name) {
      case "Properties":
        this.model = {
          worksheets: this.map.TitleOfParts.model,
          company: this.map.Company.model,
          manager: this.map.Manager.model
        };
        return false;
      default:
        return true;
    }
  }

  static DateFormat = function (dt: Date): string {
    return dt.toISOString().replace(/[.]\d{3,6}/, "");
  };

  static DateAttrs = { "xsi:type": "dcterms:W3CDTF" };

  static PROPERTY_ATTRIBUTES = {
    xmlns: "http://schemas.openxmlformats.org/officeDocument/2006/extended-properties",
    "xmlns:vt": "http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"
  };
}

export { AppXform };
