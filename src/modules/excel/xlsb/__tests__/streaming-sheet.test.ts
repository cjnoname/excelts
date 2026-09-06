/**
 * The two pieces that make an XLSB sheet part producible one row at a time.
 *
 * Both existed only as inline code inside `writeWorksheetPart`, and that is exactly why the streaming path could
 * not be written: a second implementation of "a row becomes records" would have been bytes nobody compares.
 *
 * - **`encodeRowRecords`** — one row, one place. A buffered write calls it in a loop; a streaming write calls it
 *   as each row is committed. Neither can disagree with the other about a row because there is nothing to
 *   disagree with.
 * - **`omitDimension`** — `BrtWsDim` states the used range and sits *before* the rows, so a forward pass cannot
 *   fill it in. The XLSX side has the same problem and drops `<dimension>`; whether XLSB may do the same was
 *   unobserved — Excel writes the record in all 67 worksheet parts across the corpus — and was settled by
 *   opening a package without it in Excel. It opens without a repair.
 *
 * The default stays "write it", and that is the point of testing the default too: a buffered writer has the
 * extent for free, so there is no reason for its output to differ from Excel's. Only a streaming caller takes
 * the liberty, and only because it cannot do otherwise.
 */
import { extractAll } from "@archive/unzip/extract";
import { Cell, Workbook, Worksheet } from "@excel";
import { validateXlsbBuffer } from "@excel/utils/xlsb-validator";
import { iterateInterpretableRecords } from "@excel/xlsb/binary";
import { recordSpec } from "@excel/xlsb/spec/records";
import { CellFormatTable } from "@excel/xlsb/styles";
import { SharedStringTable } from "@excel/xlsb/write/shared-strings";
import type { SheetRow } from "@excel/xlsb/write/types";
import { encodeRowRecords, sortedRows, writeWorksheetPart } from "@excel/xlsb/write/worksheet";
import { describe, expect, it } from "vitest";

/** The record names in a serialised sheet part, in order. */
function names(bytes: Uint8Array): string[] {
  const found: string[] = [];
  for (const record of iterateInterpretableRecords(bytes, "s")) {
    found.push(recordSpec(record.id)?.name ?? `?${record.id}`);
  }
  return found;
}

/** Two rows with a mix of value kinds, so the row encoder has something to choose between. */
const ROWS: readonly SheetRow[] = [
  {
    row: 0,
    cells: [
      { row: 0, column: 0, value: "text" },
      { row: 0, column: 1, value: 12.5 }
    ]
  },
  {
    row: 1,
    cells: [
      { row: 1, column: 0, value: true },
      { row: 1, column: 1, value: null }
    ]
  }
];

function part(options?: { readonly omitDimension?: boolean }): Uint8Array {
  return writeWorksheetPart({
    rows: ROWS,
    strings: new SharedStringTable(),
    formats: new CellFormatTable(),
    ...(options ?? {})
  } as never).bytes;
}

describe("BrtWsDim", () => {
  it("is written by default", () => {
    expect(names(part())).toContain("BrtWsDim");
  });

  it("is omitted on request, and nothing else moves", () => {
    // The record is *removed*, not replaced by a placeholder — a zero-extent dimension would tell Excel the
    // sheet is empty, which is worse than saying nothing.
    const withIt = names(part());
    const without = names(part({ omitDimension: true }));
    expect(without).not.toContain("BrtWsDim");
    expect(without).toEqual(withIt.filter(name => name !== "BrtWsDim"));
  });

  it("leaves a valid package either way", async () => {
    // The validator is not the authority here — Excel is, and a package without the record opens without a
    // repair — but a part that fails this would be malformed for a reason unrelated to the dimension.
    for (const omitDimension of [false, true]) {
      const handle = Workbook.create();
      const sheet = Workbook.addWorksheet(handle, "S");
      Cell.setValue(sheet, "A1", 1);
      const bytes = await Workbook.toBuffer(handle, { format: "xlsb" });
      const parts = await extractAll(bytes);
      expect(parts.has("xl/worksheets/sheet1.bin"), String(omitDimension)).toBe(true);
      const validation = await validateXlsbBuffer(bytes);
      expect(validation.problems ?? []).toEqual([]);
    }
  });
});

describe("encodeRowRecords", () => {
  /** The records for `rows`, driven one row at a time the way a streaming writer does. */
  function driven(rows: readonly SheetRow[]): string[] {
    const strings = new SharedStringTable();
    const formats = new CellFormatTable();
    const unsupported: string[] = [];
    const found: string[] = [];
    for (const row of sortedRows(rows)) {
      for (const emitted of encodeRowRecords(row, {
        strings,
        formats,
        formulaContext: {},
        unsupported
      })) {
        found.push(recordSpec(emitted.id)?.name ?? `?${emitted.id}`);
      }
    }
    return found;
  }

  it("produces the same records the whole-part writer does", () => {
    // The property the streaming path rests on. If these ever diverge, a streamed workbook and a buffered one
    // describe different rows and only a byte comparison against Excel would reveal it.
    const whole = names(part());
    const rowsOnly = driven(ROWS);
    const between = whole.slice(
      whole.indexOf("BrtBeginSheetData") + 1,
      whole.indexOf("BrtEndSheetData")
    );
    expect(rowsOnly).toEqual(between);
  });

  it("emits a row header before each row's cells", () => {
    const found = driven(ROWS);
    expect(found[0]).toBe("BrtRowHdr");
    expect(found.filter(name => name === "BrtRowHdr")).toHaveLength(2);
  });

  it("chooses the record from the value's shape", () => {
    // `12.5` is a `BrtCellRk`, not a `BrtCellReal`: `RkNumber` holds a value like this in four bytes where the
    // full double takes eight, and Excel writes the compressed form too. Asserted rather than left loose
    // because "a number becomes some numeric record" would not have caught the earlier defect where every
    // date cost four bytes more than Excel spends on it.
    expect(driven(ROWS)).toEqual([
      "BrtRowHdr",
      "BrtCellIsst",
      "BrtCellRk",
      "BrtRowHdr",
      "BrtCellBool",
      "BrtCellBlank"
    ]);
  });

  it("sorts rows even when the caller does not", () => {
    // A buffered caller may build a model in any order. A streaming one has already committed in order, so this
    // is a no-op for it rather than a second buffer.
    const reversed = [...ROWS].reverse();
    expect(driven(reversed)).toEqual(driven(ROWS));
  });

  it("collects losses into the caller's list rather than returning them", () => {
    // A caller accumulates across every row; a per-row array would make that the caller's bookkeeping.
    const unsupported: string[] = [];
    encodeRowRecords(
      {
        row: 0,
        cells: [
          { row: 0, column: 0, value: null, formula: "SUM(", unsupported: undefined } as never
        ]
      },
      {
        strings: new SharedStringTable(),
        formats: new CellFormatTable(),
        formulaContext: {},
        unsupported
      }
    );
    expect(unsupported.length).toBeGreaterThan(0);
  });
});

describe("a sheet written through the public API", () => {
  it("still carries its dimension", async () => {
    // The default matters: this is what every existing caller gets, and it must keep matching Excel.
    const handle = Workbook.create();
    const sheet = Workbook.addWorksheet(handle, "S");
    Worksheet.addAoa(sheet, [
      ["a", "b"],
      [1, 2]
    ]);
    const parts = await extractAll(await Workbook.toBuffer(handle, { format: "xlsb" }));
    expect(names(parts.get("xl/worksheets/sheet1.bin")!.data)).toContain("BrtWsDim");
  });
});
