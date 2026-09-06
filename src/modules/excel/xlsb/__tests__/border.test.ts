/**
 * Cell borders.
 *
 * The corpus establishes this record's *size* — 51 bytes, byte-identical across every workbook — and not
 * one of its fields, because every one of those workbooks uses the default border and nothing else. That
 * is why `styles.ts` wrote `new Uint8Array(51)` for every cell format and a border a caller asked for
 * disappeared. MS-XLSB 2.4.314 and 2.5.5 supply the fields, and the assertions below are against them.
 */
import { Cell, Workbook } from "@excel";
import { BORDER_SIZE, encodeBorder, readBorder } from "@excel/xlsb/border";
import { describe, expect, it } from "vitest";

describe("BrtBorder", () => {
  it("is 51 bytes: a flag byte and five ten-byte edges", () => {
    // `1 + 5 × 10`, matching the corpus record exactly — which is what makes the field layout and the
    // observed size agree rather than merely coexist.
    expect(BORDER_SIZE).toBe(51);
    expect(encodeBorder(undefined)).toHaveLength(51);
    expect(encodeBorder({ top: { style: "thin" } })).toHaveLength(51);
  });

  it("writes the default as Excel does: fValidRGB on each edge, everything else zero", () => {
    // This asserted all 51 bytes were zero, "as the corpus does". The corpus does not: `cal-any_sheets.xlsb`,
    // `cal-date.xlsb` and `cal-date_1904.xlsb` all carry `0x01` in each edge's colour flags byte, and so does
    // every file Excel produced for the oracle. One flag in an otherwise empty record, and the claim about the
    // corpus was never checked against it.
    const bytes = encodeBorder(undefined);
    expect(bytes).toHaveLength(51);
    const nonZero = [...bytes].flatMap((byte, index) => (byte === 0 ? [] : [index]));
    expect(nonZero).toEqual([3, 13, 23, 33, 43]);
    expect(new Set([...bytes].filter(byte => byte !== 0))).toEqual(new Set([0x01]));
    // And reads back as "no border" rather than as an empty configuration, so a cell format does not gain an
    // explicit "no borders" setting.
    expect(readBorder(bytes, "test")).toBeUndefined();
  });

  it("orders the edges top, bottom, left, right — not the CSS order", () => {
    // Writing left where bottom belongs puts a table's rules on the wrong sides, and a round trip
    // through this library would not notice because it would read them back the same way.
    const payload = encodeBorder({
      top: { style: "thin" }, // dg 1
      bottom: { style: "medium" }, // dg 2
      left: { style: "dashed" }, // dg 3
      right: { style: "dotted" } // dg 4
    });
    // One flag byte, then each edge's `dg` at the start of its ten-byte block.
    expect(payload[1]).toBe(1);
    expect(payload[11]).toBe(2);
    expect(payload[21]).toBe(3);
    expect(payload[31]).toBe(4);
  });

  it("maps every style the model has", () => {
    const styles = [
      "thin",
      "medium",
      "dashed",
      "dotted",
      "thick",
      "double",
      "hair",
      "mediumDashed",
      "dashDot",
      "mediumDashDot",
      "dashDotDot",
      "mediumDashDotDot",
      "slantDashDot"
    ] as const;
    for (const style of styles) {
      const back = readBorder(encodeBorder({ top: { style } }), "test");
      expect(back?.top?.style, style).toBe(style);
    }
  });

  it("carries the diagonal direction bits, which are not part of an edge", () => {
    // `fBdrDiagDown` and `fBdrDiagUp` live in the record's flag byte, not in `blxfDiag` — so a diagonal
    // with a style but no direction draws nothing, and a direction with no style is invalid by the
    // specification's own MUST.
    const both = readBorder(
      encodeBorder({ diagonal: { style: "thin", up: true, down: true } }),
      "test"
    );
    expect(both?.diagonal).toMatchObject({ style: "thin", up: true, down: true });
    const downOnly = readBorder(encodeBorder({ diagonal: { style: "thin", down: true } }), "test");
    expect(downOnly?.diagonal).toMatchObject({ style: "thin", down: true });
    expect(downOnly?.diagonal).not.toHaveProperty("up");
  });

  it("round-trips an edge colour", () => {
    const back = readBorder(
      encodeBorder({ top: { style: "thin", color: { argb: "FFFF0000" } } }),
      "test"
    );
    expect(back?.top).toMatchObject({ style: "thin", color: { argb: "FFFF0000" } });
  });

  it("survives a truncated payload", () => {
    expect(readBorder(new Uint8Array(20), "test")).toBeUndefined();
  });
});

describe("borders through a workbook", () => {
  it("round-trips all four edges with a colour", async () => {
    const workbook = Workbook.create();
    const sheet = Workbook.addWorksheet(workbook, "S");
    Cell.setValue(sheet, "A1", 1);
    Cell.setStyle(sheet, "A1", {
      border: {
        top: { style: "thin", color: { argb: "FFFF0000" } },
        bottom: { style: "double" },
        left: { style: "dashDot" },
        right: { style: "medium" }
      }
    } as never);
    const reopened = Workbook.create();
    await Workbook.read(reopened, await Workbook.toBuffer(workbook, { format: "xlsb" }));
    expect(Cell.getStyle(Workbook.getWorksheet(reopened, "S")!, "A1")?.border).toMatchObject({
      top: { style: "thin", color: { argb: "FFFF0000" } },
      bottom: { style: "double" },
      left: { style: "dashDot" },
      right: { style: "medium" }
    });
  });

  it("interns one border record per distinct border, not one per cell", async () => {
    // A `BrtXF` holds an *index* into the border table, which is the whole reason to intern: a workbook
    // that rules a hundred cells the same way needs one record, not a hundred.
    const workbook = Workbook.create();
    const sheet = Workbook.addWorksheet(workbook, "S");
    for (let row = 1; row <= 20; row++) {
      Cell.setValue(sheet, `A${row}`, row);
      Cell.setStyle(sheet, `A${row}`, { border: { top: { style: "thin" } } } as never);
    }
    const { extractAll } = await import("@archive/unzip/extract");
    const { iterateInterpretableRecords } = await import("@excel/xlsb/binary");
    const { recordSpec } = await import("@excel/xlsb/spec/records");
    const styles = (await extractAll(await Workbook.toBuffer(workbook, { format: "xlsb" }))).get(
      "xl/styles.bin"
    )!.data;
    const written = [...iterateInterpretableRecords(styles, "s")].filter(
      record => recordSpec(record.id)?.name === "BrtBorder"
    );
    // The default plus the one that was asked for.
    expect(written).toHaveLength(2);
  });

  it("round-trips a border on a row and on a column", async () => {
    const workbook = Workbook.create();
    const sheet = Workbook.addWorksheet(workbook, "S");
    Cell.setValue(sheet, "A1", 1);
    const model = Workbook.getModel(workbook);
    const border = { border: { bottom: { style: "thick" } } };
    (model.worksheets[0] as { rows?: { style?: unknown }[] }).rows![0].style = border;
    (model.worksheets[0] as { cols?: unknown[] }).cols = [{ min: 2, max: 2, style: border }];
    Workbook.setModel(workbook, model);
    const reopened = Workbook.create();
    await Workbook.read(reopened, await Workbook.toBuffer(workbook, { format: "xlsb" }));
    const back = Workbook.getModel(reopened).worksheets[0] as {
      rows?: { style?: { border?: unknown } }[];
      cols?: { style?: { border?: unknown } }[];
    };
    // Both paths matter: cells go through `applyCellFormat` and rows and columns through `styleAt`, and
    // the two assemble the style separately — which is how a facet comes to work on one and not the other.
    expect(back.rows?.[0]?.style?.border).toMatchObject({ bottom: { style: "thick" } });
    expect(back.cols?.[0]?.style?.border).toMatchObject({ bottom: { style: "thick" } });
  });
});
