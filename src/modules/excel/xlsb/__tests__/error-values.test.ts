/**
 * `BErr` — error values through the binary container.
 *
 * Both directions used to give up here, with the same stated reason: no reference workbook contained a single
 * `BrtCellError` or `BrtFmlaError`, so the code byte's meaning was unobserved and "inventing it is how a
 * reader comes to agree with this library's own writer and disagree with Excel". That was sound against the
 * corpus it was written for.
 *
 * The current corpus contains five, and every one matches MS-XLSB 2.5.98.2:
 *
 * | Byte   | Meaning   |
 * | ------ | --------- |
 * | `0x07` | `#DIV/0!` |
 * | `0x17` | `#REF!`   |
 * | `0x1D` | `#NAME?`  |
 * | `0x2A` | `#N/A`    |
 *
 * So the table below is pinned against Excel where Excel has spoken, and against the specification for the
 * four values it has not. The pairs are asserted as *constants* rather than through a round trip, because a
 * shared table used in both directions cannot be validated by using it in both directions — the mistake this
 * codec has paid for repeatedly.
 */
import { Cell, Workbook } from "@excel";
import { errorCodeOf, errorTextOf, knownErrorTexts } from "@excel/xlsb/error-values";
import { describe, expect, it } from "vitest";

/** The four Excel's own files confirm, and where. */
const OBSERVED: readonly [number, string][] = [
  [0x07, "#DIV/0!"],
  [0x17, "#REF!"],
  [0x1d, "#NAME?"],
  [0x2a, "#N/A"]
];

/** The four the specification gives and no corpus workbook exercises. */
const FROM_SPEC: readonly [number, string][] = [
  [0x00, "#NULL!"],
  [0x0f, "#VALUE!"],
  [0x24, "#NUM!"],
  [0x2b, "#GETTING_DATA"]
];

describe("the BErr table", () => {
  it.each([...OBSERVED, ...FROM_SPEC])("maps 0x%s both ways", (code, text) => {
    expect(errorTextOf(code)).toBe(text);
    expect(errorCodeOf(text)).toBe(code);
  });

  it("has exactly the eight the specification lists", () => {
    expect(knownErrorTexts()).toHaveLength(8);
  });

  it("refuses a byte that is not one of them", () => {
    // Guessing would put an error nobody wrote into a cell. `0x99` is chosen because it is outside the table
    // and inside a byte, which is what a corrupt or future file would carry.
    expect(errorTextOf(0x99)).toBeUndefined();
  });

  it("refuses an error the enumeration has no code for", () => {
    // The dynamic-array family postdates `BErr`. Substituting `#VALUE!` would be a *different* error, so
    // these are reported as losses instead.
    for (const text of ["#SPILL!", "#CALC!", "#FIELD!", "#BLOCKED!"]) {
      expect(errorCodeOf(text)).toBeUndefined();
    }
  });
});

describe("an error-valued cell", () => {
  async function roundTrip(error: string): Promise<unknown> {
    const handle = Workbook.create();
    Cell.setValue(Workbook.addWorksheet(handle, "S"), "A1", { error } as never);
    const back = Workbook.create();
    await Workbook.read(
      back,
      await Workbook.toBuffer(handle, { format: "xlsb", unsupported: "ignore" })
    );
    return Cell.getValue(Workbook.getWorksheets(back)[0]!, "A1");
  }

  it.each([...OBSERVED, ...FROM_SPEC])(
    "round-trips %s as an error, not a string",
    async (_code, text) => {
      // `{ error }` and the four characters `"#N/A"` display identically and are not the same value — reading
      // one back as the other is the shape of loss this replaced.
      expect(await roundTrip(text)).toEqual({ error: text });
    }
  );

  it("is not reported as a loss", async () => {
    const handle = Workbook.create();
    Cell.setValue(Workbook.addWorksheet(handle, "S"), "A1", { error: "#REF!" } as never);
    await expect(
      Workbook.toBuffer(handle, { format: "xlsb", unsupported: "error" })
    ).resolves.toBeInstanceOf(Uint8Array);
  });

  it("still reports one the enumeration cannot express", async () => {
    const handle = Workbook.create();
    Cell.setValue(Workbook.addWorksheet(handle, "S"), "A1", { error: "#SPILL!" } as never);
    await expect(Workbook.toBuffer(handle, { format: "xlsb" })).rejects.toThrow(
      /error value #SPILL!/
    );
  });

  it("agrees with the XLSX container", async () => {
    const handle = Workbook.create();
    Cell.setValue(Workbook.addWorksheet(handle, "S"), "A1", { error: "#N/A" } as never);
    const read = async (format: "xlsx" | "xlsb") => {
      const back = Workbook.create();
      await Workbook.read(back, await Workbook.toBuffer(handle, { format }));
      return Cell.getValue(Workbook.getWorksheets(back)[0]!, "A1");
    };
    expect(await read("xlsb")).toEqual(await read("xlsx"));
  });
});
