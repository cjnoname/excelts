import { extractAll } from "@archive/unzip/extract";
/**
 * A shared formula's body is a template, and these assert its bytes against **Excel's own**.
 *
 * Every case here is pinned to a record Excel wrote, because the defect this file exists for could not have been
 * caught any other way: the writer emitted absolute references and a 32-bit row wrap, the reader read both back
 * exactly, and a round-trip test therefore passed while Excel refused the construct outright. That is the eighth
 * time a reader and a writer in this module have agreed with each other and not with the format.
 */
import { Workbook } from "@excel";
import { iterateInterpretableRecords } from "@excel/xlsb/binary";
import { recordSpec } from "@excel/xlsb/spec/records";
import { describe, expect, it } from "vitest";

/** Hex of every `BrtShrFmla` / `BrtArrFmla` in a sheet part, keyed by record name. */
async function templates(bytes: Uint8Array): Promise<{ shared: string[]; array: string[] }> {
  const parts = await extractAll(bytes);
  const shared: string[] = [];
  const array: string[] = [];
  for (const entry of iterateInterpretableRecords(
    parts.get("xl/worksheets/sheet1.bin")!.data,
    "s"
  )) {
    const name = recordSpec(entry.id)?.name;
    const hex = [...entry.payload].map(byte => byte.toString(16).padStart(2, "0")).join(" ");
    if (name === "BrtShrFmla") {
      shared.push(hex);
    } else if (name === "BrtArrFmla") {
      array.push(hex);
    }
  }
  return { shared, array };
}

/** A workbook with one shared formula over `range`, mastered at `master`. */
async function sharedWorkbook(master: string, range: string, formula: string): Promise<Uint8Array> {
  const handle = Workbook.create();
  const sheet = Workbook.addWorksheet(handle, "S");
  const { Cell } = await import("@excel");
  Cell.setValue(sheet, master, { formula, shareType: "shared", ref: range, result: 0 } as never);
  return Workbook.toBuffer(handle, { format: "xlsb", unsupported: "ignore" });
}

describe("a shared formula body uses relative references", () => {
  it("writes the row offset the way Excel writes it", async () => {
    // `poi-62815.xlsb` stores `=<the cell above> + 1` as
    //   4c ff ff 0f 00   00 c0   1e 01 00   03
    //   PtgRefN row=0xFFFFF (-1), col=0 both-relative, PtgInt(1), PtgAdd
    // This produces the identical token stream for the same formula, which is the claim — not that some
    // relative form was chosen, but that it is byte for byte the one Excel chose.
    const { shared } = await templates(await sharedWorkbook("H2", "H2:H20", "H1+1"));
    expect(shared).toHaveLength(1);
    expect(shared[0]).toContain("4c ff ff 0f 00 00 c0 1e 01 00 03");
  });

  it("wraps a larger negative offset through the row field, not the integer", async () => {
    // `A4` referring to `A1` is -3 rows: `0xFFFFD`. Written as a signed 32-bit integer it would be
    // `fd ff ff ff`, which is not a row this format can express.
    const { shared } = await templates(await sharedWorkbook("A4", "A4:B5", "A1"));
    expect(shared[0]).toContain("4c fd ff 0f 00 00 c0");
    expect(shared[0]).not.toContain("fd ff ff ff");
  });

  it("uses the value class, as Excel does", async () => {
    // `0x4c`, not `0x2c`. An operand's class says what the consumer wants of it, and this is the difference
    // that has cost this codec the most.
    const { shared } = await templates(await sharedWorkbook("H2", "H2:H20", "H1+1"));
    expect(shared[0]).toContain(" 4c ");
    expect(shared[0]).not.toContain(" 2c ");
  });

  it("leaves a formula with no references alone", async () => {
    // `ROW()+COLUMN()` has nothing to relativise, so the template is the ordinary token stream. Asserted so
    // that "relative" is not read as "rewritten".
    const { shared } = await templates(await sharedWorkbook("A1", "A1:B2", "ROW()+COLUMN()"));
    expect(shared[0]).toContain("42 00 08 00 42 00 09 00 03");
  });
});

describe("an array formula body does not", () => {
  it("keeps absolute references", async () => {
    // A `BrtArrFmla` is one formula evaluated once over its range, not a template replicated across it.
    // Relativising it would break it, and the two records sit next to each other in the writer.
    const handle = Workbook.create();
    const sheet = Workbook.addWorksheet(handle, "S");
    const { Cell } = await import("@excel");
    Cell.setValue(sheet, "E1", {
      formula: "D1",
      shareType: "array",
      ref: "E1:E4",
      result: 0
    } as never);
    const { array } = await templates(
      await Workbook.toBuffer(handle, { format: "xlsb", unsupported: "ignore" })
    );
    expect(array).toHaveLength(1);
    // `0x44` — PtgRef, **value** class, absolute position. The point being asserted is the *absolute* part:
    // `0x4c` would be `PtgRefN`, an offset, which is what a shared template uses and what would break an array.
    // The class byte moved from `24` to `44` separately, because a formula whose whole body is a reference hands
    // the cell a value — Excel writes `44` here and for a plain `=A1` alike.
    expect(array[0]).toContain("44 ");
    expect(array[0]).not.toContain("4c ");
  });
});

describe("the round trip still holds", () => {
  it("reads a relative template back as the formula that was written", async () => {
    // Necessary but not sufficient, and that is the point of stating it last: this assertion passed while the
    // writer was wrong. It is here to catch a reader that stops understanding a correct file.
    const bytes = await sharedWorkbook("H2", "H2:H20", "H1+1");
    const handle = Workbook.create();
    await Workbook.read(handle, bytes);
    const { Cell } = await import("@excel");
    const sheets = Workbook.getWorksheets(handle);
    expect(Cell.getFormula(sheets[0], "H2")).toBe("H1+1");
  });
});

describe("the master cell says which kind of forwarding it does", () => {
  /** `grbitFlags` on the cell record immediately preceding each `BrtShrFmla` / `BrtArrFmla`. */
  async function masterFlags(bytes: Uint8Array): Promise<{ shared: number[]; array: number[] }> {
    const parts = await extractAll(bytes);
    const shared: number[] = [];
    const array: number[] = [];
    let previous: number | undefined;
    for (const entry of iterateInterpretableRecords(
      parts.get("xl/worksheets/sheet1.bin")!.data,
      "s"
    )) {
      const name = recordSpec(entry.id)?.name;
      if (name === "BrtFmlaNum") {
        previous = new DataView(
          entry.payload.buffer,
          entry.payload.byteOffset,
          entry.payload.length
        ).getUint16(16, true);
        continue;
      }
      if (name === "BrtShrFmla" && previous !== undefined) {
        shared.push(previous);
      } else if (name === "BrtArrFmla" && previous !== undefined) {
        array.push(previous);
      }
    }
    return { shared, array };
  }

  it("writes zero on both, which is what Excel writes", async () => {
    // **This bit is the difference between a file that opens and one that crashes Excel.** Not repairs, not a
    // dropped feature — the process goes down, because the master's `PtgExp` forwards to a record Excel was
    // never told to look for. Both values are read off Excel's own output: `poi-bug66682.xlsb`'s array master
    // carries `02 00`, `poi-62815.xlsb`'s shared master carries `00 00`.
    //
    // Asserted together, in one workbook, because the defect was writing one constant for both.
    const handle = Workbook.create();
    const sheet = Workbook.addWorksheet(handle, "S");
    const { Cell, Worksheet } = await import("@excel");
    for (let index = 1; index <= 4; index++) {
      Cell.setValue(sheet, `D${index}`, { formula: "ROW()", result: index });
    }
    Worksheet.fillFormula(sheet, "E1:E4", "D1", [1, 1, 1, 1], "array");
    Cell.setValue(sheet, "H1", 1);
    Worksheet.fillFormula(sheet, "H2:H20", "H1+1", row => row);
    const flags = await masterFlags(
      await Workbook.toBuffer(handle, { format: "xlsb", unsupported: "ignore" })
    );
    // Both zero. This asserted `0x0002` for the array master, inferred from the corpus's only array formula —
    // a future-function array returning `#NAME?`, whose flag belonged to that circumstance. Excel's own re-save
    // of this library's `formulas.xlsb` writes `00 00` on both, and that is the reference that settles it.
    expect(flags.array).toEqual([0x0000]);
    expect(flags.shared).toEqual([0x0000]);
  });
});
