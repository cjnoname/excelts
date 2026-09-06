/**
 * The chartsheet part carries the model's view and margins.
 *
 * These assert the **bytes of `xl/chartsheets/sheet1.bin`** inside a written package, not a write-then-read round
 * trip: the defect being pinned was a writer that never received the fields, and a round trip through the same
 * writer's own reader would have agreed with it. `BrtBeginCsView`'s zoomToFit bit and `BrtMargins` are additionally
 * compared against the values Excel itself writes for the same workbook.
 */
import { extractAll } from "@archive/unzip/extract";
import { Workbook } from "@excel";
import { iterateInterpretableRecords } from "@excel/xlsb/binary";
import { recordSpec } from "@excel/xlsb/spec/records";
import { describe, expect, it } from "vitest";

/** Payload of the one record of `name` in the first chartsheet part of a written workbook. */
async function chartsheetRecord(bytes: Uint8Array, name: string): Promise<Uint8Array | undefined> {
  const parts = await extractAll(bytes);
  const path = [...parts.keys()].find(key => /xl\/chartsheets\/sheet\d+\.bin$/.test(key));
  expect(path, "the package has a chartsheet part").toBeDefined();
  for (const entry of iterateInterpretableRecords(parts.get(path!)!.data, path!)) {
    if (recordSpec(entry.id)?.name === name) {
      return entry.payload;
    }
  }
  return undefined;
}

/** A workbook with one chartsheet whose view and margins are set. */
async function workbookWithChartsheet(
  options: { zoomToFit?: boolean; zoomScale?: number; margin?: number } = {}
): Promise<Uint8Array> {
  const wb = Workbook.create();
  Workbook.addWorksheet(wb, "Data");
  Workbook.addChartsheet(wb, "Board View", {
    chart: { type: "bar", series: [{ values: "Data!$A$1:$A$2" }] },
    ...(options.zoomToFit === undefined ? {} : { zoomToFit: options.zoomToFit }),
    ...(options.zoomScale === undefined ? {} : { zoomScale: options.zoomScale }),
    ...(options.margin === undefined
      ? {}
      : {
          pageMargins: {
            left: options.margin,
            right: options.margin,
            top: options.margin,
            bottom: options.margin,
            header: 0.3,
            footer: 0.3
          }
        })
  });
  return await Workbook.toBuffer(wb, { format: "xlsb", unsupported: "ignore" });
}

describe("chartsheet view in XLSB", () => {
  it("sets the zoomToFit bit of BrtBeginCsView when the model asks for it", async () => {
    const payload = await chartsheetRecord(
      await workbookWithChartsheet({ zoomToFit: true }),
      "BrtBeginCsView"
    );
    expect(payload).toBeDefined();
    const flags = new DataView(payload!.buffer, payload!.byteOffset).getUint16(0, true);
    // Bit 1. Excel's own re-save of `financial-report.xlsb` has `03 00` here — this bit plus `fSelected` — while the
    // same workbook's XLSX writes `<sheetView zoomToFit="1"/>`.
    expect(flags & 0x02).toBe(0x02);
  });

  it("leaves the zoomToFit bit clear when the model does not ask for it", async () => {
    const payload = await chartsheetRecord(await workbookWithChartsheet(), "BrtBeginCsView");
    const flags = new DataView(payload!.buffer, payload!.byteOffset).getUint16(0, true);
    expect(flags & 0x02).toBe(0);
  });

  it("carries the model's zoom scale rather than zero", async () => {
    const payload = await chartsheetRecord(
      await workbookWithChartsheet({ zoomScale: 128 }),
      "BrtBeginCsView"
    );
    expect(new DataView(payload!.buffer, payload!.byteOffset).getUint32(2, true)).toBe(128);
  });

  it("writes the model's margins, byte-for-byte as Excel writes them", async () => {
    const payload = await chartsheetRecord(
      await workbookWithChartsheet({ margin: 0.5 }),
      "BrtMargins"
    );
    expect(payload).toBeDefined();
    // The 48 bytes Excel wrote into `financial-report1.xlsb`'s chartsheet for margins of 0.5 with a 0.3 header and
    // footer. Six little-endian float64s: left, right, top, bottom, header, footer.
    expect(Buffer.from(payload!).toString("hex")).toBe(
      "000000000000e03f000000000000e03f000000000000e03f000000000000e03f" +
        "333333333333d33f333333333333d33f"
    );
  });

  it("does not fall back to default margins when the model has them", async () => {
    const payload = await chartsheetRecord(
      await workbookWithChartsheet({ margin: 0.5 }),
      "BrtMargins"
    );
    const left = new DataView(payload!.buffer, payload!.byteOffset).getFloat64(0, true);
    // 0.7 is Excel's default and what this writer used to emit unconditionally.
    expect(left).toBe(0.5);
    expect(left).not.toBe(0.7);
  });
});

describe("chartsheet view decoding", () => {
  it("reads the zoomToFit bit back out of the record it wrote", async () => {
    const { encodeChartsheetPart, readChartsheetPart } = await import("@excel/xlsb/chartsheet");
    const bytes = encodeChartsheetPart({
      name: "Board View",
      drawingRelationshipId: "rId1",
      zoomToFit: true
    });
    const read = readChartsheetPart(
      bytes,
      "sheet1.bin",
      iterateInterpretableRecords,
      id => recordSpec(id)?.name
    );
    expect(read.zoomToFit).toBe(true);
  });

  it("does not invent zoomToFit when the bit is clear", async () => {
    const { encodeChartsheetPart, readChartsheetPart } = await import("@excel/xlsb/chartsheet");
    const bytes = encodeChartsheetPart({ name: "Board View", drawingRelationshipId: "rId1" });
    const read = readChartsheetPart(
      bytes,
      "sheet1.bin",
      iterateInterpretableRecords,
      id => recordSpec(id)?.name
    );
    expect(read.zoomToFit).toBeUndefined();
  });
});
