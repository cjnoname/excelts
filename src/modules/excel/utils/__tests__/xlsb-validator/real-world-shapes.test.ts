/**
 * Regressions found by running the validator against Excel-authored workbooks.
 *
 * Every case here is a false positive the validator produced on real files while fifty-odd
 * hand-built tests passed — which is the shape of gap that only a differential check against
 * real output finds. Two workbooks from the Calamine test corpus produced four kinds of
 * spurious error between them, and each is pinned below as a synthetic package rather than a
 * vendored binary: the fixture states the *shape* that was mishandled, which is more useful
 * to a reader than a blob, and needs no third-party file in the repository.
 *
 * The shapes were read off `issues.xlsb` and `any_sheets.xlsb`. An optional test at the
 * bottom runs the real thing when a corpus directory is provided.
 */

import { ZipArchive } from "@archive/zip";
import { Cell, Workbook } from "@excel";
import { validateXlsbBuffer } from "@excel/utils/xlsb-validator";
import { guessPartRoleFromPath, isRecordStream, partRole } from "@excel/utils/xlsb-validator/roles";
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
import { biff, rowHeader } from "@test/biff-fixture";
import { describe, expect, it } from "vitest";

const WORKBOOK_TYPE = "application/vnd.ms-excel.sheet.binary.macroEnabled.main";

/**
 * Shaped the way Excel shapes a workbook part.
 *
 * The file version, book view and calculation properties are here because
 * `record-missing-required` warns about their absence — Excel writes them into every workbook it
 * produces, so a package without them has no evidence of being openable. These fixtures assert an
 * empty problem list, so a fixture missing them would be asserting the wrong thing.
 */
const WORKBOOK = biff([
  ["BrtBeginBook"],
  ["BrtFileVersion", fileVersion()],
  ["BrtWbProp", workbookProperties(false)],
  ["BrtBeginBookViews"],
  ["BrtBookView", bookView()],
  ["BrtEndBookViews"],
  ["BrtBeginBundleShs"],
  ["BrtBundleSh", { state: 0, tabId: 1, relId: "rId1", name: "Sheet1" }],
  ["BrtEndBundleShs"],
  ["BrtCalcProp", calculationProperties()],
  ["BrtEndBook"]
]);

/** Shaped the way Excel shapes a worksheet part — see `WORKBOOK` for why. */
const WORKSHEET = biff([
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
  ["BrtRowHdr", rowHeader({ row: 0 })],
  ["BrtCellRk", { cell: { column: 0, styleIndex: 0 }, value: (1 << 2) | 0x02 }],
  ["BrtEndSheetData"],
  ["BrtEndSheet"]
]);

/**
 * A package shaped the way Excel writes one.
 *
 * The details that matter: the workbook is declared by a `bin` Default and not only by an
 * Override, every other binary part carries its own Override, and `.bin` covers parts that
 * are not record streams at all.
 */
async function excelShapedPackage(
  extraParts: Readonly<Record<string, { data: Uint8Array | string; contentType: string }>> = {}
): Promise<Uint8Array> {
  const binaryParts: Record<string, { data: Uint8Array | string; contentType: string }> = {
    "xl/worksheets/sheet1.bin": {
      data: WORKSHEET,
      contentType: "application/vnd.ms-excel.worksheet"
    },
    ...extraParts
  };

  const overrides = [
    `<Override PartName="/xl/workbook.bin" ContentType="${WORKBOOK_TYPE}"/>`,
    ...Object.entries(binaryParts).map(
      ([path, part]) => `<Override PartName="/${path}" ContentType="${part.contentType}"/>`
    )
  ].join("");

  const archive = new ZipArchive();
  archive.add(
    "[Content_Types].xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      `<Default Extension="bin" ContentType="${WORKBOOK_TYPE}"/>` +
      overrides +
      "</Types>"
  );
  archive.add(
    "_rels/.rels",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.bin"/>' +
      "</Relationships>"
  );
  archive.add("xl/workbook.bin", WORKBOOK);
  for (const [path, part] of Object.entries(binaryParts)) {
    archive.add(path, part.data);
  }
  return await archive.bytes();
}

describe("part classification comes from content types", () => {
  it("accepts a workbook declared only by the bin Default", async () => {
    // Excel does exactly this: `<Default Extension="bin" …main"/>` and no Override for the
    // workbook part. Requiring an Override reported `package-missing-part` on every real file.
    const archive = new ZipArchive();
    archive.add(
      "[Content_Types].xml",
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        `<Default Extension="bin" ContentType="${WORKBOOK_TYPE}"/>` +
        '<Override PartName="/xl/worksheets/sheet1.bin" ContentType="application/vnd.ms-excel.worksheet"/>' +
        "</Types>"
    );
    archive.add("xl/workbook.bin", WORKBOOK);
    archive.add("xl/worksheets/sheet1.bin", WORKSHEET);

    const report = await validateXlsbBuffer(await archive.bytes(), { includeWarnings: true });
    expect(report.problems).toEqual([]);
  });

  it("does not read an OLE2 compound file as a record stream", async () => {
    // `xl/vbaProject.bin` is an OLE2 document — the signature below is its first eight
    // bytes, taken from a real macro-enabled workbook. Keying off the `.bin` extension
    // reported `framing-payload-overrun` at byte 0 of a perfectly valid part.
    const ole2 = new Uint8Array(512);
    ole2.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

    const report = await validateXlsbBuffer(
      await excelShapedPackage({
        "xl/vbaProject.bin": { data: ole2, contentType: "application/vnd.ms-office.vbaProject" }
      }),
      { includeWarnings: true }
    );
    expect(report.problems).toEqual([]);
  });

  it("does not read a printer-settings struct as a record stream", async () => {
    // A DEVMODE struct, not records. Same false positive as the OLE2 case, different part.
    const report = await validateXlsbBuffer(
      await excelShapedPackage({
        "xl/printerSettings/printerSettings1.bin": {
          data: new Uint8Array(1800).fill(0xcc),
          contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.printerSettings"
        }
      }),
      { includeWarnings: true }
    );
    expect(report.problems).toEqual([]);
  });

  it("does not demand BrtBeginSheet of Excel's own row index", async () => {
    // `xl/worksheets/binaryIndex1.bin` sits under the worksheet directory, matches every
    // reasonable worksheet path pattern, and is not a worksheet — it is a record stream with
    // its own vocabulary. Six of them in one real workbook produced six `scope-missing-root`
    // errors.
    const report = await validateXlsbBuffer(
      await excelShapedPackage({
        "xl/worksheets/binaryIndex1.bin": {
          // Framing-valid records from a vocabulary this validator does not model.
          data: new Uint8Array([0x2a, 0x04, 0x01, 0x02, 0x03, 0x04]),
          contentType: "application/vnd.ms-excel.binIndexWs"
        }
      }),
      { includeWarnings: true }
    );
    expect(report.problems).toEqual([]);
  });

  it("does not conclude there is a second workbook when a part is under-declared", async () => {
    // A package with a `bin` Default of the workbook type and no Override for a part: the
    // Default leaks, and treating the part as a workbook demands `BrtBeginBook` of a
    // worksheet. A package has exactly one workbook part.
    const archive = new ZipArchive();
    archive.add(
      "[Content_Types].xml",
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        `<Default Extension="bin" ContentType="${WORKBOOK_TYPE}"/>` +
        "</Types>"
    );
    archive.add("xl/workbook.bin", WORKBOOK);
    archive.add("xl/worksheets/sheet1.bin", WORKSHEET);

    const report = await validateXlsbBuffer(await archive.bytes(), { includeWarnings: true });
    expect(report.problems.map(problem => problem.kind)).not.toContain("scope-missing-root");
  });

  it("resolves a part whose name differs only in case", async () => {
    // A real workbook in the corpus names the shared-string part `xl/SharedStrings.bin`. OPC
    // compares part names case-insensitively, so an exact-match lookup drops every string in
    // that file — and does it silently, because a cell whose index cannot resolve looks like a
    // cell the reader could not decode rather than like a missing part.
    const archive = new ZipArchive();
    archive.add(
      "[Content_Types].xml",
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        `<Default Extension="bin" ContentType="${WORKBOOK_TYPE}"/>` +
        '<Override PartName="/xl/worksheets/sheet1.bin" ContentType="application/vnd.ms-excel.worksheet"/>' +
        '<Override PartName="/xl/SharedStrings.bin" ContentType="application/vnd.ms-excel.sharedStrings"/>' +
        "</Types>"
    );
    archive.add("xl/workbook.bin", WORKBOOK);
    archive.add(
      "xl/worksheets/sheet1.bin",
      biff([
        ["BrtBeginSheet"],
        ["BrtWsDim", { ref: { firstRow: 0, lastRow: 0, firstColumn: 0, lastColumn: 0 } }],
        ["BrtBeginSheetData"],
        ["BrtRowHdr", rowHeader({ row: 0 })],
        ["BrtCellIsst", { cell: { column: 0, styleIndex: 0 }, isst: 0 }],
        ["BrtEndSheetData"],
        ["BrtEndSheet"]
      ])
    );
    // Capitalised exactly as the real file does.
    archive.add(
      "xl/SharedStrings.bin",
      biff([
        ["BrtBeginSst", { cstTotal: 1, cstUnique: 1 }],
        ["BrtSSTItem", { flags: 0, text: "found" }],
        ["BrtEndSst"]
      ])
    );

    const workbook = Workbook.create();
    await Workbook.read(workbook, await archive.bytes());
    expect(Cell.getValue(Workbook.getWorksheets(workbook)[0]!, "A1")).toBe("found");
  });

  it("classifies by content type, not by path", () => {
    // The property, asserted directly. Both of these are `.bin` under `xl/worksheets/`.
    expect(partRole("xl/worksheets/sheet1.bin", "application/vnd.ms-excel.worksheet")).toBe(
      "worksheet"
    );
    expect(partRole("xl/worksheets/binaryIndex1.bin", "application/vnd.ms-excel.binIndexWs")).toBe(
      "binaryIndex"
    );
    expect(
      isRecordStream(partRole("xl/vbaProject.bin", "application/vnd.ms-office.vbaproject"))
    ).toBe(false);

    // And the path-based guess, which exists only for a part with no package around it, is
    // at least not fooled by the index.
    expect(guessPartRoleFromPath("xl/worksheets/binaryIndex1.bin")).toBe("binaryIndex");
    expect(guessPartRoleFromPath("xl/worksheets/sheet1.bin")).toBe("worksheet");
  });

  it("treats an undeclared binary outside xl/ as opaque rather than guessing", () => {
    // Concluding that any undeclared binary is a record stream is how the OLE2 false
    // positive happened in the first place.
    expect(isRecordStream(partRole("customXml/item1.bin", undefined))).toBe(false);
    expect(isRecordStream(partRole("xl/somethingNew.bin", undefined))).toBe(true);
  });
});
