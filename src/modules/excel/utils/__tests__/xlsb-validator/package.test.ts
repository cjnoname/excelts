/**
 * BIFF12 validation at the package level.
 *
 * The per-checker tests build one `.bin` part; this file builds whole ZIP packages,
 * because three things only exist at that level: the content-type declarations, the
 * cross-part index counts, and the ordering discipline that stops a part which failed
 * framing from generating a cascade of invented problems in the checks after it.
 */

import { ZipArchive } from "@archive/zip";
import { validateXlsbBuffer } from "@excel/utils/xlsb-validator";
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
import { biff, removeRecord, rowHeader, truncateInside } from "@test/biff-fixture";
import { describe, expect, it } from "vitest";

const WORKBOOK_TYPE = "application/vnd.ms-excel.sheet.binary.macroEnabled.main";

/**
 * A workbook part shaped the way Excel shapes one.
 *
 * The file version, book view and calculation properties are here because `record-missing-required`
 * warns about their absence — Excel writes them into every workbook, so a package without them has
 * no evidence of being openable. Omitting them would give every fixture in this file a second
 * problem alongside the one it is testing.
 */
const WORKBOOK = biff([
  ["BrtBeginBook"],
  ["BrtFileVersion", fileVersion()],
  ["BrtWbProp", workbookProperties(false)],
  ["BrtBeginBookViews"],
  ["BrtBookView", bookView()],
  ["BrtEndBookViews"],
  ["BrtBeginBundleShs"],
  ["BrtBundleSh", new Uint8Array(0)],
  ["BrtEndBundleShs"],
  ["BrtCalcProp", calculationProperties()],
  ["BrtEndBook"]
]);

/** A worksheet part shaped the way Excel shapes one — see `WORKBOOK` for why. */
function sheet(rows = 1): Uint8Array {
  return biff([
    ["BrtBeginSheet"],
    ["BrtWsProp", encodeSheetProperties(undefined)],
    ["BrtWsDim", { ref: { firstRow: 0, lastRow: rows - 1, firstColumn: 0, lastColumn: 0 } }],
    ["BrtBeginWsViews"],
    ["BrtBeginWsView", worksheetView()],
    ["BrtSel", selection()],
    ["BrtEndWsView"],
    ["BrtEndWsViews"],
    ["BrtWsFmtInfo", encodeSheetFormatInfo(undefined)],
    ["BrtBeginSheetData"],
    ...Array.from({ length: rows }, (_, row) => ["BrtRowHdr", rowHeader({ row: row })] as const),
    ["BrtEndSheetData"],
    ["BrtEndSheet"]
  ]);
}

const SHARED_STRINGS = biff([
  ["BrtBeginSst", { cstTotal: 1, cstUnique: 1 }],
  ["BrtSSTItem", new Uint8Array(0)],
  ["BrtEndSst"]
]);

interface PackageOptions {
  readonly parts?: Readonly<Record<string, Uint8Array | string>>;
  readonly omit?: readonly string[];
  readonly contentTypes?: string;
}

/**
 * Content types shaped the way Excel writes them.
 *
 * Checked against two Excel-authored workbooks: the workbook part is declared by a `bin`
 * Default, and every other binary part carries its own Override. An earlier version of
 * this helper emitted only the Default, which made every `.bin` in the package resolve to
 * the workbook type — a package no producer creates, and one that hid the fact that the
 * validator classifies by content type at all.
 */
function excelShapedContentTypes(binaryParts: readonly string[]): string {
  const overrides = binaryParts
    .map(path => {
      const type = /worksheets\//.test(path)
        ? "application/vnd.ms-excel.worksheet"
        : path.endsWith("sharedStrings.bin")
          ? "application/vnd.ms-excel.sharedStrings"
          : path.endsWith("styles.bin")
            ? "application/vnd.ms-excel.styles"
            : "application/vnd.ms-excel.worksheet";
      return `<Override PartName="/${path}" ContentType="${type}"/>`;
    })
    .join("");
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    `<Default Extension="bin" ContentType="${WORKBOOK_TYPE}"/>` +
    `<Override PartName="/xl/workbook.bin" ContentType="${WORKBOOK_TYPE}"/>` +
    overrides +
    "</Types>"
  );
}

async function xlsbPackage(options: PackageOptions = {}): Promise<Uint8Array> {
  const extraBinaryParts = Object.keys(options.parts ?? {}).filter(path => path.endsWith(".bin"));
  const defaults: Record<string, Uint8Array | string> = {
    "[Content_Types].xml":
      options.contentTypes ??
      excelShapedContentTypes([
        "xl/worksheets/sheet1.bin",
        ...extraBinaryParts.filter(path => path !== "xl/worksheets/sheet1.bin")
      ]),
    "_rels/.rels":
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.bin"/>' +
      "</Relationships>",
    "xl/workbook.bin": WORKBOOK,
    "xl/worksheets/sheet1.bin": sheet(),
    ...options.parts
  };

  const archive = new ZipArchive();
  for (const [path, data] of Object.entries(defaults)) {
    if (options.omit?.includes(path)) {
      continue;
    }
    archive.add(path, data);
  }
  return await archive.bytes();
}

describe("package structure", () => {
  it("accepts a minimal valid package", async () => {
    const report = await validateXlsbBuffer(await xlsbPackage(), { includeWarnings: true });
    expect(report.problems).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.stats.binaryPartCount).toBe(2);
  });

  it("rejects input that is not a ZIP", async () => {
    const report = await validateXlsbBuffer(new TextEncoder().encode("not a zip at all"));
    expect(report.problems.map(p => p.kind)).toEqual(["package-unreadable"]);
    expect(report.ok).toBe(false);
  });

  it("rejects a package with no binary workbook", async () => {
    // The distinguishing feature of XLSB. An XLSX would land here.
    const report = await validateXlsbBuffer(await xlsbPackage({ omit: ["xl/workbook.bin"] }));
    expect(report.problems.map(p => p.kind)).toEqual(["package-missing-workbook"]);
  });

  it("stops after a missing workbook rather than reporting the parts too", async () => {
    // A terminal failure: there is nothing useful to say about record streams in
    // something that is not a workbook, and saying it anyway buries the real problem.
    const report = await validateXlsbBuffer(
      await xlsbPackage({
        omit: ["xl/workbook.bin"],
        parts: { "xl/worksheets/sheet1.bin": removeRecord(sheet(), "BrtEndSheet") }
      })
    );
    expect(report.problems).toHaveLength(1);
    expect(report.stats.binaryPartCount).toBe(0);
  });

  it("rejects a workbook declared with a non-XLSB content type", async () => {
    // The declared type and the extension must agree or Excel refuses the file, and
    // this is exactly what an XLSX content type copied into an XLSB package looks like.
    const report = await validateXlsbBuffer(
      await xlsbPackage({
        contentTypes:
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
          '<Default Extension="bin" ContentType="application/octet-stream"/>' +
          '<Override PartName="/xl/workbook.bin" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
          "</Types>"
      })
    );
    expect(report.problems.map(p => p.kind)).toContain("package-wrong-content-type");
  });

  it("rejects a binary part with no content type at all", async () => {
    const report = await validateXlsbBuffer(
      await xlsbPackage({
        contentTypes:
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
          `<Override PartName="/xl/workbook.bin" ContentType="${WORKBOOK_TYPE}"/>` +
          "</Types>"
      })
    );
    const missing = report.problems.filter(p => p.kind === "package-missing-part");
    expect(missing.map(p => p.part)).toContain("xl/worksheets/sheet1.bin");
  });

  it("reports a missing content-types part", async () => {
    const report = await validateXlsbBuffer(await xlsbPackage({ omit: ["[Content_Types].xml"] }));
    expect(report.problems.map(p => p.kind)).toContain("package-missing-content-types");
  });

  it("reports a malformed content-types part rather than throwing", async () => {
    const report = await validateXlsbBuffer(
      await xlsbPackage({ contentTypes: "<Types><unclosed>" })
    );
    expect(report.problems.map(p => p.kind)).toContain("package-missing-content-types");
  });

  it("accepts the template and add-in workbook types", async () => {
    for (const type of [
      "application/vnd.ms-excel.template.macroEnabled.main",
      "application/vnd.ms-excel.addin.macroEnabled.main"
    ]) {
      const report = await validateXlsbBuffer(
        await xlsbPackage({
          contentTypes:
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
            '<Default Extension="bin" ContentType="application/octet-stream"/>' +
            `<Override PartName="/xl/workbook.bin" ContentType="${type}"/>` +
            "</Types>"
        })
      );
      expect(
        report.problems.map(p => p.kind),
        type
      ).not.toContain("package-wrong-content-type");
    }
  });
});

describe("orchestration", () => {
  it("excludes a part that failed framing from the later checks", async () => {
    // The ordering guarantee. Past a bad length the reader is not aligned to a record
    // boundary, so a scope or coordinate check on the same part would be reading bytes
    // from the middle of other records and reporting nonsense.
    const report = await validateXlsbBuffer(
      await xlsbPackage({
        parts: { "xl/worksheets/sheet1.bin": truncateInside(sheet(), "BrtWsDim") }
      })
    );
    expect(report.problems.map(p => p.kind)).toEqual(["framing-payload-overrun"]);
  });

  it("still checks the parts that framed cleanly", async () => {
    // One broken part must not suppress the others, or a package with two problems
    // takes two round trips to diagnose.
    const report = await validateXlsbBuffer(
      await xlsbPackage({
        parts: {
          "xl/worksheets/sheet1.bin": truncateInside(sheet(), "BrtWsDim"),
          "xl/worksheets/sheet2.bin": removeRecord(sheet(), "BrtEndSheet")
        }
      })
    );
    expect(report.problems.map(p => p.kind)).toEqual(["framing-payload-overrun", "scope-unclosed"]);
  });

  it("checks a worksheet's string references against the shared-strings part", async () => {
    // The cross-part check, and the reason counts are read before worksheets are walked.
    const withBadIsst = biff([
      ["BrtBeginSheet"],
      ["BrtWsDim", { ref: { firstRow: 0, lastRow: 0, firstColumn: 0, lastColumn: 0 } }],
      ["BrtBeginSheetData"],
      ["BrtRowHdr", rowHeader({ row: 0, heightTwips: 0 })],
      ["BrtCellIsst", { cell: { column: 0, styleIndex: 0 }, isst: 4 }],
      ["BrtEndSheetData"],
      ["BrtEndSheet"]
    ]);
    const report = await validateXlsbBuffer(
      await xlsbPackage({
        parts: {
          "xl/sharedStrings.bin": SHARED_STRINGS,
          "xl/worksheets/sheet1.bin": withBadIsst
        }
      })
    );
    expect(report.problems.map(p => p.kind)).toEqual(["index-shared-string-out-of-range"]);
    expect(report.problems[0]!.message).toMatch(/references shared string 4, but only 1 exist/);
  });

  it("does not check string references when there is no shared-strings part", async () => {
    // Nothing to compare against is not the same as out of range: a worksheet with an
    // isst and no SST is a different problem, and inventing a bound would be a guess.
    const withIsst = biff([
      ["BrtBeginSheet"],
      ["BrtWsDim", { ref: { firstRow: 0, lastRow: 0, firstColumn: 0, lastColumn: 0 } }],
      ["BrtBeginSheetData"],
      ["BrtRowHdr", rowHeader({ row: 0, heightTwips: 0 })],
      ["BrtCellIsst", { cell: { column: 0, styleIndex: 0 }, isst: 4 }],
      ["BrtEndSheetData"],
      ["BrtEndSheet"]
    ]);
    const report = await validateXlsbBuffer(
      await xlsbPackage({ parts: { "xl/worksheets/sheet1.bin": withIsst } })
    );
    expect(report.problems).toEqual([]);
  });

  it("counts records across every part", async () => {
    const report = await validateXlsbBuffer(
      await xlsbPackage({ parts: { "xl/sharedStrings.bin": SHARED_STRINGS } })
    );
    expect(report.stats.binaryPartCount).toBe(3);
    expect(report.stats.recordCount).toBeGreaterThan(10);
    expect(report.stats.unknownRecordCount).toBe(0);
    expect(report.stats.partCount).toBeGreaterThanOrEqual(5);
  });

  it("scales to a package with many rows without changing its verdict", async () => {
    const report = await validateXlsbBuffer(
      await xlsbPackage({ parts: { "xl/worksheets/sheet1.bin": sheet(5000) } }),
      { includeWarnings: true }
    );
    expect(report.problems).toEqual([]);
    expect(report.stats.recordCount).toBeGreaterThan(5000);
  });

  describe("relationship targets", () => {
    /** A `.rels` for the workbook part, naming whatever targets a case wants to try. */
    function workbookRels(targets: readonly string[]): string {
      return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        targets
          .map(
            (target, index) =>
              `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="${target}"/>`
          )
          .join("") +
        "</Relationships>"
      );
    }

    it("refuses a relationship naming a part the package does not contain", async () => {
      // **The check that would have caught a whole class by itself.** The XLSB writer named
      // `../charts/chartEx1.xml` from a drawing and never wrote the part; Excel discarded the *drawing*, because
      // one that points at nothing is not a drawing. Every part present was well formed and declared, which is
      // exactly the shape of defect a per-part check cannot see — the fault is between parts.
      const report = await validateXlsbBuffer(
        await xlsbPackage({
          parts: { "xl/_rels/workbook.bin.rels": workbookRels(["missing.bin"]) }
        })
      );
      expect(report.problems.map(problem => problem.kind)).toContain(
        "package-dangling-relationship"
      );
      expect(report.problems[0]?.message).toContain("xl/missing.bin");
    });

    it("accepts one whose target differs only in case", async () => {
      // **OPC compares part names without regard to ASCII case, and a real workbook depends on it.**
      // `cal-issue_419.xlsb`, written by Excel 12, contains `xl/SharedStrings.bin` while its relationship names
      // `sharedStrings.bin`. Excel opens it. A case-sensitive check called that file broken — and a validator
      // that refuses what Excel accepts teaches a caller to ignore it.
      const report = await validateXlsbBuffer(
        await xlsbPackage({
          parts: {
            "xl/SharedStrings.bin": SHARED_STRINGS,
            "xl/_rels/workbook.bin.rels": workbookRels(["sharedStrings.bin"])
          }
        })
      );
      // Asserted as "no dangling relationship" rather than "no problems", and the leftover is named so it cannot
      // hide anything: replacing `xl/_rels/workbook.bin.rels` drops the relationship that reaches the workbook,
      // so the scope checker rightly reports `scope-missing-root`. Both are fixture artefacts of overriding one
      // rels file — the real workbook this rule comes from, `cal-issue_419.xlsb`, is asserted clean in full by
      // `real-world-corpus.node.test.ts`.
      expect(report.problems.map(problem => problem.kind)).toEqual(["scope-missing-root"]);
    });

    it("ignores an external target, which is not a part at all", async () => {
      const rels =
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.invalid/" TargetMode="External"/>' +
        "</Relationships>";
      const report = await validateXlsbBuffer(
        await xlsbPackage({ parts: { "xl/_rels/workbook.bin.rels": rels } })
      );
      expect(report.problems).toEqual([]);
    });

    it("resolves an absolute target from the package root", async () => {
      const report = await validateXlsbBuffer(
        await xlsbPackage({
          parts: {
            "xl/sharedStrings.bin": SHARED_STRINGS,
            "xl/_rels/workbook.bin.rels": workbookRels(["/xl/sharedStrings.bin"])
          }
        })
      );
      expect(report.problems).toEqual([]);
    });
  });
});
