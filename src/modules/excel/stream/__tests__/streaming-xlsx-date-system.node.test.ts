/**
 * The 1904 date system, through the streaming **XLSX** writer.
 *
 * The BIFF12 sibling of this file (`streaming-xlsb-date-system.node.test.ts`) was written when the streamed XLSB row
 * encoder was found to be passing a literal `false`. The XLSX branch of the same class had the identical defect and
 * was not looked at, for a reason worth recording: the accessor that carried the setting was called `xlsbDate1904`,
 * so the branch that needed it read as though it did not apply. It is `date1904Flag` now.
 *
 * The XLSX failure was also quieter than the XLSB one, and quieter is worse. `WorkbookWriter.addWorkbook` built its
 * model with `properties: {}` — a literal, not the writer's own properties — so no `<workbookPr date1904="1">` was
 * written either. The package was therefore *self-consistent*: a 1900 workbook containing 1900 serials, which round
 * trips perfectly and is simply not the workbook that was asked for. A round-trip assertion cannot see that, which is
 * why the assertions below are on the bytes: the serial in the sheet, and the flag in the workbook part.
 *
 * `date1904` is passed as a declared writer *option* here rather than assigned to `properties`, because that is the
 * documented way to ask for it and an option that silently does nothing is the defect under test.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { extractAll } from "@archive/unzip/extract";
import { Cell, Stream, Workbook } from "@excel";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/** `2020-01-15`, whose two serials — 43845 and 42383 — are both unremarkable integers. */
const WHEN = new Date(Date.UTC(2020, 0, 15));
/** `(2020-01-15 - 1899-12-30) / 1 day`, the 1900-system serial Excel stores. */
const SERIAL_1900 = 43_845;
/** The same date counted from 1904-01-01: 1,462 days fewer. */
const SERIAL_1904 = SERIAL_1900 - 1462;

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "documonster-xlsx-1904-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Write one dated cell through the streaming XLSX writer and hand back the package bytes. */
async function streamed(date1904: boolean): Promise<Uint8Array> {
  const path = join(dir, `stream-${String(date1904)}.xlsx`);
  const writer = new Stream.WorkbookWriter({ filename: path, date1904, useStyles: true });
  const sheet = writer.addWorksheet("S");
  Stream.setCellValue(sheet.getCell("A1"), WHEN);
  Stream.commitRow(sheet.getRow(1));
  sheet.commit();
  await writer.commit();
  return Uint8Array.from(await readFile(path));
}

/** The same cell through `Workbook.toBuffer`, the path that was already correct. */
async function buffered(date1904: boolean): Promise<Uint8Array> {
  const workbook = Workbook.create();
  (workbook as { properties?: Record<string, unknown> }).properties = {
    ...((workbook as { properties?: Record<string, unknown> }).properties ?? {}),
    date1904
  };
  Cell.setValue(Workbook.addWorksheet(workbook, "S"), "A1", WHEN);
  return Workbook.toBuffer(workbook);
}

/** One named part of the package, as text. */
async function part(bytes: Uint8Array, suffix: string): Promise<string> {
  const parts = await extractAll(bytes);
  const path = [...parts.keys()].find(name => name.endsWith(suffix));
  expect(path, `no part ending in ${suffix}`).toBeDefined();
  return new TextDecoder().decode(parts.get(path!)!.data);
}

/** The number in cell A1's `<v>`, read out of the sheet XML. */
async function serialOf(bytes: Uint8Array): Promise<number | undefined> {
  const match = /<c r="A1"[^>]*>\s*<v>([^<]+)<\/v>/.exec(await part(bytes, "sheet1.xml"));
  return match === null ? undefined : Number(match[1]);
}

describe("the streaming XLSX writer and the 1904 date system", () => {
  it.each([
    { date1904: false, serial: SERIAL_1900 },
    { date1904: true, serial: SERIAL_1904 }
  ])("writes the $date1904 serial as $serial", async ({ date1904, serial }) => {
    // Against Excel's arithmetic rather than against the other writer, so both writers cannot drift together.
    expect(await serialOf(await streamed(date1904))).toBe(serial);
  });

  it.each([false, true])("agrees with the buffered writer at date1904=%s", async date1904 => {
    expect(await serialOf(await streamed(date1904))).toBe(await serialOf(await buffered(date1904)));
  });

  it.each([false, true])(
    "records the date system in the workbook part at date1904=%s",
    async date1904 => {
      // The half that was *not* right, and the half a round trip cannot see: with the flag missing the package is a
      // consistent 1900 workbook, so it reopens cleanly while being the wrong workbook.
      const xml = await part(await streamed(date1904), "xl/workbook.xml");
      const attributes = /<workbookPr[^>]*\/?>/.exec(xml)?.[0] ?? "";
      expect(/date1904="1"|date1904="true"/.test(attributes)).toBe(date1904);
    }
  );

  it.each([false, true])("round-trips the date itself at date1904=%s", async date1904 => {
    const reopened = Workbook.create();
    await Workbook.read(reopened, await streamed(date1904));
    const value = Cell.getValue(Workbook.getWorksheet(reopened, "S")!, "A1");
    expect(value).toBeInstanceOf(Date);
    expect((value as Date).toISOString()).toBe(WHEN.toISOString());
  });

  it("keeps the fixture non-vacuous", async () => {
    // Guards the harness: every assertion above reads `sheet1.xml` and cell A1, and a package that stopped producing
    // either would make `serialOf` return `undefined` and the comparisons pass on nothing.
    expect(await serialOf(await streamed(false))).not.toBeUndefined();
  });
});

describe("switching a workbook's date system between writes", () => {
  /** The serial in cell A1, from the buffered XLSX writer. */
  async function writeAndRead(
    workbook: ReturnType<typeof Workbook.create>
  ): Promise<number | undefined> {
    return serialOf(await Workbook.toBuffer(workbook));
  }

  it("re-encodes every date against the epoch in force at that write", async () => {
    // **`CellXform.prepare` writes onto the live cell model, and it used to set `date1904` only when true.**
    // So a workbook written once under the 1904 system kept the flag on every date cell for ever: writing it
    // again after switching back to 1900 produced 1904 serials inside a package whose workbook part said
    // 1900 — 1,462 days out, silently, in a file that reopens cleanly because both halves no longer agree.
    //
    // Three writes, because two cannot tell a stale flag from a sticky one: the third proves the value tracks
    // the setting rather than merely changing once.
    const workbook = Workbook.create();
    const properties = workbook as { properties?: Record<string, unknown> };
    Cell.setValue(Workbook.addWorksheet(workbook, "S"), "A1", WHEN);

    properties.properties = { ...(properties.properties ?? {}), date1904: true };
    expect(await writeAndRead(workbook)).toBe(SERIAL_1904);

    properties.properties = { ...(properties.properties ?? {}), date1904: false };
    expect(await writeAndRead(workbook)).toBe(SERIAL_1900);

    properties.properties = { ...(properties.properties ?? {}), date1904: true };
    expect(await writeAndRead(workbook)).toBe(SERIAL_1904);
  });

  it("does the same for a formula's cached date result", async () => {
    // The other branch of the same `prepare`, and the same stale flag.
    const workbook = Workbook.create();
    const properties = workbook as { properties?: Record<string, unknown> };
    Cell.setValue(Workbook.addWorksheet(workbook, "S"), "A1", { formula: "TODAY()", result: WHEN });

    properties.properties = { ...(properties.properties ?? {}), date1904: true };
    const asXml = new TextDecoder().decode(
      (await extractAll(await Workbook.toBuffer(workbook))).get(
        [...(await extractAll(await Workbook.toBuffer(workbook))).keys()].find(name =>
          name.endsWith("sheet1.xml")
        )!
      )!.data
    );
    expect(asXml).toContain(String(SERIAL_1904));

    properties.properties = { ...(properties.properties ?? {}), date1904: false };
    const parts = await extractAll(await Workbook.toBuffer(workbook));
    const path = [...parts.keys()].find(name => name.endsWith("sheet1.xml"))!;
    expect(new TextDecoder().decode(parts.get(path)!.data)).toContain(String(SERIAL_1900));
  });

  it("leaves no epoch marker on a model the caller can see", async () => {
    // The flag is the writer's plumbing. A 1900 workbook — the default — must come out of a write with the
    // model it went in with, so `delete` rather than `= false`.
    const workbook = Workbook.create();
    const sheet = Workbook.addWorksheet(workbook, "S");
    Cell.setValue(sheet, "A1", WHEN);
    await Workbook.toBuffer(workbook);
    expect(Object.keys(Cell.getModel(sheet, "A1") ?? {})).not.toContain("date1904");
  });
});
