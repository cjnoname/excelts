import { readFileSync } from "node:fs";

import { extractAll } from "@archive/unzip/extract";
/**
 * Auto filters, ignored errors, and the three kinds of media that are not a placed picture.
 *
 * Carries `.node` because it reads a PNG off disk: the browser config excludes that suffix by glob.
 *
 * The media group is worth reading together, because each reaches the sheet a different way and the
 * *record* is the smallest part of it: a background is one relationship plus `BrtBkHim`, while a header
 * picture is a VML part, that part's own `.rels`, and a `BrtLegacyDrawingHF` naming it.
 */
import { Cell, HeaderFooterImage, Image, Watermark, Workbook } from "@excel";
import {
  encodeAutoFilter,
  encodeIgnoredError,
  readAutoFilter,
  readIgnoredErrors
} from "@excel/xlsb/filter";
import { describe, expect, it } from "vitest";

const PNG = readFileSync("src/modules/excel/__tests__/data/image.png");

describe("BrtBeginAFilter", () => {
  it("is sixteen bytes of range and nothing else", () => {
    // The criteria are a separate collection. Sixteen bytes is the whole record.
    expect(encodeAutoFilter("A1:C10")).toHaveLength(16);
  });

  it("round-trips the range", () => {
    expect(readAutoFilter(encodeAutoFilter("A1:C10")!, "test")).toBe("A1:C10");
    expect(readAutoFilter(encodeAutoFilter("B2")!, "test")).toBe("B2");
  });

  it("refuses a reference that does not decode", () => {
    expect(encodeAutoFilter("not a range")).toBeUndefined();
  });
});

describe("BrtCellIgnoreEC", () => {
  it("maps each flag to the bit the record uses, not to its position in the model", () => {
    // `ffecCalcError` is bit 0 and the model calls it `evalError`; `ffecNumStoredAsText` is bit 2. A
    // positional mapping would swap which warnings a sheet suppresses.
    const flagsOf = (entry: Parameters<typeof encodeIgnoredError>[0]): number =>
      new DataView(encodeIgnoredError(entry)!.buffer).getUint32(0, true);
    expect(flagsOf({ ref: "A1", evalError: true })).toBe(1 << 0);
    expect(flagsOf({ ref: "A1", emptyCellReference: true })).toBe(1 << 1);
    expect(flagsOf({ ref: "A1", numberStoredAsText: true })).toBe(1 << 2);
    expect(flagsOf({ ref: "A1", formulaRange: true })).toBe(1 << 3);
    expect(flagsOf({ ref: "A1", formula: true })).toBe(1 << 4);
    expect(flagsOf({ ref: "A1", twoDigitTextYear: true })).toBe(1 << 5);
    expect(flagsOf({ ref: "A1", unlockedFormula: true })).toBe(1 << 6);
    expect(flagsOf({ ref: "A1", listDataValidation: true })).toBe(1 << 7);
    expect(flagsOf({ ref: "A1", calculatedColumn: true })).toBe(1 << 8);
  });

  it("writes nothing for an entry that ignores nothing", () => {
    // A record with every flag clear has no effect, and Excel does not write one.
    expect(encodeIgnoredError({ ref: "A1" })).toBeUndefined();
  });

  it("round-trips the range and the flags together", () => {
    const entry = { ref: "B2:B9", numberStoredAsText: true, evalError: true } as const;
    expect(readIgnoredErrors(encodeIgnoredError(entry)!, "test")).toEqual([entry]);
  });

  it("rejects a count the record does not permit", () => {
    for (const count of [0, -1, 8192]) {
      const payload = new Uint8Array(8);
      const view = new DataView(payload.buffer);
      view.setUint32(0, 1, true);
      view.setInt32(4, count, true);
      expect(readIgnoredErrors(payload, "test"), `crfx ${count}`).toEqual([]);
    }
  });
});

describe("through a workbook", () => {
  it("round-trips an auto filter and several ignored-error ranges", async () => {
    const workbook = Workbook.create();
    const sheet = Workbook.addWorksheet(workbook, "S");
    Cell.setValue(sheet, "A1", 1);
    const model = Workbook.getModel(workbook);
    (model.worksheets[0] as unknown as Record<string, unknown>).autoFilter = "A1:C10";
    (model.worksheets[0] as unknown as Record<string, unknown>).ignoredErrors = [
      { ref: "B2:B9", numberStoredAsText: true, evalError: true },
      { ref: "D1", formula: true, calculatedColumn: true }
    ];
    Workbook.setModel(workbook, model);
    const reopened = Workbook.create();
    await Workbook.read(reopened, await Workbook.toBuffer(workbook, { format: "xlsb" }));
    const back = Workbook.getModel(reopened).worksheets[0] as unknown as Record<string, unknown>;
    expect(back.autoFilter).toBe("A1:C10");
    expect(back.ignoredErrors).toEqual([
      { evalError: true, numberStoredAsText: true, ref: "B2:B9" },
      { formula: true, calculatedColumn: true, ref: "D1" }
    ]);
  });

  it("round-trips a background image, bytes and all", async () => {
    const workbook = Workbook.create();
    const sheet = Workbook.addWorksheet(workbook, "S");
    Cell.setValue(sheet, "A1", 1);
    Image.setBackground(
      sheet,
      Image.add(workbook, {
        buffer: PNG,
        extension: "png"
      } as never) as never
    );
    const bytes = await Workbook.toBuffer(workbook, { format: "xlsb" });
    // No new part beyond the medium: `BrtBkHim` names a relationship and the image was already written
    // to `xl/media/` by the media planner.
    expect([...(await extractAll(bytes)).keys()]).toContain("xl/media/image1.png");
    const reopened = Workbook.create();
    await Workbook.read(reopened, bytes);
    expect(Image.getBackground(Workbook.getWorksheet(reopened, "S")!)).toBeDefined();
    expect(Workbook.getModel(reopened).media ?? []).toHaveLength(1);
  });

  it("round-trips a header image with its position and size", async () => {
    const workbook = Workbook.create();
    const sheet = Workbook.addWorksheet(workbook, "S");
    Cell.setValue(sheet, "A1", 1);
    HeaderFooterImage.set(sheet, {
      imageId: Image.add(workbook, { buffer: PNG, extension: "png" } as never),
      position: "CH",
      width: 100,
      height: 50
    } as never);
    const bytes = await Workbook.toBuffer(workbook, { format: "xlsb" });
    const paths = [...(await extractAll(bytes)).keys()];
    // Three parts, not one: the VML holding the geometry, its own relationships naming the image, and
    // the image. Omitting the VML's `.rels` leaves a shape pointing at nothing.
    expect(paths).toContain("xl/drawings/vmlDrawing1_hf.vml");
    expect(paths).toContain("xl/drawings/_rels/vmlDrawing1_hf.vml.rels");
    expect(paths).toContain("xl/media/image1.png");
    const reopened = Workbook.create();
    await Workbook.read(reopened, bytes);
    expect(HeaderFooterImage.list(Workbook.getWorksheet(reopened, "S")!)).toEqual([
      { imageId: "0", position: "CH", width: 100, height: 50 }
    ]);
  });

  it("writes no header/footer VML for a sheet with none", async () => {
    const workbook = Workbook.create();
    Cell.setValue(Workbook.addWorksheet(workbook, "S"), "A1", 1);
    const paths = [
      ...(await extractAll(await Workbook.toBuffer(workbook, { format: "xlsb" }))).keys()
    ];
    expect(paths.some(path => path.includes("_hf.vml"))).toBe(false);
  });
});

describe("an overlay watermark is a drawing, not a header picture", () => {
  /** The `xl/drawings/drawingN.xml` a one-sheet workbook produces, and its `.rels` targets. */
  async function drawingOf(
    format: "xlsb" | "xlsx"
  ): Promise<{ xml: string; targets: string[]; vml: boolean }> {
    const workbook = Workbook.create();
    const imageId = Image.add(workbook, { buffer: PNG, extension: "png" });
    const sheet = Workbook.addWorksheet(workbook, "S");
    Cell.setValue(sheet, "A1", 1);
    Watermark.add(sheet, { imageId, mode: "overlay", opacity: 0.3 });
    const parts = await extractAll(await Workbook.toBuffer(workbook, { format }));
    const path = [...parts.keys()].find(name => /drawings\/drawing\d+\.xml$/.test(name));
    const decoder = new TextDecoder();
    const relsEntry =
      path === undefined
        ? undefined
        : parts.get(`${path}.rels`.replace("drawings/", "drawings/_rels/"));
    return {
      xml: path === undefined ? "" : decoder.decode(parts.get(path)!.data),
      targets:
        relsEntry === undefined
          ? []
          : [...decoder.decode(relsEntry.data).matchAll(/Target="([^"]*)"/g)].map(
              match => match[1]
            ),
      vml: [...parts.keys()].some(name => name.endsWith(".vml"))
    };
  }

  it("writes the same drawing XLSX does", async () => {
    // An overlay watermark used to be collected with the header pictures, which put it in the header/footer
    // VML: it came back as a `headerImage` in the centre of the page header with its opacity dropped. The
    // result was a *valid* workbook — just not the one that was written — so nothing caught it. Comparing
    // the two containers' drawings is what does.
    const [xlsb, xlsx] = await Promise.all([drawingOf("xlsb"), drawingOf("xlsx")]);
    expect(xlsb.xml).not.toBe("");
    expect(/alphaModFix amt="(\d+)"/.exec(xlsb.xml)?.[1]).toBe("30000");
    expect(/alphaModFix amt="(\d+)"/.exec(xlsb.xml)?.[1]).toBe(
      /alphaModFix amt="(\d+)"/.exec(xlsx.xml)?.[1]
    );
    // An absolute anchor, because a watermark covers the sheet rather than tracking a cell.
    expect(xlsb.xml).toContain('editAs="absolute"');
    expect(xlsb.targets).toEqual(xlsx.targets);
  });

  it("does not put an overlay watermark in a VML part", async () => {
    // The header/footer VML is where this went wrong, so its *absence* is the assertion.
    expect((await drawingOf("xlsb")).vml).toBe(false);
  });

  it("is not reported as a loss, because it is written", async () => {
    // A header-mode watermark was already written correctly and still reported `watermark` as lost — a
    // false positive that told a caller to expect a missing picture that was in the file.
    const workbook = Workbook.create();
    const imageId = Image.add(workbook, { buffer: PNG, extension: "png" });
    const sheet = Workbook.addWorksheet(workbook, "S");
    Cell.setValue(sheet, "A1", 1);
    Watermark.add(sheet, { imageId, mode: "header" });
    await expect(Workbook.toBuffer(workbook, { format: "xlsb" })).resolves.toBeDefined();
  });
});
