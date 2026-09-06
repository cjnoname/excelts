/**
 * Rich text through the binary container.
 *
 * A `RichStr` is one string plus a list of `StrRun`s, each naming where a run starts and which `BrtFont` it
 * uses. Two things made this a reported loss rather than a written feature, and neither was about the record:
 *
 * - the shared-string table held plain strings, so there was nowhere to put the runs;
 * - `ifnt` indexes the *styles part's* font collection, which the string table could not reach — so a run
 *   could only have named a font some cell happened to use.
 *
 * The byte-level assertions are against `poi-sample.xlsb`, whose rich entries end
 * `01 00 00 00 07 00 03 00` — one run, from character 7, in font 3. That is the shape asserted here, not a
 * shape inferred from the field list.
 */
import { extractAll } from "@archive/unzip/extract";
import { Cell, Workbook } from "@excel";
import { validateXlsbBuffer } from "@excel/utils/xlsb-validator";
import { iterateInterpretableRecords } from "@excel/xlsb/binary";
import { recordSpec } from "@excel/xlsb/spec/records";
import { describe, expect, it } from "vitest";

/** A workbook whose A1 is the given runs. */
function withRuns(runs: readonly { text: string; font?: object }[]): Workbook.Handle {
  const handle = Workbook.create();
  Cell.setValue(Workbook.addWorksheet(handle, "S"), "A1", { richText: runs } as never);
  return handle;
}

/** The `BrtSSTItem` payloads of a workbook's XLSB form, and its `BrtFont` count. */
async function stringTable(handle: Workbook.Handle): Promise<{
  readonly items: readonly Uint8Array[];
  readonly fonts: number;
  readonly problems: readonly string[];
}> {
  const bytes = await Workbook.toBuffer(handle, { format: "xlsb" });
  const parts = await extractAll(bytes);
  const items: Uint8Array[] = [];
  for (const record of iterateInterpretableRecords(parts.get("xl/sharedStrings.bin")!.data, "w")) {
    if (recordSpec(record.id)?.name === "BrtSSTItem") {
      items.push(record.payload);
    }
  }
  let fonts = 0;
  for (const record of iterateInterpretableRecords(parts.get("xl/styles.bin")!.data, "w")) {
    if (recordSpec(record.id)?.name === "BrtFont") {
      fonts += 1;
    }
  }
  const validation = await validateXlsbBuffer(bytes);
  return {
    items,
    fonts,
    problems: [...new Set((validation.problems ?? []).map(problem => problem.kind))]
  };
}

describe("a rich string in the shared-string table", () => {
  it("sets fRichStr and appends one StrRun per run", async () => {
    const table = await stringTable(
      withRuns([
        { text: "Hello ", font: { bold: true } },
        { text: "world", font: { italic: true } }
      ])
    );
    expect(table.items).toHaveLength(1);
    const payload = table.items[0]!;
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);

    // Bit 0 is `fRichStr`; bit 1 (`fExtStr`, phonetic data) must stay clear.
    expect(payload[0]).toBe(0x01);
    const characters = view.getUint32(1, true);
    expect(characters).toBe("Hello world".length);

    // The runs follow the text: a count, then four bytes each.
    const at = 5 + characters * 2;
    expect(view.getUint32(at, true)).toBe(2);
    expect(view.getUint16(at + 4, true)).toBe(0);
    expect(view.getUint16(at + 8, true)).toBe("Hello ".length);
    // Two distinct fonts, and neither is the default — `ifnt` 0 would mean "no formatting".
    expect(view.getUint16(at + 6, true)).not.toBe(0);
    expect(view.getUint16(at + 10, true)).not.toBe(0);
    expect(view.getUint16(at + 6, true)).not.toBe(view.getUint16(at + 10, true));
    // And the record ends there: a longer payload would mean bytes the reader must refuse to interpret.
    expect(payload.length).toBe(at + 4 + 8);
  });

  it("puts each run's font in the styles part, where ifnt points", async () => {
    // The default plus one per distinct run font. Without this the indices above would name fonts that do
    // not exist, which is the whole reason rich text could not be written before.
    expect(
      (
        await stringTable(
          withRuns([
            { text: "a", font: { bold: true } },
            { text: "b", font: { italic: true } }
          ])
        )
      ).fonts
    ).toBe(3);
  });

  it("keeps a run with no font of its own as ifnt 0", async () => {
    const table = await stringTable(
      withRuns([{ text: "plain " }, { text: "bold", font: { bold: true } }])
    );
    const payload = table.items[0]!;
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const at = 5 + view.getUint32(1, true) * 2;
    expect(view.getUint16(at + 6, true)).toBe(0);
    expect(view.getUint16(at + 10, true)).not.toBe(0);
  });

  it("passes the validator", async () => {
    expect((await stringTable(withRuns([{ text: "x", font: { bold: true } }]))).problems).toEqual(
      []
    );
  });

  it("round-trips the runs and their boundaries", async () => {
    const handle = withRuns([
      { text: "Hello ", font: { bold: true } },
      { text: "world", font: { italic: true } }
    ]);
    const back = Workbook.create();
    await Workbook.read(back, await Workbook.toBuffer(handle, { format: "xlsb" }));
    const value = Cell.getValue(Workbook.getWorksheets(back)[0]!, "A1") as {
      richText?: readonly { text: string; font?: { bold?: boolean; italic?: boolean } }[];
    };
    expect(value.richText?.map(run => run.text)).toEqual(["Hello ", "world"]);
    expect(value.richText?.[0]?.font?.bold).toBe(true);
    expect(value.richText?.[1]?.font?.italic).toBe(true);
  });

  it("agrees with the XLSX container about the run boundaries", async () => {
    // The fonts differ in detail — `BrtFont` is a complete record with no way to say "inherit", so a run's
    // font comes back with the workbook's name and size filled in, where XLSX omits them. The *text* of each
    // run is the part both containers state the same way, and it is what a caller compares.
    const handle = withRuns([
      { text: "one", font: { bold: true } },
      { text: "two", font: { italic: true } },
      { text: "three" }
    ]);
    const texts = async (format: "xlsx" | "xlsb") => {
      const back = Workbook.create();
      await Workbook.read(back, await Workbook.toBuffer(handle, { format }));
      const value = Cell.getValue(Workbook.getWorksheets(back)[0]!, "A1") as {
        richText?: readonly { text: string }[];
      };
      return value.richText?.map(run => run.text);
    };
    expect(await texts("xlsb")).toEqual(await texts("xlsx"));
  });

  it("is not reported as a loss", async () => {
    await expect(
      Workbook.toBuffer(withRuns([{ text: "x", font: { bold: true } }]), {
        format: "xlsb",
        unsupported: "error"
      })
    ).resolves.toBeInstanceOf(Uint8Array);
  });
});
