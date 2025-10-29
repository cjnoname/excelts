import { colCache } from "../../../utils/col-cache.js";
import { XmlStream } from "../../../utils/xml-stream.js";
import { BaseXform } from "../base-xform.js";
import { StaticXform } from "../static-xform.js";
import { ListXform } from "../list-xform.js";
import { DefinedNamesXform } from "./defined-name-xform.js";
import { WorksheetXform } from "./sheet-xform.js";
import { WorkbookViewXform } from "./workbook-view-xform.js";
import { WorkbookPropertiesXform } from "./workbook-properties-xform.js";
import { WorkbookCalcPropertiesXform } from "./workbook-calc-properties-xform.js";
import { WorkbookPivotCacheXform } from "./workbook-pivot-cache-xform.js";

class WorkbookXform extends BaseXform {
  declare public parser: any;

  constructor() {
    super();

    this.map = {
      fileVersion: WorkbookXform.STATIC_XFORMS.fileVersion,
      workbookPr: new WorkbookPropertiesXform(),
      bookViews: new ListXform({
        tag: "bookViews",
        count: false,
        childXform: new WorkbookViewXform()
      }),
      sheets: new ListXform({ tag: "sheets", count: false, childXform: new WorksheetXform() }),
      definedNames: new ListXform({
        tag: "definedNames",
        count: false,
        childXform: new DefinedNamesXform()
      }),
      calcPr: new WorkbookCalcPropertiesXform(),
      pivotCaches: new ListXform({
        tag: "pivotCaches",
        count: false,
        childXform: new WorkbookPivotCacheXform()
      })
    };
  }

  prepare(model: any): void {
    model.sheets = model.worksheets;

    // collate all the print areas from all of the sheets and add them to the defined names
    const printAreas: any[] = [];
    let index = 0; // sheets is sparse array - calc index manually
    model.sheets.forEach((sheet: any) => {
      if (sheet.pageSetup && sheet.pageSetup.printArea) {
        sheet.pageSetup.printArea.split("&&").forEach((printArea: string) => {
          const printAreaComponents = printArea.split(":");
          const definedName = {
            name: "_xlnm.Print_Area",
            ranges: [`'${sheet.name}'!$${printAreaComponents[0]}:$${printAreaComponents[1]}`],
            localSheetId: index
          };
          printAreas.push(definedName);
        });
      }

      if (
        sheet.pageSetup &&
        (sheet.pageSetup.printTitlesRow || sheet.pageSetup.printTitlesColumn)
      ) {
        const ranges: string[] = [];

        if (sheet.pageSetup.printTitlesColumn) {
          const titlesColumns = sheet.pageSetup.printTitlesColumn.split(":");
          ranges.push(`'${sheet.name}'!$${titlesColumns[0]}:$${titlesColumns[1]}`);
        }

        if (sheet.pageSetup.printTitlesRow) {
          const titlesRows = sheet.pageSetup.printTitlesRow.split(":");
          ranges.push(`'${sheet.name}'!$${titlesRows[0]}:$${titlesRows[1]}`);
        }

        const definedName = {
          name: "_xlnm.Print_Titles",
          ranges,
          localSheetId: index
        };

        printAreas.push(definedName);
      }
      index++;
    });
    if (printAreas.length) {
      model.definedNames = model.definedNames.concat(printAreas);
    }

    (model.media || []).forEach((medium: any, i: number) => {
      // assign name
      medium.name = medium.type + (i + 1);
    });
  }

  render(xmlStream: any, model: any): void {
    xmlStream.openXml(XmlStream.StdDocAttributes);
    xmlStream.openNode("workbook", WorkbookXform.WORKBOOK_ATTRIBUTES);

    this.map.fileVersion.render(xmlStream);
    this.map.workbookPr.render(xmlStream, model.properties);
    this.map.bookViews.render(xmlStream, model.views);
    this.map.sheets.render(xmlStream, model.sheets);
    this.map.definedNames.render(xmlStream, model.definedNames);
    this.map.calcPr.render(xmlStream, model.calcProperties);
    this.map.pivotCaches.render(xmlStream, model.pivotTables);

    xmlStream.closeNode();
  }

  parseOpen(node: any): boolean {
    if (this.parser) {
      this.parser.parseOpen(node);
      return true;
    }
    switch (node.name) {
      case "workbook":
        return true;
      default:
        this.parser = this.map[node.name];
        if (this.parser) {
          this.parser.parseOpen(node);
        }
        return true;
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
      case "workbook":
        this.model = {
          sheets: this.map.sheets.model,
          properties: this.map.workbookPr.model || {},
          views: this.map.bookViews.model,
          calcProperties: {}
        };
        if (this.map.definedNames.model) {
          this.model.definedNames = this.map.definedNames.model;
        }

        return false;
      default:
        // not quite sure how we get here!
        return true;
    }
  }

  reconcile(model: any): void {
    const rels = (model.workbookRels || []).reduce((map: any, rel: any) => {
      map[rel.Id] = rel;
      return map;
    }, {});

    // reconcile sheet ids, rIds and names
    const worksheets: any[] = [];
    let worksheet: any;
    let index = 0;

    (model.sheets || []).forEach((sheet: any) => {
      const rel = rels[sheet.rId];
      if (!rel) {
        return;
      }
      // if rel.Target start with `[space]/xl/` or `/xl/` , then it will be replaced with `''` and spliced behind `xl/`,
      // otherwise it will be spliced directly behind `xl/`. i.g.
      worksheet = model.worksheetHash[`xl/${rel.Target.replace(/^(\s|\/xl\/)+/, "")}`];
      // If there are "chartsheets" in the file, rel.Target will
      // come out as chartsheets/sheet1.xml or similar here, and
      // that won't be in model.worksheetHash.
      // As we don't have the infrastructure to support chartsheets,
      // we will ignore them for now:
      if (worksheet) {
        worksheet.name = sheet.name;
        worksheet.id = sheet.id;
        worksheet.state = sheet.state;
        worksheets[index++] = worksheet;
      }
    });

    // reconcile print areas
    const definedNames: any[] = [];
    if (model.definedNames) {
      model.definedNames.forEach((definedName: any) => {
        if (definedName.name === "_xlnm.Print_Area") {
          worksheet = worksheets[definedName.localSheetId];
          if (worksheet) {
            if (!worksheet.pageSetup) {
              worksheet.pageSetup = {};
            }
            const range: any = colCache.decodeEx(definedName.ranges[0]);
            worksheet.pageSetup.printArea = worksheet.pageSetup.printArea
              ? `${worksheet.pageSetup.printArea}&&${range.dimensions}`
              : range.dimensions;
          }
        } else if (definedName.name === "_xlnm.Print_Titles") {
          worksheet = worksheets[definedName.localSheetId];
          if (worksheet) {
            if (!worksheet.pageSetup) {
              worksheet.pageSetup = {};
            }

            const rangeString = definedName.ranges.join(",");

            const dollarRegex = /\$/g;

            const rowRangeRegex = /\$\d+:\$\d+/;
            const rowRangeMatches = rangeString.match(rowRangeRegex);

            if (rowRangeMatches && rowRangeMatches.length) {
              const range = rowRangeMatches[0];
              worksheet.pageSetup.printTitlesRow = range.replace(dollarRegex, "");
            }

            const columnRangeRegex = /\$[A-Z]+:\$[A-Z]+/;
            const columnRangeMatches = rangeString.match(columnRangeRegex);

            if (columnRangeMatches && columnRangeMatches.length) {
              const range = columnRangeMatches[0];
              worksheet.pageSetup.printTitlesColumn = range.replace(dollarRegex, "");
            }
          }
        } else {
          definedNames.push(definedName);
        }
      });
    }
    model.definedNames = definedNames;

    // used by sheets to build their image models
    model.media.forEach((media: any, i: number) => {
      media.index = i;
    });
  }

  static WORKBOOK_ATTRIBUTES = {
    xmlns: "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
    "xmlns:r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "xmlns:mc": "http://schemas.openxmlformats.org/markup-compatibility/2006",
    "mc:Ignorable": "x15",
    "xmlns:x15": "http://schemas.microsoft.com/office/spreadsheetml/2010/11/main"
  };

  static STATIC_XFORMS = {
    fileVersion: new StaticXform({
      tag: "fileVersion",
      $: { appName: "xl", lastEdited: 5, lowestEdited: 5, rupBuild: 9303 }
    })
  };
}

export { WorkbookXform };
