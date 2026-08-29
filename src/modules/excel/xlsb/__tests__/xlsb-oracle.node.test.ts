import { Cell, Table, Workbook, Worksheet, Xlsb } from "@excel";
import { runOfficeOpenValidation } from "@excel/__tests__/helpers/external-oracle";
import { expect, it } from "vitest";

it("produces an XLSB package LibreOffice can open without repair when available", async () => {
  const workbook = Workbook.create();
  workbook.company = "Documonster & Co.";
  workbook.manager = "XLSB interoperability";
  const sheet = Workbook.addWorksheet(workbook, "Interop", {
    autoFilter: "A1:E2",
    properties: { tabColor: { argb: "FF336699" }, defaultRowHeight: 18 },
    views: [
      {
        state: "frozen",
        ySplit: 1,
        topLeftCell: "A2",
        activeCell: "B2",
        showGridLines: false,
        zoomScale: 115
      }
    ]
  });
  Cell.setValue(sheet, "A1", "XLSB");
  Cell.setValue(sheet, "B2", 123.5);
  const filterModel = Worksheet.getModel(sheet);
  filterModel.autoFilterCriteria = {
    ref: "A1:E2",
    xml: '<filterColumn colId="0"><filters><filter val="XLSB"/></filters></filterColumn>'
  };
  Worksheet.setModel(sheet, filterModel);
  Cell.setStyle(sheet, "B2", {
    numFmt: "#,##0.00",
    font: { name: "Arial", bold: true, color: { argb: "FF1F4E78" } },
    fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FFD9EAF7" } },
    border: { bottom: { style: "thin", color: { argb: "FF1F4E78" } } },
    alignment: { horizontal: "right", vertical: "middle" }
  });
  Worksheet.merge(sheet, "A3:C3");
  Cell.setValue(sheet, "A3", "merged");
  Cell.setValue(sheet, "C2", { formula: "B2*2+SUM(1,2)", result: 250 });
  Cell.setValue(sheet, "D2", { formula: 'IF(B2>100,"large","small")', result: "large" });
  const rates = Workbook.addWorksheet(workbook, "Rates Data");
  Cell.setValue(rates, "A1", 2);
  Table.add(rates, {
    name: "RateTable",
    ref: "B2",
    headerRow: true,
    totalsRow: false,
    style: { theme: "TableStyleMedium9", showRowStripes: true },
    columns: [{ name: "Tier" }, { name: "Rate", filterButton: false }],
    rows: [
      ["Base", 1.5],
      ["Premium", 2]
    ]
  });
  Cell.setValue(rates, "E2", { formula: "SUM(RateTable[Rate])", result: 3.5 });
  Cell.setValue(rates, "E6", 1);
  Cell.setValue(rates, "E7", 2);
  Cell.setValue(rates, "E8", 3);
  Worksheet.fillFormula(rates, "F6:F8", "E6*2", [2, 4, 6], "shared");
  Worksheet.fillFormula(rates, "G6:G8", "E6:E8*3", [3, 6, 9], "array");
  Cell.setValue(sheet, "E2", { formula: "'Rates Data'!$A$1*B2", result: 247 });
  Cell.setValue(sheet, "A5", {
    text: "External link",
    hyperlink: "https://example.com/xlsb#interop",
    tooltip: "XLSB hyperlink"
  });
  Cell.setValidation(sheet, "A6", {
    type: "whole",
    operator: "between",
    formulae: [1, 10],
    showErrorMessage: true
  });
  Cell.setComment(sheet, "A7", {
    author: "Documonster",
    note: {
      texts: [{ text: "Binary ", font: { bold: true } }, { text: "comment" }],
      width: 120,
      height: 75
    }
  });
  const bytes = await Xlsb.toBuffer(workbook, { zip: { reproducible: true } });
  const result = await runOfficeOpenValidation({
    envFlag: "DOCUMONSTER_XLSB_LIBREOFFICE_VALIDATION",
    executableEnv: "LIBREOFFICE_BIN",
    candidates: ["soffice", "libreoffice"],
    input: bytes,
    inputName: "documonster.xlsb"
  });

  if (!result.available) {
    expect(result.skipped).toBeTruthy();
    return;
  }
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.outputs.map(output => output.name)).toContain("documonster.xlsx");
  const converted = result.outputs.find(output => output.name === "documonster.xlsx")!;
  const reopened = Workbook.create();
  await Workbook.read(reopened, converted.data);
  expect(reopened.company).toBe("Documonster & Co.");
  expect(reopened.manager).toBe("XLSB interoperability");
  const reopenedSheet = Workbook.getWorksheet(reopened, "Interop")!;
  expect(Cell.getFormula(reopenedSheet, "C2")).toBe("B2*2+SUM(1,2)");
  expect(Cell.getResult(reopenedSheet, "C2")).toBe(250);
  expect(Cell.getFormula(reopenedSheet, "D2")).toBe('IF(B2>100,"large","small")');
  expect(Cell.getResult(reopenedSheet, "D2")).toBe("large");
  expect(Cell.getFormula(reopenedSheet, "E2")).toBe("'Rates Data'!$A$1*B2");
  expect(Cell.getResult(reopenedSheet, "E2")).toBe(247);
  const reopenedRates = Workbook.getWorksheet(reopened, "Rates Data")!;
  expect(Table.model(Table.get(reopenedRates, "RateTable")!)).toMatchObject({
    tableRef: "B2:C4",
    columns: [{ name: "Tier" }, { name: "Rate" }]
  });
  // LibreOffice lowers structured references to an equivalent OFFSET formula on XLSX export.
  expect(Cell.getFormula(reopenedRates, "E2")).toContain("RateTable");
  expect(Cell.getResult(reopenedRates, "E2")).toBe(3.5);
  expect(Cell.getFormula(reopenedRates, "F6")).toBe("E6*2");
  expect(Cell.getFormula(reopenedRates, "F7")).toBe("E7*2");
  expect(Cell.getFormula(reopenedRates, "F8")).toBe("E8*2");
  expect(Cell.getResult(reopenedRates, "F8")).toBe(6);
  expect(Cell.getFormula(reopenedRates, "G6")).toBe("E6:E8*3");
  expect(Cell.getValue(reopenedRates, "G8")).toBe(9);
  expect(Cell.getValue(reopenedSheet, "A5")).toMatchObject({
    text: "External link",
    hyperlink: "https://example.com/xlsb"
  });
  expect(Cell.getValidation(reopenedSheet, "A6")).toMatchObject({
    type: "whole",
    operator: "between",
    formulae: [1, 10],
    showErrorMessage: true
  });
  const reopenedComment = Cell.getComment(reopenedSheet, "A7");
  expect(reopenedComment?.author).toBe("Documonster");
  expect(
    typeof reopenedComment?.note === "string"
      ? reopenedComment.note
      : reopenedComment?.note?.texts?.map(run => run.text).join("")
  ).toBe("Binary comment");
  expect(Worksheet.getModel(reopenedSheet)).toMatchObject({
    autoFilter: "A1:E2",
    autoFilterCriteria: {
      ref: "A1:E2",
      xml: expect.stringContaining('<filter val="XLSB"/>')
    },
    properties: { tabColor: { argb: "FF336699" }, defaultRowHeight: 18 },
    views: [
      {
        state: "frozen",
        ySplit: 1,
        topLeftCell: "A2",
        activeCell: "B2",
        zoomScale: 115
      }
    ]
  });
});

it("produces ISO-protected XLSB sheets LibreOffice can open without repair", async () => {
  const workbook = Workbook.create();
  const sheet = Workbook.addWorksheet(workbook, "Protected");
  Cell.setValue(sheet, "A1", "protected");
  await Worksheet.protect(sheet, "oracle-password", {
    spinCount: 2,
    selectLockedCells: false,
    formatColumns: true,
    autoFilter: true
  });
  await Workbook.protect(workbook, "workbook-password", {
    lockStructure: true,
    lockWindows: true,
    spinCount: 2
  });

  const bytes = await Xlsb.toBuffer(workbook, { zip: { reproducible: true } });
  const result = await runOfficeOpenValidation({
    envFlag: "DOCUMONSTER_XLSB_LIBREOFFICE_VALIDATION",
    executableEnv: "LIBREOFFICE_BIN",
    candidates: ["soffice", "libreoffice"],
    input: bytes,
    inputName: "documonster-protected.xlsb"
  });

  if (!result.available) {
    expect(result.skipped).toBeTruthy();
    return;
  }
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.outputs.map(output => output.name)).toContain("documonster-protected.xlsx");
});
