import { XlsxParseError } from "@excel/errors";
import { BaseXform } from "@excel/xlsx/xform/base-xform";
import { PreservedSubtreeXform } from "@excel/xlsx/xform/preserved-xml-xform";
import { FilterColumnXform } from "@excel/xlsx/xform/table/filter-column-xform";
import type { FilterColumnModel } from "@excel/xlsx/xform/table/filter-column-xform";
import type { ParseOpenTag, XmlSink } from "@xml/types";

interface AutoFilterModel {
  autoFilterRef: string;
  columns: FilterColumnModel[];
  autoFilterSortStateXml?: string;
  autoFilterSortStateRef?: string;
  autoFilterExtLstXml?: string;
  autoFilterNamespaceAttributes?: Record<string, string>;
}

class AutoFilterXform extends BaseXform<AutoFilterModel> {
  declare public map: Record<string, BaseXform>;
  declare public parser?: BaseXform;

  constructor() {
    super();

    this.map = {
      filterColumn: new FilterColumnXform(),
      sortState: new PreservedSubtreeXform(),
      extLst: new PreservedSubtreeXform()
    };
    this.model = { autoFilterRef: "", columns: [] };
  }

  get tag(): string {
    return "autoFilter";
  }

  prepare(model: AutoFilterModel): void {
    model.columns.forEach((column, index) => {
      this.map.filterColumn.prepare(column, { index });
    });
  }

  render(xmlStream: XmlSink, model: AutoFilterModel): void {
    xmlStream.openNode(this.tag, {
      ...model.autoFilterNamespaceAttributes,
      ref: model.autoFilterRef
    });

    // Only emit `<filterColumn>` for columns that carry actual filter
    // state. Real Excel only emits the child when a filter is applied
    // (any of the `CT_FilterColumn` criteria, preserved here as
    // `rawFilterXml`) or when the author explicitly set the filter-button
    // visibility (either `filterButton: true` or `filterButton: false`).
    // Columns that never touched `filterButton` (i.e. `undefined`) default
    // to Excel's "show button" behaviour and should emit nothing —
    // emitting an empty `<filterColumn hiddenButton="1"/>` for
    // every such column makes Excel reject the table with
    // "Removed Records: Table from /xl/tables/tableN.xml".
    model.columns.forEach(column => {
      if (column?.rawFilterXml?.length || column?.filterButton !== undefined) {
        this.map.filterColumn.render(xmlStream, column);
      }
    });
    if (model.autoFilterSortStateXml && model.autoFilterSortStateRef === model.autoFilterRef) {
      xmlStream.writeRaw(model.autoFilterSortStateXml);
    }
    if (model.autoFilterExtLstXml) {
      xmlStream.writeRaw(model.autoFilterExtLstXml);
    }

    xmlStream.closeNode();
  }

  parseOpen(node: ParseOpenTag): boolean {
    if (this.parser) {
      this.parser.parseOpen(node);
      return true;
    }
    switch (node.name) {
      case this.tag:
        {
          const autoFilterNamespaceAttributes = Object.fromEntries(
            Object.entries(node.attributes).filter(
              ([key]) => key.startsWith("xmlns:") || key === "mc:Ignorable"
            )
          );
          this.model = {
            autoFilterRef: node.attributes.ref,
            columns: [],
            ...(Object.keys(autoFilterNamespaceAttributes).length > 0
              ? { autoFilterNamespaceAttributes }
              : {})
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
          "autoFilter",
          `Unexpected xml node in parseOpen: ${JSON.stringify(node)}`
        );
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
        if (this.parser instanceof FilterColumnXform) {
          this.model!.columns.push(this.parser.model!);
        } else if (name === "sortState") {
          this.model!.autoFilterSortStateXml = this.parser.model as string;
          this.model!.autoFilterSortStateRef = this.model!.autoFilterRef;
        } else {
          this.model!.autoFilterExtLstXml = this.parser.model as string;
        }
        this.parser = undefined;
      }
      return true;
    }
    switch (name) {
      case this.tag:
        return false;
      default:
        throw new XlsxParseError("autoFilter", `Unexpected xml node in parseClose: ${name}`);
    }
  }
}

export { AutoFilterXform };
