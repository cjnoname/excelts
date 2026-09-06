/**
 * XLSB through the canonical workbook API.
 *
 * The format is a choice on the same functions, not a second API, and these tests pin both
 * halves of that: every path reaches the binary format, and none of them changes what an XLSX
 * caller sees.
 *
 * The second half matters as much as the first. Format detection means reading the ZIP central
 * directory of every buffer handed to `read`, and there are two easy ways to make that
 * expensive — decoding a base64 string twice, or inflating the whole package to check one file
 * name. Both are asserted against here, because neither shows up as a test failure.
 */

import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";

import { extractAll } from "@archive/unzip/extract";
import { ZipArchive } from "@archive/zip";
import { Cell, DefinedNames, Workbook, Worksheet } from "@excel";
import { expectValidXlsb } from "@excel/__tests__/helpers/expect-valid-xlsb";
import { expectValidXlsx } from "@excel/__tests__/helpers/expect-valid-xlsx";
import { ExcelNotSupportedError } from "@excel/errors";
import { biff, rowHeader } from "@test/biff-fixture";
import { describeWorkbook } from "@test/workbook-describe";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/** A workbook exercising everything the XLSB writer expresses. */
function sampleWorkbook(): Workbook.Handle {
  const workbook = Workbook.create();
  const data = Workbook.addWorksheet(workbook, "Data");
  Worksheet.addAoa(data, [
    ["Region", "Q1", "Q2"],
    ["North", 1250, 1310.5],
    ["South", 980, 0.1]
  ]);
  Cell.setValue(data, "D1", true);
  Cell.setValue(data, "D2", { formula: "B2+C2", result: 2560.5 });
  const summary = Workbook.addWorksheet(workbook, "Summary");
  Cell.setValue(summary, "A1", { formula: "SUM(Data!B2:C3)", result: 3540.6 });
  return workbook;
}

let directory: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "documonster-xlsb-api-"));
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("format selection", () => {
  it("writes XLSB when the format says so", async () => {
    const bytes = await Workbook.toBuffer(sampleWorkbook(), { format: "xlsb" });
    await expectValidXlsb(bytes, { includeWarnings: true });
    // On Node the canonical writer returns a Buffer, and that must not change per format.
    expect(Buffer.isBuffer(bytes)).toBe(true);
  });

  it("still writes XLSX by default", async () => {
    const bytes = await Workbook.toBuffer(sampleWorkbook());
    await expectValidXlsx(bytes);
  });

  it("detects XLSB from the package contents", async () => {
    const source = sampleWorkbook();
    const reopened = Workbook.create();
    await Workbook.read(reopened, await Workbook.toBuffer(source, { format: "xlsb" }));
    expect(describeWorkbook(reopened)).toBe(describeWorkbook(source));
  });

  it("detects XLSX from the package contents", async () => {
    const source = sampleWorkbook();
    const reopened = Workbook.create();
    await Workbook.read(reopened, await Workbook.toBuffer(source));
    expect(describeWorkbook(reopened)).toBe(describeWorkbook(source));
  });

  it("detects through a base64 string, decoding it once", async () => {
    const source = sampleWorkbook();
    const base64 = Buffer.from(await Workbook.toBuffer(source, { format: "xlsb" })).toString(
      "base64"
    );
    const reopened = Workbook.create();
    await Workbook.read(reopened, base64, { base64: true });
    expect(describeWorkbook(reopened)).toBe(describeWorkbook(source));
  });

  it("honours an explicit format over what the bytes are", async () => {
    // Forcing `xlsx` on an XLSB package must fail in the XLSX loader rather than silently
    // succeed through detection — a caller who says what the format is has said something.
    const bytes = await Workbook.toBuffer(sampleWorkbook(), { format: "xlsb" });
    const workbook = Workbook.create();
    await expect(Workbook.read(workbook, bytes, { format: "xlsx" })).rejects.toThrow();
  });

  it("rejects an XLSX package read as XLSB with a message that says why", async () => {
    const bytes = await Workbook.toBuffer(sampleWorkbook());
    const workbook = Workbook.create();
    await expect(Workbook.read(workbook, bytes, { format: "xlsb" })).rejects.toThrow(
      /no xl\/workbook\.bin/
    );
  });
});

describe("file paths", () => {
  it("writes and reads XLSB from the extension alone", async () => {
    // `writeFile(wb, "report.xlsb")` with no second argument is the shape a caller expects.
    const source = sampleWorkbook();
    const path = join(directory, "report.xlsb");
    await Workbook.writeFile(source, path);
    await expectValidXlsb(await readFile(path), { includeWarnings: true });

    const reopened = Workbook.create();
    await Workbook.readFile(reopened, path);
    expect(describeWorkbook(reopened)).toBe(describeWorkbook(source));
  });

  it("keeps writing XLSX for every other extension", async () => {
    const path = join(directory, "report.xlsx");
    await Workbook.writeFile(sampleWorkbook(), path);
    await expectValidXlsx(await readFile(path));
  });

  it("lets an explicit format override the extension", async () => {
    // Both directions, because the extension is a default and not a rule.
    const misnamed = join(directory, "actually-binary.xlsx");
    await Workbook.writeFile(sampleWorkbook(), misnamed, { format: "xlsb" });
    await expectValidXlsb(await readFile(misnamed), { includeWarnings: true });

    const reopened = Workbook.create();
    await Workbook.readFile(reopened, misnamed, { format: "xlsb" });
    expect(describeWorkbook(reopened)).toBe(describeWorkbook(sampleWorkbook()));
  });

  it("reports the path when a file is not the format it was read as", async () => {
    const path = join(directory, "not-a-workbook.xlsb");
    await writeFile(path, "this is not a zip");
    const workbook = Workbook.create();
    await expect(Workbook.readFile(workbook, path)).rejects.toThrow();
  });
});

describe("streams", () => {
  it("produces a readable byte stream", async () => {
    const source = sampleWorkbook();
    const path = join(directory, "streamed.xlsb");
    await pipeline(Workbook.toStream(source, { format: "xlsb" }), createWriteStream(path));

    const reopened = Workbook.create();
    await Workbook.readFile(reopened, path);
    expect(describeWorkbook(reopened)).toBe(describeWorkbook(source));
  });

  it("writes to a sink", async () => {
    const source = sampleWorkbook();
    const path = join(directory, "sunk.xlsb");
    await Workbook.writeStream(source, createWriteStream(path), { format: "xlsb" });

    const reopened = Workbook.create();
    await Workbook.readFile(reopened, path);
    expect(describeWorkbook(reopened)).toBe(describeWorkbook(source));
  });

  it("surfaces an assembly failure as a stream error, not a hang", async () => {
    // The XLSX path reports serialisation failures through `'error'`, and the XLSB path must do the same rather than
    // leaving the consumer waiting.
    //
    // **This case caught a real regression when `toStream` was rebuilt on the part-by-part writer.** The refusal used to
    // be applied *after* `streamXlsbPackage` returned — which worked while the package was assembled up front and the
    // throw came before any push, and stopped working the moment production became incremental: the readable had already
    // been ended, so the error reached nobody and a workbook with unwritable content streamed to a clean finish. The
    // policy is applied before the archive is finalised now, so this holds for both shapes.
    const workbook = Workbook.create();
    Cell.setValue(Workbook.addWorksheet(workbook, "Hard"), "A1", {
      formula: "MATCH(1,{1,2},0)",
      result: 1
    });
    const stream = Workbook.toStream(workbook, { format: "xlsb" });
    await expect(
      (async () => {
        for await (const chunk of stream) {
          void chunk;
        }
      })()
    ).rejects.toThrow(ExcelNotSupportedError);
  });

  it("does not leave a readable package behind when it refuses", async () => {
    // The other half of applying the policy before `finalize`. `writeStream` used to hand a *complete* archive to the
    // destination and then throw, so a caller who ignored the rejection was left with a file that opened perfectly and
    // was missing content the writer had promised to refuse over. A ZIP with no central directory cannot be mistaken
    // for a finished one.
    const workbook = Workbook.create();
    Cell.setValue(Workbook.addWorksheet(workbook, "Hard"), "A1", {
      formula: "MATCH(1,{1,2},0)",
      result: 1
    } as never);
    // A collecting sink rather than a file. Two attempts with `createWriteStream` were flaky in opposite directions —
    // first a zero-length read, then `ENOENT`, because the refusal now happens early enough that the file had not been
    // opened. What is being asserted is what the *destination* received, and an in-memory one answers that exactly.
    const chunks: Uint8Array[] = [];
    const sink = {
      write(chunk: Uint8Array) {
        chunks.push(Uint8Array.from(chunk));
        return true;
      },
      end() {}
    };
    await expect(Workbook.writeStream(workbook, sink as never, { format: "xlsb" })).rejects.toThrow(
      ExcelNotSupportedError
    );
    // **The invariant is "not a package", not "some bytes".** How much reached the sink before the refusal is not the
    // point and is not stable; that it cannot be read back as a workbook is.
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const written = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
      written.set(chunk, at);
      at += chunk.length;
    }
    await expect(Workbook.read(Workbook.create(), written)).rejects.toThrow();
  });
});

describe("content the writer cannot express", () => {
  it("refuses the write and names the cells", async () => {
    // Silently writing the cached result would produce a file that opens, looks right, and
    // never recalculates — so the default is to refuse, and the message says which cells.
    const workbook = Workbook.create();
    const sheet = Workbook.addWorksheet(workbook, "Hard");
    Cell.setValue(sheet, "A1", { formula: "MATCH(1,{1,2,3},0)", result: 1 });
    // **Two features have left this test in one session.** Rich text is written now — a `RichStr` carries the
    // runs and their fonts go into the styles part — and so are the eight `BErr` error values. What remains
    // unwritable is an error with no `BErr` code at all: `#SPILL!` and the rest of the dynamic-array family
    // postdate the enumeration, so substituting `#VALUE!` would be a different error rather than a loss.
    Cell.setValue(sheet, "A2", { error: "#SPILL!" } as never);

    await expect(Workbook.toBuffer(workbook, { format: "xlsb" })).rejects.toThrow(
      ExcelNotSupportedError
    );
    await expect(Workbook.toBuffer(workbook, { format: "xlsb" })).rejects.toThrow(
      /Hard!A1: formula.*Hard!A2: error value #SPILL!/s
    );
  });

  it("writes blanks when told to ignore the loss", async () => {
    const workbook = Workbook.create();
    const sheet = Workbook.addWorksheet(workbook, "Hard");
    Cell.setValue(sheet, "A1", { formula: "MATCH(1,{1,2,3},0)", result: 1 });
    Cell.setValue(sheet, "A2", "kept");

    const bytes = await Workbook.toBuffer(workbook, { format: "xlsb", unsupported: "ignore" });
    await expectValidXlsb(bytes, { includeWarnings: true });

    const reopened = Workbook.create();
    await Workbook.read(reopened, bytes);
    // Both survive: `A2` outright, and `A1` as its cached result with the expression reported as lost. `A1` used to
    // come back blank — see `write/worksheet.ts` for why keeping the value loses strictly less.
    expect(describeWorkbook(reopened)).toBe('Hard!A1 number 1\nHard!A2 string "kept"');
  });

  it("does not refuse an XLSX write for the same content", async () => {
    // The restriction belongs to the XLSB writer, not to the workbook.
    const workbook = Workbook.create();
    Cell.setValue(Workbook.addWorksheet(workbook, "Hard"), "A1", {
      formula: "MATCH(1,{1,2,3},0)",
      result: 1
    });
    await expectValidXlsx(await Workbook.toBuffer(workbook));
  });
});

describe("round trips carry the content", () => {
  it("preserves values, formulas and sheet order", async () => {
    const source = sampleWorkbook();
    const bytes = await Workbook.toBuffer(source, { format: "xlsb" });
    const reopened = Workbook.create();
    await Workbook.read(reopened, bytes);

    expect(describeWorkbook(reopened)).toBe(describeWorkbook(source));
    expect(Workbook.getWorksheets(reopened).map(sheet => Worksheet.getName(sheet))).toEqual([
      "Data",
      "Summary"
    ]);
  });

  it("survives a second cycle", async () => {
    // Reading back what was written and writing it again is where an asymmetry between the
    // two directions shows up.
    const source = sampleWorkbook();
    const once = Workbook.create();
    await Workbook.read(once, await Workbook.toBuffer(source, { format: "xlsb" }));
    const twice = Workbook.create();
    await Workbook.read(twice, await Workbook.toBuffer(once, { format: "xlsb" }));
    expect(describeWorkbook(twice)).toBe(describeWorkbook(source));
  });

  it("carries text that exercises the encoding", async () => {
    const source = Workbook.create();
    const sheet = Workbook.addWorksheet(source, "Unicode");
    const values = ["héllo", "日本語", "😀 emoji", 'quote "inside"', "  spaced  "];
    values.forEach((value, index) => Cell.setValue(sheet, `A${index + 1}`, value));

    const reopened = Workbook.create();
    await Workbook.read(reopened, await Workbook.toBuffer(source, { format: "xlsb" }));
    expect(describeWorkbook(reopened)).toBe(describeWorkbook(source));
  });

  it("scales to a sheet with many rows", async () => {
    const source = Workbook.create();
    const sheet = Workbook.addWorksheet(source, "Big");
    for (let row = 1; row <= 2000; row++) {
      Cell.setValue(sheet, `A${row}`, row);
      Cell.setValue(sheet, `B${row}`, `row ${row}`);
    }

    const bytes = await Workbook.toBuffer(source, { format: "xlsb" });
    await expectValidXlsb(bytes, { includeWarnings: true });
    const reopened = Workbook.create();
    await Workbook.read(reopened, bytes);
    expect(describeWorkbook(reopened)).toBe(describeWorkbook(source));
  });

  it("is smaller than the same workbook as XLSX", async () => {
    // Not a performance budget — the reason a caller asks for XLSB at all, and a sanity check
    // that the binary path is really binary.
    const source = Workbook.create();
    const sheet = Workbook.addWorksheet(source, "Numbers");
    for (let row = 1; row <= 2000; row++) {
      Cell.setValue(sheet, `A${row}`, row * 1.5);
    }
    const xlsx = await Workbook.toBuffer(source);
    const xlsb = await Workbook.toBuffer(source, { format: "xlsb" });
    expect(xlsb.length).toBeLessThan(xlsx.length);
  });
});

/**
 * What `Workbook.read` does to a workbook that already had contents.
 *
 * The XLSX reader builds a model and applies it with `setWorkbookModel`, so it has always *replaced*.
 * The XLSB reader mutated the target as it went, so it *added* — and the two are behind one public
 * function, which cannot be a place where "read" means two different things. Neither test below can
 * fail against a fresh workbook, which is why nothing caught this: every other test reads into
 * `Workbook.create()`.
 */
describe("reading into a workbook that is not empty", () => {
  async function binaryWorkbook(): Promise<Uint8Array> {
    const source = Workbook.create();
    const sheet = Workbook.addWorksheet(source, "FromFile");
    Cell.setValue(sheet, "A1", "from the file");
    return Workbook.toBuffer(source, { format: "xlsb" });
  }

  it("replaces the sheets rather than appending to them", async () => {
    const target = Workbook.create();
    Cell.setValue(Workbook.addWorksheet(target, "Existing"), "A1", "was here first");
    await Workbook.read(target, await binaryWorkbook());
    expect(Workbook.getWorksheets(target).map(sheet => Worksheet.getName(sheet))).toEqual([
      "FromFile"
    ]);
  });

  it("replaces the defined names rather than merging them", async () => {
    const target = Workbook.create();
    Cell.setValue(Workbook.addWorksheet(target, "Existing"), "A1", 1);
    DefinedNames.add(Workbook.getDefinedNames(target), "Existing!$A$1", "Stale");
    await Workbook.read(target, await binaryWorkbook());
    expect(Workbook.getModel(target).definedNames.map(entry => entry.name)).not.toContain("Stale");
  });

  it("survives a sheet name the target already uses", async () => {
    // The old reader called `addWorksheet` on the target, so this threw on the duplicate — after it
    // had already changed the epoch and added the names.
    const target = Workbook.create();
    Cell.setValue(Workbook.addWorksheet(target, "FromFile"), "A1", "was here first");
    await Workbook.read(target, await binaryWorkbook());
    expect(Cell.getValue(Workbook.getWorksheet(target, "FromFile")!, "A1")).toBe("from the file");
  });

  it("leaves the target untouched when the read fails", async () => {
    const target = Workbook.create();
    Cell.setValue(Workbook.addWorksheet(target, "Existing"), "A1", "still here");
    target.properties = { ...target.properties, date1904: true };
    // The workbook part reads cleanly and the *worksheet* part does not, so the failure lands after
    // the reader has already assigned the epoch, added the defined names and created the sheet. A
    // package that fails earlier than that cannot test this: the first attempt at this test used one,
    // and it passed against the very behaviour it was written to catch.
    const archive = new ZipArchive();
    archive.add(
      "xl/_rels/workbook.bin.rels",
      '<?xml version="1.0"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.bin"/>' +
        "</Relationships>"
    );
    archive.add(
      "xl/workbook.bin",
      biff([
        ["BrtBeginBook"],
        ["BrtBeginBundleShs"],
        ["BrtBundleSh", { state: 0, tabId: 1, relId: "rId1", name: "Incoming" }],
        ["BrtEndBundleShs"],
        ["BrtEndBook"]
      ])
    );
    archive.add("xl/worksheets/sheet1.bin", new Uint8Array([0xff, 0xff, 0xff, 0xff]));
    await expect(Workbook.read(target, await archive.bytes())).rejects.toThrow();
    // Nothing half-applied: the sheet, its value and the epoch are all as they were.
    expect(Workbook.getWorksheets(target).map(sheet => Worksheet.getName(sheet))).toEqual([
      "Existing"
    ]);
    expect(Cell.getValue(Workbook.getWorksheet(target, "Existing")!, "A1")).toBe("still here");
    expect(target.properties.date1904).toBe(true);
  });
});

/** A package whose one cell uses `BrtShortReal`, whose layout is deliberately undeclared. */
async function packageWithUnreadableCell(): Promise<Uint8Array> {
  const archive = new ZipArchive();
  archive.add(
    "xl/_rels/workbook.bin.rels",
    '<?xml version="1.0"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.bin"/>' +
      "</Relationships>"
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
  // `BrtShortReal` is one of the seven `BrtShort*` records this library declines to guess at. Its
  // payload here is a plausible eight-byte double, and the point is that the reader does *not*
  // interpret it — so the cell is lost and has to be reported.
  archive.add(
    "xl/worksheets/sheet1.bin",
    biff([
      ["BrtBeginSheet"],
      ["BrtWsDim", { ref: { firstRow: 0, lastRow: 0, firstColumn: 0, lastColumn: 0 } }],
      ["BrtBeginSheetData"],
      ["BrtRowHdr", rowHeader({ row: 0 })],
      ["BrtShortReal", new Uint8Array([0, 0, 0, 0, 0, 0, 0x24, 0x40])],
      ["BrtEndSheetData"],
      ["BrtEndSheet"]
    ])
  );
  return archive.bytes();
}

/**
 * What a read could not recover, and how a caller finds out.
 *
 * The reader has always collected this — `unreadRecords`, `undecodedFormulas`, error cells — and the
 * public entry point discarded all of it. So a workbook whose cells used a record whose layout is
 * unestablished resolved successfully, came back with those cells missing, and said nothing; saving it
 * again made the loss permanent.
 *
 * The default stays `"ignore"`, and that is not a compromise: refusing to *read* a real file because
 * part of it is unimplemented would make the reader useless for the files people actually have. What
 * `"error"` adds is the ability to say "I am converting, so stop if anything is lost".
 */
describe("read diagnostics", () => {
  it("reads the workbook and stays quiet by default", async () => {
    const workbook = Workbook.create();
    await Workbook.read(workbook, await packageWithUnreadableCell());
    // The sheet survives; only the cell it could not decode is gone.
    expect(Workbook.getWorksheets(workbook).map(sheet => Worksheet.getName(sheet))).toEqual(["S1"]);
  });

  it("refuses when the caller asks it to", async () => {
    const workbook = Workbook.create();
    await expect(
      Workbook.read(workbook, await packageWithUnreadableCell(), { unsupported: "error" })
    ).rejects.toThrow(/S1: 1 cell\(s\) in BrtShortReal/);
  });

  it("carries the list on the error rather than only in its message", async () => {
    const workbook = Workbook.create();
    // Parsing a sentence to find out what was lost is not an API. A converter reporting
    // "these cells need attention" reads `items`.
    let thrown: unknown;
    try {
      await Workbook.read(workbook, await packageWithUnreadableCell(), { unsupported: "error" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ExcelNotSupportedError);
    expect((thrown as ExcelNotSupportedError).items).toEqual(["S1: 1 cell(s) in BrtShortReal"]);
  });

  it("reports a declared sheet whose part is not in the package", async () => {
    // The empty sheet keeps the sheet list matching what the workbook declares, which is the right
    // repair — but a whole worksheet is missing, and that reaching the caller unremarked while a single
    // undecodable cell did not was the wrong way round.
    const archive = new ZipArchive();
    archive.add(
      "xl/_rels/workbook.bin.rels",
      '<?xml version="1.0"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.bin"/>' +
        "</Relationships>"
    );
    archive.add(
      "xl/workbook.bin",
      biff([
        ["BrtBeginBook"],
        ["BrtBeginBundleShs"],
        ["BrtBundleSh", { state: 0, tabId: 1, relId: "rId1", name: "Ghost" }],
        ["BrtEndBundleShs"],
        ["BrtEndBook"]
      ])
    );
    const bytes = await archive.bytes();
    await expect(Workbook.read(Workbook.create(), bytes, { unsupported: "error" })).rejects.toThrow(
      /Ghost: worksheet part is missing from the package/
    );
    // And by default the sheet still exists, so nothing after it shifts.
    const workbook = Workbook.create();
    await Workbook.read(workbook, bytes);
    expect(Workbook.getWorksheets(workbook).map(sheet => Worksheet.getName(sheet))).toEqual([
      "Ghost"
    ]);
  });

  it("reports trailing bytes it cannot read as formatting runs", async () => {
    // Formatting runs themselves are read now. What this fixture has is not runs: its flag byte is `0x00`,
    // so `fRichStr` is clear and the five bytes after the text are not a `StrRun` array — a record longer
    // than the shape it declares. The text is complete, so the string is read and those bytes are what is
    // lost, which is the right trade and one the reader used to describe in a comment and report to nobody.
    const archive = new ZipArchive();
    archive.add(
      "xl/_rels/workbook.bin.rels",
      '<?xml version="1.0"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.bin"/>' +
        "</Relationships>"
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
        ["BrtRowHdr", rowHeader({ row: 0 })],
        ["BrtCellIsst", { cell: { column: 0, styleIndex: 0 }, isst: 0 }],
        ["BrtEndSheetData"],
        ["BrtEndSheet"]
      ])
    );
    // `BrtSSTItem` with bytes past the declared layout, which is exactly the shape formatting runs
    // arrive in — the decoder reports them as a remainder rather than dropping them unseen.
    archive.add(
      "xl/sharedStrings.bin",
      biff([
        ["BrtBeginSst", new Uint8Array([1, 0, 0, 0, 1, 0, 0, 0])],
        [
          "BrtSSTItem",
          new Uint8Array([0x00, 0x02, 0, 0, 0, 0x62, 0, 0x6f, 0, 0x01, 0x00, 0x00, 0x00, 0x00])
        ],
        ["BrtEndSst"]
      ])
    );
    await expect(
      Workbook.read(Workbook.create(), await archive.bytes(), { unsupported: "error" })
    ).rejects.toThrow(/unreadable trailing bytes on 1 string/);
  });

  it("reads an error-valued cell as its error, and reports only an unrecognised code", async () => {
    // `BrtCellError` used to decode to `null`, indistinguishable from `BrtCellBlank`, so a sheet of `#N/A`
    // came back as a sheet of blanks. The reason given was that no corpus workbook established the code
    // mapping; five now do, and all five agree with MS-XLSB 2.5.98.2 — so the eight known codes are read as
    // values and only a byte outside the table is still reported.
    const archive = new ZipArchive();
    archive.add(
      "xl/_rels/workbook.bin.rels",
      '<?xml version="1.0"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.bin"/>' +
        "</Relationships>"
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
        ["BrtWsDim", { ref: { firstRow: 0, lastRow: 0, firstColumn: 1, lastColumn: 1 } }],
        ["BrtBeginSheetData"],
        ["BrtRowHdr", rowHeader({ row: 0 })],
        // `0x07` is `#DIV/0!` — one of the four codes Excel's own files confirm.
        ["BrtCellError", { cell: { column: 1, styleIndex: 0 }, error: 0x07 }],
        // `0x99` is not in the table, so it is the case that must still be reported rather than guessed.
        ["BrtCellError", { cell: { column: 2, styleIndex: 0 }, error: 0x99 }],
        ["BrtEndSheetData"],
        ["BrtEndSheet"]
      ])
    );
    const bytes = await archive.bytes();
    await expect(Workbook.read(Workbook.create(), bytes, { unsupported: "error" })).rejects.toThrow(
      /S1!C1: error value/
    );

    const workbook = Workbook.create();
    await Workbook.read(workbook, bytes);
    // The known code is the cell's value, in the shape the model gives an error.
    expect(Cell.getValue(Workbook.getWorksheet(workbook, "S1")!, "B1")).toEqual({
      error: "#DIV/0!"
    });
    // The unknown one is still a blank, which is the honest outcome for a byte with no meaning here.
    expect(Cell.getValue(Workbook.getWorksheet(workbook, "S1")!, "C1")).toBeNull();
  });
});

/**
 * A strict read that refuses must leave the target alone.
 *
 * The scratch workbook made a *parse* failure atomic and stopped there: the diagnostics were checked
 * after the commit, so `{ unsupported: "error" }` meant "replace the workbook, then report failure".
 * A rejection the caller cannot recover from is the thing the scratch workbook exists to prevent, so
 * this is the case that decides whether it works.
 */
describe("a refused strict read", () => {
  it("does not touch the target", async () => {
    const target = Workbook.create();
    Cell.setValue(Workbook.addWorksheet(target, "Existing"), "A1", "still here");
    await expect(
      Workbook.read(target, await packageWithUnreadableCell(), { unsupported: "error" })
    ).rejects.toThrow();
    expect(Workbook.getWorksheets(target).map(sheet => Worksheet.getName(sheet))).toEqual([
      "Existing"
    ]);
    expect(Cell.getValue(Workbook.getWorksheet(target, "Existing")!, "A1")).toBe("still here");
  });
});

/**
 * Document properties, which were excluded from preservation and then never read.
 *
 * `docProps/core.xml` and `docProps/app.xml` are authored by both writers from `WorkbookModel`, so
 * preserving their bytes as well produces a package that declares each part twice — which Excel
 * rejects. Excluding them from preservation while never *reading* them is the other half of that
 * decision, and it silently replaced every property with a fresh workbook's default: `creator` came
 * back as `"Unknown"`.
 */
describe("document properties survive XLSB", () => {
  it("keeps what the file said", async () => {
    const source = Workbook.create();
    source.creator = "Alice";
    source.lastModifiedBy = "Bob";
    source.title = "Quarterly";
    source.subject = "Revenue";
    source.company = "ACME";
    source.manager = "Carol";
    Cell.setValue(Workbook.addWorksheet(source, "S1"), "A1", 1);

    const reopened = Workbook.create();
    await Workbook.read(reopened, await Workbook.toBuffer(source, { format: "xlsb" }));
    expect(reopened.creator).toBe("Alice");
    expect(reopened.lastModifiedBy).toBe("Bob");
    expect(reopened.title).toBe("Quarterly");
    expect(reopened.subject).toBe("Revenue");
    expect(reopened.company).toBe("ACME");
    expect(reopened.manager).toBe("Carol");
  });
});

/** The origin, which decides how a relative path is later resolved. */
describe("sourceFilePath", () => {
  it("is the file a read came from", async () => {
    const source = Workbook.create();
    Cell.setValue(Workbook.addWorksheet(source, "S1"), "A1", 1);
    const file = join(directory, "origin.xlsb");
    await writeFile(file, await Workbook.toBuffer(source, { format: "xlsb" }));
    const workbook = Workbook.create();
    await Workbook.readFile(workbook, file);
    expect((workbook as { sourceFilePath?: string }).sourceFilePath).toBe(file);
  });

  it("is cleared when a read came from a buffer", async () => {
    const source = Workbook.create();
    Cell.setValue(Workbook.addWorksheet(source, "S1"), "A1", 1);
    const workbook = Workbook.create();
    // A stale origin is worse than none: a later relative path would resolve against a file this
    // workbook no longer holds.
    (workbook as { sourceFilePath?: string }).sourceFilePath = "/somewhere/old.xlsx";
    await Workbook.read(workbook, await Workbook.toBuffer(source, { format: "xlsb" }));
    expect((workbook as { sourceFilePath?: string }).sourceFilePath).toBeUndefined();
  });
});

/** Reading and inspecting, which neither the default nor `"error"` allows on its own. */
describe("readWithDiagnostics", () => {
  it("returns the workbook and the report together", async () => {
    const workbook = Workbook.create();
    const report = await Workbook.readWithDiagnostics(workbook, await packageWithUnreadableCell());
    expect(Worksheet.getName(Workbook.getWorksheets(report.workbook)[0]!)).toBe("S1");
    expect(report.lost).toEqual(["S1: 1 cell(s) in BrtShortReal"]);
  });

  it("hands back the structured diagnostics, not only the prose", async () => {
    // `lost` aggregates — one line per sheet — so the per-record counts are deliberately not in it. A
    // converter reporting "1,400 cells use BrtShortReal" should not have to parse a sentence for that.
    const report = await Workbook.readWithDiagnostics(
      Workbook.create(),
      await packageWithUnreadableCell()
    );
    expect(report.unreadRecords.get("BrtShortReal")).toBe(1);
    expect(report.undecodedFormulas).toEqual([]);
    expect(report.sharedFormulaCells).toEqual([]);
  });

  it("reports unknown record ids separately from losses", async () => {
    // A record id this library has no name for is usually a newer schema's extension rather than
    // missing content, so it is deliberately not a loss — but a caller who wants to know can.
    const workbook = Workbook.create();
    const source = Workbook.create();
    Cell.setValue(Workbook.addWorksheet(source, "S1"), "A1", 1);
    const report = await Workbook.readWithDiagnostics(
      workbook,
      await Workbook.toBuffer(source, { format: "xlsb" })
    );
    expect(report.lost).toEqual([]);
    expect(report.unknownRecords.size).toBe(0);
  });
});

/**
 * A binary workbook handed to the XML reader.
 *
 * `read()` sniffs the package and refuses this, but the guard is bypassed whenever the format was not
 * inferred from the bytes: `readFile` trusting an extension, or any caller passing `format: "xlsx"`. The
 * XLSX reader then finds none of the parts it knows and returns an **empty workbook** with no error, so
 * the failure looks like a file with no data in it.
 *
 * Checked inside the XLSX loader rather than at each entry point, because that is the one place that has
 * already seen the part names — and it therefore covers `read`, `readFile` and `readStream` at once.
 */
describe("an XLSB package cannot be read as XLSX", () => {
  it("refuses a forced format instead of returning an empty workbook", async () => {
    const source = Workbook.create();
    Cell.setValue(Workbook.addWorksheet(source, "S1"), "A1", 42);
    const bytes = await Workbook.toBuffer(source, { format: "xlsb" });
    await expect(Workbook.read(Workbook.create(), bytes, { format: "xlsx" })).rejects.toThrow(
      /xl\/workbook\.bin/
    );
  });

  it("refuses a misnamed file", async () => {
    const source = Workbook.create();
    Cell.setValue(Workbook.addWorksheet(source, "S1"), "A1", 42);
    // The extension says XLSX and the bytes say otherwise. `readFile` streams rather than sniffing, so
    // this is the case the loader-level check exists for.
    const file = join(directory, "misnamed.xlsx");
    await writeFile(file, await Workbook.toBuffer(source, { format: "xlsb" }));
    await expect(Workbook.readFile(Workbook.create(), file)).rejects.toThrow(/xl\/workbook\.bin/);
  });

  it("still reads a genuine XLSX", async () => {
    const source = Workbook.create();
    Cell.setValue(Workbook.addWorksheet(source, "S1"), "A1", 42);
    const workbook = Workbook.create();
    await Workbook.read(workbook, await Workbook.toBuffer(source), { format: "xlsx" });
    expect(Cell.getValue(Workbook.getWorksheet(workbook, "S1")!, "A1")).toBe(42);
  });
});

/**
 * The theme, which a `{ theme: n }` colour resolves through.
 *
 * An XLSB read keeps it as an opaque part, so a same-format round trip preserved it and nothing noticed
 * that an **XLSX** read models it instead — and this writer looked only at the opaque set. So every
 * XLSX→XLSB conversion produced a package whose cells still carried theme indices and whose theme part
 * was gone: a workbook Excel renders in different colours, with every structural check passing.
 */
describe("themes survive XLSX to XLSB", () => {
  it("writes the modelled theme", async () => {
    const source = Workbook.create();
    const sheet = Workbook.addWorksheet(source, "S1");
    Cell.setValue(sheet, "A1", "themed");
    Cell.setStyle(sheet, "A1", { font: { color: { theme: 4 } } } as never);

    const viaXlsx = Workbook.create();
    await Workbook.read(viaXlsx, await Workbook.toBuffer(source));
    const entries = await extractAll(
      await Workbook.toBuffer(viaXlsx, { format: "xlsb", unsupported: "ignore" })
    );
    expect(entries.has("xl/theme/theme1.xml")).toBe(true);
    // And the workbook points at it, or the part is present and unreachable.
    const rels = new TextDecoder().decode(entries.get("xl/_rels/workbook.bin.rels")!.data);
    expect(rels).toContain("theme/theme1.xml");
    const types = new TextDecoder().decode(entries.get("[Content_Types].xml")!.data);
    expect(types).toContain("theme+xml");
  });

  it("does not write it twice when the read preserved it", async () => {
    // An XLSB read leaves the theme in `opaqueParts`. Writing the modelled one as well would declare the
    // same part twice, which is a malformed content-types part rather than a redundant one.
    const source = Workbook.create();
    Cell.setValue(Workbook.addWorksheet(source, "S1"), "A1", 1);
    const viaXlsx = Workbook.create();
    await Workbook.read(viaXlsx, await Workbook.toBuffer(source));
    const once = await Workbook.toBuffer(viaXlsx, { format: "xlsb", unsupported: "ignore" });
    const reopened = Workbook.create();
    await Workbook.read(reopened, once);
    const types = new TextDecoder().decode(
      (
        await extractAll(
          await Workbook.toBuffer(reopened, { format: "xlsb", unsupported: "ignore" })
        )
      ).get("[Content_Types].xml")!.data
    );
    expect(types.match(/theme1\.xml/g)).toHaveLength(1);
  });
});

/** The workbook's default font, which every cell that names no font inherits. */
describe("the default font survives an XLSB round trip", () => {
  it("comes back from font index 0", async () => {
    const source = Workbook.create();
    Cell.setValue(Workbook.addWorksheet(source, "S1"), "A1", "x");
    (source as { _defaultFont?: unknown })._defaultFont = { name: "Arial", size: 10 };

    const reopened = Workbook.create();
    await Workbook.read(reopened, await Workbook.toBuffer(source, { format: "xlsb" }));
    // Recovered onto the workbook, which is what makes the *next* write reproduce it rather than fall
    // back to Calibri 11 and restyle every unstyled cell.
    expect(Workbook.getModel(reopened).defaultFont?.name).toBe("Arial");
    expect(Workbook.getModel(reopened).defaultFont?.size).toBe(10);
  });
});
