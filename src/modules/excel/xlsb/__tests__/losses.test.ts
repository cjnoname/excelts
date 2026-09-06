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
import { iterateBiffRecords, iterateInterpretableRecords } from "@excel/xlsb/binary";
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
    // Every criterion kind the XLSX reader preserves — values, date group items, custom comparisons, top-N,
    // dynamic, colour and icon — now has a record, so the fixture has to be something the schema allows
    // inside a filter column and this writer has none for: an `extLst` extension. The XML shape matters
    // here: criteria arrive as raw XML on `autoFilterCriteria`, not as a structured `filterColumns` on the
    // `autoFilter`, which is the field this check read at first and which the model does not have.
    [
      "auto filter criteria",
      {
        autoFilterCriteria: {
          ref: "A1:B2",
          xml: '<filterColumn colId="0"><extLst><ext uri="{x}"/></extLst></filterColumn>'
        }
      }
    ]
  ])("names %s", (expected, model) => {
    expect(worksheetLosses(model)).toEqual([expected]);
  });

  it.each([
    ["page setup draft", { pageSetup: { draft: true } }],
    ["page setup pageOrder", { pageSetup: { pageOrder: "overThenDown" } }]
  ])("names %s", (expected, model) => {
    expect(worksheetLosses(model)).toEqual([expected]);
  });

  it.each([
    ["horizontalCentered", { pageSetup: { horizontalCentered: true } }],
    ["verticalCentered", { pageSetup: { verticalCentered: true } }],
    ["showGridLines", { pageSetup: { showGridLines: true } }],
    ["showRowColHeaders", { pageSetup: { showRowColHeaders: true } }]
  ])("no longer reports %s, because BrtPrintOptions carries it", (_name, model) => {
    // **These four were listed as losses and are not lost.** `BrtPrintOptions` holds them in four bits that this
    // module wrote as a fixed `0x0010` and never interpreted — the caution was reasonable (the pinned corpus
    // disagrees with itself about this record) and the consequence was that four print options vanished from
    // every binary workbook. Excel's own output across fifteen references settled it: `0x0011` for the one whose
    // XML says `horizontalCentered="1"`, `0x0010` for the rest.
    //
    // Asserted as an empty list rather than deleted, so putting a name back here has to be deliberate.
    expect(worksheetLosses(model)).toEqual([]);
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
    const many = {
      conditionalFormattings: []
    };
    // Seven sheets' worth is not a thing a single sheet can carry for most checks, so the count is exercised
    // with the one remaining loss that is per-*occurrence*: a filter column this writer has no record for.
    (many as { autoFilterCriteria?: unknown }).autoFilterCriteria = {
      ref: "A1:B2",
      xml: '<filterColumn colId="0"><extLst><ext uri="{x}"/></extLst></filterColumn>'.repeat(7)
    };
    expect(worksheetLosses(many)).toEqual(["auto filter criteria"]);
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

  it("no longer counts a border, because borders are written", () => {
    // This asserted three owners. `BrtBorder`'s layout is established now — the corpus gave its *size*
    // and MS-XLSB 2.4.314 its fields — so a border on a cell, a row or a column is carried rather than
    // counted. Inverted rather than deleted: the count firing again would mean the border table stopped
    // being written.
    const border = { border: { top: { style: "thin" } } };
    expect(
      worksheetLosses({
        rows: [
          { number: 1, cells: [{ address: "A1", style: border }], style: border },
          { number: 2, cells: [{ address: "A2", style: { font: {} } }] }
        ],
        cols: [{ min: 3, max: 3, style: border }]
      })
    ).toEqual([]);
  });
});

describe("a dropped sheet feature is refused by default", () => {
  it("writes a border instead of refusing it", async () => {
    const workbook = sheetWith(sheet => {
      Cell.setStyle(sheet, "A1", { border: { top: { style: "thin" } } } as never);
    });
    // No rejection under the default, which is the behaviour that changed when the layout was
    // established — and the package is still valid.
    await expectValidXlsb(await Workbook.toBuffer(workbook, { format: "xlsb" }));
  });

  it("no longer refuses a frozen pane, because it now writes one", async () => {
    // This asserted a rejection until `BrtPane` was implemented. Kept, inverted, rather than deleted:
    // the default is `unsupported: "error"`, so a feature moving off the loss list changes what a plain
    // `toBuffer` does, and that is the behaviour worth pinning.
    const workbook = Workbook.create();
    const sheet = Workbook.addWorksheet(workbook, "S1", {
      views: [{ state: "frozen", xSplit: 0, ySplit: 1 }]
    });
    Cell.setValue(sheet, "A1", 1);
    await expectValidXlsb(await Workbook.toBuffer(workbook, { format: "xlsb" }));
  });

  it("names the sheet the loss belongs to", async () => {
    const workbook = Workbook.create();
    Cell.setValue(Workbook.addWorksheet(workbook, "Plain"), "A1", 1);
    const second = Workbook.addWorksheet(workbook, "Noted");
    Cell.setValue(second, "A1", 1);
    // Through the model: `addWorksheet` does not take `pivotTables`, and a workbook that silently ignored
    // the option would make this test pass for the wrong reason.
    const model = Workbook.getModel(workbook);
    (
      model.worksheets[1] as { autoFilterCriteria?: { ref: string; xml: string } }
    ).autoFilterCriteria = {
      ref: "A1",
      xml: '<filterColumn colId="0"><extLst><ext uri="{x}"/></extLst></filterColumn>'
    };
    Workbook.setModel(workbook, model);
    await expect(Workbook.toBuffer(workbook, { format: "xlsb" })).rejects.toThrow(
      /Noted: auto filter criteria/
    );
  });
});

describe("workbookLosses", () => {
  it.each([
    // One `BrtBookView` is written, so the *second* view is what has nowhere to go.
    [
      "additional workbook view",
      {
        views: [
          { x: 0, y: 0 },
          { x: 1, y: 1 }
        ]
      }
    ]
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
    // A structured reference needs `PtgList`, which nothing here implements — so this is a definition
    // the encoder genuinely refuses rather than one contrived to fail.
    [{ name: "Broken", ranges: ["Table1[Amount]"] }, "Broken: defined name definition"]
  ])("reports %o", (name, expected) => {
    const written = writeWorkbookPart([{ name: "S1" }], {
      definedNames: [name],
      formulaContext: { sheetNames: ["S1"], definedNames: [name.name] }
    });
    expect(written.unsupported).toContain(expected);
  });

  it.each([
    // These three *were* reported losses and are now written. Kept as tests, inverted, because each was
    // a silent narrowing before it was a reported one: a multi-range name came back truncated, a
    // sheet-local name came back visible to the whole workbook, and a hidden name came back visible.
    // Asserting they are no longer reported is what stops a regression putting any of them back.
    { name: "Two", ranges: ["S1!$A$1", "S1!$C$1"] },
    { name: "Local", ranges: ["S1!$A$1"], localSheetId: 0 },
    { name: "Quiet", ranges: ["S1!$A$1"], hidden: true }
  ])("writes %o without reporting a loss", name => {
    const written = writeWorkbookPart([{ name: "S1" }], {
      definedNames: [name],
      formulaContext: { sheetNames: ["S1"], definedNames: [name.name] }
    });
    expect(written.unsupported).toEqual([]);
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

  it("round-trips a multi-range name end to end", async () => {
    const workbook = Workbook.create();
    Cell.setValue(Workbook.addWorksheet(workbook, "S1"), "A1", 1);
    const names = Workbook.getDefinedNames(workbook);
    // Non-adjacent, so the surface keeps them as two ranges rather than merging them into one.
    DefinedNames.add(names, "S1!$A$1", "Two");
    DefinedNames.add(names, "S1!$C$1", "Two");
    // A union, and the parentheses are what make it one — a bare `A1,C1` is not a union in Excel's
    // grammar and this library's parser rejects it, which is why every multi-range name used to fail.
    const bytes = await Workbook.toBuffer(workbook, { format: "xlsb" });
    const reopened = Workbook.create();
    await Workbook.read(reopened, bytes);
    const back = Workbook.getModel(reopened).definedNames.find(entry => entry.name === "Two");
    expect(back?.ranges).toHaveLength(2);
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
    // A feature still on the loss list, so the mechanism is exercised by something real rather than by
    // whatever happened to be unsupported when this was written. Set through the model, read back and
    // handed to `setModel` — `getModel` returns a snapshot, so mutating it in place changes nothing.
    const model = Workbook.getModel(workbook);
    (
      model.worksheets[0] as { autoFilterCriteria?: { ref: string; xml: string } }
    ).autoFilterCriteria = {
      ref: "A1",
      xml: '<filterColumn colId="0"><extLst><ext uri="{x}"/></extLst></filterColumn>'
    };
    Workbook.setModel(workbook, model);
    let thrown: unknown;
    try {
      await Workbook.toBuffer(workbook, { format: "xlsb" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ExcelNotSupportedError);
    expect((thrown as ExcelNotSupportedError).items).toEqual(["S1: auto filter criteria"]);
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

  it("sets fIter, which used to be the one bit it could not express", async () => {
    // The count and the delta were written because their offsets were established from Excel's output;
    // the *switch* sat in a flags word every corpus workbook leaves off, so it was reported rather than
    // guessed. MS-XLSB 2.4.318 names it: bit 2.
    const workbook = Workbook.create();
    Cell.setValue(Workbook.addWorksheet(workbook, "S1"), "A1", 1);
    const model = Workbook.getModel(workbook);
    const written = await writeXlsbPackage({
      ...model,
      calcProperties: { iterate: true }
    } as never);
    expect(written.unsupported).toEqual([]);
    for (const record of iterateInterpretableRecords(
      (await extractAll(written.bytes)).get("xl/workbook.bin")!.data,
      "w"
    )) {
      if (recordSpec(record.id)?.name !== "BrtCalcProp") {
        continue;
      }
      // Past `recalcID`, `fAutoRecalc`, `cCalcCount`, `xnumDelta` and `cUserThreadCount`: 4+4+4+8+4 = 24.
      const flags = new DataView(record.payload.buffer, record.payload.byteOffset).getUint16(
        24,
        true
      );
      expect(flags & (1 << 2)).not.toBe(0);
      return;
    }
    throw new Error("no BrtCalcProp was written");
  });

  it("says nothing when the workbook set none", async () => {
    const workbook = Workbook.create();
    Cell.setValue(Workbook.addWorksheet(workbook, "S1"), "A1", 1);
    expect((await writeXlsbPackage(Workbook.getModel(workbook))).unsupported).toEqual([]);
  });

  it.each([
    ["hidden", { number: 1, hidden: true, cells: [] }],
    ["grouped", { number: 1, outlineLevel: 2, cells: [] }],
    ["collapsed", { number: 1, collapsed: true, cells: [] }]
  ])("no longer reports a %s row", (_name, row) => {
    // These three were on the loss list not because `BrtRowHdr` has no room for them but because the
    // record's *two* flag bytes were declared as a single `u16`. The one flag the writer set therefore
    // landed in `fExtraDsc` at offset 10 instead of `fUnsynced` at offset 11 — and `iOutLevel`,
    // `fCollapsed` and `fDyZero`, which share that second byte, were unaddressable. The record always
    // carried them; the field description was wrong.
    expect(worksheetLosses({ rows: [row] } as never)).toEqual([]);
  });

  it.each([
    ["hidden", { min: 1, max: 1, hidden: true }],
    ["grouped", { min: 1, max: 1, outlineLevel: 1 }],
    ["collapsed", { min: 1, max: 1, collapsed: true }],
    ["best-fit", { min: 1, max: 1, bestFit: true }]
  ])("no longer reports a %s column", (_name, column) => {
    // `BrtColInfo`'s flag word *was* declared correctly — unlike `BrtRowHdr`'s — and the writer simply set
    // `fUserSet` and nothing else. Four features were reported as unsupported because one `writeUint16(0x02)`
    // never grew the other four bits.
    expect(worksheetLosses({ cols: [column] } as never)).toEqual([]);
  });
});
