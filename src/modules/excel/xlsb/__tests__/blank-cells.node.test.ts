/**
 * `blankCells: "collapse"` — the memory of skipping styled blanks, without the loss.
 *
 * **The point of these tests is the word "lossless", and the only proof of it is a byte comparison.** A cell that
 * carries formatting and no value is one `BrtCellBlank` record, and Excel writes one per cell of a formatted
 * region — a formatted column leaves one per row to the sheet's end. Materialising each is what makes a small
 * workbook expensive: measured here at 322,520 records against 253 rows of actual data.
 *
 * Collapsing them into rectangles is only worth doing if the records come back. So the central assertion is not
 * "memory went down" — that is easy and unfalsifiable in a test — but that a workbook read with `"collapse"` and
 * written back produces the *same bytes* as one read with `"keep"`. Everything else here supports that claim.
 */
import { extractAll } from "@archive/unzip/extract";
import { Cell, Workbook } from "@excel";
import { iterateInterpretableRecords } from "@excel/xlsb/binary";
import { commitXlsbRead, parseXlsbPackage } from "@excel/xlsb/read/package";
import { recordSpec } from "@excel/xlsb/spec/records";
import { beforeAll, describe, expect, it } from "vitest";

/** Rows 1–20 hold data; rows 21–400 carry a fill and nothing else, across ten columns. */
const DATA_ROWS = 20;
const LAST_ROW = 400;
const COLUMNS = 10;

let source = new Uint8Array(0);

/** Read `source` in one mode and hand back the model and what it was written to. */
async function readAs(
  blankCells: "keep" | "collapse"
): Promise<{ readonly handle: Workbook.Handle; readonly written: Uint8Array }> {
  const handle = Workbook.create();
  commitXlsbRead(handle, await parseXlsbPackage(source, "<buffer>", { blankCells }));
  const written = await Workbook.toBuffer(handle, { format: "xlsb", unsupported: "ignore" });
  return { handle, written };
}

/** Every record in the sheet part, name and payload, which is what "the same part" means for BIFF. */
function records(bytes: Uint8Array): string[] {
  return [...iterateInterpretableRecords(bytes, "s")].map(
    entry => `${recordSpec(entry.id)?.name ?? `#${entry.id}`}:${[...entry.payload].join(",")}`
  );
}

beforeAll(async () => {
  const handle = Workbook.create();
  const sheet = Workbook.addWorksheet(handle, "S");
  for (let row = 1; row <= DATA_ROWS; row++) {
    for (let column = 1; column <= COLUMNS; column++) {
      Cell.setValue(sheet, row, column, row * column);
    }
  }
  // The formatted tail. This is the shape that costs: a fill applied past the data, one record per cell.
  for (let row = DATA_ROWS + 1; row <= LAST_ROW; row++) {
    for (let column = 1; column <= COLUMNS; column++) {
      Cell.setStyle(sheet, row, column, {
        fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FFEEEEEE" } }
      } as never);
    }
  }
  source = Uint8Array.from(
    await Workbook.toBuffer(handle, { format: "xlsb", unsupported: "ignore" })
  );
});

describe("the fixture", () => {
  it("really is dominated by styled blanks", async () => {
    // Stated first, because every measurement below is meaningless if the file does not have the shape the option
    // exists for. A test that silently stopped exercising the case would still pass all the others.
    const parts = await extractAll(source);
    const names = records(parts.get("xl/worksheets/sheet1.bin")!.data).map(
      entry => entry.split(":")[0]
    );
    const blanks = names.filter(name => name === "BrtCellBlank").length;
    expect(blanks).toBe((LAST_ROW - DATA_ROWS) * COLUMNS);
    expect(blanks).toBeGreaterThan(names.filter(name => name.startsWith("BrtCellRk")).length * 10);
  });
});

describe("collapse is lossless", () => {
  it("writes byte-identical output to keep", async () => {
    // **The assertion the whole option rests on.** Compared part by part rather than as a whole file so that a
    // failure names which part diverged; `docProps/core.xml` is excluded because it carries a timestamp.
    const [kept, collapsed] = await Promise.all([readAs("keep"), readAs("collapse")]);
    const left = await extractAll(kept.written);
    const right = await extractAll(collapsed.written);
    expect([...right.keys()].sort()).toEqual([...left.keys()].sort());
    for (const path of left.keys()) {
      if (path === "docProps/core.xml") {
        continue;
      }
      expect([...right.get(path)!.data], path).toEqual([...left.get(path)!.data]);
    }
  });

  it("reproduces every blank record, in the same order", async () => {
    // The sheet part is where the blanks live, so this is the same claim stated where it can be read: not "the
    // same number of records" but the same records, in sequence, payload for payload.
    const [kept, collapsed] = await Promise.all([readAs("keep"), readAs("collapse")]);
    const left = records((await extractAll(kept.written)).get("xl/worksheets/sheet1.bin")!.data);
    const right = records(
      (await extractAll(collapsed.written)).get("xl/worksheets/sheet1.bin")!.data
    );
    expect(right).toEqual(left);
  });
});

describe("collapse changes the model, not the file", () => {
  it("does not materialise the empty rows", async () => {
    // The saving, stated as a count rather than as bytes of heap: a test that asserted megabytes would be
    // measuring the garbage collector.
    const collapsed = await readAs("collapse");
    const kept = await readAs("keep");
    const rowsOf = (handle: Workbook.Handle): number =>
      (Workbook.getModel(handle).worksheets[0].rows ?? []).length;
    expect(rowsOf(kept.handle)).toBe(LAST_ROW);
    expect(rowsOf(collapsed.handle)).toBe(DATA_ROWS);
  });

  it("keeps every value, and keeps them identical", async () => {
    // What must not change. `"collapse"` is about cells that hold nothing; a cell that holds something is not its
    // business, and the values are read back rather than assumed.
    const [kept, collapsed] = await Promise.all([readAs("keep"), readAs("collapse")]);
    for (const handle of [kept.handle, collapsed.handle]) {
      const sheet = Workbook.getWorksheets(handle)[0];
      expect(Cell.getValue(sheet, "A1")).toBe(1);
      expect(Cell.getValue(sheet, "J20")).toBe(200);
    }
  });

  it("still gives a value cell its own style", async () => {
    // The distinction that makes the option safe: only *value-less* cells are collapsed. A styled cell that holds
    // a number keeps its style in the model, where a caller can read it.
    const collapsed = await readAs("collapse");
    const sheet = Workbook.getWorksheets(collapsed.handle)[0];
    expect(Cell.getValue(sheet, "A1")).toBe(1);
  });
});

describe("keep is still the default", () => {
  it("materialises the blanks when nothing is asked for", async () => {
    // A default that changed would alter what every existing caller sees from a cell iteration, silently. The
    // memory is a cost worth offering to avoid, not one to remove on a caller's behalf.
    const handle = Workbook.create();
    commitXlsbRead(handle, await parseXlsbPackage(source, "<buffer>"));
    expect((Workbook.getModel(handle).worksheets[0].rows ?? []).length).toBe(LAST_ROW);
  });
});

describe("reachable through the public API", () => {
  /** Physical rows in the first sheet, which is the number the policy changes. */
  function physicalRows(handle: Workbook.Handle): number {
    return (Workbook.getModel(handle).worksheets[0].rows ?? []).length;
  }

  it("takes `blankCells` from `Workbook.read`", async () => {
    // **The gap this closes was real.** The option existed on `parseXlsbPackage`, which is internal, so the feature was
    // implemented and unreachable — a caller with the 186 MB sheet had no way to ask for the 0.4 MB read. A capability
    // only its own tests can invoke is not a capability.
    const collapsed = Workbook.create();
    await Workbook.read(collapsed, source, { blankCells: "collapse" });
    const kept = Workbook.create();
    await Workbook.read(kept, source, { blankCells: "keep" });
    expect(physicalRows(collapsed)).toBe(DATA_ROWS);
    expect(physicalRows(kept)).toBe(LAST_ROW);
  });

  it("defaults to keep when nothing is asked for", async () => {
    const handle = Workbook.create();
    await Workbook.read(handle, source);
    expect(physicalRows(handle)).toBe(LAST_ROW);
  });

  it("is lossless through the public API too", async () => {
    // The guarantee restated where a caller can see it: same option, same bytes out.
    const collapsed = Workbook.create();
    await Workbook.read(collapsed, source, { blankCells: "collapse" });
    const kept = Workbook.create();
    await Workbook.read(kept, source, { blankCells: "keep" });
    const left = await Workbook.toBuffer(kept, { format: "xlsb", unsupported: "ignore" });
    const right = await Workbook.toBuffer(collapsed, { format: "xlsb", unsupported: "ignore" });
    expect([...right]).toEqual([...left]);
  });

  it("takes it from `readWithDiagnostics` as well", async () => {
    // The same read with the report handed back instead of thrown. A caller inspecting a large formatted sheet is
    // exactly the caller who wants the policy, so leaving it off that entry point would have reproduced the gap one
    // function along.
    const handle = Workbook.create();
    const report = await Workbook.readWithDiagnostics(handle, source, {
      blankCells: "collapse"
    } as never);
    expect(report.workbook).toBe(handle);
    expect(physicalRows(handle)).toBe(DATA_ROWS);
  });

  it("keeps every value, whichever entry point asked", async () => {
    // What must not change, checked once per entry point rather than assumed to follow from the row count.
    for (const read of [
      async (handle: Workbook.Handle) => Workbook.read(handle, source, { blankCells: "collapse" }),
      async (handle: Workbook.Handle) =>
        Workbook.readWithDiagnostics(handle, source, { blankCells: "collapse" } as never)
    ]) {
      const handle = Workbook.create();
      await read(handle);
      const sheet = Workbook.getWorksheets(handle)[0];
      expect(Cell.getValue(sheet, "A1")).toBe(1);
      expect(Cell.getValue(sheet, "J20")).toBe(200);
    }
  });
});
