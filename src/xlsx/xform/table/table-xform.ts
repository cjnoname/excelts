import { XmlStream } from "../../../utils/xml-stream.js";
import { BaseXform } from "../base-xform.js";
import { ListXform } from "../list-xform.js";
import { AutoFilterXform } from "./auto-filter-xform.js";
import { TableColumnXform } from "./table-column-xform.js";
import { TableStyleInfoXform } from "./table-style-info-xform.js";

interface TableModel {
  id?: number;
  name: string;
  displayName?: string;
  ref?: string;
  tableRef: string;
  totalsRow?: boolean;
  headerRow?: boolean;
  columns?: any[];
  rows?: any[];
  autoFilterRef?: string;
  style?: any;
}

class TableXform extends BaseXform {
  declare public map: { [key: string]: any };
  declare public parser: any;
  declare public model: TableModel;

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
      tableStyleInfo: new TableStyleInfoXform()
    };
    this.model = {
      id: 0,
      name: "",
      tableRef: "",
      columns: []
    };
  }

  prepare(model: TableModel, options: any): void {
    this.map.autoFilter.prepare(model);
    this.map.tableColumns.prepare(model.columns, options);
  }

  get tag(): string {
    return "table";
  }

  render(xmlStream: any, model: TableModel): void {
    xmlStream.openXml(XmlStream.StdDocAttributes);
    xmlStream.openNode(this.tag, {
      ...TableXform.TABLE_ATTRIBUTES,
      id: model.id,
      name: model.name,
      displayName: model.displayName || model.name,
      ref: model.tableRef,
      totalsRowCount: model.totalsRow ? "1" : undefined,
      totalsRowShown: model.totalsRow ? undefined : "1",
      headerRowCount: model.headerRow ? "1" : "0"
    });

    this.map.autoFilter.render(xmlStream, model);
    this.map.tableColumns.render(xmlStream, model.columns);
    this.map.tableStyleInfo.render(xmlStream, model.style);

    xmlStream.closeNode();
  }

  parseOpen(node: any): boolean {
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
          headerRow: attributes.headerRowCount === "1"
        };
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
        this.model.columns = this.map.tableColumns.model;
        if (this.map.autoFilter.model) {
          this.model.autoFilterRef = this.map.autoFilter.model.autoFilterRef;
          this.map.autoFilter.model.columns.forEach((column: any, index: number) => {
            this.model.columns[index].filterButton = column.filterButton;
          });
        }
        this.model.style = this.map.tableStyleInfo.model;
        return false;
      default:
        // could be some unrecognised tags
        return true;
    }
  }

  reconcile(model: TableModel, options: any): void {
    // Map tableRef to ref for Table constructor compatibility
    if (model.tableRef && !model.ref) {
      model.ref = model.tableRef;
    }
    // Add empty rows array if not present (tables loaded from file don't have row data)
    if (!model.rows) {
      model.rows = [];
    }
    // fetch the dfxs from styles
    model.columns.forEach(column => {
      if (column.dxfId !== undefined) {
        column.style = options.styles.getDxfStyle(column.dxfId);
      }
    });
  }

  static TABLE_ATTRIBUTES = {
    xmlns: "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
    "xmlns:mc": "http://schemas.openxmlformats.org/markup-compatibility/2006",
    "mc:Ignorable": "xr xr3",
    "xmlns:xr": "http://schemas.microsoft.com/office/spreadsheetml/2014/revision",
    "xmlns:xr3": "http://schemas.microsoft.com/office/spreadsheetml/2016/revision3"
    // 'xr:uid': '{00000000-000C-0000-FFFF-FFFF00000000}',
  };
}

export { TableXform };
