import { extractAll } from "@archive/unzip/extract";
/**
 * The features a binary workbook drops, and the fact that it says so.
 *
 * `unsupported: "error"` is the default, and it reads as "refuse anything this container cannot
 * express". Until these checks existed it did not: the report covered cell values and merge
 * references, so a workbook with tables, filters, validations, conditional formatting, frozen panes,
 * page breaks, comments, shapes, charts or borders wrote **successfully** and arrived with none of
 * them. Every case below therefore asserts two things — that the write is refused by default, and
 * that `"ignore"` still produces a package the validator accepts.
 *
 * These are not gaps this writer could close by trying harder. Each needs a record whose layout no
 * workbook in the reference corpus establishes, and writing an unobserved layout is how a writer comes
 * to agree with its own reader and disagree with Excel. What was fixable was the silence.
 */
import { Cell, DefinedNames, Workbook, type Worksheet } from "@excel";
import { expectValidXlsb } from "@excel/__tests__/helpers/expect-valid-xlsb";
import { ExcelNotSupportedError } from "@excel/errors";
import { iterateBiffRecords } from "@excel/xlsb/binary";
import { recordSpec } from "@excel/xlsb/spec/records";
import { workbookLosses, worksheetLosses } from "@excel/xlsb/write/losses";
import { writeXlsbPackage } from "@excel/xlsb/write/package";
import { writeWorkbookPart } from "@excel/xlsb/write/workbook";
import { describeBiffStream } from "@test/biff-dump";
import { describe, expect, it } from "vitest";

/** A one-cell sheet, so every case differs only by the feature under test. */
function sheetWith(mutate: (sheet: Worksheet.Handle) => void): Workbook.Handle {
  const workbook = Workbook.create();
  const sheet = Workbook.addWorksheet(workbook, "S1");
  Cell.setValue(sheet, "A1", 1);
  mutate(sheet);
  return workbook;
}

/**
 * The scan reads the worksheet model, so each case is expressed as the model field it populates.
 *
 * Driving it at this level rather than through the public setters is deliberate: the point is that
 * *every* feature the model can carry is accounted for, and several of these have no XLSB-facing
 * setter at all — which is exactly how they came to be dropped without notice.
 */
describe("worksheetLosses", () => {
  it.each([
    ["data validation", { dataValidations: { A1: { type: "list", formulae: ['"a,b"'] } } }],
    ["conditional formatting", { conditionalFormattings: [{ ref: "A1", rules: [] }] }],
    ["table", { tables: [{ name: "Sales" }] }],
    ["pivot table", { pivotTables: [{ name: "P" }] }],
    ["auto filter", { autoFilter: "A1:B2" }],
    ["sheet protection", { sheetProtection: { sheet: true } }],
    ["row page break", { rowBreaks: [{ id: 4 }] }],
    ["column page break", { colBreaks: [{ id: 2 }] }],
    ["shape", { shapes: [{ type: "rect" }] }],
    ["chart", { charts: [{ name: "c" }] }],
    ["sparkline group", { sparklineGroups: [{ ref: "A1" }] }],
    ["form control", { formControls: [{ ref: "A1" }] }],
    ["ignored error", { ignoredErrors: [{ sqref: "A1" }] }],
    ["threaded comment", { threadedComments: [{ ref: "A1", comment: {} }] }],
    ["watermark", { watermark: { text: "DRAFT" } }],
    ["frozen or split pane", { views: [{ state: "frozen", ySplit: 1 }] }],
    ["print area", { pageSetup: { printArea: "A1:B2" } }],
    ["print titles", { pageSetup: { printTitlesRow: "1:1" } }]
  ])("names %s", (expected, model) => {
    expect(worksheetLosses(model)).toEqual([expected]);
  });

  it.each([
    ["cell comment", { rows: [{ number: 1, cells: [{ address: "A1", comment: { texts: [] } }] }] }],
    ["hidden row", { rows: [{ number: 1, hidden: true, cells: [] }] }],
    ["grouped row", { rows: [{ number: 1, outlineLevel: 2, cells: [] }] }],
    ["collapsed row", { rows: [{ number: 1, collapsed: true, cells: [] }] }],
    ["hidden column", { cols: [{ min: 1, max: 1, hidden: true }] }],
    ["grouped column", { cols: [{ min: 1, max: 1, outlineLevel: 1 }] }],
    ["collapsed column", { cols: [{ min: 1, max: 1, collapsed: true }] }],
    ["best-fit column", { cols: [{ min: 1, max: 1, bestFit: true }] }],
    ["background image", { media: [{ type: "background" }] }],
    ["header image", { media: [{ type: "headerImage" }] }],
    ["watermark image", { media: [{ type: "watermark" }] }],
    ["outline level", { properties: { outlineLevelRow: 2 } }],
    ["worksheet view setting", { views: [{ state: "normal", zoomScale: 150 }] }],
    ["worksheet view setting", { views: [{ state: "normal", rightToLeft: true }] }],
    ["worksheet view setting", { views: [{ state: "normal", style: "pageLayout" }] }],
    ["page setup draft", { pageSetup: { draft: true } }],
    ["page setup horizontalCentered", { pageSetup: { horizontalCentered: true } }],
    ["page setup pageOrder", { pageSetup: { pageOrder: "overThenDown" } }]
  ])("names %s", (expected, model) => {
    expect(worksheetLosses(model)).toEqual([expected]);
  });

  /**
   * The other half of the contract, and the half that decides whether any of this is usable.
   *
   * A freshly created worksheet arrives with a fully populated `pageSetup`, a `properties` carrying
   * outline levels of zero and rows carrying `hidden: false`. A scan that reported a field because it
   * was *present* would report every workbook ever built — which would not be a strict mode, it would
   * be a reason to switch strict mode off permanently.
   */
  it("says nothing about a default-constructed worksheet", () => {
    const workbook = Workbook.create();
    const sheet = Workbook.addWorksheet(workbook, "S1");
    Cell.setValue(sheet, "A1", 1);
    Cell.setStyle(sheet, "A1", { font: { bold: true }, numFmt: "0.00" } as never);
    expect(worksheetLosses(Workbook.getModel(workbook).worksheets[0])).toEqual([]);
  });

  it("does not report a border shape that would not draw", () => {
    // Both of these are shapes the model produces, and neither draws anything.
    expect(
      worksheetLosses({ rows: [{ number: 1, cells: [{ style: { border: { top: {} } } }] }] })
    ).toEqual([]);
    expect(
      worksheetLosses({
        rows: [
          { number: 1, cells: [{ style: { border: { diagonal: { up: false, down: false } } } }] }
        ]
      })
    ).toEqual([]);
  });

  it("counts rather than listing every occurrence", () => {
    // A sheet with four hundred conditionally formatted ranges should produce one line, not four
    // hundred that bury everything else in the report.
    const many = { conditionalFormattings: Array.from({ length: 7 }, () => ({ ref: "A1" })) };
    expect(worksheetLosses(many)).toEqual(["conditional formatting (7)"]);
  });

  it("says nothing for a sheet whose features this writer does emit", () => {
    // Rows, columns, merges, tab colour, code name, the established page-setup fields, header and
    // footer, and images all survive — so none of them belongs in a loss report.
    expect(
      worksheetLosses({
        rows: [{ number: 1, cells: [{ address: "A1", style: { font: { bold: true } } }] }],
        cols: [{ min: 1, max: 1, width: 20 }],
        mergeCells: ["A1:B2"],
        pageSetup: { paperSize: 9, orientation: "landscape", scale: 80 },
        views: [{ state: "normal" }],
        media: [{ type: "image" }]
      })
    ).toEqual([]);
  });

  it("does not report an unprotected sheet", () => {
    // The writer emits a default `BrtSheetProtection` for every sheet because Excel does, so a sheet
    // with no protection configured loses nothing.
    expect(worksheetLosses({ sheetProtection: null })).toEqual([]);
  });

  it("counts a border wherever it sits", () => {
    const border = { border: { top: { style: "thin" } } };
    expect(
      worksheetLosses({
        rows: [
          { number: 1, cells: [{ address: "A1", style: border }], style: border },
          { number: 2, cells: [{ address: "A2", style: { font: {} } }] }
        ],
        cols: [{ min: 3, max: 3, style: border }]
      })
    ).toEqual(["border (owner) (3)"]);
  });
});

describe("a dropped sheet feature is refused by default", () => {
  it("reports a border rather than removing it silently", async () => {
    const workbook = sheetWith(sheet => {
      Cell.setStyle(sheet, "A1", { border: { top: { style: "thin" } } } as never);
    });
    await expect(Workbook.toBuffer(workbook, { format: "xlsb" })).rejects.toThrow(
      /S1: border \(owner\)/
    );
    // And the opt-out still produces a valid package — the border is gone, nothing else is.
    await expectValidXlsb(
      await Workbook.toBuffer(workbook, { format: "xlsb", unsupported: "ignore" })
    );
  });

  it("reports a frozen pane", async () => {
    const workbook = Workbook.create();
    const sheet = Workbook.addWorksheet(workbook, "S1", {
      views: [{ state: "frozen", xSplit: 0, ySplit: 1 }]
    });
    Cell.setValue(sheet, "A1", 1);
    await expect(Workbook.toBuffer(workbook, { format: "xlsb" })).rejects.toThrow(
      /S1: frozen or split pane/
    );
    await expectValidXlsb(
      await Workbook.toBuffer(workbook, { format: "xlsb", unsupported: "ignore" })
    );
  });

  it("names the sheet the loss belongs to", async () => {
    const workbook = Workbook.create();
    Cell.setValue(Workbook.addWorksheet(workbook, "Plain"), "A1", 1);
    const second = Workbook.addWorksheet(workbook, "Frozen", {
      views: [{ state: "frozen", xSplit: 1, ySplit: 1 }]
    });
    Cell.setValue(second, "A1", 1);
    await expect(Workbook.toBuffer(workbook, { format: "xlsb" })).rejects.toThrow(/Frozen: frozen/);
  });
});

describe("workbookLosses", () => {
  it.each([
    ["chartsheet", { chartsheets: [{ name: "Chart1" }] }],
    ["workbook protection", { protection: { lockStructure: true } }],
    ["workbook view", { views: [{ x: 0, y: 0 }] }],
    ["named cell style", { cellStyles: { Heading1: { font: { bold: true } } } }]
  ])("names %s", (expected, model) => {
    expect(workbookLosses(model as never)).toEqual([expected]);
  });

  it("says nothing about a default-constructed workbook", () => {
    expect(workbookLosses(Workbook.getModel(Workbook.create()))).toEqual([]);
  });
});

describe("defined names report what they could not carry", () => {
  /**
   * Driven through `writeWorkbookPart` for the cases the public surface will not construct — a name
   * whose definition does not parse, a locally scoped name, a hidden one. The writer has to be honest
   * about them regardless of which door they came through, and a reader of a `.xlsb` produced
   * elsewhere is exactly such a door.
   */
  it.each([
    // A structured reference needs `PtgList`, which no corpus workbook establishes — so this is a
    // definition the encoder genuinely refuses rather than one contrived to fail.
    [{ name: "Broken", ranges: ["Table1[Amount]"] }, "Broken: defined name definition"],
    [{ name: "Two", ranges: ["S1!$A$1", "S1!$C$1"] }, "Two: defined name with 2 ranges"],
    [
      // `localSheetId`, which is what `DefinedNameModel` actually carries. The first version of this
      // case used `sheetName` — a field the model does not have — so it passed while every real
      // sheet-local name was silently promoted to workbook scope.
      { name: "Local", ranges: ["S1!$A$1"], localSheetId: 0 },
      "Local: sheet-local defined name scope"
    ],
    [{ name: "Quiet", ranges: ["S1!$A$1"], hidden: true }, "Quiet: hidden defined name flag"]
  ])("reports %o", (name, expected) => {
    const written = writeWorkbookPart([{ name: "S1" }], {
      definedNames: [name],
      formulaContext: { sheetNames: ["S1"], definedNames: [name.name] }
    });
    expect(written.unsupported).toContain(expected);
  });

  it("keeps the slot of a name it could not encode", () => {
    // `PtgName` indexes by position, so dropping an entry silently retargets every reference after
    // it. Keeping the slot is the right repair for the indexing and is not a repair for the name —
    // which is why the loss is reported rather than treated as handled.
    const names = [
      { name: "Broken", ranges: ["Table1[Amount]"] },
      { name: "Fine", ranges: ["S1!$A$1"] }
    ];
    const written = writeWorkbookPart([{ name: "S1" }], {
      definedNames: names,
      formulaContext: { sheetNames: ["S1"], definedNames: names.map(entry => entry.name) }
    });
    expect(written.unsupported).toEqual(["Broken: defined name definition"]);
    expect(describeBiffStream(written.bytes).match(/BrtName/g)).toHaveLength(2);
  });

  it("reports a multi-range name end to end", async () => {
    const workbook = Workbook.create();
    Cell.setValue(Workbook.addWorksheet(workbook, "S1"), "A1", 1);
    const names = Workbook.getDefinedNames(workbook);
    // Non-adjacent, or the surface merges them into one range and there is nothing to lose.
    DefinedNames.add(names, "S1!$A$1", "Two");
    DefinedNames.add(names, "S1!$C$1", "Two");
    await expect(Workbook.toBuffer(workbook, { format: "xlsb" })).rejects.toThrow(
      /Two: defined name with 2 ranges/
    );
  });
});

/**
 * The report is reachable as data on both sides.
 *
 * Adding `items` to the error and then wiring it on only one side is exactly the kind of asymmetry
 * that survives a green test suite: the message still listed everything, so nothing looked wrong until
 * an example printed `named 0 item(s)`. Asserting it per direction is what keeps the two in step.
 */
describe("the loss report is data, not just a sentence", () => {
  it("carries the items when a write is refused", async () => {
    const workbook = Workbook.create();
    const sheet = Workbook.addWorksheet(workbook, "S1");
    Cell.setValue(sheet, "A1", 1);
    Cell.setStyle(sheet, "A1", { border: { top: { style: "thin" } } } as never);
    let thrown: unknown;
    try {
      await Workbook.toBuffer(workbook, { format: "xlsb" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ExcelNotSupportedError);
    expect((thrown as ExcelNotSupportedError).items).toEqual(["S1: border (owner)"]);
  });

  it("truncates the message and not the items", async () => {
    // The message is read by a human and stops at ten; `items` is read by code and does not.
    const workbook = Workbook.create();
    const sheet = Workbook.addWorksheet(workbook, "S1");
    for (let row = 1; row <= 12; row++) {
      Cell.setValue(sheet, `A${row}`, { formula: "A1:A2", isDynamicArray: true } as never);
    }
    let thrown: unknown;
    try {
      await Workbook.toBuffer(workbook, { format: "xlsb" });
    } catch (error) {
      thrown = error;
    }
    const error = thrown as ExcelNotSupportedError;
    expect(error.items).toHaveLength(12);
    expect(error.message).toContain(", …");
  });
});

/**
 * Calculation properties, which are two established fields and one unobserved bit.
 *
 * A useful shape to keep in mind when the next partly-establishable record turns up: the iteration
 * *count* and the convergence *delta* sit at offsets all nine corpus workbooks agree on, so they are
 * written. Whether iteration is *on* lives in a flags word every one of them leaves off, so that bit is
 * unobserved — and guessing it would enable or disable recalculation of every circular reference in the
 * file. So the record is written with the author's numbers and the flag is reported.
 */
describe("calculation properties", () => {
  it("writes the iteration count and delta", async () => {
    const workbook = Workbook.create();
    Cell.setValue(Workbook.addWorksheet(workbook, "S1"), "A1", 1);
    const model = Workbook.getModel(workbook);
    const written = await writeXlsbPackage({
      ...model,
      calcProperties: { iterateCount: 250, iterateDelta: 0.0001 }
    } as never);
    // Not reported, because they reached the file.
    expect(written.unsupported).toEqual([]);

    const entries = await extractAll(written.bytes);
    for (const record of iterateBiffRecords(entries.get("xl/workbook.bin")!.data, "wb")) {
      if (recordSpec(record.id)?.name !== "BrtCalcProp") {
        continue;
      }
      const view = new DataView(record.payload.buffer, record.payload.byteOffset);
      expect(view.getUint32(8, true)).toBe(250);
      expect(view.getFloat64(12, true)).toBeCloseTo(0.0001);
      return;
    }
    throw new Error("no BrtCalcProp was written");
  });

  it("reports the iteration flag it cannot express", async () => {
    const workbook = Workbook.create();
    Cell.setValue(Workbook.addWorksheet(workbook, "S1"), "A1", 1);
    const model = Workbook.getModel(workbook);
    const written = await writeXlsbPackage({
      ...model,
      calcProperties: { iterate: true }
    } as never);
    expect(written.unsupported).toEqual(["iterative calculation"]);
  });

  it("says nothing when the workbook set none", async () => {
    const workbook = Workbook.create();
    Cell.setValue(Workbook.addWorksheet(workbook, "S1"), "A1", 1);
    expect((await writeXlsbPackage(Workbook.getModel(workbook))).unsupported).toEqual([]);
  });
});
