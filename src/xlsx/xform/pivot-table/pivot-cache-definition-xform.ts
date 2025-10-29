import { BaseXform } from "../base-xform.js";
import { CacheField } from "./cache-field.js";
import { XmlStream } from "../../../utils/xml-stream.js";

interface CacheDefinitionModel {
  sourceSheet: any;
  cacheFields: any[];
}

class PivotCacheDefinitionXform extends BaseXform {
  declare public map: { [key: string]: any };

  constructor() {
    super();

    this.map = {};
  }

  prepare(_model: any): void {
    // TK
  }

  get tag(): string {
    // http://www.datypic.com/sc/ooxml/e-ssml_pivotCacheDefinition.html
    return "pivotCacheDefinition";
  }

  render(xmlStream: any, model: CacheDefinitionModel): void {
    const { sourceSheet, cacheFields } = model;

    xmlStream.openXml(XmlStream.StdDocAttributes);
    xmlStream.openNode(this.tag, {
      ...PivotCacheDefinitionXform.PIVOT_CACHE_DEFINITION_ATTRIBUTES,
      "r:id": "rId1",
      refreshOnLoad: "1", // important for our implementation to work
      refreshedBy: "Author",
      refreshedDate: "45125.026046874998",
      createdVersion: "8",
      refreshedVersion: "8",
      minRefreshableVersion: "3",
      recordCount: cacheFields.length + 1
    });

    xmlStream.openNode("cacheSource", { type: "worksheet" });
    xmlStream.leafNode("worksheetSource", {
      ref: sourceSheet.dimensions.shortRange,
      sheet: sourceSheet.name
    });
    xmlStream.closeNode();

    xmlStream.openNode("cacheFields", { count: cacheFields.length });
    // Note: keeping this pretty-printed for now to ease debugging.
    xmlStream.writeXml(
      cacheFields.map((cacheField: any) => new CacheField(cacheField).render()).join("\n    ")
    );
    xmlStream.closeNode();

    xmlStream.closeNode();
  }

  parseOpen(_node: any): boolean {
    // TK
    return false;
  }

  parseText(_text: string): void {
    // TK
  }

  parseClose(_name: string): boolean {
    // TK
    return false;
  }

  reconcile(_model: any, _options: any): void {
    // TK
  }

  static PIVOT_CACHE_DEFINITION_ATTRIBUTES = {
    xmlns: "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
    "xmlns:r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "xmlns:mc": "http://schemas.openxmlformats.org/markup-compatibility/2006",
    "mc:Ignorable": "xr",
    "xmlns:xr": "http://schemas.microsoft.com/office/spreadsheetml/2014/revision"
  };
}

export { PivotCacheDefinitionXform };
