/**
 * `Stream.WorkbookWriter` with `format: "xlsb"`, end to end.
 *
 * **What these assert that the unit tests cannot.** `xlsb/__tests__/worksheet-stream.test.ts` already proves the
 * streamed sheet part is byte-identical to the buffered one for the same options and rows; that is the property the
 * whole design rests on and it is checked at the encoder. What is left is everything around it — that the ZIP
 * entries are opened and closed in the right order, that the workbook-level parts are produced from a model whose
 * rows have been released, that the interning tables the streamed records point into are the ones serialised at the
 * end, and that a caller gets a package Excel accepts.
 *
 * Every assertion here compares the streamed output against the *buffered* output of the same content rather than
 * against constants. That is deliberate: this module's most repeated defect is two code paths agreeing with each
 * other and not with Excel, and a test written against bytes I chose would be a test of my transcription.
 *
 * Carries `.node` because it writes to a temporary directory.
 */
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { extractAll } from "@archive/unzip/extract";
import { Cell, Stream, Workbook, Worksheet } from "@excel";
import { validateXlsbBuffer } from "@excel/utils/xlsb-validator";
import { iterateInterpretableRecords } from "@excel/xlsb/binary";
import { recordSpec } from "@excel/xlsb/spec/records";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROWS: readonly (readonly (string | number)[])[] = [
  ["Year", "Sales", "Note"],
  [2023, 100, "a"],
  [2024, 150, "b"],
  [2025, 220, "a"]
];

let directory = "";
let streamed = new Uint8Array(0);
let buffered = new Uint8Array(0);

/** Record names and payloads for a sheet part, which is what "the same part" means for a BIFF stream. */
function records(bytes: Uint8Array, part: string): string[] {
  return [...iterateInterpretableRecords(bytes, part)].map(
    entry => `${recordSpec(entry.id)?.name ?? `#${entry.id}`}:${[...entry.payload].join(",")}`
  );
}

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "documonster-stream-xlsb-"));
  const target = join(directory, "streamed.xlsb");

  const writer = new Stream.WorkbookWriter({ filename: target, format: "xlsb", useStyles: true });
  const sheet = writer.addWorksheet("S");
  for (const row of ROWS) {
    Stream.commitRow(sheet.addRow([...row]));
  }
  sheet.commit();
  await writer.commit();
  streamed = Uint8Array.from(readFileSync(target));

  // The same content through the buffered writer, which is the reference.
  const handle = Workbook.create();
  const bufferedSheet = Workbook.addWorksheet(handle, "S");
  Worksheet.addAoa(
    bufferedSheet,
    ROWS.map(row => [...row])
  );
  buffered = Uint8Array.from(
    await Workbook.toBuffer(handle, { format: "xlsb", unsupported: "ignore" })
  );
});

afterAll(() => {
  if (directory !== "") {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("a streamed XLSB package", () => {
  it("is a valid package", async () => {
    expect((await validateXlsbBuffer(streamed)).problems ?? []).toEqual([]);
  });

  it("carries the same parts the buffered writer produces", async () => {
    // Not "some parts": the exact set. A streamed package missing `styles.bin` or carrying a stray
    // `sheet1.xml` from the XML path would still open in a reader that ignores what it does not know.
    const left = [...(await extractAll(buffered)).keys()].sort();
    const right = [...(await extractAll(streamed)).keys()].sort();
    expect(right).toEqual(left);
  });

  it("writes each part exactly once", async () => {
    // The sheet part is written by the streaming path and the package writer is told not to produce it again. If
    // that ever stops working the ZIP gains a second entry and the content types a duplicate `Override`, which
    // Excel treats as malformed rather than redundant.
    const parts = [...(await extractAll(streamed)).keys()];
    expect(parts).toHaveLength(new Set(parts).size);
    const contentTypes = new TextDecoder().decode(
      (await extractAll(streamed)).get("[Content_Types].xml")!.data
    );
    const overrides = [...contentTypes.matchAll(/PartName="([^"]+)"/g)].map(match => match[1]);
    expect(overrides).toHaveLength(new Set(overrides).size);
  });

  it("has a sheet part identical to the buffered one apart from the dimension", async () => {
    // The single deliberate difference. `BrtWsDim` states the used range and sits before the rows, so a forward
    // pass cannot fill it in — verified against Excel rather than assumed: a package without it opens without a
    // repair.
    const left = records((await extractAll(buffered)).get("xl/worksheets/sheet1.bin")!.data, "s");
    const right = records((await extractAll(streamed)).get("xl/worksheets/sheet1.bin")!.data, "s");
    expect(right).toEqual(left.filter(entry => !entry.startsWith("BrtWsDim:")));
  });

  it("omits the dimension and nothing else", async () => {
    const right = records((await extractAll(streamed)).get("xl/worksheets/sheet1.bin")!.data, "s");
    expect(right.filter(entry => entry.startsWith("BrtWsDim:"))).toEqual([]);
    expect(right.some(entry => entry.startsWith("BrtBeginSheetData:"))).toBe(true);
    expect(right.some(entry => entry.startsWith("BrtEndSheetData:"))).toBe(true);
  });

  it("serialises the interning tables the streamed records point into", async () => {
    // The subtle one. Rows are encoded as they arrive, so their `BrtCellIsst` indices name entries in the
    // streaming writer's own table — and `sharedStrings.bin` is written at the very end. Hand the package writer a
    // fresh table and every string cell in the file names the wrong text, with nothing invalid about the bytes.
    const left = (await extractAll(buffered)).get("xl/sharedStrings.bin")!.data;
    const right = (await extractAll(streamed)).get("xl/sharedStrings.bin")!.data;
    expect([...right]).toEqual([...left]);
  });

  it("reads back the values that were written", async () => {
    const handle = Workbook.create();
    await Workbook.read(handle, streamed);
    const sheet = Workbook.getWorksheets(handle)[0];
    expect(Cell.getValue(sheet, "A1")).toBe("Year");
    expect(Cell.getValue(sheet, "C1")).toBe("Note");
    expect(Cell.getValue(sheet, "A2")).toBe(2023);
    expect(Cell.getValue(sheet, "B4")).toBe(220);
    // The repeated string proves the shared-string indices survived the deferral above.
    expect(Cell.getValue(sheet, "C4")).toBe("a");
  });
});

describe("a streamed sheet with no rows", () => {
  it("still produces its part", async () => {
    // Easy to lose, because it cannot happen in the buffered path: there, the part is written whether or not there
    // are rows. Here the entry is opened lazily on the first row, so a sheet that never gets one has to be opened
    // at commit — otherwise the bundle names a part the package does not contain and Excel repairs the file.
    const target = join(directory, "empty.xlsb");
    const writer = new Stream.WorkbookWriter({ filename: target, format: "xlsb" });
    const sheet = writer.addWorksheet("Empty");
    sheet.commit();
    await writer.commit();
    const bytes = Uint8Array.from(readFileSync(target));
    const parts = await extractAll(bytes);
    expect(parts.has("xl/worksheets/sheet1.bin")).toBe(true);
    expect((await validateXlsbBuffer(bytes)).problems ?? []).toEqual([]);
  });
});

describe("the format option", () => {
  it("still defaults to XLSX", async () => {
    // The whole point of a default is that nothing existing changes. A `.xlsx` that started arriving as binary
    // would break every current caller silently, since both are ZIPs.
    const target = join(directory, "default.xlsx");
    const writer = new Stream.WorkbookWriter({ filename: target });
    const sheet = writer.addWorksheet("S");
    Stream.commitRow(sheet.addRow(["a", 1]));
    sheet.commit();
    await writer.commit();
    const parts = await extractAll(Uint8Array.from(readFileSync(target)));
    expect(parts.has("xl/worksheets/sheet1.xml")).toBe(true);
    expect(parts.has("xl/worksheets/sheet1.bin")).toBe(false);
  });

  it("does not leave an XML sheet part behind when writing binary", async () => {
    // `worksheet.stream` is a lazy getter that opens `sheetN.xml` on first access, and the workbook's commit used
    // to read it merely to find a completion promise. That created an entry the binary package does not want and
    // hung the commit waiting for something to close it.
    const parts = await extractAll(streamed);
    expect([...parts.keys()].filter(path => /worksheets\/sheet\d+\.xml$/.test(path))).toEqual([]);
  });
});

describe("many rows", () => {
  it("writes a large sheet without collecting it", async () => {
    // Not a memory assertion — those are too flaky to gate on — but a size and shape one: fifty thousand rows must
    // come out as fifty thousand `BrtRowHdr` records in a file whose size is plausible for the data. A path that
    // silently dropped or duplicated rows under compaction would show here.
    const target = join(directory, "large.xlsb");
    const writer = new Stream.WorkbookWriter({
      filename: target,
      format: "xlsb",
      useStyles: false,
      useSharedStrings: false
    });
    const sheet = writer.addWorksheet("big");
    for (let row = 0; row < 50_000; row++) {
      Stream.commitRow(sheet.addRow([row, row * 2, row * 3]));
    }
    sheet.commit();
    await writer.commit();
    const bytes = Uint8Array.from(readFileSync(target));
    expect(statSync(target).size).toBeGreaterThan(100_000);
    const parts = await extractAll(bytes);
    const names = records(parts.get("xl/worksheets/sheet1.bin")!.data, "s");
    expect(names.filter(entry => entry.startsWith("BrtRowHdr:"))).toHaveLength(50_000);
    expect((await validateXlsbBuffer(bytes)).problems ?? []).toEqual([]);
  }, 120_000);
});
