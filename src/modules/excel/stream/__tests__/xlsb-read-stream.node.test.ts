/**
 * The two decoders a streaming XLSB read is built from.
 *
 * **Both are checked against the buffered reader rather than against constants.** A hand-written expectation here
 * would test my transcription of the format; comparing the streamed output to the output the rest of the library
 * already produces tests the thing that matters, which is that a caller cannot tell the two apart.
 *
 * **The fixtures are written here, not borrowed from the examples' output.** They used to be read out of
 * `tmp/excel-examples/`, which is gitignored and produced by a *different* CI job — so on a clean checkout these tests
 * failed outright (17 of them), and locally they passed only because a previous example run had left the files behind.
 * A test whose input another job happens to have created is a test whose result depends on what else has run.
 *
 * Building them here also makes the pair honest in a second way: the packages the streaming decoders are checked against
 * are ones this library wrote in this process, so a change to the writer reaches this test immediately.
 *
 * Carries `.node` because it writes the fixtures to a temporary directory.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { extractAll } from "@archive/unzip/extract";
import { Cell, Workbook } from "@excel";
import { rowGetModel } from "@excel/core/row";
import { streamBiffRecords } from "@excel/stream/xlsb-record-stream";
import { streamXlsbRows } from "@excel/stream/xlsb-worksheet-reader";
import { iterateInterpretableRecords } from "@excel/xlsb/binary";
import { readSharedStrings } from "@excel/xlsb/read/parts";
import { recordSpec } from "@excel/xlsb/spec/records";
import { readStyles } from "@excel/xlsb/styles";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let sheet = new Uint8Array(0);
let sharedStrings: readonly string[] = [];
let numberFormats: readonly (string | undefined)[] | undefined;
/** Where the fixtures this file writes for itself live. */
let dir = "";
/** A package with formulas, shared strings, dates and styles — the shapes the decoders have to handle. */
let richXlsb = "";
/** The same content as XLSX, for the cross-container comparison. */
let richXlsx = "";

/**
 * A workbook covering what these decoders read: interned strings, numbers, dates with a format, formulas with cached
 * results, a blank styled cell, and more than one sheet so a cross-sheet reference resolves.
 */
async function buildFixtures(): Promise<void> {
  const { Worksheet } = await import("@excel");
  const workbook = Workbook.create();
  // `Main` first, so `sheet1.bin` is the sheet these tests read and `getWorksheets()[0]` is the same sheet. A fixture
  // whose byte-level and model-level views point at different sheets is a fixture that tests nothing.
  const main = Workbook.addWorksheet(workbook, "Main");
  const source = Workbook.addWorksheet(workbook, "Source");
  Cell.setValue(source, "A1", 10);
  Cell.setValue(source, "A2", 20);
  Cell.setValue(main, "A1", "Region");
  Cell.setValue(main, "B1", "Units");
  Cell.setValue(main, "C1", "Sold");
  Cell.setValue(main, "D1", "Note");
  // Enough rows for the "compared more than twenty cells" guards, which exist so a decoder that emits nothing cannot
  // pass by comparing nothing.
  const regions = ["APAC", "EMEA", "AMER", "LATAM", "MEA", "ANZ", "SEA", "CEE"];
  regions.forEach((region, index) => {
    const row = index + 2;
    Cell.setValue(main, `A${row}`, region);
    Cell.setValue(main, `B${row}`, (index + 1) * 10);
    Cell.setValue(main, `C${row}`, new Date(Date.UTC(2024, index, 15)));
    Cell.setValue(main, `D${row}`, `note ${index}`);
  });
  const total = regions.length + 2;
  Cell.setValue(main, `B${total}`, { formula: `SUM(B2:B${regions.length + 1})`, result: 360 });
  Cell.setValue(main, `C${total}`, { formula: "Source!A1", result: 10 });
  // A styled cell with no value, which is the `BrtCellBlank` path. Set through the cell's own style rather than a
  // named one, because `applyCellStyle` takes a style *name*.
  Cell.setStyle(main, `D${total + 1}`, { font: { bold: true } });
  void Worksheet.getName(main);
  richXlsb = join(dir, "rich.xlsb");
  richXlsx = join(dir, "rich.xlsx");
  await writeFile(richXlsb, await Workbook.toBuffer(workbook, { format: "xlsb" }));
  await writeFile(richXlsx, await Workbook.toBuffer(workbook, { format: "xlsx" }));
}

/** `bytes` delivered in fixed-size pieces, to put the frame decoder under a boundary it must survive. */
async function* inChunks(bytes: Uint8Array, size: number): AsyncIterableIterator<Uint8Array> {
  for (let offset = 0; offset < bytes.length; offset += size) {
    yield bytes.subarray(offset, Math.min(offset + size, bytes.length));
  }
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "documonster-xrs-"));
  await buildFixtures();
  const parts = await extractAll(Uint8Array.from(await readFile(richXlsb)));
  sheet = Uint8Array.from(parts.get("xl/worksheets/sheet1.bin")!.data);
  sharedStrings = parts.has("xl/sharedStrings.bin")
    ? readSharedStrings(parts.get("xl/sharedStrings.bin")!.data, "ss").texts
    : [];
  numberFormats = parts.has("xl/styles.bin")
    ? (
        readStyles(parts.get("xl/styles.bin")!.data, "st") as unknown as {
          numberFormats?: readonly (string | undefined)[];
        }
      ).numberFormats
    : undefined;
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("the record frame decoder", () => {
  /** The buffered reader's answer, which is the reference. */
  function buffered(): string[] {
    return [...iterateInterpretableRecords(sheet, "s")].map(
      entry => `${recordSpec(entry.id)?.name}:${entry.payload.length}`
    );
  }

  async function streamed(size: number): Promise<string[]> {
    const found: string[] = [];
    for await (const record of streamBiffRecords(inChunks(sheet, size), "s")) {
      found.push(`${record.name}:${record.payload.length}`);
    }
    return found;
  }

  it.each([4096, 97, 7, 1])("matches the buffered decoder at %i-byte chunks", async size => {
    // **One byte at a time is the case that matters.** A record's header is two variable-length integers, so how many
    // bytes it occupies is unknown until it has been read — a decoder that checked for a fixed minimum before
    // decoding would pass at 4 KiB and fail here. Every intermediate size is a different split of the same records.
    expect(await streamed(size)).toEqual(buffered());
  });

  it("rejects a truncated tail rather than dropping it", async () => {
    // Silently discarding an incomplete record would turn a corrupt part into a short sheet, which reads as data loss
    // with no error to attribute it to.
    //
    // A partial header is *appended* rather than bytes cut from the end: the last records of a sheet carry empty
    // payloads, so cutting a few bytes can land exactly on a boundary and leave nothing incomplete — which is what a
    // first version of this test did, and it passed for the wrong reason. `0x81` is a complete one-byte record id with
    // no length following it, so the decoder cannot finish it however much it waits.
    const truncated = new Uint8Array(sheet.length + 1);
    truncated.set(sheet, 0);
    truncated[sheet.length] = 0x81;
    await expect(async () => {
      for await (const _record of streamBiffRecords(inChunks(truncated, 64), "s")) {
        void _record;
      }
    }).rejects.toThrow(/trailing byte/);
  });
});

describe("the row decoder", () => {
  /** Streamed cell values, keyed by address. */
  async function streamedCells(): Promise<Map<string, unknown>> {
    const scratch = Workbook.create();
    const target = Workbook.addWorksheet(scratch, "S");
    const values = new Map<string, unknown>();
    for await (const row of streamXlsbRows(inChunks(sheet, 1024), "s", {
      sharedStrings,
      numberFormats,
      worksheet: target as never
    })) {
      const model = rowGetModel(row) as unknown as {
        cells?: readonly ({ address: string; value?: unknown } | undefined)[];
      };
      for (const cell of model?.cells ?? []) {
        if (cell !== undefined) {
          values.set(cell.address, cell.value);
        }
      }
    }
    return values;
  }

  it("emits one row per row header", async () => {
    const headers = [...iterateInterpretableRecords(sheet, "s")].filter(
      entry => recordSpec(entry.id)?.name === "BrtRowHdr"
    ).length;
    let rows = 0;
    const scratch = Workbook.create();
    const target = Workbook.addWorksheet(scratch, "S");
    for await (const _row of streamXlsbRows(inChunks(sheet, 512), "s", {
      sharedStrings,
      worksheet: target as never
    })) {
      void _row;
      rows++;
    }
    expect(rows).toBe(headers);
  });

  it("agrees with the buffered reader on every plain value", async () => {
    // Scoped to plain values on purpose, and the scope *is* the assertion: the three places a streamed read
    // deliberately differs — a formula's expression, a rich string's runs, a merged region's continuation — are named
    // in `xlsb-worksheet-reader.ts` and excluded here rather than quietly absorbed into a tolerance.
    const handle = Workbook.create();
    await Workbook.read(handle, Uint8Array.from(await readFile(richXlsb)));
    const reference = Workbook.getWorksheets(handle)[0];
    const streamed = await streamedCells();
    let compared = 0;
    for (const [address, value] of streamed) {
      const expected = Cell.getValue(reference, address);
      if (expected !== null && typeof expected === "object") {
        // A formula cell, a rich string, or a hyperlink — the documented omissions.
        continue;
      }
      compared++;
      expect(value ?? null, address).toEqual(expected ?? null);
    }
    expect(compared, "no plain values were compared").toBeGreaterThan(0);
  });

  it("streams a values-only sheet identically", async () => {
    // The clean case, on a sheet with no formulas or rich text: every cell must match, which is what makes the
    // omissions above a list rather than an excuse.
    const parts = await extractAll(Uint8Array.from(await readFile(richXlsb)));
    const bytes = parts.get("xl/worksheets/sheet1.bin")!.data;
    const strings = parts.has("xl/sharedStrings.bin")
      ? readSharedStrings(parts.get("xl/sharedStrings.bin")!.data, "ss").texts
      : [];
    const handle = Workbook.create();
    await Workbook.read(handle, Uint8Array.from(await readFile(richXlsb)));
    const reference = Workbook.getWorksheets(handle)[0];
    const scratch = Workbook.create();
    const target = Workbook.addWorksheet(scratch, "S");
    let compared = 0;
    for await (const row of streamXlsbRows(inChunks(bytes, 256), "s", {
      sharedStrings: strings,
      worksheet: target as never
    })) {
      const model = rowGetModel(row) as unknown as {
        cells?: readonly ({ address: string; value?: unknown } | undefined)[];
      };
      for (const cell of model?.cells ?? []) {
        if (cell === undefined) {
          continue;
        }
        const expected = Cell.getValue(reference, cell.address);
        if (expected !== null && typeof expected === "object") {
          continue;
        }
        compared++;
        expect(cell.value ?? null, cell.address).toEqual(expected ?? null);
      }
    }
    expect(compared).toBeGreaterThan(20);
  });
});

describe("what the streamed row decoder does and does not decode", () => {
  /** A package holding an error literal, a formula whose cached result is an error, and a plain number beside them. */
  async function errorFixture(): Promise<string> {
    const workbook = Workbook.create();
    const sheet = Workbook.addWorksheet(workbook, "S");
    Cell.setValue(sheet, "A1", 1);
    Cell.setValue(sheet, "A2", { error: "#N/A" } as never);
    Cell.setValue(sheet, "A3", { formula: "1/0", result: { error: "#DIV/0!" } } as never);
    const path = join(dir, "errors.xlsb");
    await writeFile(
      path,
      await Workbook.toBuffer(workbook, { format: "xlsb", unsupported: "ignore" })
    );
    return path;
  }

  it("decodes an error cell rather than omitting it", async () => {
    // **These were dropped.** `decodeCell` had no branch for `BrtCellError` or `BrtFmlaError`, so a streamed read of a
    // workbook holding `#N/A` emitted no cell at all — indistinguishable, to a caller, from an empty one. The buffered
    // reader has decoded them since `error-values.ts` existed, so the two readers disagreed about the same records.
    const { Stream } = await import("@excel");
    const reader = new Stream.WorkbookReader(await errorFixture(), {
      worksheets: "emit",
      sharedStrings: "cache",
      styles: "cache"
    });
    const seen: unknown[][] = [];
    for await (const worksheet of reader) {
      for await (const row of worksheet) {
        seen.push(
          Stream.rowValues(row).filter(value => value !== undefined && value !== null) as unknown[]
        );
      }
    }
    expect(seen).toEqual([[1], ["#N/A"], ["#DIV/0!"]]);
  });

  it("does not decode the BrtShort* variants, whose layout is unestablished", async () => {
    // The switch used to give each `BrtShort*` id the *long* layout — a column, a four-byte style reference, then the
    // value. `spec/records.ts` declares no fields for them on purpose, and the buffered reader skips and counts them.
    //
    // Asserted structurally, because the corpus contains none of these records to test against: no `BrtShort` name may
    // appear in the decoder's switch. A test that needed such a file could not be written, and the guess it replaced
    // would have thrown on a genuinely short payload — taking the whole sheet down rather than one cell.
    const source = await readFile("src/modules/excel/stream/xlsb-worksheet-reader.ts", "utf8");
    const cases = [...source.matchAll(/^\s*case "(Brt[A-Za-z]+)":/gm)].map(match => match[1]!);
    expect(cases.length).toBeGreaterThan(5);
    expect(cases.filter(name => name.startsWith("BrtShort"))).toEqual([]);
  });
});

describe("Stream.WorkbookReader on a binary package", () => {
  /** Sheet names and per-sheet row counts from a streamed read. */
  async function streamRead(
    file: string
  ): Promise<{ names: string[]; firstRow: Map<string, unknown>; rows: number[] }> {
    const { Stream } = await import("@excel");
    const reader = new Stream.WorkbookReader(file, {
      worksheets: "emit",
      sharedStrings: "cache",
      entries: "ignore"
    } as never);
    const names: string[] = [];
    const rows: number[] = [];
    const firstRow = new Map<string, unknown>();
    for await (const sheet of reader as unknown as AsyncIterable<{
      name: string;
      [Symbol.asyncIterator]: () => AsyncIterator<unknown>;
    }>) {
      let count = 0;
      for await (const row of sheet as unknown as AsyncIterable<unknown>) {
        count++;
        if (names.length === 0) {
          const model = rowGetModel(row as never) as unknown as {
            cells?: readonly ({ address: string; value?: unknown } | undefined)[];
          };
          for (const cell of model?.cells ?? []) {
            if (cell !== undefined) {
              firstRow.set(cell.address, cell.value);
            }
          }
        }
      }
      names.push(sheet.name);
      rows.push(count);
    }
    return { names, firstRow, rows };
  }

  it("names every sheet the way the buffered reader does", async () => {
    // **As a set, not a sequence.** A streaming reader emits in ZIP order and the buffered one in the workbook's
    // declared order, so requiring the sequences to match would be asserting something neither container promises —
    // the XML streaming reader emits in ZIP order too. What must hold is that every sheet is present and *correctly
    // named*, which is what catches the failure this replaced: names were resolved as `sheets[n - 1]`, and a package
    // numbers its worksheet parts independently of the bundle, so the names came out shifted.
    const file = richXlsb;
    const streamed = await streamRead(file);
    const handle = Workbook.create();
    await Workbook.read(handle, Uint8Array.from(await readFile(file)));
    const buffered = Workbook.getModel(handle).worksheets.map(sheet => sheet.name);
    expect([...streamed.names].sort()).toEqual([...buffered].sort());
  });

  it("streams the plain values identically", async () => {
    // **This is the assertion the shared-string table's ordering nearly broke.** `sharedStrings.bin` follows the sheets
    // in this library's own packages, so every sheet is spooled and replayed — and a first version compared the part
    // path in lower case while `normalizeZipPath` does not lower-case, so the table was never parsed and every string
    // cell streamed as `""`. Values, not counts, are what catches that.
    const file = richXlsb;
    const streamed = await streamRead(file);
    const handle = Workbook.create();
    await Workbook.read(handle, Uint8Array.from(await readFile(file)));
    const reference = Workbook.getWorksheets(handle)[0];
    let compared = 0;
    for (const [address, value] of streamed.firstRow) {
      const expected = Cell.getValue(reference, address);
      if (expected !== null && typeof expected === "object") {
        continue;
      }
      compared++;
      expect(value ?? null, address).toEqual(expected ?? null);
    }
    expect(compared).toBeGreaterThan(20);
  });

  it("replays a sheet spooled before its shared strings", async () => {
    // The deferral path, and it needs a package built for it: **this library writes `sharedStrings.bin` before its
    // sheets**, so its own output never defers. A reordered copy is the only way to exercise the branch, and it has to
    // be exercised — a `.bin` sheet replayed through the XML parser fails with `The encoded data was not valid for
    // encoding utf-8`, which names the symptom and not the cause, so the spool record carries which container the
    // entry came from rather than the replay inferring it.
    const source = richXlsb;
    const parts = await extractAll(Uint8Array.from(await readFile(source)));
    const { ZipArchive } = await import("@archive/zip");
    const zip = new ZipArchive();
    // Sheets first, everything else after — the order Excel itself sometimes writes.
    for (const [path, file] of parts) {
      if (/worksheets\/sheet\d+\.bin$/.test(path)) {
        zip.add(path, file.data);
      }
    }
    for (const [path, file] of parts) {
      if (!/worksheets\/sheet\d+\.bin$/.test(path)) {
        zip.add(path, file.data);
      }
    }
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { writeFile } = await import("node:fs/promises");
    const directory = await mkdtemp(join(tmpdir(), "documonster-xlsb-defer-"));
    const target = join(directory, "reordered.xlsb");
    await writeFile(target, await zip.bytes());

    const streamed = await streamRead(target);
    expect(streamed.names.length).toBeGreaterThan(0);
    expect(streamed.rows[0]).toBeGreaterThan(0);
    // And the strings survived the deferral, which is the point: a replay that lost the table would give every string
    // cell the empty string and still produce rows.
    const values = [...streamed.firstRow.values()].filter(value => typeof value === "string");
    expect(values.some(value => value !== "")).toBe(true);
  });

  it("still reads an XLSX package", async () => {
    // The branch is new; the path it was added beside is not. A regression here would be silent for anyone reading
    // XML, which is everyone today.
    const streamed = await streamRead(richXlsx);
    expect(streamed.names.length).toBeGreaterThan(0);
    expect(streamed.rows[0]).toBeGreaterThan(0);
  });
});
