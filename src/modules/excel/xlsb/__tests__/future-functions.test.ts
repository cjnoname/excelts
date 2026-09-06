/**
 * Functions the `Ftab` has no id for.
 *
 * `XLOOKUP`, `TEXTJOIN`, `CONFIDENCE.T`, `LET`, `SEQUENCE` — everything newer than the enumeration MS-XLSB
 * froze. These used to be refused by name, with the reason that they "have no iftab". True, and not the end of
 * it: Excel calls such a function through a **`PtgName`** naming a hidden `_xlfn.*` stub, with
 * `PtgFuncVar`'s `tab` set to `0x00FF` — "the callee is the first operand".
 *
 * Every constant below is read off Excel's own bytes rather than inferred:
 *
 * | Where                                   | Bytes                       | Meaning                          |
 * | --------------------------------------- | --------------------------- | -------------------------------- |
 * | `poi-bug66682.xlsb`, an array formula   | `23 02 00 00 00 42 01 ff 00`| `PtgName(2)`, `PtgFuncVar(1,255)`|
 * | Excel's repair of `scientific-analysis` | `flags 0x0002000b`, `1c 1d` | the stub's flags and `#NAME?` body|
 *
 * The specification then explains why those flags are not a choice: 2.4.674 requires `fFutureFunction` to be 0
 * unless `fHidden`, `fFunc` and `fProc` are all 1 and `fOB`, `fCalcExp`, `fgrp`, `fPublished`, `fBuiltin` and
 * `fWorkbookParam` are all 0, with a NULL comment and a global `itab`. `0x0002000b` is exactly that.
 */
import { extractAll } from "@archive/unzip/extract";
import { Cell, Workbook } from "@excel";
import { validateXlsbBuffer } from "@excel/utils/xlsb-validator";
import { iterateInterpretableRecords } from "@excel/xlsb/binary";
import {
  FUTURE_FUNCTION_FLAGS,
  FUTURE_FUNCTION_STUB_RGCE,
  futureFunctionStubName,
  isFutureFunction
} from "@excel/xlsb/formula/ptg";
import { recordSpec } from "@excel/xlsb/spec/records";
import { describe, expect, it } from "vitest";

/** A workbook whose A1 holds `formula`. */
function withFormula(formula: string): Workbook.Handle {
  const handle = Workbook.create();
  Cell.setValue(Workbook.addWorksheet(handle, "S"), "A1", { formula, result: 1 } as never);
  return handle;
}

/** The `BrtName` records and the A1 token stream of a workbook's XLSB form. */
async function parts(handle: Workbook.Handle): Promise<{
  readonly names: readonly { name: string; flags: number; rgce: Uint8Array }[];
  readonly rgce: Uint8Array;
  readonly problems: readonly string[];
}> {
  const bytes = await Workbook.toBuffer(handle, { format: "xlsb", unsupported: "ignore" });
  const archive = await extractAll(bytes);
  const names: { name: string; flags: number; rgce: Uint8Array }[] = [];
  for (const record of iterateInterpretableRecords(archive.get("xl/workbook.bin")!.data, "w")) {
    if (recordSpec(record.id)?.name !== "BrtName") {
      continue;
    }
    const view = new DataView(record.payload.buffer, record.payload.byteOffset);
    const characters = view.getUint32(9, true);
    let name = "";
    for (let index = 0; index < characters; index += 1) {
      name += String.fromCharCode(view.getUint16(13 + index * 2, true));
    }
    const at = 13 + characters * 2;
    const length = view.getUint32(at, true);
    names.push({
      name,
      flags: view.getUint32(0, true),
      rgce: record.payload.slice(at + 4, at + 4 + length)
    });
  }

  let rgce = new Uint8Array(0);
  for (const record of iterateInterpretableRecords(
    archive.get("xl/worksheets/sheet1.bin")!.data,
    "s"
  )) {
    if (!(recordSpec(record.id)?.name ?? "").startsWith("BrtFmla")) {
      continue;
    }
    const view = new DataView(record.payload.buffer, record.payload.byteOffset);
    rgce = record.payload.slice(22, 22 + view.getUint32(18, true));
  }

  const validation = await validateXlsbBuffer(bytes);
  return {
    names,
    rgce,
    problems: [...new Set((validation.problems ?? []).map(problem => problem.kind))]
  };
}

describe("which functions need a stub", () => {
  it.each(["XLOOKUP", "TEXTJOIN", "CONFIDENCE.T", "LET", "SEQUENCE", "IFS", "CONCAT"])(
    "treats %s as a future function",
    name => {
      expect(isFutureFunction(name)).toBe(true);
    }
  );

  it.each(["SUM", "IF", "AVERAGEIF", "COUNTIFS", "IFERROR", "MEDIAN"])(
    "treats %s as a built-in with an id",
    name => {
      // These have `Ftab` ids and must keep being called by id — writing one through a stub would produce a
      // formula that works and is not the one Excel writes.
      expect(isFutureFunction(name)).toBe(false);
    }
  );

  it("prefixes the stub the way Excel spells it", () => {
    expect(futureFunctionStubName("xlookup")).toBe("_xlfn.XLOOKUP");
  });
});

describe("a call to a future function", () => {
  it("writes the stub with the flags the specification requires", async () => {
    const found = await parts(withFormula("XLOOKUP(1,B1:B3,C1:C3)"));
    const stub = found.names.find(entry => entry.name === "_xlfn.XLOOKUP");
    expect(stub).toBeDefined();
    // `0x0002000b` — `fHidden | fFunc | fProc | fFutureFunction`, and Excel's own value.
    expect(stub!.flags).toBe(FUTURE_FUNCTION_FLAGS);
    expect(stub!.flags).toBe(0x0002000b);
    // `PtgErr(#NAME?)`, which is the body Excel gives every stub.
    expect([...stub!.rgce]).toEqual([...FUTURE_FUNCTION_STUB_RGCE]);
    expect([...stub!.rgce]).toEqual([0x1c, 0x1d]);
  });

  it("calls it through PtgName with iftab 0x00FF", async () => {
    const found = await parts(withFormula("XLOOKUP(1,B1:B3,C1:C3)"));
    // First token: `PtgName` in the reference class, then the one-based name index.
    expect(found.rgce[0]).toBe(0x23);
    expect(found.rgce[1]).toBe(1);
    // Last four: `PtgFuncVar`, then `cparams` and `tab`. **`cparams` counts the name**, so three arguments
    // make four operands — the detail `poi-bug66682.xlsb` settles.
    const tail = found.rgce.slice(-4);
    expect(tail[0]).toBe(0x42);
    expect(tail[1]).toBe(4);
    expect(tail[2]! | (tail[3]! << 8)).toBe(0x00ff);
  });

  it("does not report a loss", async () => {
    await expect(
      Workbook.toBuffer(withFormula('TEXTJOIN(",",TRUE,A2:A4)'), {
        format: "xlsb",
        unsupported: "error"
      })
    ).resolves.toBeInstanceOf(Uint8Array);
  });

  it("passes the validator", async () => {
    expect((await parts(withFormula("SEQUENCE(3)"))).problems).toEqual([]);
  });

  it.each([
    "XLOOKUP(1,B1:B3,C1:C3)",
    "CONFIDENCE.T(0.05,2,3)",
    'TEXTJOIN(",",TRUE,B1:B3)',
    "SEQUENCE(3)"
  ])("round-trips %s without the prefix leaking out", async formula => {
    // The `_xlfn.` prefix belongs to the file format, not to the formula: a caller must read back what they
    // wrote, which is also what the XLSX container stores.
    const back = Workbook.create();
    await Workbook.read(
      back,
      await Workbook.toBuffer(withFormula(formula), { format: "xlsb", unsupported: "ignore" })
    );
    expect(
      (Cell.getValue(Workbook.getWorksheets(back)[0]!, "A1") as { formula?: string }).formula
    ).toBe(formula);
  });

  it("interns one stub for repeated calls", async () => {
    const handle = Workbook.create();
    const sheet = Workbook.addWorksheet(handle, "S");
    Cell.setValue(sheet, "A1", { formula: "SEQUENCE(3)", result: 1 } as never);
    Cell.setValue(sheet, "A2", { formula: "SEQUENCE(4)", result: 1 } as never);
    const found = await parts(handle);
    expect(found.names.filter(entry => entry.name === "_xlfn.SEQUENCE")).toHaveLength(1);
  });

  it("does not stub a built-in", async () => {
    const found = await parts(withFormula("SUM(A2:A4)"));
    expect(found.names.filter(entry => entry.name.startsWith("_xlfn."))).toEqual([]);
    // And the call is by id: `PtgFuncVar` with `SUM`'s `iftab`, not `0x00FF`.
    const tail = found.rgce.slice(-4);
    expect(tail[2]! | (tail[3]! << 8)).not.toBe(0x00ff);
  });
});
