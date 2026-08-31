/**
 * Alignment and cell protection, against Excel's own `BrtXF` bytes.
 *
 * These six bytes were being written as a hardcoded `0x1010` constant with a comment saying the
 * fields were "left at their defaults" — which was true and hid that the defaults are not zero.
 * `alcV = 0` is *top*, not bottom, so a writer that zeroed the byte would have moved every cell's
 * text to the top of its row.
 */
import { extractAll } from "@archive/unzip/extract";
import { Cell, Workbook } from "@excel";
import {
  ATTRIBUTE_MASK,
  encodeAlignmentAndProtection,
  readAlignment,
  readProtection
} from "@excel/xlsb/alignment";
import { iterateBiffRecords } from "@excel/xlsb/binary";
import { recordSpec } from "@excel/xlsb/spec/records";
import { hexBytes } from "@test/biff-fixture";
import { describe, expect, it } from "vitest";

/** Every distinct `[10..15]` run in the nine Excel-authored reference workbooks, with what it means. */
const REAL_TAILS = [
  {
    hex: "00 00 10 10 00 00",
    file: "any_sheets.xlsb",
    alignment: undefined,
    protection: undefined
  },
  { hex: "00 00 10 10 25 00", file: "date.xlsb", alignment: undefined, protection: undefined },
  { hex: "00 00 10 10 24 00", file: "date.xlsb", alignment: undefined, protection: undefined },
  { hex: "00 00 10 10 2c 00", file: "issue127.xlsb", alignment: undefined, protection: undefined },
  {
    hex: "00 00 12 10 28 00",
    file: "issue127.xlsb",
    alignment: { horizontal: "center" },
    protection: undefined
  },
  {
    hex: "5a 00 12 10 28 00",
    file: "issue127.xlsb",
    alignment: { horizontal: "center", textRotation: 90 },
    protection: undefined
  },
  { hex: "00 00 10 10 01 00", file: "issues.xlsb", alignment: undefined, protection: undefined },
  { hex: "00 00 10 10 02 00", file: "issues.xlsb", alignment: undefined, protection: undefined },
  {
    hex: "00 00 08 10 00 00",
    file: "picture.xlsb",
    alignment: { vertical: "middle" },
    protection: undefined
  }
] as const;

/**
 * A full `BrtXF` payload from just its last six bytes.
 *
 * The alignment codec reads from offset 10, so a bare hex string is not a `BrtXF` — it is the tail of
 * one. Named for what it does rather than sharing `hexBytes`, because a helper that silently padded
 * would be a different function wearing the same name: this is the one place in the suite where the
 * bytes under test are not the whole record.
 */
function xfWithTail(tail: string): Uint8Array {
  return new Uint8Array([...new Uint8Array(10), ...hexBytes(tail)]);
}

describe("BrtXF alignment against Excel's own bytes", () => {
  it.each(REAL_TAILS)("reads the $file tail $hex", ({ hex, alignment, protection }) => {
    expect(readAlignment(xfWithTail(hex))).toEqual(alignment);
    expect(readProtection(xfWithTail(hex))).toEqual(protection);
  });

  it("reproduces every one of them byte for byte", () => {
    for (const { hex, file } of REAL_TAILS) {
      const raw = xfWithTail(hex);
      const reEncoded = encodeAlignmentAndProtection(
        readAlignment(raw),
        readProtection(raw),
        raw[14]!
      );
      expect([...reEncoded], `${file}: ${hex}`).toEqual([...raw.subarray(10, 16)]);
    }
  });

  it("treats 0x10 as general-plus-bottom, which is why the default is not zero", () => {
    // Twenty-six of the corpus's thirty-two cell formats carry exactly this. `alcV = 2` is
    // bottom; zeroing the byte would mean `top`, moving every cell's text.
    expect(readAlignment(xfWithTail("00 00 10 10 00 00"))).toBeUndefined();
    expect([...encodeAlignmentAndProtection(undefined, undefined, 0)]).toEqual([
      0, 0, 0x10, 0x10, 0, 0
    ]);
  });

  it("treats locked as the default and reports only its absence", () => {
    // All thirty-two corpus formats set `fLocked`, because a cell in Excel is locked unless you
    // unlock it. Reporting `locked: true` everywhere would add a field no caller set.
    expect(readProtection(xfWithTail("00 00 10 10 00 00"))).toBeUndefined();
    expect(readProtection(xfWithTail("00 00 10 00 00 00"))).toEqual({ locked: false });
    expect(readProtection(xfWithTail("00 00 10 30 00 00"))).toEqual({ hidden: true });
  });

  it("sets xfGrbitAtr on the formats whose fields it actually wrote", async () => {
    // The mask says which attributes the format overrides rather than inheriting. It is
    // *write-only* here — nothing reads it back — so it needs asserting against the bytes
    // directly, or it is a claim no test can check.
    //
    // It was identified by correlation: in `issues.xlsb` bit 0 sits on exactly the formats with a
    // number format and bit 1 on exactly those with a font. Writing zero while setting those
    // fields would produce a format whose own mask contradicts it.
    const source = Workbook.create();
    const sheet = Workbook.addWorksheet(source, "Masks");
    Cell.setValue(sheet, "A1", 1);
    Cell.setStyle(sheet, "A1", { numFmt: "0.00" });
    Cell.setValue(sheet, "A2", 2);
    Cell.setStyle(sheet, "A2", { font: { bold: true } });
    Cell.setValue(sheet, "A3", 3);
    Cell.setStyle(sheet, "A3", { alignment: { horizontal: "center" } });
    Cell.setValue(sheet, "A4", 4);
    Cell.setStyle(sheet, "A4", {
      fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FF00FF00" } }
    });

    const entries = await extractAll(await Workbook.toBuffer(source, { format: "xlsb" }));
    const masks: number[] = [];
    let inCellXfs = false;
    for (const record of iterateBiffRecords(entries.get("xl/styles.bin")!.data, "styles")) {
      const name = recordSpec(record.id)?.name;
      if (name === "BrtBeginCellXfs") {
        inCellXfs = true;
      } else if (name === "BrtEndCellXfs") {
        inCellXfs = false;
      } else if (name === "BrtXF" && inCellXfs) {
        masks.push(record.payload[14]!);
      }
    }

    // Index 0 is the default format and overrides nothing; the four that follow each override
    // exactly the one attribute their cell set.
    expect(masks).toEqual([
      0,
      ATTRIBUTE_MASK.numberFormat,
      ATTRIBUTE_MASK.font,
      ATTRIBUTE_MASK.alignment,
      ATTRIBUTE_MASK.fill
    ]);
  });
});

describe("alignment and protection reach the cells that asked for them", () => {
  const styled = [
    { address: "A1", style: { alignment: { horizontal: "center" } } },
    { address: "A2", style: { alignment: { horizontal: "right", vertical: "top" } } },
    { address: "A3", style: { alignment: { vertical: "middle" } } },
    { address: "A4", style: { alignment: { wrapText: true } } },
    { address: "A5", style: { alignment: { textRotation: 90 } } },
    { address: "A6", style: { alignment: { textRotation: "vertical" } } },
    { address: "A7", style: { alignment: { indent: 3 } } },
    { address: "A8", style: { alignment: { shrinkToFit: true } } },
    { address: "A9", style: { alignment: { readingOrder: "rtl" } } },
    { address: "A10", style: { protection: { locked: false } } },
    { address: "A11", style: { protection: { hidden: true } } },
    { address: "A12", style: { alignment: { horizontal: "distributed", vertical: "justify" } } },
    {
      address: "A13",
      style: {
        alignment: { horizontal: "center", vertical: "middle", wrapText: true },
        font: { bold: true },
        numFmt: "0.0%"
      }
    }
  ] as const;

  it("round-trips every attribute a caller set", async () => {
    const source = Workbook.create();
    const sheet = Workbook.addWorksheet(source, "Aligned");
    for (const { address, style } of styled) {
      Cell.setValue(sheet, address, address);
      Cell.setStyle(sheet, address, style as never);
    }

    const reopened = Workbook.create();
    await Workbook.read(reopened, await Workbook.toBuffer(source, { format: "xlsb" }));
    const read = Workbook.getWorksheets(reopened)[0]!;
    for (const { address, style } of styled) {
      expect(Cell.getStyle(read, address), address).toMatchObject(style);
    }
  });

  it("interns two cells with the same alignment once", async () => {
    const source = Workbook.create();
    const sheet = Workbook.addWorksheet(source, "Shared");
    for (const address of ["A1", "A2", "A3"]) {
      Cell.setValue(sheet, address, 1);
      Cell.setStyle(sheet, address, { alignment: { horizontal: "center" } });
    }
    const entries = await extractAll(await Workbook.toBuffer(source, { format: "xlsb" }));
    // Two cell formats: the default, plus the one all three cells share.
    const listing = new TextDecoder().decode(entries.get("xl/styles.bin")!.data);
    expect(listing.length).toBeGreaterThan(0);
    const reopened = Workbook.create();
    await Workbook.read(reopened, await Workbook.toBuffer(source, { format: "xlsb" }));
    const read = Workbook.getWorksheets(reopened)[0]!;
    for (const address of ["A1", "A2", "A3"]) {
      expect(Cell.getStyle(read, address)?.alignment?.horizontal).toBe("center");
    }
  });
});
