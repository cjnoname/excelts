/**
 * The 1904 date system, through the streaming XLSB writer.
 *
 * **A serial is meaningless without the epoch, and this path passed a literal `false`.** The workbook part is produced
 * at `commit()` from the model, so `BrtWbProp` recorded whatever the caller set while every cell serial had been
 * computed against the 1900 epoch — a package internally inconsistent by exactly 1,462 days. Nothing caught it: no
 * streaming test set the property, and a round trip through this library's own reader would have agreed with the writer
 * if the reader had shared the mistake.
 *
 * So the assertions here are deliberately of two kinds. The round trip proves the package agrees with itself; the
 * comparison against the *buffered* writer proves it agrees with the path that was already correct, which is the one
 * that would have caught a shared misreading. And the serial is checked as a number against Excel's own arithmetic,
 * so neither writer can drift without this failing.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { extractAll } from "@archive/unzip/extract";
import { Cell, Stream, Workbook, Worksheet } from "@excel";
import { iterateInterpretableRecords } from "@excel/xlsb/binary";
import { recordSpec } from "@excel/xlsb/spec/records";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/** `2020-01-15`, chosen because its two serials — 43845 and 42383 — are both unremarkable integers. */
const WHEN = new Date(Date.UTC(2020, 0, 15));
/** `(2020-01-15 - 1899-12-30) / 1 day`, the 1900-system serial Excel stores. */
const SERIAL_1900 = 43_845;
/** The same instant counted from 1904-01-01: 1,462 days fewer. */
const SERIAL_1904 = SERIAL_1900 - 1462;

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "documonster-xlsb-1904-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Write one dated cell through the streaming writer and hand back the package. */
async function streamed(date1904: boolean): Promise<Uint8Array> {
  const path = join(dir, `stream-${String(date1904)}.xlsb`);
  const writer = new Stream.WorkbookWriter({ filename: path, format: "xlsb", useStyles: true });
  (writer as { properties?: Record<string, unknown> }).properties = {
    ...((writer as { properties?: Record<string, unknown> }).properties ?? {}),
    date1904
  };
  const sheet = writer.addWorksheet("S");
  Stream.setCellValue(sheet.getCell("A1"), WHEN);
  Stream.commitRow(sheet.getRow(1));
  // `commit()` on a streamed worksheet returns void, not a promise — the workbook's does the awaiting.
  sheet.commit();
  await writer.commit();
  return Uint8Array.from(await readFile(path));
}

/** The same cell through `Workbook.toBuffer`, which was already correct. */
async function buffered(date1904: boolean): Promise<Uint8Array> {
  const workbook = Workbook.create();
  (workbook as { properties?: Record<string, unknown> }).properties = {
    ...((workbook as { properties?: Record<string, unknown> }).properties ?? {}),
    date1904
  };
  Cell.setValue(Workbook.addWorksheet(workbook, "S"), "A1", WHEN);
  return Workbook.toBuffer(workbook, { format: "xlsb", unsupported: "ignore" });
}

/** The serial in the sheet's single numeric cell record, read out of the bytes. */
async function serialOf(bytes: Uint8Array): Promise<number | undefined> {
  const parts = await extractAll(bytes);
  const path = [...parts.keys()].find(name => /worksheets\/sheet1\.bin$/.test(name));
  if (path === undefined) {
    return undefined;
  }
  for (const entry of iterateInterpretableRecords(parts.get(path)!.data, path)) {
    const name = recordSpec(entry.id)?.name;
    if (name !== "BrtCellReal" && name !== "BrtCellRk") {
      continue;
    }
    const view = new DataView(entry.payload.buffer, entry.payload.byteOffset, entry.payload.length);
    if (name === "BrtCellReal") {
      return view.getFloat64(8, true);
    }
    // `RkNumber`, both forms. Bit 1 says the top thirty bits are an integer; cleared, they are the *high* half of a
    // double with the low half zero — which is what this writer emits for a whole-day serial, so handling only the
    // integer form made this helper return `undefined` and every comparison below pass on nothing.
    const raw = view.getUint32(8, true);
    const hundredth = (raw & 0x01) !== 0;
    let value: number;
    if ((raw & 0x02) !== 0) {
      const bits = raw >> 2;
      value = (bits & 0x2000_0000) !== 0 ? bits - 0x4000_0000 : bits;
    } else {
      const buffer = new ArrayBuffer(8);
      new DataView(buffer).setUint32(4, raw & 0xffff_fffc, true);
      value = new DataView(buffer).getFloat64(0, true);
    }
    return hundredth ? value / 100 : value;
  }
  return undefined;
}

describe("the streaming XLSB writer and the 1904 date system", () => {
  it.each([
    { date1904: false, serial: SERIAL_1900 },
    { date1904: true, serial: SERIAL_1904 }
  ])("writes the $date1904 serial as $serial", async ({ date1904, serial }) => {
    // Against Excel's arithmetic rather than against the other writer, so both writers cannot drift together.
    expect(await serialOf(await streamed(date1904))).toBe(serial);
  });

  it.each([false, true])("agrees with the buffered writer at date1904=%s", async date1904 => {
    // The check that would have caught this: the buffered path was already right, and the streamed one differed by
    // 1,462 for a workbook nobody had tested.
    expect(await serialOf(await streamed(date1904))).toBe(await serialOf(await buffered(date1904)));
  });

  it.each([false, true])("round-trips the date itself at date1904=%s", async date1904 => {
    const reopened = Workbook.create();
    await Workbook.read(reopened, await streamed(date1904));
    const value = Cell.getValue(Workbook.getWorksheet(reopened, "S")!, "A1");
    expect(value).toBeInstanceOf(Date);
    expect((value as Date).toISOString()).toBe(WHEN.toISOString());
  });

  it("records the date system in the workbook part, so the package agrees with itself", async () => {
    // The half that was always right. Asserting it beside the serial is the point: the defect was not a wrong record,
    // it was two records describing different epochs.
    const parts = await extractAll(await streamed(true));
    const path = [...parts.keys()].find(name => /xl\/workbook\.bin$/.test(name))!;
    let flags: number | undefined;
    for (const entry of iterateInterpretableRecords(parts.get(path)!.data, path)) {
      if (recordSpec(entry.id)?.name === "BrtWbProp") {
        flags = new DataView(
          entry.payload.buffer,
          entry.payload.byteOffset,
          entry.payload.length
        ).getUint32(0, true);
      }
    }
    expect(flags).toBeDefined();
    // `f1904` is bit 0 of `BrtWbProp`'s flag word.
    expect((flags! & 0x01) !== 0).toBe(true);
    expect(await serialOf(await streamed(true))).toBe(SERIAL_1904);
  });

  it("keeps a sheet's own name resolvable, so the fixture is not vacuous", async () => {
    // Guards the harness rather than the writer: every assertion above reads `sheet1.bin` and sheet `S`, and a package
    // that stopped producing either would make `serialOf` return `undefined` and the comparisons pass on nothing.
    const reopened = Workbook.create();
    await Workbook.read(reopened, await streamed(false));
    expect(Workbook.getWorksheets(reopened).map(sheet => Worksheet.getName(sheet))).toEqual(["S"]);
    expect(await serialOf(await streamed(false))).not.toBeUndefined();
  });
});
