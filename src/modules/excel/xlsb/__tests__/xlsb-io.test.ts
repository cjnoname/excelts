import { ZipParser } from "@archive/unzip/zip-parser";
import { ZipArchive } from "@archive/zip/zip-archive";
import { Cell, Column, DefinedNames, Row, Table, Workbook, Worksheet, Xlsb } from "@excel";
import { colCache } from "@excel/utils/col-cache";
import {
  createBinaryWriter,
  finishBinaryWriter,
  iterateBiffRecords,
  writeRecord
} from "@excel/xlsb/binary";
import { XlsbRecordType } from "@excel/xlsb/record-types";
import { theme1Xml } from "@excel/xlsx/xml/theme1";
import { describe, expect, it } from "vitest";

describe("XLSB IO", () => {
  it("round-trips scalar cells, dates, number formats, sheet state, dimensions and merges", async () => {
    const source = Workbook.create();
    source.creator = "documonster test";
    const sheet = Workbook.addWorksheet(source, "Data", { autoFilter: "A1:B2" });
    Cell.setValue(sheet, "A1", "name");
    Cell.setValue(sheet, "B1", "value");
    Cell.setValue(sheet, "A2", "alpha");
    Cell.setValue(sheet, "B2", 42.25);
    Cell.setNumFmt(sheet, "B2", "0.00");
    Cell.setValue(sheet, "C2", true);
    Cell.setValue(sheet, "D2", new Date("2025-01-02T00:00:00.000Z"));
    Worksheet.merge(sheet, "A4:D4");
    Cell.setValue(sheet, "A4", "merged");
    Row.setHeight(sheet, 2, 24);
    Row.setHidden(sheet, 3, true);
    Column.setWidth(sheet, "A", 18);

    const hidden = Workbook.addWorksheet(source, "Hidden", { state: "hidden" });
    Cell.setValue(hidden, "A1", "secret");

    const bytes = await Xlsb.toBuffer(source, { zip: { reproducible: true } });
    expect([...bytes.subarray(0, 2)]).toEqual([0x50, 0x4b]);

    const target = Workbook.create();
    await Xlsb.read(target, bytes);
    const data = Workbook.getWorksheet(target, "Data")!;
    const hiddenResult = Workbook.getWorksheet(target, "Hidden")!;

    expect(Cell.getValue(data, "A1")).toBe("name");
    expect(Cell.getValue(data, "B2")).toBe(42.25);
    expect(Cell.getNumFmt(data, "B2")).toBe("0.00");
    expect(Cell.getValue(data, "C2")).toBe(true);
    expect((Cell.getValue(data, "D2") as Date).toISOString()).toBe("2025-01-02T00:00:00.000Z");
    expect(Worksheet.mergedRegions(data)).toEqual([{ top: 4, left: 1, bottom: 4, right: 4 }]);
    expect(Row.getHeight(data, 2)).toBe(24);
    expect(Row.getHidden(data, 3)).toBe(true);
    expect(Column.getWidth(data, "A")).toBe(18);
    expect(Worksheet.getModel(data).autoFilter).toBe("A1:B2");
    expect(Worksheet.getModel(hiddenResult).state).toBe("hidden");
    await expect(Xlsb.toBuffer(target, { zip: { reproducible: true } })).resolves.toBeInstanceOf(
      Uint8Array
    );
  });

  it("round-trips worksheet AutoFilter criteria through BIFF12 records", async () => {
    const workbook = Workbook.create();
    const sheet = Workbook.addWorksheet(workbook, "Filters", { autoFilter: "A1:G4" });
    const model = Worksheet.getModel(sheet);
    model.autoFilterCriteria = {
      ref: "A1:G4",
      xml:
        '<filterColumn colId="0"><filters blank="1"><filter val="North"/><dateGroupItem year="2025" month="8" dateTimeGrouping="month"/></filters></filterColumn>' +
        '<filterColumn colId="1"><customFilters and="1"><customFilter operator="greaterThan" val="70"/><customFilter operator="lessThanOrEqual" val="100"/></customFilters></filterColumn>' +
        '<filterColumn colId="2"><dynamicFilter type="aboveAverage"/></filterColumn>' +
        '<filterColumn colId="3"><top10 top="1" percent="0" val="10" filterVal="42"/></filterColumn>' +
        '<filterColumn colId="5"><iconFilter iconSet="3TrafficLights1" iconId="0"/></filterColumn>' +
        '<filterColumn colId="6" hiddenButton="1"/>'
    };
    Worksheet.setModel(sheet, model);

    const bytes = await Xlsb.toBuffer(workbook, { zip: { reproducible: true } });
    const target = Workbook.create();
    await Xlsb.read(target, bytes);
    const result = Worksheet.getModel(Workbook.getWorksheet(target, "Filters")!);

    expect(result.autoFilter).toBe("A1:G4");
    expect(result.autoFilterCriteria).toEqual({
      ref: "A1:G4",
      xml:
        '<filterColumn colId="0"><filters blank="1"><filter val="North"/><dateGroupItem year="2025" month="8" dateTimeGrouping="month"/></filters></filterColumn>' +
        '<filterColumn colId="1"><customFilters and="1"><customFilter operator="greaterThan" val="70"/><customFilter operator="lessThanOrEqual" val="100"/></customFilters></filterColumn>' +
        '<filterColumn colId="2"><dynamicFilter type="aboveAverage"/></filterColumn>' +
        '<filterColumn colId="3"><top10 top="1" percent="0" val="10" filterVal="42"/></filterColumn>' +
        '<filterColumn colId="5"><iconFilter iconSet="3TrafficLights1" iconId="0"/></filterColumn>' +
        '<filterColumn colId="6" hiddenButton="1"/>'
    });
    await expect(Xlsb.toBuffer(target, { zip: { reproducible: true } })).resolves.toBeInstanceOf(
      Uint8Array
    );
  });

  it("rejects color filters without DXF records and keeps lossy output structurally valid", async () => {
    const workbook = Workbook.create();
    const sheet = Workbook.addWorksheet(workbook, "Color filter", { autoFilter: "A1:A2" });
    const model = Worksheet.getModel(sheet);
    model.autoFilterCriteria = {
      ref: "A1:A2",
      xml: '<filterColumn colId="0"><colorFilter dxfId="0" cellColor="1"/></filterColumn>'
    };
    Worksheet.setModel(sheet, model);

    await expect(Xlsb.toBuffer(workbook)).rejects.toThrow("differential style");
    const bytes = await Xlsb.toBuffer(workbook, {
      unsupported: "ignore",
      zip: { reproducible: true }
    });
    const loaded = Workbook.create();
    await Xlsb.read(loaded, bytes);
    expect(Worksheet.getModel(Workbook.getWorksheet(loaded, "Color filter")!)).toMatchObject({
      autoFilter: "A1:A2",
      autoFilterCriteria: undefined
    });
  });

  it("round-trips rich shared strings and rich hyperlink display text", async () => {
    const workbook = Workbook.create();
    const sheet = Workbook.addWorksheet(workbook, "Rich text");
    const richText = [
      { text: "Bold", font: { name: "Arial", bold: true, color: { argb: "FFFF0000" } } },
      { text: " and " },
      { text: "italic", font: { name: "Arial", italic: true } }
    ];
    Cell.setValue(sheet, "A1", { richText });
    Cell.setValue(sheet, "A2", {
      richText,
      hyperlink: "https://example.com/rich",
      tooltip: "formatted link"
    });

    const bytes = await Xlsb.toBuffer(workbook, { zip: { reproducible: true } });
    const target = Workbook.create();
    await Xlsb.read(target, bytes);
    const result = Workbook.getWorksheet(target, "Rich text")!;

    expect(Cell.getValue(result, "A1")).toMatchObject({ richText });
    expect(Cell.getValue(result, "A2")).toMatchObject({
      text: "Bold and italic",
      richText,
      hyperlink: "https://example.com/rich",
      tooltip: "formatted link"
    });
  });

  it("preserves a custom workbook theme across an edited XLSB round-trip", async () => {
    const workbook = Workbook.create();
    const sheet = Workbook.addWorksheet(workbook, "Theme");
    Cell.setValue(sheet, "A1", "before");
    const model = Workbook.getModel(workbook);
    const customTheme = theme1Xml.replace("Office Theme", "Documonster Theme");
    model.themes = { theme1: customTheme };
    Workbook.setModel(workbook, model);

    const firstBytes = await Xlsb.toBuffer(workbook, { zip: { reproducible: true } });
    const loaded = Workbook.create();
    await Xlsb.read(loaded, firstBytes);
    Cell.setValue(Workbook.getWorksheet(loaded, "Theme")!, "A1", "after");
    const secondBytes = await Xlsb.toBuffer(loaded, { zip: { reproducible: true } });
    const files = await new ZipParser(secondBytes).extractAll();

    expect(new TextDecoder().decode(files.get("xl/theme/theme1.xml"))).toBe(customTheme);
  });

  it("round-trips workbook calculation properties", async () => {
    const workbook = Workbook.create();
    Workbook.addWorksheet(workbook, "Calculation");
    workbook.calcProperties = {
      fullCalcOnLoad: true,
      iterate: true,
      iterateCount: 250,
      iterateDelta: 0.0001
    };

    const bytes = await Xlsb.toBuffer(workbook, { zip: { reproducible: true } });
    const loaded = Workbook.create();
    await Xlsb.read(loaded, bytes);

    expect(loaded.calcProperties).toEqual({
      fullCalcOnLoad: true,
      iterate: true,
      iterateCount: 250,
      iterateDelta: 0.0001
    });
  });

  it("round-trips extended workbook properties", async () => {
    const workbook = Workbook.create();
    Workbook.addWorksheet(workbook, "Properties");
    workbook.company = "Documonster & Co.";
    workbook.manager = "Ada <Lovelace>";

    const bytes = await Xlsb.toBuffer(workbook, { zip: { reproducible: true } });
    const loaded = Workbook.create();
    await Xlsb.read(loaded, bytes);

    expect(loaded.company).toBe("Documonster & Co.");
    expect(loaded.manager).toBe("Ada <Lovelace>");
  });

  it("uses the canonical Workbook IO surface with XLSB format selection and autodetection", async () => {
    const source = Workbook.create();
    Cell.setValue(Workbook.addWorksheet(source, "Data"), "A1", "canonical");
    source.views = [
      {
        x: 100,
        y: 200,
        width: 12_000,
        height: 8_000,
        firstSheet: 0,
        activeTab: 0,
        visibility: "visible"
      }
    ];

    const bytes = await Workbook.toBuffer(source, {
      format: "xlsb",
      zip: { reproducible: true }
    });
    const target = Workbook.create();
    await Workbook.read(target, bytes);

    expect(Cell.getValue(Workbook.getWorksheet(target, "Data")!, "A1")).toBe("canonical");
    expect(Workbook.getModel(target).views).toEqual(source.views);
  });

  it("resolves OPC part names case-insensitively", async () => {
    const source = Workbook.create();
    source.company = "Case-folded company";
    source.manager = "Case-folded manager";
    Cell.setValue(Workbook.addWorksheet(source, "Data"), "A1", "case-sensitive ZIP entry");
    const generated = await Xlsb.toBuffer(source, { zip: { reproducible: true } });
    const files = await new ZipParser(generated).extractAll();
    const archive = new ZipArchive({ reproducible: true });
    const renamedParts = new Map([
      ["xl/workbook.bin", "XL/WORKBOOK.BIN"],
      ["xl/_rels/workbook.bin.rels", "XL/_RELS/WORKBOOK.BIN.RELS"],
      ["xl/sharedStrings.bin", "XL/SHAREDSTRINGS.BIN"],
      ["xl/styles.bin", "XL/STYLES.BIN"],
      ["docProps/core.xml", "DOCPROPS/CORE.XML"],
      ["docProps/app.xml", "DOCPROPS/APP.XML"],
      ["xl/theme/theme1.xml", "XL/THEME/THEME1.XML"]
    ]);
    for (const [path, data] of files) {
      archive.add(renamedParts.get(path) ?? path, data);
    }

    const target = Workbook.create();
    await Workbook.read(target, await archive.bytes());
    expect(target.company).toBe("Case-folded company");
    expect(target.manager).toBe("Case-folded manager");
    expect(Cell.getValue(Workbook.getWorksheet(target, "Data")!, "A1")).toBe(
      "case-sensitive ZIP entry"
    );
    Cell.setValue(Workbook.getWorksheet(target, "Data")!, "A2", "edited");
    await expect(Xlsb.toBuffer(target)).resolves.toBeInstanceOf(Uint8Array);
  });

  it("byte-preserves an unchanged loaded XLSB and protects opaque parts after edits", async () => {
    const source = Workbook.create();
    Cell.setValue(Workbook.addWorksheet(source, "Data"), "A1", "original");
    const generated = await Xlsb.toBuffer(source, { zip: { reproducible: true } });
    const files = await new ZipParser(generated).extractAll();
    const archive = new ZipArchive({ reproducible: true });
    for (const [path, data] of files) {
      archive.add(path, data);
    }
    archive.add("xl/custom/opaque.bin", Uint8Array.of(1, 2, 3, 4));
    const original = await archive.bytes();

    const loaded = Workbook.create();
    await Xlsb.read(loaded, original);
    expect([...(await Xlsb.toBuffer(loaded))]).toEqual([...original]);

    Cell.setValue(Workbook.getWorksheet(loaded, "Data")!, "A1", "edited");
    await expect(Xlsb.toBuffer(loaded)).rejects.toThrow("xl/custom/opaque.bin");
  });

  it("byte-preserves unknown BIFF12 records and rejects lossy edits by default", async () => {
    const source = Workbook.create();
    const sheet = Workbook.addWorksheet(source, "Data");
    Cell.setValue(sheet, "A1", "original");
    const generated = await Xlsb.toBuffer(source, { zip: { reproducible: true } });
    const files = await new ZipParser(generated).extractAll();
    const styles = files.get("xl/styles.bin")!;
    const writer = createBinaryWriter();
    for (const record of iterateBiffRecords(styles, "test styles")) {
      if (record.type === XlsbRecordType.EndStyleSheet) {
        writeRecord(writer, 0x3ffe, Uint8Array.of(1, 2, 3));
      }
      writeRecord(writer, record.type, record.data);
    }
    files.set("xl/styles.bin", finishBinaryWriter(writer));
    const archive = new ZipArchive({ reproducible: true });
    for (const [path, data] of files) {
      archive.add(path, data);
    }
    const original = await archive.bytes();

    const loaded = Workbook.create();
    await Xlsb.read(loaded, original);
    expect([...(await Xlsb.toBuffer(loaded))]).toEqual([...original]);

    Cell.setValue(Workbook.getWorksheet(loaded, "Data")!, "A1", "edited");
    await expect(Xlsb.toBuffer(loaded)).rejects.toThrow("xl/styles.bin#16382 (0x3FFE)");
  });

  it("round-trips BIFF12 formula tokens and cached result types", async () => {
    const workbook = Workbook.create();
    const sheet = Workbook.addWorksheet(workbook, "Formula");
    Cell.setValue(sheet, "A1", 2);
    Cell.setValue(sheet, "B1", 3);
    Cell.setValue(sheet, "C1", { formula: "A1+B1*2", result: 8 });
    Cell.setValue(sheet, "D1", { formula: "SUM($A$1:B1)+ROUND(1.25,1)", result: 6.3 });
    Cell.setValue(sheet, "E1", { formula: '"xls"&"b"', result: "xlsb" });
    Cell.setValue(sheet, "F1", { formula: "A1>B1", result: false });
    Cell.setValue(sheet, "G1", { formula: "DCOUNT(A1:B1,A1,A1:B1)", result: 1 });
    Cell.setValue(sheet, "H1", { formula: "SINH(A1)", result: Math.sinh(2) });
    Cell.setValue(sheet, "I1", { formula: "WEEKDAY(A1,2)", result: 2 });
    Cell.setValue(sheet, "J1", { formula: 'HEX2DEC("FF")', result: 255 });
    Cell.setValue(sheet, "K1", { formula: "XIRR(A1:B1,A1:B1)", result: 0.1 });

    const bytes = await Xlsb.toBuffer(workbook, { zip: { reproducible: true } });
    const target = Workbook.create();
    await Xlsb.read(target, bytes);
    const result = Workbook.getWorksheet(target, "Formula")!;

    expect(Cell.getFormula(result, "C1")).toBe("A1+B1*2");
    expect(Cell.getResult(result, "C1")).toBe(8);
    expect(Cell.getFormula(result, "D1")).toBe("SUM($A$1:B1)+ROUND(1.25,1)");
    expect(Cell.getResult(result, "D1")).toBe(6.3);
    expect(Cell.getFormula(result, "E1")).toBe('"xls"&"b"');
    expect(Cell.getResult(result, "E1")).toBe("xlsb");
    expect(Cell.getFormula(result, "F1")).toBe("A1>B1");
    expect(Cell.getResult(result, "F1")).toBe(false);
    expect(Cell.getFormula(result, "G1")).toBe("DCOUNT(A1:B1,A1,A1:B1)");
    expect(Cell.getFormula(result, "H1")).toBe("SINH(A1)");
    expect(Cell.getFormula(result, "I1")).toBe("WEEKDAY(A1,2)");
    expect(Cell.getFormula(result, "J1")).toBe('HEX2DEC("FF")');
    expect(Cell.getFormula(result, "K1")).toBe("XIRR(A1:B1,A1:B1)");
  });

  it("round-trips shared and legacy array formula records", async () => {
    const workbook = Workbook.create();
    const sheet = Workbook.addWorksheet(workbook, "Formula groups");
    Cell.setValue(sheet, "A1", 1);
    Cell.setValue(sheet, "A2", 2);
    Cell.setValue(sheet, "A3", 3);
    Worksheet.fillFormula(sheet, "B1:B3", "A1*2", [2, 4, 6], "shared");
    Worksheet.fillFormula(sheet, "C1:C3", "A1:A3*10", [10, 20, 30], "array");

    const bytes = await Xlsb.toBuffer(workbook, { zip: { reproducible: true } });
    const files = await new ZipParser(bytes).extractAll();
    const records = [
      ...iterateBiffRecords(files.get("xl/worksheets/sheet1.bin")!, "formula groups")
    ];
    const recordTypes = records.map(record => record.type);
    expect(recordTypes).toContain(XlsbRecordType.SharedFormula);
    expect(recordTypes).toContain(XlsbRecordType.ArrayFormula);
    let row = -1;
    const formulaReferences: { cell: string; master: string }[] = [];
    for (const record of records) {
      if (record.type === XlsbRecordType.RowHdr) {
        row = new DataView(
          record.data.buffer,
          record.data.byteOffset,
          record.data.byteLength
        ).getUint32(0, true);
      }
      if (record.type === XlsbRecordType.FmlaNum && record.data[22] === 0x01) {
        const view = new DataView(
          record.data.buffer,
          record.data.byteOffset,
          record.data.byteLength
        );
        formulaReferences.push({
          cell: colCache.encodeAddress(row + 1, view.getUint32(0, true) + 1),
          master: colCache.encodeAddress(view.getUint32(23, true) + 1, view.getUint32(31, true) + 1)
        });
      }
    }
    expect(formulaReferences).toEqual([
      { cell: "B1", master: "B1" },
      { cell: "C1", master: "C1" },
      { cell: "B2", master: "B1" },
      { cell: "C2", master: "C1" },
      { cell: "B3", master: "B1" },
      { cell: "C3", master: "C1" }
    ]);

    const target = Workbook.create();
    await Xlsb.read(target, bytes);
    const result = Workbook.getWorksheet(target, "Formula groups")!;

    expect(Cell.getValue(result, "B1")).toEqual({
      formula: "A1*2",
      shareType: "shared",
      ref: "B1:B3",
      result: 2
    });
    expect(Cell.getValue(result, "B2")).toEqual({ sharedFormula: "B1", result: 4 });
    expect(Cell.getFormula(result, "B2")).toBe("A2*2");
    expect(Cell.getValue(result, "B3")).toEqual({ sharedFormula: "B1", result: 6 });
    expect(Cell.getFormula(result, "B3")).toBe("A3*2");
    expect(Cell.getValue(result, "C1")).toEqual({
      formula: "A1:A3*10",
      shareType: "array",
      ref: "C1:C3",
      result: 10
    });
    expect(Cell.getValue(result, "C2")).toBe(20);
    expect(Cell.getValue(result, "C3")).toBe(30);
  });

  it("round-trips worksheet tables and their BIFF12 table parts", async () => {
    const workbook = Workbook.create();
    const sheet = Workbook.addWorksheet(workbook, "Tables");
    Table.add(sheet, {
      name: "SalesTable",
      displayName: "SalesTable",
      ref: "B2",
      headerRow: true,
      totalsRow: false,
      style: {
        theme: "TableStyleMedium9",
        showFirstColumn: false,
        showLastColumn: true,
        showRowStripes: true,
        showColumnStripes: false
      },
      columns: [
        { name: "Item", filterButton: true },
        { name: "Amount", filterButton: false },
        { name: "Tax", calculatedColumnFormula: "[@Amount]*0.1" }
      ],
      rows: [
        ["Paper", 12, { formula: "[@Amount]*0.1", result: 1.2 }],
        ["Ink", 7, { formula: "[@Amount]*0.1", result: 0.7 }]
      ]
    });
    const sourceTable = Table.get(sheet, "SalesTable")!;
    const sourceTableModel = Table.model(sourceTable);
    sourceTableModel.columns[0]!.rawFilterXml = ['<filters><filter val="Paper"/></filters>'];
    sourceTableModel.columns[1]!.rawFilterXml = [
      '<customFilters><customFilter operator="greaterThan" val="10"/></customFilters>'
    ];
    Table.setModel(sourceTable, sourceTableModel);
    Cell.setValue(sheet, "F2", { formula: "SUM(SalesTable[Amount])", result: 19 });

    const bytes = await Xlsb.toBuffer(workbook, { zip: { reproducible: true } });
    const files = await new ZipParser(bytes).extractAll();
    expect(files.has("xl/tables/table1.bin")).toBe(true);
    expect(
      [...iterateBiffRecords(files.get("xl/worksheets/sheet1.bin")!, "table worksheet")].map(
        record => record.type
      )
    ).toEqual(
      expect.arrayContaining([
        XlsbRecordType.BeginListParts,
        XlsbRecordType.ListPart,
        XlsbRecordType.EndListParts
      ])
    );

    const target = Workbook.create();
    await Xlsb.read(target, bytes);
    const loadedSheet = Workbook.getWorksheet(target, "Tables")!;
    const table = Table.get(loadedSheet, "SalesTable")!;
    expect(Table.model(table)).toMatchObject({
      ref: "B2:D4",
      tableRef: "B2:D4",
      autoFilterRef: "B2:D4",
      name: "SalesTable",
      displayName: "SalesTable",
      headerRow: true,
      totalsRow: false,
      columns: [
        {
          name: "Item",
          filterButton: true,
          rawFilterXml: ['<filters><filter val="Paper"/></filters>']
        },
        {
          name: "Amount",
          filterButton: false,
          rawFilterXml: [
            '<customFilters><customFilter operator="greaterThan" val="10"/></customFilters>'
          ]
        },
        {
          name: "Tax",
          calculatedColumnFormula: "SalesTable[[#This Row],[Amount]]*0.1"
        }
      ],
      rows: [
        ["Paper", 12, { formula: "SalesTable[[#This Row],[Amount]]*0.1", result: 1.2 }],
        ["Ink", 7, { formula: "SalesTable[[#This Row],[Amount]]*0.1", result: 0.7 }]
      ],
      style: {
        theme: "TableStyleMedium9",
        showLastColumn: true,
        showRowStripes: true
      }
    });
    expect(Cell.getFormula(loadedSheet, "F2")).toBe("SUM(SalesTable[Amount])");
    expect(Cell.getResult(loadedSheet, "F2")).toBe(19);
  });

  it("round-trips external, internal and formula-cell hyperlinks", async () => {
    const workbook = Workbook.create();
    const sheet = Workbook.addWorksheet(workbook, "Links");
    Cell.setValue(sheet, "A1", {
      text: "Open docs",
      hyperlink: "https://example.com/docs#api",
      tooltip: "Documentation"
    });
    Cell.setValue(sheet, "B1", {
      text: "Jump",
      hyperlink: "#Links!A1"
    });
    Cell.setValue(sheet, "C1", {
      formula: '"calculated"',
      result: "calculated",
      hyperlink: "https://example.com/result",
      tooltip: "Formula link"
    });

    const bytes = await Xlsb.toBuffer(workbook, { zip: { reproducible: true } });
    const target = Workbook.create();
    await Xlsb.read(target, bytes);
    const result = Workbook.getWorksheet(target, "Links")!;

    expect(Cell.getValue(result, "A1")).toEqual({
      text: "Open docs",
      hyperlink: "https://example.com/docs#api",
      tooltip: "Documentation"
    });
    expect(Cell.getValue(result, "B1")).toEqual({ text: "Jump", hyperlink: "#Links!A1" });
    expect(Cell.getValue(result, "C1")).toMatchObject({
      text: "calculated",
      hyperlink: "https://example.com/result",
      tooltip: "Formula link"
    });
    expect(Cell.getFormula(result, "C1")).toBe('"calculated"');
    expect(Cell.getResult(result, "C1")).toBe("calculated");
  });

  it("round-trips cross-sheet formula references", async () => {
    const workbook = Workbook.create();
    const other = Workbook.addWorksheet(workbook, "Other Sheet");
    Cell.setValue(other, "A1", 10);
    const sheet = Workbook.addWorksheet(workbook, "Formula");
    Cell.setValue(sheet, "A1", { formula: "'Other Sheet'!$A$1+1", result: 11 });

    const bytes = await Xlsb.toBuffer(workbook, { zip: { reproducible: true } });
    const target = Workbook.create();
    await Xlsb.read(target, bytes);
    const result = Workbook.getWorksheet(target, "Formula")!;

    expect(Cell.getFormula(result, "A1")).toBe("'Other Sheet'!$A$1+1");
    expect(Cell.getResult(result, "A1")).toBe(11);
  });

  it("round-trips workbook and sheet-scoped defined names", async () => {
    const workbook = Workbook.create();
    const sheet = Workbook.addWorksheet(workbook, "Data");
    DefinedNames.setModel(Workbook.getDefinedNames(workbook), [
      {
        name: "InputCells",
        ranges: ["Data!$A$1:$A$2", "Data!$C$1"],
        hidden: true
      },
      {
        name: "TaxRate",
        ranges: ["0.2"],
        formulaExpression: "0.2",
        localSheetId: 0
      },
      {
        name: "MyFunction",
        ranges: ["1"],
        formulaExpression: "1"
      }
    ]);
    Cell.setValue(sheet, "A1", 10);
    Cell.setValue(sheet, "A2", 20);
    Cell.setValue(sheet, "C1", 5);
    Cell.setValue(sheet, "D1", {
      formula: "SUM(InputCells)*TaxRate",
      result: 7
    });
    Cell.setValue(sheet, "D2", { formula: "MyFunction(2)", result: 2 });

    const bytes = await Xlsb.toBuffer(workbook, { zip: { reproducible: true } });
    const target = Workbook.create();
    await Xlsb.read(target, bytes);
    const names = DefinedNames.model(Workbook.getDefinedNames(target));

    expect(names.find(name => name.name === "InputCells")).toMatchObject({
      name: "InputCells",
      ranges: ["Data!$A$1:$A$2", "Data!$C$1"],
      hidden: true
    });
    expect(names.find(name => name.name === "TaxRate")).toMatchObject({
      name: "TaxRate",
      ranges: ["0.2"],
      formulaExpression: "0.2",
      localSheetId: 0
    });
    expect(Cell.getFormula(Workbook.getWorksheet(target, "Data")!, "D1")).toBe(
      "SUM(InputCells)*TaxRate"
    );
    expect(Cell.getFormula(Workbook.getWorksheet(target, "Data")!, "D2")).toBe("MyFunction(2)");
  });

  it("round-trips ISO workbook protection", async () => {
    const workbook = Workbook.create();
    Workbook.addWorksheet(workbook, "Data");
    await Workbook.protect(workbook, "workbook-password", {
      lockStructure: true,
      lockWindows: true,
      lockRevision: true,
      spinCount: 2
    });
    const expected = Workbook.getModel(workbook).protection;

    const bytes = await Xlsb.toBuffer(workbook, { zip: { reproducible: true } });
    const target = Workbook.create();
    await Xlsb.read(target, bytes);

    expect(Workbook.getModel(target).protection).toEqual(expected);
  });

  it("round-trips font, fill, border, alignment and protection styles", async () => {
    const workbook = Workbook.create();
    const sheet = Workbook.addWorksheet(workbook, "Style");
    Cell.setValue(sheet, "A1", "styled");
    Cell.setStyle(sheet, "A1", {
      font: {
        name: "Arial",
        size: 14,
        bold: true,
        italic: true,
        underline: "double",
        color: { argb: "FF123456" }
      },
      fill: { type: "pattern", pattern: "solid", fgColor: { theme: 4, tint: 0.25 } },
      border: {
        top: { style: "thin", color: { argb: "FFFF0000" } },
        bottom: { style: "double", color: { indexed: 8 } },
        diagonal: { style: "dashed", color: { theme: 5 }, up: true, down: true }
      },
      alignment: {
        horizontal: "center",
        vertical: "middle",
        wrapText: true,
        shrinkToFit: true,
        indent: 2,
        readingOrder: "rtl",
        textRotation: -30
      },
      protection: { locked: false, hidden: true }
    });

    const bytes = await Xlsb.toBuffer(workbook, { zip: { reproducible: true } });
    const target = Workbook.create();
    await Xlsb.read(target, bytes);
    const result = Workbook.getWorksheet(target, "Style")!;

    expect(Cell.getStyle(result, "A1")).toMatchObject({
      font: {
        name: "Arial",
        size: 14,
        bold: true,
        italic: true,
        underline: "double",
        color: { argb: "FF123456" }
      },
      fill: {
        type: "pattern",
        pattern: "solid",
        fgColor: { theme: 4, tint: expect.closeTo(0.25, 4) }
      },
      border: {
        top: { style: "thin", color: { argb: "FFFF0000" } },
        bottom: { style: "double", color: { indexed: 8 } },
        diagonal: { style: "dashed", color: { theme: 5 }, up: true, down: true }
      },
      alignment: {
        horizontal: "center",
        vertical: "middle",
        wrapText: true,
        shrinkToFit: true,
        indent: 2,
        readingOrder: "rtl",
        textRotation: -30
      },
      protection: { locked: false, hidden: true }
    });
  });

  it("round-trips named cell styles and cell XF inheritance", async () => {
    const workbook = Workbook.create();
    const sheet = Workbook.addWorksheet(workbook, "Named styles");
    Workbook.defineCellStyle(workbook, "Heading 1", {
      font: { name: "Arial", size: 20, bold: true, color: { theme: 4 } },
      fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FFF2F2F2" } },
      builtinId: 16,
      hidden: true,
      customBuiltin: true
    });
    Cell.setValue(sheet, "A1", "Inherited");
    Cell.setStyle(sheet, "A1", {
      styleName: "Heading 1",
      alignment: { horizontal: "center" }
    });

    const bytes = await Xlsb.toBuffer(workbook, { zip: { reproducible: true } });
    const target = Workbook.create();
    await Xlsb.read(target, bytes);
    const result = Workbook.getWorksheet(target, "Named styles")!;

    expect(Workbook.listCellStyles(target)).toMatchObject([
      {
        name: "Heading 1",
        font: { name: "Arial", size: 20, bold: true, color: { theme: 4 } },
        fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FFF2F2F2" } },
        builtinId: 16,
        hidden: true,
        customBuiltin: true
      }
    ]);
    expect(Cell.getStyle(result, "A1")).toMatchObject({
      styleName: "Heading 1",
      font: { name: "Arial", size: 20, bold: true, color: { theme: 4 } },
      fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FFF2F2F2" } },
      alignment: { horizontal: "center" }
    });
  });

  it("round-trips rich cell notes, authors and VML box geometry", async () => {
    const workbook = Workbook.create();
    const sheet = Workbook.addWorksheet(workbook, "Comments");
    Cell.setValue(sheet, "B3", "annotated");
    Cell.setComment(sheet, "B3", {
      author: "Ada Lovelace",
      note: {
        texts: [
          { text: "Important ", font: { name: "Arial", bold: true } },
          { text: "detail", font: { name: "Arial", italic: true, color: { theme: 4 } } }
        ],
        width: 140,
        height: 90,
        margins: { insetmode: "custom", inset: [0.1, 0.2, 0.3, 0.4] },
        protection: { locked: "False", lockText: "True" },
        editAs: "twoCells"
      }
    });

    const bytes = await Xlsb.toBuffer(workbook, { zip: { reproducible: true } });
    const files = await new ZipParser(bytes).extractAll();
    expect(files.has("xl/comments1.bin")).toBe(true);
    expect(files.has("xl/drawings/vmlDrawing1.vml")).toBe(true);

    const target = Workbook.create();
    await Xlsb.read(target, bytes);
    const comment = Cell.getComment(Workbook.getWorksheet(target, "Comments")!, "B3");
    expect(comment?.author).toBe("Ada Lovelace");
    expect(comment?.note).toMatchObject({
      texts: [
        { text: "Important ", font: { name: "Arial", bold: true } },
        { text: "detail", font: { name: "Arial", italic: true, color: { theme: 4 } } }
      ],
      width: 140,
      height: 90,
      margins: { insetmode: "custom", inset: [0.1, 0.2, 0.3, 0.4] },
      protection: { locked: "False", lockText: "True" },
      editAs: "twoCells"
    });
  });

  it("round-trips ISO sheet protection and its editing permissions", async () => {
    const workbook = Workbook.create();
    const sheet = Workbook.addWorksheet(workbook, "Protected");
    await Worksheet.protect(sheet, "xlsb-password", {
      spinCount: 2,
      objects: false,
      scenarios: false,
      selectLockedCells: false,
      selectUnlockedCells: true,
      formatColumns: true,
      insertRows: true,
      sort: true,
      autoFilter: true
    });

    const bytes = await Xlsb.toBuffer(workbook, { zip: { reproducible: true } });
    const target = Workbook.create();
    await Xlsb.read(target, bytes);
    const result = Workbook.getWorksheet(target, "Protected")!;

    expect(Worksheet.getModel(result).sheetProtection).toMatchObject({
      sheet: true,
      objects: false,
      scenarios: false,
      selectLockedCells: false,
      formatColumns: true,
      insertRows: true,
      sort: true,
      autoFilter: true,
      algorithmName: "SHA-512",
      spinCount: 2
    });
    expect(await Worksheet.verifyPassword(result, "xlsb-password")).toBe(true);
    expect(await Worksheet.verifyPassword(result, "wrong-password")).toBe(false);
  });

  it("round-trips data-validation rules and formulas", async () => {
    const workbook = Workbook.create();
    const sheet = Workbook.addWorksheet(workbook, "Validation");
    Cell.setValidation(sheet, "A1", {
      type: "whole",
      operator: "between",
      formulae: [1, 10],
      allowBlank: true,
      showErrorMessage: true,
      errorStyle: "warning",
      errorTitle: "Invalid value",
      error: "Enter 1 through 10"
    });
    Cell.setValidation(sheet, "B1", {
      type: "list",
      formulae: ['"red,green,blue"'],
      showInputMessage: true,
      promptTitle: "Color",
      prompt: "Choose a color"
    });
    Cell.setValidation(sheet, "C1", {
      type: "date",
      operator: "greaterThanOrEqual",
      formulae: [new Date("2025-01-01T00:00:00.000Z")]
    });

    const bytes = await Xlsb.toBuffer(workbook, { zip: { reproducible: true } });
    const target = Workbook.create();
    await Xlsb.read(target, bytes);
    const result = Workbook.getWorksheet(target, "Validation")!;

    expect(Cell.getValidation(result, "A1")).toMatchObject({
      type: "whole",
      operator: "between",
      formulae: [1, 10],
      allowBlank: true,
      showErrorMessage: true,
      errorStyle: "warning",
      errorTitle: "Invalid value",
      error: "Enter 1 through 10"
    });
    expect(Cell.getValidation(result, "B1")).toMatchObject({
      type: "list",
      formulae: ['"red,green,blue"'],
      showInputMessage: true,
      promptTitle: "Color",
      prompt: "Choose a color"
    });
    expect(Cell.getValidation(result, "C1")).toMatchObject({
      type: "date",
      operator: "greaterThanOrEqual",
      formulae: [new Date("2025-01-01T00:00:00.000Z")]
    });
  });

  it("round-trips worksheet views, panes and sheet formatting properties", async () => {
    const workbook = Workbook.create();
    const sheet = Workbook.addWorksheet(workbook, "View", {
      properties: {
        tabColor: { argb: "FF336699" },
        defaultColWidth: 11.5,
        defaultRowHeight: 18,
        outlineLevelRow: 2,
        outlineLevelCol: 3,
        outlineProperties: { summaryBelow: false, summaryRight: true }
      },
      pageSetup: {
        margins: { left: 0.5, right: 0.6, top: 0.7, bottom: 0.8, header: 0.2, footer: 0.25 },
        orientation: "landscape",
        horizontalDpi: 300,
        verticalDpi: 600,
        fitToPage: true,
        fitToWidth: 2,
        fitToHeight: 3,
        scale: 85,
        pageOrder: "overThenDown",
        blackAndWhite: true,
        draft: true,
        cellComments: "atEnd",
        errors: "dash",
        paperSize: 9,
        showRowColHeaders: true,
        showGridLines: true,
        firstPageNumber: 4,
        useFirstPageNumber: true,
        horizontalCentered: true,
        verticalCentered: true
      },
      headerFooter: {
        differentFirst: true,
        differentOddEven: true,
        scaleWithDoc: false,
        alignWithMargins: false,
        oddHeader: "&Lleft&Ccenter&Rright",
        oddFooter: "&P / &N",
        evenHeader: "even header",
        evenFooter: "even footer",
        firstHeader: "first header",
        firstFooter: "first footer"
      },
      views: [
        {
          state: "frozen",
          xSplit: 2,
          ySplit: 1,
          topLeftCell: "C2",
          activeCell: "D4",
          tabSelected: true,
          rightToLeft: true,
          showRuler: false,
          showGridLines: false,
          showRowColHeaders: false,
          zoomScale: 125,
          zoomScaleNormal: 110
        }
      ]
    });
    const sourceModel = Worksheet.getModel(sheet);
    sourceModel.rowBreaks = [{ id: 5, min: 1, max: 8, man: 1 }];
    sourceModel.colBreaks = [{ id: 3, max: 100, man: 1 }];
    sourceModel.ignoredErrors = [
      {
        ref: "A1:B10 D1:D5",
        numberStoredAsText: true,
        formulaRange: true,
        unlockedFormula: true,
        evalError: true
      }
    ];
    Worksheet.setModel(sheet, sourceModel);
    const bytes = await Xlsb.toBuffer(workbook, { zip: { reproducible: true } });
    const target = Workbook.create();
    await Xlsb.read(target, bytes);
    const model = Worksheet.getModel(Workbook.getWorksheet(target, "View")!);

    expect(model.views[0]).toMatchObject({
      state: "frozen",
      xSplit: 2,
      ySplit: 1,
      topLeftCell: "C2",
      activeCell: "D4",
      tabSelected: true,
      rightToLeft: true,
      showRuler: false,
      showGridLines: false,
      showRowColHeaders: false,
      zoomScale: 125,
      zoomScaleNormal: 110
    });
    expect(model.properties).toMatchObject({
      tabColor: { argb: "FF336699" },
      defaultColWidth: 11.5,
      defaultRowHeight: 18,
      outlineLevelRow: 2,
      outlineLevelCol: 3,
      outlineProperties: { summaryBelow: false, summaryRight: true }
    });
    expect(model.pageSetup).toMatchObject({
      margins: { left: 0.5, right: 0.6, top: 0.7, bottom: 0.8, header: 0.2, footer: 0.25 },
      orientation: "landscape",
      horizontalDpi: 300,
      verticalDpi: 600,
      fitToPage: true,
      fitToWidth: 2,
      fitToHeight: 3,
      scale: 85,
      pageOrder: "overThenDown",
      blackAndWhite: true,
      draft: true,
      cellComments: "atEnd",
      errors: "dash",
      paperSize: 9,
      showRowColHeaders: true,
      showGridLines: true,
      firstPageNumber: 4,
      useFirstPageNumber: true,
      horizontalCentered: true,
      verticalCentered: true
    });
    expect(model.headerFooter).toEqual({
      differentFirst: true,
      differentOddEven: true,
      scaleWithDoc: false,
      alignWithMargins: false,
      oddHeader: "&Lleft&Ccenter&Rright",
      oddFooter: "&P / &N",
      evenHeader: "even header",
      evenFooter: "even footer",
      firstHeader: "first header",
      firstFooter: "first footer"
    });
    expect(model.rowBreaks).toEqual([{ id: 5, min: 1, max: 8, man: 1 }]);
    expect(model.colBreaks).toEqual([{ id: 3, max: 100, man: 1 }]);
    expect(model.ignoredErrors).toEqual([
      {
        ref: "A1:B10 D1:D5",
        numberStoredAsText: true,
        formulaRange: true,
        unlockedFormula: true,
        evalError: true
      }
    ]);
  });
});
