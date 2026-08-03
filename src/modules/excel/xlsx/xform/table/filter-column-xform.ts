import { XlsxParseError } from "@excel/errors";
import { BaseXform } from "@excel/xlsx/xform/base-xform";
import { PreservedLeafXform, PreservedSubtreeXform } from "@excel/xlsx/xform/preserved-xml-xform";
import type { ParseOpenTag, XmlSink } from "@xml/types";

export interface FilterColumnModel {
  colId?: string;
  filterButton?: boolean;
  namespaceAttributes?: Record<string, string>;
  /**
   * Filter criteria captured as XML, in document order. `CT_FilterColumn` is a
   * choice of one criteria element plus an optional `<extLst>`, so this holds
   * at most two entries for a schema-valid file — but keeping it a list means a
   * file that carries more is reproduced as-is instead of being silently
   * truncated.
   */
  rawFilterXml?: string[];
}

/**
 * `<filterColumn>` — ECMA-376 §18.3.2.7. Carries the filter applied to one
 * column of a table's `<autoFilter>`.
 *
 * Every child element the spec allows is claimed here, and each one is
 * preserved as XML: the table model exposes only filter-button visibility, so
 * re-serialising the original markup is what keeps criteria this library does
 * not model (date groups, top 10, colour/icon/dynamic filters, extensions)
 * from being dropped on save. Anything outside the schema keeps throwing, so
 * genuinely malformed table parts are not silently accepted.
 */
class FilterColumnXform extends BaseXform<FilterColumnModel> {
  declare public map: { [key: string]: BaseXform };
  declare public parser?: BaseXform;

  constructor() {
    super();

    this.map = {
      customFilters: new PreservedSubtreeXform(),
      filters: new PreservedSubtreeXform(),
      "x14:customFilters": new PreservedSubtreeXform(),
      dynamicFilter: new PreservedLeafXform("dynamicFilter"),
      top10: new PreservedLeafXform("top10"),
      colorFilter: new PreservedLeafXform("colorFilter"),
      iconFilter: new PreservedLeafXform("iconFilter"),
      "x14:iconFilter": new PreservedSubtreeXform(),
      extLst: new PreservedSubtreeXform()
    };
    this.model = { filterButton: false };
  }

  get tag(): string {
    return "filterColumn";
  }

  prepare(model: FilterColumnModel, options: { index: number }): void {
    model.colId = options.index.toString();
  }

  render(xmlStream: XmlSink, model: FilterColumnModel): void {
    const attributes = {
      ...model.namespaceAttributes,
      colId: model.colId,
      hiddenButton: model.filterButton === undefined ? undefined : model.filterButton ? "0" : "1"
    };
    if (model.rawFilterXml?.length) {
      xmlStream.openNode(this.tag, attributes);
      model.rawFilterXml.forEach(xml => xmlStream.writeRaw(xml));
      xmlStream.closeNode();
      return;
    }
    xmlStream.leafNode(this.tag, attributes);
  }

  parseOpen(node: ParseOpenTag): boolean {
    if (this.parser) {
      this.parser.parseOpen(node);
      return true;
    }
    const { attributes } = node;
    switch (node.name) {
      case this.tag:
        // `AutoFilterXform` reuses one instance for every column, so the child
        // xforms must be cleared here — otherwise a column without criteria
        // inherits the previous column's captured filter XML.
        this.reset();
        {
          const namespaceAttributes = Object.fromEntries(
            Object.entries(attributes).filter(
              ([key]) => key.startsWith("xmlns:") || key === "mc:Ignorable"
            )
          );
          this.model = {
            colId: attributes.colId,
            // Both attributes are xsd:boolean and both hide the button:
            // `hiddenButton` defaults to false, `showButton` defaults to true.
            // They are folded into one visibility flag, so a file using
            // `showButton="0"` is written back as `hiddenButton="1"`. That keeps
            // the model honest about whether the button shows, at the cost of
            // normalising which attribute expresses it.
            filterButton:
              attributes.hiddenButton !== "1" &&
              attributes.hiddenButton !== "true" &&
              attributes.showButton !== "0" &&
              attributes.showButton !== "false",
            ...(Object.keys(namespaceAttributes).length > 0 ? { namespaceAttributes } : {})
          };
        }
        return true;
      default:
        this.parser = this.map[node.name];
        if (this.parser) {
          this.parseOpen(node);
          return true;
        }
        throw new XlsxParseError(
          "filterColumn",
          `Unexpected xml node in parseOpen: ${JSON.stringify(node)}`
        );
    }
  }

  parseText(text: string): void {
    this.parser?.parseText(text);
  }

  parseClose(name: string): boolean {
    if (this.parser) {
      const parser = this.parser;
      if (!parser.parseClose(name)) {
        this.model!.rawFilterXml ??= [];
        this.model!.rawFilterXml.push(parser.model as string);
        this.parser = undefined;
      }
      return true;
    }
    switch (name) {
      case this.tag:
        return false;
      default:
        // could be some unrecognised tags
        return true;
    }
  }
}

export { FilterColumnXform };
