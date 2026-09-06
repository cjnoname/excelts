import { extractAll } from "@archive/unzip/extract";
/**
 * The worksheet `<extLst>` read path.
 *
 * Everything in this file was written and never read back, in three stacked layers, and each layer's tests
 * passed while the feature did not work:
 *
 * 1. `x14:sparklineGroups` was not in `ExtXform`'s dispatch map, so the element reached no xform.
 * 2. `ExtLstXform` keyed its children by tag name — always `ext` — so no extension name ever appeared at the
 *    level `worksheet-xform` reads them from, and two `<ext>` siblings overwrote each other.
 * 3. `setSheetModel` never read `sparklineGroups` back out of the model.
 *
 * `parseSparklineGroups` had unit tests throughout. They passed, because they called it directly — nothing in
 * production did. These tests go through the public API for that reason: a round trip is the only assertion
 * that could have caught any of the three.
 */
import { Sparkline, Workbook, Worksheet } from "@excel";
import { readWorksheetPart } from "@excel/xlsb/read/parts";
import { describe, expect, it } from "vitest";

/** A sheet with one sparkline group whose options are all distinguishable from their defaults. */
function workbook(): Workbook.Handle {
  const handle = Workbook.create();
  const sheet = Workbook.addWorksheet(handle, "S");
  Worksheet.addAoa(sheet, [
    ["H", "V"],
    ["a", 1],
    ["b", 2]
  ]);
  Sparkline.add(sheet, {
    type: "column",
    markers: true,
    high: true,
    low: true,
    lineWeight: 1.5,
    sparklines: [
      { dataRef: "S!B2:B3", cellRef: "E2" },
      { dataRef: "S!B2:B3", cellRef: "E3" }
    ]
  });
  return handle;
}

/** The sheet named `S`, asserted present — `getWorksheet` is nullable and every use here requires it. */
function sheetOf(handle: Workbook.Handle): Worksheet.Handle {
  const sheet = Workbook.getWorksheet(handle, "S");
  expect(sheet).toBeDefined();
  return sheet!;
}

async function reread(bytes: Uint8Array): Promise<Workbook.Handle> {
  const handle = Workbook.create();
  await Workbook.read(handle, bytes);
  return handle;
}

describe.each(["xlsx", "xlsb"] as const)("sparklines through %s", format => {
  it("comes back from a read with its group options intact", async () => {
    const bytes = await Workbook.toBuffer(workbook(), { format, unsupported: "ignore" });
    const groups = Worksheet.getModel(sheetOf(await reread(bytes))).sparklineGroups;

    expect(groups).toHaveLength(1);
    expect(groups?.[0]?.sparklines).toHaveLength(2);
    // The options, not just the count: a reader that produced an empty group would satisfy the two above.
    expect(groups?.[0]).toMatchObject({
      type: "column",
      markers: true,
      high: true,
      low: true,
      lineWeight: 1.5
    });
    // Both members, with the cell and the data range each kept — and not swapped, which is why both are named.
    expect(groups?.[0]?.sparklines?.map(one => [one.cellRef, one.dataRef])).toEqual([
      ["E2", "S!B2:B3"],
      ["E3", "S!B2:B3"]
    ]);
  });

  it("survives a read-modify-write byte for byte", async () => {
    // **Byte equality on the worksheet part**, which is stronger than "the sparklines are still there" and is
    // what catches a reader that invents a value: an unrelated `copies="1"` fabricated by the page-setup
    // reader made this sheet 11 bytes larger on the second write, and nothing else was measuring that.
    const first = await Workbook.toBuffer(workbook(), { format, unsupported: "ignore" });
    const second = await Workbook.toBuffer(await reread(first), {
      format,
      unsupported: "ignore"
    });
    const path = format === "xlsb" ? "xl/worksheets/sheet1.bin" : "xl/worksheets/sheet1.xml";
    const before = (await extractAll(first)).get(path)!.data;
    const after = (await extractAll(second)).get(path)!.data;
    expect([...after]).toEqual([...before]);
  });

  it("writes nothing for a sheet that has none", async () => {
    // The negative case, so "comes back with a group" cannot be satisfied by always inventing one.
    const bare = Workbook.create();
    Worksheet.addAoa(Workbook.addWorksheet(bare, "S"), [["a", 1]]);
    const bytes = await Workbook.toBuffer(bare, { format, unsupported: "ignore" });
    expect(Worksheet.getModel(sheetOf(await reread(bytes))).sparklineGroups).toEqual([]);
  });
});

describe("getModel and setModel", () => {
  it("carries sparkline groups in both directions", async () => {
    // **The asymmetry that made every container lose them.** `getModel` has always written `sparklineGroups`
    // out; nothing read it back, so any path that moves a sheet through its model dropped them — including
    // `Workbook.read`, which builds sheets internally and hands them to the caller as a model. Asserted here
    // rather than only through a file, because the defect is in neither reader.
    const model = Worksheet.getModel(sheetOf(workbook()));
    expect(model.sparklineGroups).toHaveLength(1);

    const target = Workbook.create();
    const sheet = Workbook.addWorksheet(target, "S");
    Worksheet.setModel(sheet, model);
    expect(Worksheet.getModel(sheet).sparklineGroups).toHaveLength(1);
    expect(Sparkline.list(sheet)).toHaveLength(1);
  });

  it("does not alias the caller's array", async () => {
    // Copied on the way in, so a caller mutating the model it passed cannot reach inside the sheet.
    const model = Worksheet.getModel(sheetOf(workbook()));
    const target = Workbook.create();
    const sheet = Workbook.addWorksheet(target, "S");
    Worksheet.setModel(sheet, model);
    model.sparklineGroups!.length = 0;
    expect(Worksheet.getModel(sheet).sparklineGroups).toHaveLength(1);
  });
});

describe("the conditional-formatting extension, which shared the same defect", () => {
  it("reads x14:conditionalFormattings back", async () => {
    // **Not a sparkline test, and it belongs here anyway.** `worksheet-xform` looks this up as
    // `extLst.model["x14:conditionalFormattings"]`, and `ExtLstXform` keyed its children by tag name — `ext` —
    // so that lookup had always been `undefined`. The block was parsed and discarded, exactly like the
    // sparkline one, and one fix restored both. `x14Id` is the witness: it exists only inside the extension,
    // so reading it back proves the block was reached rather than reconstructed from the plain `<cfRule>`.
    const handle = Workbook.create();
    const sheet = Workbook.addWorksheet(handle, "S");
    Worksheet.addAoa(sheet, [["V"], [1], [5], [9]]);
    const model = Worksheet.getModel(sheet);
    model.conditionalFormattings = [
      {
        ref: "A2:A4",
        rules: [
          {
            type: "dataBar",
            cfvo: [{ type: "min" }, { type: "max" }],
            color: { argb: "FF638EC6" },
            priority: 1
          }
        ]
      }
    ] as never;
    Worksheet.setModel(sheet, model);

    const bytes = await Workbook.toBuffer(handle, { format: "xlsx", unsupported: "ignore" });
    const rule = Worksheet.getModel(sheetOf(await reread(bytes))).conditionalFormattings?.[0]
      ?.rules?.[0] as { x14Id?: string } | undefined;
    expect(rule?.x14Id).toMatch(/^\{[0-9A-F-]+\}$/);
  });

  it("keeps both extensions when a sheet carries them together", async () => {
    // Two `<ext>` siblings used to land on the same model key, so the second overwrote the first — a sheet with
    // both a sparkline and an extended conditional format kept whichever was written last.
    const handle = workbook();
    const sheet = sheetOf(handle);
    const model = Worksheet.getModel(sheet);
    model.conditionalFormattings = [
      {
        ref: "B2:B3",
        rules: [
          {
            type: "dataBar",
            cfvo: [{ type: "min" }, { type: "max" }],
            color: { argb: "FF638EC6" },
            priority: 1
          }
        ]
      }
    ] as never;
    Worksheet.setModel(sheet, model);

    const bytes = await Workbook.toBuffer(handle, { format: "xlsx", unsupported: "ignore" });
    const back = Worksheet.getModel(sheetOf(await reread(bytes)));
    expect(back.sparklineGroups).toHaveLength(1);
    expect(back.conditionalFormattings).toHaveLength(1);
  });
});

describe("a group always gets a visible series colour", () => {
  it("emits x14:colorSeries even when the caller states no colour", async () => {
    // **Found in Excel, not here.** A group with no `<x14:colorSeries>` is one Excel *loads* — selecting the
    // cell highlights the source range, so the sparkline exists — and then draws nothing. `Sparkline.add` with
    // no colour is the documented way to add one, so the documented way produced an invisible chart, and no
    // assertion in this repository was in a position to notice: every test checked that the element was written
    // when a colour was given.
    const bytes = await Workbook.toBuffer(workbook(), { format: "xlsx", unsupported: "ignore" });
    const xml = new TextDecoder().decode(
      (await extractAll(bytes)).get("xl/worksheets/sheet1.xml")!.data
    );
    const groups = xml.match(/<x14:sparklineGroup[\s>]/g) ?? [];
    expect(groups).toHaveLength(1);
    // **Excel's own values**, read out of a sparkline it created (`tmp/excel-sparkline-reference.xlsx`). The
    // first version of this test asserted `theme="4"` — accent1 — which was a guess, and wrong: Excel writes
    // concrete sRGB. Asserted as attributes rather than through the model, because the model is allowed to
    // leave the colour unstated; the guarantee is about what reaches the file.
    expect(xml).toContain('<x14:colorSeries rgb="FF376092"/>');
    // And all eight, not just the series: `high: true` with no `colorHigh` is an invisible high point, which
    // is the same defect one marker at a time.
    expect(xml).toContain('<x14:colorAxis rgb="FF000000"/>');
    expect(xml).toContain('<x14:colorHigh rgb="FFD00000"/>');
    // Excel's default for empty cells is `gap`, and the schema's is `zero` — which is why Excel states it.
    expect(xml).toContain('displayEmptyCellsAs="gap"');
  });

  it("does not override a stated colour in XLSB either", async () => {
    // **The gap that let a real defect through.** The XLSX side of this was tested and the XLSB side was not,
    // and the two model a colour under different field names — `rgb` in the sparkline model, `argb` in the
    // workbook-wide `Color` the XLSB encoder reads. A stated colour therefore reached that encoder unrecognised
    // and came out as the automatic palette entry: `lineColor` worked in one format and was silently discarded
    // in the other. Excel's own bytes found it, months of round-trip tests did not, and the reason is that a
    // colour read back out of a file arrives already spelled `argb` — so read-then-write agreed with itself.
    const handle = Workbook.create();
    const sheet = Workbook.addWorksheet(handle, "S");
    Worksheet.addAoa(sheet, [["V"], [1], [2]]);
    Sparkline.add(sheet, {
      type: "column",
      lineColor: "FF638EC6",
      sparklines: [{ dataRef: "S!A2:A3", cellRef: "C2" }]
    });
    const bytes = await Workbook.toBuffer(handle, { format: "xlsb", unsupported: "ignore" });
    const groups = Worksheet.getModel(sheetOf(await reread(bytes))).sparklineGroups;
    expect(groups?.[0]?.colorSeries).toEqual({ rgb: "FF638EC6" });
  });

  it("hands colours back in the model's own spelling", async () => {
    // `rgb`, not `argb`. Storing the decoder's `argb` form worked for a re-write — it is what the encoder wants
    // — but it put a shape in the model that `Sparkline.list` and the XLSX renderer do not read, so a colour
    // read out of an XLSB was invisible to every other consumer of the same model.
    const bytes = await Workbook.toBuffer(workbook(), { format: "xlsb", unsupported: "ignore" });
    const groups = Worksheet.getModel(sheetOf(await reread(bytes))).sparklineGroups;
    expect(groups?.[0]?.colorSeries).toEqual({ rgb: "FF376092" });
    expect(Object.keys(groups?.[0]?.colorSeries ?? {})).not.toContain("argb");
  });

  it("does not override a colour the caller did state", async () => {
    const handle = Workbook.create();
    const sheet = Workbook.addWorksheet(handle, "S");
    Worksheet.addAoa(sheet, [["V"], [1], [2]]);
    Sparkline.add(sheet, {
      type: "column",
      lineColor: "FF638EC6",
      sparklines: [{ dataRef: "S!A2:A3", cellRef: "C2" }]
    });
    const bytes = await Workbook.toBuffer(handle, { format: "xlsx", unsupported: "ignore" });
    const xml = new TextDecoder().decode(
      (await extractAll(bytes)).get("xl/worksheets/sheet1.xml")!.data
    );
    expect(xml).toContain('<x14:colorSeries rgb="FF638EC6"/>');
    expect(xml).not.toContain('theme="4"');
  });

  it("says the same thing in XLSB, where an unstated colour was automatic", async () => {
    // The XLSB writer had the same defect in a different spelling: `BrtBeginSparklineGroup` forbids colour type
    // 0, so an unstated colour became palette index 64 — "automatic", which is as unpainted as an absent
    // element. Both writers now read one definition.
    const bytes = await Workbook.toBuffer(workbook(), { format: "xlsb", unsupported: "ignore" });
    const groups = Worksheet.getModel(sheetOf(await reread(bytes))).sparklineGroups;
    expect(groups?.[0]?.colorSeries).toEqual({ rgb: "FF376092" });
    expect(groups?.[0]?.displayEmptyCellsAs).toBe("gap");
  });
});

/**
 * The sparkline block out of a workbook **Excel itself** produced, verbatim.
 *
 * A column sparkline over `A1:A4` in `C1`, inserted through Excel's UI with nothing customised, then saved as
 * XLSB. Copied in as bytes rather than kept as a file on disk: the artefact is hand-made and uncommittable, and
 * a test that silently skips when its fixture is missing is worse than no test.
 *
 * It is here because **this is the only assertion in the suite that is not circular.** Everything else compares
 * this library's reader against this library's writer, and three separate defects this session survived exactly
 * that shape of test — a wrong `FIND` id, a wrong `PtgList` class bit, and a wrong `FRTSqref` layout whose two
 * errors cancelled in the record length. Excel's bytes cannot agree with a mistake of ours.
 *
 * It contains, in order: the `BrtFRTBegin` wrapper, `BrtBeginSparklineGroups`, an `BrtACBegin` version stamp
 * with a revision GUID Excel adds, the 98-byte group, the 63-byte sparkline, and the closing delimiters.
 */
const EXCEL_SPARKLINE_BLOCK =
  "2304020e0000a208002506010002100080801810aed77a2ce7944033a9a37428a101a4ee260091086200000000021805" +
  "ff0000376092ff05ff0000d00000ff05ff0000000000ff05ff0000d00000ff05ff0000d00000ff05ff0000d00000ff05" +
  "ff0000d00000ff05ff0000d00000ff00000000000000000000000000000000000000000000e83f01000000a008009308" +
  "3f060000000100000002000000010000000000000000000000020000000200000001000000020000000f000000000000" +
  "003b0000000000000300000000c000c0a10800920800a308002400";

function bytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g)!.map(pair => parseInt(pair, 16)));
}

describe("a sparkline Excel wrote itself", () => {
  it("reads back out of Excel's own bytes", () => {
    // A minimal sheet stream around Excel's block, so the read goes through the same record walk a real sheet
    // does — including the future-record wrapper, which is the part that was broken.
    const sheet = new Uint8Array([
      0x81,
      0x01,
      0x00, // BrtBeginSheet, no payload
      ...bytes(EXCEL_SPARKLINE_BLOCK),
      0x82,
      0x01,
      0x00 // BrtEndSheet
    ]);
    const read = readWorksheetPart(sheet, "sheet1.bin", [], {
      sheetNames: ["Sheet1"],
      externSheets: [{ first: 0, last: 0 }]
    });

    expect(read.sparklineGroups).toHaveLength(1);
    expect(read.sparklineGroups[0]?.sparklines).toEqual([
      { cellRef: "C1", dataRef: "Sheet1!A1:A4" }
    ]);
    // Excel's own defaults, which is what makes this fixture worth keeping: `gap` (not the schema's `zero`),
    // 0.75, and concrete sRGB rather than a theme slot.
    expect(read.sparklineGroups[0]).toMatchObject({
      type: "column",
      lineWeight: 0.75,
      displayEmptyCellsAs: "gap",
      colorSeries: { rgb: "FF376092" },
      colorAxis: { rgb: "FF000000" },
      colorHigh: { rgb: "FFD00000" }
    });
    // Both axes on the individual setting — Excel's flag word confirms the pair assignment, which had the group
    // bit set here and was therefore making every group share one vertical axis.
    expect(read.sparklineGroups[0]?.maxAxisType).toBeUndefined();
    expect(read.sparklineGroups[0]?.minAxisType).toBeUndefined();
  });

  it("re-emits it byte for byte", async () => {
    // The other direction against the same authority: what this library writes for the same sparkline must be
    // the bytes Excel wrote. The version stamp inside `BrtFRTBegin` is excluded — it names the application, and
    // every writer in the corpus puts something different there.
    const handle = Workbook.create();
    const sheet = Workbook.addWorksheet(handle, "Sheet1");
    Worksheet.addAoa(sheet, [[1], [5], [3], [9]]);
    Sparkline.add(sheet, {
      type: "column",
      sparklines: [{ dataRef: "Sheet1!A1:A4", cellRef: "C1" }]
    });
    const written = (
      await extractAll(await Workbook.toBuffer(handle, { format: "xlsb", unsupported: "ignore" }))
    ).get("xl/worksheets/sheet1.bin")!.data;

    for (const [name, id] of [
      ["BrtBeginSparklineGroup", 1041],
      ["BrtSparkline", 1043]
    ] as const) {
      const mine = recordPayload(written, id);
      const excel = recordPayload(bytes(EXCEL_SPARKLINE_BLOCK), id);
      expect([...mine], name).toEqual([...excel]);
    }
  });
});

/** The payload of the first record with this id, framed the way BIFF12 frames records. */
function recordPayload(stream: Uint8Array, wanted: number): Uint8Array {
  let offset = 0;
  while (offset < stream.length) {
    let id = stream[offset]! & 0x7f;
    if (stream[offset++]! & 0x80) {
      id |= (stream[offset++]! & 0x7f) << 7;
    }
    let length = 0;
    let shift = 0;
    let part: number;
    do {
      part = stream[offset++]!;
      length |= (part & 0x7f) << shift;
      shift += 7;
    } while (part & 0x80);
    if (id === wanted) {
      return stream.slice(offset, offset + length);
    }
    offset += length;
  }
  throw new Error(`record ${wanted} not present`);
}
