import { extractAll } from "@archive/unzip/extract";
/**
 * BIFF12 validator, checked one violation at a time.
 *
 * Hand-built record streams rather than output from a writer, for the same reason
 * `ooxml-validator/fixtures.ts` gives: a checker tested by running the whole
 * serialiser can only see the problems the serialiser happens to produce, and it is
 * a checker's negative cases that decide whether it is worth having. Each test here
 * constructs exactly one violation and asserts exactly one problem kind.
 *
 * A validator with a silent hole is worse than no validator, so `pnpm check` is not
 * the calibration for this file — `describe("the checks are not vacuous")` at the
 * bottom is, by asserting that a valid stream produces nothing.
 */
import { ZipArchive } from "@archive/zip";
import { Cell, Workbook, Worksheet } from "@excel";
import { validateXlsbBuffer, validateXlsbPart } from "@excel/utils/xlsb-validator";
import type { XlsbProblemKind } from "@excel/utils/xlsb-validator/types";
import { encodeBiffRecord, encodeRange, iterateBiffRecords } from "@excel/xlsb/binary";
import {
  bookView,
  calculationProperties,
  fileVersion,
  selection,
  workbookProperties,
  worksheetView
} from "@excel/xlsb/defaults";
import { encodeSheetFormatInfo } from "@excel/xlsb/page-setup";
import { encodeSheetProperties } from "@excel/xlsb/sheet-properties";
import { recordSpec } from "@excel/xlsb/spec/records";
import {
  appendGarbage,
  biff,
  overstateLength,
  patchField,
  removeRecord,
  rowHeader,
  truncateInside,
  type BiffRecordFixture
} from "@test/biff-fixture";
import { describe, expect, it } from "vitest";

const SHEET_PATH = "xl/worksheets/sheet1.bin";

/** A minimal but structurally valid worksheet, used as the base for every mutation. */
/**
 * A worksheet part shaped the way Excel shapes one.
 *
 * The view records and `BrtWsProp` are here because a sheet without them is one Excel declines to
 * open, which `record-missing-required` now warns about. Leaving them out would make every fixture
 * in this file carry a second problem alongside the one it is testing — and a single-violation test
 * that reports two problems has stopped being one.
 */
function validSheet(cells: readonly BiffRecordFixture[] = []): Uint8Array {
  return biff([
    ["BrtBeginSheet"],
    ["BrtWsProp", encodeSheetProperties(undefined)],
    ["BrtWsDim", { ref: { firstRow: 0, lastRow: 1, firstColumn: 0, lastColumn: 1 } }],
    ["BrtBeginWsViews"],
    ["BrtBeginWsView", worksheetView()],
    ["BrtSel", selection()],
    ["BrtEndWsView"],
    ["BrtEndWsViews"],
    ["BrtWsFmtInfo", encodeSheetFormatInfo(undefined)],
    ["BrtBeginSheetData"],
    ["BrtRowHdr", rowHeader({ row: 0 })],
    ...(cells.length > 0
      ? cells
      : ([["BrtCellBlank", { cell: { column: 0, styleIndex: 0 } }]] as const)),
    ["BrtEndSheetData"],
    ["BrtEndSheet"]
  ]);
}

function kinds(bytes: Uint8Array, part = SHEET_PATH, includeWarnings = false): XlsbProblemKind[] {
  return validateXlsbPart(bytes, part, { includeWarnings }).problems.map(problem => problem.kind);
}

describe("framing", () => {
  it("rejects an empty part", () => {
    expect(kinds(new Uint8Array(0))).toEqual(["framing-empty-part"]);
  });

  it("reports a payload that overruns the part, and stops there", () => {
    // Stopping matters: past a bad length the reader is no longer aligned to a record
    // boundary, so continuing would report a cascade of invented problems and bury
    // the real one.
    const problems = validateXlsbPart(
      truncateInside(validSheet(), "BrtWsDim"),
      SHEET_PATH
    ).problems;
    expect(problems.map(problem => problem.kind)).toEqual(["framing-payload-overrun"]);
    expect(problems[0]!.part).toBe(SHEET_PATH);
    expect(problems[0]!.message).toMatch(/declares 16 byte\(s\)/);
  });

  it("reports a declared length far beyond the part", () => {
    expect(kinds(overstateLength(validSheet(), "BrtWsDim", 1_000_000))).toEqual([
      "framing-payload-overrun"
    ]);
  });

  it("reports an unterminated record header at the end of the part", () => {
    expect(kinds(appendGarbage(validSheet(), Uint8Array.of(0x80)))).toEqual([
      "framing-truncated-header"
    ]);
  });

  it("carries the byte offset of the failure", () => {
    const problems = validateXlsbPart(
      appendGarbage(validSheet(), Uint8Array.of(0x80)),
      SHEET_PATH
    ).problems;
    expect(problems[0]!.offset).toBeGreaterThan(0);
  });
});

describe("scopes", () => {
  it("reports a scope that is never closed", () => {
    // The single most valuable check here. Every record after the missing delimiter is
    // still perfectly well-framed, so nothing else notices, and Excel's own message
    // names neither the part nor the offset.
    //
    // One missing delimiter produces two problems, and both are true: the surviving
    // BrtEndSheet is consumed by BrtBeginSheetData (a mismatch), which then leaves
    // BrtBeginSheet with nothing to close it. Reporting only the first would hide
    // that the part has no closing delimiter at all.
    const problems = validateXlsbPart(
      removeRecord(validSheet(), "BrtEndSheetData"),
      SHEET_PATH
    ).problems;
    expect(problems.map(problem => problem.kind)).toEqual(["scope-mismatched", "scope-unclosed"]);
    expect(problems[0]!.message).toMatch(
      /BrtEndSheet closes BrtBeginSheetData, which expects BrtEndSheetData/
    );
    expect(problems[1]!.message).toMatch(/BrtBeginSheet is never closed by BrtEndSheet/);
  });

  it("reports only an unclosed scope when nothing is left to mis-close", () => {
    const problems = validateXlsbPart(
      biff([
        ["BrtBeginSheet"],
        ["BrtWsDim", { ref: { firstRow: 0, lastRow: 0, firstColumn: 0, lastColumn: 0 } }],
        ["BrtBeginSheetData"],
        ["BrtEndSheetData"]
      ]),
      SHEET_PATH
    ).problems;
    expect(problems.map(p => p.kind)).toEqual(["scope-unclosed"]);
    expect(problems[0]!.message).toMatch(/BrtBeginSheet is never closed/);
  });

  it("reports a delimiter that closes nothing", () => {
    const stream = biff([["BrtBeginSheet"], ["BrtEndSheet"], ["BrtEndSheet"]]);
    expect(kinds(stream)).toContain("scope-unopened");
  });

  it("reports crossed nesting", () => {
    // Balanced by count, wrong by structure — a check that only counted delimiters
    // would pass this.
    const stream = biff([
      ["BrtBeginSheet"],
      ["BrtBeginSheetData"],
      ["BrtEndSheet"],
      ["BrtEndSheetData"]
    ]);
    const problems = validateXlsbPart(stream, SHEET_PATH).problems;
    expect(problems.map(p => p.kind)).toContain("scope-mismatched");
    expect(problems.find(p => p.kind === "scope-mismatched")!.message).toMatch(
      /BrtEndSheet closes BrtBeginSheetData, which expects BrtEndSheetData/
    );
  });

  it("reports every unclosed scope, innermost first", () => {
    const stream = biff([["BrtBeginSheet"], ["BrtBeginSheetData"], ["BrtBeginMergeCells"]]);
    const messages = validateXlsbPart(stream, SHEET_PATH)
      .problems.filter(p => p.kind === "scope-unclosed")
      .map(p => p.message);
    expect(messages[0]).toMatch(/BrtBeginMergeCells/);
    expect(messages.at(-1)).toMatch(/BrtBeginSheet/);
  });

  it("does not treat future-record wrappers as structural scopes", () => {
    // These carry things a consumer may not understand and legitimately appear inside
    // records that are not containers. Counting them as scopes would make every file
    // using a newer feature look mis-nested.
    const stream = biff([
      ["BrtBeginSheet"],
      ["BrtFRTBegin", new Uint8Array(4)],
      ["BrtFRTEnd"],
      ["BrtBeginSheetData"],
      ["BrtRowHdr", rowHeader({ row: 0, heightTwips: 0 })],
      ["BrtEndSheetData"],
      ["BrtEndSheet"]
    ]);
    expect(kinds(stream)).toEqual([]);
  });
});

describe("ordering", () => {
  it("requires the part to open with the scope its role implies", () => {
    const stream = biff([["BrtBeginSheetData"], ["BrtEndSheetData"]]);
    expect(kinds(stream)).toContain("scope-missing-root");
  });

  it("requires BrtWsDim before the cell data it describes", () => {
    // A consumer sizes its buffers from the used range, so a dimension arriving after
    // the cells defeats its purpose.
    const stream = biff([
      ["BrtBeginSheet"],
      ["BrtBeginSheetData"],
      ["BrtRowHdr", rowHeader({ row: 0, heightTwips: 0 })],
      ["BrtEndSheetData"],
      ["BrtWsDim", { ref: { firstRow: 0, lastRow: 0, firstColumn: 0, lastColumn: 0 } }],
      ["BrtEndSheet"]
    ]);
    expect(kinds(stream)).toContain("ordering-out-of-place");
  });

  it("rejects a cell outside BrtBeginSheetData", () => {
    const stream = biff([
      ["BrtBeginSheet"],
      ["BrtCellBlank", { cell: { column: 0, styleIndex: 0 } }],
      ["BrtEndSheet"]
    ]);
    expect(kinds(stream)).toContain("ordering-outside-scope");
  });

  it("rejects a cell that precedes every row header", () => {
    // A cell carries a column but not a row; without a preceding BrtRowHdr it belongs
    // to no row at all, and a reader would either drop it or attach it to the wrong one.
    const stream = biff([
      ["BrtBeginSheet"],
      ["BrtWsDim", { ref: { firstRow: 0, lastRow: 0, firstColumn: 0, lastColumn: 0 } }],
      ["BrtBeginSheetData"],
      ["BrtCellBlank", { cell: { column: 0, styleIndex: 0 } }],
      ["BrtEndSheetData"],
      ["BrtEndSheet"]
    ]);
    const problems = validateXlsbPart(stream, SHEET_PATH).problems;
    expect(problems.map(p => p.kind)).toContain("ordering-outside-scope");
    expect(problems.find(p => p.kind === "ordering-outside-scope")!.message).toMatch(
      /belongs to no row/
    );
  });

  it("checks the styles part against its own expectations, not a worksheet's", () => {
    // Number formats are indexed by cell formats, so they must be declared first.
    const styles = biff([
      ["BrtBeginStyleSheet"],
      ["BrtBeginCellXFs", { count: 0 }],
      ["BrtEndCellXFs"],
      ["BrtBeginFmts", { count: 0 }],
      ["BrtEndFmts"],
      ["BrtEndStyleSheet"]
    ]);
    expect(kinds(styles, "xl/styles.bin")).toContain("ordering-out-of-place");
  });
});

describe("coordinates", () => {
  it("rejects a row beyond the grid", () => {
    expect(kinds(patchField(validSheet(), "BrtRowHdr", "rw", 1_048_576))).toContain(
      "coordinate-row-out-of-range"
    );
  });

  it("accepts the last valid row", () => {
    // An off-by-one in the bound would make this fire, which would be worse than not
    // checking: it would reject files Excel accepts.
    expect(kinds(patchField(validSheet(), "BrtRowHdr", "rw", 1_048_575))).not.toContain(
      "coordinate-row-out-of-range"
    );
  });

  it("rejects a column beyond the grid", () => {
    const stream = validSheet([["BrtCellBlank", { cell: { column: 16_384, styleIndex: 0 } }]]);
    expect(kinds(stream)).toContain("coordinate-column-out-of-range");
  });

  it("rejects row headers that do not ascend", () => {
    // Required to ascend, and a streaming reader has to trust it — when they do not,
    // the result is a silently scrambled sheet rather than an error.
    const stream = biff([
      ["BrtBeginSheet"],
      ["BrtWsDim", { ref: { firstRow: 0, lastRow: 5, firstColumn: 0, lastColumn: 0 } }],
      ["BrtBeginSheetData"],
      ["BrtRowHdr", rowHeader({ row: 5, heightTwips: 0 })],
      ["BrtRowHdr", rowHeader({ row: 2, heightTwips: 0 })],
      ["BrtEndSheetData"],
      ["BrtEndSheet"]
    ]);
    expect(kinds(stream)).toContain("coordinate-row-out-of-order");
  });

  it("rejects an inverted range", () => {
    const inverted = encodeRange({ firstRow: 5, lastRow: 1, firstColumn: 0, lastColumn: 0 });
    const stream = biff([
      ["BrtBeginSheet"],
      ["BrtWsDim", inverted],
      ["BrtBeginSheetData"],
      ["BrtEndSheetData"],
      ["BrtEndSheet"]
    ]);
    expect(kinds(stream)).toContain("coordinate-range-inverted");
  });

  it("warns when cells fall outside the declared used range", () => {
    const stream = biff([
      ["BrtBeginSheet"],
      ["BrtWsDim", { ref: { firstRow: 0, lastRow: 0, firstColumn: 0, lastColumn: 0 } }],
      ["BrtBeginSheetData"],
      ["BrtRowHdr", rowHeader({ row: 9, heightTwips: 0 })],
      ["BrtCellBlank", { cell: { column: 0, styleIndex: 0 } }],
      ["BrtEndSheetData"],
      ["BrtEndSheet"]
    ]);
    expect(kinds(stream, SHEET_PATH, true)).toContain("coordinate-dimension-mismatch");
    // A warning, so it must not affect `ok`: Excel recovers from this.
    expect(validateXlsbPart(stream, SHEET_PATH, { includeWarnings: true }).ok).toBe(true);
  });

  it("does not warn when the declared range is merely wider than the cells", () => {
    // Excel writes this itself, after formatting is applied and then cleared. Firing
    // here would make the check useless on real files.
    // Built through `validSheet` so the only thing unusual about it is the wide dimension: a
    // hand-rolled stream would also be missing the records Excel always writes, and this test
    // asserts an empty problem list.
    const stream = patchField(validSheet(), "BrtWsDim", "ref", {
      firstRow: 0,
      lastRow: 500,
      firstColumn: 0,
      lastColumn: 20
    });
    expect(kinds(stream, SHEET_PATH, true)).toEqual([]);
  });
});

describe("indexes", () => {
  const sst = (unique: number, items: number): BiffRecordFixture[] => [
    ["BrtBeginSst", { cstTotal: unique, cstUnique: unique }],
    ...Array.from({ length: items }, () => ["BrtSSTItem", new Uint8Array(0)] as BiffRecordFixture),
    ["BrtEndSst"]
  ];

  it("rejects a shared-string count that disagrees with the items present", () => {
    expect(kinds(biff(sst(3, 2)), "xl/sharedStrings.bin")).toContain("index-count-mismatch");
  });

  it("accepts a count that matches", () => {
    expect(kinds(biff(sst(2, 2)), "xl/sharedStrings.bin")).toEqual([]);
  });

  it("rejects unique strings exceeding the total", () => {
    // Swapping the two counts makes every later bounds check wrong in the permissive
    // direction, which is the worst way for a check to be wrong.
    const stream = biff([
      ["BrtBeginSst", { cstTotal: 1, cstUnique: 5 }],
      ...Array.from({ length: 5 }, () => ["BrtSSTItem", new Uint8Array(0)] as BiffRecordFixture),
      ["BrtEndSst"]
    ]);
    expect(kinds(stream, "xl/sharedStrings.bin")).toContain("index-count-mismatch");
  });

  it("rejects a cell format index past the end of the table", () => {
    const styles = biff([
      ["BrtBeginStyleSheet"],
      ["BrtBeginCellXFs", { count: 5 }],
      ["BrtEndCellXFs"],
      ["BrtEndStyleSheet"]
    ]);
    expect(kinds(styles, "xl/styles.bin")).toContain("index-count-mismatch");
  });

  it("checks a worksheet's shared-string references against a supplied count", () => {
    // The counts come from another part, so they are passed in. An earlier version of
    // this test put BrtBeginSst inside the worksheet stream to make the single-part
    // entry point find one, which is a part that could not exist — the test was
    // describing the workaround rather than the behaviour.
    const part = validSheet([["BrtCellIsst", { cell: { column: 0, styleIndex: 0 }, isst: 7 }]]);
    const report = validateXlsbPart(part, SHEET_PATH, { counts: { sharedStrings: 2 } });
    expect(report.problems.map(p => p.kind)).toEqual(["index-shared-string-out-of-range"]);
    expect(report.problems[0]!.message).toMatch(/references shared string 7, but only 2 exist/);
  });

  it("does not check a reference when no count is available", () => {
    // Nothing to compare against is not the same as out of range, and inventing a
    // bound would be a guess.
    const part = validSheet([["BrtCellIsst", { cell: { column: 0, styleIndex: 0 }, isst: 7 }]]);
    expect(kinds(part)).toEqual([]);
  });

  it("checks a style reference against a supplied count, wherever the record keeps it", () => {
    // A cell holds its style inside the Cell struct; a row header holds it as `ixfe`.
    // Both are read from the declared layout rather than from a list of record names.
    const cellStyle = validSheet([["BrtCellBlank", { cell: { column: 0, styleIndex: 9 } }]]);
    expect(
      validateXlsbPart(cellStyle, SHEET_PATH, { counts: { cellFormats: 3 } }).problems.map(
        p => p.kind
      )
    ).toEqual(["index-style-out-of-range"]);

    const rowStyle = biff([
      ["BrtBeginSheet"],
      ["BrtWsDim", { ref: { firstRow: 0, lastRow: 0, firstColumn: 0, lastColumn: 0 } }],
      ["BrtBeginSheetData"],
      ["BrtRowHdr", rowHeader({ row: 0, styleIndex: 9 })],
      ["BrtEndSheetData"],
      ["BrtEndSheet"]
    ]);
    const report = validateXlsbPart(rowStyle, SHEET_PATH, { counts: { cellFormats: 3 } });
    expect(report.problems.map(p => p.kind)).toEqual(["index-style-out-of-range"]);
    expect(report.problems[0]!.message).toMatch(/BrtRowHdr references cell format 9/);
  });

  it("treats style index 0 as always valid", () => {
    // The default format exists even when the styles part declares nothing, so a
    // check that required a table would reject every minimal workbook.
    expect(kinds(validSheet())).toEqual([]);
  });
});

describe("the checks are not vacuous", () => {
  it("finds nothing wrong with a valid worksheet", () => {
    const result = validateXlsbPart(validSheet(), SHEET_PATH, { includeWarnings: true });
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("finds nothing wrong with a valid styles part", () => {
    const styles = biff([
      ["BrtBeginStyleSheet"],
      ["BrtBeginFmts", { count: 0 }],
      ["BrtEndFmts"],
      ["BrtBeginFonts", { count: 0 }],
      ["BrtEndFonts"],
      ["BrtBeginFills", { count: 0 }],
      ["BrtEndFills"],
      ["BrtBeginBorders", { count: 0 }],
      ["BrtEndBorders"],
      ["BrtBeginCellXFs", { count: 1 }],
      ["BrtXF", new Uint8Array(16)],
      ["BrtEndCellXFs"],
      ["BrtEndStyleSheet"]
    ]);
    expect(validateXlsbPart(styles, "xl/styles.bin", { includeWarnings: true }).problems).toEqual(
      []
    );
  });

  it("counts records and unknown records", () => {
    const withUnknown = biff([
      ["BrtBeginSheet"],
      ["BrtWsDim", { ref: { firstRow: 0, lastRow: 0, firstColumn: 0, lastColumn: 0 } }],
      ["BrtBeginSheetData"],
      ["BrtEndSheetData"],
      ["BrtEndSheet"]
    ]);
    const stream = new Uint8Array([...withUnknown, ...encodeBiffRecord(0x0700, new Uint8Array(1))]);
    const stats = validateXlsbPart(stream, SHEET_PATH).stats;
    expect(stats.recordCount).toBe(6);
    expect(stats.unknownRecordCount).toBe(1);
  });

  it("does not reject a record it has never seen", () => {
    // An unknown record is a fact about this library, not about the file. Reporting it
    // as a problem would make the validator fire on every file using a feature newer
    // than the record table.
    const stream = new Uint8Array([
      ...biff([["BrtBeginSheet"]]),
      ...encodeBiffRecord(0x0700, new Uint8Array(4)),
      ...biff([["BrtEndSheet"]])
    ]);
    expect(kinds(stream)).toEqual([]);
  });

  it("honours maxProblems and says it was capped", () => {
    const stream = biff([
      ["BrtBeginSheet"],
      ["BrtBeginSheetData"],
      ["BrtBeginMergeCells", { cmcs: 0 }],
      ["BrtBeginAFilter"]
    ]);
    const result = validateXlsbPart(stream, SHEET_PATH, { maxProblems: 2 });
    expect(result.problems).toHaveLength(2);
    expect(result.capped).toBe(true);
  });

  it("suppresses warnings unless asked, and warnings never change ok", () => {
    // One warning, and exactly one: a row outside the declared dimension. Built from `validSheet`
    // so the record-completeness warning does not add a second and make "exactly one" a lie.
    const stream = patchField(validSheet(), "BrtRowHdr", "rw", 9);
    expect(validateXlsbPart(stream, SHEET_PATH).problems).toEqual([]);
    expect(validateXlsbPart(stream, SHEET_PATH, { includeWarnings: true }).problems).toHaveLength(
      1
    );
    expect(validateXlsbPart(stream, SHEET_PATH, { includeWarnings: true }).ok).toBe(true);
  });

  it("can have each check switched off independently", () => {
    const broken = removeRecord(validSheet(), "BrtEndSheetData");
    expect(kinds(broken)).toContain("scope-unclosed");
    expect(
      validateXlsbPart(broken, SHEET_PATH, { checkScopes: false }).problems.map(p => p.kind)
    ).not.toContain("scope-unclosed");
  });
});

describe("records every Excel-authored workbook contains", () => {
  /**
   * This check exists because of a gap the others could not close. A package satisfied framing,
   * scoping, ordering, coordinates and indexes — every rule this validator knew — and Excel refused
   * to open it. The difference against Excel's own output was never a wrong field: it was absence.
   * A workbook with no `BrtFileVersion`, or a worksheet with no view, is internally coherent and
   * unopenable, which is the worst combination for a validator to pass.
   */
  it("warns when a workbook part has no file version, book view or calc properties", async () => {
    const archive = new ZipArchive();
    archive.add(
      "[Content_Types].xml",
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="bin" ContentType="application/vnd.ms-excel.sheet.binary.macroEnabled.main"/>' +
        '<Override PartName="/xl/worksheets/sheet1.bin" ContentType="application/vnd.ms-excel.worksheet"/>' +
        "</Types>"
    );
    archive.add(
      "xl/workbook.bin",
      biff([
        ["BrtBeginBook"],
        ["BrtBeginBundleShs"],
        ["BrtBundleSh", { state: 0, tabId: 1, relId: "rId1", name: "S1" }],
        ["BrtEndBundleShs"],
        ["BrtEndBook"]
      ])
    );
    // A 31-byte worksheet declaring no view — the shape two of the reduced corpus files have, and
    // the shape this library used to write.
    archive.add(
      "xl/worksheets/sheet1.bin",
      biff([
        ["BrtBeginSheet"],
        ["BrtWsDim", { ref: { firstRow: 0, lastRow: 0, firstColumn: 0, lastColumn: 0 } }],
        ["BrtBeginSheetData"],
        ["BrtEndSheetData"],
        ["BrtEndSheet"]
      ])
    );

    const result = await validateXlsbBuffer(await archive.bytes(), { includeWarnings: true });
    const missing = result.problems
      .filter(problem => problem.kind === "record-missing-required")
      .map(problem => problem.message);
    for (const record of [
      "BrtFileVersion",
      "BrtWbProp",
      "BrtBeginBookViews",
      "BrtBookView",
      "BrtCalcProp",
      "BrtWsProp",
      "BrtBeginWsViews",
      "BrtBeginWsView",
      "BrtWsFmtInfo"
    ]) {
      expect(
        missing.some(message => message.includes(record)),
        `expected a warning naming ${record}`
      ).toBe(true);
    }
  });

  it("is a warning, so a reduced package still validates", async () => {
    // Two workbooks in the corpus are hand-reduced bug reports rather than Excel's output. They are
    // readable, and this validator is pointed at input as well as at output — so refusing them would
    // be refusing files this library reads correctly. The claim the warning makes is narrower and
    // true: a package lacking these has no evidence of being openable.
    const archive = new ZipArchive();
    archive.add(
      "[Content_Types].xml",
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="bin" ContentType="application/vnd.ms-excel.sheet.binary.macroEnabled.main"/>' +
        '<Override PartName="/xl/worksheets/sheet1.bin" ContentType="application/vnd.ms-excel.worksheet"/>' +
        "</Types>"
    );
    archive.add(
      "xl/workbook.bin",
      biff([
        ["BrtBeginBook"],
        ["BrtBeginBundleShs"],
        ["BrtBundleSh", { state: 0, tabId: 1, relId: "rId1", name: "S1" }],
        ["BrtEndBundleShs"],
        ["BrtEndBook"]
      ])
    );
    archive.add(
      "xl/worksheets/sheet1.bin",
      biff([
        ["BrtBeginSheet"],
        ["BrtWsDim", { ref: { firstRow: 0, lastRow: 0, firstColumn: 0, lastColumn: 0 } }],
        ["BrtBeginSheetData"],
        ["BrtEndSheetData"],
        ["BrtEndSheet"]
      ])
    );
    const bytes = await archive.bytes();
    expect((await validateXlsbBuffer(bytes)).ok).toBe(true);
    expect((await validateXlsbBuffer(bytes, { includeWarnings: true })).ok).toBe(true);
  });

  it("finds nothing to warn about in this library's own output", async () => {
    const workbook = Workbook.create();
    Cell.setValue(Workbook.addWorksheet(workbook, "S"), "A1", 1);
    const result = await validateXlsbBuffer(await Workbook.toBuffer(workbook, { format: "xlsb" }), {
      includeWarnings: true
    });
    expect(result.problems).toEqual([]);
  });
});

describe("payload lengths Excel never varies", () => {
  /**
   * This check exists because of a whole class of defect the rest of the validator could not see.
   * A record of the wrong length is perfectly consistent with itself, so framing, scoping, ordering,
   * coordinates and indexes all pass it. Three such records shipped:
   *
   * - `BrtRowHdr` was written as twelve bytes where Excel writes twenty-five, omitting the column
   *   span every row header carries. Every row in every file this library produced was truncated.
   * - `BrtBeginColInfos` carried a four-byte count where Excel's payload is empty — unlike the
   *   styles collections, which do carry one.
   * - `BrtWbProp` was four bytes short of its trailing code name.
   *
   * Each produced a package this validator accepted and Excel refused to open, which is the worst
   * outcome a validator can have: it certified the thing it exists to catch.
   */
  it("reports a record that is too short", () => {
    const stream = biff([
      ["BrtBeginSheet"],
      ["BrtWsProp", encodeSheetProperties(undefined)],
      ["BrtWsDim", { ref: { firstRow: 0, lastRow: 0, firstColumn: 0, lastColumn: 0 } }],
      ["BrtBeginWsViews"],
      ["BrtBeginWsView", worksheetView()],
      ["BrtSel", selection()],
      ["BrtEndWsView"],
      ["BrtEndWsViews"],
      ["BrtWsFmtInfo", encodeSheetFormatInfo(undefined)],
      ["BrtBeginSheetData"],
      // Twelve bytes, which is exactly what this library used to write.
      ["BrtRowHdr", new Uint8Array(12)],
      ["BrtEndSheetData"],
      ["BrtEndSheet"]
    ]);
    const result = validateXlsbPart(stream, SHEET_PATH);
    expect(result.problems.map(problem => problem.kind)).toContain(
      "framing-unexpected-payload-size"
    );
    expect(result.problems[0]!.message).toMatch(/BrtRowHdr is 12 byte\(s\); .* is 25/);
  });

  it("reports a collection header carrying a count Excel does not write", () => {
    const stream = biff([
      ["BrtBeginStyleSheet"],
      ["BrtBeginFonts", { count: 0 }],
      ["BrtEndFonts"],
      ["BrtEndStyleSheet"]
    ]);
    // The styles collections *do* carry a count, so this one is correct and must not be reported —
    // the rule is per record, not per part, and getting that backwards would make it useless.
    expect(validateXlsbPart(stream, "xl/styles.bin").problems).toEqual([]);
  });

  it("is silent on records whose length legitimately varies", () => {
    // A record holding a string has no fixed length, so it is absent from the table rather than
    // approximated. `BrtBundleSh` carries two of them.
    const stream = biff([
      ["BrtBeginBook"],
      ["BrtFileVersion", fileVersion()],
      ["BrtWbProp", workbookProperties(false)],
      ["BrtBeginBookViews"],
      ["BrtBookView", bookView()],
      ["BrtEndBookViews"],
      ["BrtBeginBundleShs"],
      ["BrtBundleSh", { state: 0, tabId: 1, relId: "rId1", name: "a much longer sheet name" }],
      ["BrtEndBundleShs"],
      ["BrtCalcProp", calculationProperties()],
      ["BrtEndBook"]
    ]);
    expect(validateXlsbPart(stream, "xl/workbook.bin").problems).toEqual([]);
  });

  it("finds nothing wrong with this library's own output", async () => {
    const workbook = Workbook.create();
    const sheet = Workbook.addWorksheet(workbook, "S");
    Cell.setValue(sheet, "A1", 1);
    Cell.setValue(sheet, "D9", "text");
    const result = await validateXlsbBuffer(await Workbook.toBuffer(workbook, { format: "xlsb" }), {
      includeWarnings: true
    });
    expect(result.problems).toEqual([]);
  });

  describe("a conditional-formatting rule's dxfId", () => {
    it("is reported when it names a differential format the styles part does not declare", async () => {
      // **Cross-part, which is why nothing saw it.** The rule lives in a worksheet and the table it indexes lives
      // in `styles.bin`, so neither part is wrong on its own — Excel reports `Repaired Records: Conditional
      // formatting`, once per sheet holding a bad reference. Found by grafting this library's `styles.bin` into a
      // workbook Excel had repaired: Excel's sheets name dxfId 10–28 and the grafted table held ten formats, and
      // the five sheets Excel repaired were exactly the five holding an out-of-range reference.
      //
      // Built by writing a real workbook and then shrinking its `DXFs` collection, so the rule and the table come
      // from the writer rather than from a hand-made fixture that could be wrong in its own way.
      const workbook = Workbook.create();
      const sheet = Workbook.addWorksheet(workbook, "S");
      Cell.setValue(sheet, "A1", 1);
      Worksheet.addConditionalFormatting(sheet, {
        ref: "A1",
        rules: [
          { type: "expression", priority: 1, formulae: ["TRUE"], style: { font: { bold: true } } }
        ]
      } as never);
      const bytes = await Workbook.toBuffer(workbook, { format: "xlsb", unsupported: "ignore" });

      // Sanity: as written, the reference is in range.
      expect((await validateXlsbBuffer(bytes)).problems.map(problem => problem.kind)).not.toContain(
        "index-dxf-out-of-range"
      );

      // Now declare zero differential formats while leaving the rule alone.
      const parts = await extractAll(bytes);
      const patched = Uint8Array.from(parts.get("xl/styles.bin")!.data);
      // `payload` is a view onto the copy, so writing through it edits the part in place — no need to know
      // how wide the record's own header happened to be.
      const marker = [...iterateBiffRecords(patched, "xl/styles.bin")].find(
        record => recordSpec(record.id)?.name === "BrtBeginDXFs"
      )!;
      new DataView(marker.payload.buffer, marker.payload.byteOffset, 4).setUint32(0, 0, true);
      const archive = new ZipArchive();
      for (const [name, entry] of parts) {
        archive.add(name, name === "xl/styles.bin" ? patched : entry.data);
      }
      const report = await validateXlsbBuffer(await archive.bytes());
      expect(report.problems.map(problem => problem.kind)).toContain("index-dxf-out-of-range");
    });
  });
});
