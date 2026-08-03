import type {
  CellFormulaValue,
  CellValue,
  Style,
  TableColumnProperties,
  TableStyleProperties
} from "@excel/types";
import { BaseXform } from "@excel/xlsx/xform/base-xform";
import { ListXform } from "@excel/xlsx/xform/list-xform";
import { PreservedSubtreeXform } from "@excel/xlsx/xform/preserved-xml-xform";
import { AutoFilterXform } from "@excel/xlsx/xform/table/auto-filter-xform";
import { TableColumnXform } from "@excel/xlsx/xform/table/table-column-xform";
import { TableStyleInfoXform } from "@excel/xlsx/xform/table/table-style-info-xform";
import type { ParseOpenTag, XmlSink } from "@xml/types";
import { StdDocAttributes } from "@xml/writer";

interface TableModel {
  id?: number;
  name: string;
  displayName?: string;
  ref?: string;
  tableRef: string;
  totalsRow?: boolean;
  headerRow?: boolean;
  columns?: TableColumnProperties[];
  rows?: Array<Array<CellValue | CellFormulaValue>>;
  autoFilterRef?: string;
  autoFilterNamespaceAttributes?: Record<string, string>;
  autoFilterSortStateXml?: string;
  autoFilterSortStateRef?: string;
  autoFilterExtLstXml?: string;
  style?: TableStyleProperties;
  /**
   * Safe root attributes the model does not interpret: namespace declarations,
   * `mc:Ignorable`, and independent table state such as `totalsRowShown`.
   */
  rawAttributes?: Record<string, string>;
  /**
   * The table's `<sortState>` block, preserved verbatim. It records the sort
   * the user last applied to the table, which Excel forgets if the element is
   * dropped on save.
   */
  sortStateXml?: string;
  sortStateAutoFilterRef?: string;
  /**
   * The table's `<extLst>` block, preserved verbatim. It carries features this
   * library does not model — alternative text, slicer links — which Excel drops
   * from the table if the element disappears.
   */
  extLstXml?: string;
}

interface LoadedTableColumnProperties extends TableColumnProperties {
  rawFilterXml?: string[];
  namespaceAttributes?: Record<string, string>;
}

/** Root attributes `TableXform` derives from the model rather than preserving. */
const MODELLED_TABLE_ATTRIBUTES = new Set([
  "xmlns",
  "id",
  "name",
  "displayName",
  "ref",
  "totalsRowCount",
  "headerRowCount"
]);

/**
 * Safe root attributes to preserve without modelling external dependencies.
 * Reference-bearing attributes such as connectionId and *DxfId are excluded:
 * their target parts or styles may not survive the workbook round trip.
 */
function shouldPreserveTableAttribute(name: string): boolean {
  return name.startsWith("xmlns:") || name === "mc:Ignorable" || name === "totalsRowShown";
}

interface TableXformOptions {
  styles?: {
    getDxfStyle(id: number): Partial<Style> | undefined;
  };
}

class TableXform extends BaseXform<TableModel> {
  declare public map: Record<string, BaseXform>;
  declare public parser?: BaseXform;

  constructor() {
    super();

    this.map = {
      autoFilter: new AutoFilterXform(),
      tableColumns: new ListXform({
        tag: "tableColumns",
        count: true,
        empty: true,
        childXform: new TableColumnXform()
      }),
      sortState: new PreservedSubtreeXform(),
      tableStyleInfo: new TableStyleInfoXform(),
      extLst: new PreservedSubtreeXform()
    };
    this.model = {
      id: 0,
      name: "",
      tableRef: "",
      columns: []
    };
  }

  prepare(model: TableModel, options: TableXformOptions): void {
    this.map.autoFilter.prepare(model);
    this.map.tableColumns.prepare(model.columns, options);
  }

  get tag(): string {
    return "table";
  }

  render(xmlStream: XmlSink, model: TableModel): void {
    xmlStream.openXml(StdDocAttributes);
    xmlStream.openNode(this.tag, {
      ...TableXform.TABLE_ATTRIBUTES,
      // Preserved namespace declarations must precede the markup that uses
      // them, and must not override the attributes the model owns.
      ...model.rawAttributes,
      id: model.id,
      name: model.name,
      displayName: model.displayName || model.name,
      ref: model.tableRef,
      totalsRowCount: model.totalsRow ? "1" : undefined,
      // Excel doesn't output headerRowCount when it's 1 (default) or when there's a header row
      headerRowCount: model.headerRow ? undefined : "0"
    });

    this.map.autoFilter.render(xmlStream, model);
    if (model.sortStateXml && model.sortStateAutoFilterRef === model.autoFilterRef) {
      xmlStream.writeRaw(model.sortStateXml);
    }
    this.map.tableColumns.render(xmlStream, model.columns);
    this.map.tableStyleInfo.render(xmlStream, model.style);
    if (model.extLstXml) {
      xmlStream.writeRaw(model.extLstXml);
    }

    xmlStream.closeNode();
  }

  parseOpen(node: ParseOpenTag): boolean {
    if (this.parser) {
      this.parser.parseOpen(node);
      return true;
    }
    const { name, attributes } = node;
    switch (name) {
      case this.tag:
        this.reset();
        this.model = {
          name: attributes.name,
          displayName: attributes.displayName || attributes.name,
          tableRef: attributes.ref,
          totalsRow: attributes.totalsRowCount === "1",
          // ECMA-376: headerRowCount defaults to 1, so missing attribute means has header
          headerRow: attributes.headerRowCount !== "0"
        };
        {
          const rawAttributes: Record<string, string> = {};
          for (const key in attributes) {
            if (!MODELLED_TABLE_ATTRIBUTES.has(key) && shouldPreserveTableAttribute(key)) {
              rawAttributes[key] = attributes[key];
            }
          }
          if (Object.keys(rawAttributes).length > 0) {
            this.model.rawAttributes = rawAttributes;
          }
        }
        break;
      default:
        this.parser = this.map[node.name];
        if (this.parser) {
          this.parser.parseOpen(node);
        }
        break;
    }
    return true;
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
      case this.tag:
        this.model!.columns = this.map!.tableColumns.model as LoadedTableColumnProperties[];
        {
          const autoFilterModel = this.map!.autoFilter.model as
            | {
                autoFilterRef?: string;
                autoFilterNamespaceAttributes?: Record<string, string>;
                autoFilterSortStateXml?: string;
                autoFilterSortStateRef?: string;
                autoFilterExtLstXml?: string;
                columns: Array<{
                  colId?: string;
                  filterButton?: boolean;
                  rawFilterXml?: string[];
                  namespaceAttributes?: Record<string, string>;
                }>;
              }
            | undefined;
          if (autoFilterModel) {
            this.model!.autoFilterRef = autoFilterModel.autoFilterRef;
            this.model!.autoFilterNamespaceAttributes =
              autoFilterModel.autoFilterNamespaceAttributes;
            this.model!.autoFilterSortStateXml = autoFilterModel.autoFilterSortStateXml;
            this.model!.autoFilterSortStateRef = autoFilterModel.autoFilterSortStateRef;
            this.model!.autoFilterExtLstXml = autoFilterModel.autoFilterExtLstXml;
            autoFilterModel.columns.forEach((column, position) => {
              // `colId` is the authoritative column index: Excel omits
              // `<filterColumn>` for columns without criteria, so trusting
              // document position would apply a filter to the wrong column.
              // Fall back to the position only when `colId` is unusable.
              const colId = Number(column.colId);
              const index = Number.isInteger(colId) && colId >= 0 ? colId : position;
              const target = this.model!.columns![index] as LoadedTableColumnProperties | undefined;
              if (!target) {
                return;
              }
              target.filterButton = column.filterButton;
              target.rawFilterXml = column.rawFilterXml;
              target.namespaceAttributes = column.namespaceAttributes;
            });
          }
        }
        this.model!.style = this.map!.tableStyleInfo.model as TableStyleProperties;
        this.model!.sortStateXml = this.map!.sortState.model as string | undefined;
        if (this.model!.sortStateXml) {
          this.model!.sortStateAutoFilterRef = this.model!.autoFilterRef;
        }
        this.model!.extLstXml = this.map!.extLst.model as string | undefined;
        return false;
      default:
        // could be some unrecognised tags
        return true;
    }
  }

  reconcile(model: TableModel, options: TableXformOptions): void {
    // Map tableRef to ref for Table constructor compatibility
    if (model.tableRef && !model.ref) {
      model.ref = model.tableRef;
    }
    // Add empty rows array if not present (tables loaded from file don't have row data)
    if (!model.rows) {
      model.rows = [];
    }
    // fetch the dfxs from styles
    const styles = options.styles;
    if (styles) {
      model.columns!.forEach(columnModel => {
        // dxfId is a transient (de)serialisation field carried on the column.
        const column = columnModel as TableColumnProperties & { dxfId?: number };
        if (column.dxfId !== undefined) {
          column.style = styles.getDxfStyle(column.dxfId);
        }
      });
    }
  }

  static TABLE_ATTRIBUTES = {
    xmlns: "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
  };
}

export { TableXform };
