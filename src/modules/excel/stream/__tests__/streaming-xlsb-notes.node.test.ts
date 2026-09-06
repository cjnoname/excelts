/**
 * A note written through the *streaming* XLSB writer reaches the file, indicator and all.
 *
 * **It reached none of it.** Reported from a generated example: `comments-streaming-writer.xlsb` showed no marker on the
 * annotated cell. The package turned out to have no comments at all — no `xl/comments1.bin`, no VML, no sheet
 * relationships — while the same workbook written two other ways was fine. Streaming XLSX produced `comments1.xml` and
 * the VML; buffered XLSB produced `comments1.bin` and the VML. Only "streaming + XLSB" lost them.
 *
 * Two independent causes, and the first hid the second:
 *
 *  1. `_writeRow` collects a row's notes into the comments writer — *after* an early `return` taken by the XLSB branch.
 *     So nothing ever saw them. And a BIFF12 comments part is written whole at the end, by `commentsFromModel`, which
 *     reads `rows[].cells[].comment` — off a row store that `commit()` has already released. The notes are retained as
 *     rows are committed now, which is small: one entry per annotated cell.
 *  2. With the part present, the *indicator* was still missing, which is what a reader actually sees. It is drawn by the
 *     VML, reached through `BrtLegacyDrawing` — a record that lives **inside** the sheet part, which closes before the
 *     package allocates that relationship. The sheet claims the id and the package writer honours it.
 *
 * So the assertions are of three kinds, because each cause is invisible to the others' test: the part exists, the record
 * naming the VML exists and resolves, and the note comes back through the reader.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { extractAll } from "@archive/unzip/extract";
import { Cell, Stream, Workbook } from "@excel";
import { iterateInterpretableRecords } from "@excel/xlsb/binary";
import { recordSpec } from "@excel/xlsb/spec/records";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "documonster-stream-notes-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Two annotated cells on non-adjacent rows, through the streaming writer. */
async function streamed(format: "xlsx" | "xlsb"): Promise<Uint8Array> {
  const path = join(dir, `notes.${format}`);
  const writer = new Stream.WorkbookWriter({ filename: path, format, useStyles: true });
  const sheet = writer.addWorksheet("S");
  Stream.setCellValue(sheet.getCell("A1"), "cell one");
  Stream.setCellNote(sheet.getCell("A1"), "note on A1");
  Stream.commitRow(sheet.getRow(1));
  // Row 3, so the retained list cannot be confused with "whatever the last row held".
  Stream.setCellValue(sheet.getCell("B3"), "cell two");
  Stream.setCellNote(sheet.getCell("B3"), "note on B3");
  Stream.commitRow(sheet.getRow(3));
  sheet.commit();
  await writer.commit();
  return Uint8Array.from(await readFile(path));
}

/** The same workbook through `Workbook.toBuffer`, which was never broken. */
async function buffered(format: "xlsx" | "xlsb"): Promise<Uint8Array> {
  const workbook = Workbook.create();
  const sheet = Workbook.addWorksheet(workbook, "S");
  Cell.setValue(sheet, "A1", "cell one");
  Cell.setNote(sheet, "A1", "note on A1");
  Cell.setValue(sheet, "B3", "cell two");
  Cell.setNote(sheet, "B3", "note on B3");
  return format === "xlsx"
    ? Workbook.toBuffer(workbook, { format, validate: false })
    : Workbook.toBuffer(workbook, { format, unsupported: "ignore" });
}

describe("notes through the streaming XLSB writer", () => {
  it("writes the comments part and its VML", async () => {
    const parts = await extractAll(await streamed("xlsb"));
    expect([...parts.keys()]).toContain("xl/comments1.bin");
    expect([...parts.keys()]).toContain("xl/drawings/vmlDrawing1.vml");
  });

  it("names the VML from inside the sheet, with an id the package resolves", async () => {
    // **The indicator.** Without this record the comments exist and Excel draws no marker — which is how the defect was
    // noticed. Asserted together with the relationship it names, because a record pointing at an unallocated id would
    // satisfy either check alone.
    const parts = await extractAll(await streamed("xlsb"));
    const sheetPath = [...parts.keys()].find(name => /worksheets\/sheet1\.bin$/.test(name))!;
    const legacy = [...iterateInterpretableRecords(parts.get(sheetPath)!.data, sheetPath)].find(
      entry => recordSpec(entry.id)?.name === "BrtLegacyDrawing"
    );
    expect(legacy, "the sheet must name its legacy drawing").toBeDefined();
    const rels = new TextDecoder().decode(parts.get("xl/worksheets/_rels/sheet1.bin.rels")!.data);
    const vmlId = /Id="(\w+)"[^>]*vmlDrawing/.exec(rels)?.[1];
    expect(vmlId, "the sheet's rels must declare a vmlDrawing").toBeDefined();
    // The record's payload is that relationship id as a wide string; matching its bytes is enough to tie the two.
    const named = new TextDecoder("utf-16le").decode(legacy!.payload.subarray(4));
    expect(named).toBe(vmlId);
  });

  it.each(["xlsx", "xlsb"] as const)("round-trips both notes in %s", async format => {
    const reopened = Workbook.create();
    await Workbook.read(reopened, await streamed(format));
    const sheet = Workbook.getWorksheet(reopened, "S")!;
    expect(Cell.getNote(sheet, "A1")).toBe("note on A1");
    expect(Cell.getNote(sheet, "B3")).toBe("note on B3");
    // The values too: retaining notes must not cost the cells they sit on.
    expect(Cell.getValue(sheet, "A1")).toBe("cell one");
    expect(Cell.getValue(sheet, "B3")).toBe("cell two");
  });

  it("produces the same comments part as the buffered writer", async () => {
    // The check that would have caught this on day one: three of the four writer/container pairs worked, so comparing
    // the pairs is what localises a defect to one of them. Byte-for-byte, because both write BIFF12 from one encoder.
    const [fromStream, fromBuffer] = await Promise.all([streamed("xlsb"), buffered("xlsb")]);
    const left = (await extractAll(fromStream)).get("xl/comments1.bin")!.data;
    const right = (await extractAll(fromBuffer)).get("xl/comments1.bin")!.data;
    expect([...left]).toEqual([...right]);
  });
});
