import { fix } from "./tools.js";
import { Row } from "../../doc/row.js";
import { Column } from "../../doc/column.js";
import { testWorkbookReader } from "./test-workbook-reader.js";
import { dataValidations } from "./test-data-validation-sheet.js";
import { conditionalFormatting } from "./test-conditional-formatting-sheet.js";
import { values } from "./test-values-sheet.js";
import { splice } from "./test-spliced-sheet.js";
import views from "./data/views.json" with { type: "json" };
import testValues from "./data/sheet-values.json" with { type: "json" };
import styles from "./data/styles.json" with { type: "json" };
import properties from "./data/sheet-properties.json" with { type: "json" };
import pageSetup from "./data/page-setup.json" with { type: "json" };
import conditionalFormattingData from "./data/conditional-formatting.json" with { type: "json" };
import headerFooter from "./data/header-footer.json" with { type: "json" };
import { expect } from "vitest";
import { get } from "../../utils/under-dash.js";

const testSheets = {
  dataValidations,
  conditionalFormatting,
  values,
  splice
};

function getOptions(docType, options?) {
  let result;
  switch (docType) {
    case "xlsx":
      result = {
        sheetName: "values",
        checkFormulas: true,
        checkMerges: true,
        checkStyles: true,
        checkBadAlignments: true,
        checkSheetProperties: true,
        dateAccuracy: 3,
        checkViews: true
      };
      break;
    case "csv":
      result = {
        sheetName: "sheet1",
        checkFormulas: false,
        checkMerges: false,
        checkStyles: false,
        checkBadAlignments: false,
        checkSheetProperties: false,
        dateAccuracy: 1000,
        checkViews: false
      };
      break;
    default:
      throw new Error(`Bad doc-type: ${docType}`);
  }
  return Object.assign(result, options);
}

const testUtils = {
  views: fix(views),
  testValues: fix(testValues),
  styles: fix(styles),
  properties: fix(properties),
  pageSetup: fix(pageSetup),
  conditionalFormatting: fix(conditionalFormattingData),
  headerFooter: fix(headerFooter),

  createTestBook(workbook: any, docType?: string, sheets?: string[]) {
    const options = getOptions(docType);
    sheets = sheets || ["values"];

    workbook.views = [{ x: 1, y: 2, width: 10000, height: 20000, firstSheet: 0, activeTab: 0 }];

    sheets.forEach(sheet => {
      const testSheet = get(testSheets, sheet);
      testSheet.addSheet(workbook, options);
    });

    return workbook;
  },

  checkTestBook(workbook: any, docType?: string, sheets?: string[], options?: any) {
    options = getOptions(docType, options);
    sheets = sheets || ["values"];

    expect(workbook).toBeDefined();

    if (options.checkViews) {
      expect(workbook.views).toEqual([
        {
          x: 1,
          y: 2,
          width: 10000,
          height: 20000,
          firstSheet: 0,
          activeTab: 0,
          visibility: "visible"
        }
      ]);
    }

    sheets.forEach(sheet => {
      const testSheet = get(testSheets, sheet);
      testSheet.checkSheet(workbook, options);
    });
  },

  checkTestBookReader: testWorkbookReader.checkBook,

  createSheetMock(): any {
    return {
      _keys: {} as Record<string, any>,
      _cells: {} as Record<string, any>,
      rows: [] as any[],
      columns: [] as any[],
      properties: {
        outlineLevelCol: 0,
        outlineLevelRow: 0
      },

      addColumn(colNumber: number, defn?: any) {
        const newColumn = new Column(this, colNumber, defn);
        this.columns[colNumber - 1] = newColumn;
        return newColumn;
      },
      getColumn(colNumber: number | string) {
        let column = this.columns[(colNumber as number) - 1] || this._keys[colNumber];
        if (!column) {
          column = this.columns[(colNumber as number) - 1] = new Column(this, colNumber as number);
        }
        return column;
      },
      getRow(rowNumber: number) {
        let row = this.rows[rowNumber - 1];
        if (!row) {
          row = this.rows[rowNumber - 1] = new Row(this, rowNumber);
        }
        return row;
      },
      getCell(rowNumber: number, colNumber: number) {
        return this.getRow(rowNumber).getCell(colNumber);
      },
      getColumnKey(key: string) {
        return this._keys[key];
      },
      setColumnKey(key: string, value: any) {
        this._keys[key] = value;
      },
      deleteColumnKey(key: string) {
        delete this._keys[key];
      },
      eachColumnKey(f: (column: any, key: string) => void) {
        Object.entries(this._keys).forEach(([key, value]) => f(value, key));
      },
      eachRow(opt: any, f?: (row: any, index: number) => void) {
        if (!f) {
          f = opt;
          opt = {};
        }
        if (opt && opt.includeEmpty) {
          const n = this.rows.length;
          for (let i = 1; i <= n; i++) {
            f!(this.getRow(i), i);
          }
        } else {
          this.rows.forEach((r: any, i: number) => {
            if (r) {
              f!(r, i + 1);
            }
          });
        }
      }
    };
  }
};

export { testUtils };
